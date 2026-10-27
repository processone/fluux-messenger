import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ConnectionStatus } from '@fluux/sdk'
import { useSessionPersistence, startupReconnectExpected } from './useSessionPersistence'
import { getSession, saveSession } from '@/utils/sessionStorage'
import { markLoggedOut, markConnectActive } from '@/utils/reconnectIntent'
import { setPlatformForTesting } from '@/platform'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'
import { resetDeepLinkRouterForTests, takeQueuedDeepLinks } from '@/utils/deepLinkRouter'
import { resetShutdownStateForTests, markShuttingDown } from '@/utils/appShutdown'

// Source: captain FLM-13 — « A la réouverture, l'écran de connexion apparait
// brièvement, même quand on a toutes les infos pour se reconnecter en auto.
// On ne devrait revenir à cet écran que lorsque qu'il y a un vrai problème de
// reconnection » — and the decisions kept from its review: a login link
// replaces the saved account at any moment during startup; room-join and
// message links are navigation only.
//
// useSessionPersistence is the single owner of the startup reconnect. These
// tests drive it with the real deep link router and a mocked SDK connect.

const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
const mockGetCredentials = vi.fn()
const mockPrewarm = vi.fn()
const mockGetCurrentUrls = vi.fn()
const mockOnOpenUrl = vi.fn()
const statusHolder = { value: 'disconnected' as ConnectionStatus }
const pushGate: { wait: Promise<void> | null } = { wait: null }

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'fr' } }),
}))
vi.mock('@/utils/keychain', () => ({
  hasSavedCredentials: () => localStorage.getItem('xmpp-has-saved-credentials') === 'true',
  getCredentials: (...args: unknown[]) => mockGetCredentials(...args),
}))
vi.mock('@/utils/openpgpPrewarm', () => ({
  prewarmOpenpgpUnlock: (...args: unknown[]) => { mockPrewarm(...args); return Promise.resolve() },
}))
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: () => mockGetCurrentUrls(),
  onOpenUrl: (...args: unknown[]) => mockOnOpenUrl(...args),
}))
vi.mock('@/hooks/useNativePush', () => ({
  prepareNativePushAccount: () => pushGate.wait ?? Promise.resolve(),
}))
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnectionActions: () => ({ connect: mockConnect }),
    useXMPPContext: () => ({ client: { disconnect: mockDisconnect, profile: { restoreOwnAvatarFromCache: vi.fn() } } }),
    connectionStore: {
      getState: () => ({ status: statusHolder.value, jid: null, setStatus: vi.fn(), setError: vi.fn() }),
      subscribe: vi.fn(() => vi.fn()),
    },
  }
})
vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => selector({
    status: statusHolder.value, setServerInfo: vi.fn(), setHttpUploadService: vi.fn(),
    setOwnNickname: vi.fn(), updateOwnResource: vi.fn(),
  }),
  useRosterStore: (selector: (s: unknown) => unknown) => selector({ setContacts: vi.fn() }),
}))

const JID = 'user@example.com'
const LOGIN_LINK = 'xmpp:alice@other.example?connect;server=wss://other.example/ws'
const JOIN_LINK = 'xmpp:team@conference.example.com?join'

function seedKeychain(jid = JID, server = 'example.com'): void {
  localStorage.setItem('xmpp-has-saved-credentials', 'true')
  localStorage.setItem('xmpp-last-jid', jid)
  localStorage.setItem('xmpp-last-server', server)
}
function seedFastToken(jid = JID, server = 'example.com'): void {
  localStorage.setItem('xmpp-remember-me', 'true')
  localStorage.setItem('xmpp-last-jid', jid)
  localStorage.setItem('xmpp-last-server', server)
  localStorage.setItem(`fluux:fast-token:${jid}`, JSON.stringify({
    mechanism: 'HT-SHA-256-NONE', token: 'tok', expiry: new Date(Date.now() + 86_400_000).toISOString(),
  }))
}
/** A connect() the test settles itself, as the server would. */
function pendingConnect() {
  let settle: { resolve: () => void; reject: (err: Error) => void } = { resolve: () => {}, reject: () => {} }
  mockConnect.mockImplementation(() => {
    statusHolder.value = 'connecting'
    return new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
  })
  return { resolve: () => settle.resolve(), reject: (err: Error) => settle.reject(err) }
}
/** The one live deep-link listener the router installed. */
function liveListener(): (urls: string[]) => void {
  const cb = mockOnOpenUrl.mock.calls[0]?.[0]
  if (!cb) throw new Error('router listener not installed')
  return cb
}
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
}

