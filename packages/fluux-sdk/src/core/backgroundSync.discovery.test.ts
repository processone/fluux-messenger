import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockClient, localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { setupBackgroundSyncSideEffects, SERVER_DISCOVERY_RETRY_DELAY_MS, SERVER_DISCOVERY_RETRY_MAX_DELAY_MS } from './backgroundSync'
import { MAM_ROOM_CATCHUP_DELAY_MS } from '../utils/mamCatchUpUtils'
import { connectionStore } from '../stores/connectionStore'
import { roomStore } from '../stores/roomStore'
import { NS_MAM } from './namespaces'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('background session discovery recovery', () => {
  let client: ReturnType<typeof createMockClient>
  let cleanup: (() => void) | undefined
  const active = () => connectionStore.getState().isCatchingUp
  const inputsReady = () => client._emit('freshSessionInputsReady')
  const discoverySettled = () => client._emit('freshSessionDiscoverySettled')
  const connect = (inputs = true) => {
    cleanup = setupBackgroundSyncSideEffects(client)
    connectionStore.getState().setStatus('connecting')
    connectionStore.getState().setStatus('online')
    client._emit('online')
    if (inputs) inputsReady()
  }
  beforeEach(() => {
    vi.useFakeTimers()
    localStorageMock.clear()
    connectionStore.getState().reset()
    roomStore.getState().reset()
    client = createMockClient()
  })
  afterEach(() => {
    cleanup?.(); cleanup = undefined
    connectionStore.getState().reset()
    roomStore.getState().reset()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not retry while the initial discovery is still pending', async () => {
    connect()
    await vi.advanceTimersByTimeAsync(4 * SERVER_DISCOVERY_RETRY_DELAY_MS)
    expect(active()).toBe(true)
    expect(client.server.fetchServerInfo).not.toHaveBeenCalled()
    discoverySettled()
    await vi.advanceTimersByTimeAsync(SERVER_DISCOVERY_RETRY_DELAY_MS)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
    expect(active()).toBe(true)
    expect(connectionStore.getState().serverInfo).toBeNull()
  })

  it('waits for session inputs even when discovery already failed', async () => {
    connect(false)
    discoverySettled()
    await vi.advanceTimersByTimeAsync(4 * SERVER_DISCOVERY_RETRY_DELAY_MS)
    expect(client.server.fetchServerInfo).not.toHaveBeenCalled()
    expect(active()).toBe(true)
    inputsReady()
    await vi.advanceTimersByTimeAsync(SERVER_DISCOVERY_RETRY_DELAY_MS)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
  })

  it('keeps a single request in flight and waits after it settles before retrying', async () => {
    const pending = deferred()
    client.server.fetchServerInfo.mockReturnValue(pending.promise)
    connect()
    discoverySettled()
    await vi.advanceTimersByTimeAsync(SERVER_DISCOVERY_RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
    expect(active()).toBe(true)
    pending.resolve()
    // The second attempt waits twice as long as the first (backoff).
    await vi.advanceTimersByTimeAsync(2 * SERVER_DISCOVERY_RETRY_DELAY_MS - 1)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(2)
    expect(active()).toBe(true)
  })

  // Review finding: a server that keeps refusing domain discovery must not be polled every 5 seconds all session.
  it('doubles the wait between retries up to a ceiling while capability data stays unknown', async () => {
    connect()
    discoverySettled()
    let expected = SERVER_DISCOVERY_RETRY_DELAY_MS
    let calls = 0
    while (expected < SERVER_DISCOVERY_RETRY_MAX_DELAY_MS) {
      await vi.advanceTimersByTimeAsync(expected - 1)
      expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(++calls)
      expected = Math.min(expected * 2, SERVER_DISCOVERY_RETRY_MAX_DELAY_MS)
    }
    // At the ceiling the wait stops growing.
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(SERVER_DISCOVERY_RETRY_MAX_DELAY_MS - 1)
      expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(++calls)
    }
  })

  it('releases only preparation after an explicit result without MAM', async () => {
    connect()
    const endOther = connectionStore.getState().beginUpdate(['messages'])
    client.server.fetchServerInfo.mockImplementation(async () => {
      connectionStore.getState().setServerInfo({ domain: 'example.test', identities: [], features: [] })
    })
    discoverySettled()
    await vi.advanceTimersByTimeAsync(SERVER_DISCOVERY_RETRY_DELAY_MS)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
    expect(connectionStore.getState().catchUpOwners).toBe(1)
    expect(active()).toBe(true)
    endOther()
    expect(active()).toBe(false)
    await vi.advanceTimersByTimeAsync(3 * SERVER_DISCOVERY_RETRY_DELAY_MS)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
    expect(client.internal.mam.catchUpAllConversations).not.toHaveBeenCalled()
  })

  it('cancels a scheduled retry when MAM arrives and retains normal archive/room ownership', async () => {
    connect()
    discoverySettled()
    connectionStore.getState().setServerInfo({ domain: 'example.test', identities: [], features: [NS_MAM] })
    expect(active()).toBe(true)
    await vi.advanceTimersByTimeAsync(MAM_ROOM_CATCHUP_DELAY_MS + 1)
    expect(client.server.fetchServerInfo).not.toHaveBeenCalled()
    expect(client.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
    expect(active()).toBe(false)
  })

  it.each(['offline', 'resumed', 'cleanup'] as const)('does not retry after %s, including a late pending reply', async action => {
    const pending = deferred()
    client.server.fetchServerInfo.mockReturnValue(pending.promise)
    connect()
    discoverySettled()
    await vi.advanceTimersByTimeAsync(SERVER_DISCOVERY_RETRY_DELAY_MS)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
    if (action === 'offline') connectionStore.getState().setStatus('reconnecting')
    else if (action === 'resumed') client._emit('resumed')
    else { cleanup?.(); cleanup = undefined }
    pending.resolve()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(1)
  })

  it('does not let an old attempt clear or reschedule the new session attempt', async () => {
    const old = deferred()
    const current = deferred()
    client.server.fetchServerInfo.mockReturnValueOnce(old.promise).mockReturnValue(current.promise)
    connect()
    discoverySettled()
    await vi.advanceTimersByTimeAsync(SERVER_DISCOVERY_RETRY_DELAY_MS)
    connectionStore.getState().setStatus('reconnecting')
    connectionStore.getState().setStatus('online')
    client._emit('online'); inputsReady(); discoverySettled()
    await vi.advanceTimersByTimeAsync(SERVER_DISCOVERY_RETRY_DELAY_MS)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(2)
    old.resolve()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.server.fetchServerInfo).toHaveBeenCalledTimes(2)
    expect(active()).toBe(true)
    current.resolve()
  })
})
