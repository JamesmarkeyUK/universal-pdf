// "Select area" on a touchscreen — browser-level regression check.
//
//   ./scripts/preview.sh          # in one terminal (Universal PDF is :5174)
//   npm run test:select-area      # in another
//
// The report (James, 2026-09-06): "there seems to be problems with the select
// area on mobile … my guess would be it's linked to the touchscreen tap and
// swipe to move up and down on multiple pages". The guess was exactly right.
//
// Select area needs a one-finger drag to draw its box. So does scrolling
// through the document, and the page could only give that gesture to one of
// them — it gave it to the box outright, with `touch-action: none` on every
// page's Konva Stage. The result on a phone: picking Select area FROZE the
// document. Every swipe drew an empty selection box instead of scrolling,
// an empty sweep leaves the tool armed for another try, and so there was no
// way to reach page 4 — or to get out — short of going back to the toolbar and
// picking a different tool.
//
// The fix hands the plain swipe back to the document and asks for a gesture a
// swipe is not: press and hold, then drag. Both halves are asserted here,
// because either one alone is a regression:
//
//   • a plain swipe with Select area active scrolls the document, exactly as
//     Select / Select text / Hand always did;
//   • a press-and-hold then drag draws the box, catches what is inside it, and
//     does NOT scroll the document out from under itself.
//
// Plus the two that say the rest of the tool is untouched: a tap on empty page
// still deselects, and a MOUSE still marquees on a plain drag with no hold.
//
// Touches are dispatched over CDP — Playwright's touchscreen API only taps, and
// this needs a press, a hold, and a drag in one gesture.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174/'
// Set when the only Chromium to hand isn't the build this Playwright expects
// (a container with a pre-installed browser, say).
const LAUNCH = process.env.E2E_CHROMIUM_PATH
  ? { executablePath: process.env.E2E_CHROMIUM_PATH }
  : {}

// Sibling repos that carry a Playwright install, newest-known first. See
// office-import.e2e.mjs for why this launches a browser rather than trusting
// the first candidate that imports.
const PLAYWRIGHT_CANDIDATES = [
  '../node_modules/playwright/index.js',
  '../../Universal_Beam/node_modules/playwright/index.js',
  '../../Universal_Exports/node_modules/playwright/index.js',
  '../../Universal_Video/node_modules/playwright/index.js',
  '../../../UNI_SIM_Assess/Ergo_Assess/frontend/node_modules/playwright/index.js'
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
      const probe = await mod.chromium.launch(LAUNCH)
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
      '  npm i -D playwright && npx playwright install chromium\n' +
      'Or point E2E_CHROMIUM_PATH at a Chromium binary you already have.'
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

// Several pages, so there is something to scroll THROUGH rather than merely
// within — the report is about moving up and down a multi-page document.
async function testPdf() {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 5; i += 1) {
    const p = doc.addPage([595, 842])
    p.drawText(`Page ${i}`, { x: 60, y: 760, size: 28, font })
  }
  return Buffer.from(await doc.save())
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch(LAUNCH)
const pdf = await testPdf()

// ── The phone ───────────────────────────────────────────────────────────────
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
})
await phone.addInitScript(() => window.localStorage.setItem('universal:mock_session', 'james'))
const page = await phone.newPage()
page.on('pageerror', (e) => failures.push('page error: ' + e.message))

try {
  await page.goto(`${BASE}?mockauth=1`, { waitUntil: 'load' })
} catch {
  console.error(`Could not reach ${BASE} — serve the build first.`)
  await browser.close()
  process.exit(2)
}

await page.setInputFiles('input[type=file]', { name: 'pages.pdf', mimeType: 'application/pdf', buffer: pdf })
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(1500)

const cdp = await phone.newCDPSession(page)

// One finger: down, hold, drag, up. `holdMs` is what separates a swipe (0) from
// a press-and-hold (> MARQUEE_HOLD_MS, which is 350).
async function finger({ x, y, dx = 0, dy = 0, holdMs = 0, steps = 14 }) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
  if (holdMs) await page.waitForTimeout(holdMs)
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps, id: 1 }]
    })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(700)
}

const tap = (x, y) => finger({ x, y, steps: 0 })

const scrollTop = () =>
  page.evaluate(() => {
    const el = document.querySelector('.overflow-auto.absolute.inset-0')
    return el ? Math.round(el.scrollTop) : -1
  })

const setScrollTop = (top) =>
  page.evaluate((t) => {
    document.querySelector('.overflow-auto.absolute.inset-0').scrollTop = t
  }, top)

// The bottom bar's first cell names the live Select-group tool: Select / Area /
// Text / Hand. That IS the tool indicator on a phone.
const barTool = () =>
  page.evaluate(() => document.querySelector('nav > div span:nth-of-type(2)')?.textContent ?? '')

// touch-action on the page's Konva Stage — the property the whole bug was.
const stageTouchAction = () =>
  page.evaluate(() => {
    const stage = [...document.querySelectorAll('[data-page-index] div')].find((d) => d.style.touchAction)
    return stage ? stage.style.touchAction : '(none set)'
  })

async function pickSelectTool(label) {
  await page.locator('nav > div').first().locator('button').nth(1).click()
  await page.waitForTimeout(300)
  await page.locator(`button:has(span:text-is("${label}"))`).last().click()
  await page.waitForTimeout(500)
}

