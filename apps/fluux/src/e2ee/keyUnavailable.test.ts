import { describe, expect, it } from 'vitest'
import { E2EEPluginError } from '@fluux/sdk'
import { isSecretKeyUnavailableError } from './keyUnavailable'

describe('isSecretKeyUnavailableError', () => {
  it('is true for key-unrecoverable and key-locked E2EEPluginErrors', () => {
    expect(isSecretKeyUnavailableError(new E2EEPluginError('permanent', 'key-unrecoverable', 'x'))).toBe(true)
    expect(isSecretKeyUnavailableError(new E2EEPluginError('transient', 'key-locked', 'x'))).toBe(true)
  })
  it('is false for other E2EEPluginError codes', () => {
    expect(isSecretKeyUnavailableError(new E2EEPluginError('permanent', 'wrong-passphrase', 'x'))).toBe(false)
    expect(isSecretKeyUnavailableError(new E2EEPluginError('permanent', 'malformed-key', 'x'))).toBe(false)
  })
  it('is false for non-plugin errors', () => {
    expect(isSecretKeyUnavailableError(new Error('boom'))).toBe(false)
    expect(isSecretKeyUnavailableError('nope')).toBe(false)
    expect(isSecretKeyUnavailableError(undefined)).toBe(false)
  })
})
