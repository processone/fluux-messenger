import { prepare, layout } from '@chenglou/pretext'

export interface FontSpec {
  fontFamily: string
  fontSizePx: number
  fontWeight: number
  fontStyle: string
  lineHeightPx: number
  letterSpacingPx: number
  whiteSpace: 'normal' | 'pre-wrap'
}

export interface MessagePrediction {
  lineCount: number
  heightPx: number
}

/** CSS `font` shorthand for pretext: "style weight size family". */
function toFontShorthand(font: FontSpec): string {
  return `${font.fontStyle} ${font.fontWeight} ${font.fontSizePx}px ${font.fontFamily}`
}

// pretext measures via Canvas 2D. Browsers (incl. the Tauri WebKit webview) always have it; jsdom
// does not (getContext returns null), so any unit test that renders the message list would otherwise
// throw inside pretext. Detect once and degrade gracefully — never throw from a size estimate.
let canvasUsableCache: boolean | null = null
function canvasUsable(): boolean {
  if (canvasUsableCache !== null) return canvasUsableCache
  try {
    canvasUsableCache =
      typeof document !== 'undefined' && document.createElement('canvas').getContext('2d') != null
  } catch {
    canvasUsableCache = false
  }
  return canvasUsableCache
}

/** Fallback when Canvas 2D is unavailable: count explicit hard lines (no wrapping info). */
function heuristicPrediction(body: string, lineBoxPx: number): MessagePrediction {
  const lineCount = Math.max(1, body.split('\n').length)
  return { lineCount, heightPx: lineCount * lineBoxPx }
}

/**
 * Predict a message body's wrapped TEXT height with no DOM reflow, using @chenglou/pretext.
 * Returns the exact wrapped line count and a height of `lineCount * lineBoxPx`, where
 * `lineBoxPx` is the engine's RENDERED per-line box height (Math.floor(lineHeight) on WebKit,
 * which floors line boxes; ~= lineHeight on Chromium). Passing lineBoxPx explicitly keeps this
 * util pure and engine-agnostic; the caller measures the real line box once (Task 5).
 *
 * Requires a working Canvas 2D. In an environment without one (jsdom) it degrades to a hard-line
 * count rather than throwing, so the size estimate never crashes a render.
 */
export function predictMessageTextHeight(
  body: string, contentWidthPx: number, font: FontSpec, lineBoxPx: number,
): MessagePrediction {
  if (!canvasUsable()) return heuristicPrediction(body, lineBoxPx)
  try {
    const prepared = prepare(body, toFontShorthand(font), {
      whiteSpace: font.whiteSpace,
      letterSpacing: font.letterSpacingPx,
    })
    const result = layout(prepared, contentWidthPx, font.lineHeightPx)
    const lineCount = Math.max(1, result.lineCount)
    return { lineCount, heightPx: lineCount * lineBoxPx }
  } catch {
    return heuristicPrediction(body, lineBoxPx)
  }
}
