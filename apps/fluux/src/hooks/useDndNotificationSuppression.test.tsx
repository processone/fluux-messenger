/**
 * Tests that DND (Do Not Disturb) presence suppresses sound and desktop notifications.
 *
 * Covers all four notification consumer hooks:
 * - useSoundNotification (message sounds)
 * - useDesktopNotifications (message desktop notifications)
 * - useEventsSoundNotification (event sounds)
 * - useEventsDesktopNotifications (event desktop notifications)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// --- Shared spies for assertion ---

const createOscillatorSpy = vi.fn()

// Class-based Notification mock (vi.fn doesn't work with `new`)
class MockNotification {
  static instances: MockNotification[] = []
  close = vi.fn()
  onclick: (() => void) | null = null
  constructor(public title: string, public options?: NotificationOptions) {
    MockNotification.instances.push(this)
  }
  static reset() {
    MockNotification.instances = []
  }
}

// --- Controllable mock state ---

let mockPresenceStatus = 'online'

const mockNotificationHandlers: {
  onConversationMessage?: (...args: unknown[]) => void
  onRoomMessage?: (...args: unknown[]) => void
} = {}

// Mock useNotificationEvents to capture handlers and allow manual triggering
vi.mock('./useNotificationEvents', () => ({
  useNotificationEvents: vi.fn((handlers: typeof mockNotificationHandlers) => {
    mockNotificationHandlers.onConversationMessage = handlers.onConversationMessage
    mockNotificationHandlers.onRoomMessage = handlers.onRoomMessage
  }),
}))

vi.mock('@/utils/notificationDebug', () => ({
  notificationDebug: {
    desktopNotification: vi.fn(),
    dockBadge: vi.fn(),
    focusChange: vi.fn(),
    unreadUpdate: vi.fn(),
  },
}))

vi.mock('@/utils/notificationAvatar', () => ({
  getNotificationAvatarUrl: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({
    navigateToConversation: vi.fn(),
    navigateToRoom: vi.fn(),
  }),
}))

const mockPermissionGranted = { current: true }
vi.mock('./useNotificationPermission', () => ({
  useNotificationPermission: () => mockPermissionGranted,
  isTauri: false,
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
  isPermissionGranted: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    usePresence: vi.fn(() => ({ presenceStatus: mockPresenceStatus })),
    useEvents: vi.fn(() => ({
      subscriptionRequests: [],
      pendingCount: 0,
    })),
    rosterStore: {
      getState: () => ({
        contacts: new Map(),
        getContact: () => undefined,
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    formatMessagePreview: vi.fn(() => 'test message'),
  }
})

// Import after mocks are set up
import { useSoundNotification } from './useSoundNotification'
import { useDesktopNotifications } from './useDesktopNotifications'
import { useEventsSoundNotification } from './useEventsSoundNotification'
import { useEventsDesktopNotifications } from './useEventsDesktopNotifications'
import { usePresence, useEvents } from '@fluux/sdk'

const mockUsePresence = vi.mocked(usePresence)
const mockUseEvents = vi.mocked(useEvents)

beforeEach(() => {
  vi.clearAllMocks()
  mockPresenceStatus = 'online'
  createOscillatorSpy.mockClear()
  MockNotification.reset()

  // Set up Web Audio mock with shared spy — use a plain function (not vi.fn)
  // because vitest's Mock class doesn't forward return values from `new` correctly
  const mockOscillator = {
    connect: vi.fn(),
    frequency: { value: 0 },
    type: 'sine',
    start: vi.fn(),
    stop: vi.fn(),
  }
  const mockGain = {
    connect: vi.fn(),
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
  }
  createOscillatorSpy.mockReturnValue(mockOscillator)

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  window.AudioContext = function AudioContext(this: Function) {
    return {
      currentTime: 0,
      state: 'running',
      destination: {},
      createOscillator: createOscillatorSpy,
      createGain: () => mockGain,
      resume: () => Promise.resolve(),
    }
  } as unknown as typeof AudioContext

  // Set up Notification mock
  // @ts-expect-error - replacing Notification with class mock
  globalThis.Notification = MockNotification

  mockUsePresence.mockReturnValue({ presenceStatus: 'online' } as ReturnType<typeof usePresence>)
})

describe('DND notification suppression', () => {
  describe('useSoundNotification', () => {
    it('should play sound when presence is online', () => {
      renderHook(() => useSoundNotification())

      act(() => {
        mockNotificationHandlers.onConversationMessage?.({}, {})
      })

      expect(createOscillatorSpy).toHaveBeenCalled()
    })

    it('should suppress sound when presence is dnd', () => {
      mockPresenceStatus = 'dnd'
      mockUsePresence.mockReturnValue({ presenceStatus: 'dnd' } as ReturnType<typeof usePresence>)
      renderHook(() => useSoundNotification())

      act(() => {
        mockNotificationHandlers.onConversationMessage?.({}, {})
      })

      expect(createOscillatorSpy).not.toHaveBeenCalled()
    })

    it('should suppress room sound when presence is dnd', () => {
      mockPresenceStatus = 'dnd'
      mockUsePresence.mockReturnValue({ presenceStatus: 'dnd' } as ReturnType<typeof usePresence>)
      renderHook(() => useSoundNotification())

      act(() => {
        mockNotificationHandlers.onRoomMessage?.({}, {}, true)
      })

      expect(createOscillatorSpy).not.toHaveBeenCalled()
    })
  })

  describe('useDesktopNotifications', () => {
    const mockConversation = { id: 'user@example.com', name: 'Test User' }
    const mockMessage = {
      id: 'msg-1',
      from: 'user@example.com',
      body: 'Hello',
      timestamp: new Date(),
      isOutgoing: false,
    }

    it('should show notification when presence is online', async () => {
      renderHook(() => useDesktopNotifications())

      await act(async () => {
        mockNotificationHandlers.onConversationMessage?.(mockConversation, mockMessage)
      })

      expect(MockNotification.instances).toHaveLength(1)
    })

    it('should suppress conversation notification when presence is dnd', async () => {
      mockPresenceStatus = 'dnd'
      mockUsePresence.mockReturnValue({ presenceStatus: 'dnd' } as ReturnType<typeof usePresence>)
      renderHook(() => useDesktopNotifications())

      await act(async () => {
        mockNotificationHandlers.onConversationMessage?.(mockConversation, mockMessage)
      })

      expect(MockNotification.instances).toHaveLength(0)
    })

    it('should suppress room notification when presence is dnd', async () => {
      mockPresenceStatus = 'dnd'
      mockUsePresence.mockReturnValue({ presenceStatus: 'dnd' } as ReturnType<typeof usePresence>)
      renderHook(() => useDesktopNotifications())

      const mockRoom = { jid: 'room@conference.example.com', name: 'Test Room' }
      const mockRoomMsg = { id: 'msg-2', nick: 'sender', body: 'Hi', timestamp: new Date() }

      await act(async () => {
        mockNotificationHandlers.onRoomMessage?.(mockRoom, mockRoomMsg, false)
      })

      expect(MockNotification.instances).toHaveLength(0)
    })
  })

  describe('useEventsSoundNotification', () => {
    it('should play sound for new subscription request when online', () => {
      mockUseEvents.mockReturnValue({
        subscriptionRequests: [],
        pendingCount: 0,
      } as unknown as ReturnType<typeof useEvents>)

      const { rerender } = renderHook(() => useEventsSoundNotification())

      mockUseEvents.mockReturnValue({
        subscriptionRequests: [{ from: 'new@example.com' }],
        pendingCount: 1,
      } as unknown as ReturnType<typeof useEvents>)
      rerender()

      expect(createOscillatorSpy).toHaveBeenCalled()
    })

    it('should suppress sound for new subscription request when dnd', () => {
      mockPresenceStatus = 'dnd'
      mockUsePresence.mockReturnValue({ presenceStatus: 'dnd' } as ReturnType<typeof usePresence>)
      mockUseEvents.mockReturnValue({
        subscriptionRequests: [],
        pendingCount: 0,
      } as unknown as ReturnType<typeof useEvents>)

      const { rerender } = renderHook(() => useEventsSoundNotification())

      mockUseEvents.mockReturnValue({
        subscriptionRequests: [{ from: 'new@example.com' }],
        pendingCount: 1,
      } as unknown as ReturnType<typeof useEvents>)
      rerender()

      expect(createOscillatorSpy).not.toHaveBeenCalled()
    })
  })

  describe('useEventsDesktopNotifications', () => {
    it('should show notification for new subscription request when online', () => {
      mockUseEvents.mockReturnValue({
        subscriptionRequests: [],
        pendingCount: 0,
      } as unknown as ReturnType<typeof useEvents>)

      const { rerender } = renderHook(() => useEventsDesktopNotifications())

      mockUseEvents.mockReturnValue({
        subscriptionRequests: [{ from: 'new@example.com' }],
        pendingCount: 1,
      } as unknown as ReturnType<typeof useEvents>)
      rerender()

      expect(MockNotification.instances).toHaveLength(1)
      expect(MockNotification.instances[0].title).toBe('Contact Request')
    })

    it('should suppress notification for new subscription request when dnd', () => {
      mockPresenceStatus = 'dnd'
      mockUsePresence.mockReturnValue({ presenceStatus: 'dnd' } as ReturnType<typeof usePresence>)
      mockUseEvents.mockReturnValue({
        subscriptionRequests: [],
        pendingCount: 0,
      } as unknown as ReturnType<typeof useEvents>)

      const { rerender } = renderHook(() => useEventsDesktopNotifications())

      mockUseEvents.mockReturnValue({
        subscriptionRequests: [{ from: 'new@example.com' }],
        pendingCount: 1,
      } as unknown as ReturnType<typeof useEvents>)
      rerender()

      expect(MockNotification.instances).toHaveLength(0)
    })

    it('should not burst notifications when exiting dnd', () => {
      mockPresenceStatus = 'dnd'
      mockUsePresence.mockReturnValue({ presenceStatus: 'dnd' } as ReturnType<typeof usePresence>)
      mockUseEvents.mockReturnValue({
        subscriptionRequests: [],
        pendingCount: 0,
      } as unknown as ReturnType<typeof useEvents>)

      const { rerender } = renderHook(() => useEventsDesktopNotifications())

      // Request arrives during DND — suppressed, but prevRequestsRef updated
      mockUseEvents.mockReturnValue({
        subscriptionRequests: [{ from: 'new@example.com' }],
        pendingCount: 1,
      } as unknown as ReturnType<typeof useEvents>)
      rerender()
      expect(MockNotification.instances).toHaveLength(0)

      // Exit DND — no new requests arrived, so no burst
      mockPresenceStatus = 'online'
      mockUsePresence.mockReturnValue({ presenceStatus: 'online' } as ReturnType<typeof usePresence>)
      rerender()

      expect(MockNotification.instances).toHaveLength(0)
    })
  })
})
