// Where the desktop app's Save dialog opens.
//
//   ./scripts/preview.sh             # in one terminal (Universal PDF is :5174)
//   npm run test:save-folder:desktop # in another
//
// ⚠️ The complaint this exists to answer: a PDF opened from a folder on the
// machine offered to save back into ~/Downloads, so every edited document had
// to be dragged home by hand. The dialog should open where the document came
// from.
//
// ⚠️ And the trap underneath it, which is the reason for the third check. A PDF
// handed over by the OS is read in the MAIN process and reaches the page as
// bytes, which the page turns into a synthetic `File`. That File has no path —
// so a bridge that reported "this file has no folder" as "forget the folder"
// would erase, one beat later, the very answer the main process had just been
// handed. The dialog would then open in ~/Downloads for the one case the
// feature exists for: double-clicking a PDF in Explorer or Finder.
//
// The OS dialog itself is never shown here. `dialog.showSaveDialog` is replaced
// in the main process with a recorder, which is where the claim actually lives:
// what matters is the `defaultPath` we hand Electron, not what the OS then
// draws with it.

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174/'
const FIXTURE = join(HERE, 'fixtures', 'sample.pdf')
const FIXTURE_DIR = join(HERE, 'fixtures')

const PLAYWRIGHT_CANDIDATES = [
  '../../Universal_Beam/node_modules/playwright/index.js',
  '../../Universal_Exports/node_modules/playwright/index.js',
  '../../Universal_Video/node_modules/playwright/index.js',
  '../../../UNI_SIM_Assess/Ergo_Assess/frontend/node_modules/playwright/index.js',
  '../node_modules/playwright/index.js'
]

async function loadPlaywright() {
  for (const rel of PLAYWRIGHT_CANDIDATES) {
    try {
      const mod = await import(pathToFileURL(join(HERE, rel)).href)
      if (mod.default?._electron) return mod.default
    } catch {
      continue
    }
  }
  console.error('No usable Playwright found — see e2e/office-import.e2e.mjs for the candidate list.')
  process.exit(2)
}

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

const playwright = await loadPlaywright()

try {
  const res = await fetch(BASE)
  if (!res.ok) throw new Error(String(res.status))
} catch {
  console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
  process.exit(2)
}

// A copy in a folder of its own, so "the folder the dialog opened in" can only
// have come from this document and not from the repo the app is running out of.
const PICKED_DIR = mkdtempSync(join(tmpdir(), 'upt-save-folder-'))
const PICKED = join(PICKED_DIR, 'picked.pdf')
copyFileSync(FIXTURE, PICKED)

// ⚠️ ELECTRON_RUN_AS_NODE must not survive into the child — see
// exit-guard-desktop.e2e.mjs, where the same trap is spelled out.
const env = { ...process.env, ELECTRON_START_URL: BASE }
delete env.ELECTRON_RUN_AS_NODE

const ELECTRON_BIN = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  readFileSync(join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
)

