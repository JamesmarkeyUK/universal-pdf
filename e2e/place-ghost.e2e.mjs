// The picture that follows the cursor while a QR code or an image is armed,
// browser-level.
//
//   ./scripts/preview.sh             # or preview.ps1 — Universal PDF is :5174
//   npm run test:place-ghost         # in another terminal
//
// What is pinned (owner, 2026-09-08: "when placing a QR code show a preview QR
// that follows the mouse, same as the signature does" / "same for the image
// placement"):
//
//   • With a QR armed, moving over the page DRAWS something on the annotation
//     canvas — the preview — and moving further MOVES it, rather than leaving
//     it where it first appeared or stacking a second copy.
//   • The same holds for an uploaded image, which arms the same tool and lands
//     the same way.
//   • It is the size the drop will be, so the preview is a promise about what
//     lands rather than a decoration: within a pixel or two of the placed
//     annotation's own box.
//   • It goes when the placement does — an armed-looking page after the code is
//     down would be worse than no preview at all.
//
// ⚠️ WHY PIXELS, NOT THE DOM. Konva draws to a canvas, so the preview has no
// element to query — every assertion here reads `getImageData` off the
// annotation canvas and works out where the ink is. That also means the
// PlacementHint card floating over the page is irrelevant to these checks: it
// is DOM, and never lands in the canvas's own bitmap.
//
// Negative control (2026-09-08, run): with the ImageGhost render disabled in
// AnnotationLayer, three checks go red — both QR ones and the image one — and
// the canvas stays empty until the click that places the code. The size and
// "stops following" checks stay green either way, which is the point of not
// resting on them: they are satisfied by the PLACED annotation.

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

async function testPdf(label) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  page.drawText(label, { x: 60, y: 780, size: 20, font })
  return Buffer.from(await doc.save())
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const pdf = await testPdf('Ghost placement test')
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
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

await page.setInputFiles('input[type=file]', { name: 'ghost.pdf', mimeType: 'application/pdf', buffer: pdf })
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(600)

const pageCanvas = page.locator('[data-page-index="0"] canvas').first()
const pageBox = await pageCanvas.boundingBox()

