// Nothing half-written ever appears in the folder the user saves into.
//
//   ./scripts/preview.sh                # in one terminal (Universal PDF is :5174)
//   npm run test:download-staging:desktop  # in another
//
// ⚠️ The complaint this exists to answer: a scratch file turning up in the
// folder the PDF lives in. It is Chromium's, not ours — a download writes into
// its destination folder AS IT ARRIVES, so a part-written file sits there for
// as long as the download takes, and stays for good if it is interrupted. That
// went unnoticed while downloads landed in ~/Downloads; it became visible the
// moment the save dialog started opening in the open document's own folder.
//
// So the download is staged in AppData and moved in only once it is whole (see
// electron/downloads.cjs), and this proves the destination folder sees nothing
// until then. Run against the pre-fix behaviour — a `setSavePath` straight to
// the destination — the mid-download check finds a 14 MB fragment of a 40 MB
// file sitting next to the document, which is the bug.
//
// The 40 MB is deliberate and so is the trickle: the claim is about what is on
// disk WHILE a download runs, and an export that finishes instantly cannot be
// caught in the act.
//
// ⚠️ The download is started with `webContents.downloadURL` rather than a click
// on an `<a download>`. The app sends off-origin URLs to the system browser, so
// a link to the test's own server leaves the app entirely and downloads nothing.

import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174/'

const TOTAL_MB = 40
const CHUNK_MS = 200

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

// A download slow enough to be inspected while it is happening.
const server = createServer((_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="big.pdf"',
    'Content-Length': String(TOTAL_MB * 1024 * 1024)
  })
  let sent = 0
  const chunk = Buffer.alloc(1024 * 1024)
  const tick = setInterval(() => {
    if (sent >= TOTAL_MB) {
      clearInterval(tick)
      res.end()
      return
    }
    res.write(chunk)
    sent++
  }, CHUNK_MS)
  res.on('close', () => clearInterval(tick))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const downloadUrl = `http://127.0.0.1:${server.address().port}/big.pdf`

// ⚠️ ELECTRON_RUN_AS_NODE must not survive into the child: npm sets it in some
// shells and it turns the Electron binary into a plain Node, so the launch
// hangs waiting for a window that will never exist.
const env = { ...process.env, ELECTRON_START_URL: BASE }
delete env.ELECTRON_RUN_AS_NODE

// ⚠️ Playwright resolves `electron` from ITS own install, which is a sibling
// repo's — so the binary is named explicitly out of this project's.
const ELECTRON_BIN = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  readFileSync(join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
)

// ⚠️ Universal PDF holds a single-instance lock, and it is keyed on the user
// data folder. Share that folder with a copy of the app someone has open — or
// with another desktop spec — and this launch quits on the spot: no window, no
// error worth the name, and a `launch` that rejects with "target closed". Its
// own folder makes the test independent of what else is running.
//
// The folder is also where the download staging lives, so it is what the
// checks below read. On a real install it is `%APPDATA%\Universal PDF` (and the
// platform equivalents) — see `app.getPath('userData')` in electron/downloads.cjs.
const userDataDir = mkdtempSync(join(tmpdir(), 'unipdf-userdata-'))

const app = await playwright._electron
  .launch({
    executablePath: ELECTRON_BIN,
    args: [ROOT, `--user-data-dir=${userDataDir}`],
    cwd: ROOT,
    env
  })
  .catch((err) => {
    // If it still cannot start, that is the environment rather than the claim.
    console.error(`Could not launch the app: ${err.message}`)
    process.exit(2)
  })

const destDir = mkdtempSync(join(tmpdir(), 'unipdf-dest-'))

try {
  // ⚠️ NOT `firstWindow()` — in dev mode a detached DevTools window turns up
  // first as often as not.
  let win = null
  for (let i = 0; i < 50 && !win; i++) {
    try {
      win = app.windows().find((w) => w.url().startsWith('http')) ?? null
    } catch {
      break // the app has already gone — the lock case below
    }
    if (!win) await new Promise((r) => setTimeout(r, 200))
  }
  if (!win) {
    console.error('The app window never appeared — is another Universal PDF already running?')
    process.exit(2)
  }
  await win.waitForLoadState('domcontentloaded')

  // Asked of the app rather than guessed: userData is a different folder on
  // every platform, and a test that guessed it wrong would pass by looking in
  // a folder that is empty for the wrong reason.
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const stagingDir = join(userData, 'downloads-staging')

  /** The Save dialog, answered without a human. */
  async function answerSaveDialog(filePath) {
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = async () =>
        p ? { canceled: false, filePath: p } : { canceled: true, filePath: undefined }
    }, filePath)
  }

  function startDownload(url) {
    return app.evaluate(({ BrowserWindow }, u) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('http'))
      w.webContents.downloadURL(u)
    }, url)
  }

  const listing = (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }

  // ── 1. a download in flight is nowhere near the destination folder ────────
  console.log('\nWhile the download is running')
  const destPath = join(destDir, 'big.pdf')
  await answerSaveDialog(destPath)
  await startDownload(downloadUrl)

  // A quarter of the way in: long enough to be unambiguously mid-download,
  // early enough that a 40 MB trickle cannot have finished.
  await new Promise((r) => setTimeout(r, 3000))
  const midDest = listing(destDir)
  const midStage = listing(stagingDir)
  check(
    'the destination folder is untouched',
    midDest.length === 0,
    `found ${JSON.stringify(midDest)}${
      midDest.length ? ` (${statSync(join(destDir, midDest[0])).size} bytes of a file still arriving)` : ''
    }`
  )
  check('and the part-written file is in AppData instead', midStage.length === 1, `staging held ${JSON.stringify(midStage)}`)
  check(
    "which is inside the app's own data folder",
    stagingDir === join(userData, 'downloads-staging') && !stagingDir.startsWith(destDir),
    stagingDir
  )

  // ── 2. it arrives whole, once ─────────────────────────────────────────────
  console.log('\nWhen it finishes')
  let size = 0
  for (let i = 0; i < 120 && size !== TOTAL_MB * 1024 * 1024; i++) {
    size = existsSync(destPath) ? statSync(destPath).size : 0
    if (size !== TOTAL_MB * 1024 * 1024) await new Promise((r) => setTimeout(r, 500))
  }
  check('the file lands in the destination folder', existsSync(destPath))
  check('whole', size === TOTAL_MB * 1024 * 1024, `${size} bytes`)
  check('and it is the only thing there', listing(destDir).length === 1, JSON.stringify(listing(destDir)))
  check('with nothing left staged', listing(stagingDir).length === 0, JSON.stringify(listing(stagingDir)))

  // ── 3. changing your mind leaves nothing behind anywhere ──────────────────
  console.log('\nWhen the Save dialog is cancelled')
  const cancelDir = mkdtempSync(join(tmpdir(), 'unipdf-cancel-'))
  await answerSaveDialog(null)
  await startDownload(downloadUrl)
  await new Promise((r) => setTimeout(r, 4000))
  check('the destination folder stays empty', listing(cancelDir).length === 0, JSON.stringify(listing(cancelDir)))
  check('and the staged copy is cleaned up', listing(stagingDir).length === 0, JSON.stringify(listing(stagingDir)))
} finally {
  await app.close().catch(() => {})
  server.close()
}

console.log(failures.length ? `\n${failures.length} failed.` : '\nAll download-staging checks passed.')
process.exit(failures.length ? 1 : 0)
