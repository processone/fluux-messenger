import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { hasFastToken, ROOM_READ_MARKERS_STORAGE_KEY } from '@fluux/sdk'
import roomFixture from '../../../../packages/fluux-sdk/src/core/modules/fixtures/roomReadMarkers.json'
import { performLogout } from './performLogout'
import { deleteCredentials } from '@/utils/keychain'
import { setPlatformForTesting } from '@/platform'
import { getReconnectIntent } from './reconnectIntent'
import { saveSession, getSession } from '@/utils/sessionStorage'

// Keep real reconnectIntent / clearAutoReconnectCredentials / clearSession (the
// behaviours under test). Only stub the heavy/native edges.
const previewCleanup = vi.hoisted(() => ({ purge: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/platform/ios/notificationPreviews', () => ({ purgeIOSNotificationPreviews: previewCleanup.purge }))
const mockReset = vi.fn()
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    connectionStore: { getState: () => ({ reset: mockReset, status: 'online', webPushEnabled: true }), subscribe: vi.fn(() => vi.fn()) },
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
  it.each([false, true])('disables push before disconnect (clear local data: %s)', async shouldCleanLocalData => {
    const registration = { jid: 'push.example.test', node: 'fixture-node' }
    localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
    const push = { registerDevice: vi.fn(), enable: vi.fn(), disable: vi.fn().mockResolvedValue(undefined), unregisterDevice: vi.fn() }
    let nodeAtDisconnect: string | null | undefined
    const disconnect = vi.fn(async () => { nodeAtDisconnect = localStorage.getItem('fluux-push-registration') })
    await performLogout({ disconnect, push, jid: JID, shouldCleanLocalData })
    expect(disconnect).toHaveBeenCalledOnce()
    expect(push.disable).toHaveBeenCalledWith(registration, expect.any(Number))
    expect(push.disable.mock.invocationCallOrder[0]).toBeLessThan(disconnect.mock.invocationCallOrder[0])
    expect(nodeAtDisconnect).toBeNull()
  })

  it.each(['error', 'timeout'])('completes logout and clears push state on %s', async mode => {
    vi.useFakeTimers()
    try {
      localStorage.setItem('fluux-push-registration', JSON.stringify({ jid: 'push.example.test', node: 'fixture-node' }))
      localStorage.setItem('fluux-push-token', 'fixture-token')
      const push = { registerDevice: vi.fn(), enable: vi.fn(), unregisterDevice: vi.fn(),
        disable: vi.fn(() => mode === 'timeout' ? new Promise<void>(() => {}) : Promise.reject(new Error(mode))) }
      const disconnect = vi.fn().mockResolvedValue(undefined)
      const logout = performLogout({ disconnect, push, jid: JID, shouldCleanLocalData: false })
      await vi.advanceTimersByTimeAsync(1500)
      await logout
      expect(disconnect).toHaveBeenCalledOnce()
      expect(localStorage.getItem('fluux-push-registration')).toBeNull()
      expect(localStorage.getItem('fluux-push-token')).toBeNull()
      expect(getReconnectIntent()).toBe('logged-out')
    } finally { vi.useRealTimers() }
  })

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mockReset.mockClear()
    previewCleanup.purge.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['none', 'consent', 'migration'] as const)('clears the captured logout account without erasing another account (conversion refused: %s)', async failure => {
    const other = 'other@example.com'
    const packet = new DOMParser().parseFromString(roomFixture.message, 'application/xml')
    const archiveId = packet.getElementsByTagNameNS('urn:xmpp:sid:0', 'stanza-id')[0].getAttribute('id')!
    const watermark = JSON.stringify({ sent: { [roomFixture.room]: { archiveId, row: { id: packet.documentElement.getAttribute('id')!, stanzaId: archiveId } } } })
    const key = (account: string, kind: string) => `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([account, kind])}`
    for (const account of [JID, other]) {
      localStorage.setItem(key(account, 'consent'), JSON.stringify(account === JID ? { version: 2, rooms: [roomFixture.room] } : { enabled: true, rooms: [roomFixture.room] }))
      if (account === JID) localStorage.setItem(key(account, 'migration'), '2')
      localStorage.setItem(key(account, 'watermarks'), watermark)
    }
    if (failure !== 'none') {
      const storage = localStorage
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, property) => property === 'setItem'
        ? (name: string, value: string) => { if (name === key(other, failure)) throw new DOMException('Quota exhausted', 'QuotaExceededError'); target.setItem(name, value) }
        : Reflect.get(target, property, target) }))
    }
    saveSession(JID, 'secret', SERVER)
    await performLogout({ disconnect: vi.fn().mockResolvedValue(undefined), jid: JID, shouldCleanLocalData: true })
    expect(getSession()).toBeNull()
    for (const kind of ['consent', 'migration', 'watermarks']) expect(localStorage.getItem(key(JID, kind))).toBeNull()
    expect(JSON.parse(localStorage.getItem(key(other, 'consent'))!).rooms).toEqual([roomFixture.room])
    expect(localStorage.getItem(key(other, 'watermarks'))).toBe(watermark)
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

  it('purges notification secrets before disconnect and bounds stalled native cleanup', async () => {
    vi.useFakeTimers()
    try {
      previewCleanup.purge.mockImplementationOnce(() => new Promise<void>(() => {}))
      const disconnect = vi.fn().mockResolvedValue(undefined)
      const logout = performLogout({ disconnect, jid: JID, shouldCleanLocalData: false })
      await vi.advanceTimersByTimeAsync(0)
      expect(previewCleanup.purge).toHaveBeenCalledOnce()
      expect(disconnect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2500)
      await logout
      expect(disconnect).toHaveBeenCalledOnce()
      expect(mockReset).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('requests FAST-token invalidation on disconnect', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)

    await performLogout({ disconnect, jid: JID, shouldCleanLocalData: false })

    expect(disconnect).toHaveBeenCalledWith({ invalidateFastToken: true })
  })

  it('warns when disconnect reports that the FAST token could not be removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await performLogout({
      disconnect: vi.fn().mockRejectedValue(new Error('FAST token removal failed')),
      jid: JID,
      shouldCleanLocalData: false,
    })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disconnect failed'))
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
  // FLM-79 S2: do not abandon the longer keychain authorization window.
  it('lets credential authorization finish after the session has left ChatLayout', async () => {
    const restore = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    vi.useFakeTimers()
    try {
      saveSession(JID, 'secret', SERVER)
      let answer!: () => void
      vi.mocked(deleteCredentials).mockImplementationOnce(() => new Promise<void>(resolve => { answer = resolve }))
      let completed = false
      const logout = performLogout({ disconnect: vi.fn().mockResolvedValue(undefined), jid: JID, shouldCleanLocalData: false })
        .then(() => { completed = true })
      await vi.advanceTimersByTimeAsync(6000)
      expect(getSession()).toBeNull()
      expect(getReconnectIntent()).toBe('logged-out')
      expect(completed).toBe(false)
      answer()
      await logout
      expect(completed).toBe(true)
    } finally { vi.useRealTimers(); restore() }
  })

  it('keeps the previous outer logout bound on Windows', async () => {
    const restore = setPlatformForTesting({ shell: 'desktop', os: 'windows' })
    vi.useFakeTimers()
    try {
      vi.mocked(deleteCredentials).mockImplementationOnce(() => new Promise<void>(() => {}))
      const logout = performLogout({ disconnect: vi.fn().mockResolvedValue(undefined), jid: JID, shouldCleanLocalData: false })
      await vi.advanceTimersByTimeAsync(2500)
      await logout
      expect(getReconnectIntent()).toBe('logged-out')
    } finally { vi.useRealTimers(); restore() }
  })

})
