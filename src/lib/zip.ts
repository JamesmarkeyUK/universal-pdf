// The browser-download glue for a batch export. The ZIP format work itself is
// no longer here.
//
// This file used to carry a whole STORE-mode writer — one of FOUR copies across
// the suite, and the odd one out: Converter, Compress and Video took Blobs and
// returned a Blob, while this one was synchronous over `Uint8Array`. It also
// wrote a DOS mod-date of 0, which is day 0 of month 0 and not a valid date;
// most unzippers tolerate it and none of them promise to. All four are now
// `@unisim/media`, which keeps both call shapes and pins the date to
// 1980-01-01 so the same batch exported twice is byte-identical.
//
// What stays here is the part that is genuinely this app's: turning the bytes
// into a download. That touches the DOM, and `@unisim/media` is deliberately
// DOM-free so it can be self-tested in plain Node.

import { zipBytes, type ZipEntry } from '@unisim/media'
import { saveBlob } from '@unisim/media/save'

export type { ZipEntry }

// Build a ZIP from the entries and trigger a browser download. Everything runs
// on-device — nothing is uploaded.
export function downloadZip(entries: ZipEntry[], zipName: string) {
  const bytes = zipBytes(entries)
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' })
  saveBlob(blob, zipName)
}
