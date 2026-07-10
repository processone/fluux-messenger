import { describe, it, expect, vi, beforeEach } from 'vitest'

const openMock = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }))

describe('openInBrowser', () => {
  beforeEach(() => {
    vi.resetModules()
    openMock.mockReset()
  })

  it('uses window.open on web', async () => {
    vi.doMock('./tauri', () => ({ isTauri: () => false }))
    const winOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { openInBrowser } = await import('./openInBrowser')
    await openInBrowser('https://example.com')
    expect(winOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(openMock).not.toHaveBeenCalled()
  })

  it('uses the Tauri shell open on desktop', async () => {
    vi.doMock('./tauri', () => ({ isTauri: () => true }))
    const { openInBrowser } = await import('./openInBrowser')
    await openInBrowser('https://example.com')
    expect(openMock).toHaveBeenCalledWith('https://example.com')
  })
})
