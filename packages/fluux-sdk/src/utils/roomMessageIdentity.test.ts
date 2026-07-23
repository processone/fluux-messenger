import { describe, it, expect } from 'vitest'
import { roomIdentityKeys, roomCanonicalKey } from './roomMessageIdentity'

const base = { roomJid: 'r@c', from: 'r@c/alice', id: 'origin-1' }
const NUL = '\u0000'

describe('roomIdentityKeys', () => {
  it('returns all tiers most-specific first, each room-scoped', () => {
    expect(roomIdentityKeys({ ...base, stanzaId: 'S', originId: 'O' })).toEqual([
      `room${NUL}r@c${NUL}stanzaId${NUL}S`,
      `room${NUL}r@c${NUL}originId${NUL}O`,
      `room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}origin-1`,
    ])
  })
  it('always includes the from+id fallback tier', () => {
    expect(roomIdentityKeys(base)).toEqual([`room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}origin-1`])
  })
  // Control: an unscoped implementation (no room: prefix) fails this — two rooms
  // sharing a stanzaId would then collide in the identityKeys index.
  it('scopes stanzaId by room, so equal values in different rooms differ', () => {
    const a = roomIdentityKeys({ roomJid: 'A@c', from: 'A@c/x', id: 'i', stanzaId: '1' })[0]
    const b = roomIdentityKeys({ roomJid: 'B@c', from: 'B@c/x', id: 'i', stanzaId: '1' })[0]
    expect(a).not.toBe(b)
  })
})

describe('roomCanonicalKey', () => {
  it('prefers stanzaId', () => { expect(roomCanonicalKey({ ...base, stanzaId: 'S', originId: 'O' })).toBe(`room${NUL}r@c${NUL}stanzaId${NUL}S`) })
  it('falls back to originId', () => { expect(roomCanonicalKey({ ...base, originId: 'O' })).toBe(`room${NUL}r@c${NUL}originId${NUL}O`) })
  it('falls back to from+id', () => { expect(roomCanonicalKey(base)).toBe(`room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}origin-1`) })
  it('is always the first identity key', () => { const m = { ...base, stanzaId: 'S' }; expect(roomCanonicalKey(m)).toBe(roomIdentityKeys(m)[0]) })
})
