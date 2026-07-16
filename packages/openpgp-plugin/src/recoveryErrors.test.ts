import { describe, expect, it } from 'vitest'
import { KeyPickerRequiredError, NoRecoveryAvailableError } from './recoveryErrors'
import type { KeyBundle } from './OpenPGPPluginBase'

const bundle: KeyBundle = { fingerprint: 'a'.repeat(40), publicArmored: 'PUB', keychainBacked: false }

describe('recoveryErrors', () => {
  it('KeyPickerRequiredError carries candidates + backup context and a stable code', () => {
    const err = new KeyPickerRequiredError([bundle], { message: 'MSG', passphrase: 'PP' })
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('needs-picker')
    expect(err.candidates).toHaveLength(1)
    expect(err.backupContext).toEqual({ message: 'MSG', passphrase: 'PP' })
  })

  it('NoRecoveryAvailableError records whether a local key existed', () => {
    expect(new NoRecoveryAvailableError(true).hadLocalKey).toBe(true)
    expect(new NoRecoveryAvailableError(false).hadLocalKey).toBe(false)
    expect(new NoRecoveryAvailableError(true).code).toBe('no-recovery-available')
  })
})
