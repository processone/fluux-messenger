import { describe, it, expect, beforeEach } from 'vitest'
import { useEncryptionSettingsStore, isOmemoEnabled } from './encryptionSettingsStore'

describe('omemoEnabled setting', () => {
  beforeEach(() => localStorage.clear())
  it('defaults to false and toggles + persists', () => {
    expect(isOmemoEnabled()).toBe(false)
    useEncryptionSettingsStore.getState().setOmemoEnabled(true)
    expect(isOmemoEnabled()).toBe(true)
    expect(localStorage.getItem('fluux-e2ee-omemo-enabled')).toBe('1')
    useEncryptionSettingsStore.getState().rehydrate()
    expect(useEncryptionSettingsStore.getState().omemoEnabled).toBe(true)
  })
})
