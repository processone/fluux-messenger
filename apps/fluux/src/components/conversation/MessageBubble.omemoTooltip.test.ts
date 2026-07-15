/**
 * Regression test for the per-message security tooltip's protocol label
 * lookup in `MessageBubble.tsx` (`formatSecurityTooltip`).
 *
 * i18next's default `nsSeparator` is `:`, so a lookup for the key
 * `chat.encryption.tooltip.protocol.omemo:2` gets split at the colon into
 * namespace `chat.encryption.tooltip.protocol.omemo` + key `2`, which never
 * resolves — i18next falls back to `defaultValue` (the raw protocol id
 * `"omemo:2"`) instead of the translated "OMEMO" label. Passing
 * `nsSeparator: false` for that one `t()` call disables namespace-splitting
 * so the literal dotted key resolves correctly, without touching the global
 * i18n init that the rest of the app relies on.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import enLocale from '../../i18n/locales/en.json'

const testI18n = i18n.createInstance()

describe('MessageBubble security tooltip protocol label (urn:xmpp:omemo:2)', () => {
  beforeAll(async () => {
    await testI18n
      .use(initReactI18next)
      .init({
        resources: { en: { translation: enLocale } },
        lng: 'en',
        fallbackLng: 'en',
        debug: false,
        interpolation: { escapeValue: false },
      })
  })

  it('resolves the "omemo:2" protocol id to "OMEMO" when nsSeparator is disabled', () => {
    const resolved = testI18n.t('chat.encryption.tooltip.protocol.omemo:2', {
      nsSeparator: false,
      defaultValue: 'omemo:2',
    })
    expect(resolved).toBe('OMEMO')
  })

  it('falls back to the raw protocol id with the default nsSeparator (proves the bug without the fix)', () => {
    const resolved = testI18n.t('chat.encryption.tooltip.protocol.omemo:2', {
      defaultValue: 'omemo:2',
    })
    expect(resolved).toBe('omemo:2')
  })

  it('still resolves the openpgp protocol label (no colon in the key, unaffected by the fix)', () => {
    const resolved = testI18n.t('chat.encryption.tooltip.protocol.openpgp', {
      nsSeparator: false,
      defaultValue: 'openpgp',
    })
    expect(resolved).toBe('OpenPGP')
  })
})
