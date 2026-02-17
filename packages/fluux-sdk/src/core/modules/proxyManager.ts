/**
 * Proxy lifecycle manager.
 *
 * Manages the always-on proxy: started once and reused across reconnects.
 * DNS/SRV resolution is handled per-connection by the Rust proxy, so
 * the SDK only needs to ensure the proxy is running.
 *
 * Falls back to WebSocket if the proxy fails to start.
 */

import type { ProxyAdapter } from '../types'
import { shouldSkipDiscovery, getWebSocketUrl, resolveWebSocketUrl, type ResolutionLogger } from './serverResolution'

/** Dependencies injected by Connection. */
export interface ProxyManagerDeps {
  proxyAdapter?: ProxyAdapter
  console: ResolutionLogger
}

/** Result from proxy operations: where to connect + how. */
export interface ServerResult {
  server: string
  connectionMethod: 'proxy' | 'websocket'
}

/**
 * Manages the always-on proxy lifecycle.
 *
 * The proxy is started once and reused across reconnects. Each new
 * WebSocket connection to the proxy creates a fresh TCP/TLS connection
 * with independent DNS resolution (handled by the Rust side).
 */
export class ProxyManager {
  private deps: ProxyManagerDeps
  private originalServer: string = ''
  private proxyUrl: string | null = null

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

  /** Get the cached proxy WS URL (for reconnection without IPC). */
  getProxyUrl(): string | null {
    return this.proxyUrl
  }

  // ── Ensure proxy is running ─────────────────────────────────────────────

  /**
   * Ensure the proxy is running for the given server.
   *
   * If already running for the same server, returns the cached URL
   * (the Rust side also checks this, but caching avoids the IPC round-trip).
   * Falls back to WebSocket discovery if the proxy fails to start.
   *
   * @param server - Original server string (domain, tls://host:port, etc.)
   * @param domain - XMPP domain from the JID
   * @param skipDiscovery - Whether to skip XEP-0156 discovery on fallback
   */
  async ensureProxy(
    server: string,
    domain: string,
    skipDiscovery?: boolean
  ): Promise<ServerResult> {
    if (!this.deps.proxyAdapter) {
      throw new Error('No proxy adapter available')
    }

    // If we already have a proxy URL for the same server, reuse it
    if (this.proxyUrl && this.originalServer === (server || domain)) {
      this.deps.console.addEvent(`Reusing proxy: ${this.proxyUrl}`, 'connection')
      return { server: this.proxyUrl, connectionMethod: 'proxy' }
    }

    this.deps.console.addEvent(`Starting proxy for: ${server || domain}`, 'connection')

    try {
      const proxyResult = await this.deps.proxyAdapter.startProxy(server || domain)
      this.proxyUrl = proxyResult.url
      this.originalServer = server || domain
      this.deps.console.addEvent(
        `Proxy started: ${server || domain} via ${proxyResult.url}`,
        'connection'
      )
      return {
        server: proxyResult.url,
        connectionMethod: 'proxy',
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

  /**
   * Force a proxy restart and return a fresh connection target.
   *
   * Useful for recovery after local proxy/socket failures where a cached
   * localhost WebSocket URL may no longer be valid.
   */
  async restartProxy(
    server: string,
    domain: string,
    skipDiscovery?: boolean
  ): Promise<ServerResult> {
    if (!this.deps.proxyAdapter) {
      throw new Error('No proxy adapter available')
    }

    const target = server || domain
    this.deps.console.addEvent(`Restarting proxy for: ${target}`, 'connection')

    try {
      await this.deps.proxyAdapter.stopProxy()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.deps.console.addEvent(`Failed to stop proxy during restart: ${errorMsg}`, 'error')
    }

    // Clear cache to force a fresh IPC startProxy call.
    this.proxyUrl = null
    this.originalServer = ''

    return this.ensureProxy(target, domain, skipDiscovery)
  }
}
