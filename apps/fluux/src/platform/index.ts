/**
 * The platform this build is running on, detected once.
 *
 * Detection reads globals, so it happens here and nowhere else. Everything
 * downstream takes the resulting {@link PlatformCapabilities} record, which
 * makes a call site's platform assumption visible in its code and lets a test
 * state one directly instead of impersonating a host.
 *
 * @packageDocumentation
 * @module Platform
 */

import { platform as nativePlatform } from '@tauri-apps/plugin-os'
import {
  deriveCapabilities,
  type PlatformCapabilities,
  type PlatformOS,
  type PlatformShell,
} from './capabilities'

export {
  deriveCapabilities,
  type PlatformCapabilities,
  type PlatformOS,
  type PlatformShell,
} from './capabilities'

/**
 * Tauri injects `__TAURI_INTERNALS__` into the webview before any app code
 * runs, which is the only signal available synchronously at module scope.
 */
function detectShell(): PlatformShell {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return 'web'
  // plugin-os injects its compile-time platform synchronously, including on
  // iPads whose user agent reports macOS. Old desktop shells may lack it.
  try {
    const os = nativePlatform()
    if (os === 'ios' || os === 'android') return 'mobile'
  } catch {
    // Preserve desktop detection when the plugin is unavailable.
  }
  return 'desktop'
}

/**
 * Sniffs `navigator`, matching the substrings the app has always matched so
 * the capabilities derived from the OS keep their current answers exactly.
 *
 * Native mobile hosts are detected independently of the user agent by plugin-os.
 */
export function detectOS(): PlatformOS {
  if (typeof navigator === 'undefined') return 'other'
  const haystack = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
  // Linux is tested first so an ambiguous string resolves to the conservative
  // answer: `hasInAppUpdates` is the capability that turns on Linux's absence,
  // and shipping a self-updater into a distro-managed install is the costly
  // direction to get wrong. No real host matches two of these.
  if (haystack.includes('linux')) return 'linux'
  if (haystack.includes('win')) return 'windows'
  if (haystack.includes('mac')) return 'macos'
  return 'other'
}

let current: PlatformCapabilities | null = null

/**
 * The current platform.
 *
 * Detected on first call and cached: the host cannot change under a running
 * app, and several callers read this at module scope.
 */
export function platform(): PlatformCapabilities {
  if (!current) {
    const shell = detectShell()
    const os = shell === 'mobile'
      ? (nativePlatform() === 'android' ? 'android' : 'ios')
      : detectOS()
    current = deriveCapabilities(shell, os)
  }
  return current
}

/**
 * Override the platform for a test, and restore it afterwards.
 *
 * Prefer this to mocking the module: it exercises the real capability
 * derivation, so a test cannot describe a platform that could not exist.
 *
 * @example
 * ```ts
 * const restore = setPlatformForTesting({ shell: 'desktop', os: 'windows' })
 * afterEach(restore)
 * ```
 */
export function setPlatformForTesting(
  host: { shell: PlatformShell; os?: PlatformOS } | PlatformCapabilities
): () => void {
  const previous = current
  current = 'nativeKeychain' in host ? host : deriveCapabilities(host.shell, host.os ?? 'other')
  return () => {
    current = previous
  }
}

/** Forget the cached detection so the next {@link platform} call re-runs it. */
export function resetPlatformDetection(): void {
  current = null
}
