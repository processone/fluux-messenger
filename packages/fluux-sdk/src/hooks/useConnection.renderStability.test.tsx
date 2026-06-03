/**
 * @vitest-environment happy-dom
 *
 * Regression guard for the LoginScreen/App connect-transition render burst.
 *
 * `useConnection()` subscribes to the whole connection store, so a component
 * that only needs `status` still re-renders when unrelated fields
 * (`connectionMethod`, `authMechanism`, `serverInfo`, reconnect state, own
 * profile, ...) change. During a connect handshake several of those change in
 * quick succession — enough to trip the dev render-loop warning on LoginScreen
 * before the post-`online` sync grace period arms.
 *
 * `useConnectionStatus()` / `useConnectionActions()` are the focused
 * counterparts (cf. useChatActive / useChatActions). These tests lock in that
 * the focused hooks do NOT re-render on unrelated field changes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useConnection } from './useConnection'
import { useConnectionStatus } from './useConnectionStatus'
import { useConnectionActions } from './useConnectionActions'
import { connectionStore } from '../stores'
import { wrapper, useRenderCount } from './renderStability.helpers'

const serverInfo = { domain: 'example.com', identities: [], features: ['urn:xmpp:carbons:2'] }

/** Fields written during a connect handshake that a login form never reads. */
function emitUnrelatedConnectFields() {
  act(() => { connectionStore.getState().setConnectionMethod('websocket') })
  act(() => { connectionStore.getState().setAuthMechanism('SCRAM-SHA-1') })
  act(() => { connectionStore.getState().setServerInfo(serverInfo) })
}

describe('useConnection render stability', () => {
  beforeEach(() => {
    connectionStore.getState().reset()
  })

  it('useConnection re-renders on unrelated connection fields (documents the broad subscription)', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const { status } = useConnection()
        return { renderCount, status }
      },
      { wrapper }
    )

    const baseline = result.current.renderCount
    emitUnrelatedConnectFields()

    // Subscribes to connectionMethod + authMechanism + serverInfo → re-renders
    // once per change. This is exactly the churn that bursts during connect.
    expect(result.current.renderCount - baseline).toBeGreaterThanOrEqual(3)
  })

  it('useConnectionStatus does NOT re-render on unrelated connection fields', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const { status, error } = useConnectionStatus()
        return { renderCount, status, error }
      },
      { wrapper }
    )

    const baseline = result.current.renderCount
    emitUnrelatedConnectFields()
    act(() => { connectionStore.getState().setReconnectState(2, 5000) })

    // Subscribes only to status/jid/error → zero extra renders.
    expect(result.current.renderCount).toBe(baseline)
  })

  it('useConnectionStatus still reflects status/error changes', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const s = useConnectionStatus()
        return { renderCount, ...s }
      },
      { wrapper }
    )

    const baseline = result.current.renderCount

    act(() => { connectionStore.getState().setStatus('connecting') })
    expect(result.current.status).toBe('connecting')
    expect(result.current.isConnecting).toBe(true)

    act(() => { connectionStore.getState().setError('boom') })
    expect(result.current.error).toBe('boom')

    act(() => { connectionStore.getState().setStatus('online') })
    expect(result.current.isConnected).toBe(true)

    // Reacts to the lifecycle, but stays bounded (no storm).
    expect(result.current.renderCount - baseline).toBeGreaterThan(0)
  })

  it('useConnectionActions performs no store subscriptions and keeps a stable identity', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const actions = useConnectionActions()
        return { renderCount, actions }
      },
      { wrapper }
    )

    const baseline = result.current.renderCount
    const firstActions = result.current.actions

    emitUnrelatedConnectFields()
    act(() => { connectionStore.getState().setStatus('online') })

    expect(result.current.renderCount).toBe(baseline)
    expect(result.current.actions).toBe(firstActions)
    expect(typeof result.current.actions.connect).toBe('function')
  })
})
