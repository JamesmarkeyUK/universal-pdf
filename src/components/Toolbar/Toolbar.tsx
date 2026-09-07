import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnnotationStore } from '../../stores/annotationStore'
import { usePdfStore } from '../../stores/pdfStore'
import SignatureMenu from '../Signature/SignatureMenu'
import ExportModal from '../Export/ExportModal'
import { FONT_DEFS } from '../../lib/fonts'
import { useCoarsePointer } from '../../hooks/useCoarsePointer'
import type { Annotation, Tool } from '../../types/annotations'

// The always-visible core fonts; the rest (FONT_DEFS) are revealed by the "+"
// more-fonts button in the text options.
const FONT_OPTIONS = FONT_DEFS.filter((f) => !f.extended)

const LONG_PRESS_MS = 450

function HighlighterIcon({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Yellow marker body */}
      <path d="M16 3 L21 8 L12 17 L7 12 Z" fill="#fde047" stroke="#a16207" strokeWidth="0.8" strokeLinejoin="round" />
      {/* Dark chisel tip */}
      <path d="M7 12 L12 17 L10 19 L5 19 L4 18 L4 14 Z" fill="#1e293b" stroke="#0f172a" strokeWidth="0.8" strokeLinejoin="round" />
      {/* Highlight swipe under tip */}
      <path d="M3 22 L13 22" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
    </svg>
  )
}

function QrIcon({ className = 'w-6 h-6' }: { className?: string }) {
  // Finder eyes in the suite orange, modules in a light slate — the same
  // arrangement the generator's own default wears, so the button looks like
  // what it makes. No active state: the button opens a dialog rather than
  // selecting a tool (what it arms afterwards is the image tool).
  const eye = '#fb923c'
  const dot = '#e2e8f0'
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      {([[3, 3], [15, 3], [3, 15]] as const).map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <rect x={x} y={y} width="6" height="6" rx="1.6" fill="none" stroke={eye} strokeWidth="1.6" />
          <rect x={x + 2} y={y + 2} width="2" height="2" rx="0.6" fill={eye} />
        </g>
      ))}
      {([[13, 13], [17, 13], [13, 17], [19, 17], [17, 19], [11, 6], [11, 10], [6, 11], [10, 11], [14, 11], [19, 11], [11, 14]] as const).map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="2" height="2" rx="0.5" fill={dot} />
      ))}
    </svg>
  )
}

function PictureFrameIcon({ active = false, className = 'w-6 h-6' }: { active?: boolean; className?: string }) {
  const frame = active ? '#fff' : '#fbbf24'
  const sky = '#7dd3fc'
  const ground = '#86efac'
  const sun = '#fde047'
  const mountain = '#94a3b8'
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" fill={sky} stroke={frame} strokeWidth="1.6" />
      <rect x="3" y="14" width="18" height="6" fill={ground} />
      <circle cx="8.5" cy="9" r="1.8" fill={sun} />
      <path d="M3 17 L9 11 L13 14 L18 9 L21 12 L21 20 L3 20 Z" fill={mountain} opacity="0.9" />
      <rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke={frame} strokeWidth="1.6" />
    </svg>
  )
}

const COLORS = [
  { hex: '#000000', name: 'Black' },
  { hex: '#ffffff', name: 'White' },
  { hex: '#dc2626', name: 'Red' },
  { hex: '#2563eb', name: 'Blue' },
  { hex: '#16a34a', name: 'Green' },
  { hex: '#eab308', name: 'Yellow' },
  { hex: '#9333ea', name: 'Purple' }
]

const HIGHLIGHT_YELLOW = '#eab308'
const HIGHLIGHT_GREEN = '#16a34a'

const DRAW_SHAPES: { id: Tool; icon: string; label: string }[] = [
  { id: 'tick', icon: '✓', label: 'Tick' },
  { id: 'cross', icon: '✗', label: 'Cross' },
  { id: 'line', icon: '╱', label: 'Line' },
  { id: 'rect', icon: '▭', label: 'Box' },
  { id: 'ellipse', icon: '◯', label: 'Circle' }
]

type Panel = 'select' | 'text' | 'draw' | 'color' | null

// Breathing room kept between a floated panel and the window edge — and
// between it and anything it is not allowed to cover.
const PANEL_MARGIN = 8

