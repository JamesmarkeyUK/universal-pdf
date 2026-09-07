// Where the open document came from — so saving it puts it back there.
//
// Someone who opened a contract out of a client folder is saving the signed
// copy beside it, not into the same pile as every browser download they have
// ever made. The desktop app's Save dialog therefore starts in the folder the
// document was opened from, and only falls back to ~/Downloads when no document
// this session has come off the disk at all.
//
// ⚠️ The renderer cannot work the folder out for itself. It is sandboxed, it
// sees a `File` and nothing else — and since Electron 32 a `File` has no
// `.path` at all. Only `webUtils.getPathForFile`, which lives in the preload,
// can turn one back into a path, so this is a one-line message to the bridge
// rather than anything resolved here.
//
// A no-op in the browser and on a phone: neither has a save dialog whose
// starting folder we could choose.

/**
 * Tell the desktop shell which file is now open, so exports default to its
 * folder.
 *
 * Pass the `File` that was picked, dropped or handed over. A file that never
 * came off the disk — a recent replayed from IndexedDB, the example PDF, the
 * output of a conversion, or the bytes of an OS-opened document — says nothing
 * and leaves the last known folder standing, which is what the user was working
 * in and a better guess than the downloads pile.
 */
export function rememberOpenFolder(file: File | null): void {
  try {
    window.desktop?.rememberOpenedFile?.(file)
  } catch {
    // The bridge is best-effort: a save dialog opening in the wrong folder is
    // a nuisance, and never a reason to fail an open.
  }
}
