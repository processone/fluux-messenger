import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import type { SecretKind, SecretStore } from './keychainSecrets'

const { mockSetDefault, mockKeychain } = vi.hoisted(() => ({
  mockSetDefault: vi.fn(),
  mockKeychain: { current: null as unknown },
}))

vi.mock('@fluux/sdk', () => ({
  getBareJid: (jid: string) => jid.split('/')[0],
  setDefaultFastTokenStorage: (...args: unknown[]) => mockSetDefault(...args),
}))

vi.mock('./keychainSecrets', () => ({
  get keychainSecrets() { return mockKeychain.current },
}))

import { createKeychainFastTokenStorage, installKeychainFastTokens } from './keychainFastTokenStorage'

const JID = 'alice@example.com'
const TOKEN = { mechanism: 'HT-SHA-256-NONE', token: 'secret-token', expiry: '2099-01-01T00:00:00.000Z' }

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

function memoryKeychain(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  const key = (kind: SecretKind, jid: string) => `${kind}:${jid}`
  const secrets: SecretStore & { items: typeof items } = {
    items,
    get: vi.fn(async (kind, jid) => items.get(key(kind, jid)) ?? null),
    set: vi.fn(async (kind, jid, secret) => void items.set(key(kind, jid), secret)),
    delete: vi.fn(async (kind, jid) => void items.delete(key(kind, jid))),
  }
  return secrets
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createKeychainFastTokenStorage', () => {
  it('loads a token saved in the keychain', async () => {
    const keychain = memoryKeychain({ [`fast-token:${JID}`]: JSON.stringify(TOKEN) })
    const { adapter, load } = createKeychainFastTokenStorage(keychain, memoryStorage())

    expect(adapter.getToken(JID)).toBeNull()
    await load(JID)

    expect(adapter.getToken(JID)).toEqual(TOKEN)
  })

  it('saves a token in memory at once and in the keychain', async () => {
    const keychain = memoryKeychain()
    const { adapter } = createKeychainFastTokenStorage(keychain, memoryStorage())

    adapter.setToken(JID, TOKEN)
    expect(adapter.getToken(JID)).toEqual(TOKEN)
    await flush()

    expect(JSON.parse(keychain.items.get(`fast-token:${JID}`)!)).toEqual(TOKEN)
  })

  it('moves a token left in localStorage into the keychain', async () => {
    const keychain = memoryKeychain()
    const storage = memoryStorage({ [`fluux:fast-token:${JID}`]: JSON.stringify(TOKEN) })
    const { adapter, load } = createKeychainFastTokenStorage(keychain, storage)

    await load(JID)

    expect(adapter.getToken(JID)).toEqual(TOKEN)
    expect(JSON.parse(keychain.items.get(`fast-token:${JID}`)!)).toEqual(TOKEN)
    expect(storage.values.has(`fluux:fast-token:${JID}`)).toBe(false)
  })

  it('keeps a localStorage token in place when the keychain refuses it', async () => {
    const keychain = memoryKeychain()
    vi.mocked(keychain.set).mockRejectedValueOnce(new Error('locked'))
    const storage = memoryStorage({ [`fluux:fast-token:${JID}`]: JSON.stringify(TOKEN) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { adapter, load } = createKeychainFastTokenStorage(keychain, storage)

    await load(JID)

    expect(adapter.getToken(JID)).toEqual(TOKEN)
    expect(storage.values.has(`fluux:fast-token:${JID}`)).toBe(true)
  })

  it('forgets a deleted token at once and in the keychain', async () => {
    const keychain = memoryKeychain({ [`fast-token:${JID}`]: JSON.stringify(TOKEN) })
    const storage = memoryStorage()
    const { adapter, load } = createKeychainFastTokenStorage(keychain, storage)
    await load(JID)

    adapter.deleteToken(JID)
    expect(adapter.getToken(JID)).toBeNull()
    await flush()

    expect(keychain.items.size).toBe(0)
    expect(storage.values.size).toBe(0)
  })

  it('does not load back a token whose keychain deletion did not complete', async () => {
    const keychain = memoryKeychain({ [`fast-token:${JID}`]: JSON.stringify(TOKEN) })
    const storage = memoryStorage()
    const first = createKeychainFastTokenStorage(keychain, storage)
    await first.load(JID)
    vi.mocked(keychain.delete).mockReturnValueOnce(new Promise(() => {}))

    first.adapter.deleteToken(JID)
    const next = createKeychainFastTokenStorage(keychain, storage)
    await next.load(JID)

    expect(next.adapter.getToken(JID)).toBeNull()
    expect(keychain.items.size).toBe(0)
  })
})

describe('installKeychainFastTokens', () => {
  let restorePlatform: () => void

  beforeEach(() => {
    mockSetDefault.mockClear()
    mockKeychain.current = memoryKeychain({ [`fast-token:${JID}`]: JSON.stringify(TOKEN) })
  })

  afterEach(() => restorePlatform())

  it('stores FAST tokens in the iOS keychain, loading the remembered account', async () => {
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })

    await installKeychainFastTokens(memoryStorage({ 'xmpp-last-jid': JID }))

    expect(mockSetDefault).toHaveBeenCalledTimes(1)
    expect(mockSetDefault.mock.calls[0][0].getToken(JID)).toEqual(TOKEN)
  })

  it.each([
    ['desktop', { shell: 'desktop', os: 'macos' }],
    ['the web', { shell: 'web', os: 'ios' }],
  ] as const)('leaves FAST tokens in localStorage on %s', async (_name, host) => {
    restorePlatform = setPlatformForTesting(host)

    await installKeychainFastTokens(memoryStorage({ 'xmpp-last-jid': JID }))

    expect(mockSetDefault).not.toHaveBeenCalled()
  })
})
