# Universal PDF

> Universal PDFs that just work — free and open source PDF viewer + editor.

> Open source — self-host free or PRO hosted by UNI SIM.

A clean Progressive Web App for viewing, annotating, and signing PDFs — works on Windows, macOS, iOS, and Android in any modern browser, with no upload to a server. Files stay on your device.

**[Try the live app →](https://pdf.unisim.co.uk/)**

## Features

- **View** multi-page PDFs with zoom (50%–300%), pinch-to-zoom on touch, and a thumbnail navigator
- **Open Word and OpenDocument files** — drop a `.docx` or `.odt` on the circle and it is converted to a PDF *on your device* (nothing is uploaded), then opens ready to annotate and sign. Headings, bold/italic, bulleted and numbered lists, tables and links all come across as real, selectable text. The page layout is re-typeset rather than copied, so fonts, columns, headers/footers and floating shapes will differ — the app says so when it opens one. Word 97–2003 `.doc` is not supported; save it as `.docx` first
- **Select text** — the *Select text* tool (in the Select ▾ menu) lets you drag over the PDF's own text and copy it (Ctrl/⌘C). Or just **double-click a word** with the *Select* tool and it switches over and highlights that word for you, ready to copy — no dragging, and double-clicking blank page or one of your own annotations leaves the tool alone
- **Follow links** — a PDF's own hyperlinks are clickable. Web links open in a new tab (so the document you're working on stays put), and a link to another part of the same document jumps to that page. Links go inert while a drawing tool is in hand, so a highlight dragged across one still draws
- **Make searchable (OCR)** — turn a scanned / image-only PDF into a searchable, selectable one *entirely on your device* (no upload). Find, copy and redact-by-search then work. The OCR engine downloads once on first use, then works offline
- **Annotate** with free draw, text, rectangles, ticks, and crosses, in any of six colours
- **Redact** — drag a box over anything and the text underneath is *destroyed* when you export, not just covered over. Offered on the front page ("Redact text"), which opens your PDF with the tool already in hand; also by search, which boxes every match at once. While you edit, each box says *"This will be redacted on export"* so a real redaction is never mistaken for a shape you have simply filled in — and that wording never appears in the file you export. The fill is any toolbar colour, and a bucket on a selected box turns it back into an ordinary shape if you change your mind
- **Sign** by drawing on a pad; signatures are auto-cropped, saved to your device, and re-usable across PDFs
- **Send to sign** — the pad can show a UNI·SIM QR + PIN; scan it, draw on your phone, enter the PIN, and the signature lands on the desktop ready to place (works from the desktop app too)
- **Edit** placed annotations — drag to move, resize handles on shapes and signatures, double-click text to retype, change colour and size of selected text on the fly
- **Add a QR code** — the QR button in the toolbar generates one from any link or text, in six styles (square, rounded, dots, circle, star…), and drops it on the page like any image. Placed codes keep an ✏️ button: click it (or double-tap the code) to bring the generator back up on that code and change the link, the style or the branding in place. Codes you've saved in [Universal QR](https://opensource.unisim.co.uk/qr) show up in the dialog ready to place, with nothing to sign into
- **Export** the annotated PDF; all annotations and signatures are baked into the saved file
- **Lock a PDF with a password** — tick *Lock with a password* on export and the file is encrypted with **AES-256** (the PDF 2.0 standard security handler, revision 6). Nobody can open it without the password, in any PDF app, on any device. Choose a **password** or a **PIN** if the person receiving it will be typing it on a phone. The dialog says plainly how strong your choice actually is: a 4-digit PIN is ten thousand guesses and it says so. Universal PDF opens locked files too — it asks for the password, then the document behaves like any other, fully editable.

  This is real encryption, not the "no printing / no copying" permission flags most PDF apps offer. Those are not encryption at all: the file is readable by every viewer, which is merely asked to honour the flags, and one command strips them. Universal PDF deliberately does not offer them.

  **There is no reset.** A locked PDF with a forgotten password cannot be opened by us or by anyone — that is the point of it. Locked documents are also never added to *Recents*, so an unlocked copy is never left behind on the machine that opened it.
- **Recents** are remembered locally so you can reopen a PDF with one tap, even offline
- **Installable** PWA — add to home screen on phone or install on desktop, works offline after first load

## Download

