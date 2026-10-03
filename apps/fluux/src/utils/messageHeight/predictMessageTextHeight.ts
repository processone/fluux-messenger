import { prepare, layout } from '@chenglou/pretext'

/** Numeric-only lab probe; absent from release builds and inert unless a test installs it. */
function recordPredictionWork(event: 'request' | 'prepare' | 'layout', chars: number): void {
  if (import.meta.env.DEV) {
    const probe = (globalThis as typeof globalThis & {
      __fluuxPredictionWork?: (event: 'request' | 'prepare' | 'layout', chars: number) => void
    }).__fluuxPredictionWork
    probe?.(event, chars)
  }
}

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
  /** Set when the height was clamped to the caller's `maxHeightPx`. */
  exceedsMax?: true
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

function predictUncached(
  body: string, contentWidthPx: number, font: FontSpec, lineBoxPx: number,
): MessagePrediction {
  if (!canvasUsable()) return heuristicPrediction(body, lineBoxPx)
  try {
    recordPredictionWork('prepare', body.length)
    const prepared = prepare(body, toFontShorthand(font), {
      whiteSpace: font.whiteSpace,
      letterSpacing: font.letterSpacingPx,
    })
    const result = layout(prepared, contentWidthPx, font.lineHeightPx)
    recordPredictionWork('layout', body.length)
    const lineCount = Math.max(1, result.lineCount)
    return { lineCount, heightPx: lineCount * lineBoxPx }
  } catch {
    return heuristicPrediction(body, lineBoxPx)
  }
}

/** Longest body prefix handed to pretext when the caller caps the height. */
export const CAPPED_PREDICTION_PREFIX_CHARS = 3000

function predictCapped(
  body: string, contentWidthPx: number, font: FontSpec, lineBoxPx: number, maxHeightPx: number,
): MessagePrediction {
  let prediction: MessagePrediction
  if (body.length <= CAPPED_PREDICTION_PREFIX_CHARS) {
    prediction = predictUncached(body, contentWidthPx, font, lineBoxPx)
  } else {
    const head = predictUncached(body.slice(0, CAPPED_PREDICTION_PREFIX_CHARS), contentWidthPx, font, lineBoxPx)
    const lineCount = Math.ceil(head.lineCount * body.length / CAPPED_PREDICTION_PREFIX_CHARS)
    prediction = { lineCount, heightPx: lineCount * lineBoxPx }
  }
  if (prediction.heightPx <= maxHeightPx) return prediction
  return { ...prediction, heightPx: maxHeightPx, exceedsMax: true }
}

// The list re-estimates every unmeasured resident row whenever virtual-core re-derives its
// measurements, so the same bodies are predicted repeatedly. Entries are keyed by the body string,
// not the message: the SDK reallocates message objects. The character budget counts each body
// once across contexts; retaining multiple contexts keeps fallback and calibrated widths reusable
// across conversation remounts.
const MAX_CACHED_PREDICTIONS = 1000
const MAX_CACHED_CHARS = 8_000_000
const MAX_CACHED_CONTEXTS = 4
const predictionCache = new Map<string, Map<string, MessagePrediction>>()
let cachedChars = 0

function contextCacheKey(
  contentWidthPx: number, font: FontSpec, lineBoxPx: number, maxHeightPx: number | undefined,
): string {
  return `${contentWidthPx}|${lineBoxPx}|${toFontShorthand(font)}|${font.lineHeightPx}|` +
    `${font.letterSpacingPx}|${font.whiteSpace}|${maxHeightPx ?? ''}`
}

function rememberPrediction(body: string, context: string, prediction: MessagePrediction): void {
  const contexts = predictionCache.get(body) ?? new Map<string, MessagePrediction>()
  contexts.set(context, prediction)
  for (const oldest of contexts.keys()) {
    if (contexts.size <= MAX_CACHED_CONTEXTS) break
    contexts.delete(oldest)
  }
  if (predictionCache.delete(body)) cachedChars -= body.length
  predictionCache.set(body, contexts)
  cachedChars += body.length
  for (const oldest of predictionCache.keys()) {
    if (predictionCache.size <= MAX_CACHED_PREDICTIONS && cachedChars <= MAX_CACHED_CHARS) break
    predictionCache.delete(oldest)
    cachedChars -= oldest.length
  }
}

/** Drop every memoised prediction. */
export function clearPredictionCache(): void {
  predictionCache.clear()
  cachedChars = 0
}

/**
 * Predict a message body's wrapped TEXT height with no DOM reflow, using @chenglou/pretext.
 * Without a cap, uses the full body's wrapped line count and a height of `lineCount * lineBoxPx`, where
 * `lineBoxPx` is the engine's RENDERED per-line box height (Math.floor(lineHeight) on WebKit,
 * which floors line boxes; ~= lineHeight on Chromium). Passing lineBoxPx explicitly keeps this
 * util engine-agnostic; the caller measures the real line box once.
 *
 * With `maxHeightPx`, the height is clamped to it (`exceedsMax` marks a clamped result) and pretext
 * sees at most CAPPED_PREDICTION_PREFIX_CHARS characters, bounding its layout work. Longer bodies
 * use a line count extrapolated from the prefix's line density, which can under- or over-estimate
 * the full body. Clamping the height does not clamp the returned line count.
 *
 * Results are memoised per (body, width, font, line box, cap). Requires a working Canvas 2D. In an
 * environment without one (jsdom) it degrades to a hard-line count rather than throwing, so the
 * size estimate never crashes a render.
 */
export function predictMessageTextHeight(
  body: string, contentWidthPx: number, font: FontSpec, lineBoxPx: number, maxHeightPx?: number,
): MessagePrediction {
  recordPredictionWork('request', body.length)
  const context = contextCacheKey(contentWidthPx, font, lineBoxPx, maxHeightPx)
  const contexts = predictionCache.get(body)
  const hit = contexts?.get(context)
  if (contexts && hit) {
    contexts.delete(context)
    contexts.set(context, hit)
    return hit
  }
  const prediction = maxHeightPx === undefined
    ? predictUncached(body, contentWidthPx, font, lineBoxPx)
    : predictCapped(body, contentWidthPx, font, lineBoxPx, maxHeightPx)
  rememberPrediction(body, context, prediction)
  return prediction
}
