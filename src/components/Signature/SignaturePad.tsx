import { useEffect, useRef, useState } from 'react'
import { Stage, Layer, Line } from 'react-konva'
import type Konva from 'konva'
import { UnisimQr, useUniversal } from '@unisim/sdk'
import { useSignatureStore, type SignatureExtras } from '../../stores/signatureStore'
import { useAnnotationStore } from '../../stores/annotationStore'
import { inkColorFor, renderInkSignature } from '../../lib/renderInk'
import {
  composeSignatureWithLabels,
  detailLines,
  labelsForOptions,
  isUnansweredNameLine,
  DEFAULT_LABEL_SCALE,
  DEFAULT_SIG_ALIGN,
  NAME_LINE_SEED,
  DETAIL_BLOCK_SEED,
  splitDetailBlock,
  dateLineSeed
} from '../../lib/composeSignature'
import type { SignatureData } from '../../types/annotations'
import { importImageAsSignature } from '../../lib/imageSignature'
import {
  mobileSignChannel,
  mobileSignUrl,
  randomPin,
  randomToken,
  type MobileSignPayload
} from '../../lib/mobileSign'

const PAD_W = 600
const PAD_H = 240

// iOS-style toggle used by the advanced options.
function OptionToggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700 select-none cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="relative w-9 h-5 rounded-full bg-slate-300 transition-colors peer-checked:bg-orange-500 peer-focus-visible:ring-2 peer-focus-visible:ring-orange-400 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-white after:rounded-full after:shadow after:transition-transform peer-checked:after:translate-x-4" />
      <span>{label}</span>
    </label>
  )
}

// A switch-gated input in the advanced options — the same pattern as the
// double-tap modal: the toggle above decides whether the line shows, the box
// holds the whole line as the user wrote it, and it's disabled while its
// toggle is off so it can never be typed into with no effect.
function GatedInput({
  value,
  onChange,
  enabled,
  placeholder,
  label
}: {
  value: string
  onChange: (v: string) => void
  enabled: boolean
  placeholder: string
  label: string
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      disabled={!enabled}
      className={`w-full px-3 py-2 border border-slate-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-500 ${enabled ? '' : 'opacity-50'}`}
    />
  )
}

