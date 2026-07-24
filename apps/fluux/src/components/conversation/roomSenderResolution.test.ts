import { describe, it, expect } from 'vitest'
import { selectSelfOccupant, stableNickSet, resolveRoomAvatar, resolveRoomSender, resolveReplyAvatar, resolveSenderColor, resolveNickColor } from './roomSenderResolution'
import { auroraSenderColor } from '@/utils/senderColor'
import type { RoomOccupant, Room, RoomMessage } from '@fluux/sdk'

const occ = (nick: string, extra: Partial<RoomOccupant> = {}): RoomOccupant =>
  ({ nick, role: 'participant', affiliation: 'none', ...extra } as RoomOccupant)

describe('selectSelfOccupant', () => {
  it('returns the occupant matching myNick', () => {
    const map = new Map([['me', occ('me')], ['you', occ('you')]])
    expect(selectSelfOccupant(map, 'me')?.nick).toBe('me')
  })
  it('returns undefined when myNick is undefined or absent', () => {
    const map = new Map([['you', occ('you')]])
    expect(selectSelfOccupant(map, undefined)).toBeUndefined()
    expect(selectSelfOccupant(map, 'me')).toBeUndefined()
  })
})

describe('stableNickSet', () => {
  it('returns the SAME set ref when the nick set is unchanged across calls', () => {
    const a = new Map([['x', occ('x')], ['y', occ('y')]])
    const first = stableNickSet(a, undefined)
    const b = new Map([['x', occ('x', { show: 'away' })], ['y', occ('y')]])
    const second = stableNickSet(b, first)
    expect(second).toBe(first)
  })
  it('returns a NEW set ref when a nick is added or removed', () => {
    const a = new Map([['x', occ('x')]])
    const first = stableNickSet(a, undefined)
    const b = new Map([['x', occ('x')], ['z', occ('z')]])
    const second = stableNickSet(b, first)
    expect(second).not.toBe(first)
    expect(second.has('z')).toBe(true)
  })
})

const room = (over: Partial<Room>): Room => ({
  jid: 'r@conf', nickname: 'me', joined: true, supportsReactions: true,
  occupants: new Map(), nickToJidCache: new Map(), nickToAvatarCache: new Map(),
  occupantIdToJidCache: new Map(), occupantIdToAvatarCache: new Map(),
  ...over,
} as Room)
const msg = (over: Partial<RoomMessage>): RoomMessage =>
  ({ id: '1', nick: 'alice', isOutgoing: false, isPrivate: false, ...over } as RoomMessage)

