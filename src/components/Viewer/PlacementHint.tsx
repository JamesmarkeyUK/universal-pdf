import { useState } from 'react'
import { useAnnotationStore } from '../../stores/annotationStore'
import { useSignatureStore } from '../../stores/signatureStore'
import { useCoarsePointer } from '../../hooks/useCoarsePointer'

// "Don't show again" is PERMANENT and has no way back, matching the ruling on
// the mobile welcome coach-mark (James, 2026-09-01: a prompt that reappears
// after you have read it "is not onboarding, it is a nag"). Cancel is the other
// button and means something else entirely — abandon the armed placement — so
// the two are never collapsed into one.
const DISMISSED_KEY = 'universal-pdf-placement-hint-dismissed'

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    // Private mode / blocked site data. Showing the card is the safe answer:
    // the state it describes is otherwise invisible.
    return false
  }
}

function persistDismissed() {
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    /* ignore — it stays hidden for this session either way */
  }
}

// The banner that says a placement is ARMED and waiting for a tap.
//
// ⚠️ Why this exists (owner, 2026-08-30: "you need an indicator to show that you
// need to tap to place the signature / name / date, or QR code for example,
// otherwise you're not sure what to do"). Saving a signature, or hitting "Add to
// page" in the QR dialog, closes the dialog and leaves the app in a state with
// no visible difference from the one before it: a tool is armed and the very
// next tap on the page drops something. The only feedback was the cursor-
// following ghost in AnnotationLayer — which needs a HOVER, so on a phone there
// was no feedback at all, and even on desktop only the signature had one (an
// armed QR / picture had none on any device).
//
// It is deliberately not a toast: it must stay up for exactly as long as the
// state it describes, and go the instant the thing lands. Nothing is timed.
//
// ⚠️ The card is SEE-THROUGH (James, 2026-09-06: "make this popup transparent so
// you can click behind it and still see the signature / object"). It was
// `bg-white/95` + `backdrop-blur`, which is opaque in practice — sitting in the
// centre of the page it hid the very spot the user was being told to tap, along
// with the armed signature's cursor ghost and whatever they were aiming at. The
// backdrop blur mattered more than the alpha did: even at a low opacity it
// smears everything underneath, so it is gone rather than softened. Legibility
// is bought back with a white text halo instead of an opaque plate, so the text
// survives a dark region of the page without the card having to hide it.
//
// ⚠️ It sits in the MIDDLE of the document area, not under the toolbar (James,
// 2026-09-05: "the tooltip that appears at the top for signature placement etc
// needs to be more prominent - maybe in the centre of the screen, with a don't
// show again option"). A pill tucked against the top edge is exactly where a
// browser puts its own chrome, and it was being read as decoration by the
// people it was written for. Covering the page is affordable *because* the
// thing it announces ends the moment the page is tapped — the card is never up
// for longer than one gesture — and the whole overlay stays
// `pointer-events-none` but for its buttons, so that gesture still lands.

type Prompt = {
  /** The instruction itself. */
  label: string
  /** Secondary line — what specifically is about to land. */
  detail?: string
  /** Thumbnail of the thing being placed, when there is an image of it. */
  preview?: string
  /** Undo the armed state. Named so the button can say what it abandons. */
  cancel: () => void
}

const EXTRA_NOUN: Record<'name' | 'details' | 'date', string> = {
  name: 'name',
  details: 'details',
  date: 'date',
}

