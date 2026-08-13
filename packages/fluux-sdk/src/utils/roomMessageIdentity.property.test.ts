/**
 * Property tests for room message identity (XEP-0359).
 *
 * The oracle is the module's own contract, which is an IFF: "Two copies are the
 * same logical message iff they share ANY of these keys." That gives both
 * directions, and both matter.
 *
 * The forward direction is what makes dedupe work at all. One logical message
 * reaches the client as several stanzas that carry DIFFERENT id subsets — the
 * optimistic echo has no server `stanzaId` yet, the MUC reflection has
 * everything, the MAM copy may have lost the client `originId` — and every pair
 * of those shapes has to match, or the same message renders twice.
 *
 * The reverse direction is what stops it over-matching. `stanzaId` and
 * `originId` are assigned per archive and repeat across rooms, while the
 * `identityKeys` index spans the whole store, so an unscoped key would merge
 * two different rooms' messages into one.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  roomCanonicalKey,
  roomIdentityKeys,
  roomOriginKey,
  roomStanzaKey,
  type RoomIdentityFields,
} from './roomMessageIdentity'

const ROOMS = ['room-a@conf.example', 'room-b@conf.example'] as const
const NICKS = ['alice', 'bob'] as const
const MSG_IDS = ['c1', 'c2', 'c3'] as const

/**
 * A LOGICAL message: one event in a room, with the ids the server and client
 * assign to it. Every stanza the client sees is a projection of this, carrying
 * some subset of the ids — never a different value for one.
 */
interface LogicalMessage {
  roomJid: string
  nick: string
  id: string
}

const logicalArb: fc.Arbitrary<LogicalMessage> = fc.record({
  roomJid: fc.constantFrom(...ROOMS),
  nick: fc.constantFrom(...NICKS),
  id: fc.constantFrom(...MSG_IDS),
})

const key = (m: LogicalMessage) => `${m.roomJid}|${m.nick}|${m.id}`
/** Ids are derived, so two distinct messages can never collide on one. */
const stanzaIdOf = (m: LogicalMessage) => `srv-${key(m)}`
const originIdOf = (m: LogicalMessage) => `cli-${key(m)}`

/** The three stanza shapes one logical message actually arrives in. */
type CopyShape = 'echo' | 'reflection' | 'mam'
const SHAPES: CopyShape[] = ['echo', 'reflection', 'mam']

function project(m: LogicalMessage, shape: CopyShape): RoomIdentityFields {
  const base = { roomJid: m.roomJid, from: `${m.roomJid}/${m.nick}`, id: m.id }
  switch (shape) {
    // Optimistic local echo: the server has not archived it yet.
    case 'echo':
      return { ...base, originId: originIdOf(m) }
    // The room's reflection carries everything.
    case 'reflection':
      return { ...base, stanzaId: stanzaIdOf(m), originId: originIdOf(m) }
    // A MAM copy need not carry the client's origin-id.
    case 'mam':
      return { ...base, stanzaId: stanzaIdOf(m) }
  }
}

const shapeArb = fc.constantFrom(...SHAPES)
const fieldsArb = fc.tuple(logicalArb, shapeArb).map(([m, shape]) => project(m, shape))

const shareAKey = (a: RoomIdentityFields, b: RoomIdentityFields) => {
  const bKeys = new Set(roomIdentityKeys(b))
  return roomIdentityKeys(a).some((k) => bKeys.has(k))
}

