/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { fetchAppearance, setAppearance } = vi.hoisted(() => ({
  fetchAppearance: vi.fn(),
  setAppearance: vi.fn(),
}))

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({ client: { profile: { fetchAppearance, setAppearance } } }),
}))
vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => string) => selector({ status: 'online' }),
}))

import { setPlatformForTesting } from '@/platform'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAppearanceSync } from './useAppearanceSync'

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useAppearanceSync font size', () => {
  let restorePlatform: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    fetchAppearance.mockReset()
    setAppearance.mockReset().mockResolvedValue(undefined)
    useSettingsStore.getState().setThemeMode('dark')
    useSettingsStore.getState().setFontSize(100)
  })

  afterEach(() => {
    restorePlatform()
    vi.useRealTimers()
  })

  it('applies the stored font size on the desktop', async () => {
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    fetchAppearance.mockResolvedValue({ mode: 'dark', fontSize: 125 })

    renderHook(() => useAppearanceSync())
    await flush()

    expect(useSettingsStore.getState().fontSize).toBe(125)
  })

  it('keeps the font size local where text follows the OS size', async () => {
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    fetchAppearance.mockResolvedValue({ mode: 'dark', fontSize: 125 })

    renderHook(() => useAppearanceSync())
    await flush()

    expect(useSettingsStore.getState().fontSize).toBe(100)

    act(() => useSettingsStore.getState().setFontSize(110))
    act(() => vi.advanceTimersByTime(1500))
    expect(setAppearance).not.toHaveBeenCalled()
  })

  it('saves the stored font size unchanged with other appearance changes from iOS', async () => {
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    fetchAppearance.mockResolvedValue({ mode: 'dark', fontSize: 125 })

    renderHook(() => useAppearanceSync())
    await flush()

    act(() => useSettingsStore.getState().setFontSize(110))
    act(() => useSettingsStore.getState().setThemeMode('light'))
    act(() => vi.advanceTimersByTime(1500))

    expect(setAppearance).toHaveBeenCalledWith(expect.objectContaining({ mode: 'light', fontSize: 125 }))
  })
})
