import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { RoomInvitation, RoomVoiceRequest, StrangerMessage, SubscriptionRequest } from '@fluux/sdk'

const {
  invoke,
  isMobileTauri,
  postPluginNotification,
  navigators,
  getNotificationPermissionGranted,
  presence,
  occupants,
} = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  isMobileTauri: vi.fn().mockResolvedValue(false),
  postPluginNotification: vi.fn().mockResolvedValue(undefined),
  navigators: {
    navigateToConversation: vi.fn(),
    navigateToRoom: vi.fn(),
    navigateToContact: vi.fn(),
    navigateToContactRequests: vi.fn(),
    navigateToRoomInvitations: vi.fn(),
  },
  getNotificationPermissionGranted: vi.fn(() => true),
  presence: { status: 'online' },
  occupants: new Map<string, { role: string; occupantId?: string }>(),
}))

interface EventsSlice {
  subscriptionRequests: SubscriptionRequest[]
  strangerMessages: StrangerMessage[]
  mucInvitations: RoomInvitation[]
  voiceRequests: RoomVoiceRequest[]
}

const emptyEvents = (): EventsSlice => ({
  subscriptionRequests: [],
  strangerMessages: [],
  mucInvitations: [],
  voiceRequests: [],
})

const events = createStore<EventsSlice>(() => emptyEvents())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/utils/tauriPlatform', () => ({ isMobileTauri }))
vi.mock('@/utils/postPluginNotification', () => ({ postPluginNotification }))
vi.mock('./useNavigateToTarget', () => ({ useNavigateToTarget: () => navigators }))
vi.mock('./useNotificationPermission', () => ({
  useNotificationPermission: () => {},
  getNotificationPermissionGranted,
}))
vi.mock('@fluux/sdk/react', () => ({
  useEventsStore: <T,>(selector: (s: EventsSlice) => T) => useStore(events, selector),
}))
vi.mock('@fluux/sdk', () => ({
  connectionStore: { getState: () => ({ jid: 'me@example.com/desk' }) },
  roomStore: {
    getState: () => ({
      getRoom: (jid: string) => (jid === 'team@conf.example.com' ? { name: 'Team', occupants } : undefined),
    }),
  },
  getBareJid: (jid: string) => jid.split('/')[0],
  getLocalPart: (jid: string) => jid.split('@')[0],
  usePresence: () => ({ presenceStatus: presence.status }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

import { useEventsDesktopNotifications } from './useEventsDesktopNotifications'
import { setPlatformForTesting } from '@/platform'

const request = (from: string): SubscriptionRequest => ({ id: `id-${from}`, from, timestamp: new Date(0) })
const invitation = (roomJid: string, from: string): RoomInvitation => ({
  id: `inv-${roomJid}`, roomJid, from, timestamp: new Date(0), isDirect: true, isQuickChat: false,
})
const voice = (nick: string, id = `voice-${nick}`, stanzaId: string | undefined = id): RoomVoiceRequest => ({
  id, ...(stanzaId && { stanzaId }), roomJid: 'team@conf.example.com', nick, jid: `${nick}@example.com/phone`,
})
const idlessVoice = (nick: string, id: string): RoomVoiceRequest => ({
  id, roomJid: 'team@conf.example.com', nick, jid: `${nick}@example.com/phone`,
})

function setEvents(patch: Partial<EventsSlice>) {
  act(() => events.setState(patch))
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

interface ShownNotification {
  title: string
  options: NotificationOptions
}

let restorePlatform: () => void = () => {}
let shown: ShownNotification[]
let delivered: { tag?: string; close: () => void }[]
let closed: string[]
const NotificationCtor = vi.fn()

function installServiceWorker() {
  const registration = {
    showNotification: vi.fn(async (title: string, options: NotificationOptions) => {
      shown.push({ title, options })
      const tag = options.tag
      delivered.push({ tag, close: () => closed.push(tag ?? '') })
    }),
    getNotifications: vi.fn(async ({ tag }: { tag?: string } = {}) => delivered.filter((n) => n.tag === tag)),
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => registration, ready: Promise.resolve(registration) },
  })
  return registration
}

function removeServiceWorker() {
  // `in` must be false for the helper to take the constructor path.
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
}

describe('useEventsDesktopNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    occupants.clear()
    events.setState(emptyEvents())
    presence.status = 'online'
    getNotificationPermissionGranted.mockReturnValue(true)
    isMobileTauri.mockResolvedValue(false)
    shown = []
    delivered = []
    closed = []
    restorePlatform = setPlatformForTesting({ shell: 'web', os: 'linux' })
    NotificationCtor.mockReset()
    vi.stubGlobal('Notification', NotificationCtor)
    installServiceWorker()
  })

  afterEach(() => {
    restorePlatform()
    removeServiceWorker()
    vi.unstubAllGlobals()
  })

  describe('web delivery', () => {
    it('shows a contact request through the service worker, not the constructor', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()

      expect(shown).toHaveLength(1)
      expect(shown[0].title).toBe('events.contactRequestTitle')
      expect(shown[0].options.body).toBe('events.contactRequestBody {"name":"alice"}')
      expect(shown[0].options.data).toEqual({
        from: 'alice@example.com', type: 'contact-request', accountId: 'me@example.com',
      })
      expect(NotificationCtor).not.toHaveBeenCalled()
    })

    it('falls back to the constructor when no service worker is available', async () => {
      removeServiceWorker()
      const instance: { onclick?: () => void; close: () => void } = { close: vi.fn() }
      NotificationCtor.mockImplementation(function () { return instance })

      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()

      expect(NotificationCtor).toHaveBeenCalledWith(
        'events.contactRequestTitle',
        expect.objectContaining({ tag: 'contact-request-alice@example.com:account:me%40example.com' }),
      )
      instance.onclick?.()
      expect(navigators.navigateToContactRequests).toHaveBeenCalledTimes(1)
    })

    it('does not throw when the browser rejects the Notification constructor', async () => {
      removeServiceWorker()
      NotificationCtor.mockImplementation(function () {
        throw new TypeError("Failed to construct 'Notification': Illegal constructor.")
      })

      renderHook(() => useEventsDesktopNotifications())
      expect(() => setEvents({ subscriptionRequests: [request('alice@example.com')] })).not.toThrow()
      await flush()
      expect(NotificationCtor).toHaveBeenCalledTimes(1)
    })
  })

  describe('which events notify', () => {
    it('notifies a room invitation with a click target on the invitation list', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ mucInvitations: [invitation('lounge@conf.example.com', 'carol@example.com')] })
      await flush()

      expect(shown).toHaveLength(1)
      expect(shown[0].title).toBe('events.roomInvitationTitle')
      expect(shown[0].options.body).toBe('events.roomInvitationBody {"name":"carol","room":"lounge"}')
      expect(shown[0].options.data).toEqual({
        from: 'lounge@conf.example.com', type: 'room-invitation', accountId: 'me@example.com',
      })
    })

    it('notifies a voice request with a click target on the room', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ voiceRequests: [voice('bob')] })
      await flush()

      expect(shown).toHaveLength(1)
      expect(shown[0].title).toBe('events.voiceRequestTitle')
      expect(shown[0].options.body).toBe('events.voiceRequestBody {"nick":"bob","room":"Team"}')
      expect(shown[0].options.data).toEqual({
        from: 'team@conf.example.com/bob', type: 'voice-request', accountId: 'me@example.com',
      })
    })

    it('raises no system notification for a message from a stranger', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({
        strangerMessages: [{ id: 's1', from: 'spam@example.com', body: 'hi', timestamp: new Date(0) }],
        mucInvitations: [invitation('lounge@conf.example.com', 'carol@example.com')],
      })
      await flush()

      // Only the invitation alerts; the stranger's message stays counter-only.
      expect(shown.map((n) => n.options.tag)).toEqual(['room-invitation-lounge@conf.example.com:account:me%40example.com'])
      expect(NotificationCtor).not.toHaveBeenCalled()
    })
  })

  describe('one alert per event', () => {
    it('does not repeat an alert when the store republishes the same events', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      setEvents({ subscriptionRequests: [request('alice@example.com'), request('dave@example.com')] })
      await flush()

      expect(shown.map((n) => n.options.tag)).toEqual([
        'contact-request-alice@example.com:account:me%40example.com',
        'contact-request-dave@example.com:account:me%40example.com',
      ])
    })

    it('alerts again for a voice request the occupant renews', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ voiceRequests: [voice('bob', 'first')] })
      await flush()
      setEvents({ voiceRequests: [voice('bob', 'second')] })
      await flush()

      expect(shown).toHaveLength(2)
    })

    it('does not repeat an id-less voice request after reconnect', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ voiceRequests: [idlessVoice('bob', 'generated-first')] })
      await flush()
      setEvents({ voiceRequests: [] })
      setEvents({ voiceRequests: [idlessVoice('bob', 'generated-replay')] })
      await flush()

      expect(shown).toHaveLength(1)
    })

    it('alerts for a new id-less voice request after voice was granted', async () => {
      occupants.set('bob', { role: 'visitor', occupantId: 'bob-occupant' })
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ voiceRequests: [idlessVoice('bob', 'generated-first')] })
      await flush()
      occupants.set('bob', { role: 'participant', occupantId: 'bob-occupant' })
      setEvents({ voiceRequests: [] })
      await flush()
      occupants.set('bob', { role: 'visitor', occupantId: 'bob-occupant' })
      setEvents({ voiceRequests: [idlessVoice('bob', 'generated-renewed')] })
      await flush()

      expect(shown).toHaveLength(2)
    })

    it('does not alert at login for an event already notified in an earlier session', async () => {
      events.setState({ subscriptionRequests: [request('alice@example.com')] })
      const first = renderHook(() => useEventsDesktopNotifications())
      await flush()
      expect(shown).toHaveLength(1)
      first.unmount()

      // A new login: the server redelivers the same pending request.
      events.setState(emptyEvents())
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()

      expect(shown).toHaveLength(1)
    })

    it('alerts again when a contact asks again after the request was handled', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()
      setEvents({ subscriptionRequests: [] })
      await flush()
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()

      expect(shown).toHaveLength(2)
    })
  })

  describe('suppression', () => {
    it('suppresses every event kind during Do Not Disturb, without alerting once it ends', async () => {
      presence.status = 'dnd'
      const { rerender } = renderHook(() => useEventsDesktopNotifications())
      setEvents({
        subscriptionRequests: [request('alice@example.com')],
        mucInvitations: [invitation('lounge@conf.example.com', 'carol@example.com')],
        voiceRequests: [voice('bob')],
      })
      await flush()
      expect(shown).toHaveLength(0)

      presence.status = 'online'
      rerender()
      await flush()
      expect(shown).toHaveLength(0)

      setEvents({ voiceRequests: [voice('bob'), voice('erin')] })
      await flush()
      expect(shown.map((n) => n.options.tag)).toEqual(['voice-request-team@conf.example.com/erin:account:me%40example.com'])
    })

    it('shows nothing without notification permission', async () => {
      getNotificationPermissionGranted.mockReturnValue(false)
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()
      expect(shown).toHaveLength(0)
    })
  })

  describe('dismissal', () => {
    it('closes the web notification once the event is handled', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({
        subscriptionRequests: [request('alice@example.com')],
        voiceRequests: [voice('bob')],
      })
      await flush()
      setEvents({ subscriptionRequests: [], voiceRequests: [] })
      await flush()

      expect(closed.sort()).toEqual([
        'contact-request-alice@example.com:account:me%40example.com',
        'voice-request-team@conf.example.com/bob:account:me%40example.com',
      ])
    })
  })

  describe('delivery races', () => {
    it('dismisses a notification that arrives after its event was handled', async () => {
      const registration = installServiceWorker()
      let deliver!: () => void
      registration.showNotification.mockImplementation((_: string, options: NotificationOptions) =>
        new Promise<void>((resolve) => {
          deliver = () => {
            const tag = options.tag
            delivered.push({ tag, close: () => closed.push(tag ?? '') })
            resolve()
          }
        }),
      )
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()
      setEvents({ subscriptionRequests: [] })
      await act(async () => deliver())
      await flush()

      expect(closed).toEqual(['contact-request-alice@example.com:account:me%40example.com'])
    })

    it('does not post a mobile notification after its event was handled', async () => {
      restorePlatform()
      restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'linux' })
      let resolvePlatform!: (mobile: boolean) => void
      isMobileTauri.mockImplementation(() => new Promise<boolean>((resolve) => { resolvePlatform = resolve }))
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()
      setEvents({ subscriptionRequests: [] })
      resolvePlatform(true)
      await flush()

      expect(postPluginNotification).not.toHaveBeenCalled()
    })
  })

  describe('desktop delivery', () => {
    beforeEach(() => {
      restorePlatform()
      restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    })

    it('posts through the native backend with a routable target', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ voiceRequests: [voice('bob')] })
      await flush()

      expect(invoke).toHaveBeenCalledWith('post_notification', {
        title: 'events.voiceRequestTitle',
        body: 'events.voiceRequestBody {"nick":"bob","room":"Team"}',
        navType: 'voice-request',
        navTarget: 'team@conf.example.com/bob',
        messageId: null,
        accountId: 'me@example.com',
        avatarPath: null,
      })
      expect(shown).toHaveLength(0)
      expect(NotificationCtor).not.toHaveBeenCalled()
    })

    it('dismisses the native notification once the event is handled', async () => {
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ mucInvitations: [invitation('lounge@conf.example.com', 'carol@example.com')] })
      await flush()
      setEvents({ mucInvitations: [] })
      await flush()

      expect(invoke).toHaveBeenCalledWith('dismiss_notifications', {
        navType: 'room-invitation',
        navTarget: 'lounge@conf.example.com',
        accountId: 'me@example.com',
      })
    })

    it('posts through the notification plugin on mobile', async () => {
      isMobileTauri.mockResolvedValue(true)
      renderHook(() => useEventsDesktopNotifications())
      setEvents({ subscriptionRequests: [request('alice@example.com')] })
      await flush()

      expect(postPluginNotification).toHaveBeenCalledWith({
        title: 'events.contactRequestTitle',
        body: 'events.contactRequestBody {"name":"alice"}',
        extra: {
          navType: 'contact-request',
          navTarget: 'alice@example.com',
          accountId: 'me@example.com',
        },
      })
    })
  })
})
