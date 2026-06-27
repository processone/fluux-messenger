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

/**
 * Predict a message body's wrapped TEXT height with no DOM reflow, using @chenglou/pretext.
 * Returns the exact wrapped line count and a height of `lineCount * lineBoxPx`, where
 * `lineBoxPx` is the engine's RENDERED per-line box height (Math.floor(lineHeight) on WebKit,
 * which floors line boxes; ~= lineHeight on Chromium). Passing lineBoxPx explicitly keeps this
 * util pure and engine-agnostic; the caller measures the real line box once (Task 5).
 *
 * Requires a working Canvas 2D (browser); under plain Node/jsdom prepare() measures 0.
 */
export function predictMessageTextHeight(
  body: string, contentWidthPx: number, font: FontSpec, lineBoxPx: number,
): MessagePrediction {
  const prepared = prepare(body, toFontShorthand(font), {
    whiteSpace: font.whiteSpace,
    letterSpacing: font.letterSpacingPx,
  })
  const result = layout(prepared, contentWidthPx, font.lineHeightPx)
  const lineCount = Math.max(1, result.lineCount)
  return { lineCount, heightPx: lineCount * lineBoxPx }
}
