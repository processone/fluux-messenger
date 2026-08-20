/**
 * The "New messages" divider is a landmark, not a cursor.
 *
 * It marks where the unread messages began when this view was opened. The read pointer moves
 * underneath it while the reader scrolls — that is genuine read state, and it still drives receipts
 * and the XEP-0490 marker other devices see — but deriving the divider's POSITION from that pointer
 * walks the line down the screen while the reader is looking at it. Placing it belongs to
 * activation; removing it belongs to read-through scroll, Esc, mark-all-read and deactivation.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { chatStore } from './chatStore'
import type { Message } from '../core'
import { makeReadPointer } from './shared/readPointer'

const CID = 'alice@example.com'

function msg(id: string): Message {
  return {
    id,
    stanzaId: `stanza-${id}`,
    conversationId: CID,
    from: CID,
    body: id,
    timestamp: new Date(2024, 0, 1, 12, Number(id.replace(/\D/g, '')) || 0),
    isOutgoing: false,
    isDelayed: false,
    type: 'chat' as const,
  }
}

const MESSAGES = [msg('m0'), msg('m1'), msg('m2'), msg('m3'), msg('m4')]

/** Parks a divider at `marker` with the pointer already read down to `lastSeen`. */
function seedActive(lastSeen: string, marker: string) {
  const seen = MESSAGES.find((m) => m.id === lastSeen)!
  chatStore.setState({
    activeConversationId: CID,
    conversationMeta: new Map([[CID, { unreadCount: 0, readPointer: makeReadPointer(seen, 'chat') }]]),
    messages: new Map([[CID, MESSAGES]]),
    firstNewMessageMarkers: new Map([[CID, marker]]),
    conversations: new Map(),
  })
}

describe('the active conversation keeps the divider its view opened with', () => {
  beforeEach(() => {
    chatStore.getState().clearFirstNewMessageId(CID)
    chatStore.setState({
      activeConversationId: undefined,
      conversationMeta: new Map(),
      messages: new Map(),
      firstNewMessageMarkers: new Map(),
      conversations: new Map(),
    })
  })

  it('follows a read marker another device published past the line', () => {
    // A marker from a second client is not navigation, it is a statement that those messages were
    // read. Leaving the line in front of them would label as new what the user has already seen.
    seedActive('m1', 'm1')
    const before = chatStore.getState().conversationMeta.get(CID)?.readPointer

    chatStore.getState().applyRemoteDisplayed(CID, 'stanza-m3', MESSAGES)

    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m4')
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).not.toEqual(before)
  })

  it('follows a remote marker behind the local pointer', () => {
    seedActive('m4', 'm1')

    chatStore.getState().applyRemoteDisplayed(CID, 'stanza-m2', MESSAGES)

    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m4')
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m3')
  })

  it('follows a remote marker once its successor becomes resident', () => {
    seedActive('m2', 'm1')

    chatStore.getState().applyRemoteDisplayed(CID, 'stanza-m4', MESSAGES)
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m1')

    chatStore.getState().addMessage(msg('m5'))

    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m5')
  })

  it('does not restore a cleared line when a deferred successor arrives', () => {
    seedActive('m2', 'm1')

    chatStore.getState().applyRemoteDisplayed(CID, 'stanza-m4', MESSAGES)
    chatStore.getState().clearFirstNewMessageId(CID)
    chatStore.getState().addMessage(msg('m5'))

    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBeUndefined()
  })

  it('does not resurrect a line the reader cleared', () => {
    // Clearing is deliberate — Esc, mark-all-read, sending. A later marker moves the pointer and
    // the count, and must not put the landmark back on screen.
    seedActive('m1', 'm1')
    chatStore.setState({ firstNewMessageMarkers: new Map() })

    chatStore.getState().applyRemoteDisplayed(CID, 'stanza-m3', MESSAGES)

    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBeUndefined()
  })

  it('never walks the line backwards', () => {
    // The marker must genuinely advance the pointer, or the resolution never reaches the divider at
    // all and this would assert nothing. Pointer at m0 and the line parked further down at m4: the
    // marker advances the pointer to m2, whose first unread is m3 — BEHIND the line. Read state
    // moved forward; the landmark must not slide back up the screen to meet it.
    seedActive('m0', 'm4')

    chatStore.getState().applyRemoteDisplayed(CID, 'stanza-m2', MESSAGES)

    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m2')
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m4')
  })

  it('leaves the line alone when it sits outside the loaded slice', () => {
    // A line parked from a slice that has since been windowed out cannot be ordered against the
    // marker's boundary. Moving it would be a guess, and the guess lands the reader somewhere they
    // never were.
    seedActive('m0', 'windowed-out')

    chatStore.getState().applyRemoteDisplayed(CID, 'stanza-m2', MESSAGES)

    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m2')
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('windowed-out')
  })

  it('does not walk the divider forward when the read pointer has advanced past it', () => {
    // The reader opened on m1 and has scrolled down to m3. Re-deriving from the pointer would put
    // the line at m4 — under the reader's eyes, and no longer marking what they came back to.
    seedActive('m3', 'm1')
    chatStore.getState().resyncDividerToReadPointer(CID)
    // The SDK primitive still repositions on demand: the app simply stops asking.
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m4')

    seedActive('m3', 'm1')
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m1')
  })
})