// Renders a toolbar dropdown into a body-level portal, fixed-positioned under
// its anchor. The desktop toolbar sits inside an `overflow-x-auto` container
// (so it can scroll horizontally on narrow viewports); per the CSS overflow
// spec that container also clips vertically, which turned the dropdowns into an
// inner scrollbar instead of letting them overlay the PDF. Portaling escapes
// the clip. `panelRef` is shared with the outside-click handler so clicks
// inside the floated panel don't close it.
function FloatingPanel({
  anchorRef,
  panelRef,
  children
}: {
  anchorRef: React.RefObject<HTMLDivElement>
  panelRef: React.RefObject<HTMLDivElement>
  children: React.ReactNode
}) {
  // ⚠️ The position is written STRAIGHT TO THE NODE and remembered in a ref —
  // it is deliberately not React state, and putting it back into state would
  // reintroduce a crash that took the whole app down (owner, 2026-09-04: "when
  // i clicked the X draw tool" → the root ErrorBoundary). `place` runs from a
  // dep-less layout effect, i.e. after EVERY commit. While the answer never
  // changed, the old `setPos` no-op'd and React's eager bailout stopped there —
  // but the first time it genuinely moved (picking ✓/✗ opened a placement
  // banner under the toolbar, and the panel steps below it) the update was
  // dispatched from inside the commit phase, where that bailout no longer
  // applies: the state landed, the effect ran again, dispatched again, and
  // every commit scheduled the next one. React gave up at 50 — "Maximum update
  // depth exceeded" — and the error boundary replaced the document with
  // "Something went wrong". A DOM write can't schedule a render, so the loop
  // has nowhere to start.
  const posRef = useRef<{ left: number; top: number } | null>(null)
  const place = useCallback(() => {
    const el = anchorRef.current
    const panel = panelRef.current
    if (!el || !panel) return
    const r = el.getBoundingClientRect()
    const w = panel.offsetWidth
    const h = panel.offsetHeight
    // Left-align with the anchor, but never run off the right of the window.
    // The draw options are nearly as wide as the toolbar itself, so anchored
    // under a button that sits mid-bar they used to hang off the screen.
    const left = Math.max(PANEL_MARGIN, Math.min(r.left, window.innerWidth - w - PANEL_MARGIN))
    let top = r.bottom + 4
    // The placement banner ("Click the page to place…") floats directly under
    // the toolbar too, and it reports live state the user needs — so the
    // panel steps below it rather than covering it.
    const hint = document.querySelector('[data-placement-hint]')
    if (hint) {
      const a = hint.getBoundingClientRect()
      const overlaps =
        left < a.right + PANEL_MARGIN &&
        left + w > a.left - PANEL_MARGIN &&
        top < a.bottom + PANEL_MARGIN &&
        top + h > a.top - PANEL_MARGIN
      if (overlaps) top = a.bottom + PANEL_MARGIN
    }
    top = Math.max(PANEL_MARGIN, Math.min(top, window.innerHeight - h - PANEL_MARGIN))
    const prev = posRef.current
    if (prev && prev.left === left && prev.top === top) return
    posRef.current = { left, top }
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    // Hidden until measured — see the render below.
    panel.style.visibility = 'visible'
  }, [anchorRef, panelRef])

  // Re-place on EVERY render, not just on mount: picking ✓ from the open sheet
  // arms a placement, so the banner it must dodge can appear while the panel is
  // already up.
  useLayoutEffect(place)

  useLayoutEffect(() => {
    // Where it fits depends on its own size, and the content changes under it
    // (more fonts revealed, a different tool's swatches) — so watch the box,
    // not just the window.
    const ro = new ResizeObserver(place)
    if (panelRef.current) ro.observe(panelRef.current)
    window.addEventListener('resize', place)
    // Capture phase so the toolbar's own horizontal scroll (and any ancestor
    // scroll) keeps the panel pinned to its anchor.
    window.addEventListener('scroll', place, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [place, panelRef])
  return createPortal(
    // Rendered — invisible, at 0,0 — before it has been placed, because the
    // effect above has to measure it to place it. Those three values are the
    // panel's STARTING state only: `place` overwrites left/top/visibility on the
    // node itself. React never rewrites them, because what it renders here never
    // changes between renders, so there is nothing for it to diff and undo.
    // maxWidth is what lets a too-wide panel wrap onto a second row instead of
    // overflowing the window.
    <div
      ref={panelRef}
      data-toolbar-panel
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        zIndex: 60,
        maxWidth: `calc(100vw - ${PANEL_MARGIN * 2}px)`,
        visibility: 'hidden'
      }}
    >
      {children}
    </div>,
    document.body
  )
}

// `touchHelp` replaces `help` on a touchscreen, and `gesture` is the same fact
// short enough for the mobile panel's buttons. They exist for exactly one
// reason: Select area is drawn with a different gesture there. A finger's plain
// drag belongs to the document — that is how a reader reaches page 4 — so the
// box is started by pressing and holding first (see MARQUEE_HOLD_MS in
// AnnotationLayer). A gesture nobody is told about is a gesture nobody finds,
// and this list is the one place a reader looks at the tool before picking it.
const SELECT_OPTIONS: {
  id: Tool
  icon: string
  label: string
  help: string
  touchHelp?: string
  gesture?: string
}[] = [
  { id: 'select', icon: '↖', label: 'Select', help: 'Click to move, resize or edit. On desktop, drag empty space to select many' },
  {
    id: 'marquee',
    icon: '⛶',
    label: 'Select area',
    help: 'Drag a box to select many edits, then move/resize/rotate them together',
    touchHelp: 'Press and hold, then drag a box to select many edits — a plain swipe still scrolls the document',
    gesture: 'hold, then drag'
  },
  { id: 'selecttext', icon: '⌶', label: 'Select text', help: "Drag over the PDF's own text to select it, then copy (Ctrl/⌘C)" },
  { id: 'hand', icon: '✋', label: 'Hand', help: 'Drag to pan around the PDF without selecting' }
]

// Icon shown on the main Select-group button for the currently-active tool.
const SELECT_GROUP_ICON: Partial<Record<Tool, string>> = {
  select: '↖',
  marquee: '⛶',
  selecttext: '⌶',
  hand: '✋'
}

// Which group tool is "active" for the main Select-group button (drives its
// icon + whether a re-tap toggles the options panel).
function selectGroupTool(tool: Tool): Tool {
  return tool === 'hand' || tool === 'marquee' || tool === 'selecttext' ? tool : 'select'
}

