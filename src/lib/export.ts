import { PDFDocument, StandardFonts, LineCapStyle, degrees, PDFName, PDFHexString, PDFString, PDFArray, PDFDict, PDFStream, type PDFFont } from 'pdf-lib'
import type { Annotation, RedactAnnotation, SignatureFieldAnnotation } from '../types/annotations'
import type { FormFieldValue } from '../stores/formStore'
import { hexToPdfRgb } from './colors'
import { fontBase, type PdfBaseFont } from './fonts'
import { LINE_HEIGHT, layoutText } from './textLayout'
import { pdfjsLib, type PDFDocumentProxy } from './pdfjs'
import { redactFillHex } from './redactGate'
import { saveBlob } from '@unisim/media/save'

// Custom PDF catalog key carrying the unsigned signature-request boxes, so a
// reopened or shared file's boxes stay interactive (movable / click-to-sign) in
// Universal PDF. Signed fields are baked into the page (visible in any viewer)
// and are deliberately NOT embedded — re-editing a finished signature isn't the
// goal, and embedding would double it against the baked copy.
const SIG_FIELDS_KEY = 'UPDFSigFields'

// The minimal, scale-independent shape stored per embedded field. Coordinates
// are PDF points (the annotation store's native space — see EXPORT_SCALE = 1),
// so they map straight back onto the same page at any zoom on reopen.
type EmbeddedSigField = Pick<
  SignatureFieldAnnotation,
  | 'id'
  | 'pageIndex'
  | 'x'
  | 'y'
  | 'width'
  | 'height'
  | 'requireName'
  | 'requireDate'
  | 'requireLive'
>

// Rotate (x, y) around (cx, cy) by `rad` radians.
function rotatePoint(x: number, y: number, cx: number, cy: number, rad: number): [number, number] {
  if (rad === 0) return [x, y]
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - cx
  const dy = y - cy
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
}

// Codepoints WinAnsi (cp1252) can represent in addition to ASCII (0x20-0x7E)
// and Latin-1 supplement (0xA0-0xFF). Anything outside this set blows up
// pdf-lib's standard fonts on encode — we replace it with '?' so a stray
// glyph doesn't kill the whole export.
const WIN_ANSI_EXTRAS = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C,
  0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A,
  0x0153, 0x017E, 0x0178
])
function sanitizeForWinAnsi(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if ((cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF) || WIN_ANSI_EXTRAS.has(cp)) {
      out += ch
    } else {
      out += '?'
    }
  }
  return out
}

// Convert a polyline (flat [x0,y0,x1,y1,...]) to a sequence of cardinal-spline
// Bezier segments matching Konva's `tension` smoothing on the screen overlay.
function smoothPolyline(points: number[], tension = 0.4, samplesPerSeg = 12) {
  if (points.length < 4) return points
  const out: Array<[number, number]> = []
  out.push([points[0], points[1]])
  for (let i = 0; i < points.length - 2; i += 2) {
    const p1x = points[i]
    const p1y = points[i + 1]
    const p2x = points[i + 2]
    const p2y = points[i + 3]
    const p0x = i === 0 ? p1x : points[i - 2]
    const p0y = i === 0 ? p1y : points[i - 1]
    const p3x = i + 4 >= points.length ? p2x : points[i + 4]
    const p3y = i + 4 >= points.length ? p2y : points[i + 5]
    const cp1x = p1x + ((p2x - p0x) * tension) / 6
    const cp1y = p1y + ((p2y - p0y) * tension) / 6
    const cp2x = p2x - ((p3x - p1x) * tension) / 6
    const cp2y = p2y - ((p3y - p1y) * tension) / 6
    for (let s = 1; s <= samplesPerSeg; s++) {
      const t = s / samplesPerSeg
      const mt = 1 - t
      const x =
        mt * mt * mt * p1x +
        3 * mt * mt * t * cp1x +
        3 * mt * t * t * cp2x +
        t * t * t * p2x
      const y =
        mt * mt * mt * p1y +
        3 * mt * mt * t * cp1y +
        3 * mt * t * t * cp2y +
        t * t * t * p2y
      out.push([x, y])
    }
  }
  return out.flat()
}

