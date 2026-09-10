import { useEffect, useId, useRef, useState } from 'react'
import { readPdfMetadata, type PdfMetadata } from '../../lib/pdfMetadata'
import { usePdfStore } from '../../stores/pdfStore'

// "Advanced → Document metadata": show everything the open PDF says about
// itself, then let the user strip it. Read and rewrite both run on the bytes
// already in the tab — nothing is uploaded.

type Phase = 'reading' | 'ready' | 'scrubbing' | 'error'

interface Props {
  sourceBytes: ArrayBuffer
  onClose: () => void
}

export default function MetadataDialog({ sourceBytes, onClose }: Props) {
  const scrubMetadata = usePdfStore((s) => s.scrubMetadata)

  const [phase, setPhase] = useState<Phase>('reading')
  const [meta, setMeta] = useState<PdfMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scrubbed, setScrubbed] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const infoId = useId()
  // Ignore async results if the dialog closed mid-read (OcrModal pattern).
  const liveRef = useRef(true)
  // Read the bytes the dialog opened on, once. Scrubbing replaces the store's
  // sourceBytes, and re-reading them here would race the "stripped" result we
  // already know is correct.
  const openedBytes = useRef(sourceBytes)

  useEffect(() => {
    liveRef.current = true
    // pdf-lib detaches the ArrayBuffer it parses, so hand it a copy.
    readPdfMetadata(openedBytes.current.slice(0))
      .then((m) => {
        if (!liveRef.current) return
        setMeta(m)
        setPhase('ready')
      })
      .catch((err) => {
        console.error(err)
        if (!liveRef.current) return
        setError((err as Error).message || 'Could not read this PDF’s metadata')
        setPhase('error')
      })
    return () => {
      liveRef.current = false
    }
  }, [])

  async function onScrub() {
    setPhase('scrubbing')
    try {
      await scrubMetadata()
      if (!liveRef.current) return
      setMeta({ fields: [], xmpBytes: 0, encrypted: false, hasAny: false })
      setScrubbed(true)
      setPhase('ready')
    } catch (err) {
      console.error(err)
      if (!liveRef.current) return
      setError((err as Error).message || 'Could not strip the metadata')
      setPhase('error')
    }
  }

  const busy = phase === 'reading' || phase === 'scrubbing'
  const identifying = meta?.fields.filter((f) => f.identifying).length ?? 0

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl p-5 w-full max-w-md max-h-[min(100%,100dvh)] flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <span aria-hidden="true">🏷</span>
            Document metadata
          </h2>
          {!busy && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center"
            >
              ×
            </button>
          )}
        </div>

        {/* "What is metadata?" — a small (i) rather than a permanent paragraph,
            so the panel stays about *this* file for anyone who already knows. */}
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setInfoOpen((v) => !v)}
            aria-expanded={infoOpen}
            aria-controls={infoId}
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-orange-700 transition-colors"
          >
            <span
              aria-hidden="true"
              className="w-4 h-4 rounded-full border border-current flex items-center justify-center text-[10px] font-serif italic leading-none"
            >
              i
            </span>
            What is metadata?
          </button>
          {infoOpen && (
            <p id={infoId} className="mt-2 text-xs text-slate-600 leading-relaxed bg-slate-50 rounded-lg px-3 py-2.5">
              Metadata is the hidden description a PDF carries about itself — who
              wrote it, which program made it, and when it was created and last
              edited. It travels with the file, so whoever you send it to can read
              it. Stripping it changes nothing you can see on the page.
            </p>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {phase === 'reading' && (
            <div className="py-6 text-center text-sm text-slate-500">Reading metadata…</div>
          )}

          {phase === 'error' && (
            <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3 text-sm">{error}</div>
          )}

          {(phase === 'ready' || phase === 'scrubbing') && meta && (
            <>
              {!meta.hasAny && (
                <div
                  className={[
                    'rounded-lg px-4 py-3 text-sm font-medium',
                    scrubbed ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-600',
                  ].join(' ')}
                >
                  {scrubbed
                    ? 'Metadata stripped — this document no longer names an author, a program or a date.'
                    : 'This PDF carries no metadata. Nothing to strip.'}
                </div>
              )}

              {meta.hasAny && (
                <>
                  {identifying > 0 && (
                    <div className="rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-xs mb-3">
                      {identifying} of these {identifying === 1 ? 'field' : 'fields'} could identify
                      you, your organisation or your computer.
                    </div>
                  )}

                  <dl className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                    {meta.fields.map((f) => (
                      <div key={f.key} className="px-3 py-2 bg-white">
                        <dt className="text-[11px] uppercase tracking-wide text-slate-400 font-medium flex items-center gap-1.5">
                          {f.label}
                          {f.identifying && (
                            <span className="text-amber-600 normal-case tracking-normal" title="Can identify you">
                              ⚠
                            </span>
                          )}
                        </dt>
                        <dd className="text-sm text-slate-800 break-words">{f.value}</dd>
                      </div>
                    ))}
                    {meta.xmpBytes > 0 && (
                      <div className="px-3 py-2 bg-white">
                        <dt className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">
                          XMP packet
                        </dt>
                        <dd className="text-sm text-slate-800">
                          {meta.xmpBytes.toLocaleString()} bytes of embedded XML
                          <span className="block text-[11px] text-slate-500">
                            An extra metadata block — often repeats the author and tool, and can
                            carry edit history.
                          </span>
                        </dd>
                      </div>
                    )}
                  </dl>
                </>
              )}

              {meta.encrypted && (
                <p className="mt-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                  This PDF is encrypted, so its metadata can be read but not rewritten.
                </p>
              )}
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2 justify-end shrink-0">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            {scrubbed ? 'Done' : 'Close'}
          </button>
          {phase !== 'error' && meta?.hasAny && !meta.encrypted && (
            <button
              onClick={onScrub}
              disabled={busy}
              className="px-4 py-2 bg-orange-700 hover:bg-orange-800 text-white rounded text-sm font-medium disabled:opacity-50"
            >
              {phase === 'scrubbing' ? 'Stripping…' : 'Scrub metadata'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
