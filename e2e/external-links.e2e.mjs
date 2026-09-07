// External links in the native shells — browser-level.
//
//   ./scripts/preview.sh              # or preview.ps1 — Universal PDF is :5174
//   npm run test:external-links:e2e   # in another terminal
//
// What is pinned (owner, 2026-09-06, iOS: "going to this page in app then
// clicking a link (tested with the full credits link) then going back to app
// and you can't then close the window and have to force close the app").
//
// A `target="_blank"` in a Capacitor WebView does not open a tab. Capacitor
// cancels the navigation and calls `UIApplication.shared.open`, which sends the
// whole app to the background and opens Safari — and the app does not survive
// coming back: the About dialog stays on screen and stops taking taps, while
// the rest of the app still works (both of the dialog's layers are
// `position: fixed`; nothing else on that screen is).
//
// `installExternalLinkHandler` cancels the click first and opens the link in an
// in-app browser instead, so the app is never backgrounded. This test drives
// the real dialog and asserts the two halves that matter:
//
//   • ON a native shell the click is CANCELLED, so the platform never gets to
//     hand the app away, and the app opens the URL itself instead.
//   • OFF one, nothing is touched. The web build must keep letting the anchor
//     open a genuine tab, which is what it has always done.
//
// ⚠️ The shell is FAKED (`window.Capacitor.isNativePlatform`), because that is
// exactly what `isNativeShell()` reads. What cannot be faked is the native side
// of `Browser.open` — off a device the plugin falls back to `window.open`, so
// A TAB OPENS ON BOTH PATHS and counting tabs proves nothing. The assertion is
// on the anchor being cancelled, which is the half that stops Capacitor
// backgrounding the app. The sheet itself needs a device.
//
// Negative control (2026-09-06, run): with the `useEffect` that installs the
// handler commented out of App.tsx, the two native checks go red — the click is
// no longer cancelled and nothing routes it — and all four web checks stay
// green, which is the point: the web build was never broken and must not change.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174/'

const PLAYWRIGHT_CANDIDATES = [
  '../../Universal_Beam/node_modules/playwright/index.js',
  '../../Universal_Exports/node_modules/playwright/index.js',
  '../../Universal_Video/node_modules/playwright/index.js',
  '../../../backoffice/universal-platform/node_modules/playwright/index.js',
  '../node_modules/playwright/index.js',
]

