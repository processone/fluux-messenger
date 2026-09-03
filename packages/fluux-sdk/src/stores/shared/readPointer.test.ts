import { describe, it, expect } from 'vitest'
import {
  makeReadPointer,
  withArchiveId,
  isAhead,
  advance,
  serializeReadPointer,
  deserializeReadPointer,
} from './readPointer'
import type { ReadPointer } from './readPointer'
import { exactPosition, isAfterBoundary, type CacheOrderKey } from './readState'

const at = (ms: number) => new Date(ms)

/** An `exact` + `local` pointer, the shape every migrated keyed pointer enters as. */
const exactLocal = (messageId: string, timestamp: number, tiebreak: CacheOrderKey): ReadPointer => ({
  order: { role: 'exact', timestamp, tiebreak },
  identity: { state: 'local', messageId },
})

describe('makeReadPointer', () => {
  it('captures the order and the LOCAL name of a message with no archive id', () => {
    expect(makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')).toEqual({
      order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'chat', id: 'm1' } },
      identity: { state: 'local', messageId: 'm1' },
    })
  })

  it('captures the WIRE name too when the message carries an archive id', () => {
    expect(makeReadPointer({ id: 'm1', timestamp: at(1000), stanzaId: 'archive-1' }, 'chat')).toEqual({
      order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'chat', id: 'm1' } },
      identity: { state: 'addressable', messageId: 'm1', archiveId: 'archive-1' },
    })
  })

  it('round-trips a room pointer with its tiebreak', () => {
    const p = makeReadPointer({ id: 'm1', from: 'r@c/alice', timestamp: at(1000) }, 'room')
    expect(p.order).toEqual({ role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: 'r@c/alice', id: 'm1' } })
    expect(deserializeReadPointer(serializeReadPointer(p))!.order).toEqual(p.order)
  })

  it('binds the wire name to the message it NAMES, never to a neighbour', () => {
    // The constraint that keeps the anchor defect from reappearing at a new
    // site: the archive id comes from the same object the id and timestamp do.
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000), stanzaId: 'archive-1' }, 'chat')
    expect(p.identity).toEqual({ state: 'addressable', messageId: 'm1', archiveId: 'archive-1' })
  })
})

describe('withArchiveId — forward NAME convergence', () => {
  it('promotes a local pointer and leaves the order identical BY REFERENCE', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const enriched = withArchiveId(p, 'archive-1')
    expect(enriched.order).toBe(p.order)
    expect(enriched.identity).toEqual({ state: 'addressable', messageId: 'm1', archiveId: 'archive-1' })
  })

  it('cannot move the cursor: the enriched pointer is neither ahead nor behind', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const enriched = withArchiveId(p, 'archive-1')
    expect(isAhead(enriched, p)).toBe(false)
    expect(isAhead(p, enriched)).toBe(false)
    expect(advance(p, enriched)).toBe(p)
  })

  it('refuses a FLOOR pointer — its name and order already disagree', () => {
    const migrated: ReadPointer = {
      order: { role: 'floor', timestamp: 1000 },
      identity: { state: 'local', messageId: 'm4' },
    }
    expect(withArchiveId(migrated, 'archive-4')).toBe(migrated)
  })

  it('refuses an empty archive id rather than minting an unpublishable name', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    expect(withArchiveId(p, '')).toBe(p)
  })

  it('never re-names an already-addressable pointer', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000), stanzaId: 'archive-1' }, 'chat')
    expect(withArchiveId(p, 'archive-999')).toBe(p)
  })
})

