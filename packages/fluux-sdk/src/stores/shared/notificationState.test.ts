import { describe, it, expect } from 'vitest'
import * as notifState from './notificationState'
import {
  onMessageReceived,
  onActivate,
  onDeactivate,
  onMarkAsRead,
  onClearMarker,
  onWindowBecameVisible,
  onMessageSeen,
  shouldNotifyConversation,
  shouldNotifyRoom,
  computeBadgeCount,
  createInitialNotificationState,
  type EntityNotificationState,
  type NotificationMessage,
  type EntityContext,
} from './notificationState'
import { makeReadPointer, type ReadPointer } from './readPointer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default timestamp is "now" so freshness checks pass in shouldNotify tests.
 * Default `body` is non-empty so every test using this helper represents an
 * ordinary renderable message unless it deliberately overrides `body` (or
 * another renderability field) to exercise the guard itself.
 */
function makeMsg(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: 'msg-1',
    timestamp: new Date(),
    isOutgoing: false,
    isDelayed: false,
    body: 'hello',
    ...overrides,
  }
}

function makeState(overrides: Partial<EntityNotificationState> = {}): EntityNotificationState {
  return {
    ...createInitialNotificationState(),
    ...overrides,
  }
}

/**
 * A read position (#1081). Both halves are given together because that is the
 * only way to express one: `messageId` alone is not a read position, and the
 * timestamp has to be that message's own.
 */
function seen(id: string, timestamp: Date): ReadPointer {
  // A FLOOR order: the shape this helper replaces carried a timestamp and no
  // tie-break, so the position is known only to a millisecond. `local`, because
  // no archive id was ever part of it.
  return { order: { role: 'floor', timestamp: timestamp.getTime() }, identity: { state: 'local', messageId: id } }
}

/**
 * The read position naming `id`, taking that message's own timestamp from `msgs`.
 *
 * KEYED, via `makeReadPointer` — exactly how production builds a pointer for a
 * message it holds. The key is what says "this timestamp is that message's own",
 * and without it the message the pointer NAMES sorts after the floor (a missing
 * boundary means at-or-after its millisecond, see `isAfterBoundary`) and
 * would itself become the divider.
 * `seen()` above is the keyless population — a pointer migrated from the
 * pre-#1081 `lastSeenMessageId` + `lastReadAt` pair, which genuinely cannot
 * certify its own position.
 */
function seenIn(msgs: NotificationMessage[], id: string): ReadPointer {
  const found = msgs.find((m) => m.id === id)
  if (!found) throw new Error(`seenIn: no message ${id} in the slice`)
  return makeReadPointer(found, 'chat')
}

/**
 * The epoch timestamp a pointer carries when the pre-#1081 migration had only a
 * `lastSeenMessageId` and no read time to pair with it.
 *
 * No longer a SENTINEL: nothing special-cases `getTime() === 0` any more — the
 * stale-pointer fallback ladder that read it as "no usable read time" and fell
 * through to `unreadCount` is gone. It is now an ORDINARY boundary that happens
 * to sit at time zero, so the whole slice sorts after it and every renderable
 * incoming message counts as new: over-counting, the recoverable direction.
 */
const NO_READ_TIME = new Date(0)

// `viewportAtLiveEdge: true` on ACTIVE_VISIBLE: every existing usage
// below represents the user genuinely watching the live edge (either directly
// testing the "sees it" branch, or an outgoing-message context where the
// viewport precondition doesn't matter since `isOutgoing` short-circuits
// before it's consulted) — never the new "active + focused but scrolled up"
// case, which has its own fixture below.
const ACTIVE_VISIBLE: EntityContext = { isActive: true, windowVisible: true, unreadCount: 1, viewportAtLiveEdge: true }
const ACTIVE_HIDDEN: EntityContext = { isActive: true, windowVisible: false, unreadCount: 1 }
const INACTIVE_VISIBLE: EntityContext = { isActive: false, windowVisible: true, unreadCount: 1 }
const INACTIVE_HIDDEN: EntityContext = { isActive: false, windowVisible: false, unreadCount: 1 }
// Active + focused, but the viewport is scrolled up (not at the live edge) —
// the negative control: `onMessageReceived` must NOT advance the
// pointer here, unlike the pre-Task-11 code (which treated ACTIVE_VISIBLE's
// isActive+windowVisible alone as "seen").
const ACTIVE_VISIBLE_SCROLLED_UP: EntityContext = { isActive: true, windowVisible: true, unreadCount: 1, viewportAtLiveEdge: false }
// Same isActive/windowVisible as ACTIVE_VISIBLE_SCROLLED_UP, but the viewport
// evidence is simply absent (never reported / stale / unknown generation) —
// must be treated exactly as conservatively as an explicit `false`.
const ACTIVE_VISIBLE_UNKNOWN_VIEWPORT: EntityContext = { isActive: true, windowVisible: true, unreadCount: 1 }

// ---------------------------------------------------------------------------
// onMessageReceived
// ---------------------------------------------------------------------------

describe('onMessageReceived', () => {
  describe('outgoing messages', () => {
    it('clears unread, mentions, and marker', () => {
      const state = makeState({ unreadCount: 3, mentionsCount: 1, firstNewMessageId: 'old-marker' })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE, 'chat')
      expect(result.unreadCount).toBe(0)
      expect(result.mentionsCount).toBe(0)
      expect(result.firstNewMessageId).toBeUndefined()
      expect(result.readPointer).toMatchObject({ order: { timestamp: msg.timestamp.getTime() }, identity: { messageId: msg.id } })
    })

    // The outgoing early return that used to clear
    // state unconditionally is gone. A backgrounded outgoing message (a carbon
    // from another device, or a nick-misattributed MUC reflection) is exactly
    // the vector #1081 exists to close — it must NOT clear the unread count.
    // It still clears the divider unconditionally on the branches this reaches
    // (see the doc comment on `onMessageReceived`), so that half of the old
    // assertion survives.
    it('preserves unread count (but still clears the divider) for a backgrounded outgoing message', () => {
      const state = makeState({ unreadCount: 5, firstNewMessageId: 'old-marker' })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, 'chat')
      expect(result.unreadCount).toBe(5)
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('advances the read pointer to the outgoing message', () => {
      const state = makeState({ readPointer: seen('seen-1', new Date(1000)) })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE, 'chat')
      expect(result.readPointer).toMatchObject({ order: { timestamp: msg.timestamp.getTime() }, identity: { messageId: msg.id } })
    })

    it('does not regress the read pointer for an older outgoing message', () => {
      const current = seen('newer-msg', new Date('2025-01-15T10:05:00Z'))
      const state = makeState({ unreadCount: 4, readPointer: current })
      const msg = makeMsg({
        id: 'older-outgoing',
        isOutgoing: true,
        timestamp: new Date('2025-01-15T10:00:00Z'),
      })

      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE, 'chat')

      expect(result.readPointer).toBe(current)
      expect(result.unreadCount).toBe(0)
    })
  })

  describe('delayed/historical messages', () => {
    it('returns state unchanged', () => {
      const state = makeState({ unreadCount: 2 })
      const msg = makeMsg({ isDelayed: true })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, 'chat')
      expect(result).toBe(state) // same reference
    })
  })

  describe('incoming message — user sees it', () => {
    it('keeps unread at 0 and advances the read pointer to the message', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE, 'chat')
      expect(result.unreadCount).toBe(0)
      expect(result.mentionsCount).toBe(0)
      expect(result.readPointer).toMatchObject({ order: { timestamp: msg.timestamp.getTime() }, identity: { messageId: msg.id } })
    })

    it('advances the read pointer to the new message', () => {
      const state = makeState({ readPointer: seen('old-msg', new Date(1000)) })
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE, 'chat')
      expect(result.readPointer).toMatchObject({ order: { timestamp: msg.timestamp.getTime() }, identity: { messageId: 'new-msg' } })
    })

    it('does not regress the read pointer for an older delayed arrival at the live edge', () => {
      const current = seen('newer-msg', new Date('2025-01-15T10:05:00Z'))
      const state = makeState({ unreadCount: 4, readPointer: current })
      const msg = makeMsg({
        id: 'older-delayed',
        isDelayed: true,
        timestamp: new Date('2025-01-15T10:00:00Z'),
      })

      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE, 'chat', {
        treatDelayedAsNew: true,
      })

      expect(result.readPointer).toBe(current)
      expect(result.unreadCount).toBe(0)
    })

    it('preserves existing marker', () => {
      const state = makeState({ firstNewMessageId: 'marker-1' })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE, 'chat')
      expect(result.firstNewMessageId).toBe('marker-1')
    })
  })

  describe('incoming message — user does not see it', () => {
    it('increments unreadCount for inactive conversation', () => {
      const state = makeState({ unreadCount: 2 })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_VISIBLE, 'chat')
      expect(result.unreadCount).toBe(3)
    })

    it('increments unreadCount for active but hidden window', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN, 'chat')
      expect(result.unreadCount).toBe(1)
    })

    it('sets firstNewMessageId when active + hidden + no existing marker', () => {
      const state = makeState()
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN, 'chat')
      expect(result.firstNewMessageId).toBe('new-msg')
    })

    it('does not overwrite existing marker', () => {
      const state = makeState({ firstNewMessageId: 'existing-marker' })
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN, 'chat')
      expect(result.firstNewMessageId).toBe('existing-marker')
    })

    it('does not set marker for inactive entity', () => {
      const state = makeState()
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, 'chat')
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('leaves the read pointer undefined when there was none', () => {
      const state = makeState({ readPointer: undefined })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, 'chat')
      expect(result.readPointer).toBeUndefined()
    })

    it('preserves the existing read pointer', () => {
      const existing = seen('seen-1', new Date('2025-01-10T00:00:00Z'))
      const state = makeState({ readPointer: existing })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, 'chat')
      expect(result.readPointer).toBe(existing)
    })
  })

  // Acceptance scenario 8 (see docs/superpowers/specs/2026-07-23-read-state-unread-count-single-source-acceptance.md):
  // the on-arrival pointer-advance precondition. Pre-Task-11 code advanced the
  // pointer on `isActive && windowVisible` alone; the negative control below
  // ("scrolled up") is the one that must FAIL under that old gate — it is the
  // whole reason this precondition exists. Seeded at a distinguishing nonzero
  // read pointer / unreadCount so a broken gate is caught by an inequality, not
  // masked by a 0 -> 0 / undefined -> undefined tautology.
  describe('viewport-at-live-edge precondition (Task 11, acceptance scenario 8)', () => {
    const priorPointer = seen('prior-msg', new Date('2025-01-15T08:00:00Z'))

    it('active + focused + SCROLLED UP (not at live edge): pointer unchanged, unread increases', () => {
      const state = makeState({ readPointer: priorPointer, unreadCount: 4 })
      const msg = makeMsg({ id: 'new-msg', timestamp: new Date('2025-01-15T09:00:00Z') })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE_SCROLLED_UP, 'chat')
      // Break check (a): gating on `isActive && windowVisible` only would take
      // the "sees it" branch here and wrongly report unreadCount 4 / pointer
      // advanced to 'new-msg' — this assertion is what catches that regression.
      expect(result.readPointer).toBe(priorPointer)
      expect(result.unreadCount).toBe(5)
    })

    it('active + focused + AT THE LIVE EDGE: pointer advances, count converges to 0', () => {
      const state = makeState({ readPointer: priorPointer, unreadCount: 4 })
      const msg = makeMsg({ id: 'new-msg', timestamp: new Date('2025-01-15T09:00:00Z') })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE, 'chat')
      expect(result.readPointer).toMatchObject({ order: { timestamp: msg.timestamp.getTime() }, identity: { messageId: 'new-msg' } })
      expect(result.unreadCount).toBe(0)
    })

    it('active + focused + UNKNOWN viewport evidence (never reported): treated as not-at-edge, pointer unchanged', () => {
      const state = makeState({ readPointer: priorPointer, unreadCount: 4 })
      const msg = makeMsg({ id: 'new-msg', timestamp: new Date('2025-01-15T09:00:00Z') })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE_UNKNOWN_VIEWPORT, 'chat')
      expect(result.readPointer).toBe(priorPointer)
      expect(result.unreadCount).toBe(5)
    })

    it('window hidden (existing gate, unaffected by Task 11): pointer unchanged regardless of viewport evidence', () => {
      const state = makeState({ readPointer: priorPointer, unreadCount: 4 })
      const msg = makeMsg({ id: 'new-msg', timestamp: new Date('2025-01-15T09:00:00Z') })
      // Even an explicit at-edge report must not matter while the window itself is hidden.
      const result = onMessageReceived(
        state,
        msg,
        { isActive: true, windowVisible: false, unreadCount: 4, viewportAtLiveEdge: true },
        'chat'
      )
      expect(result.readPointer).toBe(priorPointer)
      expect(result.unreadCount).toBe(5)
    })
  })

  describe('renderability guard (Task 9)', () => {
    // Seeded at a distinguishing nonzero value (4) so a broken guard that
    // increments unconditionally is caught by the FIRST assertion (5 !== 4),
    // not masked by a 0 -> 0 tautology.
    it('does NOT increment unreadCount for a non-renderable message (empty body, nothing else)', () => {
      const state = makeState({ unreadCount: 4 })
      const msg = makeMsg({ body: '' })
      const result = onMessageReceived(state, msg, INACTIVE_VISIBLE, 'chat')
      expect(result.unreadCount).toBe(4)
    })

    it('increments unreadCount for an ordinary renderable message', () => {
      const state = makeState({ unreadCount: 4 })
      const msg = makeMsg({ body: 'hello there' })
      const result = onMessageReceived(state, msg, INACTIVE_VISIBLE, 'chat')
      expect(result.unreadCount).toBe(5)
    })

    it('still increments for a body-less retraction tombstone (isRenderableStoredMessage keeps those)', () => {
      const state = makeState({ unreadCount: 4 })
      const msg = makeMsg({ body: '', isRetracted: true })
      const result = onMessageReceived(state, msg, INACTIVE_VISIBLE, 'chat')
      expect(result.unreadCount).toBe(5)
    })
  })

  describe('room-specific options', () => {
    it('increments mentionsCount when incrementMentions is true', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, 'chat', { incrementMentions: true })
      expect(result.mentionsCount).toBe(1)
      expect(result.unreadCount).toBe(1)
    })

    it('does not increment unread when incrementUnread is false', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, 'chat', { incrementUnread: false })
      expect(result.unreadCount).toBe(0)
    })

    it('handles multiple increments correctly', () => {
      let state = makeState()
      state = onMessageReceived(state, makeMsg({ id: 'm1' }), INACTIVE_HIDDEN, 'chat', { incrementMentions: true })
      state = onMessageReceived(state, makeMsg({ id: 'm2' }), INACTIVE_HIDDEN, 'chat', { incrementMentions: false })
      state = onMessageReceived(state, makeMsg({ id: 'm3' }), INACTIVE_HIDDEN, 'chat', { incrementMentions: true })
      expect(state.unreadCount).toBe(3)
      expect(state.mentionsCount).toBe(2)
    })
  })
})

