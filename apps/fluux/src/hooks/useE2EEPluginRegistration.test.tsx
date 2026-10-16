import { StrictMode, useEffect, useState } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { E2EEManager } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { setPlatformForTesting } from '@/platform'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useE2EEPluginRegistration } from './useE2EEPluginRegistration'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/e2ee/SequoiaPgpPlugin', () => ({
  SequoiaPgpPlugin: class {},
}))

function makeManager() {
  let plugin: unknown = null
  return {
    getAccountJid: () => 'me@example.com',
    getPlugin: () => plugin,
    register: vi.fn(async (value: unknown) => { plugin = value }),
    setForcedPlaintext: vi.fn(),
  } as unknown as E2EEManager
}

function makeClient(manager: E2EEManager | null) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const client = {
    e2ee: manager,
    subscribe: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
      return () => { handlers.get(event)!.delete(handler) }
    }),
  } as unknown as XMPPClient
  const emit = (event: string, payload?: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }
  return {
    client,
    ready: () => emit('e2ee:manager-ready'),
    connected: (jid = 'me@example.com/resource') => emit('connection:authenticated', { jid }),
  }
}

describe('useE2EEPluginRegistration', () => {
  beforeEach(() => {
    setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    useEncryptionSettingsStore.setState({ openpgpEnabled: true, pluginRegisteredAt: 0, registrationError: null })
  })

  afterEach(() => {
    cleanup()
    setPlatformForTesting({ shell: 'web', os: 'macos' })
  })

  it('waits for the manager lifecycle signal and ignores duplicate signals during initialization', async () => {
    const { client, ready } = makeClient(null)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    expect(client.subscribe).toHaveBeenCalledWith('e2ee:manager-ready', expect.any(Function))
    expect(onRegistered).not.toHaveBeenCalled()

    const manager = makeManager()
    client.e2ee = manager
    act(() => { ready(); ready() })
    await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith(manager))
    expect(manager.register).toHaveBeenCalledTimes(1)
    expect(useEncryptionSettingsStore.getState().pluginRegisteredAt).toBe(1)
    act(ready)
    expect(manager.register).toHaveBeenCalledTimes(1)
  })

  it('registers immediately when the manager exists before subscribing', async () => {
    const manager = makeManager()
    const { client } = makeClient(manager)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith(manager))
    expect(manager.register).toHaveBeenCalledTimes(1)
  })

  it('lets account settings rehydrate in React before registration reads the opt-in', async () => {
    const { client, ready } = makeClient(null)
    const onRegistered = vi.fn(async () => {})
    useEncryptionSettingsStore.setState({ openpgpEnabled: false })
    const { result } = renderHook(() => {
      const [account, setAccount] = useState(0)
      useEffect(() => {
        useEncryptionSettingsStore.setState({ openpgpEnabled: account === 1 })
      }, [account])
      useE2EEPluginRegistration(client, onRegistered)
      return setAccount
    })
    const manager = makeManager()
    act(() => {
      result.current(1)
      client.e2ee = manager
      ready()
    })
    await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith(manager))
    expect(manager.register).toHaveBeenCalledTimes(1)
  })

  it('registers each rebuilt identity independently', async () => {
    const first = makeManager()
    const { client, ready } = makeClient(first)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith(first))

    const second = makeManager()
    client.e2ee = second
    act(ready)
    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith(second))
    expect(first.register).toHaveBeenCalledTimes(1)
    expect(second.register).toHaveBeenCalledTimes(1)
    expect(onRegistered).toHaveBeenCalledTimes(2)
  })

  it('shares initialization across StrictMode effect remounts', async () => {
    const manager = makeManager()
    const { client } = makeClient(manager)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered), { wrapper: StrictMode })
    await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith(manager))
    expect(manager.register).toHaveBeenCalledTimes(1)
    expect(useEncryptionSettingsStore.getState().pluginRegisteredAt).toBe(1)
  })

  it('ignores a previous identity finishing registration after its replacement', async () => {
    const first = makeManager()
    let release!: () => void
    vi.mocked(first.register).mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const { client, ready } = makeClient(first)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    await waitFor(() => expect(first.register).toHaveBeenCalledTimes(1))

    const second = makeManager()
    client.e2ee = second
    act(ready)
    await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith(second))
    await act(async () => { release() })
    expect(onRegistered).toHaveBeenCalledTimes(1)
    expect(useEncryptionSettingsStore.getState().pluginRegisteredAt).toBe(1)
  })

  it('retries a failed initialization after a successful connection', async () => {
    const manager = makeManager()
    vi.mocked(manager.register).mockRejectedValueOnce(new Error('PEP timeout'))
    const { client, connected } = makeClient(manager)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    await waitFor(() => expect(useEncryptionSettingsStore.getState().registrationError).not.toBeNull())
    expect(manager.getPlugin('openpgp')).toBeNull()
    expect(onRegistered).not.toHaveBeenCalled()

    act(() => connected())
    await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith(manager))
    expect(manager.register).toHaveBeenCalledTimes(2)
    expect(manager.getPlugin('openpgp')).not.toBeNull()
  })

  it.each([false, true])('preserves a reconnect during pending initialization (retry fails: %s)', async (retryFails) => {
    const manager = makeManager()
    let reject!: (error: Error) => void
    vi.mocked(manager.register).mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    if (retryFails) vi.mocked(manager.register).mockRejectedValueOnce(new Error('Retry timeout'))
    const { client, connected } = makeClient(manager)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    await waitFor(() => expect(manager.register).toHaveBeenCalledTimes(1))
    act(() => connected())
    expect(manager.register).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('Old PEP timeout')) })
    await waitFor(() => expect(manager.register).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(manager.register).toHaveBeenCalledTimes(2)
    expect(Boolean(manager.getPlugin('openpgp'))).toBe(!retryFails)
    expect(onRegistered).toHaveBeenCalledTimes(retryFails ? 0 : 1)
  })

  it.each(['replacement', 'different-account', 'disabled', 'unmounted'])('discards a queued reconnect after %s', async (transition) => {
    const manager = makeManager()
    let reject!: (error: Error) => void
    vi.mocked(manager.register).mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const { client, connected, ready } = makeClient(manager)
    const onRegistered = vi.fn(async () => {})
    const { unmount } = renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    await waitFor(() => expect(manager.register).toHaveBeenCalledTimes(1))
    act(() => connected())
    const replacement = makeManager()
    act(() => {
      if (transition === 'replacement') { client.e2ee = replacement; ready() }
      if (transition === 'different-account') connected('other@example.com/resource')
      if (transition === 'disabled') useEncryptionSettingsStore.setState({ openpgpEnabled: false })
      if (transition === 'unmounted') unmount()
    })
    await act(async () => { reject(new Error('Old PEP timeout')) })
    if (transition === 'replacement') {
      await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith(replacement))
    } else expect(onRegistered).not.toHaveBeenCalled()
    expect(manager.register).toHaveBeenCalledTimes(1)
    expect(manager.getPlugin('openpgp')).toBeNull()
  })

  it('registers an offline opt-in on reconnect and skips a healthy manager thereafter', async () => {
    useEncryptionSettingsStore.setState({ openpgpEnabled: false })
    const manager = makeManager()
    const { client, connected } = makeClient(manager)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    await act(async () => {})
    expect(manager.register).not.toHaveBeenCalled()
    act(() => { useEncryptionSettingsStore.setState({ openpgpEnabled: true }) })
    expect(manager.register).not.toHaveBeenCalled()
    act(() => connected())
    await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith(manager))
    act(() => connected())
    await act(async () => {})
    expect(manager.register).toHaveBeenCalledTimes(1)
    expect(onRegistered).toHaveBeenCalledTimes(1)
  })

  it('does not retry an old manager for a different authenticated identity', async () => {
    const manager = makeManager()
    vi.mocked(manager.register).mockRejectedValueOnce(new Error('PEP timeout'))
    const { client, connected } = makeClient(manager)
    const onRegistered = vi.fn(async () => {})
    renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    await waitFor(() => expect(useEncryptionSettingsStore.getState().registrationError).not.toBeNull())
    act(() => connected('other@example.com/resource'))
    await act(async () => {})
    expect(manager.register).toHaveBeenCalledTimes(1)
    expect(onRegistered).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount before a manager appears', () => {
    const { client, ready } = makeClient(null)
    const onRegistered = vi.fn(async () => {})
    const { unmount } = renderHook(() => useE2EEPluginRegistration(client, onRegistered))
    unmount()
    const manager = makeManager()
    client.e2ee = manager
    act(ready)
    expect(manager.register).not.toHaveBeenCalled()
  })
})
