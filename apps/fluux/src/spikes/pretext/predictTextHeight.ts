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

export interface Prediction {
  heightPx: number
  lineCount: number
}

/** Build a CSS `font` shorthand for pretext: "style weight size family". */
function toFontShorthand(font: FontSpec): string {
  return `${font.fontStyle} ${font.fontWeight} ${font.fontSizePx}px ${font.fontFamily}`
}

/**
 * Predict the wrapped height of a message body's TEXT, with no DOM reflow,
 * using @chenglou/pretext. 'pre-wrap' preserves explicit newlines so the whole
 * body is measured at once. Height = lineCount * lineHeightPx, mirroring the
 * CSS line-box model the real MessageBody renders with.
 *
 * Requires a working Canvas 2D (browser or jsdom-with-canvas). In a plain Node
 * run prepare() throws / measures 0; callers gate on canvas availability.
 */
export function predictTextHeight(body: string, contentWidthPx: number, font: FontSpec): Prediction {
  const prepared = prepare(body, toFontShorthand(font), {
    whiteSpace: font.whiteSpace,
    letterSpacing: font.letterSpacingPx,
  })
  const result = layout(prepared, contentWidthPx, font.lineHeightPx)
  const lineCount = Math.max(1, result.lineCount)
  return { heightPx: lineCount * font.lineHeightPx, lineCount }
}