// ---------------------------------------------------------------------------
// onActivate
// ---------------------------------------------------------------------------

describe('onActivate', () => {
  const messages: NotificationMessage[] = [
    makeMsg({ id: 'msg-1', timestamp: new Date('2025-01-15T09:00:00Z') }),
    makeMsg({ id: 'msg-2', timestamp: new Date('2025-01-15T09:30:00Z') }),
    makeMsg({ id: 'msg-3', timestamp: new Date('2025-01-15T10:00:00Z'), isOutgoing: true }),
    makeMsg({ id: 'msg-4', timestamp: new Date('2025-01-15T10:30:00Z') }),
    makeMsg({ id: 'msg-5', timestamp: new Date('2025-01-15T11:00:00Z') }),
  ]

  it('sets marker at first incoming message after the read pointer', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-2'), unreadCount: 2 })
    const result = onActivate(state, messages, 'chat')
    // msg-3 is outgoing, so marker should be at msg-4
    expect(result.firstNewMessageId).toBe('msg-4')
  })

  it('skips outgoing messages when finding marker position', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-2') })
    const result = onActivate(state, messages, 'chat')
    expect(result.firstNewMessageId).toBe('msg-4') // skips msg-3 (outgoing)
  })

  it('includes delayed messages when finding marker position (offline delivery)', () => {
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'a', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'b', timestamp: new Date('2025-01-15T09:30:00Z'), isDelayed: true }),
      makeMsg({ id: 'c', timestamp: new Date('2025-01-15T10:00:00Z') }),
    ]
    const state = makeState({ readPointer: seenIn(msgs, 'a') })
    const result = onActivate(state, msgs, 'chat')
    // Delayed messages are valid new messages (offline delivery in 1:1 chats).
    // `isDelayed` no longer discriminates at all: anything after the
    // boundary is new.
    expect(result.firstNewMessageId).toBe('b')
  })

  it('sets no marker when the read pointer is at the last message', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-5') })
    const result = onActivate(state, messages, 'chat')
    expect(result.firstNewMessageId).toBeUndefined()
  })

  // Activation used to force
  // unreadCount to 0 unconditionally, as if opening an entity were the same
  // event as reading it. It is not — the one canonical count is derived
  // exclusively from the archive (recomputeUnreadForConversation /
  // recomputeUnreadForRoom) and converges to 0 only through the
  // live-edge convergence. This test used to protect "activation zeroes both
  // counts"; it now protects the opposite for unreadCount — activation must
  // leave it exactly as given. mentionsCount is untouched (out of
  // scope) and still clears on open.
  it('leaves unreadCount unchanged but clears mentionsCount', () => {
    const state = makeState({ unreadCount: 5, mentionsCount: 2, readPointer: seenIn(messages, 'msg-2') })
    const result = onActivate(state, messages, 'chat')
    expect(result.unreadCount).toBe(5)
    expect(result.mentionsCount).toBe(0)
  })

  // Replaces 'updates lastReadAt to last message timestamp' (#1081). Activation
  // used to stamp a second read field with the NEWEST loaded message's time
  // while the position it actually held stayed at msg-2 — the two-fields drift
  // this issue removes. There is now one pointer, and activation must leave its
  // timestamp on the message it names.
  it('does not drag the read time forward to the newest loaded message', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-2') })
    const result = onActivate(state, messages, 'chat')
    expect(result.readPointer?.identity.messageId).toBe('msg-2')
    expect(result.readPointer?.order.timestamp).toBe(new Date('2025-01-15T09:30:00Z').getTime())
    expect(result.readPointer?.order.timestamp).not.toBe(new Date('2025-01-15T11:00:00Z').getTime())
  })

  it('preserves the read pointer', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-2') })
    const result = onActivate(state, messages, 'chat')
    expect(result.readPointer?.identity.messageId).toBe('msg-2')
  })

  // An empty slice gives onActivate nothing to derive a divider from —
  // it must not fabricate a "fully read" 0 either; the seeded 3 passes through.
  it('handles empty messages array', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-1'), unreadCount: 3 })
    const result = onActivate(state, [], 'chat')
    expect(result.firstNewMessageId).toBeUndefined()
    expect(result.unreadCount).toBe(3)
  })

  // Residency is no longer a case distinction. There is ONE rule — the divider
  // is the first renderable incoming message strictly after the boundary in
  // `(timestamp, tiebreak)` order — and it is the same rule whether or
  // not the pointer's own message happens to be in the slice. The old
  // "stale-pointer fallback" ladder these tests were named after is gone; what
  // they now pin is that the one rule keeps giving the right answer when the
  // pointer sits outside the loaded window.
  describe('when the read pointer is not in the loaded slice', () => {
    it('positions the divider from the pointer position alone', () => {
      const state = makeState({
        // between msg-3 (10:00) and msg-4 (10:30)
        readPointer: seen('very-old-msg', new Date('2025-01-15T10:15:00Z')),
        unreadCount: 2,
      })
      const result = onActivate(state, messages, 'chat')
      expect(result.firstNewMessageId).toBe('msg-4')
    })

    it('skips outgoing messages', () => {
      const state = makeState({
        // between msg-2 (09:30) and msg-3 (10:00, outgoing)
        readPointer: seen('very-old-msg', new Date('2025-01-15T09:45:00Z')),
        unreadCount: 2,
      })
      const result = onActivate(state, messages, 'chat')
      // msg-3 is outgoing, so marker should be at msg-4
      expect(result.firstNewMessageId).toBe('msg-4')
    })

    it('uses the pointer timestamp even when unreadCount is 0 (post-restart)', () => {
      const state = makeState({
        readPointer: seen('very-old-msg', new Date('2025-01-15T10:15:00Z')),
        unreadCount: 0, // restored with nothing counted as unread
      })
      const result = onActivate(state, messages, 'chat')
      expect(result.firstNewMessageId).toBe('msg-4')
    })

    it('sets no marker when all loaded messages are before the pointer timestamp', () => {
      const state = makeState({
        // after all messages
        readPointer: seen('very-old-msg', new Date('2025-01-15T12:00:00Z')),
      })
      const result = onActivate(state, messages, 'chat')
      expect(result.firstNewMessageId).toBeUndefined()
    })

    // Replaces three tests that asserted the deleted Nth-from-end ladder
    // ('uses unreadCount to place marker N messages from end…', 'places marker
    // at first incoming when unreadCount exceeds available messages', 'sets no
    // marker when the pointer has no usable time and no unread'). The epoch is
    // the "no usable read time" sentinel, so the whole slice sits after the
    // boundary and the divider is the first renderable incoming message —
    // over-counting, the recoverable direction.
    // unreadCount no longer participates: the three cases below differ only in
    // it, and all three must now answer the same thing.
    it.each([0, 2, 50])(
      'puts the divider at the first incoming message for an epoch pointer (unreadCount %i is not consulted)',
      (unreadCount) => {
        const state = makeState({ readPointer: seen('very-old-msg', NO_READ_TIME), unreadCount })
        const result = onActivate(state, messages, 'chat')
        expect(result.firstNewMessageId).toBe('msg-1')
      }
    )

    // Replaces 'resume-preserving: snaps a stale pointer to the predecessor of
    // the derived divider'. That snap was a pointer WRITE inside a function
    // whose only job is to place a divider, and it existed solely because an
    // off-slice pointer could not be located. It is gone: the pointer comes out
    // by reference, untouched.
    it('leaves a stale pointer exactly where it was while still placing a divider', () => {
      const pointer = seen('very-old-msg', new Date('2025-01-15T09:45:00Z'))
      const state = makeState({ readPointer: pointer, unreadCount: 3 })
      const result = onActivate(state, messages, 'chat')
      expect(result.firstNewMessageId).toBe('msg-4') // msg-3 is outgoing
      expect(result.readPointer).toBe(pointer)
    })

    it('includes delayed messages (offline/MAM delivery)', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'old-1', timestamp: new Date('2025-01-15T09:00:00Z') }),
        makeMsg({ id: 'delayed-1', timestamp: new Date('2025-01-15T10:00:00Z'), isDelayed: true }),
        makeMsg({ id: 'delayed-2', timestamp: new Date('2025-01-15T10:30:00Z'), isDelayed: true }),
      ]
      const state = makeState({
        readPointer: seen('very-old-msg', new Date('2025-01-15T09:30:00Z')),
        unreadCount: 2,
      })
      const result = onActivate(state, msgs, 'chat')
      expect(result.firstNewMessageId).toBe('delayed-1')
    })
  })

  describe('migration path (pointer built from a legacy lastReadAt-only conversation)', () => {
    // Pre-#1081 a conversation could hold a read TIME and no message id at all,
    // and onActivate had a dedicated branch for it. The migration turns that into
    // a pointer whose id names whatever message the cache resolved (often absent
    // from the loaded slice) and whose timestamp IS the old lastReadAt. No
    // dedicated branch survives: that pointer goes through the one rule like any
    // other, ordered on its bare timestamp (it is KEYLESS, so it cannot break a
    // millisecond tie), and lands on the same message.
    it('finds the marker from the pointer timestamp when its id is not in the slice', () => {
      const state = makeState({ readPointer: seen('resolved-elsewhere', new Date('2025-01-15T09:15:00Z')) })
      const result = onActivate(state, messages, 'chat')
      // First message with timestamp > 09:15 and not outgoing = msg-2 (09:30)
      expect(result.firstNewMessageId).toBe('msg-2')
    })

    it('handles no read pointer at all with no unread', () => {
      const state = makeState()
      const result = onActivate(state, messages, 'chat')
      expect(result.firstNewMessageId).toBeUndefined()
    })
  })

  // Replaces 'brand-new conversation (no read pointer, has unread)', whose
  // every case asserted the deleted unreadCount-driven placement. A pointerless
  // entity's boundary is its creation/join watermark, and nothing else — the
  // count derives from exactly the same fallback (`computeFloor`).
  describe('no read pointer: the boundary is the historyFloor, never unreadCount', () => {
    it('places the divider at the first message after the floor', () => {
      // The floor shares msg-2's millisecond and msg-2 still counts as after it —
      // `isAfterBoundary` applies the same keyless-boundary rule as the count.
      const state = makeState({ historyFloor: new Date('2025-01-15T09:30:00Z'), unreadCount: 2 })
      const result = onActivate(state, messages, 'chat')
      expect(result.firstNewMessageId).toBe('msg-2')
    })

    it('skips outgoing messages after the floor', () => {
      const state = makeState({ historyFloor: new Date('2025-01-15T09:45:00Z'), unreadCount: 2 })
      const result = onActivate(state, messages, 'chat')
      expect(result.firstNewMessageId).toBe('msg-4') // msg-3 is outgoing
    })

    // The count is not a boundary and never was one — same fixture, same
    // messages, three different counts, one answer.
    it.each([0, 2, 50])('ignores unreadCount %i entirely', (unreadCount) => {
      const state = makeState({ historyFloor: new Date('2025-01-15T09:45:00Z'), unreadCount })
      expect(onActivate(state, messages, 'chat').firstNewMessageId).toBe('msg-4')
    })

    it('yields no divider without a floor, however large the count', () => {
      const state = makeState({ unreadCount: 50 })
      expect(onActivate(state, messages, 'chat').firstNewMessageId).toBeUndefined()
    })

    it('places the divider on a delayed message after the floor (offline delivery)', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'old-1', timestamp: new Date('2025-01-15T09:00:00Z') }),
        makeMsg({ id: 'new-1', timestamp: new Date('2025-01-15T10:00:00Z'), isDelayed: true }),
        makeMsg({ id: 'new-2', timestamp: new Date('2025-01-15T10:30:00Z'), isDelayed: true }),
      ]
      const state = makeState({ historyFloor: new Date('2025-01-15T09:30:00Z'), unreadCount: 2 })
      const result = onActivate(state, msgs, 'chat')
      expect(result.firstNewMessageId).toBe('new-1')
    })

    it('handles empty messages', () => {
      const state = makeState({ historyFloor: new Date('2025-01-15T09:00:00Z'), unreadCount: 3 })
      const result = onActivate(state, [], 'chat')
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('sets no marker when every message after the floor is outgoing', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'out-1', timestamp: new Date('2025-01-15T09:00:00Z'), isOutgoing: true }),
        makeMsg({ id: 'out-2', timestamp: new Date('2025-01-15T09:30:00Z'), isOutgoing: true }),
      ]
      const state = makeState({ historyFloor: new Date('2025-01-15T08:00:00Z'), unreadCount: 1 })
      const result = onActivate(state, msgs, 'chat')
      expect(result.firstNewMessageId).toBeUndefined()
    })
  })

  // Replaces 'room mode (treatDelayedAsNew=false): delayed = history replay,
  // not new'. Under the unified rule `isDelayed` no longer
  // discriminates anywhere in the divider: what keeps a freshly joined room
  // from opening in the middle of replayed history is the JOIN WATERMARK, which
  // sits after that history. Gating on `isDelayed` was a proxy for it, and a
  // wrong one — MAM catch-up for a long-standing room delivers genuinely unread
  // messages flagged delayed, and the ROOM path used to drop the divider for
  // every one of them.
  describe('room mode: history replay is excluded by the floor, not by isDelayed', () => {
    const replay: NotificationMessage[] = [
      makeMsg({ id: 'h-1', timestamp: new Date('2025-01-15T09:00:00Z'), isDelayed: true }),
      makeMsg({ id: 'h-2', timestamp: new Date('2025-01-15T10:00:00Z'), isDelayed: true }),
      makeMsg({ id: 'live-1', timestamp: new Date('2025-01-15T12:00:00Z') }),
    ]

    it('a freshly joined room shows no divider over history that predates the join', () => {
      // The join watermark sits after the replayed history but before the live
      // message, so only the live message is new.
      const state = makeState({ historyFloor: new Date('2025-01-15T11:00:00Z'), unreadCount: 2 })
      expect(onActivate(state, replay.slice(0, 2), 'room').firstNewMessageId).toBeUndefined()
      expect(onActivate(state, replay, 'room').firstNewMessageId).toBe('live-1')
    })

    it('delayed history AFTER a read pointer is genuinely unread and carries the divider', () => {
      // The regression the isDelayed gate caused: a room read up to h-1, whose
      // catch-up then delivers h-2 flagged delayed, used to lose its divider.
      const state = makeState({ readPointer: makeReadPointer({ id: 'h-1', timestamp: replay[0].timestamp }, 'room') })
      expect(onActivate(state, replay, 'room').firstNewMessageId).toBe('h-2')
    })
  })
})