// The annotation canvas is Konva's, the LAST canvas in the page container —
// the first is the rendered PDF, which is opaque everywhere and would answer
// "is there ink here" with yes on every pixel.
//
// Returns the bounding box of every non-transparent pixel, in canvas pixels,
// or null when the layer is completely empty.
async function inkBox(fromY = 0) {
  return page.evaluate((fromY) => {
    const canvases = document.querySelectorAll('[data-page-index="0"] canvas')
    const c = canvases[canvases.length - 1]
    if (!c) return null
    const ctx = c.getContext('2d', { willReadFrequently: true })
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0
    for (let y = Math.max(0, fromY); y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          count++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (count === 0) return null
    return { minX, minY, maxX, maxY, count, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, canvasW: c.width }
  }, fromY)
}

// Canvas pixels per CSS pixel — the Konva stage is drawn at device resolution,
// so a 60px mouse move is not a 60px move in the bitmap.
async function pixelRatio() {
  const r = await page.evaluate(() => {
    const canvases = document.querySelectorAll('[data-page-index="0"] canvas')
    const c = canvases[canvases.length - 1]
    return c ? c.width / c.getBoundingClientRect().width : 1
  })
  return r || 1
}

// A point well inside the page, for the before-anything-is-armed check. The two
// the preview is actually measured at are worked out below, once the hint card
// exists and its position is known.
const IDLE = { x: pageBox.x + pageBox.width * 0.32, y: pageBox.y + 200 }

// ── Nothing armed, nothing drawn ────────────────────────────────────────────
console.log('\nan unarmed page draws no preview')
await page.mouse.move(IDLE.x, IDLE.y)
await page.waitForTimeout(250)
check('the annotation layer is empty before anything is armed', (await inkBox()) === null)

// ── A QR armed for placement previews under the cursor ──────────────────────
console.log('\na QR code armed for placement follows the mouse')
await page.click('button[title="Add a QR code"]')
await page.waitForSelector('h2:has-text("Add a QR code")', { timeout: 5000 })
await page.fill('input[placeholder="https://example.com"]', 'https://unisim.co.uk')
await page.waitForTimeout(900)
await page.click('button:has-text("Add to page")')
await page.waitForTimeout(800)

// ⚠️ HOVER CLEAR OF THE HINT CARD — do not dismiss it. The card floats over the
// middle of the document, and its two buttons are the one part of it that DOES
// take pointer events: a hover landing on one never reaches the Konva stage, so
// the preview looks broken when it is only being covered.
//
// The obvious fix is to press "Don't show again", and it is WRONG. Since
// 2026-09-08 that preference follows the user between devices, so pressing it
// here turns the card off for the mock account for good — and
// placement-hint.e2e.mjs, whose whole job is to check that the card appears,
// then fails for a reason nothing in its own file explains. (Done once,
// diagnosed, undone.) Hover in the band above the card instead.
const card = await page.locator('[data-placement-hint]').first().boundingBox()
const bandTop = pageBox.y + 60
const bandBottom = card.y - 20
check(
  'there is room above the hint card to hover in',
  bandBottom - bandTop > 120,
  `only ${Math.round(bandBottom - bandTop)}px between the page top and the card`,
)
const P1 = { x: pageBox.x + pageBox.width * 0.32, y: bandTop + (bandBottom - bandTop) * 0.3 }
const P2 = { x: pageBox.x + pageBox.width * 0.62, y: bandTop + (bandBottom - bandTop) * 0.7 }

await page.mouse.move(P1.x, P1.y)
await page.waitForTimeout(300)
const qrAt1 = await inkBox()
check('moving over the page draws a preview', qrAt1 !== null, 'the annotation canvas is still empty')

await page.mouse.move(P2.x, P2.y)
await page.waitForTimeout(300)
const qrAt2 = await inkBox()
check('and it is still there after moving', qrAt2 !== null)

if (qrAt1 && qrAt2) {
  const ratio = await pixelRatio()
  const wantDx = (P2.x - P1.x) * ratio
  const wantDy = (P2.y - P1.y) * ratio
  const gotDx = qrAt2.cx - qrAt1.cx
  const gotDy = qrAt2.cy - qrAt1.cy
  check(
    'it follows the cursor rather than staying put',
    Math.abs(gotDx - wantDx) < 6 && Math.abs(gotDy - wantDy) < 6,
    `cursor moved ${Math.round(wantDx)},${Math.round(wantDy)} but the ink moved ${Math.round(gotDx)},${Math.round(gotDy)}`,
  )
  check(
    'and one preview, not a trail of them',
    Math.abs((qrAt2.maxX - qrAt2.minX) - (qrAt1.maxX - qrAt1.minX)) < 6,
    `${qrAt1.maxX - qrAt1.minX}px wide, then ${qrAt2.maxX - qrAt2.minX}px`,
  )
  check(
    'it is centred on the cursor, the way the drop is',
    Math.abs(qrAt2.cx - (P2.x - pageBox.x) * ratio) < 8 &&
      Math.abs(qrAt2.cy - (P2.y - pageBox.y) * ratio) < 8,
    `ink centre ${Math.round(qrAt2.cx)},${Math.round(qrAt2.cy)} vs cursor ${Math.round((P2.x - pageBox.x) * ratio)},${Math.round((P2.y - pageBox.y) * ratio)}`,
  )
}

// ── The preview is the size of what lands ───────────────────────────────────
console.log('\nthe preview is a promise about what lands')
const previewW = qrAt2 ? qrAt2.maxX - qrAt2.minX : 0
await page.mouse.click(P2.x, P2.y)
await page.waitForTimeout(700)
const placed = await inkBox()
check('the click places the code', placed !== null)
if (placed && previewW) {
  const placedW = placed.maxX - placed.minX
  check(
    'at the size the preview showed',
    Math.abs(placedW - previewW) < 6,
    `preview ${Math.round(previewW)}px wide, placed ${Math.round(placedW)}px`,
  )
}
// Moving away must not leave a second preview behind: the tool disarmed itself
// on the drop, so the ink count should not grow.
await page.mouse.move(P1.x, P1.y)
await page.waitForTimeout(300)
const afterPlace = await inkBox()
check(
  'and the preview stops following once it is down',
  afterPlace !== null && Math.abs(afterPlace.cx - placed.cx) < 4,
  afterPlace ? `ink centre moved to ${Math.round(afterPlace.cx)} from ${Math.round(placed.cx)}` : 'canvas empty',
)

// ── The same for an uploaded image ──────────────────────────────────────────
//
// Measured in a BAND OF THE PAGE BELOW THE PLACED QR, not on a fresh document.
// The QR is ink on the same canvas and a box drawn round both says nothing
// about where the preview alone is — and starting over does not help, because
// reopening brings the annotations back with it. Worse, the naive version of
// this check passed whether the preview existed or not: the second hover point
// sat inside the placed QR's own footprint, so the union box did not move.
console.log('\nan uploaded image previews the same way')
const BAND_TOP = 560

// Solid magenta 120×80 PNG, built in the page so there is no fixture to keep.
const pngBytes = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 120
  c.height = 80
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#d946ef'
  ctx.fillRect(0, 0, 120, 80)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
})

