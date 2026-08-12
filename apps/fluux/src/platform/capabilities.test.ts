import { describe, it, expect, afterEach } from 'vitest'
import { deriveCapabilities, type PlatformCapabilities } from './capabilities'
import { platform, setPlatformForTesting, resetPlatformDetection } from './index'

describe('deriveCapabilities', () => {
  it('grants no native capability on the web, whatever the OS', () => {
    for (const os of ['macos', 'windows', 'linux', 'other'] as const) {
      const web = deriveCapabilities('web', os)
      const granted = Object.entries(web)
        .filter(([key, value]) => value === true && key !== 'shell' && key !== 'os')
        .map(([key]) => key)
      expect(granted, `web/${os}`).toEqual([])
    }
  })

  it('reserves taskbar attention for desktop Windows', () => {
    expect(deriveCapabilities('desktop', 'windows').canRequestWindowAttention).toBe(true)
    expect(deriveCapabilities('desktop', 'macos').canRequestWindowAttention).toBe(false)
    expect(deriveCapabilities('desktop', 'linux').canRequestWindowAttention).toBe(false)
    expect(deriveCapabilities('web', 'windows').canRequestWindowAttention).toBe(false)
  })

  it('offers the tray preference on desktop Windows and Linux only', () => {
    expect(deriveCapabilities('desktop', 'windows').canKeepInSystemTray).toBe(true)
    expect(deriveCapabilities('desktop', 'linux').canKeepInSystemTray).toBe(true)
    // macOS hides the window on close; there is nothing to configure.
    expect(deriveCapabilities('desktop', 'macos').canKeepInSystemTray).toBe(false)
  })

  it('withholds in-app updates from Linux, which updates through its distro', () => {
    expect(deriveCapabilities('desktop', 'macos').hasInAppUpdates).toBe(true)
    expect(deriveCapabilities('desktop', 'windows').hasInAppUpdates).toBe(true)
    expect(deriveCapabilities('desktop', 'linux').hasInAppUpdates).toBe(false)
    expect(deriveCapabilities('web', 'macos').hasInAppUpdates).toBe(false)
  })

  it('treats every capability as a boolean the caller can read', () => {
    const desktop = deriveCapabilities('desktop', 'macos')
    for (const [key, value] of Object.entries(desktop)) {
      if (key === 'shell' || key === 'os') continue
      expect(typeof value, key).toBe('boolean')
    }
  })
})

describe('platform override', () => {
  afterEach(() => {
    resetPlatformDetection()
  })

  it('serves the override, then restores what was there before', () => {
    const before = platform()
    const restore = setPlatformForTesting({ shell: 'desktop', os: 'linux' })
    expect(platform().shell).toBe('desktop')
    expect(platform().hasInAppUpdates).toBe(false)
    restore()
    expect(platform()).toEqual(before)
  })

  it('accepts a full record for a host that no derivation produces', () => {
    const impossible: PlatformCapabilities = {
      ...deriveCapabilities('web', 'other'),
      nativeKeychain: true,
    }
    const restore = setPlatformForTesting(impossible)
    expect(platform().shell).toBe('web')
    expect(platform().nativeKeychain).toBe(true)
    restore()
  })
})
