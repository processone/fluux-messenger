import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { chatStore, roomStore, connectionStore, ignoreStore } from '@fluux/sdk/stores'
import type { Message } from '@fluux/sdk'
import { notificationDebug } from '@/utils/notificationDebug'
import { setPlatformForTesting } from '@/platform'
import { roomNotificationFixture, resetNotificationFixtures } from './notification.testHelpers'

const { invoke, showWebNotification, avatar } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ payload: null })),
  showWebNotification: vi.fn(async () => {}),
  avatar: vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
}))
let presence = 'online'
vi.mock('@tauri-apps/api/core', () => ({ invoke, addPluginListener: async () => ({ unregister: () => {} }) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/plugin-notification', () => ({ onAction: async () => ({ unregister: () => {} }) }))
vi.mock('@/utils/tauriPlatform', () => ({ isMobileTauri: async () => (await import('@/platform')).platform().shell === 'mobile' }))
vi.mock('@/utils/attention', () => ({ requestAttention: vi.fn() }))
vi.mock('@/utils/notificationAvatar', () => ({ getNotificationAvatarUrl: avatar }))
vi.mock('@/utils/notificationDebug', () => ({ notificationDebug: { desktopNotification: vi.fn() } }))
vi.mock('@/utils/webNotification', () => ({ showWebNotification }))
vi.mock('./useNavigateToTarget', () => ({ useNavigateToTarget: () => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() }) }))
vi.mock('./useNotificationPermission', () => ({ useNotificationPermission: () => {}, getNotificationPermissionGranted: () => true }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
// These delivery tests exercise the actual vanilla stores, including ignore changes.
vi.mock('@fluux/sdk/stores', async original => await original<typeof import('@fluux/sdk/stores')>())
vi.mock('@fluux/sdk', async original => ({
  ...await original<typeof import('@fluux/sdk')>(),
  usePresence: () => ({ presenceStatus: presence }),
  useConnectionStatus: () => ({ status: 'disconnected' }),
}))
import { useDesktopNotifications } from './useDesktopNotifications'

let PEER = ''
let sequence = 0
function pending(body = 'encrypted hint'): Message {
  return { type: 'chat', id: 'deferred-1', stanzaId: undefined, originId: undefined, conversationId: PEER, from: PEER, body,
    timestamp: new Date(), isOutgoing: false, encryptedPayload: '<openpgp/>', securityContext: { protocolId: 'openpgp', trust: 'untrusted', failureReason: 'key-unavailable' } }
}
function postedBodies(): string[] {
  return [
    ...showWebNotification.mock.calls.map(call => (call as unknown as [string, { body: string }])[1].body),
    ...invoke.mock.calls.flatMap(call => {
      const [command, args] = call as unknown as [string, { body?: string; options?: { body?: string } }]
      return command === 'plugin:notification|notify' ? [args.options?.body ?? ''] : command === 'post_notification' ? [args.body ?? ''] : []
    }),
  ]
}
let restorePlatform: () => void
beforeEach(() => {
  vi.clearAllMocks()
  PEER = `alice-${++sequence}@example.test`
  resetNotificationFixtures()
  ignoreStore.setState({ ignoredUsers: {} })
  presence = 'online'
  avatar.mockResolvedValue(undefined)
  restorePlatform = setPlatformForTesting({ shell: 'web', os: 'other' })
})
afterEach(() => { cleanup(); restorePlatform() })

describe('local notifications use recovered content', () => {
  it.each([
    { kind: 'chat', body: '' },
    { kind: 'chat', body: 'Sender-provided OMEMO fallback' },
    { kind: 'room', body: '' },
    { kind: 'room', body: 'Sender-provided OMEMO fallback' },
  ] as const)('notifies once for unsupported OMEMO in a hidden $kind with body "$body"', async ({ kind, body }) => {
    const unsupportedEncryption = { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }
    expect(connectionStore.getState().windowVisible).toBe(false)
    if (kind === 'chat') {
      renderHook(() => useDesktopNotifications())
      await act(async () => {
        chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Alice', unreadCount: 0 })
        chatStore.getState().addMessage({ ...pending(body), encryptedPayload: undefined, securityContext: undefined, unsupportedEncryption }, { isLiveArrival: true })
      })
      expect(chatStore.getState().conversations.get(PEER)?.unreadCount).toBe(1)
      await act(async () => { chatStore.getState().updateConversationName(PEER, 'Alice updated') })
    } else {
      const [room, message] = roomNotificationFixture({ jid: `unsupported-${sequence}@conference.example.test`, unreadCount: 0 },
        { body, unsupportedEncryption })
      roomStore.setState({ messages: new Map(), lastArrivedMessage: new Map() })
      renderHook(() => useDesktopNotifications())
      await act(async () => { await roomStore.getState().addMessage(room.jid, message, { isLiveArrival: true }) })
      expect(roomStore.getState().rooms.get(room.jid)?.unreadCount).toBe(1)
      await act(async () => { await roomStore.getState().updateMessage(room.jid, message.id, { body }) })
    }
    await vi.waitFor(() => expect(postedBodies()).toEqual(['chat.encryption.unsupportedMessage']))
    expect(showWebNotification).toHaveBeenCalledTimes(1)
  })

  it.each([
    { shell: 'mobile', os: 'ios' },
    { shell: 'desktop', os: 'macos' },
    { shell: 'web', os: 'other' },
  ] as const)('notifies once after repair on $shell/$os', async host => {
    restorePlatform()
    restorePlatform = setPlatformForTesting(host)
    renderHook(() => useDesktopNotifications())
    const message = pending()
    act(() => {
      chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Alice', unreadCount: 0 })
      chatStore.getState().addMessage(message, { isLiveArrival: true })
    })
    expect(postedBodies()).toEqual([])
    await act(async () => {
      chatStore.getState().updateMessage(PEER, message, { body: 'recovered text', encryptedPayload: undefined, securityContext: { protocolId: 'openpgp', trust: 'tofu' } })
    })
    await vi.waitFor(() => expect(postedBodies()).toEqual(['recovered text']))
    expect(notificationDebug.desktopNotification).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.not.stringContaining('recovered text') }))
    if (host.shell === 'web') expect(showWebNotification).toHaveBeenCalledTimes(1)
    else expect(invoke).toHaveBeenCalledWith(host.shell === 'mobile' ? 'plugin:notification|notify' : 'post_notification', expect.anything())
    await act(async () => { chatStore.getState().updateMessage(PEER, message, { body: 'another repair' }) })
    expect(postedBodies()).toEqual(['recovered text'])
  })

  it('notifies after an empty encrypted arrival is repaired', async () => {
    renderHook(() => useDesktopNotifications())
    const message = pending('')
    act(() => {
      chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Alice', unreadCount: 0 })
      chatStore.getState().addMessage(message, { isLiveArrival: true })
    })
    expect(postedBodies()).toEqual([])
    await act(async () => {
      chatStore.getState().updateMessage(PEER, message, { body: 'now readable', encryptedPayload: undefined, securityContext: { protocolId: 'openpgp', trust: 'tofu' } })
    })
    expect(postedBodies()).toEqual(['now readable'])
  })

  it('applies DND at resolution time', async () => {
    const { rerender } = renderHook(() => useDesktopNotifications())
    const message = pending()
    act(() => {
      chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Alice', unreadCount: 0 })
      chatStore.getState().addMessage(message, { isLiveArrival: true })
    })
    presence = 'dnd'
    rerender()
    await act(async () => {
      chatStore.getState().updateMessage(PEER, message, { body: 'quiet recovered text', encryptedPayload: undefined, securityContext: { protocolId: 'openpgp', trust: 'tofu' } })
    })
    expect(postedBodies()).toEqual([])
  })

  it('does not suppress a repaired message at an imprecise read floor', async () => {
    renderHook(() => useDesktopNotifications())
    const message = pending()
    act(() => {
      chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Alice', unreadCount: 0,
        readPointer: { order: { role: 'floor', timestamp: message.timestamp.getTime() }, identity: { state: 'local', messageId: 'previous-message' } } })
      chatStore.getState().addMessage(message, { isLiveArrival: true })
    })
    await act(async () => {
      chatStore.getState().updateMessage(PEER, message, { body: 'unread at floor', encryptedPayload: undefined, securityContext: undefined })
    })
    expect(postedBodies()).toEqual(['unread at floor'])
  })

  it.each(['repair', 'read', 'retract', 'account', 'dnd'] as const)('rechecks %s after avatar loading', async change => {
    let finish!: (value: undefined) => void
    avatar.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { rerender } = renderHook(() => useDesktopNotifications())
    const message = { ...pending(), body: 'before avatar', encryptedPayload: undefined, securityContext: undefined }
    act(() => {
      chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Alice', unreadCount: 0 })
      chatStore.getState().addMessage(message, { isLiveArrival: true })
    })
    await vi.waitFor(() => expect(avatar).toHaveBeenCalled())
    await act(async () => {
      if (change === 'repair') chatStore.getState().updateMessage(PEER, message, { body: 'after avatar' })
      if (change === 'read') chatStore.getState().markAsRead(PEER)
      if (change === 'retract') chatStore.getState().updateMessage(PEER, message, { isRetracted: true })
      if (change === 'account') connectionStore.setState({ jid: 'other@example.test' })
      if (change === 'dnd') { presence = 'dnd'; rerender() }
      finish(undefined)
    })
    expect(postedBodies()).toEqual(change === 'repair' ? ['after avatar'] : [])
  })

  it('uses a recovered room mention through the same formatter', async () => {
    const [room, message] = roomNotificationFixture({ jid: 'room@conference.example.test', name: 'Room', nickname: 'me', notifyAll: false, unreadCount: 0 },
      { body: 'encrypted hint', encryptedPayload: '<openpgp/>' })
    roomStore.setState({ messages: new Map(), lastArrivedMessage: new Map() })
    renderHook(() => useDesktopNotifications())
    await act(async () => { await roomStore.getState().addMessage(room.jid, message, { isLiveArrival: true }) })
    expect(postedBodies()).toEqual([])
    await act(async () => { await roomStore.getState().updateMessage(room.jid, message.id, { body: 'hello @me', encryptedPayload: undefined }) })
    expect(postedBodies()).toEqual(['hello @me'])
  })
  it('drops a room notification ignored during avatar loading', async () => {
    let finish!: (value: undefined) => void
    avatar.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const [room, message] = roomNotificationFixture({ jid: 'ignored@conference.example.test', unreadCount: 0 }, { id: 'ignore-avatar', body: 'hello' })
    roomStore.setState({ messages: new Map(), lastArrivedMessage: new Map() })
    renderHook(() => useDesktopNotifications())
    await act(async () => { await roomStore.getState().addMessage(room.jid, message, { isLiveArrival: true }) })
    await vi.waitFor(() => expect(avatar).toHaveBeenCalled())
    await act(async () => {
      ignoreStore.getState().addIgnored(room.jid, { identifier: message.nick, displayName: message.nick })
      finish(undefined)
    })
    expect(postedBodies()).toEqual([])
  })

})