// Render one source page through pdfjs at high DPI, paint each redact rect
// black on the resulting canvas, then return the JPEG bytes. The redact
// coordinates come from the editor's canvas space (at `annotationScale`)
// and are mapped to the render canvas via the ratio.
async function rasterizePageWithRedacts(
  pdfjsDoc: PDFDocumentProxy,
  pageIndex: number,
  redacts: RedactAnnotation[],
  annotationScale: number
): Promise<Uint8Array> {
  const page = await pdfjsDoc.getPage(pageIndex + 1)
  const renderScale = 2
  const viewport = page.getViewport({ scale: renderScale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  await page.render({ canvasContext: ctx, viewport }).promise

  const k = renderScale / annotationScale
  for (const r of redacts) {
    // The block only — never the editor's "This will be redacted on export"
    // hint, which is drawn by the annotation layer and has no counterpart here.
    ctx.fillStyle = redactFillHex(r.fill)
    ctx.fillRect(r.x * k, r.y * k, r.width * k, r.height * k)
  }

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      0.92
    )
  })
  return new Uint8Array(await blob.arrayBuffer())
}

export async function buildAnnotatedPdfBytes(
  sourceBytes: ArrayBuffer,
  annotations: Annotation[],
  scale: number,
  formValues?: FormFieldValue[]
): Promise<Uint8Array> {
  // updateMetadata: false — pdf-lib otherwise stamps its own Producer and a
  // fresh ModDate on every save, which would quietly re-add metadata to a
  // document the user had just scrubbed (see lib/pdfMetadata.ts).
  const sourcePdf = await PDFDocument.load(sourceBytes, { updateMetadata: false })

  // Fill PDF form fields if any. Flatten so values bake into the page
  // content streams — that way any redacted page rasterizes with the user's
  // typed values baked in, and copyPages preserves them on other pages too.
  if (formValues && formValues.length > 0) {
    try {
      const form = sourcePdf.getForm()
      for (const fv of formValues) {
        if (!fv.value) continue
        try {
          const field = form.getTextField(fv.fieldName)
          field.setText(fv.value)
        } catch {
          // Field not found or not a text field — skip silently
        }
      }
      try { form.flatten() } catch { /* ignore if form can't be flattened */ }
    } catch {
      // No form fields or form not supported
    }
  }

  // Group redact annotations by page — these drive the rasterize-and-rebuild
  // pass below.
  const redactsByPage = new Map<number, RedactAnnotation[]>()
  for (const a of annotations) {
    if (a.type === 'redact') {
      if (!redactsByPage.has(a.pageIndex)) redactsByPage.set(a.pageIndex, [])
      redactsByPage.get(a.pageIndex)!.push(a)
    }
  }

  // If any page needs redaction, rebuild the document so redacted pages
  // become flat raster images (no original text/forms survive in the
  // content stream). Pages without redacts are copied across unchanged.
  let pdf: PDFDocument
  if (redactsByPage.size > 0) {
    const flatBytes = await sourcePdf.save()
    const pdfjsDoc = await pdfjsLib.getDocument({ data: flatBytes.slice() }).promise

    const out = await PDFDocument.create()
    for (let i = 0; i < sourcePdf.getPageCount(); i++) {
      const srcPage = sourcePdf.getPage(i)
      const { width, height } = srcPage.getSize()
      if (redactsByPage.has(i)) {
        const imgBytes = await rasterizePageWithRedacts(
          pdfjsDoc,
          i,
          redactsByPage.get(i)!,
          scale
        )
        const img = await out.embedJpg(imgBytes)
        const newPage = out.addPage([width, height])
        newPage.drawImage(img, { x: 0, y: 0, width, height })
      } else {
        const [copied] = await out.copyPages(sourcePdf, [i])
        out.addPage(copied)
      }
    }
    pdf = out
  } else {
    pdf = sourcePdf
  }

  // Standard-14 variants for each base family, indexed [normal, bold, italic,
  // boldItalic]. Text annotations map to their nearest base (see fonts.ts) and
  // then to the bold/italic variant for the on-screen toggles. Embedded lazily
  // and cached — the standard fonts carry no glyph data so this is cheap.
  const STD_VARIANTS: Record<PdfBaseFont, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
    helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
    times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
    courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique]
  }
  const fontCache = new Map<StandardFonts, PDFFont>()
  const pickFont = async (base: PdfBaseFont, bold?: boolean, italic?: boolean): Promise<PDFFont> => {
    const idx = bold && italic ? 3 : bold ? 1 : italic ? 2 : 0
    const std = STD_VARIANTS[base][idx]
    let f = fontCache.get(std)
    if (!f) {
      f = await pdf.embedFont(std)
      fontCache.set(std, f)
    }
    return f
  }
  const pages = pdf.getPages()

  const byPage = new Map<number, Annotation[]>()
  for (const a of annotations) {
    if (a.type === 'redact') continue
    if (!byPage.has(a.pageIndex)) byPage.set(a.pageIndex, [])
    byPage.get(a.pageIndex)!.push(a)
  }

  for (const [pageIndex, items] of byPage) {
    const page = pages[pageIndex]
    if (!page) continue
    // PDF.js's viewport (used for the on-screen canvas) is anchored at the
    // page's CropBox origin, not at user-space (0, 0). When a PDF declares
    // a non-zero CropBox/MediaBox origin, every annotation we draw with
    // pdf-lib would otherwise be shifted by that offset against the
    // rasterized page — the form fields stay put because pdf-lib's
    // flatten() works in user-space already.
    const box = page.getCropBox()
    const ph = box.height
    const ox = box.x
    const oy = box.y
    // sx/toY map a canvas-space position to PDF user-space (offset included).
    // sw maps a canvas-space size — width, height, font size — to PDF
    // user-space (scale only, no offset).
    const sx = (n: number) => ox + n / scale
    const toY = (canvasY: number) => oy + ph - canvasY / scale
    const sw = (n: number) => n / scale

    for (const a of items) {
      switch (a.type) {
        case 'text': {
          const rot = a.rotation ?? 0
          const rad = (rot * Math.PI) / 180
          // Draw each styled run in sequence, advancing x by the run's own
          // (variant-specific) width so mixed bold/italic/underline/link within
          // one text box bake correctly.
          //
          // ⚠️ WHERE the lines break is decided by the shared canvas layout, not
          // re-derived here from pdf-lib's metrics: the two measure slightly
          // differently, and a file whose words wrapped somewhere other than
          // the editor showed them would be the bug. Only the advance WITHIN a
          // line uses the embedded font's own widths, as it always has.
          for (const [li, line] of layoutText(a).entries()) {
            const lineY = a.y + li * a.fontSize * LINE_HEIGHT
            let offset = 0 // canvas-space advance from a.x
            for (const run of line.runs) {
              const body = sanitizeForWinAnsi(run.text)
              const font = await pickFont(fontBase(a.fontFamily), run.bold, run.italic)
              const runW = body ? font.widthOfTextAtSize(body, a.fontSize) : 0
              if (body) {
                const rx = a.x + offset
                const blKy = lineY + a.fontSize * 0.8
                const [bx, by] = rotatePoint(rx, blKy, a.x, a.y, rad)
                page.drawText(body, {
                  x: sx(bx),
                  y: toY(by),
                  size: sw(a.fontSize),
                  font,
                  color: hexToPdfRgb(a.color),
                  rotate: rot ? degrees(-rot) : undefined
                })
                // pdf-lib has no underline; a link also shows as an underline (its
                // colour is deliberately left as the text colour). Draw the rule
                // just below the baseline, rotated with the text.
                if (run.underline || run.link) {
                  const uy = lineY + a.fontSize * 0.98
                  const [ux1, uy1] = rotatePoint(rx, uy, a.x, a.y, rad)
                  const [ux2, uy2] = rotatePoint(rx + runW, uy, a.x, a.y, rad)
                  page.drawLine({
                    start: { x: sx(ux1), y: toY(uy1) },
                    end: { x: sx(ux2), y: toY(uy2) },
                    thickness: sw(Math.max(0.75, a.fontSize * 0.06)),
                    color: hexToPdfRgb(a.color)
                  })
                }
                // Bake a clickable URI link annotation over just this run's box.
                // The rect is axis-aligned (run rotation of the hit area is
                // dropped — acceptable for a link target).
                if (run.link) {
                  const lx1 = sx(rx)
                  const lx2 = sx(rx + runW)
                  const ly1 = toY(lineY + a.fontSize * 1.2)
                  const ly2 = toY(lineY)
                  const linkAnnot = pdf.context.obj({
                    Type: 'Annot',
                    Subtype: 'Link',
                    Rect: [lx1, ly1, lx2, ly2],
                    Border: [0, 0, 0],
                    A: pdf.context.obj({
                      Type: 'Action',
                      S: 'URI',
                      URI: PDFString.of(run.link)
                    })
                  })
                  const ref = pdf.context.register(linkAnnot)
                  const existing = page.node.lookup(PDFName.of('Annots'), PDFArray)
                  if (existing) existing.push(ref)
                  else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]))
                }
              }
              offset += runW
            }
          }
          break
        }
        case 'rect': {
          const rot = a.rotation ?? 0
          const rad = (rot * Math.PI) / 180
          // Konva top-left is (a.x, a.y); pdf-lib wants the bottom-left of
          // the un-rotated rectangle in its own coordinate system.
          const [bx, by] = rotatePoint(a.x, a.y + a.height, a.x, a.y, rad)
          if (a.filled) {
            page.drawRectangle({
              x: sx(bx),
              y: toY(by),
              width: sw(a.width),
              height: sw(a.height),
              color: hexToPdfRgb(a.color),
              rotate: rot ? degrees(-rot) : undefined
            })
          } else {
            page.drawRectangle({
              x: sx(bx),
              y: toY(by),
              width: sw(a.width),
              height: sw(a.height),
              borderColor: hexToPdfRgb(a.color),
              borderWidth: sw(2),
              opacity: 0,
              rotate: rot ? degrees(-rot) : undefined
            })
          }
          break
        }
        case 'ellipse': {
          const rot = a.rotation ?? 0
          // pdf-lib drawEllipse is centre-anchored. Konva stores a top-left
          // bbox; the centre in Konva space is (x + w/2, y + h/2). Rotation in
          // the app pivots around the bbox top-left, so rotate that centre
          // about the top-left to get the centre in the rotated frame.
          const rad = (rot * Math.PI) / 180
          const [cxr, cyr] = rotatePoint(a.x + a.width / 2, a.y + a.height / 2, a.x, a.y, rad)
          const common = {
            x: sx(cxr),
            y: toY(cyr),
            xScale: sw(a.width / 2),
            yScale: sw(a.height / 2),
            rotate: rot ? degrees(-rot) : undefined
          }
          if (a.filled) {
            page.drawEllipse({ ...common, color: hexToPdfRgb(a.color) })
          } else {
            page.drawEllipse({
              ...common,
              borderColor: hexToPdfRgb(a.color),
              borderWidth: sw(2),
              opacity: 0
            })
          }
          break
        }
        case 'draw': {
          const pts = smoothPolyline(a.points, 0.4, 12)
          for (let i = 0; i < pts.length - 2; i += 2) {
            page.drawLine({
              start: { x: sx(pts[i]), y: toY(pts[i + 1]) },
              end: { x: sx(pts[i + 2]), y: toY(pts[i + 3]) },
              thickness: sw(a.strokeWidth),
              color: hexToPdfRgb(a.color),
              opacity: a.opacity,
              lineCap: LineCapStyle.Round
            })
          }
          break
        }
        case 'tick': {
          const s = a.size
          const rad = ((a.rotation ?? 0) * Math.PI) / 180
          const segs: Array<[number, number, number, number]> = [
            [a.x, a.y + s * 0.55, a.x + s * 0.35, a.y + s * 0.9],
            [a.x + s * 0.35, a.y + s * 0.9, a.x + s, a.y + s * 0.1]
          ]
          for (const [x1, y1, x2, y2] of segs) {
            const [rx1, ry1] = rotatePoint(x1, y1, a.x, a.y, rad)
            const [rx2, ry2] = rotatePoint(x2, y2, a.x, a.y, rad)
            page.drawLine({
              start: { x: sx(rx1), y: toY(ry1) },
              end: { x: sx(rx2), y: toY(ry2) },
              thickness: sw(3.5),
              color: hexToPdfRgb(a.color),
              lineCap: LineCapStyle.Round
            })
          }
          break
        }
        case 'cross': {
          const s = a.size
          const rad = ((a.rotation ?? 0) * Math.PI) / 180
          const segs: Array<[number, number, number, number]> = [
            [a.x, a.y, a.x + s, a.y + s],
            [a.x + s, a.y, a.x, a.y + s]
          ]
          for (const [x1, y1, x2, y2] of segs) {
            const [rx1, ry1] = rotatePoint(x1, y1, a.x, a.y, rad)
            const [rx2, ry2] = rotatePoint(x2, y2, a.x, a.y, rad)
            page.drawLine({
              start: { x: sx(rx1), y: toY(ry1) },
              end: { x: sx(rx2), y: toY(ry2) },
              thickness: sw(3.5),
              color: hexToPdfRgb(a.color),
              lineCap: LineCapStyle.Round
            })
          }
          break
        }
        case 'image': {
          const rot = a.rotation ?? 0
          const rad = (rot * Math.PI) / 180
          const isPng = a.src.startsWith('data:image/png')
          const img = isPng
            ? await pdf.embedPng(a.src)
            : await pdf.embedJpg(a.src)
          const [bx, by] = rotatePoint(a.x, a.y + a.height, a.x, a.y, rad)
          page.drawImage(img, {
            x: sx(bx),
            y: toY(by),
            width: sw(a.width),
            height: sw(a.height),
            rotate: rot ? degrees(-rot) : undefined
          })
          // Optional border (owner ask, 2026-09-04). Baked here as well as drawn
          // in the viewer, or a bordered picture exports naked — which is the
          // failure mode that matters, because the export is what gets sent.
          //
          // Drawn AFTER the image so the stroke sits on top of the picture edge
          // rather than being half-covered by it, and `opacity: 0` keeps the
          // rectangle's FILL invisible while the border still paints (the same
          // trick the outline-only rect case above uses).
          if (a.border && a.border.width > 0) {
            page.drawRectangle({
              x: sx(bx),
              y: toY(by),
              width: sw(a.width),
              height: sw(a.height),
              borderColor: hexToPdfRgb(a.border.color),
              borderWidth: sw(a.border.width),
              // ⚠️ pdf-lib takes the dash pattern in POINTS, already scaled —
              // passing raw annotation units would give a dash that looks right
              // on screen and wrong in the file at any zoom but 100%.
              borderDashArray: a.border.style === 'dashed'
                ? [sw(a.border.width * 3), sw(a.border.width * 2)]
                : undefined,
              opacity: 0,
              rotate: rot ? degrees(-rot) : undefined
            })
          }
          break
        }
        case 'sigfield': {
          if (a.signed) {
            // A signed box that came from a flattened/exported PDF (locked) has
            // the "Sign here • Name • Date" caption already baked into the page —
            // paint the box white first so the signature replaces it, not sits
            // on top of it.
            if (a.locked) {
              page.drawRectangle({
                x: sx(a.x),
                y: toY(a.y + a.height),
                width: sw(a.width),
                height: sw(a.height),
                color: hexToPdfRgb('#ffffff')
              })
            }
            // Bake the signature image, contained inside the box (matches the
            // on-screen fit). Baseline of the box's bottom edge is a.y + height.
            const img = a.signed.src.startsWith('data:image/png')
              ? await pdf.embedPng(a.signed.src)
              : await pdf.embedJpg(a.signed.src)
            const margin = 0.08
            const availW = a.width * (1 - margin * 2)
            const availH = a.height * (1 - margin * 2)
            const ratio = a.signed.width > 0 && a.signed.height > 0
              ? a.signed.width / a.signed.height
              : 1
            let fw = availW
            let fh = fw / ratio
            if (fh > availH) {
              fh = availH
              fw = fh * ratio
            }
            const fx = a.x + (a.width - fw) / 2
            const fy = a.y + (a.height - fh) / 2
            page.drawImage(img, {
              x: sx(fx),
              y: toY(fy + fh),
              width: sw(fw),
              height: sw(fh)
            })
          } else {
            // Unsigned request box: bake a visible outline + caption so it's
            // shown in any viewer (Acrobat, browsers, print). It's ALSO embedded
            // in the catalog below, so Universal PDF re-detects it as a
            // click-to-sign box — locked in place (non-movable) so it can't drift
            // off the baked outline.
            const orange = hexToPdfRgb('#ea580c')
            page.drawRectangle({
              x: sx(a.x),
              y: toY(a.y + a.height),
              width: sw(a.width),
              height: sw(a.height),
              borderColor: orange,
              borderWidth: sw(1.5),
              opacity: 0
            })
            const parts: string[] = []
            if (a.requireName) parts.push('Name')
            if (a.requireDate) parts.push('Date')
            if (a.requireLive) parts.push('Live')
            const label = sanitizeForWinAnsi(['Sign here', ...parts].join(' • '))
            const size = sw(Math.min(a.height * 0.28, 18))
            // Inset from the box's top-left corner. The box is in canvas units
            // (canvas = pdf * scale); `size` is PDF units, so scale it back up to
            // canvas space when positioning the baseline.
            const padCanvas = Math.min(8, a.height * 0.12, a.width * 0.06)
            const baselineCanvasY = a.y + padCanvas + size * scale * 0.85
            page.drawText(label, {
              x: sx(a.x + padCanvas),
              y: toY(baselineCanvasY),
              size,
              font: await pickFont('helvetica'),
              color: hexToPdfRgb('#c2410c')
            })
          }
          break
        }
      }
    }
  }

  // Embed unsigned signature-request boxes into the document catalog so they
  // round-trip as interactive fields when the file is reopened / shared. Signed
  // fields are already baked into the page above and are not embedded.
  const unsignedFields: EmbeddedSigField[] = annotations
    .filter((a): a is SignatureFieldAnnotation => a.type === 'sigfield' && !a.signed)
    .map((a) => ({
      id: a.id,
      pageIndex: a.pageIndex,
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
      requireName: a.requireName,
      requireDate: a.requireDate,
      requireLive: a.requireLive
    }))
  try {
    const key = PDFName.of(SIG_FIELDS_KEY)
    if (unsignedFields.length > 0) {
      pdf.catalog.set(key, PDFHexString.fromText(JSON.stringify(unsignedFields)))
    } else {
      pdf.catalog.delete(key)
    }
  } catch {
    // Best-effort — a failure here just means the boxes won't round-trip, not
    // that the export fails.
  }

  return pdf.save()
}

