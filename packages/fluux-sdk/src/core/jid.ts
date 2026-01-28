/**
 * JID (Jabber ID) Utilities
 *
 * XMPP addresses (JIDs) have the format: local@domain/resource
 * - Bare JID: local@domain (without resource)
 * - Full JID: local@domain/resource (with resource)
 *
 * Examples:
 * - user@example.com (bare JID)
 * - user@example.com/mobile (full JID)
 * - room@conference.example.com/nickname (MUC occupant JID)
 *
 * Note: For full RFC6122-compliant parsing with escaping support,
 * use @xmpp/jid directly. These utilities provide simple, fast
 * string operations for common use cases.
 */

export interface ParsedJid {
  local: string
  domain: string
  resource?: string
  bare: string
  full: string
}

/**
 * Parse a JID into its components
 * @param jid - Full or bare JID string
 * @returns Parsed JID object with all components
 */
export function parseJid(jid: string): ParsedJid {
  if (!jid) {
    return { local: '', domain: '', bare: '', full: '' }
  }

  // Split resource first (everything after first /)
  const slashIndex = jid.indexOf('/')
  const bareJid = slashIndex >= 0 ? jid.substring(0, slashIndex) : jid
  const resource = slashIndex >= 0 ? jid.substring(slashIndex + 1) : undefined

  // Split local and domain
  const atIndex = bareJid.indexOf('@')
  const local = atIndex >= 0 ? bareJid.substring(0, atIndex) : bareJid
  const domain = atIndex >= 0 ? bareJid.substring(atIndex + 1) : ''

  return {
    local,
    domain,
    resource,
    bare: bareJid,
    full: jid,
  }
}

/**
 * Get bare JID (without resource) from a full JID
 * @param fullJid - Full JID (e.g., "user@example.com/mobile")
 * @returns Bare JID (e.g., "user@example.com")
 */
export function getBareJid(fullJid: string): string {
  if (!fullJid) return ''
  const slashIndex = fullJid.indexOf('/')
  return slashIndex >= 0 ? fullJid.substring(0, slashIndex) : fullJid
}

/**
 * Get resource from a full JID
 * @param fullJid - Full JID (e.g., "user@example.com/mobile")
 * @returns Resource string or undefined if no resource
 */
export function getResource(fullJid: string): string | undefined {
  if (!fullJid) return undefined
  const slashIndex = fullJid.indexOf('/')
  return slashIndex >= 0 ? fullJid.substring(slashIndex + 1) : undefined
}

/**
 * Get local part (username) from a JID
 * @param jid - Any JID (e.g., "user@example.com" or "user@example.com/mobile")
 * @returns Local part (e.g., "user")
 */
export function getLocalPart(jid: string): string {
  if (!jid) return ''
  const bareJid = getBareJid(jid)
  const atIndex = bareJid.indexOf('@')
  return atIndex >= 0 ? bareJid.substring(0, atIndex) : bareJid
}

/**
 * Get domain from a JID
 * @param jid - Any JID (e.g., "user@example.com" or "user@example.com/mobile")
 * @returns Domain (e.g., "example.com")
 */
export function getDomain(jid: string): string {
  if (!jid) return ''
  const bareJid = getBareJid(jid)
  const atIndex = bareJid.indexOf('@')
  return atIndex >= 0 ? bareJid.substring(atIndex + 1) : ''
}

/**
 * Split a full JID into bare JID and resource
 * @param fullJid - Full JID (e.g., "room@conf/nickname")
 * @returns Tuple of [bareJid, resource] where resource may be undefined
 */
export function splitFullJid(fullJid: string): [string, string | undefined] {
  const bareJid = getBareJid(fullJid)
  const resource = getResource(fullJid)
  return [bareJid, resource]
}

/**
 * Check if a JID has a resource part
 * @param jid - Any JID string
 * @returns True if the JID contains a resource
 */
export function hasResource(jid: string): boolean {
  return jid?.includes('/') ?? false
}

/**
 * Create a full JID from bare JID and resource
 * @param bareJid - Bare JID (e.g., "user@example.com")
 * @param resource - Resource string (e.g., "mobile")
 * @returns Full JID (e.g., "user@example.com/mobile")
 */
export function createFullJid(bareJid: string, resource: string): string {
  if (!bareJid) return ''
  if (!resource) return bareJid
  return `${bareJid}/${resource}`
}

/**
 * Check if a room JID is a quick chat room
 * Quick chat rooms follow the pattern: quickchat-{username}-{adj}-{noun}-{suffix}@{mucService}
 * @param roomJid - Room JID to check
 * @returns True if this is a quick chat room
 */
export function isQuickChatJid(roomJid: string): boolean {
  if (!roomJid) return false
  const localPart = getLocalPart(roomJid)
  return localPart.startsWith('quickchat-')
}

/**
 * Count unique users from an iterable of occupants by bare JID.
 * Multiple connections from the same user (same bare JID) are counted once.
 * Occupants without a JID are each counted individually.
 *
 * @param occupants - Iterable of objects with optional jid field
 * @returns Number of unique users
 *
 * @example
 * ```typescript
 * const count = getUniqueOccupantCount(room.occupants.values())
 * // 2 connections from alice@example.com + 1 from bob@example.com = 2
 * ```
 */
export function getUniqueOccupantCount(occupants: Iterable<{ jid?: string }>): number {
  const bareJids = new Set<string>()
  let noJidCount = 0
  for (const occupant of occupants) {
    if (occupant.jid) {
      bareJids.add(getBareJid(occupant.jid))
    } else {
      noJidCount++
    }
  }
  return bareJids.size + noJidCount
}

/**
 * Check if a search query matches a JID by username only (not domain).
 * This prevents matching on common domains like "example.com" or "gmail.com".
 *
 * @param jid - The full JID (e.g., "user@example.com")
 * @param query - The search query (case-insensitive)
 * @returns true if the username part contains the query
 *
 * @example
 * ```typescript
 * matchJidUsername('alice@example.com', 'ali') // true
 * matchJidUsername('alice@example.com', 'example') // false (domain not matched)
 * ```
 */
export function matchJidUsername(jid: string, query: string): boolean {
  const username = getLocalPart(jid).toLowerCase()
  return username.includes(query.toLowerCase())
}

/**
 * Check if a search query matches a name or JID username (not domain).
 * Useful for contact/conversation search where you want to match on
 * display name or username, but not on email domain.
 *
 * @param name - Display name to match
 * @param jid - JID to match (username part only)
 * @param query - Search query (case-insensitive)
 * @returns true if name or username contains the query
 *
 * @example
 * ```typescript
 * matchNameOrJid('Alice Smith', 'alice@example.com', 'smith') // true (name match)
 * matchNameOrJid('Alice Smith', 'alice@example.com', 'ali') // true (username match)
 * matchNameOrJid('Alice Smith', 'alice@example.com', 'example') // false
 * ```
 */
export function matchNameOrJid(name: string, jid: string, query: string): boolean {
  const lowerQuery = query.toLowerCase()
  const nameMatch = name.toLowerCase().includes(lowerQuery)
  const usernameMatch = matchJidUsername(jid, lowerQuery)
  return nameMatch || usernameMatch
}
