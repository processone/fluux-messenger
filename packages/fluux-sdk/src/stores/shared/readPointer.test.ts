import { describe, it, expect } from 'vitest'
import {
  makeReadPointer,
  isAhead,
  advance,
  serializeReadPointer,
  deserializeReadPointer,
} from './readPointer'
import type { ReadPointer } from './readPointer'

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
