/**
 * Compile-time proof that each Zustand store implements its binding port.
 *
 * `StoreBindings` used to be `Pick<ChatState, …>`: the contract was derived
 * from the implementation, so it could not disagree with it — but it also made
 * the SDK's leaf type layer depend on the stores, and left the package unable
 * to describe its own state surface without naming Zustand.
 *
 * The port is now declared independently in `core/types/storeBindings.ts`, and
 * the drift protection lives here instead, pointing the other way: if a store
 * drops a member the port promises, or narrows a signature the port requires,
 * these assignments stop compiling. If a store ADDS a member the port does not
 * mention, nothing breaks — extra state is a store's business, and the client
 * only ever sees the port.
 *
 * This file is type-only. It emits no runtime code and is never imported.
 *
 * @packageDocumentation
 * @module Stores
 */

import type { StoreBindings } from '../core/types/storeBindings'
import type { ConnectionState } from './connectionStore'
import type { ChatState } from './chatStore'
import type { RosterState } from './rosterStore'
import type { ConsoleState } from './consoleStore'
import type { EventsState } from './eventsStore'
import type { RoomState } from './roomStore'
import type { AdminState } from './adminStore'
import type { BlockingState } from './blockingStore'

/**
 * Structural conformance: `State` must be assignable to the port namespace.
 *
 * Composite getters (`getAllConversations`, `getRoomGapStart`, …) are NOT
 * store members — `createDefaultStoreBindings` builds them over the raw state —
 * so they are excluded from the obligation here.
 */
type StoreMembersOf<Namespace> = Omit<Namespace, ComputedBindingKey>

/**
 * Members of a port namespace that `defaultStoreBindings.ts` synthesises
 * rather than delegating. Keep in sync with the handwritten entries there.
 */
type ComputedBindingKey =
  | 'getStatus'
  | 'getOwnNickname'
  | 'getJid'
  | 'getHttpUploadService'
  | 'getWebPushServices'
  | 'getWebPushEnabled'
  | 'getServerInfo'
  | 'getAllConversations'
  | 'getConversationGapStart'
  | 'getConversationGapStartId'
  | 'getConversationGapEndId'
  | 'getConversationCoverageUnproven'
  | 'getConversationPendingStanzaId'
  | 'getActiveConversationId'
  | 'getArchivedConversations'
  | 'getLastMessage'
  | 'getAllStoredMessages'
  | 'getConversationMessages'
  | 'getEncryptedPreviews'
  | 'getRoomGapStart'
  | 'getRoomGapStartId'
  | 'getRoomGapEndId'
  | 'getRoomCoverageUnproven'
  | 'getRoomPendingStanzaId'
  | 'getAllRoomMessages'
  | 'getCommands'
  | 'getCurrentSession'
  | 'getMucServiceJid'
  | 'selectedVhost'

/** Compiles only when `T` is `true`; otherwise reports the constraint failure. */
type Assert<T extends true> = T

/** Whether a store's state is usable wherever its port namespace is required. */
type Implements<State, Namespace> = State extends StoreMembersOf<Namespace> ? true : false

// Each alias below fails to compile — "Type 'false' does not satisfy the
// constraint 'true'" — when its store stops satisfying its port namespace. The
// alias name says which one; compare the store's state interface against
// `core/types/storeBindings.ts` to find the member that drifted.
export type ConnectionStoreImplementsPort = Assert<Implements<ConnectionState, StoreBindings['connection']>>
export type ChatStoreImplementsPort = Assert<Implements<ChatState, StoreBindings['chat']>>
export type RosterStoreImplementsPort = Assert<Implements<RosterState, StoreBindings['roster']>>
export type ConsoleStoreImplementsPort = Assert<Implements<ConsoleState, StoreBindings['console']>>
export type EventsStoreImplementsPort = Assert<Implements<EventsState, StoreBindings['events']>>
export type RoomStoreImplementsPort = Assert<Implements<RoomState, StoreBindings['room']>>
export type AdminStoreImplementsPort = Assert<Implements<AdminState, StoreBindings['admin']>>
export type BlockingStoreImplementsPort = Assert<Implements<BlockingState, StoreBindings['blocking']>>
