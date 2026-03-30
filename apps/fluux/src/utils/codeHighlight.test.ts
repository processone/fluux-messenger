import { describe, it, expect } from 'vitest'
import { codeToHtml } from 'shiki'

/**
 * Verify that Shiki escapes HTML in code content, preventing XSS
 * when the output is used with dangerouslySetInnerHTML.
 *
 * Shiki builds a HAST where code tokens are text nodes, then serializes
 * via hast-util-to-html which escapes '<' and '&' in all text content.
 * See: https://github.com/syntax-tree/hast-util-to-html/blob/9.0.5/lib/handle/text.js#L10
 */
describe('codeHighlight XSS safety', () => {
  // Use Shiki's codeToHtml directly — same pipeline as highlightCode()
  // but avoids needing to manage the lazy singleton in tests.
  async function highlightAsJavaScript(code: string): Promise<string> {
    const html = await codeToHtml(code, { lang: 'javascript', theme: 'nord' })
    // Strip outer <pre><code>...</code></pre> wrapper (same as highlightCode)
    const match = html.match(/<pre[^>]*><code[^>]*>([\s\S]*)<\/code><\/pre>/)
    return match ? match[1] : html
  }

  const xssPayloads = [
    {
      name: 'script injection',
      input: '<script>alert(document.cookie)</script>',
    },
    {
      name: 'img onerror',
      input: '<img src=x onerror=alert(document.cookie)>',
    },
    {
      name: 'closing tags to escape context',
      input: '</span><script>alert(1)</script><span>',
    },
    {
      name: 'closing code/pre to escape wrapper',
      input: '</code></pre><script>alert(1)</script>',
    },
  ]

  for (const { name, input } of xssPayloads) {
    it(`escapes ${name}: ${input}`, async () => {
      const html = await highlightAsJavaScript(input)

      // The output must NOT contain raw <script or <img tags —
      // all '<' from the input must be escaped (e.g. &#x3C; or &lt;)
      expect(html).not.toContain('<script')
      expect(html).not.toContain('<img')

      // Verify the text content is preserved (just escaped)
      expect(html).toContain('alert')
    })
  }
})
