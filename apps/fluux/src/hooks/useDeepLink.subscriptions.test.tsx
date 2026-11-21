/**
 * The deep-link hook is always mounted, so contact presence bursts must not
 * re-render it (audit finding: roster copies re-sorted through it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { rosterStore, chatStore, roomStore, connectionStore } from '@fluux/sdk'
import type { Contact } from '@fluux/sdk'

let renders = 0
const mockAddConversation = vi.fn()
const mockNavigateToConversation = vi.fn()
// The global test setup stubs the SDK stores; this suite needs the real ones.
vi.mock('@fluux/sdk/react', async () => await vi.importActual('@fluux/sdk/react'))
vi.mock('@fluux/sdk', async () => ({
  ...await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk'),
  useChatActions: () => ({ addConversation: mockAddConversation }),
  useRoomActions: () => ({
    joinRoom: vi.fn(), joinResult: vi.fn(), getRoomInfo: vi.fn(),
    isNonAnonymousRoomAcknowledged: vi.fn(), domainHostsRooms: vi.fn(),
  }),
}))
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation: mockNavigateToConversation, navigateToRoom: vi.fn(), navigateToContactRequests: vi.fn() }),
}))
vi.mock('./useRoomMessageLink', () => ({ useRoomMessageLink: () => vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: () => Promise.resolve(() => {}), getCurrent: () => Promise.resolve([]),
}))

import { useDeepLink } from './useDeepLink'

const contact = (i: number): Contact => ({
  jid: `c${i}@example.org`, name: `C${i}`, presence: 'offline', subscription: 'both',
} as Contact)

describe('useDeepLink store subscriptions', () => {
  beforeEach(() => { renders = 0; vi.clearAllMocks() })

  it('does not re-render on roster, chat or room changes', () => {
    rosterStore.getState().setContacts(Array.from({ length: 50 }, (_, i) => contact(i)), 'me@example.org')
    renderHook(() => { renders++; return useDeepLink() })
    const mounted = renders
    act(() => {
      for (let i = 0; i < 50; i++) {
        rosterStore.getState().updatePresence(`c${i}@example.org/res`, 'chat', 0)
      }
      chatStore.getState().addConversation({ id: 'x@example.org', name: 'X', type: 'chat', unreadCount: 0 })
      roomStore.getState().addRoom({
        jid: 'r@conference.example.org', name: 'r', nickname: 'n', joined: false, isBookmarked: false,
        occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
      })
    })
    expect(renders).toBe(mounted)
  })

  it('finds a contact added after the hook mounted, without a re-render', async () => {
    const { routeDeepLink } = await import('@/utils/deepLinkRouter')
    connectionStore.getState().setJid('me@example.org/res')
    connectionStore.getState().setStatus('online')
    rosterStore.getState().setContacts([], 'me@example.org')
    renderHook(() => { renders++; return useDeepLink() })
    const mounted = renders
    // The contact arrives after mount: a stale snapshot would not know them.
    act(() => { rosterStore.getState().addOrUpdateContact({ ...contact(1), jid: 'dave@example.org', name: 'Dave' }) })
    expect(renders).toBe(mounted)

    await act(async () => routeDeepLink('xmpp:dave@example.org?subscribe'))
    expect(mockNavigateToConversation).toHaveBeenCalledWith('dave@example.org')

    await act(async () => routeDeepLink('xmpp:dave@example.org'))
    expect(mockAddConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 'dave@example.org', name: 'Dave' }))
    expect(renders).toBe(mounted)
  })
})
