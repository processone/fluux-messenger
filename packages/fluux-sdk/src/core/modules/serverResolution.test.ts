import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shouldSkipDiscovery, getWebSocketUrl, resolveWebSocketUrl } from './serverResolution'

// Mock the discovery module
vi.mock('../../utils/websocketDiscovery', () => ({
  discoverWebSocket: vi.fn(),
}))

import { discoverWebSocket } from '../../utils/websocketDiscovery'

const mockDiscover = vi.mocked(discoverWebSocket)

describe('serverResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('shouldSkipDiscovery', () => {
    it('should return true when skipDiscovery is explicitly set', () => {
      expect(shouldSkipDiscovery('example.com', true)).toBe(true)
    })

    it('should return false when skipDiscovery is not set', () => {
      expect(shouldSkipDiscovery('example.com')).toBe(false)
      expect(shouldSkipDiscovery('example.com', false)).toBe(false)
    })

    it('should return true for ws:// URLs', () => {
      expect(shouldSkipDiscovery('ws://example.com/ws')).toBe(true)
    })

    it('should return true for wss:// URLs', () => {
      expect(shouldSkipDiscovery('wss://example.com/ws')).toBe(true)
    })

    it('should return false for plain domain names', () => {
      expect(shouldSkipDiscovery('example.com')).toBe(false)
    })
  })

  describe('getWebSocketUrl', () => {
    it('should return the server as-is for ws:// URLs', () => {
      expect(getWebSocketUrl('ws://localhost:5280/ws', 'example.com')).toBe('ws://localhost:5280/ws')
    })

    it('should return the server as-is for wss:// URLs', () => {
      expect(getWebSocketUrl('wss://chat.example.com/ws', 'example.com')).toBe('wss://chat.example.com/ws')
    })

    it('should construct wss URL from server domain', () => {
      expect(getWebSocketUrl('chat.example.com', 'example.com')).toBe('wss://chat.example.com/ws')
    })

    it('should fall back to JID domain when server is empty', () => {
      expect(getWebSocketUrl('', 'example.com')).toBe('wss://example.com/ws')
    })
  })

  describe('resolveWebSocketUrl', () => {
    it('should return discovered URL when discovery succeeds', async () => {
      mockDiscover.mockResolvedValue('wss://discovered.example.com/ws')

      const result = await resolveWebSocketUrl('example.com', 'example.com')
      expect(result).toBe('wss://discovered.example.com/ws')
      expect(mockDiscover).toHaveBeenCalledWith('example.com', 5000)
    })

    it('should fall back to default URL when discovery returns null', async () => {
      mockDiscover.mockResolvedValue(null)

      const result = await resolveWebSocketUrl('example.com', 'example.com')
      expect(result).toBe('wss://example.com/ws')
    })

    it('should fall back to default URL when discovery throws', async () => {
      mockDiscover.mockRejectedValue(new Error('Network error'))

      const result = await resolveWebSocketUrl('example.com', 'example.com')
      expect(result).toBe('wss://example.com/ws')
    })

    it('should use server param as discovery domain when available', async () => {
      mockDiscover.mockResolvedValue('wss://srv.example.com/ws')

      await resolveWebSocketUrl('srv.example.com', 'example.com')
      expect(mockDiscover).toHaveBeenCalledWith('srv.example.com', 5000)
    })

    it('should use JID domain when server is empty', async () => {
      mockDiscover.mockResolvedValue(null)

      const result = await resolveWebSocketUrl('', 'example.com')
      expect(result).toBe('wss://example.com/ws')
      expect(mockDiscover).toHaveBeenCalledWith('example.com', 5000)
    })

    it('should log events via logger when provided', async () => {
      mockDiscover.mockResolvedValue('wss://found.example.com/ws')
      const logger = { addEvent: vi.fn() }

      await resolveWebSocketUrl('example.com', 'example.com', logger)

      expect(logger.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('Attempting XEP-0156'),
        'connection'
      )
      expect(logger.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('discovery successful'),
        'connection'
      )
    })

    it('should log discovery failure via logger', async () => {
      mockDiscover.mockRejectedValue(new Error('DNS failed'))
      const logger = { addEvent: vi.fn() }

      await resolveWebSocketUrl('example.com', 'example.com', logger)

      expect(logger.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('discovery failed: DNS failed'),
        'connection'
      )
    })
  })
})
