const { app, BrowserWindow, dialog, ipcMain, screen, session, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const defaultApp = require('./defaultApp.cjs')
const previewPane = require('./previewPane.cjs')
const libreOffice = require('./libreOffice.cjs')
const downloads = require('./downloads.cjs')
const { installHubHandoff } = require('@unisim/sdk/electron')

// Set by `npm run electron:dev` to load the live Vite dev server. When unset
// (the packaged app), we load the built bundle from disk over `file://`.
const DEV_SERVER_URL = process.env.ELECTRON_START_URL

// ⚠️ NOT the same string as the page's <title>, deliberately. The web build's
// title is its search-result headline ("open source, browser-based PDF editor")
// — right for Google, wrong for a title bar, where nobody needs to be told what
// kind of app the window they are looking at is.
const WINDOW_TITLE = 'Universal PDF: Welcome to PDFs that just work.'

let mainWindow = null

// Whether mainWindow's renderer has finished loading. `webContents.send` before
// that point goes nowhere — the preload's buffer only covers the gap between
// preload and React, not the gap before preload runs — so anything arriving
// earlier waits in `pendingPdfPath` instead of being fired into the void.
let windowLoaded = false

// PDF the app was launched with (double-click / "Open with → Universal PDF"),
// held until the window has finished loading.
let pendingPdfPath = null

// Folder the open document came off the disk from, or null when it did not come
// off the disk at all. Every save dialog starts here.
//
// Someone who opened a contract out of a client folder is saving the signed
// copy back beside it — not into the same pile as every browser download they
// have ever made, which is where Electron's own default (~/Downloads) puts it.
//
// Fed from both directions: a document handed over by the OS, whose path this
// process already has, and one picked or dropped in the page, whose path only
// the preload can resolve (`webUtils.getPathForFile`).
//
// A document that never came off the disk — a recent replayed from storage, a
// converted file, the example PDF — leaves this ALONE rather than clearing it.
// It is the last folder the user actually chose a document from, which is the
// same "remember where I was working" every desktop app keeps, and a better
// guess than falling back to ~/Downloads mid-session.
let lastOpenFolder = null

function rememberOpenFolder(filePath) {
  if (!filePath) return
  try {
    const folder = path.dirname(filePath)
    // Checked, because a folder that has since been unplugged or deleted (a
    // document opened off a USB stick, then pulled out) would open the dialog
    // on nothing at all. A path we cannot see is simply not an answer, and the
    // previous one stands.
    if (fs.existsSync(folder)) lastOpenFolder = folder
  } catch {
    // Unreadable path — keep whatever we had.
  }
}

// `name` placed in the open document's folder. Falls back to the bare filename,
// which is Electron's cue to use its own default folder.
function suggestedSavePath(name) {
  const base = path.basename(String(name || 'document.pdf'))
  return lastOpenFolder ? path.join(lastOpenFolder, base) : base
}

// Whether the open document has amendments that no saved file contains. Owned
// by the renderer — it is the only side that knows what is on the page — and
// pushed here over `unsaved:set` whenever the answer changes.
let unsavedChanges = false

// Set when the renderer has answered the question below and the close should
// now go through untouched. Cleared for each new window.
let allowClose = false

// Windows passes the document path as a plain argument after the executable
// (plus the app-dir argument when running unpackaged via `electron .`).
// Chromium switches all start with `-`, so skip those.
function pdfPathFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2)
  const candidate = args.find((a) => !a.startsWith('-') && /\.pdf$/i.test(a))
  if (!candidate) return null
  try {
    return fs.existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

// The renderer is fully sandboxed (no Node access), so the main process reads
// the bytes off disk and ships them over IPC; the preload bridge hands them to
// the React app, which opens them like any other picked/dropped file.
function sendPdf(win, filePath) {
  try {
    const bytes = fs.readFileSync(filePath)
    // Read succeeded, so this folder exists and holds the document now on
    // screen — where its exports should be offered back.
    rememberOpenFolder(filePath)
    win.webContents.send('open-pdf', { name: path.basename(filePath), bytes })
  } catch (err) {
    console.error('Failed to read PDF passed from the OS:', err)
    // The renderer may be sitting on the launch placeholder waiting for exactly
    // this file. Tell it to give up, or it spins forever on a file that is
    // never coming.
    win.webContents.send('no-pdf', { unreadable: path.basename(filePath) })
  }
}

// Hand a PDF to the window if it can receive one, and hold it otherwise.
// `did-finish-load` flushes whatever is held.
function deliverPdf(filePath) {
  if (mainWindow && windowLoaded) sendPdf(mainWindow, filePath)
  else pendingPdfPath = filePath
}

// Bring the existing window back in front of whatever the user is looking at.
// `focus()` alone only raises the window WITHIN an app that is already
// frontmost, and an app being handed a document by Finder or Explorer usually
// is not — so the app itself has to be raised too.
function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  // macOS only: `steal` is what lets a background app pull itself forward.
  if (process.platform === 'darwin') app.focus({ steal: true })
}

