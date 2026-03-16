/**
 * XEP-0115: Entity Capabilities
 *
 * Provides capability advertisement so servers know what features
 * this client supports (e.g., PEP notifications for avatars).
 */

import {
  NS_CHATSTATES,
  NS_DISCO_INFO,
  NS_AVATAR_METADATA_NOTIFY,
  NS_BOOKMARKS_NOTIFY,
  NS_CARBONS,
  NS_IDLE,
  NS_PING,
  NS_REACTIONS,
  NS_TIME,
  NS_REPLY,
  NS_STYLING,
  NS_VCARD_UPDATE,
} from './namespaces'
import {
  getCachedPlatform,
  getCapsNodeForPlatform,
  getClientNameForPlatform,
} from './platform'

// Client identity type based on platform
export interface ClientIdentity {
  category: 'client'
  type: 'web' | 'pc' | 'phone'
  name: string
}

/**
 * Get client identity for the current platform.
 * Falls back to 'web' if platform not yet detected.
 */
export function getClientIdentity(): ClientIdentity {
  const platform = getCachedPlatform() || 'web'
  return {
    category: 'client',
    type: platform === 'mobile' ? 'phone' : platform === 'desktop' ? 'pc' : 'web',
    name: getClientNameForPlatform(platform),
  }
}

/**
 * Get caps node URL for the current platform.
 * Falls back to web if platform not yet detected.
 */
export function getCapsNode(): string {
  const platform = getCachedPlatform() || 'web'
  return getCapsNodeForPlatform(platform)
}

// Features this client supports (will be sorted for hash calculation)
export const CLIENT_FEATURES = [
  NS_CHATSTATES,            // XEP-0085 Chat States
  NS_DISCO_INFO,            // XEP-0030 Service Discovery
  NS_AVATAR_METADATA_NOTIFY, // XEP-0084 PEP notify (avatars)
  NS_BOOKMARKS_NOTIFY,      // XEP-0402 PEP notify (bookmarks)
  NS_CARBONS,               // XEP-0280 Message Carbons
  NS_IDLE,                  // XEP-0319 Last User Interaction
  NS_PING,                  // XEP-0199 XMPP Ping
  NS_TIME,                  // XEP-0202 Entity Time
  NS_REACTIONS,             // XEP-0444 Message Reactions
  NS_REPLY,                 // XEP-0461 Message Replies
  NS_STYLING,               // XEP-0393 Message Styling
  NS_VCARD_UPDATE,          // XEP-0153 vCard avatar updates
]

/**
 * Calculate the verification string per XEP-0115 Section 5.1
 *
 * Format:
 * 1. For each identity: category/type/xml:lang/name<
 * 2. For each feature: feature<
 * All sorted and concatenated
 */
export function calculateVerificationString(): string {
  // Use platform-specific identity
  const identity = getClientIdentity()

  // Identity format: category/type/lang/name<
  // We don't specify xml:lang, so it's empty between the slashes
  const identityStr = `${identity.category}/${identity.type}//${identity.name}<`

  // Features must be sorted alphabetically
  const sortedFeatures = [...CLIENT_FEATURES].sort()
  const featuresStr = sortedFeatures.map(f => `${f}<`).join('')

  return identityStr + featuresStr
}

/**
 * Calculate the SHA-1 hash of the verification string and base64 encode it
 * This is the 'ver' attribute used in the <c/> element
 */
export async function calculateCapsHash(): Promise<string> {
  const verString = calculateVerificationString()
  const encoder = new TextEncoder()
  const data = encoder.encode(verString)

  // Use Web Crypto API for SHA-1
  const hashBuffer = await crypto.subtle.digest('SHA-1', data)
  const hashArray = new Uint8Array(hashBuffer)

  // Convert to base64
  return btoa(String.fromCharCode(...hashArray))
}