describe('isAhead', () => {
  it('treats any candidate as ahead of no pointer', () => {
    expect(isAhead(makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat'), undefined)).toBe(true)
  })

  it('is ahead when strictly newer', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(2000) }, 'chat'), current)).toBe(true)
  })

  it('is NOT ahead when older', () => {
    const current = makeReadPointer({ id: 'm2', timestamp: at(2000) }, 'chat')
    expect(isAhead(makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat'), current)).toBe(false)
  })

  it('breaks a same-millisecond tie when BOTH orders are exact (chat: id order)', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const candidate = makeReadPointer({ id: 'm2', timestamp: at(1000) }, 'chat')
    expect(isAhead(candidate, current)).toBe(true)
  })

  it('is NOT ahead when both are exact and the candidate sorts LOWER at the same ms', () => {
    const current = makeReadPointer({ id: 'm2', timestamp: at(1000) }, 'chat')
    const candidate = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    expect(isAhead(candidate, current)).toBe(false)
  })

  it('breaks a room tie on (from, id), not id alone', () => {
    const current = makeReadPointer({ id: 'm9', from: 'r@c/alice', timestamp: at(1000) }, 'room')
    const candidate = makeReadPointer({ id: 'm1', from: 'r@c/bob', timestamp: at(1000) }, 'room')
    // 'bob' > 'alice' wins even though 'm1' < 'm9'.
    expect(isAhead(candidate, current)).toBe(true)
  })

  it('ignores identity entirely — a wire name is not a position', () => {
    const local = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const addressable = makeReadPointer({ id: 'm1', timestamp: at(1000), stanzaId: 'archive-1' }, 'chat')
    expect(isAhead(addressable, local)).toBe(false)
    expect(isAhead(local, addressable)).toBe(false)
  })

  // CONTROL for the polarity inversion (#1173). The COUNTING comparator,
  // `isAfterBoundary`, reads a FLOOR boundary as at-or-after its millisecond —
  // safe for counting (over-count) and UNSAFE for a pointer, where it would let
  // any exact candidate overtake a migrated floor pointer at the same
  // millisecond. Substituting it here passes every test above and fails these
  // two.
  //
  // That substitution no longer compiles — `isAfterBoundary` takes an
  // `ExactPosition` row, which a possibly-floor pointer order is not — so these
  // two are now a second line of defence rather than the only one. Keep both:
  // the type guard pins the SHAPE, these pin the BEHAVIOUR. See
  // `readState.enforcement.test.ts`.
  it('is NOT ahead at an equal ms when the CURRENT pointer is a floor (migrated)', () => {
    const current: ReadPointer = {
      order: { role: 'floor', timestamp: 1000 },
      identity: { state: 'local', messageId: 'legacy' },
    }
    const candidate = makeReadPointer({ id: 'm2', timestamp: at(1000) }, 'chat')
    expect(isAhead(candidate, current)).toBe(false)
  })

  it('is NOT ahead at an equal ms when the CANDIDATE is a floor', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const candidate: ReadPointer = {
      order: { role: 'floor', timestamp: 1000 },
      identity: { state: 'local', messageId: 'legacy' },
    }
    expect(isAhead(candidate, current)).toBe(false)
  })

  it('still compares by millisecond when a floor pointer is genuinely older/newer', () => {
    const current: ReadPointer = {
      order: { role: 'floor', timestamp: 1000 },
      identity: { state: 'local', messageId: 'legacy' },
    }
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(2000) }, 'chat'), current)).toBe(true)
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(500) }, 'chat'), current)).toBe(false)
  })
})

describe('advance', () => {
  it('takes the candidate when it is ahead', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const next = makeReadPointer({ id: 'm2', timestamp: at(2000) }, 'chat')
    expect(advance(current, next)).toBe(next)
  })

  it('returns the SAME reference when the candidate is behind', () => {
    const current = makeReadPointer({ id: 'm2', timestamp: at(2000) }, 'chat')
    const older = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    // Reference equality matters: Zustand selectors use it to skip re-renders.
    expect(advance(current, older)).toBe(current)
  })

  it('adopts the candidate when there is no current pointer', () => {
    const next = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    expect(advance(undefined, next)).toBe(next)
  })
})