check('the band below the placed QR starts out empty', (await inkBox(BAND_TOP)) === null)

await page.setInputFiles('input[type=file][accept*="image"]', {
  name: 'ghost.png',
  mimeType: 'image/png',
  buffer: Buffer.from(pngBytes),
})
await page.waitForTimeout(700)

const ratio = await pixelRatio()
const Q1 = { x: pageBox.x + pageBox.width * 0.32, y: pageBox.y + 650 / ratio }
const Q2 = { x: pageBox.x + pageBox.width * 0.55, y: pageBox.y + 730 / ratio }

await page.mouse.move(Q1.x, Q1.y)
await page.waitForTimeout(300)
const imgAt1 = await inkBox(BAND_TOP)
check('moving over the page draws the image preview', imgAt1 !== null, 'nothing drawn below the placed QR')

await page.mouse.move(Q2.x, Q2.y)
await page.waitForTimeout(300)
const imgAt2 = await inkBox(BAND_TOP)
if (imgAt1 && imgAt2) {
  const gotDx = imgAt2.cx - imgAt1.cx
  const gotDy = imgAt2.cy - imgAt1.cy
  const wantDx = (Q2.x - Q1.x) * ratio
  const wantDy = (Q2.y - Q1.y) * ratio
  check(
    'and the image preview follows the cursor too',
    Math.abs(gotDx - wantDx) < 6 && Math.abs(gotDy - wantDy) < 6,
    `cursor moved ${Math.round(wantDx)},${Math.round(wantDy)} but the ink moved ${Math.round(gotDx)},${Math.round(gotDy)}`,
  )
  // A solid rectangle, so its ink box IS the placement box: the 200px-wide cap
  // the drop uses, and the 120×80 picture's own shape.
  check(
    'at the size and shape the drop will be',
    Math.abs((imgAt2.maxX - imgAt2.minX) - 200 * ratio) < 8 &&
      Math.abs((imgAt2.maxY - imgAt2.minY) - (200 * 80 / 120) * ratio) < 8,
    `${Math.round(imgAt2.maxX - imgAt2.minX)}×${Math.round(imgAt2.maxY - imgAt2.minY)} canvas px, expected ~${Math.round(200 * ratio)}×${Math.round((200 * 80 / 120) * ratio)}`,
  )
}

console.log('')
if (failures.length) {
  console.log(`${failures.length} FAILED:`)
  for (const f of failures) console.log(`  • ${f}`)
} else {
  console.log('All checks passed.')
}
await browser.close()
process.exit(failures.length ? 1 : 0)
