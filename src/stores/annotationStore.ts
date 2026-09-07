import { create } from 'zustand'
import type { Annotation, FontFamily, Tool } from '../types/annotations'
import type { QrPlacement } from '../lib/qr/design'

interface AnnotationState {
  tool: Tool
  // The one colour every annotation is drawn with, redactions included — a
  // redaction stores it as `fill` rather than `color`, but the toolbar swatches
  // are the single control (there is no separate redaction palette any more).
  color: string
  strokeWidth: number
  // When true the line tool draws "rigid" strokes that snap to the nearest
  // horizontal, vertical or 45° diagonal. Free-form lines when false.
  lineSnap: boolean
  fontSize: number
  fontFamily: FontFamily
  annotations: Annotation[]
  // Primary single selection. Kept in sync with `selectedIds`: it is the id
  // when exactly one thing is selected, and null for an empty or multi
  // selection. Existing single-select callers can keep reading this.
  selectedId: string | null
  // Full selection set. Drives the group move/resize/rotate Transformer.
  selectedIds: string[]
  uploadedImageSrc: string | null
  // Set alongside `uploadedImageSrc` when the armed image is a generated QR
  // code: the editor state it came from, which rides onto the annotation at
  // placement so the code can be edited again on the page. Null for an
  // ordinary uploaded picture.
  uploadedImageQr: QrPlacement | null
  past: Annotation[][]
  future: Annotation[][]
  setTool: (t: Tool) => void
  setColor: (c: string) => void
  setStrokeWidth: (w: number) => void
  setLineSnap: (v: boolean) => void
  setFontSize: (s: number) => void
  // Remember the size (in display pixels) the next text should be placed at,
  // WITHOUT touching the selected annotation. The floating size pill sets a
  // selected box's size absolutely — it knows the zoom, so it can convert
  // display pixels to points itself — and then records the choice here so the
  // next text matches. `setFontSize` is the relative nudge the toolbar uses.
  setDefaultFontSize: (s: number) => void
  setFontFamily: (f: FontFamily) => void
  setSelected: (id: string | null) => void
  setSelectedIds: (ids: string[]) => void
  toggleSelected: (id: string) => void
  setUploadedImageSrc: (src: string | null, qr?: QrPlacement | null) => void
  add: (a: Annotation) => void
  addMany: (items: Annotation[]) => void
  update: (id: string, patch: Partial<Annotation>) => void
  updateMany: (patches: { id: string; patch: Partial<Annotation> }[]) => void
  remove: (id: string) => void
  removeMany: (ids: string[]) => void
  clearPage: (pageIndex: number) => void
  clearAll: () => void
  // Hard reset for loading a different PDF: drops every annotation AND the
  // undo/redo history, so nothing from the previous document can be undone
  // back onto the new one. (clearAll deliberately keeps history so the user can
  // undo the clear; that would be wrong across documents.)
  resetDocument: () => void
  remapPages: (indexMap: Map<number, number>) => void
  undo: () => void
  redo: () => void
}

const MAX_HISTORY = 100

function pushPast(past: Annotation[][], current: Annotation[]): Annotation[][] {
  const next = [...past, current]
  return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
}

