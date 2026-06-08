import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { OccupantPanel } from './OccupantPanel'
import { groupOccupantsByRole } from '@/utils/occupantGrouping'
import type { Room, RoomOccupant } from '@fluux/sdk'

// Count occupant-row renders: each online occupant row renders exactly one Avatar.
const avatarRenders = { count: 0 }

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({ titleBarClass: '', dragRegionProps: {} }),
  useContextMenu: () => ({
    isOpen: false, position: { x: 0, y: 0 }, open: vi.fn(), close: vi.fn(),
    menuRef: { current: null }, triggerHandlers: {},
    handleContextMenu: vi.fn(), handleTouchStart: vi.fn(), handleTouchEnd: vi.fn(),
  }),
}))

vi.mock('./Avatar', () => ({
  Avatar: ({ name }: { name: string }) => {
    avatarRenders.count++
    return <div data-testid="avatar">{name}</div>
  },
}))

vi.mock('./conversation/UserInfoPopover', () => ({
  UserInfoPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@fluux/sdk', async () => {
  const actual = await vi.importActual('@fluux/sdk')
  return {
    ...actual,
    getPresenceFromShow: (show: string | undefined) => show || 'online',
    getBareJid: (jid: string) => jid.split('/')[0],
    getBestPresenceShow: (shows: (string | undefined)[]) => shows[0],
    generateConsistentColorHexSync: () => '#abc123',
    useBlocking: () => ({ blockedJids: [], isBlocked: () => false, blockJid: vi.fn(), unblockJid: vi.fn(), unblockAll: vi.fn(), fetchBlocklist: vi.fn() }),
    useRoomActions: () => ({ setAffiliation: vi.fn(), setRole: vi.fn(), queryAffiliationList: vi.fn() }),
  }
})

vi.mock('@fluux/sdk/stores', () => ({
  ignoreStore: {
    getState: () => ({ ignoredUsers: {}, isIgnored: () => false, getIgnoredForRoom: () => [] }),
    subscribe: vi.fn(() => vi.fn()),
  },
}))

vi.mock('@/utils/presence', () => ({
  getTranslatedShowText: (show: string | undefined) => show || 'online',
}))

// Wrap the real grouping helper in a spy so we can assert it is memoized (not
// recomputed on every panel render). importOriginal keeps the real implementation
// so the rows still render correctly.
vi.mock('@/utils/occupantGrouping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/occupantGrouping')>()
  return { ...actual, groupOccupantsByRole: vi.fn(actual.groupOccupantsByRole) }
})

const createOccupant = (overrides: Partial<RoomOccupant> = {}): RoomOccupant => ({
  nick: 'User', role: 'participant', affiliation: 'none', ...overrides,
})

const createRoom = (occupants: Map<string, RoomOccupant>): Room => ({
  jid: 'room@conference.example.com', name: 'Test Room', nickname: 'Me',
  occupants, messages: [], joined: true, unreadCount: 0, mentionsCount: 0,
  typingUsers: new Set(), isBookmarked: false,
})

describe('OccupantPanel per-row memoization', () => {
  beforeEach(() => { avatarRenders.count = 0 })

  it('re-renders only the changed occupant row when a single occupant updates', () => {
    const alice = createOccupant({ nick: 'alice', jid: 'alice@example.com' })
    const bob = createOccupant({ nick: 'bob', jid: 'bob@example.com' })
    const carol = createOccupant({ nick: 'carol', jid: 'carol@example.com' })

    // Stable refs that must NOT change across the re-render.
    const contactsByJid = new Map()
    const onClose = () => {}

    const room1 = createRoom(new Map([['alice', alice], ['bob', bob], ['carol', carol]]))
    const { rerender } = render(
      <OccupantPanel room={room1} contactsByJid={contactsByJid} onClose={onClose} />
    )

    const perRowCost = avatarRenders.count / 3 // avatars rendered per row at mount (handles StrictMode)
    expect(avatarRenders.count).toBeGreaterThan(0)
    const afterMount = avatarRenders.count

    // Mirror roomStore.addOccupant: a NEW occupants Map where only bob's object is
    // replaced; alice & carol keep their refs (this is what the store actually does).
    const bobAway = { ...bob, show: 'away' as const }
    const room2 = createRoom(new Map([['alice', alice], ['bob', bobAway], ['carol', carol]]))
    rerender(<OccupantPanel room={room2} contactsByJid={contactsByJid} onClose={onClose} />)

    const delta = avatarRenders.count - afterMount
    // Only bob's row should re-render — one row's worth, NOT all three.
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThanOrEqual(perRowCost)
  })

  it('memoizes grouping — does not re-group when the panel re-renders with unchanged occupants', () => {
    const groupSpy = vi.mocked(groupOccupantsByRole)
    groupSpy.mockClear()

    const alice = createOccupant({ nick: 'alice', jid: 'alice@example.com' })
    const bob = createOccupant({ nick: 'bob', jid: 'bob@example.com' })
    const occupants = new Map([['alice', alice], ['bob', bob]])
    const contactsByJid = new Map()
    const onClose = () => {}

    const room1 = createRoom(occupants)
    const { rerender } = render(
      <OccupantPanel room={room1} contactsByJid={contactsByJid} onClose={onClose} />
    )
    const callsAfterMount = groupSpy.mock.calls.length
    expect(callsAfterMount).toBeGreaterThan(0)

    // A parent re-render that does NOT change occupants (message activity, menu or
    // connection-state change): NEW room object, SAME occupants Map ref. The old IIFE
    // re-grouped here on every render; the useMemo must skip it.
    const room2 = { ...room1 }
    rerender(<OccupantPanel room={room2} contactsByJid={contactsByJid} onClose={onClose} />)

    expect(groupSpy.mock.calls.length).toBe(callsAfterMount)
  })
})
