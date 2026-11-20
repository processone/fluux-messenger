import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Room } from '@fluux/sdk'
import { AtSign, BellOff } from 'lucide-react'
import { buildNotifyGroup, buildManagementGroup, notifyModeOf } from './roomHeaderActions'

const t = ((k: string) => k) as any

function room(partial: Partial<Room> = {}): Room {
  return {
    jid: 'room@conf.example.com',
    name: 'Room',
    occupants: new Map(),
    notifyAllPersistent: false,
    isQuickChat: false,
    isBookmarked: true,
    avatar: undefined,
    supportsHats: true,
    ...partial,
  } as Room
}

describe('notifyModeOf', () => {
  it('maps flags to modes', () => {
    expect(notifyModeOf(room())).toBe('mentions')
    expect(notifyModeOf(room({ notifyAll: true }))).toBe('all-session')
    expect(notifyModeOf(room({ notifyAll: true, notifyAllPersistent: true }))).toBe('all-always')
    expect(notifyModeOf(room({ notifyAllPersistent: true }))).toBe('all-always')
  })

  it('shows Off for a saved or session Off, and lets a session choice override a saved one', () => {
    expect(notifyModeOf(room({ notifyOffPersistent: true }))).toBe('off')
    expect(notifyModeOf(room({ notifyOff: true }))).toBe('off')
    expect(notifyModeOf(room({ notifyOffPersistent: true, notifyAll: true }))).toBe('all-session')
    expect(notifyModeOf(room({ notifyAllPersistent: true, notifyOff: true }))).toBe('off')
  })
})

describe('buildNotifyGroup', () => {
  const group = (partial: Partial<Room> = {}) => {
    const setRoomNotifyLevel = vi.fn().mockResolvedValue(undefined)
    const onSaveFailed = vi.fn()
    return { setRoomNotifyLevel, onSaveFailed, g: buildNotifyGroup({ room: room(partial), t, setRoomNotifyLevel, onSaveFailed }) }
  }
  const choose = (g: ReturnType<typeof group>['g'], key: string) => g.items.find((i) => i.key === key)!.onSelect()

  it('omits the persistent All messages option for quick chats but keeps Off as session only', () => {
    const { g } = group({ isQuickChat: true })
    expect(g.items.map((i) => i.key)).toEqual(['off', 'mentions', 'all-session'])
    expect(g.items.find((i) => i.key === 'off')!.description).toBe('rooms.thisSessionOnly')
  })

  it('offers one Off row saved to the bookmark, first, with the crossed bell; Mentions only takes @', () => {
    const { g } = group()
    expect(g.items.map((i) => i.key)).toEqual(['off', 'mentions', 'all-session', 'all-always'])
    const off = g.items.find((i) => i.key === 'off')!
    expect(off.label).toBe('rooms.notificationsOff')
    expect(off.description).toBe('rooms.alwaysSavedToBookmark')
    expect(off.icon).toBe(BellOff)
    expect(g.items.find((i) => i.key === 'mentions')!.icon).toBe(AtSign)
  })

  it('marks the active mode and wires onSelect', () => {
    const { g, setRoomNotifyLevel } = group({ notifyAll: true, isBookmarked: false })
    expect(g.items.find((i) => i.key === 'all-session')!.active).toBe(true)
    choose(g, 'mentions')
    expect(setRoomNotifyLevel).toHaveBeenCalledWith('room@conf.example.com', 'mentions', false)
  })

  it('saves Off, which replaces any session choice, and marks it active', () => {
    const { g, setRoomNotifyLevel } = group({ notifyAll: true })
    choose(g, 'off')
    expect(setRoomNotifyLevel).toHaveBeenCalledWith('room@conf.example.com', 'none', true)
    expect(group({ notifyOffPersistent: true }).g.items.find((i) => i.key === 'off')!.active).toBe(true)
  })

  it('holds Off for the session in a quick chat', () => {
    const { g, setRoomNotifyLevel } = group({ isQuickChat: true })
    choose(g, 'off')
    expect(setRoomNotifyLevel).toHaveBeenCalledWith('room@conf.example.com', 'none', false)
  })

  it('holds Off for the session, and says so, in a joined room with no bookmark', () => {
    const { g, setRoomNotifyLevel } = group({ isBookmarked: false })
    expect(g.items.find((i) => i.key === 'off')!.description).toBe('rooms.thisSessionOnly')
    choose(g, 'off')
    expect(setRoomNotifyLevel).toHaveBeenCalledWith('room@conf.example.com', 'none', false)
  })

  it('offers no saved All messages row in a joined room with no bookmark', () => {
    const { g } = group({ isBookmarked: false })
    expect(g.items.map((i) => i.key)).toEqual(['off', 'mentions', 'all-session'])
  })

  it('clears a saved level when Mentions only or a session All messages replaces it', () => {
    const saved = group({ notifyOffPersistent: true })
    choose(saved.g, 'mentions')
    expect(saved.setRoomNotifyLevel).toHaveBeenCalledWith('room@conf.example.com', 'mentions', true)

    const all = group({ notifyAllPersistent: true })
    choose(all.g, 'all-session')
    expect(all.setRoomNotifyLevel.mock.calls).toEqual([
      ['room@conf.example.com', 'mentions', true],
      ['room@conf.example.com', 'all', false],
    ])
  })

  // A saved All messages or Off shows as a session choice until the bookmark stores it.
  // Leaving it for Mentions only must save Mentions only, or the bookmark would end on
  // the level the user moved away from.
  it.each([
    ['All messages', { notifyAll: true }],
    ['Off', { notifyAll: false, notifyOff: true }],
  ] as const)('saves Mentions only when it replaces %s shown on a bookmarked room before the bookmark stores it', (_shown, partial) => {
    const mentions = group(partial)
    choose(mentions.g, 'mentions')
    expect(mentions.setRoomNotifyLevel.mock.calls).toEqual([['room@conf.example.com', 'mentions', true]])

    const session = group(partial)
    choose(session.g, 'all-session')
    expect(session.setRoomNotifyLevel.mock.calls).toEqual([
      ['room@conf.example.com', 'mentions', true],
      ['room@conf.example.com', 'all', false],
    ])
  })

  it('saves All messages always', () => {
    const { g, setRoomNotifyLevel } = group()
    choose(g, 'all-always')
    expect(setRoomNotifyLevel).toHaveBeenCalledWith('room@conf.example.com', 'all', true)
  })

  describe('when the bookmark refuses a saved level', () => {
    // Only a saved level waits on the bookmark write; a session choice never fails.
    const refusingSaves = (partial: Partial<Room>) => {
      const made = group(partial)
      made.setRoomNotifyLevel.mockImplementation((_jid: string, _level: string, persistent?: boolean) =>
        persistent ? Promise.reject(Object.assign(new Error('conflict'), { name: 'StanzaError', condition: 'conflict' })) : Promise.resolve())
      return made
    }
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    afterEach(() => {
      process.off('unhandledRejection', onUnhandled)
      unhandled.length = 0
    })

    it.each([
      ['off', {}],
      ['all-always', {}],
      ['mentions', { notifyAllPersistent: true }],
      ['all-session', { notifyOffPersistent: true }],
    ] as const)('reports a refused %s save once and leaves no unhandled rejection', async (key, partial) => {
      process.on('unhandledRejection', onUnhandled)
      const { g, onSaveFailed } = refusingSaves(partial)

      choose(g, key)

      await vi.waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1))
      // Node reports an unhandled rejection once the microtasks after it have run.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onSaveFailed).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    })
  })
})

