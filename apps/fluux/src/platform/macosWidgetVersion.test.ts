import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveCapabilities, platform, resetPlatformDetection } from './index'

// Accepted widget plan: only macOS 14+ can host the desktop widget. Review W4 requires
// older and unknown native versions to stay silent before heartbeat or avatar work starts.
describe('macOS widget version boundary', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetPlatformDetection() })

  it.each([
    ['10.13.6', false], ['11.7.10', false], ['12.7.6', false], ['13.7.8', false],
    ['14.0', true], ['15.0', true], ['27.2.0', true], ['', false], ['unknown', false],
  ])('derives widget support from native macOS %s', (version, expected) => {
    expect(deriveCapabilities('desktop', 'macos', version).publishesUnreadWidget).toBe(expected)
  })

  it.each(['13.7.8', '14.0', undefined])('uses plugin metadata rather than the Mac user agent for version %s', (version) => {
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    vi.stubGlobal('__TAURI_OS_PLUGIN_INTERNALS__', { platform: 'macos', version })
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' })
    resetPlatformDetection()
    expect(platform().publishesUnreadWidget).toBe(version === '14.0')
  })
})
