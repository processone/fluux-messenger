import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { chatStore, connectionStore, roomStore, rosterStore, type SDKEvents } from '@fluux/sdk'
import { xml, type Element, NS_DISCO_INFO, NS_MAM, NS_CARBONS } from '@fluux/sdk/xmpp'
import { setPlatformForTesting } from '@/platform'
import { resetSharedUnreadWidgetList, startUnreadWidgetPublisher, unreadWidgetList } from './unreadWidget'
// Compose the actual SDK lifecycle with its application consumer; production app code does not import these internals.
import { setupBackgroundSyncSideEffects } from '../../../../packages/fluux-sdk/src/core/backgroundSync'
import { SessionLifecycleEngine, type SessionLifecycleDeps } from '../../../../packages/fluux-sdk/src/core/sessionLifecycle'
import { Discovery } from '../../../../packages/fluux-sdk/src/core/modules/Discovery'
import type { ModuleDependencies } from '../../../../packages/fluux-sdk/src/core/modules/BaseModule'
import { createMockClient } from '../../../../packages/fluux-sdk/src/core/sideEffects.testHelpers'
import { MAM_ROOM_CATCHUP_DELAY_MS } from '../../../../packages/fluux-sdk/src/utils/mamCatchUpUtils'

vi.unmock('@fluux/sdk')
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('iOS read publication after session discovery settles', () => {
  let restorePlatform: () => void
  let stopPublisher: (() => void) | undefined
  let stopSync: (() => void) | undefined

  beforeEach(() => {
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    vi.useFakeTimers()
    resetSharedUnreadWidgetList()
    chatStore.getState().reset()
    roomStore.getState().reset()
    rosterStore.getState().reset()
    connectionStore.getState().reset()
    connectionStore.getState().setJid('fixture@example.test/phone')
    invoke.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    stopPublisher?.(); stopPublisher = undefined
    stopSync?.(); stopSync = undefined
    resetSharedUnreadWidgetList()
    connectionStore.getState().reset()
    vi.clearAllTimers()
    vi.useRealTimers()
    restorePlatform()
  })

  it.each(['failed', 'missing-query', 'account-failed', 'account-missing-query', 'account-refused', 'account-refused-with-owner'] as const)('settles %s discovery before publishing the confirmed local read', async (outcome) => {
    const client = createMockClient()
    const accountProbe = outcome.startsWith('account-')
    const refused = outcome.startsWith('account-refused')
    const overlapping = outcome === 'account-refused-with-owner'
    const discoveryReply = deferred<Element>()
    const accountReply = deferred<Element>()
    const retryReply = deferred<Element>()
    const archive = deferred<void>()
    const sendIQ = vi.fn<ModuleDependencies['sendIQ']>()
      .mockReturnValueOnce(discoveryReply.promise).mockReturnValueOnce(accountProbe ? accountReply.promise : retryReply.promise)
    if (accountProbe) sendIQ.mockReturnValueOnce(retryReply.promise)
    const emitSDK: ModuleDependencies['emitSDK'] = (event, payload) => {
      if (event === 'connection:server-info') connectionStore.getState().setServerInfo((payload as SDKEvents['connection:server-info']).info)
    }
    const discovery = new Discovery({
      getCurrentJid: () => connectionStore.getState().jid,
      sendIQ, emitSDK,
    } as unknown as ModuleDependencies)
    vi.spyOn(discovery, 'discoverHttpUploadService').mockResolvedValue(undefined)
    client.server.fetchServerInfo.mockImplementation(() => discovery.fetchServerInfo())
    client.internal.mam.catchUpAllConversations.mockReturnValue(archive.promise)
    const stores = {
      connection: { ...connectionStore.getState(),
        getStatus: () => connectionStore.getState().status,
        getServerInfo: () => connectionStore.getState().serverInfo,
        getWebPushEnabled: () => connectionStore.getState().webPushEnabled },
      chat: chatStore.getState(), room: roomStore.getState(), roster: rosterStore.getState(),
      console: { addEvent: vi.fn() },
    }
    const engine = new SessionLifecycleEngine({
      discovery,
      admin: { discoverAdminCommands: vi.fn().mockResolvedValue(undefined) },
      roster: { fetchRoster: vi.fn().mockResolvedValue(undefined), sendInitialPresence: vi.fn().mockResolvedValue(undefined) },
      muc: {
        fetchBookmarks: vi.fn().mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] }),
        discoverMucService: vi.fn().mockResolvedValue(undefined),
      },
      profile: { fetchOwnProfile: vi.fn().mockResolvedValue(undefined), restoreAllRoomAvatarHashes: vi.fn().mockResolvedValue(undefined) },
      push: { checkSupport: vi.fn().mockResolvedValue(false) },
      conversationSync: { fetchConversations: vi.fn().mockResolvedValue(null) },
      getStores: () => stores,
      getCurrentJid: () => connectionStore.getState().jid,
      getXmpp: () => null,
      ensureE2EEManager: vi.fn(), sendStanza: vi.fn().mockResolvedValue(undefined),
      emitSDK: vi.fn(), emitOnline: () => client._emit('online'),
      emitFreshSessionInputsReady: () => client._emit('freshSessionInputsReady'),
      emitFreshSessionDiscoverySettled: () => client._emit('freshSessionDiscoverySettled'),
      emitConversationListReady: vi.fn(), connectPresence: vi.fn(),
    } as unknown as SessionLifecycleDeps)

    // Synthetic old state is deliberately three; this does not identify the real phone's three.
    const ids = ['one@example.test', 'two@example.test', 'three@example.test']
    for (const [index, id] of ids.entries()) {
      chatStore.getState().addConversation({
        id, type: 'chat', name: `Fixture ${index}`, unreadCount: 1,
        lastMessage: { id: `fixture-${index}`, conversationId: id, type: 'chat', from: id,
          stanzaId: undefined, originId: undefined, body: 'Synthetic fixture', timestamp: new Date(), isOutgoing: false },
      })
    }
    let nativeBadgeTotal = 3
    let nativeWidgetTotal = 3
    const commands: string[] = []
    invoke.mockImplementation(async (command, args) => {
      commands.push(command)
      if (command === 'plugin:push|set_badge') nativeBadgeTotal = args.badge.unread.length + args.badge.events
      if (command === 'plugin:widgets|set_unread_list') nativeWidgetTotal = args.list?.total ?? 0
    })
    const state = () => ({
      appTotal: unreadWidgetList('fixture@example.test', chatStore.getState().conversations.values(), roomStore.getState(), 0).total,
      catchUpOwners: connectionStore.getState().catchUpOwners,
      isCatchingUp: connectionStore.getState().isCatchingUp,
      nativeBadgeTotal, nativeWidgetTotal, commandCount: commands.length,
    })
    expect(state().appTotal).toBe(3)
    connectionStore.getState().setStatus('connecting')
    stopSync = setupBackgroundSyncSideEffects(client)
    stopPublisher = startUnreadWidgetPublisher(() => 0)
    connectionStore.getState().setStatus('online')
    client._emit('online')
    await engine.handleConnectionSuccess(false)
    expect(state().appTotal).toBe(3)
    const endOther = overlapping ? connectionStore.getState().beginUpdate(['messages']) : undefined
    for (const id of ids) chatStore.getState().markReadToNewest(id)
    await vi.advanceTimersByTimeAsync(600)
    const pending = state()
    expect(pending).toMatchObject({ appTotal: 0, catchUpOwners: overlapping ? 2 : 1, isCatchingUp: true, nativeBadgeTotal: 3, nativeWidgetTotal: 3, commandCount: 0 })

    // A finished request with unknown capabilities is not proof that the cached zero is current.
    if (accountProbe) {
      discoveryReply.resolve(xml('iq', { type: 'result' }, xml('query', { xmlns: NS_DISCO_INFO }, xml('feature', { var: NS_CARBONS }))))
      await vi.advanceTimersByTimeAsync(0)
      if (refused) accountReply.reject(Object.assign(new Error('service-unavailable'), { name: 'StanzaError' }))
      else if (outcome === 'account-failed') accountReply.reject(new Error('fixture account discovery failed'))
      else accountReply.resolve(xml('iq', { type: 'result' }))
    } else if (outcome === 'failed') discoveryReply.reject(new Error('fixture discovery failed'))
    else discoveryReply.resolve(xml('iq', { type: 'result' }))
    await vi.advanceTimersByTimeAsync(1_000)
    const unknown = state()
    if (process.env.FLUUX_CATCHUP_EVIDENCE) {
      writeFileSync(`${process.env.FLUUX_CATCHUP_EVIDENCE}-${outcome}-unknown.json`, JSON.stringify({
        synthetic: true, unknown, capabilityDataPublished: connectionStore.getState().serverInfo !== null,
        note: 'Synthetic state; not the origin of the physical phone count',
      }, null, 2) + '\n')
    }
    if (refused) {
      endOther?.()
      await vi.advanceTimersByTimeAsync(600)
      const settled = state()
      if (process.env.FLUUX_CATCHUP_EVIDENCE) {
        writeFileSync(`${process.env.FLUUX_CATCHUP_EVIDENCE}-${outcome}-refusal.json`, JSON.stringify({
          synthetic: true, pending, afterReply: unknown, settled, commands,
          capabilityDataPublished: connectionStore.getState().serverInfo !== null,
          standIns: ['IQ transport and StanzaError reply', 'unrelated lifecycle collaborators', 'native bridge; not OS badge or WidgetKit rendering'],
        }, null, 2) + '\n')
      }
      expect(unknown).toMatchObject(overlapping
        ? { catchUpOwners: 1, isCatchingUp: true, nativeBadgeTotal: 3, nativeWidgetTotal: 3, commandCount: 0 }
        : { catchUpOwners: 0, isCatchingUp: false, nativeBadgeTotal: 0, nativeWidgetTotal: 0, commandCount: 2 })
      expect(settled).toMatchObject({ appTotal: 0, catchUpOwners: 0, isCatchingUp: false, nativeBadgeTotal: 0, nativeWidgetTotal: 0 })
      expect(connectionStore.getState().serverInfo?.features).toContain(NS_CARBONS)
      expect(connectionStore.getState().serverInfo?.features).not.toContain(NS_MAM)
      expect(client.internal.mam.catchUpAllConversations).not.toHaveBeenCalled()
      expect(commands).toEqual(['plugin:push|set_badge', 'plugin:widgets|set_unread_list'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(client.server.fetchServerInfo).not.toHaveBeenCalled()
      return
    }
    expect(unknown).toMatchObject({ appTotal: 0, isCatchingUp: true, nativeBadgeTotal: 3, nativeWidgetTotal: 3, commandCount: 0 })
    expect(connectionStore.getState().serverInfo).toBeNull()
    await vi.advanceTimersByTimeAsync(5_000)
    if (process.env.FLUUX_CATCHUP_EVIDENCE) {
      writeFileSync(`${process.env.FLUUX_CATCHUP_EVIDENCE}-${outcome}-retry.json`, JSON.stringify({
        synthetic: true, pending, unknown, retryCalls: client.server.fetchServerInfo.mock.calls.length,
        commands, note: 'Synthetic state; not the origin of the physical phone count',
      }, null, 2) + '\n')
    }
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
    expect(sendIQ).toHaveBeenCalledTimes(accountProbe ? 3 : 2)
    retryReply.resolve(xml('iq', { type: 'result' }, xml('query', { xmlns: NS_DISCO_INFO }, xml('feature', { var: NS_MAM }))))
    await vi.advanceTimersByTimeAsync(MAM_ROOM_CATCHUP_DELAY_MS + 600)
    const retrieving = state()
    expect(retrieving).toMatchObject({ appTotal: 0, isCatchingUp: true, nativeBadgeTotal: 3, nativeWidgetTotal: 3, commandCount: 0 })
    expect(client.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
    archive.resolve(undefined)
    await vi.advanceTimersByTimeAsync(600)
    const settled = state()
    if (process.env.FLUUX_CATCHUP_EVIDENCE) {
      writeFileSync(`${process.env.FLUUX_CATCHUP_EVIDENCE}-${outcome}-complete.json`, JSON.stringify({
        synthetic: true, pending, unknown, retrieving, settled, commands,
        standIns: ['IQ transport', 'archive request', 'unrelated lifecycle collaborators', 'native bridge; not OS badge or WidgetKit rendering'],
        actual: ['SDK Discovery', 'SessionLifecycleEngine', 'background-sync ownership', 'SDK stores and mark-read action', 'application widget publisher'],
      }, null, 2) + '\n')
    }
    expect(settled).toMatchObject({ appTotal: 0, catchUpOwners: 0, isCatchingUp: false, nativeBadgeTotal: 0, nativeWidgetTotal: 0 })
    expect(commands).toEqual(['plugin:push|set_badge', 'plugin:widgets|set_unread_list'])
    expect(connectionStore.getState().serverInfo?.features).toContain(NS_MAM)
  })
})
