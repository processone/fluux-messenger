import { describe, expect, it } from 'vitest'
import { xml } from '@xmpp/client'
import { serialize, parse, isPayloadEnvelope } from './payloadEnvelope'

describe('payloadEnvelope', () => {
  describe('serialize', () => {
    it('wraps a single <body> in <payload>', () => {
      const out = serialize([xml('body', {}, 'hello')])
      expect(out).toContain('<payload')
      expect(out).toMatch(/xmlns=["']jabber:client["']/)
      expect(out).toMatch(/<body[^>]*>hello<\/body>/)
      expect(out).toMatch(/<\/payload>$/)
    })

    it('wraps multiple children in order', () => {
      const out = serialize([
        xml('body', {}, 'caption'),
        xml('x', { xmlns: 'jabber:x:oob' }, xml('url', {}, 'aesgcm://u.example.org/f#abc')),
        xml('file', { xmlns: 'urn:xmpp:file-metadata:0' }, xml('name', {}, 'a.jpg')),
      ])
      const bodyIdx = out.indexOf('<body')
      const xIdx = out.indexOf('<x')
      const fileIdx = out.indexOf('<file')
      expect(bodyIdx).toBeGreaterThan(-1)
      expect(xIdx).toBeGreaterThan(bodyIdx)
      expect(fileIdx).toBeGreaterThan(xIdx)
    })

    it('preserves XML-entity encoding in body text', () => {
      const out = serialize([xml('body', {}, 'a & b <c>')])
      expect(out).toContain('&amp;')
      expect(out).toContain('&lt;')
      expect(out).toContain('&gt;')
    })
  })

  describe('parse', () => {
    it('round-trips a serialized envelope into the original children', () => {
      const bodyEl = xml('body', {}, 'hello')
      const oobEl = xml('x', { xmlns: 'jabber:x:oob' }, xml('url', {}, 'https://u.example.org/f'))
      const serialized = serialize([bodyEl, oobEl])
      const parsed = parse(serialized)
      expect(parsed).not.toBeNull()
      expect(parsed!.length).toBe(2)
      expect(parsed![0].name).toBe('body')
      expect(parsed![0].text()).toBe('hello')
      expect(parsed![1].name).toBe('x')
      expect(parsed![1].getChild('url')?.text()).toBe('https://u.example.org/f')
    })

    it('returns null for a bare body string (legacy plaintext)', () => {
      expect(parse('just some plain text')).toBeNull()
      expect(parse('hello world')).toBeNull()
      expect(parse('')).toBeNull()
    })

    it('returns null for XML that isn\'t a <payload> root', () => {
      expect(parse('<body>hello</body>')).toBeNull()
    })

    it('returns null for malformed XML', () => {
      expect(parse('<payload<body></body></payload>')).toBeNull()
    })
  })

  describe('isPayloadEnvelope', () => {
    it('detects envelope prefix', () => {
      expect(isPayloadEnvelope('<payload xmlns="jabber:client">hi</payload>')).toBe(true)
    })
    it('rejects bare strings', () => {
      expect(isPayloadEnvelope('hello')).toBe(false)
      expect(isPayloadEnvelope('<body>hi</body>')).toBe(false)
    })
  })
})
