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
})
