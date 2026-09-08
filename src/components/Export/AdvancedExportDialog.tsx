import { useEffect, useState } from 'react'
import { usePdfStore } from '../../stores/pdfStore'
import { useAnnotationStore } from '../../stores/annotationStore'
import { downloadPdfBytes, type CompressQuality } from '../../lib/export'
import { nextExportName, previewExportName } from '../../lib/exportName'
import { countRedactions, isRedactConfirmed } from '../../lib/redactGate'
import { encryptPdf } from '../../lib/pdfEncrypt'
import { scrubPdfMetadata } from '../../lib/pdfMetadata'
import LockFields, { EMPTY_LOCK, lockIncomplete, lockPasswordOf, type LockState } from '../Lock/LockFields'
import { markSaved } from '../../lib/unsavedChanges'
import { RedactIcon } from '../icons/RedactIcon'
import { useExportBuild } from './useExportBuild'

// Actions ▸ Advanced ▸ Advanced export — the things that change what the
// exported file IS, rather than how big it is: flatten, strip metadata, lock.
//
// ⚠️ WHY THEY SHARE A DIALOG rather than being rows in the Advanced menu
// (owner decision, 2026-09-01). They are routinely wanted TOGETHER: the
// document you flatten so nobody can edit what you signed is the same document
// you then want sealed with a password, and stripped of the author's name.
// Separate actions would mean flatten, download, re-open the result, lock,
// download again — two files on disk and a version number burnt on the
// intermediate one. Here they are applied in one pass to one file.
//
// ⚠️ ORDER MATTERS AND IS NOT NEGOTIABLE: flatten, then scrub, then encrypt.
// The rasteriser writes a fresh document carrying its own producer metadata,
// so scrubbing before it would be undone; pdf-lib cannot open an encrypted
// document at all, so both must happen before the lock.
//
// ⚠️ TWO ORTHOGONAL QUESTIONS, and until 2026-08-31 the export dialog asked
// them as one. `CompressQuality` is a single scale — light / balanced / strong
// — but 'light' differs from the other two in KIND, not in degree: it is a
// lossless re-save, while both the others turn every page into a picture.
// Presenting them as one row of three made "do I keep my text layer?" look
// like a compression setting, and gated it behind whether flattening would
// save enough bytes to be worth offering.
//
// It is not a size question. The reason to want a flattened PDF is "nobody can
// reflow, copy or edit what I signed", which is true of a 40 KB letter exactly
// as it is of a 40 MB scan — and a 40 KB letter never cleared the ≥20% AND
// ≥100 KB bar in `worthOffering`, so on every text document (every Word file
// this app converts, for one) the mode was present, functional and completely
// unreachable.
//
// So the two questions are two controls: a FLATTEN checkbox, always available,
// and — only once flattening is on — a strength choice between the two
// rasterising levels. 'light' is no longer a button; it IS the unchecked box.
const FLATTEN_OPTIONS: { value: CompressQuality; label: string; hint: string }[] = [
  { value: 'balanced', label: 'Balanced', hint: 'Good quality · big saving on scans' },
  { value: 'strong', label: 'Maximum', hint: 'Smallest · most visible loss' }
]

