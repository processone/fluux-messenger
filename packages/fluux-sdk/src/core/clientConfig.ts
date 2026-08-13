/**
 * {@link XMPPClient} construction options.
 *
 * This is wiring, not vocabulary: alongside the adapter contracts it carries a
 * live {@link SDKStores} bundle, which is a handle on a concrete state
 * implementation. That is why it lives here next to the client rather than in
 * `core/types`, which stays a leaf layer no store can be reached from.
 *
 * @packageDocumentation
 * @module Core
 */

import type { SDKStores } from '../stores/sdkStores'
import type { StorageAdapter } from './types/storage'
import type { ProxyAdapter } from './types/proxy'
import type { PresenceOptions, PrivacyOptions } from './types/client'

/**
 * XMPPClient configuration options.
 *
 * @category Core
 */
export interface XMPPClientConfig {
  /** Enable debug logging */
  debug?: boolean
  /**
   * Store bundle backing this client. Defaults to the process-wide singletons
   * ({@link defaultStores}).
   *
   * @internal Partial seam — NOT a supported multi-account switch yet, and not
   * part of the public API. A custom {@link SDKStores} bundle is honored by
   * `connect()` account-switch and the SDK event → store bindings, but the
   * store-based side effects (MAM catch-up, read-marker / MDS sync, background
   * sync), the SM-resumable state snapshot, and the Poll module still read and
   * write the process-global singletons regardless of what is passed here.
   * Two clients with different bundles therefore cross-contaminate on that
   * state — do not use this to run multiple accounts. Full isolation also needs
   * a `createStores()` factory and a per-instance storage scope; see the
   * checklist in `stores/sdkStores.ts`. Single-account apps must omit this.
   */
  stores?: SDKStores
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
}