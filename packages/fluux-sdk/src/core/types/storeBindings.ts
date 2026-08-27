/**
 * The state surface {@link XMPPClient} writes through.
 *
 * This is a PORT: it is declared here, in the SDK's leaf type layer, in terms
 * of domain types only. Deriving it from the Zustand stores with
 * `Pick<ChatState, …>` would make the contract a shadow of one particular
 * implementation and pull every store into the core's dependency graph.
 *
 * The conformance direction runs the other way round: each store proves it
 * satisfies its interface here (`stores/storeBindingsConformance.ts`), and the
 * key lists in `core/storeBindingKeys.ts` are checked against these interfaces
 * rather than against the store state. Adding a method to the client surface
 * means declaring it here first, then implementing it in the store — the
 * compiler rejects either half on its own.
 *
 * @packageDocumentation
 * @module Types/StoreBindings
 */

import type { ConnectionStatus, ConnectionMethod } from './connection'
import type { ServerInfo } from './discovery'
import type { HttpUploadService } from './upload'
import type { WebPushService, WebPushStatus } from './webpush'
import type { Contact, PresenceShow, ProfileDetails } from './roster'
import type { Message, Conversation } from './chat'
import type { Room, RoomMessage, RoomOccupant, RoomAffiliation } from './room'
import type { SystemNotificationType } from './events'
import type { AdminCommand, AdminSession, ServerStats } from './admin'
import type {
  HistoryQueryState,
  HistoryQueryDirection,
  CoverageRecord,
  MergeArchiveExtras,
  PageInfo,
} from './pagination'
import type { GetMessagesOptions } from '../../utils/messageCache'

/**
 * Connection-store surface the client writes to.
 *
 * @category Internal
 */
export interface ConnectionBindings {
  // Actions - state setters only (connect/disconnect moved to hooks)
  setStatus: (status: ConnectionStatus) => void
  setIsVerifying: (isVerifying: boolean) => void
  setJid: (jid: string | null) => void
  setError: (error: string | null) => void
  setReconnectState: (attempt: number, reconnectTargetTime: number | null) => void
  setServerInfo: (info: ServerInfo | null) => void
  setConnectionMethod: (method: ConnectionMethod | null) => void
  setAuthMechanism: (mechanism: string | null) => void
  setAuthMethod: (method: 'fast-token' | 'password' | null) => void

  // Own profile actions
  setOwnAvatar: (avatar: string | null, hash?: string | null) => void
  setOwnNickname: (nickname: string | null) => void
  setOwnProfileDetails: (details: ProfileDetails | null) => void
  updateOwnResource: (resource: string, show: PresenceShow | null, priority: number, status?: string, lastInteraction?: Date, client?: string) => void
  removeOwnResource: (resource: string) => void
  clearOwnResources: () => void

  // HTTP Upload actions
  setHttpUploadService: (service: HttpUploadService | null) => void

  // Web Push actions
  setWebPushStatus: (status: WebPushStatus) => void
  setWebPushServices: (services: WebPushService[]) => void

  // ----- State getters -----

  getStatus: () => ConnectionStatus
  getOwnNickname: () => string | null
  getJid: () => string | null
  getHttpUploadService: () => HttpUploadService | null
  getWebPushServices: () => WebPushService[]
  getWebPushEnabled: () => boolean
  /** Server info getter (for MAM support detection). */
  getServerInfo?: () => ServerInfo | null
}

/**
 * 1:1 conversation surface the client writes to, plus the read seams
 * MAM catch-up and deferred decrypt need.
 *
 * @category Internal
 */
export interface ChatBindings {
  addMessage: (msg: Message) => void
  addConversation: (conv: Conversation) => void
  updateConversationName: (id: string, name: string) => void
  hasConversation: (id: string) => boolean
  setTyping: (conversationId: string, jid: string, isTyping: boolean) => void
  updateReactions: (conversationId: string, messageId: string, reactorJid: string, emojis: string[]) => void
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void

  /**
   * Hard-remove a message from the conversation, the search index, and the
   * durable cache. Used when a stanza that was provisionally stored as a
   * message turns out not to be one — e.g. a deferred-decrypted bodiless
   * signal (XEP-0444 reaction) whose "[could not decrypt]" placeholder must
   * disappear once the real reaction is applied to its target.
   */
  removeMessage: (conversationId: string, messageId: string) => void

