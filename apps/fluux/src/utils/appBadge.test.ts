import { describe, it, expect, vi, afterEach } from 'vitest'
import { setWebAppBadge } from './appBadge'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setWebAppBadge', () => {
  it('sets the badge for positive counts', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined)
    const clearAppBadge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })
    await setWebAppBadge(3)
    expect(setAppBadge).toHaveBeenCalledWith(3)
    expect(clearAppBadge).not.toHaveBeenCalled()
  })

  it('clears the badge at zero', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined)
    const clearAppBadge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })
    await setWebAppBadge(0)
    expect(clearAppBadge).toHaveBeenCalled()
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  it('no-ops when the Badging API is missing', async () => {
    vi.stubGlobal('navigator', {})
    await expect(setWebAppBadge(2)).resolves.toBeUndefined()
  })

  it('swallows rejections (unsupported platforms)', async () => {
    vi.stubGlobal('navigator', {
      setAppBadge: vi.fn().mockRejectedValue(new Error('nope')),
    })
    await expect(setWebAppBadge(2)).resolves.toBeUndefined()
  })
})
