import type { QrPlacement } from '../lib/qr/design'

export type Tool =
  | 'select'
  | 'marquee'
  | 'hand'
  // Select & copy the PDF's own underlying text (pdf.js text-layer overlay),
  // as opposed to 'select' which selects/moves the annotations drawn on top.
  | 'selecttext'
  | 'text'
  | 'draw'
  | 'highlight'
  | 'rect'
  | 'ellipse'
  | 'redact'
  | 'tick'
  | 'cross'
  | 'line'
  | 'image'
  | 'signature'
  // Place a "sign here" request box. Optionally asks for a name and/or date
  // line too. Clicking one of these boxes (with the Select tool) opens the
  // signature pad and drops the resulting signature straight into the box.
  | 'sigfield'
  | 'form'

type Base = { id: string; pageIndex: number }

export type FontFamily = 'sans' | 'serif' | 'mono' | 'georgia' | 'verdana' | 'comic' | 'impact'

// A styled span within a text annotation. Only the inline style toggles vary
// per run — colour, size and family stay whole-annotation. An empty/whitespace
// run is allowed (it carries spaces between styled words).
export type TextRun = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  // A clickable hyperlink covering just this run.
  link?: string
}

export type TextAnnotation = Base & {
  type: 'text'
  x: number
  y: number
  text: string
  color: string
  fontSize: number
  fontFamily?: FontFamily
  rotation?: number
  // Width (in the same model/point space as x/y) the text wraps to, set by
  // dragging a side handle on the box. Absent means "no box" — the text is one
  // line as wide as it needs to be, which is how every text placed before
  // resizing existed still behaves. See lib/textLayout.ts.
  wrapWidth?: number
  // Whole-annotation style fallback, used when `runs` is absent (legacy text,
  // or text with a single uniform style). The pill toggles these when the box
  // is selected but not being edited.
  bold?: boolean
  italic?: boolean
  underline?: boolean
  // A clickable hyperlink for the whole annotation (fallback, as above). When
  // set the text is underlined on-screen and a real URI link annotation is
  // baked over it on export. The font colour is left unchanged.
  link?: string
  // When present (and non-empty) this is the styled source of truth: the text
  // is split into runs each carrying their own bold/italic/underline/link, so
  // formatting can apply to part of the text. `text` mirrors the concatenation
  // for search / export fallback / back-compat.
  runs?: TextRun[]
}

export type DrawAnnotation = Base & {
  type: 'draw'
  points: number[]
  color: string
  strokeWidth: number
  // Set for highlighter strokes so they render with a translucent fill.
  // Pencil strokes leave this undefined and render fully opaque.
  opacity?: number
  // Set for straight lines drawn with the line tool (a two-point stroke). Lets
  // the editor offer endpoint grabbers + a contextual stroke/snap panel without
  // confusing them with free-draw scribbles that happen to be short.
  shape?: 'line'
}

export type RectAnnotation = Base & {
  type: 'rect'
  x: number
  y: number
  width: number
  height: number
  color: string
  rotation?: number
  // When true the rectangle is painted with `color` instead of just outlined.
  filled?: boolean
}

// Stored as a top-left bounding box (same convention as RectAnnotation) so the
// drag / transform / bbox / export plumbing can be shared. The ellipse is
// inscribed in that box: centre = (x + width/2, y + height/2), radii = half the
// box. A square box gives a circle.
export type EllipseAnnotation = Base & {
  type: 'ellipse'
  x: number
  y: number
  width: number
  height: number
  color: string
  rotation?: number
  filled?: boolean
}

export type RedactAnnotation = Base & {
  type: 'redact'
  x: number
  y: number
  width: number
  height: number
  // Fill colour the box is baked with on export — a hex string taken from the
  // toolbar's colour swatches, the same control that colours every other
  // annotation. Defaults to black (the privacy default) when undefined.
  //
  // ⚠️ Boxes drawn before redactions took an arbitrary colour stored the words
  // `'black'` / `'white'` here, and an old `.unipdf` backup still carries them.
  // Read this through `redactFillHex()` rather than testing it yourself.
  fill?: string
}

export type MarkAnnotation = Base & {
  type: 'tick' | 'cross'
  x: number
  y: number
  size: number
  color: string
  rotation?: number
}

// How the name/date labels beneath a signature are horizontally aligned
// (relative to the ink). Cycled by the size/alignment pill.
export type SigAlign = 'left' | 'center' | 'right'

