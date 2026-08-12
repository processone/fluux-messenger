import { describe, it, expect, afterEach } from 'vitest'
import { deriveCapabilities, type PlatformCapabilities } from './capabilities'
import { platform, setPlatformForTesting, resetPlatformDetection } from './index'

describe('deriveCapabilities', () => {
  /**
   * The web build's whole manifest, listed rather than counted.
   *
   * A capability added without a thought for the web lands here as a diff, so
   * "it defaults to desktop" cannot pass unnoticed — which is the mistake
   * `isTauri()` made structural.
   */
  const WEB_CAPABILITIES = [
    'keyNeedsSessionPassphrase',
    'needsTabCoordination',
    'usesWebPush',
  ]

  it('grants exactly its own capabilities on the web, whatever the OS', () => {
    for (const os of ['macos', 'windows', 'linux', 'other'] as const) {
      const granted = Object.entries(deriveCapabilities('web', os))
        .filter(([key, value]) => value === true && key !== 'shell' && key !== 'os')
        .map(([key]) => key)
        .sort()
      expect(granted, `web/${os}`).toEqual([...WEB_CAPABILITIES].sort())
    }
  })

  it('gives desktop and web opposite answers on the ones that pair up', () => {
    const desktop = deriveCapabilities('desktop', 'macos')
    const web = deriveCapabilities('web', 'macos')
    for (const key of WEB_CAPABILITIES) {
      expect(web[key as keyof typeof web], `web.${key}`).toBe(true)
      expect(desktop[key as keyof typeof desktop], `desktop.${key}`).toBe(false)
    }
  })

  it('reserves the custom title bar for desktop macOS', () => {
    expect(deriveCapabilities('desktop', 'macos').hasCustomTitleBar).toBe(true)
    // Windows and Linux keep a native title bar; there is nothing to reserve.
    expect(deriveCapabilities('desktop', 'windows').hasCustomTitleBar).toBe(false)
    expect(deriveCapabilities('desktop', 'linux').hasCustomTitleBar).toBe(false)
    expect(deriveCapabilities('web', 'macos').hasCustomTitleBar).toBe(false)
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
