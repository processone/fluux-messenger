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
  recomputeCountsFromPointer,
  shouldNotifyConversation,
  shouldNotifyRoom,
  computeBadgeCount,
  createInitialNotificationState,
  type EntityNotificationState,
  type NotificationMessage,
  type EntityContext,
} from './notificationState'
import type { ReadPointer } from './readPointer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default timestamp is "now" so freshness checks pass in shouldNotify tests. */
function makeMsg(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: 'msg-1',
    timestamp: new Date(),
    isOutgoing: false,
    isDelayed: false,
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
  return { messageId: id, timestamp }
}

/** The read position naming `id`, taking that message's own timestamp from `msgs`. */
function seenIn(msgs: NotificationMessage[], id: string): ReadPointer {
  const found = msgs.find((m) => m.id === id)
  if (!found) throw new Error(`seenIn: no message ${id} in the slice`)
  return { messageId: found.id, timestamp: found.timestamp }
}

/**
 * The epoch sentinel a pointer carries when its timestamp is not usable as a
 * read horizon — the shape a pre-#1081 conversation that only ever had a
 * `lastSeenMessageId` migrates into. The stale-pointer fallbacks still treat
 * `getTime() === 0` as "no usable read time" and fall through to unreadCount.
 */
const NO_READ_TIME = new Date(0)

const ACTIVE_VISIBLE: EntityContext = { isActive: true, windowVisible: true, unreadCount: 1 }
const ACTIVE_HIDDEN: EntityContext = { isActive: true, windowVisible: false, unreadCount: 1 }
const INACTIVE_VISIBLE: EntityContext = { isActive: false, windowVisible: true, unreadCount: 1 }
const INACTIVE_HIDDEN: EntityContext = { isActive: false, windowVisible: false, unreadCount: 1 }

// ---------------------------------------------------------------------------
// onMessageReceived
// ---------------------------------------------------------------------------

