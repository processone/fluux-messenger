import { describe, it, expect } from 'vitest'
import {
  transientIdentity,
  transientAliases,
  noteTransient,
  transientCounts,
  pruneTransient,
  removeTransient,
  clearTransientScope,
  type ScopeKey,
} from './transientUnread'
import { roomScope, tierKey } from '../../utils/messageIdentity'
import { makeCacheOrderKey, type ExactPosition } from './readState'

/**
 * A transient entry's position.
 *
 * These tests exercise identity, aliasing, coalescing and counting — never
 * tie-breaks — so every fixture shares ONE key. Same-millisecond fixtures then
 * compare equal, exactly as they did when they carried no key at all, while
 * `ExactPosition` still holds: a transient entry is always noted from a real
 * message, so in production its tie-break always resolves (#1173).
 */
const FIXTURE_TIEBREAK = makeCacheOrderKey({ from: 'fixture@x', id: 'fixture' }, 'room')
const posAt = (timestamp: number): ExactPosition => ({ role: 'exact', timestamp, tiebreak: FIXTURE_TIEBREAK })

// Fresh scope per test: entityIds are unique so no state leaks between tests
// (the module holds module-level state, matching the always-on lifetime the
// brief requires — "never cleared on deactivation").
let counter = 0
function freshScopeKey(kind: 'chat' | 'room' = 'room'): ScopeKey {
  counter += 1
  return { accountScope: 'me@x', kind, entityId: `r${counter}@c` }
}

