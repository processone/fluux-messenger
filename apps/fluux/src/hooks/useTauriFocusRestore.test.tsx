import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import tauriCapabilities from '../../src-tauri/capabilities/default.json'

// Capture what the hook subscribes to and the handler it registers.
const listened: Array<{ name: string; cb: () => void | Promise<void> }> = []
const unlisten = vi.fn()
const setFocus = vi.fn<() => Promise<void>>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: () => void | Promise<void>) => {
    listened.push({ name, cb })
    return Promise.resolve(unlisten)
  },
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setFocus }),
}))

import { useTauriFocusRestore } from './useTauriFocusRestore'

const setPlatform = (value: string) => {
  Object.defineProperty(window.navigator, 'platform', {
    value,
    configurable: true,
  })
}

// Let the hook's async setup() (dynamic imports + listen) settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('useTauriFocusRestore', () => {
  beforeEach(() => {
    listened.length = 0
    unlisten.mockClear()
    setFocus.mockReset()
    setFocus.mockResolvedValue()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('listens for window-focus-restore on Windows and grabs webview focus', async () => {
    setPlatform('Win32')
    renderHook(() => useTauriFocusRestore())
    await flush()

    expect(listened).toHaveLength(1)
    expect(listened[0].name).toBe('window-focus-restore')

    await listened[0].cb()
    expect(setFocus).toHaveBeenCalledTimes(1)
  })

  it('allows the native webview focus command in the Tauri capability', () => {
    expect(tauriCapabilities.permissions).toContain('core:webview:allow-set-webview-focus')
  })

  it('logs native focus failures before falling back to window focus', async () => {
    setPlatform('Win32')
    setFocus.mockRejectedValueOnce(new Error('webview focus denied'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})

    renderHook(() => useTauriFocusRestore())
    await flush()
    await listened[0].cb()

    expect(warn).toHaveBeenCalledWith(
      '[FocusRestore] Failed to focus native webview:',
      expect.any(Error),
    )
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('listens for tray-restore-focus on Linux', async () => {
    setPlatform('Linux x86_64')
    renderHook(() => useTauriFocusRestore())
    await flush()

    expect(listened).toHaveLength(1)
    expect(listened[0].name).toBe('tray-restore-focus')
  })

  it('is a no-op on macOS', async () => {
    setPlatform('MacIntel')
    renderHook(() => useTauriFocusRestore())
    await flush()

    expect(listened).toHaveLength(0)
  })

  it('unsubscribes on unmount', async () => {
    setPlatform('Win32')
    const { unmount } = renderHook(() => useTauriFocusRestore())
    await flush()

    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
