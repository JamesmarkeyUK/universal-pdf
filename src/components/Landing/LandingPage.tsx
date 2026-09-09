import { useRef, useState } from 'react'
import { DropAnywhere, DropRing, PrivacyNote, useFileDrop } from '@unisim/sdk'
import { usePdfStore } from '../../stores/pdfStore'
import { useAnnotationStore } from '../../stores/annotationStore'
import { createExamplePdfFile } from '../../lib/examplePdf'
import { compressPdf, type CompressQuality, type CompressResult } from '../../lib/export'
import {
  isPdfFile,
  OfficeImportError,
  PDF_OR_OFFICE_ACCEPT,
  toViewablePdf
} from '../../lib/officeToPdf'
import CompressResultModal from '../Compress/CompressResultModal'
import BatchCompressModal, { type BatchSource } from '../Compress/BatchCompressModal'
import MergeDialog from '../Convert/MergeDialog'
import ConvertDialog, { type ConvertMode } from '../Convert/ConvertDialog'
import RecentFilesList from '../RecentFiles/RecentFilesList'
import OcrModal from '../Ocr/OcrModal'
import TransformPanel from '../Transform/TransformPanel'
import PdfIllustration from './PdfIllustration'
import DownloadRow from './DownloadRow'
import DropRingWatermark from './DropRingWatermark'
import { RedactIcon } from '../icons/RedactIcon'
import { DefaultAppPill } from '../Onboarding/DefaultAppOffer'
import { useDefaultPdfApp } from '../../hooks/useDefaultPdfApp'
import { PreviewPanePill } from '../Onboarding/PreviewPaneOffer'
import { usePreviewPane } from '../../hooks/usePreviewPane'
import { CONTAINER } from '../../lib/layout'

// Balanced is the default when compressing — 'light' is lossless but usually
// barely shrinks, so people expect the "Compress PDF(s)" default to actually
// make the file smaller. Stronger/lighter are still one tap away in the modal.
const DEFAULT_COMPRESS_QUALITY: CompressQuality = 'balanced'

// The third column of the closing grid. These are not features, they are the
// answer to "what does it cost me when it isn't money", so each one names the
// thing it is refusing — a struck-through cloud, eye and megaphone — rather than
// wearing the tick its neighbours do. Lucide's `cloud-off` / `eye-off` /
// `megaphone-off` outlines, drawn inline: a lone symbol CHARACTER falls back to
// whatever font happens to carry it (see the chevron on the compress row).
const PROMISES: { claim: string; paths: string[] }[] = [
  {
    claim: 'No forced uploads',
    paths: [
      'M5.78 5.78A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.19',
      'M21.53 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7 7 0 0 0 10 5.07',
      'M2 2l20 20'
    ]
  },
  {
    claim: 'No data scraping',
    paths: [
      'M9.88 9.88a3 3 0 1 0 4.24 4.24',
      'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68',
      'M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61',
      'M2 2l20 20'
    ]
  },
  {
    claim: 'No advertising',
    paths: [
      'M9.26 9.26 3 11v3l14.14 3.14',
      'M21 15.34V6l-7.31 2.03',
      'M11.6 16.8a3 3 0 1 1-5.8-1.6',
      'M2 2l20 20'
    ]
  }
]

