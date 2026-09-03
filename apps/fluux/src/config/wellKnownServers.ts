/**
 * Fallback WebSocket endpoints for known XMPP servers.
 *
 * XEP-0156 discovery answers this question for any domain that publishes a
 * discovery document, and it wins: these entries are consulted only when a
 * domain advertises no WebSocket endpoint at all. That case is real —
 * process-one.net serves a host-meta whose links are a webfinger template and
 * nothing else. A fallback is attached only when the JID domain is also the
 * connection target, so an explicit target keeps its own resolution path.
 */
import { getDomain } from '@fluux/sdk'

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
 *
 * Add an entry only for a server that advertises no WebSocket endpoint of its
 * own. A domain that publishes one needs nothing here.
 */
export const wellKnownServers: Record<string, ServerConfig> = {
  'process-one.net': {
    websocketUrl: 'wss://chat.process-one.net/xmpp',
    name: 'ProcessOne',
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
 * Get the fallback WebSocket URL for a domain, used only when XEP-0156
 * discovery advertises none. Checks exact matches first, then wildcard
 * suffix matches.
 */
export function getFallbackWebsocketUrlForDomain(domain: string): string | null {
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

export interface ConnectionServerOptions {
  server: string
  fallbackWebSocketUrl: string | undefined
}

export function getConnectionServerOptions(jid: string, server: string): ConnectionServerOptions {
  const domain = getDomainFromJid(jid) || ''
  const target = server || domain
  const fallbackWebSocketUrl = domain && target.toLowerCase() === domain.toLowerCase()
    ? getFallbackWebsocketUrlForDomain(domain) || undefined
    : undefined

  return { server: target, fallbackWebSocketUrl }
}

/**
 * Extract domain from a JID
 */
export function getDomainFromJid(jid: string): string | null {
  return getDomain(jid) || null
}
