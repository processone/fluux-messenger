import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

describe('selected quote and reply framing', () => {
  it('uses the shared selected-message marker for both card types', () => {
    expect(css).toMatch(
      /\[data-msg-selected\]\s+\.blockquote-decorated,\s*\[data-msg-selected\]\s+\.reply-quote-card\s*\{[\s\S]*?--fluux-quote-selected-overlay/,
    )
  })

  it('frames reply cards with their sender colour', () => {
    expect(css).toMatch(
      /\[data-msg-selected\]\s+\.reply-quote-card\s*\{[\s\S]*?box-shadow:\s*inset 0 0 0 1px var\(--fluux-quote-frame-color,\s*var\(--fluux-brand\)\)/,
    )
  })
})
