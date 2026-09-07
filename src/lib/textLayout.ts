import type { TextAnnotation, TextRun } from '../types/annotations'
import { FONT_CSS } from './fonts'
import { effectiveRuns, runFontStyle } from './textRuns'

// Vertical advance between wrapped lines, as a multiple of the font size. The
// contentEditable editor overlay uses the same figure for its line-height and
// the export baked the same box height long before wrapping existed, so all
// three agree on where the second line starts.
export const LINE_HEIGHT = 1.25

// Shared offscreen 2D context for measuring run widths in unscaled model space.
// Konva itself measures with canvas measureText, so widths derived here match
// the on-canvas advance, keeping the per-run layout, the wrap points and the
// editor aligned.
const _measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
const _measureCtx = _measureCanvas?.getContext('2d') ?? null

// Width of one run's text at the annotation's (unscaled) font size + family.
export function runWidth(run: TextRun, fontSize: number, cssFamily: string): number {
  if (!run.text) return 0
  if (!_measureCtx) return run.text.length * fontSize * 0.6
  _measureCtx.font = `${runFontStyle(run)} ${fontSize}px ${cssFamily}`
  return _measureCtx.measureText(run.text).width
}

export function cssFamilyOf(a: TextAnnotation): string {
  return FONT_CSS[a.fontFamily ?? 'sans']
}

// One run as laid out on a line: the run itself plus its x offset from the
// annotation's left edge and its measured width.
export type PlacedRun = TextRun & { x: number; width: number }
export type TextLine = { runs: PlacedRun[]; width: number }

type Token = { run: TextRun; space: boolean }

// Split the runs into whitespace / non-whitespace tokens, each keeping the
// style of the run it came from, so a wrap can fall between two words that sit
// in differently-styled runs.
function tokenize(runs: TextRun[]): Token[] {
  const out: Token[] = []
  for (const run of runs) {
    for (const piece of run.text.split(/(\s+)/)) {
      if (!piece) continue
      out.push({ run: { ...run, text: piece }, space: /^\s+$/.test(piece) })
    }
  }
  return out
}

// Place the runs of one line, left to right, measuring each to get the next
// one's offset (the same advance Konva will use when it draws them).
function placeLine(runs: TextRun[], fontSize: number, cssFamily: string): TextLine {
  const placed: PlacedRun[] = []
  let x = 0
  for (const run of runs) {
    const width = runWidth(run, fontSize, cssFamily)
    placed.push({ ...run, x, width })
    x += width
  }
  return { runs: placed, width: x }
}

/**
 * Lay a text annotation out into lines.
 *
 * Without a `wrapWidth` this is a single line — the layout the app had before
 * text boxes could be resized, preserved exactly. With one, the text is greedily
 * word-wrapped to that width (in model/point space, not screen pixels). A single
 * word wider than the box is left to overflow rather than being broken
 * mid-word, matching the contentEditable editor's own default.
 *
 * ⚠️ Shared with the PDF export deliberately: the wrap points have to be decided
 * ONCE, from canvas metrics, or the exported file would break its lines
 * somewhere other than the screen did. (Export still advances within a line
 * using pdf-lib's own metrics — see lib/export.ts.)
 */
export function layoutText(a: TextAnnotation): TextLine[] {
  const cssFamily = cssFamilyOf(a)
  const runs = effectiveRuns(a)
  const wrapWidth = a.wrapWidth
  if (!wrapWidth || !(wrapWidth > 0)) return [placeLine(runs, a.fontSize, cssFamily)]

  const lines: TextRun[][] = [[]]
  let width = 0
  for (const token of tokenize(runs)) {
    const w = runWidth(token.run, a.fontSize, cssFamily)
    const line = lines[lines.length - 1]
    if (!token.space && line.length > 0 && width + w > wrapWidth) {
      lines.push([token.run])
      width = w
      continue
    }
    // Whitespace that a wrap has pushed to the head of a line is dropped, the
    // way a browser drops it — otherwise every wrapped line would start indented
    // by the space that used to separate the two words.
    if (token.space && line.length === 0) continue
    line.push(token.run)
    width += w
  }
  return lines.map((l) => placeLine(l, a.fontSize, cssFamily))
}

// The laid-out box of a text annotation in model space: the wrap width when one
// is set (the box the user dragged), else the measured width of the single line.
export function textBoxSize(a: TextAnnotation): { width: number; height: number; lines: number } {
  const lines = layoutText(a)
  const measured = lines.reduce((max, l) => Math.max(max, l.width), 0)
  return {
    width: a.wrapWidth && a.wrapWidth > 0 ? a.wrapWidth : measured,
    height: a.fontSize * LINE_HEIGHT * Math.max(1, lines.length),
    lines: lines.length
  }
}
