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

// #1386: released communication-enabled builds keep the updater and Updates settings.
describe('communication-enabled updater', () => {
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

  it.each([true, undefined])('retains Updates, checks and installation with communication marker %s', async (marker) => {
    vi.stubGlobal('__FLUUX_COMMUNICATION__', marker)
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
