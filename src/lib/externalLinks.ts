// External links inside the native (Capacitor) shells.
//
// ⚠️ WHY THIS EXISTS (owner, 2026-09-06, on iOS): open About this app, tap the
// full-credits link, come back to the app — and the dialog can no longer be
// closed. The X and a tap outside the card both do nothing, while the rest of
// the app still reacts normally. The only way out is to force-quit.
//
// The trigger is the ROUND TRIP, not the dialog. A plain `<a target="_blank">`
// in a Capacitor WebView never opens a tab: `WebViewDelegationHandler`'s
// `decidePolicyFor` sees an off-origin top-level navigation, cancels it, and
// calls `UIApplication.shared.open(url)` — which sends the whole app to the
// background and hands the URL to Safari. Coming back, the app is resumed and
// only its `position: fixed` layers are wrong; everything in normal flow is
// fine, which is exactly the split that was reported (the dialog's overlay and
// card are both `position: fixed`, the toolbar and the page are not).
//
// So this does not patch the dialog — nothing here knows about it. It removes
// the background/resume round trip that the failure needs, by opening external
// links in the IN-APP browser (`SFSafariViewController` on iOS, a Custom Tab on
// Android). The app stays foregrounded, the sheet has its own Done button, and
// the page underneath is never resumed from the background at all.
//
// ⚠️ It has to be a document-level CAPTURE listener rather than a prop on each
// link, because most of the links this covers are not ours to change: the About
// dialog, the privacy note, the changelog and the nav bar are all `@unisim/sdk`
// components that hard-code `<a target="_blank">`, and `LinkLayer` renders one
// per link annotation in the open PDF. One listener covers every one of them,
// including any added later.
//
// No-ops off a native shell. The web build keeps ordinary `target="_blank"`
// tabs, and Electron already routes these through `shell.openExternal` in
// `electron/main.cjs` — neither needs (or should get) an in-app browser.

import { isNativeShell } from './nativeOpen'

/**
 * True for a URL that should leave the app — an http(s) address that is not the
 * shell's own origin. `pageUrl` is passed in rather than read off `window` so
 * the rule is a pure function `scripts/externalLinks.test.mjs` can exercise.
 *
 * ⚠️ http(s) ONLY. `mailto:` and `tel:` reach here too (a PDF's link annotation
 * can carry either — see `LinkLayer`), and an in-app browser cannot render
 * them: iOS shows a blank sheet. Left alone they fall through to Capacitor,
 * which hands them to the OS and opens Mail or the dialler, which is what the
 * same link does in a browser. `blob:` and `data:` are likewise not ours.
 */
export function isExternalHttpUrl(href: string, pageUrl: string): boolean {
  let url: URL
  let page: URL
  try {
    page = new URL(pageUrl)
    url = new URL(href, pageUrl)
  } catch {
    // Not a URL we can reason about — leave it to the platform.
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  // The native shells serve the bundle from `capacitor://localhost` (iOS) or
  // `https://localhost` (Android), so a same-origin href is in-app navigation
  // and must not be sent out to a browser sheet.
  return url.origin !== page.origin
}

/**
 * Opens `url` in the in-app browser. Resolves to false when the plugin is not
 * there to do it.
 *
 * ⚠️ Dynamically imported, matching `nativeOpen.ts`: the Capacitor plugins must
 * never reach the web bundle, which has no use for them.
 */
async function openInAppBrowser(url: string): Promise<boolean> {
  try {
    const { Browser } = await import('@capacitor/browser')
    await Browser.open({ url })
    return true
  } catch (err) {
    console.error('Could not open the in-app browser:', err)
    return false
  }
}

/**
 * Routes external link clicks through the in-app browser inside the native
 * shells. Returns an unsubscribe function.
 *
 * Safe to call on every platform — off a native shell it attaches nothing.
 */
export function installExternalLinkHandler(): () => void {
  if (!isNativeShell()) return () => {}

  function onClick(e: MouseEvent) {
    // Someone ahead of us already dealt with it (a drag that was not a click,
    // in `LinkLayer`; a handler that opened its own dialog instead).
    if (e.defaultPrevented) return
    // Only a plain primary click opens a link at all.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

    const anchor = (e.target as Element | null)?.closest?.('a[href]')
    if (!(anchor instanceof HTMLAnchorElement)) return

    // `anchor.href` is the RESOLVED absolute URL; the attribute may be relative.
    const href = anchor.href
    if (!isExternalHttpUrl(href, window.location.href)) return

    // ⚠️ Cancel FIRST and synchronously. `openInAppBrowser` is async, and a
    // `preventDefault()` awaited behind a dynamic import lands after the event
    // has finished — Capacitor would already have backgrounded the app, which
    // is the whole thing this exists to stop.
    e.preventDefault()
    void openInAppBrowser(href).then((opened) => {
      if (opened) return
      // The plugin is missing or refused. Falling back to the platform's own
      // handling is worse than this bug but far better than a dead link: the
      // user is at least taken to the page they asked for.
      window.open(href, '_blank', 'noopener,noreferrer')
    })
  }

  // ⚠️ CAPTURE. A bubble-phase listener never sees a click inside a component
  // that stops propagation on its own container — which the About dialog's card
  // does (`onClick: (e) => e.stopPropagation()`, so a click on a link inside it
  // does not reach the overlay and close the dialog). That is precisely the
  // link this bug was reported against.
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
