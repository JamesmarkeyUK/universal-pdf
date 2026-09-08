// The "tap to place" indicator, browser-level.
//
//   ./scripts/preview.sh             # or preview.ps1 — Universal PDF is :5174
//   npm run test:placement-hint      # in another terminal
//
// What is pinned (owner, 2026-08-30: "need an indicator to show that you need to
// tap to place the signature / name / date, or QR code for example, otherwise
// you're not sure what to do"):
//
//   • Saving a signature, or "Add to page" in the QR dialog, closes the dialog
//     and leaves an ARMED tool with nothing on screen saying so. The banner is
//     the only thing that distinguishes that state from the one before it.
//   • It names what is about to land — signature vs QR code vs the next of the
//     name/details/date pieces — because the four states look identical.
//   • It goes when the thing lands, not on a timer.
//   • ⚠️ It must NOT eat the tap it is asking for. It floats over the page, so
//     everything but its buttons is pointer-events:none — a placement made
//     THROUGH THE MIDDLE OF THE CARD is the assertion for that, since a
//     lookalike CSS check would pass on a card whose child re-enabled events.
//
// And since 2026-09-05 (owner: "needs to be more prominent - maybe in the
// centre of the screen, with a don't show again option"):
//
//   • It is a card in the MIDDLE of the document area, not a pill at the top.
//     The click-through assertion above matters far more now that the card sits
//     exactly where the user is aiming.
//   • "Don't show again" hides it for good (localStorage) and, unlike Cancel,
//     leaves the placement ARMED — it is a display preference, not a way out.
//
// Negative control (2026-08-30, run): with `<PlacementHint />` taken back out of
// App.tsx, the four QR checks go red and the run then ABORTS at Cancel — there
// is no banner to click, so the locator times out rather than reporting the rest.
// That is the control doing its job; it is not a flake.

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
  page.drawText('Placement hint test', { x: 60, y: 780, size: 20, font })
  return Buffer.from(await doc.save())
}

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

await page.setInputFiles('input[type=file]', { name: 'hint.pdf', mimeType: 'application/pdf', buffer: pdf })
await page.waitForSelector('[data-page-index="0"] canvas', { timeout: 30000 })
await page.waitForTimeout(500)

// Any of the banner's wordings — the extras one says "where the … should go".
const anyBanner = page.locator('[role="status"] button:has-text("Cancel")').first()
const bannerText = async () =>
  (await anyBanner.count()) ? (await anyBanner.locator('xpath=../..').innerText()).replace(/\s+/g, ' ').trim() : ''

// ⚠️ READ THE PREFERENCE THE WAY THE APP WRITES IT. It used to be a
// localStorage flag of this app's own; since 2026-09-08 it is a synced user
// pref (`@unisim/sdk`'s userPrefs), whose local mirror is one JSON blob under
// `unisim:prefs:<app>`. The old key is never written any more, so the two
// assertions that read it went red without anything being broken — a test
// telling the truth about a key nobody uses.
async function dismissedInPrefs() {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith('unisim:prefs:')) continue
      try {
        if (JSON.parse(localStorage.getItem(k) || '{}').placementHintDismissed === true) return true
      } catch {
        /* not ours */
      }
    }
    return false
  })
}

const pageCanvas = page.locator('[data-page-index="0"] canvas').first()
const pageBox = await pageCanvas.boundingBox()

// ── Start from defaults ─────────────────────────────────────────────────────
// ⚠️ THIS TEST DISMISSES THE CARD FOR GOOD, and since 2026-09-08 that
// preference is SYNCED to the account rather than kept in this browser. So a
// run leaves the next one starting with the card already off, and "a card is up
// again" fails — on a second run of a suite that passed the first time, with
// nothing in the app broken. Reset defaults (Actions ▸ Advanced) is the app's
// own way back, and clearing localStorage would not do: the synced value would
// simply come back down.
await page.hover('button[aria-label$="Profile"]')
await page.waitForTimeout(400)
const advanced = page.locator('button:visible').filter({ hasText: 'Advanced' }).first()
if ((await advanced.getAttribute('aria-expanded')) !== 'true') {
  await advanced.click()
  await page.waitForTimeout(300)
}
await page.locator('button:visible').filter({ hasText: 'Reset defaults' }).first().click()
await page.waitForTimeout(1200)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// ── Nothing armed, nothing said ─────────────────────────────────────────────
console.log('\nthe banner only exists while something is armed')
check('no banner with a freshly opened document', (await anyBanner.count()) === 0)

