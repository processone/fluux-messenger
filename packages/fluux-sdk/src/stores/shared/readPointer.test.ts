import { describe, it, expect } from 'vitest'
import {
  makeReadPointer,
  isAhead,
  advance,
  serializeReadPointer,
  deserializeReadPointer,
} from './readPointer'
import type { ReadPointer } from './readPointer'
import { isValidArchiveOrderKey } from './readState'

const at = (ms: number) => new Date(ms)

describe('makeReadPointer', () => {
  it('captures the id and timestamp of the message it names, plus its archive order key', () => {
    expect(makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')).toEqual({
      messageId: 'm1',
      timestamp: at(1000),
      archiveOrderKey: { kind: 'chat', id: 'm1' },
    })
  })

  it('round-trips a room pointer with its archiveOrderKey', () => {
    const p = makeReadPointer({ id: 'm1', from: 'r@c/alice', timestamp: at(1000) }, 'room')
    expect(p.archiveOrderKey).toEqual({ kind: 'room', from: 'r@c/alice', id: 'm1' })
    expect(deserializeReadPointer(serializeReadPointer(p))!.archiveOrderKey)
      .toEqual({ kind: 'room', from: 'r@c/alice', id: 'm1' })
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

  it('breaks a same-millisecond tie when BOTH pointers are keyed (chat: id order)', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const candidate = makeReadPointer({ id: 'm2', timestamp: at(1000) }, 'chat')
    expect(isAhead(candidate, current)).toBe(true)
  })

  it('is NOT ahead when both are keyed and the candidate sorts LOWER at the same ms', () => {
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

  // CONTROL for the polarity inversion. compareOrder sorts a MISSING key FIRST,
  // which is safe for a floor (under-advance -> over-count) and UNSAFE for a
  // pointer: it would let any keyed candidate overtake a migrated keyless
  // pointer at the same millisecond. A naive `compareOrder(candidate, current) > 0`
  // implementation passes every test above and fails these two.
  it('is NOT ahead at an equal ms when the CURRENT pointer is keyless (migrated)', () => {
    const current: ReadPointer = { messageId: 'legacy', timestamp: at(1000) }
    const candidate = makeReadPointer({ id: 'm2', timestamp: at(1000) }, 'chat')
    expect(isAhead(candidate, current)).toBe(false)
  })

  it('is NOT ahead at an equal ms when the CANDIDATE is keyless', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const candidate: ReadPointer = { messageId: 'legacy', timestamp: at(1000) }
    expect(isAhead(candidate, current)).toBe(false)
  })

  it('still compares by millisecond when a keyless pointer is genuinely older/newer', () => {
    const current: ReadPointer = { messageId: 'legacy', timestamp: at(1000) }
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
  it('round-trips through JSON', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const raw = JSON.parse(JSON.stringify(serializeReadPointer(p)))
    expect(deserializeReadPointer(raw)).toEqual(p)
  })

  // Two on-disk encodings of `timestamp` both need to keep loading: epoch ms
  // (serializeReadPointer's own output, used by room read-state storage) and
  // ISO strings (what a chat pointer riding inside `conversationMeta` becomes
  // after a plain `JSON.stringify` turns its `Date` into a string, #1081).
  // Deserializing the wrong encoding must never silently drop every existing
  // pointer.
  it('accepts an ISO string timestamp', () => {
    const iso = new Date(1000).toISOString()
    expect(deserializeReadPointer({ messageId: 'm1', timestamp: iso })).toEqual({
      messageId: 'm1',
      timestamp: at(1000),
    })
  })

  // Storage is untrusted input: a corrupt entry must yield "no pointer",
  // never a pointer with an Invalid Date that silently poisons comparisons.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nonsense'],
    ['a missing messageId', { timestamp: 1000 }],
    ['a missing timestamp', { messageId: 'm1' }],
    ['a non-numeric, non-string timestamp', { messageId: 'm1', timestamp: true }],
    ['a string timestamp that is not a valid date', { messageId: 'm1', timestamp: 'later' }],
  ])('returns undefined for %s', (_label, raw) => {
    expect(deserializeReadPointer(raw)).toBeUndefined()
  })

  // The persisted key is untrusted input too: a malformed one must not ride
  // through into ordering comparisons. Dropping only the key (not the whole
  // pointer) keeps the id/timestamp that are otherwise fine.
  it('drops a malformed persisted archiveOrderKey instead of trusting it', () => {
    const back = deserializeReadPointer({ messageId: 'm', timestamp: 1000, archiveOrderKey: { kind: 'room', id: 'x' } })
    expect(back!.archiveOrderKey).toBeUndefined() // missing `from` → invalid → dropped
    expect(back!.messageId).toBe('m') // the pointer itself survives
  })

  // A pointer migrated from the pre-#1081 legacy fields has no message
  // position to derive a key from — absence here is legitimate, not corrupt.
  it('a legacy pointer with no key deserializes with archiveOrderKey undefined', () => {
    expect(deserializeReadPointer({ messageId: 'm', timestamp: 1000 })!.archiveOrderKey).toBeUndefined()
  })
})

