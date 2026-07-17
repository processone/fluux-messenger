import { isTauri } from './tauri'

/**
 * Best-effort request for persistent storage on the web/PWA build.
 *
 * The service worker runtime-caches cross-origin media in the 'fluux-media'
 * cache (see sw.ts / utils/mediaCache.ts). Chromium pads opaque responses
 * heavily in quota accounting (~7 MB apiece), so under storage pressure the
 * browser could evict the entire origin — including the IndexedDB that will
 * hold OMEMO device identity (see docs/2026-07-16-e2ee-device-identity-design.md).
 * Marking storage as persistent exempts the origin from best-effort eviction.
 *
 * No-op under Tauri (desktop storage is not subject to browser eviction) and on
 * browsers without the Storage API. Never throws; returns whether storage is
 * persistent after the call.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (isTauri()) return false

  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
  if (!storage || typeof storage.persist !== 'function') return false

  try {
    // Already persistent (granted in a previous session) — nothing to request.
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      return true
    }
    return await storage.persist()
  } catch {
    return false
  }
}
