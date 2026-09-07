// Tapping a shape tool has to leave a shape behind — and the contextual pills
// have to carry a colour.
//
//   ./scripts/preview.sh              # or preview.ps1 — Universal PDF is :5174
//   npm run test:shape-tap            # in another terminal
//
// What is pinned (owner, 2026-09-05):
//
//   • "Same issue for circle drawing, if single tapping show a generic circle
//     they can modify / Rectangle too" — the Line tool's tap fix, applied to
//     Box and Circle. Both used to throw a tap away (`if (w > 4 && h > 4)`),
//     leaving the page untouched and the tool looking dead.
//   • "The stroke popup also should show a couple of colours with it e.g.
//     black, white, colour wheel" and "Same for text toolbar" — the floating
//     pills carry two swatches and a wheel, and they repaint the annotation
//     they are attached to, not just the default for the next one.
//   • "The preset stamps lose a lot of quality on stretch" — the stamp raster
//     is supersampled, so its pixel size is a multiple of its logical 240x96.
//
// ⚠️ Redact is deliberately NOT covered: it keeps the old discard-a-tap guard,
// because a black block appearing at a guessed size over text is not the
// harmless default an outline is, and James named Line, Circle and Rectangle.
// If that is ever changed, this file is where the case belongs.
//
// Negative control (2026-09-05, run): with the rect/ellipse hunk in
// AnnotationLayer reverted to `if (w > 4 && h > 4)`, the six tap checks go red
// and the drag + colour + stamp cases stay green.

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
  console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
  await browser.close()
  process.exit(2)
}

await page.setInputFiles('input[type=file]', { name: 'shapes.pdf', mimeType: 'application/pdf', buffer: pdf })
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(700)

// Every annotation shape Konva is holding, in stage (screen) pixels. Annotation
// nodes carry an id; Transformer chrome and the line grabbers do not.
//
// ⚠️ A text annotation is a GROUP of per-run Text nodes and the id is on the
// group, not on the runs — the runs are how bold/italic/underline/link can vary
// within one box. So the id is taken from the node or its parent; reading
// `node.id()` alone finds every other annotation and silently no text at all.
const shapes = () =>
  page.evaluate(() => {
    const K = window.Konva
    if (!K || !K.stages) return { error: 'no Konva global on window' }
    const out = []
    for (const stage of K.stages) {
      const s = stage.scaleX() || 1
      const r = (n) => Math.round(n * s * 100) / 100
      const idOf = (n) => {
        // Walk ALL the way up, not one level: a text annotation's runs sit
        // inside an inner group (the one a resize counter-scales), so the id is
        // two parents away, and a single hop silently finds no text at all.
        for (let p = n; p; p = p.getParent()) {
          const id = p.id ? p.id() : ''
          if (id) return id
        }
        return ''
      }
      for (const node of stage.find('Shape')) {
        if (!idOf(node)) continue
        const cls = node.getClassName()
        if (cls === 'Ellipse') {
          out.push({ cls, id: idOf(node), cx: r(node.x()), cy: r(node.y()), w: r(node.radiusX() * 2), h: r(node.radiusY() * 2), stroke: node.stroke() })
        } else if (cls === 'Rect') {
          out.push({ cls, id: idOf(node), x: r(node.x()), y: r(node.y()), w: r(node.width()), h: r(node.height()), stroke: node.stroke() })
        } else if (cls === 'Line') {
          const p = node.points() || []
          out.push({ cls, id: idOf(node), x: r(p[0]), y: r(p[1]), w: r((p[2] ?? 0) - p[0]), h: r((p[3] ?? 0) - p[1]), stroke: node.stroke(), points: p.length })
        } else if (cls === 'Text') {
          out.push({ cls, id: idOf(node), x: r(node.x()), y: r(node.y()), fill: node.fill(), text: node.text() })
        }
      }
    }
    return { shapes: out }
  })

const drawBtn = page.locator('button[title^="Free draw"]:visible').first()
// Placing a shape auto-selects it, and the toolbar closes the options panel so
// it doesn't cover the shape's own controls — so the panel is reopened for
// every tool rather than once.
async function armShape(title) {
  const btn = page.locator(`button[title="${title}"]:visible`).first()
  for (let attempt = 0; attempt < 3 && !(await btn.count()); attempt++) {
    await drawBtn.click()
    await page.waitForTimeout(250)
  }
  if (!(await btn.count())) return false
  await btn.click()
  await page.waitForTimeout(300)
  return true
}

