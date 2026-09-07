// The unsaved-changes exit guard — browser-level regression check.
//
//   ./scripts/preview.sh      # in one terminal (Universal PDF is :5174)
//   npm run test:exit-guard   # in another
//
// What it pins down is the QUESTION, not the plumbing: a document with
// amendments must not leave the screen without the three-answer popup, the
// popup's answers must each do what they say, and a document with no
// amendments — including one whose marks came back with it from recents — must
// not be asked about at all.
//
// ⚠️ The dirty test compares array IDENTITY, which is exactly the kind of thing
// that keeps working while meaning nothing. So this drives the real UI (the
// Actions menu, the real buttons) and reads `hasUnsavedChanges()` back through
// the app's own module registry rather than trusting either on its own.
//
// This repo has no test runner of its own, so Playwright is borrowed from a
// sibling repo that does — the suite's usual arrangement for a one-file spec.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174/'

// Sibling repos that carry a Playwright install, newest-known first. Same list
// (and the same launch-before-you-commit rule) as office-import.e2e.mjs.
const PLAYWRIGHT_CANDIDATES = [
  '../../Universal_Beam/node_modules/playwright/index.js',
  '../../Universal_Exports/node_modules/playwright/index.js',
  '../../Universal_Video/node_modules/playwright/index.js',
  '../../../UNI_SIM_Assess/Ergo_Assess/frontend/node_modules/playwright/index.js',
  '../node_modules/playwright/index.js'
]