// ── A plain tool is not an armed payload ────────────────────────────────────
// Owner, 2026-09-04: the Text hint is "not needed - it's expected", and of the
// tick/cross ones "i don't want them to". Picking a tool and clicking the page
// to use it is not a state anybody has to be told about; the banner is for a
// payload that is armed and INVISIBLE. Text is the one driven here because it
// has its own toolbar button — tick and cross share the branch that was removed
// with it.
console.log('\npicking a plain tool says nothing')
await page.click('button[title^="Add text"]:visible')
await page.waitForTimeout(500)
check(
  'the Text tool is on',
  ((await page.locator('button[title^="Add text"]:visible').getAttribute('class')) ?? '').includes(
    'bg-orange-700',
  ),
)
check('and puts up no banner', (await anyBanner.count()) === 0, await bannerText())
// Back to Select, so the sections below start where they used to.
await page.click('button[title^="Select"]:visible')
await page.waitForTimeout(300)

// ── A QR armed for placement announces itself ───────────────────────────────
console.log('\n"Add to page" in the QR dialog arms a placement, and says so')
await page.click('button[title="Add a QR code"]')
await page.waitForSelector('h2:has-text("Add a QR code")', { timeout: 5000 })
await page.fill('input[placeholder="https://example.com"]', 'https://unisim.co.uk')
await page.waitForTimeout(900)
await page.click('button:has-text("Add to page")')
await page.waitForTimeout(1200)

check('the QR dialog closes', (await page.locator('h2:has-text("Add a QR code")').count()) === 0)
const qrText = await bannerText()
check('a banner appears', qrText.length > 0, 'nothing with a Cancel button on screen')
check('it says a QR code is what lands', /QR code/.test(qrText), qrText)
check('it names the gesture', /click|tap/i.test(qrText), qrText)
check(
  'and shows what is about to be placed',
  (await page.locator('[role="status"] img').count()) === 1,
  'no thumbnail in the banner',
)

// ── Cancel really disarms ───────────────────────────────────────────────────
console.log('\nCancel is a way out of the armed state')
await anyBanner.click()
await page.waitForTimeout(400)
check('the banner goes', (await anyBanner.count()) === 0)
const armedAfterCancel = await page.evaluate(() => {
  const img = document.querySelector('label[title="Upload and place an image"]')
  return img ? (img.className || '').includes('bg-orange-700') : null
})
check('the picture tool is no longer lit', armedAfterCancel === false, `class check gave ${armedAfterCancel}`)
// A click on the page after cancelling must place nothing.
await page.mouse.click(pageBox.x + pageBox.width * 0.5, pageBox.y + 260)
await page.waitForTimeout(500)
check('and clicking the page places nothing', (await anyBanner.count()) === 0)

// ── The signature, and the name/date pieces after it ────────────────────────
console.log('\na saved signature arms a placement, and each extra piece is named')
await page.click('button[aria-label="Sign"]')
await page.click('button:has-text("+ Draw new")')
await page.waitForSelector('button:has-text("Advanced options")', { timeout: 5000 })

const padDialog = page.locator('div.fixed.inset-0:has-text("Advanced options")').first()
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
await page.click('label:has-text("Add your details")')
await page.waitForTimeout(200)
await page.locator('textarea[aria-label="Details to show under the signature"]').fill('Jane Smith\nHead of Testing')
await page.waitForTimeout(200)
await page.click('label:has-text("Add date")')
await page.waitForTimeout(200)
await page.click('button:has-text("Separate click")')
await page.waitForTimeout(150)
await padDialog.locator('button:has-text("Save")').click()
await page.waitForTimeout(900)