const pageCanvas = page.locator('[data-page-index="0"] canvas').first()
const pageBox = await pageCanvas.boundingBox()
const tapAt = async (dx, dy) => {
  await page.mouse.move(Math.round(pageBox.x + dx), Math.round(pageBox.y + dy))
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(450)
}

// ── Circle ──────────────────────────────────────────────────────────────────
console.log('\na single tap with the Circle tool leaves a circle')
check('the Circle tool is reachable', await armShape('Circle'))
await tapAt(180, 150)
const afterCircle = (await shapes()).shapes ?? []
const circle = afterCircle.find((n) => n.cls === 'Ellipse')
check('a circle landed on the page', !!circle, JSON.stringify(afterCircle))
check(
  'it is big enough to see, and round rather than an oval',
  !!circle && circle.w > 80 && circle.w < 220 && Math.abs(circle.w - circle.h) < 1,
  circle && `${circle.w} x ${circle.h}`,
)
check(
  'and it is centred on the tap',
  !!circle && Math.abs(circle.cx - 180) < 2 && Math.abs(circle.cy - 150) < 2,
  circle && `centre ${circle.cx},${circle.cy} vs tap 180,150`,
)

// ── Rectangle ───────────────────────────────────────────────────────────────
console.log('\nand a tap with the Box tool leaves a box')
check('the Box tool is reachable', await armShape('Box'))
await tapAt(400, 150)
const afterRect = (await shapes()).shapes ?? []
const rect = afterRect.find((n) => n.cls === 'Rect' && n.w > 40)
check('a box landed on the page', !!rect, JSON.stringify(afterRect.filter((n) => n.cls === 'Rect')))
check(
  'it is a landscape box, not a square or a sliver',
  !!rect && rect.w > 120 && rect.w < 260 && rect.h > 80 && rect.h < 180 && rect.w > rect.h,
  rect && `${rect.w} x ${rect.h}`,
)
check(
  'and it is centred on the tap',
  !!rect && Math.abs(rect.x + rect.w / 2 - 400) < 2 && Math.abs(rect.y + rect.h / 2 - 150) < 2,
  rect && `centre ${rect.x + rect.w / 2},${rect.y + rect.h / 2} vs tap 400,150`,
)

// ── A tap near the edge is pulled back on-page ──────────────────────────────
// Centring on the tap alone would hang half the shape off an A4 sheet, which is
// the one case where a "generic shape to modify" is no use at all.
console.log('\nand a tap near the edge shuffles back onto the page')
check('the Box tool can be re-armed', await armShape('Box'))
await tapAt(Math.round(pageBox.width) - 8, 260)
const edgeRect = ((await shapes()).shapes ?? [])
  .filter((n) => n.cls === 'Rect' && n.w > 40)
  .sort((a, b) => b.x - a.x)[0]
check(
  'the box is wholly on the page, not hanging off the right edge',
  !!edgeRect && edgeRect.x >= -0.5 && edgeRect.x + edgeRect.w <= pageBox.width + 0.5,
  edgeRect && `x ${edgeRect.x} + w ${edgeRect.w} vs page width ${Math.round(pageBox.width)}`,
)
check(
  'and it is flush with that edge rather than pushed to the middle',
  !!edgeRect && Math.abs(edgeRect.x + edgeRect.w - pageBox.width) < 2,
  edgeRect && `right edge ${edgeRect.x + edgeRect.w} vs page width ${Math.round(pageBox.width)}`,
)

