import { describe, it, expect, vi } from 'vitest'
import { resolveRemoteDisplayed, createMdsSessionGate, foldPendingRemoteDisplayed } from './readMarkerSync'
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
  readPointer: undefined,
  pendingRemoteDisplayedStanzaId: undefined,
}

/** The read position naming `id`, carrying that message's own timestamp. */
function seenIn(id: string) {
  const found = messages.find((m) => m.id === id)!
  return { messageId: found.id, timestamp: found.timestamp }
}

describe('resolveRemoteDisplayed', () => {
  it('stashes the stanza-id as a pending high-water mark when the message is not loaded', () => {
    const result = resolveRemoteDisplayed(baseMeta, messages, undefined, 'arch-unknown', { isActive: false })

    expect(result.kind).toBe('stash-pending')
  })

  it('advances the read position forward-only for a non-active entity (no divider)', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m1') },
      messages,
      undefined,
      'arch-m2',
      { isActive: false }
    )

    // Whole-object assertion: the resolution carries one read position, and its
    // timestamp is the resolved message's own (#1081).
    expect(result).toEqual({
      kind: 'advanced',
      readPointer: { messageId: 'm2', timestamp: new Date('2024-01-15T10:02:00Z') },
    })
  })

  it('recomputes the divider for the ACTIVE entity from the advanced position', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m1') },
      messages,
      undefined,
      'arch-m2',
      { isActive: true }
    )

    // Advanced to m2 → the first unseen incoming message after it is m3.
    expect(result).toEqual({
      kind: 'advanced-with-divider',
      readPointer: { messageId: 'm2', timestamp: new Date('2024-01-15T10:02:00Z') },
      firstNewMessageId: 'm3',
    })
  })

  it('clears the divider when the advanced position reaches the newest message', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m1') },
      messages,
      'm2',
      'arch-m3',
      { isActive: true }
    )

    expect(result).toEqual({
      kind: 'advanced-with-divider',
      readPointer: { messageId: 'm3', timestamp: new Date('2024-01-15T10:03:00Z') },
      firstNewMessageId: undefined,
    })
  })

  it('reports unchanged when the local position is already at the marker and no pending is stale', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m3') },
      messages,
      undefined,
      'arch-m2',
      { isActive: false }
    )

    expect(result.kind).toBe('unchanged')
  })

  it('asks to clear a stale pending mark when resolved without an advance', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m3'), pendingRemoteDisplayedStanzaId: 'arch-m2' },
      messages,
      undefined,
      'arch-m2',
      { isActive: false }
    )

    expect(result.kind).toBe('clear-pending')
  })

  it('keeps the marker pending when an off-slice position ties the marker', () => {
    // The fresh-session forward catch-up merges only the newest MAM page: the
    // marker's message is in it, but the message the local pointer names is
    // still on disk. `onMessageSeen` refuses to advance against a pointer it
    // cannot locate, and a tied timestamp cannot break it either — MAM archives
    // routinely put two messages in the same millisecond. Nothing was resolved,
    // and reading that as "already read" would lose the remote position for
    // good, since the activation fold (which loads a wide enough slice) would
    // then have nothing left to apply.
    const offSlicePointer = {
      messageId: 'ties-m3',
      timestamp: new Date('2024-01-15T10:03:00Z'),
    }

    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: offSlicePointer, pendingRemoteDisplayedStanzaId: 'arch-m3' },
      messages,
      undefined,
      'arch-m3',
      { isActive: false }
    )

    expect(result.kind).toBe('stash-pending')
  })

  it('discards an off-slice marker the local position is provably past', () => {
    // Local pointer far ahead (m200) and an older remote marker (m20). A slice
    // holding m20 cannot hold m200, and a load-around m200 cannot reach back to
    // m20, so no retry will ever contain both — stashing here would leave the
    // marker pending forever, re-folding on every activation. The timestamps
    // decide it outright: the marker is behind, so there is nothing to apply.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { messageId: 'newer-than-slice', timestamp: new Date('2024-01-15T11:00:00Z') },
        pendingRemoteDisplayedStanzaId: 'arch-m3',
      },
      messages,
      undefined,
      'arch-m3',
      { isActive: false }
    )

    expect(result.kind).toBe('clear-pending')
  })

  it('keeps the marker pending when the off-slice position carries the epoch sentinel', () => {
    // Epoch is the legacy "no read time recorded" value: every real message
    // beats it, so it cannot decide the comparison and must not be trusted to.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { messageId: 'older-than-slice', timestamp: new Date(0) },
        pendingRemoteDisplayedStanzaId: 'arch-m3',
      },
      messages,
      undefined,
      'arch-m3',
      { isActive: false }
    )

    expect(result.kind).toBe('stash-pending')
  })

  it('advances an off-slice position when the marker is provably newer', () => {
    // Index ordering is undecidable here, but the pointer carries its own
    // timestamp: a strictly newer marker is unambiguously ahead. Resolving it
    // now clears the entity's badge at catch-up instead of making the user
    // open it first.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { messageId: 'older-than-slice', timestamp: new Date('2024-01-15T09:00:00Z') },
        pendingRemoteDisplayedStanzaId: 'arch-m3',
      },
      messages,
      undefined,
      'arch-m3',
      { isActive: false }
    )

    expect(result).toEqual({
      kind: 'advanced',
      readPointer: { messageId: 'm3', timestamp: new Date('2024-01-15T10:03:00Z') },
    })
  })

  it('stashes rather than reporting unchanged for an undecidable position with nothing pending', () => {
    // Same unresolvable case reached from a live notify (no pending mark yet):
    // it must still record the high-water mark so the activation fold retries.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { messageId: 'ties-m3', timestamp: new Date('2024-01-15T10:03:00Z') },
      },
      messages,
      undefined,
      'arch-m3',
      { isActive: false }
    )

    expect(result.kind).toBe('stash-pending')
  })

  it('recomputes the divider when an off-slice position advances in the ACTIVE entity', () => {
    // The timestamp-decided advance must feed the same divider recompute as the
    // index-decided one, so entering the entity does not show a stale marker.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { messageId: 'older-than-slice', timestamp: new Date('2024-01-15T09:00:00Z') },
        pendingRemoteDisplayedStanzaId: 'arch-m1',
      },
      messages,
      'm1',
      'arch-m1',
      { isActive: true }
    )

    expect(result).toEqual({
      kind: 'advanced-with-divider',
      readPointer: { messageId: 'm1', timestamp: new Date('2024-01-15T10:01:00Z') },
      firstNewMessageId: 'm2',
    })
  })
})

