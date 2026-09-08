// "Separate click" — the signature pad's placement control, browser-level.
//
//   ./scripts/preview.ps1            # or preview.sh — Universal PDF is :5174
//   npm run test:separate            # in another terminal
//
// What is pinned, both halves of the same owner report (2026-08-29: "it's
// activated option only when date is switched (should be details and/or date)
// and then when placing it doesn't do it on a separate click anyway"):
//
//   • The control is LIVE as soon as "Add your details" is on, with nothing
//     typed. It used to need a name typed over the "Signed by: " seed, so it
//     appeared to belong to the date switch alone.
//   • Choosing "Separate click" actually places separately WHEN THERE ARE
//     DETAILS. It used to bail silently (`&& !wantDetails`) and bake the lot,
//     so the control did nothing and said nothing about doing nothing.
//   • One piece per line, date LAST. Name + two detail lines + date is four
//     click-placements after the signature itself, and the tool only returns to
//     Select when the queue is empty — which is what counts them here.
//   • EXACTLY four. It was seven before the mid-sequence deselect: `add` selects
//     what it adds, so each dropped piece left a Transformer over itself and ate
//     the next click. The count is the assertion that catches that coming back —
//     a click that silently does nothing is the same symptom as the feature not
//     working, which is how it was reported in the first place.
//
// Negative control (2026-08-29, run): `git stash`-ing the three source files
// back turns three of these six red — the details gate, "stays armed", and the
// click count (queue emptied after 0, i.e. everything baked).

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
  const page = doc.addPage([595, 842])
  page.drawText('Separate placement test', { x: 60, y: 780, size: 20, font })
  return Buffer.from(await doc.save())
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const pdf = await testPdf()
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => failures.push('page error: ' + e.message))

// Signed in before boot, the way the other suites do it — the pad itself does
// not need an account, but the app's chrome is the same in both tests this way.
await context.addInitScript(() => {
  window.localStorage.setItem('universal:mock_session', 'james')
})

try {
  await page.goto(`${BASE}?mockauth=1`, { waitUntil: 'load' })
} catch {
  console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
  await browser.close()
  process.exit(2)
}

await page.setInputFiles('input[type=file]', { name: 'sep.pdf', mimeType: 'application/pdf', buffer: pdf })
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(500)

// ── Open the pad and draw something ─────────────────────────────────────────
await page.click('button[aria-label="Sign"]')
await page.click('button:has-text("+ Draw new")')
await page.waitForSelector('button:has-text("Advanced options")', { timeout: 5000 })

// The pad's drawing surface is the first canvas inside the dialog. A few
// strokes so `lines` is non-empty and Save produces real ink.
const pad_dialog = page.locator('div.fixed.inset-0:has-text("Advanced options")').first()
const pad = page.locator('.fixed.inset-0 canvas').first()
const padBox = await pad.boundingBox()
await page.mouse.move(padBox.x + 60, padBox.y + padBox.height * 0.6)
await page.mouse.down()
for (const dx of [40, 80, 120, 160]) {
  await page.mouse.move(padBox.x + 60 + dx, padBox.y + padBox.height * (dx % 80 ? 0.45 : 0.7))
}
await page.mouse.up()
await page.waitForTimeout(200)

await page.click('button:has-text("Advanced options")')
await page.waitForTimeout(250)

// ── 1. The gate: details alone must light the control ───────────────────────
// The wrapper carries `pointer-events-none` while inert, which is also what
// actually stops the buttons working — so the assertion reads the real gate
// rather than a lookalike.
const placementBlock = page.locator('div:has(> div:text-is("When placed"))').last()
const isLive = async () => {
  const cls = (await placementBlock.getAttribute('class')) ?? ''
  return !cls.includes('pointer-events-none')
}

console.log('\nthe "When placed" control follows the switches')
check('it starts inert with both switches off', !(await isLive()))

await page.click('label:has-text("Add your details")')
await page.waitForTimeout(200)
check('"Add your details" alone makes it live (nothing typed yet)', await isLive())

