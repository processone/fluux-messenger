import { describe, it, expect } from 'vitest'
import { computeMessageActions } from './messageActionCapabilities'

const base = {
  isOutgoing: true, isPrivate: false, isLastOutgoing: true, isLastMessage: false,
  inThread: false, counterpartGone: false, isIrcGateway: false, canModerate: false,
  reactionsEnabled: true,
}

describe('computeMessageActions', () => {
  it('public own last message: edit/delete/react/reply all allowed', () => {
    const a = computeMessageActions(base)
    expect(a).toEqual({ canReply: true, canEdit: true, canDelete: true, canReact: true })
  })

  it('whisper with the counterpart gone: every action disabled', () => {
    const a = computeMessageActions({ ...base, isPrivate: true, inThread: true, counterpartGone: true })
    expect(a).toEqual({ canReply: false, canEdit: false, canDelete: false, canReact: false })
  })

  it('incoming whisper: no moderation-based delete even for a moderator', () => {
    const a = computeMessageActions({
      ...base, isOutgoing: false, isPrivate: true, inThread: true, isLastOutgoing: false, canModerate: true,
    })
    expect(a.canDelete).toBe(false) // private message cannot be moderated
    expect(a.canReact).toBe(true)   // can still react while counterpart present
  })

  it('public message a moderator can delete: moderation delete still allowed', () => {
    const a = computeMessageActions({
      ...base, isOutgoing: false, isLastOutgoing: false, canModerate: true,
    })
    expect(a.canDelete).toBe(true)
  })

  it('IRC gateway: no edit/delete', () => {
    const a = computeMessageActions({ ...base, isIrcGateway: true })
    expect(a.canEdit).toBe(false)
    expect(a.canDelete).toBe(false)
  })
})
