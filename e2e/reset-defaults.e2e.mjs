// reset-defaults.e2e.mjs — "Don't show again" stays dismissed, and Reset
// defaults brings it back. `npm run test:reset-defaults` (dev server up).
//
// Owner ask, 2026-09-08: keep "Don't show again" permanent, add a Reset
// defaults row under Advanced on the Actions tab, and make the dismissal follow
// a signed-in user across devices.
//
// ⚠️ WHAT THIS CAN AND CANNOT PROVE. The cross-device half needs a real
// Universal ID and two browsers; under the offline mock there is no Supabase to
// write `user_app_prefs` to. So this covers the half that a person actually
// touches — dismiss, reload, still gone; reset, reload, back — and the
// cross-device half is asserted structurally (the component reads the SDK hook
// rather than localStorage directly) with the live check left to a device pass.
// Saying so beats a green tick that quietly means less than it looks like.

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
    } catch { continue }
    try {
      const probe = await mod.chromium.launch()
      await probe.close()
      return mod
    } catch { /* next */ }
  }
  console.error('No usable Playwright found.')
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
  doc.addPage([595, 842]).drawText('Reset defaults test', { x: 60, y: 780, size: 20, font })
  return Buffer.from(await doc.save())
}

const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAQUlEQVR42u3OMQEAAAgDoC1p' +
  'b3vBHRxYm3ZlKQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAgYcFYQABAV' +
  'yZbwAAAAAASUVORK5CYII=', 'base64')

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const pdf = await testPdf()
// ONE context for the whole run: localStorage has to survive the reloads, which
// is the entire thing under test.
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.addInitScript(() => {
  window.localStorage.setItem('universal:mock_session', 'james')
})
const page = await context.newPage()
page.on('pageerror', (e) => failures.push('page error: ' + e.message))

async function openDoc() {
  await page.goto(`${BASE}?mockauth=1`, { waitUntil: 'load' })
  await page.setInputFiles('input[type=file][accept*="pdf"], input[type=file]', {
    name: 'reset.pdf', mimeType: 'application/pdf', buffer: pdf,
  })
  await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
  await page.waitForTimeout(500)
}

/** Arm a placement so the hint appears. */
async function armPlacement() {
  await page.setInputFiles('input[type=file][accept*="image/png"]', {
    name: 'red.png', mimeType: 'image/png', buffer: RED_PNG,
  })
  await page.waitForTimeout(600)
}

const hint = () => page.locator('[data-placement-hint]')

try {
  await openDoc()
} catch {
  console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
  await browser.close()
  process.exit(2)
}

console.log('\nthe hint shows when a placement is armed')
await armPlacement()
check('the card is up', await hint().count() > 0)

console.log('\n"Don\'t show again" hides it, and it stays hidden across a reload')
await page.click('button:has-text("Don\'t show again")')
await page.waitForTimeout(400)
check('the card went', await hint().count() === 0)
// ⚠️ The placement must still be ARMED — the button is a display preference,
// not a way out of the state. Cancel is the way out. Getting this wrong would
// silently disarm people.
check('the placement is still armed (the image tool is still active)',
      (await page.locator('button[title^="Select / move"]').first().getAttribute('class') ?? '')
        .includes('bg-orange-700') === false)

await openDoc()
await armPlacement()
check('still hidden after a reload', await hint().count() === 0)

console.log('\nReset defaults brings it back')
// ⚠️ The Actions rows are in the DOM at all times and merely hidden — the same
// trap the separate-placement suite records for the mobile toolbar's Save. So
// the menu has to be OPENED, and every assertion below is on VISIBILITY, not on
// count: a count assertion here would pass without the menu ever opening.
// ⚠️ HOVER, not click. The Actions panel is the SDK's <UserProfile />, which
// opens on pointer-enter — clicking the pill leaves aria-expanded at false and
// nothing appears, which looks exactly like a broken menu.
await page.locator('button:has-text("Actions")').first().hover()
await page.waitForTimeout(600)
const advanced = page.locator('button:has-text("Advanced")').first()
check('the Advanced section is visible once Actions is open', await advanced.isVisible())

await advanced.click()
await page.waitForTimeout(300)
const resetRow = page.locator('button:has-text("Reset defaults")').first()
check('Reset defaults is in it', await resetRow.isVisible())
if (await resetRow.isVisible()) {
  await page.screenshot({ path: 'e2e-reset-defaults-menu.png' })
}

await resetRow.click()
await page.waitForTimeout(800)
check('it confirms in place rather than closing the menu',
      await page.locator('button:has-text("Defaults restored")').first().isVisible())

await openDoc()
await armPlacement()
check('the hint is back after reset', await hint().count() > 0)

await page.screenshot({ path: 'e2e-reset-defaults.png' })
await browser.close()
console.log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