export default function PlacementHint() {
  // Read once on mount: nothing else in the app writes this key, so there is
  // no state to keep in step with.
  const [dismissed, setDismissed] = useState(isDismissed)
  const tool = useAnnotationStore((s) => s.tool)
  const uploadedImageSrc = useAnnotationStore((s) => s.uploadedImageSrc)
  const uploadedImageQr = useAnnotationStore((s) => s.uploadedImageQr)
  const pendingExtras = useSignatureStore((s) => s.pendingExtras)
  const activeSignature = useSignatureStore((s) => {
    const id = s.activeId
    return id ? s.signatures.find((x) => x.id === id) ?? null : null
  })
  // "Tap" on glass, "Click" with a mouse. The instruction is only useful if it
  // names the gesture the reader actually has.
  const verb = useCoarsePointer() ? 'Tap' : 'Click'

  const prompt = ((): Prompt | null => {
    // Mid-sequence first: with extras queued the signature is already down and
    // the tool is still 'signature', so this case has to win over the one below.
    if (tool === 'signature' && pendingExtras.length > 0) {
      const next = pendingExtras[0]
      const more = pendingExtras.length - 1
      return {
        label: `${verb} where the ${EXTRA_NOUN[next.kind]} should go`,
        detail: more > 0 ? `“${next.text}” — ${more} more after this` : `“${next.text}”`,
        cancel: () => {
          useSignatureStore.getState().setPendingExtras([])
          useAnnotationStore.getState().setTool('select')
        },
      }
    }
    // Both of the tools below do NOTHING on a tap without their payload, so the
    // payload — not the tool — is what gates the banner.
    if (tool === 'signature' && activeSignature) {
      // A stamp is armed through the same tool and the same library — the
      // " Stamp" name suffix is how the Sign menu and the stamp picker tell the
      // two apart, so the card names what is actually about to land rather
      // than calling an APPROVED stamp a signature. It matters more now the
      // card is the centre of the screen than it did as a top-edge pill.
      const isStamp = activeSignature.name.endsWith(' Stamp')
      return {
        label: `${verb} the page to place your ${isStamp ? 'stamp' : 'signature'}`,
        preview: activeSignature.dataUrl,
        cancel: () => useAnnotationStore.getState().setTool('select'),
      }
    }
    if (tool === 'image' && uploadedImageSrc) {
      return {
        label: `${verb} the page to place your ${uploadedImageQr ? 'QR code' : 'image'}`,
        preview: uploadedImageSrc,
        cancel: () => {
          useAnnotationStore.getState().setUploadedImageSrc(null)
          useAnnotationStore.getState().setTool('select')
        },
      }
    }
    // ⚠️ NO BANNER FOR THE PLAIN TOOLS — Text, Tick and Cross (owner,
    // 2026-09-04: "not needed - it's expected", and of tick/cross "i don't want
    // them to"). Picking a tool from the toolbar and clicking the page to use it
    // is not a state anybody has to be told about.
    //
    // What is left above is the whole rule: a banner exists for a payload that
    // is ARMED AND INVISIBLE — a saved signature, a generated QR code, an
    // uploaded picture, a queued name/details/date — where the app looks
    // identical to the moment before and the next tap drops something anyway.
    // Don't add one for a tool.
    return null
  })()

  if (!prompt || dismissed) return null

  return (
    // ⚠️ pointer-events-none on everything but the buttons. This floats over the
    // page, and the whole point of the state it announces is that the next tap
    // on the page places something — an overlay that ate that tap would be
    // worse than no overlay at all. It spans the whole document area only to
    // centre the card; nothing but the two buttons is clickable.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4"
    >
      {/* data-placement-hint is how the toolbar's floating option panels find
          this card: they drop below it rather than covering the one bit of
          feedback telling the user a tap is armed. Centred, they rarely have to
          — but the panel is measured, not assumed, so the rule still holds if a
          tall one ever reaches this far down. */}
      <div
        data-placement-hint
        // ⚠️ No `backdrop-blur` here, and don't reintroduce one: a blur hides
        // what is behind the card whatever the background alpha is, which is
        // the thing this card is not allowed to do. The orange ring and the
        // drop shadow are what keep it prominent (James, 2026-09-05) now that
        // the fill no longer is.
        className="flex w-max max-w-full flex-col items-center gap-3 rounded-2xl bg-white/45 px-6 py-5 text-center shadow-xl ring-2 ring-orange-400"
      >
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-orange-500 motion-reduce:animate-none"
          />
          {/* ⚠️ `w-max max-w-full` on the card, and the label allowed to wrap
              inside it: the card is content-sized, so a label merely allowed to
              wrap collapses to MIN-content — "Tap the page to place your QR
              code" came out one word per line, seven lines tall, on a 390px
              screen. Asking for the single-line width first and clamping it
              means it wraps only when it genuinely has to. */}
          {/* The white halo is what replaces the opaque plate the card used to
              be — it keeps the sentence readable over a dark photo or a filled
              table cell without putting anything solid between the reader and
              the page they are being told to tap. */}
          <span className="text-[15px] font-semibold leading-snug text-slate-900 [text-shadow:0_0_3px_#fff,0_0_9px_#fff]">
            {prompt.label}
          </span>
        </span>
        {prompt.preview && (
          <img
            src={prompt.preview}
            alt=""
            aria-hidden="true"
            className="max-h-14 w-auto max-w-[180px] object-contain"
          />
        )}
        {prompt.detail && (
          <span className="max-w-[260px] truncate text-[13px] text-slate-600 [text-shadow:0_0_3px_#fff,0_0_8px_#fff]">
            {prompt.detail}
          </span>
        )}
        {/* ⚠️ The ONLY part of the card that takes a pointer, and therefore the
            only part that can eat the tap the card is asking for — so the two
            buttons keep a solid fill while the card around them does not. That
            reads as the honest thing it is: the opaque strip is where a tap
            hits a button, the transparent everything-else is where it goes
            through to the page. */}
        <span className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={prompt.cancel}
            className="rounded-full bg-slate-100 px-4 py-1.5 text-[13px] font-semibold text-slate-700 shadow-sm hover:bg-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { persistDismissed(); setDismissed(true) }}
            // Hides the card and leaves the placement ARMED — it is a display
            // preference, not a way out of the state. Cancel is the way out.
            className="rounded-full bg-white/80 px-3 py-1.5 text-[13px] font-medium text-slate-500 shadow-sm hover:bg-white hover:text-slate-700"
          >
            Don't show again
          </button>
        </span>
      </div>
    </div>
  )
}
