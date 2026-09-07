import { create } from 'zustand'
import { loadPdf, type PDFDocumentProxy } from '../lib/pdfjs'
import { listRecents, saveRecent, getRecent, getRecentBySlug, getRecentEdits, updateRecentEdits, deleteRecent, renameRecent, type RecentMeta, type RecentEdits } from '../lib/recents'
import { readEmbeddedSigFields } from '../lib/export'
import { applyPageOrderToPdf, buildPageIndexMap } from '../lib/pdfPages'
import { scrubPdfMetadata } from '../lib/pdfMetadata'
import { decryptPdf, isEncryptedPdf, WrongPasswordError } from '../lib/pdfEncrypt'
import { useAnnotationStore } from './annotationStore'
import { useFormStore } from './formStore'
import { useSearchStore } from './searchStore'
import { useSignatureStore } from './signatureStore'
import { markSaved, noteStructuralEdit } from '../lib/unsavedChanges'
import { rememberOpenFolder } from '../lib/openFolder'
import type { QrPlacement } from '../lib/qr/design'

// Restore a recent's saved edits into the live stores. Applies whenever the
// stored arrays EXIST (even when empty) so a deliberately-cleared document
// stays cleared on reopen — `undefined` means "never persisted", in which case
// we leave whatever loadFile hydrated from the PDF (e.g. embedded sig fields).
// Returns true if annotations were applied.
function applyRecentEdits(edits: RecentEdits): boolean {
  let applied = false
  if (edits.annotations) {
    useAnnotationStore.setState({
      annotations: edits.annotations,
      selectedId: null,
      selectedIds: [],
      past: [],
      future: []
    })
    applied = true
  }
  if (edits.formValues) {
    useFormStore.setState({ values: edits.formValues })
  }
  return applied
}

// Wipe every piece of per-document editing state so nothing from the PDF being
// closed (annotations, drawings, signatures, highlights, form values, find
// results, in-progress signature placement) leaks onto the next one. Called
// when a different PDF is opened and when the document is closed/reset. The
// saved signature *library* is intentionally left alone — it is a reusable,
// cross-document collection.
function clearDocumentState() {
  useAnnotationStore.getState().resetDocument()
  useFormStore.getState().clearAll()
  useSearchStore.getState().reset()
  useSignatureStore.getState().setPendingExtras([])
}

function setHashSlug(slug: string | null) {
  if (typeof window === 'undefined') return
  const target = slug ? `#${slug}` : ''
  if (window.location.hash === target) return
  // Use replaceState so the user's browser history doesn't fill up with
  // every PDF they open in this session.
  const url = window.location.pathname + window.location.search + target
  window.history.replaceState(null, '', url)
}

