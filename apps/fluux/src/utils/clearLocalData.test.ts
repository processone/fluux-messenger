import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hasFastToken, getBareJid, connectionStore } from '@fluux/sdk'
import { ignoreStore } from '@fluux/sdk/stores'
import { clearAutoReconnectCredentials, clearLocalData } from './clearLocalData'

// Exercise real store reset ordering rather than the test setup's connection facade.
vi.unmock('@fluux/sdk')
vi.unmock('@fluux/sdk/stores')

const FAST_TOKEN_PREFIX = 'fluux:fast-token:'

function seedFastToken(bareJid: string): void {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  localStorage.setItem(
    `${FAST_TOKEN_PREFIX}${bareJid}`,
    JSON.stringify({ mechanism: 'HT-SHA-256-NONE', token: 'tok', expiry })
  )
}

describe('clearAutoReconnectCredentials', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('removes the FAST token so post-logout auto-reconnect cannot re-authenticate', () => {
    const jid = 'user@example.com'
    seedFastToken(getBareJid(jid))
    expect(hasFastToken(jid)).toBe(true)

    clearAutoReconnectCredentials(`${jid}/resource`)

    expect(hasFastToken(jid)).toBe(false)
  })

  it('is a no-op when jid is null', () => {
    expect(() => clearAutoReconnectCredentials(null)).not.toThrow()
  })
})

describe('clearLocalData push cleanup', () => {
  it('disables and unregisters before resetting an online account', async () => {
    connectionStore.getState().setStatus('online')
    connectionStore.getState().setJid('fixture@example.com')
    const registration = { jid: 'push.example.test', node: 'fixture-node' }
    localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
    localStorage.setItem('fluux-push-device-id', 'fixture-installation')
    localStorage.setItem('fluux-push-token', 'fixture-token')
    const statusAtRequests: string[] = []
    const push = {
      registerDevice: vi.fn(), enable: vi.fn(),
      disable: vi.fn(async () => { statusAtRequests.push(connectionStore.getState().status) }),
      unregisterDevice: vi.fn(async () => { statusAtRequests.push(connectionStore.getState().status) }),
    }
    await clearLocalData({ push })
    expect(push.disable).toHaveBeenCalledWith(registration, expect.any(Number))
    expect(push.unregisterDevice).toHaveBeenCalledWith({ appServer: registration.jid, deviceId: 'fixture-installation', token: 'fixture-token' }, expect.any(Number))
    expect(statusAtRequests).toEqual(['online', 'online'])
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
    expect(localStorage.getItem('fluux-push-token')).toBeNull()
  })
})

describe('clearLocalData ignore list', () => {
  it('clears the ignore list of the account being wiped', async () => {
    ignoreStore.getState().addIgnored('room@conference.example.com', { identifier: 'occ-1', displayName: 'Spammer' })

    await clearLocalData()

    expect(ignoreStore.getState().ignoredUsers).toEqual({})
  })
})

// Source: account erasure must keep working if room-consent coordination is unavailable.
describe('clearLocalData room coordination failure', () => {
  it('continues deleting reconnect tokens when room storage cannot coordinate', async () => {
    const database = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    const jid = 'fixture@example.com'
    seedFastToken(jid)
    expect(hasFastToken(jid)).toBe(true)
    try {
      await expect(clearLocalData({ allAccounts: true })).resolves.toBeUndefined()
      expect(hasFastToken(jid)).toBe(false)
    } finally { vi.stubGlobal('indexedDB', database) }
  })
})
