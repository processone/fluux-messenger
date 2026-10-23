import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { RoomHeader } from './RoomHeader'
import { DEGRADED_STATUS_GRACE_MS } from './ConnectionStep'
import type { Room } from '@fluux/sdk'

// FLM-120: like the 1:1 header, the room header subtitle shows the connection
// step after the 2 s grace and gives the topic back once online, in the same
// fixed-height (h-14) slot.

let mockStatus = 'online'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}))
vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({ dragRegionProps: {} }),
  useClickOutside: vi.fn(),
  useAnchoredMenu: () => ({ triggerRef: { current: null }, menuRef: { current: null }, position: { x: 0, y: 0 } }),
}))
vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({ status: mockStatus, isVerifying: false, reconnectTargetTime: null }),
}))
vi.mock('@fluux/sdk', () => ({
  generateConsistentColorHexSync: () => '#4a90d9',
  getUniqueOccupantCount: () => 0,
}))
vi.mock('./Avatar', () => ({ Avatar: () => <div /> }))
vi.mock('./AvatarCropModal', () => ({ AvatarCropModal: () => null }))
vi.mock('./InviteToRoomModal', () => ({ InviteToRoomModal: () => null }))
vi.mock('./RoomConfigModal', () => ({ RoomConfigModal: () => null }))
vi.mock('./RoomMembersModal', () => ({ RoomMembersModal: () => null }))
vi.mock('./RoomHatsModal', () => ({ RoomHatsModal: () => null }))
vi.mock('@/utils/messageStyles', () => ({ renderTextWithLinks: (t: string) => t }))

const room = {
  jid: 'room@conference.example.com',
  name: 'Test Room',
  subject: 'Weekly sync',
  joined: true,
  nickname: 'Me',
  occupants: new Map(),
  typingUsers: new Set<string>(),
  unreadCount: 0,
  mentionsCount: 0,
  isBookmarked: true,
} as unknown as Room

const ui = () => (
  <RoomHeader
    room={room}
    showOccupants={false}
    onToggleOccupants={vi.fn()}
    setRoomNotifyAll={vi.fn()}
    setRoomAvatar={vi.fn()}
    clearRoomAvatar={vi.fn()}
    submitRoomConfig={vi.fn()}
    setSubject={vi.fn()}
    destroyRoom={vi.fn()}
  />
)

describe('RoomHeader connection step', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockStatus = 'online'
  })
  afterEach(() => vi.useRealTimers())

  it('swaps the topic for the step after the grace delay and restores it online', () => {
    mockStatus = 'connecting'
    const { container, rerender } = render(ui())
    expect(screen.getByText('Weekly sync')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 1) })
    expect(screen.queryByTestId('connection-step')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByTestId('connection-step').textContent).toContain('status.connecting')
    expect(screen.queryByText('Weekly sync')).toBeNull()
    expect(container.querySelector('header')!.className).toContain('h-14')

    mockStatus = 'online'
    rerender(ui())
    expect(screen.getByText('Weekly sync')).toBeTruthy()
    expect(container.querySelector('header')!.className).toContain('h-14')
  })
})
