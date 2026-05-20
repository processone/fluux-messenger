import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { saveCredentialToManager } from './saveCredentialToManager'

interface MutableGlobal {
  PasswordCredential?: unknown
}

const mutableGlobal = globalThis as MutableGlobal

describe('saveCredentialToManager', () => {
  const originalCredentials = navigator.credentials
  const originalPasswordCredential = mutableGlobal.PasswordCredential

  beforeEach(() => {
    delete mutableGlobal.PasswordCredential
    Object.defineProperty(navigator, 'credentials', {
      value: undefined,
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    if (originalPasswordCredential === undefined) {
      delete mutableGlobal.PasswordCredential
    } else {
      mutableGlobal.PasswordCredential = originalPasswordCredential
    }
    Object.defineProperty(navigator, 'credentials', {
      value: originalCredentials,
      configurable: true,
      writable: true,
    })
  })

  it('returns "unsupported" when PasswordCredential is missing', async () => {
    Object.defineProperty(navigator, 'credentials', {
      value: { store: vi.fn() },
      configurable: true,
      writable: true,
    })

    const result = await saveCredentialToManager({
      id: 'openpgp-passphrase',
      name: 'Fluux — OpenPGP backup passphrase',
      password: 'correct horse battery staple',
    })

    expect(result).toBe('unsupported')
  })

  it('returns "unsupported" when credentials.store is missing', async () => {
    mutableGlobal.PasswordCredential = class {
      constructor(_data: unknown) {}
    }

    const result = await saveCredentialToManager({
      id: 'openpgp-passphrase',
      name: 'Fluux — OpenPGP backup passphrase',
      password: 'correct horse battery staple',
    })

    expect(result).toBe('unsupported')
  })

  it('returns "saved" when credentials.store resolves', async () => {
    const constructed: Array<{ id: string; password: string; name: string }> = []
    mutableGlobal.PasswordCredential = class {
      constructor(data: { id: string; password: string; name: string }) {
        constructed.push(data)
      }
    }
    const store = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'credentials', {
      value: { store },
      configurable: true,
      writable: true,
    })

    const result = await saveCredentialToManager({
      id: 'openpgp-passphrase',
      name: 'Fluux — OpenPGP backup passphrase',
      password: 'correct horse battery staple',
    })

    expect(result).toBe('saved')
    expect(constructed).toEqual([
      {
        id: 'openpgp-passphrase',
        password: 'correct horse battery staple',
        name: 'Fluux — OpenPGP backup passphrase',
      },
    ])
    expect(store).toHaveBeenCalledTimes(1)
  })

  it('returns "failed" when credentials.store rejects', async () => {
    mutableGlobal.PasswordCredential = class {
      constructor(_data: unknown) {}
    }
    Object.defineProperty(navigator, 'credentials', {
      value: { store: vi.fn().mockRejectedValue(new Error('user dismissed')) },
      configurable: true,
      writable: true,
    })

    const result = await saveCredentialToManager({
      id: 'openpgp-passphrase',
      name: 'Fluux — OpenPGP backup passphrase',
      password: 'correct horse battery staple',
    })

    expect(result).toBe('failed')
  })

  it('returns "failed" when the constructor throws', async () => {
    mutableGlobal.PasswordCredential = class {
      constructor(_data: unknown) {
        throw new Error('invalid credential')
      }
    }
    Object.defineProperty(navigator, 'credentials', {
      value: { store: vi.fn() },
      configurable: true,
      writable: true,
    })

    const result = await saveCredentialToManager({
      id: 'openpgp-passphrase',
      name: 'Fluux — OpenPGP backup passphrase',
      password: 'correct horse battery staple',
    })

    expect(result).toBe('failed')
  })
})
