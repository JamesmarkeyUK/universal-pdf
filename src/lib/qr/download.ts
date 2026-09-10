// Getting the code back OUT of the dialog — as a PNG file or on the clipboard —
// for the times it isn't going onto this PDF at all (a slide, an email, a
// poster someone else is laying out).
//
// Both paths go through the same `renderQrPng` at the same `PLACEMENT_SIZE` the
// page placement uses, so the file you get is pixel-for-pixel the image "Add to
// page" would have stamped in. A second renderer for "the downloaded one" is
// how the two would quietly drift apart.

import { qrDisplayName, type QrDesign } from '@unisim/qr'
import { PLACEMENT_SIZE, renderQrPng } from './render'
import { saveBlob } from '@unisim/media/save'

/** Slugify a design's display name into a safe filename stem — the same rule as
 *  Universal QR's `fileStem`, so a design shared between the two apps downloads
 *  under the same name from either. */
export function qrFileStem(design: QrDesign): string {
  const slug = qrDisplayName(design)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return slug || 'qr-code'
}

/** `data:` URL → Blob without `fetch()`. The Electron build serves the app off
 *  its own protocol with a strict CSP, and a fetch of a `data:` URL is exactly
 *  what that refuses; decoding the base64 by hand can't be blocked. */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(0, comma)
  const type = /:(.*?);/.exec(head)?.[1] ?? 'image/png'
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

/** Render the design and save it as a PNG. */
export async function downloadQrPng(design: QrDesign): Promise<void> {
  const blob = dataUrlToBlob(await renderQrPng(design, PLACEMENT_SIZE))
  saveBlob(blob, `${qrFileStem(design)}.png`)
}

/** Copy the rendered PNG to the clipboard. Returns false when the browser has
 *  no image clipboard or refuses the write — the caller says so rather than
 *  claiming a copy that never happened. */
export async function copyQrPngToClipboard(design: QrDesign): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false

  // Started before the first write so both attempts share one render.
  const png = renderQrPng(design, PLACEMENT_SIZE).then(dataUrlToBlob)
  try {
    // Safari only honours a clipboard write inside the gesture that asked for
    // it, and rendering a QR is asynchronous — so hand it the promise, which it
    // accepts, rather than awaiting the blob and arriving too late.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return true
  } catch {
    // Not every browser takes a promise there (and a render can simply fail).
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await png })])
      return true
    } catch {
      return false
    }
  }
}
