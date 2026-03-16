/**
 * React hook wrappers for Zustand vanilla stores.
 *
 * These hooks bind the vanilla stores to React's render cycle using zustand's useStore.
 *
 * @packageDocumentation
 * @module React/StoreHooks
 */

import { useStore } from 'zustand'
import {
  connectionStore,
  chatStore,
  rosterStore,
  consoleStore,
  eventsStore,
  roomStore,
  adminStore,
  blockingStore,
  ignoreStore,
} from '../stores'
import type { ConnectionState } from '../stores/connectionStore'
import type { ChatState } from '../stores/chatStore'
import type { RosterState } from '../stores/rosterStore'
import type { ConsoleState } from '../stores/consoleStore'
import type { EventsState } from '../stores/eventsStore'
import type { RoomState } from '../stores/roomStore'
import type { AdminState } from '../stores/adminStore'
import type { BlockingState } from '../stores/blockingStore'
import type { IgnoreState } from '../stores/ignoreStore'

/**
 * React hook for the connection store.
 * @param selector - Optional selector function to pick specific state
 */
export function useConnectionStore<T = ConnectionState>(
  selector: (state: ConnectionState) => T = (state) => state as unknown as T
): T {
  return useStore(connectionStore, selector)
}

/**
 * React hook for the chat store.
 * @param selector - Optional selector function to pick specific state
 */
export function useChatStore<T = ChatState>(
  selector: (state: ChatState) => T = (state) => state as unknown as T
): T {
  return useStore(chatStore, selector)
}

/**
 * React hook for the roster store.
 * @param selector - Optional selector function to pick specific state
 */
export function useRosterStore<T = RosterState>(
  selector: (state: RosterState) => T = (state) => state as unknown as T
): T {
  return useStore(rosterStore, selector)
}

/**
 * React hook for the console store.
 * @param selector - Optional selector function to pick specific state
 */
export function useConsoleStore<T = ConsoleState>(
  selector: (state: ConsoleState) => T = (state) => state as unknown as T
): T {
  return useStore(consoleStore, selector)
}

/**
 * React hook for the events store.
 * @param selector - Optional selector function to pick specific state
 */
export function useEventsStore<T = EventsState>(
  selector: (state: EventsState) => T = (state) => state as unknown as T
): T {
  return useStore(eventsStore, selector)
}

/**
 * React hook for the room store.
 * @param selector - Optional selector function to pick specific state
 */
export function useRoomStore<T = RoomState>(
  selector: (state: RoomState) => T = (state) => state as unknown as T
): T {
  return useStore(roomStore, selector)
}

/**
 * React hook for the admin store.
 * @param selector - Optional selector function to pick specific state
 */
export function useAdminStore<T = AdminState>(
  selector: (state: AdminState) => T = (state) => state as unknown as T
): T {
  return useStore(adminStore, selector)
}

/**
 * React hook for the blocking store.
 * @param selector - Optional selector function to pick specific state
 */
export function useBlockingStore<T = BlockingState>(
  selector: (state: BlockingState) => T = (state) => state as unknown as T
): T {
  return useStore(blockingStore, selector)
}

/**
 * React hook for the ignore store.
 * @param selector - Optional selector function to pick specific state
 */
export function useIgnoreStore<T = IgnoreState>(
  selector: (state: IgnoreState) => T = (state) => state as unknown as T
): T {
  return useStore(ignoreStore, selector)
}
