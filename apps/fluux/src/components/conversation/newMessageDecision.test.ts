import { describe, it, expect } from 'vitest'
import { decideOnNewMessage, type NewMessageFacts } from './newMessageDecision'

const facts = (over: Partial<NewMessageFacts> = {}): NewMessageFacts => ({
  messageCount: 10,
  baselineMessageCount: 10,
  lastMessageId: 'm-10',
  baselineLastMessageId: 'm-10',
  lastMessageIsOutgoing: false,
  atBottom: true,
  savedPositionPending: false,
  directionalHistoryPending: false,
  windowAtLiveEdge: true,
  baselineWindowAtLiveEdge: true,
  ...over,
})

const arrived = (over: Partial<NewMessageFacts> = {}): NewMessageFacts =>
  facts({ messageCount: 11, baselineMessageCount: 10, lastMessageId: 'm-11', ...over })

describe('decideOnNewMessage', () => {
  it('follows the live edge for an arrival the reader is already watching', () => {
    expect(decideOnNewMessage(arrived())).toBe('follow-incoming')
  })

  it('holds position for an arrival while the reader is scrolled up', () => {
    // The one rule a reader notices immediately when it breaks: an incoming message must not
    // yank them out of the history they are reading.
    expect(decideOnNewMessage(arrived({ atBottom: false }))).toBe('hold-incoming')
  })

  it('follows the reader own send from anywhere in the history', () => {
    expect(decideOnNewMessage(arrived({ atBottom: false, lastMessageIsOutgoing: true })))
      .toBe('follow-outgoing')
  })

  it('treats a replaced bottom row as a new one', () => {
    // A send reconciling to its server id replaces the optimistic row in place, so the count
    // does not move. Keying on the count alone is the "my message did not scroll" bug.
    const replaced = facts({ lastMessageId: 'server-9', baselineLastMessageId: 'local-9' })
    expect(decideOnNewMessage(replaced)).toBe('follow-incoming')
    expect(decideOnNewMessage({ ...replaced, lastMessageIsOutgoing: true })).toBe('follow-outgoing')
  })

  it('says so when nothing about the bottom row changed', () => {
    expect(decideOnNewMessage(facts())).toBe('no-bottom-row')
    // An id that has not arrived yet is not a change either.
    expect(decideOnNewMessage(facts({ lastMessageId: undefined }))).toBe('no-bottom-row')
  })

  it('leaves a pending restore alone, and still follows the reader own send', () => {
    const pending = arrived({ savedPositionPending: true, atBottom: false })
    expect(decideOnNewMessage(pending)).toBe('restore-pending')
    expect(decideOnNewMessage({ ...pending, lastMessageIsOutgoing: true }))
      .toBe('outgoing-during-restore')
  })

  it('leaves a pending prepend alone, and still follows the reader own send', () => {
    const pending = arrived({ directionalHistoryPending: true, atBottom: false })
    expect(decideOnNewMessage(pending)).toBe('prepend-pending')
    expect(decideOnNewMessage({ ...pending, lastMessageIsOutgoing: true }))
      .toBe('outgoing-during-prepend')
  })

  it('answers for a pending restore even when no new row arrived', () => {
    // The restore branches run before the bottom-row comparison: a commit during a restore is
    // about the restore, whatever else it carries.
    expect(decideOnNewMessage(facts({ savedPositionPending: true }))).toBe('restore-pending')
    expect(decideOnNewMessage(facts({ directionalHistoryPending: true }))).toBe('prepend-pending')
  })

  it('prefers the saved-position restore when both are pending', () => {
    const both = arrived({ savedPositionPending: true, directionalHistoryPending: true })
    expect(decideOnNewMessage(both)).toBe('restore-pending')
  })

  // Scrolling back through a chat longer than the resident window kept snapping back to the
  // newest messages. A pull past the bound trims the newest rows, so the bottom row changes with
  // nothing sent or received; when the new bottom row was the reader's own, it was followed, and
  // the pin at the bottom of the slid window loaded newer history until the window was back at the
  // newest messages. The next pull up slid it back, and the reader never got further.
  describe('when the resident window slides', () => {
    /** A pull at the bound: same count, the bottom row is now an older one. */
    const slidBack = (over: Partial<NewMessageFacts> = {}) => facts({
      messageCount: 100,
      baselineMessageCount: 100,
      lastMessageId: 'm-49',
      baselineLastMessageId: 'm-99',
      windowAtLiveEdge: false,
      baselineWindowAtLiveEdge: true,
      atBottom: false,
      ...over,
    })

    it('does not follow the reader own message that a slide into history left at the bottom', () => {
      expect(decideOnNewMessage(slidBack({ lastMessageIsOutgoing: true }))).toBe('window-slid')
    })

    it('does not follow an incoming bottom row a slide brought, even from the bottom', () => {
      expect(decideOnNewMessage(slidBack({ atBottom: true }))).toBe('window-slid')
    })

    it('keeps slides deeper into history, and back towards the newest, from being arrivals', () => {
      // Already parked: the next pull up, or a load of newer history from the parked bottom.
      const parked = slidBack({ baselineWindowAtLiveEdge: false, atBottom: true })
      expect(decideOnNewMessage(parked)).toBe('window-slid')
      expect(decideOnNewMessage({ ...parked, lastMessageIsOutgoing: true })).toBe('window-slid')
      // Newer history reached the end: the window is at the newest messages again.
      const returned = slidBack({
        lastMessageId: 'm-149',
        baselineLastMessageId: 'm-99',
        windowAtLiveEdge: true,
        baselineWindowAtLiveEdge: false,
        lastMessageIsOutgoing: true,
      })
      expect(decideOnNewMessage(returned)).toBe('window-slid')
    })

    it('leaves a pending prepend or restore in charge when the slide left an own message at the bottom', () => {
      const own = { lastMessageIsOutgoing: true }
      expect(decideOnNewMessage(slidBack({ ...own, directionalHistoryPending: true }))).toBe('prepend-pending')
      expect(decideOnNewMessage(slidBack({ ...own, savedPositionPending: true }))).toBe('restore-pending')
    })

    it('is not fooled by the trim of a full window at the newest messages', () => {
      // A send into a full window evicts the OLDEST row: the count holds and the bottom row is new,
      // like a slide, but the window never left the newest messages. It is the reader's send.
      const send = facts({ lastMessageId: 'm-11', lastMessageIsOutgoing: true, atBottom: false })
      expect(decideOnNewMessage(send)).toBe('follow-outgoing')
    })
  })
})
