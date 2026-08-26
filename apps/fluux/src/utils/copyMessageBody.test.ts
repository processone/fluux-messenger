/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { deriveCopyBody, type CopyableMessage } from './copyMessageBody'

/** Translator stub: returns the key so localized notices are identifiable. */
const t = (key: string, options?: Record<string, unknown>) =>
  options?.method ? `${key}:${String(options.method)}` : key

const message = (over: Partial<CopyableMessage>): CopyableMessage =>
  ({ body: '', ...over }) as CopyableMessage

describe('deriveCopyBody', () => {
  describe('messages that have a body copy it verbatim', () => {
    it('returns a plain body unchanged', () => {
      expect(deriveCopyBody(message({ body: 'Hello there' }), t)).toBe('Hello there')
    })

    // Regression guard for the byte-identity requirement: the preview formatter
    // strips XEP-0393 styling, and a transcript must quote, not normalize.
    it('keeps styling markup intact instead of stripping it like a preview would', () => {
      const body = 'a **bold** and _italic_ and ~~struck~~ and `code`'
      expect(deriveCopyBody(message({ body }), t)).toBe(body)
    })

    it('keeps a reply-quote prefix intact', () => {
      const body = '> Bob: original\nMy reply'
      expect(deriveCopyBody(message({ body, replyTo: { id: '123' } } as Partial<CopyableMessage>), t)).toBe(body)
    })

    it('keeps the body of a message that also carries an attachment', () => {
      expect(
        deriveCopyBody(
          message({
            body: 'look at this',
            attachment: { url: 'https://e.x/p.png', mediaType: 'image/png', name: 'p.png' },
          } as Partial<CopyableMessage>),
          t,
        ),
      ).toBe('look at this')
    })
  })

  describe('messages whose text lives outside body', () => {
    it('renders a poll as its emoji and title', () => {
      const poll = message({
        poll: { title: 'Lunch where?', options: [], settings: { allowMultiple: false, hideResultsBeforeVote: false } },
      } as Partial<CopyableMessage>)
      expect(deriveCopyBody(poll, t)).toBe('📊 Lunch where?')
    })

    it('renders a closed-poll announcement', () => {
      const closed = message({
        pollClosed: { title: 'Lunch where?', pollMessageId: 'p1', results: [] },
      } as Partial<CopyableMessage>)
      expect(deriveCopyBody(closed, t)).toBe('📊 Poll closed: Lunch where?')
    })

    it('renders a file-only message as its emoji and filename', () => {
      const file = message({
        attachment: { url: 'https://e.x/report.pdf', mediaType: 'application/pdf', name: 'report.pdf' },
      } as Partial<CopyableMessage>)
      expect(deriveCopyBody(file, t)).toBe('📕 report.pdf')
    })
  })

  describe('whitespace-only is absent, never content', () => {
    it('returns empty for an empty body with nothing else', () => {
      expect(deriveCopyBody(message({}), t)).toBe('')
    })

    it('returns empty for a whitespace-only body', () => {
      expect(deriveCopyBody(message({ body: '   \n  ' }), t)).toBe('')
    })

    // A body of empty code fences previews as whitespace, but it IS a body, so
    // rule 1 quotes it verbatim rather than routing it through the preview path.
    it('quotes a body of empty code fences verbatim rather than previewing it away', () => {
      expect(deriveCopyBody(message({ body: '```\n```' }), t)).toBe('```\n```')
    })

    it('returns empty when the preview would reduce to whitespace', () => {
      expect(deriveCopyBody(message({ body: '\t' }), t)).toBe('')
    })
  })

  it('uses the localized notice for a message encrypted with an unreadable method', () => {
    const encrypted = message({
      body: 'This message is encrypted with OMEMO and cannot be displayed.',
      unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
    } as Partial<CopyableMessage>)
    expect(deriveCopyBody(encrypted, t)).toBe('chat.encryption.unsupportedMessage:OMEMO')
  })
})
