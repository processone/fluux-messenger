import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import * as ltx from 'ltx'

/**
 * Tests for XML parsing behavior in @xmpp/client.
 * These tests verify that XML entities are properly decoded by the underlying parser.
 *
 * If these tests fail, it indicates a bug in @xmpp/client or ltx that should be
 * reported upstream rather than worked around in our code.
 */
describe('XML entity decoding', () => {
  describe('ltx parser (used by @xmpp/client)', () => {
    it('should decode &apos; to apostrophe in text content', () => {
      const xmlString = '<status>I&apos;m using Conversations</status>'
      const element = ltx.parse(xmlString)

      expect(element.getText()).toBe("I'm using Conversations")
    })

    it('should decode &quot; to double quote in text content', () => {
      const xmlString = '<body>He said &quot;hello&quot;</body>'
      const element = ltx.parse(xmlString)

      expect(element.getText()).toBe('He said "hello"')
    })

    it('should decode &lt; and &gt; in text content', () => {
      const xmlString = '<body>Use &lt;html&gt; tags</body>'
      const element = ltx.parse(xmlString)

      expect(element.getText()).toBe('Use <html> tags')
    })

    it('should decode &amp; to ampersand in text content', () => {
      const xmlString = '<body>Tom &amp; Jerry</body>'
      const element = ltx.parse(xmlString)

      expect(element.getText()).toBe('Tom & Jerry')
    })

    it('should handle multiple entities in the same text', () => {
      const xmlString = '<body>It&apos;s &quot;cool&quot; &amp; &lt;fun&gt;</body>'
      const element = ltx.parse(xmlString)

      expect(element.getText()).toBe(`It's "cool" & <fun>`)
    })

    it('should decode entities in nested element text', () => {
      const xmlString = '<presence><status>I&apos;m away</status></presence>'
      const element = ltx.parse(xmlString)

      expect(element.getChildText('status')).toBe("I'm away")
    })

    it('should handle numeric character references', () => {
      const xmlString = '<body>Smile &#128512;</body>'
      const element = ltx.parse(xmlString)

      expect(element.getText()).toBe('Smile 😀')
    })

    it('should handle hex character references', () => {
      const xmlString = '<body>Heart &#x2764;</body>'
      const element = ltx.parse(xmlString)

      expect(element.getText()).toBe('Heart ❤')
    })
  })

  describe('double-encoded entities (bug in sending client)', () => {
    it('should NOT decode double-encoded &amp;apos; - this becomes literal &apos;', () => {
      // If a client sends &amp;apos; it means they double-encoded
      // The parser correctly decodes &amp; to & leaving us with &apos; as literal text
      const xmlString = '<status>I&amp;apos;m using Conversations</status>'
      const element = ltx.parse(xmlString)

      // This is the expected (correct) behavior - double encoding results in literal entity
      expect(element.getText()).toBe("I&apos;m using Conversations")
    })
  })

  describe('@xmpp/client xml builder', () => {
    it('should automatically encode required special characters when building XML', () => {
      const element = xml('body', {}, "It's a <test> & more")
      const xmlString = element.toString()

      // The xml builder encodes < > and & (required in XML text content)
      // Apostrophes don't need encoding in text content (only in attribute values)
      expect(xmlString).toContain('&lt;')
      expect(xmlString).toContain('&gt;')
      expect(xmlString).toContain('&amp;')
      // Apostrophe is left as-is (valid XML)
      expect(xmlString).toContain("'")
    })

    it('should round-trip: build then parse preserves original text', () => {
      const originalText = "It's a \"test\" with <special> & chars"
      const element = xml('body', {}, originalText)
      const xmlString = element.toString()

      // Parse it back
      const parsed = ltx.parse(xmlString)

      expect(parsed.getText()).toBe(originalText)
    })
  })
})
