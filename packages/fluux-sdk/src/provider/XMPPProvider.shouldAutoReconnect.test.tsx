/**
 * @vitest-environment happy-dom
 *
 * Verifies the `shouldAutoReconnect` predicate threads from XMPPProvider props
 * into the constructed XMPPClient config. Mocks XMPPClient (in its own file so
 * the real-client persistence tests are unaffected) and captures the config
 * passed to the constructor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { XMPPClientConfig } from '../core/types/client'

const { capturedConfigs, makeStubClient } = vi.hoisted(() => {
  const configs: Array<XMPPClientConfig | undefined> = []
  return {
    capturedConfigs: configs,
    // Minimal stub satisfying the provider's effects/refs.
    makeStubClient: () => ({
      presenceActor: { subscribe: () => ({ unsubscribe: () => {} }), getSnapshot: () => ({}) },
      setupBindings: vi.fn(),
      destroy: vi.fn(),
      getHook: vi.fn(() => undefined),
      registerHook: vi.fn(),
      persistSmState: vi.fn(),
      flushStateSnapshot: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

vi.mock('../core/XMPPClient', () => ({
  // Regular function (not arrow) so it is callable with `new`.
  XMPPClient: vi.fn(function (this: unknown, config?: XMPPClientConfig) {
    capturedConfigs.push(config)
    return makeStubClient()
  }),
}))

// The provider also touches these on mount; keep them inert.
vi.mock('../utils/debugUtils', () => ({ setupDebugUtils: () => () => {} }))
vi.mock('../stores/searchStore', () => ({ setSearchClient: vi.fn() }))
vi.mock('../core/eventHooks', () => ({ ActivityLogHook: vi.fn() }))

import { XMPPProvider } from './XMPPProvider'

describe('XMPPProvider shouldAutoReconnect threading', () => {
  beforeEach(() => {
    cleanup()
    capturedConfigs.length = 0
    vi.clearAllMocks()
  })

  it('threads shouldAutoReconnect into the constructed client config', () => {
    const predicate = () => true
    render(
      <XMPPProvider shouldAutoReconnect={predicate}>
        <div />
      </XMPPProvider>
    )
    expect(capturedConfigs).toHaveLength(1)
    expect(capturedConfigs[0]?.shouldAutoReconnect).toBe(predicate)
  })

  it('omits shouldAutoReconnect when the prop is not provided', () => {
    render(
      <XMPPProvider>
        <div />
      </XMPPProvider>
    )
    expect(capturedConfigs).toHaveLength(1)
    expect(capturedConfigs[0]?.shouldAutoReconnect).toBeUndefined()
  })
})
