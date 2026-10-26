import { chatNotificationFixture, roomNotificationFixture, resetNotificationFixtures } from './notification.testHelpers'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useArrivalJumpStore } from '@/stores/arrivalJumpStore'
import { renderHook, waitFor } from '@testing-library/react'
import { useToastStore } from '@/stores/toastStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { setPlatformForTesting } from '@/platform'
import { postActionableEventNotification } from '@/utils/actionableEventNotification'
import { showWebNotification } from '@/utils/webNotification'
import { communicationMetadata } from '@/utils/localMessageNotification'
import type { ActionPerformed, ActiveNotification } from '@tauri-apps/plugin-notification'
import iosTapPayloads from '../../../../scripts/native-tests/NotificationTap/payloads.json'

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
  onAction: vi.fn<(callback: (event: ActionPerformed) => void) => Promise<{ unregister: () => void }>>()
    .mockResolvedValue({ unregister: vi.fn() }),
  listen: vi.fn(() => Promise.resolve(() => {})),
  isMobileTauri: vi.fn().mockResolvedValue(false),
  navigateToConversation: vi.fn(),
  navigateToRoom: vi.fn(),
  requestAttention: vi.fn(),
  getNotificationPermissionGranted: vi.fn(() => true),
}))
let mockPresenceStatus = 'online'
let mockWindowVisible = false
let mockJid = 'me@example.com'

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
  useNotificationEvents: (h: typeof handlers) => { handlers = {
    onConversationMessage: (conv, message) => h.onConversationMessage?.(...chatNotificationFixture(conv, message)),
    onRoomMessage: (room, message) => h.onRoomMessage?.(...roomNotificationFixture(room, message)),
  } },
}))
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    rosterStore: { getState: () => ({ getContact: () => undefined }) },
    connectionStore: { getState: () => ({ jid: mockJid, windowVisible: mockWindowVisible }) },
    roomStore: { getState: () => ({ ...actual.roomStore.getState(), getRoom: (jid: string) => (jid === 'team@conf.example.com' ? {} : undefined) }) },
    usePresence: () => ({ presenceStatus: mockPresenceStatus }),
    useConnectionStatus: () => ({ status: 'disconnected' }),
  }
})
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import { useDesktopNotifications } from './useDesktopNotifications'
import { chatStore } from '@fluux/sdk'
import { roomStore } from '@fluux/sdk/stores'
import type { Message, RoomOccupant } from '@fluux/sdk'
import { getNotificationAvatarUrl } from '@/utils/notificationAvatar'
import { setPreviewLedgerSession, clearPreviewLedgerSession } from '@/platform/ios/previewReadLedger'

