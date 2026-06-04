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
})
