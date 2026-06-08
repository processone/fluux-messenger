import { describe, it, expect } from 'vitest'
import type { RoomOccupant } from '@fluux/sdk'
import { groupOccupantsByBareJid } from '@/utils/occupantGrouping'

// Helper to create test occupants
function createOccupant(nick: string, opts: Partial<RoomOccupant> = {}): RoomOccupant {
  return {
    nick,
    affiliation: 'member',
    role: 'participant',
    ...opts,
  }
}

describe('groupOccupantsByBareJid', () => {
  describe('basic grouping', () => {
    it('should return empty array for empty input', () => {
      expect(groupOccupantsByBareJid([])).toEqual([])
    })

    it('should keep single occupant without JID as individual group', () => {
      const occupants = [createOccupant('alice')]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(1)
      expect(result[0].bareJid).toBeUndefined()
      expect(result[0].primaryNick).toBe('alice')
      expect(result[0].connections).toHaveLength(1)
    })

    it('should keep single occupant with JID as individual group', () => {
      const occupants = [createOccupant('alice', { jid: 'alice@example.com/desktop' })]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(1)
      expect(result[0].bareJid).toBe('alice@example.com')
      expect(result[0].primaryNick).toBe('alice')
      expect(result[0].connections).toHaveLength(1)
    })

    it('should group occupants with same bare JID', () => {
      const occupants = [
        createOccupant('alice', { jid: 'alice@example.com/desktop' }),
        createOccupant('alice_mobile', { jid: 'alice@example.com/mobile' }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(1)
      expect(result[0].bareJid).toBe('alice@example.com')
      expect(result[0].connections).toHaveLength(2)
    })

    it('should keep occupants with different bare JIDs separate', () => {
      const occupants = [
        createOccupant('alice', { jid: 'alice@example.com/desktop' }),
        createOccupant('bob', { jid: 'bob@example.com/laptop' }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(2)
      expect(result.find(g => g.bareJid === 'alice@example.com')).toBeDefined()
      expect(result.find(g => g.bareJid === 'bob@example.com')).toBeDefined()
    })
  })

  describe('primary nick selection', () => {
    it('should use alphabetically first nick as primary', () => {
      const occupants = [
        createOccupant('zoe_mobile', { jid: 'alice@example.com/mobile' }),
        createOccupant('alice', { jid: 'alice@example.com/desktop' }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result[0].primaryNick).toBe('alice')
    })

    it('should sort connections by nick within group', () => {
      const occupants = [
        createOccupant('charlie', { jid: 'user@example.com/c' }),
        createOccupant('alice', { jid: 'user@example.com/a' }),
        createOccupant('bob', { jid: 'user@example.com/b' }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result[0].connections[0].nick).toBe('alice')
      expect(result[0].connections[1].nick).toBe('bob')
      expect(result[0].connections[2].nick).toBe('charlie')
    })
  })

  describe('presence aggregation', () => {
    it('should select best presence from multiple connections', () => {
      const occupants = [
        createOccupant('alice', { jid: 'alice@example.com/desktop', show: 'away' }),
        createOccupant('alice_mobile', { jid: 'alice@example.com/mobile', show: 'chat' }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result[0].bestPresence).toBe('chat')
    })

    it('should prefer online (undefined) over away', () => {
      const occupants = [
        createOccupant('alice', { jid: 'alice@example.com/desktop', show: 'away' }),
        createOccupant('alice_mobile', { jid: 'alice@example.com/mobile', show: undefined }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result[0].bestPresence).toBeUndefined()
    })

    it('should use single occupant presence for ungrouped occupants', () => {
      const occupants = [createOccupant('alice', { show: 'dnd' })]
      const result = groupOccupantsByBareJid(occupants)

      expect(result[0].bestPresence).toBe('dnd')
    })
  })

  describe('mixed JID and non-JID occupants', () => {
    it('should handle mix of occupants with and without JIDs', () => {
      const occupants = [
        createOccupant('alice', { jid: 'alice@example.com/desktop' }),
        createOccupant('anonymous'),
        createOccupant('bob', { jid: 'bob@example.com/laptop' }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(3)
      expect(result.find(g => g.bareJid === undefined)?.primaryNick).toBe('anonymous')
    })

    it('should not group occupants without JIDs together', () => {
      const occupants = [
        createOccupant('anon1'),
        createOccupant('anon2'),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(2)
      expect(result.every(g => g.connections.length === 1)).toBe(true)
    })
  })

  describe('sorting', () => {
    it('should sort result alphabetically by primary nick', () => {
      const occupants = [
        createOccupant('zoe', { jid: 'zoe@example.com' }),
        createOccupant('alice', { jid: 'alice@example.com' }),
        createOccupant('mike', { jid: 'mike@example.com' }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result[0].primaryNick).toBe('alice')
      expect(result[1].primaryNick).toBe('mike')
      expect(result[2].primaryNick).toBe('zoe')
    })

    it('should sort mixed JID/non-JID occupants together', () => {
      const occupants = [
        createOccupant('zoe'),
        createOccupant('alice', { jid: 'alice@example.com' }),
        createOccupant('bob'),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result[0].primaryNick).toBe('alice')
      expect(result[1].primaryNick).toBe('bob')
      expect(result[2].primaryNick).toBe('zoe')
    })
  })

  describe('real-world scenarios', () => {
    it('should handle user with multiple devices in room', () => {
      // Alice joins from desktop and mobile, Bob from laptop only
      const occupants = [
        createOccupant('alice', { jid: 'alice@company.com/work-desktop', show: 'away' }),
        createOccupant('alice_phone', { jid: 'alice@company.com/iphone', show: 'chat' }),
        createOccupant('bob', { jid: 'bob@company.com/laptop', show: undefined }),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(2)

      const aliceGroup = result.find(g => g.bareJid === 'alice@company.com')
      expect(aliceGroup).toBeDefined()
      expect(aliceGroup!.connections).toHaveLength(2)
      expect(aliceGroup!.bestPresence).toBe('chat') // Best of away and chat

      const bobGroup = result.find(g => g.bareJid === 'bob@company.com')
      expect(bobGroup).toBeDefined()
      expect(bobGroup!.connections).toHaveLength(1)
    })

    it('should handle anonymous room (no JIDs exposed)', () => {
      const occupants = [
        createOccupant('user1'),
        createOccupant('user2'),
        createOccupant('user3'),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(3)
      expect(result.every(g => g.connections.length === 1)).toBe(true)
      expect(result.every(g => g.bareJid === undefined)).toBe(true)
    })

    it('should handle semi-anonymous room (some JIDs exposed)', () => {
      // Moderators might have JIDs visible, regular participants don't
      const occupants = [
        createOccupant('admin', { jid: 'admin@server.com/office', role: 'moderator' }),
        createOccupant('user1'),
        createOccupant('user2'),
      ]
      const result = groupOccupantsByBareJid(occupants)

      expect(result).toHaveLength(3)
      expect(result.find(g => g.bareJid === 'admin@server.com')).toBeDefined()
    })
  })
})
