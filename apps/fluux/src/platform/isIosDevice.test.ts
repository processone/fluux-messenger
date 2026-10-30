import { afterEach, describe, expect, it, vi } from 'vitest'
import { isIosDevice, setPlatformForTesting } from './index'

// FLM-278: keyboard dismissal is limited to iPhone and iPad, in the app and in Safari.
describe('isIosDevice', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is true in the native iOS app whatever the user agent says', () => {
    const restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 })
    expect(isIosDevice()).toBe(true)
    restore()
  })

  it('is false in the native Android app even though the web view has touch', () => {
    const restore = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux armv81', maxTouchPoints: 5 })
    expect(isIosDevice()).toBe(false)
    restore()
  })

  it.each([
    ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5, true],
    ['iPad Safari with a Mac user agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5, true],
    ['a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0, false],
    ['a touchscreen Windows computer', 'Mozilla/5.0 (Windows NT 10.0)', 'Win32', 10, false],
  ])('in a browser: %s', (_name, userAgent, platformName, maxTouchPoints, expected) => {
    const restore = setPlatformForTesting({ shell: 'web' })
    vi.stubGlobal('navigator', { userAgent, platform: platformName, maxTouchPoints })
    expect(isIosDevice()).toBe(expected)
    restore()
  })
})
