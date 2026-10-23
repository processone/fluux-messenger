import { afterEach, describe, expect, it, vi } from 'vitest'
import updaterInitialization from '../../src-tauri/src/prototype-updater-init.js?raw'
import communicationInitialization from '../../src-tauri/src/communication-prototype-init.js?raw'
import { platform, resetPlatformDetection, communicationPrototypeAvailable } from './index'

// FLM-110 F3: execute the exact scripts included by the native builder, not a test-authored flag.
describe('native prototype initialization scripts', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetPlatformDetection() })

  it('protects updates and enables communication only after the host initialization scripts execute', () => {
    const hostWindow = { __TAURI_INTERNALS__: {}, __TAURI_OS_PLUGIN_INTERNALS__: { platform: 'macos' } }
    vi.stubGlobal('window', hostWindow)
    resetPlatformDetection()
    expect(platform().hasInAppUpdates).toBe(true)
    expect(communicationPrototypeAvailable()).toBe(false)

    new Function('window', updaterInitialization)(hostWindow)
    resetPlatformDetection()
    expect(platform().hasInAppUpdates).toBe(false)
    expect(communicationPrototypeAvailable()).toBe(false)
    expect(Object.getOwnPropertyDescriptor(hostWindow, '__FLUUX_DISABLE_UPDATER__')).toMatchObject({
      value: true, writable: false, configurable: false,
    })

    new Function('window', communicationInitialization)(hostWindow)
    expect(communicationPrototypeAvailable()).toBe(true)
    expect(Object.getOwnPropertyDescriptor(hostWindow, '__FLUUX_COMMUNICATION_PROTOTYPE__')).toMatchObject({
      value: true, writable: false, configurable: false,
    })
    expect(Reflect.set(hostWindow, '__FLUUX_DISABLE_UPDATER__', false)).toBe(false)
    expect(Reflect.set(hostWindow, '__FLUUX_COMMUNICATION_PROTOTYPE__', false)).toBe(false)
  })
})