describe('buildManagementGroup', () => {
  const handlers = { onConfig: vi.fn(), onAvatar: vi.fn(), onClearAvatar: vi.fn(), onMembers: vi.fn(), onHats: vi.fn() }

  it('offers bulk moderation to a moderator without room administration controls', () => {
    const onBulkModeration = vi.fn()
    const group = buildManagementGroup({ room: room(), t, isOwner: false, canManageRoom: false, ...handlers, onBulkModeration })
    expect(group?.items.map(item => item.key)).toEqual(['bulk-moderation'])
    group?.items[0].onSelect()
    expect(onBulkModeration).toHaveBeenCalledOnce()
  })

  it('returns null when the user cannot manage the room', () => {
    expect(buildManagementGroup({ room: room(), t, isOwner: false, canManageRoom: false, ...handlers })).toBeNull()
  })

  it('admin (non-owner) sees settings/subject/membership but not avatar or hats', () => {
    const g = buildManagementGroup({ room: room(), t, isOwner: false, canManageRoom: true, ...handlers })!
    const keys = g.items.map((i) => i.key)
    expect(keys).toContain('settings')
    expect(keys).toContain('membership')
    expect(keys).not.toContain('avatar')
    expect(keys).not.toContain('hats')
  })

  it('owner sees avatar + hats; clear-avatar only when an avatar exists', () => {
    const without = buildManagementGroup({ room: room(), t, isOwner: true, canManageRoom: true, ...handlers })!
    expect(without.items.map((i) => i.key)).not.toContain('clear-avatar')
    const withAvatar = buildManagementGroup({ room: room({ avatar: 'data:...' }), t, isOwner: true, canManageRoom: true, ...handlers })!
    expect(withAvatar.items.map((i) => i.key)).toContain('clear-avatar')
  })

  it('disables hats when the room does not support them', () => {
    const g = buildManagementGroup({ room: room({ supportsHats: false }), t, isOwner: true, canManageRoom: true, ...handlers })!
    expect(g.items.find((i) => i.key === 'hats')!.disabled).toBe(true)
  })
})
