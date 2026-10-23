import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPlatformDetection } from '@/platform'
import { getVisibleCategories } from '@/components/settings-components/types'
import { useAutoUpdate } from './useAutoUpdate'

const { check, install, relaunch } = vi.hoisted(() => ({
  check: vi.fn(), install: vi.fn(), relaunch: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-updater', () => ({ check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }))

// Source: the captain's I2 choice disables checking and installation for the explicit standard-identity test mode only.
// This exercises the native initialization marker through the real capability detection and consumers.
describe('communication test updater isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    vi.stubGlobal('__TAURI_OS_PLUGIN_INTERNALS__', { platform: 'macos' })
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    check.mockReset().mockResolvedValue({ version: '0.18.0', body: 'Fluux Messenger 0.18.0', downloadAndInstall: install })
    install.mockReset().mockResolvedValue(undefined)
    relaunch.mockReset().mockResolvedValue(undefined)
    resetPlatformDetection()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetPlatformDetection()
  })

  it('blocks automatic/manual checks, installation and update prompts for the native test-mode marker', async () => {
    vi.stubGlobal('__FLUUX_DISABLE_UPDATER__', true)
    const { result } = renderHook(() => useAutoUpdate({ autoCheck: true }))
    expect(result.current.updaterEnabled).toBe(false)
    expect(getVisibleCategories().map(category => category.id)).not.toContain('updates')
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
      await result.current.checkForUpdate()
      await result.current.downloadAndInstall()
      await result.current.relaunchApp()
    })
    expect(check).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
    expect(result.current.available).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('preserves automatic checks and manual installation for normal desktop identities', async () => {
    const { result } = renderHook(() => useAutoUpdate({ autoCheck: true }))
    expect(result.current.updaterEnabled).toBe(true)
    expect(getVisibleCategories().map(category => category.id)).toContain('updates')
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(check).toHaveBeenCalledOnce()
    expect(result.current.available).toBe(true)
    await act(async () => { await result.current.checkForUpdate() })
    expect(check).toHaveBeenCalledTimes(2)
    await act(async () => { await result.current.downloadAndInstall() })
    expect(install).toHaveBeenCalledOnce()
    await act(async () => { await result.current.relaunchApp() })
    expect(relaunch).toHaveBeenCalledOnce()
  })
})
