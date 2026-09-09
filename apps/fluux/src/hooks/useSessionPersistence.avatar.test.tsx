import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { XMPPClient } from '../../../../packages/fluux-sdk/src/core/XMPPClient'
import { Connection } from '../../../../packages/fluux-sdk/src/core/modules/Connection'
import { connectionStore } from '../../../../packages/fluux-sdk/src/stores/connectionStore'
import * as avatarCache from '../../../../packages/fluux-sdk/src/utils/avatarCache'
import { saveSession, useSessionPersistence } from './useSessionPersistence'

const context = vi.hoisted(() => ({ client: null as unknown as XMPPClient }))

vi.mock('../../../../packages/fluux-sdk/src/provider', () => ({ useXMPPContext: () => context }))
vi.mock('@fluux/sdk', async () => ({
  connectionStore: (await import('../../../../packages/fluux-sdk/src/stores/connectionStore')).connectionStore,
  useConnectionActions: (await import('../../../../packages/fluux-sdk/src/hooks/useConnectionActions')).useConnectionActions,
  useXMPPContext: () => context,
  ...(await import('../../../../packages/fluux-sdk/src/core/jid')),
  hasFastToken: () => false,
  deleteFastToken: vi.fn(),
}))
vi.mock('@fluux/sdk/react', async () => {
  const { useConnectionStore, useRosterStore } = await import('../../../../packages/fluux-sdk/src/react/storeHooks')
  return { useConnectionStore, useRosterStore }
})
vi.mock('@/platform', () => ({ platform: () => ({
  hasNativeConnectionKeepalive: true, nativeKeychain: true, hasStableInstallIdentity: true,
}) }))

const OWN = 'me@example.com'
const HASH = 'saved-own-avatar'

describe('cached own avatar during session reload', () => {
  let finishTransport: () => void
  let releaseCache: () => void
  let onConnectionSuccess: Parameters<Connection['setConnectionSuccessHandler']>[0]
  let client: XMPPClient
  let cachedUrl: string

  beforeEach(async () => {
    localStorage.clear()
    sessionStorage.clear()
    connectionStore.setState({ status: 'disconnected', jid: null, ownAvatar: null, ownAvatarHash: null })
    globalThis.indexedDB = new IDBFactory()
    cachedUrl = await avatarCache.cacheAvatar(HASH, 'aW1hZ2U=', 'image/png')
    const handler = vi.spyOn(Connection.prototype, 'setConnectionSuccessHandler')
    class ReloadClient extends XMPPClient {
      protected override async sendStanza(): Promise<void> {}
    }
    client = new ReloadClient({ debug: false })
    context.client = client
    onConnectionSuccess = handler.mock.calls.at(-1)![0]
    finishTransport = () => {}
    vi.spyOn(client.connection, 'connect')
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishTransport = resolve }))
      .mockResolvedValue(undefined)
    vi.spyOn(client.contacts, 'sendInitialPresence').mockResolvedValue(undefined)
    vi.spyOn(client.contacts, 'sendPresenceProbes').mockResolvedValue(undefined)
    vi.spyOn(client.admin, 'discoverAdminCommands').mockResolvedValue(undefined)
    vi.spyOn(client.profile, 'refreshAllAvatarBlobUrls')
    vi.spyOn(client.profile, 'fetchOwnProfile')
    vi.spyOn(client.profile, 'restoreOwnAvatarFromCache')
    const getCachedAvatar = avatarCache.getCachedAvatar
    const delayedRead = new Promise<void>(resolve => { releaseCache = resolve })
    vi.spyOn(avatarCache, 'getCachedAvatar').mockImplementation(async hash => {
      await delayedRead
      return getCachedAvatar(hash)
    })
    saveSession(OWN, 'password', 'wss://example.com/ws')
    sessionStorage.setItem(`xmpp-profile:${OWN}`, JSON.stringify({ ownAvatarHash: HASH }))
    localStorage.setItem(`fluux:cache-marker:${OWN}`, 'present')
  })

  afterEach(() => {
    cleanup()
    releaseCache?.()
    finishTransport?.()
    client?.destroy()
    vi.restoreAllMocks()
  })

  async function resume(path: string) {
    const claim = path === 'claim granted' ? async () => true
      : path === 'claim failure' ? async () => { throw new Error('Claim unavailable') }
      : undefined
    renderHook(() => useSessionPersistence(claim))
    await waitFor(() => expect(client.connection.connect).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(avatarCache.getCachedAvatar).toHaveBeenCalledTimes(1))
    await act(async () => {
      await onConnectionSuccess(true, undefined, 1_000)
      finishTransport()
    })
    expect(client.profile.refreshAllAvatarBlobUrls).not.toHaveBeenCalled()
    expect(client.profile.fetchOwnProfile).not.toHaveBeenCalled()
    expect(connectionStore.getState().ownAvatar).toBeNull()
  }

  async function finishCachedRestore() {
    await act(async () => {
      releaseCache()
      await vi.mocked(client.profile.restoreOwnAvatarFromCache).mock.results[0].value
    })
  }

  it.each(['native reload', 'claim granted', 'claim failure'])(
    'restores the saved avatar after a short SM resume through %s', async path => {
      await resume(path)
      await finishCachedRestore()
      expect(connectionStore.getState().jid).toBe(OWN)
      expect(connectionStore.getState().ownAvatar).toBe(cachedUrl)
      expect(connectionStore.getState().ownAvatarHash).toBe(HASH)
      expect(client.profile.refreshAllAvatarBlobUrls).not.toHaveBeenCalled()
    },
  )

  it('rejects the delayed saved avatar after a real account switch', async () => {
    await resume('native reload')
    await act(async () => {
      await client.connect({ jid: 'next@example.com', password: 'password', server: 'wss://example.com/ws' })
      connectionStore.getState().setOwnAvatar('blob:next-account', 'next-hash')
    })
    await finishCachedRestore()
    expect(connectionStore.getState().jid).toBe('next@example.com')
    expect(connectionStore.getState().ownAvatar).toBe('blob:next-account')
    expect(connectionStore.getState().ownAvatarHash).toBe('next-hash')
  })
})