Installers for every release are on the
[releases page](https://github.com/universal-simulation-ltd/Universal_PDF/releases/latest):

| Platform | File | Notes |
| --- | --- | --- |
| Windows | `Universal-PDF-Setup-<version>.exe` | NSIS installer, per-user by default |
| macOS | `Universal-PDF-<version>-mac-arm64.dmg` / `-x64.dmg` | Apple silicon and Intel are separate builds |
| Linux | `Universal-PDF-<version>-linux-*.AppImage` / `.deb` | AppImage runs anywhere; `.deb` for Debian/Ubuntu |
| Android | `Universal-PDF-<version>-android.apk` | Sideload, or install from Play once listed |
| iOS | — | App Store only; an `.ipa` on a release is not installable |

**None of the builds are code-signed**, so Windows SmartScreen and macOS
Gatekeeper warn on first run: *More info → Run anyway* on Windows, right-click →
*Open* on macOS.

### Or install the web app — no download at all

The browser version is the whole app. Open the
[app URL](https://opensource.unisim.co.uk/pdf), then:

- **iOS Safari**: Share → *Add to Home Screen* — the recommended route on iPhone
  and iPad until the App Store listing exists
- **Android Chrome**: menu → *Install app*
- **Desktop Chrome / Edge**: install icon in the address bar

## How to use

1. **Open a document** — drop a PDF, Word (`.docx`) or OpenDocument (`.odt`) file on the circle, click it to browse, or drag-and-drop anywhere on the page. Word and ODT files are converted to PDF on your device first
2. **Pick a tool** from the toolbar (Text, Draw, Tick, Cross, Rectangle, or Sign)
3. **Click / tap on the page** to place the annotation
4. **Switch to *Select*** to drag, resize, recolour, or delete existing annotations — or *Select text* (same menu) to drag over and copy the PDF's own text. Double-clicking a word on the page makes that switch for you and selects the word
5. **Save** to download the annotated PDF

Signatures: tap *Sign → Draw new signature*, sign with mouse or finger, save. Pick it from the menu, then tap on the PDF to place. Drag the corners to resize, drag the body to reposition.

## Development

Requires Node 22+ and npm.

```sh
git clone https://github.com/universal-simulation-ltd/Universal_PDF.git
cd Universal_PDF
npm install
npm run dev
```

The dev server runs at <http://localhost:5173>. Build for production with `npm run build`.

### Tests

Unit suites run under Node's type-stripping and import the app's modules directly:

```sh
npm run test:encrypt        # locking/unlocking a PDF, verified against pdf.js
npm run test:lock-password  # what counts as an acceptable password, and how it is described
```

`npm run test:lock` is a browser test (Playwright, borrowed from a sibling Universal app) and needs the dev server running on port 5174 — `./scripts/preview.sh` in another terminal. It is the only place the encryption is proven to work against a real browser's WebCrypto rather than Node's.

`npm run test:word-dblclick` is the other browser test: it pins double-clicking a word with the *Select* tool — the tool switches, exactly the word is selected (asserted on `window.getSelection().toString()`, i.e. what Ctrl/⌘C would copy), and blank page space or an annotation leaves the tool alone. Same dev server on 5174, or set `E2E_BASE_URL` at a production build — the file header gives the commands.

Pushes to `main` auto-deploy via Cloudflare Pages, which serves the app at <https://opensource.unisim.co.uk/pdf>. The production build sets Vite `base: '/pdf/'` and ships a `public/_redirects` file that rewrites `/pdf/*` onto the flat `dist/` output.

Each build bakes the commit SHA into a `<meta name="build-sha">` tag and logs `build: <sha>` to the console at startup, so you can tell which build is live in-browser. On Cloudflare Pages the SHA comes from `CF_PAGES_COMMIT_SHA`; locally it falls back to the git short SHA (or `dev`).

## Desktop app (Windows, macOS, Linux)

The same client-side app can be packaged as a native desktop app with
[Electron](https://www.electronjs.org/). The Electron main process lives in
[`electron/main.cjs`](electron/main.cjs) and loads the built bundle; the
`desktop` Vite mode builds with a relative `base` (`./`) and without the PWA
service worker so assets resolve over `file://`.

```sh
npm run build:desktop      # build the web bundle for Electron (dist/)
npm run electron           # run the packaged-style app against that build
npm run dist:win           # Windows NSIS installer     -> release/
npm run dist:mac:unsigned  # macOS DMGs, arm64 + x64    -> release/
npm run dist:linux         # Linux AppImage + .deb      -> release/
```

The installer registers Universal PDF as a `.pdf` file handler, so it appears
in Windows' right-click *Open with* menu (and can be made the default PDF
app). Files opened that way — or double-clicked while it's the default — load
straight into the editor, skipping the landing page; opening another PDF while
the app is running reuses the existing window, and **opens one if there isn't
one**, which on macOS is what closing the last window leaves you with (the app
keeps running). See `openFromOs` in [`electron/main.cjs`](electron/main.cjs).

**Saving follows the document.** A PDF opened from a folder on the machine —
by double-click, drag-and-drop or the file chooser — offers to save back into
**that folder** rather than Electron's default `~/Downloads`, and that applies
to *Export*, compress and convert as well as *Save and exit*. A file with no
folder of its own (a recent replayed from the browser's storage, the example
PDF, conversion output) leaves the last real folder in place. See
[`docs/README.md`](docs/README.md) → *Where the Save dialog opens (desktop)*.

**Each target must be built on its own OS.** electron-builder packages a
platform-native binary, so cross-building from a plain Linux host won't produce
a working Windows `.exe`. The first run downloads the Electron binary (~100 MB).

To cut a release, push a `v*` tag — the [`release`](.github/workflows/release.yml)
workflow builds all three on their matching runners and attaches them to the
GitHub Release. `workflow_dispatch` takes an existing tag for ad-hoc rebuilds.

> **Building the DMG locally on macOS needs a working `python3`.**
> electron-builder shells out to a vendored `dmgbuild` and reports the failure
> as `Command failed: which python`, which is misleading — it means the
> *`python3` it found* threw, and the fallback to `python` then missed too. A
> Homebrew Python with a mismatched `libexpat` is the usual cause. Point it at a
> known-good interpreter with `PYTHON_PATH=/usr/bin/python3 npm run dist:mac:unsigned`.

## Mobile apps (Android, iOS)

The same bundle is wrapped with [Capacitor](https://capacitorjs.com/). Both
native projects are **committed**, not generated on demand — they carry the app
icons, the bundle id, the version wiring and the signing config.

```sh
npm run cap:sync         # build the web bundle + copy it into ios/ and android/
npm run cap:open:android # open in Android Studio
npm run cap:open:ios     # open in Xcode
```

⚠️ **`cap:sync` must use the relative-base build**, which is what it does
(`build:mobile`, an alias for `build:desktop`). The default `npm run build`
bakes in the `/pdf/` base path the hosted site uses, and every asset 404s inside
the WebView.

**Versions.** `android/app/build.gradle` reads `package.json` directly, so
Android needs nothing. Xcode cannot, so run `node scripts/sync-ios-version.mjs`
after a version bump (`--check` fails instead of writing, for CI). Both derive
the build number as `major*10000 + minor*100 + patch`; both stores refuse a
build number they have already seen, permanently.

**Icons** are generated from the canonical mark by `native-icons.mjs` in the
platform repo — not resampled from `public/icon-512.png`. Regenerate after a
mark change rather than editing `res/mipmap-*` or `Assets.xcassets` by hand.

**Android signing** is driven entirely by environment variables, so no keystore
lives here: `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. With none set you get an unsigned
build, which will not install on a phone and which Play rejects. CI reads the
keystore from the `ANDROID_KEYSTORE_BASE64` secret.

**Gradle needs Java 21.** Java 25 fails with `Unsupported class file major
version 69` before compiling anything. Android Studio's bundled JBR is a
convenient one: `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.

**iOS is not distributed from GitHub.** An `.ipa` attached to a release is not
installable — the route is TestFlight or the App Store, which needs a signing
identity and an App Store Connect listing. The Xcode project archives cleanly
without one (`CODE_SIGNING_ALLOWED=NO`) if you only want to check it builds.

## Stack

- **Vite 6 + React 18 + TypeScript** — app shell
- **pdfjs-dist** — PDF rendering (Mozilla)
- **pdf-lib** — PDF export with annotations baked in
- **tesseract.js** — on-device OCR (WASM), lazily loaded for the "Make searchable" tool
- **react-konva** — canvas overlay for shapes, text, freehand, and signatures
- **Zustand** — state management
- **IndexedDB** — recent files (binary bytes)
- **localStorage** — saved signatures
- **Tailwind CSS v4** — styling
- **vite-plugin-pwa** — service worker + manifest

## Contributing

Issues and pull requests welcome. The project is intentionally small and dependency-light; please open an issue before adding a large feature.

## License

[AGPL-3.0-or-later](./LICENSE), with an added permission for app-store distribution.
