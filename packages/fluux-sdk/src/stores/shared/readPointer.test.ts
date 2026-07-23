import { describe, it, expect } from 'vitest'
import {
  makeReadPointer,
  isAhead,
  advance,
  readFloor,
  serializeReadPointer,
  deserializeReadPointer,
} from './readPointer'

const at = (ms: number) => new Date(ms)

describe('makeReadPointer', () => {
  it('captures the id and timestamp of the message it names', () => {
    expect(makeReadPointer({ id: 'm1', timestamp: at(1000) })).toEqual({
      messageId: 'm1',
      timestamp: at(1000),
    })
  })
})

describe('isAhead', () => {
  it('treats any candidate as ahead of no pointer', () => {
    expect(isAhead(makeReadPointer({ id: 'm1', timestamp: at(1000) }), undefined)).toBe(true)
  })

  it('is ahead when strictly newer', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(2000) }), current)).toBe(true)
  })

  it('is NOT ahead when older', () => {
    const current = makeReadPointer({ id: 'm2', timestamp: at(2000) })
    expect(isAhead(makeReadPointer({ id: 'm1', timestamp: at(1000) }), current)).toBe(false)
  })

  // Control: a `>=` implementation passes every test above and fails this one.
  // Equal timestamps must NOT advance — a same-instant sibling is not progress,
  // and treating it as one makes the MDS publisher re-assert forever.
  it('is NOT ahead when the timestamp is equal but the id differs', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(1000) }), current)).toBe(false)
  })
})

describe('advance', () => {
  it('takes the candidate when it is ahead', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    const next = makeReadPointer({ id: 'm2', timestamp: at(2000) })
    expect(advance(current, next)).toBe(next)
  })

  it('returns the SAME reference when the candidate is behind', () => {
    const current = makeReadPointer({ id: 'm2', timestamp: at(2000) })
    const older = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    // Reference equality matters: Zustand selectors use it to skip re-renders.
    expect(advance(current, older)).toBe(current)
  })

  it('adopts the candidate when there is no current pointer', () => {
    const next = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    expect(advance(undefined, next)).toBe(next)
  })
})

describe('readFloor', () => {
  it('is the pointer timestamp when there is no history floor', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    expect(readFloor(p, undefined)).toEqual(at(1000))
  })

  it('is the history floor when there is no pointer', () => {
    expect(readFloor(undefined, at(500))).toEqual(at(500))
  })

  it('is undefined when neither is set', () => {
    expect(readFloor(undefined, undefined)).toBeUndefined()
  })

  // Control: an implementation returning the EARLIER of the two passes the three
  // tests above and fails these. Taking the earlier value would count history the
  // user already read (or that predates the join) as unread.
  it('takes the LATER value when the pointer is ahead of the floor', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(2000) })
    expect(readFloor(p, at(500))).toEqual(at(2000))
  })

  it('takes the LATER value when the floor is ahead of the pointer', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(500) })
    expect(readFloor(p, at(2000))).toEqual(at(2000))
  })
})

describe('serialization', () => {
  it('round-trips through JSON', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) })
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
})
