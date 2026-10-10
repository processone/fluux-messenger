import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useArrivalJumpStore } from '@/stores/arrivalJumpStore'
import { renderHook } from '@testing-library/react'
import { useSettingsStore } from '@/stores/settingsStore'
import { setPlatformForTesting } from '@/platform'
import { postActionableEventNotification } from '@/utils/actionableEventNotification'
import { showWebNotification } from '@/utils/webNotification'

// vi.mock factories are hoisted to top of file, so mocks that reference vi.fn()
// vars must be declared with vi.hoisted() to be available before hoisting.
const {
  invoke,
  sendNotification,
  createChannel,
  onAction,
  listen,
  isMobileTauri,
  navigateToConversation,
  navigateToRoom,
  requestAttention,
  getNotificationPermissionGranted,
  addPluginListener,
} = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(null),
  addPluginListener: vi.fn<(plugin: string, event: string, callback: () => void) => Promise<{ unregister: () => void }>>()
    .mockResolvedValue({ unregister: vi.fn() }),
  sendNotification: vi.fn(),
  createChannel: vi.fn().mockResolvedValue(undefined),
  onAction: vi.fn<(callback: (notification: unknown) => void) => Promise<{ unregister: () => void }>>()
    .mockResolvedValue({ unregister: vi.fn() }),
  listen: vi.fn(() => Promise.resolve(() => {})),
  isMobileTauri: vi.fn().mockResolvedValue(false),
  navigateToConversation: vi.fn(),
  navigateToRoom: vi.fn(),
  requestAttention: vi.fn(),
  getNotificationPermissionGranted: vi.fn(() => true),
}))
let mockPresenceStatus = 'online'

// Capture the handlers the hook registers with useNotificationEvents.
let handlers: {
  onConversationMessage?: (conv: unknown, msg: unknown) => unknown
  onRoomMessage?: (room: unknown, msg: unknown) => unknown
} = {}

vi.mock('@tauri-apps/api/core', () => ({ invoke, addPluginListener }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@tauri-apps/plugin-notification', () => ({ sendNotification, onAction, createChannel, Importance: { Low: 2 } }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', version: () => '8.0.0' }))
vi.mock('@/utils/tauriPlatform', () => ({ isMobileTauri }))
vi.mock('@/utils/attention', () => ({ requestAttention }))
vi.mock('@/utils/notificationAvatar', () => ({ getNotificationAvatarUrl: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/utils/messagePreviewText', () => ({ formatLocalizedPreview: () => 'body text' }))
vi.mock('@/utils/notificationDebug', () => ({ notificationDebug: { desktopNotification: vi.fn() } }))
vi.mock('@/utils/webNotification', () => ({ showWebNotification: vi.fn() }))
vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation, navigateToRoom, navigateToContact: vi.fn() }),
}))
vi.mock('./useNotificationPermission', () => ({
  useNotificationPermission: () => {},
  getNotificationPermissionGranted,
}))
vi.mock('./useNotificationEvents', () => ({
  useNotificationEvents: (h: typeof handlers) => { handlers = h },
}))
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    rosterStore: { getState: () => ({ getContact: () => undefined }) },
    connectionStore: { getState: () => ({ jid: 'me@example.com' }) },
    roomStore: { getState: () => ({ getRoom: (jid: string) => (jid === 'team@conf.example.com' ? {} : undefined) }) },
    usePresence: () => ({ presenceStatus: mockPresenceStatus }),
    useConnectionStatus: () => ({ status: 'disconnected' }),
  }
})
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import { useDesktopNotifications } from './useDesktopNotifications'
import { chatStore } from '@fluux/sdk'
import type { Message } from '@fluux/sdk'
import { getNotificationAvatarUrl } from '@/utils/notificationAvatar'
import { setPreviewLedgerSession, clearPreviewLedgerSession } from '@/platform/ios/previewReadLedger'

