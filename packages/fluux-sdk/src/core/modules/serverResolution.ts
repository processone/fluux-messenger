/**
 * Server resolution utilities — pure functions for WebSocket URL resolution.
 *
 * Handles XEP-0156 discovery, URL construction, and fallback logic.
 * Extracted from Connection.ts for independent testing and reuse.
 */

import type { DiscoveryFailure } from '../types/connection'
import { discoverWebSocket, type DiscoveryDiagnostics } from '../../utils/websocketDiscovery'

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
 * The WebSocket URL assumed for a host that advertises none.
 *
 * The conventional endpoint of an XMPP server that terminates WebSocket on the
 * same host. It is a guess, and it is the last thing tried.
 */
export function defaultWebSocketUrl(host: string): string {
  return `wss://${host}/ws`
}

/**
 * Return the value when it is already a WebSocket URL, otherwise null.
 */
function asWebSocketUrl(value?: string): string | null {
  if (!value) return null
  return value.startsWith('ws://') || value.startsWith('wss://') ? value : null
}

/**
 * Get WebSocket URL synchronously (used when discovery is skipped).
 * Returns the server if it's already a WebSocket URL, otherwise constructs default URL.
 */
export function getWebSocketUrl(server: string, domain: string): string {
  return asWebSocketUrl(server) ?? defaultWebSocketUrl(server || domain)
}

/**
 * Discover a WebSocket URL via XEP-0156 only (no default URL fallback).
 *
 * @param server - Server parameter (domain name)
 * @param domain - XMPP domain from the JID, used when server is empty
 * @param logger - Optional logger for console events
 * @param timeoutMs - Discovery timeout in milliseconds
 * @param onDiagnostics - Optional observer for the completed discovery report
 * @returns Discovered WebSocket URL, or null when discovery fails or finds no usable endpoint
 */
export async function discoverWebSocketUrl(
  server: string,
  domain: string,
  logger?: ResolutionLogger,
  timeoutMs: number = XEP0156_DISCOVERY_TIMEOUT_MS,
  onDiagnostics?: (diagnostics: DiscoveryDiagnostics) => void
): Promise<string | null> {
  const discoveryDomain = server || domain

  logger?.addEvent(
    `Attempting XEP-0156 WebSocket discovery for ${discoveryDomain}...`,
    'connection'
  )

  try {
    const discoveredUrl = await discoverWebSocket(discoveryDomain, timeoutMs, onDiagnostics)
    if (discoveredUrl) {
      logger?.addEvent(
        `XEP-0156 discovery successful: ${discoveredUrl}`,
        'connection'
      )
      return discoveredUrl
    }
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
 * Note: This function is only called when discovery is NOT skipped.
 *
 * The configured endpoint follows the precedence documented by
 * ConnectOptions.fallbackWebSocketUrl; the synthesised default is the last guess.
 *
 * @param server - Server parameter (domain name)
 * @param domain - XMPP domain from the JID, used when server is empty
 * @param logger - Optional logger for console events
 * @param fallbackWebSocketUrl - Optional endpoint from ConnectOptions.fallbackWebSocketUrl
 * @param onFallback - Called when a fallback is selected; null means no read failure was reported
 * @returns Resolved WebSocket URL
 */
export async function resolveWebSocketUrl(
  server: string,
  domain: string,
  logger?: ResolutionLogger,
  fallbackWebSocketUrl?: string,
  onFallback?: (failure: DiscoveryFailure | null) => void
): Promise<string> {
  const discoveryDomain = server || domain

  let diagnostics: DiscoveryDiagnostics | undefined
  const discoveredUrl = await discoverWebSocketUrl(
    server,
    domain,
    logger,
    XEP0156_DISCOVERY_TIMEOUT_MS,
    (result) => { diagnostics = result }
  )
  if (discoveredUrl) {
    return discoveredUrl
  }

  const configuredUrl = asWebSocketUrl(fallbackWebSocketUrl)
  const fallbackUrl = configuredUrl ?? defaultWebSocketUrl(discoveryDomain)
  const failure = reportDiscoveryFallback(discoveryDomain, diagnostics, fallbackUrl,
    configuredUrl ? 'configured' : 'guess', logger)
  onFallback?.(failure)
  return fallbackUrl
}

/**
 * Validate the optional ConnectOptions.fallbackWebSocketUrl before trying it.
 *
 * Exposed so the proxy-capable desktop path can apply the same precedence
 * before it gives up on a direct WebSocket and starts the TCP proxy.
 */
export function fallbackWebSocketUrlFor(fallbackWebSocketUrl?: string): string | null {
  return asWebSocketUrl(fallbackWebSocketUrl)
}

/** Log the document outcomes together with the fallback selected by the caller. */
export function reportDiscoveryFallback(
  domain: string,
  diagnostics: DiscoveryDiagnostics | undefined,
  target: string,
  kind: 'configured' | 'guess' | 'native-tcp',
  logger?: ResolutionLogger
): DiscoveryFailure | null {
  const outcomes = diagnostics?.attempts.map((attempt) => {
    let text: string
    switch (attempt.outcome) {
      case 'endpoint-found': text = `WebSocket endpoint ${attempt.websocket}`; break
      case 'no-websocket': text = 'document read; no usable secure WebSocket endpoint'; break
      case 'http-error': text = `HTTP ${attempt.status}`; break
      case 'invalid-document': text = 'unreadable or unparsable document'; break
      case 'timeout': text = 'request timed out'; break
      case 'request-failed': text = 'request failed (network error, possibly blocked by CORS)'; break
      case 'redirect-rejected': text = `redirect rejected (${attempt.reason})`; break
    }
    return `${attempt.url}: ${text}`
  }).join('; ') ?? 'discovery diagnostics unavailable'
  const fallback = kind === 'configured' ? `configured WebSocket URL ${target}`
    : kind === 'guess' ? `guessed WebSocket URL ${target}` : `native TCP/SRV for ${target}`
  logger?.addEvent(
    `XEP-0156 discovery for ${domain}: ${outcomes}. Falling back to ${fallback}. Host-meta must send Access-Control-Allow-Origin for web clients.`,
    'connection'
  )
  const failed = diagnostics?.attempts.some(({ outcome }) =>
    outcome !== 'no-websocket' && outcome !== 'endpoint-found')
  return failed ? { domain, target, transport: kind === 'native-tcp' ? 'native-tcp' : 'websocket' } : null
}
