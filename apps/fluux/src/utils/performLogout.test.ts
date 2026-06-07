import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hasFastToken } from '@fluux/sdk'
import { performLogout } from './performLogout'
import { getReconnectIntent } from './reconnectIntent'
import { saveSession, getSession } from '@/hooks/useSessionPersistence'

// Keep real reconnectIntent / clearAutoReconnectCredentials / clearSession (the
// behaviours under test). Only stub the heavy/native edges.
const mockReset = vi.fn()
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    connectionStore: { getState: () => ({ reset: mockReset }), subscribe: vi.fn(() => vi.fn()) },
  }
})
vi.mock('@/utils/keychain', () => ({
  deleteCredentials: vi.fn().mockResolvedValue(undefined),
}))

const JID = 'user@example.com'
const SERVER = 'example.com'

function seedFastToken(): void {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  localStorage.setItem(
    `fluux:fast-token:${JID}`,
    JSON.stringify({ mechanism: 'HT-SHA-256-NONE', token: 'tok', expiry })
  )
}

describe('performLogout', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mockReset.mockClear()
  })

  // ★ The ordering invariant: the intent must flip BEFORE any await, so a
  // disconnect that hangs (or a webview reload mid-logout) can't leave the app
  // in a reconnectable state.
  it('marks logged-out synchronously, before awaiting disconnect', () => {
    vi.useFakeTimers()
    try {
      const neverResolves = () => new Promise<void>(() => {})

      // Intentionally not awaited: assert the synchronous prefix already ran.
      void performLogout({ disconnect: neverResolves, jid: JID, shouldCleanLocalData: false })

      expect(getReconnectIntent()).toBe('logged-out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('requests FAST-token invalidation on disconnect', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)

    await performLogout({ disconnect, jid: JID, shouldCleanLocalData: false })

    expect(disconnect).toHaveBeenCalledWith({ invalidateFastToken: true })
  })

  // Post-condition (keep-data logout): every local re-auth vector is gone AND
  // the intent is logged-out. "One credential survived" becomes a test failure.
  it('clears all local credential vectors and sets logged-out intent (keep-data path)', async () => {
    seedFastToken()
    saveSession(JID, 'secret', SERVER)
    expect(hasFastToken(JID)).toBe(true)
    expect(getSession()).not.toBeNull()

    await performLogout({
      disconnect: vi.fn().mockResolvedValue(undefined),
      jid: JID,
      shouldCleanLocalData: false,
    })

    expect(hasFastToken(JID)).toBe(false)
    expect(getSession()).toBeNull()
    expect(getReconnectIntent()).toBe('logged-out')
    expect(mockReset).toHaveBeenCalled()
  })
})