describe('serialization', () => {
  it('round-trips a local pointer through JSON', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    expect(deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(p))))).toEqual(p)
  })

  it('round-trips an ADDRESSABLE pointer, wire name included', () => {
    const p = makeReadPointer({ id: 'm1', from: 'r@c/alice', timestamp: at(1000), stanzaId: 'archive-1' }, 'room')
    expect(deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(p))))).toEqual(p)
  })

  it('round-trips a FLOOR pointer, which has no tiebreak to write', () => {
    const p: ReadPointer = {
      order: { role: 'floor', timestamp: 1000 },
      identity: { state: 'local', messageId: 'legacy' },
    }
    expect(serializeReadPointer(p).order).toEqual({ role: 'floor', timestamp: 1000 })
    expect(deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(p))))).toEqual(p)
  })

  // The chat storage blob is a plain `JSON.stringify` of the LIVE object rather
  // than a call to `serializeReadPointer`, so the two writers must produce the
  // same readable shape. The only difference is the tie-break's redundant `id`,
  // which the blob keeps and hydration ignores.
  it('reads the chat blob (a plain JSON.stringify of the live pointer) identically', () => {
    const p = makeReadPointer({ id: 'm1', from: 'r@c/alice', timestamp: at(1000), stanzaId: 'archive-1' }, 'room')
    const viaBlob = deserializeReadPointer(JSON.parse(JSON.stringify(p)))
    const viaSerializer = deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(p))))
    expect(viaBlob).toEqual(p)
    expect(viaBlob).toEqual(viaSerializer)
  })

  it('omits the tie-break id from what it writes', () => {
    const chat = serializeReadPointer(makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat'))
    const room = serializeReadPointer(makeReadPointer({ id: 'm2', from: 'room@x/nick', timestamp: at(1000) }, 'room'))
    expect(chat.order).toEqual({ role: 'exact', timestamp: 1000, tiebreak: { kind: 'chat' } })
    expect(room.order).toEqual({ role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: 'room@x/nick' } })
    for (const s of [chat, room]) {
      expect(JSON.parse(JSON.stringify(s)).order.tiebreak).not.toHaveProperty('id')
    }
  })

  // Storage is untrusted input: a corrupt entry must yield "no pointer",
  // never a pointer with an Invalid Date that silently poisons comparisons.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nonsense'],
    ['an order with no identity', { order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'chat' } } }],
    ['an identity with no messageId', { order: { role: 'floor', timestamp: 1000 }, identity: { state: 'local' } }],
    ['an empty messageId', { order: { role: 'floor', timestamp: 1000 }, identity: { state: 'local', messageId: '' } }],
    ['an order with no timestamp', { order: { role: 'floor' }, identity: { state: 'local', messageId: 'm' } }],
    [
      'a non-numeric, non-string timestamp',
      { order: { role: 'floor', timestamp: true }, identity: { state: 'local', messageId: 'm' } },
    ],
    [
      'a string timestamp that is not a date',
      { order: { role: 'floor', timestamp: 'later' }, identity: { state: 'local', messageId: 'm' } },
    ],
    ['a non-object order', { order: 'floor', identity: { state: 'local', messageId: 'm' } }],
  ])('returns undefined for %s', (_label, raw) => {
    expect(deserializeReadPointer(raw)).toBeUndefined()
  })

  // The persisted order is untrusted too: an `exact` claim whose tie-break comes
  // back unusable degrades to a FLOOR rather than being trusted or dropped. Same
  // instinct as before the identity variant — over-count, the safe direction —
  // now expressed as a role rather than as a missing field.
  it('degrades exact -> floor when the persisted tiebreak is unusable', () => {
    const back = deserializeReadPointer({
      order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', id: 'x' } }, // no `from`
      identity: { state: 'local', messageId: 'm' },
    })!
    expect(back.order).toEqual({ role: 'floor', timestamp: 1000 })
    expect(back.identity.messageId).toBe('m') // the pointer itself survives
  })

  it.each([
    ['an unknown kind', { kind: 'nope' }],
    ['a room key with no from', { kind: 'room' }],
    ['a room key with a non-string from', { kind: 'room', from: 7 }],
    ['a non-object key', 'chat'],
    ['no key at all', undefined],
  ])('degrades exact -> floor for %s', (_label, tiebreak) => {
    const back = deserializeReadPointer({
      order: { role: 'exact', timestamp: 1000, tiebreak },
      identity: { state: 'local', messageId: 'm' },
    })!
    expect(back.order.role).toBe('floor')
    expect(back.identity.messageId).toBe('m')
  })

  // An `addressable` claim with no usable archive id hydrates as `local`.
  // Degraded is the state that always has a defined meaning; a pointer whose
  // wire name is `undefined` at the publisher is not a state at all.
  it.each([
    ['a missing archiveId', undefined],
    ['an empty archiveId', ''],
    ['a non-string archiveId', 42],
  ])('hydrates an addressable claim with %s as local', (_label, archiveId) => {
    const back = deserializeReadPointer({
      order: { role: 'floor', timestamp: 1000 },
      identity: { state: 'addressable', messageId: 'm', archiveId },
    })!
    expect(back.identity).toEqual({ state: 'local', messageId: 'm' })
  })

  it('ignores an archiveId riding on a `local` identity', () => {
    const back = deserializeReadPointer({
      order: { role: 'floor', timestamp: 1000 },
      identity: { state: 'local', messageId: 'm', archiveId: 'archive-1' },
    })!
    expect(back.identity).toEqual({ state: 'local', messageId: 'm' })
  })
})

