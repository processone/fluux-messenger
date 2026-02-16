import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProxyManager, type ProxyManagerDeps } from './proxyManager'
import type { ProxyAdapter, ProxyStartResult } from '../types'

function createMockProxyAdapter(): ProxyAdapter {
  return {
    startProxy: vi.fn(),
    stopProxy: vi.fn().mockResolvedValue(undefined),
  }
}

function createDeps(overrides?: Partial<ProxyManagerDeps>): ProxyManagerDeps {
  return {
    proxyAdapter: createMockProxyAdapter(),
    console: { addEvent: vi.fn() },
    ...overrides,
  }
}

const TLS_RESULT: ProxyStartResult = {
  url: 'ws://127.0.0.1:12345',
  connectionMethod: 'tls',
  resolvedEndpoint: 'tls://chat.example.com:5223',
}

const STARTTLS_RESULT: ProxyStartResult = {
  url: 'ws://127.0.0.1:12346',
  connectionMethod: 'starttls',
  resolvedEndpoint: 'tcp://chat.example.com:5222',
}

describe('ProxyManager', () => {
  let deps: ProxyManagerDeps
  let proxyAdapter: ProxyAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    deps = createDeps()
    proxyAdapter = deps.proxyAdapter!
  })

  describe('hasProxy', () => {
    it('should return true when proxy adapter is provided', () => {
      const pm = new ProxyManager(deps)
      expect(pm.hasProxy).toBe(true)
    })

    it('should return false when no proxy adapter', () => {
      const pm = new ProxyManager(createDeps({ proxyAdapter: undefined }))
      expect(pm.hasProxy).toBe(false)
    })
  })

  describe('startForConnect', () => {
    it('should start proxy and return server result', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(TLS_RESULT)
      const pm = new ProxyManager(deps)

      const result = await pm.startForConnect('example.com', 'example.com')

      expect(proxyAdapter.startProxy).toHaveBeenCalledWith('example.com')
      expect(result).toEqual({
        server: 'ws://127.0.0.1:12345',
        connectionMethod: 'tls',
      })
    })

    it('should cache resolved endpoint from proxy', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(TLS_RESULT)
      const pm = new ProxyManager(deps)

      await pm.startForConnect('example.com', 'example.com')

      expect(pm.getResolvedEndpoint()).toBe('tls://chat.example.com:5223')
    })

    it('should fall back to WebSocket when proxy fails', async () => {
      vi.mocked(proxyAdapter.startProxy).mockRejectedValue(new Error('proxy failed'))
      const pm = new ProxyManager(deps)

      const result = await pm.startForConnect('example.com', 'example.com', true)

      expect(result).toEqual({
        server: 'wss://example.com/ws',
        connectionMethod: 'websocket',
      })
    })

    it('should use domain when server is empty', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(TLS_RESULT)
      const pm = new ProxyManager(deps)

      await pm.startForConnect('', 'example.com')

      expect(proxyAdapter.startProxy).toHaveBeenCalledWith('example.com')
    })

    it('should throw when no proxy adapter', async () => {
      const pm = new ProxyManager(createDeps({ proxyAdapter: undefined }))
      await expect(pm.startForConnect('example.com', 'example.com')).rejects.toThrow('No proxy adapter')
    })
  })

  describe('restartForReconnect', () => {
    it('should stop old proxy and restart with cached endpoint', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(TLS_RESULT)
      const pm = new ProxyManager(deps)
      pm.setOriginalServer('example.com')

      // Simulate initial connect that cached an endpoint
      await pm.startForConnect('example.com', 'example.com')
      vi.clearAllMocks()

      vi.mocked(proxyAdapter.startProxy).mockResolvedValue({
        url: 'ws://127.0.0.1:12347',
        connectionMethod: 'tls',
        resolvedEndpoint: 'tls://chat.example.com:5223',
      })

      const result = await pm.restartForReconnect('example.com')

      // Should have stopped the old proxy first
      expect(proxyAdapter.stopProxy).toHaveBeenCalled()
      // Should use cached endpoint (not original server)
      expect(proxyAdapter.startProxy).toHaveBeenCalledWith('tls://chat.example.com:5223')
      expect(result.connectionMethod).toBe('tls')
    })

    it('should fall back to original server when cached endpoint fails', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(TLS_RESULT)
      const pm = new ProxyManager(deps)
      pm.setOriginalServer('example.com')

      // Initial connect caches endpoint
      await pm.startForConnect('example.com', 'example.com')
      vi.clearAllMocks()

      // First call (cached endpoint) fails, second call (original server) succeeds
      vi.mocked(proxyAdapter.startProxy)
        .mockRejectedValueOnce(new Error('cached endpoint dead'))
        .mockResolvedValueOnce(STARTTLS_RESULT)

      const result = await pm.restartForReconnect('example.com')

      // Should have called startProxy twice: once with cached, once with original
      expect(proxyAdapter.startProxy).toHaveBeenCalledTimes(2)
      expect(proxyAdapter.startProxy).toHaveBeenNthCalledWith(1, 'tls://chat.example.com:5223')
      expect(proxyAdapter.startProxy).toHaveBeenNthCalledWith(2, 'example.com')
      expect(result.connectionMethod).toBe('starttls')
    })

    it('should fall back to WebSocket when both proxy attempts fail', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(TLS_RESULT)
      const pm = new ProxyManager(deps)
      pm.setOriginalServer('example.com')

      // Initial connect caches endpoint
      await pm.startForConnect('example.com', 'example.com')
      vi.clearAllMocks()

      // Both attempts fail
      vi.mocked(proxyAdapter.startProxy)
        .mockRejectedValueOnce(new Error('cached dead'))
        .mockRejectedValueOnce(new Error('srv dead'))

      const result = await pm.restartForReconnect('example.com')

      expect(result).toEqual({
        server: 'wss://example.com/ws',
        connectionMethod: 'websocket',
      })
    })

    it('should fall back to WebSocket directly when no cached endpoint', async () => {
      const pm = new ProxyManager(deps)
      pm.setOriginalServer('example.com')

      // No cached endpoint — startProxy fails on first attempt
      vi.mocked(proxyAdapter.startProxy).mockRejectedValue(new Error('proxy dead'))

      const result = await pm.restartForReconnect('example.com')

      expect(result).toEqual({
        server: 'wss://example.com/ws',
        connectionMethod: 'websocket',
      })
      // Only one attempt (no cached endpoint to try first)
      expect(proxyAdapter.startProxy).toHaveBeenCalledTimes(1)
    })

    it('should throw when no proxy adapter', async () => {
      const pm = new ProxyManager(createDeps({ proxyAdapter: undefined }))
      await expect(pm.restartForReconnect('example.com')).rejects.toThrow('No proxy adapter')
    })
  })

  describe('stop', () => {
    it('should stop the proxy', () => {
      const pm = new ProxyManager(deps)
      pm.stop()
      expect(proxyAdapter.stopProxy).toHaveBeenCalled()
    })

    it('should no-op when no proxy adapter', () => {
      const pm = new ProxyManager(createDeps({ proxyAdapter: undefined }))
      pm.stop() // Should not throw
    })
  })

  describe('reset', () => {
    it('should clear originalServer and resolvedEndpoint', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(TLS_RESULT)
      const pm = new ProxyManager(deps)
      pm.setOriginalServer('example.com')
      await pm.startForConnect('example.com', 'example.com')

      pm.reset()

      expect(pm.getOriginalServer()).toBe('')
      expect(pm.getResolvedEndpoint()).toBeNull()
    })
  })
})