// A document handed over by the OS — double-click, "Open with → Universal PDF",
// or a second launch on Windows/Linux.
//
// ⚠️ The window has to be CREATED here when there is none, and that is not
// an edge case: macOS keeps an app running after its last window closes (see
// `window-all-closed`), so "running, no window" is the ordinary state of a
// Universal PDF that has been used once already. Handing the document to
// `deliverPdf` and stopping there parked it in `pendingPdfPath` while NOTHING
// appeared on screen — the app was frontmost, the menu bar said so, and the
// document only surfaced when a Dock click happened to run `activate` and
// build the window that flushed it.
function openFromOs(filePath) {
  if (filePath) deliverPdf(filePath)
  // Before `ready` there is no window to make; `whenReady` is moments away and
  // createWindow() picks `pendingPdfPath` up on its own.
  if (!app.isReady()) return
  if (mainWindow && !mainWindow.isDestroyed()) revealMainWindow()
  else createWindow()
}

function createWindow() {
  // Fill the display's full working height (screen minus taskbar) on launch —
  // PDFs are portrait documents, so vertical space is what matters. Width
  // stays at the comfortable 1280 default (clamped to the work area on small
  // screens). y pins the window to the top of the work area so the full
  // height is actually visible.
  const { workArea } = screen.getPrimaryDisplay()
  // Launched by double-clicking a PDF? The renderer needs to know at its FIRST
  // paint, because the file itself cannot arrive until the bundle has loaded.
  // Without this the app paints the landing page, then throws it away a beat
  // later when the document lands — the front door flashing past on the way to
  // a document the user already chose.
  const launching = !!pendingPdfPath
  const win = new BrowserWindow({
    width: Math.min(1280, workArea.width),
    height: workArea.height,
    y: workArea.y,
    minWidth: 640,
    minHeight: 480,
    title: WINDOW_TITLE,
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    // Hold the window back until there is something to look at, rather than
    // showing an empty frame while the bundle boots.
    show: false,
    webPreferences: {
      // The renderer needs no Node or Electron APIs — keep it sandboxed. The
      // preload script only bridges OS-opened PDFs (bytes + name) into the page.
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // A loaded page's <title> replaces the window title unless this is stopped,
  // so `title` above would last only until the bundle finished loading.
  win.on('page-title-updated', (event) => event.preventDefault())

  mainWindow = win
  windowLoaded = false
  allowClose = false

  // ⚠️ The window's × is held here, in the main process, and NOT by the page's
  // `beforeunload`: Electron shows no dialog for that event, it merely refuses
  // the close — so a renderer using it would make the × look broken. Instead
  // the close is cancelled once, the renderer is asked, and its answer comes
  // back as `unsaved:allow-close`.
  //
  // This covers ⌘Q / Alt+F4 as well: quitting closes the window, and a
  // cancelled window close cancels the quit with it.
  win.on('close', (event) => {
    if (allowClose || !unsavedChanges) return
    event.preventDefault()
    win.webContents.send('unsaved:close-request', {})
  })

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
      windowLoaded = false
      // Whatever was unsaved went with the window; a second window would
      // otherwise inherit a stale "yes" and refuse to close.
      unsavedChanges = false
    }
  })

  // `ready-to-show` is the right moment; `did-finish-load` is the belt-and-
  // braces one, so a page that somehow never reaches first paint still leaves
  // the user with a window rather than nothing at all.
  const reveal = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }
  win.once('ready-to-show', reveal)

  // Deliver the launch file once the bundle is loaded; the preload bridge
  // buffers it if React hasn't subscribed yet.
  win.webContents.on('did-finish-load', () => {
    windowLoaded = true
    reveal()
    if (pendingPdfPath) {
      const filePath = pendingPdfPath
      pendingPdfPath = null
      sendPdf(win, filePath)
    } else {
      // Nothing inbound. Said out loud rather than left to a timeout, because
      // this also covers a manual reload (⌘R) of a window that was started with
      // `launching` set: the flag survives the reload, the file does not, and
      // the renderer would otherwise wait on it forever.
      win.webContents.send('no-pdf', {})
    }
  })

  if (DEV_SERVER_URL) {
    const devUrl = new URL(DEV_SERVER_URL)
    if (launching) devUrl.searchParams.set('launching', '1')
    win.loadURL(devUrl.toString())
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(
      path.join(__dirname, '..', 'dist', 'index.html'),
      launching ? { query: { launching: '1' } } : undefined
    )
  }

  // External links (e.g. the UNI SIM navbar) open in the system browser rather
  // than inside the app window.
  // mailto:/tel: are here because a PDF's own link annotations can carry them
  // (see LinkLayer) and they arrive through this handler as target=_blank. Left
  // to 'allow' they would open an empty BrowserWindow on a scheme Chromium
  // can't render; handed to the OS they open the mail/phone app, which is what
  // the same link does in a browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith('http://') || url.startsWith('https://') ||
      url.startsWith('mailto:') || url.startsWith('tel:')
    ) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // setWindowOpenHandler only covers window.open/target=_blank. Plain <a href>
  // clicks (e.g. the suite-switcher rows) navigate the window itself, which
  // would replace the app with the remote site — send those to the system
  // browser too. The packaged app is a local file:// bundle, so any http(s)
  // navigation is external — except the dev server's own origin in dev mode.
  win.webContents.on('will-navigate', (event, url) => {
    if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
}

// Opening a PDF while the app is already running must reuse the existing
// window (Windows/Linux launch a second process for it — forward the argv
// and quit the newcomer).
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  pendingPdfPath = pdfPathFromArgv(process.argv)

  app.on('second-instance', (_event, argv) => {
    openFromOs(pdfPathFromArgv(argv))
  })

  // macOS delivers OS-opened files as an event (possibly before `ready`).
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    openFromOs(filePath)
  })

  // Whether this app owns .pdf on the machine, and the attempt to make it so.
  // Both live in the main process because every route to the answer is an OS
  // call (Launch Services, xdg-mime, the registry) that a sandboxed renderer
  // has no way to reach.
  // The unsaved-changes guard's two halves — see `win.on('close')` above.
  // The page reporting which file it just opened — see `lastOpenFolder`. A
  // send, not an invoke: nothing waits on the answer, and an open must never
  // be held up by bookkeeping about where a later save might go.
  ipcMain.on('open-folder:set', (_event, filePath) => {
    rememberOpenFolder(typeof filePath === 'string' ? filePath : null)
  })

  ipcMain.on('unsaved:set', (_event, dirty) => {
    unsavedChanges = !!dirty
  })
  ipcMain.on('unsaved:allow-close', () => {
    allowClose = true
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  })

  // "Save and exit" — the renderer builds the PDF, the main process owns the
  // Save dialog and the write. A cancelled dialog is reported as such rather
  // than as an error: it means "I have changed my mind about leaving".
  ipcMain.handle('save-pdf', async (_event, payload) => {
    const bytes = payload && payload.bytes
    if (!bytes) return { ok: false, error: 'There was nothing to save.' }
    const suggestedName =
      payload && typeof payload.suggestedName === 'string' ? payload.suggestedName : 'document.pdf'
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow ?? undefined, {
        title: 'Save PDF',
        // Beside the document that was opened, not in ~/Downloads — see
        // `lastOpenFolder`.
        defaultPath: suggestedSavePath(suggestedName),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (canceled || !filePath) return { ok: false, cancelled: true }
      await fs.promises.writeFile(filePath, Buffer.from(bytes))
      return { ok: true, path: filePath }
    } catch (err) {
      console.error('Failed to save the PDF:', err)
      return { ok: false, error: err.message || 'The PDF could not be written.' }
    }
  })

  // A Word/OpenDocument file converted by LibreOffice, when the machine happens
  // to have it. The renderer asks first (`status`) so it only sends the bytes
  // when there is something to send them to, and treats every failure as "use
  // the built-in converter" — see electron/libreOffice.cjs.
  ipcMain.handle('libreoffice:status', () => libreOffice.status())
  ipcMain.handle('libreoffice:convert', async (_event, payload) => {
    const bytes = payload && payload.bytes
    if (!bytes) return { ok: false, reason: 'no-input' }
    const res = await libreOffice.convert(bytes, payload.fileName)
    // Buffer does not survive the IPC boundary as a Buffer; hand back a plain
    // Uint8Array the renderer can put straight into a File.
    return res.ok ? { ok: true, bytes: new Uint8Array(res.bytes), version: res.version } : res
  })

  ipcMain.handle('default-app:status', () => defaultApp.status())

  ipcMain.handle('default-app:set', () => defaultApp.makeDefault())

  // The Explorer preview pane. Its last registry key is machine-wide, so
  // turning it on raises an administrator prompt — see electron/previewPane.cjs.
  ipcMain.handle('preview-pane:status', () => previewPane.status())
  ipcMain.handle('preview-pane:set', (_event, enable) => previewPane.setEnabled(!!enable))

  app.whenReady().then(() => {
    // Hub pages (profile, account settings) open in a window this app owns,
    // signed in as the current user. Without it every hub link lands in the
    // system browser as a stranger — the desktop app's session lives here and
    // nowhere else.
    installHubHandoff({ icon: path.join(__dirname, '..', 'public', 'icon-512.png') })
    // Every export the page hands out — the Export dialog, a compressed copy,
    // a converted document — leaves the renderer as an ordinary browser
    // download, because that is the one path that also works in the web build.
    // Electron answers those with a Save dialog rooted in ~/Downloads; this
    // moves it to the open document's folder instead, in one place, without
    // every export button needing to know it is running on a desktop.
    //
    // ⚠️ Registered on the shared default session at `ready`, NOT per window:
    // closing and reopening a window (the ordinary state of things on macOS)
    // would otherwise stack a second listener on the same session for every
    // window ever built.
    //
    // The dialog is OURS rather than Chromium's, because Chromium's writes the
    // part-downloaded file into the destination folder as it goes — and now
    // that the destination is the open document's own folder, that is a
    // scratch file appearing next to the user's PDF. electron/downloads.cjs
    // stages every download in AppData and moves it in when it is whole;
    // `suggestedSavePath` still decides where the dialog opens.
    downloads.installAll(session.defaultSession, suggestedSavePath)
    // Guarded, because `open-file` can arrive before this runs and builds the
    // window itself — an unguarded call would answer one document with two
    // windows.
    if (!mainWindow) createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
