import { afterEach, describe, expect, it } from 'vitest'
import { isLinux, isWindows } from './tauri'

const realPlatform = navigator.platform
const realUserAgent = navigator.userAgent

function setNavigator(platform: string, userAgent: string): void {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform })
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

describe('desktop platform detection', () => {
  afterEach(() => setNavigator(realPlatform, realUserAgent))

  it('detects Windows', () => {
    setNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0)')
    expect(isWindows()).toBe(true)
    expect(isLinux()).toBe(false)
  })

  it('detects Linux', () => {
    setNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    expect(isLinux()).toBe(true)
    expect(isWindows()).toBe(false)
  })
})
