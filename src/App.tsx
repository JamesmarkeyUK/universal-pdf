import { useEffect, useState } from 'react'
import {
  ToolbarDesktopActions,
  ToolbarDesktopTools,
  ToolbarMobile,
  useToolbarKeyboardShortcuts
} from './components/Toolbar/Toolbar'
import PdfViewer from './components/Viewer/PdfViewer'
import PageNavigator from './components/Viewer/PageNavigator'
import PlacementHint from './components/Viewer/PlacementHint'
import SignaturePad from './components/Signature/SignaturePad'
import StampPicker from './components/Signature/StampPicker'
import SignatureImport from './components/Signature/SignatureImport'
import LandingPage from './components/Landing/LandingPage'
import LivePreview from './components/Preview/LivePreview'
import PresentMode from './components/Present/PresentMode'
import ProductLogo from './components/Header/ProductLogo'
import ToolbarUserProfile from './components/Header/ToolbarUserProfile'
import FileMenu from './components/Toolbar/FileMenu'
import HostedStoreDialog from './components/HostedStoreDialog'
import SendToSignDialog from './components/SendToSignDialog'
import OcrModal from './components/Ocr/OcrModal'
import MergeDialog from './components/Convert/MergeDialog'
import ConvertDialog from './components/Convert/ConvertDialog'
import AdvancedExportDialog from './components/Export/AdvancedExportDialog'
import MetadataDialog from './components/Metadata/MetadataDialog'
import QrDialog from './components/Qr/QrDialog'
import MobileWelcomeToast from './components/Onboarding/MobileWelcomeToast'
import UnsavedChangesDialog from './components/Exit/UnsavedChangesDialog'
import LockedFilePrompt from './components/Lock/LockedFilePrompt'
import { UniversalAppsNavBar, UniversalBar, ChangelogMenu, DropAnywhere, useFileDrop } from '@unisim/sdk'

// What this copy of the app is, for the changelog panel's footer and the
// landing footer. Support's first question is "which build are you on?", and
// the changelog's own version chip cannot answer it — that one is the live
// feed's latest release, identical on every install however old.
//
// The platform is half the answer: the same bundle is the website, the
// installed desktop app and the phone PWA, and they update on entirely
// different schedules.
const APP_BUILD_LABEL = (() => {
  const version = `Universal PDF ${__APP_VERSION__}`
  if (typeof window === 'undefined') return version
  const desktop = !!window.desktop
  const ua = navigator.userAgent
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua)
      ? 'macOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad/i.test(ua)
          ? 'iOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : ''
  return `${version} · ${[os, desktop ? 'desktop' : 'web'].filter(Boolean).join(' ')}`
})()

// Apply the saved language to <html lang> on first mount.
import { persistLang, readSavedLang } from './lib/lang'
if (typeof document !== 'undefined') {
  document.documentElement.lang = readSavedLang()
  // Re-run persist (no-op if unchanged) so this stays in sync if the
  // user clears storage between sessions.
  persistLang(readSavedLang())
}
import { usePdfStore } from './stores/pdfStore'
import { useSignatureStore } from './stores/signatureStore'
import { useAnnotationStore } from './stores/annotationStore'
import { useFormStore } from './stores/formStore'
import { useExitGuard } from './stores/exitGuard'
import { hasUnsavedChanges, onSavedStateChanged } from './lib/unsavedChanges'
import { CONTAINER } from './lib/layout'
import { OfficeImportError, toViewablePdf } from './lib/officeToPdf'
import { isNativeShell, setStatusBarOverDarkChrome, subscribeNativeOpenPdf } from './lib/nativeOpen'
import { installExternalLinkHandler } from './lib/externalLinks'

const REPO_URL = 'https://github.com/universal-simulation-ltd/Universal_PDF'