describe('useDesktopNotifications posting + guard', () => {
  let restorePlatform: () => void
  beforeEach(() => {
    resetNotificationFixtures()
    vi.stubGlobal('__FLUUX_COMMUNICATION_TEST__', true)
    vi.clearAllMocks()
    handlers = {}
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    isMobileTauri.mockResolvedValue(false)
    mockPresenceStatus = 'online'
    mockWindowVisible = false
    mockJid = 'me@example.com'
    useSettingsStore.setState({ inAppBannerEnabled: true })
    useToastStore.setState({ toasts: [] })
    getNotificationPermissionGranted.mockReturnValue(true)
    useSettingsStore.setState({ soundEnabled: true })
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    restorePlatform()
    vi.unstubAllGlobals()
  })

  // FLM-110 F2: ordinary desktop hosts retain one legacy alert, without walking the room roster.
  it.each(['macos', 'windows', 'linux'] as const)('skips communication metadata and preparation on normal %s hosts', async os => {
    vi.unstubAllGlobals()
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os })
    const occupants = new Map([
      ['bob', { nick: 'bob', occupantId: 'stable-bob', affiliation: 'member', role: 'participant' }],
      ['me', { nick: 'me', occupantId: 'stable-me', affiliation: 'member', role: 'participant' }],
    ])
    // SDK fixture creation may walk occupants; measure only the metadata interface after setup.
    const [room, message] = roomNotificationFixture(
      { jid: 'team@conf.example.com', name: 'Team', nickname: 'me', occupants },
      { id: 'ordinary-room-alert', nick: 'bob', occupantId: 'stable-bob' })
    const enumerate = vi.spyOn(room.occupants, 'values')
    expect(communicationMetadata({ kind: 'room', entity: room, message })).toBeUndefined()
    expect(enumerate).not.toHaveBeenCalled()
    enumerate.mockRestore()
    renderHook(() => useDesktopNotifications())
    await handlers.onRoomMessage?.({ jid: 'team@conf.example.com', name: 'Team', nickname: 'me', occupants },
      { id: 'ordinary-room-alert', nick: 'bob', occupantId: 'stable-bob' })
    expect(invoke.mock.calls.map(([command]) => command).filter(command =>
      ['prepare_communication_notification', 'finish_communication_notification', 'post_notification'].includes(command),
    )).toEqual(['post_notification'])
    expect(invoke).toHaveBeenCalledWith('post_notification', expect.objectContaining({
      title: 'bob @ Team', body: 'body text', navTarget: 'team@conf.example.com', messageId: 'ordinary-room-alert',
    }))
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
    // N3: metadata belongs to preparation, not the legacy posting payload.
    expect(invoke).toHaveBeenCalledWith('prepare_communication_notification', { payload: expect.objectContaining({
      communication: { senderId: 'alice@example.com', senderName: 'Alice' },
    }) })
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

  // FLM-145: with Fluux in front, its own banner replaces the system one.
  describe('in-app banner while Fluux is in front', () => {
    const arrive = (id: string, name: string) => handlers.onConversationMessage?.(
      { id, name }, { id: `m-${id}`, from: id })

    beforeEach(() => { mockWindowVisible = true })

    it('shows a banner with the sender and preview, and no system notification', async () => {
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual(['Alice: body text'])
      expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
    })

    it('opens the conversation at the message when tapped', async () => {
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      useToastStore.getState().toasts[0].onClick?.()
      expect(navigateToConversation).toHaveBeenCalledWith('alice@example.com', 'm-alice@example.com')
    })

    it('replaces the previous banner with the newer one', async () => {
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      await arrive('carol@example.com', 'Carol')
      expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual(['Carol: body text'])
    })

    it('hides after 5 seconds', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        renderHook(() => useDesktopNotifications())
        await arrive('alice@example.com', 'Alice')
        vi.advanceTimersByTime(5000)
        expect(useToastStore.getState().toasts).toEqual([])
      } finally { vi.useRealTimers() }
    })

    it('plays one light haptic on iPhone and none elsewhere', async () => {
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(invoke).not.toHaveBeenCalledWith('plugin:ios-feedback|haptic', expect.anything())
      restorePlatform()
      restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
      isMobileTauri.mockResolvedValue(true)
      await arrive('bob@example.com', 'Bob')
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:ios-feedback|haptic', { kind: 'selection' }))
      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'plugin:ios-feedback|haptic')).toHaveLength(1)
      expect(invoke).not.toHaveBeenCalledWith('plugin:push|post_notification', expect.anything())
    })

    it('shows nothing and plays no haptic in Do Not Disturb', async () => {
      mockPresenceStatus = 'dnd'
      restorePlatform()
      restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(useToastStore.getState().toasts).toEqual([])
      expect(invoke).not.toHaveBeenCalledWith('plugin:ios-feedback|haptic', expect.anything())
    })

    // Review R3: the banner is in-app, so system permission does not gate it.
    it('shows the banner and haptic without system notification permission', async () => {
      getNotificationPermissionGranted.mockReturnValue(false)
      restorePlatform()
      restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(useToastStore.getState().toasts).toHaveLength(1)
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:ios-feedback|haptic', { kind: 'selection' }))
    })

    // Review R5: no unused avatar preparation that could finish after a newer banner.
    it('does not prepare an avatar for the banner', async () => {
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(getNotificationAvatarUrl).not.toHaveBeenCalled()
    })

    it('shows no banner and no haptic when Show banner is off', async () => {
      useSettingsStore.setState({ inAppBannerEnabled: false })
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(useToastStore.getState().toasts).toEqual([])
      expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
    })

    // Review R6: the global toast must not outlive the hook or its account.
    it('removes its banner on unmount', async () => {
      const { unmount } = renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      unmount()
      expect(useToastStore.getState().toasts).toEqual([])
    })

    it('ignores a tap from a previous account', async () => {
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      const [toast] = useToastStore.getState().toasts
      mockJid = 'other@example.com'
      toast.onClick?.()
      expect(navigateToConversation).not.toHaveBeenCalled()
    })

    // Review R10: Fluux can come to the front while the avatar is being prepared.
    it('uses the banner when the window comes to the front during avatar preparation', async () => {
      mockWindowVisible = false
      vi.mocked(getNotificationAvatarUrl).mockImplementationOnce(async () => { mockWindowVisible = true; return undefined })
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual(['Alice: body text'])
      expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
    })

    it('shows nothing when it comes to the front during preparation and Show banner is off', async () => {
      mockWindowVisible = false
      useSettingsStore.setState({ inAppBannerEnabled: false })
      vi.mocked(getNotificationAvatarUrl).mockImplementationOnce(async () => { mockWindowVisible = true; return undefined })
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(useToastStore.getState().toasts).toEqual([])
      expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
    })

    it('keeps the system notification when the window is not in front', async () => {
      mockWindowVisible = false
      renderHook(() => useDesktopNotifications())
      await arrive('alice@example.com', 'Alice')
      expect(useToastStore.getState().toasts).toEqual([])
      expect(invoke).toHaveBeenCalledWith('post_notification', expect.objectContaining({ title: 'Alice' }))
    })
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

  it('posts the selected iOS row when a retracted row shares its client ID', async () => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    isMobileTauri.mockResolvedValue(true)
    setPreviewLedgerSession({ account: 'me@example.com', epoch: 'synthetic' })
    invoke.mockImplementation(async (command) => command === 'plugin:push|set_notification_preview' ? { allowed: true } : null)
    const fresh = {
      type: 'chat', id: 'reused', stanzaId: 'second', originId: undefined,
      conversationId: 'alice@example.com', from: 'alice@example.com', body: 'new message',
      timestamp: new Date(), isOutgoing: false, ownArchiveId: 'second', ownArchiveBy: 'me@example.com',
    } satisfies Message
    const old = { ...fresh, stanzaId: 'first', ownArchiveId: 'first', isRetracted: true }
    renderHook(() => useDesktopNotifications())
    // Seed both rows after the fixture adds the actual arriving message.
    vi.mocked(getNotificationAvatarUrl).mockImplementationOnce(async () => {
      chatStore.setState({ messages: new Map([[fresh.conversationId, [old, fresh]]]) })
      return undefined
    })
    try {
      await handlers.onConversationMessage?.({ id: fresh.conversationId, name: 'Alice' }, fresh)
      expect(invoke).toHaveBeenCalledWith('plugin:push|set_notification_preview', expect.objectContaining({
        operation: 'claimApp', deltas: [expect.objectContaining({ uid: 'second' })],
      }))
      expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', expect.anything())
    } finally {
      clearPreviewLedgerSession()
      chatStore.setState({ messages: new Map() })
      invoke.mockResolvedValue(null)
    }
  })
  // Captain's F5 choice: refresh only display names; other metadata/eligibility changes still cancel.
  it.each(['contact', 'room', 'other-metadata'] as const)('finalizes preparation after a %s change with current presentation only', async change => {
    let prepared!: (token: string) => void
    invoke.mockImplementation((command: string) => command === 'prepare_communication_notification'
      ? new Promise<string>(resolve => { prepared = resolve }) : Promise.resolve(null))
    try {
      renderHook(() => useDesktopNotifications())
      const posting = change === 'contact'
        ? handlers.onConversationMessage?.({ id: 'alice@example.com', name: 'Alice' }, { id: 'rename-contact', from: 'alice@example.com' })
        : handlers.onRoomMessage?.({ jid: 'team@conf.example.com', name: 'Team', nickname: 'me',
          occupants: new Map([['bob', { nick: 'bob', occupantId: 'stable-bob', affiliation: 'member', role: 'participant' }],
            ['me', { nick: 'me', occupantId: 'stable-me', affiliation: 'member', role: 'participant' }]]) },
        { id: 'rename-room', nick: 'bob', occupantId: 'stable-bob' })
      await vi.waitFor(() => expect(prepared).toBeTypeOf('function'))
      if (change === 'contact') chatStore.getState().updateConversationName('alice@example.com', 'Alicia')
      else roomStore.getState().updateRoom('team@conf.example.com', change === 'room' ? { name: 'Projects' } : { nickname: 'another-self' })
      prepared('rename-token')
      await posting
      expect(invoke).toHaveBeenCalledWith('finish_communication_notification', change === 'other-metadata'
        ? { token: 'rename-token', commit: false }
        : { token: 'rename-token', commit: true, names: change === 'contact'
          ? { title: 'Alicia', senderName: 'Alicia' }
          : { title: 'bob @ Projects', senderName: 'bob', roomName: 'Projects' } })
      expect(invoke.mock.calls.filter(([command]) => command === 'finish_communication_notification')).toHaveLength(1)
      expect(invoke.mock.calls.some(([command]) => command === 'post_notification')).toBe(false)
    } finally { invoke.mockResolvedValue(null) }
  })

  // FLM-125 R2 / captain's F5 choice: prepared recipients are a snapshot, not message identity.
  it.each(['joins', 'leaves'] as const)('keeps a prepared room alert when an occupant %s', async change => {
    let prepared!: (token: string) => void
    invoke.mockImplementation((command: string) => command === 'prepare_communication_notification'
      ? new Promise<string>(resolve => { prepared = resolve }) : Promise.resolve(null))
    try {
      const occupants = new Map<string, RoomOccupant>([
        ['bob', { nick: 'bob', occupantId: 'stable-bob', affiliation: 'member', role: 'participant' }],
        ['me', { nick: 'me', occupantId: 'stable-me', affiliation: 'member', role: 'participant' }],
        ['charlie', { nick: 'charlie', occupantId: 'stable-charlie', affiliation: 'member', role: 'participant' }],
      ])
      renderHook(() => useDesktopNotifications())
      const posting = handlers.onRoomMessage?.({ jid: 'team@conf.example.com', name: 'Team', nickname: 'me', occupants },
        { id: 'occupancy-during-prepare', nick: 'bob', occupantId: 'stable-bob' })
      await vi.waitFor(() => expect(prepared).toBeTypeOf('function'))
      const current = new Map(occupants)
      if (change === 'joins') current.set('dana', { nick: 'dana', occupantId: 'stable-dana', affiliation: 'member', role: 'participant' })
      else current.delete('charlie')
      roomStore.getState().updateRoom('team@conf.example.com', { occupants: current })
      prepared('occupancy-token')
      await posting
      expect(invoke).toHaveBeenCalledWith('finish_communication_notification', { token: 'occupancy-token', commit: true })
      expect(invoke.mock.calls.filter(([command]) => command === 'prepare_communication_notification')).toHaveLength(1)
      expect(invoke.mock.calls.filter(([command]) => command === 'finish_communication_notification')).toHaveLength(1)
      expect(invoke.mock.calls.some(([command]) => command === 'post_notification')).toBe(false)
    } finally { invoke.mockResolvedValue(null) }
  })

  // Source intent: #1386 requires a second eligibility check after native preparation.
  it.each(['read', 'permission', 'dnd', 'unmount'])('cancels native preparation after %s changes', async (change) => {
    let prepared!: (token: string) => void
    invoke.mockImplementation((command: string) => command === 'prepare_communication_notification'
      ? new Promise<string>(resolve => { prepared = resolve }) : Promise.resolve(null))
    try {
      const { rerender, unmount } = renderHook(() => useDesktopNotifications())
      const posting = handlers.onConversationMessage?.({ id: 'alice@example.com', name: 'Alice' },
        { id: 'prepared-message', from: 'alice@example.com' })
      await waitFor(() => expect(prepared).toBeTypeOf('function'))
      if (change === 'read') chatStore.getState().markAsRead('alice@example.com')
      if (change === 'permission') getNotificationPermissionGranted.mockReturnValue(false)
      if (change === 'unmount') unmount()
      if (change === 'dnd') {
        mockPresenceStatus = 'dnd'
        rerender()
      }
      prepared('native-prepared-token')
      await posting
      expect(invoke).toHaveBeenCalledWith('finish_communication_notification', {
        token: 'native-prepared-token', commit: false,
      })
      expect(invoke.mock.calls.some(([command]) => command === 'post_notification')).toBe(false)
    } finally { invoke.mockResolvedValue(null) }
  })

  it('passes stable occupant IDs separately from room names and sender nicks for #1386', async () => {
    renderHook(() => useDesktopNotifications())
    await handlers.onRoomMessage?.({ jid: 'team@conf.example.com', name: 'Team', nickname: 'me',
      occupants: new Map([
        ['bob', { nick: 'bob', occupantId: 'stable-bob', affiliation: 'member', role: 'participant' }],
        ['me', { nick: 'me', occupantId: 'stable-me', affiliation: 'member', role: 'participant' }],
      ]),
    }, { id: 'room-stable-sender', nick: 'bob', occupantId: 'stable-bob' })
    expect(invoke).toHaveBeenCalledWith('prepare_communication_notification', { payload: expect.objectContaining({
      communication: { senderId: 'stable-bob', senderName: 'bob', senderNick: 'bob', roomName: 'Team', ownNick: 'me',
        participantIds: { bob: 'stable-bob', me: 'stable-me' }, participants: ['bob', 'me'] },
    }) })
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

  it('routes Android activation and unregisters without desktop commands', async () => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    const listener = { unregister: vi.fn() }
    onAction.mockResolvedValueOnce(listener)
    const { unmount } = renderHook(() => useDesktopNotifications())
    await onAction.mock.results[0].value
    // PR #1727 refreshes the Android plugin to its ActionPerformed envelope.
    // Preserve message navigation and the account guard through the Android payload.
    const callback = onAction.mock.calls[0][0]
    const notification: ActiveNotification = {
      id: 1, groupSummary: false, data: {}, attachments: [],
      extra: {
        navType: 'room', navTarget: 'team@conf.example.com',
        accountId: 'me@example.com', messageId: 'room-message-1',
      },
    }
    callback({ actionId: 'tap', inputValue: null, notification })
    expect(navigateToRoom).toHaveBeenCalledExactlyOnceWith('team@conf.example.com', 'room-message-1')
    navigateToRoom.mockClear()
    callback({ actionId: 'tap', inputValue: null, notification: null })
    callback({
      actionId: 'tap', inputValue: null,
      notification: { ...notification, extra: { ...notification.extra, accountId: 'other@example.com' } },
    })
    expect(navigateToRoom).not.toHaveBeenCalled()
    expect(navigateToConversation).not.toHaveBeenCalled()
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

    // FLM-95: these userInfo fixtures are checked against the installed Swift
    // notification plugin by scripts/native-tests/NotificationTap/run.sh.
    it.each(iosTapPayloads)('opens $options.extra.navType from the retained iOS local payload', async ({ userInfo, options, actionPerformed }) => {
      const listener = { unregister: vi.fn() }
      addPluginListener.mockResolvedValueOnce(listener)
      invoke.mockImplementation(async (command) => command === 'plugin:push|take_pending_tap' ? {} : null)
      useArrivalJumpStore.setState({ jump: null })
      const { unmount } = renderHook(() => useDesktopNotifications())
      await vi.waitFor(() => expect(addPluginListener).toHaveBeenCalledWith('push', 'tap', expect.any(Function)))
      // The upstream iOS action envelope has no extra and cannot route a tap.
      expect(actionPerformed.notification).not.toHaveProperty('extra')
      expect(onAction).not.toHaveBeenCalled()
      const callback = addPluginListener.mock.calls[0][2]
      invoke.mockResolvedValueOnce({ payload: userInfo })
      callback()
      const navigate = options.extra.navType === 'room' ? navigateToRoom : navigateToConversation
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(options.extra.navTarget, options.extra.messageId))
      expect(useArrivalJumpStore.getState().jump).toBeNull()
      navigate.mockClear()
      invoke.mockResolvedValueOnce({ payload: { __EXTRA__: { ...userInfo.__EXTRA__, accountId: 'other@example.com' } } })
      callback()
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3))
      expect(navigate).not.toHaveBeenCalled()
      unmount()
      expect(listener.unregister).toHaveBeenCalledTimes(1)
      invoke.mockResolvedValue(null)
    })

    it('drains a local tap once when it arrived before the hook mounted', async () => {
      const { userInfo, options } = iosTapPayloads[0]
      let pending: typeof userInfo | null = userInfo
      invoke.mockImplementation(async (command) => {
        if (command !== 'plugin:push|take_pending_tap') return null
        const payload = pending
        pending = null
        return { payload }
      })
      const { unmount } = renderHook(() => useDesktopNotifications())
      await vi.waitFor(() => expect(navigateToConversation).toHaveBeenCalledExactlyOnceWith(options.extra.navTarget, options.extra.messageId))
      addPluginListener.mock.calls[0][2]()
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
      expect(navigateToConversation).toHaveBeenCalledTimes(1)
      unmount()
      invoke.mockResolvedValue(null)
    })

    it('does not route a local tap whose read completes after unmount', async () => {
      let finish!: (value: { payload: typeof iosTapPayloads[0]['userInfo'] }) => void
      invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
      const { unmount } = renderHook(() => useDesktopNotifications())
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      unmount()
      finish({ payload: iosTapPayloads[0].userInfo })
      await Promise.resolve()
      expect(navigateToConversation).not.toHaveBeenCalled()
      expect(navigateToRoom).not.toHaveBeenCalled()
      invoke.mockResolvedValue(null)
    })

    it('drains a tap retained while the iOS listener is registering', async () => {
      let registered!: (value: { unregister: () => void }) => void
      addPluginListener.mockReturnValueOnce(new Promise(resolve => { registered = resolve }))
      invoke.mockResolvedValue({ payload: iosTapPayloads[0].userInfo })
      const { unmount } = renderHook(() => useDesktopNotifications())
      expect(invoke).not.toHaveBeenCalledWith('plugin:push|take_pending_tap')
      registered({ unregister: vi.fn() })
      const { navTarget, messageId } = iosTapPayloads[0].options.extra
      await vi.waitFor(() => expect(navigateToConversation).toHaveBeenCalledExactlyOnceWith(navTarget, messageId))
      unmount()
      invoke.mockResolvedValue(null)
    })

    it('still reads a retained local tap if live event registration fails', async () => {
      addPluginListener.mockRejectedValueOnce(new Error('listener unavailable'))
      invoke.mockResolvedValue({ payload: iosTapPayloads[0].userInfo })
      const { unmount } = renderHook(() => useDesktopNotifications())
      const { navTarget, messageId } = iosTapPayloads[0].options.extra
      await vi.waitFor(() => expect(navigateToConversation).toHaveBeenCalledExactlyOnceWith(navTarget, messageId))
      unmount()
      invoke.mockResolvedValue(null)
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

describe('useDesktopNotifications system post gate (FLM-152 R10)', () => {
  let restorePlatform: () => void
  beforeEach(() => {
    resetNotificationFixtures()
    vi.clearAllMocks()
    handlers = {}
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    isMobileTauri.mockResolvedValue(false)
    mockPresenceStatus = 'online'
    mockWindowVisible = false
    getNotificationPermissionGranted.mockReturnValue(true)
    useSettingsStore.setState({ soundEnabled: true, inAppBannerEnabled: true })
    useToastStore.setState({ toasts: [] })
  })
  afterEach(() => { restorePlatform(); invoke.mockReset(); invoke.mockResolvedValue(null) })

  it('uses the banner when Fluux comes to the front while the native post is being prepared', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'prepare_communication_notification') mockWindowVisible = true
      return null
    })
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.({ id: 'alice@example.com', name: 'Alice' }, { id: 'm1', from: 'alice@example.com' })
    expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
    expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual(['Alice: body text'])
  })

  it('shows nothing in that case when Show banner is off', async () => {
    useSettingsStore.setState({ inAppBannerEnabled: false })
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'prepare_communication_notification') mockWindowVisible = true
      return null
    })
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.({ id: 'alice@example.com', name: 'Alice' }, { id: 'm1', from: 'alice@example.com' })
    expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
    expect(useToastStore.getState().toasts).toEqual([])
  })
})
})
