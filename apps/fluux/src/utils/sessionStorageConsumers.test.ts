import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getReconnectIntent } from './reconnectIntent'

// These consumers must work even when the React startup owner is unavailable.
vi.mock('@/hooks/useSessionPersistence', () => {
  throw new Error('Storage consumers must not load the startup hook')
})
vi.mock('@fluux/sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...sdk,
    connectionStore: {
      getState: () => ({ jid: null, reset: vi.fn() }),
      subscribe: vi.fn(() => () => {}),
    },
  }
})
vi.mock('@/hooks/useNativePush', () => ({ endPushSession: async () => {} }))
vi.mock('@/utils/keychain', () => ({
  deleteCredentials: async () => {},
  getCredentials: async () => null,
}))

describe('session storage consumers without the startup hook', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  it('clears the active tab session during logout', async () => {
    const jid = 'user@example.com'
    sessionStorage.setItem('xmpp-active-session-jid', jid)
    sessionStorage.setItem(`xmpp-session:${jid}`, JSON.stringify({ jid, password: 'fixture', server: 'example.com' }))

    const logout = async () => {
      const { performLogout } = await import('./performLogout')
      await performLogout({ disconnect: async () => {}, jid: null, shouldCleanLocalData: false })
      return {
        session: sessionStorage.getItem(`xmpp-session:${jid}`),
        account: sessionStorage.getItem('xmpp-active-session-jid'),
        intent: getReconnectIntent(),
      }
    }

    await expect(logout()).resolves.toEqual({ session: null, account: null, intent: 'logged-out' })
  })

  it('can provision notification credentials without loading startup orchestration', async () => {
    const provision = async () => {
      const { ensureExtensionCredential } = await import('@/platform/ios/notificationPreviews')
      return ensureExtensionCredential('user@example.com', {
        saved: async () => ({ password: 'fixture', server: 'example.com' }),
        tokenStatus: async () => ({ userAgentId: 'fixture-agent', present: true }),
        provision: vi.fn(),
        storeToken: vi.fn(),
      })
    }

    await expect(provision()).resolves.toEqual({ password: 'fixture', server: 'example.com' })
  })
})
