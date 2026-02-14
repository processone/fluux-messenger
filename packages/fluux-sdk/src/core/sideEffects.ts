/**
 * Side effects orchestrator.
 *
 * Wires up all store-based side effects (chat, room, background sync)
 * and re-exports individual setup functions for direct use.
 *
 * @packageDocumentation
 * @module Core/SideEffects
 */

import type { XMPPClient } from './XMPPClient'
import { setupChatSideEffects } from './chatSideEffects'
import { setupRoomSideEffects } from './roomSideEffects'
import { setupBackgroundSyncSideEffects } from './backgroundSync'

// Re-export individual setup functions and types
export { setupChatSideEffects } from './chatSideEffects'
export type { SideEffectsOptions } from './chatSideEffects'
export { setupRoomSideEffects } from './roomSideEffects'

/**
 * Sets up all store-based side effects for the SDK.
 *
 * This should be called once when the XMPPClient is created. It sets up
 * subscriptions that respond to state changes and trigger appropriate
 * side effects (loading cache, fetching history, etc.).
 *
 * @param client - The XMPPClient instance
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up all subscriptions
 *
 * @example
 * ```typescript
 * const client = new XMPPClient()
 * const cleanup = setupStoreSideEffects(client)
 *
 * // Later, when client is destroyed:
 * cleanup()
 * ```
 */
export function setupStoreSideEffects(
  client: XMPPClient,
  options: { debug?: boolean } = {}
): () => void {
  const unsubscribeChat = setupChatSideEffects(client, options)
  const unsubscribeRoom = setupRoomSideEffects(client, options)
  const unsubscribeSync = setupBackgroundSyncSideEffects(client, options)

  return () => {
    unsubscribeChat()
    unsubscribeRoom()
    unsubscribeSync()
  }
}
