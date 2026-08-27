/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { reactionPreviewText, formatReactionNotification } from './reactionNotificationText'

/** Translator stub: returns the key (plus interpolations) so notices are identifiable. */
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}|${JSON.stringify(options)}` : key

const message = (over: Record<string, unknown>) => ({ body: '', ...over }) as never

describe('reactionPreviewText', () => {
  it('quotes the deleted notice for a retracted message, never its preserved body', () => {
    const out = reactionPreviewText(message({ body: 'the secret', isRetracted: true }), t)
    expect(out).toBe('chat.messageDeleted')
    expect(out).not.toContain('secret')
  })

  it('quotes the notice for a bodiless retraction instead of collapsing to empty quotes', () => {
    expect(reactionPreviewText(message({ isRetracted: true }), t)).toBe('chat.messageDeleted')
  })

  it('still returns empty for a bodiless signal placeholder, so the caller drops the quotes', () => {
    expect(reactionPreviewText(message({}), t)).toBe('')
    expect(formatReactionNotification(t, { name: 'Bob', emoji: '👍', preview: '' })).toContain(
      'reactions.mentionNoPreview',
    )
  })

  it('leaves every other message type quoting its own content', () => {
    expect(reactionPreviewText(message({ body: 'hi there' }), t)).toBe('hi there')
    expect(reactionPreviewText(message({ poll: { title: 'Lunch?', options: [], settings: { allowMultiple: false, hideResultsBeforeVote: false } } }), t)).toBe('📊 Lunch?')
    expect(
      reactionPreviewText(
        message({ attachment: { url: 'https://e.x/r.pdf', mediaType: 'application/pdf', name: 'r.pdf' } }),
        t,
      ),
    ).toBe('📕 r.pdf')
    expect(
      reactionPreviewText(
        message({ body: 'fallback', unsupportedEncryption: { namespace: 'ns', name: 'OMEMO' } }),
        t,
      ),
    ).toContain('chat.encryption.unsupportedMessage')
  })

  it('truncates a long quote to the notification limit', () => {
    expect(reactionPreviewText(message({ body: 'x'.repeat(200) }), t)).toHaveLength(80)
  })
})