export default function LandingPage() {
  // The default-app offer, now surfaced only as the "System options" pill —
  // the top-of-page bar it used to share this with is gone (2026-08-27).
  const defaultApp = useDefaultPdfApp()
  const previewPane = usePreviewPane()
  const compressInputRef = useRef<HTMLInputElement>(null)
  const ocrInputRef = useRef<HTMLInputElement>(null)
  const redactInputRef = useRef<HTMLInputElement>(null)
  const advancedRef = useRef<HTMLDivElement>(null)
  const loadFile = usePdfStore((s) => s.loadFile)
  const hasRecents = usePdfStore((s) => s.recents.length > 0)
  const [opening, setOpening] = useState(false)
  const [converting, setConverting] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [compressProgress, setCompressProgress] = useState('')
  const [compressJob, setCompressJob] = useState<{
    sourceBytes: ArrayBuffer
    fileName: string
    result: CompressResult
  } | null>(null)
  const [batchJob, setBatchJob] = useState<{
    files: BatchSource[]
    results: CompressResult[]
  } | null>(null)
  const [dragOverCompress, setDragOverCompress] = useState(false)
  // The extra tools, behind the chevron that sits on the end of the Compress
  // row. They used to be a `<details>` with its own "Advanced options" summary
  // line, which cost a full-width row of the card to say nothing (James,
  // 2026-08-29) — the chevron carries the same meaning in the space already
  // taken by the row above it.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [transformOpen, setTransformOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [convertMode, setConvertMode] = useState<ConvertMode | null>(null)
  const [ocrJob, setOcrJob] = useState<{ bytes: ArrayBuffer; name: string } | null>(null)

  // The suite's shared drop mechanics — drag depth, the hidden input, click and
  // Enter and Space, resetting the value so the same file can be picked twice.
  // `openFiles` is a hoisted declaration, so referring to it here is fine.
  //
  // `pageWide`: the circle is where to aim, not where you have to land. A PDF let
  // go two pixels outside the ring used to be handed to the browser, which
  // navigates away from the tab — on this page that costs nothing, but the same
  // gesture over the compress pill or the recents list is a plain miss and the
  // app should just take the file. It replaces the `window` listener App.tsx used
  // to keep for this, and with it the stopPropagation wrappers this zone needed
  // to stop that listener loading the same file a second time: the hook skips any
  // drop that landed inside a `data-unisim-dropzone`, which this is.
  //
  // Not while one of this page's own dialogs is up: every one of them is either
  // showing a result for a file already chosen or asking for a different file of
  // its own, and swapping the document out from behind it would leave the dialog
  // describing something that is no longer there.
  const modalOpen =
    !!compressJob || !!batchJob || transformOpen || mergeOpen || !!convertMode || !!ocrJob
  const drop = useFileDrop({
    // Wrapped rather than passed straight through: `openFiles` reports whether
    // the document actually opened (the redact entry point below only arms the
    // tool if it did), and a `Promise<boolean>` isn't a `Promise<void>`.
    onFiles: (files) => { void openFiles(files) },
    accept: PDF_OR_OFFICE_ACCEPT,
    multiple: false,
    pageWide: true,
    disabled: modalOpen,
    label: 'Drop a PDF, Word or OpenDocument file here, or click to browse',
  })
  // ⚠️ `over`/`pageOver` go true for a page drag whether or not the zone is
  // disabled — the hook lights every page-wide zone and only checks `disabled`
  // when deciding who TAKES the file. Lighting a ring that will not take
  // anything is a lie, so gate the visuals on the same condition. The compress
  // pill below is the other case: it is its own drop target with its own
  // meaning, so the "drop anywhere to open" hint has no business over it.
  const over = drop.over && !modalOpen
  const showDropHint = drop.pageOver && !modalOpen && !dragOverCompress

  async function runCompress(fileList: File[] | FileList) {
    const files = Array.from(fileList).filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    )
    if (files.length === 0) {
      alert('Please choose one or more PDF files.')
      return
    }
    setCompressing(true)
    setCompressProgress('')
    try {
      if (files.length === 1) {
        const buf = await files[0].arrayBuffer()
        // Slice so the kept-around source survives pdfjs detaching its copy.
        // The percentage is the page counter: rasterising a long scan is
        // minutes of work, and a pill that just says "Compressing…" for all of
        // it is indistinguishable from one that has crashed.
        const result = await compressPdf(
          buf.slice(0),
          files[0].name,
          DEFAULT_COMPRESS_QUALITY,
          (f) => setCompressProgress(`Compressing… ${Math.round(f * 100)}%`)
        )
        setCompressJob({ sourceBytes: buf, fileName: files[0].name, result })
        return
      }
      // Batch: compress each at the default quality (re-tunable in the modal).
      const sources: BatchSource[] = []
      const results: CompressResult[] = []
      for (let i = 0; i < files.length; i++) {
        setCompressProgress(`Compressing ${i + 1}/${files.length}…`)
        const buf = await files[i].arrayBuffer()
        const result = await compressPdf(
          buf.slice(0),
          files[i].name,
          DEFAULT_COMPRESS_QUALITY,
          (f) => setCompressProgress(`Compressing ${i + 1}/${files.length} — ${Math.round(f * 100)}%`)
        )
        sources.push({ sourceBytes: buf, fileName: files[i].name })
        results.push(result)
      }
      setBatchJob({ files: sources, results })
    } catch (err) {
      console.error(err)
      alert('Compression failed: ' + (err as Error).message)
    } finally {
      setCompressing(false)
      setCompressProgress('')
    }
  }

  // Shared by the circle's picker and its drop. The picker is filtered by
  // `accept`, a drop is not — so the check has to live here.
  //
  // A Word or OpenDocument file is converted first, on this device, and the
  // PDF that comes out is what gets opened. `convertOfficeFile` throws a
  // message written to be read, so anything it says is shown as-is — including
  // its "save it as .docx first" answer for a legacy .doc, which is the whole
  // point of not simply rejecting everything that isn't a PDF here.
  // Returns whether a document ended up open, so a caller that wants to hand
  // the user straight to a tool doesn't arm it over a failed load.
  async function openFiles(files: File[]): Promise<boolean> {
    const file = files[0]
    if (!file) return false
    setConverting(!isPdfFile(file))
    try {
      const { file: pdf, notice } = await toViewablePdf(file)
      await loadFile(pdf, { notice })
      return true
    } catch (err) {
      console.error(err)
      alert(err instanceof OfficeImportError ? err.message : 'Failed to load PDF')
      return false
    } finally {
      setConverting(false)
    }
  }

  // "Redact text" opens the PDF with the redact tool already in hand, so the
  // first drag on the page draws a box. Coming through a door labelled Redact
  // and landing on the Select tool would mean hunting for the tool in a menu
  // the user has never opened — the door IS the instruction.
  //
  // Black, and nothing selected: the tool's colour is the toolbar's colour, and
  // whatever the pencil was last set to is not a sane default for a redaction.
  async function onRedactFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (await openFiles([file])) {
      const s = useAnnotationStore.getState()
      s.setSelected(null)
      s.setColor('#000000')
      s.setTool('redact')
    }
  }

  async function openExample() {
    if (opening) return
    setOpening(true)
    try {
      const file = await createExamplePdfFile()
      await loadFile(file)
    } catch (err) {
      console.error(err)
      alert('Failed to open example: ' + ((err as Error).message || err))
    } finally {
      setOpening(false)
    }
  }

  async function onCompressFile(e: React.ChangeEvent<HTMLInputElement>) {
    // ⚠️ `input.files` is a LIVE FileList, not a snapshot. Clearing `value` (so
    // the same file can be re-picked) empties the very list you are holding —
    // so reading `files.length` afterwards gave 0 and "Compress PDF(s)" did
    // nothing at all when you picked a file through the browser (dropping one
    // still worked, which is why it went unnoticed). Materialise first.
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length > 0) await runCompress(files)
  }

  async function onOcrFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      alert('Please choose a PDF file.')
      return
    }
    setOcrJob({ bytes: await file.arrayBuffer(), name: file.name })
  }

  // Universal Images' front door is a stack of full-width centred pills with an
  // "or" between them, and this box now speaks the same language. The old rows
  // here were chunky cards — 48px icon tile, title, subtitle, trailing arrow —
  // which made every option shout as loudly as the drop circle above them.
  const PILL =
    'w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors'
  const PILL_IDLE =
    'border-slate-300 hover:border-orange-400 hover:bg-orange-50/40 text-slate-700'

  const exampleButton = (
    <button
      type="button"
      onClick={openExample}
      disabled={opening}
      className={`${PILL} ${PILL_IDLE} disabled:opacity-60 disabled:cursor-wait`}
    >
      <span aria-hidden="true">👁</span>
      {opening ? 'Opening example…' : 'Try with example PDF'}
    </button>
  )

  return (
    <div className="min-h-full flex items-center">
      <div className={`${CONTAINER} py-8 lg:py-14`}>
        {/* No top banners for now (James, 2026-08-27): the default-app bar
            kept showing after the answer was given, so the offer lives only
            in "System options" below until the detection is trustworthy. */}
        <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
          {/* Left: animated PDF illustration */}
          {/* Desktop keeps the illustration as its own column. On a phone it
              moves BEHIND the drop circle instead (see below): as a stacked
              block it was a full screen-height of scrolling before the primary
              action, which is what stopped the landing page fitting on one
              screen. */}
          <div className="hidden lg:flex flex-col items-center lg:items-start gap-4 order-2 lg:order-1 min-w-0">
            <PdfIllustration />
          </div>

          {/* ⚠️ min-w-0 is load-bearing, not tidying. A grid item defaults to
              `min-width: auto`, so its MIN-CONTENT width becomes a floor the
              track cannot go below — and `truncate` further down does not
              reduce that contribution, it only clips once a width is settled.
              One recent file with a long unbreakable name (no spaces to wrap
              at) therefore set the width of this whole column, and the h1, the
              lead and the card were all laid out wider than the phone: the
              heading was cut off mid-word with nothing on screen to explain
              why. Reported from an iPhone; the recents list has to be OPEN to
              see it, which is why it survived earlier mobile passes.
              Right: open / create cards */}
          <div className="order-1 lg:order-2 min-w-0">
            {/* One line on a phone, deliberately. "Universal PDFs that just
                work." wrapped to two lines on every phone width, and the app's
                name is already in the navbar directly above it — so the word
                was costing a whole line to repeat something on screen. */}
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-slate-900">
              PDFs that <span className="text-orange-600">just work</span>.
            </h1>
            <p className="mt-3 text-slate-600 max-w-md">
              View, annotate, sign and export.
            </p>

            {/* One box, read top to bottom: upload → recent → compress →
                more options. Compress and the power-user tools used to sit in
                a second card below this one, which read as a separate, lesser
                panel — Universal Images keeps everything in a single card and
                this now matches it. */}
            <div className="mt-7 bg-white border border-slate-200 rounded-2xl shadow-sm p-5 sm:p-6">
              {/* Open existing — primary action, wearing the suite's shared
                  drop circle (`DropRing` + `useFileDrop` from @unisim/sdk)
                  rather than a copy, so it is the same front door Universal
                  Compress and the Converter's All tab open on. It replaced a
                  dashed rectangle: one look for "drop a file here" across the
                  suite. Always `idle` — nothing runs on this page, and a busy
                  chase on an empty page reads as "still loading".

                  The drag handlers used to stop the event so App.tsx's own
                  `window` listener would not put the same file through
                  `loadFile` twice. That listener is gone — this zone is
                  `pageWide` now, and the hook recognises its own zones by the
                  `data-unisim-dropzone` marker it spreads on, so a drop that
                  lands here is never picked up a second time. */}
              <div className="flex flex-col items-center">
                <div
                  {...drop.dropzoneProps}
                  className={`relative w-full max-w-[260px] cursor-pointer rounded-full transition-transform focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-orange-600 ${
                    over ? 'scale-[1.02]' : ''
                  }`}
                >
                  <DropRing size="100%" over={over} motion="idle" watermark={<DropRingWatermark />}>
                    <svg
                      viewBox="0 0 24 24"
                      className={`mb-1 h-9 w-9 ${over ? 'text-orange-500' : 'text-slate-400'}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {/* A page with its corner turned — the thing you drop,
                          not an upload tray. Nothing is uploaded. */}
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                      <path d="M14 3v5h5" />
                      <path d="M9 13h6" />
                      <path d="M9 17h4" />
                    </svg>
                    <span className="text-[15px] font-bold text-slate-900">
                      {converting ? 'Converting…' : over ? 'Drop to open' : 'Drop a PDF here'}
                    </span>
                    {/* Word and OpenDocument files are converted here rather
                        than turned away, so the circle has to say so — nobody
                        drops a .docx on a thing labelled "PDF" to find out. */}
                    <span className="mt-1 text-[11px] text-slate-400">
                      or click to browse — .pdf, .docx, .odt
                    </span>
                  </DropRing>
                </div>
                <input {...drop.inputProps} className="hidden" />
              </div>

              {/* This slot is the same pill either way — it says "Recent files"
                  and opens the list once you have some, and "Try with example
                  PDF" until then. A first-time visitor has nothing to be recent,
                  so offering an empty list would be a dead end; someone with
                  history rarely wants the sample again, so it moves inside. */}
              {hasRecents ? (
                <details className="group mt-5">
                  <summary className={`${PILL} ${PILL_IDLE} cursor-pointer select-none list-none`}>
                    <span aria-hidden="true">🕘</span>
                    Recent files
                    <span
                      className="text-base text-slate-400 transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    >
                      ⌄
                    </span>
                  </summary>
                  <div className="mt-3">
                    <RecentFilesList className="" />
                    <div className="mt-3">{exampleButton}</div>
                  </div>
                </details>
              ) : (
                <div className="mt-5">{exampleButton}</div>
              )}

              <div className="mt-4 flex items-center gap-3 text-xs text-slate-500">
                <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
                <span>or</span>
                <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
              </div>

              {/* Compress. `data-unisim-dropzone` says out loud what this
                  already is: a drop target with its own meaning, sitting on a
                  page whose circle is page-wide. It is how the hook recognises
                  a drop another target has claimed.

                  It is belt-and-braces TODAY — measured, not assumed: strip the
                  marker at runtime and a file dropped here still compresses,
                  because `onDrop` below stops the event and React's synthetic
                  stopPropagation reaches the native event before it gets past
                  the root container to the hook's `window` listener. The marker
                  is what keeps that true if the stopPropagation is ever tidied
                  away as redundant — which, on its own, it would then not be. */}
              {/* Compress + the chevron that opens everything else, on one
                  row. */}
              <div className="mt-3 flex items-stretch gap-2">
              <button
                type="button"
                data-unisim-dropzone=""
                onClick={() => compressInputRef.current?.click()}
                disabled={compressing}
                onDragEnter={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDragOverCompress(true)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (!dragOverCompress) setDragOverCompress(true)
                }}
                onDragLeave={(e) => {
                  e.stopPropagation()
                  setDragOverCompress(false)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDragOverCompress(false)
                  const files = e.dataTransfer.files
                  if (files && files.length > 0) runCompress(files)
                }}
                className={[
                  PILL,
                  'flex-1 min-w-0 disabled:opacity-60 disabled:cursor-wait',
                  // Dashed + amber while a file is over it — the one bit of the
                  // old card worth keeping, because this pill is a drop target
                  // as well as a button and nothing else in the box is.
                  dragOverCompress
                    ? 'border-amber-500 border-dashed bg-amber-50 text-amber-900'
                    : PILL_IDLE
                ].join(' ')}
              >
                <span aria-hidden="true">⬇</span>
                {compressing
                  ? compressProgress || 'Compressing…'
                  : dragOverCompress
                    ? 'Drop to compress'
                    : 'Compress PDF(s)'}
              </button>

              {/* The chevron IS the "Advanced options" label now: a square
                  button on the end of the Compress row, wearing the same border
                  as the pill beside it. The row it replaced was full-width and
                  carried nothing but the word. */}
              <button
                type="button"
                onClick={() => {
                  const next = !advancedOpen
                  setAdvancedOpen(next)
                  // On a short screen the revealed options open below the fold;
                  // bring them back into view once they have rendered.
                  if (next) {
                    requestAnimationFrame(() =>
                      advancedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
                    )
                  }
                }}
                aria-expanded={advancedOpen}
                aria-controls="pdf-advanced-options"
                aria-label={advancedOpen ? 'Hide advanced options' : 'Show advanced options'}
                title="Advanced options — merge, convert, OCR, redact, Markdown"
                className={`shrink-0 w-11 inline-flex items-center justify-center rounded-lg border transition-colors ${
                  advancedOpen
                    ? 'border-orange-400 bg-orange-50/60 text-orange-700'
                    : 'border-slate-300 text-slate-500 hover:border-orange-400 hover:bg-orange-50/40 hover:text-slate-700'
                }`}
              >
                {/* An SVG chevron, not the `⌄` character the old summary row
                    used: alone in a button it fell back to a font that draws it
                    as a plain "<". */}
                <svg
                  viewBox="0 0 24 24"
                  className={`w-4 h-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              </div>
              <input
                ref={compressInputRef}
                type="file"
                accept="application/pdf"
                multiple
                hidden
                onChange={onCompressFile}
              />

              {advancedOpen && (
              <div id="pdf-advanced-options" ref={advancedRef}>

                {/* The four tools wear the same pill as the two above, so
                    expanding this doesn't drop a stack of chunky cards into a
                    box of slim buttons. Each label carries its old subtitle
                    after an em dash — "what it is — what it does" — which is
                    the shape Images uses on its Convert pill. */}
                <button
                  type="button"
                  onClick={() => setMergeOpen(true)}
                  className={`${PILL} ${PILL_IDLE} mt-3`}
                >
                  <span aria-hidden="true">⧉</span>
                  Merge PDFs — combine several into one
                </button>

                <button
                  type="button"
                  onClick={() => setConvertMode('pdf-to-images')}
                  className={`${PILL} ${PILL_IDLE} mt-3`}
                >
                  <span aria-hidden="true">⇄</span>
                  Convert — PDF ↔ images (PNG/JPG)
                </button>

                {/* Make searchable (OCR) — scanned/image-only PDF → text layer */}
                <button
                  type="button"
                  onClick={() => ocrInputRef.current?.click()}
                  className={`${PILL} ${PILL_IDLE} mt-3`}
                >
                  <span aria-hidden="true">🔎</span>
                  Make searchable (OCR) — read a scan
                </button>
                <input
                  ref={ocrInputRef}
                  type="file"
                  accept="application/pdf"
                  hidden
                  onChange={onOcrFile}
                />

                {/* Redact — the one entry here that opens the editor rather
                    than running a job, so it says what it will do to the
                    document ("unreadable to humans and machines") rather than
                    naming a tool. The PDF opens with the redact tool armed. */}
                <button
                  type="button"
                  onClick={() => redactInputRef.current?.click()}
                  className={`${PILL} ${PILL_IDLE} mt-3`}
                >
                  <RedactIcon size={16} className="shrink-0" />
                  Redact text — make portions unreadable to humans and machines
                </button>
                <input
                  ref={redactInputRef}
                  type="file"
                  accept="application/pdf"
                  hidden
                  onChange={onRedactFile}
                />

                <button
                  type="button"
                  onClick={() => setTransformOpen(true)}
                  className={`${PILL} ${PILL_IDLE} mt-3`}
                >
                  <span aria-hidden="true">✎</span>
                  Transform text into a PDF — paste Markdown
                </button>
              </div>
              )}

              {/* OS-integration switches, apart from the document tools:
                  things that change how this MACHINE treats PDFs rather than
                  what happens to one file. Desktop-only in practice — both
                  pills render nothing in the browser — so the whole section
                  hides where it would be empty. The title names the OS
                  ("[Windows] System options") because every switch inside is
                  a promise about this machine, not about the app. */}
              {(defaultApp.available || previewPane.available) && (() => {
                const os =
                  defaultApp.platform === 'win32' || previewPane.available
                    ? 'Windows'
                    : defaultApp.platform === 'darwin'
                      ? 'macOS'
                      : defaultApp.platform === 'linux'
                        ? 'Linux'
                        : null
                // No onToggle scroll on the fold below any more: @unisim/sdk
                // >= 0.139.0 scrolls an opening fold into view for every
                // product, and it does it better than the `block: 'end'` this
                // used to do — that aligned the BOTTOM to the bottom, which
                // shoves the summary you just clicked off the top of a phone.
                return (
                <details className="group mt-3">
                  <summary className="flex items-center gap-2 cursor-pointer select-none list-none px-1 py-1 text-xs uppercase tracking-wide font-medium text-slate-500 hover:text-slate-700 transition-colors">
                    <span>{os ? `[${os}] ` : ''}System options</span>
                    <span
                      className="ml-auto text-base text-slate-400 transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    >
                      ⌄
                    </span>
                  </summary>

                  {/* Desktop only, and only while it isn't already the
                      default. */}
                  <DefaultAppPill offer={defaultApp} className={`${PILL} ${PILL_IDLE} mt-3`} />

                  {/* Windows only, and only where the preview handler shipped
                      with the app. Not a proactive offer: it costs an
                      administrator prompt, so it waits to be looked for. */}
                  <PreviewPanePill offer={previewPane} className={`${PILL} ${PILL_IDLE} mt-3`} />
                </details>
                )
              })()}

              {/* What you get, in the tick grid Universal Images closes its
                  card with. The first two columns end "for free" deliberately
                  and repetitively: these are the things people arrive expecting
                  to hit a paywall or a watermark on, and one "all free" heading
                  over a list does not answer the question the way the word next
                  to each item does.

                  The third column answers the OTHER question — what it costs
                  you when it isn't money — so each line names the thing it
                  refuses (see `PROMISES`) instead of wearing a tick. A tick
                  beside "No advertising" would read as one more feature in the
                  pile.

                  ⚠️ `grid-flow-col` + `grid-rows-3` fills DOWN each column, so
                  the DOM order below IS the column order. Row-flow would deal
                  the shields out across the rows and there would be no third
                  column at all.

                  Three columns only from `sm`. Measured on a 390px phone: every
                  one of the nine wrapped onto a second line, which is a block of
                  eighteen. Below that it falls back to two columns and plain
                  row-flow, where they all fit on one line each. */}
              <ul className="mt-5 grid grid-cols-2 sm:grid-cols-3 sm:grid-rows-3 sm:grid-flow-col gap-x-1 gap-y-2 text-xs text-slate-600">
                {[
                  'Sign PDF for free',
                  'Convert PDF for free',
                  'Redact PDF for free',
                  'Compress PDF for free',
                  'Add QR codes for free',
                  'Export PDF for free'
                ].map((claim) => (
                  <li key={claim} className="flex items-center gap-2 pl-2 sm:pl-4">
                    <span className="text-orange-700" aria-hidden="true">✓</span>
                    {claim}
                  </li>
                ))}
                {PROMISES.map(({ claim, paths }) => (
                  <li key={claim} className="flex items-center gap-2 pl-2 sm:pl-4">
                    <svg
                      viewBox="0 0 24 24"
                      className="w-3.5 h-3.5 shrink-0 text-orange-700"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {paths.map((d) => <path key={d} d={d} />)}
                    </svg>
                    {claim}
                  </li>
                ))}
              </ul>
            </div>

            {/* Under the card, outside the box: a statement the page makes
                about the panel above it rather than one more row of the
                panel's own furniture. It sits in the always-visible column,
                so unlike the illustration side it needs no breakpoint twin. */}
            <PrivacyNote
              className="mt-4"
              repo="https://github.com/universal-simulation-ltd/Universal_PDF"
              proof="https://github.com/universal-simulation-ltd/Universal_PDF/blob/main/PRIVACY.md"
              subject="Your PDF"
              except="backup and send-to-sign"
            />
          </div>

        </div>

        {/* ⚠️ Outside the grid, not inside it: as a third child of a
            two-column grid this became a grid ITEM and landed in the left
            column above the headline. Under the whole hero, never above it —
            the browser is the product, and nothing here should imply this
            page is the lesser version. */}
        <DownloadRow />
      </div>

      {compressJob && (
        <CompressResultModal
          sourceBytes={compressJob.sourceBytes}
          fileName={compressJob.fileName}
          initialResult={compressJob.result}
          onClose={() => setCompressJob(null)}
          discardLabel="Discard"
        />
      )}

      {batchJob && (
        <BatchCompressModal
          files={batchJob.files}
          initialResults={batchJob.results}
          initialQuality={DEFAULT_COMPRESS_QUALITY}
          onClose={() => setBatchJob(null)}
        />
      )}

      <TransformPanel open={transformOpen} onClose={() => setTransformOpen(false)} />

      {mergeOpen && <MergeDialog onClose={() => setMergeOpen(false)} />}

      {convertMode && (
        <ConvertDialog initialMode={convertMode} onClose={() => setConvertMode(null)} />
      )}

      {ocrJob && (
        <OcrModal
          sourceBytes={ocrJob.bytes}
          fileName={ocrJob.name}
          onClose={() => setOcrJob(null)}
          onOpen={(file) => {
            loadFile(file).catch((err) => {
              console.error(err)
              alert('Failed to load searchable PDF')
            })
          }}
        />
      )}

      {/* The other half of `pageWide` — the circle lights up wherever the drag
          is, and this says why, in the margin where the pointer actually is. */}
      <DropAnywhere
        show={showDropHint}
        title="Drop to open"
        hint="PDF files only — anywhere on this page will do"
        icon={<span aria-hidden="true">📄</span>}
      />
    </div>
  )
}
