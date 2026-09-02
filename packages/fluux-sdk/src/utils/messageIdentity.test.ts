import { describe, it, expect } from 'vitest'
import {
  CHAT_SCOPE,
  archiveReference,
  canMergeOccupantSet,
  canonicalKey,
  canonicalReference,
  chatMessageAuthor,
  createMessageLookup,
  findMessageById,
  identityFieldsEqual,
  identityKeys,
  mergeableOccupantCandidates,
  messageReferences,
  occupantConflict,
  resolveMessageReference,
  roomMessageAuthor,
  roomScope,
  sameLogicalMessage,
  searchDocumentFallbackKey,
  searchDocumentKey,
  senderReference,
  tierKey,
} from './messageIdentity'

const NUL = '\u0000'

describe('persisted key shapes', () => {
  // These strings are written to IndexedDB. Changing one orphans every stored
  // row or document, so they are pinned here rather than left to the reader.
  it('pins the room identityKeys spelling', () => {
    expect(identityKeys(roomScope('r@c'), { from: 'r@c/alice', id: 'i', stanzaId: 'S', originId: 'O' })).toEqual([
      `room${NUL}r@c${NUL}stanzaId${NUL}S`,
      `room${NUL}r@c${NUL}originId${NUL}O`,
      `room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}i`,
    ])
  })

  it('pins the chat identityKeys spelling', () => {
    expect(identityKeys(CHAT_SCOPE, { from: 'a@b', id: 'i', stanzaId: 'S', originId: 'O' })).toEqual([
      'stanzaId:S',
      'originId:O',
      'from:a@b:id:i',
    ])
  })

  it('pins the search document id, which predates the scoped ladder', () => {
    const m = { roomJid: 'r@c', from: 'r@c/alice', id: 'i' }
    expect(searchDocumentKey({ ...m, stanzaId: 'S' })).toBe('S')
    expect(searchDocumentKey(m)).toBe('r@c:r@c/alice:i')
    expect(searchDocumentFallbackKey({ ...m, stanzaId: 'S' })).toBe('r@c:r@c/alice:i')
  })

  it('always includes the from+id rung, whatever else is present', () => {
    expect(identityKeys(roomScope('r@c'), { from: 'r@c/alice', id: 'i' }))
      .toEqual([`room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}i`])
  })

  it('takes the canonical key from the highest tier present', () => {
    const scope = roomScope('r@c')
    const base = { from: 'r@c/alice', id: 'i' }
    expect(canonicalKey(scope, { ...base, stanzaId: 'S', originId: 'O' })).toBe(`room${NUL}r@c${NUL}stanzaId${NUL}S`)
    expect(canonicalKey(scope, { ...base, originId: 'O' })).toBe(`room${NUL}r@c${NUL}originId${NUL}O`)
    expect(canonicalKey(scope, base)).toBe(`room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}i`)
    expect(canonicalKey(scope, { ...base, stanzaId: 'S' })).toBe(identityKeys(scope, { ...base, stanzaId: 'S' })[0])
  })

  it('qualifies only a room fallback canonical key with occupant evidence', () => {
    const scope = roomScope('r@c')
    const base = { from: 'r@c/alice', id: 'i', occupantId: 'occupant-a' }
    const fallback = `room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}i`

    expect(identityKeys(scope, base)).toEqual([fallback])
    expect(canonicalKey(scope, base)).toBe(`${fallback}${NUL}occupantId${NUL}occupant-a`)
    expect(canonicalKey(scope, { ...base, occupantId: 'occupant-b' }))
      .toBe(`${fallback}${NUL}occupantId${NUL}occupant-b`)
    expect(canonicalKey(scope, { ...base, stanzaId: 'S' }))
      .toBe(`room${NUL}r@c${NUL}stanzaId${NUL}S`)
    expect(canonicalKey(scope, { ...base, originId: 'O' }))
      .toBe(`room${NUL}r@c${NUL}originId${NUL}O`)
  })

  it('emits the same key from tierKey as from identityKeys', () => {
    const m = { from: 'r@c/alice', id: 'i', stanzaId: 'S', originId: 'O' }
    const keys = identityKeys(roomScope('r@c'), m)
    expect(keys).toContain(tierKey(roomScope('r@c'), 'stanzaId', 'S'))
    expect(keys).toContain(tierKey(roomScope('r@c'), 'originId', 'O'))
  })
})

