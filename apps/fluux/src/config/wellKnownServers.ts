/**
 * Well-known XMPP server WebSocket URLs
 *
 * This config maps domain names to their WebSocket endpoints.
 * Used to auto-fill the WebSocket URL field when the user types a JID
 * from a known domain.
 */

export interface ServerConfig {
  websocketUrl: string
  name?: string // Optional display name
}

/**
 * Wildcard server config for suffix-matched domains (e.g. *.m.in-app.io).
 * The websocketUrl is a template where {domain} is replaced with the full domain.
 */
export interface WildcardServerConfig {
  suffix: string // e.g. '.m.in-app.io'
  websocketUrl: string // e.g. 'wss://{domain}/xmpp'
  name?: string
}

/**
 * Map of domain -> server configuration
 * Add entries here for known XMPP servers
 */
export const wellKnownServers: Record<string, ServerConfig> = {
  'process-one.net': {
    websocketUrl: 'wss://chat.process-one.net/xmpp',
    name: 'ProcessOne',
  },
  'jabber.fr': {
    websocketUrl: 'wss://jabber.fr/ws',
    name: 'Jabber.fr',
  },
}

/**
 * Wildcard entries for domains matching a suffix pattern.
 * Checked when no exact match is found in wellKnownServers.
 */
export const wildcardServers: WildcardServerConfig[] = [
  {
    suffix: '.m.in-app.io',
    websocketUrl: 'wss://{domain}/xmpp',
    name: 'Fluux',
  },
]

/**
 * Get WebSocket URL for a domain if it's a well-known server.
 * Checks exact matches first, then wildcard suffix matches.
 */
export function getWebsocketUrlForDomain(domain: string): string | null {
  const lower = domain.toLowerCase()

  // Exact match
  const config = wellKnownServers[lower]
  if (config) return config.websocketUrl

  // Wildcard suffix match
  for (const wildcard of wildcardServers) {
    if (lower.endsWith(wildcard.suffix)) {
      return wildcard.websocketUrl.replace('{domain}', lower)
    }
  }

  return null
}

/**
 * Extract domain from a JID
 */
export function getDomainFromJid(jid: string): string | null {
  if (!jid) return null
  const atIndex = jid.indexOf('@')
  if (atIndex === -1) return null
  const domain = jid.slice(atIndex + 1).split('/')[0]
  return domain || null
}
