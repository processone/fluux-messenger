import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock isTauri to return false so BroadcastChannel coordination is active
vi.mock('@/utils/tauri', () => ({
  isTauri: () => false,
}))

// Mock getResource to return a stable tab ID
vi.mock('@/utils/xmppResource', () => ({
  getResource: () => 'test-tab-id',
}))

import { useTabCoordination } from './useTabCoordination'

describe('useTabCoordination', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should start with blocked=false and takenOver=false', () => {
    const { result } = renderHook(() => useTabCoordination())
    expect(result.current.blocked).toBe(false)
    expect(result.current.takenOver).toBe(false)
  })

  it('should provide claimConnection, takeOver, and releaseConnection functions', () => {
    const { result } = renderHook(() => useTabCoordination())
    expect(typeof result.current.claimConnection).toBe('function')
    expect(typeof result.current.takeOver).toBe('function')
    expect(typeof result.current.releaseConnection).toBe('function')
  })

  it('should claim connection when no other tab responds', async () => {
    const { result } = renderHook(() => useTabCoordination())

    let claimed: boolean | undefined
    await act(async () => {
      const promise = result.current.claimConnection('user@example.com')
      // Advance past the CLAIM_TIMEOUT_MS (500ms)
      await vi.advanceTimersByTimeAsync(600)
      claimed = await promise
    })

    expect(claimed).toBe(true)
    expect(result.current.blocked).toBe(false)
  })

  it('should detect blocking when another tab responds ALIVE', async () => {
    const { result } = renderHook(() => useTabCoordination())

    // Set up a second BroadcastChannel to simulate another tab
    const otherTab = new BroadcastChannel('fluux-tab-coordination')
    otherTab.addEventListener('message', (event) => {
      if (event.data.type === 'CLAIM') {
        otherTab.postMessage({
          type: 'ALIVE',
          tabId: 'other-tab-id',
          jid: event.data.jid,
        })
      }
    })

    let claimed: boolean | undefined
    await act(async () => {
      const promise = result.current.claimConnection('user@example.com')
      // Allow BroadcastChannel messages to propagate
      await vi.advanceTimersByTimeAsync(50)
      claimed = await promise
    })

    expect(claimed).toBe(false)
    expect(result.current.blocked).toBe(true)

    otherTab.close()
  })

  it('should set takenOver when receiving TAKEOVER message', async () => {
    const onTakenOver = vi.fn()
    const { result } = renderHook(() => useTabCoordination(onTakenOver))

    // First claim the connection
    await act(async () => {
      const promise = result.current.claimConnection('user@example.com')
      await vi.advanceTimersByTimeAsync(600)
      await promise
    })

    // Simulate another tab sending TAKEOVER
    const otherTab = new BroadcastChannel('fluux-tab-coordination')
    await act(async () => {
      otherTab.postMessage({
        type: 'TAKEOVER',
        tabId: 'other-tab-id',
        jid: 'user@example.com',
        targetTabId: 'test-tab-id',
      })
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(result.current.takenOver).toBe(true)
    expect(onTakenOver).toHaveBeenCalled()

    otherTab.close()
  })

  it('should unblock when receiving RELEASE message', async () => {
    const { result } = renderHook(() => useTabCoordination())

    // Set up blocker tab
    const otherTab = new BroadcastChannel('fluux-tab-coordination')
    otherTab.addEventListener('message', (event) => {
      if (event.data.type === 'CLAIM') {
        otherTab.postMessage({
          type: 'ALIVE',
          tabId: 'other-tab-id',
          jid: event.data.jid,
        })
      }
    })

    // Get blocked
    await act(async () => {
      const promise = result.current.claimConnection('user@example.com')
      await vi.advanceTimersByTimeAsync(50)
      await promise
    })
    expect(result.current.blocked).toBe(true)

    // Other tab releases
    await act(async () => {
      otherTab.postMessage({
        type: 'RELEASE',
        tabId: 'other-tab-id',
        jid: 'user@example.com',
      })
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(result.current.blocked).toBe(false)

    otherTab.close()
  })

  it('should clean up BroadcastChannel on unmount', () => {
    const { unmount } = renderHook(() => useTabCoordination())
    // Should not throw
    unmount()
  })
})
