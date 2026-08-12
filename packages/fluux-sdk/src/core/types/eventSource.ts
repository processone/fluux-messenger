/**
 * The two event buses a consumer can attach to, as contracts rather than as
 * "whatever XMPPClient happens to expose".
 *
 * The SDK has two buses on purpose, and they are not interchangeable:
 *
 * - {@link SDKEventSource} carries the typed, domain-level `SDKEvents` that
 *   store bindings and side effects react to.
 * - {@link ClientEventSource} carries the lower-level `XMPPClientEvents` that
 *   describe the connection and stanza lifecycle.
 *
 * Naming them here lets a module say which bus it needs without importing the
 * client that provides both — which is what kept the client, its bindings and
 * every side effect in one mutually recursive component.
 *
 * @packageDocumentation
 * @module Types/EventSource
 */

import type { XMPPClientEvents } from './client'
import type { SDKEvents, SDKEventHandler } from './sdk-events'

/**
 * Subscribes to typed SDK events. Returns an unsubscribe function.
 *
 * @category Internal
 */
export interface SDKEventSource {
  subscribe<K extends keyof SDKEvents>(event: K, handler: SDKEventHandler<K>): () => void
}

/**
 * Subscribes to low-level client events. Returns an unsubscribe function.
 *
 * @category Internal
 */
export interface ClientEventSource {
  on<K extends keyof XMPPClientEvents>(event: K, handler: XMPPClientEvents[K]): () => void
}