// ⚠️ NOT `firstWindow()`: dev mode opens DevTools detached and that window turns
// up first as often as not.
async function appWindow(app, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const win = app.windows().find((w) => w.url().startsWith('http'))
    if (win) {
      await win.waitForLoadState('domcontentloaded')
      return win
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

const app = await playwright._electron.launch({
  executablePath: ELECTRON_BIN,
  args: [ROOT],
  cwd: ROOT,
  env
})

// The Save dialog, replaced by a recorder. Every save from here on is answered
// as "cancelled", which is a normal outcome the app already handles — so
// nothing is written and no OS dialog is left waiting for a human.
async function stubSaveDialog() {
  await app.evaluate(({ dialog }) => {
    globalThis.__savePaths = []
    dialog.showSaveDialog = async (...args) => {
      const options = args[args.length - 1]
      globalThis.__savePaths.push(options && options.defaultPath)
      return { canceled: true }
    }
  })
}

// Ask the page to save, and report the `defaultPath` the main process chose.
async function defaultPathForSave(win, name) {
  await app.evaluate(() => {
    globalThis.__savePaths = []
  })
  await win.evaluate(
    (fileName) => window.desktop.savePdf(fileName, new Uint8Array([37, 80, 68, 70])),
    name
  )
  return app.evaluate(() => globalThis.__savePaths[0] ?? null)
}

// The name of the document the store currently has open — how we know a load
// has actually landed before asking where it would save to.
async function openFileName(win, expected, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout
  let name = null
  while (Date.now() < deadline) {
    name = await win.evaluate(async () => {
      const { usePdfStore } = await import('/src/stores/pdfStore.ts')
      return usePdfStore.getState().fileName
    })
    if (name === expected) return name
    await new Promise((r) => setTimeout(r, 200))
  }
  return name
}

try {
  const win = await appWindow(app)
  if (!win) throw new Error('the app opened no window')
  await stubSaveDialog()

  console.log('Nothing has been opened off the disk yet')
  const bare = await defaultPathForSave(win, 'untitled.pdf')
  check(
    'the dialog is left to Electron — a bare name, no folder of ours',
    bare === 'untitled.pdf',
    `defaultPath was ${JSON.stringify(bare)}`
  )

  console.log('\nA PDF is picked in the page, from a folder of its own')
  // The landing page's own drop/browse input — `accept` carries the Office
  // types, which is what tells it apart from the single-purpose PDF inputs
  // (compress, OCR, redact) elsewhere on the page.
  await win.setInputFiles('input[type=file][accept*=".docx"]', PICKED)
  const pickedName = await openFileName(win, 'picked.pdf')
  check('the picked document opens', pickedName === 'picked.pdf', `opened ${pickedName}`)

  const pickedSave = await defaultPathForSave(win, 'picked-1.pdf')
  check(
    'the dialog opens in the folder it was picked from',
    pickedSave === join(PICKED_DIR, 'picked-1.pdf'),
    `defaultPath was ${JSON.stringify(pickedSave)}`
  )

  console.log('\nThe OS hands a PDF over (double-click / "Open with")')
  await app.evaluate(({ app: electronApp }, filePath) => {
    // Exactly the shape Electron delivers: a preventable event and a path.
    electronApp.emit('open-file', { preventDefault() {} }, filePath)
  }, FIXTURE)
  const osName = await openFileName(win, 'sample.pdf')
  check('the handed-over document opens', osName === 'sample.pdf', `opened ${osName}`)

  const osSave = await defaultPathForSave(win, 'sample-1.pdf')
  check(
    'the dialog follows it there, and the pathless bytes have not wiped the folder',
    osSave === join(FIXTURE_DIR, 'sample-1.pdf'),
    `defaultPath was ${JSON.stringify(osSave)}`
  )

  console.log('\nAn export leaves the page as an ordinary download')
  // A download's dialog is the app's own `dialog.showSaveDialog`, not
  // Chromium's — Chromium's cannot be asked where it opened, and it writes the
  // part-downloaded file into the destination folder while it runs, which is a
  // scratch file appearing beside the user's PDF (see electron/downloads.cjs).
  // So the recorder above is what answers this one, and answering "cancelled"
  // is what keeps a real dialog off the screen.
  await app.evaluate(() => {
    globalThis.__savePaths = []
  })
  await win.evaluate(() => {
    const blob = new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'exported.pdf'
    document.body.appendChild(a)
    a.click()
    a.remove()
  })
  let downloadPath = null
  for (let i = 0; i < 100 && downloadPath == null; i++) {
    downloadPath = await app.evaluate(() => globalThis.__savePaths[0] ?? null)
    if (downloadPath == null) await new Promise((r) => setTimeout(r, 200))
  }
  check(
    'and it too is offered beside the open document, not in ~/Downloads',
    downloadPath === join(FIXTURE_DIR, 'exported.pdf'),
    `defaultPath was ${JSON.stringify(downloadPath)}`
  )
} finally {
  await app.close().catch(() => {})
  rmSync(PICKED_DIR, { recursive: true, force: true })
}

console.log(failures.length ? `\n${failures.length} failed.` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
