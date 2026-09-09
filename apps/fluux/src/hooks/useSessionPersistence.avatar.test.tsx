import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { XMPPClient } from '@fluux/sdk/core'
import { connectionStore } from '@fluux/sdk/stores'
import { XMPPProvider } from '@fluux/sdk/react'
import { clearAllAvatarData, revokeAllBlobUrls } from '@fluux/sdk/cache'
import { xml, type Element } from '@fluux/sdk/xmpp'
import { saveSession, useSessionPersistence } from './useSessionPersistence'

vi.mock('@fluux/sdk', async () => {
  const { connectionStore } = await import('@fluux/sdk/stores')
  const { useConnectionActions, useXMPPContext } = await import('@fluux/sdk/react')
  const { getBareJid, getDomain } = await import('@fluux/sdk/core')
  return { connectionStore, useConnectionActions, useXMPPContext, getBareJid, getDomain,
    hasFastToken: () => false, deleteFastToken: vi.fn() }
})
vi.mock('@fluux/sdk/react', async importOriginal => {
  // This integration exercises the real provider, actions and store subscriptions.
  const { XMPPProvider, useConnectionActions, useXMPPContext, useConnectionStore, useRosterStore } =
    await importOriginal<typeof import('@fluux/sdk/react')>()
  return { XMPPProvider, useConnectionActions, useXMPPContext, useConnectionStore, useRosterStore }
})
vi.mock('@/platform', () => ({ platform: () => ({
  hasNativeConnectionKeepalive: true, nativeKeychain: true, hasStableInstallIdentity: true,
}) }))

const OWN = 'me@example.com'
const HASH = 'saved-own-avatar'

describe('cached own avatar during session reload', () => {
  let finishTransport: () => void
  let releaseCache: () => void
  let onConnectionSuccess: Parameters<XMPPClient['connection']['setConnectionSuccessHandler']>[0]
  let client: XMPPClient
  let cachedUrl: string

  beforeAll(() => { vi.stubGlobal('indexedDB', new IDBFactory()) })
  afterAll(() => { vi.unstubAllGlobals() })

  beforeEach(async () => {
    localStorage.clear()
    sessionStorage.clear()
    connectionStore.setState({ status: 'disconnected', jid: null, ownAvatar: null, ownAvatarHash: null })
    await clearAllAvatarData()
    class ReloadClient extends XMPPClient {
      protected override async sendStanza(): Promise<void> {}
      protected override async sendIQ(): Promise<Element> {
        return xml('iq', { type: 'result' },
          xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
            xml('items', { node: 'urn:xmpp:avatar:data' },
              xml('item', { id: HASH }, xml('data', { xmlns: 'urn:xmpp:avatar:data' }, 'aW1hZ2U=')))))
      }
    }
    const probe = new ReloadClient({ debug: false })
    const connectionPrototype = Object.getPrototypeOf(probe.connection) as XMPPClient['connection']
    probe.destroy()
    const handler = vi.spyOn(connectionPrototype, 'setConnectionSuccessHandler')
    client = new ReloadClient({ debug: false })
    onConnectionSuccess = handler.mock.calls.at(-1)![0]
    await client.profile.fetchAvatarData(OWN, HASH)
    revokeAllBlobUrls()
    cachedUrl = 'blob:saved-avatar'
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(cachedUrl)
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
    releaseCache = undefined as unknown as () => void
    const get = IDBObjectStore.prototype.get
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = get.call(this, key)
      if (this.name === 'avatars' && key === HASH) {
        request.addEventListener('success', event => {
          const complete = request.onsuccess
          request.onsuccess = null
          releaseCache = () => { complete?.call(request, event) }
        })
      }
      return request
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
    renderHook(() => useSessionPersistence(claim), {
      wrapper: ({ children }: { children: ReactNode }) => <XMPPProvider client={client}>{children}</XMPPProvider>,
    })
    await waitFor(() => expect(client.connection.connect).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(releaseCache).toBeTypeOf('function'))
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
