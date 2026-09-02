import type { MessageRowRef } from '../../utils/messageIdentity'
import { describe, it, expect, vi } from 'vitest'
import { resolveRemoteDisplayed, createMdsSessionGate, foldPendingRemoteDisplayed } from './readMarkerSync'
import type { NotificationMessage } from './notificationState'
import { makeReadPointer, type ReadPointer } from './readPointer'

/**
 * XEP-0490 remote-read-position resolution — the state machine that both
 * stores' applyRemoteDisplayed previously implemented as ~100-line twins.
 */

type TestMsg = NotificationMessage & { stanzaId?: string }

/**
 * `body` is non-empty so each fixture is an ordinary RENDERABLE message: the
 * divider now shares `countUnreadInArchive`'s eligibility predicate, which skips
 * rows with nothing to display (see `isRenderableStoredMessage`).
 */
function msg(id: string, iso: string, extra: Partial<TestMsg> = {}): TestMsg {
  return { id, timestamp: new Date(iso), isOutgoing: false, body: 'hi', stanzaId: `arch-${id}`, ...extra }
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

/**
 * The read position naming `id`, carrying that message's own timestamp as a
 * FLOOR — the pre-#1081 migrated shape, which is what these cases exercise (the
 * exact-order branch is covered by the `seenExactIn` cases below).
 */
function seenIn(id: string): ReadPointer {
  const found = messages.find((m) => m.id === id)!
  return { order: { role: 'floor', timestamp: found.timestamp.getTime() }, identity: { state: 'local', messageId: found.id } }
}

// Re-recording the stanza already stashed is `unchanged`, not `stash-pending`: the pending value
// does not move, and every resolution that is not `unchanged` makes the stores rebuild the entry.
describe('resolveRemoteDisplayed', () => {
  it('stashes the stanza-id as a pending high-water mark when the message is not loaded', () => {
    const result = resolveRemoteDisplayed(baseMeta, messages, undefined, 'arch-unknown', 'chat', { isActive: false })

    expect(result.kind).toBe('stash-pending')
  })

  it('advances the read position forward-only for a non-active entity (no divider)', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m1') },
      messages,
      undefined,
      'arch-m2',
      'chat',
      { isActive: false }
    )

    // Whole-object assertion: the resolution carries one read position, and its
    // timestamp is the resolved message's own (#1081). toMatchObject rather
    // than toEqual: the resolved pointer also carries a tiebreak,
    // which is not what this test is about.
    expect(result).toMatchObject({
      kind: 'advanced',
      readPointer: {
        order: { role: 'exact', timestamp: new Date('2024-01-15T10:02:00Z').getTime(), tiebreak: { kind: 'chat', id: 'm2' } },
        // ADDRESSABLE, and free: the row was found BY the archive id the marker
        // carried, so the minted pointer already holds its wire name — no
        // lookup, no residency, nothing for the publisher to resolve.
        identity: { state: 'addressable', messageId: 'm2', archiveId: 'arch-m2' },
      },
    })
  })

  it('reports an active advance without carrying divider placement', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m1') },
      messages,
      undefined,
      'arch-m2',
      'chat',
      { isActive: true }
    )

    expect(result).toEqual({
      kind: 'advanced-active',
      readPointer: {
        order: { role: 'exact', timestamp: new Date('2024-01-15T10:02:00Z').getTime(), tiebreak: { kind: 'chat', id: 'm2' } },
        identity: { state: 'addressable', messageId: 'm2', archiveId: 'arch-m2' },
      },
    })
  })

  it('does not return divider state when the active advance reaches the newest message', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m1') },
      messages,
      { id: 'm2' },
      'arch-m3',
      'chat',
      { isActive: true }
    )

    expect(result).toEqual({
      kind: 'advanced-active',
      readPointer: {
        order: { role: 'exact', timestamp: new Date('2024-01-15T10:03:00Z').getTime(), tiebreak: { kind: 'chat', id: 'm3' } },
        identity: { state: 'addressable', messageId: 'm3', archiveId: 'arch-m3' },
      },
    })
  })

  it('reports unchanged when the local position is already at the marker and no pending is stale', () => {
    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: seenIn('m3') },
      messages,
      undefined,
      'arch-m2',
      'chat',
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
      'chat',
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
    const offSlicePointer: ReadPointer = {
      order: { role: 'floor', timestamp: new Date('2024-01-15T10:03:00Z').getTime() },
      identity: { state: 'local', messageId: 'ties-m3' },
    }

    const result = resolveRemoteDisplayed(
      { ...baseMeta, readPointer: offSlicePointer, pendingRemoteDisplayedStanzaId: 'arch-m3' },
      messages,
      undefined,
      'arch-m3',
      'chat',
      { isActive: false }
    )

    expect(result.kind).toBe('unchanged')
  })

  it('keeps an older-timestamped off-slice marker pending (a migrated pointer may lead its message)', () => {
    // A pointer whose timestamp is LATER than the marker still proves nothing.
    // `migrateReadPointer` copies the pre-#1081 pair through unchanged, and that
    // `lastReadAt` meant "timestamp of the newest LOADED message when I last
    // activated" — so it can sit AHEAD of the message it names. This pointer may
    // really be at m2 while carrying m5's timestamp, in which case the marker at
    // m4 is a valid forward advance and retiring it would discard a genuine
    // cross-device read.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { order: { role: 'floor', timestamp: new Date('2024-01-15T11:00:00Z').getTime() }, identity: { state: 'local', messageId: 'may-lag-its-timestamp' } },
        pendingRemoteDisplayedStanzaId: 'arch-m3',
      },
      messages,
      undefined,
      'arch-m3',
      'chat',
      { isActive: false }
    )

    expect(result.kind).toBe('unchanged')
  })

  it('keeps the marker pending when the off-slice position carries the epoch sentinel', () => {
    // Epoch is the legacy "no read time recorded" value: every real message
    // beats it, so it cannot decide the comparison and must not be trusted to.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { order: { role: 'floor', timestamp: new Date(0).getTime() }, identity: { state: 'local', messageId: 'older-than-slice' } },
        pendingRemoteDisplayedStanzaId: 'arch-m3',
      },
      messages,
      undefined,
      'arch-m3',
      'chat',
      { isActive: false }
    )

    expect(result.kind).toBe('unchanged')
  })

  it('keeps a newer-timestamped off-slice marker pending', () => {
    // A migrated pointer can carry a timestamp from well before the message it
    // names, so a newer marker timestamp is not proof of a forward advance.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { order: { role: 'floor', timestamp: new Date('2024-01-15T09:00:00Z').getTime() }, identity: { state: 'local', messageId: 'may-name-a-newer-message' } },
        pendingRemoteDisplayedStanzaId: 'arch-m3',
      },
      messages,
      undefined,
      'arch-m3',
      'chat',
      { isActive: false }
    )

    expect(result.kind).toBe('unchanged')
  })

  it('stashes rather than reporting unchanged for an undecidable position with nothing pending', () => {
    // Same unresolvable case reached from a live notify (no pending mark yet):
    // it must still record the high-water mark so the activation fold retries.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { order: { role: 'floor', timestamp: new Date('2024-01-15T10:03:00Z').getTime() }, identity: { state: 'local', messageId: 'ties-m3' } },
      },
      messages,
      undefined,
      'arch-m3',
      'chat',
      { isActive: false }
    )

    expect(result.kind).toBe('stash-pending')
  })

  it('keeps an off-slice marker pending on the ACTIVE entity too', () => {
    // Being active changes nothing: the slice still cannot order the two ends,
    // so the marker survives here exactly as it does on an inactive entity.
    const result = resolveRemoteDisplayed(
      {
        ...baseMeta,
        readPointer: { order: { role: 'floor', timestamp: new Date('2024-01-15T11:00:00Z').getTime() }, identity: { state: 'local', messageId: 'may-lag-its-timestamp' } },
        pendingRemoteDisplayedStanzaId: 'arch-m3',
      },
      messages,
      { id: 'm2' },
      'arch-m3',
      'chat',
      { isActive: true }
    )

    expect(result.kind).toBe('unchanged')
  })

  it('survives an off-slice catch-up and resolves on the later activation fold', () => {
    const gate = createMdsSessionGate()
    const fullHistory = [
      msg('m1', '2024-01-15T10:01:00Z'),
      msg('m2', '2024-01-15T10:02:00Z'),
      msg('m3', '2024-01-15T10:03:00Z'),
      msg('m4', '2024-01-15T10:04:00Z'),
    ]
    const latestPage = fullHistory.slice(2)
    let readPointer: ReadPointer = {
      order: { role: 'floor', timestamp: new Date('2024-01-15T10:01:00Z').getTime() },
      identity: { state: 'local', messageId: 'm1' },
    }
    let pending: string | undefined = 'arch-m3'
    const firstNewMessageRow: MessageRowRef | undefined = { id: 'm2' }

    // Fresh-session forward catch-up only has the newest page. It contains the
    // remote marker (m3), but not the local pointer (m1), so the comparison is
    // deliberately postponed instead of destroying the pending marker.
    const catchUp = resolveRemoteDisplayed(
      {
        ...baseMeta,
        unreadCount: 26,
        readPointer,
        pendingRemoteDisplayedStanzaId: pending,
      },
      latestPage,
      firstNewMessageRow,
      pending,
      'chat',
      { isActive: false }
    )
    expect(catchUp).toEqual({ kind: 'unchanged' })
    expect(pending).toBe('arch-m3')

    // Opening the entity loads a wide enough slice to order both ends by
    // index. The normal activation fold can now advance to the remote position.
    const fold = foldPendingRemoteDisplayed(
      gate,
      'xsf@muc.xmpp.org',
      () => pending,
      (stanzaId) => {
        const activated = resolveRemoteDisplayed(
          {
            ...baseMeta,
            unreadCount: 0,
            readPointer,
            pendingRemoteDisplayedStanzaId: pending,
          },
          fullHistory,
          firstNewMessageRow,
          stanzaId,
          'chat',
          { isActive: true }
        )
        expect(activated.kind).toBe('advanced-active')
        if (activated.kind === 'advanced-active') {
          readPointer = activated.readPointer
          pending = undefined
        }
      }
    )

    expect(fold).toEqual({ pending: 'arch-m3', attempted: true, resolved: true })
    expect(readPointer.identity.messageId).toBe('m3')
    expect(firstNewMessageRow).toEqual({ id: 'm2' })
    expect(pending).toBeUndefined()
  })
})

