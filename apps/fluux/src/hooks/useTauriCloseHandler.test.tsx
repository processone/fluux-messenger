import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTauriCloseHandler } from './useTauriCloseHandler'
import { isShuttingDown, resetShutdownStateForTests } from '@/utils/appShutdown'

// Captures the `graceful-shutdown` callback Rust would invoke on quit.
let shutdownHandler: (() => Promise<void>) | null = null
const mockListen = vi.fn(async (event: string, cb: () => Promise<void>) => {
  if (event === 'graceful-shutdown') shutdownHandler = cb
  return () => {}
})
const mockInvoke = vi.fn().mockResolvedValue(undefined)

vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => mockListen(...(a as [string, () => Promise<void>])) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }))

// Records whether shutdown was already marked at the moment disconnect ran.
let shuttingDownAtDisconnect: boolean | null = null
const mockDisconnect = vi.fn(async () => {
  shuttingDownAtDisconnect = isShuttingDown()
})

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useXMPPContext: () => ({ client: { disconnect: mockDisconnect } }),
}))

describe('useTauriCloseHandler — shutdown marking', () => {
  beforeEach(() => {
    shutdownHandler = null
    shuttingDownAtDisconnect = null
    mockDisconnect.mockClear()
    mockInvoke.mockClear()
    resetShutdownStateForTests()
    // The hook only registers on desktop platforms.
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    })
  })

  // ★ The flag must be set BEFORE disconnect(), because disconnect()
  // synchronously flips the store to 'disconnected' — which is exactly what
  // remounts LoginScreen and arms its reload / auto-connect effects. Marking it
  // after the await would be too late to suppress them.
  it('marks shutdown before disconnecting', async () => {
    renderHook(() => useTauriCloseHandler())

    await waitFor(() => expect(shutdownHandler).not.toBeNull())

    // Control: nothing has marked shutdown before the event arrives.
    expect(isShuttingDown()).toBe(false)

    await shutdownHandler!()

    expect(mockDisconnect).toHaveBeenCalled()
    expect(shuttingDownAtDisconnect).toBe(true)
  })

  it('still tears down the proxy and exits after disconnect', async () => {
    renderHook(() => useTauriCloseHandler())

    await waitFor(() => expect(shutdownHandler).not.toBeNull())
    await shutdownHandler!()

    expect(mockInvoke).toHaveBeenCalledWith('stop_xmpp_proxy')
    expect(mockInvoke).toHaveBeenCalledWith('exit_app')
  })
})
