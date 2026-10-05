import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))

import { pushBadgeState, resetSharedPushBadge, sharePushBadge } from './pushBadge'

type Rooms = Parameters<typeof pushBadgeState>[1]

function rooms(list: Array<{ jid: string; joined?: boolean; unreadCount?: number; mentionsCount?: number; notifyAll?: boolean }>): Rooms {
  return {
    roomEntities: new Map(list.map((r) => [r.jid, { jid: r.jid, joined: r.joined ?? true }])),
    roomMeta: new Map(list.map((r) => [r.jid, {
      unreadCount: r.unreadCount ?? 0,
      mentionsCount: r.mentionsCount ?? 0,
      notifyAll: r.notifyAll,
    }])),
  } as unknown as Rooms
}

describe('pushBadgeState', () => {
  it('counts conversations with unread messages and rooms the badge counts', () => {
    const state = pushBadgeState(
      [{ id: 'alice@example.com', unreadCount: 2 }, { id: 'bob@example.com', unreadCount: 0 }],
      rooms([
        { jid: 'mention@muc.example.com', unreadCount: 3, mentionsCount: 1 },
        { jid: 'quiet@muc.example.com', unreadCount: 5 },
        { jid: 'all@muc.example.com', unreadCount: 1, notifyAll: true },
        { jid: 'idle@muc.example.com', notifyAll: true },
        { jid: 'left@muc.example.com', joined: false, notifyAll: true },
      ]),
      1,
    )

    expect(state).toEqual({
      unread: ['alice@example.com', 'mention@muc.example.com', 'all@muc.example.com'],
      events: 1,
      notifyAllRooms: ['all@muc.example.com', 'idle@muc.example.com'],
    })
  })
})

describe('sharePushBadge', () => {
  const state = { unread: ['alice@example.com'], events: 0, notifyAllRooms: [] }

  beforeEach(() => {
    resetSharedPushBadge()
    mockInvoke.mockReset().mockResolvedValue(undefined)
  })

  it('sends a state once while it does not change', async () => {
    await sharePushBadge(state)
    await sharePushBadge({ ...state })

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_badge', { badge: state })
  })

  it('sends the state again after a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockInvoke.mockRejectedValueOnce(new Error('unavailable'))

    await sharePushBadge(state)
    await sharePushBadge(state)

    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })
})
