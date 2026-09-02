import { describe, it, expect } from 'vitest'
import { createPointerRegressionDetector, type PointerObservation } from './pointerRegression'
import { CTX, ID, TAG } from '../values'
import type { RecordInput } from '../recorder'
import type { ReadPointer, ReadStateGeneration } from '@fluux/sdk'

const TOKEN = TAG.focus

/** A pointer whose only comparable property is its timestamp. */
function pointer(ms: number, messageId = `m-${ms}`): ReadPointer {
  return {
    order: { role: 'floor', timestamp: ms },
    identity: { kind: 'local', messageId },
  } as unknown as ReadPointer
}

/** The ordering rule under test, stated here rather than imported. */
function isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean {
  if (!current) return true
  return candidate.order.timestamp > current.order.timestamp
}

const GEN: ReadStateGeneration = { store: 1, entity: 3 }

function observation(
  ptr: ReadPointer | undefined,
  generation: ReadStateGeneration = GEN,
  id = 'alice@example.com',
): PointerObservation {
  return { kind: 'chat', id, pointer: ptr, generation }
}

function setup() {
  const records: RecordInput[] = []
  const detector = createPointerRegressionDetector({
    record: (input) => records.push(input),
    token: () => TOKEN,
    isAhead,
  })
  return { detector, records }
}

describe('pointer-regression fires', () => {
  it('when a pointer is replaced by one strictly behind it', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(5_000)))
    detector.observe(observation(pointer(3_000)))

    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(ID.pointerRegression)
    expect(records[0].sev).toBe('bug')
    expect(records[0].ctx).toEqual(
      expect.arrayContaining([
        [CTX.conv, TOKEN],
        // How far back it went: a one-millisecond slip and a week of lost read
        // state are the same invariant break but not the same investigation.
        [CTX.behindMs, 2_000],
      ]),
    )
  })

  it('again on a second regression for the same entity', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(9_000)))
    detector.observe(observation(pointer(5_000)))
    detector.observe(observation(pointer(1_000)))

    // The state follows the pointer rather than latching: a detector that reported
    // once and went quiet would hide a cursor walking backwards.
    expect(records).toHaveLength(2)
  })

  it('for a room as well as a conversation', () => {
    const { detector, records } = setup()
    const room = { kind: 'room' as const, id: 'g@conf.example.com', generation: GEN }
    detector.observe({ ...room, pointer: pointer(5_000) })
    detector.observe({ ...room, pointer: pointer(4_000) })

    expect(records).toHaveLength(1)
    expect(records[0].ctx).toEqual(expect.arrayContaining([[CTX.room, TOKEN]]))
  })
})

describe('pointer-regression stays silent', () => {
  it('on an advance', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(1_000)))
    detector.observe(observation(pointer(2_000)))

    expect(records).toEqual([])
  })

  it('on an identical rewrite', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(1_000)))
    detector.observe(observation(pointer(1_000)))

    // Writing the same pointer twice is idempotence, not regression.
    expect(records).toEqual([])
  })

  it('on the first pointer an entity ever has', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(1_000)))

    expect(records).toEqual([])
  })

  it('when the store generation moved', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(9_000), { store: 1, entity: 3 }))
    // An account switch or a logout: every pointer is new, and the first
    // observation of a generation has no predecessor to be behind.
    detector.observe(observation(pointer(1_000), { store: 2, entity: 0 }))

    expect(records).toEqual([])
  })

  it('when the entity generation moved', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(9_000), { store: 1, entity: 3 }))
    // The conversation was deleted and re-created; its read state starts over.
    detector.observe(observation(pointer(1_000), { store: 1, entity: 4 }))

    expect(records).toEqual([])
  })

  it('on the first observation AFTER a generation change, then watches again', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(9_000), { store: 1, entity: 3 }))
    detector.observe(observation(pointer(5_000), { store: 1, entity: 4 }))
    detector.observe(observation(pointer(4_000), { store: 1, entity: 4 }))

    // Silent across the boundary, armed again inside the new generation.
    expect(records).toHaveLength(1)
  })

  it('when the pointer is cleared', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(5_000)))
    detector.observe(observation(undefined))

    // A cleared pointer is a different event with a different cause, and the
    // ordering rule has no answer for "behind nothing".
    expect(records).toEqual([])
  })

  it('for an entity whose pointer never moves', () => {
    const { detector, records } = setup()
    const other = 'bob@example.com'
    detector.observe(observation(pointer(5_000)))
    detector.observe(observation(pointer(1_000), GEN, other))
    detector.observe(observation(pointer(6_000)))

    // Two entities, two independent histories: `other`'s lower timestamp is not a
    // regression of `alice`'s pointer.
    expect(records).toEqual([])
  })

  it('after a reset', () => {
    const { detector, records } = setup()
    detector.observe(observation(pointer(5_000)))
    detector.reset()
    detector.observe(observation(pointer(1_000)))

    expect(records).toEqual([])
  })
})

describe('bounds', () => {
  it('tracks a bounded number of entities', () => {
    const records: RecordInput[] = []
    const detectorWithBound = createPointerRegressionDetector({
      record: (input) => records.push(input),
      token: () => TOKEN,
      isAhead,
      maxTracked: 2,
    })

    detectorWithBound.observe(observation(pointer(5_000), GEN, 'a@example.com'))
    detectorWithBound.observe(observation(pointer(5_000), GEN, 'b@example.com'))
    detectorWithBound.observe(observation(pointer(5_000), GEN, 'c@example.com'))
    // 'a' was evicted, so its regression cannot be seen — a bounded detector
    // misses rather than leaks.
    detectorWithBound.observe(observation(pointer(1_000), GEN, 'a@example.com'))
    detectorWithBound.observe(observation(pointer(1_000), GEN, 'c@example.com'))

    expect(records).toHaveLength(1)
  })
})