describe('useDesktopNotifications posting + guard', () => {
  let restorePlatform: () => void
  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    isMobileTauri.mockResolvedValue(false)
    mockPresenceStatus = 'online'
    getNotificationPermissionGranted.mockReturnValue(true)
    useSettingsStore.setState({ soundEnabled: true })
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    restorePlatform()
  })

  it('posts a conversation with its client id even when a stanza id exists', async () => {
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.(
      { id: 'alice@example.com', name: 'Alice' },
      {
        id: 'message-1',
        stanzaId: 'server-stanza-1',
        from: 'alice@example.com',
      },
    )
    expect(invoke).toHaveBeenCalledWith('post_notification', {
      title: 'Alice',
      body: 'body text',
      navType: 'conversation',
      navTarget: 'alice@example.com',
      messageId: 'message-1',
      accountId: 'me@example.com',
      avatarPath: null,
      silent: false,
    })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(requestAttention).toHaveBeenCalledTimes(1)
  })

  it('withholds an iOS preview retracted during avatar loading', async () => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    isMobileTauri.mockResolvedValue(true)
    setPreviewLedgerSession({ account: 'me@example.com', epoch: 'synthetic' })
    const original = { id: 'avatar-race', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'private', ownArchiveId: 'archive-race', ownArchiveBy: 'me@example.com' } as Message
    chatStore.setState({ messages: new Map([[original.conversationId, [original]]]) })
    let finish!: (value: undefined) => void
    vi.mocked(getNotificationAvatarUrl).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    renderHook(() => useDesktopNotifications())
    const posting = handlers.onConversationMessage?.({ id: original.conversationId, name: 'Alice' }, original)
    await vi.waitFor(() => expect(getNotificationAvatarUrl).toHaveBeenCalled())
    chatStore.setState({ messages: new Map([[original.conversationId, [{ ...original, isRetracted: true }]]]) })
    finish(undefined)
    await posting
    expect(invoke).not.toHaveBeenCalledWith('plugin:notification|notify', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('plugin:push|set_notification_preview', expect.objectContaining({ operation: 'claimApp' }))
    clearPreviewLedgerSession()
    chatStore.setState({ messages: new Map() })
  })
  it('posts a room via the native desktop command', async () => {
    renderHook(() => useDesktopNotifications())
    await handlers.onRoomMessage?.(
      { jid: 'team@conf.example.com', name: 'Team' },
      { id: 'room-message-1', nick: 'bob' },
    )
    expect(invoke).toHaveBeenCalledWith('post_notification', {
      title: 'bob @ Team',
      body: 'body text',
      navType: 'room',
      navTarget: 'team@conf.example.com',
      messageId: 'room-message-1',
      accountId: 'me@example.com',
      avatarPath: null,
      silent: false,
    })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(requestAttention).toHaveBeenCalledTimes(1)
  })

  it('posts conversation and room notifications silent when the sound option is off', async () => {
    useSettingsStore.setState({ soundEnabled: false })
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.(
      { id: 'alice@example.com', name: 'Alice' },
      { id: 'message-1', from: 'alice@example.com' },
    )
    await handlers.onRoomMessage?.(
      { jid: 'team@conf.example.com', name: 'Team' },
      { id: 'room-message-1', nick: 'bob' },
    )
    const posted = invoke.mock.calls.filter(([command]) => command === 'post_notification')
    expect(posted).toHaveLength(2)
    for (const [, payload] of posted) expect(payload).toMatchObject({ silent: true })
  })

  // The coalesced-backlog count in the title is human-visible text, so it must
  // render through the shared formatUnreadCount and saturate as "999+" like the
  // sidebar badge and the command palette. See useDesktopNotifications.unreadCount.test.tsx
  // for the other half of the split (plural argument and payload stay numeric).
  it('formats the coalesced unread count in the notification title', async () => {
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.(
      { id: 'alice@example.com', name: 'Alice', unreadCount: 999 },
      { id: 'message-1', from: 'alice@example.com' },
    )
    expect(invoke).toHaveBeenCalledWith(
      'post_notification',
      expect.objectContaining({ title: 'Alice (999+)' }),
    )
  })

  it('renders an unsaturated coalesced count as the plain number', async () => {
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.(
      { id: 'alice@example.com', name: 'Alice', unreadCount: 7 },
      { id: 'message-1', from: 'alice@example.com' },
    )
    expect(invoke).toHaveBeenCalledWith(
      'post_notification',
      expect.objectContaining({ title: 'Alice (7)' }),
    )
  })

  it('uses the default Android channel when conversation sound is enabled', async () => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    isMobileTauri.mockResolvedValue(true)
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.(
      { id: 'alice@example.com', name: 'Alice' },
      { id: 'message-1', from: 'alice@example.com' },
    )
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
      options: {
        title: 'Alice',
        body: 'body text',
        attachments: undefined,
        extra: {
          navType: 'conversation',
          navTarget: 'alice@example.com',
          messageId: 'message-1',
          accountId: 'me@example.com',
        },
      },
    })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(createChannel).not.toHaveBeenCalled()
    expect(showWebNotification).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
  })

  it('uses the default Android channel when room sound is enabled', async () => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    isMobileTauri.mockResolvedValue(true)
    renderHook(() => useDesktopNotifications())
    await handlers.onRoomMessage?.(
      { jid: 'team@conf.example.com', name: 'Team' },
      { id: 'room-message-1', nick: 'bob' },
    )
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
      options: {
        title: 'bob @ Team',
        body: 'body text',
        attachments: undefined,
        extra: {
          navType: 'room',
          navTarget: 'team@conf.example.com',
          messageId: 'room-message-1',
          accountId: 'me@example.com',
        },
      },
    })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(createChannel).not.toHaveBeenCalled()
    expect(showWebNotification).not.toHaveBeenCalled()
  })

  it.each(['conversation', 'room'])('silences Android %s notifications', async (kind) => {
    const restoreAndroid = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    try {
      isMobileTauri.mockResolvedValue(true)
      useSettingsStore.setState({ soundEnabled: false })
      renderHook(() => useDesktopNotifications())

      if (kind === 'conversation') {
        await handlers.onConversationMessage?.(
          { id: 'alice@example.com', name: 'Alice' },
          { id: 'message-1', from: 'alice@example.com' },
        )
      } else {
        await handlers.onRoomMessage?.(
          { jid: 'team@conf.example.com', name: 'Team' },
          { id: 'room-message-1', nick: 'bob' },
        )
      }

      expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'fluux-silent', importance: 2 }))
      expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
        options: expect.objectContaining({
          channelId: 'fluux-silent',
          extra: expect.objectContaining({ navType: kind }),
        }),
      })
      expect(showWebNotification).not.toHaveBeenCalled()
    } finally {
      restoreAndroid()
    }
  })

  it.each(['contact-request', 'room-invitation', 'voice-request'] as const)(
    'silences Android %s events', async (navType) => {
      const restoreAndroid = setPlatformForTesting({ shell: 'mobile', os: 'android' })
      try {
        isMobileTauri.mockResolvedValue(true)
        useSettingsStore.setState({ soundEnabled: false })

        await postActionableEventNotification({
          key: 'event-1', navType, navTarget: 'alice@example.com', title: 'Request', body: 'hello',
        }, vi.fn())

        expect(createChannel).toHaveBeenCalledTimes(1)
        expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
          options: expect.objectContaining({
            channelId: 'fluux-silent',
            extra: expect.objectContaining({ navType }),
          }),
        })
        expect(showWebNotification).not.toHaveBeenCalled()
      } finally {
        restoreAndroid()
      }
    },
  )

  it('requests attention even when OS notification permission is denied', async () => {
    getNotificationPermissionGranted.mockReturnValue(false)
    renderHook(() => useDesktopNotifications())

    await handlers.onConversationMessage?.(
      { id: 'alice@example.com', name: 'Alice' },
      { from: 'alice@example.com' },
    )

    expect(requestAttention).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
  })

  it('does not request attention while Do Not Disturb is active', async () => {
    mockPresenceStatus = 'dnd'
    renderHook(() => useDesktopNotifications())

    await handlers.onConversationMessage?.(
      { id: 'alice@example.com', name: 'Alice' },
      { from: 'alice@example.com' },
    )

    expect(requestAttention).not.toHaveBeenCalled()
  })

  it('registers and drains desktop activation without the mobile listener', async () => {
    const { unmount } = renderHook(() => useDesktopNotifications())
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('take_pending_notification_target'))
    expect(listen).toHaveBeenCalledWith('notification-activated', expect.any(Function))
    expect(invoke).toHaveBeenCalledWith('set_notification_listener_ready', { ready: true })
    expect(onAction).not.toHaveBeenCalled()
    unmount()
    expect(invoke).toHaveBeenCalledWith('set_notification_listener_ready', { ready: false })
  })

  it.each(['android', 'ios'] as const)('routes %s activation and unregisters without desktop commands', async (os) => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os })
    const listener = { unregister: vi.fn() }
    onAction.mockResolvedValueOnce(listener)
    const { unmount } = renderHook(() => useDesktopNotifications())
    await onAction.mock.results[0].value
    const callback = onAction.mock.calls[0][0]
    callback({ extra: { navType: 'room', navTarget: 'team@conf.example.com', accountId: 'me@example.com' } })
    expect(navigateToRoom).toHaveBeenCalledWith('team@conf.example.com', undefined)
    unmount()
    expect(listener.unregister).toHaveBeenCalledTimes(1)
    expect(listener.unregister.mock.contexts[0]).toBe(listener)
    expect(listen).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('set_notification_listener_ready', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('take_pending_notification_target')
  })

  it('unregisters an Android listener that finishes registering after unmount', async () => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    const listener = { unregister: vi.fn() }
    let finishRegistration!: (value: typeof listener) => void
    const registration = new Promise<typeof listener>((resolve) => { finishRegistration = resolve })
    onAction.mockReturnValueOnce(registration)
    const { unmount } = renderHook(() => useDesktopNotifications())
    unmount()
    finishRegistration(listener)
    await registration
    expect(listener.unregister).toHaveBeenCalledTimes(1)
    expect(listener.unregister.mock.contexts[0]).toBe(listener)
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    { shell: 'mobile', os: 'other' },
    { shell: 'web', os: 'android' },
    { shell: 'web', os: 'ios' },
  ] as const)('does not register native activation on $shell/$os', (host) => {
    restorePlatform()
    restorePlatform = setPlatformForTesting(host)
    const { unmount } = renderHook(() => useDesktopNotifications())
    unmount()
    expect(onAction).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  describe('native push on iOS', () => {
    beforeEach(() => {
      restorePlatform()
      restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
      isMobileTauri.mockResolvedValue(true)
    })

    it('opens the conversation of a push tap that launched the app', async () => {
      invoke.mockImplementation(async (command: string) =>
        command === 'plugin:push|take_pending_tap'
          ? { payload: { aps: { alert: 'Hello' }, from: 'mrtest@process-one.net' } }
          : null)

      renderHook(() => useDesktopNotifications())

      await vi.waitFor(() => expect(navigateToConversation).toHaveBeenCalledWith('mrtest@process-one.net', undefined))
      expect(useArrivalJumpStore.getState().jump?.conversationId).toBe('mrtest@process-one.net')
      invoke.mockResolvedValue(null)
    })

    it('opens the room of a push tap while the app runs', async () => {
      renderHook(() => useDesktopNotifications())
      await vi.waitFor(() => expect(addPluginListener).toHaveBeenCalledWith('push', 'tap', expect.any(Function)))
      invoke.mockResolvedValueOnce({ payload: { from: 'team@conf.example.com/alice' } })

      addPluginListener.mock.calls[0][2]()

      await vi.waitFor(() => expect(navigateToRoom).toHaveBeenCalledWith('team@conf.example.com', undefined))
      expect(useArrivalJumpStore.getState().jump?.conversationId).toBe('team@conf.example.com')
    })

    afterEach(() => localStorage.removeItem('fluux-push-registration'))

    it('leaves a message stored for the absent session to the push that announced it', async () => {
      localStorage.setItem('fluux-push-registration', JSON.stringify({ jid: 'pushgate', node: 'n1' }))
      renderHook(() => useDesktopNotifications())

      await handlers.onConversationMessage?.(
        { id: 'alice@example.com', name: 'Alice' },
        { id: 'stored', from: 'alice@example.com', isDelayed: true },
      )
      expect(invoke).not.toHaveBeenCalledWith('plugin:notification|notify', expect.anything())

      await handlers.onConversationMessage?.(
        { id: 'alice@example.com', name: 'Alice' },
        { id: 'live', from: 'alice@example.com' },
      )
      expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', expect.anything())
    })

    it('still notifies a stored message when this device is not registered for push', async () => {
      renderHook(() => useDesktopNotifications())

      await handlers.onConversationMessage?.(
        { id: 'alice@example.com', name: 'Alice' },
        { id: 'stored', from: 'alice@example.com', isDelayed: true },
      )
      expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', expect.anything())
    })
  })
})