describe('onMessageReceived', () => {
  describe('outgoing messages', () => {
    it('clears unread, mentions, and marker', () => {
      const state = makeState({ unreadCount: 3, mentionsCount: 1, firstNewMessageId: 'old-marker' })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.unreadCount).toBe(0)
      expect(result.mentionsCount).toBe(0)
      expect(result.firstNewMessageId).toBeUndefined()
      expect(result.readPointer).toEqual({ messageId: msg.id, timestamp: msg.timestamp })
    })

    it('clears state regardless of window visibility', () => {
      const state = makeState({ unreadCount: 5 })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result.unreadCount).toBe(0)
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('advances the read pointer to the outgoing message', () => {
      const state = makeState({ readPointer: seen('seen-1', new Date(1000)) })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.readPointer).toEqual({ messageId: msg.id, timestamp: msg.timestamp })
    })
  })

  describe('delayed/historical messages', () => {
    it('returns state unchanged', () => {
      const state = makeState({ unreadCount: 2 })
      const msg = makeMsg({ isDelayed: true })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result).toBe(state) // same reference
    })
  })

  describe('incoming message — user sees it', () => {
    it('keeps unread at 0 and advances the read pointer to the message', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.unreadCount).toBe(0)
      expect(result.mentionsCount).toBe(0)
      expect(result.readPointer).toEqual({ messageId: msg.id, timestamp: msg.timestamp })
    })

    it('advances the read pointer to the new message', () => {
      const state = makeState({ readPointer: seen('old-msg', new Date(1000)) })
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.readPointer).toEqual({ messageId: 'new-msg', timestamp: msg.timestamp })
    })

    it('preserves existing marker', () => {
      const state = makeState({ firstNewMessageId: 'marker-1' })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.firstNewMessageId).toBe('marker-1')
    })
  })

  describe('incoming message — user does not see it', () => {
    it('increments unreadCount for inactive conversation', () => {
      const state = makeState({ unreadCount: 2 })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_VISIBLE)
      expect(result.unreadCount).toBe(3)
    })

    it('increments unreadCount for active but hidden window', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN)
      expect(result.unreadCount).toBe(1)
    })

    it('sets firstNewMessageId when active + hidden + no existing marker', () => {
      const state = makeState()
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN)
      expect(result.firstNewMessageId).toBe('new-msg')
    })

    it('does not overwrite existing marker', () => {
      const state = makeState({ firstNewMessageId: 'existing-marker' })
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN)
      expect(result.firstNewMessageId).toBe('existing-marker')
    })

    it('does not set marker for inactive entity', () => {
      const state = makeState()
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('leaves the read pointer undefined when there was none', () => {
      const state = makeState({ readPointer: undefined })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result.readPointer).toBeUndefined()
    })

    it('preserves the existing read pointer', () => {
      const existing = seen('seen-1', new Date('2025-01-10T00:00:00Z'))
      const state = makeState({ readPointer: existing })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result.readPointer).toBe(existing)
    })
  })

  describe('room-specific options', () => {
    it('increments mentionsCount when incrementMentions is true', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, { incrementMentions: true })
      expect(result.mentionsCount).toBe(1)
      expect(result.unreadCount).toBe(1)
    })

    it('does not increment unread when incrementUnread is false', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, { incrementUnread: false })
      expect(result.unreadCount).toBe(0)
    })

    it('handles multiple increments correctly', () => {
      let state = makeState()
      state = onMessageReceived(state, makeMsg({ id: 'm1' }), INACTIVE_HIDDEN, { incrementMentions: true })
      state = onMessageReceived(state, makeMsg({ id: 'm2' }), INACTIVE_HIDDEN, { incrementMentions: false })
      state = onMessageReceived(state, makeMsg({ id: 'm3' }), INACTIVE_HIDDEN, { incrementMentions: true })
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
    const result = onActivate(state, messages)
    // msg-3 is outgoing, so marker should be at msg-4
    expect(result.firstNewMessageId).toBe('msg-4')
  })

  it('skips outgoing messages when finding marker position', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-2') })
    const result = onActivate(state, messages)
    expect(result.firstNewMessageId).toBe('msg-4') // skips msg-3 (outgoing)
  })

  it('includes delayed messages when finding marker position (offline delivery)', () => {
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'a', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'b', timestamp: new Date('2025-01-15T09:30:00Z'), isDelayed: true }),
      makeMsg({ id: 'c', timestamp: new Date('2025-01-15T10:00:00Z') }),
    ]
    const state = makeState({ readPointer: seenIn(msgs, 'a') })
    const result = onActivate(state, msgs, { treatDelayedAsNew: true })
    // Delayed messages are valid new messages (offline delivery in 1:1 chats)
    expect(result.firstNewMessageId).toBe('b')
  })

  it('sets no marker when the read pointer is at the last message', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-5') })
    const result = onActivate(state, messages)
    expect(result.firstNewMessageId).toBeUndefined()
  })

  it('clears unreadCount and mentionsCount', () => {
    const state = makeState({ unreadCount: 5, mentionsCount: 2, readPointer: seenIn(messages, 'msg-2') })
    const result = onActivate(state, messages)
    expect(result.unreadCount).toBe(0)
    expect(result.mentionsCount).toBe(0)
  })

  // Replaces 'updates lastReadAt to last message timestamp' (#1081). Activation
  // used to stamp a second read field with the NEWEST loaded message's time
  // while the position it actually held stayed at msg-2 — the two-fields drift
  // this issue removes. There is now one pointer, and activation must leave its
  // timestamp on the message it names.
  it('does not drag the read time forward to the newest loaded message', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-2') })
    const result = onActivate(state, messages)
    expect(result.readPointer).toEqual({ messageId: 'msg-2', timestamp: new Date('2025-01-15T09:30:00Z') })
    expect(result.readPointer?.timestamp).not.toEqual(new Date('2025-01-15T11:00:00Z'))
  })

  it('preserves the read pointer', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-2') })
    const result = onActivate(state, messages)
    expect(result.readPointer?.messageId).toBe('msg-2')
  })

  it('handles empty messages array', () => {
    const state = makeState({ readPointer: seenIn(messages, 'msg-1'), unreadCount: 3 })
    const result = onActivate(state, [])
    expect(result.firstNewMessageId).toBeUndefined()
    expect(result.unreadCount).toBe(0)
  })

  describe('when the read pointer is not in loaded messages (older than memory)', () => {
    it('uses the pointer timestamp as fallback to find correct marker position', () => {
      const state = makeState({
        // between msg-3 (10:00) and msg-4 (10:30)
        readPointer: seen('very-old-msg', new Date('2025-01-15T10:15:00Z')),
        unreadCount: 2,
      })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBe('msg-4')
    })

    it('timestamp fallback skips outgoing messages', () => {
      const state = makeState({
        // between msg-2 (09:30) and msg-3 (10:00, outgoing)
        readPointer: seen('very-old-msg', new Date('2025-01-15T09:45:00Z')),
        unreadCount: 2,
      })
      const result = onActivate(state, messages)
      // msg-3 is outgoing, so marker should be at msg-4
      expect(result.firstNewMessageId).toBe('msg-4')
    })

    it('uses the pointer timestamp even when unreadCount is 0 (post-restart)', () => {
      const state = makeState({
        readPointer: seen('very-old-msg', new Date('2025-01-15T10:15:00Z')),
        unreadCount: 0, // restored with nothing counted as unread
      })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBe('msg-4')
    })

    it('sets no marker when all loaded messages are before the pointer timestamp', () => {
      const state = makeState({
        // after all messages
        readPointer: seen('very-old-msg', new Date('2025-01-15T12:00:00Z')),
      })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('uses unreadCount to place marker N messages from end when the pointer has no usable time', () => {
      // 5 messages: msg-1, msg-2, msg-3(outgoing), msg-4, msg-5
      // unreadCount=2: count back 2 incoming from end → msg-5, msg-4 → marker at msg-4
      const state = makeState({ readPointer: seen('very-old-msg', NO_READ_TIME), unreadCount: 2 })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBe('msg-4')
    })

    it('places marker at first incoming when unreadCount exceeds available messages', () => {
      const state = makeState({ readPointer: seen('very-old-msg', NO_READ_TIME), unreadCount: 50 })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBe('msg-1') // first non-outgoing
    })

    it('sets no marker when the pointer has no usable time and no unread', () => {
      const state = makeState({ readPointer: seen('very-old-msg', NO_READ_TIME), unreadCount: 0 })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('resume-preserving: snaps a stale pointer to the predecessor of the derived divider', () => {
      // unreadCount=3: counting back 3 incoming from end → msg-5, msg-4, msg-2 (skips
      // outgoing msg-3) → marker at msg-2. The pointer snaps to msg-2's predecessor
      // (msg-1), NOT to the newest message (msg-5) — that would destroy the resume
      // point the marker just derived.
      const state = makeState({ readPointer: seen('very-old-msg', NO_READ_TIME), unreadCount: 3 })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBe('msg-2')
      expect(result.readPointer).toEqual(seenIn(messages, 'msg-1'))
    })

    it('timestamp fallback includes delayed messages (offline/MAM delivery)', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'old-1', timestamp: new Date('2025-01-15T09:00:00Z') }),
        makeMsg({ id: 'delayed-1', timestamp: new Date('2025-01-15T10:00:00Z'), isDelayed: true }),
        makeMsg({ id: 'delayed-2', timestamp: new Date('2025-01-15T10:30:00Z'), isDelayed: true }),
      ]
      const state = makeState({
        readPointer: seen('very-old-msg', new Date('2025-01-15T09:30:00Z')),
        unreadCount: 2,
      })
      const result = onActivate(state, msgs, { treatDelayedAsNew: true })
      expect(result.firstNewMessageId).toBe('delayed-1')
    })
  })

  describe('migration path (pointer built from a legacy lastReadAt-only conversation)', () => {
    // Pre-#1081 a conversation could hold a read TIME and no message id at all,
    // and onActivate had a dedicated branch for it. The migration turns that into
    // a pointer whose id names whatever message the cache resolved (often absent
    // from the loaded slice) and whose timestamp IS the old lastReadAt — so the
    // divider is now derived by the stale-pointer timestamp fallback instead, to
    // the same message.
    it('finds the marker from the pointer timestamp when its id is not in the slice', () => {
      const state = makeState({ readPointer: seen('resolved-elsewhere', new Date('2025-01-15T09:15:00Z')) })
      const result = onActivate(state, messages)
      // First message with timestamp > 09:15 and not outgoing = msg-2 (09:30)
      expect(result.firstNewMessageId).toBe('msg-2')
    })

    it('handles no read pointer at all with no unread', () => {
      const state = makeState()
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBeUndefined()
    })
  })

  describe('brand-new conversation (no read pointer, has unread)', () => {
    it('places marker using unreadCount', () => {
      // 5 messages: msg-1, msg-2, msg-3(outgoing), msg-4, msg-5
      // unreadCount=2: count back 2 incoming from end → msg-5, msg-4 → marker at msg-4
      const state = makeState({ unreadCount: 2 })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBe('msg-4')
    })

    it('places marker at first incoming when unreadCount exceeds messages', () => {
      const state = makeState({ unreadCount: 50 })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBe('msg-1')
    })

    it('places marker on delayed messages (offline delivery)', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'old-1', timestamp: new Date('2025-01-15T09:00:00Z') }),
        makeMsg({ id: 'new-1', timestamp: new Date('2025-01-15T10:00:00Z'), isDelayed: true }),
        makeMsg({ id: 'new-2', timestamp: new Date('2025-01-15T10:30:00Z'), isDelayed: true }),
      ]
      const state = makeState({ unreadCount: 2 })
      const result = onActivate(state, msgs, { treatDelayedAsNew: true })
      expect(result.firstNewMessageId).toBe('new-1')
    })

    it('handles empty messages', () => {
      const state = makeState({ unreadCount: 3 })
      const result = onActivate(state, [])
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('sets no marker when all messages are outgoing', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'out-1', timestamp: new Date('2025-01-15T09:00:00Z'), isOutgoing: true }),
        makeMsg({ id: 'out-2', timestamp: new Date('2025-01-15T09:30:00Z'), isOutgoing: true }),
      ]
      const state = makeState({ unreadCount: 1 })
      const result = onActivate(state, msgs)
      expect(result.firstNewMessageId).toBeUndefined()
    })
  })

  describe('room mode (treatDelayedAsNew=false): delayed = history replay, not new', () => {
    // For rooms, isDelayed means "MUC history replay" (not a new message), so the
    // marker must skip delayed messages — otherwise joining a room scrolls the user
    // into the middle of replayed history instead of to the bottom.

    it('forward scan skips delayed history after the read pointer', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'a', timestamp: new Date('2025-01-15T09:00:00Z') }),
        makeMsg({ id: 'b', timestamp: new Date('2025-01-15T09:30:00Z'), isDelayed: true }),
        makeMsg({ id: 'c', timestamp: new Date('2025-01-15T10:00:00Z'), isDelayed: true }),
      ]
      const state = makeState({ readPointer: seenIn(msgs, 'a') })
      // Only delayed (history) messages follow → no marker → scroll to bottom
      const result = onActivate(state, msgs, { treatDelayedAsNew: false })
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('forward scan lands on the first non-delayed (live) message', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'a', timestamp: new Date('2025-01-15T09:00:00Z') }),
        makeMsg({ id: 'b', timestamp: new Date('2025-01-15T09:30:00Z'), isDelayed: true }),
        makeMsg({ id: 'c', timestamp: new Date('2025-01-15T10:00:00Z') }),
      ]
      const state = makeState({ readPointer: seenIn(msgs, 'a') })
      const result = onActivate(state, msgs, { treatDelayedAsNew: false })
      expect(result.firstNewMessageId).toBe('c')
    })

    it('timestamp fallback skips delayed history', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'old-1', timestamp: new Date('2025-01-15T09:00:00Z') }),
        makeMsg({ id: 'delayed-1', timestamp: new Date('2025-01-15T10:00:00Z'), isDelayed: true }),
        makeMsg({ id: 'delayed-2', timestamp: new Date('2025-01-15T10:30:00Z'), isDelayed: true }),
      ]
      const state = makeState({
        readPointer: seen('very-old-msg', new Date('2025-01-15T09:30:00Z')),
        unreadCount: 2,
      })
      const result = onActivate(state, msgs, { treatDelayedAsNew: false })
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('brand-new room with pure history replay (all delayed) sets no marker', () => {
      // Joining a room with no prior read state: the server replays history as
      // delayed messages. None are "new", so there must be no marker → bottom.
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'h-1', timestamp: new Date('2025-01-15T09:00:00Z'), isDelayed: true }),
        makeMsg({ id: 'h-2', timestamp: new Date('2025-01-15T10:00:00Z'), isDelayed: true }),
        makeMsg({ id: 'h-3', timestamp: new Date('2025-01-15T10:30:00Z'), isDelayed: true }),
      ]
      const state = makeState({ unreadCount: 2 })
      const result = onActivate(state, msgs, { treatDelayedAsNew: false })
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('defaults to room-safe (skips delayed) when no option is passed', () => {
      const msgs: NotificationMessage[] = [
        makeMsg({ id: 'a', timestamp: new Date('2025-01-15T09:00:00Z') }),
        makeMsg({ id: 'b', timestamp: new Date('2025-01-15T09:30:00Z'), isDelayed: true }),
      ]
      const state = makeState({ readPointer: seenIn(msgs, 'a') })
      const result = onActivate(state, msgs)
      expect(result.firstNewMessageId).toBeUndefined()
    })
  })
})

