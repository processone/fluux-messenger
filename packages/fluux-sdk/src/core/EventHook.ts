/**
 * Obsidian-inspired EventHook base class for modular event processing.
 *
 * EventHooks provide a lifecycle-managed way to subscribe to SDK events
 * and store changes. All subscriptions registered via `registerEvent()`
 * or `registerStoreSubscription()` are automatically cleaned up when
 * the hook is unloaded.
 *
 * @example Creating a custom event hook
 * ```typescript
 * class MyHook extends EventHook {
 *   readonly id = 'my-hook'
 *   readonly name = 'My Custom Hook'
 *
 *   onload(): void {
 *     this.registerEvent('chat:message', ({ message }) => {
 *       console.log('New message:', message.body)
 *     })
 *   }
 * }
 *
 * // Register with client
 * client.registerHook(new MyHook(client))
 * ```
 *
 * @packageDocumentation
 * @module Core/EventHook
 */

import type { SDKEventSource } from './types/eventSource'
import type { SDKEvents, SDKEventHandler } from './types/sdk-events'

/**
 * Base class for event hooks (Obsidian-inspired plugin pattern).
 *
 * Subclass this to create modular event processors that subscribe to
 * SDK events with automatic lifecycle cleanup. Register hooks on
 * the client via `client.registerHook(hook)`.
 *
 * @category Core
 */
export abstract class EventHook {
  /** Unique identifier for this hook */
  abstract readonly id: string
  /** Human-readable name */
  abstract readonly name: string

  /**
   * The event source this hook is bound to.
   *
   * Narrowed to the SDK bus on purpose: a hook reacts to events, and giving it
   * the whole client would let a hook drive protocol operations from inside an
   * event handler. Use {@link on} rather than subscribing through this
   * directly — it registers the cleanup.
   */
  protected client: SDKEventSource

  private _subscriptions: Array<() => void> = []

  constructor(client: SDKEventSource) {
    this.client = client
  }

  /**
   * Subscribe to an SDK event with automatic cleanup on unload.
   *
   * @param event - The SDK event name to subscribe to
   * @param handler - The event handler function
   */
  protected registerEvent<K extends keyof SDKEvents>(
    event: K,
    handler: SDKEventHandler<K>
  ): void {
    const unsub = this.client.subscribe(event, handler)
    this._subscriptions.push(unsub)
  }

  /**
   * Register a store subscription or other cleanup function.
   * Will be called automatically on unload.
   *
   * @param unsubscribe - Cleanup function to call on unload
   */
  protected registerStoreSubscription(unsubscribe: () => void): void {
    this._subscriptions.push(unsubscribe)
  }

  /**
   * Called when the hook is loaded/activated.
   * Override this to set up event subscriptions and initialize state.
   */
  abstract onload(): void

  /**
   * Called when the hook is unloaded/deactivated.
   * Base implementation cleans up all registered subscriptions.
   * Override to add custom cleanup logic (call `super.onunload()` first).
   */
  onunload(): void {
    for (const unsub of this._subscriptions) {
      unsub()
    }
    this._subscriptions = []
  }
}