await page.click('label:has-text("Add your details")')
await page.waitForTimeout(200)
await page.click('label:has-text("Add date")')
await page.waitForTimeout(200)
check('"Add date" alone makes it live too', await isLive())

// ── 2. Separate placement with details actually places separately ───────────
await page.click('label:has-text("Add your details")')
await page.waitForTimeout(200)
const details = page.locator('textarea[aria-label="Details to show under the signature"]')
await details.fill(['Jane Smith', 'Head of Testing', 'jane@example.com'].join('\n'))
await page.waitForTimeout(200)

await page.click('button:has-text("Separate click")')
await page.waitForTimeout(150)
// ⚠️ Scoped to the pad. A bare `button:has-text("Save")` also matches the
// MOBILE toolbar's Save, which is in the DOM at every viewport and merely
// hidden — Playwright picks it first and then waits for a button that will
// never be visible.
await pad_dialog.locator('button:has-text("Save")').click()
await page.waitForTimeout(800)

// The signature arms the tool; drop it, then count how many further clicks the
// queue eats. The tool returns to Select only once it is empty, so the count of
// clicks IS the number of separately-placed pieces.
// ⚠️ Prefix match. The select-group button carries a `panel`, so its title is
// "Select / move — tap again or long-press for options", not the bare label.
const selectActive = async () =>
  ((await page.locator('button[title^="Select / move"]').first().getAttribute('class')) ?? '').includes(
    'bg-orange-700'
  )

const pageBox = await page.locator('[data-page-index="0"] canvas').first().boundingBox()

// ⚠️ EVERY CLICK STAYS IN THE TOP THIRD OF THE PAGE, and that is not cosmetic.
//
// PlacementHint centres its card over the document. The card itself is
// `pointer-events-none` — deliberately, and its comment says why — but its two
// buttons (Cancel / Don't show again) are `pointer-events-auto`, and they sit
// dead centre. The original ladder stepped 60px per click from y+180, so the
// FOURTH click landed on "Don't show again": the click was swallowed, the hint
// was permanently dismissed, and the run needed a fifth click to place four
// pieces.
//
// That read exactly like "the queue serves one placement too many" and was
// recorded as such. It is not: the queue is correct and drains in four. The
// pieces even land in the right order — the giveaway was a GAP in the placed
// column where the fourth should have been, visible only in the DEBUG_SEP
// frames.
//
// The underlying hazard is real and is a product question rather than a test
// one: a live button parked over the middle of the page can eat the very tap
// the card is instructing the user to make. That is written up in the backlog
// for the owner; this harness simply stops colliding with it, so it can go back
// to guarding what it is for.
const dropAt = async (i) => {
  await page.mouse.click(pageBox.x + 90 + i * 60, pageBox.y + 110 + i * 42)
  await page.waitForTimeout(260)
}

console.log('\nplacing with details on really is a separate click')
await dropAt(0) // the signature itself
check('the tool stays armed after the signature (extras queued)', !(await selectActive()))

let clicks = 0
while (clicks < 8 && !(await selectActive())) {
  clicks += 1
  await dropAt(clicks)
  // Canvas failures are opaque — a red count tells you nothing about WHICH
  // click did nothing. `DEBUG_SEP=<dir> npm run test:separate` drops a frame
  // per click there; that is how the swallowed-by-Transformer clicks were found.
  if (process.env.DEBUG_SEP) {
    await page.screenshot({ path: `${process.env.DEBUG_SEP}/sep-${clicks}.png`, clip: { x: pageBox.x, y: pageBox.y + 100, width: Math.min(700, pageBox.width), height: 560 } })
    console.log(`    [debug] after click ${clicks}: select=${await selectActive()}`)
  }
}
check(
  'name + 2 detail lines + date = four click-placements',
  clicks === 4,
  `queue emptied after ${clicks}`
)
check('and the tool falls back to Select once the queue is empty', await selectActive())

await browser.close()
console.log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