describe('resolveRoomSender', () => {
  it('resolves avatar + presence from the live occupant by nick', () => {
    const alice = { nick: 'alice', role: 'participant', affiliation: 'none', show: 'away', avatar: 'blob:a' } as any
    const r = room({ occupants: new Map([['alice', alice]]) })
    const s = resolveRoomSender(msg({}), r, new Map(), undefined)
    expect(s.occupant).toBe(alice)
    expect(s.senderAvatar).toBe('blob:a')
    expect(s.avatarPresence).toBe('away')
    expect(s.resolvedSenderName).toBe('alice')
  })
  it('falls back to occupant-id match when nick is not a current occupant', () => {
    const bob = { nick: 'bob2', occupantId: 'oid-bob', role: 'participant', affiliation: 'none', show: 'online' } as any
    const r = room({ occupants: new Map([['bob2', bob]]) })
    const s = resolveRoomSender(msg({ nick: 'bob', occupantId: 'oid-bob' }), r, new Map(), undefined)
    expect(s.occupant).toBe(bob)
    expect(s.resolvedSenderName).toBe('bob2')
  })
  it('reports avatarPresence offline when occupant absent (joined room)', () => {
    const s = resolveRoomSender(msg({ nick: 'ghost' }), room({}), new Map(), undefined)
    expect(s.avatarPresence).toBe('offline')
  })
  it('restores an offline anonymous sender avatar by room-scoped occupant-id', () => {
    const r = room({
      occupantIdToAvatarCache: new Map([['occ-alice', 'blob:stable']]),
      nickToAvatarCache: new Map([['alice', 'blob:nick']]),
    })
    const s = resolveRoomSender(
      msg({ nick: 'alice', occupantId: 'occ-alice' }),
      r,
      new Map(),
      undefined,
    )
    expect(s.senderAvatar).toBe('blob:stable')
    expect(s.avatarPresence).toBe('offline')
  })
  it('does not give a historical sender the avatar of a recycled nickname', () => {
    const recycled = occ('alice', {
      occupantId: 'occ-new-person',
      avatar: 'blob:new-person',
    })
    const r = room({
      occupants: new Map([['alice', recycled]]),
      nickToAvatarCache: new Map([['alice', 'blob:unsafe-nick-cache']]),
    })
    const resolved = resolveRoomAvatar(
      { nick: 'alice', occupantId: 'occ-old-person' },
      r,
      new Map(),
    )
    expect(resolved.occupant).toBeUndefined()
    expect(resolved.avatarUrl).toBeUndefined()
    expect(resolved.source).toBe('fallback')
  })
  it('follows a stable occupant-id across a nickname change', () => {
    const renamed = occ('alice-new', {
      occupantId: 'occ-alice',
      avatar: 'blob:renamed',
    })
    const r = room({ occupants: new Map([['alice-new', renamed]]) })
    const resolved = resolveRoomAvatar(
      { nick: 'alice-old', occupantId: 'occ-alice' },
      r,
      new Map(),
    )
    expect(resolved.occupant).toBe(renamed)
    expect(resolved.matchedNick).toBe('alice-new')
    expect(resolved.avatarUrl).toBe('blob:renamed')
  })
  it('falls back through the stable JID alias in a non-anonymous room', () => {
    const r = room({
      occupantIdToJidCache: new Map([['occ-alice', 'alice@example.com']]),
    })
    const contacts = new Map([
      ['alice@example.com', {
        jid: 'alice@example.com',
        name: 'Alice',
        avatar: 'blob:contact',
      } as any],
    ])
    const resolved = resolveRoomAvatar(
      { nick: 'old-nick', occupantId: 'occ-alice' },
      r,
      contacts,
    )
    expect(resolved.avatarUrl).toBe('blob:contact')
    expect(resolved.senderBareJid).toBe('alice@example.com')
    expect(resolved.source).toBe('jid')
  })
  it('counterpartPresent is true for non-private messages', () => {
    const s = resolveRoomSender(msg({ isPrivate: false }), room({}), new Map(), undefined)
    expect(s.counterpartPresent).toBe(true)
  })
  it('canModerate is true when self is moderator and sender is participant', () => {
    const self = { nick: 'me', role: 'moderator', affiliation: 'member' } as any
    const alice = { nick: 'alice', role: 'participant', affiliation: 'none' } as any
    const r = room({ occupants: new Map([['alice', alice], ['me', self]]) })
    const s = resolveRoomSender(msg({}), r, new Map(), self)
    expect(s.canModerate).toBe(true)
  })
  it('canModerate is false for outgoing messages even when self is moderator', () => {
    const self = { nick: 'me', role: 'moderator', affiliation: 'admin' } as any
    const r = room({ occupants: new Map([['me', self]]) })
    const s = resolveRoomSender(msg({ isOutgoing: true }), r, new Map(), self)
    expect(s.canModerate).toBe(false)
  })
  it('canModerate is false when the room does not support moderation (XEP-0425, supportsModeration === false)', () => {
    const self = { nick: 'me', role: 'moderator', affiliation: 'member' } as any
    const alice = { nick: 'alice', role: 'participant', affiliation: 'none' } as any
    const r = room({ occupants: new Map([['alice', alice], ['me', self]]), supportsModeration: false })
    const s = resolveRoomSender(msg({}), r, new Map(), self)
    expect(s.canModerate).toBe(false)
  })
  it('canModerate stays true when supportsModeration is undefined (disco unresolved — optimistic)', () => {
    const self = { nick: 'me', role: 'moderator', affiliation: 'member' } as any
    const alice = { nick: 'alice', role: 'participant', affiliation: 'none' } as any
    const r = room({ occupants: new Map([['alice', alice], ['me', self]]) })
    const s = resolveRoomSender(msg({}), r, new Map(), self)
    expect(s.canModerate).toBe(true)
  })
  it('counterpartPresent is false for a private message when the counterpart is absent', () => {
    const s = resolveRoomSender(msg({ isPrivate: true, whisperWith: 'alice' }), room({}), new Map(), undefined)
    expect(s.counterpartPresent).toBe(false)
  })
  it('senderBareJid falls back via the occupant-id cache where senderBareJidForBan is undefined', () => {
    // Message nick is NOT a current occupant, but occupant-id matches an occupant
    // under a different nick; the JID for that nick lives only in nickToJidCache.
    const bob = { nick: 'bob2', occupantId: 'oid-bob', role: 'participant', affiliation: 'none' } as any
    const r = room({
      occupants: new Map([['bob2', bob]]),
      // cache keyed by the occupant-id-matched nick, NOT message.nick
      nickToJidCache: new Map([['bob2', 'bob@server']]),
    })
    const s = resolveRoomSender(msg({ nick: 'bob', occupantId: 'oid-bob' }), r, new Map(), undefined)
    // Ban path has no occupant-id fallback → undefined (occupant.jid absent, cache miss on message.nick)
    expect(s.senderBareJidForBan).toBeUndefined()
    // Superset JID resolves via the occupant-id-matched nick cache entry
    expect(s.senderBareJid).toBe('bob@server')
  })
})