// Read back the unsigned signature-request boxes embedded by a prior export, so
// a reopened / shared PDF's boxes become interactive again. Returns [] for any
// file without them (or that can't be parsed). Coordinates are already in the
// annotation store's PDF-point space, so the fields drop straight back in.
export async function readEmbeddedSigFields(
  bytes: ArrayBuffer
): Promise<SignatureFieldAnnotation[]> {
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    const raw = pdf.catalog.get(PDFName.of(SIG_FIELDS_KEY)) as unknown
    const decodable = raw as { decodeText?: () => string } | undefined
    const text =
      decodable && typeof decodable.decodeText === 'function'
        ? decodable.decodeText()
        : null
    if (!text) return []
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    const out: SignatureFieldAnnotation[] = []
    for (const v of parsed as Partial<EmbeddedSigField>[]) {
      if (
        v &&
        typeof v.id === 'string' &&
        typeof v.pageIndex === 'number' &&
        typeof v.x === 'number' &&
        typeof v.y === 'number' &&
        typeof v.width === 'number' &&
        typeof v.height === 'number'
      ) {
        out.push({
          type: 'sigfield',
          id: v.id,
          pageIndex: v.pageIndex,
          x: v.x,
          y: v.y,
          width: v.width,
          height: v.height,
          requireName: !!v.requireName,
          requireDate: !!v.requireDate,
          requireLive: !!v.requireLive,
          // The outline is baked into this exported page, so the re-detected box
          // is locked in place — click-to-sign only. Editing/moving comes from a
          // `.unipdf` backup, which restores the original unlocked annotation.
          locked: true
        })
      }
    }
    return out
  } catch {
    return []
  }
}