// Re-editable label options for a placed signature. Changing any of these
// re-composes the rendered image from the untouched ink — the strokes are never
// altered, only the labels beneath them.
export type SignatureLabelOptions = {
  // The whole name line as the user wrote it — "Signed by: Jane Smith". The
  // options modal edits it as one string; the pad still stores the bare name
  // with any wording in `namePrefix`. Composition merges the two, so both
  // shapes render identically.
  name?: string
  showName?: boolean
  // Free text under the name — a role, an email address, a company. Multi-line
  // by design: every line typed becomes its own label line, which is why this
  // is a single string rather than an array. Unfilled template prompts
  // ("Role:" with nothing after) are dropped at compose time.
  details?: string
  showDetails?: boolean
  showDate?: boolean
  // Optional wording in front of the name and date lines — "Signed by:",
  // "Signed on". Deliberately plain strings rather than a template with
  // {name}/{date} tokens: a mistyped token would bake literal braces into a
  // signed document, and this dialog is used by people who should not have to
  // learn a syntax to put two words in front of their own name. Both dialogs
  // now edit whole lines and fold the prefixes away (namePrefix into `name`,
  // datePrefix into `dateText`); the fields remain so older signatures still
  // compose unchanged.
  namePrefix?: string
  datePrefix?: string
  // The whole date line as the user wrote it — "Signed on 26 Aug 2026". Seeded
  // with today's date when the toggle goes on, then editable in full, the date
  // included. Absent on older signatures, where the date resolves to the day of
  // compositing instead.
  dateText?: string
  align?: SigAlign
  // Multiplier on the base label font size (driven by the size pill).
  labelScale?: number
  // Colour used for the name/date labels (matches the ink by default).
  color?: string
}

// The full re-editable signature payload attached to a placed signature. `ink`
// is the ink-only PNG (the drawn strokes or imported image) and is NEVER mutated
// by option edits; the annotation's rendered image is always `ink` composited
// with the labels described by the options above. Its presence marks an image /
// signed field as an editable signature (double-tap to change name/date, and a
// size/alignment pill when labels are showing).
export type SignatureData = SignatureLabelOptions & {
  ink: string
  inkWidth: number
  inkHeight: number
  // The raw pen strokes the ink was rasterised from, in the pad's own pixel
  // space — flat [x,y,x,y,…] arrays, one per stroke. Present only for
  // signatures drawn in-app (the pad or the phone); an imported picture has no
  // strokes. Keeping them lets `ink` be re-rendered after placement, which is
  // what makes the "realistic" toggle re-editable rather than baked in forever.
  strokes?: number[][]
  // Whether `ink` was rendered with the realistic pen treatment. Only
  // meaningful alongside `strokes` — without them the look can't be changed.
  realistic?: boolean
}

export type ImageAnnotation = Base & {
  type: 'image'
  x: number
  y: number
  width: number
  height: number
  src: string
  rotation?: number
  // Present when this image is a placed signature whose name/date labels can be
  // re-edited without touching the ink. `src` is the composite derived from it.
  sig?: SignatureData
  // Present when this image is a QR code generated in-app: the editor state it
  // was rendered from, so the ✏️ on the selected code (or a double-tap) can
  // bring the generator back up on THIS code — change the link, the style or
  // the branding — and re-render `src` in place. Absent on plain pictures, and
  // on codes placed before this existed, which stay ordinary images.
  qr?: QrPlacement
}

// A "Request signature" placeholder box. Until it is signed it renders as a
// dashed "Sign here" box (plus optional Name / Date lines). When the user
// clicks it and signs, `signed` is filled with a single baked PNG (the ink
// plus any requested name/date beneath it), which then renders — and exports —
// contained inside the box.
export type SignatureFieldAnnotation = Base & {
  type: 'sigfield'
  x: number
  y: number
  width: number
  height: number
  // Which extra lines the box asks for, chosen before it was drawn.
  requireName?: boolean
  requireDate?: boolean
  // Asks that the box be signed with live ink — the pad, or the phone (which is
  // still drawn ink, just on a better input device) — rather than an uploaded
  // image of a signature. Rides on the annotation rather than a
  // `pdf_sign_requests` column so it travels with the document, the `.unipdf`
  // backup and the hosted upload, and binds the rule to the BOX: it applies to
  // anyone who opens the PDF, not just people who arrived via a send-to-sign
  // link.
  //
  // ⚠️ This is a constraint the signer's own browser enforces, so it is a
  // STATED REQUIREMENT, not proof — same class of claim as the signing
  // certificate page. Don't let UI copy imply the ink is verified as live.
  requireLive?: boolean
  // True for boxes re-detected from a flattened/exported PDF, where the outline
  // is already baked into the page. Locked boxes stay put (non-movable /
  // resizable / deletable) so moving them can't leave a baked "ghost" behind —
  // they're still click-to-sign. A `.unipdf` backup restores the original
  // editable (unlocked) annotations instead, keeping them movable.
  locked?: boolean
  // Populated once signed. `src` is a PNG data URL already composited with the
  // name/date labels; width/height are its logical (unscaled) pixel size, used
  // to preserve aspect when fitting it inside the box.
  signed?: {
    src: string
    width: number
    height: number
    // Present for boxes signed in-app (not re-detected from a flattened PDF):
    // the untouched ink + label options, so the name/date can be re-edited
    // (double-tap) or restyled (size/alignment pill) and `src` re-composed
    // without altering the strokes.
    data?: SignatureData
  }
}

export type Annotation =
  | TextAnnotation
  | DrawAnnotation
  | RectAnnotation
  | EllipseAnnotation
  | RedactAnnotation
  | MarkAnnotation
  | ImageAnnotation
  | SignatureFieldAnnotation