describe('onActivate stale pointer (resume-preserving)', () => {
  it('snaps pointer to the message before the derived divider, not to the newest', () => {
    const mkMsg = (id: string, minutesAgo: number): NotificationMessage => ({
      id, timestamp: new Date(Date.now() - minutesAgo * 60_000), isOutgoing: false, isDelayed: true,
    })
    const state = {
      ...createInitialNotificationState(),
      readPointer: seen('evicted', new Date(Date.now() - 25 * 60_000)),
    }
    const messages = [mkMsg('a', 30), mkMsg('b', 20), mkMsg('c', 10)]
    const out = onActivate(state, messages, { treatDelayedAsNew: true })
    expect(out.firstNewMessageId).toBe('b')
    expect(out.readPointer?.messageId).toBe('a') // predecessor of divider — NOT 'c'
  })
})

describe('onMessageSeen atLiveEdge advance', () => {
  it('advances an unresolvable pointer when viewing the newest message at the live edge', () => {
    const state = { ...createInitialNotificationState(), readPointer: seen('evicted', new Date(500)) }
    const messages = [{ id: 'a', timestamp: new Date(1000) }, { id: 'b', timestamp: new Date(2000) }]
    const out = onMessageSeen(state, 'b', messages, { atLiveEdge: true })
    expect(out.readPointer).toEqual({ messageId: 'b', timestamp: new Date(2000) })
  })
  it('stays guarded off the live edge (window slid up — no regression)', () => {
    const state = { ...createInitialNotificationState(), readPointer: seen('newer-than-slice', new Date(9000)) }
    const messages = [{ id: 'a', timestamp: new Date(1000) }, { id: 'b', timestamp: new Date(2000) }]
    expect(onMessageSeen(state, 'b', messages, { atLiveEdge: false })).toBe(state)
    expect(onMessageSeen(state, 'a', messages, { atLiveEdge: true })).toBe(state) // not the newest
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
    expect(result.readPointer?.messageId).toBe('seen-1')
  })
})