export function downloadPdfBytes(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  saveBlob(blob, fileName)
}

export async function exportPdfWithAnnotations(
  sourceBytes: ArrayBuffer,
  annotations: Annotation[],
  scale: number,
  fileName: string,
  formValues?: FormFieldValue[]
) {
  const bytes = await buildAnnotatedPdfBytes(sourceBytes, annotations, scale, formValues)
  const outName = fileName.replace(/\.pdf$/i, '') + '-v2.pdf'
  downloadPdfBytes(bytes, outName)
}

/**
 * Does this document contain any raster image at all?
 *
 * The point is to know whether the rasterising qualities ('balanced' /
 * 'strong') could POSSIBLY help before spending a pass finding out. They shrink
 * a file by re-encoding its pictures at a lower resolution; a document with no
 * pictures has nothing for them to take, so turning its pages into JPEGs only
 * ever inflates it — the comment on `fellBackToLossless` has the numbers, 7 KB
 * of text becoming ~860 KB of JPEG.
 *
 * Walks each page's Resources → XObject dictionary looking for a /Subtype
 * /Image. Cheap: dictionary lookups on an already-parsed document, no decoding
 * and no re-serialising.
 *
 * ⚠️ Deliberately errs towards TRUE. Every failure path — a malformed
 * resource dict, an XObject we cannot resolve, an exception — reports "there
 * might be images", because the cost of being wrong is asymmetric: a false
 * `true` shows a compression control that turns out not to help, while a false
 * `false` silently removes the one setting that would have shrunk someone's
 * 45 MB scan.
 */