/**
 * THE MIGRATION (§5.4 of the design). Three populations, and the invariant that
 * governs all of them: **no stored position moves**. Not the timestamp, not the
 * tie-break, not the name. A read pointer is forward-only, so a position moved
 * forward here is unrecoverable and a position moved backward re-notifies the
 * user about messages they read.
 *
 * The fixtures below are the ACTUAL on-disk shapes shipped builds wrote, each
 * traced to the commit that produced it — not shapes invented to match the
 * reader. Verify one against its commit before changing it.
 */
describe('migration from the pre-identity on-disk shapes', () => {
  /** Epoch ms of a real persisted pointer, kept as a literal so drift is visible. */
  const T = 1785400698528

  // ── POPULATION 1: keyed pointers (the bulk) ───────────────────────────────
  // Shape change only. `exact` order preserved, tie-break id reconstructed from
  // `messageId` exactly as the previous reader already did, and identity `local`
  // because NO archive id was ever stored in any of these formats.
  const KEYED_FIXTURES: Array<[string, unknown]> = [
    // `ef2faa19` (#1208) — the currently shipped room-read-state / snapshot form.
    ['#1208 room read state: `tiebreak`, id dropped', { messageId: 'm4', timestamp: T, tiebreak: { kind: 'chat' } }],
    // `7780a8b1` (#1196) — id dropped, still under the historical name.
    [
      '#1196 room read state: `archiveOrderKey`, id dropped',
      { messageId: 'm4', timestamp: T, archiveOrderKey: { kind: 'chat' } },
    ],
    // Pre-#1196 — the key carried its own copy of the id. Ignored, not read.
    [
      'pre-#1196: the key still carries its redundant id',
      { messageId: 'm4', timestamp: T, archiveOrderKey: { kind: 'chat', id: 'm4' } },
    ],
    // The chat blob at every one of those builds: a plain `JSON.stringify` of the
    // live object, so `timestamp` is an ISO string and the key keeps its id.
    [
      'chat blob: ISO timestamp, key keeps its id',
      { messageId: 'm4', timestamp: new Date(T).toISOString(), tiebreak: { kind: 'chat', id: 'm4' } },
    ],
  ]

  it.each(KEYED_FIXTURES)('migrates %s without moving the position', (_label, raw) => {
    expect(deserializeReadPointer(raw)).toEqual(
      exactLocal('m4', T, { kind: 'chat', id: 'm4' })
    )
  })

  it('migrates a keyed ROOM pointer, keeping the `from` it cannot reconstruct', () => {
    expect(
      deserializeReadPointer({ messageId: 'm4', timestamp: T, tiebreak: { kind: 'room', from: 'room@x/nick' } })
    ).toEqual(exactLocal('m4', T, { kind: 'room', from: 'room@x/nick', id: 'm4' }))
  })

  it('enters `local`, never `addressable`: no archive id was ever stored', () => {
    for (const [, raw] of KEYED_FIXTURES) {
      expect(deserializeReadPointer(raw)!.identity.state).toBe('local')
    }
  })

  // The anchor defect (#1196), still closed by the new reader: a stored key
  // whose id disagreed with `messageId` resolves to `messageId`, so the boundary
  // cannot name a different — possibly NEWER — row than the pointer does.
  it('resolves an inconsistent legacy key to messageId, not to the persisted id', () => {
    expect(
      deserializeReadPointer({
        messageId: 'm4',
        timestamp: T,
        archiveOrderKey: { kind: 'chat', id: 'm9-ahead' },
      })!.order
    ).toEqual({ role: 'exact', timestamp: T, tiebreak: { kind: 'chat', id: 'm4' } })
  })

  it('cannot write the disagreement back out', () => {
    const back = deserializeReadPointer({
      messageId: 'm4',
      timestamp: T,
      archiveOrderKey: { kind: 'chat', id: 'm9-ahead' },
    })!
    expect(JSON.stringify(serializeReadPointer(back))).not.toContain('m9-ahead')
  })

  it('prefers `tiebreak` when a blob somehow carries both names', () => {
    expect(
      deserializeReadPointer({
        messageId: 'm4',
        timestamp: T,
        tiebreak: { kind: 'chat' },
        archiveOrderKey: { kind: 'room', from: 'stale@x/nick' },
      })!.order
    ).toEqual({ role: 'exact', timestamp: T, tiebreak: { kind: 'chat', id: 'm4' } })
  })

  // ── POPULATION 2: keyless legacy pointers ─────────────────────────────────
  // `baa1601b` (#1081) wrote `{ messageId, timestamp }` and nothing else, and
  // the #1081 migration still mints that pair from `lastSeenMessageId` +
  // `lastReadAt`. Its timestamp is `lastReadAt`, which sits at or BEHIND the
  // message it names — so the position is genuinely a FLOOR and the type now
  // says so.
  it('migrates the #1081 keyless pointer to a FLOOR without moving it', () => {
    expect(deserializeReadPointer({ messageId: 'm4', timestamp: T })).toEqual({
      order: { role: 'floor', timestamp: T },
      identity: { state: 'local', messageId: 'm4' },
    })
  })

  it('migrates the keyless chat-blob variant (ISO timestamp) identically', () => {
    expect(deserializeReadPointer({ messageId: 'm4', timestamp: new Date(T).toISOString() })).toEqual({
      order: { role: 'floor', timestamp: T },
      identity: { state: 'local', messageId: 'm4' },
    })
  })

  // Why they can NEVER converge, asserted rather than left as prose: resolving
  // the named message's real timestamp is what convergence would need, and that
  // could move the floor FORWARD on a forward-only pointer. `withArchiveId`
  // refuses them outright, so no future enrichment path can do it by accident.
  it('a migrated FLOOR pointer can never acquire a wire name', () => {
    const migrated = deserializeReadPointer({ messageId: 'm4', timestamp: T })!
    expect(withArchiveId(migrated, 'archive-4')).toBe(migrated)
    expect(migrated.identity.state).toBe('local')
  })

  // ...and how they self-heal instead: any fresh exact pointer at a later
  // millisecond is ahead, so the first genuine read in that entity replaces it.
  it('a migrated FLOOR pointer self-heals on the next genuine read', () => {
    const migrated = deserializeReadPointer({ messageId: 'm4', timestamp: T })!
    const fresh = makeReadPointer({ id: 'm5', timestamp: at(T + 1), stanzaId: 'archive-5' }, 'chat')
    expect(advance(migrated, fresh)).toBe(fresh)
  })

  // ── POPULATION 3: pointerless entities ────────────────────────────────────
  it('leaves a pointerless entity pointerless', () => {
    expect(deserializeReadPointer(undefined)).toBeUndefined()
    expect(deserializeReadPointer(null)).toBeUndefined()
  })

  // ── THE INVARIANT, stated once over every population ──────────────────────
  it('moves NO stored position, for any fixture', () => {
    const all: unknown[] = [
      ...KEYED_FIXTURES.map(([, raw]) => raw),
      { messageId: 'm4', timestamp: T },
      { messageId: 'm4', timestamp: T, tiebreak: { kind: 'room', from: 'room@x/nick' } },
      { messageId: 'm4', timestamp: T, archiveOrderKey: { kind: 'chat', id: 'm9-ahead' } },
    ]
    for (const raw of all) {
      const back = deserializeReadPointer(raw)!
      expect(back.order.timestamp).toBe(T)
      expect(back.identity.messageId).toBe('m4')
      // And the tie-break, when there is one, still names the pointer's own
      // message — never the persisted id, never a neighbour.
      if (back.order.role === 'exact') expect(back.order.tiebreak.id).toBe('m4')
    }
  })
})

