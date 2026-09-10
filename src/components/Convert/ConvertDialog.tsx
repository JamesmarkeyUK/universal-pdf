import { useRef, useState } from 'react'
import { pdfToImages, imagesToPdf, type ImageFormat } from '../../lib/convert'
import { downloadPdfBytes } from '../../lib/export'
import { downloadZip } from '../../lib/zip'
import { usePdfStore } from '../../stores/pdfStore'
import { useExitGuard } from '../../stores/exitGuard'
import { saveBlob } from '@unisim/media/save'

export type ConvertMode = 'pdf-to-images' | 'images-to-pdf'

interface Props {
  initialMode: ConvertMode
  onClose: () => void
  /** Seed the PDF→images side with this file (the currently-open document when
   *  launched from the viewer's Advanced menu). Omit to start empty. */
  initialPdf?: File | null
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// Convert between PDFs and images, both directions, fully on-device: pdfjs
// rasterizes each page to a canvas (→ PNG/JPG), and pdf-lib embeds images into a
// fresh PDF. Multi-page rasterization downloads a ZIP (via the store-mode writer
// in zip.ts); a single page downloads the bare image.
export default function ConvertDialog({ initialMode, onClose, initialPdf }: Props) {
  const [mode, setMode] = useState<ConvertMode>(initialMode)
  const [pdf, setPdf] = useState<File | null>(initialPdf ?? null)
  const [images, setImages] = useState<File[]>([])
  const [format, setFormat] = useState<ImageFormat>('png')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const loadFile = usePdfStore((s) => s.loadFile)
  const snapshotDocument = usePdfStore((s) => s.snapshotDocument)
  const requestExit = useExitGuard((s) => s.requestExit)

  function switchMode(next: ConvertMode) {
    if (busy) return
    setMode(next)
    setProgress('')
  }

  async function runPdfToImages() {
    if (!pdf || busy) return
    setBusy(true)
    setProgress('')
    try {
      const buf = await pdf.arrayBuffer()
      const entries = await pdfToImages(buf, pdf.name, {
        format,
        onProgress: (done, total) => setProgress(`Rendering ${done}/${total}…`)
      })
      if (entries.length === 1) {
        const mime = format === 'png' ? 'image/png' : 'image/jpeg'
        const blob = new Blob([entries[0].data as BlobPart], { type: mime })
        saveBlob(blob, entries[0].name)
      } else {
        const stem = pdf.name.replace(/\.pdf$/i, '')
        downloadZip(entries, `${stem}-images.zip`)
      }
      onClose()
    } catch (err) {
      console.error(err)
      alert('Convert failed: ' + (err as Error).message)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  async function runImagesToPdf(open: boolean) {
    if (images.length === 0 || busy) return
    setBusy(true)
    try {
      const bytes = await imagesToPdf(images)
      if (open) {
        const file = new File([bytes.slice() as BlobPart], 'converted.pdf', {
          type: 'application/pdf'
        })
        // Same bargain as the merge dialog: the converted file replaces an
        // annotated document without carrying its annotations, so it asks
        // first — and leaves an undo step behind either way.
        requestExit('convert', async () => {
          snapshotDocument('convert')
          await loadFile(file, { keepDocUndo: true })
          onClose()
        })
        return
      }
      downloadPdfBytes(bytes, 'converted.pdf')
      onClose()
    } catch (err) {
      console.error(err)
      alert('Convert failed: ' + (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      {/* ⚠️ Capped at the viewport and split: the title row is pinned and
          everything below it scrolls. `min(100%,100dvh)` rather than a `vh`
          cap — `vh` is the LARGE viewport on iOS, so a `vh`-capped box can
          still overrun the visible area once the browser chrome shows. */}
      <div className="bg-white rounded-xl shadow-2xl p-5 w-full max-w-lg flex max-h-[min(100%,100dvh)] flex-col">
        <div className="flex shrink-0 items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-900">Convert</h2>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center disabled:opacity-50"
          >
            ×
          </button>
        </div>
        <div className="-mx-5 min-h-0 flex-1 overflow-y-auto px-5">

        {/* Direction toggle */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg mb-4">
          {([
            ['pdf-to-images', 'PDF → images'],
            ['images-to-pdf', 'Images → PDF']
          ] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => switchMode(value)}
              disabled={busy}
              aria-pressed={mode === value}
              className={[
                'rounded-md px-2 py-1.5 text-sm font-medium transition-colors disabled:cursor-wait',
                mode === value ? 'bg-white text-orange-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'pdf-to-images' ? (
          <>
            <button
              type="button"
              onClick={() => pdfInputRef.current?.click()}
              disabled={busy}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-slate-200 text-left hover:border-orange-400 hover:bg-orange-50/50 transition-colors disabled:opacity-60"
            >
              <span className="shrink-0 w-9 h-9 rounded bg-slate-100 text-slate-600 flex items-center justify-center">
                📄
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-slate-800 truncate">
                  {pdf ? pdf.name : 'Choose a PDF…'}
                </span>
                <span className="block text-xs text-slate-500">
                  {pdf ? formatSize(pdf.size) : 'One image per page'}
                </span>
              </span>
            </button>
            <input
              ref={pdfInputRef}
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => {
                setPdf(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />

            <div className="mt-4">
              <div className="text-xs uppercase tracking-wide text-slate-500 font-medium mb-1.5">
                Image format
              </div>
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
                {([
                  ['png', 'PNG · sharp'],
                  ['jpeg', 'JPG · smaller']
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setFormat(value)}
                    disabled={busy}
                    aria-pressed={format === value}
                    className={[
                      'rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
                      format === value ? 'bg-white text-orange-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                    ].join(' ')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5 flex items-center gap-2 justify-end">
              <button
                onClick={onClose}
                disabled={busy}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded text-sm font-medium text-slate-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={runPdfToImages}
                disabled={!pdf || busy}
                className="px-4 py-2 bg-orange-700 hover:bg-orange-800 text-white rounded text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {busy ? progress || 'Converting…' : '⬇ Convert & download'}
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => imgInputRef.current?.click()}
              disabled={busy}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-slate-200 text-left hover:border-orange-400 hover:bg-orange-50/50 transition-colors disabled:opacity-60"
            >
              <span className="shrink-0 w-9 h-9 rounded bg-slate-100 text-slate-600 flex items-center justify-center">
                🖼
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-slate-800 truncate">
                  {images.length > 0 ? `${images.length} image${images.length > 1 ? 's' : ''} selected` : 'Choose images…'}
                </span>
                <span className="block text-xs text-slate-500">
                  PNG, JPG, WebP, HEIC — one page each, in the order picked
                </span>
              </span>
            </button>
            {/* `.heic`/`.heif` are spelled out even though `image/*` is here:
                a photo copied straight off a phone routinely has no MIME type
                on Windows, and `image/*` alone then greys it out in the
                picker — the file the format exists for. */}
            <input
              ref={imgInputRef}
              type="file"
              accept="image/*,.heic,.heif"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) setImages(Array.from(e.target.files))
                e.target.value = ''
              }}
            />

            {images.length > 0 && (
              <div className="mt-3 max-h-40 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                {images.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="w-5 text-right tabular-nums text-slate-400">{i + 1}</span>
                    <span className="truncate flex-1 text-slate-700" title={f.name}>{f.name}</span>
                    <span className="text-xs text-slate-400 tabular-nums shrink-0">{formatSize(f.size)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5 flex items-center gap-2 justify-end">
              <button
                onClick={onClose}
                disabled={busy}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded text-sm font-medium text-slate-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => runImagesToPdf(true)}
                disabled={images.length === 0 || busy}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Convert &amp; open
              </button>
              <button
                onClick={() => runImagesToPdf(false)}
                disabled={images.length === 0 || busy}
                className="px-4 py-2 bg-orange-700 hover:bg-orange-800 text-white rounded text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {busy ? 'Converting…' : '⬇ Convert & download'}
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
