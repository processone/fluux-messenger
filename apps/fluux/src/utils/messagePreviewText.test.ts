import { describe, it, expect } from 'vitest'
import { formatLocalizedPreview } from './messagePreviewText'

// Fake t: encodes key + interpolation so we can assert both without real i18n.
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}|${JSON.stringify(options)}` : key

describe('formatLocalizedPreview', () => {
  it('returns a localized notice naming the method for unsupported encryption', () => {
    const out = formatLocalizedPreview(
      {
        body: 'You received a message encrypted with OMEMO but your client…',
        unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
      },
      t,
    )
    // Localized key is used, the method name is interpolated…
    expect(out).toContain('chat.encryption.unsupportedMessage')
    expect(out).toContain('OMEMO')
    // …and the sender's raw fallback body never surfaces.
    expect(out).not.toContain('your client')
  })

  it('falls back to the generic notice when the method has no name', () => {
    const out = formatLocalizedPreview(
      { body: 'fallback', unsupportedEncryption: { namespace: 'urn:xmpp:otr:0', name: '' } },
      t,
    )
    expect(out).toBe('chat.encryption.unsupportedMessageGeneric')
  })

  it('delegates to formatMessagePreview for ordinary messages', () => {
    expect(formatLocalizedPreview({ body: 'Hello there' }, t)).toBe('Hello there')
  })

  describe('retracted messages', () => {
    it('substitutes the deleted notice instead of the preserved body', () => {
      const out = formatLocalizedPreview({ body: 'the secret', isRetracted: true }, t)
      expect(out).toBe('chat.messageDeleted')
      expect(out).not.toContain('secret')
    })

    it('never yields a blank preview for a bodiless retraction', () => {
      expect(formatLocalizedPreview({ body: '', isRetracted: true }, t).trim()).toBe('chat.messageDeleted')
      expect(formatLocalizedPreview({ body: '   ', isRetracted: true }, t).trim()).toBe('chat.messageDeleted')
    })

    it('outranks an attachment, a poll and a closed poll', () => {
      expect(
        formatLocalizedPreview(
          { body: '', isRetracted: true, attachment: { url: 'https://e.x/p.png', mediaType: 'image/png', name: 'p.png' } },
          t,
        ),
      ).toBe('chat.messageDeleted')
      expect(
        formatLocalizedPreview({ body: '', isRetracted: true, poll: { title: 'Lunch?', options: [], settings: { allowMultiple: false, hideResultsBeforeVote: false } } }, t),
      ).toBe('chat.messageDeleted')
      expect(
        formatLocalizedPreview({ body: '', isRetracted: true, pollClosed: { title: 'Lunch?', pollMessageId: 'p1', results: [] } }, t),
      ).toBe('chat.messageDeleted')
    })

    it('outranks unsupported encryption — a deleted message is deleted either way', () => {
      expect(
        formatLocalizedPreview(
          {
            body: 'fallback',
            isRetracted: true,
            unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
          },
          t,
        ),
      ).toBe('chat.messageDeleted')
    })
  })

  describe('unaffected message types keep their existing preview', () => {
    it.each([
      ['plain text', { body: 'Hello there' }, 'Hello there'],
      ['poll', { body: '', poll: { title: 'Lunch?', options: [], settings: { allowMultiple: false, hideResultsBeforeVote: false } } }, '\u{1F4CA} Lunch?'],
      ['closed poll', { body: '', pollClosed: { title: 'Lunch?', pollMessageId: 'p1', results: [] } }, '\u{1F4CA} Poll closed: Lunch?'],
      [
        'file attachment',
        { body: '', attachment: { url: 'https://e.x/r.pdf', mediaType: 'application/pdf', name: 'r.pdf' } },
        '\u{1F4D5} r.pdf',
      ],
      ['reply', { body: '> Bob: hi\nMy reply', replyTo: { id: '123' } }, 'My reply'],
    ])('%s is unchanged when not retracted', (_label, message, expected) => {
      expect(
        formatLocalizedPreview({ body: '', isRetracted: false, ...(message as Record<string, unknown>) }, t),
      ).toBe(expected)
    })
  })
})
