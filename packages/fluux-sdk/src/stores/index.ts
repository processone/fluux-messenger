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
export type { SubscriptionRequest, StrangerMessage, MucInvitation } from '../core/types'

export { roomStore } from './roomStore'
export type { RoomState } from './roomStore'
export { roomSelectors } from './roomSelectors'

export { adminStore } from './adminStore'
export type { AdminState, AdminCommand, AdminSession, DataForm, DataFormField, AdminNote } from './adminStore'

export { blockingStore } from './blockingStore'
export type { BlockingState } from './blockingStore'

export { ignoreStore, isMessageFromIgnoredUser, isReplyToIgnoredUser } from './ignoreStore'
export type { IgnoreState, IgnoredUser } from './ignoreStore'

export { activityLogStore } from './activityLogStore'
export type { ActivityLogState } from './activityLogStore'

export { searchStore, setSearchClient, getSearchClient } from './searchStore'
export type { SearchState, SearchResult, ContextMessage, SearchResultContext, SearchFilterType, InPrefixSuggestion } from './searchStore'