describe('transientUnread — room lifecycle, identity, and alias cases', () => {
  it('survives switching away and back (never cleared on deactivate)', () => {
    const K = freshScopeKey()
    const msg = { roomJid: K.entityId, from: `${K.entityId}/al`, id: 'm1' }
    const note = (m: typeof msg & { stanzaId?: string }, at: number) =>
      noteTransient(K, { position: posAt(at) }, transientIdentity(m, 'room'), transientAliases(m, 'room'))

    note(msg, 10)
    // simulate deactivate + reactivate: nothing is called; the entry must remain
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(1)
  })

  it('re-noting the same logical message after a stanzaId arrives does not double-count', () => {
    const K = freshScopeKey()
    const msg = { roomJid: K.entityId, from: `${K.entityId}/al`, id: 'm1' }
    const note = (m: typeof msg & { stanzaId?: string }, at: number) =>
      noteTransient(K, { position: posAt(at) }, transientIdentity(m, 'room'), transientAliases(m, 'room'))

    note(msg, 10)
    note({ ...msg, stanzaId: 'S1' }, 10) // same logical message, higher identity tier
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(1) // NOT 2
  })

  it('removeTransient resolves a retraction that references only the stanza-id', () => {
    const K = freshScopeKey()
    const msg = { roomJid: K.entityId, from: `${K.entityId}/al`, id: 'm1' }
    const note = (m: typeof msg & { stanzaId?: string }, at: number) =>
      noteTransient(K, { position: posAt(at) }, transientIdentity(m, 'room'), transientAliases(m, 'room'))

    note({ ...msg, stanzaId: 'S1' }, 10)
    removeTransient(K, tierKey(roomScope(K.entityId), 'stanzaId', 'S1'))
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(0)
  })

  it('two room messages with the SAME id but different senders count as two', () => {
    const K = freshScopeKey()
    const note = (m: { roomJid: string; from: string; id: string }, at: number) =>
      noteTransient(K, { position: posAt(at) }, transientIdentity(m, 'room'), transientAliases(m, 'room'))

    note({ roomJid: K.entityId, from: `${K.entityId}/al`, id: 'dup' }, 10)
    note({ roomJid: K.entityId, from: `${K.entityId}/bo`, id: 'dup' }, 11)
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(2)
  })

  it('keeps colliding aliases separate across a room nick reassignment', () => {
    const K = freshScopeKey()
    const departed = {
      roomJid: K.entityId,
      from: `${K.entityId}/Alice`,
      id: 'collide',
      occupantId: 'old-occupant',
    }
    const newcomer = { ...departed, occupantId: 'new-occupant' }

    expect(noteTransient(
      K,
      { position: posAt(10) },
      transientIdentity(departed, 'room'),
      transientAliases(departed, 'room'),
      departed.occupantId
    ).added).toBe(true)
    expect(noteTransient(
      K,
      { position: posAt(20) },
      transientIdentity(newcomer, 'room'),
      transientAliases(newcomer, 'room'),
      newcomer.occupantId
    ).added).toBe(true)
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(2)

    expect(removeTransient(
      K,
      transientIdentity(newcomer, 'room'),
      newcomer.occupantId
    ).removed).toBe(true)
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(1)
  })

  it('does not let an occupant-less alias bridge collapse conflicting entries', () => {
    const K = freshScopeKey()
    const base = {
      roomJid: K.entityId,
      from: `${K.entityId}/Alice`,
      id: 'collide',
    }
    const departed = { ...base, occupantId: 'old-occupant' }
    const newcomer = { ...base, occupantId: 'new-occupant' }
    const note = (message: typeof base & { occupantId?: string }, at: number) =>
      noteTransient(
        K,
        { position: posAt(at) },
        transientIdentity(message, 'room'),
        transientAliases(message, 'room'),
        message.occupantId
      )

    note(departed, 10)
    note(newcomer, 20)
    const ambiguous = note(base, 30)

    expect(ambiguous).toEqual({ added: true, requiresRecount: false })
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(3)
  })

  it('a partial pointer advance drops only the passed entries', () => {
    const K = freshScopeKey()
    const note = (m: { roomJid: string; from: string; id: string }, at: number) =>
      noteTransient(K, { position: posAt(at) }, transientIdentity(m, 'room'), transientAliases(m, 'room'))

    note({ roomJid: K.entityId, from: `${K.entityId}/al`, id: 'a' }, 10)
    note({ roomJid: K.entityId, from: `${K.entityId}/al`, id: 'b' }, 20)
    expect(transientCounts(K, { role: 'floor', timestamp: 15 }).unread).toBe(1) // only the t=20 one remains unread
  })

  it('returns added:false when an alias merges into an existing entry', () => {
    const K = freshScopeKey()
    const msg = { roomJid: K.entityId, from: `${K.entityId}/al`, id: 'm1' }
    const note = (m: typeof msg & { stanzaId?: string }, at: number) =>
      noteTransient(K, { position: posAt(at) }, transientIdentity(m, 'room'), transientAliases(m, 'room'))

    expect(note(msg, 10).added).toBe(true)
    expect(note({ ...msg, stanzaId: 'S1' }, 10).added).toBe(false) // merged, not new
  })

  it('coalesces two entries when a later alias bridges them', () => {
    const K = freshScopeKey()
    // Two copies land separately (no shared tier yet), then a copy carrying BOTH tiers arrives.
    noteTransient(K, { position: posAt(10) }, 'origin-key-O', ['origin-key-O'])
    noteTransient(K, { position: posAt(10) }, 'stanza-key-S', ['stanza-key-S'])
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(2)

    const r = noteTransient(K, { position: posAt(10) }, 'stanza-key-S', ['stanza-key-S', 'origin-key-O']) // bridges both
    expect(r).toEqual({ added: false, requiresRecount: true }) // nothing added, but 2 -> 1
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(1) // coalesced, not 2
  })

  it('a plain alias registration reports no semantic change', () => {
    const K = freshScopeKey()
    const msg = { roomJid: K.entityId, from: `${K.entityId}/al`, id: 'm1' }
    const note = (m: typeof msg & { stanzaId?: string }, at: number) =>
      noteTransient(K, { position: posAt(at) }, transientIdentity(m, 'room'), transientAliases(m, 'room'))

    note(msg, 10)
    const r = noteTransient(K, { position: posAt(10) }, transientIdentity(msg, 'room'), transientAliases(msg, 'room'))
    expect(r).toEqual({ added: false, requiresRecount: false })
  })

  it('removeTransient reports whether anything was removed', () => {
    const K = freshScopeKey()
    const msg = { roomJid: K.entityId, from: `${K.entityId}/al`, id: 'm1' }
    const note = (m: typeof msg & { stanzaId?: string }, at: number) =>
      noteTransient(K, { position: posAt(at) }, transientIdentity(m, 'room'), transientAliases(m, 'room'))

    note(msg, 10)
    expect(removeTransient(K, transientIdentity(msg, 'room')).removed).toBe(true)
    expect(removeTransient(K, transientIdentity(msg, 'room')).removed).toBe(false)
  })

  it('coalesce keeps the EARLIEST of all positions involved, not the first-matched entry\'s own', () => {
    // Regression against a "pick the first match" coalesce that keeps
    // whichever entry happens to be first in iteration order and its own
    // stored position, rather than computing the minimum across every
    // coalesced entry (5) and the incoming note itself (30).
    const K = freshScopeKey()
    noteTransient(K, { position: posAt(20) }, 'tier-a', ['tier-a']) // first-matched under a naive impl
    noteTransient(K, { position: posAt(5) }, 'tier-b', ['tier-b']) // earliest of all three
    const r = noteTransient(K, { position: posAt(30) }, 'tier-a', ['tier-a', 'tier-b'])
    expect(r).toEqual({ added: false, requiresRecount: true })
    // A boundary of 10 sits strictly between the earliest (5) and tier-a's own
    // original position (20): correct behaviour reads 0 (5 <= 10, already
    // passed); "keep the first match's own position" would wrongly read 1.
    expect(transientCounts(K, { role: 'floor', timestamp: 10 }).unread).toBe(0)
    expect(transientCounts(K, { role: 'floor', timestamp: 4 }).unread).toBe(1) // the surviving entry (at 5) still exists
  })
})