/**
 * OLD BUILD, NEW DATA. This is the direction that matters: a format an older
 * build mis-read in the UNSAFE direction (an over-advanced forward-only
 * pointer) would be unrecoverable, so the degrade is asserted against a replica
 * of that build's reader rather than assumed.
 *
 * The degrade is LARGER than the previous step's: every build before this one
 * looks for a TOP-LEVEL `messageId` and `timestamp`, finds neither under
 * `order` / `identity`, and reads NO POINTER at all — where the previous format
 * still gave it a name and a timestamp and cost only the tie-break. That is the
 * deliberate price of keeping exactly ONE copy of the name on disk: writing the
 * flat fields alongside the nested ones would re-create the two-names-that-can-
 * disagree shape this series exists to remove.
 */
describe('an old build reading the identity-variant on-disk form', () => {
  /** How `deserializeReadPointer` read a blob at `ef2faa19` (#1208). */
  const oldBuildRead = (raw: Record<string, unknown>): { messageId: string; timestamp: Date } | undefined => {
    const { messageId, timestamp } = raw as { messageId?: unknown; timestamp?: unknown }
    if (typeof messageId !== 'string' || messageId.length === 0) return undefined
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return { messageId, timestamp: new Date(timestamp) }
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp)
      return Number.isNaN(parsed.getTime()) ? undefined : { messageId, timestamp: parsed }
    }
    return undefined
  }

  const onDisk = (p: ReadPointer) => JSON.parse(JSON.stringify(serializeReadPointer(p)))

  it('reads NO pointer at all, rather than a wrong one', () => {
    for (const p of [
      makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat'),
      makeReadPointer({ id: 'm2', from: 'room@x/nick', timestamp: at(2000), stanzaId: 'archive-2' }, 'room'),
    ]) {
      expect(oldBuildRead(onDisk(p))).toBeUndefined()
    }
  })

  // The consequence, stated as behaviour rather than as a missing property. With
  // no pointer at all, an old build derives its floor from the entity's
  // `historyFloor` instead, which counts MORE messages as unread — the
  // recoverable direction, cleared by reading. Nothing it can do publishes an
  // over-advanced XEP-0490 position, because it has no position to publish.
  it('degrades toward over-counting, never toward over-advancing', () => {
    const stored = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    expect(oldBuildRead(onDisk(stored))).toBeUndefined()

    // What "no pointer" means for the counting question: with no boundary, every
    // row from the history floor counts. Modelled here with the weakest boundary
    // that build could construct — a bare millisecond at the floor.
    expect(isAfterBoundary({ role: 'exact', timestamp: 1000, tiebreak: { kind: 'chat', id: 'm1' } }, { role: 'floor', timestamp: 1000 })).toBe(true)
  })

  // And the reverse direction stays lossless, which is what actually protects an
  // upgrading user: a new build reads every shape an old build ever wrote.
  it('is one-way: the NEW build still reads everything the old one wrote', () => {
    for (const raw of [
      { messageId: 'm4', timestamp: 1785400698528, tiebreak: { kind: 'chat' } },
      { messageId: 'm4', timestamp: 1785400698528, archiveOrderKey: { kind: 'chat', id: 'm4' } },
      { messageId: 'm4', timestamp: 1785400698528 },
    ]) {
      expect(deserializeReadPointer(raw)).toBeDefined()
    }
  })
})

