import { create } from 'zustand'
import { saveCurrentPdf } from '../lib/saveDocument'
import { hasUnsavedChanges } from '../lib/unsavedChanges'

/**
 * What the user was trying to do when the guard stopped them. Only the wording
 * of the popup depends on it — every intent runs the same three answers.
 */
export type ExitIntent =
  /** Actions → File → Close PDF. */
  | 'close'
  /** Opening (or dropping) a different PDF over the top of this one. */
  | 'open-another'
  /**
   * Merging or converting the open document into a NEW one, which then replaces
   * it (James, 2026-09-08: "I had annotations and then used the merge option
   * thinking it would keep my annotations but it destroyed them and merged
   * anew"). Merge works from the FILES, not from what is on screen, so the
   * annotation layer does not travel — and nothing said so.
   */
  | 'merge'
  | 'convert'
  /** Closing the desktop window / quitting the app. */
  | 'quit'

interface PendingExit {
  intent: ExitIntent
  /** The thing that was going to happen. Runs once the user has answered. */
  run: () => void | Promise<void>
}

interface ExitGuardState {
  pending: PendingExit | null
  saving: boolean
  error: string | null
  /**
   * Do `run`, unless the document has amendments no saved copy contains — in
   * which case put the popup up and do it when the user says so.
   *
   * ⚠️ Every route out of a document goes through here, so a new one (a
   * shortcut, a mobile back gesture) is one call rather than a fourth copy of
   * the dialog.
   */
  requestExit: (intent: ExitIntent, run: () => void | Promise<void>) => void
  /** Stay with the document. */
  cancel: () => void
  /** Leave; the amendments stay in this device's recent files either way. */
  exitWithoutSaving: () => void
  /** Write the file out, then leave. A cancelled Save dialog leaves the popup
   *  up rather than exiting — backing out of the save is not an answer. */
  saveAndExit: () => Promise<void>
}

export const useExitGuard = create<ExitGuardState>((set, get) => ({
  pending: null,
  saving: false,
  error: null,

  requestExit: (intent, run) => {
    if (!hasUnsavedChanges()) {
      void run()
      return
    }
    set({ pending: { intent, run }, saving: false, error: null })
  },

  cancel: () => {
    if (get().saving) return
    set({ pending: null, error: null })
  },

  exitWithoutSaving: () => {
    const pending = get().pending
    if (!pending || get().saving) return
    set({ pending: null, error: null })
    void pending.run()
  },

  saveAndExit: async () => {
    const pending = get().pending
    if (!pending || get().saving) return
    set({ saving: true, error: null })
    try {
      const outcome = await saveCurrentPdf()
      if (outcome === 'cancelled') {
        set({ saving: false })
        return
      }
    } catch (e) {
      set({ saving: false, error: (e as Error).message || 'The PDF could not be saved.' })
      return
    }
    set({ saving: false, pending: null })
    await pending.run()
  }
}))