function readHashSlug(): string | null {
  if (typeof window === 'undefined') return null
  const h = window.location.hash.replace(/^#/, '').trim()
  return /^[a-z0-9]{4,16}$/i.test(h) ? h : null
}

interface PdfState {
  doc: PDFDocumentProxy | null
  numPages: number
  fileName: string | null
  sourceBytes: ArrayBuffer | null
  // True for Adobe LiveCycle/Designer XFA forms — the viewer renders these via
  // the XFA HTML layer (XfaPage) and saves filled values with saveDocument().
  isXfa: boolean
  loading: boolean
  // ⚠️ False from the moment a document is handed to the viewer until page 1
  // has actually been PAINTED — not merely parsed. `loading` goes false as
  // soon as pdf.js resolves the document, but the viewer then mounts a box for
  // every page and rasterizes them three at a time (see `renderQueue.ts`), so
  // for a beat the reader gets a screen of empty white page frames. On a phone
  // opening a PDF from WhatsApp that beat is a visible stage of its own —
  // "splash, loading, outline pdf, pdf" — and it reads as the app stalling
  // halfway. Holding the existing placeholder over it collapses two stages
  // into one.
  //
  // ⚠️ It is a HOLD, NOT A GATE: `firstPaintDeadline` below flips it true
  // regardless after a beat, so a page that never paints (a render failure, a
  // pure-XFA document, which draws through XfaPage and never reaches
  // `markFirstPaint` at all) can never strand the viewer behind a spinner. The
  // worst case is exactly today's behaviour, arriving a moment later.
  firstPaint: boolean
  /** Page 1 has drawn. Called by `PdfPage`; idempotent. */
  markFirstPaint: () => void
  pageNavOpen: boolean
  previewOpen: boolean
  presentOpen: boolean
  hostedStoreOpen: boolean
  sendToSignOpen: boolean
  ocrOpen: boolean
  // True while two fingers are down on the viewer for a pinch-zoom. The
  // annotation layer watches this so a pinch is only ever a zoom: any drag /
  // stroke / rubber-band already in flight is abandoned, and no new one can
  // start until the fingers lift. Lives here (not in the annotation store)
  // because the gesture belongs to the viewport, and it has to be readable
  // across every page's layer — a pinch can straddle two pages.
  pinching: boolean
  // Advanced-menu dialogs that act on the currently-open document.
  mergeOpen: boolean
  convertOpen: boolean
  advancedExportOpen: boolean
  metadataOpen: boolean
  // The "Add QR code" generator (toolbar, next to the image button).
  qrOpen: boolean
  // Set when the generator was opened by the ✏️ on a code already on the page
  // rather than by the toolbar: the annotation to write back to, and the editor
  // state it was placed with. Null for a fresh code.
  qrEdit: { id: string; placement: QrPlacement } | null
  recents: RecentMeta[]
  // Set when the open document was converted from Word/OpenDocument rather than
  // opened as a PDF, so the viewer can say so — what is on screen is a
  // re-typeset version, not a facsimile. Cleared by the next load.
  importNotice: string | null
  dismissImportNotice: () => void
  // Set when the file the user just opened is password-locked. The document is
  // NOT loaded until a password arrives; `LockedFilePrompt` renders from this
  // and calls `loadFile` again with one.
  //
  // ⚠️ The File is held, not its bytes: the prompt may sit on screen for a
  // while and a File is a handle to something the browser already has, whereas
  // an ArrayBuffer of a big PDF is a copy we would be pinning in memory for as
  // long as somebody is hunting for their password.
  lockedFile: { file: File; notice?: string; error: string | null } | null
  cancelLockedFile: () => void
  loadFile: (file: File, options?: { notice?: string; password?: string }) => Promise<void>
  loadFromSlug: (slug: string) => Promise<boolean>
  loadFromCurrentUrl: () => Promise<boolean>
  reset: () => void
  togglePageNav: () => void
  setPageNavOpen: (open: boolean) => void
  setPreviewOpen: (open: boolean) => void
  setPresentOpen: (open: boolean) => void
  setHostedStoreOpen: (open: boolean) => void
  setSendToSignOpen: (open: boolean) => void
  setOcrOpen: (open: boolean) => void
  setPinching: (pinching: boolean) => void
  setMergeOpen: (open: boolean) => void
  setConvertOpen: (open: boolean) => void
  setAdvancedExportOpen: (open: boolean) => void
  setMetadataOpen: (open: boolean) => void
  setQrOpen: (open: boolean) => void
  /** Reopen the generator on a code already placed on a page. */
  openQrEditor: (id: string, placement: QrPlacement) => void
  /** Strip the Info dictionary + XMP packet from the open document, in place. */
  scrubMetadata: () => Promise<void>
  refreshRecents: () => Promise<void>
  openRecent: (id: string) => Promise<void>
  removeRecent: (id: string) => Promise<void>
  renameFile: (newName: string) => Promise<void>
  applyPageOrder: (newOrder: number[]) => Promise<void>
  deletePage: (pageIndex: number) => Promise<void>
  movePage: (from: number, to: number) => Promise<void>
}

// How long the "page 1 is drawing" hold may last before the viewer is shown
// regardless. Sized to cover the rasterization of one page on a phone, not the
// whole document — the rest of the pages carry on filling in behind the reader
// exactly as they did before. Overshooting it costs nothing worse than the
// empty page frames this hold exists to hide.
const FIRST_PAINT_GRACE_MS = 1200
let firstPaintDeadline: ReturnType<typeof setTimeout> | null = null

export const usePdfStore = create<PdfState>((set, get) => ({
  doc: null,
  numPages: 0,
  fileName: null,
  sourceBytes: null,
  isXfa: false,
  loading: false,
  // True when idle: with no document there is no first paint to wait for, and
  // the landing page must never sit behind this.
  firstPaint: true,
  pageNavOpen: false,
  previewOpen: false,
  presentOpen: false,
  hostedStoreOpen: false,
  sendToSignOpen: false,
  ocrOpen: false,
  pinching: false,
  mergeOpen: false,
  convertOpen: false,
  advancedExportOpen: false,
  metadataOpen: false,
  qrOpen: false,
  qrEdit: null,
  recents: [],
  importNotice: null,
  dismissImportNotice: () => set({ importNotice: null }),
  lockedFile: null,
  cancelLockedFile: () => set({ lockedFile: null }),
  togglePageNav: () => set((s) => ({ pageNavOpen: !s.pageNavOpen })),
  setPageNavOpen: (pageNavOpen) => set({ pageNavOpen }),
  setPreviewOpen: (previewOpen) => set({ previewOpen }),
  setPresentOpen: (presentOpen) => set({ presentOpen }),
  setHostedStoreOpen: (hostedStoreOpen) => set({ hostedStoreOpen }),
  setSendToSignOpen: (sendToSignOpen) => set({ sendToSignOpen }),
  setOcrOpen: (ocrOpen) => set({ ocrOpen }),
  setPinching: (pinching) => set({ pinching }),
  setMergeOpen: (mergeOpen) => set({ mergeOpen }),
  setConvertOpen: (convertOpen) => set({ convertOpen }),
  setAdvancedExportOpen: (advancedExportOpen) => set({ advancedExportOpen }),
  setMetadataOpen: (metadataOpen) => set({ metadataOpen }),
  // Clearing the edit target on every open AND close is what keeps the toolbar
  // button meaning "a new code": without it, closing an edit and pressing QR
  // again would come back up still pointed at the annotation it last wrote to.
  setQrOpen: (qrOpen) => set({ qrOpen, qrEdit: null }),
  openQrEditor: (id, placement) => set({ qrOpen: true, qrEdit: { id, placement } }),
  scrubMetadata: async () => {
    const bytes = get().sourceBytes
    const fileName = get().fileName
    if (!bytes || !fileName) return

    // Same atomic shape as applyPageOrder: build the replacement document
    // first, and only swap state once it has loaded. Annotations and form
    // values are deliberately left alone — stripping metadata doesn't touch a
    // single page, so the user's work in progress survives it.
    const newBytes = await scrubPdfMetadata(bytes.slice(0))
    const doc = await loadPdf(newBytes.slice(0)).promise
    get().doc?.destroy()
    set({ doc, numPages: doc.numPages, sourceBytes: newBytes, isXfa: doc.isPureXfa })
    // Rewrote the bytes without touching either edit store, so the exit guard
    // would never see it. Same for the page operations below.
    noteStructuralEdit()

    saveRecent(fileName, newBytes)
      .then((slug) => {
        if (slug) setHashSlug(slug)
        return get().refreshRecents()
      })
      .catch(() => {})
  },
  loadFile: async (file, options) => {
    set({ loading: true })
    try {
      get().doc?.destroy()
      let buf = await file.arrayBuffer()

      // ⚠️ A locked PDF is unlocked HERE, before anything else sees it, and
      // the rest of this function then runs on ordinary bytes. Every tool
      // downstream — annotating, flattening, compressing, reading embedded
      // signature boxes — is pdf-lib, which cannot decrypt; letting the
      // ciphertext through would give a document that renders (pdf.js can cope)
      // and then fails, differently, in every other feature.
      const encrypted = isEncryptedPdf(new Uint8Array(buf))
      if (encrypted) {
        if (!options?.password) {
          // Not an error — nobody has been asked yet.
          set({ loading: false, lockedFile: { file, notice: options?.notice, error: null } })
          return
        }
        try {
          buf = (await decryptPdf(new Uint8Array(buf), options.password)).slice().buffer as ArrayBuffer
        } catch (e) {
          set({
            loading: false,
            lockedFile: {
              file,
              notice: options?.notice,
              error:
                e instanceof WrongPasswordError
                  ? 'That password does not open this PDF.'
                  : (e as Error).message || 'This PDF could not be unlocked.',
            },
          })
          return
        }
      }

      const renderCopy = buf.slice(0)
      const doc = await loadPdf(renderCopy).promise
      // A different document is now in hand — drop the outgoing PDF's
      // annotations/drawings/signatures/form/find state before showing it.
      clearDocumentState()
      // ⚠️ The deadline is armed in the same breath as the hold, never later.
      // Arming it from the viewer (on mount, say) would mean a document that
      // fails between here and there holds the placeholder for ever.
      if (firstPaintDeadline) clearTimeout(firstPaintDeadline)
      firstPaintDeadline = setTimeout(() => {
        firstPaintDeadline = null
        get().markFirstPaint()
      }, FIRST_PAINT_GRACE_MS)
      set({
        doc,
        numPages: doc.numPages,
        fileName: file.name,
        sourceBytes: buf,
        isXfa: doc.isPureXfa,
        loading: false,
        // Page 1 has not drawn yet; hold the placeholder over the empty page
        // frames rather than showing them. See the field's own note.
        firstPaint: false,
        // Always assigned, never merged: opening a PDF normally has to clear a
        // notice left over from the converted document before it.
        importNotice: options?.notice ?? null,
        lockedFile: null
      })
      // Desktop only: the folder this document came off the disk from, which is
      // where the Save dialog will start rather than ~/Downloads. Said here,
      // once the document is genuinely open, so a file that failed to parse
      // never redirects the next save. See lib/openFolder.ts.
      rememberOpenFolder(file)
      // Re-hydrate any signature-request boxes embedded in the PDF (from a prior
      // export) so a reopened / shared file's boxes are interactive again. The
      // doc is already on screen; this just drops the boxes in a beat later.
      // Callers that restore saved edits (openRecent / loadFromSlug / backup)
      // replace these afterwards, so there's no duplication.
      try {
        const fields = await readEmbeddedSigFields(buf.slice(0))
        if (fields.length > 0) {
          useAnnotationStore.setState((s) => ({ annotations: [...s.annotations, ...fields] }))
        }
      } catch {
        // Best-effort — a parse failure just means no boxes are recovered.
      }
      // Whatever is on screen now IS the document as it arrived, so the exit
      // guard has nothing to offer to save until the user amends it. Boxes
      // recovered from the PDF above are part of the file, not an amendment.
      markSaved()
      // ⚠️ A LOCKED DOCUMENT IS NEVER ADDED TO RECENTS. `buf` is plaintext by
      // this point, and `saveRecent` writes it to IndexedDB — so recording it
      // would leave an unlocked copy of a deliberately locked file on the disk
      // of whatever machine opened it, reachable afterwards with no password
      // at all. Someone who locks a PDF has said what they want; silently
      // keeping a readable copy is the opposite of it.
      //
      // The cost is that a locked document does not survive a refresh and has
      // no shareable slug. That is the right trade, and it is why the hash is
      // cleared rather than left pointing at the previous document.
      if (encrypted) {
        setHashSlug(null)
      } else {
        // Persist to recents in the background — never blocks loading.
        // The returned slug becomes the URL hash so a refresh reloads the
        // same PDF straight from IndexedDB.
        saveRecent(file.name, buf)
          .then((slug) => {
            if (slug) setHashSlug(slug)
            return get().refreshRecents()
          })
          .catch(() => {})
      }
    } catch (e) {
      set({ loading: false })
      throw e
    }
  },
  loadFromSlug: async (slug) => {
    const hit = await getRecentBySlug(slug)
    if (!hit) return false
    const file = new File([hit.bytes], hit.meta.name, { type: 'application/pdf' })
    await get().loadFile(file)
    // Restore the edits saved for this document (supersedes anything loadFile
    // hydrated from the PDF), so a refresh brings back the user's work.
    applyRecentEdits(hit.edits)
    // ⚠️ Restored marks are the baseline, not amendments. They were already
    // there when the document opened, so closing it again without touching
    // anything must not ask about saving a file nothing has changed.
    markSaved()
    return true
  },
  loadFromCurrentUrl: async () => {
    const slug = readHashSlug()
    if (!slug) return false
    const ok = await get().loadFromSlug(slug)
    if (!ok) {
      // Stale slug — clear the hash so we fall back to the landing page.
      setHashSlug(null)
    }
    return ok
  },
  markFirstPaint: () => {
    if (firstPaintDeadline) {
      clearTimeout(firstPaintDeadline)
      firstPaintDeadline = null
    }
    if (!get().firstPaint) set({ firstPaint: true })
  },
  reset: () => {
    get().doc?.destroy()
    clearDocumentState()
    // Nothing is open, so nothing is unsaved. Re-baselining here is also what
    // keeps the structural-edit counter in step across documents.
    markSaved()
    set({ doc: null, numPages: 0, fileName: null, sourceBytes: null, isXfa: false, firstPaint: true, previewOpen: false, presentOpen: false, ocrOpen: false, mergeOpen: false, convertOpen: false, advancedExportOpen: false, metadataOpen: false, qrOpen: false, qrEdit: null, importNotice: null, lockedFile: null })
    setHashSlug(null)
  },
  refreshRecents: async () => {
    const recents = await listRecents()
    set({ recents })
  },
  openRecent: async (id) => {
    const bytes = await getRecent(id)
    if (!bytes) return
    const meta = get().recents.find((r) => r.id === id)
    if (!meta) return
    const file = new File([bytes], meta.name, { type: 'application/pdf' })
    await get().loadFile(file)
    // Restore the edits saved for this document (see loadFromSlug).
    applyRecentEdits(await getRecentEdits(id))
    markSaved()
  },
  removeRecent: async (id) => {
    // Optimistic update, then drop from IndexedDB.
    set((s) => ({ recents: s.recents.filter((r) => r.id !== id) }))
    await deleteRecent(id)
  },
  renameFile: async (newName) => {
    const next = newName.trim()
    if (!next) return
    const cleaned = /\.pdf$/i.test(next) ? next : `${next}.pdf`
    const current = get().fileName
    if (!current || current === cleaned) return
    set({ fileName: cleaned })
    await renameRecent(current, cleaned)
    await get().refreshRecents()
  },
  applyPageOrder: async (newOrder) => {
    const bytes = get().sourceBytes
    const fileName = get().fileName
    if (!bytes || !fileName) return
    if (newOrder.length === 0) return

    const current = get().numPages
    const isNoop =
      newOrder.length === current && newOrder.every((idx, i) => idx === i)
    if (isNoop) return

    const newBytes = await applyPageOrderToPdf(bytes, newOrder)
    const indexMap = buildPageIndexMap(newOrder)

    // Build the new doc FIRST, before touching any state. Previously the
    // annotation/form remap and the old doc's destroy() ran ahead of this
    // getDocument call, so a transient first-attempt failure left annotations
    // remapped and the old doc destroyed — a half-applied state that a second
    // "delete" appeared to fix. Doing all the destructive work only after the
    // new doc is in hand makes the operation atomic: it either fully succeeds
    // or leaves everything untouched. One retry covers a flaky worker init.
    let doc: Awaited<ReturnType<typeof loadPdf>['promise']> | null = null
    for (let attempt = 0; attempt < 2 && !doc; attempt++) {
      try {
        doc = await loadPdf(newBytes.slice(0)).promise
      } catch (err) {
        if (attempt === 1) throw err
      }
    }
    if (!doc) return

    // Now commit, in order: remap annotations/forms (before React renders the
    // new doc so they land on the right pages), swap out the old doc, set state.
    noteStructuralEdit()
    useAnnotationStore.getState().remapPages(indexMap)
    useFormStore.getState().remapPages(indexMap)
    get().doc?.destroy()
    set({ doc, numPages: doc.numPages, sourceBytes: newBytes, isXfa: doc.isPureXfa })

    saveRecent(fileName, newBytes)
      .then((slug) => {
        if (slug) setHashSlug(slug)
        return get().refreshRecents()
      })
      .catch(() => {})
  },
  deletePage: async (pageIndex) => {
    const total = get().numPages
    if (total <= 1) return
    if (pageIndex < 0 || pageIndex >= total) return
    const newOrder = Array.from({ length: total }, (_, i) => i).filter(
      (i) => i !== pageIndex
    )
    await get().applyPageOrder(newOrder)
  },
  movePage: async (from, to) => {
    const total = get().numPages
    if (from === to) return
    if (from < 0 || from >= total) return
    if (to < 0 || to >= total) return
    const order = Array.from({ length: total }, (_, i) => i)
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)
    await get().applyPageOrder(order)
  }
}))

// ── Edit auto-save ─────────────────────────────────────────────────────────
// Persist the open document's annotations + form values to its recents entry,
// debounced, whenever they change — so closing and reopening the file (from the
// recents list or a refresh) restores the work, signature-request boxes and
// all. Selection / tool changes don't touch the annotation array reference, so
// they're skipped here.
if (typeof window !== 'undefined') {
  let timer: number | null = null
  let lastAnns: unknown = null
  let lastForms: unknown = null

  const schedule = () => {
    const anns = useAnnotationStore.getState().annotations
    const forms = useFormStore.getState().values
    if (anns === lastAnns && forms === lastForms) return
    lastAnns = anns
    lastForms = forms
    const { doc, fileName } = usePdfStore.getState()
    if (!doc || !fileName) return
    if (timer !== null) clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      const name = usePdfStore.getState().fileName
      if (!name) return
      void updateRecentEdits(name, {
        annotations: useAnnotationStore.getState().annotations,
        formValues: useFormStore.getState().values
      })
    }, 600)
  }

  useAnnotationStore.subscribe(schedule)
  useFormStore.subscribe(schedule)
}