describe('resolveReplyAvatar', () => {
  it('prefers occupant avatar, then cache, then contact', () => {
    const r = room({
      occupants: new Map([['alice', { nick: 'alice', avatar: 'blob:occ' } as any]]),
      nickToAvatarCache: new Map([['alice', 'blob:cache']]),
    })
    const res = resolveReplyAvatar('alice', r, new Map(), 'me', 'blob:own')
    expect(res).toEqual({ avatarUrl: 'blob:occ', avatarIdentifier: 'alice' })
  })
  it('uses own avatar when the reply nick is me', () => {
    expect(resolveReplyAvatar('me', room({}), new Map(), 'me', 'blob:own'))
      .toEqual({ avatarUrl: 'blob:own', avatarIdentifier: 'me' })
  })
  it('returns identifier-safe result for a null nick', () => {
    expect(resolveReplyAvatar(undefined, room({}), new Map(), 'me', undefined))
      .toEqual({ avatarUrl: undefined, avatarIdentifier: 'unknown' })
  })
  it('falls back to nickToAvatarCache when the occupant has no avatar', () => {
    const r = room({
      occupants: new Map([['alice', { nick: 'alice' } as any]]),
      nickToAvatarCache: new Map([['alice', 'blob:cache']]),
    })
    expect(resolveReplyAvatar('alice', r, new Map(), 'me', undefined).avatarUrl).toBe('blob:cache')
  })
  it('falls back to the contact avatar when occupant and cache have none', () => {
    const r = room({
      occupants: new Map([['alice', { nick: 'alice', jid: 'alice@x' } as any]]),
    })
    // getBareJid strips resource; 'alice@x' has no slash so getBareJid returns 'alice@x' unchanged
    const contacts = new Map([['alice@x', { jid: 'alice@x', name: 'Alice', avatar: 'blob:contact' } as any]])
    expect(resolveReplyAvatar('alice', r, contacts, 'me', undefined).avatarUrl).toBe('blob:contact')
  })
  // The reply sender's bare JID is needed by the row to look up the contact's
  // pre-calculated XEP-0392 color, so the quote matches the main message color.
  it('returns the reply sender bare JID from the occupant full JID', () => {
    const r = room({
      occupants: new Map([['alice', { nick: 'alice', jid: 'alice@x/res' } as any]]),
    })
    expect(resolveReplyAvatar('alice', r, new Map(), 'me', undefined).senderBareJid).toBe('alice@x')
  })
  it('falls back to nickToJidCache for the bare JID when the occupant left', () => {
    const r = room({ nickToJidCache: new Map([['alice', 'alice@x']]) })
    expect(resolveReplyAvatar('alice', r, new Map(), 'me', undefined).senderBareJid).toBe('alice@x')
  })
})

describe('resolveSenderColor', () => {
  // Aurora: one consistent, AA-tuned per-person color for all senders — the
  // roster's precomputed contact color is intentionally not used for names.
  // Both the main message and the reply quote use auroraSenderColor so the
  // same sender always gets the same color in both places.
  const contact = { jid: 'alice@x', colorLight: '#7b4500', colorDark: '#ffa54c' } as any
  it('returns auroraSenderColor regardless of contact — consistent system for all senders', () => {
    expect(resolveSenderColor('alice', contact, true)).toBe(auroraSenderColor('alice', true))
    expect(resolveSenderColor('alice', contact, false)).toBe(auroraSenderColor('alice', false))
  })
  it('returns auroraSenderColor when there is no contact', () => {
    expect(resolveSenderColor('alice', undefined, true)).toBe(auroraSenderColor('alice', true))
    expect(resolveSenderColor('alice', undefined, false)).toBe(auroraSenderColor('alice', false))
  })
  it('returns auroraSenderColor when the contact has no pre-calculated colors', () => {
    expect(resolveSenderColor('alice', { jid: 'alice@x' } as any, false)).toBe(auroraSenderColor('alice', false))
  })
})

describe('resolveNickColor', () => {
  // Aurora: resolveNickColor delegates to resolveSenderColor. The color is seeded
  // on the mentioned person's STABLE identity (occupant-id, then real JID), not the
  // nick string, so an impersonating look-alike nick diverges in color.
  const contact = { jid: 'alice@x', colorLight: '#7b4500', colorDark: '#ffa54c' } as any
  it('seeds on the real JID when the nick maps to a JID via the live occupant', () => {
    const r = room({
      occupants: new Map([['alice', occ('alice', { jid: 'alice@x/res' })]]),
    })
    expect(resolveNickColor('alice', r, new Map([['alice@x', contact]]), true)).toBe(auroraSenderColor('alice@x', true))
  })
  it('seeds on the real JID when it comes from nickToJidCache', () => {
    const r = room({ occupants: new Map(), nickToJidCache: new Map([['alice', 'alice@x']]) })
    expect(resolveNickColor('alice', r, new Map([['alice@x', contact]]), false)).toBe(auroraSenderColor('alice@x', false))
  })
  it('prefers the occupant-id over the JID when both are known', () => {
    const r = room({
      occupants: new Map([['alice', occ('alice', { jid: 'alice@x/res', occupantId: 'oid-alice' })]]),
    })
    expect(resolveNickColor('alice', r, new Map([['alice@x', contact]]), true)).toBe(auroraSenderColor('oid-alice', true))
  })
  it('falls back to the nick for an unknown occupant (no JID / no occupant-id)', () => {
    const r = room({ occupants: new Map(), nickToJidCache: new Map() })
    expect(resolveNickColor('ghost', r, new Map(), true)).toBe(auroraSenderColor('ghost', true))
  })
})
