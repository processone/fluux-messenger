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
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'desktop' : 'web'
}

/**
 * Sniffs `navigator`, matching the substrings the app has always matched so
 * the capabilities derived from the OS keep their current answers exactly.
 *
 * Android reports `Linux` in its user agent and lands on `'linux'` here, as it
 * always has. Telling a phone from a desktop needs the Tauri OS plugin, which
 * only answers asynchronously — see `utils/tauriPlatform.ts`. Do not add a
 * `'mobile'` member here until this can resolve one.
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
  current ??= deriveCapabilities(detectShell(), detectOS())
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
