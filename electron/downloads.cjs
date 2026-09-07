// Every download the renderer starts, written somewhere safe first.
//
// The renderer is sandboxed, so anything it hands the user — an export, a
// converted document, a QR image — leaves through an `<a download>` and lands
// in Chromium's download pipeline (see src/lib/saveFile.ts). Left to itself
// that pipeline picks the destination folder AND writes into it while the
// download is still in progress, which is how a half-written file with a name
// nobody chose ends up sitting next to the user's PDF.
//
// So the file is staged in this app's own AppData folder and only moved to the
// destination once it is whole. The destination folder sees one atomic arrival
// and nothing else — no partial file, no leftover if the write fails halfway.
//
// ⚠️ `setSavePath` has to be called SYNCHRONOUSLY inside `will-download`.
// Miss that turn of the loop and Chromium falls back to its own routine —
// which raises a save dialog of its own and writes straight into whatever
// folder it lands on, i.e. exactly the behaviour this file exists to prevent.
// That is why the staging path is set first and the user is asked afterwards.

const { app, dialog, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

/** Sessions already wired up — `install` is called from more than one place. */
const wired = new WeakSet()

/**
 * Where part-written downloads live: inside this app's own userData, which is
 * `%APPDATA%\Universal PDF` on Windows and the equivalent elsewhere. Deliberately
 * NOT `os.tmpdir()` — a cleaner emptying the system temp folder mid-download
 * would take the file with it.
 */
function stagingDir() {
  return path.join(app.getPath('userData'), 'downloads-staging')
}

/** A staged name that cannot collide, keeping the real extension for clarity. */
function stagePathFor(filename) {
  const ext = path.extname(filename || '') || ''
  const stem = path.basename(filename || 'download', ext).slice(0, 60) || 'download'
  return path.join(stagingDir(), `${stem}-${crypto.randomUUID()}${ext}`)
}

/**
 * Anything left behind by a crash or a power cut. Best-effort and non-blocking:
 * a staging folder that cannot be tidied is not a reason to fail a download.
 */
async function sweep() {
  try {
    const dir = stagingDir()
    const entries = await fs.promises.readdir(dir)
    await Promise.all(
      entries.map((name) => fs.promises.rm(path.join(dir, name), { force: true }).catch(() => {})),
    )
  } catch {
    // No staging folder yet — nothing to sweep.
  }
}

/** The Save dialog's file-type filter, worked out from the suggested name. */
function filtersFor(filename) {
  const ext = path.extname(filename || '').replace(/^\./, '').toLowerCase()
  const names = {
    pdf: 'PDF',
    png: 'PNG image',
    jpg: 'JPEG image',
    jpeg: 'JPEG image',
    webp: 'WebP image',
    txt: 'Text file',
    docx: 'Word document',
    zip: 'Zip archive',
  }
  const known = ext ? [{ name: names[ext] ?? `${ext.toUpperCase()} file`, extensions: [ext] }] : []
  return [...known, { name: 'All files', extensions: ['*'] }]
}

/**
 * Staged file → where the user asked for it. `rename` is the atomic move, but
 * it only works within one volume: userData is on the system drive and the
 * destination very often is not, so the copy is not a nicety.
 */
async function moveInto(stagePath, destination) {
  try {
    await fs.promises.rename(stagePath, destination)
  } catch (err) {
    if (err && err.code !== 'EXDEV') throw err
    await fs.promises.copyFile(stagePath, destination)
    await fs.promises.rm(stagePath, { force: true }).catch(() => {})
  }
}

/**
 * Where the Save dialog opens — the main process's `suggestedSavePath`, which
 * puts it in the open document's own folder. Held here rather than passed
 * around because `session-created` gives us a session and nothing else.
 */
let suggestPath = (name) => name

/**
 * Route one session's downloads through staging. Idempotent, so it is safe to
 * call for the default session and again for any session created later.
 */
function install(session) {
  if (!session || wired.has(session)) return
  wired.add(session)

  session.on('will-download', (_event, item, webContents) => {
    const suggested = item.getFilename() || 'download'

    // ⚠️ Synchronous, before anything that can yield — see the note at the top.
    let stagePath
    try {
      fs.mkdirSync(stagingDir(), { recursive: true })
      stagePath = stagePathFor(suggested)
      item.setSavePath(stagePath)
    } catch (err) {
      console.error('Could not stage the download; letting Chromium handle it:', err)
      return
    }

    // Asking runs alongside the download rather than before it. The file is
    // going somewhere harmless either way, so there is nothing to wait for.
    const parent = BrowserWindow.fromWebContents(webContents) ?? undefined
    const asked = dialog
      .showSaveDialog(parent, {
        title: 'Save file',
        defaultPath: suggestPath(suggested),
        filters: filtersFor(suggested),
      })
      .catch((err) => {
        console.error('The Save dialog failed:', err)
        return { canceled: true }
      })

    item.once('done', async (_doneEvent, state) => {
      const { canceled, filePath } = await asked
      const discard = () => fs.promises.rm(stagePath, { force: true }).catch(() => {})

      // A cancelled dialog is the user saying "not after all" — the staged copy
      // is the only trace and it goes away with it.
      if (canceled || !filePath) return discard()
      if (state !== 'completed') {
        await discard()
        dialog.showErrorBox('The file could not be saved', `“${suggested}” did not finish downloading.`)
        return
      }

      try {
        await moveInto(stagePath, filePath)
      } catch (err) {
        console.error('Could not move the finished download into place:', err)
        await discard()
        dialog.showErrorBox(
          'The file could not be saved',
          `“${suggested}” could not be written to ${path.dirname(filePath)}.`,
        )
      }
    })

    // The user cancelling the dialog while a long download is still running
    // should stop it, not finish it into a file about to be deleted.
    asked.then(({ canceled }) => {
      if (canceled && item.getState() === 'progressing') item.cancel()
    })
  })
}

/**
 * Wire the default session and every session made after this point.
 * `suggestedPath` turns a filename into the path the dialog should open on.
 */
function installAll(defaultSession, suggestedPath) {
  if (typeof suggestedPath === 'function') suggestPath = suggestedPath
  sweep()
  install(defaultSession)
  app.on('session-created', install)
}

module.exports = { installAll, install, stagingDir }
