import { describe, it, expect } from 'vitest'
import { E2EEEncryptionRequiredError, E2EEPluginError } from '@fluux/sdk'
import { encryptionSendErrorKey } from './encryptionSendError'

describe('encryptionSendErrorKey', () => {
  it('maps E2EEEncryptionRequiredError to the generic encryption-required key', () => {
    const err = new E2EEEncryptionRequiredError({ kind: 'direct', peer: 'bob@example.com' })
    expect(encryptionSendErrorKey(err)).toBe('chat.encryption.sendBlockedEncryptionRequired')
  })

  it('maps pin-mismatch to the key-changed message', () => {
    expect(encryptionSendErrorKey(new E2EEPluginError('permanent', 'pin-mismatch', 'changed')))
      .toBe('chat.encryption.sendBlockedKeyChanged')
  })

  it('maps key-locked to the unlock message', () => {
    expect(encryptionSendErrorKey(new E2EEPluginError('transient', 'key-locked', 'locked')))
      .toBe('chat.encryption.sendBlockedKeyLocked')
  })

  it('maps own-key-conflict to the conflict message', () => {
    expect(encryptionSendErrorKey(new E2EEPluginError('permanent', 'own-key-conflict', 'conflict')))
      .toBe('chat.encryption.sendBlockedKeyConflict')
  })

  it('maps any other plugin error to the generic encryption-failed message', () => {
    expect(encryptionSendErrorKey(new E2EEPluginError('transient', 'peer-key-missing', 'probe')))
      .toBe('chat.encryption.sendBlockedGeneric')
  })

  it('returns null for a non-encryption error (caller logs instead)', () => {
    expect(encryptionSendErrorKey(new Error('network down'))).toBeNull()
  })
})
