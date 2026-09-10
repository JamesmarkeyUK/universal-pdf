import { useId } from 'react'
import { useFileDrop } from '@unisim/sdk'

// The one control that decides whose brand a code carries.
//
// It replaced a plain "UNI·SIM mark" checkbox. That checkbox was the wrong
// question in two ways: it asked about OUR logo when the thing people want to
// change is THEIRS, and it had nowhere to put the answer — the dialog could
// only ever show a brand logo that arrived with an imported design.
//
// So: one switch, off by default (the code carries the UNI·SIM mark), and
// turning it on discloses a panel holding the mark and the colour. Signed in
// with a Universal ID, that panel arrives already filled in with the company's
// own branding — which is the whole point of the org having set it once — and
// every part of it is still editable.

export interface QrBrandingPanelProps {
  on: boolean
  onToggle: (on: boolean) => void
  /** The mark in use, as a data URI. */
  logo: string | null
  onLogo: (logo: string | null) => void
  /** The colour in use, `#rrggbb`. */
  color: string | null
  onColor: (color: string | null) => void
  /** The signed-in company's own branding, for the "reset" affordance. */
  orgName: string | null
  orgLogo: string | null
  orgColor: string | null
  /** True when `color` is too light to have reached the code itself. */
  colorRejected: boolean
  onError: (message: string) => void
}

/** The colour shown in the picker when the design has no brand colour set —
 *  the suite orange the presets already draw finder eyes in. */
const FALLBACK_ACCENT = '#e05504'

export default function QrBrandingPanel({
  on,
  onToggle,
  logo,
  onLogo,
  color,
  onColor,
  orgName,
  orgLogo,
  orgColor,
  colorRejected,
  onError
}: QrBrandingPanelProps) {
  const panelId = useId()
  const drop = useFileDrop({
    onFiles: (files) => readLogo(files[0]),
    accept: 'image/*,.svg',
    multiple: false,
    label: 'Drop a logo here, or click to choose one'
  })

  function readLogo(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      onError('Please choose an image file (PNG, JPG or SVG).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') onLogo(reader.result)
    }
    reader.onerror = () => onError('Could not read that image.')
    reader.readAsDataURL(file)
  }

  // Only offer "back to the company's" when there is something to go back to
  // AND it isn't already what's showing.
  const canResetToOrg = !!(orgLogo || orgColor) && (logo !== orgLogo || color !== orgColor)

  return (
    <div className="rounded-lg border border-slate-200">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-expanded={on}
        aria-controls={panelId}
        onClick={() => onToggle(!on)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className={`shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${
            on ? 'bg-orange-600' : 'bg-slate-300'
          }`}
        >
          <span
            className={`block w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
              on ? 'translate-x-4' : ''
            }`}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-700">Custom branding</span>
          <span className="block text-xs text-slate-400 truncate">
            {on
              ? 'Your mark and colour on the code'
              : `UNI·SIM mark in the centre${orgName ? ` — switch on for ${orgName}'s` : ''}`}
          </span>
        </span>
      </button>

      {on && (
        <div id={panelId} className="px-3 pb-3 pt-1 flex flex-col gap-3 border-t border-slate-100">
          {/* ── The mark ──────────────────────────────────────────────────── */}
          <input {...drop.inputProps} hidden />
          {logo ? (
            <div className="flex items-center gap-3 p-2 rounded-lg border border-slate-200 bg-slate-50">
              <img
                src={logo}
                alt="Brand mark preview"
                className="w-10 h-10 rounded-md object-contain bg-white ring-1 ring-slate-200 p-1"
              />
              <span className="flex-1 min-w-0 text-xs text-slate-600 truncate">
                {logo === orgLogo && orgName ? `${orgName}'s mark` : 'Your mark'}
              </span>
              <button
                type="button"
                onClick={drop.open}
                className="text-xs font-medium text-slate-600 hover:text-orange-700 px-1.5 py-1"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => onLogo(null)}
                className="text-xs font-medium text-red-600 hover:text-red-700 px-1.5 py-1"
              >
                Remove
              </button>
            </div>
          ) : (
            <div
              {...drop.dropzoneProps}
              className={`w-full flex items-center justify-center gap-2 px-3 py-3 rounded-lg border-2 border-dashed cursor-pointer text-xs font-medium transition-colors ${
                drop.over
                  ? 'border-orange-500 bg-orange-50 text-orange-700'
                  : 'border-slate-300 text-slate-500 hover:border-orange-400 hover:bg-orange-50/40 hover:text-orange-700'
              }`}
            >
              <span aria-hidden="true">🖼</span> Drop your logo here, or click to choose
            </div>
          )}

          {/* ── The colour ────────────────────────────────────────────────── */}
          <div className="flex items-center gap-2">
            <label htmlFor="qr-brand-color" className="text-xs text-slate-600 shrink-0">
              Brand colour
            </label>
            <input
              id="qr-brand-color"
              type="color"
              value={color ?? FALLBACK_ACCENT}
              onChange={(e) => onColor(e.target.value)}
              className="w-8 h-8 rounded border border-slate-300 bg-white p-0.5 cursor-pointer shrink-0"
            />
            <span className="text-xs text-slate-400 font-mono">{color ?? 'default'}</span>
            {color && (
              <button
                type="button"
                onClick={() => onColor(null)}
                className="ml-auto text-xs text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline"
              >
                Clear
              </button>
            )}
          </div>

          {colorRejected && (
            <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-2">
              That colour is too light to hold up as part of the code, so the code keeps its own
              eye colour. Your logo still uses it.
            </p>
          )}

          {canResetToOrg && (
            <button
              type="button"
              onClick={() => {
                onLogo(orgLogo)
                onColor(orgColor)
              }}
              className="self-start text-xs text-orange-700 hover:text-orange-800 underline-offset-2 hover:underline"
            >
              Reset to {orgName ? `${orgName}'s` : 'my company'} branding
            </button>
          )}

          {!orgLogo && !orgColor && (
            <p className="text-xs text-slate-400">
              Sign in with your Universal ID and set your logo and colour once in My Company, and
              they land here automatically.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