export function hasRasterImages(pdf: PDFDocument): boolean {
  try {
    for (const page of pdf.getPages()) {
      const resources = page.node.Resources()
      if (!resources) return true // can't tell — assume it might
      const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
      if (!xobjects) continue // this page genuinely has none
      for (const key of xobjects.keys()) {
        const xobj = xobjects.lookupMaybe(key, PDFStream)
        if (!xobj) return true // unresolvable — assume it might
        const subtype = xobj.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)
        if (subtype === PDFName.of('Image')) return true
        // A Form XObject can nest images of its own. Rather than recurse
        // through arbitrary nesting, treat it as "might".
        if (subtype === PDFName.of('Form')) return true
      }
    }
    return false
  } catch {
    return true
  }
}

// 'light' keeps everything lossless (text stays selectable) and just re-packs
// the file with object streams. 'balanced' and 'strong' rasterize each page to
// JPEG — losing text selectability but shrinking image-heavy PDFs a lot — with
// progressively lower render resolution and JPEG quality.
export type CompressQuality = 'light' | 'balanced' | 'strong'

// ⚠️ 'balanced' is the default the landing page's 1-click compress uses, so it
// is the setting people actually judge the app by, and it has to survive being
// looked at. 1.5x/0.70 shrank a 12 MB pack to 860 KB but read visibly soft on
// screen — the gap to 'light' was a cliff, not a step. 2.0x (≈144 DPI) with
// JPEG 0.82 lands a few hundred KB higher and stays sharp; 'strong' keeps the
// aggressive end of the range for when size is all that matters.
const RASTER_SETTINGS: Record<'balanced' | 'strong', { renderScale: number; jpegQuality: number }> = {
  balanced: { renderScale: 2.0, jpegQuality: 0.82 },
  strong: { renderScale: 1.0, jpegQuality: 0.45 }
}

