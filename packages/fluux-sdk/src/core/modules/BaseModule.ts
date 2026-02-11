import type { Element } from '@xmpp/client'
import type { StoreBindings, XMPPClientEvents, SDKEvents, StorageAdapter, ProxyAdapter, PrivacyOptions } from '../types'

/**
 * Dependencies injected into each module by XMPPClient.
 *
 * Provides access to stores, stanza sending, and event emission
 * without modules needing direct access to the XMPPClient instance.
 *
 * @internal
 */
export interface ModuleDependencies {
  stores: StoreBindings | null
  sendStanza: (stanza: Element) => Promise<void>
  sendIQ: (iq: Element) => Promise<Element>
  getCurrentJid: () => string | null
  emit: <K extends keyof XMPPClientEvents>(
    event: K,
    ...args: Parameters<XMPPClientEvents[K]>
  ) => void
  /**
   * Emit SDK events for store bindings (Phase 0.3 of event-based decoupling).
   * These events are subscribed to by XMPPProvider to update Zustand stores.
   */
  emitSDK: <K extends keyof SDKEvents>(event: K, payload: SDKEvents[K]) => void
  getXmpp: () => any | null // The underlying xmpp client
  /**
   * Storage adapter for session persistence.
   * Used by Connection module for SM state persistence.
   */
  storageAdapter?: StorageAdapter
  /**
   * Proxy adapter for WebSocket-to-TCP bridging.
   * Used by Connection module for native TCP/TLS connections.
   */
  proxyAdapter?: ProxyAdapter
  /**
   * Register a MAM query collector.
   * The collector will be called for each incoming stanza while active.
   * Returns a function to unregister the collector.
   * Used by MAM module to avoid adding temporary event listeners.
   */
  registerMAMCollector?: (queryId: string, collector: (stanza: Element) => void) => () => void
  /**
   * Privacy options for controlling data exposure.
   * Used by Profile module to control avatar fetching behavior.
   */
  privacyOptions?: PrivacyOptions
}

/**
 * Base class for domain-specific modules in XMPPClient.
 *
 * Each module handles a specific set of XEPs or features and is responsible
 * for processing incoming stanzas related to its domain. Modules are created
 * by XMPPClient during store binding and share common dependencies.
 *
 * @remarks
 * Subclasses must implement the `handle()` method to process incoming stanzas.
 * Return `true` from `handle()` to indicate the stanza was processed and should
 * not be passed to other modules.
 *
 * @example Creating a custom module
 * ```typescript
 * class CustomModule extends BaseModule {
 *   handle(stanza: Element): boolean {
 *     if (stanza.is('message') && stanza.getChild('custom', 'urn:example:custom')) {
 *       // Process custom stanza
 *       return true // Stanza handled
 *     }
 *     return false // Pass to next module
 *   }
 * }
 * ```
 *
 * @category Modules
 * @internal
 */
export abstract class BaseModule {
  protected deps: ModuleDependencies

  constructor(deps: ModuleDependencies) {
    this.deps = deps
  }

  /**
   * Handle incoming stanza.
   * @param stanza The incoming XMPP stanza
   * @returns true if the stanza was handled and should not be processed further
   */
  abstract handle(stanza: Element): boolean | void
}
