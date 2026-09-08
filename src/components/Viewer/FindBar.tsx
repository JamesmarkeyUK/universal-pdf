import { useEffect, useRef, useState } from 'react'
import { usePdfStore } from '../../stores/pdfStore'
import { useSearchStore } from '../../stores/searchStore'
import { useAnnotationStore } from '../../stores/annotationStore'
import { extractDocText, findInDoc, type PageText } from '../../lib/pdfText'
import type { Annotation } from '../../types/annotations'
import { RedactIcon } from '../icons/RedactIcon'

// Pad redaction boxes slightly past the glyph extents so no edge of the
// original text can peek out around a baked black box (in points).
const REDACT_PAD = 1

export default function FindBar() {
  const doc = usePdfStore((s) => s.doc)
  const query = useSearchStore((s) => s.query)
  const setQuery = useSearchStore((s) => s.setQuery)
  const matches = useSearchStore((s) => s.matches)
  const setMatches = useSearchStore((s) => s.setMatches)
  const activeIndex = useSearchStore((s) => s.activeIndex)
  const next = useSearchStore((s) => s.next)
  const prev = useSearchStore((s) => s.prev)
  const setOpen = useSearchStore((s) => s.setOpen)
  const redactIntent = useSearchStore((s) => s.redactIntent)
  const addMany = useAnnotationStore((s) => s.addMany)
  const clearSelection = useAnnotationStore((s) => s.setSelectedIds)
  // Find-and-redact paints with the SAME colour as a hand-drawn redaction — the
  // toolbar's colour, not a setting of its own. The two swatches below are a
  // shortcut into it, not a second place the choice is stored.
  const color = useAnnotationStore((s) => s.color)
  const setColor = useAnnotationStore((s) => s.setColor)

  const inputRef = useRef<HTMLInputElement>(null)
  // Open with the redact panel already showing when the bar was launched from
  // the Redact → "Find and redact" menu.
  const [expanded, setExpanded] = useState(redactIntent)
  const [indexing, setIndexing] = useState(false)
  const [confirmingAll, setConfirmingAll] = useState(false)

  // Cache the extracted page text for the current doc. Re-extracted whenever the
  // doc instance changes (new file, page reorder/delete rebuilds it).
  const pagesRef = useRef<PageText[] | null>(null)
  const pagesDocRef = useRef<typeof doc>(null)

  // Focus the input as soon as the bar mounts.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Recompute matches when the query changes (debounced). Extract the doc text
  // lazily on first search and cache it.
  useEffect(() => {
    let cancelled = false
    const q = query
    // A new search is a new decision: the "are you sure" state must not carry
    // over from the last one. It matters more now that the whole Redact-all
    // block is hidden at exactly one match — editing the query down to one and
    // back up would otherwise land straight in the confirmation.
    setConfirmingAll(false)
    if (!q.trim()) {
      setMatches([])
      return
    }
    const timer = setTimeout(async () => {
      if (!doc) return
      if (pagesRef.current === null || pagesDocRef.current !== doc) {
        setIndexing(true)
        try {
          pagesRef.current = await extractDocText(doc)
          pagesDocRef.current = doc
        } finally {
          if (!cancelled) setIndexing(false)
        }
      }
      if (cancelled || !pagesRef.current) return
      setMatches(findInDoc(pagesRef.current, q))
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, doc, setMatches])

  // Scroll the active match into view whenever it changes.
  useEffect(() => {
    if (activeIndex < 0) return
    const id = requestAnimationFrame(() => {
      const el = document.querySelector('[data-search-active="true"]')
      el?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(id)
  }, [activeIndex, matches])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) prev()
      else next()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  // Turn a set of matches into redaction boxes. Returns how many boxes landed.
  function redactMatches(list: typeof matches): number {
    const items: Annotation[] = []
    for (const m of list) {
      for (const r of m.rects) {
        if (r.w <= 0 || r.h <= 0) continue
        items.push({
          id: crypto.randomUUID(),
          pageIndex: m.pageIndex,
          type: 'redact',
          x: r.x - REDACT_PAD,
          y: r.y - REDACT_PAD,
          width: r.w + REDACT_PAD * 2,
          height: r.h + REDACT_PAD * 2,
          fill: color
        })
      }
    }
    if (items.length === 0) return 0
    addMany(items)
    // Don't leave the boxes selected — the group transformer would sprawl
    // across the page. They're one undo step regardless.
    clearSelection([])
    return items.length
  }

  // Redact only the match currently highlighted, then advance so the user can
  // step through and redact one at a time. The bar stays open.
  function redactCurrent() {
    const m = matches[activeIndex]
    if (!m) return
    if (redactMatches([m])) next()
  }

  function redactAll() {
    if (redactMatches(matches) === 0) return
    setConfirmingAll(false)
    setOpen(false)
  }

  const hasQuery = query.trim().length > 0
  const count = matches.length

  return (
    <div className="absolute top-3 right-3 z-30 w-[300px] rounded-xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400 shrink-0" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in document"
          className="flex-1 min-w-0 text-sm outline-none placeholder:text-slate-400"
        />
        <span className="text-[11px] text-slate-400 tabular-nums shrink-0 min-w-[44px] text-right">
          {indexing ? '…' : hasQuery ? (count ? `${activeIndex + 1} / ${count}` : '0 / 0') : ''}
        </span>
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={prev}
            disabled={count === 0}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            type="button"
            onClick={next}
            disabled={count === 0}
            title="Next match (Enter)"
            aria-label="Next match"
            className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <span aria-hidden="true">↓</span>
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title="More actions"
            aria-label="More actions"
            aria-expanded={expanded}
            className={`w-7 h-7 rounded flex items-center justify-center hover:bg-slate-100 ${expanded ? 'text-slate-900' : 'text-slate-500'}`}
          >
            <RedactIcon size={15} />
          </button>
          <span className="w-px h-5 bg-slate-200 mx-0.5" />
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close (Esc)"
            aria-label="Close find"
            className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:bg-slate-100"
          >
            {/* SVG, not `✕`: U+2715 is a hollow ▯?▯ box in iOS's system
                font — see the suite landmines. */}
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50 px-2.5 py-2.5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-medium text-slate-500">Fill</span>
            <div className="flex items-center gap-1.5">
              {([['#000000', 'Black'], ['#ffffff', 'White']] as const).map(([hex, name]) => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => setColor(hex)}
                  title={`${name} redaction`}
                  aria-pressed={color.toLowerCase() === hex}
                  className={`w-6 h-6 rounded-full border-2 transition-transform ${
                    color.toLowerCase() === hex ? 'border-orange-500 scale-110' : 'border-slate-300 hover:scale-105'
                  }`}
                  style={{ backgroundColor: hex }}
                />
              ))}
              {/* Any other toolbar colour lands here too — shown, not offered,
                  so the bar never disagrees with the swatch that is actually
                  armed. */}
              {color.toLowerCase() !== '#000000' && color.toLowerCase() !== '#ffffff' && (
                <span
                  title={`Current colour ${color}`}
                  className="w-6 h-6 rounded-full border-2 border-orange-500 scale-110"
                  style={{ backgroundColor: color }}
                />
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            {/* First: redact just the highlighted match, then step to the next. */}
            <button
              type="button"
              onClick={redactCurrent}
              disabled={count === 0 || activeIndex < 0}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white border border-slate-200 text-left hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-inherit disabled:hover:border-slate-200 transition-colors group"
            >
              <RedactIcon size={16} className="shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium leading-tight">Redact this 1 match</span>
                <span className="block text-[11px] text-slate-500 group-hover:text-slate-300 leading-tight mt-0.5">
                  {count > 0 ? `Just match ${activeIndex + 1} of ${count}` : 'The highlighted match'} — then jump to the next
                </span>
              </span>
            </button>
            {/* Then: redact every match at once and close.
                ⚠️ NOT OFFERED WHEN THERE IS EXACTLY ONE MATCH (James,
                2026-09-08: "if there's only one match don't show the all match
                option (it's also just one)") — "Redact all 1 match" is the same
                command as the button above it, dressed as a bigger decision,
                and it asks for a confirmation to do it. Still shown at zero
                matches, where it is disabled and its job is to say the option
                exists. */}
            {count !== 1 && (confirmingAll ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-2">
                <p className="text-[11px] text-amber-800 leading-snug">
                  <strong>Double-check before proceeding.</strong> Automatic search may miss some instances — different spellings, formatting, or scanned text won't be caught. Please review the document manually after redacting.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={redactAll}
                    className="flex-1 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs font-medium hover:bg-slate-700"
                  >
                    Redact all {count > 0 ? count : ''} match{count === 1 ? '' : 'es'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingAll(false)}
                    className="flex-1 px-3 py-1.5 rounded-md bg-white border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { if (count > 0) setConfirmingAll(true) }}
                disabled={count === 0}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white border border-slate-200 text-left hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-inherit disabled:hover:border-slate-200 transition-colors group"
              >
                <RedactIcon size={16} className="shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium leading-tight">
                    Redact all {count > 0 ? count : ''} match{count === 1 ? '' : 'es'}
                  </span>
                  <span className="block text-[11px] text-slate-500 group-hover:text-slate-300 leading-tight mt-0.5">
                    {color.toLowerCase() === '#ffffff' ? 'Whites' : 'Blocks'} out every match — text is removed on export
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