  /**
   * Reconcile a non-active conversation's unread count against the durable
   * archive: a coverage-gated cursor count from the effective read
   * boundary, plus the transient (`noLocalStore`) overlay, capped at 999 —
   * never a bounded resident/cache slice. Commits only on an exact
   * derivation; every uncertain case (un-migrated/pending read state,
   * pointerless-with-count, incomplete coverage) leaves the last TRUSTED
   * count untouched rather than writing a provisional one. `mentionsCount` is
   * never written here (see `readState.ts`'s `RecomputeOutcome` doc). Latest-
   * wins across concurrent recounts for the same conversation.
   *
   * Called after a deferred-decrypt drops a bodiless-signal placeholder
   * (reaction/retraction) that had been provisionally counted as unread —
   * {@link removeMessage} clears the row but not the phantom badge it left
   * behind — and after any transient-overlay mutation that reports a change.
   *
   * No-op for the active conversation by default: most triggers (message
   * arrival, deferred-decrypt, transient-overlay changes) are already
   * reconciled for the active conversation by their own synchronous path
   * (`onMessageReceived`'s live-edge convergence), so racing an async
   * archive recompute against that would be redundant at best. The one
   * exception is `{ allowActive: true }`: a remote XEP-0490 marker can advance
   * the ACTIVE entity's read position without that convergence path running at
   * all, and activation writes no unconditional zero, so nothing
   * else re-derives the active entity's count after such an advance — pass
   * `allowActive: true` ONLY from that trigger.
   */
  recomputeUnreadForConversation: (conversationId: string, options?: { allowActive?: boolean }) => Promise<void>

  /**
   * XEP-0424: apply an incoming retraction, deferring it when its target is not
   * resident. Applies immediately (and writes through to the durable cache) when
   * the target is in the window; otherwise records it and replays it the moment
   * the target arrives live or loads from the cache. Only the message's own
   * author can retract it — a mismatched actor is dropped, never tombstoned.
   *
   * @param actorJid - Bare JID the retraction came from.
   */
  recordPendingRetraction: (conversationId: string, targetId: string, actorJid: string) => void
  getMessage: (conversationId: string, messageId: string) => Message | undefined
  triggerAnimation: (conversationId: string, animation: string, senderName?: string) => void

  // XEP-0313: MAM (Message Archive Management)
  setMAMLoading: (conversationId: string, isLoading: boolean) => void
  setMAMError: (conversationId: string, error: string | null) => void

  /**
   * Merge MAM messages into conversation and update query state.
   * @param conversationId - Conversation JID
   * @param messages - Messages from MAM query
   * @param page - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeMAMMessages: (conversationId: string, messages: Message[], page: PageInfo, complete: boolean, direction: HistoryQueryDirection, isFetchLatest?: boolean, preserveGapMarker?: boolean, extras?: MergeArchiveExtras) => void
  getMAMQueryState: (conversationId: string) => HistoryQueryState
  resetMAMStates: () => void

  /** Persisted contiguous-with-live coverage record, if any. */
  getConversationCoverage: (conversationId: string) => CoverageRecord | undefined

  /** Drop the coverage record; with `ifBottomId`, only when it matches
   *  `bottomId` (purge-event guard — the anchor is known gone). */
  clearConversationCoverage: (conversationId: string, ifBottomId?: string) => void

  /**
   * Update only the lastMessage preview for a conversation without affecting the messages array.
   * Used for background preview refresh to sync sidebar with server state after being offline.
   * @param conversationId - Conversation JID
   * @param lastMessage - The most recent message from MAM
   */
  updateLastMessagePreview: (conversationId: string, lastMessage: Message) => void

  /**
   * Apply an in-place content update to a conversation's lastMessage preview,
   * but only when the preview IS the referenced message (matched across the
   * XEP-0359 id tiers). Used by the durable-cache deferred-decrypt pass: when a
   * conversation's preview message is decrypted while its messages aren't loaded
   * in memory, {@link updateMessage} can't reach it and the timestamp-gated
   * {@link updateLastMessagePreview} won't replace a same-timestamp message — so
   * the sidebar would keep showing "[OpenPGP-encrypted message]". This refreshes
   * the preview's content (body/securityContext/attachment/encryptedPayload)
   * without touching the messages array.
   * @param conversationId - Conversation JID
   * @param messageId - id / stanzaId / originId of the decrypted message
   * @param updates - Partial content to merge into the preview message
   */
  refreshLastMessageContent: (conversationId: string, messageId: string, updates: Partial<Message>) => void

