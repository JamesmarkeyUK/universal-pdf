const { contextBridge, ipcRenderer, webUtils } = require('electron')

// PDFs opened via the OS (double-click / "Open with → Universal PDF") are read
// by the main process and pushed here over IPC. The React app subscribes after
// mount, which can be after the launch file has already arrived — buffer any
// early payloads and replay them on subscribe so the file is never dropped.
//
// `no-pdf` is the same message in the negative: this page load is not getting a
// file. It matters because the app renders a placeholder instead of the landing
// page when it was started with a document to open, and a placeholder needs an
// end whether or not the document turns up.
function channel(name) {
  let handler = null
  const buffered = []

  ipcRenderer.on(name, (_event, payload) => {
    if (handler) handler(payload)
    else buffered.push(payload)
  })

  // Returns an unsubscribe function (matches the addEventListener-style
  // cleanup the app's useEffect hooks expect).
  return function subscribe(cb) {
    handler = cb
    for (const payload of buffered.splice(0)) cb(payload)
    return () => {
      if (handler === cb) handler = null
    }
  }
}

// Hub links (View profile, App settings) opened in an app-owned window with
// this app's session installed for the hub's origin — otherwise Electron hands
// them to the system browser, which has never seen the session and shows a
// signed-out page. The main process does the work; see @unisim/sdk/electron.
//
// ⚠️ Spelled out rather than required from the SDK on purpose: Electron
// sandboxes preloads, and a sandboxed `require` resolves only a few built-ins
// — requiring the package here would throw at load and take the bridge with
// it. The channel names are the SDK's `PRELOAD_SNIPPET`; keep them in step.
contextBridge.exposeInMainWorld('unisimDesktop', {
  openHub: (url, session) => ipcRenderer.invoke('unisim:open-hub', { url, session }),
  clearHub: () => ipcRenderer.invoke('unisim:clear-hub'),
})

contextBridge.exposeInMainWorld('desktop', {
  onOpenPdf: channel('open-pdf'),
  onNoPdf: channel('no-pdf'),
  // "Save and exit" writes a real file, so the bytes cross to the main process
  // — a sandboxed renderer has no filesystem and a browser download would put
  // the PDF in ~/Downloads without ever asking where it should go.
  savePdf: (suggestedName, bytes) => ipcRenderer.invoke('save-pdf', { suggestedName, bytes }),
  // Where the document now open came from, so saving it starts in that folder
  // instead of ~/Downloads.
  //
  // ⚠️ This has to happen HERE and not in the page: the renderer is sandboxed
  // and since Electron 32 a `File` carries no `.path` at all, so
  // `webUtils.getPathForFile` — a preload-only API — is the only thing left
  // that can turn the File the user picked back into a path on disk.
  //
  // ⚠️ A File that was never on disk answers with an empty string, and that
  // says NOTHING and is not reported. It has to work that way: a PDF handed
  // over by the OS reaches the page as bytes, which the page turns into a
  // synthetic File — so a pathless file here is routinely the very document
  // whose folder the main process has just learnt the hard way, and reporting
  // it would erase the answer a beat after finding it.
  rememberOpenedFile: (file) => {
    let filePath = null
    try {
      if (file) filePath = webUtils?.getPathForFile?.(file) || null
    } catch {
      filePath = null
    }
    if (filePath) ipcRenderer.send('open-folder:set', filePath)
  },
  // Unsaved-changes guard. `set` keeps the main process told whether closing
  // the window would lose a file; `onCloseRequest` is main asking the question
  // it holds the × for; `allowClose` is the answer that lets it through.
  unsaved: {
    set: (dirty) => ipcRenderer.send('unsaved:set', !!dirty),
    onCloseRequest: channel('unsaved:close-request'),
    allowClose: () => ipcRenderer.send('unsaved:allow-close'),
  },
  // Whether this app is the system's default .pdf handler, and the request to
  // become it. Request-response rather than a pushed event: the app asks when
  // it has somewhere to put the answer.
  defaultApp: {
    status: () => ipcRenderer.invoke('default-app:status'),
    makeDefault: () => ipcRenderer.invoke('default-app:set'),
  },
  // Convert a Word / OpenDocument file with the user's own LibreOffice, giving
  // a faithful copy of Word's layout instead of the built-in re-typeset one.
  // `status` is cheap and cached in main; `convert` is not, so ask first.
  libreOffice: {
    status: () => ipcRenderer.invoke('libreoffice:status'),
    convert: (fileName, bytes) => ipcRenderer.invoke('libreoffice:convert', { fileName, bytes }),
  },
  // Whether PDFs show in Explorer's preview pane, and turning it on or off.
  // ⚠️ `set` raises a Windows administrator prompt: the key that makes a
  // preview handler visible to the shell is machine-wide.
  previewPane: {
    status: () => ipcRenderer.invoke('preview-pane:status'),
    set: (enable) => ipcRenderer.invoke('preview-pane:set', !!enable),
  },
})
