import { describe, it, expect } from 'vitest'
import { conversationDecryptionKey, formatLocalizedPreview } from './messagePreviewText'

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

  it.each([
    ['key-unavailable', 'couldNotDecryptKeyUnavailable'],
    ['signature-invalid', 'couldNotDecryptSignature'],
    ['unreadable', 'couldNotDecryptUnreadable'],
    [undefined, 'couldNotDecryptUnreadable'],
  ] as const)('localizes pending encryption with reason %s', (reason, key) => {
    const message = {
      body: '[Encrypted message: could not decrypt]', encryptedPayload: '<openpgp/>',
      securityContext: { protocolId: 'openpgp', trust: 'untrusted' as const, failureReason: reason },
    }
    expect(formatLocalizedPreview(message, t)).toBe(`chat.encryption.${key}`)
    expect(formatLocalizedPreview({ ...message, body: 'Recovered content', encryptedPayload: undefined }, t)).toBe('Recovered content')
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

    it('suppresses the preview for moderated Spam only', () => {
      expect(formatLocalizedPreview({ body: 'secret', isRetracted: true, isModerated: true, moderationReason: ' Spam ' }, t)).toBe('')
      expect(formatLocalizedPreview({ body: 'secret', isRetracted: true, isModerated: true, moderationReason: 'Off topic' }, t)).toBe('chat.messageDeleted')
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

// Status wording is confined to the conversation list. Other callers retain
// their existing policy; never surface the sender's fallback while waiting.
describe('conversation-list content availability', () => {
  const available = { enabled: true, locked: false, decrypting: false }
  const encrypted = { body: 'Sender-controlled fallback', encryptedPayload: '<openpgp/>' }
  it.each([
    [available, 'previewWaiting'],
    [{ ...available, decrypting: true }, 'previewDecrypting'],
    [{ ...available, locked: true, decrypting: true }, 'previewLocked'],
    [{ ...available, enabled: false }, 'previewDisabled'],
  ])('uses established account availability %j', (state, key) => {
    expect(formatLocalizedPreview(encrypted, t, state)).toBe(`chat.encryption.${key}`)
  })
  it('keeps verification waiting separate and hides unapproved plaintext', () => {
    expect(formatLocalizedPreview({ ...encrypted, contentAvailability: { state: 'verification' } }, t, { ...available, decrypting: true }))
      .toBe('chat.encryption.previewVerification')
  })
  it.each(['key-unavailable', 'signature-invalid', 'unreadable'] as const)('preserves completed %s failures with or without retained ciphertext', reason => {
    const failed = { ...encrypted, contentAvailability: { state: 'failed' as const, reason },
      securityContext: { protocolId: 'openpgp', trust: 'untrusted' as const, failureReason: reason } }
    const expected = formatLocalizedPreview(failed, t)
    expect(formatLocalizedPreview(failed, t, available)).toBe(expected)
    expect(formatLocalizedPreview({ ...failed, encryptedPayload: undefined }, t, available)).toBe(expected)
    expect(formatLocalizedPreview(failed, t, { ...available, decrypting: true })).toBe('chat.encryption.previewDecrypting')
  })
  it('preserves deletion and moderation precedence even during active work', () => {
    const active = { ...available, decrypting: true }
    expect(formatLocalizedPreview({ ...encrypted, isRetracted: true }, t, active)).toBe('chat.messageDeleted')
    expect(formatLocalizedPreview({ ...encrypted, isRetracted: true, isModerated: true, moderationReason: 'Spam' }, t, active)).toBe('')
    expect(conversationDecryptionKey({ ...encrypted, isRetracted: true }, active)).toBeUndefined()
  })
})
