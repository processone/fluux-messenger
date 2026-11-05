import { afterEach, describe, expect, it, vi } from 'vitest'
import communicationInitialization from '../../src-tauri/src/communication-init.js?raw'
import { platform, resetPlatformDetection, communicationAvailable } from './index'

// #1386: execute the exact scripts included by the native builder, not a test-authored flag.
describe('native communication initialization scripts', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetPlatformDetection() })

  it('keeps updates and enables communication only after the host initialization scripts execute', () => {
    const hostWindow = { __TAURI_INTERNALS__: {}, __TAURI_OS_PLUGIN_INTERNALS__: { platform: 'macos' } }
    vi.stubGlobal('window', hostWindow)
    // The OS is sniffed from navigator, so the fixture must not inherit the CI runner's Linux user agent.
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    resetPlatformDetection()
    expect(platform().hasInAppUpdates).toBe(true)
    expect(communicationAvailable()).toBe(false)

    new Function('window', communicationInitialization)(hostWindow)
    resetPlatformDetection()
    expect(platform().hasInAppUpdates).toBe(true)
    expect(communicationAvailable()).toBe(true)
    expect(Object.getOwnPropertyDescriptor(hostWindow, '__FLUUX_COMMUNICATION__')).toMatchObject({
      value: true, writable: false, configurable: false,
    })
    expect(Reflect.set(hostWindow, '__FLUUX_COMMUNICATION__', false)).toBe(false)
  })
})