// The document's rendered width, clamped exactly as the viewer clamps it
// (`PdfViewer` publishes `--doc-display-width` from page 1's viewport), and the
// empty margin to the right of it — the strip of grey between the page's right
// edge and the window.
//
// ⚠️ Every term here is load-bearing, so do not "simplify" it:
//   • `100vw` and not `100%` — a percentage inside a grid cell resolves against
//     the CELL, and this cell is one `1fr` of three.
//   • `--doc-scrollbar-width` — the page is centred inside the viewer's scroll
//     box, which is narrower than the window by its scrollbar. The bar carries
//     the same padding for the same reason.
//   • `0.75rem` is the row's own `px-3`, which sits between the strip's right
//     edge and the window, so it comes off. Nothing else does: the strip now
//     STARTS at the page's edge and holds Export itself, so no gap between
//     Export and what follows it is in the measurement any more.
const DOC_WIDTH = 'clamp(600px, var(--doc-display-width, 80rem), 80rem)'
const DOC_RIGHT_STRIP = `max(0px, calc((100vw - var(--doc-scrollbar-width, 0px) - ${DOC_WIDTH}) / 2 - 0.75rem))`


export default function App() {
  const loadFile = usePdfStore((s) => s.loadFile)
  const doc = usePdfStore((s) => s.doc)
  const loading = usePdfStore((s) => s.loading)
  // See `firstPaint` in the store: the placeholder stays up over the empty page
  // frames until page 1 has drawn (or the store's grace period gives up), so a
  // document opened from the OS goes loading → document rather than
  // loading → outlines → document.
  const firstPaint = usePdfStore((s) => s.firstPaint)
  const refreshRecents = usePdfStore((s) => s.refreshRecents)
  const loadFromCurrentUrl = usePdfStore((s) => s.loadFromCurrentUrl)

  const ocrOpen = usePdfStore((s) => s.ocrOpen)
  const setOcrOpen = usePdfStore((s) => s.setOcrOpen)
  const mergeOpen = usePdfStore((s) => s.mergeOpen)
  const setMergeOpen = usePdfStore((s) => s.setMergeOpen)
  const convertOpen = usePdfStore((s) => s.convertOpen)
  const setConvertOpen = usePdfStore((s) => s.setConvertOpen)
  const advancedExportOpen = usePdfStore((s) => s.advancedExportOpen)
  const setAdvancedExportOpen = usePdfStore((s) => s.setAdvancedExportOpen)
  const metadataOpen = usePdfStore((s) => s.metadataOpen)
  const setMetadataOpen = usePdfStore((s) => s.setMetadataOpen)
  const sourceBytes = usePdfStore((s) => s.sourceBytes)
  const fileName = usePdfStore((s) => s.fileName)
  const importNotice = usePdfStore((s) => s.importNotice)
  const dismissImportNotice = usePdfStore((s) => s.dismissImportNotice)

  const requestExit = useExitGuard((s) => s.requestExit)

  // The currently-open document as a File, for the Advanced-menu dialogs that
  // start from it (Merge with another PDF, Convert into images). A fresh copy of
  // sourceBytes each time — pdf-lib / pdf.js detach the ArrayBuffer they consume.
  const currentDocFile =
    sourceBytes && fileName ? new File([sourceBytes.slice(0)], fileName, { type: 'application/pdf' }) : null

  const stampPickerOpen = useSignatureStore((s) => s.stampPickerOpen)

  // Electron adds `?launching=1` when the app was started by the OS handing it
  // a PDF (double-click / "Open with"). The file itself cannot arrive until the
  // bundle has loaded, so without this the first paint is the landing page —
  // which then vanishes. The user picked a document; show them a document
  // opening, not the front door on the way past.
  //
  // On iOS and Android there is no such flag to pass — the OS hands the file to
  // the native side, which can only be asked for it asynchronously — so a
  // native shell holds the loading state on every launch and releases it a
  // bridge round-trip later. A few milliseconds of "Loading PDF…" on an
  // ordinary launch is a better trade than the landing page appearing and
  // vanishing on a launch that did carry a document.
  const [launching, setLaunching] = useState(
    () => new URLSearchParams(window.location.search).has('launching') || isNativeShell()
  )

  // While the launch file is in flight the app is heading for the document
  // view, so it wears that view's chrome. Half the flash was the landing page's
  // navbar and footer, not just its body.
  const showLanding = !doc && !launching

  useToolbarKeyboardShortcuts(!!doc)

  useEffect(() => {
    refreshRecents()
    // If we landed on /#abc12345, try to reopen that PDF straight from
    // IndexedDB so a refresh restores the editor state.
    loadFromCurrentUrl().catch(() => {})
    function onHashChange() {
      loadFromCurrentUrl().catch(() => {})
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [refreshRecents, loadFromCurrentUrl])

  // Desktop (Electron) only — PDFs opened via the OS ("Open with → Universal
  // PDF" / double-click) arrive from the main process as bytes. Load them
  // straight away so the app opens onto the document, not the landing page.
  useEffect(() => {
    const desktop = window.desktop
    if (!desktop) return
    const offOpen = desktop.onOpenPdf(({ name, bytes }) => {
      const file = new File([bytes], name, { type: 'application/pdf' })
      loadFile(file)
        .catch((err) => {
          console.error(err)
          alert('Failed to load PDF')
        })
        // Cleared only once the load has settled: dropping it the moment the
        // bytes arrive would hand one frame back to the landing page before
        // the store's own `loading` picks up — the same flash, one step later.
        .finally(() => setLaunching(false))
    })
    const offNone = desktop.onNoPdf(({ unreadable }) => {
      setLaunching(false)
      if (unreadable) alert(`Could not open ${unreadable}`)
    })
    return () => {
      offOpen()
      offNone()
    }
  }, [loadFile])

  // Web only — an INSTALLED PWA registered as a `.pdf` handler (Chromium
  // desktop) is handed the file on `launchQueue`, the browser's equivalent of
  // the IPC message above. The manifest's `file_handlers.action` carries the
  // same `?launching=1`, so this path holds the loading state from the first
  // paint too.
  //
  // ⚠️ `isNativeShell()` is the guard, NOT `window.launchQueue`. Android's
  // WebView has no launchQueue, so this effect used to fall straight into the
  // `!queue` branch below and `setLaunching(false)` on mount — clearing, one
  // tick after the first paint, the very hold `isNativeShell()` had just put
  // up. The landing page then showed on EVERY native launch, including one
  // carrying a document, which is the "it only opened the front page" half of
  // the WhatsApp report. On native the effect below owns the placeholder.
  useEffect(() => {
    if (window.desktop || isNativeShell()) return
    const queue = window.launchQueue
    if (!queue) {
      // No file handling here at all, so a `?launching=1` that reached this
      // page (a bookmark, a shared link) must not strand it on the placeholder.
      setLaunching(false)
      return
    }
    queue.setConsumer((params) => {
      const handle = params.files?.[0]
      if (!handle) {
        setLaunching(false)
        return
      }
      handle
        .getFile()
        .then((file) => loadFile(file))
        .catch((err) => {
          console.error(err)
          alert('Failed to load PDF')
        })
        .finally(() => setLaunching(false))
    })
  }, [loadFile])

  // ⚠️ Native only, and it must be installed for the WHOLE session rather than
  // by the components that own the links: nearly every external link in the app
  // belongs to an `@unisim/sdk` dialog or to a PDF's own link annotations. See
  // `lib/externalLinks.ts` for why leaving the app at all is the bug.
  useEffect(() => installExternalLinkHandler(), [])

  // iOS / Android — a PDF opened through the share sheet or the chooser. Same
  // shape as the two paths above: a file turns up, or word that none is coming.
  useEffect(() => {
    if (window.desktop || !isNativeShell()) return
    let unsubscribe: (() => void) | null = null
    let cancelled = false
    void subscribeNativeOpenPdf(
      (file) => {
        loadFile(file)
          .catch((err) => {
            console.error(err)
            alert('Failed to load PDF')
          })
          .finally(() => setLaunching(false))
      },
      () => setLaunching(false)
    ).then((off) => {
      if (cancelled) off()
      else unsubscribe = off
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [loadFile])

  // ⚠️ Backstop for the browser and native paths. The PWA's consumer fires when
  // the browser has launch parameters and stays silent when it does not, so a
  // `?launching=1` opened by hand would otherwise wait on a file that is never
  // coming; on iOS/Android it catches a bridge that never answers. The desktop
  // needs no equivalent — its main process says so explicitly over `no-pdf`.
  useEffect(() => {
    if (!launching || window.desktop) return
    const timer = window.setTimeout(() => setLaunching(false), 3000)
    return () => window.clearTimeout(timer)
  }, [launching])

  // Keep the system clock/battery legible against whichever chrome is at the
  // top right now — dark strip with a document open, the SDK bar's white
  // surface on the landing page. See `setStatusBarOverDarkChrome`.
  useEffect(() => {
    void setStatusBarOverDarkChrome(!showLanding)
  }, [showLanding])

  // ── Leaving a document that has amendments ───────────────────────────────
  // Three ways out, one question. `requestExit` runs its action outright when
  // there is nothing unsaved, so these are guards rather than prompts.

  // Desktop (Electron): the main process holds the window's × until the
  // renderer has answered, and it can only do that if it knows there is
  // something to ask about. Push the answer on every change — including a save,
  // which changes it without touching either store (hence `onSavedStateChanged`).
  useEffect(() => {
    const bridge = window.desktop?.unsaved
    if (!bridge) return
    const push = () => bridge.set(!!usePdfStore.getState().doc && hasUnsavedChanges())
    push()
    const offs = [
      useAnnotationStore.subscribe(push),
      useFormStore.subscribe(push),
      usePdfStore.subscribe(push),
      onSavedStateChanged(push),
      // The window is closing for real — main asks, the popup answers, and
      // `allowClose` is what lets the close through the second time.
      bridge.onCloseRequest(() => requestExit('quit', () => bridge.allowClose()))
    ]
    return () => offs.forEach((off) => off())
  }, [requestExit])

  // Web: a browser tab can only be stopped by `beforeunload`, and only with the
  // browser's own wording — no three-button popup exists for it.
  //
  // ⚠️ Deliberately NOT registered in the desktop app. Electron does not show a
  // dialog for `beforeunload`; it just silently refuses to close the window, so
  // this would cancel the close before the popup above was ever asked for and
  // the × would look broken.
  useEffect(() => {
    if (window.desktop) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!usePdfStore.getState().doc || !hasUnsavedChanges()) return
      e.preventDefault()
      // Chromium still wants the legacy assignment to raise the prompt.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Drop a PDF anywhere on the page and it opens — the SDK's `pageWide`, not the
  // hand-rolled `window` listener this used to be. That copy predated the hook
  // and carried the whole of its cost: a depth counter, a bubble-phase drop
  // handler, and a SECOND capture-phase one whose only job was to clear the
  // overlay after a zone stopped the event so one file was not loaded twice. All
  // three now live once, in `useFileDrop`, which skips any drop that landed
  // inside a `data-unisim-dropzone` instead of asking the zone to stop the event.
  //
  // This one covers the OPEN DOCUMENT only. The landing page runs its own
  // page-wide zone around the drop circle (see `Landing/LandingPage.tsx`), and
  // `disabled` here hands the page to it — the hook picks the last-mounted zone
  // that isn't disabled, and the landing page mounts inside this component.
  //
  // Merge and Convert take a file of their own while a document is open, so the
  // page belongs to the dialog rather than the viewer behind it.
  const dialogOwnsDrop = mergeOpen || convertOpen
  const pageDrop = useFileDrop({
    onFiles: async (files) => {
      const file = files[0]
      if (!file) return
      // A page-wide target takes whatever lands on it; `accept` only ever
      // filtered the picker, and there is no picker here — so `toViewablePdf`
      // does the checking, converting a Word or OpenDocument file on the way
      // through and refusing anything else with a message worth reading.
      // Dropping onto an open document replaces it, so it is an exit like any
      // other — the guard runs the load once the user has answered.
      requestExit('open-another', async () => {
      try {
        const { file: pdf, notice } = await toViewablePdf(file)
        await loadFile(pdf, { notice })
      } catch (err) {
        console.error(err)
        alert(err instanceof OfficeImportError ? err.message : 'Failed to load PDF')
      }
      })
    },
    clickToBrowse: false,
    pageWide: true,
    disabled: !doc || dialogOwnsDrop,
  })
  // ⚠️ `pageOver` goes true for any page drag whether or not this zone is
  // disabled — the hook lights every page-wide zone and only checks `disabled`
  // when deciding who TAKES the file. Promising a drop that will not be taken is
  // a lie, so the hint is gated on the same condition.
  const showDropHint = pageDrop.pageOver && !!doc && !dialogOwnsDrop

  return (
    // ⚠️ pt-[env(safe-area-inset-top)] is for the native (Capacitor) builds, not
    // the web one. Capacitor runs the app in a FULL-SCREEN WKWebView / Android
    // WebView, so without it the top bar renders underneath the iOS status bar
    // and Dynamic Island — "Universal PDF" sitting on top of the clock, which is
    // exactly what the first simulator run showed. In a browser the inset is 0,
    // so this is a no-op on the web and on desktop.
    //
    // It lives here rather than in @unisim/sdk's UniversalAppsNavBar because
    // that bar is shared by every Universal App, and the padding belongs to
    // whichever of them is wrapped for a phone — currently only this one.
    <div className="flex flex-col h-full bg-slate-100">
      {/* ⚠️ THE NOTCH SPACER IS DARK ON PURPOSE, and the reason is the system
          clock rather than taste. Android and iOS draw the status bar's own
          clock/signal/battery glyphs over whatever the app paints up there,
          and nothing in this app chooses their colour — there is no
          @capacitor/status-bar here, so the icons are whatever the platform
          decided at install time, which on Android is WHITE. This strip used
          to be the shell's `bg-slate-100`, so a white clock sat on a near-white
          band and simply vanished (measured on a Nothing Phone, Android 16).

          slate-900 is not an arbitrary dark: it is exactly what sits directly
          under this strip whenever a document is open — the UniversalBar strip
          and the tools bar are both `bg-slate-900` — so the chrome now reads as
          one unbroken bar from the top of the screen. On the landing page the
          navbar below is white (BAR.light.surface), so there the strip reads as
          a deliberate status band instead. Either way the glyphs are legible,
          which is the thing that was broken.

          It is a flow child rather than padding on the shell because padding
          takes its parent's background and the parent has to stay light. */}
      <div
        aria-hidden="true"
        className="shrink-0 bg-slate-900"
        style={{ height: 'env(safe-area-inset-top)' }}
      />
      {showLanding && (
        // ⚠️ `relative z-50` is load-bearing, and it is what spares this app the
        // z-index trap the rest of the suite hit on 2026-08-30. The SDK's
        // UniversalAppsNavBar sets an inline `zIndex: 1000` on itself, which no
        // Tailwind class can outrank — elsewhere that put the bar on top of
        // open dialogs. Here the wrapper confines it to a z-50 stacking
        // context, so the app's own `fixed … z-50` dialogs tie with the WRAPPER
        // and win on document order.
        //
        // Which means the tie is what protects the dialogs: every dialog must
        // keep rendering AFTER this block in App's tree (they all live at the
        // bottom of the return), and nothing that must sit above the bar may
        // drop below z-50. Measured at 390x844 against the built app: a probe
        // box at z-40 is painted over by the bar, z-50 and above are not.
        <div className="relative z-50">
          <UniversalAppsNavBar
            product="pdf"
            productLogo={<ProductLogo />}
            suiteSwitcherIconSrc={`${import.meta.env.BASE_URL}unisim-icon.png`}
            contentClassName={CONTAINER}
          />
          {/* The SDK's <UpdateNotice /> ("new version — reload") used to sit
              here. Off for now with the other top banners (James,
              2026-08-27): no banner invites a reload; the PWA still updates
              itself on the next natural reload. */}
        </div>
      )}
      {/* The full navbar is landing-page only. While a doc is open we keep just
          the suite brand strip up top for cross-app visual continuity; profile
          + changelog move down into the dark tools bar below.

          The strip takes the colour of what it sits ON TOP OF, which here is
          the slate-900 tools bar — its gradient fades to transparent at both
          ends precisely so it can sit on either. On the shell's own bg-slate-100
          it read as a white sliver capping a black bar; on slate-900 the bar
          starts at the top of the window and the orange pulse is the only thing
          in it. The landing page keeps the light treatment, because what is
          under the bar there is a light page. */}
      {(doc || launching) && (
        <div className="bg-slate-900">
          <UniversalBar />
        </div>
      )}
      {doc && (
        <div className="bg-slate-900 text-white relative z-[45] overflow-x-auto" style={{ paddingRight: 'var(--doc-scrollbar-width, 0px)' }}>
          {/* No home button on this bar. Leaving an open document is
              Actions → File → Close PDF, in the profile pill at the far right —
              one control, one dropdown, matching the other Universal Apps. A
              second way out pinned to the far left (and a third inside the tool
              cluster on mobile) spent the bar's scarcest space on a control the
              menu already carries. Actions used to sit out here too, and moved
              into the same pill for the same reason. */}
          {/* ⚠️ This row spans the WINDOW, not the document. It used to be
              `mx-auto` + `min-w-max` capped at the document's width, which grew
              the row to fit the tools and then centred the overflow: the tools
              and Actions ended up shoulder to shoulder in the middle of the bar
              with empty black either side, and Actions hung past the document's
              right edge into the bargain. Aligning the two clusters to the
              PAGE's edges instead (a shrinkable gutter sized to the page margin)
              was tried next and is not what is wanted either — at a 75% zoom the
              page is only ~600px wide, so that still parks both clusters in the
              middle of a wide window.

              So: tools hard left, Actions hard right, one flexible gap between
              them. The bar is chrome for the window, and it now uses all of it.
              The page/zoom strip at the bottom of the viewer is the one that
              lines up with the document — that is deliberate, it carries
              document state (page count, name, zoom) rather than app controls. */}
          {/* ⚠️ Three columns with EXPLICIT `col-start-*`, not auto-placement.
              Both `ToolbarDesktopTools` and `ToolbarDesktopActions` are
              `hidden lg:flex`, and a `display:none` grid child is not placed at
              all — so on a phone auto-placement would slide whatever is left
              into column 1 and the layout would silently differ from the one you
              designed. Pinning each cell makes the two breakpoints the same
              structure with different cells filled.

              The outer columns are both `1fr`, which is what centres the tools:
              column 3's content (Sign, Export, Actions, the profile pill and the
              changelog icon) sets its width, and the equal `1fr` on column 1
              mirrors that width as empty space. */}
          <div className="w-full grid grid-cols-[1fr_auto_1fr] items-center gap-3 py-2 min-h-[52px] px-3">
            {/* Brand mark, phones and tablets only. Below lg the whole tool
                cluster moves to the bottom bar, leaving this end of the row
                empty — so on a phone the app's own name was nowhere on screen
                while a document was open. On lg+ the tools own the middle column
                and this one is the empty counterweight, hence lg:hidden.

                ⚠️ Deliberately NOT a link or a button. The comment above is
                explicit that this bar has no home control: leaving a document
                is Actions → File → Close PDF, one way out, and a second one
                hiding behind the logo is exactly what was removed. It is a
                label.

                The mark's own tile is #0f172a, which is bg-slate-900 — so it
                disappears into the bar and what reads is the white page and
                the orange fold, not a square sitting on a square. */}
            <span className="col-start-1 justify-self-start lg:hidden flex items-center gap-2 pl-1 select-none">
              <ProductLogo />
              <span className="text-sm font-semibold tracking-tight whitespace-nowrap">
                Universal PDF
              </span>
            </span>

            {/* The tools themselves — centred in the window on lg+, and nothing
                at all below it (they move to the bottom bar). */}
            <div className="col-start-2 justify-self-center flex items-center gap-2 [&>*]:shrink-0">
              <ToolbarDesktopTools />
            </div>
            {/* Profile + changelog previously lived in the top navbar; with
                that bar gone while viewing, they carry the whole of the
                document's chrome and sit at the end of this row.

                ⚠️ They must stay IN THE FLOW. They were once a second copy,
                absolutely positioned against the bar's right edge, while the row
                itself was centred at the document's width — and the two collided
                whenever the window was about as wide as the document (~1280px, a
                maximised window on a 13" screen): the pinned cluster painted
                straight over Actions and over the open Actions menu. As a grid
                cell they cannot overlap anything, and the width they take is
                also what sizes the empty column that centres the tools. */}
            <div className="col-start-3 flex items-center gap-2 [&>*]:shrink-0">
              {/* Export STARTS ON THE DOCUMENT'S RIGHT EDGE — it sits in the
                  grey strip beside the page rather than inside it (owner,
                  2026-08-29: a box drawn on the empty bar right of Export,
                  "just to the right of the alignment with the pdf edge").

                  It ENDED on that edge from 2026-08-25 until then, and before
                  that it floated in the middle of whatever the centred tools
                  left over. Same line, other side of it.

                  The anchor is still a sized box rather than any positioning of
                  Export: this strip is the page's right margin, so its LEFT
                  edge is the page's right edge at every zoom. Export leads the
                  strip; `ml-auto` on the profile cluster keeps that pinned to
                  the window's right where it has always been, and `pl-2` is the
                  "just to the right" — flush against the edge reads as a
                  misalignment rather than a decision.

                  ⚠️ `min-w-max` is the collision guard, and it is why this can
                  be anchored at all — the previous version refused to anchor
                  because a page as wide as the window would drive Export into
                  the profile pill. It cannot: the box never gets narrower than
                  the controls inside it, so once the margin runs out the box
                  stops shrinking and the `flex-1` spacer gives up its space
                  instead. Nothing overlaps; Export just stops moving right.
                  ⚠️ Export is INSIDE the box now, so it is inside that guard —
                  keep it there.

                  ⚠️ This cell must stay STRETCHED (no `justify-self`) — it
                  spans the whole right-hand `1fr`, which is also what keeps the
                  tool cluster on the window's centre line. */}
              <div aria-hidden="true" className="flex-1" />
              <div
                className="flex min-w-max items-center gap-2 pl-2"
                style={{ width: DOC_RIGHT_STRIP }}
              >
                <ToolbarDesktopActions />
                <div className="ml-auto flex items-center gap-2 [&>*]:shrink-0">
                  <ToolbarUserProfile actions={<FileMenu variant="rows" />} />
                  {/* The build this actually is, in the one panel that is
                      reachable with a document open. ⚠️ NOT the version chip in
                      the panel's header — that is the changelog FEED's latest
                      release, fetched live, and identical on every install
                      however old. */}
                  <ChangelogMenu
                    iconSrc={`${import.meta.env.BASE_URL}unisim-icon.png`}
                    productFilter="pdf"
                    appVersion={APP_BUILD_LABEL}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {doc && <ToolbarMobile />}
      {doc && <MobileWelcomeToast />}

      {/* Converted-from-Word notice. It sits in the flow above the viewer rather
          than floating over it: what it says changes how you should read the
          document, so it should not be something you dismiss by accident before
          reading, nor cover the first line of the page it is describing. */}
      {doc && importNotice && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900">
          <div className="mx-auto w-full max-w-5xl px-4 py-2 flex items-start gap-3 text-[13px]">
            <span aria-hidden="true">ℹ</span>
            <p className="flex-1">{importNotice}</p>
            <button
              type="button"
              onClick={dismissImportNotice}
              className="shrink-0 rounded px-2 py-0.5 hover:bg-amber-100 font-medium"
              aria-label="Dismiss conversion notice"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* When a PDF is open, isolate the viewer in its own stacking context so
          its positioned layers (Konva canvas, annotation/form overlays, the
          zoom menu) stay below the navbar — otherwise they bubble up to the
          root context and can paint over the navbar's open dropdowns. */}
      <main className={`flex-1 min-h-0 md:pb-0 relative ${doc ? 'pb-[calc(4rem_+_env(safe-area-inset-bottom))] z-0 isolate' : 'overflow-auto'}`}>
        {doc ? (
          /* ⚠️ PlacementHint is a sibling of the viewer, absolutely positioned
             against this `relative` <main> — so it floats at the top of the
             document area without being inside the viewer's own scroller (where
             it would scroll away from the state it is describing). */
          <>
            <PdfViewer />
            <PlacementHint />
          </>
        ) : loading || launching ? null : (
          <LandingPage />
        )}
        {/* ⚠️ AN OVERLAY OVER THE MOUNTED VIEWER, NOT A BRANCH INSTEAD OF IT —
            and that is the whole point. The store's `firstPaint` hold waits for
            page 1 to be PAINTED, and page 1 is painted by `PdfPage`, which only
            exists while `PdfViewer` is mounted. Rendering the placeholder
            *instead of* the viewer therefore made the hold unsatisfiable: the
            only thing that could ever release it was its own 1.2s deadline, and
            the viewer then mounted and drew its empty page frames afterwards —
            the exact stage the hold was added to hide, moved later rather than
            removed. Mounting the viewer underneath lets it rasterize behind the
            placeholder, so page 1 really has drawn (and, see `fittedDoc` in the
            viewer, drawn at its fit-to-screen zoom) by the time this lifts.
            Above every layer inside the viewer, including AnnotationLayer's own
            z-[100] dialogs, and bg-slate-100 because that is the shell colour
            this placeholder has always sat on. */}
        {(loading || launching || (doc && !firstPaint)) && (
          <div className="absolute inset-0 z-[120] bg-slate-100 flex items-center justify-center text-slate-500">
            Loading PDF…
          </div>
        )}
      </main>

      {showLanding && !loading && (
        <footer className="mt-auto border-t border-slate-200 bg-white">
          <div className={`${CONTAINER} py-4 flex flex-row items-center gap-3 sm:gap-4 text-xs text-slate-500`}>
            <div className="flex items-center gap-2">
              <span>
                With{' '}
                <span aria-hidden="true" className="text-orange-600">&hearts;</span>
                <span className="sr-only">love</span>{' '}
                from{' '}
                <a href="https://www.unisim.co.uk" target="_blank" rel="noreferrer" className="text-slate-700 hover:text-orange-700 underline-offset-2 hover:underline">
                  UNISIM.co.uk
                </a>
              </span>
              {/* The build you are actually running. The changelog cannot tell
                  you this: the SDK fetches it live from changelog.unisim.co.uk,
                  so a desktop app three versions behind still lists today's
                  entries. Diagnosing a stale install otherwise means Windows
                  Settings or the exe's properties — see how long it took to
                  establish which build was installed on 2026-08-27. */}
              <span className="text-slate-400 tabular-nums" title={APP_BUILD_LABEL}>
                v{__APP_VERSION__}
              </span>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Universal PDF on GitHub"
                title="View source on GitHub"
                className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="w-5 h-5"
                  aria-hidden="true"
                >
                  <path d="M12 .5C5.65.5.5 5.65.5 12.02c0 5.09 3.29 9.4 7.86 10.92.57.1.78-.25.78-.55 0-.27-.01-1-.02-1.96-3.2.69-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.95.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.08 0 4.42-2.69 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.21.66.79.55 4.57-1.52 7.86-5.83 7.86-10.92C23.5 5.65 18.35.5 12 .5z" />
                </svg>
                <span className="hidden sm:inline">GitHub</span>
              </a>
            </div>
          </div>
        </footer>
      )}

      {/* The suite's shared page-wide hint, replacing a per-app overlay. Same
          sentence, same orange, but now identical to the one Compress, Video and
          Signatures show — and it steps aside on its own over a drop zone, which
          the old copy could not do. */}
      <DropAnywhere
        show={showDropHint}
        title="Drop to open"
        hint="PDF files only — it replaces the document you have open"
        icon={<span aria-hidden="true">📄</span>}
      />


      <PageNavigator />
      <SignaturePad />
      <SignatureImport />
      {stampPickerOpen && <StampPicker />}
      <LivePreview />
      <PresentMode />
      <HostedStoreDialog />
      <SendToSignDialog />
      <QrDialog />
      {ocrOpen && sourceBytes && (
        <OcrModal
          sourceBytes={sourceBytes}
          fileName={fileName ?? 'document.pdf'}
          onClose={() => setOcrOpen(false)}
          onOpen={(file) => {
            loadFile(file).catch((err) => {
              console.error(err)
              alert('Failed to load searchable PDF')
            })
          }}
        />
      )}
      {/* Advanced-menu dialogs, seeded with the open document so they act on it. */}
      {mergeOpen && <MergeDialog initialFile={currentDocFile} onClose={() => setMergeOpen(false)} />}
      {convertOpen && (
        <ConvertDialog initialMode="pdf-to-images" initialPdf={currentDocFile} onClose={() => setConvertOpen(false)} />
      )}
      <AdvancedExportDialog open={advancedExportOpen} onClose={() => setAdvancedExportOpen(false)} />
      {metadataOpen && sourceBytes && (
        <MetadataDialog sourceBytes={sourceBytes} onClose={() => setMetadataOpen(false)} />
      )}
      {/* Last in the list and highest in the stack: the question about leaving
          has to be answerable whatever else is open on top of the document. */}
      <UnsavedChangesDialog />
      {/* Renders only when `pdfStore.lockedFile` is set — i.e. somebody opened
          a password-locked PDF and has not supplied the password yet. */}
      <LockedFilePrompt />
    </div>
  )
}