// Module-level in-app clipboard for annotations (Ctrl+C/X/V)
let clipboardAnnotation: Annotation | null = null

// Shared keyboard shortcuts: Delete/Backspace, Ctrl+Z, Ctrl+C/X/V.
// Mounted once at the App level whenever a PDF is loaded.
export function useToolbarKeyboardShortcuts(enabled: boolean) {
  const selectedId = useAnnotationStore((s) => s.selectedId)
  const selectedIds = useAnnotationStore((s) => s.selectedIds)
  const undo = useAnnotationStore((s) => s.undo)
  const redo = useAnnotationStore((s) => s.redo)
  const remove = useAnnotationStore((s) => s.remove)
  const removeMany = useAnnotationStore((s) => s.removeMany)
  const add = useAnnotationStore((s) => s.add)

  useEffect(() => {
    if (!enabled) return
    function isEditable(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null
      if (!el) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if ((el as HTMLElement).isContentEditable) return true
      return false
    }
    function onKey(e: KeyboardEvent) {
      if (isEditable(document.activeElement)) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }
      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
        return
      }
      if (mod && key === 'c') {
        if (!selectedId) return
        const sel = useAnnotationStore.getState().annotations.find((a) => a.id === selectedId)
        if (!sel) return
        clipboardAnnotation = sel
        e.preventDefault()
        return
      }
      if (mod && key === 'x') {
        if (!selectedId) return
        const sel = useAnnotationStore.getState().annotations.find((a) => a.id === selectedId)
        if (!sel) return
        clipboardAnnotation = sel
        remove(selectedId)
        e.preventDefault()
        return
      }
      if (mod && key === 'v') {
        if (!clipboardAnnotation) return
        const clone: Annotation = JSON.parse(JSON.stringify(clipboardAnnotation))
        clone.id = crypto.randomUUID()
        if ('x' in clone && 'y' in clone) {
          ;(clone as { x: number; y: number }).x = (clone as { x: number; y: number }).x + 20
          ;(clone as { x: number; y: number }).y = (clone as { x: number; y: number }).y + 20
        } else if ('points' in clone) {
          ;(clone as { points: number[] }).points = (clone as { points: number[] }).points.map((v, i) =>
            i % 2 === 0 ? v + 20 : v + 20
          )
        }
        add(clone)
        e.preventDefault()
        return
      }
      if (!mod && key === 'f') {
        // Enter presentation. Guarded by isEditable above so it won't fire
        // while typing into a text annotation / rename field.
        const pdf = usePdfStore.getState()
        if (pdf.sourceBytes && !pdf.presentOpen) {
          e.preventDefault()
          pdf.setPresentOpen(true)
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.length > 1) {
          e.preventDefault()
          removeMany(selectedIds)
          return
        }
        if (!selectedId) return
        e.preventDefault()
        remove(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, selectedId, selectedIds, remove, removeMany, undo, redo, add])
}

const isDrawShape = (t: Tool) => t === 'tick' || t === 'cross' || t === 'line' || t === 'rect' || t === 'ellipse' || t === 'highlight'

// --- DESKTOP TOOLS (left, inline in header) -------------------------------
export function ToolbarDesktopTools() {
  // A tablet gets this toolbar at lg+ but drives it with a finger, so the
  // help text has to name the gesture the reader actually has.
  const coarsePointer = useCoarsePointer()
  const tool = useAnnotationStore((s) => s.tool)
  const color = useAnnotationStore((s) => s.color)
  const strokeWidth = useAnnotationStore((s) => s.strokeWidth)
  const selectedId = useAnnotationStore((s) => s.selectedId)
  const setTool = useAnnotationStore((s) => s.setTool)
  const setColor = useAnnotationStore((s) => s.setColor)
  const setStrokeWidth = useAnnotationStore((s) => s.setStrokeWidth)
  const setSelected = useAnnotationStore((s) => s.setSelected)
  const remove = useAnnotationStore((s) => s.remove)
  const fontSize = useAnnotationStore((s) => s.fontSize)
  const setFontSize = useAnnotationStore((s) => s.setFontSize)
  const fontFamily = useAnnotationStore((s) => s.fontFamily)
  const setFontFamily = useAnnotationStore((s) => s.setFontFamily)
  const setUploadedImageSrc = useAnnotationStore((s) => s.setUploadedImageSrc)
  const setQrOpen = usePdfStore((s) => s.setQrOpen)

  const [openPanel, setOpenPanel] = useState<Panel>(null)
  // Reveals the extra built-in fonts (Georgia, Verdana, …) in the text panel.
  const [moreFonts, setMoreFonts] = useState(false)

  const selectGroupRef = useRef<HTMLDivElement>(null)
  const textGroupRef = useRef<HTMLDivElement>(null)
  const drawGroupRef = useRef<HTMLDivElement>(null)
  // Inside the draw group the two "+"s open different panels from different
  // anchors: the pencil's is the full tool sheet, the swatches' is colours only.
  const drawToolRef = useRef<HTMLDivElement>(null)
  const colorGroupRef = useRef<HTMLDivElement>(null)
  // The open panel is portaled out of the toolbar, so it's no longer a DOM
  // descendant of the group refs — track it separately for outside-click.
  const panelContentRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  const pressTimer = useRef<number | null>(null)
  const longPressed = useRef(false)

  function togglePanel(p: Panel) {
    setOpenPanel((prev) => (prev === p ? null : p))
  }

  useEffect(() => {
    if (!openPanel) return
    function onDoc(e: MouseEvent) {
      const refs = [selectGroupRef, textGroupRef, drawGroupRef, panelContentRef]
      const inside = refs.some((r) => r.current?.contains(e.target as Node))
      if (!inside) setOpenPanel(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [openPanel])

  // Drawing a line auto-selects it and pops a contextual stroke/snap panel next
  // to the line. Collapse the draw-options dropdown so that panel isn't hidden
  // behind it.
  useEffect(() => {
    if (!selectedId) return
    const sel = useAnnotationStore.getState().annotations.find((a) => a.id === selectedId)
    if (sel && sel.type === 'draw' && sel.shape === 'line') setOpenPanel(null)
  }, [selectedId])

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const src = ev.target?.result as string
      setUploadedImageSrc(src)
      setTool('image')
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  function PlusBox({ panel, label = 'options' }: { panel: Panel; label?: string }) {
    return (
      <button
        onClick={() => togglePanel(panel)}
        className={`w-[14px] h-[14px] text-[9px] font-bold rounded-[3px] flex items-center justify-center transition-colors border self-start mt-[3px] -ml-[2px] leading-none ${
          openPanel === panel
            ? 'bg-orange-700 border-orange-400 text-white'
            : 'bg-slate-600 border-slate-500 text-slate-300 hover:bg-slate-500 hover:text-white'
        }`}
        title={`${openPanel === panel ? 'Close' : 'Open'} ${label}`}
        aria-label={`${openPanel === panel ? 'Close' : 'Open'} ${label}`}
        aria-expanded={openPanel === panel}
      >
        +
      </button>
    )
  }

  function startLongPress(panel?: Panel) {
    if (!panel) return
    longPressed.current = false
    if (pressTimer.current !== null) clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true
      setOpenPanel(panel)
    }, LONG_PRESS_MS)
  }
  function endLongPress() {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }
  function handleToolClick(id: Tool, panel?: Panel, defaultColor?: string) {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (panel && tool === id) {
      togglePanel(panel)
    } else {
      setTool(id)
      if (defaultColor) {
        // Deselect first so setColor doesn't repaint the currently selected
        // annotation when the user is really just switching tools.
        setSelected(null)
        setColor(defaultColor)
      }
    }
  }

  function toolBtn(id: Tool, icon: string, label: string, panel?: Panel, defaultColor?: string) {
    return (
      <button
        key={id}
        onClick={() => handleToolClick(id, panel, defaultColor)}
        onPointerDown={() => startLongPress(panel)}
        onPointerUp={endLongPress}
        onPointerLeave={endLongPress}
        onPointerCancel={endLongPress}
        title={panel ? `${label} — tap again or long-press for options` : label}
        className={`w-9 h-9 rounded flex items-center justify-center text-lg font-semibold transition-colors ${
          tool === id ? 'bg-orange-700' : 'hover:bg-slate-700'
        }`}
      >
        {icon}
      </button>
    )
  }

  function colorSwatch(hex: string, name: string, small = false, onActiveReclick?: () => void) {
    const active = color === hex
    return (
      <button
        key={hex}
        onClick={() => {
          if (active && onActiveReclick) onActiveReclick()
          else setColor(hex)
        }}
        title={onActiveReclick ? `${name} — click again for more colours` : name}
        className={`rounded-full border-2 transition-transform flex-shrink-0 ${
          small ? 'w-6 h-6' : 'w-7 h-7'
        } ${active ? 'border-white scale-110' : 'border-slate-600 hover:scale-105'}`}
        style={{ backgroundColor: hex }}
      />
    )
  }

  function ColorPickerTrigger() {
    const isCustom = !COLORS.some((c) => c.hex === color)
    return (
      <label
        title="Custom colour"
        className={`w-7 h-7 rounded-full cursor-pointer border-2 flex-shrink-0 overflow-hidden transition-transform ${
          isCustom ? 'border-white scale-110' : 'border-slate-600 hover:scale-105'
        }`}
        style={{
          background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)'
        }}
      >
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="sr-only"
        />
      </label>
    )
  }

  return (
    <div className="hidden lg:flex items-center gap-1 text-white shrink-0 [&>*]:shrink-0">
      {/* Select / Hand with options panel */}
      <div ref={selectGroupRef} className="relative flex items-start">
        {toolBtn(
          selectGroupTool(tool),
          SELECT_GROUP_ICON[tool] ?? '↖',
          tool === 'hand'
            ? 'Hand — drag to pan'
            : tool === 'marquee'
              ? 'Select area — drag a box'
              : tool === 'selecttext'
                ? 'Select text — drag to copy the PDF text'
                : 'Select / move',
          'select'
        )}
        <PlusBox panel="select" label="select options" />
        {openPanel === 'select' && (
          <FloatingPanel anchorRef={selectGroupRef} panelRef={panelContentRef}>
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-xl py-1 whitespace-nowrap min-w-56">
            {SELECT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => { if (opt.id === 'selecttext') setSelected(null); setTool(opt.id); setOpenPanel(null) }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                  tool === opt.id ? 'bg-orange-700 text-white' : 'hover:bg-slate-700 text-slate-100'
                }`}
              >
                <span className="text-lg leading-none w-5 text-center">{opt.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-[11px] opacity-70">
                    {(coarsePointer && opt.touchHelp) || opt.help}
                  </div>
                </div>
              </button>
            ))}
          </div>
          </FloatingPanel>
        )}
      </div>

      <div className="w-px h-6 bg-slate-700 mx-1" />

      {/* Text + font-size expander */}
      <div ref={textGroupRef} className="relative flex items-start">
        {toolBtn('text', 'T', 'Add text', 'text')}
        <PlusBox panel="text" label="text options" />
        {openPanel === 'text' && (
          <FloatingPanel anchorRef={textGroupRef} panelRef={panelContentRef}>
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-xl px-3 py-2 flex items-center gap-3 gap-y-2 flex-wrap">
            <span className="text-xs text-slate-400">Size</span>
            <input
              type="range"
              min={10}
              max={48}
              step={1}
              value={fontSize}
              onChange={(e) => setFontSize(parseInt(e.target.value, 10))}
              className="w-28"
            />
            <span className="text-xs text-slate-300 w-9 tabular-nums text-right">{fontSize}px</span>
            <div className="w-px h-6 bg-slate-600 mx-1" />
            <span className="text-xs text-slate-400">Font</span>
            {(moreFonts ? FONT_DEFS : FONT_OPTIONS).map((f) => (
              <button
                key={f.id}
                onClick={() => setFontFamily(f.id)}
                title={f.label}
                style={{ fontFamily: f.css }}
                className={`px-2 h-8 rounded text-sm transition-colors ${
                  fontFamily === f.id ? 'bg-orange-700 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-100'
                }`}
              >
                {f.preview}
              </button>
            ))}
            <button
              onClick={() => setMoreFonts((v) => !v)}
              title={moreFonts ? 'Fewer fonts' : 'More fonts'}
              aria-label={moreFonts ? 'Show fewer fonts' : 'Show more fonts'}
              aria-expanded={moreFonts}
              className={`w-8 h-8 rounded text-lg leading-none transition-colors ${
                moreFonts ? 'bg-orange-700 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-100'
              }`}
            >
              {moreFonts ? '−' : '+'}
            </button>
          </div>
          </FloatingPanel>
        )}
      </div>

      <div className="w-px h-6 bg-slate-700 mx-1" />

      {/* Pencil (its "+" = every drawing tool, stroke and colour) + highlighter
          + the two quick swatches (their "+" = the colour picker on its own). */}
      <div ref={drawGroupRef} className="relative flex items-start gap-1">
        <div ref={drawToolRef} className="flex items-start">
          {toolBtn('draw', '✎', 'Free draw', 'draw', '#000000')}
          <PlusBox panel="draw" label="drawing tools" />
        </div>
        <button
          onClick={() => handleToolClick('highlight', 'draw', HIGHLIGHT_YELLOW)}
          onPointerDown={() => startLongPress('draw')}
          onPointerUp={endLongPress}
          onPointerLeave={endLongPress}
          onPointerCancel={endLongPress}
          title="Highlighter — tap again or long-press for options"
          className={`w-9 h-9 rounded flex items-center justify-center transition-colors ${
            tool === 'highlight' ? 'bg-orange-700' : 'hover:bg-slate-700'
          }`}
        >
          <HighlighterIcon className="w-5 h-5" />
        </button>
        {/* self-stretch, not self-center: the swatches are shorter than the tool
            buttons, and this is the box the colour popup hangs off — matched
            heights are what keep it from opening inside the toolbar. */}
        <div ref={colorGroupRef} className="flex items-start gap-1 self-stretch ml-1">
          <div className="flex h-full items-center gap-1">
          {tool === 'highlight' ? (
            <>
              {colorSwatch(HIGHLIGHT_YELLOW, 'Yellow', true, () => setOpenPanel('color'))}
              {colorSwatch(HIGHLIGHT_GREEN, 'Green', true, () => setOpenPanel('color'))}
            </>
          ) : (
            <>
              {colorSwatch('#000000', 'Black', true, () => setOpenPanel('color'))}
              {colorSwatch('#ffffff', 'White', true, () => setOpenPanel('color'))}
            </>
          )}
          </div>
          <PlusBox panel="color" label="colours" />
        </div>
        {openPanel === 'draw' && (
          <FloatingPanel anchorRef={drawToolRef} panelRef={panelContentRef}>
          {/* ⚠️ Two ROWS, not one wrapping line (owner, 2026-09-04: "show the
              colours on a second line of the popup, don't extend it
              horizontally"). The shapes + stroke slider are one row and the
              colours the next, so the panel stays roughly as wide as the
              toolbar button it hangs off instead of running away across the
              screen. flex-wrap on a single row didn't do this: the panel is
              content-sized, so it just grew. */}
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-xl px-3 py-2 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              {DRAW_SHAPES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setTool(s.id)}
                  title={s.label}
                  className={`w-9 h-9 rounded flex items-center justify-center text-lg font-semibold text-white transition-colors ${
                    tool === s.id ? 'bg-orange-700' : 'hover:bg-slate-700'
                  }`}
                >
                  {s.icon}
                </button>
              ))}
              <div className="w-px h-6 bg-slate-600 mx-1" />
              <span className="text-xs text-slate-400">Stroke</span>
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={strokeWidth}
                onChange={(e) => setStrokeWidth(parseFloat(e.target.value))}
                className="w-20"
              />
              <span className="text-xs text-slate-300 w-12 tabular-nums text-right">{strokeWidth.toFixed(1)}px</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-400">Colour</span>
              {COLORS.map((c) => colorSwatch(c.hex, c.name))}
              <ColorPickerTrigger />
            </div>
          </div>
          </FloatingPanel>
        )}
        {/* Colours only — the swatch "+" is a colour picker, not a second way
            into the whole tool sheet. */}
        {openPanel === 'color' && (
          <FloatingPanel anchorRef={colorGroupRef} panelRef={panelContentRef}>
            <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-xl px-3 py-2 flex items-center gap-2 gap-y-2 flex-wrap">
              {COLORS.map((c) => colorSwatch(c.hex, c.name))}
              <ColorPickerTrigger />
            </div>
          </FloatingPanel>
        )}
      </div>

      <div className="w-px h-6 bg-slate-700 mx-1" />

      {/* Image upload */}
      <label
        title="Upload and place an image"
        className={`w-9 h-9 rounded flex items-center justify-center transition-colors cursor-pointer ${
          tool === 'image' ? 'bg-orange-700' : 'hover:bg-slate-700'
        }`}
      >
        <PictureFrameIcon active={tool === 'image'} className="w-5 h-5" />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={handleImageUpload}
        />
      </label>

      {/* Generate a QR code — it lands as an image annotation, so it sits next
          to the image button rather than in the tool groups. */}
      <button
        onClick={() => setQrOpen(true)}
        title="Add a QR code"
        className="w-9 h-9 rounded flex items-center justify-center transition-colors hover:bg-slate-700"
      >
        <QrIcon className="w-5 h-5" />
      </button>

      {/* Sign — an icon in this row rather than a labelled pill over with
          Export. It places something on the page, which is what every other
          control in this cluster does; Export ends the document. */}
      <SignatureMenu />

      {/* Delete (only when an annotation is selected) */}
      {selectedId && (
        <button
          onClick={() => remove(selectedId)}
          title="Delete selected (Del)"
          className="ml-1 px-3 h-9 rounded bg-red-600 hover:bg-red-500 text-sm font-medium"
        >
          Delete
        </button>
      )}
    </div>
  )
}

// --- DESKTOP ACTIONS (right, inline in header) ----------------------------
export function ToolbarDesktopActions() {
  const sourceBytes = usePdfStore((s) => s.sourceBytes)
  const [exportOpen, setExportOpen] = useState(false)

  return (
    <>
      <div className="hidden lg:flex items-center gap-2 shrink-0 [&>*]:shrink-0">
        {/* Sign moved into the tool cluster (it places things on the page);
            Present moved onto the bottom zoom bar (next to − % +). */}
        <button
          onClick={() => setExportOpen(true)}
          disabled={!sourceBytes}
          className="px-4 h-9 rounded bg-orange-700 hover:bg-orange-800 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
        >
          Export
        </button>
      </div>
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  )
}

// --- MOBILE TOOLBAR (bottom, fixed) --------------------------------------
export function ToolbarMobile() {
  // Only a touchscreen needs to be told about the press-and-hold; this toolbar
  // also shows on a narrow DESKTOP window, where a mouse drags the box on
  // contact as it always has.
  const coarsePointer = useCoarsePointer()
  const tool = useAnnotationStore((s) => s.tool)
  const color = useAnnotationStore((s) => s.color)
  const strokeWidth = useAnnotationStore((s) => s.strokeWidth)
  const selectedId = useAnnotationStore((s) => s.selectedId)
  const setTool = useAnnotationStore((s) => s.setTool)
  const setColor = useAnnotationStore((s) => s.setColor)
  const setStrokeWidth = useAnnotationStore((s) => s.setStrokeWidth)
  const setSelected = useAnnotationStore((s) => s.setSelected)
  const undo = useAnnotationStore((s) => s.undo)
  const canUndo = useAnnotationStore((s) => s.past.length > 0)
  const fontSize = useAnnotationStore((s) => s.fontSize)
  const setFontSize = useAnnotationStore((s) => s.setFontSize)
  const fontFamily = useAnnotationStore((s) => s.fontFamily)
  const setFontFamily = useAnnotationStore((s) => s.setFontFamily)
  const setUploadedImageSrc = useAnnotationStore((s) => s.setUploadedImageSrc)
  const setQrOpen = usePdfStore((s) => s.setQrOpen)

  const sourceBytes = usePdfStore((s) => s.sourceBytes)

  const [openPanel, setOpenPanel] = useState<Panel>(null)
  const [exportOpen, setExportOpen] = useState(false)
  // Reveals the extra built-in fonts (Georgia, Verdana, …) in the text panel.
  const [moreFonts, setMoreFonts] = useState(false)

  const mobilePanelRef = useRef<HTMLDivElement>(null)

  const pressTimer = useRef<number | null>(null)
  const longPressed = useRef(false)

  function togglePanel(p: Panel) {
    setOpenPanel((prev) => (prev === p ? null : p))
  }

  useEffect(() => {
    if (!openPanel) return
    function onDoc(e: MouseEvent) {
      if (!mobilePanelRef.current?.contains(e.target as Node)) setOpenPanel(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [openPanel])

  // Drawing a line auto-selects it and pops a contextual stroke/snap panel next
  // to the line. Collapse the big draw-options panel so that toolbar isn't
  // hidden behind it.
  useEffect(() => {
    if (!selectedId) return
    const sel = useAnnotationStore.getState().annotations.find((a) => a.id === selectedId)
    if (sel && sel.type === 'draw' && sel.shape === 'line') setOpenPanel(null)
  }, [selectedId])

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const src = ev.target?.result as string
      setUploadedImageSrc(src)
      setTool('image')
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  function startLongPress(panel?: Panel) {
    if (!panel) return
    longPressed.current = false
    if (pressTimer.current !== null) clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true
      setOpenPanel(panel)
    }, LONG_PRESS_MS)
  }
  function endLongPress() {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }
  function handleToolClick(id: Tool, panel?: Panel, defaultColor?: string) {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (panel && tool === id) {
      togglePanel(panel)
    } else {
      setTool(id)
      if (defaultColor) {
        setSelected(null)
        setColor(defaultColor)
      }
    }
  }

  const mobilePanelContent = (() => {
    if (openPanel === 'select') {
      return (
        <div className="flex items-center gap-2">
          {SELECT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => { setTool(opt.id); setOpenPanel(null) }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                tool === opt.id ? 'bg-orange-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <span className="text-lg leading-none">{opt.icon}</span>
              <span className="flex flex-col items-start leading-tight">
                <span>{opt.label}</span>
                {/* The one tool whose gesture differs on glass says so here.
                    There is no room for the full help text in this row, and no
                    banner for it either (PlacementHint is for armed payloads,
                    not tools) — so three words at the moment of choosing is
                    the whole budget, and it is enough. */}
                {coarsePointer && opt.gesture && (
                  <span className={`text-[10px] font-normal ${tool === opt.id ? 'text-orange-100' : 'text-slate-500'}`}>
                    {opt.gesture}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )
    }
    if (openPanel === 'text') {
      return (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-medium">Size</span>
          <button
            onClick={() => setFontSize(Math.max(10, fontSize - 2))}
            className="w-8 h-8 rounded-full hover:bg-slate-100 text-lg font-semibold text-slate-700"
          >
            −
          </button>
          <span className="text-sm font-medium w-10 text-center tabular-nums text-slate-700">
            {fontSize}px
          </span>
          <button
            onClick={() => setFontSize(Math.min(48, fontSize + 2))}
            className="w-8 h-8 rounded-full hover:bg-slate-100 text-lg font-semibold text-slate-700"
          >
            +
          </button>
          <div className="w-px h-7 bg-slate-200 mx-1" />
          <span className="text-xs text-slate-500 font-medium">Font</span>
          {(moreFonts ? FONT_DEFS : FONT_OPTIONS).map((f) => (
            <button
              key={f.id}
              onClick={() => setFontFamily(f.id)}
              title={f.label}
              style={{ fontFamily: f.css }}
              className={`px-2.5 h-9 rounded-lg text-sm transition-colors ${
                fontFamily === f.id ? 'bg-orange-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {f.preview}
            </button>
          ))}
          <button
            onClick={() => setMoreFonts((v) => !v)}
            title={moreFonts ? 'Fewer fonts' : 'More fonts'}
            aria-label={moreFonts ? 'Show fewer fonts' : 'Show more fonts'}
            aria-expanded={moreFonts}
            className={`w-9 h-9 rounded-lg text-lg leading-none transition-colors ${
              moreFonts ? 'bg-orange-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {moreFonts ? '−' : '+'}
          </button>
        </div>
      )
    }
    if (openPanel === 'draw') {
      return (
        <div className="flex items-center gap-2 flex-wrap max-w-[92vw]">
          <button
            onClick={() => {
              if (tool !== 'highlight') {
                setSelected(null)
                setColor(HIGHLIGHT_YELLOW)
              }
              setTool('highlight')
            }}
            title="Highlighter"
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
              tool === 'highlight' ? 'bg-orange-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <HighlighterIcon className="w-6 h-6" />
          </button>
          {DRAW_SHAPES.map((s) => (
            <button
              key={s.id}
              onClick={() => setTool(s.id)}
              title={s.label}
              className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl font-semibold transition-colors ${
                tool === s.id ? 'bg-orange-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {s.icon}
            </button>
          ))}
          <div className="w-px h-7 bg-slate-200 mx-1" />
          <input
            type="range"
            min={1}
            max={10}
            step={0.5}
            value={strokeWidth}
            onChange={(e) => setStrokeWidth(parseFloat(e.target.value))}
            className="w-20"
          />
          <span className="text-xs text-slate-700 tabular-nums w-10 text-right">{strokeWidth.toFixed(1)}px</span>
          <div className="w-px h-7 bg-slate-200 mx-1" />
          {COLORS.map((c) => (
            <button
              key={c.hex}
              onClick={() => setColor(c.hex)}
              className={`w-8 h-8 rounded-full border-2 flex-shrink-0 transition-transform ${
                color === c.hex ? 'border-slate-900 scale-110' : 'border-slate-200 hover:scale-105'
              }`}
              style={{ backgroundColor: c.hex }}
              title={c.name}
            />
          ))}
          <label
            title="Custom colour"
            className={`w-8 h-8 rounded-full cursor-pointer border-2 flex-shrink-0 overflow-hidden transition-transform ${
              !COLORS.some((c) => c.hex === color) ? 'border-slate-900 scale-110' : 'border-slate-200 hover:scale-105'
            }`}
            style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}
          >
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="sr-only"
            />
          </label>
        </div>
      )
    }
    return null
  })()

  function mobileBtnWithPlus(id: Tool, icon: string, label: string, panel: Panel, defaultColor?: string) {
    const active = tool === id || (panel === 'draw' && isDrawShape(tool))
    return (
      <div className="flex flex-col items-center justify-center flex-1 h-full relative">
        <button
          onClick={() => handleToolClick(id, panel, defaultColor)}
          onPointerDown={() => startLongPress(panel)}
          onPointerUp={endLongPress}
          onPointerLeave={endLongPress}
          onPointerCancel={endLongPress}
          className={`flex flex-col items-center justify-center w-full h-full gap-0.5 rounded transition-colors ${
            active ? 'text-orange-400' : 'text-slate-200'
          }`}
        >
          <span className="text-xl leading-none">{icon}</span>
          <span className="text-[10px] font-medium">{label}</span>
        </button>
        <button
          onClick={() => togglePanel(panel)}
          className={`absolute top-1 right-1 w-[13px] h-[13px] text-[8px] font-bold rounded-[2px] flex items-center justify-center leading-none border ${
            openPanel === panel
              ? 'bg-orange-700 border-orange-400 text-white'
              : 'bg-slate-700 border-slate-600 text-slate-400'
          }`}
        >
          +
        </button>
      </div>
    )
  }

  return (
    <div className="lg:hidden">
      {/* The selected-text controls (size + bold/italic/underline/link) float
          next to the text itself, drawn by AnnotationLayer — so there's no
          bottom size-pill here. Deletion is the floating bin icon by the
          object. */}

      {/* Expandable panel above toolbar */}
      {openPanel !== null && mobilePanelContent && (
        <div
          ref={mobilePanelRef}
          className="fixed bottom-[calc(68px_+_env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-40 bg-white rounded-2xl shadow-xl px-4 py-3 flex items-center gap-2 whitespace-nowrap max-w-[96vw] overflow-x-auto"
        >
          {mobilePanelContent}
        </div>
      )}

      <nav
        className="fixed bottom-0 left-0 right-0 z-40 bg-slate-900 border-t border-slate-700 flex items-stretch px-1"
        style={{
          // 4rem of button content, with the home-indicator safe-area inset
          // added *below* it. Setting a fixed h-16 here would make box-sizing
          // subtract the inset from the content, squishing the buttons.
          height: 'calc(4rem + env(safe-area-inset-bottom))',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {/* Select / Select area / Select text / Hand with + */}
        {mobileBtnWithPlus(
          selectGroupTool(tool),
          SELECT_GROUP_ICON[tool] ?? '↖',
          tool === 'hand' ? 'Hand' : tool === 'marquee' ? 'Area' : tool === 'selecttext' ? 'Text' : 'Select',
          'select'
        )}

        {/* Draw with + (includes shapes/stroke/colour in panel) */}
        {mobileBtnWithPlus('draw', '✎', 'Draw', 'draw', '#000000')}

        {/* Text with + */}
        {mobileBtnWithPlus('text', 'T', 'Text', 'text')}

        {/* Image upload */}
        <label className={`flex flex-col items-center justify-center flex-1 h-full gap-0.5 cursor-pointer ${tool === 'image' ? 'text-orange-400' : 'text-slate-200'}`}>
          <PictureFrameIcon active={tool === 'image'} className="w-6 h-6" />
          <span className="text-[10px] font-medium">Image</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={handleImageUpload}
          />
        </label>

        {/* QR — beside Image, since that's where it lands on the page. */}
        <button
          onClick={() => setQrOpen(true)}
          className="flex flex-col items-center justify-center flex-1 h-full gap-0.5 text-slate-200"
        >
          <QrIcon className="w-6 h-6" />
          <span className="text-[10px] font-medium">QR</span>
        </button>

        <div className="flex-1 h-full flex items-stretch">
          <SignatureMenu openUpward compact />
        </div>

        <button
          onClick={undo}
          disabled={!canUndo}
          className="flex flex-col items-center justify-center flex-1 h-full gap-0.5 text-slate-200 disabled:opacity-40"
        >
          <span className="text-xl leading-none">↶</span>
          <span className="text-[10px] font-medium">Undo</span>
        </button>

        <button
          onClick={() => setExportOpen(true)}
          disabled={!sourceBytes}
          className="flex flex-col items-center justify-center flex-1 h-full gap-0.5 text-orange-400 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="text-xl leading-none">⤓</span>
          <span className="text-[10px] font-medium">Save</span>
        </button>
      </nav>

      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  )
}

// Backward-compatible default export — renders both the desktop tools and
// actions on a single bar plus the mobile toolbar. New layouts should
// prefer the named exports so the desktop pieces can live inside the
// app header.
export default function Toolbar() {
  return (
    <>
      <div className="hidden lg:block bg-slate-800 text-white border-b border-slate-700">
        <div className="mx-auto w-full max-w-7xl flex flex-wrap items-center gap-1 px-4 py-2">
          <ToolbarDesktopTools />
          <div className="ml-auto flex items-center gap-2">
            <ToolbarDesktopActions />
          </div>
        </div>
      </div>
      <ToolbarMobile />
    </>
  )
}
