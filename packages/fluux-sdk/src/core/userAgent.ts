/**
 * SASL2 User Agent (XEP-0388 §2.2)
 *
 * Builds the `<user-agent/>` element included in `<authenticate/>`.
 * The `id` attribute is a stable per-device UUIDv4 kept in localStorage;
 * FAST (XEP-0484) binds issued tokens to this id, so it MUST be stable
 * across sessions for token reuse to work.
 *
 * The `<device/>` label is human-readable and shown in other clients'
 * connected-devices lists. It defaults to a platform-derived name
 * ("Fluux Desktop" / "Fluux Web" / "Fluux Mobile") but the user can
 * override it via `setUserAgentDeviceName()` (typically wired to a
 * settings field).
 *
 * @see https://xmpp.org/extensions/xep-0388.html#initiation
 */

import { xml, Element } from '@xmpp/client'
import { generateUUID } from '../utils/uuid'
import { getCachedPlatform, type Platform } from './platform'

const STORAGE_KEY_ID = 'fluux:user-agent-id'
const STORAGE_KEY_DEVICE = 'fluux:user-agent-device'

/**
 * Get the persistent user-agent id for this installation,
 * generating one on first use.
 */
export function getOrCreateUserAgentId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY_ID)
    if (existing) return existing
    const id = generateUUID()
    localStorage.setItem(STORAGE_KEY_ID, id)
    return id
  } catch {
    // localStorage unavailable (SSR, private mode with quota=0, etc.)
    // Return a fresh UUID; token persistence won't work but auth will.
    return generateUUID()
  }
}

/**
 * Read the current user-agent id without creating one.
 * Returns null if no id has been generated yet.
 */
export function getUserAgentId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_ID)
  } catch {
    return null
  }
}

/**
 * Clear the persisted user-agent id and device-name override.
 *
 * The next call to `buildUserAgentElement()` will generate a fresh id,
 * which invalidates any FAST tokens the server has issued against the
 * previous id. Use for "sign out of all devices" / full local-data wipes;
 * do NOT call on a per-account logout where the user stays on the same
 * browser and may reconnect.
 */
export function clearUserAgentIdentity(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_ID)
    localStorage.removeItem(STORAGE_KEY_DEVICE)
  } catch {
    // localStorage unavailable — nothing to clear.
  }
}

function defaultDeviceName(platform: Platform | null): string {
  switch (platform) {
    case 'mobile':
      return 'Fluux Mobile'
    case 'desktop':
      return 'Fluux Desktop'
    case 'web':
    default:
      return 'Fluux Web'
  }
}

/**
 * Read a user-supplied device name override, or null if none is set.
 * Callers should prefer `getEffectiveDeviceName()` unless they need to
 * distinguish "user override" from "platform default".
 */
export function getUserAgentDeviceName(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DEVICE)
    if (!raw) return null
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * Set or clear the user-supplied device name. Pass null/empty to
 * revert to the platform default.
 */
export function setUserAgentDeviceName(name: string | null): void {
  try {
    if (name && name.trim().length > 0) {
      localStorage.setItem(STORAGE_KEY_DEVICE, name.trim())
    } else {
      localStorage.removeItem(STORAGE_KEY_DEVICE)
    }
  } catch {
    // localStorage unavailable — silently ignore; auth still works with default.
  }
}

/**
 * The device name that will be sent in `<device/>`: user override if set,
 * otherwise the platform-derived default ("Fluux Desktop" / "Fluux Web" /
 * "Fluux Mobile").
 */
export function getEffectiveDeviceName(): string {
  return getUserAgentDeviceName() ?? defaultDeviceName(getCachedPlatform())
}

/**
 * Build the SASL2 `<user-agent/>` element.
 * Pass the returned element as the third argument of xmpp.js's
 * `authenticate(credentials, mechanism, userAgent)` callback.
 */
export function buildUserAgentElement(): Element {
  return xml('user-agent', { id: getOrCreateUserAgentId() }, [
    xml('software', {}, 'Fluux'),
    xml('device', {}, getEffectiveDeviceName()),
  ])
}
