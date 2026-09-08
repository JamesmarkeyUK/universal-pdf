import { useRef, useState } from 'react'
import { mergePdfs } from '../../lib/convert'
import { downloadPdfBytes } from '../../lib/export'
import { usePdfStore } from '../../stores/pdfStore'
import { useExitGuard } from '../../stores/exitGuard'

interface Props {
  onClose: () => void
  /** Seed the merge list with this file (the currently-open document when
   *  launched from the viewer's Advanced menu). Omit for an empty start. */
  initialFile?: File | null
}

interface Item {
  file: File
  /** Stable key so reordering doesn't remount rows / lose focus. */
  key: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// Merge several PDFs into one. Files accumulate in an ordered list the user can
// reorder (up/down) and prune before merging — output order matches the list.
// Reorder is buttons rather than drag-drop: accessible, and it verifies in the
// headless preview where pointer-drag on canvas UI can't.
export default function MergeDialog({ onClose, initialFile }: Props) {
  const keySeq = useRef(0)
  const [items, setItems] = useState<Item[]>(() =>
    initialFile ? [{ file: initialFile, key: `f${keySeq.current++}` }] : [],
  )
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const loadFile = usePdfStore((s) => s.loadFile)
  const snapshotDocument = usePdfStore((s) => s.snapshotDocument)
  const requestExit = useExitGuard((s) => s.requestExit)

  function addFiles(fileList: FileList | File[]) {
    const pdfs = Array.from(fileList).filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    )
    if (pdfs.length === 0) return
    setItems((prev) => [
      ...prev,
      ...pdfs.map((file) => ({ file, key: `f${keySeq.current++}` }))
    ])
  }

  function move(index: number, dir: -1 | 1) {
    setItems((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function remove(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key))
  }

  async function buildBytes(): Promise<Uint8Array> {
    const buffers: ArrayBuffer[] = []
    for (const it of items) buffers.push(await it.file.arrayBuffer())
    return mergePdfs(buffers)
  }

  async function onMergeDownload() {
    if (items.length < 2 || busy) return
    setBusy(true)
    try {
      const bytes = await buildBytes()
      downloadPdfBytes(bytes, 'merged.pdf')
      onClose()
    } catch (err) {
      console.error(err)
      alert('Merge failed: ' + (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function onMergeOpen() {
    if (items.length < 2 || busy) return
    setBusy(true)
    try {
      const bytes = await buildBytes()
      // pdf-lib returns a Uint8Array view; copy into a fresh buffer so the File
      // owns contiguous bytes independent of pdf-lib's backing store.
      const file = new File([bytes.slice() as BlobPart], 'merged.pdf', {
        type: 'application/pdf'
      })
      // ⚠️ THROUGH THE EXIT GUARD, because opening the merged file over the top
      // of an annotated document throws that annotation layer away — the same
      // loss the guard already covers for Close and Open-another, arrived at by
      // a route that never asked. It runs straight through when there is
      // nothing unsaved, so a plain merge is still one click.
      requestExit('merge', async () => {
        // Before the load, and paired with `keepDocUndo` so the step survives
        // it: this is what makes Undo able to put the old document back.
        snapshotDocument('merge')
        await loadFile(file, { keepDocUndo: true })
        onClose()
      })
    } catch (err) {
      console.error(err)
      alert('Merge failed: ' + (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canMerge = items.length >= 2 && !busy

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl p-5 w-full max-w-lg max-h-[min(100%,100dvh)] flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">Merge PDFs</h2>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center disabled:opacity-50"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-3">
          Combine files into one PDF. Drag to add, reorder, then merge — nothing leaves your device.
        </p>

        {/* Drop / add zone */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragEnter={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDragOver(true)
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (!dragOver) setDragOver(true)
          }}
          onDragLeave={(e) => {
            e.stopPropagation()
            setDragOver(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDragOver(false)
            if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
          }}
          className={[
            'w-full flex items-center justify-center gap-2 p-3 rounded-lg border-2 border-dashed text-sm font-medium transition-colors',
            dragOver
              ? 'border-orange-500 bg-orange-50 text-orange-700'
              : 'border-slate-300 text-slate-600 hover:border-orange-400 hover:bg-orange-50/50'
          ].join(' ')}
        >
          <span aria-hidden="true">＋</span>
          {dragOver ? 'Drop PDFs to add' : 'Add PDFs…'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {/* Ordered list */}
        <div className="mt-3 flex-1 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100 min-h-[3rem]">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-slate-400">
              No files yet — add two or more PDFs to merge.
            </div>
          ) : (
            items.map((it, i) => (
              <div key={it.key} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="w-5 text-right tabular-nums text-slate-400">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-800" title={it.file.name}>
                    {it.file.name}
                  </div>
                  <div className="text-xs text-slate-500 tabular-nums">
                    {formatSize(it.file.size)}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={() => move(i, -1)}
                    disabled={i === 0 || busy}
                    aria-label={`Move ${it.file.name} up`}
                    className="w-7 h-7 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === items.length - 1 || busy}
                    aria-label={`Move ${it.file.name} down`}
                    className="w-7 h-7 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => remove(it.key)}
                    disabled={busy}
                    aria-label={`Remove ${it.file.name}`}
                    className="w-7 h-7 rounded hover:bg-red-50 hover:text-red-600 text-slate-400 disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-4 flex items-center gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onMergeOpen}
            disabled={!canMerge}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Merge &amp; open
          </button>
          <button
            onClick={onMergeDownload}
            disabled={!canMerge}
            className="px-4 py-2 bg-orange-700 hover:bg-orange-800 text-white rounded text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? 'Merging…' : `⬇ Merge ${items.length || ''} & download`}
          </button>
        </div>
      </div>
    </div>
  )
}