  // IndexedDB message loading. `oldest` flips the latest-N default to the
  // OLDEST-N ascending slice (true cache bottom) — pointer-walk seeding; use
  // with `peek` (an oldest slice must never become the resident window).
  loadMessagesFromCache: (conversationId: string, options?: { limit?: number; before?: Date; peek?: boolean; oldest?: boolean }) => Promise<Message[]>

  /**
   * Epoch ms of the conversation's persisted last-known message (the entity
   * preview), or undefined. Used as a last-resort forward catch-up cursor so a
   * persisted conversation whose message cache is empty this run still
   * forward-fills its offline gap instead of a `before:''` fetch-latest.
   */
  getConversationLastTimestamp: (conversationId: string) => number | undefined
  archiveConversation: (id: string) => void
  unarchiveConversation: (id: string) => void

  /** Batch-add/update conversations from server sync in a single state update. */
  mergeServerConversations: (convs: Array<{ id: string; name: string; type: 'chat' | 'groupchat'; archived: boolean }>) => void

  // ----- Composite getters -----

  /** Every non-archived conversation with its in-memory messages, for MAM catch-up. */
  getAllConversations: () => Array<{ id: string; messages: Message[] }>
  /** Persisted forward-gap boundary for automatic catch-up recovery. */
  getConversationGapStart?: (conversationId: string) => number | undefined
  /**
   * Archive id of the recorded gap's coverage edge (GapInterval.startId) —
   * id-exact resume cursor, preferred over the timestamp fallback above.
   */
  getConversationGapStartId?: (conversationId: string) => string | undefined
  /**
   * Archive id of the recorded gap's contiguous-coverage bottom (GapInterval.endId) —
   * the proven upper edge of the contiguous-from-live region.
   */
  getConversationGapEndId?: (conversationId: string) => string | undefined
  /**
   * True when a disjoint fetch-latest flagged the contiguous coverage BOTTOM
   * as unproven (no gap edge, no resident boundary) — the seeder must not
   * trust cache-oldest as contiguous-to-live.
   */
  getConversationCoverageUnproven?: (conversationId: string) => boolean | undefined
  /**
   * XEP-0490 stanza-id of the remote read position, kept unresolved when it
   * can't be matched locally — seeds a forward `after` catch-up on an
   * empty-cache new device.
   */
  getConversationPendingStanzaId?: (conversationId: string) => string | undefined
  /**
   * Currently ACTIVE conversation id (null when none). Re-checked at every
   * Phase B iteration of the pointer-stitch walk: backward pages into the
   * active resident window would keep-oldest-evict its live edge.
   */
  getActiveConversationId?: () => string | null
  /** Smart MAM: archived conversation preview refresh. */
  getArchivedConversations?: () => Array<{ id: string; messages: Message[] }>
  getLastMessage?: (conversationId: string) => Message | undefined
  /**
   * Every stored conversation (archived INCLUDED) with its in-memory
   * messages. Read seam for the deferred-decrypt engine, which must retry
   * pending encrypted payloads regardless of archive state — unlike
   * getAllConversations, which returns only the active set.
   */
  getAllStoredMessages: () => Array<{ id: string; messages: Message[] }>
  /**
   * In-memory messages for a single conversation (archived included). Read
   * seam for peer-scoped deferred-decrypt retry on a PEP key change.
   */
  getConversationMessages: (conversationId: string) => Message[]
  /**
   * Every conversation whose sidebar preview still carries an
   * `encryptedPayload` (archived INCLUDED). Read seam for the deferred-decrypt
   * engine's preview-level heal: a preview can hold ciphertext that no message
   * store reaches (its message evicted, already decrypted in IndexedDB, or set
   * preview-only) — so it must be re-decrypted straight from its own stash.
   */
  getEncryptedPreviews?: () => Array<{ conversationId: string; lastMessage: Message }>
}

/**
 * Roster surface the client writes to.
 *
 * @category Internal
 */
