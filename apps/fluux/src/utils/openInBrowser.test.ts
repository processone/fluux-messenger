import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setPlatformForTesting } from '@/platform'

const openMock = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }))

describe('openInBrowser', () => {
  let restorePlatform: (() => void) | undefined

  beforeEach(() => {
    openMock.mockReset()
  })

  afterEach(() => {
    restorePlatform?.()
  })

  it('uses window.open on web', async () => {
    restorePlatform = setPlatformForTesting({ shell: 'web' })
    const winOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { openInBrowser } = await import('./openInBrowser')
    await openInBrowser('https://example.com')
    expect(winOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(openMock).not.toHaveBeenCalled()
  })

  it('uses the Tauri shell open on desktop', async () => {
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    const { openInBrowser } = await import('./openInBrowser')
    await openInBrowser('https://example.com')
    expect(openMock).toHaveBeenCalledWith('https://example.com')
  })
})