export interface CompressResult {
  bytes: Uint8Array
  originalSize: number
  compressedSize: number
  fileName: string
  quality: CompressQuality
  /** Set when a rasterising quality was asked for but produced a *bigger* file
   *  than the lossless pass, so the lossless bytes were returned instead. A
   *  text-only PDF is the common case: 7 KB of text becomes ~860 KB of JPEG. */
  fellBackToLossless?: boolean
}

// ⚠️ Mobile Safari refuses to back a canvas past roughly 16.7M pixels, and
// hands back a blank (or null) bitmap rather than an error. A4 at 2x is 2M and
// nowhere near it, but a poster-sized page is: A0 at 2x is 16M, right on the
// line. Cap the area and drop the scale to fit, so a big page degrades to a
// slightly softer render instead of a blank one.
const MAX_RASTER_PIXELS = 8_000_000

// Render one source page through pdfjs at the given DPI and return JPEG bytes.
async function rasterizePageToJpeg(
  pdfjsDoc: PDFDocumentProxy,
  pageIndex: number,
  renderScale: number,
  jpegQuality: number
): Promise<Uint8Array> {
  const page = await pdfjsDoc.getPage(pageIndex + 1)
  const unscaled = page.getViewport({ scale: 1 })
  const pixelsAtScale = unscaled.width * unscaled.height * renderScale * renderScale
  const scale =
    pixelsAtScale > MAX_RASTER_PIXELS
      ? renderScale * Math.sqrt(MAX_RASTER_PIXELS / pixelsAtScale)
      : renderScale
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  // JPEG has no alpha — paint white first so transparent regions don't go black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      jpegQuality
    )
  })
  return new Uint8Array(await blob.arrayBuffer())
}

