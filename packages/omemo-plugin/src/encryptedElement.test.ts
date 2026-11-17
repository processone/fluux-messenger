import { describe, it, expect } from 'vitest'
import { buildEncrypted, parseEncrypted } from './encryptedElement'
import type { OmemoMessage } from '@fluux/omemo'

describe('<encrypted> <-> OmemoMessage', () => {
  it('groups keys by jid and round-trips (kex + payload)', () => {
    const msg: OmemoMessage = {
      sid: 111,
      keys: [
        { jid: 'bob@x', rid: 5, kex: true, data: new Uint8Array([1, 2, 3]) },
        { jid: 'bob@x', rid: 6, kex: false, data: new Uint8Array([4, 5]) },
        { jid: 'alice@x', rid: 9, kex: false, data: new Uint8Array([6]) },
      ],
      payload: new Uint8Array([9, 9, 9]),
    }
    const el = buildEncrypted(msg)
    expect(el.name).toBe('encrypted')
    expect(el.attrs.xmlns).toBe('urn:xmpp:omemo:2')
    expect(el.getChild('header')!.attrs.sid).toBe('111')
    expect(el.getChild('header')!.getChildren('keys')).toHaveLength(2) // two jid groups
    const parsed = parseEncrypted(el)
    expect(parsed).toEqual(msg)
  })

  it('emits kex=\'true\' only for kex keys and omits it otherwise', () => {
    const el = buildEncrypted({
      sid: 7,
      keys: [
        { jid: 'b@x', rid: 1, kex: true, data: new Uint8Array([1]) },
        { jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([2]) },
      ],
    })
    const [k1, k2] = el.getChild('header')!.getChild('keys')!.getChildren('key')
    expect(k1.attrs.kex).toBe('true')
    expect(k2.attrs.kex).toBeUndefined()
  })

  it('omits <payload> for an empty (key-transport) message', () => {
    const el = buildEncrypted({ sid: 1, keys: [{ jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([0]) }] })
    expect(el.getChild('payload')).toBeUndefined()
    const parsed = parseEncrypted(el)
    expect(parsed.payload).toBeUndefined()
    expect('payload' in parsed).toBe(false)
  })

  it('round-trips a multi-jid message preserving every {jid,rid,kex}', () => {
    const msg: OmemoMessage = {
      sid: 42,
      keys: [
        { jid: 'alice@x', rid: 100, kex: true, data: new Uint8Array([10, 20]) },
        { jid: 'alice@x', rid: 101, kex: false, data: new Uint8Array([30]) },
        { jid: 'bob@x', rid: 200, kex: false, data: new Uint8Array([40, 50, 60]) },
      ],
      payload: new Uint8Array([1, 2, 3, 4]),
    }
    const parsed = parseEncrypted(buildEncrypted(msg))
    expect(parsed).toEqual(msg)
  })

  // --- Adversarial parse tests: robustness against hostile wire input ---

  it('throws on a header with a non-numeric sid (never silently NaN)', () => {
    const el = buildEncrypted({ sid: 1, keys: [{ jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([0]) }] })
    el.getChild('header')!.attrs.sid = 'not-a-number'
    expect(() => parseEncrypted(el)).toThrow(/sid/)
  })

  it('throws on a key with a non-numeric rid (never silently NaN)', () => {
    const el = buildEncrypted({ sid: 1, keys: [{ jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([0]) }] })
    el.getChild('header')!.getChild('keys')!.getChild('key')!.attrs.rid = 'xyz'
    expect(() => parseEncrypted(el)).toThrow(/rid/)
  })

  it('throws on a <keys> group missing its jid attribute', () => {
    const el = buildEncrypted({ sid: 1, keys: [{ jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([0]) }] })
    delete el.getChild('header')!.getChild('keys')!.attrs.jid
    expect(() => parseEncrypted(el)).toThrow(/jid/)
  })

  it('throws on <key> text that is not valid base64 (garbage never becomes empty bytes)', () => {
    const el = buildEncrypted({ sid: 1, keys: [{ jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([0]) }] })
    const keyEl = el.getChild('header')!.getChild('keys')!.getChild('key')!
    keyEl.children = ['!!!not base64!!!']
    expect(() => parseEncrypted(el)).toThrow()
  })

  it('throws on an element that is not a urn:xmpp:omemo:2 <encrypted>', () => {
    const el = buildEncrypted({ sid: 1, keys: [{ jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([0]) }] })
    el.attrs.xmlns = 'wrong:ns'
    expect(() => parseEncrypted(el)).toThrow(/omemo/)
  })

  it('throws when <header> is missing', () => {
    const el = buildEncrypted({ sid: 1, keys: [{ jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([0]) }] })
    el.children = el.children.filter((c) => typeof c === 'string' || c.name !== 'header')
    expect(() => parseEncrypted(el)).toThrow(/header/)
  })
})
