import { usePdfStore } from '../stores/pdfStore'
import { useAnnotationStore } from '../stores/annotationStore'
import { useFormStore, type FormFieldValue } from '../stores/formStore'
import type { Annotation } from '../types/annotations'
import { saveBlob } from '@unisim/media/save'

// "Save to desktop" backup for Universal PDF — the editable middle tier between
// the free in-browser recents and the paid "Hosted by UNI·SIM" cloud. A backup
// bundles the ORIGINAL PDF bytes plus the user's annotations and form values as
// one JSON file the guest keeps and re-imports later to carry on editing.
//
// This is deliberately NOT the flattened export the hosted store uploads:
// re-importing a baked PDF couldn't restore editable annotations. The trade-off
// is size — the source PDF is embedded as base64 (~+33%), fine for a download
// the user chose to make.

const MAGIC = 'universal-pdf-backup'
const VERSION = 1

interface BackupFile {
  app: typeof MAGIC
  version: number
  createdAt: string
  fileName: string
  /** base64 of the original (unflattened) source PDF bytes. */
  pdf: string
  annotations: Annotation[]
  formValues: FormFieldValue[]
}

/** Encode bytes as base64 without blowing the call stack on large PDFs. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function safeStem(name: string | null): string {
  const base = (name ?? 'document').replace(/\.pdf$/i, '')
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return slug || 'document'
}

/** Whether there's a PDF open to back up. */
export function canBackup(): boolean {
  return !!usePdfStore.getState().sourceBytes
}

/** Serialise the open PDF + its edits to a JSON backup blob + filename. */
export function buildBackup(): { blob: Blob; fileName: string } {
  const { sourceBytes, fileName } = usePdfStore.getState()
  if (!sourceBytes) throw new Error('No PDF is open.')
  const payload: BackupFile = {
    app: MAGIC,
    version: VERSION,
    createdAt: new Date().toISOString(),
    fileName: fileName ?? 'document.pdf',
    pdf: bytesToBase64(new Uint8Array(sourceBytes)),
    annotations: useAnnotationStore.getState().annotations,
    formValues: useFormStore.getState().values,
  }
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
  return { blob, fileName: `${safeStem(fileName)}.unipdf.json` }
}

/** Save the open PDF + edits to the guest's device as a re-importable backup. */
export function downloadBackup(): void {
  const { blob, fileName } = buildBackup()
  saveBlob(blob, fileName)
}

/** Restore a previously-downloaded backup: load the PDF back into the editor
 *  and re-apply its annotations + form values. Throws a user-facing message if
 *  the file isn't a valid Universal PDF backup. */
export async function importBackup(file: File): Promise<void> {
  let json: unknown
  try {
    json = JSON.parse(await file.text())
  } catch {
    throw new Error("That file isn't a Universal PDF backup (it isn't valid JSON).")
  }

  const data = json as Partial<BackupFile>
  if (!data || data.app !== MAGIC || typeof data.pdf !== 'string') {
    throw new Error("That file isn't a Universal PDF backup.")
  }
  if (typeof data.version === 'number' && data.version > VERSION) {
    throw new Error('This backup was made by a newer version of Universal PDF — update the app to open it.')
  }

  const bytes = base64ToBytes(data.pdf)
  const restored = new File([bytes as unknown as BlobPart], data.fileName ?? 'document.pdf', { type: 'application/pdf' })
  // Load the source first (sets the doc + recents), then replace the edit
  // stores wholesale so the restored work — not the previous doc's — shows.
  await usePdfStore.getState().loadFile(restored)
  useAnnotationStore.setState({
    annotations: Array.isArray(data.annotations) ? data.annotations : [],
    selectedId: null,
    selectedIds: [],
    past: [],
    future: [],
  })
  useFormStore.setState({ values: Array.isArray(data.formValues) ? data.formValues : [] })
}