export const useAnnotationStore = create<AnnotationState>((set) => ({
  tool: 'select',
  color: '#000000',
  strokeWidth: 2.5,
  lineSnap: false,
  fontSize: 18,
  fontFamily: 'sans',
  annotations: [],
  selectedId: null,
  selectedIds: [],
  uploadedImageSrc: null,
  uploadedImageQr: null,
  past: [],
  future: [],
  setTool: (tool) => set({ tool }),
  // The QR payload defaults to null rather than being left alone, so arming a
  // plain picture after a code can't drop the code's design onto it.
  setUploadedImageSrc: (uploadedImageSrc, uploadedImageQr = null) =>
    set({ uploadedImageSrc, uploadedImageQr }),
  setColor: (color) =>
    set((s) => {
      const sel = s.annotations.find((a) => a.id === s.selectedId)
      if (sel && sel.type !== 'image') {
        // A redaction carries its colour as `fill` — the solid block it is
        // baked as — where every other annotation carries `color`. Same
        // swatches, same setter; only the field differs.
        const patch = sel.type === 'redact' ? { fill: color } : { color }
        return {
          color,
          annotations: s.annotations.map((a) =>
            a.id === sel.id ? ({ ...a, ...patch } as Annotation) : a
          ),
          past: pushPast(s.past, s.annotations),
          future: []
        }
      }
      return { color }
    }),
  setStrokeWidth: (strokeWidth) =>
    set((s) => {
      const sel = s.annotations.find((a) => a.id === s.selectedId)
      if (sel && sel.type === 'draw') {
        return {
          strokeWidth,
          annotations: s.annotations.map((a) =>
            a.id === sel.id ? ({ ...a, strokeWidth } as Annotation) : a
          ),
          past: pushPast(s.past, s.annotations),
          future: []
        }
      }
      return { strokeWidth }
    }),
  setLineSnap: (lineSnap) => set({ lineSnap }),
  setFontSize: (fontSize) =>
    set((s) => {
      const sel = s.annotations.find((a) => a.id === s.selectedId)
      if (sel && sel.type === 'text') {
        // The pill shows a size in display pixels, but a text annotation stores
        // its size in PDF points (created as display ÷ scale — see
        // AnnotationLayer). Writing the raw pill value straight into the
        // annotation mixed the two spaces, so a single +/- step snapped the
        // on-screen text by the zoom factor. Instead nudge the annotation's
        // point size by the same ratio the pill moved, keeping display and
        // model in lock-step whatever the current zoom.
        const prev = s.fontSize || fontSize
        const nextFontSize = Math.max(1, sel.fontSize * (prev > 0 ? fontSize / prev : 1))
        return {
          fontSize,
          annotations: s.annotations.map((a) =>
            a.id === sel.id ? ({ ...a, fontSize: nextFontSize } as Annotation) : a
          ),
          past: pushPast(s.past, s.annotations),
          future: []
        }
      }
      return { fontSize }
    }),
  setDefaultFontSize: (fontSize) => set({ fontSize }),
  setFontFamily: (fontFamily) =>
    set((s) => {
      const sel = s.annotations.find((a) => a.id === s.selectedId)
      if (sel && sel.type === 'text') {
        return {
          fontFamily,
          annotations: s.annotations.map((a) =>
            a.id === sel.id ? ({ ...a, fontFamily } as Annotation) : a
          ),
          past: pushPast(s.past, s.annotations),
          future: []
        }
      }
      return { fontFamily }
    }),
  setSelected: (selectedId) =>
    set({ selectedId, selectedIds: selectedId ? [selectedId] : [] }),
  setSelectedIds: (ids) =>
    set({ selectedIds: ids, selectedId: ids.length === 1 ? ids[0] : null }),
  toggleSelected: (id) =>
    set((s) => {
      const next = s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id]
      return { selectedIds: next, selectedId: next.length === 1 ? next[0] : null }
    }),
  add: (a) =>
    set((s) => ({
      annotations: [...s.annotations, a],
      selectedId: a.id,
      selectedIds: [a.id],
      past: pushPast(s.past, s.annotations),
      future: []
    })),
  // Add several annotations as one history step (e.g. "Redact all matches"),
  // so the whole batch is a single undo and ends up selected together.
  addMany: (items) =>
    set((s) => {
      if (items.length === 0) return {}
      return {
        annotations: [...s.annotations, ...items],
        selectedId: items.length === 1 ? items[0].id : null,
        selectedIds: items.map((i) => i.id),
        past: pushPast(s.past, s.annotations),
        future: []
      }
    }),
  update: (id, patch) =>
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id ? ({ ...a, ...patch } as Annotation) : a
      ),
      past: pushPast(s.past, s.annotations),
      future: []
    })),
  // Apply several patches as a single history step so a group move / resize /
  // rotate is one undo, not one-per-annotation.
  updateMany: (patches) =>
    set((s) => {
      if (patches.length === 0) return {}
      const byId = new Map(patches.map((p) => [p.id, p.patch]))
      return {
        annotations: s.annotations.map((a) =>
          byId.has(a.id) ? ({ ...a, ...byId.get(a.id) } as Annotation) : a
        ),
        past: pushPast(s.past, s.annotations),
        future: []
      }
    }),
  remove: (id) =>
    set((s) => ({
      annotations: s.annotations.filter((a) => a.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      selectedIds: s.selectedIds.filter((x) => x !== id),
      past: pushPast(s.past, s.annotations),
      future: []
    })),
  removeMany: (ids) =>
    set((s) => {
      if (ids.length === 0) return {}
      const drop = new Set(ids)
      return {
        annotations: s.annotations.filter((a) => !drop.has(a.id)),
        selectedId: null,
        selectedIds: [],
        past: pushPast(s.past, s.annotations),
        future: []
      }
    }),
  clearPage: (pageIndex) =>
    set((s) => ({
      annotations: s.annotations.filter((a) => a.pageIndex !== pageIndex),
      past: pushPast(s.past, s.annotations),
      future: []
    })),
  clearAll: () =>
    set((s) => ({
      annotations: [],
      selectedId: null,
      selectedIds: [],
      past: pushPast(s.past, s.annotations),
      future: []
    })),
  resetDocument: () =>
    set({
      annotations: [],
      selectedId: null,
      selectedIds: [],
      uploadedImageSrc: null,
      uploadedImageQr: null,
      past: [],
      future: []
    }),
  remapPages: (indexMap) =>
    set((s) => ({
      annotations: s.annotations
        .filter((a) => indexMap.has(a.pageIndex))
        .map((a) => ({ ...a, pageIndex: indexMap.get(a.pageIndex)! } as Annotation)),
      selectedId: null,
      selectedIds: [],
      past: pushPast(s.past, s.annotations),
      future: []
    })),
  undo: () =>
    set((s) => {
      if (s.past.length === 0) return {}
      const prev = s.past[s.past.length - 1]
      return {
        annotations: prev,
        past: s.past.slice(0, -1),
        future: [...s.future, s.annotations],
        selectedId: null,
        selectedIds: []
      }
    }),
  redo: () =>
    set((s) => {
      if (s.future.length === 0) return {}
      const next = s.future[s.future.length - 1]
      return {
        annotations: next,
        past: [...s.past, s.annotations],
        future: s.future.slice(0, -1),
        selectedId: null,
        selectedIds: []
      }
    })
}))