// ── A swept box is unchanged ────────────────────────────────────────────────
// The regression this change could most easily cause: the default hijacking a
// deliberate drag.
console.log('\na dragged box is still exactly the box that was swept out')
check('the Box tool can be re-armed', await armShape('Box'))
const dx = Math.round(pageBox.x + 120)
const dy = Math.round(pageBox.y + 420)
await page.mouse.move(dx, dy)
await page.mouse.down()
await page.mouse.move(dx + 140, dy + 60, { steps: 5 })
await page.mouse.move(dx + 300, dy + 130, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(450)
const swept = ((await shapes()).shapes ?? []).find(
  (n) => n.cls === 'Rect' && Math.abs(n.x - 120) < 3 && Math.abs(n.y - 420) < 3,
)
check('the swept box is on the page', !!swept, 'no Rect at the drag origin')
check(
  'and it is the size that was dragged, not the default',
  !!swept && Math.abs(swept.w - 300) < 3 && Math.abs(swept.h - 130) < 3,
  swept && `${swept.w} x ${swept.h}`,
)

// ── The line pill's colours ─────────────────────────────────────────────────
console.log('\nthe line pill can repaint the line it is attached to')
check('the Line tool is reachable', await armShape('Line'))
await tapAt(300, 620)
const beforeColor = ((await shapes()).shapes ?? []).find((n) => n.cls === 'Line' && n.points === 4)
check('a line landed', !!beforeColor)
check('and it starts in the toolbar colour', beforeColor?.stroke === '#000000', beforeColor?.stroke)
// The pill floats under the line. Both pills use the same cluster, so the
// aria-labels are the addressable part.
await page.locator('button[aria-label="White"]:visible').first().click()
await page.waitForTimeout(400)
const whiteLine = ((await shapes()).shapes ?? []).find((n) => n.cls === 'Line' && n.points === 4)
check('clicking White repaints THIS line', whiteLine?.stroke === '#ffffff', whiteLine?.stroke)
await page.locator('button[aria-label="Black"]:visible').first().click()
await page.waitForTimeout(400)
const blackLine = ((await shapes()).shapes ?? []).find((n) => n.cls === 'Line' && n.points === 4)
check('and Black puts it back', blackLine?.stroke === '#000000', blackLine?.stroke)
check(
  'the wheel is there too, for anything not on the two swatches',
  (await page.locator('input[type="color"]:below(:text("Stroke"))').count()) > 0 ||
    (await page.locator('label[title="More colours"]:visible').count()) > 0,
)

// ── The text pill's colours ─────────────────────────────────────────────────
console.log('\nand the text pill carries the same cluster')
await page.locator('button[title^="Add text"]:visible').first().click()
await page.waitForTimeout(250)
await tapAt(140, 700)
await page.keyboard.type('Paid in full')
await page.waitForTimeout(350)

// ⚠️ Clicking the pill mid-edit must not blur the editor — that is what the
// preventDefault on the pill's mousedown is for, and losing focus here would
// commit the text half-typed.
await page.locator('button[aria-label="White"]:visible').first().click()
await page.waitForTimeout(400)
check(
  'the editor keeps focus when the pill is clicked mid-edit',
  (await page.locator('textarea:visible, [contenteditable="true"]:visible').count()) > 0,
)

// ⚠️ Now commit before reading the canvas: while the editor is open the text is
// a DOM overlay, so Konva has nothing to measure and a check made here would
// pass or fail for the wrong reason.
await page.locator('button[title^="Select / move"]:visible').first().click()
await page.waitForTimeout(500)
const texts = ((await shapes()).shapes ?? []).filter((n) => n.cls === 'Text')
check(
  'and the committed text really is white',
  texts.some((t) => t.fill === '#ffffff'),
  JSON.stringify(texts),
)

// The commoner path: a text box that is merely SELECTED, not being edited.
await page.mouse.click(pageBox.x + 150, pageBox.y + 700)
await page.waitForTimeout(400)
await page.locator('button[aria-label="Black"]:visible').first().click()
await page.waitForTimeout(400)
const backToBlack = ((await shapes()).shapes ?? []).filter((n) => n.cls === 'Text')
check(
  'and a selected (not edited) text box repaints too',
  backToBlack.some((t) => t.fill === '#000000'),
  JSON.stringify(backToBlack),
)

// ── Stamp resolution ────────────────────────────────────────────────────────
console.log('\na preset stamp is rasterised well above its placed size')
await page.locator('button[title^="Sign — place"]:visible').first().click()
await page.waitForTimeout(400)
await page.locator('button:has-text("STAMPS")').first().click()
await page.waitForTimeout(400)
await page.locator('button:has-text("Preset stamps")').first().click()
await page.waitForTimeout(600)
await page.locator('button:has-text("APPROVED")').first().click()
await page.waitForTimeout(700)
const raster = await page.evaluate(() => {
  const img = document.querySelector('[data-placement-hint] img')
  if (!img) return null
  return { w: img.naturalWidth, h: img.naturalHeight, chars: (img.getAttribute('src') || '').length }
})
check('the armed stamp is on screen', !!raster, 'no preview in the placement card')
check(
  'and its raster is a multiple of the 240x96 logical stamp, not 1:1',
  !!raster && raster.w >= 240 * 3 && raster.h === Math.round((raster.w * 96) / 240),
  raster && `${raster.w}x${raster.h}`,
)
check(
  'the aspect ratio is unchanged, so it still places at the same size',
  !!raster && Math.abs(raster.w / raster.h - 240 / 96) < 0.01,
  raster && `${(raster.w / raster.h).toFixed(3)} vs ${(240 / 96).toFixed(3)}`,
)

await browser.close()

console.log('')
if (failures.length) {
  console.log(`${failures.length} check(s) failed:`)
  for (const f of failures) console.log(`  • ${f}`)
  process.exit(1)
}
console.log('All checks passed.')