describe('useSessionPersistence — startup owner', () => {
  let restorePlatform: () => void

  beforeEach(() => {
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    localStorage.clear()
    sessionStorage.clear()
    statusHolder.value = 'disconnected'
    pushGate.wait = null
    mockConnect.mockReset().mockImplementation(() => { statusHolder.value = 'online'; return Promise.resolve(null) })
    mockDisconnect.mockReset().mockImplementation(() => { statusHolder.value = 'disconnected'; return Promise.resolve() })
    mockGetCredentials.mockReset().mockResolvedValue({ jid: JID, password: 'pw', server: 'example.com' })
    mockPrewarm.mockReset()
    mockGetCurrentUrls.mockReset().mockResolvedValue(null)
    mockOnOpenUrl.mockReset().mockResolvedValue(() => {})
    resetDeepLinkRouterForTests()
    resetShutdownStateForTests()
    useLoginPrefillStore.getState().clearPrefill()
    markConnectActive()
  })
  afterEach(() => {
    restorePlatform()
  })

  describe.each([
    { name: 'web', shell: 'web', os: 'other', nativeKeepalive: false, nativeKeychain: false },
    { name: 'desktop', shell: 'desktop', os: 'macos', nativeKeepalive: true, nativeKeychain: true },
    { name: 'iOS', shell: 'mobile', os: 'ios', nativeKeepalive: false, nativeKeychain: true },
  ] as const)('connection options on $name', ({ shell, os, nativeKeepalive, nativeKeychain }) => {
    const jid = 'user@process-one.net'
    const commonOptions = {
      jid,
      server: 'process-one.net',
      fallbackWebSocketUrl: 'wss://chat.process-one.net/xmpp',
      resource: 'fluux-w12345',
      lang: 'fr',
    }

    beforeEach(() => {
      setPlatformForTesting({ shell, os })
      // Both stores carry the same valid resource to make forwarding observable
      // regardless of whether the host has a stable install identity.
      sessionStorage.setItem('xmpp-resource', commonOptions.resource)
      localStorage.setItem('xmpp-resource', commonOptions.resource)
    })

    it.each([null, 'false', 'true'])('preserves session options with remember-me=%s', async (rememberMe) => {
      saveSession(jid, 'session-password', 'process-one.net')
      if (rememberMe !== null) localStorage.setItem('xmpp-remember-me', rememberMe)

      renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      expect(mockConnect.mock.calls[0][0]).toStrictEqual({
        ...commonOptions,
        password: 'session-password',
        disableSmKeepalive: nativeKeepalive,
        rememberSession: rememberMe === 'true' ? true : undefined,
        autoRetryOnTransientFailure: true,
        previouslyJoinedRooms: undefined,
      })
    })

    it('preserves FAST options without a password and derives the missing server', async () => {
      seedFastToken(jid, '')

      renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      expect(mockConnect.mock.calls[0][0]).toStrictEqual({
        ...commonOptions,
        password: undefined,
        disableSmKeepalive: false,
        rememberSession: true,
        autoRetryOnTransientFailure: true,
      })
      await waitFor(() => expect(getSession()).toMatchObject({ jid, password: '', server: 'process-one.net' }))
    })

    if (nativeKeychain) {
      it('forwards a matching keychain password on the FAST path without changing its policy', async () => {
        seedFastToken(jid)
        seedKeychain(jid)
        mockGetCredentials.mockResolvedValue({ jid: `${jid}/other-resource`, password: 'fallback-password', server: 'example.com' })

        renderHook(() => useSessionPersistence())
        await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
        expect(mockConnect.mock.calls[0][0]).toStrictEqual({
          ...commonOptions,
          server: 'example.com',
          fallbackWebSocketUrl: undefined,
          password: 'fallback-password',
          disableSmKeepalive: false,
          rememberSession: true,
          autoRetryOnTransientFailure: true,
        })
      })

      it('leaves transient retry at the SDK default for a direct keychain startup', async () => {
        seedKeychain(jid)
        mockGetCredentials.mockResolvedValue({ jid: ` ${jid} `, password: 'keychain-password', server: '' })

        renderHook(() => useSessionPersistence())
        await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
        expect(mockConnect.mock.calls[0][0]).toStrictEqual({
          ...commonOptions,
          password: 'keychain-password',
          disableSmKeepalive: nativeKeepalive,
          rememberSession: true,
        })
        await waitFor(() => expect(getSession()).toMatchObject({ jid, password: 'keychain-password', server: 'process-one.net' }))
      })

      it('keeps JavaScript keepalive and transient retries for the keychain error fallback', async () => {
        seedKeychain(jid, '')
        mockGetCredentials.mockResolvedValue({ jid, password: 'retry-password', server: 'ignored.example' })
        statusHolder.value = 'error'

        renderHook(() => useSessionPersistence())
        await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
        expect(mockConnect.mock.calls[0][0]).toStrictEqual({
          ...commonOptions,
          password: 'retry-password',
          disableSmKeepalive: false,
          rememberSession: true,
          autoRetryOnTransientFailure: true,
        })
        await waitFor(() => expect(getSession()).toMatchObject({ jid, password: 'retry-password', server: 'process-one.net' }))
      })
    }
  })

  describe('what a reopen can reconnect with', () => {
    it('expects a startup reconnect for a tab session, a FAST token or a keychain password, and for nothing else', () => {
      expect(startupReconnectExpected()).toBe(false)
      seedFastToken()
      expect(startupReconnectExpected()).toBe(true)
      localStorage.clear()
      seedKeychain()
      expect(startupReconnectExpected()).toBe(true)
      localStorage.clear()
      saveSession(JID, 'pw', 'example.com')
      expect(startupReconnectExpected()).toBe(true)
    })

    it('expects none after a logout, while quitting, or when a login link (web URL parameters) names an account', () => {
      seedFastToken()
      markLoggedOut()
      expect(startupReconnectExpected()).toBe(false)
      markConnectActive()
      markShuttingDown()
      expect(startupReconnectExpected()).toBe(false)
      resetShutdownStateForTests()
      useLoginPrefillStore.getState().setPrefill({ jid: 'alice@other.example' })
      expect(startupReconnectExpected()).toBe(false)
    })
  })

  describe('remembered FAST token (tab closed and reopened)', () => {
    it('is pending from the first render, connects, and ends pending once online', async () => {
      seedFastToken()
      const { result, rerender } = renderHook(() => useSessionPersistence())
      expect(result.current.startupPending).toBe(true)
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({ jid: JID, rememberSession: true, autoRetryOnTransientFailure: true }))
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
      expect(getSession()).toMatchObject({ jid: JID })
    })

    it('stays pending through the attempt and ends it only when the error is final (no keychain fallback)', async () => {
      seedFastToken()
      mockConnect.mockImplementation(() => { statusHolder.value = 'error'; return Promise.reject(new Error('not-authorized')) })
      const { result, rerender } = renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      await flush()
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
      expect(getSession()).toBeNull()
      // No password in the keychain: the refused token is deleted, as before.
      expect(localStorage.getItem(`fluux:fast-token:${JID}`)).toBeNull()
    })

    it('keeps the startup pending while the one keychain retry runs after a refused token', async () => {
      seedFastToken()
      seedKeychain()
      // The keychain is locked at startup (no fallback password), then readable.
      mockGetCredentials.mockResolvedValueOnce(null)
      const first = pendingConnect()
      const { result, rerender } = renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      expect(mockConnect.mock.calls[0][0]).toMatchObject({ password: undefined })

      // Refused: the error is not final, the retry with the keychain password follows.
      const second = pendingConnect()
      statusHolder.value = 'error'
      await act(async () => { first.reject(new Error('not-authorized')) })
      rerender()
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2))
      expect(mockConnect.mock.calls[1][0]).toMatchObject({ password: 'pw' })
      rerender()
      expect(result.current.startupPending).toBe(true)

      statusHolder.value = 'online'
      await act(async () => { second.resolve() })
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
      expect(getSession()).toMatchObject({ jid: JID, password: 'pw' })
    })

    it('ends the startup when a pending attempt is torn down (cancelled reconnect, logout, takeover)', async () => {
      seedFastToken()
      pendingConnect()
      const { result, rerender } = renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      rerender()
      expect(result.current.startupPending).toBe(true)
      statusHolder.value = 'disconnected'
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
    })

    it('does not connect, and is not pending, after a logout even though the token survived', async () => {
      seedFastToken()
      markLoggedOut()
      const { result } = renderHook(() => useSessionPersistence())
      expect(result.current.startupPending).toBe(false)
      await flush()
      expect(mockConnect).not.toHaveBeenCalled()
    })

    it('does not connect when the user logs out while the startup is still preparing', async () => {
      seedFastToken()
      let releasePush: () => void = () => {}
      pushGate.wait = new Promise<void>((resolve) => { releasePush = resolve })
      const { result, rerender } = renderHook(() => useSessionPersistence())
      await flush()
      markLoggedOut()
      await act(async () => { releasePush() })
      await flush()
      expect(mockConnect).not.toHaveBeenCalled()
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
    })

    it('runs the startup once under StrictMode', async () => {
      seedFastToken()
      renderHook(() => useSessionPersistence(), { wrapper: StrictMode })
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      await flush()
      expect(mockConnect).toHaveBeenCalledTimes(1)
    })
  })

  describe('keychain password without a FAST token (desktop, iOS)', () => {
    it('is pending from the first render and connects with the keychain credentials, prewarming the key', async () => {
      seedKeychain()
      const { result, rerender } = renderHook(() => useSessionPersistence())
      expect(result.current.startupPending).toBe(true)
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({ jid: JID, password: 'pw', rememberSession: true }))
      expect(mockConnect.mock.calls[0][0].autoRetryOnTransientFailure).toBeUndefined()
      expect(mockPrewarm).toHaveBeenCalledWith(JID)
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
      expect(getSession()).toMatchObject({ jid: JID, password: 'pw' })
    })

    it('ends the startup with no attempt when the keychain holds nothing usable', async () => {
      seedKeychain()
      mockGetCredentials.mockResolvedValue(null)
      const { result, rerender } = renderHook(() => useSessionPersistence())
      expect(result.current.startupPending).toBe(true)
      await flush()
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
      expect(mockConnect).not.toHaveBeenCalled()
    })

    it('spends the one automatic attempt: a refused password ends the startup without a second try', async () => {
      seedKeychain()
      mockConnect.mockImplementation(() => { statusHolder.value = 'error'; return Promise.reject(new Error('not-authorized')) })
      const { result, rerender } = renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      await flush()
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
      await flush()
      expect(mockConnect).toHaveBeenCalledTimes(1)
      expect(getSession()).toBeNull()
    })
  })

  describe('links during startup (desktop, iOS)', () => {
    it('a login link that launched the app replaces the saved account before anything connects', async () => {
      seedKeychain()
      mockGetCurrentUrls.mockResolvedValue([LOGIN_LINK])
      const { result, rerender } = renderHook(() => useSessionPersistence())
      expect(result.current.startupPending).toBe(true)
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
      await flush()
      expect(mockGetCredentials).not.toHaveBeenCalled()
      expect(mockConnect).not.toHaveBeenCalled()
      expect(mockDisconnect).not.toHaveBeenCalled()
      expect(useLoginPrefillStore.getState().prefill).toMatchObject({ jid: 'alice@other.example', server: 'wss://other.example/ws' })
    })

    it('a login link arriving while the connection is in flight cancels it and saves nothing', async () => {
      seedFastToken()
      const attempt = pendingConnect()
      const { result, rerender } = renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))

      await act(async () => { liveListener()([LOGIN_LINK]) })
      expect(mockDisconnect).toHaveBeenCalledTimes(1)
      expect(useLoginPrefillStore.getState().prefill).toMatchObject({ jid: 'alice@other.example' })
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))

      // The SDK rejects the cancelled request; even a quiet resolution saves nothing.
      await act(async () => { attempt.resolve() })
      await flush()
      expect(getSession()).toBeNull()
    })

    it('a login link arriving during the keychain lookup stops the startup before it connects', async () => {
      seedKeychain()
      let releaseCredentials: () => void = () => {}
      mockGetCredentials.mockImplementation(() => new Promise((resolve) => {
        releaseCredentials = () => resolve({ jid: JID, password: 'pw', server: 'example.com' })
      }))
      const { result, rerender } = renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockGetCredentials).toHaveBeenCalledTimes(1))
      await act(async () => { liveListener()([LOGIN_LINK]) })
      await act(async () => { releaseCredentials() })
      await flush()
      expect(mockConnect).not.toHaveBeenCalled()
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
    })

    it('a room-join link is navigation: the startup continues and the link waits for the connected app', async () => {
      seedFastToken()
      mockGetCurrentUrls.mockResolvedValue([JOIN_LINK])
      const { result, rerender } = renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      expect(useLoginPrefillStore.getState().prefill).toBeNull()
      expect(mockDisconnect).not.toHaveBeenCalled()
      expect(takeQueuedDeepLinks()).toEqual([JOIN_LINK])
      rerender()
      await waitFor(() => expect(result.current.startupPending).toBe(false))
    })

    it('navigation received for an abandoned startup does not replay for the replacement account', async () => {
      seedFastToken()
      pendingConnect()
      renderHook(() => useSessionPersistence())
      await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
      await act(async () => { liveListener()([JOIN_LINK]) })
      await act(async () => { liveListener()([LOGIN_LINK]) })
      expect(takeQueuedDeepLinks()).toEqual([])
    })
  })
})