// ---------------------------------------------------------------------------
// onMarkAsRead
// ---------------------------------------------------------------------------

describe('onMarkAsRead', () => {
  it('clears unreadCount and mentionsCount', () => {
    const state = makeState({ unreadCount: 5, mentionsCount: 2 })
    const result = onMarkAsRead(state)
    expect(result.unreadCount).toBe(0)
    expect(result.mentionsCount).toBe(0)
  })

  it('preserves firstNewMessageId', () => {
    const state = makeState({ firstNewMessageId: 'marker-1', unreadCount: 1 })
    const result = onMarkAsRead(state)
    expect(result.firstNewMessageId).toBe('marker-1')
  })

  it('returns same reference when nothing to change', () => {
    const state = makeState({ unreadCount: 0, mentionsCount: 0 })
    const result = onMarkAsRead(state)
    expect(result).toBe(state)
  })

  // Replaces 'uses current time when no timestamp provided' (#1081). Clearing a
  // badge is not evidence of a new read position, so marking read no longer
  // stamps a wall-clock time anywhere: with no caught-up message supplied, the
  // read position must come out byte-identical.
  it('does not invent a read position when no caught-up message is supplied', () => {
    const pointer = seen('seen-1', new Date('2025-01-15T11:00:00Z'))
    const state = makeState({ unreadCount: 1, readPointer: pointer })
    const result = onMarkAsRead(state)
    expect(result.unreadCount).toBe(0)
    expect(result.readPointer).toBe(pointer)
  })

  it('leaves the read pointer untouched when no caught-up message is given', () => {
    const pointer = seen('seen-1', new Date(1000))
    const state = makeState({ unreadCount: 3, readPointer: pointer })
    const result = onMarkAsRead(state)
    expect(result.readPointer).toBe(pointer)
  })

  it('advances the read pointer to the supplied message (pointer catches up)', () => {
    const state = makeState({ unreadCount: 3, readPointer: seen('seen-1', new Date(1000)) })
    const caughtUpTo = makeMsg({ id: 'newest-9', timestamp: new Date(9000) })
    const result = onMarkAsRead(state, caughtUpTo)
    expect(result.readPointer).toEqual({ messageId: 'newest-9', timestamp: new Date(9000) })
    expect(result.unreadCount).toBe(0)
  })

  it('advances the read pointer even when the badge is already clear', () => {
    // The IntersectionObserver may lag: unread already 0 but the pointer is behind.
    const ts = new Date('2025-01-15T12:00:00Z')
    const state = makeState({ unreadCount: 0, readPointer: seen('seen-1', new Date(1000)) })
    const result = onMarkAsRead(state, makeMsg({ id: 'newest-9', timestamp: ts }))
    expect(result).not.toBe(state)
    expect(result.readPointer).toEqual({ messageId: 'newest-9', timestamp: ts })
  })

  it('returns same reference when the supplied message is the current pointer', () => {
    const ts = new Date('2025-01-15T12:00:00Z')
    const state = makeState({ unreadCount: 0, mentionsCount: 0, readPointer: seen('seen-1', ts) })
    const result = onMarkAsRead(state, makeMsg({ id: 'seen-1', timestamp: ts }))
    expect(result).toBe(state)
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
    expect(result.readPointer?.messageId).toBe('seen-1')
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
    expect(result.readPointer?.messageId).toBe('seen-1')
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
    return { messageId: found.id, timestamp: found.timestamp }
  }

  it('sets the read pointer when none exists', () => {
    const state = makeState()
    const result = onMessageSeen(state, 'msg-3', messages)
    expect(result.readPointer).toEqual({ messageId: 'msg-3', timestamp: new Date(3000) })
  })

  it('advances forward', () => {
    const state = makeState({ readPointer: pointerAt('msg-2') })
    const result = onMessageSeen(state, 'msg-4', messages)
    expect(result.readPointer).toEqual({ messageId: 'msg-4', timestamp: new Date(4000) })
  })

  it('does not go backwards', () => {
    const state = makeState({ readPointer: pointerAt('msg-4') })
    const result = onMessageSeen(state, 'msg-2', messages)
    expect(result).toBe(state)
  })

  it('returns same reference for same message', () => {
    const state = makeState({ readPointer: pointerAt('msg-3') })
    const result = onMessageSeen(state, 'msg-3', messages)
    expect(result).toBe(state)
  })

  // #1081 constraint: the id and the timestamp of a read position move together
  // or not at all. A message the caller does not hold has no honest timestamp to
  // pair with its id, so the pointer must not move to it — under-advancing is
  // recoverable (the next viewport report re-derives), over-advancing is not.
  it('does not advance to a message that is absent from the slice', () => {
    const withPointer = makeState({ readPointer: pointerAt('msg-2') })
    expect(onMessageSeen(withPointer, 'not-in-slice', messages)).toBe(withPointer)

    const withoutPointer = makeState()
    expect(onMessageSeen(withoutPointer, 'not-in-slice', messages)).toBe(withoutPointer)
    expect(onMessageSeen(withoutPointer, 'not-in-slice', messages).readPointer).toBeUndefined()
  })

  it('preserves other fields', () => {
    const state = makeState({
      unreadCount: 3,
      firstNewMessageId: 'marker-1',
      readPointer: pointerAt('msg-1'),
    })
    const result = onMessageSeen(state, 'msg-3', messages)
    expect(result.unreadCount).toBe(3)
    expect(result.firstNewMessageId).toBe('marker-1')
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
        readPointer: { messageId: 'm5', timestamp: new Date() },
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

    // User opens conversation
    state = onActivate(state, messages)
    expect(state.firstNewMessageId).toBe('m2')
    expect(state.unreadCount).toBe(0)

    // User scrolls and sees m2 and m3 via viewport
    state = onMessageSeen(state, 'm2', messages)
    state = onMessageSeen(state, 'm3', messages)
    expect(state.readPointer).toEqual(seenIn(messages, 'm3'))

    // User switches away
    state = onDeactivate(state)
    expect(state.firstNewMessageId).toBeUndefined()
    expect(state.readPointer).toEqual(seenIn(messages, 'm3'))
  })

  it('message arrives while window hidden → window refocuses', () => {
    let state = makeState({ readPointer: seen('m1', new Date('2025-01-15T09:00:00Z')) })
    const msg = makeMsg({ id: 'm2', timestamp: new Date('2025-01-15T10:00:00Z') })

    // Message arrives while active but window hidden
    state = onMessageReceived(state, msg, ACTIVE_HIDDEN)
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
    state = onMessageReceived(state, outgoing, ACTIVE_VISIBLE)
    expect(state.unreadCount).toBe(0)
    expect(state.mentionsCount).toBe(0)
    expect(state.firstNewMessageId).toBeUndefined()
    // advanced to the outgoing message, timestamp included
    expect(state.readPointer).toEqual({ messageId: 'out-1', timestamp: outgoing.timestamp })
  })

  it('no spurious marker after user replies to a conversation', () => {
    // Regression: user reads messages, replies, then re-opens the conversation.
    // The "new messages" divider must NOT appear above messages the user already saw.
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'msg-1', timestamp: new Date() }),
      makeMsg({ id: 'msg-2', timestamp: new Date() }),
      makeMsg({ id: 'reply-1', isOutgoing: true, timestamp: new Date() }),
      makeMsg({ id: 'msg-3', timestamp: new Date() }),
      makeMsg({ id: 'reply-2', isOutgoing: true, timestamp: new Date() }),
    ]

    // User has seen everything up to msg-2
    let state = makeState({ readPointer: seenIn(msgs, 'msg-2') })

    // User sends reply-1 → the read pointer must advance
    state = onMessageReceived(state, msgs[2], ACTIVE_VISIBLE)
    expect(state.readPointer?.messageId).toBe('reply-1')

    // Incoming msg-3 arrives while user is viewing
    state = onMessageReceived(state, msgs[3], ACTIVE_VISIBLE)
    expect(state.readPointer?.messageId).toBe('msg-3')

    // User sends reply-2
    state = onMessageReceived(state, msgs[4], ACTIVE_VISIBLE)
    expect(state.readPointer?.messageId).toBe('reply-2')

    // User switches away and back
    state = onDeactivate(state)
    state = onActivate(state, msgs)

    // No new messages after reply-2 → no marker
    expect(state.firstNewMessageId).toBeUndefined()
  })

  it('switching away and back re-derives the same marker (resume-preserving stale pointer)', () => {
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'msg-100', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'msg-101', timestamp: new Date('2025-01-15T09:30:00Z') }),
      makeMsg({ id: 'msg-102', timestamp: new Date('2025-01-15T10:00:00Z') }),
      // These two are new (after the read pointer's timestamp)
      makeMsg({ id: 'msg-103', timestamp: new Date('2025-01-15T10:30:00Z') }),
      makeMsg({ id: 'msg-104', timestamp: new Date('2025-01-15T11:00:00Z') }),
    ]

    let state = makeState({
      // stale: 'msg-50' is not in msgs, so the timestamp is the usable half
      readPointer: seen('msg-50', new Date('2025-01-15T10:15:00Z')),
      unreadCount: 2,
    })

    // First activation: marker at msg-103. Resume-preserving: the pointer snaps to
    // msg-103's predecessor (msg-102), not to the newest (msg-104) — the user
    // hasn't actually seen msg-103 yet, so snapping past it would destroy the
    // resume point without the viewport ever confirming it was read.
    state = onActivate(state, msgs)
    expect(state.firstNewMessageId).toBe('msg-103')
    expect(state.readPointer).toEqual(seenIn(msgs, 'msg-102'))

    // User switches away
    state = onDeactivate(state)
    expect(state.firstNewMessageId).toBeUndefined()

    // User switches back without ever having scrolled past the marker (no
    // onMessageSeen calls) — the same unread content re-derives the same marker.
    state = onActivate(state, msgs)
    expect(state.firstNewMessageId).toBe('msg-103')
    // pointer preserved (found in array, no longer stale)
    expect(state.readPointer).toEqual(seenIn(msgs, 'msg-102'))
  })

  it('an epoch pointer timestamp does not place the marker at the beginning of history', () => {
    // Scenario: a pre-#1081 conversation that only ever had a message id migrates
    // to a pointer carrying the epoch sentinel, and that id is stale. The marker
    // must NOT be placed at the very first message just because the timestamp is
    // epoch — it falls through to the unreadCount placement.
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'msg-500', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'msg-501', timestamp: new Date('2025-01-15T09:30:00Z') }),
      makeMsg({ id: 'msg-502', timestamp: new Date('2025-01-15T10:00:00Z') }),
    ]

    const startPointer = seen('msg-1', NO_READ_TIME)
    let state = makeState({ readPointer: startPointer, unreadCount: 3 })
    const offlineMsg = makeMsg({ id: 'offline-1', isDelayed: true })
    state = onMessageReceived(state, offlineMsg, INACTIVE_HIDDEN, { treatDelayedAsNew: true })

    // An unseen arrival never moves the read position
    expect(state.readPointer).toBe(startPointer)

    // On activation with a stale pointer and no usable timestamp,
    // marker should be placed using unreadCount (4 unread: 3 original + 1 offline)
    state = onActivate(state, msgs)
    // 4 unread > 3 incoming msgs available → marker at first incoming
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

    const result = onMessageSeen(state, 'msg-100', msgs)
    // Should NOT regress to msg-100 — the stale pointer is preserved
    expect(result).toBe(state)
    expect(result.readPointer).toBe(pointer)
  })

  it('stale read pointer + unreadCount places marker correctly from end', () => {
    // After app restart: the pointer's id is stale and its timestamp is not
    // usable, unreadCount > 0. The marker should be placed N messages from the end.
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

    const result = onActivate(state, msgs)
    // 2 unread, counting back from end: 'e' (1), 'd' (2) → marker at 'd'
    // (skips 'b' because it's outgoing)
    expect(result.firstNewMessageId).toBe('d')
  })

  it('room with mentions and notifyAll', () => {
    let state = makeState()

    // Regular message (no mention)
    state = onMessageReceived(state, makeMsg({ id: 'm1' }), INACTIVE_HIDDEN, {
      incrementUnread: true,
      incrementMentions: false,
    })
    expect(state.unreadCount).toBe(1)
    expect(state.mentionsCount).toBe(0)

    // Mention message
    state = onMessageReceived(state, makeMsg({ id: 'm2', isMention: true }), INACTIVE_HIDDEN, {
      incrementUnread: true,
      incrementMentions: true,
    })
    expect(state.unreadCount).toBe(2)
    expect(state.mentionsCount).toBe(1)

    // Outgoing clears both
    state = onMessageReceived(state, makeMsg({ id: 'm3', isOutgoing: true }), ACTIVE_VISIBLE)
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
    state = onActivate(state, initialMessages)
    expect(state.firstNewMessageId).toBe('m2')
    expect(state.readPointer?.messageId).toBe('m1')

    // User scrolls and sees all messages via IntersectionObserver
    state = onMessageSeen(state, 'm3', initialMessages)
    expect(state.readPointer).toEqual(seenIn(initialMessages, 'm3'))

    // New messages arrive while user is actively viewing
    const m4 = makeMsg({ id: 'm4', timestamp: new Date('2025-01-15T10:30:00Z') })
    const m5 = makeMsg({ id: 'm5', timestamp: new Date('2025-01-15T11:00:00Z') })
    state = onMessageReceived(state, m4, ACTIVE_VISIBLE)
    state = onMessageReceived(state, m5, ACTIVE_VISIBLE)

    // the read pointer should have advanced to m5 (user sees each message)
    expect(state.readPointer).toEqual({ messageId: 'm5', timestamp: m5.timestamp })

    // User switches away
    state = onDeactivate(state)
    expect(state.firstNewMessageId).toBeUndefined()

    // User comes back — all messages including m4 and m5 are in the array now
    const allMessages: NotificationMessage[] = [
      ...initialMessages,
      m4,
      m5,
    ]
    state = onActivate(state, allMessages)

    // No new messages after m5 → no marker (not the stale marker at m2!)
    expect(state.firstNewMessageId).toBeUndefined()
    expect(state.readPointer?.messageId).toBe('m5')
  })
})

