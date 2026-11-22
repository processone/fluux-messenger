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

// Rework: the quote that stands in for a shown copy is left out of the list preview and the notification.
describe('forward with a marked quote', () => {
  const quote = '> Bob wrote:\n> Ship it\nxmpp:r@c?join;msg=1'
  const marked = (lead: string) => message({ body: `${lead}${quote}`,
    forwarded: { author: 'Bob', text: 'Ship it', fallback: { begin: lead.length, end: lead.length + quote.length, text: quote } } })

  it.each([false, true])('notifies with the comment and not the quote (web: %s)', web => {
    expect(buildLocalMessageNotification({ kind: 'chat', entity, message: marked('Look\n') }, t, 'en', web)).toMatchObject({ title: 'Alice', body: 'Look' })
    expect(formatLocalizedPreview(marked('Look\n'), t)).toBe('Look')
  })

  it('shows the copied text when no comment is left, and the whole body once an edit changed the marked text', () => {
    expect(formatLocalizedPreview(marked(''), t)).toBe('Ship it')
    const edited = { ...marked('Look\n'), body: `A much longer comment\n${quote}` }
    // FLM-537: the edited body is shown whole, but previews drop its quote lines.
    expect(formatLocalizedPreview(edited, t)).toBe('A much longer comment\nxmpp:r@c?join;msg=1')
  })
})

