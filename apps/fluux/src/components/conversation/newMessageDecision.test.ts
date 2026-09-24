import { describe, it, expect } from 'vitest'
import { decideOnNewMessage, type NewMessageFacts } from './newMessageDecision'

const facts = (over: Partial<NewMessageFacts> = {}): NewMessageFacts => ({
  messageCount: 10,
  previousMessageCount: 10,
  lastMessageId: 'm-10',
  previousLastMessageId: 'm-10',
  lastMessageIsOutgoing: false,
  atBottom: true,
  savedPositionPending: false,
  directionalHistoryPending: false,
  ...over,
})

const arrived = (over: Partial<NewMessageFacts> = {}): NewMessageFacts =>
  facts({ messageCount: 11, previousMessageCount: 10, lastMessageId: 'm-11', ...over })

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
    const replaced = facts({ lastMessageId: 'server-9', previousLastMessageId: 'local-9' })
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
})
