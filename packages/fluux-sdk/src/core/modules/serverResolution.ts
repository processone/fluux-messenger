/**
 * Server resolution utilities — pure functions for WebSocket URL resolution.
 *
 * Handles XEP-0156 discovery, URL construction, and fallback logic.
 * Extracted from Connection.ts for independent testing and reuse.
 */

import { discoverWebSocket } from '../../utils/websocketDiscovery'

/** Console-like interface for logging (avoids direct store dependency). */
export interface ResolutionLogger {
  addEvent(message: string, category?: 'connection' | 'error' | 'sm' | 'presence'): void
}

/** Default timeout budget for XEP-0156 discovery. */
export const XEP0156_DISCOVERY_TIMEOUT_MS = 5000

/**
 * Shorter timeout used for desktop proxy pre-checks where we'll quickly
 * fall back to TCP/SRV via proxy if no endpoint is discovered.
 */
export const FAST_XEP0156_DISCOVERY_TIMEOUT_MS = 2500

/**
 * Check if WebSocket discovery should be skipped.
 * Returns true if:
 * - skipDiscovery option is explicitly set
 * - server is already a WebSocket URL (no discovery needed)
 */
export function shouldSkipDiscovery(server: string, skipDiscovery?: boolean): boolean {
  return skipDiscovery === true || server.startsWith('ws://') || server.startsWith('wss://')
}

/**
 * Get WebSocket URL synchronously (used when discovery is skipped).
 * Returns the server if it's already a WebSocket URL, otherwise constructs default URL.
 */
export function getWebSocketUrl(server: string, domain: string): string {
  if (server.startsWith('ws://') || server.startsWith('wss://')) {
    return server
  }
  return `wss://${server || domain}/ws`
}

/**
 * Discover a WebSocket URL via XEP-0156 only (no default URL fallback).
 *
 * @param server - Server parameter (domain name)
 * @param domain - XMPP domain from the JID (used for discovery)
 * @param logger - Optional logger for console events
 * @param timeoutMs - Discovery timeout in milliseconds
 * @returns Discovered WebSocket URL, or null when none is advertised
 */
export async function discoverWebSocketUrl(
  server: string,
  domain: string,
  logger?: ResolutionLogger,
  timeoutMs: number = XEP0156_DISCOVERY_TIMEOUT_MS
): Promise<string | null> {
  const discoveryDomain = server || domain

  logger?.addEvent(
    `Attempting XEP-0156 WebSocket discovery for ${discoveryDomain}...`,
    'connection'
  )

  try {
    const discoveredUrl = await discoverWebSocket(discoveryDomain, timeoutMs)
    if (discoveredUrl) {
      logger?.addEvent(
        `XEP-0156 discovery successful: ${discoveredUrl}`,
        'connection'
      )
      return discoveredUrl
    }
    logger?.addEvent(
      `XEP-0156 discovery returned no WebSocket endpoint for ${discoveryDomain}`,
      'connection'
    )
    return null
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger?.addEvent(
      `XEP-0156 discovery failed: ${errorMsg}`,
      'connection'
    )
    return null
  }
}

/**
 * Resolve WebSocket URL for a server via XEP-0156 discovery.
 *
 * Attempts discovery on the domain and falls back to default URL if discovery fails.
 * Note: This function is only called when discovery is NOT skipped.
 *
 * @param server - Server parameter (domain name)
 * @param domain - XMPP domain from the JID (used for discovery)
 * @param logger - Optional logger for console events
 * @returns Resolved WebSocket URL
 */
export async function resolveWebSocketUrl(
  server: string,
  domain: string,
  logger?: ResolutionLogger
): Promise<string> {
  // The server parameter might be a domain - attempt XEP-0156 discovery
  // Use the JID domain for discovery (more reliable than server param)
  const discoveryDomain = server || domain

  const discoveredUrl = await discoverWebSocketUrl(
    server,
    domain,
    logger,
    XEP0156_DISCOVERY_TIMEOUT_MS
  )
  if (discoveredUrl) {
    return discoveredUrl
  }

  // Fall back to default URL pattern
  const fallbackUrl = `wss://${discoveryDomain}/ws`
  logger?.addEvent(
    `Using default WebSocket URL: ${fallbackUrl}`,
    'connection'
  )
  return fallbackUrl
}
