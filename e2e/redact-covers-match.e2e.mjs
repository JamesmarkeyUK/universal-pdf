// A redaction box has to COVER the word it redacts.
//
//   ./scripts/preview.ps1             # or preview.sh — Universal PDF is :5174
//   npm run test:redact-covers        # in another terminal
//
// What is pinned (owner, 2026-09-07: "the bandicot search and redact was a
// little off - you still see the ot"):
//
//   • Find and redact removed the text correctly — pdf.js could not read
//     "Bandicoot" anywhere in the exported file — but the black box was drawn
//     short, so the rasterised page still read "The secret codeword is ███ot on
//     this line." Nothing in the FILE gave it away; only the picture did, which
//     is exactly why a text-only assertion missed it.
//   • The cause was `rectsForRange` in src/lib/pdfText.ts dividing a run's total
//     width by its character count — a monospace assumption. On this line at
//     14pt Helvetica the glyphs sit at 208.6–270.8; the box (including its 1pt
//     REDACT_PAD each side) came out at 201.8–259.7. Seven points early at the
//     left, eleven short at the right. Measured, not estimated: both numbers
//     below are printed by this test.
//
// HOW THIS MEASURES TRUTH. Not by eye and not against a hard-coded number: it
// asks the browser where the glyphs are, by making a DOM Range over just the
// word inside PDF.js's own text layer. That layer is laid out from the same
// font PDF.js picked to draw the page, so its rect IS the answer. The redaction
// box, read back off the Konva stage, then has to contain it.
//
// Negative control (run 2026-09-07): with `rectsForRange` put back to
// `it.w / it.len`, the box measures 201.8–259.7 instead of 207.6–271.9, and two
// checks go red — "reaches the end of the word" (11.2px short) and "does not
// sprawl far beyond it" (7px early at the left). "Starts no later than the
// word" stays GREEN, because the old maths starts early: that asymmetry is why
// the bug read as a rendering nicety rather than a hole in a redaction tool.

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

// The word sits mid-line on purpose: a match at the start of a run would be
// placed correctly even by the broken maths.
const WORD = 'Bandicoot'
const LINE = `The secret codeword is ${WORD} on this line.`

async function testPdf() {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([595, 842])
  p.drawText(LINE, { x: 60, y: 700, size: 14, font })
  return Buffer.from(await doc.save())
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const pdf = await testPdf()
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => failures.push('page error: ' + e.message))

try {
  await page.goto(BASE, { waitUntil: 'load' })
} catch {
  console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
  await browser.close()
  process.exit(2)
}

await page.setInputFiles('input[type=file]', { name: 'redact.pdf', mimeType: 'application/pdf', buffer: pdf })
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(1200)

// ── Where the glyphs really are ──────────────────────────────────────────────
//
// PDF.js only builds its text layer while the Select-text tool is active, so
// arm it, measure, and put the tool back.
console.log('\nwhere the word actually sits, per PDF.js\'s own text layer')

const pickSelectText = async () => {
  await page.locator('button[title*="Open select options"], button[aria-label*="Open select options"]').first().click()
  await page.waitForTimeout(400)
  await page.getByText('Select text', { exact: true }).first().click()
  await page.waitForTimeout(900)
}
await pickSelectText()

const wordRect = await page.evaluate((word) => {
  const host = document.querySelector('[data-page-index="0"]')
  if (!host) return null
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.textContent.indexOf(word)
    if (i === -1) continue
    const r = document.createRange()
    r.setStart(n, i)
    r.setEnd(n, i + word.length)
    const box = r.getBoundingClientRect()
    if (box.width < 1) continue
    const pageBox = host.getBoundingClientRect()
    return {
      left: box.left - pageBox.left,
      right: box.right - pageBox.left,
      top: box.top - pageBox.top,
      bottom: box.bottom - pageBox.top,
    }
  }
  return null
}, WORD)

check('the text layer exposes the word to measure', !!wordRect, 'no text node carried it')
if (!wordRect) {
  await browser.close()
  process.exit(1)
}
console.log(`    (glyphs span ${wordRect.left.toFixed(1)}–${wordRect.right.toFixed(1)}px across the page)`)

// ── Redact every match, and see where the box landed ─────────────────────────
console.log('\nFind and redact puts its box on the word')

