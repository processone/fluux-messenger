/**
 * A reused MUC nick, carried across the SDK boundary.
 *
 * XEP-0421 lets a room reassign a nick once its owner leaves. Two occupants can
 * then produce rows sharing a room, a `from` and a client id — client ids carry
 * no uniqueness guarantee (`docs/MESSAGE_IDENTIFIERS.md`) — and only the
 * occupant-id separates them.
 *
 * These are the read-state consequences of that collision, at the seams where a
 * bare client id used to arrive: the viewport report, the divider, the load-around
 * anchor derived from the pointer. Each one selects the row the reader actually
 * reached rather than whichever copy the resident array happens to hold first.
 */
import { describe, it, expect } from 'vitest'
import {
  onActivate,
  onMessageSeen,
  shouldNotifyConversation,
  createInitialNotificationState,
  type NotificationMessage,
} from './notificationState'
import { makeReadPointer, pointerRowRef, serializeReadPointer, deserializeReadPointer } from './readPointer'
import { advanceDividerToRemoteRead } from './dividerAdvance'
import { findMessageRowIndex, messageRowRef, selectOccupantRow } from '../../utils/messageIdentity'

const ROOM = 'room@conference.example.com'
const NICK = `${ROOM}/alice`

/** Occupant A's message. Departed; the nick was handed on. */
const fromA: NotificationMessage & { from: string; occupantId: string } = {
  id: 'shared-id',
  from: NICK,
  occupantId: 'occupant-a',
  timestamp: new Date(1000),
  isOutgoing: false,
  body: 'written by the first alice',
}

/** Occupant B's message. Same nick, same client id, later. */
const fromB: NotificationMessage & { from: string; occupantId: string } = {
  id: 'shared-id',
  from: NICK,
  occupantId: 'occupant-b',
  timestamp: new Date(3000),
  isOutgoing: false,
  body: 'written by the second alice',
}

const messages = [fromA, fromB]

describe('row selection under an occupant collision', () => {
  it('picks the exact occupant, not the first row sharing the client id', () => {
    expect(findMessageRowIndex(messages, { id: 'shared-id', occupantId: 'occupant-b' })).toBe(1)
    expect(findMessageRowIndex(messages, { id: 'shared-id', occupantId: 'occupant-a' })).toBe(0)
  })

  it('takes the first candidate when the ref names no occupant', () => {
    // No evidence was supplied, so there is nothing to choose with. Stated rather
    // than left implicit: this is the pre-XEP-0421 and local-echo behaviour.
    expect(findMessageRowIndex(messages, { id: 'shared-id' })).toBe(0)
  })

  it('refuses a row every candidate conflicts with', () => {
    expect(findMessageRowIndex(messages, { id: 'shared-id', occupantId: 'occupant-c' })).toBe(-1)
  })

  it('does not let an absent occupant-id separate two copies', () => {
    const occupantless = [{ id: 'shared-id', from: NICK, timestamp: new Date(1000), isOutgoing: false }]
    expect(findMessageRowIndex(occupantless, { id: 'shared-id', occupantId: 'occupant-b' })).toBe(0)
    expect(selectOccupantRow({ occupantId: 'occupant-b' }, [{ occupantId: undefined }])).toBeDefined()
  })
})

describe('the read pointer lands on the row the viewport reported', () => {
  it('advances to the reported occupant rather than the earlier same-id row', () => {
    const seen = onMessageSeen(
      createInitialNotificationState(),
      messageRowRef(fromB),
      messages,
      'room'
    )
    expect(seen.readPointer?.order.timestamp).toBe(3000)
    expect(seen.readPointer?.identity.occupantId).toBe('occupant-b')
  })

  it('still reaches the earlier occupant when that is the row reported', () => {
    const seen = onMessageSeen(
      createInitialNotificationState(),
      messageRowRef(fromA),
      messages,
      'room'
    )
    expect(seen.readPointer?.order.timestamp).toBe(1000)
    expect(seen.readPointer?.identity.occupantId).toBe('occupant-a')
  })

  it('does not advance a pointer already on the later occupant', () => {
    const state = { ...createInitialNotificationState(), readPointer: makeReadPointer(fromB, 'room') }
    expect(onMessageSeen(state, messageRowRef(fromA), messages, 'room')).toBe(state)
  })

  it('names the row, occupant included, when the pointer becomes a load-around anchor', () => {
    const pointer = makeReadPointer(fromB, 'room')
    expect(pointerRowRef(pointer)).toEqual({ id: 'shared-id', occupantId: 'occupant-b' })
  })

  it('keeps the occupant across a persistence round trip', () => {
    const pointer = makeReadPointer(fromB, 'room')
    const restored = deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(pointer))))
    expect(restored?.identity.occupantId).toBe('occupant-b')
    expect(pointerRowRef(restored!)).toEqual({ id: 'shared-id', occupantId: 'occupant-b' })
  })

  it('hydrates a pointer written before the field existed, unchanged', () => {
    // The fallback path for every pointer already on disk: no occupant-id, and so
    // exactly the pre-existing resolution — an absent id is never evidence.
    const legacy = deserializeReadPointer({
      order: { role: 'exact', timestamp: 3000, tiebreak: { kind: 'room', from: NICK } },
      identity: { state: 'local', messageId: 'shared-id' },
    })
    expect(legacy?.identity.occupantId).toBeUndefined()
    expect(pointerRowRef(legacy!)).toEqual({ id: 'shared-id' })
    expect(findMessageRowIndex(messages, pointerRowRef(legacy!))).toBe(0)
  })
})

describe('the divider names a row, not a client id', () => {
  it('carries the occupant of the first unread row', () => {
    const state = { ...createInitialNotificationState(), readPointer: makeReadPointer(fromA, 'room') }
    // Occupant A's row is the read position; B's is the first unread one, and the
    // marker has to say so — naming only "shared-id" would draw the line above A,
    // which the pointer is already past.
    expect(onActivate(state, messages, 'room').firstNewMessageRow).toEqual({
      id: 'shared-id',
      occupantId: 'occupant-b',
    })
  })

  it('orders two same-id rows when a remote marker moves the line', () => {
    const parked = { id: 'shared-id', occupantId: 'occupant-a' }
    const remote = { id: 'shared-id', occupantId: 'occupant-b' }
    expect(advanceDividerToRemoteRead(parked, remote, messages)).toBe(remote)
    expect(advanceDividerToRemoteRead(remote, parked, messages)).toBe(remote)
  })
})

describe('notification suppression respects the occupant boundary', () => {
  const ctx = { isActive: false, windowVisible: false, unreadCount: 1 }

  it('does not silence the OTHER occupant sharing the pointer id', () => {
    expect(shouldNotifyConversation(fromB, { ...ctx, readPointer: makeReadPointer(fromA, 'room') })).toBe(true)
  })

  it('still silences the row the pointer names', () => {
    expect(shouldNotifyConversation(fromA, { ...ctx, readPointer: makeReadPointer(fromA, 'room') })).toBe(false)
  })
})
