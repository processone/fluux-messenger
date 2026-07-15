import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import { buildEnvelope, parseEnvelope } from './sce'
import { parseXml, serializeElement } from './stanzaData'

const rpad = (n: number) => new Uint8Array(n).fill(7)

describe('XEP-0420 SCE envelope', () => {
  it('wraps content directly under <content>, includes mandatory rpad, round-trips', () => {
    const body = xml('body', {}, 'interop hello')
    const env = buildEnvelope([body], { from: 'a@x', to: 'b@y', timeIso: '2026-07-15T00:00:00Z' }, rpad)
    expect(env.name).toBe('envelope')
    expect(env.attrs.xmlns).toBe('urn:xmpp:sce:1')
    expect(env.getChild('rpad')).toBeTruthy() // mandatory
    const contentEl = env.getChild('content')!
    expect(contentEl.getChild('body')!.text()).toBe('interop hello') // body DIRECTLY under content
    const parsed = parseEnvelope(env)
    expect(parsed.content[0].name).toBe('body')
    expect(parsed.content[0].text()).toBe('interop hello')
    expect(parsed.from).toBe('a@x')
    expect(parsed.to).toBe('b@y')
    expect(parsed.timeIso).toBe('2026-07-15T00:00:00Z')
  })

  it('rpad varies with the rng (length-hiding)', () => {
    const a = buildEnvelope([xml('body', {}, 'x')], {}, (n) => new Uint8Array(n).fill(1))
    const b = buildEnvelope([xml('body', {}, 'x')], {}, (n) => new Uint8Array(Math.max(1, n) + 5).fill(2))
    expect(a.getChild('rpad')!.text()).not.toBe(b.getChild('rpad')!.text())
  })

  it('rpad length tracks the injected rng (1..200 bytes, base64 varies)', () => {
    // First byte drives the length: len = (byte % 200) + 1.
    const short = buildEnvelope([xml('body', {}, 'x')], {}, () => new Uint8Array([0, 1, 2, 3, 4]))
    const long = buildEnvelope([xml('body', {}, 'x')], {}, () => new Uint8Array(300).fill(199))
    // len=1 → 1 byte → 4 base64 chars; len=200 → 200 bytes → much longer.
    expect(short.getChild('rpad')!.text().length).toBeLessThan(long.getChild('rpad')!.text().length)
    expect(short.getChild('rpad')!.text().length).toBeGreaterThan(0)
  })

  it('empty content (key-transport, no body) still builds a valid envelope and round-trips to []', () => {
    const env = buildEnvelope([], { from: 'a@x' }, rpad)
    expect(env.name).toBe('envelope')
    const contentEl = env.getChild('content')!
    expect(contentEl).toBeTruthy()
    expect(contentEl.getChildren('body')).toHaveLength(0)
    expect(env.getChild('rpad')).toBeTruthy() // rpad still mandatory
    const parsed = parseEnvelope(env)
    expect(parsed.content).toEqual([])
    expect(parsed.from).toBe('a@x')
    expect(parsed.to).toBeUndefined()
    expect(parsed.timeIso).toBeUndefined()
  })

  it('multi-byte UTF-8 body survives build → serialize → parseXml → parseEnvelope', () => {
    const text = 'héllo 🌍 café — ünïcødé'
    const env = buildEnvelope([xml('body', {}, text)], {}, rpad)
    const wire = serializeElement(env)
    const reparsed = parseXml(wire)
    const parsed = parseEnvelope(reparsed)
    expect(parsed.content[0].name).toBe('body')
    expect(parsed.content[0].text()).toBe(text)
  })

  it('content element with attributes and nested children round-trips', () => {
    const rich = xml(
      'reply',
      { xmlns: 'urn:xmpp:reply:0', to: 'b@y', id: 'abc123' },
      xml('fallback', { xmlns: 'urn:xmpp:fallback:0' }, xml('body', { start: '0', end: '5' })),
    )
    const body = xml('body', {}, 'hi')
    const env = buildEnvelope([rich, body], {}, rpad)
    const parsed = parseEnvelope(parseXml(serializeElement(env)))
    expect(parsed.content).toHaveLength(2)
    const [replyEl, bodyEl] = parsed.content
    expect(replyEl.name).toBe('reply')
    expect(replyEl.attrs.xmlns).toBe('urn:xmpp:reply:0')
    expect(replyEl.attrs.to).toBe('b@y')
    expect(replyEl.attrs.id).toBe('abc123')
    const fallback = replyEl.getChild('fallback')!
    expect(fallback.attrs.xmlns).toBe('urn:xmpp:fallback:0')
    expect(fallback.getChild('body')!.attrs.start).toBe('0')
    expect(fallback.getChild('body')!.attrs.end).toBe('5')
    expect(bodyEl.name).toBe('body')
    expect(bodyEl.text()).toBe('hi')
  })

  it('parseEnvelope throws on a non-urn:xmpp:sce:1 element', () => {
    const notEnvelope = xml('message', { xmlns: 'jabber:client' })
    expect(() => parseEnvelope(notEnvelope)).toThrow()
    const wrongNs = xml('envelope', { xmlns: 'urn:xmpp:sce:0' }, xml('content', {}))
    expect(() => parseEnvelope(wrongNs)).toThrow()
  })

  it('parseEnvelope throws when <content> is missing', () => {
    const noContent = xml('envelope', { xmlns: 'urn:xmpp:sce:1' }, xml('rpad', {}, 'AAAA'))
    expect(() => parseEnvelope(noContent)).toThrow(/content/)
  })
})