await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// ⚠️ The Actions panel opens on HOVER and a click TOGGLES it shut again, so
// `.click()` (which hovers first) opens and immediately closes it. Hover, and
// re-hover after each row click — the re-render drops the panel out from under
// the pointer. Same trap as redact-hint-follow.
const findAndRedact = page.locator('button:has-text("Find and redact")')
for (let attempt = 0; attempt < 4; attempt++) {
  await page.hover('button[aria-label$="Profile"]')
  await page.waitForTimeout(500)
  if (await findAndRedact.count()) break
  const redactRow = page.locator('button:has-text("Redact")').first()
  if (!(await redactRow.count())) continue
  await redactRow.click()
  await page.waitForTimeout(400)
  if (await findAndRedact.count()) break
}
check('the Redact submenu opened', (await findAndRedact.count()) > 0)
await findAndRedact.first().click()
await page.waitForTimeout(900)

await page.locator('input[placeholder*="Find" i], input[aria-label*="Find" i]').first().fill(WORD)
await page.waitForTimeout(1200)

// Arm, then confirm — "Redact all" asks before it commits.
for (let i = 0; i < 2; i++) {
  await page.evaluate(() => {
    const all = [...document.querySelectorAll('button')].filter((b) => /Redact all/i.test(b.textContent || ''))
    const el = all[all.length - 1]
    if (el) el.click()
  })
  await page.waitForTimeout(1200)
}
await page.keyboard.press('Escape')
await page.waitForTimeout(800)

const boxRect = await page.evaluate(() => {
  const K = window.Konva
  if (!K || !K.stages) return null
  for (const stage of K.stages) {
    const host = stage.container().closest('[data-page-index]')
    if (!host || host.getAttribute('data-page-index') !== '0') continue
    const pageBox = host.getBoundingClientRect()
    const cBox = stage.container().getBoundingClientRect()
    for (const n of stage.find('Rect')) {
      const fill = n.fill && n.fill()
      if (!/^#0{3,6}$|black|rgb\(0, ?0, ?0\)/i.test(String(fill))) continue
      const r = n.getClientRect()
      if (r.width < 10) continue
      return {
        left: cBox.left - pageBox.left + r.x,
        right: cBox.left - pageBox.left + r.x + r.width,
        top: cBox.top - pageBox.top + r.y,
        bottom: cBox.top - pageBox.top + r.y + r.height,
      }
    }
  }
  return null
})

check('a redaction box landed on page 1', !!boxRect, 'none found on the stage')
if (!boxRect) {
  await browser.close()
  process.exit(1)
}
console.log(`    (box spans ${boxRect.left.toFixed(1)}–${boxRect.right.toFixed(1)}px)`)

// A point of slack each side: the box is padded by REDACT_PAD and the Range
// rect is measured from a different (but equivalent) layout pass.
const SLACK = 1.5
check(
  'the box starts no later than the word',
  boxRect.left <= wordRect.left + SLACK,
  `box left ${boxRect.left.toFixed(1)} vs word left ${wordRect.left.toFixed(1)}`
)
check(
  'the box reaches the end of the word',
  boxRect.right >= wordRect.right - SLACK,
  `box right ${boxRect.right.toFixed(1)} is ${(wordRect.right - boxRect.right).toFixed(1)}px short of the word's ${wordRect.right.toFixed(1)}`
)
// ⚠️ Vertically the two rects are not the same thing and must not be compared
// edge-to-edge. The Range rect is the text layer's LINE BOX — full ascent to
// full descent of the face — while the redaction is built from the run height
// PDF.js reports, which tracks the ink. On this fixture that is a couple of
// points of descender space the box has no reason to cover, so the assertion is
// overlap, not containment: enough to catch a box on the wrong line, which is
// the failure worth catching here.
const overlap =
  Math.min(boxRect.bottom, wordRect.bottom) - Math.max(boxRect.top, wordRect.top)
const wordHeight = wordRect.bottom - wordRect.top
check(
  'the box sits on the word vertically',
  wordHeight > 0 && overlap / wordHeight >= 0.75,
  `box ${boxRect.top.toFixed(1)}–${boxRect.bottom.toFixed(1)} vs word ${wordRect.top.toFixed(1)}–${wordRect.bottom.toFixed(1)} (${((overlap / wordHeight) * 100).toFixed(0)}% overlap)`
)
// …and it must not swallow half the line either. The old maths started early;
// a fix that simply over-padded would hide the bug rather than fix it.
check(
  'and does not sprawl far beyond it',
  boxRect.left >= wordRect.left - 6 && boxRect.right <= wordRect.right + 6,
  `box ${boxRect.left.toFixed(1)}–${boxRect.right.toFixed(1)} vs word ${wordRect.left.toFixed(1)}–${wordRect.right.toFixed(1)}`
)

await browser.close()

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll checks passed.')
