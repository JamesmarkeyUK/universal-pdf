import { pdfjsLib } from './pdfjs'
import type { PDFDocumentProxy, PDFPageProxy } from './pdfjs'

// A single text run from pdf.js, positioned in "annotation space" — the
// scale-1 viewport (PDF points, top-left origin, y-down). That's the same
// space annotations are stored in (pointer / liveScale) and the space export
// bakes redactions in (EXPORT_SCALE = 1), so a box from here can be used
// verbatim both to draw a highlight (×liveScale) and to create a redaction.
export interface ExtractedItem {
  // Character offset of this run's first char within the page's `text`.
  start: number
  len: number
  x: number
  y: number
  w: number
  h: number
  // Where each character STARTS across the run, as a fraction of `w`, with a
  // final 1 so a slice [a, b) spans `offsets[a] … offsets[b]`. Length is
  // `len + 1`.
  //
  // ⚠️ This exists because the obvious `w / len` is a MONOSPACE assumption, and
  // almost no PDF is monospaced. On "The secret codeword is Bandicoot on this
  // line." at 14pt Helvetica, dividing by character count put the box round
  // "Bandicoot" at 201.8–259.7pt when the glyphs sit at 208.6–270.8 — it started
  // early and stopped 11.2pt short, leaving "ot" of the redacted word legible on
  // the exported page. The text was still removed, so nothing in the FILE gave
  // it away; only the picture did.
  offsets: number[]
}

export interface PageText {
  pageIndex: number
  // Raw concatenation of every run's string (plus a newline after runs that end
  // a visual line). Offsets in `items` index into this. `lower` is the same
  // string lower-cased for case-insensitive search — lower-casing preserves
  // length so offsets stay valid.
  text: string
  lower: string
  items: ExtractedItem[]
}

// An axis-aligned box in annotation space. A single match can produce several
// (one per text run / line it spans).
export interface MatchRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SearchMatch {
  pageIndex: number
  start: number
  end: number
  rects: MatchRect[]
}

// ── Where the characters inside a run actually sit ───────────────────────────
//
// pdf.js hands back one width for a whole run, not per glyph. To place a box
// round a substring we need the split, and the honest way to get it is to
// measure the glyphs.
//
// The absolute size of the measuring font does not matter, and neither does
// getting the exact face: the offsets are NORMALISED by the run's own measured
// total and then multiplied by the width pdf.js reported, so only the RATIOS
// between characters are used. A generic family with the right proportions —
// which is all `styles[].fontFamily` gives us, and is what pdf.js's own text
// layer lays selection out with — lands within a fraction of a point.
const MEASURE_PX = 100
let measureCtx: CanvasRenderingContext2D | null | undefined
function measurer(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx
  try {
    measureCtx = document.createElement('canvas').getContext('2d')
  } catch {
    measureCtx = null
  }
  return measureCtx
}

// One advance per (family, character). Runs share characters heavily, and a
// page of prose is thousands of measureText calls without this.
const advanceCache = new Map<string, number>()
function advance(ctx: CanvasRenderingContext2D, family: string, ch: string): number {
  const key = family + ' ' + ch
  const hit = advanceCache.get(key)
  if (hit !== undefined) return hit
  const w = ctx.measureText(ch).width
  advanceCache.set(key, w)
  return w
}

/**
 * Fractional start offset of every character in `str`, plus a trailing 1.
 *
 * Falls back to an even split where there is no canvas (a worker, a test) or the
 * measurement comes back degenerate — the old behaviour, which is wrong but
 * never worse than wrong.
 */
