// A text box's size pill has to mean what it says, and the box has to be
// resizable — corners for the type, sides to re-wrap it.
//
//   ./scripts/preview.ps1             # or preview.sh — Universal PDF is :5174
//   npm run test:text-resize          # in another terminal
//
// ⚠️ Needs the DEV server, not a static build: the last block imports the app's
// own `/src/lib/export.ts` to bake the wrapped box into a real PDF and read the
// baselines back with pdf.js.
//
// What is pinned (owner, 2026-09-07):
//
//   • "click the manual size input, click + then the size will enlarge, the
//     number will stay the same and then when you drag it, it snaps back to the
//     smaller size" — the pill's +/− now step from the number in the field and
//     write the result back into it, so the stale value can never be committed
//     by the blur that grabbing the box causes.
//   • "Allow the corners of the text box to be manipulated to get the exact
//     size you want" — text is resizable at all now (it was missing from
//     `isResizable`), and its corners scale the font proportionally.
//   • "dragging from the right point towards the left should make the text wrap
//     if needed" — the side handles set a wrap width and the text re-flows.
//
// Negative controls, all three run 2026-09-07:
//
//   • FontSizeStepper's `step` reading `value` instead of the draft (what the
//     old FontSizeField + external +/− buttons amounted to): the number stays
//     at 18 while the text goes to 20, and the drag snaps it back to 18 —
//     "the number in the field moved with it" and "the enlarged size survived
//     the drag" both go red. Everything else stays green.
//   • 'text' out of isResizable: all three handle checks go red (no anchors).
//   • export.ts drawing effectiveRuns(a) as one line instead of layoutText(a):
//     the two baked-lines checks go red, the on-screen ones stay green.

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
  doc.addPage([595, 842]).drawText('Invoice 4471', { x: 60, y: 740, size: 18, font })
  return Buffer.from(await doc.save())
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const pdf = await testPdf()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => failures.push('page error: ' + e.message))

await context.addInitScript(() => {
  window.localStorage.setItem('universal:mock_session', 'james')
})

try {
  await page.goto(`${BASE}?mockauth=1`, { waitUntil: 'load' })
} catch {
  console.error(`Could not reach ${BASE} — serve the build first.`)
  await browser.close()
  process.exit(2)
}

await page.setInputFiles('input[type=file]', { name: 'text.pdf', mimeType: 'application/pdf', buffer: pdf })
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(700)

// ⚠️ A text annotation is a GROUP of per-run Text nodes and the id is on the
// group, not on the runs — so the id is read from the node's ancestors.
const textRuns = () =>
  page.evaluate(() => {
    const K = window.Konva
    if (!K || !K.stages) return []
    const out = []
    for (const stage of K.stages) {
      for (const node of stage.find('Text')) {
        let p = node
        let id = ''
        while (p && !id) {
          id = p.id() || ''
          p = p.getParent()
        }
        if (!id) continue
        out.push({
          id,
          text: node.text(),
          x: Math.round(node.x() * 100) / 100,
          y: Math.round(node.y() * 100) / 100,
          fontSize: Math.round(node.fontSize() * 100) / 100,
          width: Math.round(node.getTextWidth() * 100) / 100,
        })
      }
    }
    return out
  })

// Absolute (page) position of one Transformer anchor, so a drag can grab it.
const anchorAt = (name) =>
  page.evaluate((n) => {
    const K = window.Konva
    for (const stage of K.stages) {
      const tr = stage.findOne('Transformer')
      if (!tr) continue
      const a = tr.findOne('.' + n)
      if (!a || !a.isVisible()) continue
      const box = a.getClientRect()
      const rect = stage.container().getBoundingClientRect()
      return { x: rect.x + box.x + box.width / 2, y: rect.y + box.y + box.height / 2 }
    }
    return null
  }, name)

const pageCanvas = page.locator('[data-page-index="0"] canvas').first()
const pageBox = await pageCanvas.boundingBox()
const SENTENCE = 'The quick brown fox jumps over the lazy dog'

// ── Place a text box ────────────────────────────────────────────────────────
console.log('\na text box is placed and typed into')
await page.locator('button[title^="Add text"]:visible').first().click()
await page.waitForTimeout(250)
await page.mouse.click(Math.round(pageBox.x + 120), Math.round(pageBox.y + 200))
await page.waitForTimeout(400)
await page.locator('[contenteditable]').waitFor({ timeout: 5000 })
await page.keyboard.type(SENTENCE)
await page.keyboard.press('Enter')
await page.waitForTimeout(400)

let runs = await textRuns()
check('the text landed on the page', runs.length > 0, JSON.stringify(runs))
check('and it is one line to start with', new Set(runs.map((r) => r.y)).size === 1, JSON.stringify(runs.map((r) => r.y)))
const startSize = runs[0]?.fontSize ?? 0

// ── The size pill ───────────────────────────────────────────────────────────
console.log('\nclicking into the size field and pressing + enlarges the text, and the number keeps up')
const sizeField = page.locator('input[aria-label="Font size in points"]')
await sizeField.waitFor({ timeout: 5000 })
const before = await sizeField.inputValue()
await sizeField.click()
await page.locator('button[aria-label="Increase text size"]').click()
await page.waitForTimeout(300)
const afterClick = await sizeField.inputValue()
runs = await textRuns()
check('the text got bigger', runs[0].fontSize > startSize, `${startSize} -> ${runs[0].fontSize}`)
check('and the number in the field moved with it', Number(afterClick) === Number(before) + 2, `${before} -> ${afterClick}`)

const grown = runs[0].fontSize

