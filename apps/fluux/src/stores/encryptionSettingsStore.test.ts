import { describe, it, expect, beforeEach } from 'vitest'
import { useEncryptionSettingsStore, isOpenpgpEnabled } from './encryptionSettingsStore'

describe('encryptionSettingsStore', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset the store to its initial (localStorage-derived) state.
    useEncryptionSettingsStore.setState({
      openpgpEnabled: localStorage.getItem('fluux-e2ee-openpgp-enabled') === '1',
    })
  })

  it('defaults to disabled when no preference is stored', () => {
    expect(useEncryptionSettingsStore.getState().openpgpEnabled).toBe(false)
    expect(isOpenpgpEnabled()).toBe(false)
  })

  it('persists the preference to localStorage', () => {
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(true)
    expect(localStorage.getItem('fluux-e2ee-openpgp-enabled')).toBe('1')
    expect(isOpenpgpEnabled()).toBe(true)
  })

  it('can be toggled back off', () => {
    const { setOpenpgpEnabled } = useEncryptionSettingsStore.getState()
    setOpenpgpEnabled(true)
    setOpenpgpEnabled(false)
    expect(localStorage.getItem('fluux-e2ee-openpgp-enabled')).toBe('0')
    expect(isOpenpgpEnabled()).toBe(false)
  })

  it('isOpenpgpEnabled reflects the live state', () => {
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(true)
    expect(isOpenpgpEnabled()).toBe(true)
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(false)
    expect(isOpenpgpEnabled()).toBe(false)
  })

  describe('plugin registration failures', () => {
    it('starts with no registration error', () => {
      expect(useEncryptionSettingsStore.getState().registrationError).toBeNull()
    })

    it('records the typed failure (kind + code)', () => {
      useEncryptionSettingsStore
        .getState()
        .notifyPluginRegistrationFailed({ kind: 'permanent', code: 'pep-unsupported' })
      expect(useEncryptionSettingsStore.getState().registrationError).toEqual({
        kind: 'permanent',
        code: 'pep-unsupported',
      })
    })

    it('notifyPluginRegistered clears the failure and still bumps the nonce', () => {
      const before = useEncryptionSettingsStore.getState().pluginRegisteredAt
      useEncryptionSettingsStore
        .getState()
        .notifyPluginRegistrationFailed({ kind: 'transient', code: 'timeout' })
      useEncryptionSettingsStore.getState().notifyPluginRegistered()
      const state = useEncryptionSettingsStore.getState()
      expect(state.registrationError).toBeNull()
      expect(state.pluginRegisteredAt).toBe(before + 1)
    })

    it('toggling the preference clears a stale failure', () => {
      useEncryptionSettingsStore
        .getState()
        .notifyPluginRegistrationFailed({ kind: 'permanent', code: 'pep-unsupported' })
      useEncryptionSettingsStore.getState().setOpenpgpEnabled(false)
      expect(useEncryptionSettingsStore.getState().registrationError).toBeNull()
    })
  })
})