/** The quality used when the flatten box is ticked, before any strength is picked. */
const DEFAULT_FLATTEN: CompressQuality = 'balanced'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function AdvancedExportDialog({ open, onClose }: Props) {
  const fileName = usePdfStore((s) => s.fileName)
  const isXfa = usePdfStore((s) => s.isXfa)
  const annotations = useAnnotationStore((s) => s.annotations)

  // ⚠️ ONE boolean's worth of state, held as the quality itself. There is no
  // separate `flatten` flag to keep in step, and so no way for the checkbox and
  // the compressor to disagree about what is being produced.
  const [quality, setQuality] = useState<CompressQuality>('light')
  const flatten = quality !== 'light'

  // null while the box is unticked, so the compression pass never runs for a
  // file nobody asked to rasterise — minutes of work on a long document.
  const { annotated, compressed, rasterEstimate, building, compressing, compressPct, error, ready } =
    useExportBuild(open, flatten ? quality : null)

  // Locking runs at DOWNLOAD time, not while the dialog is open: it is the
  // last step over the finished bytes, and re-running it on every keystroke of
  // a password would be both pointless and slow (Algorithm 2.B is designed to
  // be slow). `locking` exists because that step is the one part of an export
  // that can take a visible moment.
  const [lock, setLock] = useState<LockState>(EMPTY_LOCK)
  const [locking, setLocking] = useState(false)
  const [lockError, setLockError] = useState<string | null>(null)

  // ⚠️ SCRUBBING IS THE DEFAULT, and the checkbox is the way OUT of it (James,
  // 2026-09-08: "any reason not to scrub the metadata by default? ... so we are
  // privacy first"). Author, dates and producing app identify a person and do
  // no work for the reader, so the file you hand someone should not carry them
  // unless you meant it to.
  //
  // Held as `keepMeta` rather than as a `scrub` flag someone has to remember to
  // invert: the state IS what the box says, so the box and the behaviour cannot
  // drift apart.
  //
  // Metadata is stripped at DOWNLOAD time for the same reason locking is: it
  // rewrites the finished bytes, and there is nothing to show for it in the
  // dialog beforehand.
  const [keepMeta, setKeepMeta] = useState(false)
  const [scrubError, setScrubError] = useState<string | null>(null)

  const redactCount = countRedactions(annotations)
  const needsRedactConfirm = !isXfa && redactCount > 0
  const [redactConfirm, setRedactConfirm] = useState('')
  const redactConfirmed = !needsRedactConfirm || isRedactConfirmed(redactConfirm)

  useEffect(() => {
    if (!open) return
    setQuality('light')
    setRedactConfirm('')
    // ⚠️ Cleared every time the dialog opens. A password left in state from a
    // previous export would silently lock the NEXT document with it — a file
    // the user never meant to protect, sealed with something they have already
    // forgotten they typed.
    setLock(EMPTY_LOCK)
    setLockError(null)
    setKeepMeta(false)
    setScrubError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const origSize = annotated?.byteLength ?? 0
  const outSize = flatten ? compressed?.compressedSize ?? 0 : origSize
  const delta = origSize - outSize

  // Which strength buttons are worth putting on screen.
  //
  // Measured Maximum against Balanced, because Balanced is what ticking the box
  // already gives you. A level that would shave 3% more off does not earn a
  // second button — one button is not a choice.
  const RASTER_WORTH_IT = 0.2 // ≥20% smaller...
  const RASTER_MIN_BYTES = 100 * 1024 // ...and ≥100 KB, so tiny files don't qualify on ratio alone
  function worthOffering(estimated: number, against: number): boolean {
    const savedVs = against - estimated
    return savedVs >= against * RASTER_WORTH_IT && savedVs >= RASTER_MIN_BYTES
  }
  const offeredQualities = FLATTEN_OPTIONS.filter((opt) => {
    if (opt.value === 'balanced') return true
    // Not measured yet (or the estimate failed): show it rather than hide a
    // level that might have been the useful one.
    if (!rasterEstimate) return true
    // Never hide the level currently in use — a button vanishing from under
    // the user's own selection is worse than one that turns out not to help.
    if (opt.value === quality) return true
    return worthOffering(rasterEstimate.strong, rasterEstimate.balanced)
  })
  const showStrength = flatten && offeredQualities.length > 1

  // How much smaller flattening would make it, for the line under the checkbox.
  // Null when unknown, and — deliberately — also when it would make the file
  // BIGGER: a text document rasterises to something larger almost every time,
  // and "· 240 KB bigger" beside a checkbox reads as a warning against ticking
  // it when size is not what it is for.
  const flattenSaving =
    rasterEstimate && annotated && origSize - rasterEstimate.balanced >= RASTER_MIN_BYTES
      ? origSize - rasterEstimate.balanced
      : null

  const previewName = previewExportName(fileName)
  const blocked = !ready || !redactConfirmed || lockIncomplete(lock) || locking

  async function download() {
    if (!annotated) return
    // ⚠️ The FLATTENED bytes when the box is ticked, and bail rather than fall
    // back to `annotated` if they are somehow absent. Silently handing over a
    // file whose text is still selectable, to someone who ticked a box saying
    // it would not be, is the one failure worse than an error.
    if (flatten && !compressed) return
    // Widened to plain `Uint8Array` because the locked bytes come back over a
    // buffer TypeScript will not narrow to ArrayBuffer; both are the same
    // thing at runtime.
    let bytes: Uint8Array = (flatten ? compressed!.bytes : annotated).slice()

    // ⚠️ BEFORE the lock, after the flatten. Both neighbours are load-and-save
    // passes over the whole document: the rasteriser writes a fresh file (with
    // its own producer metadata) so scrubbing first would be undone, and
    // pdf-lib cannot open an encrypted one at all, so scrubbing last would
    // simply fail.
    if (!keepMeta) {
      setScrubError(null)
      try {
        bytes = new Uint8Array(await scrubPdfMetadata(bytes.slice().buffer as ArrayBuffer))
      } catch (e) {
        // Bail rather than fall through, on the same grounds as the lock below:
        // handing over a file still carrying the author's name, to someone who
        // ticked a box saying it would not, is worse than an error.
        setScrubError((e as Error).message || 'Could not strip the metadata.')
        return
      }
    }

    if (lock.enabled) {
      const password = lockPasswordOf(lock)
      // ⚠️ Bail, never fall through. If the fields are incomplete the button
      // is already disabled, but the one unacceptable outcome here is handing
      // someone an UNLOCKED file because their confirm box was a character
      // out — so the null case stops the export rather than skipping the lock.
      if (!password) return
      setLockError(null)
      setLocking(true)
      try {
        bytes = (await encryptPdf(bytes, password)).bytes
      } catch (e) {
        setLockError((e as Error).message || 'Could not lock this PDF.')
        return
      } finally {
        setLocking(false)
      }
    }

    // ⚠️ Claimed only now that the bytes exist. `nextExportName` increments a
    // per-document counter, so calling it before a lock that then failed would
    // burn v1 on a file that was never written.
    const name = nextExportName(fileName)
    downloadPdfBytes(bytes, name)
    // The amendments are now in a file, so the exit guard has nothing left to
    // offer to save. Every route out of a document reads this.
    markSaved()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Same viewport-capped column as the export dialog — see ExportModal for
          why `max-h-[min(100%,100dvh)]` rather than a `vh` cap. */}
      <div className="bg-white rounded-xl shadow-2xl p-5 w-full max-w-lg flex max-h-[min(100%,100dvh)] flex-col">
        <div className="flex shrink-0 items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-900">Advanced export</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="-mx-5 min-h-0 flex-1 overflow-y-auto px-5">
        {error ? (
          <div className="text-sm text-red-600">Export failed: {error}</div>
        ) : isXfa ? (
          // Neither control can work on an XFA document: the rasteriser only
          // ever captures Adobe's placeholder page, and there is no reason to
          // send someone down that path to find out.
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="text-sm font-medium text-slate-900">Filled XFA form</div>
            <p className="mt-1 text-xs text-slate-500">
              Flattening and locking aren't available for XFA documents. Use Export to
              download the filled form.
            </p>
          </div>
        ) : (
          <>
            {/* ⚠️ ALWAYS OFFERED, on every document. This used to be two of
                three buttons in a "Compression" row that only appeared when
                rasterising would save ≥20% AND ≥100 KB — so on a text document
                it was unreachable, which is precisely the document somebody
                wants flattened. The reason to want it is "nobody can reflow,
                copy or edit what I signed"; that has nothing to do with file
                size, so size no longer gates it. */}
            <div className="mb-3">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={flatten}
                  onChange={(e) => setQuality(e.target.checked ? DEFAULT_FLATTEN : 'light')}
                  disabled={building || compressing}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-orange-700 disabled:cursor-wait"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900">
                    Flatten pages to images
                    {flattenSaving !== null && (
                      <span className="ml-1.5 text-xs font-medium tabular-nums text-emerald-700">
                        ≈ {formatSize(flattenSaving)} smaller
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-slate-500 mt-0.5">
                    Every page becomes a picture, so nobody can select, copy, search or edit
                    the text — useful for a document you have signed.
                  </span>
                </span>
              </label>

              {/* Only a choice between the two rasterising levels, so it lives
                  inside the checkbox it belongs to and appears with it. */}
              {showStrength && (
                <div className="mt-2.5 pl-6.5">
                  <div className="text-xs uppercase tracking-wide text-slate-500 font-medium mb-1.5">
                    Image quality
                  </div>
                  <div
                    className="grid gap-1 p-1 bg-slate-100 rounded-lg"
                    style={{ gridTemplateColumns: `repeat(${offeredQualities.length}, minmax(0, 1fr))` }}
                  >
                    {offeredQualities.map((opt) => {
                      const active = opt.value === quality
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setQuality(opt.value)}
                          disabled={building || compressing}
                          aria-pressed={active}
                          className={[
                            'rounded-md px-2 py-1.5 text-sm font-medium transition-colors disabled:cursor-wait',
                            active
                              ? 'bg-white text-orange-700 shadow-sm'
                              : 'text-slate-600 hover:text-slate-900'
                          ].join(' ')}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="mt-1.5 text-xs text-slate-500">
                    {FLATTEN_OPTIONS.find((o) => o.value === quality)?.hint}
                  </div>
                </div>
              )}

              {flatten && (
                <div className="mt-2 text-xs text-amber-700">
                  Your open document keeps its text layer — only the downloaded copy is
                  flattened. Export again from the toolbar if you need the text back.
                </div>
              )}
            </div>

            {/* Metadata, on the way out (James, 2026-09-08: "add scrub metadata
                to the advanced export popup too", then "any reason not to scrub
                the metadata by default?").
                ⚠️ NOT the same command as Advanced ▸ Document metadata ▸ Strip.
                That one rewrites the document you are working on — the author
                and dates are gone from the file you keep. This applies to the
                COPY being downloaded and leaves the open document alone, which
                is the same bargain flattening makes two boxes up.
                ⚠️ The caption says what the UNTICKED state does, deliberately.
                A box nobody ticks is a box nobody reads, and this is the one
                control here whose default CHANGES the file — so the sentence
                has to work when the box is left alone. */}
            <div className="mb-3">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={keepMeta}
                  onChange={(e) => setKeepMeta(e.target.checked)}
                  disabled={building || compressing}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-orange-700 disabled:cursor-wait"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900">Keep metadata</span>
                  <span className="block text-xs text-slate-500 mt-0.5">
                    {keepMeta
                      ? 'The author, title, dates and producing app travel with the downloaded copy.'
                      : 'The author, title, dates and producing app are removed from the downloaded copy. Your open document keeps its own.'}
                  </span>
                  {/* Only when it is about to happen. Stripping the XMP packet
                      is what takes a PDF/A or PDF/UA document out of
                      conformance, and takes any licence statement with it —
                      invisible unless someone says so. */}
                  {!keepMeta && (
                    <span className="block text-xs text-amber-700 mt-1">
                      Tick this for an archival (PDF/A), accessible (PDF/UA) or licensed
                      document — their conformance and licence live in the metadata.
                    </span>
                  )}
                </span>
              </label>
              {scrubError && <div className="mt-2 text-xs text-red-600">{scrubError}</div>}
            </div>

            {/* ⚠️ Below flattening, and that ordering is the point. The two
                look like neighbours — both are "stop someone doing something
                with this file" — but only one of them is real. Flattening
                removes the text layer; locking encrypts the document. Putting
                a lock beside a PDF "no printing / no copying" permissions
                checkbox is what most PDF apps do, and it is why users believe
                those flags protect anything. There is no such checkbox here on
                purpose — see the note at the top of lib/pdfCrypto.ts. */}
            <LockFields value={lock} onChange={setLock} disabled={building || compressing || locking} />

            <div className="rounded-lg border border-slate-200 p-4">
              {!ready ? (
                <>
                  <div className="text-sm text-slate-500">
                    {building ? 'Building export…' : 'Flattening pages…'}
                  </div>
                  {/* A rasterising pass over a long document is minutes of
                      work. Without a bar it reads as a hung dialog, which is
                      how people learn to kill the tab mid-export. */}
                  {compressing && (
                    <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full bg-orange-600 transition-[width] duration-200"
                        style={{ width: `${Math.round(compressPct * 100)}%` }}
                      />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <div className="text-2xl font-semibold text-slate-900 tabular-nums">
                      {formatSize(outSize)}
                    </div>
                    {/* ⚠️ Three outcomes, not one. Flattening a text document
                        routinely produces a BIGGER file, and a single line
                        would render that as "Saved -240 KB" in green — a
                        saving of a negative number, which is not a sentence
                        anybody should have to parse. */}
                    {!flatten ? (
                      <div className="text-xs text-slate-500">annotations baked in</div>
                    ) : delta > 0 ? (
                      <div className="text-xs font-medium text-emerald-700">
                        {formatSize(delta)} smaller
                      </div>
                    ) : delta < 0 ? (
                      <div className="text-xs font-medium text-amber-700">
                        {formatSize(-delta)} bigger
                      </div>
                    ) : (
                      <div className="text-xs font-medium text-slate-500">Same size</div>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {flatten ? 'pages rasterised to JPEG' : 'no changes to the pages'}
                    {lock.enabled && ' · locked with AES-256'}
                  </div>
                </>
              )}
            </div>

            {needsRedactConfirm && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3.5">
                <div className="flex items-start gap-2.5">
                  <span className="text-red-600 mt-0.5 shrink-0">
                    <RedactIcon size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-red-900">
                      Permanent redaction
                    </div>
                    <p className="mt-1 text-xs text-red-700">
                      Exporting flattens {redactCount} redaction box{redactCount === 1 ? '' : 'es'} and
                      removes the text underneath for good. This can't be undone.
                    </p>
                    <input
                      value={redactConfirm}
                      onChange={(e) => setRedactConfirm(e.target.value)}
                      placeholder="Type REDACT to confirm"
                      aria-label="Type REDACT to confirm"
                      autoCapitalize="characters"
                      spellCheck={false}
                      className="mt-2.5 w-full rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 placeholder:text-red-300"
                    />
                  </div>
                </div>
              </div>
            )}

            <p className="mt-4 text-xs text-slate-500">
              Saves as <span className="font-medium text-slate-700">{previewName}</span>
            </p>

            {/* A disabled button with no stated reason is the same as a broken
                one. `lockIncomplete` is the only condition here that the user
                can fix by typing, so it is the only one that says so. */}
            {lockIncomplete(lock) && !lockError && (
              <p className="mt-1 text-xs text-amber-700">
                Finish the {lock.mode === 'pin' ? 'PIN' : 'password'} fields above to download.
              </p>
            )}
            {lockError && <p className="mt-1 text-xs text-red-600">{lockError}</p>}

            <div className="mt-2">
              <button
                onClick={() => { void download() }}
                disabled={blocked}
                className="w-full px-4 py-2.5 bg-orange-700 hover:bg-orange-800 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2"
              >
                <span aria-hidden="true">{lock.enabled ? '🔒' : '⬇'}</span>
                {locking
                  ? 'Locking…'
                  : flatten && lock.enabled
                    ? 'Download flattened & locked'
                    : flatten
                      ? 'Download flattened'
                      : lock.enabled
                        ? 'Download locked'
                        : 'Download'}
              </button>
            </div>
          </>
        )}
        </div>

        <div className="mt-5 flex shrink-0 items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded text-sm font-medium text-slate-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