export interface RosterBindings {
  // Actions
  setContacts: (contacts: Contact[]) => void
  addOrUpdateContact: (contact: Contact) => void
  updateContact: (jid: string, update: Partial<Contact>) => void
  updatePresence: (
    fullJid: string,
    show: PresenceShow | null,
    priority: number,
    statusMessage?: string,
    lastInteraction?: Date,
    client?: string
  ) => void
  removePresence: (fullJid: string) => void
  setPresenceError: (jid: string, error: string) => void
  updateAvatar: (jid: string, avatar: string | null, avatarHash?: string) => void
  removeContact: (jid: string) => void
  hasContact: (jid: string) => boolean
  getContact: (jid: string) => Contact | undefined
  getOfflineContacts: () => Contact[]
  sortedContacts: () => Contact[]
  resetAllPresence: () => void
}

/**
 * XMPP console surface (raw packet and event tap).
 *
 * @category Internal
 */
export interface ConsoleBindings {
  addPacket: (direction: 'incoming' | 'outgoing', xml: string) => void
  addEvent: (message: string, category?: 'connection' | 'error' | 'sm' | 'presence' | 'e2ee') => void
}

/**
 * Pending-event surface (subscription requests, invitations, stranger messages).
 *
 * @category Internal
 */
export interface EventsBindings {
  // Actions
  addSubscriptionRequest: (from: string) => void
  removeSubscriptionRequest: (from: string) => void
  addStrangerMessage: (from: string, body: string) => void
  removeStrangerMessages: (from: string) => void
  addMucInvitation: (roomJid: string, from: string, reason?: string, password?: string, isDirect?: boolean, isQuickChat?: boolean) => void
  removeMucInvitation: (roomJid: string) => void
  addSystemNotification: (type: SystemNotificationType, title: string, message: string) => void
  clearSystemNotifications: () => void
}

/**
 * MUC surface the client writes to, plus the read seams MAM catch-up
 * and deferred decrypt need.
 *
 * @category Internal
 */
export interface RoomBindings {
  // Actions
  addRoom: (room: Room, resident?: RoomMessage[]) => void
  updateRoom: (roomJid: string, update: Partial<Room>) => void
  removeRoom: (roomJid: string) => void
  setRoomJoined: (roomJid: string, joined: boolean) => void
  addOccupant: (roomJid: string, occupant: RoomOccupant) => void
  batchAddOccupants: (roomJid: string, occupants: RoomOccupant[]) => void
  removeOccupant: (roomJid: string, nick: string) => void
  setSelfOccupant: (roomJid: string, occupant: RoomOccupant) => void

  /** Batch variant of updateOccupantAvatar — one state update for N resolved avatars (e.g. after joining a large room) */
  updateOccupantAvatars: (roomJid: string, updates: Array<{ nick?: string; occupantId?: string; avatar: string | null; avatarHash: string | null }>) => void
  getRoom: (roomJid: string) => Room | undefined

  // Message actions
  addMessage: (roomJid: string, message: RoomMessage, options?: {
    incrementUnread?: boolean
    incrementMentions?: boolean
  }) => void
  updateReactions: (roomJid: string, messageId: string, reactorNick: string, emojis: string[]) => void
  updateMessage: (roomJid: string, messageId: string, updates: Partial<RoomMessage>) => void

  /**
   * XEP-0424: apply an incoming retraction, deferring it when its target is not
   * resident. Applies immediately (and writes through to the durable cache) when
   * the target is in the window; otherwise records it and replays it the moment
   * the target arrives live or loads from the cache. Only the message's own
   * author can retract it — a mismatched actor is dropped, never tombstoned.
   *
   * @param actorJid - Full room JID (room@service/nick) the retraction came from.
   * @param actorOccupantId - XEP-0421 occupant-id when advertised; preferred over the nick.
   */
  recordPendingRetraction: (roomJid: string, targetId: string, actorJid: string, actorOccupantId?: string) => void
  getMessage: (roomJid: string, messageId: string) => RoomMessage | undefined

