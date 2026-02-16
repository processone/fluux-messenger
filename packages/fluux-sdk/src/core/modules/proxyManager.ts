/**
 * Proxy lifecycle manager.
 *
 * Handles proxy start/stop/restart with a three-level fallback chain
 * for reconnection: cached endpoint → SRV → WebSocket fallback.
 *
 * Extracted from Connection.ts for independent testing and to provide
 * a clean seam for future Option E (replacing proxy with Rust IPC).
 */

import type { ProxyAdapter, ProxyStartResult, ConnectionMethod } from '../types'
import { PROXY_RESTART_TIMEOUT_MS } from './connectionUtils'
import { shouldSkipDiscovery, getWebSocketUrl, resolveWebSocketUrl, type ResolutionLogger } from './serverResolution'

/** Dependencies injected by Connection. */
export interface ProxyManagerDeps {
  proxyAdapter?: ProxyAdapter
  console: ResolutionLogger
}

/** Result from proxy operations: where to connect + how. */
export interface ServerResult {
  server: string
  connectionMethod: ConnectionMethod
}

/**
 * Manages the proxy lifecycle (start / restart / stop) and the
 * three-level reconnection fallback chain.
 *
 * State fields moved here from Connection.ts:
 * - `originalServer`: pre-proxy server string (needed to restart proxy)
 * - `resolvedEndpoint`: cached endpoint from proxy (skips SRV on reconnect)
 */
export class ProxyManager {
  private deps: ProxyManagerDeps
  private originalServer: string = ''
  private resolvedEndpoint: string | null = null

  constructor(deps: ProxyManagerDeps) {
    this.deps = deps
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Whether a proxy adapter is available. */
  get hasProxy(): boolean {
    return !!this.deps.proxyAdapter
  }

  /** Set original server on initial connect. */
  setOriginalServer(server: string): void {
    this.originalServer = server
  }

  /** Get the original server string (pre-proxy). */
  getOriginalServer(): string {
    return this.originalServer
  }

  /** Get cached resolved endpoint (for logging). */
  getResolvedEndpoint(): string | null {
    return this.resolvedEndpoint
  }

  // ── Initial connect ───────────────────────────────────────────────────────

  /**
   * Start proxy for initial connection.
   *
   * Returns the resolved server URL and connection method.
   * Falls back to WebSocket discovery if proxy fails.
   *
   * @param server - Original server string (domain, tls://host:port, etc.)
   * @param domain - XMPP domain from the JID
   * @param skipDiscovery - Whether to skip XEP-0156 discovery
   */
  async startForConnect(
    server: string,
    domain: string,
    skipDiscovery?: boolean
  ): Promise<ServerResult> {
    if (!this.deps.proxyAdapter) {
      throw new Error('No proxy adapter available')
    }

    this.deps.console.addEvent(`Starting proxy for: ${server || domain}`, 'connection')

    try {
      const proxyResult = await this.deps.proxyAdapter.startProxy(server || domain)
      this.resolvedEndpoint = proxyResult.resolvedEndpoint ?? null
      this.deps.console.addEvent(
        `Proxy started: ${server || domain} via ${proxyResult.url} (${proxyResult.connectionMethod})`,
        'connection'
      )
      return {
        server: proxyResult.url,
        connectionMethod: proxyResult.connectionMethod,
      }
    } catch (err) {
      // Proxy failed — fall back to WebSocket
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.deps.console.addEvent(`Failed to start proxy: ${errorMsg}, falling back to WebSocket`, 'error')

      const resolvedServer = shouldSkipDiscovery(server, skipDiscovery)
        ? getWebSocketUrl(server, domain)
        : await resolveWebSocketUrl(server, domain, this.deps.console)

      return {
        server: resolvedServer,
        connectionMethod: 'websocket',
      }
    }
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  /**
   * Restart proxy for reconnection with three-level fallback:
   * 1. Cached resolved endpoint (skip SRV re-resolution)
   * 2. Original server (fresh SRV)
   * 3. Plain WebSocket fallback
   *
   * @param domain - XMPP domain for WebSocket fallback URL
   * @returns The resolved server URL and connection method
   */
  async restartForReconnect(domain: string): Promise<ServerResult> {
    if (!this.deps.proxyAdapter) {
      throw new Error('No proxy adapter available')
    }

    try {
      // Stop the old proxy first (if still running)
      try { await this.deps.proxyAdapter.stopProxy() } catch { /* may not be running */ }

      // Prefer cached resolved endpoint to skip SRV re-resolution
      const proxyServer = this.resolvedEndpoint || this.originalServer
      const proxyResult = await this.startProxyWithTimeout(proxyServer)

      this.resolvedEndpoint = proxyResult.resolvedEndpoint ?? null
      this.deps.console.addEvent(
        `Proxy restarted for reconnect: ${proxyResult.url} (${proxyResult.connectionMethod}) [endpoint: ${proxyServer}]`,
        'connection'
      )
      return {
        server: proxyResult.url,
        connectionMethod: proxyResult.connectionMethod,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)

      // If cached endpoint failed, retry with original server (fresh SRV)
      if (this.resolvedEndpoint) {
        this.deps.console.addEvent(
          `Cached endpoint failed: ${errorMsg}, retrying with SRV resolution`,
          'connection'
        )
        this.resolvedEndpoint = null

        try {
          const proxyResult = await this.startProxyWithTimeout(this.originalServer)
          this.resolvedEndpoint = proxyResult.resolvedEndpoint ?? null
          this.deps.console.addEvent(
            `Proxy restarted via SRV fallback: ${proxyResult.url} (${proxyResult.connectionMethod})`,
            'connection'
          )
          return {
            server: proxyResult.url,
            connectionMethod: proxyResult.connectionMethod,
          }
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          this.deps.console.addEvent(`Failed to restart proxy on reconnect: ${fallbackMsg}`, 'error')
        }
      } else {
        this.deps.console.addEvent(`Failed to restart proxy on reconnect: ${errorMsg}`, 'error')
      }

      // Ultimate fallback: plain WebSocket
      return {
        server: `wss://${domain}/ws`,
        connectionMethod: 'websocket',
      }
    }
  }

  // ── Stop / Reset ──────────────────────────────────────────────────────────

  /** Stop proxy (fire-and-forget, used on disconnect). */
  stop(): void {
    if (this.deps.proxyAdapter) {
      this.deps.proxyAdapter.stopProxy().catch(() => {})
      this.deps.console.addEvent('Stopped proxy', 'connection')
    }
  }

  /** Reset state on disconnect. */
  reset(): void {
    this.originalServer = ''
    this.resolvedEndpoint = null
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Start proxy with timeout to prevent hanging on dead connections. */
  private startProxyWithTimeout(server: string): Promise<ProxyStartResult> {
    return Promise.race([
      this.deps.proxyAdapter!.startProxy(server),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Proxy restart timed out')), PROXY_RESTART_TIMEOUT_MS)
      ),
    ])
  }
}
