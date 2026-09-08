// Merge asks before it throws your annotations away, and Undo puts them back.
//
//   ./scripts/preview.sh             # or preview.ps1 — Universal PDF is :5174
//   npm run test:merge-guard         # in another terminal
//
// What is pinned (owner, 2026-09-08: "when doing anything destructive to the
// PDF, show the discard, save, cancel — I had annotations and then used the
// merge option thinking it would keep my annotations but it destroyed them and
// merged anew", and "allow the undo option to undo things like merge too"):
//
//   • "Merge & open" over an annotated document raises the unsaved-changes
//     guard — the same Cancel / Exit without saving / Save and exit the app
//     already shows for Close and Open-another — and says what merge does to
//     the annotations.
//   • Cancel really cancels: the document is untouched and the annotations are
//     still there.
//   • After going through with it, UNDO puts the pre-merge document back WITH
//     its annotations. That is the half the guard alone cannot give you.
//   • A merge over a clean document does not ask — the guard is about unsaved
//     amendments, not about merging.
//
// ⚠️ Annotation counts are read from the Konva canvas's pixels, not the DOM:
// there is no element per annotation. "Any ink at all on the layer" is enough
// here, because the test only ever asks whether the markup survived.
//
// ⚠️ THE ACTIONS MENU OPENS ON HOVER — see actions-menu.e2e.mjs.
//
// Negative control (2026-09-08, run): with `requestExit` short-circuited to run
// its action outright and `snapshotDocument` made a no-op, "the guard appears"
// goes red and the run then ABORTS on the next line — there is no dialog to
// read the wording out of. That is the control working, not a flake.

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

const { PDFDocument, StandardFonts } = await import('pdf-lib')

async function testPdf(label, pages = 1) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842])
    page.drawText(`${label} — page ${i + 1}`, { x: 60, y: 760, size: 16, font })
  }
  return Buffer.from(await doc.save())
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const first = await testPdf('First document')
const second = await testPdf('Second document', 2)

const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.addInitScript(() => {
  window.localStorage.setItem('universal:mock_session', 'james')
})
const page = await context.newPage()
page.on('pageerror', (e) => failures.push('page error: ' + e.message))

try {
  await page.goto(`${BASE}?mockauth=1`, { waitUntil: 'load' })
} catch {
  console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
  await browser.close()
  process.exit(2)
}

await page.setInputFiles('input[type=file]', { name: 'first.pdf', mimeType: 'application/pdf', buffer: first })
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(700)

// Lit pixels on the annotation layer — see the note at the top.
async function ink() {
  return page.evaluate(() => {
    const canvases = document.querySelectorAll('[data-page-index="0"] canvas')
    const c = canvases[canvases.length - 1]
    if (!c) return 0
    const ctx = c.getContext('2d', { willReadFrequently: true })
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let n = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n++
    return n
  })
}

const pageCount = () =>
  page.evaluate(() => document.querySelectorAll('[data-page-index]').length)

async function openMerge() {
  await page.hover('button[aria-label$="Profile"]')
  await page.waitForTimeout(400)
  const section = page.locator('button:visible').filter({ hasText: 'Advanced' }).first()
  if ((await section.getAttribute('aria-expanded')) !== 'true') {
    await section.click()
    await page.waitForTimeout(300)
  }
  await page.locator('button:visible').filter({ hasText: 'Merge with another PDF' }).first().click()
  await page.waitForSelector('h2:has-text("Merge PDFs")', { timeout: 5000 })
  await page.waitForTimeout(400)
  // ⚠️ Scoped to the merge dialog. The app has its own file input on the page,
  // and feeding the second PDF to THAT opens it as the document instead —
  // which looks like the merge list quietly refusing to accept anything.
  await page.locator('div.fixed:has(h2:has-text("Merge PDFs")) input[type=file]').setInputFiles({
    name: 'second.pdf',
    mimeType: 'application/pdf',
    buffer: second,
  })
  await page.waitForTimeout(500)
}

