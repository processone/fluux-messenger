import { describe, it, expect, vi } from 'vitest'
import type { Room } from '@fluux/sdk'
import { buildNotifyGroup, buildManagementGroup, notifyModeOf } from './roomHeaderActions'

const t = ((k: string) => k) as any

function room(partial: Partial<Room> = {}): Room {
  return {
    jid: 'room@conf.example.com',
    name: 'Room',
    occupants: new Map(),
    notifyAll: false,
    notifyAllPersistent: false,
    isQuickChat: false,
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
  })
})

describe('buildNotifyGroup', () => {
  it('omits the persistent option for quick chats', () => {
    const g = buildNotifyGroup({ room: room({ isQuickChat: true }), t, setRoomNotifyAll: vi.fn() })
    expect(g.items.map((i) => i.key)).toEqual(['mentions', 'all-session'])
  })

  it('marks the active mode and wires onSelect', () => {
    const setRoomNotifyAll = vi.fn().mockResolvedValue(undefined)
    const g = buildNotifyGroup({ room: room({ notifyAll: true }), t, setRoomNotifyAll })
    expect(g.items.find((i) => i.key === 'all-session')!.active).toBe(true)
    g.items.find((i) => i.key === 'mentions')!.onSelect()
    expect(setRoomNotifyAll).toHaveBeenCalledWith('room@conf.example.com', false, false)
  })
})

describe('buildManagementGroup', () => {
  const handlers = { onConfig: vi.fn(), onAvatar: vi.fn(), onClearAvatar: vi.fn(), onMembers: vi.fn(), onHats: vi.fn() }

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
