import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ProxyManager,
  type ProxyManagerDeps,
  PROXY_START_TIMEOUT_MS,
  PROXY_STOP_TIMEOUT_MS,
} from './proxyManager'
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

const PROXY_RESULT: ProxyStartResult = {
  url: 'ws://127.0.0.1:12345',
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

  describe('ensureProxy', () => {
    it('should start proxy and return server result', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(PROXY_RESULT)
      const pm = new ProxyManager(deps)

      const result = await pm.ensureProxy('example.com', 'example.com')

      expect(proxyAdapter.startProxy).toHaveBeenCalledWith('example.com')
      expect(result).toEqual({
        server: 'ws://127.0.0.1:12345',
        connectionMethod: 'proxy',
      })
    })

    it('should cache proxy URL and reuse on subsequent calls', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(PROXY_RESULT)
      const pm = new ProxyManager(deps)

      await pm.ensureProxy('example.com', 'example.com')
      vi.clearAllMocks()

      const result = await pm.ensureProxy('example.com', 'example.com')

      // Should not call startProxy again (cached)
      expect(proxyAdapter.startProxy).not.toHaveBeenCalled()
      expect(result).toEqual({
        server: 'ws://127.0.0.1:12345',
        connectionMethod: 'proxy',
      })
    })

    it('should start new proxy when server changes', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(PROXY_RESULT)
      const pm = new ProxyManager(deps)

      await pm.ensureProxy('example.com', 'example.com')
      vi.clearAllMocks()

      const newResult: ProxyStartResult = { url: 'ws://127.0.0.1:12346' }
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(newResult)

      const result = await pm.ensureProxy('other.com', 'other.com')

      expect(proxyAdapter.startProxy).toHaveBeenCalledWith('other.com')
      expect(result.server).toBe('ws://127.0.0.1:12346')
    })

    it('should fall back to WebSocket when proxy fails', async () => {
      vi.mocked(proxyAdapter.startProxy).mockRejectedValue(new Error('proxy failed'))
      const pm = new ProxyManager(deps)

      const result = await pm.ensureProxy('example.com', 'example.com', true)

      expect(result).toEqual({
        server: 'wss://example.com/ws',
        connectionMethod: 'websocket',
      })
    })

    it('should use domain when server is empty', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(PROXY_RESULT)
      const pm = new ProxyManager(deps)

      await pm.ensureProxy('', 'example.com')

      expect(proxyAdapter.startProxy).toHaveBeenCalledWith('example.com')
    })

    it('should throw when no proxy adapter', async () => {
      const pm = new ProxyManager(createDeps({ proxyAdapter: undefined }))
      await expect(pm.ensureProxy('example.com', 'example.com')).rejects.toThrow('No proxy adapter')
    })

    it('should serialize concurrent ensureProxy calls for same target', async () => {
      let resolveStart: ((value: ProxyStartResult) => void) | undefined
      const startPromise = new Promise<ProxyStartResult>((resolve) => {
        resolveStart = resolve
      })
      vi.mocked(proxyAdapter.startProxy).mockReturnValue(startPromise)

      const pm = new ProxyManager(deps)

      const first = pm.ensureProxy('example.com', 'example.com')
      const second = pm.ensureProxy('example.com', 'example.com')

      resolveStart!(PROXY_RESULT)

      await expect(first).resolves.toEqual({
        server: 'ws://127.0.0.1:12345',
        connectionMethod: 'proxy',
      })
      await expect(second).resolves.toEqual({
        server: 'ws://127.0.0.1:12345',
        connectionMethod: 'proxy',
      })
      expect(proxyAdapter.startProxy).toHaveBeenCalledTimes(1)
    })

    it('should fall back when startProxy hangs past timeout', async () => {
      vi.useFakeTimers()
      vi.mocked(proxyAdapter.startProxy).mockReturnValue(new Promise(() => {}))
      const pm = new ProxyManager(deps)

      const resultPromise = pm.ensureProxy('example.com', 'example.com', true)
      await vi.advanceTimersByTimeAsync(PROXY_START_TIMEOUT_MS + 1)

      await expect(resultPromise).resolves.toEqual({
        server: 'wss://example.com/ws',
        connectionMethod: 'websocket',
      })
      expect(pm.getLifecycleState()).toBe('stopped')

      vi.useRealTimers()
    })
  })

  describe('stopProxy', () => {
    it('should stop proxy and clear cached URL', async () => {
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(PROXY_RESULT)
      const pm = new ProxyManager(deps)

      await pm.ensureProxy('example.com', 'example.com')
      expect(pm.getProxyUrl()).toBe('ws://127.0.0.1:12345')

      await pm.stopProxy()

      expect(proxyAdapter.stopProxy).toHaveBeenCalledTimes(1)
      expect(pm.getProxyUrl()).toBeNull()
    })

    it('should no-op when no proxy adapter exists', async () => {
      const pm = new ProxyManager(createDeps({ proxyAdapter: undefined }))
      await expect(pm.stopProxy()).resolves.toBeUndefined()
    })

    it('should timeout a hung stopProxy call and still clear local state', async () => {
      vi.useFakeTimers()
      vi.mocked(proxyAdapter.startProxy).mockResolvedValue(PROXY_RESULT)
      vi.mocked(proxyAdapter.stopProxy).mockReturnValue(new Promise(() => {}))
      const pm = new ProxyManager(deps)

      await pm.ensureProxy('example.com', 'example.com')
      const stopPromise = pm.stopProxy()
      const stopAssertion = expect(stopPromise).rejects.toThrow(
        `stopProxy timed out after ${PROXY_STOP_TIMEOUT_MS}ms`
      )
      await vi.advanceTimersByTimeAsync(PROXY_STOP_TIMEOUT_MS + 1)

      await stopAssertion
      expect(pm.getProxyUrl()).toBeNull()
      expect(pm.getLifecycleState()).toBe('stopped')

      vi.useRealTimers()
    })
  })
})
