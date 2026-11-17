import { describe, expect, it } from 'vitest'
import type { Conversation, Message } from '@fluux/sdk'
import { buildLocalMessageNotification } from './localMessageNotification'
import { formatLocalizedPreview } from './messagePreviewText'

// Review: a forwarded copy without a comment is a real message, so the conversation list and the notification show its text.
const t = (key: string) => key
const message = (fields: Partial<Message>) => ({ id: 'one', type: 'chat', conversationId: 'alice@example.test', from: 'alice@example.test',
  timestamp: new Date(0), isOutgoing: false, body: '', ...fields }) as Message
const entity = { id: 'alice@example.test', name: 'Alice', unreadCount: 1 } as Conversation

describe('copy-only forwarded message', () => {
  const forwarded = { author: 'Bob', text: 'Ship it' }

  it('previews as the copied text in the conversation list', () => {
    expect(formatLocalizedPreview(message({ forwarded }), t)).toBe('Ship it')
  })

  it.each([false, true])('raises a notification with the copied text (web: %s)', web => {
    const built = buildLocalMessageNotification({ kind: 'chat', entity, message: message({ forwarded }) }, t, 'en', web)
    expect(built).toMatchObject({ title: 'Alice', body: 'Ship it' })
  })

  it('shows the deleted notice, not the copy, once the message is retracted', () => {
    expect(formatLocalizedPreview(message({ forwarded: undefined, isRetracted: true }), t)).toBe('chat.messageDeleted')
  })
})
