import { describe, it, expect } from 'vitest'
import {
  parseJid,
  getBareJid,
  getResource,
  getLocalPart,
  getDomain,
  splitFullJid,
  hasResource,
  createFullJid,
  getUniqueOccupantCount,
} from './jid'

describe('JID utilities', () => {
  describe('parseJid', () => {
    it('should parse a full JID with all parts', () => {
      const result = parseJid('user@example.com/mobile')
      expect(result).toEqual({
        local: 'user',
        domain: 'example.com',
        resource: 'mobile',
        bare: 'user@example.com',
        full: 'user@example.com/mobile',
      })
    })

    it('should parse a bare JID without resource', () => {
      const result = parseJid('user@example.com')
      expect(result).toEqual({
        local: 'user',
        domain: 'example.com',
        resource: undefined,
        bare: 'user@example.com',
        full: 'user@example.com',
      })
    })

    it('should parse a MUC occupant JID', () => {
      const result = parseJid('room@conference.example.com/nickname')
      expect(result).toEqual({
        local: 'room',
        domain: 'conference.example.com',
        resource: 'nickname',
        bare: 'room@conference.example.com',
        full: 'room@conference.example.com/nickname',
      })
    })

    it('should handle resource with slashes', () => {
      const result = parseJid('user@example.com/path/to/resource')
      expect(result.resource).toBe('path/to/resource')
      expect(result.bare).toBe('user@example.com')
    })

    it('should handle empty string', () => {
      const result = parseJid('')
      expect(result).toEqual({
        local: '',
        domain: '',
        resource: undefined,
        bare: '',
        full: '',
      })
    })

    it('should handle domain-only JID', () => {
      const result = parseJid('example.com')
      expect(result).toEqual({
        local: 'example.com',
        domain: '',
        resource: undefined,
        bare: 'example.com',
        full: 'example.com',
      })
    })
  })

  describe('getBareJid', () => {
    it('should extract bare JID from full JID', () => {
      expect(getBareJid('user@example.com/mobile')).toBe('user@example.com')
    })

    it('should return same string for bare JID', () => {
      expect(getBareJid('user@example.com')).toBe('user@example.com')
    })

    it('should handle MUC JID', () => {
      expect(getBareJid('room@conf.example.com/nick')).toBe('room@conf.example.com')
    })

    it('should handle empty string', () => {
      expect(getBareJid('')).toBe('')
    })

    it('should handle resource with slashes', () => {
      expect(getBareJid('user@example.com/a/b/c')).toBe('user@example.com')
    })
  })

  describe('getResource', () => {
    it('should extract resource from full JID', () => {
      expect(getResource('user@example.com/mobile')).toBe('mobile')
    })

    it('should return undefined for bare JID', () => {
      expect(getResource('user@example.com')).toBeUndefined()
    })

    it('should handle MUC nickname', () => {
      expect(getResource('room@conf.example.com/MyNickname')).toBe('MyNickname')
    })

    it('should handle empty string', () => {
      expect(getResource('')).toBeUndefined()
    })

    it('should preserve resource with slashes', () => {
      expect(getResource('user@example.com/path/to/res')).toBe('path/to/res')
    })

    it('should handle empty resource after slash', () => {
      expect(getResource('user@example.com/')).toBe('')
    })
  })

  describe('getLocalPart', () => {
    it('should extract local part from bare JID', () => {
      expect(getLocalPart('user@example.com')).toBe('user')
    })

    it('should extract local part from full JID', () => {
      expect(getLocalPart('user@example.com/mobile')).toBe('user')
    })

    it('should handle room JID', () => {
      expect(getLocalPart('chatroom@conference.example.com')).toBe('chatroom')
    })

    it('should handle empty string', () => {
      expect(getLocalPart('')).toBe('')
    })

    it('should handle JID without @', () => {
      expect(getLocalPart('example.com')).toBe('example.com')
    })
  })

  describe('getDomain', () => {
    it('should extract domain from bare JID', () => {
      expect(getDomain('user@example.com')).toBe('example.com')
    })

    it('should extract domain from full JID', () => {
      expect(getDomain('user@example.com/mobile')).toBe('example.com')
    })

    it('should handle subdomain', () => {
      expect(getDomain('room@conference.example.com/nick')).toBe('conference.example.com')
    })

    it('should handle empty string', () => {
      expect(getDomain('')).toBe('')
    })

    it('should return empty for JID without @', () => {
      expect(getDomain('example.com')).toBe('')
    })
  })

  describe('splitFullJid', () => {
    it('should split full JID into bare and resource', () => {
      const [bare, resource] = splitFullJid('user@example.com/mobile')
      expect(bare).toBe('user@example.com')
      expect(resource).toBe('mobile')
    })

    it('should return undefined resource for bare JID', () => {
      const [bare, resource] = splitFullJid('user@example.com')
      expect(bare).toBe('user@example.com')
      expect(resource).toBeUndefined()
    })

    it('should handle MUC JID', () => {
      const [bare, resource] = splitFullJid('room@conf/nickname')
      expect(bare).toBe('room@conf')
      expect(resource).toBe('nickname')
    })
  })

  describe('hasResource', () => {
    it('should return true for full JID', () => {
      expect(hasResource('user@example.com/mobile')).toBe(true)
    })

    it('should return false for bare JID', () => {
      expect(hasResource('user@example.com')).toBe(false)
    })

    it('should return false for empty string', () => {
      expect(hasResource('')).toBe(false)
    })

    it('should return true for JID with empty resource', () => {
      expect(hasResource('user@example.com/')).toBe(true)
    })
  })

  describe('createFullJid', () => {
    it('should create full JID from bare JID and resource', () => {
      expect(createFullJid('user@example.com', 'mobile')).toBe('user@example.com/mobile')
    })

    it('should return bare JID if resource is empty', () => {
      expect(createFullJid('user@example.com', '')).toBe('user@example.com')
    })

    it('should return empty string for empty bare JID', () => {
      expect(createFullJid('', 'mobile')).toBe('')
    })

    it('should handle MUC JID', () => {
      expect(createFullJid('room@conf.example.com', 'nickname')).toBe('room@conf.example.com/nickname')
    })
  })

  describe('getUniqueOccupantCount', () => {
    it('should count unique users by bare JID', () => {
      const occupants = [
        { jid: 'alice@example.com/mobile' },
        { jid: 'alice@example.com/desktop' },
        { jid: 'bob@example.com/web' },
      ]
      expect(getUniqueOccupantCount(occupants)).toBe(2)
    })

    it('should count occupants without JID individually', () => {
      const occupants = [
        { jid: 'alice@example.com' },
        { jid: undefined },
        { jid: undefined },
      ]
      expect(getUniqueOccupantCount(occupants)).toBe(3)
    })

    it('should return 0 for empty list', () => {
      expect(getUniqueOccupantCount([])).toBe(0)
    })

    it('should work with Map values iterator', () => {
      const map = new Map([
        ['Alice', { jid: 'alice@example.com/mobile' }],
        ['Alice2', { jid: 'alice@example.com/desktop' }],
        ['Bob', { jid: 'bob@example.com' }],
      ])
      expect(getUniqueOccupantCount(map.values())).toBe(2)
    })
  })
})