// A rasterised result this much smaller than the input is a landslide the
// lossless pass cannot overturn: repacking removes structural slack, never
// image data, so a third off is a good day for it and half is out of reach.
// Below this ratio we skip the yardstick save entirely — see compressPdf.
const LANDSLIDE_RATIO = 0.5

/** Estimated output size of each rasterising quality, in bytes. */
export interface RasterEstimate {
  balanced: number
  strong: number
}

/**
 * Predict what the rasterising qualities would produce, WITHOUT doing the full
 * pass.
 *
 * The export dialog needs to know whether 'balanced' / 'strong' are worth
 * offering at all. Actually compressing at every quality to find out is not an
 * option: a rasterising pass over a long document is minutes of work, and the
 * whole point is to answer the question before the user commits to one.
 *
 * So: rasterise ONE page at each setting, measure the JPEG, and multiply by the
 * page count. Rasterising replaces every page with a picture of itself at fixed
 * render settings, so per-page output size is roughly uniform across a document
 * — which is exactly what makes one sample extrapolate honestly here, and would
 * not for a compressor whose output tracked the input's composition.
 *
 * ⚠️ Samples the MIDDLE page, not the first. A first page is disproportionately
 * often a cover, a title page or a mostly-blank letterhead — the least
 * representative page in the file, and one that compresses far smaller than the
 * dense pages after it. Sampling it would underestimate the output and offer a
 * saving that never arrives.
 *
 * The result is an estimate and is only ever used to decide whether to SHOW an
 * option. The size the dialog reports is always really measured.
 */
