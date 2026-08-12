/**
 * What a store-based side effect needs from the client that drives it.
 *
 * The side effects used to name `XMPPClient` itself. That single type import
 * was enough to tie them together: the client constructs the side effects, the
 * side effects name the client, and everything reachable from either ended up
 * in one strongly connected component that no part could be read or typechecked
 * without.
 *
 * Nothing about a side effect actually needs the whole client. Each one reacts
 * to a bus and calls a handful of protocol methods, and that is what is declared
 * here — narrowed per concern, so a reader can see the blast radius of a side
 * effect from its signature. `XMPPClient` satisfies this structurally; the
 * assertion in `sideEffectHostConformance.ts` fails to compile if it stops.
 *
 * This lives beside the client rather than in `core/types` because it names
 * module-level result shapes (MDS markers, synced conversations) that are not
 * part of the SDK's public vocabulary.
 *
 * @packageDocumentation
 * @module Core
 */

import type { SDKEventSource, ClientEventSource } from './types/eventSource'
import type { RoomAffiliation } from './types/room'
import type { ConversationTarget } from './e2ee/types'
import type { DisplayedMarkerFetchResult } from './modules/Mds'
import type { SyncedConversation } from './modules/ConversationSync'

/** A message as the catch-up entry points read it: position, not content. */
export interface ArchivePosition {
  timestamp?: Date
  stanzaId?: string
}

/** Options shared by the two history catch-up entry points. */
export interface CatchUpHistoryOptions {
  sessionStartTime?: number
  stitchReadPointer?: boolean
}

/** The archive operations background sync and the history side effects drive. */
export interface MamSideEffectHost {
  catchUpAllConversations(options?: {
    concurrency?: number
    exclude?: string | null
    sessionStartTime?: number
  }): Promise<void>
  catchUpConversationHistory(
    conversationId: string,
    messages: ArchivePosition[],
    options?: CatchUpHistoryOptions
  ): Promise<void>
  catchUpRoom(roomJid: string, sessionStartTime?: number): Promise<void>
  catchUpRoomHistory(
    roomJid: string,
    messages: ArchivePosition[],
    options?: CatchUpHistoryOptions
  ): Promise<void>
  discoverNewConversationsFromRoster(options?: { concurrency?: number }): Promise<void>
  fetchPreviewForRoom(roomJid: string): Promise<void>
  refreshArchivedConversationPreviews(options?: { concurrency?: number }): Promise<void>
}

/** The MUC operation background sync drives. */
export interface MucSideEffectHost {
  queryRoomMembers(
    roomJid: string
  ): Promise<Array<{ jid: string; nick?: string; affiliation: RoomAffiliation }>>
}

/** The XEP-0490 operations the read-marker side effect drives. */
export interface MdsSideEffectHost {
  fetchAllDisplayedResult(timeoutMs?: number): Promise<DisplayedMarkerFetchResult>
  publishDisplayed(conversationJid: string, stanzaId: string, stanzaIdBy: string): Promise<void>
  retractDisplayed(conversationJid: string): Promise<void>
}

/** The discovery probe background sync runs once per session. */
export interface DiscoverySideEffectHost {
  discoverMAMSearchCapability(): Promise<void>
}

/** The XEP-0489 publish the conversation-sync side effect drives. */
export interface ConversationSyncSideEffectHost {
  publishConversations(conversations: SyncedConversation[]): Promise<void>
}

/**
 * The encryption capability probe background sync warms.
 *
 * Deliberately one method rather than the whole `E2EEManager`: the warm-up is
 * the only thing a side effect does with encryption, and widening this would
 * hand every side effect the key material surface.
 */
export interface E2EEWarmupHost {
  canEncryptTo(target: ConversationTarget): Promise<boolean>
}

/**
 * The client surface every store-based side effect is written against.
 *
 * @category Internal
 */
export interface SideEffectHost extends SDKEventSource, ClientEventSource {
  isConnected(): boolean
  /** Re-runs decryption for payloads stashed while the key was unavailable. */
  retryPendingDecrypts(): Promise<number>
  /** Null until an identity is logged in — every caller must handle that. */
  readonly e2ee: E2EEWarmupHost | null
  readonly mam: MamSideEffectHost
  readonly muc: MucSideEffectHost
  readonly mds: MdsSideEffectHost
  readonly discovery: DiscoverySideEffectHost
  readonly conversationSync: ConversationSyncSideEffectHost
}
