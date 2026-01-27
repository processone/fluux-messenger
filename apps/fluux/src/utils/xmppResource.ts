/**
 * XMPP Resource Management
 *
 * The resource is the third part of a JID (user@domain/resource).
 * It identifies a specific client connection.
 *
 * - Desktop (Tauri): Generate a random resource on first launch and persist it.
 *   This allows the desktop app to maintain its own session.
 *
 * - Web: Use a fixed resource ("web") so that opening the app in a new tab
 *   kicks the existing connection. This prevents multiple web sessions.
 */

import { isTauri } from './tauri'

const RESOURCE_KEY = 'xmpp-resource'

/**
 * Generates a random resource identifier.
 * Format: "desktop-XXXXXX" where X is alphanumeric
 */
function generateResource(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return `desktop-${suffix}`
}

/**
 * Gets the XMPP resource for the current client.
 *
 * - For Tauri: Returns a persistent random resource (generated on first launch)
 * - For Web: Returns "web" (fixed resource to kick existing sessions)
 */
export function getResource(): string {
  if (isTauri()) {
    // Desktop: Use persistent random resource
    let resource = localStorage.getItem(RESOURCE_KEY)
    if (!resource) {
      resource = generateResource()
      localStorage.setItem(RESOURCE_KEY, resource)
    }
    return resource
  } else {
    // Web: Fixed resource - new tabs kick existing connections
    return 'web'
  }
}
