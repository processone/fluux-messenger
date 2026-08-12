/**
 * XMPP Resource Management
 *
 * The resource is the third part of a JID (user@domain/resource).
 * It identifies a specific client connection.
 *
 * - Desktop (Tauri): Generate a random resource on first launch and persist it
 *   in localStorage. This allows the desktop app to maintain its own session
 *   across restarts.
 *
 * - Web: Generate a unique resource per tab/window and persist it in
 *   sessionStorage. This allows multiple browser tabs to connect simultaneously
 *   as independent clients, while a page reload reconnects with the same resource.
 */

import { platform } from '@/platform'

const RESOURCE_KEY = 'xmpp-resource'

/**
 * Generates a random resource identifier with the given prefix.
 * Format: "{prefix}-XXXXXX" where X is alphanumeric
 */
export function generateResource(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return `${prefix}-${suffix}`
}

/**
 * Validates that a stored resource has the expected format: "{prefix}-XXXXXX".
 * Rejects bare prefixes (e.g. "web", "desktop") that predate the random suffix system.
 */
export function isValidResource(resource: string): boolean {
  return /^(web|desktop)-[a-z0-9]{6}$/.test(resource)
}

/**
 * Gets the XMPP resource for the current client.
 *
 * - For Tauri: Returns a persistent random resource stored in localStorage
 * - For Web: Returns a unique-per-tab resource stored in sessionStorage
 *
 * If a stored resource has an invalid format (e.g. a bare "web" or "desktop"
 * from before the random suffix system), it is regenerated.
 */
export function getResource(): string {
  if (platform().hasStableInstallIdentity) {
    // Desktop: Use persistent random resource (survives app restarts)
    let resource = localStorage.getItem(RESOURCE_KEY)
    if (!resource || !isValidResource(resource)) {
      resource = generateResource('desktop')
      localStorage.setItem(RESOURCE_KEY, resource)
    }
    return resource
  } else {
    // Web: Use per-tab resource (survives page reload, unique per tab)
    let resource = sessionStorage.getItem(RESOURCE_KEY)
    if (!resource || !isValidResource(resource)) {
      resource = generateResource('web')
      sessionStorage.setItem(RESOURCE_KEY, resource)
    }
    return resource
  }
}