async function loadPlaywright() {
  for (const rel of PLAYWRIGHT_CANDIDATES) {
    let mod
    try {
      mod = (await import(pathToFileURL(join(HERE, rel)).href)).default
    } catch {
      continue
    }
    try {
      const probe = await mod.chromium.launch()
      await probe.close()
      return mod
    } catch {
      /* try the next one */
    }
  }
  console.error('No usable Playwright found. Install it in a sibling Universal app.')
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

async function testPdf() {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([595, 842]).drawText('External links test', { x: 60, y: 780, size: 20, font })
  return Buffer.from(await doc.save())
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const pdf = await testPdf()

/**
 * Opens the About dialog and clicks the full-credits link — the exact route in
 * the report — with `native` deciding whether the app believes it is inside a
 * Capacitor shell.
 *
 * Returns what happened to the click: whether a real tab opened (the default
 * ran) and whether the dialog is still there afterwards.
 */
async function run(native) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => failures.push('page error: ' + e.message))

  await context.addInitScript((isNative) => {
    window.localStorage.setItem('universal:mock_session', 'james')
    if (isNative) {
      // What `isNativeShell()` reads, and all it reads.
      window.Capacitor = { isNativePlatform: () => true }
    }
    // The in-app browser cannot run here, so record the attempt instead. The
    // handler falls back to `window.open` when the plugin will not load, which
    // is what this stands in for — either way, a recorded call means the click
    // reached our handler rather than the platform.
    window.__opened = []
    const realOpen = window.open.bind(window)
    window.open = (url, ...rest) => {
      window.__opened.push(String(url))
      return realOpen(url, ...rest)
    }
  }, native)

  try {
    await page.goto(`${BASE}?mockauth=1`, { waitUntil: 'load' })
  } catch {
    console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
    await browser.close()
    process.exit(2)
  }

  await page.setInputFiles('input[type=file]', { name: 'links.pdf', mimeType: 'application/pdf', buffer: pdf })
  await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
  await page.waitForTimeout(500)

  // ⚠️ HOVER, not click — <UserProfile> opens the pill on hover, so a click
  // opens it and then toggles it shut again. Same landmine as `about-app`, and
  // `aria-haspopup` rather than the bare label for the same reason it gives.
  const pill = page.locator('button:has-text("Actions")').first()
  await pill.waitFor({ state: 'visible', timeout: 15000 })
  await pill.hover()
  await page.waitForTimeout(600)
  const advanced = page.locator('button[aria-haspopup="true"]', { hasText: /^\s*\S{0,3}\s*Advanced\s*$/ }).first()
  if (!(await advanced.isVisible())) {
    await pill.click()
    await page.waitForTimeout(600)
  }
  await advanced.click()
  await page.waitForTimeout(400)
  await page.locator('button', { hasText: /About this app/ }).first().click()
  await page.waitForTimeout(700)

  // ⚠️ Watch the click's own `defaultPrevented`, not whether a tab appeared.
  // A tab appearing proves nothing here: off a device, `@capacitor/browser`
  // falls back to `window.open`, so the in-app path opens a tab too. What
  // separates the two is who cancelled the anchor — cancelling is exactly what
  // stops Capacitor handing the app to Safari on a real device.
  //
  // ⚠️ On `document.body`, in CAPTURE. The app's own listener is on `document`
  // in capture, which runs first (outermost node first), so by the time this
  // one runs the cancellation has already happened. A bubble listener would be
  // worse than useless: the dialog's card stops propagation, so a click on a
  // link inside it never bubbles to the document at all.
  await page.evaluate(() => {
    window.__prevented = null
    document.body.addEventListener('click', (e) => { window.__prevented = e.defaultPrevented }, true)
  })

  const openedBefore = context.pages().length
  const link = page.locator('[role="dialog"] a').filter({ hasText: /package/i }).first()
  const href = await link.getAttribute('href')
  await link.click()
  await page.waitForTimeout(1200)

  const result = {
    href,
    prevented: await page.evaluate(() => window.__prevented),
    newTabs: context.pages().length - openedBefore,
    routed: await page.evaluate(() => window.__opened ?? []),
    dialogStillOpen: (await page.locator('[role="dialog"]').count()) > 0,
    // The user-facing outcome: the dialog must still be closable afterwards.
    closable: null,
  }

  for (const p of context.pages()) if (p !== page) await p.close()
  await page.bringToFront()
  await page.locator('[role="dialog"] button[aria-label]').first().click().catch(() => {})
  await page.waitForTimeout(500)
  result.closable = (await page.locator('[role="dialog"]').count()) === 0

  await context.close()
  return result
}

console.log('\ninside a native shell the click never reaches the platform')
const nat = await run(true)
check('the full-credits link is the one under test', /THIRD-PARTY-NOTICES/.test(nat.href ?? ''), nat.href ?? '(no href)')
check(
  'the click is cancelled — the platform never gets to hand the app away',
  nat.prevented === true,
  `defaultPrevented was ${nat.prevented}`,
)
check(
  'and the app opens it itself instead',
  nat.routed.some((u) => /THIRD-PARTY-NOTICES/.test(u)),
  JSON.stringify(nat.routed),
)
check('the dialog is untouched by all this', nat.dialogStillOpen)
check('and still closes', nat.closable)

console.log('\nin a browser nothing changes')
const web = await run(false)
check('the click is left alone', web.prevented === false, `defaultPrevented was ${web.prevented}`)
check('so a real tab opens, as it always has', web.newTabs === 1, `${web.newTabs} tab(s) opened`)
check('and the app did not route it', web.routed.length === 0, JSON.stringify(web.routed))
check('the dialog still closes', web.closable)

await browser.close()
console.log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
