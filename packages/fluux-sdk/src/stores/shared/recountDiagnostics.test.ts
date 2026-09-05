/**
 * The two rules the chat and room recounts share.
 *
 * Both used to be stated inline in each store, which is why they could differ
 * without anything failing. Tested here directly, without driving a store, so a
 * change to either rule fails at the rule rather than in one entity's suite.
 * `recountVerdict.test.ts` covers the same rules as the stores exercise them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { countOnlyClear, recountLedger } from './recountDiagnostics'
import { makeReadPointer } from './readPointer'
import { subscribeDiagnostics, type DiagnosticEvent } from '../../diagnostics/channel'
import type { EntityNotificationState } from './notificationState'
import type { ReadPointer } from '../../core/types/readState'

const at = (id: string, extra: { occupantId?: string } = {}): ReadPointer =>
  makeReadPointer(
    { id, from: 'room@conf.example.com/nick', timestamp: new Date(1_000), ...extra },
    'room'
  )

const state = (unreadCount: number, readPointer?: ReadPointer): EntityNotificationState => ({
  unreadCount,
  mentionsCount: 0,
  readPointer,
  firstNewMessageRow: undefined,
})

describe('countOnlyClear', () => {
  it('reports the cleared badge when the read position held', () => {
    const pointer = at('m1')
    expect(countOnlyClear(state(3, pointer), state(0, pointer))).toBe(3)
  })

  it('stays silent when the pointer advanced with the clear', () => {
    expect(countOnlyClear(state(3, at('m1')), state(0, at('m2')))).toBeUndefined()
  })

  it('stays silent when the badge was already zero', () => {
    const pointer = at('m1')
    expect(countOnlyClear(state(0, pointer), state(0, pointer))).toBeUndefined()
  })

  it('reports a pointerless entity whose badge cleared', () => {
    expect(countOnlyClear(state(2, undefined), state(0, undefined))).toBe(2)
  })

  it('stays silent when a pointerless entity gained a position', () => {
    expect(countOnlyClear(state(2, undefined), state(0, at('m1')))).toBeUndefined()
  })

  // Row identity, not the client message id: a reused MUC nick puts two rows under
  // one id, so comparing ids alone would call a real advance a count-only clear.
  it('treats two occupants sharing a message id as different rows', () => {
    const before = at('m1', { occupantId: 'occ-a' })
    const after = at('m1', { occupantId: 'occ-b' })
    expect(countOnlyClear(state(3, before), state(0, after))).toBeUndefined()
  })

  it('treats the same occupant re-derived as the same row', () => {
    const before = at('m1', { occupantId: 'occ-a' })
    const after = at('m1', { occupantId: 'occ-a' })
    expect(countOnlyClear(state(3, before), state(0, after))).toBe(3)
  })
})

describe('recountLedger', () => {
  let seen: DiagnosticEvent[]
  let unsubscribe: () => void

  beforeEach(() => {
    seen = []
    unsubscribe = subscribeDiagnostics((event) => seen.push(event), { kinds: ['unread-recount'] })
  })
  afterEach(() => unsubscribe())

  it('publishes nothing until asked', () => {
    const ledger = recountLedger('chat', 'alice@example.com', vi.fn())
    ledger.counted(4, 9)
    expect(seen).toEqual([])
  })

  it('publishes the last verdict once', () => {
    const ledger = recountLedger('chat', 'alice@example.com', vi.fn())
    ledger.defer('no-meta')
    ledger.counted(4, 9)
    ledger.publish()

    expect(seen).toEqual([
      {
        kind: 'unread-recount',
        entityKind: 'chat',
        entityId: 'alice@example.com',
        verdict: { status: 'counted', count: 4, previousCount: 9 },
      },
    ])
  })

  it('publishes nothing when the body reached no verdict', () => {
    recountLedger('room', 'team@conf.example.com', vi.fn()).publish()
    expect(seen).toEqual([])
  })

  it('names the entity kind it was built for', () => {
    const ledger = recountLedger('room', 'team@conf.example.com', vi.fn())
    ledger.defer('coverage-missing')
    ledger.publish()

    expect(seen).toEqual([
      {
        kind: 'unread-recount',
        entityKind: 'room',
        entityId: 'team@conf.example.com',
        verdict: { status: 'deferred', reason: 'coverage-missing' },
      },
    ])
  })

  it('queues the trailing retry only for an input change', () => {
    const scheduleRetry = vi.fn()
    const ledger = recountLedger('chat', 'alice@example.com', scheduleRetry)

    ledger.defer('coverage-missing')
    expect(scheduleRetry).not.toHaveBeenCalled()

    ledger.defer('input-version-changed')
    expect(scheduleRetry).toHaveBeenCalledTimes(1)
  })
})