  /**
   * Reconcile a non-active room's unread count against the durable archive
   *: a coverage-gated cursor count from the effective read boundary,
   * plus the transient (`noLocalStore`) overlay, capped at 999 — never a
   * bounded resident/cache slice. Commits only on an exact derivation; every
   * uncertain case (pointerless-with-count, incomplete coverage) leaves the
   * last TRUSTED count untouched rather than writing a provisional one.
   * `mentionsCount` is never written here (see `readState.ts`'s
   * `RecomputeOutcome` doc) — rooms keep it on the live `+1` path. Latest-wins
   * across concurrent recounts for the same room.
   *
   * Called after a deferred-decrypt resolves an encrypted room message (the
   * badge it may have provisionally inflated needs reconciling once the
   * message settles), after a forward MAM merge past the floor, after a
   * remote read-marker advance, at cold-start rehydrate, and after any
   * transient-overlay mutation that reports a change.
   *
   * No-op for the active room by default: most triggers are already
   * reconciled for the active room by their own synchronous path
   * (`onMessageReceived`'s live-edge convergence). The one exception
   * is `{ allowActive: true }`: a remote XEP-0490 marker can advance the
   * ACTIVE room's read position without that convergence path running at
   * all, and activation writes no unconditional zero, so nothing re-derives the
   * active room's count after such an advance — pass `allowActive: true`
   * ONLY from that trigger.
   */
  recomputeUnreadForRoom: (roomJid: string, options?: { allowActive?: boolean }) => Promise<void>
  markAsRead: (roomJid: string) => void
  getActiveRoomJid: () => string | null
  setTyping: (roomJid: string, nick: string, isTyping: boolean) => void

  // Bookmark actions
  setBookmark: (roomJid: string, bookmark: { name: string; nick: string; autojoin?: boolean; password?: string; notifyAll?: boolean }) => void
  removeBookmark: (roomJid: string) => void

  /** Whether the user has already acknowledged this room's real-JID exposure. */
  isNonAnonymousRoomAcknowledged: (roomJid: string) => boolean

  // Notification settings
  setNotifyAll: (roomJid: string, notifyAll: boolean, persistent?: boolean) => void

  // Computed
  joinedRooms: () => Room[]

  /**
   * Epoch ms of the room's persisted last-known message (the entity preview),
   * or undefined. Used as a last-resort forward catch-up cursor so a persisted
   * room whose message cache is empty this run still forward-fills its offline
   * gap instead of a `before:''` fetch-latest.
   */
  getRoomLastTimestamp: (roomJid: string) => number | undefined

  // Easter egg animations
  triggerAnimation: (roomJid: string, animation: string, senderName?: string) => void

  // MAM state management (XEP-0313 for MUC rooms)
  setRoomMAMLoading: (roomJid: string, isLoading: boolean) => void
  setRoomMAMError: (roomJid: string, error: string | null) => void

  /**
   * Merge MAM messages into room and update query state.
   * @param roomJid - Room JID
   * @param messages - Messages from MAM query
   * @param page - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeRoomMAMMessages: (roomJid: string, messages: RoomMessage[], page: PageInfo, complete: boolean, direction: HistoryQueryDirection, preserveGapMarker?: boolean, isFetchLatest?: boolean, extras?: MergeArchiveExtras) => void
  getRoomMAMQueryState: (roomJid: string) => HistoryQueryState
  resetRoomMAMStates: () => void

  /** Persisted contiguous-with-live coverage record, if any. */
  getRoomCoverage: (roomJid: string) => CoverageRecord | undefined

  /** Drop the coverage record; with `ifBottomId`, only when it matches
   *  `bottomId` (purge-event guard — the anchor is known gone). */
  clearRoomCoverage: (roomJid: string, ifBottomId?: string) => void

  /** Reset joined/isJoining for all rooms (called on fresh session after reconnect) */
  markAllRoomsNotJoined: () => void

  /** Update only the lastMessage preview without affecting message history */
  updateLastMessagePreview: (roomJid: string, lastMessage: RoomMessage) => void

  // IndexedDB cache loading. `oldest` flips the latest-N default to the
  // OLDEST-N ascending slice (true cache bottom) — pointer-walk seeding; use
  // with `peek` (an oldest slice must never become the resident window).
  loadMessagesFromCache: (roomJid: string, options?: GetMessagesOptions & { peek?: boolean; oldest?: boolean }) => Promise<RoomMessage[]>

  /** Load only the latest message from cache for sidebar preview (doesn't modify messages array) */
  loadPreviewFromCache: (roomJid: string) => Promise<RoomMessage | null>