export default function SignaturePad() {
  const open = useSignatureStore((s) => s.padOpen)
  const closePad = useSignatureStore((s) => s.closePad)
  const add = useSignatureStore((s) => s.add)
  // Id of the "Request signature" box being fulfilled, if any. When set the pad
  // fills that box (rather than adding a library signature) and offers the same
  // name/date options every other signature gets.
  const signingFieldId = useSignatureStore((s) => s.signingFieldId)
  const { supabase } = useUniversal()

  const stageRef = useRef<Konva.Stage>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [padW, setPadW] = useState(PAD_W)
  const [lines, setLines] = useState<number[][]>([])
  const drawingRef = useRef(false)
  // What the signature is called in the library list — never part of the
  // signature itself. The name that bakes under the ink is `nameLine` below.
  const [title, setTitle] = useState('')
  // Advanced options: which extras to attach, and how they're placed. All of
  // them start OFF — a fresh pad produces exactly what the user drew, and the
  // extras are opt-in under "Advanced options". Same switch-gates-its-input
  // pattern as the double-tap options modal, so the two dialogs read alike.
  const [includeDetails, setIncludeDetails] = useState(false)
  const [includeDate, setIncludeDate] = useState(false)
  // ONE box for the lines under the signature — the name is simply its first
  // line, set larger. The date stays its own field: it is the one line the app
  // fills in for you, so it gets its own switch.
  const [detailBlock, setDetailBlock] = useState('')
  const [dateLine, setDateLine] = useState('')
  // Realistic ink (blue, blemishes, variable width) vs a clean plain-black line.
  const [realistic, setRealistic] = useState(false)
  // false → bake name/date into the signature image (one click places all).
  // true  → keep the image ink-only and drop name/date as separate text the
  //         user positions with extra clicks (e.g. into a form's name field).
  const [separatePlacement, setSeparatePlacement] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // True when the box being fulfilled asked for live ink. Surfaced to the signer
  // so the requirement is visible to the person it constrains; the pad's own
  // Draw / Sign-on-phone modes already produce nothing but drawn ink, so there
  // is no upload path here to disable.
  const [fieldRequiresLive, setFieldRequiresLive] = useState(false)

  // ── Sign-on-phone handoff (mirrors Ergo Assess) ───────────────────────────
  const [mode, setMode] = useState<'draw' | 'phone'>('draw')
  const [token, setToken] = useState(randomToken)
  const [pin, setPin] = useState(randomPin)
  const [phoneStatus, setPhoneStatus] = useState<'waiting' | 'received'>('waiting')

  // Fresh token + PIN every time the pad opens, so a QR from an earlier
  // session can't feed a signature into this one.
  useEffect(() => {
    if (!open) return
    setMode('draw')
    setToken(randomToken())
    setPin(randomPin())
    setPhoneStatus('waiting')
  }, [open])

  // Fulfilling a "Request signature" box: seed the same name/date options the
  // box asked for (and surface them) so the signer gets exactly the options
  // every other signature gets, rather than having them silently dictated by
  // the request. They stay editable — the signer can add or drop either one.
  useEffect(() => {
    if (!open || !signingFieldId) {
      setFieldRequiresLive(false)
      return
    }
    const ann = useAnnotationStore
      .getState()
      .annotations.find((a) => a.id === signingFieldId)
    if (ann?.type !== 'sigfield') return
    setIncludeDetails(!!ann.requireName)
    if (ann.requireName) setDetailBlock((b) => (b.trim() ? b : NAME_LINE_SEED))
    setIncludeDate(!!ann.requireDate)
    if (ann.requireDate) setDateLine((l) => (l.trim() ? l : dateLineSeed()))
    setFieldRequiresLive(!!ann.requireLive)
    // Baked into the box (never a separate click) — a request box is a fixed
    // slot, so the labels always travel inside it.
    setSeparatePlacement(false)
    if (ann.requireName || ann.requireDate) setAdvancedOpen(true)
  }, [open, signingFieldId])

  // While in phone mode: listen for the phone's signature. (The QR draws
  // itself — see <UnisimQr> below.)
  useEffect(() => {
    if (!open || mode !== 'phone') return
    const channel = supabase.channel(mobileSignChannel(token))
    channel
      .on('broadcast', { event: 'signature' }, (msg) => {
        const payload = msg.payload as MobileSignPayload
        if (payload?.pin !== pin || !payload.signature) return
        setPhoneStatus('received')
        // The phone canvas has a white background — run it through the same
        // clean-up as imported signature images (crop + background removal)
        // so it places like an ink signature.
        const bytes = Uint8Array.from(atob(payload.signature), (c) => c.charCodeAt(0))
        const file = new File([bytes], 'phone-signature.png', { type: 'image/png' })
        importImageAsSignature(file, { removeBg: true })
          .then((res) => {
            // Signing a specific request box: drop the phone signature straight
            // into it after a beat, so the "received ✓" tick is visible.
            const fieldId = useSignatureStore.getState().signingFieldId
            if (fieldId) {
              setTimeout(() => {
                fillField(fieldId, res, splitDetailBlock(detailBlock).name.trim())
              }, 700)
              return
            }
            const count = useSignatureStore.getState().signatures.length
            add({ name: `Signature ${count + 1}`, dataUrl: res.dataUrl, width: res.width, height: res.height })
            setTimeout(() => {
              closePad()
              // Arm the signature tool so the user can immediately place it.
              useAnnotationStore.getState().setTool('signature')
            }, 700)
          })
          .catch(() => setPhoneStatus('waiting'))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [open, mode, token, pin, supabase, add, closePad])

  useEffect(() => {
    if (!open) return
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const available = Math.max(200, Math.min(PAD_W, el.clientWidth))
      setPadW(Math.floor(available))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // `mode` is a dep so the draw container is re-measured when switching
    // back from the phone view (it remounts fresh).
  }, [open, mode])

  const padH = Math.round((padW / PAD_W) * PAD_H)
  // The details box is one string; the compose layer still wants a name and the
  // smaller lines separately, so it is split here and nowhere else.
  const { name: rawName, details } = splitDetailBlock(detailBlock)
  // The name that would actually bake or place: the typed line, unless it's
  // still the untouched "Signed by: " seed (an unanswered prompt, not a name).
  const effectiveName = isUnansweredNameLine(rawName) ? '' : rawName.trim()
  const includeName = includeDetails
  // Whether there's anything to place separately (gates the placement control).
  //
  // ⚠️ Gated on the SWITCHES, not on what has been typed yet. It used to require
  // `includeDetails && effectiveName`, so turning "Add your details" on left the
  // control greyed out until a name was typed over the "Signed by: " seed — and
  // since turning "Add date" on lit it up immediately, the control read as
  // belonging to the date alone (owner, 2026-08-29). A control that appears on
  // one switch and not the other is describing a rule nobody wrote down.
  const hasExtras = includeDetails || includeDate
  // The label lines the advanced options will produce, previewed live inside
  // the drawing box. Built through the same helper the bake uses, so what the
  // preview shows is exactly what ships — untouched seeds stay invisible here
  // for the same reason they never bake.
  const previewLabels = labelsForOptions({
    name: effectiveName,
    showName: includeDetails && !!effectiveName,
    details,
    showDetails: includeDetails,
    showDate: includeDate,
    dateText: dateLine.trim() || undefined
  })
  // Where the drawn strokes sit in the pad, cropped the way renderInkSignature
  // crops them (6px of padding) — the preview hangs its labels off this box,
  // so it sits exactly where the bake will put them.
  const inkBox = (() => {
    if (lines.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const pts of lines) {
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const x = pts[i]
        const y = pts[i + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (!isFinite(minX)) return null
    const p = 6
    return { left: minX - p, right: maxX + p, top: minY - p, bottom: maxY + p }
  })()

  // The bake's own numbers (composeSignature's layout()), so the preview is
  // the same block at the same size — not something that merely resembles it.
  const inkH = inkBox ? inkBox.bottom - inkBox.top : 0
  const labelBaseFont = Math.min(28, Math.max(14, inkH * 0.4))
  const labelGap = Math.max(4, inkH * 0.08)
  const labelBlockH = previewLabels.reduce(
    (a, l) => a + labelBaseFont * DEFAULT_LABEL_SCALE * l.scale * 1.3,
    0
  )
  // The drawing box stretches so the labels always fit BELOW the ink. A
  // signature drawn at the bottom of the pad pushes its own caption past the
  // original frame, and the frame follows rather than cropping it — which is
  // also what the composite does on the page.
  const previewHeight =
    previewLabels.length > 0
      ? Math.max(padH, (inkBox ? inkBox.bottom : padH) + labelGap + labelBlockH + 10)
      : padH
  // Ink colour follows the realism toggle (deep blue vs plain near-black).
  const inkColor = inkColorFor(realistic)

  if (!open) return null

  function pos(e: Konva.KonvaEventObject<PointerEvent>) {
    return e.target.getStage()!.getPointerPosition()!
  }

  function onPointerDown(e: Konva.KonvaEventObject<PointerEvent>) {
    drawingRef.current = true
    const p = pos(e)
    setLines((prev) => [...prev, [p.x, p.y]])
  }

  function onPointerMove(e: Konva.KonvaEventObject<PointerEvent>) {
    if (!drawingRef.current) return
    const p = pos(e)
    setLines((prev) => {
      const out = prev.slice(0, -1)
      const last = prev[prev.length - 1]
      out.push([...last, p.x, p.y])
      return out
    })
  }

  function onPointerUp() {
    drawingRef.current = false
  }

  function clear() {
    setLines([])
  }

  function resetForm() {
    setLines([])
    setTitle('')
    setIncludeDetails(false)
    setIncludeDate(false)
    setDetailBlock('')
    setDateLine('')
    setSeparatePlacement(false)
    setRealistic(false)
    setAdvancedOpen(false)
  }

  // Toggling an extra on with nothing typed seeds its box so the expected
  // shape is visible; the text then belongs entirely to the user.
  const toggleIncludeDetails = (v: boolean) => {
    setIncludeDetails(v)
    if (v && !detailBlock.trim()) setDetailBlock(DETAIL_BLOCK_SEED)
  }
  const toggleIncludeDate = (v: boolean) => {
    setIncludeDate(v)
    if (v && !dateLine.trim()) setDateLine(dateLineSeed())
  }

  function cancel() {
    resetForm()
    closePad()
  }

  // Bake the ink (plus the field's requested name/date labels) into a single
  // PNG and drop it into the signature-request box the user clicked, then
  // return to the editor. Used when the pad was opened by clicking a field.
  // `strokes` is the raw pen path behind `sig` when it came from this pad. It
  // rides along so the placed signature's realism can still be toggled later;
  // a phone/imported image arrives already rasterised and passes nothing.
  async function fillField(
    fieldId: string,
    sig: { dataUrl: string; width: number; height: number },
    trimmedName: string,
    strokes?: number[][]
  ) {
    const ann = useAnnotationStore.getState().annotations.find((a) => a.id === fieldId)
    if (!ann || ann.type !== 'sigfield') {
      resetForm()
      closePad()
      return
    }
    // The signer's chosen options (seeded from the request, but freely
    // adjustable in the pad) decide which labels get baked in.
    const wantName = includeName && !!trimmedName
    const wantDate = includeDate
    // Built through the same helper the re-edit path uses, so a signature looks
    // identical whether it was just drawn or restyled an hour later.
    const labels = labelsForOptions({
      name: trimmedName,
      showName: wantName,
      details,
      showDetails: includeDetails,
      showDate: wantDate,
      dateText: dateLine.trim() || undefined
    })

    let src = sig.dataUrl
    let w = sig.width
    let h = sig.height
    if (labels.length > 0) {
      const composed = await composeSignatureWithLabels(sig.dataUrl, sig.width, sig.height, labels, inkColor)
      src = composed.dataUrl
      w = composed.width
      h = composed.height
    }
    // Carry the untouched ink + options so the box's name/date stay re-editable
    // (double-tap) and restyleable (size/alignment pill) later.
    const data: SignatureData = {
      ink: sig.dataUrl,
      inkWidth: sig.width,
      inkHeight: sig.height,
      name: trimmedName || undefined,
      showName: wantName,
      details: details || undefined,
      showDetails: includeDetails,
      showDate: wantDate,
      dateText: dateLine.trim() || undefined,
      align: DEFAULT_SIG_ALIGN,
      labelScale: DEFAULT_LABEL_SCALE,
      color: inkColor,
      strokes: strokes && strokes.length > 0 ? strokes : undefined,
      realistic
    }
    useAnnotationStore.getState().update(fieldId, { signed: { src, width: w, height: h, data } })
    resetForm()
    closePad()
    useAnnotationStore.getState().setTool('select')
  }

  async function save() {
    if (lines.length === 0) return
    const ink = renderInkSignature(lines, inkColor, realistic)
    if (!ink) return

    // If the pad was opened by clicking a signature-request box, fill that box
    // instead of adding a reusable library signature.
    const fieldId = useSignatureStore.getState().signingFieldId
    if (fieldId) {
      await fillField(fieldId, ink, effectiveName, lines)
      return
    }

    const sigName = title.trim() || `Signature ${useSignatureStore.getState().signatures.length + 1}`
    const wantName = includeName && !!effectiveName
    const wantDate = includeDate
    const wantDetails = includeDetails && detailLines(details).length > 0

    let finalUrl = ink.dataUrl
    let finalW = ink.width
    let finalH = ink.height
    let extras: SignatureExtras | undefined

    // Details ARE placed separately now (owner, 2026-08-29). They used to be
    // excluded — "a block that belongs under the ink", and three clicks to land
    // a role and an email judged more than anyone wants — but the exclusion was
    // SILENT: picking "Separate click" with details on baked everything anyway,
    // so the control did nothing and said nothing about doing nothing. One line
    // per click is also the right shape for what this is for, since each piece
    // is headed for a form field and a form field holds one line.
    if ((wantName || wantDate || wantDetails) && separatePlacement) {
      // Image stays ink-only; every label is placed by an extra click, each
      // line exactly as written in the pad.
      extras = {
        name: wantName ? effectiveName : undefined,
        details: wantDetails ? detailLines(details) : undefined,
        date: wantDate,
        dateText: dateLine.trim() || undefined,
        color: inkColor
      }
    } else if (wantName || wantDate || wantDetails) {
      // Bake the labels beneath the ink so they travel as one image.
      const labels = labelsForOptions({
        name: effectiveName,
        showName: wantName,
        details,
        showDetails: includeDetails,
        showDate: wantDate,
        dateText: dateLine.trim() || undefined
      })
      const composed = await composeSignatureWithLabels(ink.dataUrl, ink.width, ink.height, labels, inkColor)
      finalUrl = composed.dataUrl
      finalW = composed.width
      finalH = composed.height
    }

    // Carry the untouched ink + baked-label options onto the library signature
    // so, once placed, its name/date can be re-edited (double-tap) and restyled
    // (size/alignment pill) without ever redrawing the strokes. Separately-
    // placed labels aren't baked into the image, so the image starts label-free.
    const sig: SignatureData = {
      ink: ink.dataUrl,
      inkWidth: ink.width,
      inkHeight: ink.height,
      name: wantName ? effectiveName : undefined,
      showName: wantName && !separatePlacement,
      details: details || undefined,
      // ⚠️ `&& !separatePlacement` for the same reason as showName and showDate
      // either side of it: separately-placed labels are not part of the image,
      // so re-placing this signature from the library must not draw them back
      // under the ink.
      showDetails: includeDetails && !separatePlacement,
      showDate: wantDate && !separatePlacement,
      dateText: dateLine.trim() || undefined,
      align: DEFAULT_SIG_ALIGN,
      labelScale: DEFAULT_LABEL_SCALE,
      color: inkColor,
      // Keep the pen path so realism stays a toggle after placement, not a
      // decision frozen at draw time.
      strokes: lines,
      realistic
    }

    add({ name: sigName, dataUrl: finalUrl, width: finalW, height: finalH, extras, sig })
    resetForm()
    closePad()
    useAnnotationStore.getState().setTool('signature')
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      onClick={(e) => { if (e.target === e.currentTarget) cancel() }}
    >
      {/* ⚠️ Capped at the viewport and split: the title row and the mode
          toggle are pinned, the pad and its controls scroll.
          `min(100%,100dvh)` rather than a `vh` cap — `vh` is the LARGE
          viewport on iOS, so a `vh`-capped box can still overrun the visible
          area once the browser chrome shows. */}
      <div className="bg-white rounded-lg shadow-2xl p-5 max-w-full flex max-h-[min(100%,100dvh)] flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 mb-3">
          <h2 className="text-lg font-semibold text-slate-900">
            {mode === 'phone' ? 'Send to sign' : 'Draw signature'}
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setMode('draw')}
                className={`rounded-md px-2.5 py-1 transition ${mode === 'draw' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Draw
              </button>
              {/* Orange + phone icon so the "send to sign" option is easy
                  to spot — signing with a mouse on desktop is fiddly. */}
              <button
                type="button"
                onClick={() => setMode('phone')}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition ${mode === 'phone' ? 'bg-orange-700 text-white' : 'text-orange-700 hover:bg-orange-700/10 hover:text-orange-800'}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="7" y="2" width="10" height="20" rx="2.5" /><line x1="11" y1="18" x2="13" y2="18" />
                </svg>
                Send to sign
              </button>
            </div>
            <button
              onClick={cancel}
              className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center"
            >
              ×
            </button>
          </div>
        </div>
        <div className="-mx-5 min-h-0 flex-1 overflow-y-auto px-5">
        {/* The box asked for live ink. Worded as what the document asks for —
            NOT as a guarantee the ink is verified — because this is a
            client-side constraint, the same class of claim as the signing
            certificate page. */}
        {fieldRequiresLive && (
          <p className="mb-3 rounded-md bg-orange-50 border border-orange-200 px-3 py-2 text-xs text-orange-800" style={{ maxWidth: padW }}>
            This box asks to be signed here rather than with an uploaded image.
            Drawing it on your phone counts — that is drawn ink too.
          </p>
        )}
        {mode === 'phone' ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center" style={{ width: padW }}>
            {/* Click enlarges it — this dialog is a small window on a big
                screen, and the code is being read by a camera held up to it. */}
            <UnisimQr
              value={mobileSignUrl(token)}
              size={192}
              label="signing on your phone"
              className="rounded-lg"
              lightbox={{
                title: "Point your phone's camera at this code",
                hint: (
                  <>
                    Then enter this PIN on your phone:
                    <span className="mt-1 block text-2xl font-bold tracking-[0.3em] text-white">{pin}</span>
                  </>
                )
              }}
            />
            <p className="text-sm text-slate-600">Scan with your phone, then enter this PIN:</p>
            <p className="text-2xl font-bold tracking-[0.3em] text-slate-900">{pin}</p>
            <p className={`text-xs ${phoneStatus === 'received' ? 'text-green-600' : 'text-slate-400'}`}>
              {phoneStatus === 'received' ? 'Signature received ✓' : 'Waiting for your phone…'}
            </p>
            <button
              type="button"
              onClick={cancel}
              className="mt-1 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded text-sm"
            >
              Cancel
            </button>
          </div>
        ) : (
        <>
        <div
          ref={containerRef}
          className="relative border-2 border-dashed border-slate-300 rounded bg-slate-50 w-full transition-[height] duration-200"
          style={{ height: previewHeight }}
        >
          {/* Live preview of the labels the advanced options will bake — laid
              out the way the bake lays them out (composeSignature's layout()):
              hanging beneath the cropped ink, left-aligned with its edge, at
              the font size the ink's height implies. Until something is drawn
              the block waits at the bottom-left. Inert: drawing passes
              straight through it.
              ⚠️ The labels NEVER overlap the ink, even when the signature is
              drawn at the very bottom of the pad — the box grows instead (see
              previewHeight). An earlier version clamped the block upward and
              let it sit over the strokes, which is not what the bake does and
              read as a collision rather than a caption. */}
          {previewLabels.length > 0 &&
            (() => {
              const pos = inkBox
                ? { left: Math.max(2, inkBox.left), top: inkBox.bottom + labelGap }
                : { left: 12, top: padH + labelGap }
              return (
                <div
                  className="pointer-events-none absolute select-none whitespace-nowrap"
                  style={{
                    ...pos,
                    color: inkColor,
                    // Under "Separate click" these lines are NOT baked into the
                    // image — they are a queue of pieces the user will click
                    // into place. So the preview stops pretending to be a
                    // caption and shows them as detached: dimmer, ringed. An
                    // `outline` and not a border on purpose — it draws outside
                    // the box, so the block does not move when the mode flips.
                    opacity: separatePlacement ? 0.5 : 0.85,
                    outline: separatePlacement ? '1px dashed currentColor' : undefined,
                    outlineOffset: '3px',
                    fontFamily: 'Helvetica, Arial, sans-serif'
                  }}
                >
                  {previewLabels.map((l, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: labelBaseFont * DEFAULT_LABEL_SCALE * l.scale,
                        lineHeight: 1.3
                      }}
                    >
                      {l.text}
                    </div>
                  ))}
                </div>
              )
            })()}
          <Stage
            ref={stageRef}
            width={padW}
            height={padH}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{ touchAction: 'none', cursor: 'crosshair' }}
          >
            <Layer>
              {lines.map((points, i) => (
                <Line
                  key={i}
                  points={points}
                  stroke={inkColor}
                  strokeWidth={2.5}
                  lineCap="round"
                  lineJoin="round"
                  tension={0.4}
                />
              ))}
            </Layer>
          </Stage>
        </div>
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* Titles the library entry only — the name that bakes under the
                ink lives in "Add your name" below. */}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Signature name (optional)"
              className="flex-1 min-w-40 px-3 py-2 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <button
              onClick={clear}
              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded text-sm"
            >
              Clear
            </button>
            <button
              onClick={cancel}
              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded text-sm"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={lines.length === 0}
              className="px-4 py-2 bg-orange-700 hover:bg-orange-800 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded text-sm font-medium"
            >
              Save
            </button>
          </div>

          {/* Advanced options — name/details/date extras and how they're placed. */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
              aria-expanded={advancedOpen}
            >
              <span className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}>▸</span>
              Advanced options
            </button>

            {advancedOpen && (
              <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
                <OptionToggle checked={realistic} onChange={setRealistic} label="Make it look more realistic" />
                {/* One box, one switch. Every line typed becomes a line under
                    the signature; the first is set larger, because it is
                    almost always the name. */}
                <OptionToggle
                  checked={includeDetails}
                  onChange={toggleIncludeDetails}
                  label="Add your details"
                />
                <textarea
                  value={detailBlock}
                  onChange={(e) => setDetailBlock(e.target.value)}
                  rows={4}
                  placeholder={DETAIL_BLOCK_SEED}
                  aria-label="Details to show under the signature"
                  disabled={!includeDetails}
                  className={`w-full px-3 py-2 border border-slate-300 rounded text-sm bg-white resize-y focus:outline-none focus:ring-2 focus:ring-orange-500 ${includeDetails ? '' : 'opacity-50'}`}
                />
                <OptionToggle checked={includeDate} onChange={toggleIncludeDate} label="Add date" />
                {/* Seeded with today's date, then the whole line is the user's
                    to edit — wording and date alike. */}
                <GatedInput
                  value={dateLine}
                  onChange={setDateLine}
                  enabled={includeDate}
                  placeholder={dateLineSeed()}
                  label="Date line under the signature"
                />

                <div className={hasExtras ? '' : 'opacity-50 pointer-events-none'}>
                  <div className="text-xs font-medium text-slate-500 mb-1">When placed</div>
                  <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
                    <button
                      type="button"
                      onClick={() => setSeparatePlacement(false)}
                      className={`px-3 py-1.5 ${!separatePlacement ? 'bg-orange-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}
                    >
                      With signature
                    </button>
                    <button
                      type="button"
                      onClick={() => setSeparatePlacement(true)}
                      className={`px-3 py-1.5 border-l border-slate-300 ${separatePlacement ? 'bg-orange-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}
                    >
                      Separate click
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    “Separate click” places each line on a click of its own, so
                    every one can go in a form’s own field.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        </>
        )}
        </div>
      </div>
    </div>
  )
}