async function loadPlaywright() {
  const problems = []
  for (const rel of PLAYWRIGHT_CANDIDATES) {
    let mod
    try {
      mod = (await import(pathToFileURL(join(HERE, rel)).href)).default
    } catch {
      continue // not installed here
    }
    try {
      const probe = await mod.chromium.launch()
      await probe.close()
      return mod
    } catch (err) {
      problems.push(`  ${rel}\n    ${String(err).split('\n')[0]}`)
    }
  }
  console.error(
    'No usable Playwright found. Candidates that imported but could not launch:\n' +
      (problems.join('\n') || '  (none imported at all)') +
      '\n\nInstall it in a sibling Universal app (e.g. Universal_Beam), or run:\n' +
      '  npm i -D playwright && npx playwright install chromium'
  )
  process.exit(2)
}

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => failures.push('page error: ' + e.message))

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
} catch {
  console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
  await browser.close()
  process.exit(2)
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Open the bundled example PDF through the app's own store. Loading the file
 *  is not what is under test; what happens when you try to leave it is. */
async function openExample() {
  await page.evaluate(async () => {
    const { createExamplePdfFile } = await import('/src/lib/examplePdf.ts')
    const { usePdfStore } = await import('/src/stores/pdfStore.ts')
    await usePdfStore.getState().loadFile(await createExamplePdfFile())
  })
  await page.waitForSelector('canvas', { timeout: 20000 })
}

/** Draw on the document — a plain box, or a redaction when asked for one. */
async function amend(type = 'rect') {
  await page.evaluate(async (kind) => {
    const { useAnnotationStore } = await import('/src/stores/annotationStore.ts')
    const base = { id: 'e2e-' + kind + '-' + Math.random().toString(36).slice(2), pageIndex: 0 }
    useAnnotationStore.getState().add(
      kind === 'redact'
        ? { ...base, type: 'redact', x: 60, y: 60, width: 180, height: 24, fill: 'black' }
        : { ...base, type: 'rect', x: 60, y: 60, width: 180, height: 90, color: '#dc2626' }
    )
  }, type)
}

/** The app's own answer, read out of the module the app itself is using. */
function isDirty() {
  return page.evaluate(async () => {
    const { hasUnsavedChanges } = await import('/src/lib/unsavedChanges.ts')
    return hasUnsavedChanges()
  })
}

function docIsOpen() {
  return page.evaluate(async () => {
    const { usePdfStore } = await import('/src/stores/pdfStore.ts')
    return !!usePdfStore.getState().doc
  })
}

/** Actions pill → File → Close PDF, driven the way a user drives it.
 *
 * ⚠️ HOVER, not click. The SDK's profile pill opens on `mouseenter`, so a
 * Playwright click opens it on the way in and toggles it shut again on the
 * press — the menu never appears and the failure reads as "no such button". */
async function clickClosePdf() {
  await page.getByRole('button', { name: /Actions/ }).first().hover()
  // ⚠️ `exact`, because a substring match on "File" also matches the pill that
  // opens the menu — its label is "Actions · Pro-FILE". Without it Playwright
  // picks the pill, the click toggles the menu shut, and the failure blames
  // "Close PDF" for not existing.
  // ⚠️ The File submenu remembers being open between openings of the menu, and
  // clicking the row TOGGLES it — so a second visit that clicks it again folds
  // the rows away instead of revealing them. Open it only when it is shut.
  const close = page.getByRole('button', { name: 'Close PDF' })
  const fileRow = page.getByRole('button', { name: 'File', exact: true })
  await fileRow.waitFor({ state: 'visible', timeout: 5000 })
  if (!(await close.isVisible().catch(() => false))) await fileRow.click()
  await close.waitFor({ state: 'visible', timeout: 5000 })
  await close.click()
}

const dialog = page.getByRole('dialog', { name: 'Save your changes?' })
const saveAndExit = page.getByRole('button', { name: /Save and exit|Saving/ })
const exitAnyway = page.getByRole('button', { name: 'Exit without saving' })
const cancelButton = dialog.getByRole('button', { name: 'Cancel' })

// ── 1. a document nobody has touched just closes ───────────────────────────
console.log('\nUntouched document')
await openExample()
check('opens', await docIsOpen())
check('is not dirty on arrival', (await isDirty()) === false)
await clickClosePdf()
await page.waitForTimeout(300)
check('no popup', (await dialog.count()) === 0)
check('closed straight away', (await docIsOpen()) === false)

// ── 2. an amended document asks, and Cancel means stay ─────────────────────
console.log('\nAmended document → Cancel')
await openExample()
await amend()
check('dirty after drawing', (await isDirty()) === true)
await clickClosePdf()
await dialog.waitFor({ state: 'visible', timeout: 5000 })
check('popup asks', await dialog.isVisible())
check('offers all three answers', (await saveAndExit.count()) === 1 && (await exitAnyway.count()) === 1 && (await cancelButton.count()) === 1)
check('names the file', (await dialog.innerText()).includes('.pdf'))
await cancelButton.click()
await page.waitForTimeout(200)
check('popup gone', (await dialog.count()) === 0)
check('document still open', await docIsOpen())
check('still dirty', (await isDirty()) === true)

// ── 3. Escape is Cancel ────────────────────────────────────────────────────
console.log('\nEscape')
await clickClosePdf()
await dialog.waitFor({ state: 'visible', timeout: 5000 })
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('popup dismissed', (await dialog.count()) === 0)
check('document still open', await docIsOpen())

// ── 4. Exit without saving leaves, and the marks are still in recents ──────
console.log('\nExit without saving')
await clickClosePdf()
await dialog.waitFor({ state: 'visible', timeout: 5000 })
await exitAnyway.click()
await page.waitForTimeout(400)
check('document closed', (await docIsOpen()) === false)
check('nothing left unsaved', (await isDirty()) === false)

// ── 5. Save and exit writes the file, then leaves ──────────────────────────
console.log('\nSave and exit')
await openExample()
await amend()
await clickClosePdf()
await dialog.waitFor({ state: 'visible', timeout: 5000 })
const downloadPromise = page.waitForEvent('download', { timeout: 20000 })
await saveAndExit.click()
let download = null
try {
  download = await downloadPromise
} catch {
  /* reported by the check below */
}
check('a PDF is downloaded', !!download && /\.pdf$/i.test(download?.suggestedFilename() ?? ''), download?.suggestedFilename())
check('named as the next version', /-v\d+\.pdf$/i.test(download?.suggestedFilename() ?? ''), download?.suggestedFilename())
await page.waitForTimeout(600)
check('document closed after saving', (await docIsOpen()) === false)

// ── 6. a redaction cannot be baked in on the way out without the word ──────
console.log('\nRedaction on the way out')
await openExample()
await amend('redact')
await clickClosePdf()
await dialog.waitFor({ state: 'visible', timeout: 5000 })
check('Save is blocked', await saveAndExit.isDisabled())
check('says what will happen', (await dialog.innerText()).toLowerCase().includes('permanent redaction'))
await dialog.getByPlaceholder('Type REDACT to confirm').fill('nope')
check('a wrong word is still blocked', await saveAndExit.isDisabled())
await dialog.getByPlaceholder('Type REDACT to confirm').fill('redact')
check('the word unblocks it', await saveAndExit.isEnabled())
await cancelButton.click()
await page.waitForTimeout(200)
check('the typed word does not survive the next asking', await (async () => {
  await clickClosePdf()
  await dialog.waitFor({ state: 'visible', timeout: 5000 })
  return saveAndExit.isDisabled()
})())
await cancelButton.click()

// ── 7. exporting is saving: the guard stops asking afterwards ──────────────
console.log('\nAfter a real export')
await page.evaluate(async () => {
  const { useAnnotationStore } = await import('/src/stores/annotationStore.ts')
  useAnnotationStore.getState().clearAll()
})
await amend()
check('dirty again', (await isDirty()) === true)
const exportDownload = page.waitForEvent('download', { timeout: 60000 })
await page.getByRole('button', { name: 'Export', exact: true }).click()
const downloadButton = page.getByRole('button', { name: /^Download/ })
await downloadButton.waitFor({ state: 'visible', timeout: 30000 })
// The dialog builds the annotated bytes and a compressed variant before either
// button does anything — wait for it to be offered, not merely present.
for (let i = 0; i < 60 && (await downloadButton.isDisabled()); i++) await page.waitForTimeout(500)
await downloadButton.click()
await exportDownload
await page.waitForTimeout(300)
check('export cleared the amendments', (await isDirty()) === false)
await clickClosePdf()
await page.waitForTimeout(300)
check('closing no longer asks', (await dialog.count()) === 0)
check('and it closed', (await docIsOpen()) === false)

// ── 8. marks restored from recents are the baseline, not an amendment ──────
console.log('\nReopened from recents')
await page.evaluate(async () => {
  const { usePdfStore } = await import('/src/stores/pdfStore.ts')
  await usePdfStore.getState().refreshRecents()
  const first = usePdfStore.getState().recents[0]
  if (first) await usePdfStore.getState().openRecent(first.id)
})
await page.waitForSelector('canvas', { timeout: 20000 })
check('reopened', await docIsOpen())
check('not treated as amended', (await isDirty()) === false)

// ── 9. undoing every mark leaves nothing to save ───────────────────────────
console.log('\nDraw then undo')
await amend()
check('dirty', (await isDirty()) === true)
await page.evaluate(async () => {
  const { useAnnotationStore } = await import('/src/stores/annotationStore.ts')
  useAnnotationStore.getState().undo()
})
check('clean again once the mark is gone', (await isDirty()) === false)

// ── 10. the browser's own "leave site?" still fires for a tab close ────────
// The popup cannot cover a tab being closed — no web page can put three buttons
// in front of that — so the web build also arms `beforeunload`, which is the
// browser's one-question version of the same guard. (The desktop build must NOT
// arm it; Electron shows no dialog and just refuses the close. That half is
// proven in exit-guard-desktop.e2e.mjs.)
console.log('\nClosing the tab')
await amend()
check('dirty before closing the tab', (await isDirty()) === true)
const beforeUnload = new Promise((resolve) => {
  page.once('dialog', (d) => {
    resolve(d.type())
    d.dismiss().catch(() => {})
  })
})
await page.close({ runBeforeUnload: true })
const dialogType = await Promise.race([
  beforeUnload,
  new Promise((r) => setTimeout(() => r('(none)'), 5000))
])
check('the browser asks before the tab goes', dialogType === 'beforeunload', dialogType)

// ── ...but the native shells must NOT be asked ──────────────────────────────
// ⚠️ `beforeunload` is a REAL-BROWSER-ONLY guard. Electron was already excluded
// because it silently refuses the close instead of prompting; the two Capacitor
// shells do exactly the same and were missed when that was written. Checked in
// the plugin sources: `BridgeWebChromeClient` (Android) implements onJsAlert and
// onJsConfirm and no onJsBeforeUnload, and `WebViewDelegationHandler` (iOS) has
// the alert / confirm / text-input panels and no beforeunload panel — so
// neither can ever put the question to the user, and a guard there can only
// block silently.
//
// Nothing is lost: a native app is not closed by unloading its document, so the
// only unload reachable in a shell is one the app did not ask for. In-app exits
// go through `requestExit`'s three-button popup on every platform, which the
// checks above cover.
//
// The shell is FAKED (`window.Capacitor.isNativePlatform`) — that is all
// `isNativeShell()` reads.
//
// Negative control (2026-09-07, run): with `isNativeShell()` taken back out of
// the guard's condition in App.tsx, "and it is not asked anyway" goes red with
// `beforeunload` and every other check here stays green.
console.log('\nInside a native shell the browser is never asked')
const nativeCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await nativeCtx.addInitScript(() => {
  window.Capacitor = { isNativePlatform: () => true }
})
const nativePage = await nativeCtx.newPage()
await nativePage.goto(BASE, { waitUntil: 'networkidle' })
await nativePage.evaluate(async () => {
  const { createExamplePdfFile } = await import('/src/lib/examplePdf.ts')
  const { usePdfStore } = await import('/src/stores/pdfStore.ts')
  await usePdfStore.getState().loadFile(await createExamplePdfFile())
})
await nativePage.waitForSelector('canvas', { timeout: 20000 })
await nativePage.evaluate(async () => {
  const { useAnnotationStore } = await import('/src/stores/annotationStore.ts')
  useAnnotationStore.getState().add({
    id: 'e2e-native-rect', pageIndex: 0,
    type: 'rect', x: 60, y: 60, width: 180, height: 90, color: '#dc2626',
  })
})
check(
  'dirty, so a browser would have asked',
  await nativePage.evaluate(async () => {
    const { hasUnsavedChanges } = await import('/src/lib/unsavedChanges.ts')
    return hasUnsavedChanges()
  }),
)
const nativeDialog = new Promise((resolve) => {
  nativePage.once('dialog', (d) => {
    resolve(d.type())
    d.dismiss().catch(() => {})
  })
})
await nativePage.close({ runBeforeUnload: true })
const nativeType = await Promise.race([
  nativeDialog,
  new Promise((r) => setTimeout(() => r('(none)'), 5000)),
])
check('and it is not asked anyway', nativeType === '(none)', nativeType)
await nativeCtx.close()

await browser.close()

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n` + failures.map((f) => `  • ${f}`).join('\n'))
  process.exit(1)
}
console.log('\nAll exit-guard checks passed.')
