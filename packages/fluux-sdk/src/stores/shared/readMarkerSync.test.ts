import { describe, it, expect } from 'vitest'
import { resolveRemoteDisplayed, createMdsSessionGate } from './readMarkerSync'
import type { NotificationMessage } from './notificationState'

/**
 * XEP-0490 remote-read-position resolution — the state machine that both
 * stores' applyRemoteDisplayed previously implemented as ~100-line twins.
 */

type TestMsg = NotificationMessage & { stanzaId?: string }

function msg(id: string, iso: string, extra: Partial<TestMsg> = {}): TestMsg {
  return { id, timestamp: new Date(iso), isOutgoing: false, stanzaId: `arch-${id}`, ...extra }
}

const messages: TestMsg[] = [
  msg('m1', '2024-01-15T10:01:00Z'),
  msg('m2', '2024-01-15T10:02:00Z'),
  msg('m3', '2024-01-15T10:03:00Z'),
]

const baseMeta = {
  unreadCount: 2,
  mentionsCount: 0,
  lastReadAt: undefined,
  lastSeenMessageId: undefined,
  pendingRemoteDisplayedStanzaId: undefined,
}

describe('resolveRemoteDisplayed', () => {
  it('stashes the stanza-id as a pending high-water mark when the message is not loaded', () => {
    const result = resolveRemoteDisplayed(baseMeta, messages, undefined, 'arch-unknown', { isActive: false })

    expect(result.kind).toBe('stash-pending')
  })

  it('advances the read position forward-only for a non-active entity (no divider)', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, lastSeenMessageId: 'm1' },
      messages,
      undefined,
      'arch-m2',
      { isActive: false }
    )

    expect(result).toEqual({ kind: 'advanced', lastSeenMessageId: 'm2' })
  })

  it('recomputes the divider for the ACTIVE entity from the advanced position', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, lastSeenMessageId: 'm1' },
      messages,
      undefined,
      'arch-m2',
      { isActive: true }
    )

    // Advanced to m2 → the first unseen incoming message after it is m3.
    expect(result).toEqual({
      kind: 'advanced-with-divider',
      lastSeenMessageId: 'm2',
      firstNewMessageId: 'm3',
    })
  })

  it('clears the divider when the advanced position reaches the newest message', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, lastSeenMessageId: 'm1' },
      messages,
      'm2',
      'arch-m3',
      { isActive: true }
    )

    expect(result).toEqual({
      kind: 'advanced-with-divider',
      lastSeenMessageId: 'm3',
      firstNewMessageId: undefined,
    })
  })

  it('reports unchanged when the local position is already at the marker and no pending is stale', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, lastSeenMessageId: 'm3' },
      messages,
      undefined,
      'arch-m2',
      { isActive: false }
    )

    expect(result.kind).toBe('unchanged')
  })

  it('asks to clear a stale pending mark when resolved without an advance', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, lastSeenMessageId: 'm3', pendingRemoteDisplayedStanzaId: 'arch-m2' },
      messages,
      undefined,
      'arch-m2',
      { isActive: false }
    )

    expect(result.kind).toBe('clear-pending')
  })
})

describe('createMdsSessionGate', () => {
  it('consumes each id once per session and resets', () => {
    const gate = createMdsSessionGate()

    expect(gate.consume('a@example.com')).toBe(true)
    expect(gate.consume('a@example.com')).toBe(false)
    expect(gate.consume('b@example.com')).toBe(true)

    gate.reset()
    expect(gate.consume('a@example.com')).toBe(true)
  })
})
