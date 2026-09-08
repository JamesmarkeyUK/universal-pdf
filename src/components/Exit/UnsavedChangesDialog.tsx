import { useEffect, useState } from 'react'
import { useAnnotationStore } from '../../stores/annotationStore'
import { useExitGuard, type ExitIntent } from '../../stores/exitGuard'
import { usePdfStore } from '../../stores/pdfStore'
import { previewExportName } from '../../lib/exportName'
import { countRedactions, isRedactConfirmed } from '../../lib/redactGate'
import { RedactIcon } from '../icons/RedactIcon'

// The one popup that stands between an amended document and every way out of
// it — Close PDF, opening another, and the desktop window's × / ⌘Q. Three
// answers, always the same three: save the file and go, go anyway, or stay.
//
// It is raised by `stores/exitGuard.ts`, never by a caller directly, so the
// question is asked in exactly one place however many exits there come to be.

// What the user was doing, said back to them. The popup is about a decision,
// so it names the consequence rather than the button that got here.
const WHAT_HAPPENS: Record<ExitIntent, string> = {
  close: 'Closing it returns you to the start screen.',
  'open-another': 'Opening another PDF replaces what is on screen.',
  // ⚠️ These two say what the operation DOES to the amendments, not just that
  // the document is replaced. Merge and convert build the new file from the
  // source PDFs, so the annotation layer is not carried across — a fact that
  // was previously discoverable only by losing an afternoon's markup to it.
  merge: 'The merged PDF is built from the files themselves, so your annotations stay with this document rather than moving onto the result.',
  convert: 'The converted PDF is built fresh, so your annotations stay with this document rather than moving onto the result.',
  quit: 'Closing the window shuts Universal PDF down.'
}

export default function UnsavedChangesDialog() {
  const pending = useExitGuard((s) => s.pending)
  const saving = useExitGuard((s) => s.saving)
  const error = useExitGuard((s) => s.error)
  const cancel = useExitGuard((s) => s.cancel)
  const exitWithoutSaving = useExitGuard((s) => s.exitWithoutSaving)
  const saveAndExit = useExitGuard((s) => s.saveAndExit)

  const fileName = usePdfStore((s) => s.fileName)
  const annotations = useAnnotationStore((s) => s.annotations)

  const [redactConfirm, setRedactConfirm] = useState('')

  const redactCount = countRedactions(annotations)
  const needsRedactConfirm = redactCount > 0
  const canSave = !needsRedactConfirm || isRedactConfirmed(redactConfirm)

  // A fresh question each time it is asked — a REDACT typed on the way out of
  // one document must not still be sitting there on the way out of the next.
  //
  // ⚠️ Cleared when the popup CLOSES, not when it opens. Clearing on open
  // leaves one painted frame in which the old word is still in state and the
  // Save button is therefore already enabled — which an e2e caught, and a fast
  // double-click would have hit for real.
  useEffect(() => {
    if (!pending) setRedactConfirm('')
  }, [pending])

  // Escape is Cancel, which is the safe answer. Deliberately NOT while a save
  // is in flight: the file is half-written and there is nothing to go back to
  // yet. Registered in the capture phase so it beats the menus and panels
  // underneath, which close on Escape too.
  useEffect(() => {
    if (!pending) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (useExitGuard.getState().saving) return
      e.stopPropagation()
      e.preventDefault()
      cancel()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [pending, cancel])

  if (!pending) return null

  return (
    <div
      // z-[80] — above the Present overlay (z-[70]) and every dialog below it.
      // Whatever is on screen, the question about leaving is in front of it.
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[80] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      onClick={(e) => {
        // No click-outside-to-dismiss. Every other dialog in the app treats the
        // backdrop as Cancel, but this one is asking a question whose safe
        // answer costs a file — an accidental click should not answer it at all.
        e.stopPropagation()
      }}
    >
      {/* ⚠️ Capped at the viewport and split: the question and the three
          answers are pinned, and only the explanation between them scrolls.
          `min(100%,100dvh)` rather than a `vh` cap — `vh` is the LARGE
          viewport on iOS, so a `vh`-capped box can still overrun the visible
          area once the browser chrome shows. Of every dialog in the app this
          is the one that must never put its buttons off screen: it is asking a
          question whose wrong answer costs a file. */}
      <div className="bg-white rounded-xl shadow-2xl p-5 w-full max-w-md flex max-h-[min(100%,100dvh)] flex-col">
        <h2
          id="unsaved-changes-title"
          className="shrink-0 text-lg font-semibold text-slate-900 flex items-center gap-2"
        >
          <span aria-hidden="true">✎</span>
          Save your changes?
        </h2>

        <div className="-mx-5 min-h-0 flex-1 overflow-y-auto px-5">
        <p className="mt-2 text-sm text-slate-600 leading-relaxed">
          <span className="font-medium text-slate-800">{fileName ?? 'This PDF'}</span> has
          amendments that aren&rsquo;t in a saved file yet. {WHAT_HAPPENS[pending.intent]}
        </p>

        {/* Said plainly rather than left as a threat. The annotation layer is
            written to this device's recent files as you work, so "exit without
            saving" costs the FILE, not the work — and a popup that implies
            otherwise trains people to save copies they don't need. */}
        <p className="mt-2 text-xs text-slate-500 leading-relaxed bg-slate-50 rounded-lg px-3 py-2.5">
          Your marks stay in <span className="font-medium">Recent files</span> on this device
          either way — saving writes them into a PDF you can send, keep or print.
        </p>

        {needsRedactConfirm && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3.5">
            <div className="flex items-start gap-2.5">
              <span className="text-red-600 mt-0.5 shrink-0">
                <RedactIcon size={18} />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-red-900">Permanent redaction</div>
                <p className="mt-1 text-xs text-red-700">
                  Saving flattens {redactCount} redaction box{redactCount === 1 ? '' : 'es'} and
                  removes the text underneath for good. This can&rsquo;t be undone.
                </p>
                <input
                  value={redactConfirm}
                  onChange={(e) => setRedactConfirm(e.target.value)}
                  placeholder="Type REDACT to confirm"
                  aria-label="Type REDACT to confirm"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={saving}
                  className="mt-2.5 w-full rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 placeholder:text-red-300 disabled:opacity-60"
                />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* The file the Save button is about to write. Same name the Export
            dialog would give it — a second version of the document you opened. */}
        <div className="mt-3 text-xs text-slate-500">
          Saves as <span className="font-medium text-slate-700">{previewExportName(fileName)}</span>
        </div>

        </div>

        <div className="mt-4 flex shrink-0 flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            onClick={cancel}
            disabled={saving}
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={exitWithoutSaving}
            disabled={saving}
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-red-700 bg-white ring-1 ring-red-200 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Exit without saving
          </button>
          <button
            onClick={() => void saveAndExit()}
            disabled={saving || !canSave}
            autoFocus
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-orange-700 hover:bg-orange-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <span aria-hidden="true">⬇</span>
            {saving ? 'Saving…' : 'Save and exit'}
          </button>
        </div>
      </div>
    </div>
  )
}
