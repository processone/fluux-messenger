import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { setPlatformForTesting, type PlatformOS, type PlatformShell } from './index'
import { detectWindowChrome, setCustomWindowChromeForTesting, useCustomWindowChrome } from './windowChrome'

const isDecorated = vi.fn<() => Promise<boolean>>()
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isDecorated }),
}))

describe('window chrome detection', () => {
  let restorePlatform: (() => void) | undefined
  let restoreChrome: (() => void) | undefined

  function host(shell: PlatformShell, os: PlatformOS) {
    restorePlatform = setPlatformForTesting({ shell, os })
  }

  beforeEach(() => {
    isDecorated.mockReset()
    // Every case starts from, and is restored to, native chrome.
    restoreChrome = setCustomWindowChromeForTesting(false)
  })

  afterEach(() => {
    restoreChrome?.()
    restorePlatform?.()
    restorePlatform = undefined
  })

  it('reports custom chrome once a Windows window says it has no native frame', async () => {
    host('desktop', 'windows')
    isDecorated.mockResolvedValue(false)
    const { result } = renderHook(() => useCustomWindowChrome())
    expect(result.current).toBe(false)

    await act(() => detectWindowChrome())

    expect(result.current).toBe(true)
    expect(document.documentElement.dataset.windowChrome).toBe('custom')
  })

  it('stays native when the Windows window still has its frame', async () => {
    host('desktop', 'windows')
    isDecorated.mockResolvedValue(true)
    const { result } = renderHook(() => useCustomWindowChrome())

    await act(() => detectWindowChrome())

    expect(result.current).toBe(false)
    expect(document.documentElement.dataset.windowChrome).toBeUndefined()
  })

  it('stays native when the window cannot be asked', async () => {
    host('desktop', 'windows')
    isDecorated.mockRejectedValue(new Error('not allowed'))
    const { result } = renderHook(() => useCustomWindowChrome())

    await act(() => detectWindowChrome())

    expect(result.current).toBe(false)
  })

  it.each([
    ['desktop', 'macos'],
    ['desktop', 'linux'],
    ['web', 'windows'],
  ] as const)('never asks on %s %s, even if the window would report no frame', async (shell, os) => {
    host(shell, os)
    isDecorated.mockResolvedValue(false)
    const { result } = renderHook(() => useCustomWindowChrome())

    await act(() => detectWindowChrome())

    expect(isDecorated).not.toHaveBeenCalled()
    expect(result.current).toBe(false)
  })
})