// ---------------------------------------------------------------------------
// recomputeCountsFromPointer
// ---------------------------------------------------------------------------

describe('recomputeCountsFromPointer', () => {
  const msg = (id: string, minutesAgo: number, opts: Partial<NotificationMessage> = {}): NotificationMessage => ({
    id,
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    isOutgoing: false,
    isDelayed: true, // catch-up context: everything is archive-delivered
    ...opts,
  })

  it('does not claim caught-up while an XEP-0490 marker is still pending', () => {
    const state = createInitialNotificationState()
    const messages = [msg('a', 30), msg('b', 20), msg('c', 10)]
    const out = recomputeCountsFromPointer(state, messages, { hasPendingRemoteMarker: true })
    // Untouched: the pending fold owns resolving this position.
    expect(out).toBe(state)
    expect(out.readPointer).toBeUndefined()
  })

  // Twin of the case above, for the #1081 migration: a conversation whose legacy
  // read state has not resolved into a pointer yet HAS a read position — snapping
  // to newest here retires the legacy values and, forward-only, outranks the
  // correct older pointer the next attempt would produce.
  it('does not claim caught-up while legacy read state is still un-migrated', () => {
    const state = createInitialNotificationState()
    const messages = [msg('a', 30), msg('b', 20), msg('c', 10)]
    const out = recomputeCountsFromPointer(state, messages, { hasUnmigratedLegacyReadState: true })
    expect(out).toBe(state)
    expect(out.readPointer).toBeUndefined()
  })

  it('fresh entity (no read pointer) is caught up: snaps pointer to newest, zero counts', () => {
    const state = createInitialNotificationState()
    const messages = [msg('a', 30), msg('b', 20), msg('c', 10)]
    const out = recomputeCountsFromPointer(state, messages, { countMentions: true })
    expect(out.unreadCount).toBe(0)
    expect(out.mentionsCount).toBe(0)
    expect(out.readPointer).toEqual({ messageId: 'c', timestamp: messages[2].timestamp })
  })

  it('counts incoming messages after the pointer, including delayed ones, with mentions', () => {
    const messages = [msg('a', 30), msg('b', 20, { isMention: true }), msg('c', 10)]
    const pointer = seenIn(messages, 'a')
    const state = { ...createInitialNotificationState(), readPointer: pointer }
    const out = recomputeCountsFromPointer(state, messages, { countMentions: true })
    expect(out.unreadCount).toBe(2)
    expect(out.mentionsCount).toBe(1)
    expect(out.readPointer).toBe(pointer) // pointer untouched
  })

  it('pointer id missing from slice: falls back to its own timestamp', () => {
    const state = {
      ...createInitialNotificationState(),
      readPointer: seen('gone', new Date(Date.now() - 25 * 60_000)),
    }
    const messages = [msg('a', 30), msg('b', 20), msg('c', 10)]
    const out = recomputeCountsFromPointer(state, messages)
    expect(out.unreadCount).toBe(2) // b and c are newer than the pointer's timestamp
  })

  it('pointer id missing and no usable timestamp: counts the whole slice (lower bound)', () => {
    const state = { ...createInitialNotificationState(), readPointer: seen('gone', NO_READ_TIME) }
    const messages = [msg('a', 30), msg('b', 20)]
    const out = recomputeCountsFromPointer(state, messages)
    expect(out.unreadCount).toBe(2)
  })

  it('an outgoing message in range marks everything before it read and advances the pointer', () => {
    const messages = [msg('a', 40), msg('b', 30), msg('mine', 20, { isOutgoing: true }), msg('c', 10)]
    const state = { ...createInitialNotificationState(), readPointer: seenIn(messages, 'a') }
    const out = recomputeCountsFromPointer(state, messages)
    expect(out.unreadCount).toBe(1) // only c
    expect(out.readPointer).toEqual(seenIn(messages, 'mine'))
  })

  it('returns the same reference when nothing changes', () => {
    const messages = [msg('a', 30), msg('b', 20)]
    const state = { ...createInitialNotificationState(), readPointer: seenIn(messages, 'b'), unreadCount: 0 }
    expect(recomputeCountsFromPointer(state, messages)).toBe(state)
  })

  it('empty slice returns the same reference', () => {
    const state = { ...createInitialNotificationState(), readPointer: seen('x', new Date(1000)), unreadCount: 3 }
    expect(recomputeCountsFromPointer(state, [])).toBe(state)
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

  it('onMessageReceived writes the whole pointer for an outgoing message', () => {
    const out = notifState.onMessageReceived(
      base(),
      msg('m1', 1000, { isOutgoing: true }),
      { isActive: false, windowVisible: false }
    )
    // Whole-object assertion: a write that got the timestamp from anywhere but
    // the message itself fails here.
    expect(out.readPointer).toEqual({ messageId: 'm1', timestamp: new Date(1000) })
  })

  it('onMessageReceived writes the whole pointer when the user sees the message', () => {
    const out = notifState.onMessageReceived(
      base(),
      msg('m2', 2000),
      { isActive: true, windowVisible: true }
    )
    expect(out.readPointer).toEqual({ messageId: 'm2', timestamp: new Date(2000) })
  })

  it('onMessageSeen resolves the timestamp from the messages array', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000), msg('m3', 3000)]
    const start = { ...base(), readPointer: { messageId: 'm1', timestamp: new Date(1000) } }
    const out = notifState.onMessageSeen(start, 'm3', messages)
    expect(out.readPointer).toEqual({ messageId: 'm3', timestamp: new Date(3000) })
  })

  it('onMessageSeen leaves the pointer put when it does not advance', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000)]
    const pointer = { messageId: 'm2', timestamp: new Date(2000) }
    const start = { ...base(), readPointer: pointer }
    const out = notifState.onMessageSeen(start, 'm1', messages)
    expect(out.readPointer).toBe(pointer)
  })
})

