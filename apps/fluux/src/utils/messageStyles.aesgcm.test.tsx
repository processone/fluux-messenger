/**
 * Linkifier guard against XEP-0454 aesgcm:// URIs.
 *
 * An aesgcm:// URI carries an AES key in its fragment. If the linkifier
 * ever wrapped one in an <a href="…">, a click would expose the key to
 * the navigated page (extensions, history, JS on the landing page).
 *
 * Our URL regex matches only `https?://` — so aesgcm://-in-body renders
 * as plain text. This test locks that in so a future "also match ftp://"
 * tweak can't silently catch aesgcm:// too.
 */
import type React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderTextWithLinks } from './messageStyles'

function renderMarkup(node: React.ReactNode): string {
  // React.Fragment accepts children including string/array nodes, so wrap.
  return renderToStaticMarkup(<>{node}</>)
}

describe('linkifier — aesgcm:// URI safety', () => {
  it('does not linkify aesgcm:// URIs as anchors', () => {
    const text = 'secret: aesgcm://upload.example.org/abc.bin#' + 'a'.repeat(88)
    const out = renderTextWithLinks(text)
    const markup = renderMarkup(out)
    expect(markup.toLowerCase()).not.toContain('href="aesgcm')
    expect(markup.toLowerCase()).not.toContain("href='aesgcm")
    // The raw URI should still appear as text, just not wrapped in <a>.
    expect(markup).toContain('aesgcm://upload.example.org/abc.bin')
  })

  it('still linkifies https:// URIs', () => {
    const text = 'see https://example.org/foo'
    const out = renderTextWithLinks(text)
    const markup = renderMarkup(out)
    expect(markup).toContain('href="https://example.org/foo"')
  })
})
