// Which link leaves the app — the rule behind the in-app browser.
//
//   npm run test:external-links
//
// Runs under Node's type-stripping with `ts-resolve.mjs`, so `externalLinks.ts`
// is imported directly. Its only static import is `nativeOpen.ts`, which itself
// imports nothing (every Capacitor plugin there is loaded dynamically) — the
// landmine `hostedPath.test.mjs` documents.
//
// What is being pinned (owner, 2026-09-06, iOS: About this app → the full
// credits link → back to the app → the dialog can no longer be closed). A
// `target="_blank"` in a Capacitor WebView backgrounds the whole app and hands
// the URL to Safari, and it is that round trip the dialog does not survive.
// `installExternalLinkHandler` cancels the click and opens an in-app browser
// instead, and THIS function is what decides which clicks it may take.
//
// Both directions matter and the second is the easy one to break:
//
//   • Too narrow and the bug comes back for the links it misses.
//   • Too WIDE and it breaks things that were never broken — an in-app browser
//     cannot render `mailto:` or `tel:` (iOS shows a blank sheet), and taking
//     over a same-origin href would put the app's own navigation in a sheet.
//
// Negative control (2026-09-06, run): dropping the protocol guard turns the
// mailto/tel/blob/data test red (1 of 5); dropping the origin comparison turns
// both same-origin tests red (2 of 5).

import assert from 'node:assert/strict'
import test from 'node:test'

import { isExternalHttpUrl } from '../src/lib/externalLinks.ts'

// The two origins the native shells actually serve the bundle from, plus the
// web build's own. The rule has to hold on all three.
const IOS = 'capacitor://localhost/index.html'
const ANDROID = 'https://localhost/index.html'
const WEB = 'https://opensource.unisim.co.uk/pdf/'

test('the links from the bug report are taken', () => {
  // The full-credits link the report names, and its neighbours in the dialog.
  const outward = [
    'https://github.com/universal-simulation-ltd/Universal_PDF/blob/main/THIRD-PARTY-NOTICES.md',
    'https://github.com/universal-simulation-ltd/Universal_PDF',
    'https://github.com/universal-simulation-ltd/Universal_PDF/issues',
    'https://changelog.unisim.co.uk',
    'https://unisim.co.uk/#contact',
    'http://example.com/a-plain-http-link',
  ]
  for (const href of outward) {
    assert.equal(isExternalHttpUrl(href, IOS), true, `iOS: ${href}`)
    assert.equal(isExternalHttpUrl(href, ANDROID), true, `Android: ${href}`)
  }
})

test('schemes an in-app browser cannot render are left to the OS', () => {
  // ⚠️ A PDF's own link annotation can carry either of the first two — see
  // LinkLayer. Handing them to Browser.open shows a blank sheet; left alone,
  // Capacitor passes them out and Mail or the dialler opens, which is what the
  // same link does in a browser.
  assert.equal(isExternalHttpUrl('mailto:someone@example.com', IOS), false)
  assert.equal(isExternalHttpUrl('tel:+441234567890', IOS), false)
  assert.equal(isExternalHttpUrl('blob:https://localhost/9f8c-4d', ANDROID), false)
  assert.equal(isExternalHttpUrl('data:text/plain,hello', ANDROID), false)
})

test('the app\'s own origin is navigation, not an outward link', () => {
  assert.equal(isExternalHttpUrl('https://localhost/privacy.html', ANDROID), false)
  assert.equal(isExternalHttpUrl('/index.html', ANDROID), false)
  assert.equal(isExternalHttpUrl('#a-fragment-on-this-page', ANDROID), false)
})

test('the web build treats its own site as internal and the rest as outward', () => {
  assert.equal(isExternalHttpUrl('https://opensource.unisim.co.uk/pdf/x', WEB), false)
  // A sibling subdomain is a different origin, and so is a plain-http twin.
  assert.equal(isExternalHttpUrl('https://unisim.co.uk/', WEB), true)
  assert.equal(isExternalHttpUrl('http://opensource.unisim.co.uk/pdf/', WEB), true)
})

test('a href that is not a URL is nobody\'s to take', () => {
  // `new URL()` throws on these rather than returning something to test, and
  // the answer has to be "leave it alone" rather than an exception thrown out
  // of a click handler.
  assert.equal(isExternalHttpUrl('', IOS), false)
  assert.equal(isExternalHttpUrl('http://', IOS), false)
  assert.equal(isExternalHttpUrl('https://example.com', 'not-a-url'), false)
})