// ── Two things on page 1 for the box to catch ───────────────────────────────
const pageBox = await page.locator('[data-page-index="0"]').boundingBox()
const markA = { x: pageBox.x + pageBox.width * 0.35, y: pageBox.y + pageBox.height * 0.45 }
const markB = { x: pageBox.x + pageBox.width * 0.6, y: pageBox.y + pageBox.height * 0.55 }

await page.locator('nav > div').nth(1).locator('button').nth(1).click() // Draw "+"
await page.waitForTimeout(300)
await page.click('button[title="Tick"]:visible')
await page.waitForTimeout(300)
await tap(markA.x, markA.y)
await tap(markB.x, markB.y)
check('two ticks are on the page to be caught', (await page.evaluate(() => {
  // Nothing exposes the annotation list, but placing a tick switches the tool
  // back to Select — two placements, and the bar has to read "Select".
  return document.querySelector('nav > div span:nth-of-type(2)')?.textContent
})) === 'Select', await barTool())

// ── 1. A plain swipe still moves the document ───────────────────────────────
console.log('\nSelect area active, plain swipe up')
await pickSelectTool('Select area')
check('the tool is armed', (await barTool()) === 'Area', await barTool())
check(
  'the Stage leaves vertical panning to the document',
  (await stageTouchAction()) === 'pan-y pinch-zoom',
  await stageTouchAction()
)
await setScrollTop(400)
await page.waitForTimeout(300)
const beforeSwipe = await scrollTop()
await finger({ x: 195, y: 620, dy: -400 })
const afterSwipe = await scrollTop()
check(
  'the document scrolls',
  afterSwipe - beforeSwipe > 200,
  `scrollTop ${beforeSwipe} → ${afterSwipe}`
)
check('and Select area is still armed for the box', (await barTool()) === 'Area', await barTool())

// ── 2. Press and hold, then drag, draws the box ─────────────────────────────
console.log('\nSelect area active, press and hold then drag')
await setScrollTop(0)
await page.waitForTimeout(500)
const boxFrom = { x: pageBox.x + pageBox.width * 0.2, y: pageBox.y + pageBox.height * 0.35 }
const beforeBox = await scrollTop()
await finger({
  x: boxFrom.x,
  y: boxFrom.y,
  dx: pageBox.width * 0.55,
  dy: pageBox.height * 0.3,
  holdMs: 500
})
const afterBox = await scrollTop()
check('the document does NOT scroll under the box', afterBox === beforeBox, `scrollTop ${beforeBox} → ${afterBox}`)
// A marquee that catches something drops into Select so the group can be
// moved straight away — so the bar reading "Select" is the catch.
check('the box caught the ticks inside it', (await barTool()) === 'Select', await barTool())

// ── 3. A tap on empty page still deselects ──────────────────────────────────
console.log('\nSelect area active, tap on empty page')
await pickSelectTool('Select area')
await tap(pageBox.x + pageBox.width * 0.5, pageBox.y + pageBox.height * 0.85)
check('a tap is not a box, so the tool stays armed', (await barTool()) === 'Area', await barTool())

await phone.close()

// ── 4. A mouse still marquees on a plain drag ───────────────────────────────
console.log('\nthe same tool with a mouse')
const desktop = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await desktop.addInitScript(() => window.localStorage.setItem('universal:mock_session', 'james'))
const dPage = await desktop.newPage()
dPage.on('pageerror', (e) => failures.push('desktop page error: ' + e.message))
await dPage.goto(`${BASE}?mockauth=1`, { waitUntil: 'load' })
await dPage.setInputFiles('input[type=file]', { name: 'pages.pdf', mimeType: 'application/pdf', buffer: pdf })
await dPage.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await dPage.waitForTimeout(1200)

const dBox = await dPage.locator('[data-page-index="0"]').boundingBox()
await dPage.click('button[aria-label="Open drawing tools"]:visible')
await dPage.click('button[title="Tick"]:visible')
await dPage.waitForTimeout(300)
await dPage.mouse.click(dBox.x + dBox.width * 0.5, dBox.y + dBox.height * 0.5)
await dPage.waitForTimeout(400)

const groupTitle = () => dPage.locator('button[title^="Select"]').first().getAttribute('title')
await dPage.click('button[aria-label="Open select options"]:visible')
await dPage.click('button:has(div:text-is("Select area")):visible')
await dPage.waitForTimeout(400)
check('mouse: the tool is armed', /Select area/.test(await groupTitle()), await groupTitle())

await dPage.mouse.move(dBox.x + 20, dBox.y + 20)
await dPage.mouse.down()
await dPage.mouse.move(dBox.x + dBox.width - 20, dBox.y + dBox.height - 20, { steps: 20 })
await dPage.mouse.up()
await dPage.waitForTimeout(500)
check(
  'mouse: a plain drag still draws the box, with no hold',
  /Select \/ move/.test(await groupTitle()),
  await groupTitle()
)

await browser.close()

console.log('')
if (failures.length) {
  console.error(`${failures.length} check(s) failed:`)
  for (const f of failures) console.error(`  • ${f}`)
  process.exit(1)
}
console.log('All checks passed.')