describe('resolution policies', () => {
  // The two orderings disagree about where originId sits, which is exactly why
  // the policy is a required argument rather than a default.
  const byOrigin = { from: 'a@b', id: 'x1', originId: 'REF' }
  const byId = { from: 'a@b', id: 'REF' }

  it('archive-first ranks originId above the bare client id', () => {
    const resolved = resolveMessageReference([byId, byOrigin], 'REF', 'archive-first')
    expect(resolved?.tier).toBe('originId')
    expect(resolved?.candidates[0].message).toBe(byOrigin)
  })

  it('client-id-first ranks the bare client id above originId', () => {
    const resolved = resolveMessageReference([byOrigin, byId], 'REF', 'client-id-first')
    expect(resolved?.tier).toBe('client-id')
    expect(resolved?.candidates[0].message).toBe(byId)
  })

  it('marks the from+id rung non-authoritative under archive-first', () => {
    const resolved = resolveMessageReference([byId], 'REF', 'archive-first')
    expect(resolved?.tier).toBe('fallback')
    expect(resolved?.authoritative).toBe(false)
  })

  it('returns every candidate at the winning tier, not just the first', () => {
    const a = { from: 'a@b', id: 'REF' }
    const b = { from: 'c@d', id: 'REF' }
    const resolved = resolveMessageReference([a, b], 'REF', 'archive-first')
    expect(resolved?.candidates.map(({ message }) => message)).toEqual([a, b])
  })

  it('resolves a correction archive id under client-id-first only', () => {
    const corrected = { from: 'a@b', id: 'm1', correctionStanzaIds: ['C1'] }
    expect(findMessageById([corrected], 'C1')).toBe(corrected)
    expect(resolveMessageReference([corrected], 'C1', 'archive-first')).toBeUndefined()
  })

  it('never lets a spoofable originId shadow a strong-tier match in the lookup map', () => {
    const spoofer = { from: 'evil@b', id: 'e1', originId: 'REF' }
    const real = { from: 'a@b', id: 'REF' }
    expect(createMessageLookup([spoofer, real]).get('REF')).toBe(real)
  })
})

describe('messageReferences', () => {
  const m = { from: 'a@b', id: 'i', stanzaId: 'S', originId: 'O', correctionStanzaIds: ['C'] }

  it('orders by the policy it is given', () => {
    expect(messageReferences(m, 'archive-first')).toEqual(['S', 'O', 'i', 'C'])
    expect(messageReferences(m, 'client-id-first')).toEqual(['i', 'S', 'C', 'O'])
  })

  it('omits the tiers the message does not carry', () => {
    expect(messageReferences({ id: 'i' }, 'archive-first')).toEqual(['i'])
  })
})

describe('outgoing reference rules', () => {
  const m = { from: 'r@c/alice', id: 'i', stanzaId: 'S', originId: 'O' }

  it('gives a reply or moderation the archive id, skipping originId', () => {
    expect(archiveReference(m)).toBe('S')
    expect(archiveReference({ id: 'i' })).toBe('i')
  })

  it('gives a correction the sender-assigned id, never the archive id', () => {
    expect(senderReference(m)).toBe('O')
    expect(senderReference({ id: 'i' })).toBe('i')
  })

  it('gives a retraction the full ladder', () => {
    expect(canonicalReference(m)).toBe('S')
    expect(canonicalReference({ id: 'i', originId: 'O' })).toBe('O')
    expect(canonicalReference({ id: 'i' })).toBe('i')
  })

  // An empty-string tier counts as absent for keys, so it must for references too.
  it('treats an empty tier as absent, agreeing with identityKeys', () => {
    const empty = { from: 'a@b', id: 'i', stanzaId: '', originId: '' }
    expect(canonicalReference(empty)).toBe('i')
    expect(archiveReference(empty)).toBe('i')
    expect(senderReference(empty)).toBe('i')
    expect(identityKeys(CHAT_SCOPE, empty)).toEqual(['from:a@b:id:i'])
    expect(searchDocumentKey({ ...empty, roomJid: 'r@c' })).toBe('r@c:a@b:i')
  })

  it('returns a raw id, not a cache key', () => {
    expect(canonicalReference(m)).not.toBe(canonicalKey(roomScope('r@c'), m))
  })
})