// The reported symptom: the blur that grabbing the box causes used to commit
// the stale number still sitting in the focused field.
console.log('\nand dragging the box afterwards does not snap it back')
await page.mouse.move(Math.round(pageBox.x + 130), Math.round(pageBox.y + 205))
await page.mouse.down()
await page.mouse.move(Math.round(pageBox.x + 160), Math.round(pageBox.y + 240), { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(400)
runs = await textRuns()
check('the enlarged size survived the drag', Math.abs(runs[0].fontSize - grown) < 0.01, `${grown} -> ${runs[0].fontSize}`)

// ── Resize handles ──────────────────────────────────────────────────────────
console.log('\nthe selected box offers side handles as well as corners')
const right = await anchorAt('middle-right')
const corner = await anchorAt('bottom-right')
check('there is a right-hand side handle', !!right, JSON.stringify(right))
check('and the corner handle is still there', !!corner, JSON.stringify(corner))

if (right) {
  console.log('\nand dragging the right handle leftwards wraps the text')
  const widthBefore = runs.reduce((sum, r) => sum + r.width, 0)
  await page.mouse.move(Math.round(right.x), Math.round(right.y))
  await page.mouse.down()
  await page.mouse.move(Math.round(right.x - widthBefore * 0.55), Math.round(right.y), { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  runs = await textRuns()
  const rows = [...new Set(runs.map((r) => r.y))].sort((a, b) => a - b)
  check('the text now runs over more than one line', rows.length > 1, JSON.stringify(rows))
  check(
    'the second line starts a line-height below the first',
    rows.length > 1 && Math.abs(rows[1] - rows[0] - runs[0].fontSize * 1.25) < 0.5,
    rows.length > 1 ? `${rows[1] - rows[0]} vs ${runs[0].fontSize * 1.25}` : '',
  )
  check(
    'the font size was left alone by the side handle',
    Math.abs(runs[0].fontSize - grown) < 0.01,
    `${grown} -> ${runs[0].fontSize}`,
  )
  check(
    'and no word was cut in half to make it fit',
    runs.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim() === SENTENCE,
    JSON.stringify(runs.map((r) => r.text)),
  )
}

console.log('\nand a corner still scales the type, wrap and all')
const corner2 = await anchorAt('bottom-right')
check('the corner handle is reachable', !!corner2)
if (corner2) {
  await page.mouse.move(Math.round(corner2.x), Math.round(corner2.y))
  await page.mouse.down()
  await page.mouse.move(Math.round(corner2.x + 60), Math.round(corner2.y + 45), { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const after = await textRuns()
  check('the corner grew the font', after[0].fontSize > grown + 0.5, `${grown} -> ${after[0].fontSize}`)
  // The pill reads the SELECTED box's own size, so a corner drag has to move
  // the number too — it used to show a global default that only coincided with
  // the box's real size right after it was placed.
  check(
    'and the size field followed the corner',
    Number(await sizeField.inputValue()) > Number(afterClick),
    `${afterClick} -> ${await sizeField.inputValue()}`,
  )
  check(
    'and the box is still wrapped, not back to one line',
    new Set(after.map((r) => r.y)).size > 1,
    JSON.stringify([...new Set(after.map((r) => r.y))]),
  )
}

// ── The exported file has to wrap where the screen did ──────────────────────
// Everything below runs inside the page, against the app's own modules over
// Vite's served paths. `page.evaluate` has no bundler resolution, so bare
// specifiers would fail — see office-import.e2e.mjs for the same note.
console.log('\nand a wrapped box bakes into the PDF as separate lines')
const baked = await page.evaluate(async (sentence) => {
  const { PDFDocument } = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js')
  const { buildAnnotatedPdfBytes } = await import('/src/lib/export.ts')
  const pdfjsLib = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs'

  const src = await PDFDocument.create()
  src.addPage([595, 842])
  const srcBytes = await src.save()

  const base = {
    id: 'wrap-test',
    pageIndex: 0,
    type: 'text',
    x: 60,
    y: 60,
    text: sentence,
    color: '#111111',
    fontSize: 16,
  }
  async function lines(annotation) {
    const bytes = await buildAnnotatedPdfBytes(srcBytes.slice(0).buffer, [annotation], 1)
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise
    const content = await (await doc.getPage(1)).getTextContent()
    // Baseline y of each drawn line, top of the page first.
    const rows = [...new Set(content.items.map((i) => Math.round(i.transform[5])))].sort((a, b) => b - a)
    return { rows, text: content.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim() }
  }
  return {
    unwrapped: await lines(base),
    wrapped: await lines({ ...base, wrapWidth: 140 }),
  }
}, SENTENCE)

check('the unwrapped box still bakes as one line', baked.unwrapped.rows.length === 1, JSON.stringify(baked.unwrapped.rows))
check('the wrapped one bakes as several', baked.wrapped.rows.length > 1, JSON.stringify(baked.wrapped.rows))
check(
  'the baked lines are a line-height apart',
  baked.wrapped.rows.length > 1 && Math.abs(baked.wrapped.rows[0] - baked.wrapped.rows[1] - 16 * 1.25) < 1,
  JSON.stringify(baked.wrapped.rows),
)
check(
  'and every word is still in the file',
  baked.wrapped.text.replace(/\s+/g, ' ') === SENTENCE,
  baked.wrapped.text,
)

await browser.close()
if (failures.length) {
  console.log(`\n${failures.length} failed:`)
  for (const f of failures) console.log(`  • ${f}`)
  process.exit(1)
}
console.log('\nAll good.')
