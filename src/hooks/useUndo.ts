import { useAnnotationStore } from '../stores/annotationStore'
import { usePdfStore } from '../stores/pdfStore'

/**
 * Undo, across BOTH histories — the annotation layer's, and the document's.
 *
 * ⚠️ Why there are two, and why this is the only place that knows it (James,
 * 2026-09-08: "allow the undo option to undo things like merge too"). Ctrl+Z
 * has always walked `annotationStore.past`, a list of annotation arrays for one
 * set of bytes. Merge, convert, a page delete and a metadata scrub replace the
 * bytes, and clear that history on the way through — deliberately, so a stroke
 * drawn on the old document cannot be undone back onto the new one. The effect
 * was that the largest changes in the app were the only ones nothing could take
 * back.
 *
 * ORDER: annotations first, document second. That is not a preference, it is
 * the only order that can be right — a document-level change empties the
 * annotation history, so anything left in it was drawn AFTER the last document
 * change and must come off first. Undo therefore walks back through this
 * session's strokes, and only then puts the pre-merge document back.
 *
 * Redo is annotations-only and stays that way: the document stack holds bytes,
 * and keeping a forward copy as well would double the memory for the rarer half
 * of a feature nobody has asked for.
 */
export function useUndo() {
  const canUndoAnnotations = useAnnotationStore((s) => s.past.length > 0)
  const undoAnnotations = useAnnotationStore((s) => s.undo)
  const canRedo = useAnnotationStore((s) => s.future.length > 0)
  const redo = useAnnotationStore((s) => s.redo)

  const docSteps = usePdfStore((s) => s.docUndo)
  const undoDocument = usePdfStore((s) => s.undoDocument)

  const canUndo = canUndoAnnotations || docSteps.length > 0

  function undo() {
    if (canUndoAnnotations) {
      undoAnnotations()
      return
    }
    if (docSteps.length > 0) void undoDocument()
  }

  return {
    canUndo,
    undo,
    canRedo,
    redo,
    /**
     * What the next undo would take back, when it is a whole-document step —
     * 'merge', 'convert', 'page change', 'strip metadata'. Null when the next
     * undo is an ordinary annotation step, which needs no explaining.
     */
    nextDocumentUndo:
      !canUndoAnnotations && docSteps.length > 0 ? docSteps[docSteps.length - 1].label : null
  }
}
