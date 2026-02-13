/**
 * Proxy adapter interface for WebSocket-to-TCP bridging.
 *
 * Desktop apps can provide a proxy adapter to enable native TCP/TLS
 * connections to XMPP servers. The proxy bridges between a local WebSocket
 * (used by xmpp.js) and a remote TCP/TLS connection.
 *
 * @packageDocumentation
 * @module Types/Proxy
 */

import type { ConnectionMethod } from './connection'

/**
 * Result of starting the proxy.
 */
export interface ProxyStartResult {
  /** Local WebSocket URL to connect to (e.g., "ws://127.0.0.1:12345") */
  url: string
  /** Connection method used: 'tls' for direct TLS, 'starttls' for STARTTLS upgrade */
  connectionMethod: ConnectionMethod
  /** Resolved endpoint URI for reuse on reconnect (e.g., "tls://chat.example.com:5223").
   *  Passing this to startProxy() on reconnect avoids SRV re-resolution
   *  which may yield different results after DNS cache flush (e.g., after system sleep). */
  resolvedEndpoint?: string
}

/**
 * Adapter interface for WebSocket-to-TCP proxy implementations.
 *
 * The SDK uses this adapter to delegate native TCP/TLS connection handling
 * to platform-specific implementations. When a proxy adapter is provided,
 * the SDK will use it instead of connecting directly via WebSocket.
 *
 * @example Tauri desktop app
 * ```typescript
 * const tauriProxyAdapter: ProxyAdapter = {
 *   async startProxy(server) {
 *     const { invoke } = await import('@tauri-apps/api/core')
 *     const result = await invoke('start_xmpp_proxy', { server })
 *     return { url: result.url, connectionMethod: result.connection_method }
 *   },
 *   async stopProxy() {
 *     const { invoke } = await import('@tauri-apps/api/core')
 *     await invoke('stop_xmpp_proxy')
 *   },
 * }
 * ```
 *
 * @category Core
 */
export interface ProxyAdapter {
  /**
   * Start the proxy for the given server.
   *
   * The server parameter supports multiple formats depending on the implementation:
   * - `domain` — resolve via SRV records
   * - `host:port` — connect directly
   * - `tls://host:port` — direct TLS connection
   * - `tcp://host:port` — STARTTLS connection
   *
   * @param server - Server specification
   * @returns Local WebSocket URL and connection method
   */
  startProxy(server: string): Promise<ProxyStartResult>

  /**
   * Stop the running proxy.
   * Should be graceful — no error if proxy is not running.
   */
  stopProxy(): Promise<void>
}
