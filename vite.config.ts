import { execSync } from 'node:child_process'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }
import { checkBuildEnv, buildEnvError } from './scripts/buildEnv.ts'

// Universal PDF is served at opensource.unisim.co.uk/pdf in production. `base`
// controls where built assets resolve from; in local dev it stays `/`. The
// `desktop` mode targets the Electron build, which loads index.html over
// `file://`, so assets must resolve relative to it (`./`). Derived from Vite's
// `mode` so the config needs no Node `process` typings.
//
// ⚠️ `desktop` mode is ALSO what the Capacitor (Android + iOS) builds use, and
// the name is now a misnomer — see the `build:mobile` script, which is an alias
// for `build:desktop`. Both need exactly the same two things: a relative `base`
// (Capacitor serves the bundle from a `capacitor://` / `https://localhost`
// origin) and no service worker. Don't add anything Electron-specific behind
// `isDesktop` without splitting the mode first.
// Build-version marker: prefer the Cloudflare Pages commit SHA baked in at build
// time, fall back to the local git short SHA, then 'dev'. Surfaced as a
// <meta name="build-sha"> tag and a startup console.log so the live build is
// identifiable in-browser without wrangler.
function resolveBuildSha(): string {
  // ⚠️ Truncated to the same 7 characters the local fallback below produces.
  // Cloudflare hands over the FULL 40-character SHA, so the same commit used to
  // stamp two different markers depending on where it was built — and the marker
  // exists precisely to be compared against `git log` by eye.
  // Also reads GITHUB_SHA, so an Actions build stamps the commit it is
  // building rather than falling through.
  const ciSha = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA
  if (ciSha) return ciSha.slice(0, 7)

  // ⚠️ THE LOCAL-GIT FALLBACK MUST NEVER RUN IN CI. On 2026-07-26 a Pages
  // build of b4e0699 fell through to it and shipped `ac02d14` — the PREVIOUS
  // commit. The marker built to answer "is the live build current?" reported a
  // stale-looking SHA for a perfectly current deploy, and cost a later session
  // two days chasing a build that was never broken. In CI we emit 'unknown'
  // instead: a marker that is obviously useless beats one that quietly lies.
  //
  // CF_PAGES is set by Cloudflare Pages; CI by essentially every other runner.
  if (process.env.CF_PAGES || process.env.CI) {
    console.warn(
      '[build-sha] CI build with no commit SHA in the environment ' +
        '(CF_PAGES_COMMIT_SHA / GITHUB_SHA). Emitting "unknown" — the local git ' +
        "fallback reports the checkout's HEAD, which can disagree with the " +
        'commit actually being deployed.',
    )
    return 'unknown'
  }

  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}
const BUILD_SHA = resolveBuildSha()

