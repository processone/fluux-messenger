import { describe, expect, it } from 'vitest'
import { xml } from '@xmpp/client'
import {
  SigncryptEnvelopeError,
  isPayloadEnvelope,
  parse,
  serialize,
  unwrapSigncrypt,
  wrapForSigncrypt,
} from './payloadEnvelope'

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

  describe('wrapForSigncrypt', () => {
    const payloadXml = serialize([xml('body', {}, 'hello')])

    it('wraps the payload with XEP-0373 §4.1 affixes', () => {
      const out = wrapForSigncrypt({
        payloadXml,
        peerJid: 'bob@example.com',
        timestamp: new Date('2026-04-24T10:00:00Z'),
        rpadLength: 8,
      })
      expect(out).toMatch(/^<signcrypt xmlns=["']urn:xmpp:openpgp:0["']>/)
      expect(out).toMatch(/<to jid=["']bob@example\.com["']\/>/)
      expect(out).toMatch(/<time stamp=["']2026-04-24T10:00:00\.000Z["']\/>/)
      expect(out).toMatch(/<rpad>[A-Za-z0-9]{8}<\/rpad>/)
      expect(out).toContain(payloadXml)
      expect(out).toMatch(/<\/signcrypt>$/)
    })

    it('xml-escapes the peer JID to block attribute-injection', () => {
      const out = wrapForSigncrypt({
        payloadXml,
        peerJid: "a'><injected attr='",
        timestamp: new Date('2026-04-24T10:00:00Z'),
        rpadLength: 0,
      })
      expect(out).toContain("&apos;")
      expect(out).not.toContain("'><injected")
    })

    it('draws rpad length uniformly across the allowed range', () => {
      // Smoke test: draw a bunch of lengths and check we see variety. The
      // `<rpad>…</rpad>` payload is the only length-dependent part.
      const lengths = new Set<number>()
      for (let i = 0; i < 64; i++) {
        const out = wrapForSigncrypt({
          payloadXml,
          peerJid: 'bob@example.com',
          timestamp: new Date(),
        })
        const m = /<rpad>([^<]*)<\/rpad>/.exec(out)
        lengths.add(m ? m[1].length : -1)
      }
      // Not deterministic, but collision-of-all is astronomically unlikely.
      expect(lengths.size).toBeGreaterThan(1)
      for (const len of lengths) {
        expect(len).toBeGreaterThanOrEqual(0)
        expect(len).toBeLessThanOrEqual(200)
      }
    })
  })

  describe('unwrapSigncrypt', () => {
    const bodyEnvelope = serialize([xml('body', {}, 'hello')])

    it('round-trips through wrap/unwrap with all affixes surfaced', () => {
      const stamp = new Date('2026-04-24T10:00:00Z')
      const wrapped = wrapForSigncrypt({
        payloadXml: bodyEnvelope,
        peerJid: 'bob@example.com',
        timestamp: stamp,
        rpadLength: 4,
      })
      const env = unwrapSigncrypt(wrapped)
      expect(env.addressees).toEqual(['bob@example.com'])
      expect(env.timestamp.toISOString()).toBe(stamp.toISOString())
      // payloadXml should be parseable by the existing envelope parser.
      const children = parse(env.payloadXml)
      expect(children?.length).toBe(1)
      expect(children![0].name).toBe('body')
      expect(children![0].text()).toBe('hello')
    })

    it('returns every addressee in document order (encrypt-to-self scenario)', () => {
      const wrapped =
        `<signcrypt xmlns='urn:xmpp:openpgp:0'>` +
        `<to jid='bob@example.com'/>` +
        `<to jid='alice@example.com'/>` +
        `<time stamp='2026-04-24T10:00:00Z'/>` +
        `<rpad></rpad>` +
        bodyEnvelope +
        `</signcrypt>`
      const env = unwrapSigncrypt(wrapped)
      expect(env.addressees).toEqual(['bob@example.com', 'alice@example.com'])
    })

    it('throws malformed-xml on bad XML', () => {
      try {
        unwrapSigncrypt('<signcrypt xmlns=\'urn:xmpp:openpgp:0\'><to ')
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(SigncryptEnvelopeError)
        expect((err as SigncryptEnvelopeError).code).toBe('malformed-xml')
      }
    })

    it('throws wrong-root when the outer element is not <signcrypt>', () => {
      try {
        unwrapSigncrypt(bodyEnvelope)
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(SigncryptEnvelopeError)
        expect((err as SigncryptEnvelopeError).code).toBe('wrong-root')
      }
    })

    it('throws missing-to when <to/> is absent', () => {
      const wrapped =
        `<signcrypt xmlns='urn:xmpp:openpgp:0'>` +
        `<time stamp='2026-04-24T10:00:00Z'/>` +
        `<rpad>x</rpad>` +
        bodyEnvelope +
        `</signcrypt>`
      try {
        unwrapSigncrypt(wrapped)
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(SigncryptEnvelopeError)
        expect((err as SigncryptEnvelopeError).code).toBe('missing-to')
      }
    })

    it('throws malformed-time on a stamp that does not parse', () => {
      const wrapped =
        `<signcrypt xmlns='urn:xmpp:openpgp:0'>` +
        `<to jid='bob@example.com'/>` +
        `<time stamp='not-a-date'/>` +
        `<rpad>x</rpad>` +
        bodyEnvelope +
        `</signcrypt>`
      try {
        unwrapSigncrypt(wrapped)
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(SigncryptEnvelopeError)
        expect((err as SigncryptEnvelopeError).code).toBe('malformed-time')
      }
    })

    it('throws missing-payload when <payload/> is absent', () => {
      const wrapped =
        `<signcrypt xmlns='urn:xmpp:openpgp:0'>` +
        `<to jid='bob@example.com'/>` +
        `<time stamp='2026-04-24T10:00:00Z'/>` +
        `<rpad>x</rpad>` +
        `</signcrypt>`
      try {
        unwrapSigncrypt(wrapped)
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(SigncryptEnvelopeError)
        expect((err as SigncryptEnvelopeError).code).toBe('missing-payload')
      }
    })

    it('normalises the inner <payload/> to xmlns=jabber:client for downstream parse', () => {
      // Sender built the envelope per XEP-0373: <payload/> has no explicit
      // xmlns and inherits `urn:xmpp:openpgp:0` from <signcrypt/>. Downstream
      // parsers expect the jabber:client-tagged form, so unwrap must
      // re-tag on the way out.
      const wrapped =
        `<signcrypt xmlns='urn:xmpp:openpgp:0'>` +
        `<to jid='bob@example.com'/>` +
        `<time stamp='2026-04-24T10:00:00Z'/>` +
        `<rpad></rpad>` +
        `<payload><body xmlns='jabber:client'>hi</body></payload>` +
        `</signcrypt>`
      const env = unwrapSigncrypt(wrapped)
      expect(env.payloadXml).toMatch(/xmlns=["']jabber:client["']/)
      const children = parse(env.payloadXml)
      expect(children?.[0].name).toBe('body')
      expect(children?.[0].text()).toBe('hi')
    })
  })
})