describe('createMdsSessionGate', () => {
  it('blocks a marker only after it was marked folded, and resets', () => {
    const gate = createMdsSessionGate()

    expect(gate.shouldFold('a@example.com', 's1')).toBe(true)
    // Not yet marked folded (e.g. the fold stashed): still retryable.
    expect(gate.shouldFold('a@example.com', 's1')).toBe(true)

    gate.markFolded('a@example.com', 's1')
    // Same marker re-presented after a RESOLVED fold: skip.
    expect(gate.shouldFold('a@example.com', 's1')).toBe(false)
    // Distinct id: independent.
    expect(gate.shouldFold('b@example.com', 's1')).toBe(true)

    gate.reset()
    expect(gate.shouldFold('a@example.com', 's1')).toBe(true)
  })

  it('re-arms when a newer marker arrives for an already-folded id', () => {
    const gate = createMdsSessionGate()

    gate.markFolded('a@example.com', 's1')
    // A different (newer) marker — synced from another device while this entity
    // was unloaded, so the live PEP notify could only stash it — must fold too.
    expect(gate.shouldFold('a@example.com', 's2')).toBe(true)
    gate.markFolded('a@example.com', 's2')
    // …but re-presenting that same newer marker is now a no-op.
    expect(gate.shouldFold('a@example.com', 's2')).toBe(false)
  })
})

describe('foldPendingRemoteDisplayed', () => {
  it('does nothing when no marker is pending', () => {
    const gate = createMdsSessionGate()
    const apply = vi.fn()
    const result = foldPendingRemoteDisplayed(gate, 'a@example.com', () => undefined, apply)
    expect(result).toEqual({ attempted: false, resolved: false })
    expect(apply).not.toHaveBeenCalled()
  })

  it('records a resolved fold on the gate so the same marker is not re-folded', () => {
    const gate = createMdsSessionGate()
    let pending: string | undefined = 's1'
    const apply = vi.fn(() => { pending = undefined }) // apply resolved the marker
    const first = foldPendingRemoteDisplayed(gate, 'a@example.com', () => pending, apply)
    expect(first).toEqual({ pending: 's1', attempted: true, resolved: true })

    // Same marker re-stashed later (e.g. our own publish echoed while unloaded):
    pending = 's1'
    const second = foldPendingRemoteDisplayed(gate, 'a@example.com', () => pending, apply)
    expect(second).toEqual({ pending: 's1', attempted: false, resolved: false })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('leaves a stashed (unresolved) fold retryable — the gate is NOT consumed', () => {
    const gate = createMdsSessionGate()
    let pending: string | undefined = 's1'
    const stashApply = vi.fn() // apply could not resolve: pending survives
    const first = foldPendingRemoteDisplayed(gate, 'a@example.com', () => pending, stashApply)
    expect(first).toEqual({ pending: 's1', attempted: true, resolved: false })

    // Retry (next activation / after a load-around): must attempt again…
    const resolveApply = vi.fn(() => { pending = undefined })
    const second = foldPendingRemoteDisplayed(gate, 'a@example.com', () => pending, resolveApply)
    expect(second).toEqual({ pending: 's1', attempted: true, resolved: true })
    // …and only now is the marker recorded as folded.
    expect(gate.shouldFold('a@example.com', 's1')).toBe(false)
  })
})