describe('readPointer on the remaining pointer-writing transitions (#1081)', () => {
  const base = () => notifState.createInitialNotificationState()
  const msg = (id: string, ms: number, over: Partial<NotificationMessage> = {}): NotificationMessage => ({
    id, timestamp: new Date(ms), isOutgoing: false, ...over,
  })

  it('onMessageReceived keeps the pointer put for an unseen incoming message', () => {
    const pointer = { messageId: 'm1', timestamp: new Date(1000) }
    const start = { ...base(), readPointer: pointer }
    const out = notifState.onMessageReceived(start, msg('m2', 2000), { isActive: false, windowVisible: false })
    expect(out.readPointer).toBe(pointer)
  })

  it('onActivate resolves the pointer to the position it lands on', () => {
    // Stale pointer (id not in the slice) with a usable timestamp: the divider
    // derives at m2, so the pointer snaps to the message just before it — and
    // takes THAT message's timestamp, not the stale one it came in with.
    const messages = [msg('m1', 1000), msg('m2', 2000), msg('m3', 3000)]
    const start = { ...base(), readPointer: { messageId: 'gone', timestamp: new Date(1500) }, unreadCount: 2 }
    const out = notifState.onActivate(start, messages, { treatDelayedAsNew: true })
    expect(out.firstNewMessageId).toBe('m2')
    expect(out.readPointer).toEqual({ messageId: 'm1', timestamp: new Date(1000) })
  })

  it('onActivate resolves the pointer even when the position does not move', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000), msg('m3', 3000)]
    const start = { ...base(), readPointer: { messageId: 'm2', timestamp: new Date(2000) }, unreadCount: 1 }
    const out = notifState.onActivate(start, messages)
    expect(out.readPointer).toEqual({ messageId: 'm2', timestamp: new Date(2000) })
  })

  it('onMarkAsRead writes the whole pointer when the caller supplies the caught-up message', () => {
    const start = {
      ...base(),
      unreadCount: 3,
      readPointer: { messageId: 'm1', timestamp: new Date(1000) },
    }
    const out = notifState.onMarkAsRead(start, msg('m3', 3000))
    expect(out.readPointer).toEqual({ messageId: 'm3', timestamp: new Date(3000) })
  })

  it('onMarkAsRead leaves the pointer put when the window is off the live edge', () => {
    const pointer = { messageId: 'm1', timestamp: new Date(1000) }
    const start = { ...base(), unreadCount: 3, readPointer: pointer }
    const out = notifState.onMarkAsRead(start)
    expect(out.readPointer).toBe(pointer)
  })

  it('recomputeCountsFromPointer writes the whole pointer on the fresh-entity guard', () => {
    const messages = [msg('a', 1000), msg('b', 2000)]
    const out = notifState.recomputeCountsFromPointer(base(), messages)
    expect(out.readPointer).toEqual({ messageId: 'b', timestamp: new Date(2000) })
  })

  it('recomputeCountsFromPointer writes the whole pointer when an outgoing message moves it', () => {
    const messages = [msg('a', 1000), msg('b', 2000), msg('mine', 3000, { isOutgoing: true }), msg('c', 4000)]
    const start = { ...base(), readPointer: { messageId: 'a', timestamp: new Date(1000) } }
    const out = notifState.recomputeCountsFromPointer(start, messages)
    expect(out.unreadCount).toBe(1)
    expect(out.readPointer).toEqual({ messageId: 'mine', timestamp: new Date(3000) })
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
    // Tagged so a failure names the transition that broke the invariant. The
    // whole pointer is compared, so a right-id/wrong-timestamp pair fails.
    const coherent = (st: EntityNotificationState, label: string) => {
      const p = st.readPointer
      expect(`${label}: ${JSON.stringify(p)}`).toBe(
        `${label}: ${JSON.stringify(p && { messageId: p.messageId, timestamp: byId.get(p.messageId) })}`
      )
    }

    let s: EntityNotificationState = base()
    s = notifState.onMessageReceived(s, messages[0], { isActive: false, windowVisible: false })
    coherent(s, 'onMessageReceived (unseen)')
    s = notifState.onMessageReceived(s, messages[1], { isActive: true, windowVisible: true })
    coherent(s, 'onMessageReceived (seen)')
    s = notifState.onMessageReceived(s, messages[2], { isActive: false, windowVisible: false })
    coherent(s, 'onMessageReceived (outgoing)')
    s = notifState.onMessageReceived(s, messages[3], { isActive: false, windowVisible: false })
    coherent(s, 'onMessageReceived (unseen again)')
    s = notifState.onActivate(s, messages, { treatDelayedAsNew: true })
    coherent(s, 'onActivate')
    s = notifState.onMessageSeen(s, 'm4', messages)
    coherent(s, 'onMessageSeen')
    s = notifState.onDeactivate(s)
    coherent(s, 'onDeactivate')
    s = notifState.recomputeCountsFromPointer(s, messages)
    coherent(s, 'recomputeCountsFromPointer')
    s = notifState.onMarkAsRead(s, messages[3])
    coherent(s, 'onMarkAsRead')
    s = notifState.onWindowBecameVisible(s, true)
    coherent(s, 'onWindowBecameVisible')
    s = notifState.onClearMarker(s)
    coherent(s, 'onClearMarker')
    expect(s.readPointer?.messageId).toBe('m4')
  })
})