describe('onActivate stale pointer', () => {
  // Replaces 'snaps pointer to the message before the derived divider, not to
  // the newest' — the snap is gone (see the D5 suite's 'never moves the read
  // pointer'). What survives is that an OFF-SLICE pointer still positions a
  // divider, now purely by cache order.
  it('positions a divider from an off-slice pointer without touching it', () => {
    const mkMsg = (id: string, minutesAgo: number): NotificationMessage => ({
      id, timestamp: new Date(Date.now() - minutesAgo * 60_000), isOutgoing: false, isDelayed: true, body: 'hi',
    })
    const pointer = seen('evicted', new Date(Date.now() - 25 * 60_000))
    const state = { ...createInitialNotificationState(), readPointer: pointer }
    const messages = [mkMsg('a', 30), mkMsg('b', 20), mkMsg('c', 10)]
    const out = onActivate(state, messages, 'chat')
    expect(out.firstNewMessageId).toBe('b')
    expect(out.readPointer).toBe(pointer)
  })
})

describe('onActivate — floor-derived divider (PR C, D5)', () => {
  const inc = (id: string, ms: number, extra?: Partial<NotificationMessage>): NotificationMessage =>
    ({ id, timestamp: new Date(ms), isOutgoing: false, body: 'hi', ...extra })

  it('places the divider at the first incoming message after a KEYED pointer', () => {
    const state = { unreadCount: 2, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000), inc('m3', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m2')
  })

  // A non-resident pointer at a DISTINCT millisecond is not a control: today's
  // ladder already probes `timestamp > pointer.timestamp` and lands on the same
  // message. The case only the key order can settle is a non-resident pointer
  // SHARING a millisecond with a resident message.
  //
  // Pointer m2@2000 (keyed, absent from the slice); m3@2000 is resident.
  //   before -> ladder finds the first message strictly after 2000 => 'm4'
  //   now    -> mayAdvanceTo ranks m3 after m2 at the same ms  => 'm3'
  it('places the divider on a same-millisecond sibling of a NON-RESIDENT pointer', () => {
    const state = { unreadCount: 2, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm2', timestamp: new Date(2000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m3', 2000), inc('m4', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m3')
  })

  // Pointerless: the floor is historyFloor, and `isAfterBoundary` counts a
  // same-ms message as after that keyless boundary — matching the count exactly.
  it('uses historyFloor when there is no pointer, counting a same-millisecond message as after', () => {
    const state = { unreadCount: 1, mentionsCount: 0, readPointer: undefined,
      historyFloor: new Date(2000), firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000), inc('m3', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m2')
  })

  it('yields NO divider when there is neither a pointer nor a historyFloor', () => {
    const state = { unreadCount: 5, mentionsCount: 0, readPointer: undefined, firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000)], 'chat')
    expect(r.firstNewMessageId).toBeUndefined()
  })

  // CONTROL: divider eligibility must match countUnreadInArchive's predicate.
  // A non-renderable row contributes nothing to the count, so it must not carry
  // the divider either. The old isNewCandidate had no renderability check.
  it('skips a NON-RENDERABLE row and puts the divider on the next real message', () => {
    const state = { unreadCount: 1, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    const ghost = { id: 'ghost', timestamp: new Date(2000), isOutgoing: false }
    const r = onActivate(state, [inc('m1', 1000), ghost, inc('m3', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m3')
  })

  it('skips outgoing messages', () => {
    const state = { unreadCount: 1, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000, { isOutgoing: true }), inc('m3', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m3')
  })

  // Unified semantics: with a timestamp floor, a delayed message after the floor
  // simply IS new. This is why onActivate sheds treatDelayedAsNew (spec D8).
  it('treats a DELAYED message after the floor as new, for chat and room alike', () => {
    for (const kind of ['chat', 'room'] as const) {
      const state = { unreadCount: 1, mentionsCount: 0,
        readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, kind),
        firstNewMessageId: undefined }
      const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000, { isDelayed: true })], kind)
      expect(r.firstNewMessageId).toBe('m2')
    }
  })

  it('never moves the read pointer', () => {
    const pointer = makeReadPointer({ id: 'gone', timestamp: new Date(1500) }, 'chat')
    const state = { unreadCount: 2, mentionsCount: 0, readPointer: pointer, firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m2', 2000)], 'chat')
    expect(r.readPointer).toBe(pointer)
  })

  it('leaves unreadCount untouched', () => {
    const state = { unreadCount: 7, mentionsCount: 3,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    expect(onActivate(state, [inc('m1', 1000), inc('m2', 2000)], 'chat').unreadCount).toBe(7)
  })
})

describe('onMessageSeen atLiveEdge advance', () => {
  it('advances an unresolvable pointer when viewing the newest message at the live edge', () => {
    const state = { ...createInitialNotificationState(), readPointer: seen('evicted', new Date(500)) }
    const messages = [{ id: 'a', timestamp: new Date(1000) }, { id: 'b', timestamp: new Date(2000) }]
    const out = onMessageSeen(state, 'b', messages, 'chat', { atLiveEdge: true })
    expect(out.readPointer).toMatchObject({ order: { timestamp: new Date(2000).getTime() }, identity: { messageId: 'b' } })
  })
  it('stays guarded off the live edge (window slid up — no regression)', () => {
    const state = { ...createInitialNotificationState(), readPointer: seen('newer-than-slice', new Date(9000)) }
    const messages = [{ id: 'a', timestamp: new Date(1000) }, { id: 'b', timestamp: new Date(2000) }]
    expect(onMessageSeen(state, 'b', messages, 'chat', { atLiveEdge: false })).toBe(state)
    expect(onMessageSeen(state, 'a', messages, 'chat', { atLiveEdge: true })).toBe(state) // not the newest
  })
})

// ---------------------------------------------------------------------------
// onDeactivate
// ---------------------------------------------------------------------------

describe('onDeactivate', () => {
  it('clears firstNewMessageId', () => {
    const state = makeState({ firstNewMessageId: 'marker-1', unreadCount: 0 })
    const result = onDeactivate(state)
    expect(result.firstNewMessageId).toBeUndefined()
  })

  it('returns same reference when no marker to clear', () => {
    const state = makeState()
    const result = onDeactivate(state)
    expect(result).toBe(state)
  })

  it('preserves other fields', () => {
    const state = makeState({
      unreadCount: 3,
      mentionsCount: 1,
      readPointer: seen('seen-1', new Date(1000)),
      firstNewMessageId: 'marker-1',
    })
    const result = onDeactivate(state)
    expect(result.unreadCount).toBe(3)
    expect(result.mentionsCount).toBe(1)
    expect(result.readPointer?.identity.messageId).toBe('seen-1')
  })
})

// ---------------------------------------------------------------------------
// onMarkAsRead
// ---------------------------------------------------------------------------

describe('onMarkAsRead', () => {
  it('clears unreadCount and mentionsCount', () => {
    const state = makeState({ unreadCount: 5, mentionsCount: 2 })
    const result = onMarkAsRead(state, [], 'chat', { windowAtLiveEdge: false, viewportAtLiveEdge: true })
    expect(result.unreadCount).toBe(0)
    expect(result.mentionsCount).toBe(0)
  })

  it('preserves firstNewMessageId', () => {
    const state = makeState({ firstNewMessageId: 'marker-1', unreadCount: 1 })
    const result = onMarkAsRead(state, [], 'chat', { windowAtLiveEdge: false, viewportAtLiveEdge: true })
    expect(result.firstNewMessageId).toBe('marker-1')
  })

  it('returns same reference when nothing to change', () => {
    const state = makeState({ unreadCount: 0, mentionsCount: 0 })
    const result = onMarkAsRead(state, [], 'chat', { windowAtLiveEdge: false, viewportAtLiveEdge: true })
    expect(result).toBe(state)
  })

  // Replaces 'uses current time when no timestamp provided' (#1081). Clearing a
  // badge is not evidence of a new read position, so marking read no longer
  // stamps a wall-clock time anywhere: off the live edge, the read position
  // must come out byte-identical.
  it('does not invent a read position when off the live edge', () => {
    const pointer = seen('seen-1', new Date('2025-01-15T11:00:00Z'))
    const state = makeState({ unreadCount: 1, readPointer: pointer })
    const result = onMarkAsRead(state, [], 'chat', { windowAtLiveEdge: false, viewportAtLiveEdge: true })
    expect(result.unreadCount).toBe(0)
    expect(result.readPointer).toBe(pointer)
  })

  it('leaves the read pointer untouched when off the live edge', () => {
    const pointer = seen('seen-1', new Date(1000))
    const state = makeState({ unreadCount: 3, readPointer: pointer })
    const result = onMarkAsRead(state, [], 'chat', { windowAtLiveEdge: false, viewportAtLiveEdge: true })
    expect(result.readPointer).toBe(pointer)
  })

  it('advances the read pointer to the newest loaded message at the live edge (pointer catches up)', () => {
    const state = makeState({ unreadCount: 3, readPointer: seen('seen-1', new Date(1000)) })
    const messages = [makeMsg({ id: 'seen-1', timestamp: new Date(1000) }), makeMsg({ id: 'newest-9', timestamp: new Date(9000) })]
    const result = onMarkAsRead(state, messages, 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: true })
    expect(result.readPointer).toMatchObject({ order: { timestamp: new Date(9000).getTime() }, identity: { messageId: 'newest-9' } })
    expect(result.unreadCount).toBe(0)
  })

  it('advances the read pointer even when the badge is already clear', () => {
    // The IntersectionObserver may lag: unread already 0 but the pointer is behind.
    const ts = new Date('2025-01-15T12:00:00Z')
    const state = makeState({ unreadCount: 0, readPointer: seen('seen-1', new Date(1000)) })
    const messages = [makeMsg({ id: 'seen-1', timestamp: new Date(1000) }), makeMsg({ id: 'newest-9', timestamp: ts })]
    const result = onMarkAsRead(state, messages, 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: true })
    expect(result).not.toBe(state)
    expect(result.readPointer).toMatchObject({ order: { timestamp: ts.getTime() }, identity: { messageId: 'newest-9' } })
  })

  it('returns same reference when the newest loaded message is already the current pointer', () => {
    const ts = new Date('2025-01-15T12:00:00Z')
    const state = makeState({ unreadCount: 0, mentionsCount: 0, readPointer: seen('seen-1', ts) })
    const messages = [makeMsg({ id: 'seen-1', timestamp: ts })]
    const result = onMarkAsRead(state, messages, 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: true })
    expect(result).toBe(state)
  })
})

describe('onMarkAsRead — live-edge decision (PR C, D8)', () => {
  const m = (id: string, ms: number) => ({ id, timestamp: new Date(ms) })

  it('advances the pointer to the newest loaded message at the live edge', () => {
    const state = { unreadCount: 5, mentionsCount: 2, readPointer: undefined, firstNewMessageId: 'x' }
    const r = onMarkAsRead(state, [m('m1', 1000), m('m2', 2000)], 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: true })
    expect(r.readPointer?.identity.messageId).toBe('m2')
    expect(r.unreadCount).toBe(0)
    expect(r.mentionsCount).toBe(0)
    expect(r.firstNewMessageId).toBe('x')
  })

  it('clears the counts WITHOUT moving the pointer off the live edge', () => {
    const pointer = makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat')
    const state = { unreadCount: 5, mentionsCount: 0, readPointer: pointer, firstNewMessageId: undefined }
    const r = onMarkAsRead(state, [m('m1', 1000), m('m2', 2000)], 'chat', { windowAtLiveEdge: false, viewportAtLiveEdge: true })
    expect(r.readPointer).toBe(pointer)
    expect(r.unreadCount).toBe(0)
  })

  it('clears the counts WITHOUT moving the pointer when the viewport is away', () => {
    const pointer = makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat')
    const state = { unreadCount: 5, mentionsCount: 0, readPointer: pointer, firstNewMessageId: undefined }
    const r = onMarkAsRead(state, [m('m1', 1000), m('m2', 2000)], 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: false })
    expect(r.readPointer).toBe(pointer)
    expect(r.unreadCount).toBe(0)
  })

  it('is a no-op on an already-read entity at the live edge', () => {
    const pointer = makeReadPointer({ id: 'm2', timestamp: new Date(2000) }, 'chat')
    const state = { unreadCount: 0, mentionsCount: 0, readPointer: pointer, firstNewMessageId: undefined }
    expect(onMarkAsRead(state, [m('m1', 1000), m('m2', 2000)], 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: true })).toBe(state)
  })

  it('clears the counts on an empty slice without inventing a pointer', () => {
    const state = { unreadCount: 3, mentionsCount: 0, readPointer: undefined, firstNewMessageId: undefined }
    const r = onMarkAsRead(state, [], 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: true })
    expect(r.unreadCount).toBe(0)
    expect(r.readPointer).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// onClearMarker
// ---------------------------------------------------------------------------

describe('onClearMarker', () => {
  it('clears firstNewMessageId', () => {
    const state = makeState({ firstNewMessageId: 'marker-1' })
    const result = onClearMarker(state)
    expect(result.firstNewMessageId).toBeUndefined()
  })

  it('returns same reference when no marker', () => {
    const state = makeState()
    const result = onClearMarker(state)
    expect(result).toBe(state)
  })

  it('preserves other fields', () => {
    const state = makeState({
      unreadCount: 3,
      readPointer: seen('seen-1', new Date(1000)),
      firstNewMessageId: 'marker-1',
    })
    const result = onClearMarker(state)
    expect(result.unreadCount).toBe(3)
    expect(result.readPointer?.identity.messageId).toBe('seen-1')
  })
})

// ---------------------------------------------------------------------------
// onWindowBecameVisible
// ---------------------------------------------------------------------------

describe('onWindowBecameVisible', () => {
  it('clears unread and mentions for active entity', () => {
    const state = makeState({ unreadCount: 5, mentionsCount: 2 })
    const result = onWindowBecameVisible(state, true)
    expect(result.unreadCount).toBe(0)
    expect(result.mentionsCount).toBe(0)
  })

  // Replaces the lastReadAt half of the case above (#1081). Refocusing the
  // window says nothing about WHICH message the user reached, so it must not
  // move the read position — the pointer comes back by reference.
  it('does not move the read position', () => {
    const pointer = seen('seen-1', new Date(1000))
    const state = makeState({ unreadCount: 5, readPointer: pointer })
    const result = onWindowBecameVisible(state, true)
    expect(result.readPointer).toBe(pointer)
  })

  it('returns same reference for non-active entity', () => {
    const state = makeState({ unreadCount: 5 })
    const result = onWindowBecameVisible(state, false)
    expect(result).toBe(state)
  })

  it('returns same reference when already read', () => {
    const state = makeState({ unreadCount: 0, mentionsCount: 0 })
    const result = onWindowBecameVisible(state, true)
    expect(result).toBe(state)
  })

  it('preserves marker and read pointer', () => {
    const state = makeState({
      unreadCount: 3,
      firstNewMessageId: 'marker-1',
      readPointer: seen('seen-1', new Date(1000)),
    })
    const result = onWindowBecameVisible(state, true)
    expect(result.firstNewMessageId).toBe('marker-1')
    expect(result.readPointer?.identity.messageId).toBe('seen-1')
  })
})

// ---------------------------------------------------------------------------
// onMessageSeen
// ---------------------------------------------------------------------------

describe('onMessageSeen', () => {
  const messages = [
    { id: 'msg-1', timestamp: new Date(1000) },
    { id: 'msg-2', timestamp: new Date(2000) },
    { id: 'msg-3', timestamp: new Date(3000) },
    { id: 'msg-4', timestamp: new Date(4000) },
    { id: 'msg-5', timestamp: new Date(5000) },
  ]

  const pointerAt = (id: string): ReadPointer => {
    const found = messages.find((m) => m.id === id)!
    return { order: { role: 'floor', timestamp: found.timestamp.getTime() }, identity: { state: 'local', messageId: found.id } }
  }

  it('sets the read pointer when none exists', () => {
    const state = makeState()
    const result = onMessageSeen(state, 'msg-3', messages, 'chat')
    expect(result.readPointer).toMatchObject({ order: { timestamp: new Date(3000).getTime() }, identity: { messageId: 'msg-3' } })
  })

  it('advances forward', () => {
    const state = makeState({ readPointer: pointerAt('msg-2') })
    const result = onMessageSeen(state, 'msg-4', messages, 'chat')
    expect(result.readPointer).toMatchObject({ order: { timestamp: new Date(4000).getTime() }, identity: { messageId: 'msg-4' } })
  })

  it('does not go backwards', () => {
    const state = makeState({ readPointer: pointerAt('msg-4') })
    const result = onMessageSeen(state, 'msg-2', messages, 'chat')
    expect(result).toBe(state)
  })

  it('returns same reference for same message', () => {
    const state = makeState({ readPointer: pointerAt('msg-3') })
    const result = onMessageSeen(state, 'msg-3', messages, 'chat')
    expect(result).toBe(state)
  })

  // #1081 constraint: the id and the timestamp of a read position move together
  // or not at all. A message the caller does not hold has no honest timestamp to
  // pair with its id, so the pointer must not move to it — under-advancing is
  // recoverable (the next viewport report re-derives), over-advancing is not.
  it('does not advance to a message that is absent from the slice', () => {
    const withPointer = makeState({ readPointer: pointerAt('msg-2') })
    expect(onMessageSeen(withPointer, 'not-in-slice', messages, 'chat')).toBe(withPointer)

    const withoutPointer = makeState()
    expect(onMessageSeen(withoutPointer, 'not-in-slice', messages, 'chat')).toBe(withoutPointer)
    expect(onMessageSeen(withoutPointer, 'not-in-slice', messages, 'chat').readPointer).toBeUndefined()
  })

  it('preserves other fields', () => {
    const state = makeState({
      unreadCount: 3,
      firstNewMessageId: 'marker-1',
      readPointer: pointerAt('msg-1'),
    })
    const result = onMessageSeen(state, 'msg-3', messages, 'chat')
    expect(result.unreadCount).toBe(3)
    expect(result.firstNewMessageId).toBe('marker-1')
  })
})

describe('onMessageSeen — position comparison (PR C, D4)', () => {
  const m = (id: string, ms: number) => ({ id, timestamp: new Date(ms) })

  it('advances a KEYED pointer that is absent from the slice', () => {
    const state = { unreadCount: 4, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'old', timestamp: new Date(500) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onMessageSeen(state, 'm2', [m('m2', 2000)], 'chat')
    expect(r.readPointer?.identity.messageId).toBe('m2')
  })

  it('does NOT advance a KEYED pointer to a message behind it', () => {
    const state = { unreadCount: 0, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'new', timestamp: new Date(9000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onMessageSeen(state, 'm2', [m('m2', 2000)], 'chat')
    expect(r).toBe(state)
  })

  it('advances a KEYED pointer across a same-millisecond sibling that sorts after it', () => {
    const state = { unreadCount: 1, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onMessageSeen(state, 'm2', [m('m1', 1000), m('m2', 1000)], 'chat')
    expect(r.readPointer?.identity.messageId).toBe('m2')
  })

  // OFF-SLICE + same millisecond: nothing but the cache order key can decide
  // this one. The same-ms test above keeps the pointer's OWN message resident,
  // so deleting the keyed branch entirely still answers it correctly by array
  // index; here the index path finds no current position (currentIdx === -1,
  // and no live-edge escape hatch) and refuses.
  it('advances a KEYED, OFF-SLICE pointer onto a same-millisecond sibling that sorts after it', () => {
    const state = { unreadCount: 1, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    expect(onMessageSeen(state, 'm2', [m('m2', 1000)], 'chat').readPointer?.identity.messageId).toBe('m2')
  })

  // NEGATIVE POLARITY — this is the forward-only guard itself. The keyed branch
  // does NOT go through `advance()`: it builds the pointer directly, and both
  // stores commit whatever comes back after only a reference check. So this
  // `mayAdvanceTo(...)` is the SOLE thing standing between a same-millisecond
  // sibling that sorts BEFORE the pointer and a BACKWARDS pointer move —
  // which, on a forward-only position, is unrecoverable. Relaxing it to accept
  // equality (or to a key-blind `>=` on timestamps alone) is caught here and
  // nowhere else.
  it('does NOT move a KEYED, OFF-SLICE pointer back onto a same-millisecond sibling that sorts before it', () => {
    const state = { unreadCount: 1, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm2', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    expect(onMessageSeen(state, 'm1', [m('m1', 1000)], 'chat')).toBe(state)
  })

  // CONTROL: the keyless branch keeps its guard AND its escape hatch.
  it('refuses a KEYLESS pointer that is absent from the slice, unless at the live edge and newest', () => {
    const state: EntityNotificationState = { unreadCount: 4, mentionsCount: 0,
      readPointer: { order: { role: 'floor', timestamp: new Date(500).getTime() }, identity: { state: 'local', messageId: 'old' } }, firstNewMessageId: undefined }
    expect(onMessageSeen(state, 'm1', [m('m1', 2000), m('m2', 3000)], 'chat')).toBe(state)
    const edge = onMessageSeen(state, 'm2', [m('m1', 2000), m('m2', 3000)], 'chat', { atLiveEdge: true })
    expect(edge.readPointer?.identity.messageId).toBe('m2')
  })

  // ACCEPTED HAZARD — read this before "fixing" it.
  //
  // Dropping the `currentIdx === -1` guard for keyed pointers did more than
  // resolve unresolvable pointers: it also permits an advance ACROSS AN
  // ARBITRARY GAP. The viewport observer reports the bottom-most VISIBLE row
  // (`apps/fluux/src/hooks/useViewportObserver.ts`) and `MessageList` enables it
  // whenever `!isLoading && messages.length > 0` — never gated on the live edge.
  // So after a search "go to message" jump (`loadMessagesAroundFromCache`, which
  // hydrates the resident array with a slice around an arbitrary anchor and does
  // NOT touch `windowAtLiveEdge`), a keyed pointer sitting far behind and off the
  // slice advances straight to a row in the jumped-to window.
  //
  // What that costs, asserted below: every message between the old pointer and
  // the new one — m101…m254 here, none of which was ever rendered — is now
  // BEHIND the read boundary. The boundary is forward-only, so that is
  // permanent: those messages will never carry the divider or a `+1` again.
  //
  // This was raised in review and accepted
  // owner: the observer only ever reports a row the user is actually looking at,
  // and the same skip already happens within a resident slice (jump to the top of
  // a loaded window, scroll to its bottom, everything between is marked read).
  // A difference of degree, not of kind. Do NOT add a guard here without
  // re-opening that decision — this test is where it is recorded.
  it('accepts a far-forward advance: a KEYED off-slice pointer jumps to the reported row and the skipped range goes read', () => {
    // Pointer names m100; the resident slice is a jumped-to window at m250…m260
    // and does not contain it.
    const state = {
      unreadCount: 12,
      mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm100', timestamp: new Date(100_000) }, 'chat'),
      firstNewMessageId: undefined,
    }
    const slice = Array.from({ length: 11 }, (_, i) => m(`m${250 + i}`, (250 + i) * 1000))

    // The observer reports a row in the MIDDLE of that window — not its newest.
    const advancedState = onMessageSeen(state, 'm255', slice, 'chat')
    expect(advancedState.readPointer?.identity.messageId).toBe('m255')
    expect(advancedState.readPointer?.order.timestamp).toBe(255_000)

    // The consequence, made explicit: m200 was never rendered, yet it is now
    // behind the boundary — it no longer qualifies as the first new message,
    // while a message after the new pointer still does.
    const neverRendered: NotificationMessage = {
      id: 'm200', timestamp: new Date(200_000), isOutgoing: false, body: 'never rendered',
    }
    const afterPointer: NotificationMessage = {
      id: 'm300', timestamp: new Date(300_000), isOutgoing: false, body: 'genuinely new',
    }
    expect(onActivate(advancedState, [neverRendered, afterPointer], 'chat').firstNewMessageId).toBe('m300')
  })
})

// ---------------------------------------------------------------------------
// shouldNotifyConversation
// ---------------------------------------------------------------------------

describe('shouldNotifyConversation', () => {
  it('returns true for incoming unseen message when user cannot see it', () => {
    const msg = makeMsg()
    expect(shouldNotifyConversation(msg, INACTIVE_VISIBLE)).toBe(true)
    expect(shouldNotifyConversation(msg, INACTIVE_HIDDEN)).toBe(true)
    expect(shouldNotifyConversation(msg, ACTIVE_HIDDEN)).toBe(true)
  })

  it('returns false when user sees it (active + visible)', () => {
    expect(shouldNotifyConversation(makeMsg(), ACTIVE_VISIBLE)).toBe(false)
  })

  it('returns false for outgoing messages', () => {
    expect(shouldNotifyConversation(makeMsg({ isOutgoing: true }), INACTIVE_HIDDEN)).toBe(false)
  })

  it('returns true for a delayed but unseen message (reconnect offline delivery)', () => {
    expect(shouldNotifyConversation(makeMsg({ isDelayed: true }), INACTIVE_HIDDEN)).toBe(true)
  })

  it('returns true for an old but unseen message (freshness is not a gate)', () => {
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    expect(
      shouldNotifyConversation(makeMsg({ timestamp: hoursAgo, isDelayed: true }), INACTIVE_HIDDEN),
    ).toBe(true)
  })

  it('returns false when there is nothing unseen (unreadCount 0)', () => {
    expect(
      shouldNotifyConversation(makeMsg(), { isActive: false, windowVisible: false, unreadCount: 0 }),
    ).toBe(false)
  })

  it('returns false when lastMessage is the already-seen message', () => {
    expect(
      shouldNotifyConversation(makeMsg({ id: 'm5' }), {
        isActive: false,
        windowVisible: false,
        unreadCount: 1,
        readPointer: { order: { role: 'floor', timestamp: new Date().getTime() }, identity: { state: 'local', messageId: 'm5' } },
      }),
    ).toBe(false)
  })

  it('returns false when context omits unreadCount (defensive default)', () => {
    expect(
      shouldNotifyConversation(makeMsg(), { isActive: false, windowVisible: false }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldNotifyRoom
// ---------------------------------------------------------------------------

describe('shouldNotifyRoom', () => {
  it('notifies for mention even when notifyAll is false', () => {
    const msg = makeMsg({ isMention: true })
    const result = shouldNotifyRoom(msg, INACTIVE_HIDDEN, false)
    expect(result.shouldNotify).toBe(true)
    expect(result.isMention).toBe(true)
  })

  it('notifies for non-mention when notifyAll is true', () => {
    const msg = makeMsg()
    const result = shouldNotifyRoom(msg, INACTIVE_HIDDEN, true)
    expect(result.shouldNotify).toBe(true)
    expect(result.isMention).toBe(false)
  })

  it('does not notify for non-mention when notifyAll is false', () => {
    const msg = makeMsg()
    const result = shouldNotifyRoom(msg, INACTIVE_HIDDEN, false)
    expect(result.shouldNotify).toBe(false)
  })

  it('does not notify when user sees it', () => {
    const msg = makeMsg({ isMention: true })
    const result = shouldNotifyRoom(msg, ACTIVE_VISIBLE, true)
    expect(result.shouldNotify).toBe(false)
  })

  it('does not notify for outgoing', () => {
    const result = shouldNotifyRoom(makeMsg({ isOutgoing: true }), INACTIVE_HIDDEN, true)
    expect(result.shouldNotify).toBe(false)
  })

  it('does not notify for delayed', () => {
    const result = shouldNotifyRoom(makeMsg({ isDelayed: true }), INACTIVE_HIDDEN, true)
    expect(result.shouldNotify).toBe(false)
  })

  it('does not notify for stale messages', () => {
    const staleTimestamp = new Date(Date.now() - 6 * 60 * 1000)
    const result = shouldNotifyRoom(makeMsg({ timestamp: staleTimestamp, isMention: true }), INACTIVE_HIDDEN, true)
    expect(result.shouldNotify).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeBadgeCount
// ---------------------------------------------------------------------------

describe('computeBadgeCount', () => {
  it('sums all sources', () => {
    expect(computeBadgeCount({
      conversationsUnreadCount: 3,
      roomsWithUnreadCount: 2,
      eventsPendingCount: 1,
    })).toBe(6)
  })

  it('returns 0 when all sources are 0', () => {
    expect(computeBadgeCount({
      conversationsUnreadCount: 0,
      roomsWithUnreadCount: 0,
      eventsPendingCount: 0,
    })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// createInitialNotificationState
// ---------------------------------------------------------------------------

describe('createInitialNotificationState', () => {
  it('returns clean initial state', () => {
    const state = createInitialNotificationState()
    expect(state.unreadCount).toBe(0)
    expect(state.mentionsCount).toBe(0)
    expect(state.readPointer).toBeUndefined()
    expect(state.firstNewMessageId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration: full lifecycle sequences
// ---------------------------------------------------------------------------

describe('lifecycle sequences', () => {
  it('conversation with unread → open → see → switch away', () => {
    const messages = [
      makeMsg({ id: 'm1', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'm2', timestamp: new Date('2025-01-15T09:30:00Z') }),
      makeMsg({ id: 'm3', timestamp: new Date('2025-01-15T10:00:00Z') }),
    ]

    // Start: user has seen m1, messages m2 and m3 arrived while away
    let state = makeState({ readPointer: seenIn(messages, 'm1'), unreadCount: 2 })

    // User opens conversation. Opening is not reading — the divider is
    // positioned but unreadCount passes through untouched (2, not force-zeroed).
    // The count only converges to 0 once the archive derivation re-runs off the
    // pointer `onMessageSeen` below advances — a store-layer concern this pure
    // lifecycle test doesn't exercise.
    state = onActivate(state, messages, 'chat')
    expect(state.firstNewMessageId).toBe('m2')
    expect(state.unreadCount).toBe(2)

    // User scrolls and sees m2 and m3 via viewport
    state = onMessageSeen(state, 'm2', messages, 'chat')
    state = onMessageSeen(state, 'm3', messages, 'chat')
    expect(state.readPointer).toMatchObject(seenIn(messages, 'm3'))

    // User switches away
    state = onDeactivate(state)
    expect(state.firstNewMessageId).toBeUndefined()
    expect(state.readPointer).toMatchObject(seenIn(messages, 'm3'))
  })

  it('message arrives while window hidden → window refocuses', () => {
    let state = makeState({ readPointer: seen('m1', new Date('2025-01-15T09:00:00Z')) })
    const msg = makeMsg({ id: 'm2', timestamp: new Date('2025-01-15T10:00:00Z') })

    // Message arrives while active but window hidden
    state = onMessageReceived(state, msg, ACTIVE_HIDDEN, 'chat')
    expect(state.unreadCount).toBe(1)
    expect(state.firstNewMessageId).toBe('m2')

    // Window becomes visible
    state = onWindowBecameVisible(state, true)
    expect(state.unreadCount).toBe(0)
    expect(state.firstNewMessageId).toBe('m2') // marker preserved for visual
  })

  it('outgoing message clears everything consistently', () => {
    let state = makeState({
      unreadCount: 5,
      mentionsCount: 2,
      firstNewMessageId: 'old-marker',
      readPointer: seen('seen-1', new Date(1000)),
    })

    const outgoing = makeMsg({ id: 'out-1', isOutgoing: true })
    state = onMessageReceived(state, outgoing, ACTIVE_VISIBLE, 'chat')
    expect(state.unreadCount).toBe(0)
    expect(state.mentionsCount).toBe(0)
    expect(state.firstNewMessageId).toBeUndefined()
    // advanced to the outgoing message, timestamp included
    expect(state.readPointer).toMatchObject({ order: { timestamp: outgoing.timestamp.getTime() }, identity: { messageId: 'out-1' } })
  })

  it('no spurious marker after user replies to a conversation', () => {
    // Regression: user reads messages, replies, then re-opens the conversation.
    // The "new messages" divider must NOT appear above messages the user already saw.
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'msg-1', timestamp: new Date(1000) }),
      makeMsg({ id: 'msg-2', timestamp: new Date(2000) }),
      makeMsg({ id: 'reply-1', isOutgoing: true, timestamp: new Date(3000) }),
      makeMsg({ id: 'msg-3', timestamp: new Date(4000) }),
      makeMsg({ id: 'reply-2', isOutgoing: true, timestamp: new Date(5000) }),
    ]

    // User has seen everything up to msg-2
    let state = makeState({ readPointer: seenIn(msgs, 'msg-2') })

    // User sends reply-1 → the read pointer must advance
    state = onMessageReceived(state, msgs[2], ACTIVE_VISIBLE, 'chat')
    expect(state.readPointer?.identity.messageId).toBe('reply-1')

    // Incoming msg-3 arrives while user is viewing
    state = onMessageReceived(state, msgs[3], ACTIVE_VISIBLE, 'chat')
    expect(state.readPointer?.identity.messageId).toBe('msg-3')

    // User sends reply-2
    state = onMessageReceived(state, msgs[4], ACTIVE_VISIBLE, 'chat')
    expect(state.readPointer?.identity.messageId).toBe('reply-2')

    // User switches away and back
    state = onDeactivate(state)
    state = onActivate(state, msgs, 'chat')

    // No new messages after reply-2 → no marker
    expect(state.firstNewMessageId).toBeUndefined()
  })

  it('switching away and back re-derives the same marker (stale pointer, untouched)', () => {
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'msg-100', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'msg-101', timestamp: new Date('2025-01-15T09:30:00Z') }),
      makeMsg({ id: 'msg-102', timestamp: new Date('2025-01-15T10:00:00Z') }),
      // These two are new (after the read pointer's timestamp)
      makeMsg({ id: 'msg-103', timestamp: new Date('2025-01-15T10:30:00Z') }),
      makeMsg({ id: 'msg-104', timestamp: new Date('2025-01-15T11:00:00Z') }),
    ]

    const pointer = seen('msg-50', new Date('2025-01-15T10:15:00Z'))
    let state = makeState({
      // stale: 'msg-50' is not in msgs, so the timestamp is the boundary
      readPointer: pointer,
      unreadCount: 2,
    })

    // First activation: marker at msg-103. The pointer is NOT moved — activation
    // places a divider and writes no read position. The resume-
    // preserving snap that used to land it on msg-102 is gone.
    state = onActivate(state, msgs, 'chat')
    expect(state.firstNewMessageId).toBe('msg-103')
    expect(state.readPointer).toBe(pointer)

    // User switches away
    state = onDeactivate(state)
    expect(state.firstNewMessageId).toBeUndefined()

    // User switches back without ever having scrolled past the marker (no
    // onMessageSeen calls) — the boundary never moved, so the same unread
    // content re-derives the same marker. Idempotence is now structural.
    state = onActivate(state, msgs, 'chat')
    expect(state.firstNewMessageId).toBe('msg-103')
    expect(state.readPointer).toBe(pointer)
  })

  it('an epoch pointer timestamp puts the whole slice after the boundary', () => {
    // Scenario: a pre-#1081 conversation that only ever had a message id migrates
    // to a pointer carrying the epoch sentinel, and that id is stale. The epoch
    // IS the boundary, so every message sits after it and the divider lands on
    // the first one. Over-counting is the recoverable direction; the ladder's old
    // unreadCount placement guessed instead, and could guess too far forward.
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'msg-500', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'msg-501', timestamp: new Date('2025-01-15T09:30:00Z') }),
      makeMsg({ id: 'msg-502', timestamp: new Date('2025-01-15T10:00:00Z') }),
    ]

    const startPointer = seen('msg-1', NO_READ_TIME)
    let state = makeState({ readPointer: startPointer, unreadCount: 3 })
    const offlineMsg = makeMsg({ id: 'offline-1', isDelayed: true })
    state = onMessageReceived(state, offlineMsg, INACTIVE_HIDDEN, 'chat', { treatDelayedAsNew: true })

    // An unseen arrival never moves the read position
    expect(state.readPointer).toBe(startPointer)

    // On activation with a stale epoch pointer, the boundary is epoch: every
    // message is after it → divider at the first renderable incoming message.
    state = onActivate(state, msgs, 'chat')
    expect(state.firstNewMessageId).toBe('msg-500')
  })

  it('onMessageSeen does not regress when the read pointer is stale', () => {
    // Scenario: the pointer names an old message not in the current array.
    // A visible message should NOT replace it since we can't confirm ordering.
    const msgs = [
      { id: 'msg-100', timestamp: new Date(1000) },
      { id: 'msg-101', timestamp: new Date(2000) },
      { id: 'msg-102', timestamp: new Date(3000) },
    ]
    const pointer = seen('msg-999', new Date(9000))
    const state = makeState({ readPointer: pointer }) // not in msgs

    const result = onMessageSeen(state, 'msg-100', msgs, 'chat')
    // Should NOT regress to msg-100 — the stale pointer is preserved
    expect(result).toBe(state)
    expect(result.readPointer).toBe(pointer)
  })

  it('stale epoch pointer places the marker at the oldest incoming message', () => {
    // After app restart: the pointer's id is stale and its timestamp is the
    // epoch sentinel, so the boundary is epoch and the whole slice is after it.
    // Replaces 'stale read pointer + unreadCount places marker correctly from
    // end', which asserted the deleted Nth-from-end ladder ('d' for unread=2).
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'a', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'b', timestamp: new Date('2025-01-15T09:30:00Z'), isOutgoing: true }),
      makeMsg({ id: 'c', timestamp: new Date('2025-01-15T10:00:00Z') }),
      makeMsg({ id: 'd', timestamp: new Date('2025-01-15T10:30:00Z') }),
      makeMsg({ id: 'e', timestamp: new Date('2025-01-15T11:00:00Z') }),
    ]

    const state = makeState({
      readPointer: seen('stale-id', NO_READ_TIME),
      unreadCount: 2,
    })

    const result = onActivate(state, msgs, 'chat')
    // 'a' is the first renderable incoming message in the slice
    expect(result.firstNewMessageId).toBe('a')
  })

  it('room with mentions and notifyAll', () => {
    let state = makeState()

    // Regular message (no mention)
    state = onMessageReceived(state, makeMsg({ id: 'm1' }), INACTIVE_HIDDEN, 'chat', {
      incrementUnread: true,
      incrementMentions: false,
    })
    expect(state.unreadCount).toBe(1)
    expect(state.mentionsCount).toBe(0)

    // Mention message
    state = onMessageReceived(state, makeMsg({ id: 'm2', isMention: true }), INACTIVE_HIDDEN, 'chat', {
      incrementUnread: true,
      incrementMentions: true,
    })
    expect(state.unreadCount).toBe(2)
    expect(state.mentionsCount).toBe(1)

    // Outgoing clears both
    state = onMessageReceived(state, makeMsg({ id: 'm3', isOutgoing: true }), ACTIVE_VISIBLE, 'chat')
    expect(state.unreadCount).toBe(0)
    expect(state.mentionsCount).toBe(0)
  })

  it('messages arriving while viewing → leave → come back shows no stale marker', () => {
    // Scenario: user opens conversation, reads everything, new messages arrive
    // while viewing, user leaves and comes back → should see no old marker.
    const initialMessages: NotificationMessage[] = [
      makeMsg({ id: 'm1', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'm2', timestamp: new Date('2025-01-15T09:30:00Z') }),
      makeMsg({ id: 'm3', timestamp: new Date('2025-01-15T10:00:00Z') }),
    ]

    // User had seen m1, m2 and m3 are unread
    let state = makeState({ readPointer: seenIn(initialMessages, 'm1'), unreadCount: 2 })

    // User opens conversation → marker at m2
    state = onActivate(state, initialMessages, 'chat')
    expect(state.firstNewMessageId).toBe('m2')
    expect(state.readPointer?.identity.messageId).toBe('m1')

    // User scrolls and sees all messages via IntersectionObserver
    state = onMessageSeen(state, 'm3', initialMessages, 'chat')
    expect(state.readPointer).toMatchObject(seenIn(initialMessages, 'm3'))

    // New messages arrive while user is actively viewing
    const m4 = makeMsg({ id: 'm4', timestamp: new Date('2025-01-15T10:30:00Z') })
    const m5 = makeMsg({ id: 'm5', timestamp: new Date('2025-01-15T11:00:00Z') })
    state = onMessageReceived(state, m4, ACTIVE_VISIBLE, 'chat')
    state = onMessageReceived(state, m5, ACTIVE_VISIBLE, 'chat')

    // the read pointer should have advanced to m5 (user sees each message)
    expect(state.readPointer).toMatchObject({ order: { timestamp: m5.timestamp.getTime() }, identity: { messageId: 'm5' } })

    // User switches away
    state = onDeactivate(state)
    expect(state.firstNewMessageId).toBeUndefined()

    // User comes back — all messages including m4 and m5 are in the array now
    const allMessages: NotificationMessage[] = [
      ...initialMessages,
      m4,
      m5,
    ]
    state = onActivate(state, allMessages, 'chat')

    // No new messages after m5 → no marker (not the stale marker at m2!)
    expect(state.firstNewMessageId).toBeUndefined()
    expect(state.readPointer?.identity.messageId).toBe('m5')
  })
})

// ---------------------------------------------------------------------------
// readPointer shadow write (#1081)
// ---------------------------------------------------------------------------

describe('readPointer is the whole read position (#1081)', () => {
  const base = () => notifState.createInitialNotificationState()
  const msg = (id: string, ms: number, over = {}) => ({
    id, timestamp: new Date(ms), isOutgoing: false, ...over,
  })

  // An outgoing message only ever advances the pointer via the
  // `userSeesMessage` branch now (there is no more outgoing early return), so
  // this fixture must supply live-edge evidence — a backgrounded context would
  // leave the pointer untouched and this assertion would be testing nothing.
  it('onMessageReceived writes the whole pointer for an outgoing message', () => {
    const out = notifState.onMessageReceived(
      base(),
      msg('m1', 1000, { isOutgoing: true }),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: true },
      'chat'
    )
    // Whole-object assertion: a write that got the timestamp from anywhere but
    // the message itself fails here.
    expect(out.readPointer).toMatchObject({ order: { timestamp: new Date(1000).getTime() }, identity: { messageId: 'm1' } })
  })

  it('onMessageReceived writes the whole pointer when the user sees the message', () => {
    const out = notifState.onMessageReceived(
      base(),
      msg('m2', 2000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: true },
      'chat'
    )
    expect(out.readPointer).toMatchObject({ order: { timestamp: new Date(2000).getTime() }, identity: { messageId: 'm2' } })
  })

  it('onMessageSeen resolves the timestamp from the messages array', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000), msg('m3', 3000)]
    const start: EntityNotificationState = { ...base(), readPointer: { order: { role: 'floor', timestamp: new Date(1000).getTime() }, identity: { state: 'local', messageId: 'm1' } } }
    const out = notifState.onMessageSeen(start, 'm3', messages, 'chat')
    expect(out.readPointer?.identity.messageId).toBe('m3')
    expect(out.readPointer?.order.timestamp).toBe(3000)
  })

  it('onMessageSeen leaves the pointer put when it does not advance', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000)]
    const pointer: ReadPointer = { order: { role: 'floor', timestamp: 2000 }, identity: { state: 'local', messageId: 'm2' } }
    const start = { ...base(), readPointer: pointer }
    const out = notifState.onMessageSeen(start, 'm1', messages, 'chat')
    expect(out.readPointer).toBe(pointer)
  })
})

describe('readPointer on the remaining pointer-writing transitions (#1081)', () => {
  const base = () => notifState.createInitialNotificationState()
  // `body` is non-empty so each fixture is an ordinary RENDERABLE message —
  // the divider skips rows with nothing to display (see onActivate).
  const msg = (id: string, ms: number, over: Partial<NotificationMessage> = {}): NotificationMessage => ({
    id, timestamp: new Date(ms), isOutgoing: false, body: 'hi', ...over,
  })

  it('onMessageReceived keeps the pointer put for an unseen incoming message', () => {
    const pointer: ReadPointer = { order: { role: 'floor', timestamp: 1000 }, identity: { state: 'local', messageId: 'm1' } }
    const start = { ...base(), readPointer: pointer }
    const out = notifState.onMessageReceived(start, msg('m2', 2000), { isActive: false, windowVisible: false }, 'chat')
    expect(out.readPointer).toBe(pointer)
  })

  // Replaces 'onActivate resolves the pointer to the position it lands on'
  // (which asserted the deleted resume-preserving snap onto m1) — onActivate is
  // no longer a pointer-writing transition at all, which is why it now belongs
  // in this suite as a NEGATIVE case.
  it('onActivate never writes the pointer, stale id or not', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000), msg('m3', 3000)]
    const stale: ReadPointer = { order: { role: 'floor', timestamp: 1500 }, identity: { state: 'local', messageId: 'gone' } }
    const outStale = notifState.onActivate({ ...base(), readPointer: stale, unreadCount: 2 }, messages, 'chat')
    expect(outStale.firstNewMessageId).toBe('m2')
    expect(outStale.readPointer).toBe(stale)

    const resident = makeReadPointer(messages[1], 'chat')
    const outResident = notifState.onActivate({ ...base(), readPointer: resident, unreadCount: 1 }, messages, 'chat')
    expect(outResident.firstNewMessageId).toBe('m3')
    expect(outResident.readPointer).toBe(resident)
  })

  it('onMarkAsRead writes the whole pointer when the loaded window is at the live edge', () => {
    const start = {
      ...base(),
      unreadCount: 3,
      readPointer: { order: { role: 'floor', timestamp: new Date(1000).getTime() }, identity: { state: 'local', messageId: 'm1' } },
    } satisfies EntityNotificationState
    const out = notifState.onMarkAsRead(start, [msg('m1', 1000), msg('m3', 3000)], 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: true })
    expect(out.readPointer?.identity.messageId).toBe('m3')
    expect(out.readPointer?.order.timestamp).toBe(3000)
  })

  it('onMarkAsRead leaves the pointer put when the window is off the live edge', () => {
    const pointer: ReadPointer = { order: { role: 'floor', timestamp: 1000 }, identity: { state: 'local', messageId: 'm1' } }
    const start = { ...base(), unreadCount: 3, readPointer: pointer }
    const out = notifState.onMarkAsRead(start, [msg('m1', 1000)], 'chat', { windowAtLiveEdge: false, viewportAtLiveEdge: true })
    expect(out.readPointer).toBe(pointer)
  })

  // Replaces 'the two fields never disagree across the full transition set'
  // (#1081): there is no second field left to disagree with. The invariant that
  // survives the consolidation, and is still falsifiable, is that a pointer's
  // timestamp is always the timestamp of the message its id names — a transition
  // that carried a stale timestamp onto a new id would fail here.
  it('every transition leaves the pointer timestamp equal to its own message', () => {
    const messages = [
      msg('m1', 1000),
      msg('m2', 2000),
      msg('m3', 3000, { isOutgoing: true }),
      msg('m4', 4000),
    ]
    const byId = new Map(messages.map((m) => [m.id, m.timestamp]))
    // Tagged so a failure names the transition that broke the invariant.
    // messageId/timestamp are compared explicitly (not the whole pointer):
    // tiebreak is not this invariant's concern, and a `kind` constant
    // across every call here would otherwise make it trivially match.
    const coherent = (st: EntityNotificationState, label: string) => {
      const p = st.readPointer
      expect(
        `${label}: ${JSON.stringify(p && { messageId: p.identity.messageId, timestamp: p.order.timestamp })}`
      ).toBe(
        `${label}: ${JSON.stringify(p && { messageId: p.identity.messageId, timestamp: byId.get(p.identity.messageId)?.getTime() })}`
      )
    }

    let s: EntityNotificationState = base()
    s = notifState.onMessageReceived(s, messages[0], { isActive: false, windowVisible: false }, 'chat')
    coherent(s, 'onMessageReceived (unseen)')
    s = notifState.onMessageReceived(s, messages[1], { isActive: true, windowVisible: true, viewportAtLiveEdge: true }, 'chat')
    coherent(s, 'onMessageReceived (seen)')
    s = notifState.onMessageReceived(s, messages[2], { isActive: false, windowVisible: false }, 'chat')
    coherent(s, 'onMessageReceived (outgoing)')
    s = notifState.onMessageReceived(s, messages[3], { isActive: false, windowVisible: false }, 'chat')
    coherent(s, 'onMessageReceived (unseen again)')
    s = notifState.onActivate(s, messages, 'chat')
    coherent(s, 'onActivate')
    s = notifState.onMessageSeen(s, 'm4', messages, 'chat')
    coherent(s, 'onMessageSeen')
    s = notifState.onDeactivate(s)
    coherent(s, 'onDeactivate')
    s = notifState.onMarkAsRead(s, messages, 'chat', { windowAtLiveEdge: true, viewportAtLiveEdge: true })
    coherent(s, 'onMarkAsRead')
    s = notifState.onWindowBecameVisible(s, true)
    coherent(s, 'onWindowBecameVisible')
    s = notifState.onClearMarker(s)
    coherent(s, 'onClearMarker')
    expect(s.readPointer?.identity.messageId).toBe('m4')
  })
})

// ---------------------------------------------------------------------------
// onMessageReceived — outgoing collapse
// ---------------------------------------------------------------------------

describe('onMessageReceived — outgoing collapse (PR C, D1)', () => {
  const base = (over?: Partial<EntityNotificationState>): EntityNotificationState => ({
    unreadCount: 0,
    mentionsCount: 0,
    readPointer: undefined,
    firstNewMessageId: undefined,
    ...over,
  })
  const out = (id: string, ms: number, extra?: Partial<NotificationMessage>): NotificationMessage => ({
    id, timestamp: new Date(ms), isOutgoing: true, body: 'hi', ...extra,
  })

  it('advances the pointer on an outgoing message ONLY at the live edge', () => {
    const seen = onMessageReceived(base({ unreadCount: 5 }), out('m1', 1000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: true }, 'chat', { treatDelayedAsNew: true })
    expect(seen.readPointer?.identity.messageId).toBe('m1')
    expect(seen.unreadCount).toBe(0)
  })

  // The vector: a carbon of our own message, or a nick-misattributed MUC
  // reflection, arriving at a BACKGROUNDED entity must not move the pointer.
  it('does NOT advance the pointer on an outgoing message at a backgrounded entity', () => {
    const bg = onMessageReceived(base({ unreadCount: 5 }), out('m1', 1000),
      { isActive: false, windowVisible: true, viewportAtLiveEdge: false }, 'chat', { treatDelayedAsNew: true })
    expect(bg.readPointer).toBeUndefined()
    expect(bg.unreadCount).toBe(5)
  })

  it('does NOT advance the pointer on an outgoing message while active but scrolled up', () => {
    const up = onMessageReceived(base({ unreadCount: 5 }), out('m1', 1000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, 'chat', { treatDelayedAsNew: true })
    expect(up.readPointer).toBeUndefined()
    expect(up.unreadCount).toBe(5)
  })

  // CONTROL for hazard 1. chatStore.addMessage passes `incrementUnread: !noteAsTransient`,
  // NOT `!isOutgoing`, so without the guard this reaches the +1 and returns 6.
  it('never increments unread for an outgoing message, even when incrementUnread is true', () => {
    const r = onMessageReceived(base({ unreadCount: 5 }), out('m1', 1000),
      { isActive: false, windowVisible: false }, 'chat',
      { treatDelayedAsNew: true, incrementUnread: true })
    expect(r.unreadCount).toBe(5)
  })

  // CONTROL for hazard 2. active + window hidden + no existing divider is the
  // branch that would otherwise place the divider on our OWN message.
  it('never places the divider on an outgoing message', () => {
    const r = onMessageReceived(base({ unreadCount: 3 }), out('m1', 1000),
      { isActive: true, windowVisible: false }, 'chat', { treatDelayedAsNew: true })
    expect(r.firstNewMessageId).toBeUndefined()
  })

  it('never increments mentions for an outgoing message', () => {
    const r = onMessageReceived(base({ mentionsCount: 2 }), out('m1', 1000, { isMention: true }),
      { isActive: false, windowVisible: false }, 'room', { incrementMentions: true })
    expect(r.mentionsCount).toBe(2)
  })

  // The MUC vector specifically: `isOutgoing` in a room is
  // `isSentCarbon || nickname match`, so a whitespace/occupant-id impersonation
  // makes someone else's message look like ours. At a backgrounded room that
  // must not move a forward-only pointer.
  it('room: a misattributed outgoing reflection at a backgrounded room moves nothing', () => {
    const state = base({ unreadCount: 6,
      readPointer: makeReadPointer({ id: 'p0', from: 'r@c/alice', timestamp: new Date(500) }, 'room') })
    const r = onMessageReceived(state, { id: 'm1', from: 'r@c/imposter', timestamp: new Date(1000), isOutgoing: true, body: 'x' },
      { isActive: false, windowVisible: true, viewportAtLiveEdge: false }, 'room')
    expect(r.readPointer?.identity.messageId).toBe('p0')
    expect(r.unreadCount).toBe(6)
  })

  // D1's deliberate loss, both polarities. Seeded nonzero so "unchanged" is a
  // real assertion rather than 0-to-0.
  it('mentionsCount survives a reply sent while scrolled up, and clears at the live edge', () => {
    const up = onMessageReceived(base({ mentionsCount: 3 }), out('m1', 1000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, 'room')
    expect(up.mentionsCount).toBe(3)

    const edge = onMessageReceived(base({ mentionsCount: 3 }), out('m1', 1000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: true }, 'room')
    expect(edge.mentionsCount).toBe(0)
  })

  it('an active-but-not-at-live-edge outgoing message clears an existing divider (chat and room)', () => {
    for (const kind of ['chat', 'room'] as const) {
      const r = onMessageReceived(base({ unreadCount: 4, firstNewMessageId: 'old' }), out('m1', 1000),
        { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, kind,
        kind === 'chat' ? { treatDelayedAsNew: true } : undefined)
      expect(r.firstNewMessageId).toBeUndefined()
    }
  })

  it('a DELAYED outgoing message clears the divider in a CHAT (offline delivery)', () => {
    const r = onMessageReceived(base({ unreadCount: 4, firstNewMessageId: 'old' }),
      out('m1', 1000, { isDelayed: true }),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, 'chat',
      { treatDelayedAsNew: true })
    expect(r.firstNewMessageId).toBeUndefined()
  })

  // Deliberate behaviour change. Joining a MUC replays our own
  // <delay/>-stamped messages; a history replay is not evidence of reading, so
  // the divider must survive. Today this clears it.
  it('a DELAYED outgoing message does NOT clear the divider in a ROOM (history replay)', () => {
    const state = base({ unreadCount: 4, firstNewMessageId: 'old' })
    const r = onMessageReceived(state, out('m1', 1000, { isDelayed: true }),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, 'room')
    expect(r).toBe(state)
    expect(r.firstNewMessageId).toBe('old')
  })
})