describe('the tiered key set', () => {
  it('always carries the from+id tier, and a tier exactly when its id is present', () => {
    fc.assert(
      fc.property(fieldsArb, (m) => {
        const keys = roomIdentityKeys(m)
        expect(keys.length).toBeGreaterThan(0)
        // from+id is unconditional: it is the tier that always exists.
        expect(keys).toHaveLength(1 + (m.stanzaId ? 1 : 0) + (m.originId ? 1 : 0))
        expect(keys.includes(roomStanzaKey(m.roomJid, m.stanzaId ?? ''))).toBe(Boolean(m.stanzaId))
        expect(keys.includes(roomOriginKey(m.roomJid, m.originId ?? ''))).toBe(Boolean(m.originId))
      }),
      { numRuns: 3000 },
    )
  })

  it('orders the tiers most-specific first, and the canonical key is the first of them', () => {
    fc.assert(
      fc.property(fieldsArb, (m) => {
        const keys = roomIdentityKeys(m)
        expect(roomCanonicalKey(m)).toBe(keys[0])
        expect(keys).toContain(roomCanonicalKey(m))

        const expectedTop = m.stanzaId
          ? roomStanzaKey(m.roomJid, m.stanzaId)
          : m.originId
            ? roomOriginKey(m.roomJid, m.originId)
            : keys[0]
        expect(roomCanonicalKey(m)).toBe(expectedTop)
      }),
      { numRuns: 3000 },
    )
  })

  it('emits no duplicate keys', () => {
    fc.assert(
      fc.property(fieldsArb, (m) => {
        const keys = roomIdentityKeys(m)
        expect(new Set(keys).size).toBe(keys.length)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('copies of one logical message always match', () => {
  it('matches across every pair of stanza shapes', () => {
    // The forward half of the iff. An echo and a MAM copy share only the from+id
    // tier — that is the tier that makes backfill possible at all.
    fc.assert(
      fc.property(logicalArb, shapeArb, shapeArb, (m, a, b) => {
        expect(shareAKey(project(m, a), project(m, b))).toBe(true)
      }),
      { numRuns: 3000 },
    )
  })

  it('is reflexive and symmetric', () => {
    fc.assert(
      fc.property(fieldsArb, fieldsArb, (a, b) => {
        expect(shareAKey(a, a)).toBe(true)
        expect(shareAKey(a, b)).toBe(shareAKey(b, a))
      }),
      { numRuns: 3000 },
    )
  })

  it('only ever gains keys as ids arrive', () => {
    // A live copy that is later backfilled with its server stanzaId must keep
    // every key it was already indexed under, or its earlier aliases orphan.
    fc.assert(
      fc.property(logicalArb, (m) => {
        const echo = project(m, 'echo')
        const reflected = { ...echo, stanzaId: stanzaIdOf(m) }
        const before = roomIdentityKeys(echo)
        const after = new Set(roomIdentityKeys(reflected))
        for (const k of before) expect(after.has(k)).toBe(true)
        expect(after.size).toBe(before.length + 1)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('distinct messages never match', () => {
  it('never matches two different logical messages', () => {
    // The reverse half of the iff. Over-matching collapses two messages into one.
    fc.assert(
      fc.property(logicalArb, shapeArb, logicalArb, shapeArb, (m1, s1, m2, s2) => {
        if (key(m1) === key(m2)) return
        expect(shareAKey(project(m1, s1), project(m2, s2))).toBe(false)
      }),
      { numRuns: 5000 },
    )
  })

  it('never matches the same ids across two rooms', () => {
    // stanzaId and originId repeat across archives; the index does not. This is
    // the whole reason the keys are room-scoped.
    fc.assert(
      fc.property(logicalArb, shapeArb, (m, shape) => {
        const here = project(m, shape)
        const elsewhere: RoomIdentityFields = {
          ...here,
          roomJid: ROOMS.find((r) => r !== m.roomJid)!,
        }
        expect(shareAKey(here, elsewhere)).toBe(false)
      }),
      { numRuns: 3000 },
    )
  })

  it('cannot have a from+id join forged by splicing a tier marker into a field', () => {
    // The narrow, high-density version of the property below. `from` and `id` are
    // joined into one key, so a separator a peer can type makes the join
    // ambiguous: `from='x:id:y', id='z'` and `from='x', id='y:id:z'` concatenate
    // identically. The pool is tiny on purpose — the collision is one specific
    // pair of tuples, and a broad alphabet dilutes it past any run count.
    //
    // Bound of this property: it catches a separator a peer can TYPE. It does not
    // catch removing the separator altogether — with the room JIDs and tier
    // markers used here, bare concatenation happens to admit no collision, and
    // manufacturing one needs adversarially shaped room JIDs. A printable
    // separator is the regression worth guarding; an empty one is not a change
    // anyone makes.
    const spliceable = fc.constantFrom('x', 'y', 'z', 'x:id:y', 'y:id:z')
    const pair = fc.record({ from: spliceable, id: spliceable })
    fc.assert(
      fc.property(fc.constantFrom(...ROOMS), pair, pair, (roomJid, a, b) => {
        const same = a.from === b.from && a.id === b.id
        expect(shareAKey({ roomJid, ...a }, { roomJid, ...b })).toBe(same)
      }),
      { numRuns: 5000 },
    )
  })

  it('is not fooled by field values that look like tier markers', () => {
    // The separator's job, and the reason it is U+0000 rather than a printable
    // character. Nicks and message ids are peer-controlled, so the pool splices a
    // tier marker INTO a field: with a printable separator, `from='x:id:y', id='z'`
    // and `from='x', id='y:id:z'` join to the same string, and one occupant's
    // message would dedupe against another's.
    //
    // U+0000 is deliberately absent: XML 1.0 forbids it in character data, so no
    // stanza can carry one, which is precisely the guarantee the join relies on.
    const nasty = fc.constantFrom(
      'from', 'id', 'stanzaId', 'originId', 'room', '', 'x', 'y', 'z',
      'x:id:y', 'y:id:z', 'x id y', 'a:stanzaId:b',
    )
    fc.assert(
      fc.property(
        fc.record({
          roomJid: fc.constantFrom(...ROOMS),
          from: nasty,
          id: nasty,
          stanzaId: fc.option(nasty, { nil: undefined }),
          originId: fc.option(nasty, { nil: undefined }),
        }),
        fc.record({
          roomJid: fc.constantFrom(...ROOMS),
          from: nasty,
          id: nasty,
          stanzaId: fc.option(nasty, { nil: undefined }),
          originId: fc.option(nasty, { nil: undefined }),
        }),
        (a, b) => {
          const sameRoom = a.roomJid === b.roomJid
          const sameFromId = a.from === b.from && a.id === b.id
          const sameStanza = Boolean(a.stanzaId) && a.stanzaId === b.stanzaId
          const sameOrigin = Boolean(a.originId) && a.originId === b.originId
          // They may share a key only when they genuinely share a tier value.
          const mayMatch = sameRoom && (sameFromId || sameStanza || sameOrigin)
          expect(shareAKey(a, b)).toBe(mayMatch)
        },
      ),
      { numRuns: 5000 },
    )
  })
})

describe('revocation aliases agree with the key set', () => {
  it('roomStanzaKey and roomOriginKey name exactly the tier they revoke', () => {
    // messageCache removes these aliases when an id is cleared. Naming anything
    // other than the tier roomIdentityKeys emitted would orphan an index entry,
    // or drop a key the message still needs.
    fc.assert(
      fc.property(fieldsArb, (m) => {
        const keys = roomIdentityKeys(m)
        if (m.stanzaId) {
          const alias = roomStanzaKey(m.roomJid, m.stanzaId)
          expect(keys.filter((k) => k === alias)).toHaveLength(1)
          expect(keys.filter((k) => k !== alias)).toHaveLength(keys.length - 1)
        }
        if (m.originId) {
          const alias = roomOriginKey(m.roomJid, m.originId)
          expect(keys.filter((k) => k === alias)).toHaveLength(1)
        }
      }),
      { numRuns: 3000 },
    )
  })

  it('leaves the lower tiers intact when the top one is revoked', () => {
    fc.assert(
      fc.property(logicalArb, (m) => {
        const full = project(m, 'reflection')
        const revoked: RoomIdentityFields = { ...full, stanzaId: undefined }
        const remaining = roomIdentityKeys(full).filter(
          (k) => k !== roomStanzaKey(m.roomJid, stanzaIdOf(m)),
        )
        expect(roomIdentityKeys(revoked)).toEqual(remaining)
        // And the message is still matchable by what it kept.
        expect(shareAKey(revoked, full)).toBe(true)
      }),
      { numRuns: 3000 },
    )
  })
})
