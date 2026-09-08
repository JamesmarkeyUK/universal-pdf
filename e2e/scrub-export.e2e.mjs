// "Strip metadata" in the Advanced export dialog, browser-level.
//
//   ./scripts/preview.sh             # or preview.ps1 — Universal PDF is :5174
//   npm run test:scrub-export        # in another terminal
//
// What is pinned (owner, 2026-09-08: "Add scrub metadata to the advanced export
// popup too", then "any reason not to scrub the metadata by default? ... so we
// are privacy first"):
//
//   • The DEFAULT export strips the author, title and producer from the
//     downloaded file. Nothing is ticked to get this.
//   • Ticking "Keep metadata" brings them back — the control run below, without
//     which the first check proves nothing.
//   • The OPEN document keeps its own metadata either way. That is the whole
//     difference between this and Advanced ▸ Document metadata ▸ Strip, and it
//     is what the checkbox's caption promises.
//
// ⚠️ READ THE METADATA BACK WITH pdf-lib, never by searching the bytes. The
// export saves with object streams, so the Info dictionary is inside a
// compressed stream: a `bytes.includes('Jane Confidential')` check comes back
// false on the UNSCRUBBED file too, and reports a passing test for a feature
// that does nothing. (Observed, 2026-09-08, before the control was added.)
//
// ⚠️ THE ACTIONS MENU OPENS ON HOVER. A Playwright click opens it on the way in
// and then toggles it shut — see the same note in actions-menu.e2e.mjs.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'

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

const AUTHOR = 'Jane Confidential'
const TITLE = 'Internal draft'
const PRODUCER = 'Secret Producer 1.0'

const { PDFDocument, StandardFonts } = await import('pdf-lib')

async function testPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.setAuthor(AUTHOR)
  doc.setTitle(TITLE)
  doc.setProducer(PRODUCER)
  const page = doc.addPage([595, 842])
  page.drawText('Scrub metadata test', { x: 60, y: 760, size: 16, font })
  return Buffer.from(await doc.save())
}

const playwright = await loadPlaywright()
const browser = await playwright.chromium.launch()
const pdf = await testPdf()

// One pass of the whole flow. `keep` decides whether the box gets ticked, so
// the two runs differ in exactly one click.
async function exportOnce(keep) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  })
  await context.addInitScript(() => {
    window.localStorage.setItem('universal:mock_session', 'james')
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push('page error: ' + e.message))

  try {
    await page.goto(`${BASE}?mockauth=1`, { waitUntil: 'load' })
  } catch {
    console.error(`Could not reach ${BASE} — start the dev server first (npm run dev).`)
    await browser.close()
    process.exit(2)
  }

  await page.setInputFiles('input[type=file]', { name: 'scrub.pdf', mimeType: 'application/pdf', buffer: pdf })
  await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
  await page.waitForTimeout(700)

  // ⚠️ The Advanced section REMEMBERS whether it was open. Clicking it blind
  // the second time round collapses it, and every row underneath disappears —
  // so expand only when it is actually closed.
  async function openAdvanced() {
    await page.hover('button[aria-label$="Profile"]')
    await page.waitForTimeout(400)
    const section = page.locator('button:visible').filter({ hasText: 'Advanced' }).first()
    if ((await section.getAttribute('aria-expanded')) !== 'true') {
      await section.click()
      await page.waitForTimeout(300)
    }
  }

  await openAdvanced()
  await page.locator('button:visible').filter({ hasText: 'Advanced export' }).first().click()
  await page.waitForSelector('h2:has-text("Advanced export")', { timeout: 5000 })
  await page.waitForTimeout(800)

  if (keep) {
    await page.click('text=Keep metadata')
    await page.waitForTimeout(300)
  }

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Download")'),
  ])
  const bytes = await readFile(await download.path())
  const out = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false })

  // What the OPEN document still says about itself, read back through the
  // dialog that reports it rather than from any internal state.
  await openAdvanced()
  await page.locator('button:visible').filter({ hasText: 'Document metadata' }).first().click()
  await page.waitForSelector('h2:has-text("Document metadata")', { timeout: 5000 })
  await page.waitForTimeout(700)
  const shown = (await page.locator('div.fixed').last().innerText()).replace(/\s+/g, ' ')

  await context.close()
  return {
    author: out.getAuthor() ?? null,
    title: out.getTitle() ?? null,
    producer: out.getProducer() ?? null,
    size: bytes.length,
    stillOpenWith: shown,
    errors,
  }
}

console.log('\nan ordinary export strips the metadata from the downloaded file')
const stripped = await exportOnce(false)
check('no author', stripped.author === null, JSON.stringify(stripped.author))
check('no title', stripped.title === null, JSON.stringify(stripped.title))
check('no producer', stripped.producer === null, JSON.stringify(stripped.producer))
check(
  'and the open document keeps its own',
  stripped.stillOpenWith.includes(AUTHOR),
  'the editor lost the metadata too — this must only affect the exported copy',
)

// ⚠️ THE CONTROL. Without it the checks above pass on a build where the
// checkbox does nothing at all.
console.log('\nticking "Keep metadata" keeps it, which is what makes the above mean anything')
const kept = await exportOnce(true)
check('the author is still there', kept.author === AUTHOR, JSON.stringify(kept.author))
check('the title is still there', kept.title === TITLE, JSON.stringify(kept.title))
check('the producer is still there', kept.producer === PRODUCER, JSON.stringify(kept.producer))

for (const e of [...stripped.errors, ...kept.errors]) failures.push(e)

console.log('')
if (failures.length) {
  console.log(`${failures.length} FAILED:`)
  for (const f of failures) console.log(`  • ${f}`)
} else {
  console.log('All checks passed.')
}
await browser.close()
process.exit(failures.length ? 1 : 0)
