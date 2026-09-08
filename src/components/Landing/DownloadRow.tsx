import { useState } from 'react'

const RELEASES = 'https://github.com/universal-simulation-ltd/Universal_PDF/releases/latest'

// The same marks the download page on the marketing site uses, so the two read
// as one product rather than two takes on the same four platforms.
const ICON = 'h-[18px] w-[18px] shrink-0'

function WindowsIcon() {
  return (
    <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5.5 10 4.5v7H3zM11.5 4.3 21 3v8.5h-9.5zM3 12.5h7v7L3 18.5zM11.5 12.5H21V21l-9.5-1.3z" />
    </svg>
  )
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className={ICON} aria-hidden="true">
      <path fill="currentColor" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  )
}

function AndroidIcon() {
  return (
    <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 10.5h14v6.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
      <path d="M8 10.5a4 4 0 0 1 8 0" />
      <path d="M6.5 6 8 8M17.5 6 16 8M10 6.8h.01M14 6.8h.01" />
      <path d="M2.8 11.5v4M21.2 11.5v4M9.5 19v2.2M14.5 19v2.2" />
    </svg>
  )
}

function IPhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="2" width="12" height="20" rx="2.6" />
      <path d="M11 18.5h2" />
    </svg>
  )
}

const ITEM =
  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors'

/**
 * Where to get the app for each platform, kept quiet on purpose.
 *
 * The browser IS the product here — nothing on this page should suggest the
 * page itself is the lesser version — so this is a row of small marks under
 * the drop zone rather than a banner above it: findable by someone looking for
 * it, ignorable by everyone else.
 *
 * ⚠️ The iPhone entry is not a link. There is no App Store listing yet, and a
 * dead href is worse than no link — that is the mistake the Universal Screens
 * page shipped. It reveals the Add-to-Home-Screen route instead, which does
 * work today.
 */
export default function DownloadRow() {
  const [showIosHint, setShowIosHint] = useState(false)

  // The desktop app is already the download; offering it one is noise.
  if (typeof window !== 'undefined' && window.desktop) return null

  return (
    <section aria-labelledby="get-the-app" className="mt-8 text-center">
      <h2 id="get-the-app" className="flex items-center justify-center gap-1.5 text-[13px] text-slate-400">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16" />
        </svg>
        Download it for offline use — it works the same
      </h2>

      <ul className="mt-1 flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
        <li>
          <a className={ITEM} href={RELEASES} rel="noopener" title="Windows installer (.exe), 64-bit">
            <WindowsIcon />
            Windows
          </a>
        </li>
        <li>
          <a className={ITEM} href={RELEASES} rel="noopener" title="Disk image (.dmg) — Apple silicon and Intel">
            <AppleIcon />
            macOS
          </a>
        </li>
        <li>
          <a className={ITEM} href={RELEASES} rel="noopener" title="Android package (.apk)">
            <AndroidIcon />
            Android
          </a>
        </li>
        <li>
          <button
            type="button"
            className={ITEM}
            aria-expanded={showIosHint}
            onClick={() => setShowIosHint((open) => !open)}
          >
            <IPhoneIcon />
            iPhone
          </button>
        </li>
      </ul>

      {showIosHint && (
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-slate-500">
          Not on the App Store yet. In Safari, tap <strong className="font-medium">Share</strong> →{' '}
          <strong className="font-medium">Add to Home Screen</strong> — it installs and runs offline.
        </p>
      )}

      <p className="mt-1 text-[12px] text-slate-400">
        Free and open source, like the web version. Desktop builds are unsigned.
      </p>
    </section>
  )
}