const sigText = await bannerText()
check('the pad closes onto a banner', sigText.length > 0)
check('which says the signature is what lands', /signature/i.test(sigText), sigText)

// Drop the signature THROUGH the card. This is the pointer-events assertion:
// the card sits over the middle of the document area, so a click on it has to
// reach the page underneath.
//
// ⚠️ Measure the CARD (`[data-placement-hint]`), not the `[role="status"]`
// wrapper — the wrapper spans the whole document area in order to centre the
// card, so its own box says nothing about where the card actually is.
const bannerBox = await page.locator('[data-placement-hint]').first().boundingBox()
const shell = await page.locator('[role="status"]').first().boundingBox()
check(
  'the card floats over the document, not beside it',
  bannerBox.x > pageBox.x &&
    bannerBox.x + bannerBox.width < pageBox.x + pageBox.width &&
    bannerBox.y > pageBox.y,
  `card at ${Math.round(bannerBox.x)},${Math.round(bannerBox.y)} vs page ${Math.round(pageBox.x)},${Math.round(pageBox.y)}`,
)
check(
  'and sits in the middle of it rather than tucked against the top edge',
  Math.abs((bannerBox.y + bannerBox.height / 2) - (shell.y + shell.height / 2)) < 8,
  `card centre ${Math.round(bannerBox.y + bannerBox.height / 2)} vs area centre ${Math.round(shell.y + shell.height / 2)}`,
)
await page.mouse.click(bannerBox.x + bannerBox.width * 0.5, bannerBox.y + bannerBox.height * 0.5)
await page.waitForTimeout(600)

const afterDrop = await bannerText()
check(
  'a click through the banner still places the signature',
  /name/i.test(afterDrop),
  `banner now reads: ${afterDrop || '(gone)'}`,
)
check('and the queue is counted', /2 more/.test(afterDrop), afterDrop)

const seen = [afterDrop]
for (let i = 0; i < 3; i += 1) {
  await page.mouse.click(pageBox.x + 120 + i * 80, pageBox.y + 420 + i * 60)
  await page.waitForTimeout(400)
  seen.push(await bannerText())
}
check('the details line is named on its own turn', /details/i.test(seen[1]), seen[1])
check('and the date on its own turn', /date/i.test(seen[2]), seen[2])
check('the banner goes when the last piece lands', seen[3] === '', `still reads: ${seen[3]}`)

// ── "Don't show again" ──────────────────────────────────────────────────────
// Arm a QR code again (the shortest route back to a banner), then turn the card
// off for good and prove BOTH halves: the card goes, and the placement it was
// describing is still armed — the tap must still place a QR code.
console.log('\n"Don\'t show again" silences the card without disarming the placement')
await page.locator('button[title="Add a QR code"]').click()
await page.waitForTimeout(400)
await page.locator('input[type="text"], input[type="url"]').first().fill('https://unisim.co.uk')
await page.locator('button:has-text("Add to page")').click()
await page.waitForTimeout(700)
check('a card is up again', (await anyBanner.count()) > 0)

await page.locator('button:has-text("Don\'t show again")').click()
await page.waitForTimeout(400)
check('the card goes', (await anyBanner.count()) === 0)
check(
  'and the choice is remembered',
  await dismissedInPrefs(),
)

const before = await page.evaluate(() => {
  const K = window.Konva
  return (K?.stages ?? []).reduce((n, st) => n + st.find('Image').filter((i) => !!i.id()).length, 0)
})
await page.mouse.click(pageBox.x + pageBox.width * 0.5, pageBox.y + 300)
await page.waitForTimeout(700)
const after = await page.evaluate(() => {
  const K = window.Konva
  return (K?.stages ?? []).reduce((n, st) => n + st.find('Image').filter((i) => !!i.id()).length, 0)
})
check('the placement it was announcing is still armed', after === before + 1, `${before} -> ${after} images`)

// And it stays gone across a reload — the whole point of persisting it.
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(500)
check(
  'and it is still off after a reload',
  await dismissedInPrefs(),
)

await browser.close()

console.log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