  /**
   * Populate sidebar-ordering previews for all bookmarked/joined rooms from the
   * durable IndexedDB cache in a SINGLE batched store write.
   *
   * At launch the room list is rebuilt from bookmarks with no `lastMessage`, so
   * every room sorts at epoch 0 until its per-room preview lands (on join, or the
   * delayed catch-up) - leaving the sidebar mis-ordered and making the active room
   * "jump" to the top once opened. This reads each room's newest cached message in
   * parallel (network-free) and applies all previews at once, so the sidebar
   * re-sorts a single time instead of once per room. Never downgrades a fresher
   * preview, so it is safe alongside the join / catch-up preview paths.
   */
  hydratePreviewsFromCache: () => Promise<void>
  mergeRoomMembers: (roomJid: string, members: Array<{ jid: string; nick?: string; affiliation: RoomAffiliation }>, contactAvatarLookup?: (jid: string) => string | null) => void

  /**
   * Apply a single affiliation change to the cached `affiliatedMembers` list (XEP-0045 admin set).
   * owner/admin/member upsert the member; none/outcast remove them. Keeps the occupant
   * sidebar's offline-member list in sync after a change without a full member re-query.
   */
  updateMemberAffiliation: (roomJid: string, userJid: string, affiliation: RoomAffiliation) => void

  // ----- Composite getters -----

  /** Persisted forward-gap boundary for automatic catch-up recovery. */
  getRoomGapStart?: (roomJid: string) => number | undefined
  /**
   * Archive id of the recorded gap's coverage edge (GapInterval.startId) —
   * id-exact resume cursor, preferred over the timestamp fallback above.
   */
  getRoomGapStartId?: (roomJid: string) => string | undefined
  /**
   * Archive id of the recorded gap's contiguous-coverage bottom (GapInterval.endId) —
   * the proven upper edge of the contiguous-from-live region.
   */
  getRoomGapEndId?: (roomJid: string) => string | undefined
  /**
   * True when a disjoint fetch-latest flagged the contiguous coverage BOTTOM
   * as unproven (no gap edge, no resident boundary) — the seeder must not
   * trust cache-oldest as contiguous-to-live.
   */
  getRoomCoverageUnproven?: (roomJid: string) => boolean | undefined
  /**
   * XEP-0490 stanza-id of the remote read position, kept unresolved when it
   * can't be matched locally — seeds a forward `after` catch-up on an
   * empty-cache new device.
   */
  getRoomPendingStanzaId?: (roomJid: string) => string | undefined
  /**
   * Every room with its in-memory runtime messages. Read seam for the
   * deferred-decrypt engine (mirrors chat.getAllStoredMessages for MUC).
   */
  getAllRoomMessages: () => Array<{ jid: string; messages: RoomMessage[] }>
}

/**
 * Admin (XEP-0133) surface the client writes to.
 *
 * @category Internal
 */
export interface AdminBindings {
  // Actions
  setIsAdmin: (isAdmin: boolean) => void
  setCommands: (commands: AdminCommand[]) => void
  setCurrentSession: (session: AdminSession | null) => void
  setIsDiscovering: (loading: boolean) => void
  setIsExecuting: (loading: boolean) => void
  setMucServiceJid: (jid: string | null) => void
  setServerStats: (stats: ServerStats | null) => void
  setVhosts: (vhosts: string[]) => void
  setSelectedVhost: (vhost: string | null) => void
  reset: () => void

  // ----- State getters -----

  getCommands: () => AdminCommand[]
  getCurrentSession: () => AdminSession | null
  getMucServiceJid: () => string | null
  selectedVhost: string | null
}

/**
 * Blocklist (XEP-0191) surface the client writes to.
 *
 * @category Internal
 */
export interface BlockingBindings {
  // Actions
  setBlocklist: (jids: string[]) => void
  addBlockedJids: (jids: string[]) => void
  removeBlockedJids: (jids: string[]) => void
  clearBlocklist: () => void
  isBlocked: (jid: string) => boolean
  getBlockedJids: () => string[]
}

/**
 * Store bindings interface for injecting store methods into XMPPClient.
 *
 * @internal
 * This interface is used internally by XMPPProvider to bind Zustand stores
 * to the XMPP client. Application code should use the React hooks instead.
 *
 * @category Internal
 */
export interface StoreBindings {
  connection: ConnectionBindings
  chat: ChatBindings
  roster: RosterBindings
  console: ConsoleBindings
  events: EventsBindings
  room: RoomBindings
  admin: AdminBindings
  blocking: BlockingBindings
}
