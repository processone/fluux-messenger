import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMobileDevice, setPlatformForTesting } from './index'

const WINDOWS_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.8154.6 Safari/537.36 Edg/159.0.8154.6'
const ANDROID_BROWSER = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.8154.6 Mobile Safari/537.36'

// Viewer defaults follow host/device identity, not the pointer or the viewport.
describe('isMobileDevice', () => {
  let restore: () => void
  afterEach(() => {
    restore()
    vi.unstubAllGlobals()
  })

  it.each(['ios', 'android'] as const)('trusts the native %s shell even with a desktop browser identity', os => {
    restore = setPlatformForTesting({ shell: 'mobile', os })
    vi.stubGlobal('navigator', { userAgent: WINDOWS_BROWSER, platform: 'Win32', maxTouchPoints: 0 })
    expect(isMobileDevice()).toBe(true)
  })

  it('does not classify a native desktop shell as mobile from its user agent', () => {
    restore = setPlatformForTesting({ shell: 'desktop', os: 'linux' })
    vi.stubGlobal('navigator', { userAgent: ANDROID_BROWSER, platform: 'Linux armv81', maxTouchPoints: 5 })
    expect(isMobileDevice()).toBe(false)
  })

  it('recognizes an Android browser whose OS family is Linux', () => {
    restore = setPlatformForTesting({ shell: 'web', os: 'linux' })
    vi.stubGlobal('navigator', { userAgent: ANDROID_BROWSER, platform: 'Linux armv81', maxTouchPoints: 5 })
    expect(isMobileDevice()).toBe(true)
  })

  it('does not classify a touch-first Windows browser as mobile', () => {
    restore = setPlatformForTesting({ shell: 'web', os: 'windows' })
    vi.stubGlobal('navigator', { userAgent: WINDOWS_BROWSER, platform: 'Win32', maxTouchPoints: 10 })
    expect(isMobileDevice()).toBe(false)
  })
})
