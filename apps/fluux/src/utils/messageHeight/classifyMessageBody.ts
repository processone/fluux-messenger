export type BodyClass = 'text' | 'code' | 'media' | 'empty'

/** A fenced code block opens a line with ``` (after optional leading whitespace). */
function hasFencedCodeBlock(body: string): boolean {
  return /(^|\n)\s*```/.test(body)
}

/**
 * Coarse render-shape classifier for height estimation. `media` (attachment / link preview /
 * poll) and `code` (fenced block, rendered in a monospace font pretext cannot model with the
 * prose font) get a reserved-space estimate; `text` uses pretext; `empty`/retracted gets the
 * minimal row height.
 */
export function classifyMessageBody(m: {
  body: string
  attachment?: unknown
  linkPreview?: unknown
  poll?: unknown
  isRetracted?: boolean
}): BodyClass {
  if (m.attachment != null || m.linkPreview != null || m.poll != null) return 'media'
  if (m.isRetracted || m.body.trim() === '') return 'empty'
  if (hasFencedCodeBlock(m.body)) return 'code'
  return 'text'
}
