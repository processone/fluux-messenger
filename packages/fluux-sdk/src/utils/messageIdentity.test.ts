import { describe, it, expect } from 'vitest'
import {
  CHAT_SCOPE,
  archiveReference,
  canMergeOccupantSet,
  canonicalKey,
  canonicalReference,
  chatMessageAuthor,
  adoptDeliveryEvidence,
  createMessageLookup,
  fallbackRungOnly,
  findMessageById,
  firstDeliveryConflict,
  identityFieldsEqual,
  identityKeys,
  isFallbackKey,
  mergeableOccupantCandidates,
  messageReferences,
  occupantConflict,
  receiptQualifiedKey,
  resolveMessageReference,
  retractionPrecedesDelivery,
  roomMessageAuthor,
  roomScope,
  sameLogicalMessage,
  searchDocumentFallbackKey,
  searchDocumentKey,
  selectMergeTargets,
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

  it('resolves a correction archive id under both reference policies', () => {
    const corrected = { from: 'a@b', id: 'm1', correctionStanzaIds: ['C1'] }
    expect(findMessageById([corrected], 'C1')).toBe(corrected)
    expect(resolveMessageReference([corrected], 'C1', 'archive-first')).toMatchObject({
      tier: 'correctionStanzaId', authoritative: true, candidates: [{ message: corrected }],
    })
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

// The delivery-channel clause: the from+id rung recognises a message that comes
// around again, and every re-delivery channel marks itself (a delay stamp, or
// being one's own reflection). A first delivery received after a row the client
// already holds is a new message, however alike — a room broadcasts a message
// once. Receipt instants come from the client's own clock (`receivedAt`).
describe('sameLogicalMessage — a first delivery on the from+id rung', () => {
  const scope = roomScope('r@c')
  const alice = { roomJid: 'r@c', from: 'r@c/alice', id: 'i', timestamp: new Date(1000), receivedAt: new Date(1000), isOutgoing: false }
  const bob = { ...alice, timestamp: new Date(2000), receivedAt: new Date(2000) }

  it('separates two first deliveries received at different instants', () => {
    expect(firstDeliveryConflict(alice, bob)).toBe(true)
    expect(sameLogicalMessage(scope, alice, bob)).toBe(false)
    expect(sameLogicalMessage(scope, bob, alice)).toBe(false)
  })

  it('keeps one object presented again: the same instant is the same message', () => {
    expect(sameLogicalMessage(scope, alice, { ...alice })).toBe(true)
  })

  it('merges a re-delivery received after the first delivery it repeats', () => {
    // A MAM or history copy carries the original stamp and its own, later receipt.
    const copy = { ...alice, isDelayed: true, receivedAt: new Date(5000) }
    expect(sameLogicalMessage(scope, alice, copy)).toBe(true)
    expect(sameLogicalMessage(scope, copy, alice)).toBe(true)
    // XEP-0203 lets the SENDER stamp a delay; that copy is a re-delivery here too.
    expect(sameLogicalMessage(scope, alice, { ...bob, isDelayed: true })).toBe(true)
  })

  // A late joiner holds Alice's message as a history copy; Bob's live message
  // with a reused client id is still a first delivery received after it.
  it('separates a first delivery received after a delayed row', () => {
    const aliceViaHistory = { ...alice, isDelayed: true }
    expect(firstDeliveryConflict(aliceViaHistory, bob)).toBe(true)
    expect(sameLogicalMessage(scope, aliceViaHistory, bob)).toBe(false)
    expect(sameLogicalMessage(scope, bob, aliceViaHistory)).toBe(false)
  })

  it('merges two re-deliveries, and one\'s own reflection with the optimistic echo', () => {
    expect(sameLogicalMessage(scope, { ...alice, isDelayed: true }, { ...bob, isDelayed: true })).toBe(true)
    const echo = { ...alice, isOutgoing: true }
    const reflection = { ...bob, isOutgoing: true }
    expect(sameLogicalMessage(scope, echo, reflection)).toBe(true)
  })

  it('never reaches an authoritative tier', () => {
    // A shared origin id or archive id proves the copies are one message; the
    // clause only ever applies where from+id is the sole shared key.
    expect(sameLogicalMessage(scope, { ...alice, originId: 'O' }, { ...bob, originId: 'O' })).toBe(true)
    expect(sameLogicalMessage(scope, { ...alice, stanzaId: 'S' }, { ...bob, stanzaId: 'S' })).toBe(true)
  })

  it('reads the receipt instant, never the stamp', () => {
    // A merged row keeps the archive stamp as its timestamp and the first
    // delivery's receipt instant separately.
    const merged = { ...alice, timestamp: new Date(1800), receivedAt: new Date(2000) }
    expect(firstDeliveryConflict(merged, { ...alice, receivedAt: new Date(1000) })).toBe(true)
    expect(firstDeliveryConflict(merged, { ...alice, receivedAt: new Date(2000), timestamp: new Date(2000) })).toBe(false)
  })

  it('stays inert without a receipt instant on either side, and outside rooms', () => {
    const { receivedAt: _a, ...aliceRef } = alice
    expect(sameLogicalMessage(scope, aliceRef, bob)).toBe(true)
    expect(firstDeliveryConflict(aliceRef, bob)).toBe(false)
    const peer = { from: 'peer@example.com', id: 'i', timestamp: new Date(1000), receivedAt: new Date(1000), isOutgoing: false }
    expect(sameLogicalMessage(CHAT_SCOPE, peer, { ...peer, timestamp: new Date(2000), receivedAt: new Date(2000) })).toBe(true)
  })

  it('names the from+id rung by its persisted spelling, absorbed aliases included', () => {
    const [fallback] = identityKeys(scope, alice)
    expect(isFallbackKey(scope, fallback)).toBe(true)
    expect(isFallbackKey(scope, tierKey(scope, 'stanzaId', 'S'))).toBe(false)
    expect(fallbackRungOnly(scope, [fallback])).toBe(true)
    expect(fallbackRungOnly(scope, [fallback, tierKey(scope, 'originId', 'O')])).toBe(false)
    expect(fallbackRungOnly(CHAT_SCOPE, identityKeys(CHAT_SCOPE, { from: 'p', id: 'i' }))).toBe(false)
  })

  it('preserves a colliding first delivery under a receipt-qualified key', () => {
    expect(receiptQualifiedKey(scope, bob)).not.toBe(canonicalKey(scope, bob))
    expect(receiptQualifiedKey(scope, bob).startsWith(canonicalKey(scope, bob))).toBe(true)
    expect(receiptQualifiedKey(scope, { ...bob, stanzaId: 'S' })).toBe(receiptQualifiedKey(scope, bob))
    // The receipt instant names the key, whatever stamp the row's timestamp adopted.
    expect(receiptQualifiedKey(scope, { ...bob, timestamp: new Date(1800) })).toBe(receiptQualifiedKey(scope, bob))
    expect(receiptQualifiedKey(scope, bob)).toMatchInlineSnapshot(`"room\u0000r@c\u0000from\u0000r@c/alice\u0000id\u0000i\u0000received\u00002000"`)
  })

  it('gives a copy the delivery evidence of the row it re-delivers', () => {
    const copy = { ...alice, isDelayed: true, receivedAt: new Date(5000) }
    expect(adoptDeliveryEvidence(copy, alice)).toEqual({ ...copy, isDelayed: false, receivedAt: alice.receivedAt })
    // A row that was only ever delayed has no first delivery to lend.
    expect(adoptDeliveryEvidence(copy, { ...alice, isDelayed: true })).toBe(copy)
    // A first delivery is its own occurrence.
    expect(adoptDeliveryEvidence(alice, alice)).toBe(alice)
  })
})

describe('selectMergeTargets', () => {
  const scope = roomScope('r@c')
  const keysOf = (m: Parameters<typeof identityKeys>[1]) => identityKeys(scope, m)
  const alice = { roomJid: 'r@c', from: 'r@c/alice', id: 'i', timestamp: new Date(1000), receivedAt: new Date(1000), isOutgoing: false, isRetracted: true }
  const bob = { ...alice, timestamp: new Date(2000), receivedAt: new Date(2000), isRetracted: false }
  /** A delayed copy stamped `stamp`, received after both rows. */
  const redelivery = (stamp: number, extra: Partial<typeof alice & { stanzaId: string; originId: string }> = {}) =>
    ({ ...alice, isDelayed: true, isRetracted: false, timestamp: new Date(stamp), receivedAt: new Date(9000), ...extra })
  const select = (incoming: typeof alice & { isDelayed?: boolean; stanzaId?: string; originId?: string }, candidates: typeof alice[]) =>
    selectMergeTargets(scope, incoming, keysOf(incoming), candidates, keysOf)

  it('attaches a re-delivery reaching two first deliveries to the one whose stamp is closest', () => {
    expect(select(redelivery(2100), [alice, bob])).toEqual([bob])
    expect(select(redelivery(900), [alice, bob])).toEqual([alice])
  })

  it('attaches to none when no candidate is uniquely closest', () => {
    expect(select(redelivery(1500), [alice, bob])).toEqual([])
  })

  it('keeps ambiguous fallback deliveries separate when an archive copy repeats', () => {
    const archived = redelivery(1500, { stanzaId: 'S', receivedAt: new Date(3000) })
    expect(select(archived, [alice, bob])).toEqual([])
    expect(select(archived, [alice, bob, archived])).toEqual([archived])
  })

  it('selects at most one fallback sibling beside an authoritative match', () => {
    const archived = redelivery(2100, { stanzaId: 'S' })
    expect(select(archived, [alice, bob, archived])).toEqual([bob, archived])
  })

  it('resolves mutually separated authoritative candidates by closest stamp', () => {
    const first = { ...alice, stanzaId: 'S' }
    const second = { ...bob, originId: 'O' }
    expect(select(redelivery(1500, { stanzaId: 'S', originId: 'O' }), [first, second])).toEqual([])
    expect(select(redelivery(2100, { stanzaId: 'S', originId: 'O' }), [first, second])).toEqual([second])
  })

  it('never returns a first delivery for another first delivery', () => {
    expect(select(bob, [alice])).toEqual([])
    expect(select(bob, [alice, bob])).toEqual([bob])
  })

  it('lets an authoritative match exclude every row the evidence separates from it', () => {
    const archived = { ...alice, stanzaId: 'S' }
    // Archived A, fallback-only B, and A's delayed copy carrying S: A's tombstone never reaches B.
    expect(select(redelivery(1000, { stanzaId: 'S' }), [archived, bob])).toEqual([archived])
  })

  it('carries along a same-message sibling known under another tier', () => {
    // A live copy under an origin id and its archive copy under a stanza id share
    // only from+id, at one receipt instant: one message, two tiers.
    const archived = { ...alice, stanzaId: 'S' }
    const live = { ...alice, originId: 'O' }
    expect(select(redelivery(1000, { stanzaId: 'S' }), [archived, live])).toEqual([archived, live])
  })

  it('keeps a single re-delivery target, and leaves a chat scope alone', () => {
    expect(select(redelivery(1500), [alice])).toEqual([alice])
    expect(selectMergeTargets(CHAT_SCOPE, { ...bob, isDelayed: true }, keysOf(bob), [alice, bob], keysOf)).toEqual([alice, bob])
  })
})

describe('retractionPrecedesDelivery', () => {
  const message = { timestamp: new Date(2000), receivedAt: new Date(2000), isOutgoing: false }

  it('is true only for a first delivery received after the retraction', () => {
    expect(retractionPrecedesDelivery(message, 1000)).toBe(true)
    expect(retractionPrecedesDelivery(message, 2000)).toBe(false)
    expect(retractionPrecedesDelivery(message, 3000)).toBe(false)
  })

  it('reads the receipt instant of a merged row, not the archive stamp it adopted', () => {
    expect(retractionPrecedesDelivery({ ...message, timestamp: new Date(1800) }, 1900)).toBe(true)
  })

  it('is false for a re-delivery, and for a row without a receipt instant', () => {
    expect(retractionPrecedesDelivery({ ...message, isDelayed: true }, 1000)).toBe(false)
    expect(retractionPrecedesDelivery({ ...message, isOutgoing: true }, 1000)).toBe(false)
    expect(retractionPrecedesDelivery({ timestamp: new Date(2000), isOutgoing: false }, 1000)).toBe(false)
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