export function charOffsets(str: string, fontFamily: string): number[] {
  const n = str.length
  const even = () => Array.from({ length: n + 1 }, (_, i) => (n > 0 ? i / n : 0))
  if (n === 0) return [0]
  const ctx = measurer()
  if (!ctx) return even()
  ctx.font = `${MEASURE_PX}px ${fontFamily || 'sans-serif'}`
  const running: number[] = [0]
  let total = 0
  for (let i = 0; i < n; i++) {
    total += advance(ctx, fontFamily, str[i])
    running.push(total)
  }
  // A run whose glyphs the measuring font has nothing for (symbol fonts, some
  // subset encodings) measures as zero. There are no ratios to be had, so don't
  // invent any.
  if (total <= 0) return even()
  return running.map((v) => v / total)
}

export async function extractPageText(page: PDFPageProxy, pageIndex: number): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const styles = (content.styles ?? {}) as Record<string, { fontFamily?: string }>
  const items: ExtractedItem[] = []
  let text = ''

  for (const raw of content.items) {
    // Skip TextMarkedContent entries (begin/end markers) — only TextItems have a
    // string and a transform.
    if (!('str' in raw)) continue
    const it = raw as {
      str: string
      transform: number[]
      width: number
      height: number
      hasEOL?: boolean
      fontName?: string
    }
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform)
    // Vertical extent of the run = magnitude of the matrix's vertical basis.
    const h = Math.hypot(tx[2], tx[3]) || it.height || 0
    const x = tx[4]
    const y = tx[5] - h // baseline → top-left
    const start = text.length
    // The family pdf.js chose for this run. Absent on an unstyled run, in which
    // case the measurer falls back to sans-serif.
    const family = (it.fontName && styles[it.fontName]?.fontFamily) || 'sans-serif'
    items.push({
      start,
      len: it.str.length,
      x,
      y,
      w: it.width,
      h,
      offsets: charOffsets(it.str, family)
    })
    text += it.str
    // Keep visual lines apart so two stacked lines can't form a false match
    // across the gap. The newline maps to no run, so it never lands in a rect.
    if (it.hasEOL) text += '\n'
  }

  return { pageIndex, text, lower: text.toLowerCase(), items }
}

export async function extractDocText(doc: PDFDocumentProxy): Promise<PageText[]> {
  const out: PageText[] = []
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1)
    out.push(await extractPageText(page, i))
  }
  return out
}

// Map a character range [s, e) within a page to the boxes covering it. A run is
// split by the MEASURED position of its glyphs (see `offsets`), so a match that
// starts or ends mid-run gets a box on the words rather than near them; a match
// spanning several runs yields one rect each.
function rectsForRange(pt: PageText, s: number, e: number): MatchRect[] {
  const rects: MatchRect[] = []
  for (const it of pt.items) {
    const a = Math.max(s, it.start)
    const b = Math.min(e, it.start + it.len)
    if (a >= b) continue
    // Defensive: an item built by hand, or restored from an older shape, must
    // degrade to the even split rather than produce NaN geometry.
    const even = (i: number) => (it.len > 0 ? i / it.len : 0)
    const from = it.offsets?.[a - it.start] ?? even(a - it.start)
    const to = it.offsets?.[b - it.start] ?? even(b - it.start)
    rects.push({
      x: it.x + from * it.w,
      y: it.y,
      w: (to - from) * it.w,
      h: it.h
    })
  }
  return rects
}

export function findInPage(pt: PageText, needleLower: string): SearchMatch[] {
  const matches: SearchMatch[] = []
  if (!needleLower) return matches
  let idx = pt.lower.indexOf(needleLower)
  while (idx !== -1) {
    const end = idx + needleLower.length
    matches.push({ pageIndex: pt.pageIndex, start: idx, end, rects: rectsForRange(pt, idx, end) })
    idx = pt.lower.indexOf(needleLower, end)
  }
  return matches
}

// All matches across the document, in reading order (page, then position).
export function findInDoc(pages: PageText[], query: string): SearchMatch[] {
  const needle = query.toLowerCase()
  if (!needle.trim()) return []
  const out: SearchMatch[] = []
  for (const pt of pages) out.push(...findInPage(pt, needle))
  return out
}
