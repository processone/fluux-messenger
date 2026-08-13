import { describe, it, expect } from 'vitest'
import { decideMdsSettle, type MdsSettleFacts } from './mdsSettleDecision'

/** A divider that has just been cleared by a late read-sync, with nothing else in the way. */
const settling: MdsSettleFacts = {
  staticMode: false,
  sameConversation: true,
  previousDivider: 'msg-42',
  currentDivider: undefined,
  hasGenuineInput: false,
}

describe('decideMdsSettle', () => {
  it('settles when the divider was cleared under a reader who has not moved', () => {
    expect(decideMdsSettle(settling)).toBe('settle')
  })

  it('skips in static mode, which has no positioning owner', () => {
    expect(decideMdsSettle({ ...settling, staticMode: true })).toBe('skip')
  })

  // The divider that vanished belonged to the conversation being left. Settling the newly-entered
  // one to its bottom would override the entry position it just chose.
  it('skips across a conversation switch', () => {
    expect(decideMdsSettle({ ...settling, sameConversation: false })).toBe('skip')
  })

  it('skips when there was no divider to clear', () => {
    expect(decideMdsSettle({ ...settling, previousDivider: undefined })).toBe('skip')
  })

  it('skips while a divider is still showing', () => {
    expect(decideMdsSettle({ ...settling, currentDivider: 'msg-42' })).toBe('skip')
  })

  it('skips when the divider merely moved rather than cleared', () => {
    expect(decideMdsSettle({ ...settling, currentDivider: 'msg-99' })).toBe('skip')
  })

  // A marker arriving from another device must not pull the reader off a position they chose.
  it('skips when the reader has moved the list themselves', () => {
    expect(decideMdsSettle({ ...settling, hasGenuineInput: true })).toBe('skip')
  })

  it('needs every condition at once', () => {
    const broken: Partial<MdsSettleFacts>[] = [
      { staticMode: true },
      { sameConversation: false },
      { previousDivider: undefined },
      { currentDivider: 'msg-7' },
      { hasGenuineInput: true },
    ]
    for (const override of broken) {
      expect(decideMdsSettle({ ...settling, ...override })).toBe('skip')
    }
  })
})