describe('sameLogicalMessage', () => {
  const echo = { roomJid: 'r@c', from: 'r@c/alice', id: 'i', originId: 'O' }
  const reflection = { roomJid: 'r@c', from: 'r@c/alice', id: 'i', originId: 'O', stanzaId: 'S' }

  it('matches copies that share any tier', () => {
    expect(sameLogicalMessage(roomScope('r@c'), echo, reflection)).toBe(true)
  })

  // The scope is the caller's, not the message's: two rooms' keys never collide,
  // so a comparison is always inside one room's key space.
  it('separates rooms at the key level', () => {
    const here = identityKeys(roomScope('r@c'), reflection)
    const there = identityKeys(roomScope('other@c'), reflection)
    expect(here.some((key) => there.includes(key))).toBe(false)
  })

  // The collision this whole boundary exists to stop: after a nick reassignment
  // two occupants share room, nick and client id, and only the occupant-id
  // separates them.
  it('refuses a from+id match when the occupant-ids disagree', () => {
    const departed = { roomJid: 'r@c', from: 'r@c/alice', id: 'i', occupantId: 'occ-1' }
    const newcomer = { roomJid: 'r@c', from: 'r@c/alice', id: 'i', occupantId: 'occ-2' }
    expect(identityKeys(roomScope('r@c'), departed)).toEqual(identityKeys(roomScope('r@c'), newcomer))
    expect(sameLogicalMessage(roomScope('r@c'), departed, newcomer)).toBe(false)
  })

  // A local echo carries no occupant-id; an absent id is not evidence.
  it('still matches when only one side carries an occupant-id', () => {
    const stamped = { roomJid: 'r@c', from: 'r@c/alice', id: 'i', occupantId: 'occ-1' }
    const unstamped = { roomJid: 'r@c', from: 'r@c/alice', id: 'i' }
    expect(sameLogicalMessage(roomScope('r@c'), stamped, unstamped)).toBe(true)
  })
})

describe('occupantConflict', () => {
  it('is evidence of difference only, never of sameness', () => {
    expect(occupantConflict({ occupantId: 'a' }, { occupantId: 'b' })).toBe(true)
    expect(occupantConflict({ occupantId: 'a' }, { occupantId: 'a' })).toBe(false)
    expect(occupantConflict({ occupantId: 'a' }, {})).toBe(false)
    expect(occupantConflict({}, {})).toBe(false)
  })
})

describe('canMergeOccupantSet', () => {
  it('accepts unknown evidence until known occupant ids conflict', () => {
    expect(canMergeOccupantSet([{}, {}])).toBe(true)
    expect(canMergeOccupantSet([{ occupantId: 'a' }, {}])).toBe(true)
    expect(canMergeOccupantSet([
      { occupantId: 'a' },
      {},
      { occupantId: 'b' },
    ])).toBe(false)
  })

  it('selects an exact known occupant from an ambiguous candidate set', () => {
    const candidates = [
      { occupantId: 'a', id: 'old' },
      { id: 'unknown' },
      { occupantId: 'b', id: 'new' },
    ]

    expect(mergeableOccupantCandidates({ occupantId: 'b' }, candidates)).toEqual([
      { occupantId: 'b', id: 'new' },
    ])
    expect(mergeableOccupantCandidates({}, candidates)).toEqual([])
  })
})

describe('identityFieldsEqual', () => {
  const row = { from: 'r@c/alice', id: 'i', stanzaId: 'S' }

  it('sees an added originId even though the canonical key is unchanged', () => {
    const widened = { ...row, originId: 'O' }
    expect(canonicalKey(roomScope('r@c'), widened)).toBe(canonicalKey(roomScope('r@c'), row))
    expect(identityFieldsEqual(widened, row)).toBe(false)
  })

  it('treats a different room as a different identity', () => {
    expect(identityFieldsEqual({ ...row, roomJid: 'a@c' }, { ...row, roomJid: 'b@c' })).toBe(false)
  })

  it('ignores non-identity fields', () => {
    expect(identityFieldsEqual({ ...row, occupantId: 'x' }, row)).toBe(true)
  })
})

describe('authorship gates', () => {
  it('prefers the occupant-id when both sides carry one', () => {
    expect(roomMessageAuthor(
      { from: 'r@c/alice', occupantId: 'occ-1' },
      { actorJid: 'r@c/alice', actorOccupantId: 'occ-2' },
    )).toBe(false)
  })

  it('falls back to the nick when a pre-XEP-0421 room offers nothing else', () => {
    expect(roomMessageAuthor({ from: 'r@c/alice' }, { actorJid: 'r@c/alice' })).toBe(true)
  })

  it('compares bare JIDs for 1:1', () => {
    expect(chatMessageAuthor({ from: 'a@b' }, { actorJid: 'a@b' })).toBe(true)
    expect(chatMessageAuthor({ from: 'a@b' }, { actorJid: 'c@d' })).toBe(false)
  })
})