describe('resolveRemoteDisplayed — position resolution (PR C, D3)', () => {
  const msg = (id: string, ms: number, stanzaId?: string) => ({
    id, timestamp: new Date(ms), isOutgoing: false, body: 'x', ...(stanzaId ? { stanzaId } : {}),
  })

  // Branch 1 — REGRESSION GUARD. This works today and must keep working.
  it('advances to the marker when there is no local pointer at all', () => {
    const r = resolveRemoteDisplayed(
      { unreadCount: 3, mentionsCount: 0, readPointer: undefined },
      [msg('m1', 1000), msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('advanced')
    expect(r.kind === 'advanced' && r.readPointer.identity.messageId).toBe('m2')
  })

  // Branch 2 — the widening. The local pointer's message is NOT in the slice.
  it('advances a KEYED pointer by position even when the pointer is absent from the slice', () => {
    const pointer = makeReadPointer({ id: 'old', timestamp: new Date(500) }, 'chat')
    const r = resolveRemoteDisplayed(
      { unreadCount: 3, mentionsCount: 0, readPointer: pointer },
      [msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('advanced')
    expect(r.kind === 'advanced' && r.readPointer.identity.messageId).toBe('m2')
  })

  it('does NOT advance a KEYED pointer when the marker is behind it', () => {
    const pointer = makeReadPointer({ id: 'new', timestamp: new Date(9000) }, 'chat')
    const r = resolveRemoteDisplayed(
      { unreadCount: 0, mentionsCount: 0, readPointer: pointer },
      [msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('unchanged')
  })

  it('clears a stale pending mark when a KEYED pointer is already past the marker', () => {
    const pointer = makeReadPointer({ id: 'new', timestamp: new Date(9000) }, 'chat')
    const r = resolveRemoteDisplayed(
      { unreadCount: 0, mentionsCount: 0, readPointer: pointer, pendingRemoteDisplayedStanzaId: 's2' },
      [msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('clear-pending')
  })

  // Branch 3 — CONTROL. A migrated keyless pointer's timestamp is `lastReadAt`,
  // which can sit on either side of the message it names, so its position is
  // NOT provable and must keep stashing.
  it('stashes a KEYLESS pointer that is absent from the slice', () => {
    const r = resolveRemoteDisplayed(
      { unreadCount: 3, mentionsCount: 0, readPointer: { order: { role: 'floor', timestamp: new Date(500).getTime() }, identity: { state: 'local', messageId: 'old' } } },
      [msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('stash-pending')
  })

  it('room: breaks a same-millisecond marker tie on (from, id)', () => {
    const pointer = makeReadPointer({ id: 'm9', from: 'r@c/alice', timestamp: new Date(1000) }, 'room')
    const match = { id: 'm1', from: 'r@c/bob', timestamp: new Date(1000), isOutgoing: false, body: 'x', stanzaId: 's1' }
    const r = resolveRemoteDisplayed(
      { unreadCount: 1, mentionsCount: 0, readPointer: pointer },
      [match], undefined, 's1', 'room', { isActive: false }
    )
    expect(r.kind).toBe('advanced')
  })

  // NEGATIVE POLARITY for the tie-break above, which on its own proves nothing:
  // a key-blind `>=` on timestamps alone also reports 'advanced' there. Here the
  // marker sorts BEFORE the pointer at the same millisecond ('alice' < 'bob'),
  // so only the (from, id) tie-break can refuse it — and refusing is what keeps
  // the position forward-only: `resolveAdvance` builds the advanced pointer
  // directly, never through `advance()`, and the stores commit it as-is.
  it('room: refuses a same-millisecond marker that sorts BEFORE the pointer', () => {
    const pointer = makeReadPointer({ id: 'm9', from: 'r@c/bob', timestamp: new Date(1000) }, 'room')
    const match = { id: 'm1', from: 'r@c/alice', timestamp: new Date(1000), isOutgoing: false, body: 'x', stanzaId: 's1' }
    const r = resolveRemoteDisplayed(
      { unreadCount: 1, mentionsCount: 0, readPointer: pointer },
      [match], undefined, 's1', 'room', { isActive: false }
    )
    expect(r.kind).toBe('unchanged')
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
