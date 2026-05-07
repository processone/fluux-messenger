import { describe, it, expect } from 'vitest'
import { E2EEPluginError, isE2EEPluginError } from './errors'

describe('E2EEPluginError', () => {
  it('carries kind, code, message, and optional cause', () => {
    const cause = new Error('underlying IPC failure')
    const err = new E2EEPluginError(
      'transient',
      'timeout',
      'plugin operation timed out',
      cause,
    )
    expect(err.kind).toBe('transient')
    expect(err.code).toBe('timeout')
    expect(err.message).toBe('plugin operation timed out')
    expect(err.cause).toBe(cause)
    expect(err.name).toBe('E2EEPluginError')
  })

  it('isTransient() is true for transient kind', () => {
    const transient = new E2EEPluginError('transient', 'network', 'x')
    const permanent = new E2EEPluginError('permanent', 'wrong-passphrase', 'x')
    expect(transient.isTransient()).toBe(true)
    expect(permanent.isTransient()).toBe(false)
  })

  it('isE2EEPluginError() accepts a real plugin error', () => {
    const err = new E2EEPluginError('permanent', 'key-missing', 'x')
    expect(isE2EEPluginError(err)).toBe(true)
  })

  it('isE2EEPluginError() rejects a plain Error', () => {
    // The guard relies on duck-typing so double-bundled SDKs still interop;
    // a vanilla Error must not accidentally pass.
    expect(isE2EEPluginError(new Error('nope'))).toBe(false)
  })

  it('isE2EEPluginError() rejects non-error values', () => {
    expect(isE2EEPluginError(null)).toBe(false)
    expect(isE2EEPluginError(undefined)).toBe(false)
    expect(isE2EEPluginError('string')).toBe(false)
    expect(isE2EEPluginError({ kind: 'transient', code: 'x' })).toBe(false)
  })
})