export default defineConfig(({ command, mode }) => {
  // ⚠️ Refuse to BUILD without the Supabase pair `src/main.tsx` inlines. Vite
  // substitutes `undefined` for a missing variable and reports success, so the
  // first thing to notice used to be a user staring at the error boundary —
  // once in CI (PR #80) and once in the 0.6.15 macOS build, which was packaged
  // in a checkout with no `.env.local` and could not start. See
  // `scripts/buildEnv.ts`.
  //
  // Build only, never `vite dev`: a contributor with no credentials can still
  // run the app locally against the SDK's `?mockauth=1` fixture world, and
  // taking that away would be a bigger tax than the bug this prevents.
  //
  // `loadEnv` reads the `.env*` files AND `process.env` — which is what makes
  // one check cover both the local path (`.env.local`) and CI, where the
  // release workflow passes the pair in from repo secrets.
  if (command === 'build') {
    const problems = checkBuildEnv(loadEnv(mode, process.cwd(), 'VITE_'))
    if (problems.length) throw new Error(buildEnvError(problems, mode))
  }

  const isDesktop = mode === 'desktop'
  const BASE_PATH = isDesktop ? './' : mode === 'production' ? '/pdf/' : '/'
  return {
    base: BASE_PATH,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      'import.meta.env.VITE_BUILD_SHA': JSON.stringify(BUILD_SHA)
    },
    plugins: [
      {
        name: 'build-sha-meta',
        transformIndexHtml() {
          return [
            { tag: 'meta', attrs: { name: 'build-sha', content: BUILD_SHA }, injectTo: 'head' as const },
          ]
        },
      },
      react(),
      tailwindcss(),
      // The PWA service worker is for the hosted web app only — under Electron's
      // `file://` origin it cannot register and is unnecessary, so skip it.
      ...(isDesktop ? [] : [VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'],
        manifest: {
          name: 'Universal PDF',
          short_name: 'UniPDF',
          description: 'Annotate and sign PDFs anywhere',
          theme_color: '#0f172a',
          background_color: '#f8fafc',
          display: 'standalone',
          start_url: BASE_PATH,
          scope: BASE_PATH,
          // An INSTALLED PWA can be offered as a handler for .pdf (Chromium
          // desktop; Chrome asks permission at install time). ⚠️ This makes the
          // app a CHOICE in the OS "Open with" list — a web app can never be
          // the system default, and nothing here claims otherwise.
          //
          // `?launching=1` is the same flag Electron passes for exactly the
          // same reason: the file arrives on `launchQueue` AFTER the bundle has
          // loaded, so the app holds its loading state from the first paint
          // rather than flashing the landing page on the way to a document the
          // user already chose.
          file_handlers: [
            {
              action: `${BASE_PATH}?launching=1`,
              accept: { 'application/pdf': ['.pdf'] }
            }
          ],
          icons: [
            { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
          ]
        },
        workbox: {
          // SPA navigations under the base path fall back to the prefixed shell.
          navigateFallback: `${BASE_PATH}index.html`,
          // Workbox refuses to precache a file over 2 MiB, and refuses the BUILD
          // with it. The app's own bundle sat at 2.02 MiB and went over when the
          // QR design model moved to @unisim/qr, which inlines the UNI·SIM mark
          // as a data URI (~64 kB) instead of fetching it — the price of the two
          // apps rendering the identical picture, and it is paid once at install
          // rather than per code.
          //
          // Raised rather than worked around because the alternative is worse:
          // leaving the main bundle un-precached would take the app offline on
          // the one file it cannot start without. 4 MiB is headroom, not a
          // target — this is a PDF editor carrying pdf.js, pdf-lib and konva,
          // and it ships gzipped at ~700 kB. The QR editor is the obvious thing
          // to code-split out of the first load if this needs to come down.
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          // ⚠️ The HEIC decoder is the biggest single chunk in the build (~3 MB)
          // and stays OUT of the install-time precache. Precaching it would hand
          // that download to every visitor and undo the dynamic import in
          // `lib/convert.ts`, which exists precisely so that people who never
          // convert an iPhone photo never pay for it. Same bargain, and the same
          // pair of rules, as Universal Converter and Universal Compress.
          // ⚠️ The Cyrillic/Greek/Hebrew fallback face is 350 KB and matters
          // only to somebody opening a Word file in one of those alphabets.
          // Same bargain again: out of the install-time precache, fetched by
          // `lib/fallbackFont.ts` when a document actually needs it.
          globIgnores: ['**/heic-to-*.js', 'fonts/*.ttf'],
          // The on-device OCR runtime (Tesseract.js WASM core + English model)
          // is large (~15 MB) and only fetched from the Tesseract CDN when the
          // optional "Make searchable (OCR)" tool is used. Keep it OUT of the
          // install-time precache (it would bloat the PWA install and blow past
          // workbox's file-size limit — the assets live cross-origin anyway) and
          // cache it at runtime on first use, so OCR still works offline once the
          // user has run it once. Same pattern as Universal Images' background
          // removal. Cross-origin responses are opaque (status 0), so allow that.
          runtimeCaching: [
            {
              // The fallback face — cached after the first document that needs
              // another alphabet, so that person has it offline from then on.
              urlPattern: /\/fonts\/.*\.ttf$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'fallback-font',
                expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // The HEIC decoder — cached after the first iPhone photo, so
              // Images → PDF keeps working offline from then on.
              urlPattern: /\/assets\/heic-to-.*\.js$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'heic-to',
                expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js.*/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'tesseract-runtime',
                expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 30 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/tessdata\.projectnaptha\.com\/.*/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'tesseract-langdata',
                expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: { enabled: false }
      })]),
    ],
    optimizeDeps: {
      exclude: ['canvas']
    },
    worker: {
      format: 'iife'
    }
  }
})
