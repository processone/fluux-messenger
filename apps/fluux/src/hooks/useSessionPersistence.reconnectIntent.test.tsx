import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSessionPersistence, saveSession } from './useSessionPersistence'
import { markLoggedOut, markConnectActive } from '@/utils/reconnectIntent'

// Spy client. The auto-reconnect engine calls `client.connect(...)` through its
// internal connect wrapper; this spy lets us assert whether a reconnect was
// attempted.
const mockConnect = vi.fn().mockResolvedValue(undefined)

// Override the SDK mock from test-setup for this file only:
//  - `useXMPPContext` returns our spy client (the real one needs a provider)
//  - `connectionStore.getState()` exposes the setters the connect wrapper calls
//  - real `hasFastToken` / `getBareJid` / `deleteFastToken` are preserved so the
//    FAST-token Path B reads our seeded token exactly like production
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useXMPPContext: () => ({ client: { connect: mockConnect } }),
    connectionStore: {
      getState: () => ({ setStatus: vi.fn(), setError: vi.fn() }),
      subscribe: vi.fn(() => vi.fn()),
    },
  }
})

const JID = 'user@example.com'
const SERVER = 'example.com'

function seedFastTokenSession(): void {
  // "Remember Me" + last account + a valid FAST token => Path B auto-connect arms.
  localStorage.setItem('xmpp-remember-me', 'true')
  localStorage.setItem('xmpp-last-jid', JID)
  localStorage.setItem('xmpp-last-server', SERVER)
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  localStorage.setItem(
    `fluux:fast-token:${JID}`,
    JSON.stringify({ mechanism: 'HT-SHA-256-NONE', token: 'tok', expiry })
  )
}

async function flush(): Promise<void> {
  // Let the effect's async attemptFastConnect() microtasks settle.
  await Promise.resolve()
  await Promise.resolve()
}

describe('useSessionPersistence — reconnect intent gate', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mockConnect.mockClear()
  })

  // Positive control: proves the harness actually arms Path B, so a "not called"
  // assertion below is meaningful (the gate, not broken wiring).
  it('auto-connects via FAST token when intent is active (default)', async () => {
    seedFastTokenSession()
    markConnectActive()

    renderHook(() => useSessionPersistence())

    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
  })

  // ★ The core regression guard.
  it('does NOT auto-connect via FAST token after logout (intent = logged-out)', async () => {
    seedFastTokenSession()
    markLoggedOut()

    renderHook(() => useSessionPersistence())
    await flush()

    expect(mockConnect).not.toHaveBeenCalled()
  })

  // ★ Path A (in-tab reload): a sessionStorage session must also be gated.
  it('does NOT auto-connect via a stored sessionStorage session after logout', async () => {
    saveSession(JID, 'secret', SERVER)
    markLoggedOut()

    renderHook(() => useSessionPersistence())
    await flush()

    expect(mockConnect).not.toHaveBeenCalled()
  })

  // ★ The exact reload scenario: the in-memory once-per-startup guard is reset
  // by the webview reload AND the FAST token deletion lost its race (token still
  // present). The persisted intent must still block the reconnect.
  it('does NOT auto-connect after logout even across a simulated reload with the FAST token still present', async () => {
    seedFastTokenSession()
    markLoggedOut()

    // First mount (pre-reload), then unmount to simulate the WRY reload tearing
    // down the JS context, then a fresh mount with a brand-new ref.
    const { unmount } = renderHook(() => useSessionPersistence())
    await flush()
    unmount()

    renderHook(() => useSessionPersistence())
    await flush()

    expect(mockConnect).not.toHaveBeenCalled()
  })
})
