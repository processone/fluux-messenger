/**
 * XMPP Resource Management
 *
 * The resource is the third part of a JID (user@domain/resource).
 * It identifies a specific client connection.
 *
 * - Native (Tauri desktop/mobile): Generate a random resource on first launch and persist it
 *   in localStorage. This allows the native app to maintain its own session
 *   across restarts.
 *
 * - Web: Generate a unique resource per tab/window and persist it in
 *   sessionStorage. This allows multiple browser tabs to connect simultaneously
 *   as independent clients, while a page reload reconnects with the same resource.
 */

import { platform } from '@/platform'
import { platform as nativePlatform } from '@tauri-apps/plugin-os'

const RESOURCE_KEY = 'xmpp-resource'

/**
 * Generates a branded resource: "fluux-{w|d|m}XXXXX", with five random
 * lowercase alphanumeric characters after the platform letter.
 */
export function generateResource(clientPlatform: 'web' | 'desktop' | 'mobile'): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 5; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return `fluux-${clientPlatform[0]}${suffix}`
}

/**
 * Accepts branded resources and legacy random resources so a reload can resume
 * the same session. Bare prefixes lack a unique suffix and must be replaced.
 */
export function isValidResource(resource: string): boolean {
  return /^fluux-[wdm][a-z0-9]{5}$/.test(resource)
    || /^(web|desktop)-[a-z0-9]{6}$/.test(resource)
}

function getNativeResourcePlatform(): 'desktop' | 'mobile' {
  try {
    const os = nativePlatform()
    return os === 'ios' || os === 'android' ? 'mobile' : 'desktop'
  } catch {
    // Match the SDK's desktop fallback when the native OS plugin is unavailable.
    return 'desktop'
  }
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
    // Native: Use persistent random resource (survives app restarts)
    let resource = localStorage.getItem(RESOURCE_KEY)
    if (!resource || !isValidResource(resource)) {
      resource = generateResource(getNativeResourcePlatform())
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
