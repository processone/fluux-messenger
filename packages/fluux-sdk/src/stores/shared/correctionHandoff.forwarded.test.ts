import { describe, expect, it } from 'vitest'
import type { Message } from '../../core/types'
import { reconcileCorrectionHandoff } from './correctionHandoff'

const row = (over: Partial<Message> = {}): Message => ({
  type: 'chat', id: 'm1', stanzaId: undefined, originId: undefined, conversationId: 'bob@example.org', from: 'bob@example.org',
  body: 'look', timestamp: new Date(1000), isOutgoing: false, ...over,
})
const copy = { author: 'Bob', text: 'Ship it' }

// A cached row that was retracted or recovered after decryption reaches the resident row through this handoff.
describe('reconcileCorrectionHandoff and a forwarded copy', () => {
  it('removes the copy from the resident row when the cached row is retracted', () => {
    const held = row({ forwarded: copy })
    const incoming = row({ forwarded: copy, isRetracted: true, retractedAt: new Date(2000), isEdited: true })
    expect(reconcileCorrectionHandoff(held, incoming, null)).toMatchObject({ isRetracted: true, forwarded: undefined })
  })

  it('carries a copy recovered after decryption into the resident row', () => {
    const held = row({ body: '[could not decrypt]' })
    const incoming = row({ forwarded: copy, isEdited: true })
    expect(reconcileCorrectionHandoff(held, incoming, null)?.forwarded).toEqual(copy)
  })
})
