/**
 * # Fluux SDK Stores
 *
 * Framework-agnostic state management using Zustand vanilla stores.
 *
 * ## Usage Patterns
 *
 * ### Vue/Svelte/Vanilla JS (Direct Store Access)
 * ```ts
 * import { connectionStore, chatStore } from '@fluux/sdk/stores'
 *
 * // Subscribe to changes
 * connectionStore.subscribe((state) => console.log(state.status))
 *
 * // Get current state
 * const status = connectionStore.getState().status
 *
 * // Update state
 * connectionStore.getState().setStatus('connected')
 * ```
 *
 * ### React Applications
 * ```tsx
 * import { useConnectionStore, useChatStore } from '@fluux/sdk'
 * // Or: import { useConnectionStore, useChatStore } from '@fluux/sdk/react'
 *
 * function Component() {
 *   const status = useConnectionStore((state) => state.status)
 *   const conversations = useChatStore((state) => state.conversations)
 * }
 * ```
 *
 * @packageDocumentation
 * @module Stores
 */

// =============================================================================
// VANILLA STORES (framework-agnostic)
// =============================================================================

export { connectionStore } from './connectionStore'
export type { ConnectionState } from './connectionStore'

export { chatStore } from './chatStore'
export type { ChatState } from './chatStore'
export { chatSelectors } from './chatSelectors'

export { rosterStore } from './rosterStore'
export type { RosterState } from './rosterStore'
export { rosterSelectors } from './rosterSelectors'

export { consoleStore } from './consoleStore'
export type { ConsoleState } from './consoleStore'

export { eventsStore } from './eventsStore'
export type { EventsState } from './eventsStore'
// Re-exported from the concrete module, not the '../core/types' barrel: that barrel
// pulls in core/types/client.ts, which would put this barrel back inside a cycle.
export type { SubscriptionRequest, StrangerMessage, MucInvitation } from '../core/types/events'

export { roomStore } from './roomStore'
export type { RoomState } from './roomStore'
export { roomSelectors, roomActivityTone } from './roomSelectors'
export type { RoomActivityTone } from './roomSelectors'

export { adminStore } from './adminStore'
export type { AdminState, AdminCommand, AdminSession, DataForm, DataFormField, AdminNote } from './adminStore'

export { blockingStore } from './blockingStore'
export type { BlockingState } from './blockingStore'

export { ignoreStore, isMessageFromIgnoredUser, isReplyToIgnoredUser } from './ignoreStore'
export type { IgnoreState, IgnoredUser } from './ignoreStore'

export { searchStore, setSearchClient, getSearchClient } from './searchStore'
export type { SearchState, SearchResult, ContextMessage, SearchResultContext, SearchFilterType, InPrefixSuggestion } from './searchStore'

// Injectable store bundle (store-injection seam; see sdkStores.ts)
export { defaultStores } from './sdkStores'
export type { SDKStores } from './sdkStores'

// =============================================================================
// UTILITIES
// =============================================================================

export { buildScopedStorageKey } from '../utils/storageScope'
