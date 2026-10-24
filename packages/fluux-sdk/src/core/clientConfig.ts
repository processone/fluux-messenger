/**
 * {@link XMPPClient} construction options.
 *
 * This is wiring rather than domain vocabulary, so it lives beside the client
 * instead of in the leaf `core/types` layer.
 *
 * @packageDocumentation
 * @module Core
 */

import type { StorageAdapter } from './types/storage'
import type { ProxyAdapter } from './types/proxy'
import type { PresenceOptions, PrivacyOptions } from './types/client'
import type { FastTokenStorageAdapter } from './fastTokenStorage'

/**
 * XMPPClient configuration options.
 *
 * @category Core
 */
export interface XMPPClientConfig {
  /** Enable debug logging */
  debug?: boolean
  /**
   * Options for integrating an external presence state machine.
   * Only needed when using XState for presence management (e.g., in React apps).
   * Bots typically don't need this - default presence handling is sufficient.
   */
  presenceOptions?: PresenceOptions
  /**
   * Privacy options for controlling data exposure.
   * @see {@link PrivacyOptions}
   */
  privacyOptions?: PrivacyOptions
  /**
   * Storage adapter for session persistence.
   *
   * Provides platform-specific storage for:
   * - XEP-0198 Stream Management session state (for fast reconnection)
   * - User credentials (for "Remember Me" functionality)
   * - Cached roster, rooms, and server info (for faster startup)
   *
   * The SDK provides `sessionStorageAdapter` as a default for web apps.
   * Desktop apps can provide a custom adapter using OS keychain.
   *
   * @example
   * ```tsx fragment
   * // Web app - uses default sessionStorageAdapter
   * <XMPPProvider>
   *   <App />
   * </XMPPProvider>
   *
   * // Desktop app with OS keychain
   * <XMPPProvider storageAdapter={tauriStorageAdapter}>
   *   <App />
   * </XMPPProvider>
   * ```
   */
  storageAdapter?: StorageAdapter
  /**
   * Storage for XEP-0484 FAST authentication tokens.
   *
   * Browsers default to localStorage. Headless runtimes default to memory. To
   * survive a process restart, inject an adapter and persist {@link userAgentId}.
   */
  fastTokenStorage?: FastTokenStorageAdapter
  /**
   * Stable XEP-0388 user-agent UUID used to bind XEP-0484 FAST tokens.
   *
   * Headless runtimes keep a process-local default. Callers that persist FAST
   * tokens across process restarts must persist and reuse this ID as well.
   * An injected ID is caller-owned and is not changed by
   * `clearUserAgentIdentity()`.
   */
  userAgentId?: string
  /**
   * Proxy adapter for WebSocket-to-TCP bridging.
   *
   * Desktop apps can provide a proxy adapter to enable native TCP/TLS
   * connections to XMPP servers instead of WebSocket.
   *
   * When provided, the SDK will use this adapter to start/stop the proxy
   * for each connection. When not provided, connections use WebSocket directly.
   *
   * @example
   * ```tsx fragment
   * <XMPPProvider proxyAdapter={tauriProxyAdapter}>
   *   <App />
   * </XMPPProvider>
   * ```
   */
  proxyAdapter?: ProxyAdapter
  /**
   * Pull-based predicate the SDK evaluates before each automatic reconnect
   * attempt. Return `false` to suppress auto-reconnect (e.g., after an
   * explicit logout). Evaluated live — no cached copy. Defaults to always-on.
   */
  shouldAutoReconnect?: () => boolean
  /**
   * Ids of the E2EE plugins the app registers on `e2ee:manager-ready`.
   *
   * Declaring them lets the SDK tag a message encrypted with any other protocol
   * (for example OMEMO when only OpenPGP is wired) as unsupported as soon as it
   * arrives. Messages for a declared protocol wait for its plugin to register.
   * When omitted, every encrypted message waits until the first plugin
   * registers before an unsupported protocol is recognised.
   *
   * A declared id only keeps messages waiting for a protocol the SDK can map to
   * it: `openpgp` for XEP-0373. A message in a protocol it cannot map that
   * arrives before a plugin claiming it registers is tagged unsupported.
   *
   * @example
   * ```tsx fragment
   * <XMPPProvider e2eePlugins={['openpgp']}>
   *   <App />
   * </XMPPProvider>
   * ```
   */
  e2eePlugins?: readonly string[]
}
