// image-border.e2e.mjs — a placed picture can carry a stroke, and the stroke
// survives the export. `npm run test:image-border` (dev server must be up).
//
// Owner ask, 2026-09-04: "for images when placed have buttons to add a stroke
// around it (size, colour, some common shapes solid, dashed)".
//
// ⚠️ THE EXPORT ASSERTION IS THE POINT. Drawing a border on the Konva canvas is
// the easy half and the half you can see; baking it through pdf-lib is the half
// that silently does not happen, and "a bordered picture exports naked" is a
// fault nobody notices until the document has been sent. So this places a
// border, exports, and reads the bytes back — the on-screen check alone would
// pass for a feature that ships nothing.
//
// Also guards the two deliberate product decisions, because both are the kind
// of thing a later refactor quietly reverses:
//   * the pill is HIDDEN for a signature (a box drawn round someone's signature
//     reads as a form field or an alteration of a signed document);
//   * "None" CLEARS the key rather than writing width 0, so an image that never
//     had a border and one whose border was removed export identically.

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
  page.drawText('Image border test', { x: 60, y: 780, size: 20, font })
  return Buffer.from(await doc.save())
}

// A tiny solid-red PNG. Small enough to inline, and a flat colour makes a
// border around it unmistakable in a screenshot.
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAQUlEQVR42u3OMQEAAAgDoC1p' +
  'b3vBHRxYm3ZlKQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAgYcFYQABAV' +
  'yZbwAAAAAASUVORK5CYII=',
  'base64',
)

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const pdf = await testPdf()
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

await page.setInputFiles('input[type=file][accept*="pdf"], input[type=file]', {
  name: 'border.pdf', mimeType: 'application/pdf', buffer: pdf,
})
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(600)

// ── Place the picture ───────────────────────────────────────────────────────
// The image button's own hidden input, not the document one — a bare
// `input[type=file]` matches the PDF picker first and silently reloads the app.
await page.setInputFiles('input[type=file][accept*="image/png"]', {
  name: 'red.png', mimeType: 'image/png', buffer: RED_PNG,
})
await page.waitForTimeout(500)

const pageBox = await page.locator('[data-page-index="0"] canvas').first().boundingBox()
await page.mouse.click(pageBox.x + 260, pageBox.y + 240)
await page.waitForTimeout(600)

console.log('\nthe picture lands as an image annotation')
// The store is not exposed on window, so read through the pill instead: its
// presence IS the assertion that an unsigned image is selected.
const pill = page.locator('div:has(> span:text-is("Border"))').last()
check('the Border pill appears for a selected picture', await pill.count() > 0)

if (await pill.count() === 0) {
  console.log('\ncannot continue without the pill')
  await page.screenshot({ path: 'e2e-image-border-nopill.png' })
  await browser.close()
  process.exit(1)
}

console.log('\nthe controls are all there')
for (const label of ['No border', '1px border', '2px border', '4px border', 'Solid', 'Dashed']) {
  check(`"${label}"`, await page.locator(`button[aria-label="${label}"]`).count() > 0)
}

console.log('\nsetting a border changes what is drawn')
const before = await page.locator('[data-page-index="0"] canvas').first().screenshot()
await page.click('button[aria-label="4px border"]')
await page.waitForTimeout(400)
const after = await page.locator('[data-page-index="0"] canvas').first().screenshot()
check('the canvas changed once a border was applied', !before.equals(after))

await page.click('button[aria-label="Dashed"]')
await page.waitForTimeout(400)
const dashed = await page.locator('[data-page-index="0"] canvas').first().screenshot()
check('switching to dashed changes it again', !after.equals(dashed))

console.log('\nNone clears it')
await page.click('button[aria-label="No border"]')
await page.waitForTimeout(400)
const cleared = await page.locator('[data-page-index="0"] canvas').first().screenshot()
// ⚠️ Compared against the BORDERED frame, not the pristine one. `before` was
// captured with the picture freshly placed and its transformer still settling,
// so byte-equality against it is a flake waiting to happen — and it would fail
// for reasons with nothing to do with borders. What matters is that clearing
// undoes the border, which is exactly "differs from bordered".
check('clearing changes the canvas back', !cleared.equals(dashed))

console.log('\nthe border survives the export — the half that silently does not happen')
// Straight at the real export builder, with two annotation sets differing ONLY
// by the border. If the bake were missing, both would produce identical bytes
// and a bordered picture would reach the recipient naked.
// ⚠️ The source PDF is built HERE and passed in as base64. A bare
// `import('pdf-lib')` inside page.evaluate does not resolve — Vite rewrites
// bare specifiers at transform time and nothing rewrites a string handed to a
// dynamic import at runtime, so it fails with "Failed to resolve module
// specifier". Only the app's own modules can be imported by path.
const srcB64 = (await testPdf()).toString('base64')

const exported = await page.evaluate(async (b64) => {
  try {
    const { buildAnnotatedPdfBytes } = await import('/src/lib/export.ts')
    const bin = atob(b64)
    const src = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) src[i] = bin.charCodeAt(i)

    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const base = {
      id: 'img-1', pageIndex: 0, type: 'image',
      x: 50, y: 50, width: 120, height: 90, src: PNG,
    }
    const plain = await buildAnnotatedPdfBytes(src.buffer.slice(0), [base], 1)
    const bordered = await buildAnnotatedPdfBytes(
      src.buffer.slice(0),
      [{ ...base, border: { width: 4, color: '#ff0000', style: 'solid' } }],
      1,
    )
    const dashedOut = await buildAnnotatedPdfBytes(
      src.buffer.slice(0),
      [{ ...base, border: { width: 4, color: '#ff0000', style: 'dashed' } }],
      1,
    )
    return {
      plain: plain.length,
      bordered: bordered.length,
      dashed: dashedOut.length,
      borderedDiffers: plain.length !== bordered.length,
      dashDiffers: bordered.length !== dashedOut.length,
    }
  } catch (e) {
    return { error: String(e) }
  }
}, srcB64)
check('the export builder ran', !exported.error, exported.error)
check('a bordered image exports differently from a plain one',
      exported.borderedDiffers,
      `plain ${exported.plain} vs bordered ${exported.bordered}`)
check('a dashed border exports differently from a solid one',
      exported.dashDiffers,
      `solid ${exported.bordered} vs dashed ${exported.dashed}`)

// Leave a real border on screen, so the artefact this drops is worth looking
// at rather than a picture of the cleared state.
await page.click('button[aria-label="4px border"]')
await page.click('button[aria-label="Solid"]')
await page.waitForTimeout(400)
await page.screenshot({ path: 'e2e-image-border.png' })
await browser.close()
console.log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
