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

import { isTauri } from './tauri'

const RESOURCE_KEY = 'xmpp-resource'

/**
 * Generates a random resource identifier with the given prefix.
 * Format: "{prefix}-XXXXXX" where X is alphanumeric
 */
function generateResource(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return `${prefix}-${suffix}`
}

/**
 * Gets the XMPP resource for the current client.
 *
 * - For Tauri: Returns a persistent random resource stored in localStorage
 * - For Web: Returns a unique-per-tab resource stored in sessionStorage
 */
export function getResource(): string {
  if (isTauri()) {
    // Desktop: Use persistent random resource (survives app restarts)
    let resource = localStorage.getItem(RESOURCE_KEY)
    if (!resource) {
      resource = generateResource('desktop')
      localStorage.setItem(RESOURCE_KEY, resource)
    }
    return resource
  } else {
    // Web: Use per-tab resource (survives page reload, unique per tab)
    let resource = sessionStorage.getItem(RESOURCE_KEY)
    if (!resource) {
      resource = generateResource('web')
      sessionStorage.setItem(RESOURCE_KEY, resource)
    }
    return resource
  }
}