// The tie-break's `id` IS `messageId` — the same message named twice. Storing
// them independently made a disagreement representable on disk, and the
// ordering scan trusts the key as the at-or-behind boundary, so an inconsistent
// restored pointer could select a row that is actually AHEAD — the
// unrecoverable direction for a forward-only position. The on-disk form now
// omits the id entirely, which makes the disagreement unrepresentable rather
// than merely rejected.
describe('serialization: the tie-break id is not persisted', () => {
  it('omits `id` from a persisted chat key', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    expect(serializeReadPointer(p).archiveOrderKey).toEqual({ kind: 'chat' })
  })

  it('omits `id` from a persisted room key but keeps `from` (the room tie-break needs it)', () => {
    const p = makeReadPointer({ id: 'm1', from: 'room@x/nick', timestamp: at(1000) }, 'room')
    expect(serializeReadPointer(p).archiveOrderKey).toEqual({ kind: 'room', from: 'room@x/nick' })
  })

  it('no persisted pointer carries an id beside the messageId', () => {
    const chat = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const room = makeReadPointer({ id: 'm2', from: 'room@x/nick', timestamp: at(1000) }, 'room')
    for (const p of [chat, room]) {
      const onDisk = JSON.parse(JSON.stringify(serializeReadPointer(p)))
      expect(onDisk.archiveOrderKey).not.toHaveProperty('id')
    }
  })

  it('hydration reconstructs the key id from messageId, so the round trip is unchanged in memory', () => {
    const chat = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const room = makeReadPointer({ id: 'm2', from: 'room@x/nick', timestamp: at(1000) }, 'room')
    for (const p of [chat, room]) {
      expect(deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(p))))).toEqual(p)
    }
  })

  // Compatibility 1 — old data, new build. Any persisted `id` is ignored and
  // `messageId` is used instead. Lossless: they were always the same value.
  it('reads a legacy on-disk key that still carries its id (lossless)', () => {
    expect(
      deserializeReadPointer({ messageId: 'm1', timestamp: 1000, archiveOrderKey: { kind: 'chat', id: 'm1' } })
    ).toEqual({ messageId: 'm1', timestamp: at(1000), archiveOrderKey: { kind: 'chat', id: 'm1' } })

    expect(
      deserializeReadPointer({
        messageId: 'm2',
        timestamp: 1000,
        archiveOrderKey: { kind: 'room', from: 'room@x/nick', id: 'm2' },
      })
    ).toEqual({
      messageId: 'm2',
      timestamp: at(1000),
      archiveOrderKey: { kind: 'room', from: 'room@x/nick', id: 'm2' },
    })
  })

  it('accepts a legacy chat key with a non-string id because messageId is authoritative', () => {
    expect(
      deserializeReadPointer({ messageId: 'm1', timestamp: 1000, archiveOrderKey: { kind: 'chat', id: 42 } })
    ).toEqual({
      messageId: 'm1',
      timestamp: at(1000),
      archiveOrderKey: { kind: 'chat', id: 'm1' },
    })
  })

  // Compatibility 3 — inconsistent legacy data. This is the defect being
  // closed: a stored pointer whose persisted id disagreed with `messageId` now
  // resolves to `messageId`, so the boundary can no longer name a different
  // (possibly newer) row than the pointer does.
  it('resolves an inconsistent legacy key to messageId, not to the persisted id', () => {
    const back = deserializeReadPointer({
      messageId: 'm1',
      timestamp: 1000,
      archiveOrderKey: { kind: 'chat', id: 'm9-ahead' },
    })
    expect(back!.archiveOrderKey).toEqual({ kind: 'chat', id: 'm1' })

    const roomBack = deserializeReadPointer({
      messageId: 'm1',
      timestamp: 1000,
      archiveOrderKey: { kind: 'room', from: 'room@x/nick', id: 'm9-ahead' },
    })
    expect(roomBack!.archiveOrderKey).toEqual({ kind: 'room', from: 'room@x/nick', id: 'm1' })
  })

  // ...and the disagreement cannot be written back out either: what a
  // re-persist emits carries no id at all, so the inconsistency does not
  // survive a load/save cycle in any form.
  it('cannot write the disagreement back out', () => {
    const back = deserializeReadPointer({
      messageId: 'm1',
      timestamp: 1000,
      archiveOrderKey: { kind: 'chat', id: 'm9-ahead' },
    })!
    expect(JSON.stringify(serializeReadPointer(back))).not.toContain('m9-ahead')
  })

  // Compatibility 2 — new data, old build. An older build validates the
  // persisted key with `isValidArchiveOrderKey`, which requires
  // `typeof k.id === 'string'`. The id-less form fails that guard, so an old
  // build DROPS the key and degrades to the documented at-or-after-timestamp
  // fallback, which over-counts — the safe, recoverable direction. Asserted
  // here rather than assumed, because shipping a format an older build
  // mis-read in the unsafe direction would be unrecoverable.
  it('an old build drops the new id-less key rather than mis-reading it', () => {
    const chat = serializeReadPointer(makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat'))
    const room = serializeReadPointer(makeReadPointer({ id: 'm2', from: 'room@x/nick', timestamp: at(1000) }, 'room'))
    expect(isValidArchiveOrderKey(chat.archiveOrderKey)).toBe(false)
    expect(isValidArchiveOrderKey(room.archiveOrderKey)).toBe(false)
  })

  // The pointer itself must still load on an old build: only the key degrades.
  it('leaves messageId and timestamp readable in the old on-disk shape', () => {
    const onDisk = JSON.parse(
      JSON.stringify(serializeReadPointer(makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')))
    )
    expect(onDisk.messageId).toBe('m1')
    expect(onDisk.timestamp).toBe(1000)
  })

  // A key whose `kind` is unrecognisable, or a room key with no usable `from`,
  // still yields no key at all — storage stays untrusted input.
  it.each([
    ['an unknown kind', { kind: 'nope' }],
    ['a room key with no from', { kind: 'room' }],
    ['a room key with a non-string from', { kind: 'room', from: 7 }],
    ['a non-object key', 'chat'],
  ])('drops %s', (_label, archiveOrderKey) => {
    const back = deserializeReadPointer({ messageId: 'm', timestamp: 1000, archiveOrderKey })
    expect(back!.archiveOrderKey).toBeUndefined()
    expect(back!.messageId).toBe('m')
  })
})