describe('transientUnread — scope isolation', () => {
  it('a bare entityId leaks across accounts unless accountScope partitions it', () => {
    const roomJid = 'shared@conference.example.com'
    const accountA: ScopeKey = { accountScope: 'alice@x', kind: 'room', entityId: roomJid }
    const accountB: ScopeKey = { accountScope: 'bob@x', kind: 'room', entityId: roomJid }

    noteTransient(accountA, { position: posAt(10) }, transientIdentity({ roomJid, from: `${roomJid}/al`, id: 'm1' }, 'room'), [
      'k-a',
    ])

    expect(transientCounts(accountA, { role: 'floor', timestamp: 5 }).unread).toBe(1)
    expect(transientCounts(accountB, { role: 'floor', timestamp: 5 }).unread).toBe(0)
  })

  it('chat and room kinds under the same entityId are independent scopes', () => {
    const entityId = 'same@x'
    const chatKey: ScopeKey = { accountScope: 'me@x', kind: 'chat', entityId }
    const roomKey: ScopeKey = { accountScope: 'me@x', kind: 'room', entityId }

    noteTransient(chatKey, { position: posAt(10) }, transientIdentity({ id: 'c1' }, 'chat'), transientAliases({ id: 'c1' }, 'chat'))

    expect(transientCounts(chatKey, { role: 'floor', timestamp: 5 }).unread).toBe(1)
    expect(transientCounts(roomKey, { role: 'floor', timestamp: 5 }).unread).toBe(0)
  })
})

describe('transientUnread — chat identity (bare id, no tiers)', () => {
  it('uses the message id directly as identity and sole alias', () => {
    expect(transientIdentity({ id: 'm1' }, 'chat')).toBe('m1')
    expect(transientAliases({ id: 'm1' }, 'chat')).toEqual(['m1'])
  })

  it('counts a noted chat message as unread until the boundary passes it', () => {
    const K = freshScopeKey('chat')
    noteTransient(K, { position: posAt(10) }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
    expect(transientCounts(K, { role: 'floor', timestamp: 5 }).unread).toBe(1)
    expect(transientCounts(K, { role: 'floor', timestamp: 15 }).unread).toBe(0)
  })
})

describe('transientUnread — pruneTransient', () => {
  it('drops entries at or behind the boundary and leaves later ones', () => {
    const K = freshScopeKey()
    noteTransient(K, { position: posAt(10) }, 'a', ['a'])
    noteTransient(K, { position: posAt(20) }, 'b', ['b'])

    // The boundary names the SAME position as entry 'a' — the read pointer
    // sitting exactly on it. A bare `{ timestamp: 10 }` boundary would be a
    // keyless (migrated) pointer, which deliberately does NOT prune an entry
    // sharing its millisecond: that is the over-count-safe rule (#1173),
    // pinned by its own test below.
    const result = pruneTransient(K, posAt(10))
    expect(result).toEqual({ removed: 1 })
    expect(transientCounts(K, undefined).unread).toBe(1)
  })

  it('a KEYLESS boundary does not prune an entry sharing its millisecond', () => {
    // The migrated-pointer case (#1173). A keyless boundary means at-or-after
    // its timestamp, so an entry at that exact millisecond stays counted rather
    // than being dropped — an over-count the user clears by reading, instead of
    // an under-count that would hide the message for good. This is the rule the
    // prune test above deliberately does NOT exercise.
    const K = freshScopeKey()
    noteTransient(K, { position: posAt(10) }, 'a', ['a'])

    expect(pruneTransient(K, { role: 'floor', timestamp: 10 })).toEqual({ removed: 0 })
    expect(transientCounts(K, { role: 'floor', timestamp: 10 }).unread).toBe(1)
  })

  it('removed aliases can no longer resolve for removeTransient', () => {
    const K = freshScopeKey()
    noteTransient(K, { position: posAt(10) }, 'canon', ['canon', 'alias1'])
    pruneTransient(K, posAt(10))
    expect(removeTransient(K, 'alias1').removed).toBe(false)
  })

  it('an undefined boundary counts everything (no floor yet)', () => {
    const K = freshScopeKey()
    noteTransient(K, { position: posAt(10) }, 'a', ['a'])
    noteTransient(K, { position: posAt(999999) }, 'b', ['b'])
    expect(transientCounts(K, undefined).unread).toBe(2)
  })
})

describe('transientUnread — clearTransientScope', () => {
  it('clears every scope for an account but leaves other accounts intact', () => {
    const accountScope = `teardown-${counter}@x`
    counter += 1
    const roomKey: ScopeKey = { accountScope, kind: 'room', entityId: 'r@c' }
    const chatKey: ScopeKey = { accountScope, kind: 'chat', entityId: 'c@x' }
    const otherAccount: ScopeKey = { accountScope: 'untouched@x', kind: 'room', entityId: 'r@c' }

    noteTransient(roomKey, { position: posAt(10) }, 'a', ['a'])
    noteTransient(chatKey, { position: posAt(10) }, 'b', ['b'])
    noteTransient(otherAccount, { position: posAt(10) }, 'c', ['c'])

    clearTransientScope(accountScope)

    expect(transientCounts(roomKey, undefined).unread).toBe(0)
    expect(transientCounts(chatKey, undefined).unread).toBe(0)
    expect(transientCounts(otherAccount, undefined).unread).toBe(1)
  })
})