const guard = page.locator('button:has-text("Exit without saving")')

// ── A clean document merges without being asked ─────────────────────────────
console.log('\na merge with nothing unsaved does not ask')
await openMerge()
await page.locator('button:has-text("Merge & open")').first().click()
await page.waitForTimeout(400)
check('no guard on a document with no amendments', (await guard.count()) === 0)
await page.waitForTimeout(1800)
check('and the merge happened', (await pageCount()) === 3, `${await pageCount()} pages`)

// ⚠️ Everything below runs on the MERGED document, deliberately. Feeding
// `first.pdf` back through the page-level file input does nothing once a
// document is open — the landing input is gone — and a test that quietly went
// on measuring the wrong document read as three unrelated failures.

// ── Annotate, then merge ────────────────────────────────────────────────────
console.log('\nwith annotations on the page, merge asks first')
await page.click('button[aria-label="Open drawing tools"]:visible')
await page.waitForTimeout(400)
await page.click('button[title="Tick"]:visible')
await page.waitForTimeout(300)
const box = await page.locator('[data-page-index="0"] canvas').first().boundingBox()
await page.mouse.click(box.x + box.width * 0.4, box.y + 300)
await page.waitForTimeout(600)
// ⚠️ Deselect before measuring. A selected annotation drags a Transformer —
// dashed outline and eight handles — onto the same canvas, so a count taken
// with it selected is not the count that comes back after an undo, and the
// comparison fails on a feature that worked.
await page.locator('button[aria-label="Confirm and deselect"]').first().click()
await page.waitForTimeout(400)
const inkBefore = await ink()
check('there is markup on the page', inkBefore > 0)

await openMerge()
await page.locator('button:has-text("Merge & open")').first().click()
await page.waitForTimeout(700)
check('the guard appears', (await guard.count()) === 1)
const guardText = (await page.locator('div.fixed:has-text("Exit without saving")').last().innerText()).replace(/\s+/g, ' ')
check('it offers all three answers', /Cancel/.test(guardText) && /Exit without saving/.test(guardText) && /Save and exit/.test(guardText), guardText.slice(0, 200))
check(
  'and says what merge does to the annotations',
  /annotations stay with this document/i.test(guardText),
  guardText.slice(0, 300),
)

// ── Cancel means cancel ─────────────────────────────────────────────────────
console.log('\nCancel leaves the document exactly as it was')
// ⚠️ The guard's Cancel, not the merge dialog's — that one is still open
// underneath, and it is the FIRST match on the page.
await page.locator('div.fixed:has-text("Exit without saving")').last().locator('button:has-text("Cancel")').click()
await page.waitForTimeout(700)
check('the guard closes', (await guard.count()) === 0)
check('still three pages', (await pageCount()) === 3, `${await pageCount()} pages`)
check('and the markup is untouched', (await ink()) === inkBefore)

// ── Going through with it, then undoing ─────────────────────────────────────
console.log('\ngoing through with the merge, then undoing it')
await page.locator('button:has-text("Merge & open")').first().click()
await page.waitForTimeout(700)
await page.locator('button:has-text("Exit without saving")').first().click()
await page.waitForTimeout(2500)
check('the merged document is open', (await pageCount()) === 5, `${await pageCount()} pages`)
check('and the annotations are gone, as merge warned', (await ink()) === 0)

await page.keyboard.press('Control+z')
await page.waitForTimeout(2500)
check('Ctrl+Z puts the pre-merge document back', (await pageCount()) === 3, `${await pageCount()} pages`)
check('WITH its annotations', (await ink()) === inkBefore, `${await ink()} lit pixels, was ${inkBefore}`)

console.log('')
if (failures.length) {
  console.log(`${failures.length} FAILED:`)
  for (const f of failures) console.log(`  • ${f}`)
} else {
  console.log('All checks passed.')
}
await browser.close()
process.exit(failures.length ? 1 : 0)