/**
 * The occupant rung crosses storage on the IDENTITY, never in the stored key.
 * Both halves are pinned here: what a current pointer gets back, and what a
 * pointer written before the field existed does when it meets a row that has
 * one — the path every existing room takes on first read.
 */
describe('the occupant rung across storage', () => {
  const roomMsg = { id: 'm1', from: 'r@c/nick', timestamp: at(1000) }

  /** A room pointer as it was written before the pointer carried an occupant-id. */
  const legacyOnDisk = {
    order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: 'r@c/nick' } },
    identity: { state: 'local', messageId: 'm1' },
  }

  it('rebuilds the tie-break occupant from the identity', () => {
    const p = makeReadPointer({ ...roomMsg, occupantId: 'occ-a' }, 'room')
    const back = deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(p))))!
    expect(back).toEqual(p)
    expect(back.order.role === 'exact' && back.order.tiebreak).toEqual({
      kind: 'room',
      from: 'r@c/nick',
      id: 'm1',
      occupantId: 'occ-a',
    })
  })

  it('writes no occupant into the stored key, leaving the on-disk shape unchanged', () => {
    const written = serializeReadPointer(makeReadPointer({ ...roomMsg, occupantId: 'occ-a' }, 'room'))
    expect(written.order).toEqual({
      role: 'exact',
      timestamp: 1000,
      tiebreak: { kind: 'room', from: 'r@c/nick' },
    })
    expect(JSON.parse(JSON.stringify(written)).order.tiebreak).not.toHaveProperty('occupantId')
  })

  it('hydrates a pointer written before the field existed without one', () => {
    const back = deserializeReadPointer(legacyOnDisk)!
    expect(back.order.role === 'exact' && back.order.tiebreak).toEqual({
      kind: 'room',
      from: 'r@c/nick',
      id: 'm1',
    })
  })

  it('OVER-COUNTS the other occupant under such a pointer rather than swallowing it', () => {
    const legacy = deserializeReadPointer(legacyOnDisk)!
    const otherOccupant = exactPosition({ ...roomMsg, occupantId: 'occ-b' }, 'room')
    expect(isAfterBoundary(otherOccupant, legacy.order)).toBe(true)
  })
})