export async function estimateRasterSizes(sourceBytes: ArrayBuffer): Promise<RasterEstimate> {
  const pdfjsDoc = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise
  const pageCount = pdfjsDoc.numPages
  const sampleIndex = Math.floor(pageCount / 2)
  const measure = async (q: 'balanced' | 'strong') => {
    const { renderScale, jpegQuality } = RASTER_SETTINGS[q]
    const jpeg = await rasterizePageToJpeg(pdfjsDoc, sampleIndex, renderScale, jpegQuality)
    // + a little per page for the PDF object overhead wrapping each image.
    return (jpeg.byteLength + 512) * pageCount
  }
  return { balanced: await measure('balanced'), strong: await measure('strong') }
}

export async function compressPdf(
  sourceBytes: ArrayBuffer,
  fileName: string,
  quality: CompressQuality = 'light',
  onProgress: (fraction: number) => void = () => {},
  /**
   * Keep the rasterised pages even when they come out BIGGER than the lossless
   * save. Off everywhere that is compressing for size — where handing back a
   * larger file would be absurd — and on for the export dialog's "Flatten pages
   * to images" checkbox, where size is not what is being asked for.
   *
   * ⚠️ Without this, ticking that box on a text document silently does nothing:
   * the fallback below returns the lossless bytes, the text layer survives, and
   * the user sends out a file believing its text cannot be copied. That is the
   * one failure mode of this feature that is worse than not having it, because
   * it is invisible and it is the opposite of what was asked for.
   */
  keepRasterEvenIfBigger = false
): Promise<CompressResult> {
  const originalSize = sourceBytes.byteLength
  const outName = fileName.replace(/\.pdf$/i, '') + '-compressed.pdf'
  onProgress(0.05)

  if (quality === 'light') {
    const pdf = await PDFDocument.load(sourceBytes, { updateMetadata: false })
    onProgress(0.5)
    const bytes = await pdf.save({ useObjectStreams: true })
    onProgress(1)
    return { bytes, originalSize, compressedSize: bytes.byteLength, fileName: outName, quality }
  }

  const { renderScale, jpegQuality } = RASTER_SETTINGS[quality]
  // pdfjs detaches the buffer it's handed, so give it a copy and keep the
  // original for pdf-lib (which we use for each page's size, and for the
  // lossless yardstick below).
  const pdfjsDoc = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise
  const srcPdf = await PDFDocument.load(sourceBytes, { updateMetadata: false })
  const out = await PDFDocument.create()
  const pageCount = srcPdf.getPageCount()
  for (let i = 0; i < pageCount; i++) {
    const { width, height } = srcPdf.getPage(i).getSize()
    const imgBytes = await rasterizePageToJpeg(pdfjsDoc, i, renderScale, jpegQuality)
    const img = await out.embedJpg(imgBytes)
    const page = out.addPage([width, height])
    page.drawImage(img, { x: 0, y: 0, width, height })
    // Rendering is nearly all the wall-clock, so the bar is the page counter.
    onProgress(0.05 + ((i + 1) / pageCount) * 0.9)
  }
  const bytes = await out.save({ useObjectStreams: true })
  // ⚠️ Rasterising is only a win when there is something raster-shaped to win.
  // A text-only PDF turns 7 KB of glyphs into ~860 KB of JPEG — 100× bigger,
  // with the text no longer selectable. "Compress PDF(s)" must never hand back
  // a bigger file than it was given, so the lossless pass is the yardstick and
  // whichever is smaller wins. Same document either way; only the bytes differ.
  //
  // But that yardstick is the most expensive step in here — it serialises the
  // whole source document a second time, which on a 45 MB scan means a second
  // 45 MB buffer on top of the source, pdfjs's copy and the parsed doc. Big
  // files were dying on it. So only pay for it when the lossless pass could
  // plausibly win: a landslide raster result is already smaller than anything
  // a repack could produce, and is returned without measuring.
  if (bytes.byteLength < originalSize * LANDSLIDE_RATIO) {
    onProgress(1)
    return { bytes, originalSize, compressedSize: bytes.byteLength, fileName: outName, quality }
  }
  const lossless = await srcPdf.save({ useObjectStreams: true })
  onProgress(1)
  if (bytes.byteLength >= lossless.byteLength && !keepRasterEvenIfBigger) {
    return {
      bytes: lossless,
      originalSize,
      compressedSize: lossless.byteLength,
      fileName: outName,
      quality,
      fellBackToLossless: true
    }
  }
  return { bytes, originalSize, compressedSize: bytes.byteLength, fileName: outName, quality }
}
