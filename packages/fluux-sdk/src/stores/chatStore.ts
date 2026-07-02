import { createStore } from 'zustand/vanilla'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import type { Message, Conversation, ConversationEntity, ConversationMetadata, MAMQueryState, RSMResponse } from '../core'
import { setTypingTimeout, clearTypingTimeout, clearAllTypingTimeouts } from './typingTimeout'
import { findMessageById, findMessageIndexById } from '../utils/messageLookup'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import * as mamState from './shared/mamState'
import type { MAMQueryDirection } from './shared/mamState'
import { computeGapEnd, syncGap, type GapInterval } from './shared/mamGap'
import * as draftState from './shared/draftState'
import { buildMessageKeySet, isMessageDuplicate, sortMessagesByTimestamp, trimMessages, trimMessagesKeepOldest, prependOlderMessages, mergeAndProcessMessages, backfillArchiveIds } from './shared/messageArrayUtils'
import { isPreviewableMessage, findLastPreviewableMessage, shouldReplaceLastMessage, isResolvedSamePreview } from './shared/lastMessageUtils'
import * as notifState from './shared/notificationState'
import { markerDebugLog } from '../utils/markerDebug'
import { connectionStore } from './connectionStore'
import { buildScopedStorageKey } from '../utils/storageScope'

// Maximum messages to keep in memory per conversation (display buffer)
// Purely an in-memory bound (messages live in IndexedDB, not localStorage). Before view
// virtualization this mainly capped DOM nodes; now the message list windows its DOM
// regardless of array size, so the limit is raised to allow real scroll-back — at the old
// 1000 a prepend at the cap trimmed the just-loaded older batch straight back off.
// FUTURE: the goal is to remove this cap entirely (unlimited scroll-back — "go back anywhere
// in time"). Removal needs an estimate strategy that keeps getTotalSize/scrollbar accurate on
// a huge mostly-estimated array (a running-average estimate was tried but collapsed — see
// tanstackMessageVirtualizer); Phase-1 conversation-switch eviction bounds RAM. 5000 is interim.
const RESIDENT_WINDOW_SIZE = 5000
const STORAGE_KEY_BASE = 'xmpp-chat-storage'

/**
 * Stable empty array reference to prevent infinite re-renders.
 * When activeMessages() returns empty results, it should return this
 * constant instead of creating a new [] instances each time.
 */
const EMPTY_MESSAGE_ARRAY: Message[] = []
const EMPTY_CONVERSATION_IDS: string[] = []

/**
 * Conversation ids (active or archived) sorted by last activity, most recent
 * first. Powers the sidebar's id-only subscription: the list re-renders only on
 * reorder/membership change, not on per-conversation metadata churn. Returns a
 * referentially-stable empty array so useShallow consumers never re-render when
 * the list is empty.
 */
function conversationIdsByActivity(
  conversations: Map<string, Conversation>,
  archivedConversations: Set<string>,
  archived: boolean,
): string[] {
  const entries: Array<[string, number]> = []
  for (const [id, c] of conversations) {
    if (archivedConversations.has(id) !== archived) continue
    const ts = c.lastMessage?.timestamp
    entries.push([id, ts instanceof Date ? ts.getTime() : ts ? new Date(ts).getTime() : 0])
  }
  if (entries.length === 0) return EMPTY_CONVERSATION_IDS
  entries.sort((a, b) => b[1] - a[1])
  return entries.map((e) => e[0])
}

// Monotonic token so a slow cache read from a superseded activateConversation
// call can't overwrite a newer activation when it finally resolves
let activationToken = 0

// Conversations whose pending XEP-0490 (Message Displayed Synchronization) read marker has
// already been consumed for divider positioning THIS session. XEP-0490 markers are broadcast
// live over PEP, so once we fold the synced read position on the first open of a conversation
// this session, later opens must NOT re-check/re-fold it — the live `read:displayed-synced`
// notifies keep loaded conversations current, and re-folding on every open lets a synced read
// position reposition the divider on each return. Cleared on reset() (logout/account switch);
// module-level so it is naturally per app session.
const mdsConsumedThisSession = new Set<string>()

function getScopedStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(STORAGE_KEY_BASE, jid)
}

/**
 * Merge a batch of cached messages into a conversation's resident array, returning the partial
 * state update (or `null` when every cached message is already resident). Shared by
 * {@link ChatState.loadMessagesFromCache} and {@link ChatState.loadMessagesAroundFromCache}: both
 * filter duplicates, merge/sort/trim, and refresh the sidebar preview to the newest previewable
 * message (healing a stuck encrypted-fallback placeholder). The only difference between the two
 * callers is WHICH cache slice they fetch (latest-N vs the slice around an anchor).
 */
function mergeCachedChatMessages(
  state: ChatState,
  conversationId: string,
  cachedMessages: Message[]
): Pick<ChatState, 'messages' | 'conversationMeta' | 'conversations'> | { messages: ChatState['messages'] } | null {
  const existingMessages = state.messages.get(conversationId) || []

  const existingKeySet = buildMessageKeySet(existingMessages, getChatMessageKeys)
  const newMessages = cachedMessages.filter(
    (m) => !isMessageDuplicate(m, existingKeySet, getChatMessageKeys)
  )

  if (newMessages.length === 0) return null

  const merged = sortMessagesByTimestamp([...existingMessages, ...newMessages])
  const trimmed = trimMessages(merged, RESIDENT_WINDOW_SIZE)

  const newMessagesMap = new Map(state.messages)
  newMessagesMap.set(conversationId, trimmed)

  // Update lastMessage with the newest previewable message after merge/sort, skipping bodiless
  // signal placeholders. Opening a conversation whose stored preview is a stuck placeholder heals
  // it here: a real cached message supersedes the placeholder even though the placeholder's
  // timestamp is newer.
  const lastMessage = findLastPreviewableMessage(trimmed)
  const meta = state.conversationMeta.get(conversationId)
  const conv = state.conversations.get(conversationId)
  if (
    meta && conv && lastMessage &&
    (shouldReplaceLastMessage(meta.lastMessage, lastMessage) ||
      isResolvedSamePreview(meta.lastMessage, lastMessage))
  ) {
    const newMeta = new Map(state.conversationMeta)
    newMeta.set(conversationId, { ...meta, lastMessage })
    const newConversations = new Map(state.conversations)
    newConversations.set(conversationId, { ...conv, lastMessage })
    return { messages: newMessagesMap, conversationMeta: newMeta, conversations: newConversations }
  }

  return { messages: newMessagesMap }
}

function getLegacyStorageKey(): string {
  return STORAGE_KEY_BASE
}

/**
 * Extract deduplication keys for a chat message.
 * Uses three tiers of identity (XEP-0359):
 * - stanzaId: server-assigned canonical ID (most reliable, from MAM/server)
 * - originId: sender-assigned stable ID (survives archiving, for echo dedup)
 * - from+id: stanza attribute combo (fallback for legacy/bridge messages)
 */
function getChatMessageKeys(m: Message): string[] {
  const keys: string[] = []
  if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
  if (m.originId) keys.push(`originId:${m.originId}`)
  keys.push(`from:${m.from}:id:${m.id}`)
  return keys
}

/**
 * Chat state interface for 1:1 conversations.
 *
 * Manages direct message conversations, message history, typing indicators,
 * drafts, and MAM (Message Archive Management) state. Conversations and messages
 * are persisted to localStorage for offline access.
 *
 * @remarks
 * Most applications should use the `useChat` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * The store separates entity data (stable) from metadata (frequently-changing)
 * to enable fine-grained subscriptions:
 * - `conversationEntities`: Rarely changes (id, name, type)
 * - `conversationMeta`: Changes often (unreadCount, lastMessage, etc.)
 * - `conversations`: Combined view for backward compatibility
 *
 * @example Direct store access (advanced)
 * ```ts
 * import { useChatStore } from '@fluux/sdk'
 *
 * // Get all conversations (combined entity + metadata)
 * const conversations = useChatStore.getState().conversations
 *
 * // Subscribe to metadata only (sidebar optimization)
 * useChatStore.subscribe(
 *   (state) => state.conversationMeta,
 *   (meta) => console.log('Metadata changed')
 * )
 * ```
 *
 * @category Stores
 */
interface ChatState {
  // Separated entity/metadata for fine-grained subscriptions
  conversationEntities: Map<string, ConversationEntity>
  conversationMeta: Map<string, ConversationMetadata>
  // Combined view for backward compatibility (computed from entities + meta)
  conversations: Map<string, Conversation>
  messages: Map<string, Message[]>
  activeConversationId: string | null
  // True while activateConversation() is hydrating a conversation's cache before
  // it becomes active. Lets the UI hold a neutral loading surface during the async
  // gap instead of flashing the "nothing selected" empty state on tab switch.
  activationPending: boolean
  // Archived conversation IDs - hidden from main list but reappear on new activity
  archivedConversations: Set<string>
  // Typing indicators: conversationId -> Set of JIDs currently typing (ephemeral, not persisted)
  typingStates: Map<string, Set<string>>
  // Easter egg animation state (ephemeral, not persisted)
  activeAnimation: { conversationId: string; animation: string } | null
  // Message drafts per conversation (persisted to localStorage)
  drafts: Map<string, string>
  // XEP-0313: MAM query state per conversation (ephemeral, not persisted)
  mamQueryStates: Map<string, MAMQueryState>
  // Persisted history-gap intervals per conversation (in the account-scoped chat
  // blob; drives the gap marker). Parity with roomStore.roomGaps.
  conversationGaps: Map<string, GapInterval>
  // Target message to scroll to after navigation (ephemeral, not persisted)
  targetMessageId: string | null
  // Session-only new-message divider per conversation (jid -> messageId). Derived
  // at activation from lastSeenMessageId; never persisted (absent from serializeState).
  firstNewMessageMarkers: Map<string, string>
  // Sliding window: whether a conversation's resident `messages` array is at the live
  // edge (holds the newest history) so an incoming live message can be appended.
  // Semantics: ABSENT or `true` = at the live edge (append); only an explicit `false`
  // gates the append in addMessage. Load-older that evicts the newest tail sets `false`;
  // (re)loading the latest window sets it back true (or deletes the entry).
  // EPHEMERAL: never persisted (absent from partialize) — on reload the resident array
  // is rebuilt from the newest window, so a stale `false` would wrongly gate live
  // messages. This is why the flag lives here and NOT in the persisted conversationMeta.
  windowAtLiveEdge: Map<string, boolean>

  // Computed
  activeConversation: () => Conversation | null
  activeMessages: () => Message[]
  isArchived: (id: string) => boolean
  /** Get all non-archived conversations (visible in sidebar) */
  activeConversations: () => Conversation[]
  /**
   * Active (non-archived) conversation ids, sorted by last activity (most recent
   * first). Referentially stable under useShallow when order/membership is
   * unchanged — the sidebar subscribes to this instead of the full conversation
   * objects, so presence churn and per-conversation metadata updates don't
   * re-render the whole list (each row self-subscribes by id).
   */
  conversationSidebarIds: () => string[]
  /** Archived conversation ids, sorted by last activity (most recent first). */
  archivedConversationSidebarIds: () => string[]

  // Actions
  setActiveConversation: (id: string | null) => void
  /**
   * Hydrate the conversation's recent history from the IndexedDB cache, then mark it active.
   *
   * Prefer this over `setActiveConversation` for user-facing activation: only live messages
   * are kept in memory, so activating without hydration renders an empty view (until a manual
   * scroll loads history) and computes the unread marker without historical context.
   * If a newer activation starts while the cache read is in flight, the stale one is dropped.
   * Passing `null` deactivates immediately without touching the cache.
   */
  activateConversation: (id: string | null) => Promise<void>
  addConversation: (conv: Conversation) => void
  updateConversationName: (id: string, name: string) => void
  deleteConversation: (id: string) => void
  addMessage: (msg: Message) => void
  markAsRead: (conversationId: string) => void
  clearFirstNewMessageId: (conversationId: string) => void
  updateLastSeenMessageId: (conversationId: string, messageId: string) => void
  /**
   * XEP-0490: apply a remote device's last-displayed marker. Advances
   * lastSeenMessageId forward-only by resolving the stanza-id to a local
   * message id; stores a pending high-water mark if not yet loaded.
   */
  applyRemoteDisplayed: (conversationId: string, stanzaId: string, messagesOverride?: Message[]) => void
  hasConversation: (id: string) => boolean
  archiveConversation: (id: string) => void
  unarchiveConversation: (id: string) => void
  /** Batch-add/update conversations from server sync in a single state update. */
  mergeServerConversations: (convs: Array<{ id: string; name: string; type: 'chat' | 'groupchat'; archived: boolean }>) => void
  setTyping: (conversationId: string, jid: string, isTyping: boolean) => void
  clearAllTyping: () => void
  updateReactions: (conversationId: string, messageId: string, reactorJid: string, emojis: string[]) => void
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void
  clearMessageStanzaId: (conversationId: string, stanzaId: string) => void
  /**
   * Hard-remove a message from the conversation, the search index, and the
   * durable cache. Used when a stanza that was provisionally stored as a
   * message turns out not to be one — e.g. a deferred-decrypted bodiless
   * signal (XEP-0444 reaction) whose "[could not decrypt]" placeholder must
   * disappear once the real reaction is applied to its target.
   */
  removeMessage: (conversationId: string, messageId: string) => void
  getMessage: (conversationId: string, messageId: string) => Message | undefined
  /**
   * Epoch ms of the conversation's persisted last-known message (the entity
   * preview), or undefined. Used as a last-resort forward catch-up cursor so a
   * persisted conversation whose message cache is empty this run still
   * forward-fills its offline gap instead of a `before:''` fetch-latest.
   */
  getConversationLastTimestamp: (conversationId: string) => number | undefined
  triggerAnimation: (conversationId: string, animation: string) => void
  clearAnimation: () => void
  // Draft management
  setDraft: (conversationId: string, text: string) => void
  getDraft: (conversationId: string) => string
  clearDraft: (conversationId: string) => void
  // XEP-0313: MAM (Message Archive Management)
  setMAMLoading: (conversationId: string, isLoading: boolean) => void
  setMAMError: (conversationId: string, error: string | null) => void
  /**
   * Merge MAM messages into conversation and update query state.
   * @param conversationId - Conversation JID
   * @param messages - Messages from MAM query
   * @param rsm - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeMAMMessages: (conversationId: string, messages: Message[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection) => void
  getMAMQueryState: (conversationId: string) => MAMQueryState
  resetMAMStates: () => void
  /** Mark all conversations as needing a catch-up MAM query (called on reconnect) */
  markAllNeedsCatchUp: () => void
  /** Clear the needsCatchUp flag for a specific conversation */
  clearNeedsCatchUp: (conversationId: string) => void
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
  // IndexedDB message loading
  loadMessagesFromCache: (conversationId: string, options?: { limit?: number; before?: Date; peek?: boolean }) => Promise<Message[]>
  /**
   * Hydrate the resident array with the contiguous cache slice that CONTAINS a specific message
   * (the anchor), rather than the latest-N slice. Used by scroll-position restore on return to a
   * conversation the user had scrolled deep into: the saved content anchor points at an old message
   * absent from the latest-100 rehydration, so restore can't resolve it. Loading the slice around
   * the anchor (older context + the tail through the latest message) makes the existing anchor
   * restore land correctly. Also serves search/activity navigation to a message not in the recent
   * slice. Returns the loaded slice (empty if the anchor is not in the cache).
   */
  loadMessagesAroundFromCache: (conversationId: string, anchorMessageId: string, options?: { before?: number; after?: number }) => Promise<Message[]>
  loadOlderMessagesFromCache: (conversationId: string, limit?: number) => Promise<Message[]>
  setTargetMessageId: (id: string | null) => void
  switchAccount: (jid: string | null) => void
  reset: () => void
}

// Serialization types for localStorage
// Note: messages are NOT persisted in localStorage - they're in IndexedDB
// Only conversations metadata, archivedConversations, and drafts are persisted here
interface PersistedState {
  // New separated storage (Phase 6)
  conversationEntities?: [string, ConversationEntity][]
  conversationMeta?: [string, ConversationMetadata][]
  // Legacy combined storage for backward compatibility
  conversations: [string, Conversation][]
  archivedConversations?: string[] // Optional for backwards compatibility
  drafts?: [string, string][] // Optional for backwards compatibility
  conversationGaps?: [string, GapInterval][] // Optional for backwards compatibility
  // Legacy fields, kept for backwards compatibility when reading old storage
  messages?: [string, Message[]][] // May exist in old storage, will be migrated
  activeConversationId?: string | null
}

// Serialize Maps to arrays for JSON storage
function serializeState(state: Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'archivedConversations' | 'drafts'> & { conversationGaps?: Map<string, GapInterval> }): PersistedState {
  return {
    // Serialize separated maps (Phase 6)
    conversationEntities: Array.from(state.conversationEntities.entries()),
    conversationMeta: Array.from(state.conversationMeta.entries()),
    // Also serialize combined map for backward compatibility
    conversations: Array.from(state.conversations.entries()),
    // Messages are NOT stored in localStorage - they're in IndexedDB
    archivedConversations: Array.from(state.archivedConversations),
    drafts: Array.from(state.drafts.entries()),
    // Persisted history gaps (account-scoped via the chat storage key)
    conversationGaps: Array.from((state.conversationGaps ?? new Map<string, GapInterval>()).entries()),
  }
}

// Deserialize arrays back to Maps, reset unread counts, restore Date objects
// Also handles migration of old localStorage messages to IndexedDB
function deserializeState(persisted: PersistedState): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'archivedConversations' | 'drafts' | 'conversationGaps'> {
  // Helper to restore Date objects in lastMessage
  const restoreLastMessage = (lastMessage?: Message): Message | undefined => {
    if (!lastMessage) return undefined
    return { ...lastMessage, timestamp: new Date(lastMessage.timestamp) }
  }

  // Helper to restore Date objects in lastReadAt
  const restoreLastReadAt = (lastReadAt?: Date | string): Date | undefined => {
    if (!lastReadAt) return undefined
    return lastReadAt instanceof Date ? lastReadAt : new Date(lastReadAt)
  }

  // Check if we have the new separated format
  const hasNewFormat = persisted.conversationEntities && persisted.conversationMeta

  let conversationEntities: Map<string, ConversationEntity>
  let conversationMeta: Map<string, ConversationMetadata>
  let conversations: Map<string, Conversation>

  if (hasNewFormat) {
    // New format: deserialize separated maps
    conversationEntities = new Map(persisted.conversationEntities!)
    conversationMeta = new Map(
      persisted.conversationMeta!.map(([id, meta]) => [
        id,
        {
          ...meta,
          unreadCount: 0, // Reset unread on restore
          lastMessage: restoreLastMessage(meta.lastMessage),
          lastReadAt: restoreLastReadAt(meta.lastReadAt),
        },
      ])
    )

    // Rebuild combined map from separated maps
    conversations = new Map()
    for (const [id, entity] of conversationEntities) {
      const meta = conversationMeta.get(id)
      if (meta) {
        conversations.set(id, { ...entity, ...meta })
      }
    }
  } else {
    // Legacy format: deserialize combined map and extract separated maps
    conversations = new Map(
      persisted.conversations.map(([id, conv]) => [
        id,
        {
          ...conv,
          // Default to 'chat' for conversations stored before the type field was added
          type: conv.type ?? 'chat',
          unreadCount: 0, // Reset unread on restore
          lastMessage: restoreLastMessage(conv.lastMessage),
          lastReadAt: restoreLastReadAt(conv.lastReadAt),
        },
      ])
    )

    // Extract entity and metadata from combined conversations (migration)
    conversationEntities = new Map()
    conversationMeta = new Map()
    for (const [id, conv] of conversations) {
      conversationEntities.set(id, {
        id: conv.id,
        name: conv.name,
        // Default to 'chat' for conversations stored before the type field was added
        type: conv.type ?? 'chat',
      })
      conversationMeta.set(id, {
        unreadCount: conv.unreadCount,
        lastMessage: conv.lastMessage,
        lastReadAt: conv.lastReadAt,
        lastSeenMessageId: conv.lastSeenMessageId,
      })
    }
  }

  // Migrate old localStorage messages to IndexedDB (one-time migration)
  if (persisted.messages && persisted.messages.length > 0) {
    const allMessages: Message[] = []
    for (const [, msgs] of persisted.messages) {
      for (const m of msgs) {
        allMessages.push({
          ...m,
          timestamp: new Date(m.timestamp),
        })
      }
    }
    if (allMessages.length > 0) {
      // Save to IndexedDB asynchronously (fire-and-forget migration)
      void messageCache.saveMessages(allMessages).then(() => {
        console.log(`Migrated ${allMessages.length} messages from localStorage to IndexedDB`)
      })
    }
  }

  // Restore archived conversations (backwards compatible - default to empty set)
  const archivedConversations = new Set(persisted.archivedConversations || [])

  // Restore drafts (backwards compatible - default to empty map)
  const drafts = new Map(persisted.drafts || [])

  // Restore history gaps (backwards compatible - default to empty map)
  const conversationGaps = new Map<string, GapInterval>(persisted.conversationGaps || [])

  return {
    conversationEntities,
    conversationMeta,
    conversations,
    // Messages are NOT loaded from localStorage - they'll be loaded from IndexedDB on demand
    messages: new Map(),
    // Always null - activeConversationId is managed by ChatLayout's session storage
    activeConversationId: null,
    archivedConversations,
    drafts,
    conversationGaps,
  }
}

function createEmptyChatState(): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'activationPending' | 'archivedConversations' | 'typingStates' | 'activeAnimation' | 'drafts' | 'mamQueryStates' | 'conversationGaps' | 'targetMessageId' | 'firstNewMessageMarkers' | 'windowAtLiveEdge'> {
  return {
    conversationEntities: new Map(),
    conversationMeta: new Map(),
    conversations: new Map(),
    messages: new Map(),
    activeConversationId: null,
    activationPending: false,
    archivedConversations: new Set(),
    typingStates: new Map(),
    activeAnimation: null,
    drafts: new Map(),
    mamQueryStates: new Map(),
    conversationGaps: new Map(),
    targetMessageId: null,
    firstNewMessageMarkers: new Map(),
    windowAtLiveEdge: new Map(),
  }
}

/**
 * One-time migration from pre-scope storage.
 *
 * Legacy versions stored chat data under a single unscoped key. For safety, we only migrate
 * conversation lists (active + archived classification) and intentionally skip drafts/messages.
 */
function migrateLegacyConversationListsToScoped(jid: string | null): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'archivedConversations' | 'typingStates' | 'activeAnimation' | 'drafts' | 'mamQueryStates' | 'conversationGaps' | 'targetMessageId' | 'firstNewMessageMarkers' | 'windowAtLiveEdge'> | null {
  if (!jid) return null

  const legacyKey = getLegacyStorageKey()
  const scopedStorageKey = getScopedStorageKey(jid)
  if (legacyKey === scopedStorageKey) return null

  try {
    const legacyRaw = localStorage.getItem(legacyKey)
    if (!legacyRaw) return null

    const parsed = JSON.parse(legacyRaw)
    const restored = deserializeState(parsed.state)
    const migrated = createEmptyChatState()

    migrated.conversationEntities = restored.conversationEntities
    migrated.conversationMeta = restored.conversationMeta
    migrated.conversations = restored.conversations
    migrated.archivedConversations = restored.archivedConversations

    const serialized = serializeState({
      conversationEntities: migrated.conversationEntities,
      conversationMeta: migrated.conversationMeta,
      conversations: migrated.conversations,
      messages: migrated.messages,
      archivedConversations: migrated.archivedConversations,
      drafts: migrated.drafts,
    })

    // Persist migrated conversation lists to scoped storage and clear the legacy key.
    localStorage.setItem(scopedStorageKey, JSON.stringify({ state: serialized }))
    localStorage.removeItem(legacyKey)

    return migrated
  } catch {
    return null
  }
}

function loadScopedChatState(jid: string | null): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'archivedConversations' | 'typingStates' | 'activeAnimation' | 'drafts' | 'mamQueryStates' | 'conversationGaps' | 'targetMessageId' | 'firstNewMessageMarkers' | 'windowAtLiveEdge'> {
  const baseState = createEmptyChatState()
  const scopedStorageKey = getScopedStorageKey(jid)

  try {
    const str = localStorage.getItem(scopedStorageKey)
    if (!str) {
      const migrated = migrateLegacyConversationListsToScoped(jid)
      return migrated ?? baseState
    }
    const parsed = JSON.parse(str)
    const restored = deserializeState(parsed.state)
    return {
      ...baseState,
      conversationEntities: restored.conversationEntities,
      conversationMeta: restored.conversationMeta,
      conversations: restored.conversations,
      messages: restored.messages,
      activeConversationId: restored.activeConversationId,
      archivedConversations: restored.archivedConversations,
      drafts: restored.drafts,
      conversationGaps: restored.conversationGaps,
    }
  } catch {
    try {
      localStorage.removeItem(scopedStorageKey)
    } catch {
      // Ignore storage errors
    }
    return baseState
  }
}

export const chatStore = createStore<ChatState>()(
  subscribeWithSelector(
    persist(
    (set, get) => ({
      ...createEmptyChatState(),

      activeConversation: () => {
        const { activeConversationId, conversations } = get()
        if (!activeConversationId) return null
        return conversations.get(activeConversationId) || null
      },

      activeMessages: () => {
        const { activeConversationId, messages } = get()
        if (!activeConversationId) return EMPTY_MESSAGE_ARRAY
        return messages.get(activeConversationId) || EMPTY_MESSAGE_ARRAY
      },

      isArchived: (id) => {
        return get().archivedConversations.has(id)
      },

      activeConversations: () => {
        const state = get()
        const result: Conversation[] = []
        for (const conv of state.conversations.values()) {
          if (!state.archivedConversations.has(conv.id)) {
            result.push(conv)
          }
        }
        return result
      },

      conversationSidebarIds: () => {
        const { conversations, archivedConversations } = get()
        return conversationIdsByActivity(conversations, archivedConversations, false)
      },
      archivedConversationSidebarIds: () => {
        const { conversations, archivedConversations } = get()
        return conversationIdsByActivity(conversations, archivedConversations, true)
      },

      setActiveConversation: (id) => {
        const prevId = get().activeConversationId
        // Skip if already the active conversation (prevents duplicate side effects)
        if (id === prevId) return

        // Deactivate previous conversation: clear its "new messages" marker (if
        // any) and EVICT its message array from RAM. Only the active conversation
        // keeps its messages resident — the durable copy stays in IndexedDB and is
        // rehydrated by activateConversation on return. Meta / lastMessage are
        // preserved, so the sidebar preview and unread badge are unaffected.
        if (prevId && prevId !== id) {
          const hadMarker = get().firstNewMessageMarkers.has(prevId)

          set((state) => {
            const newMessages = new Map(state.messages)
            newMessages.delete(prevId)
            if (!hadMarker) {
              return { messages: newMessages }
            }
            const newMarkers = new Map(state.firstNewMessageMarkers)
            newMarkers.delete(prevId)
            return { messages: newMessages, firstNewMessageMarkers: newMarkers }
          })
        }

        if (id) {
          const conv = get().conversations.get(id)
          if (conv) {
            // Use conversationMeta if available, otherwise derive from conversations map
            const meta = get().conversationMeta.get(id)
            const notifInput: notifState.EntityNotificationState = {
              unreadCount: meta?.unreadCount ?? conv.unreadCount ?? 0,
              mentionsCount: 0,
              lastReadAt: meta?.lastReadAt ?? conv.lastReadAt,
              lastSeenMessageId: meta?.lastSeenMessageId ?? conv.lastSeenMessageId,
              firstNewMessageId: undefined,
            }

            const messages = get().messages.get(id) || []
            // Compute marker position and mark as read atomically.
            // 1:1 chats treat delayed messages as new (offline delivery), so the
            // marker may land on a delayed message — unlike rooms, where delayed
            // means MUC history replay.
            const activated = notifState.onActivate(notifInput, messages, { treatDelayedAsNew: true })

            set((state) => {
              const newMetaEntry = {
                ...(meta ?? { unreadCount: 0, lastReadAt: undefined, lastSeenMessageId: undefined }),
                unreadCount: activated.unreadCount,
                lastReadAt: activated.lastReadAt,
                lastSeenMessageId: activated.lastSeenMessageId,
              }
              const newMeta = new Map(state.conversationMeta)
              newMeta.set(id, newMetaEntry)
              const newConversations = new Map(state.conversations)
              newConversations.set(id, {
                ...conv,
                unreadCount: activated.unreadCount,
                lastReadAt: activated.lastReadAt,
                lastSeenMessageId: activated.lastSeenMessageId,
              })
              const newMarkers = new Map(state.firstNewMessageMarkers)
              if (activated.firstNewMessageId) newMarkers.set(id, activated.firstNewMessageId)
              else newMarkers.delete(id)
              return { conversationMeta: newMeta, conversations: newConversations, activeConversationId: id, firstNewMessageMarkers: newMarkers }
            })
            return
          }
        }
        // Default case: conversation not found, just set active
        set({ activeConversationId: id })
      },

      activateConversation: async (id) => {
        const token = ++activationToken
        if (id) {
          // Signal the hydration window so the UI can hold a neutral surface
          // instead of flashing the empty state while the cache read is in flight.
          set({ activationPending: true })
          await get().loadMessagesFromCache(id, { limit: 100 })
          // A newer activation started while the cache read was in flight: it owns
          // the pending flag now, so bail without clearing it.
          if (token !== activationToken) return
          // XEP-0490: fold any pending remote read position into lastSeenMessageId
          // BEFORE setActiveConversation derives the new-message divider. The fresh
          // session MDS seed runs before messages load, so the marker is stashed as
          // pendingRemoteDisplayedStanzaId; resolve it now (forward-only, against the
          // just-loaded messages) so the divider reflects reads synced from other
          // devices instead of the stale local position.
          // Fold a pending XEP-0490 synced read position into lastSeenMessageId BEFORE
          // setActiveConversation derives the divider — but only on the FIRST open of this
          // conversation this session. XEP-0490 markers broadcast live over PEP, so after the
          // first consumption the live `read:displayed-synced` notifies keep us current; re-folding
          // on every open would let a synced read position reposition the divider on each return.
          const firstConsumeThisSession = !mdsConsumedThisSession.has(id)
          mdsConsumedThisSession.add(id)
          const pending = get().conversationMeta.get(id)?.pendingRemoteDisplayedStanzaId
          if (pending && firstConsumeThisSession) {
            const lastSeenBefore = get().conversationMeta.get(id)?.lastSeenMessageId
            get().applyRemoteDisplayed(id, pending)
            markerDebugLog('activation fold (XEP-0490 pending → divider, first open this session)', {
              conversationId: id,
              pendingStanzaId: pending,
              lastSeenBefore,
              lastSeenAfter: get().conversationMeta.get(id)?.lastSeenMessageId,
              advanced: lastSeenBefore !== get().conversationMeta.get(id)?.lastSeenMessageId,
            })
          } else if (pending) {
            markerDebugLog('activation fold SKIPPED (already consumed this session — PEP keeps it live)', {
              conversationId: id,
              pendingStanzaId: pending,
            })
          }
        }
        // Set active and clear pending atomically (same React commit) so the view
        // swaps straight from loading surface to content with no empty-state frame.
        get().setActiveConversation(id)
        set({ activationPending: false })
      },

      addConversation: (conv) => {
        set((state) => {
          // Extract entity fields (stable)
          const entity: ConversationEntity = {
            id: conv.id,
            name: conv.name,
            type: conv.type,
          }
          // Extract metadata fields (frequently-changing)
          const meta: ConversationMetadata = {
            unreadCount: conv.unreadCount,
            lastMessage: conv.lastMessage,
            lastReadAt: conv.lastReadAt,
            lastSeenMessageId: conv.lastSeenMessageId,
          }

          const newEntities = new Map(state.conversationEntities)
          newEntities.set(conv.id, entity)

          const newMeta = new Map(state.conversationMeta)
          newMeta.set(conv.id, meta)

          // Also update combined map for backward compatibility
          const newConversations = new Map(state.conversations)
          newConversations.set(conv.id, conv)

          return {
            conversationEntities: newEntities,
            conversationMeta: newMeta,
            conversations: newConversations,
          }
        })
      },

      updateConversationName: (id, name) => {
        set((state) => {
          const entity = state.conversationEntities.get(id)
          if (!entity) return state

          // Update entity (name is entity data)
          const newEntities = new Map(state.conversationEntities)
          newEntities.set(id, { ...entity, name })

          // Update combined map
          const conv = state.conversations.get(id)
          if (conv) {
            const newConversations = new Map(state.conversations)
            newConversations.set(id, { ...conv, name })
            return { conversationEntities: newEntities, conversations: newConversations }
          }

          return { conversationEntities: newEntities }
        })
      },

      deleteConversation: (id) => {
        // Delete messages from IndexedDB asynchronously
        void messageCache.deleteConversationMessages(id)

        set((state) => {
          // Remove from separated maps
          const newEntities = new Map(state.conversationEntities)
          newEntities.delete(id)

          const newMeta = new Map(state.conversationMeta)
          newMeta.delete(id)

          // Remove from combined map
          const newConversations = new Map(state.conversations)
          newConversations.delete(id)

          // Also delete all messages for this conversation from memory
          const newMessages = new Map(state.messages)
          newMessages.delete(id)

          // Remove from archived set if present
          const newArchived = new Set(state.archivedConversations)
          newArchived.delete(id)

          // Clear active conversation if it's the one being deleted
          const newActiveId = state.activeConversationId === id ? null : state.activeConversationId

          return {
            conversationEntities: newEntities,
            conversationMeta: newMeta,
            conversations: newConversations,
            messages: newMessages,
            archivedConversations: newArchived,
            activeConversationId: newActiveId,
          }
        })
      },

      addMessage: (msg) => {
        set((state) => {
          const convMessages = state.messages.get(msg.conversationId) || []

          // XEP-0359: Deduplicate using shared utility that checks ANY matching key
          // (stanzaId OR from+id), avoiding the pitfall of short-circuiting on mismatched stanzaIds
          const existingKeys = buildMessageKeySet(convMessages, getChatMessageKeys)
          const isDuplicate = isMessageDuplicate(msg, existingKeys, getChatMessageKeys)

          if (isDuplicate) {
            // The duplicate may be the archived/carbon copy of an outgoing
            // message that has no stanzaId yet. Backfill the server archive id
            // onto the in-memory copy (matched by originId) so backward MAM
            // pagination has a valid cursor — then still skip adding the dup.
            const { messages: backfilled, patched } = backfillArchiveIds(convMessages, [msg], getChatMessageKeys)
            if (patched.length === 0) return state
            for (const p of patched) {
              void messageCache.updateMessage(p.id, { stanzaId: p.stanzaId!, ...(p.originId ? { originId: p.originId } : {}) })
            }
            const patchedMap = new Map(state.messages)
            patchedMap.set(msg.conversationId, backfilled)
            return { messages: patchedMap }
          }

          // Save to IndexedDB + search index only if the message is locally persistable.
          // This runs regardless of the live-edge gate below: a gated message is still
          // durable in the cache and reloads on jump-to-latest.
          if (!msg.noLocalStore) {
            void messageCache.saveMessage(msg)
            searchIndex.indexMessage(msg).catch((e) => console.warn('[searchIndex] indexMessage failed:', e))
          }

          // Sliding window: only append the live message to the resident array when the
          // window is at the live edge. If load-older slid the window up (evicting the
          // newest tail), appending here would splice a fresh message directly after an
          // OLD one — a visible false-adjacency gap. When gated we leave the resident
          // array untouched (the cache write above + the meta/preview/unread updates
          // below still run). ABSENT or true = at the live edge; only explicit false gates.
          const atLiveEdge = state.windowAtLiveEdge.get(msg.conversationId) !== false
          const newMessages = new Map(state.messages)
          newMessages.set(msg.conversationId, atLiveEdge ? [...convMessages, msg] : convMessages)

          const conv = state.conversations.get(msg.conversationId)
          const meta = state.conversationMeta.get(msg.conversationId)
          if (conv && meta) {
            const isActive = state.activeConversationId === msg.conversationId
            const windowVisible = connectionStore.getState().windowVisible

            // Delegate notification state transition to pure function
            const notif = notifState.onMessageReceived(
              {
                unreadCount: meta.unreadCount,
                mentionsCount: 0,
                lastReadAt: meta.lastReadAt,
                lastSeenMessageId: meta.lastSeenMessageId,
                firstNewMessageId: state.firstNewMessageMarkers.get(msg.conversationId),
              },
              msg,
              { isActive, windowVisible },
              // In 1:1 chats, delayed messages are offline delivery (new messages
              // sent while user was offline), so they should increment unread
              { treatDelayedAsNew: true }
            )

            // Keep a bodiless signal placeholder (e.g. an undecrypted encrypted
            // reaction) from becoming the preview — fall back to the existing
            // lastMessage when the incoming message has nothing to show.
            const previewMessage = isPreviewableMessage(msg) ? msg : meta.lastMessage

            // Update metadata map
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(msg.conversationId, {
              ...meta,
              unreadCount: notif.unreadCount,
              lastReadAt: notif.lastReadAt,
              lastMessage: previewMessage,
              lastSeenMessageId: notif.lastSeenMessageId,
            })

            // Update combined map for backward compatibility
            const newConversations = new Map(state.conversations)
            newConversations.set(msg.conversationId, {
              ...conv,
              unreadCount: notif.unreadCount,
              lastReadAt: notif.lastReadAt,
              lastMessage: previewMessage,
              lastSeenMessageId: notif.lastSeenMessageId,
            })

            // Session-only divider: onMessageReceived only sets it for the active,
            // window-hidden case; otherwise it is preserved. Mirror that into the map.
            const newMarkers = new Map(state.firstNewMessageMarkers)
            if (notif.firstNewMessageId) newMarkers.set(msg.conversationId, notif.firstNewMessageId)
            else newMarkers.delete(msg.conversationId)

            // Auto-unarchive conversation when new incoming message arrives
            // (outgoing messages should not trigger unarchive)
            if (!msg.isOutgoing) {
              const newArchived = new Set(state.archivedConversations)
              if (newArchived.has(msg.conversationId)) {
                newArchived.delete(msg.conversationId)
                return {
                  messages: newMessages,
                  conversationMeta: newMeta,
                  conversations: newConversations,
                  archivedConversations: newArchived,
                  firstNewMessageMarkers: newMarkers,
                }
              }
            }

            return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations, firstNewMessageMarkers: newMarkers }
          }

          return { messages: newMessages }
        })
      },

      markAsRead: (conversationId) => {
        set((state) => {
          const conv = state.conversations.get(conversationId)
          if (!conv) return {} // Conversation doesn't exist

          // Use conversationMeta if available, otherwise derive from conversations map
          // (backward compat: persist middleware may restore conversations without conversationMeta)
          const meta = state.conversationMeta.get(conversationId)
          const notifInput: notifState.EntityNotificationState = {
            unreadCount: meta?.unreadCount ?? conv.unreadCount ?? 0,
            mentionsCount: 0,
            lastReadAt: meta?.lastReadAt ?? conv.lastReadAt,
            lastSeenMessageId: meta?.lastSeenMessageId ?? conv.lastSeenMessageId,
            firstNewMessageId: state.firstNewMessageMarkers.get(conversationId),
          }

          const messages = state.messages.get(conversationId) || []
          const lastMessage = messages[messages.length - 1]
          const lastMessageTimestamp = lastMessage?.timestamp

          // Delegate to pure function
          const updated = notifState.onMarkAsRead(notifInput, lastMessageTimestamp)

          // If no change (same reference returned), skip state update
          if (updated.unreadCount === notifInput.unreadCount && updated.lastReadAt === notifInput.lastReadAt) {
            // Also check by value for deserialized timestamps
            const existingTime = notifInput.lastReadAt instanceof Date
              ? notifInput.lastReadAt.getTime()
              : notifInput.lastReadAt ? new Date(notifInput.lastReadAt as unknown as string).getTime() : 0
            const newTime = updated.lastReadAt instanceof Date ? updated.lastReadAt.getTime() : 0
            if (existingTime === newTime) return {}
          }

          const newMetaEntry = {
            ...(meta ?? { unreadCount: 0, lastReadAt: undefined, lastSeenMessageId: undefined }),
            unreadCount: updated.unreadCount,
            lastReadAt: updated.lastReadAt,
          }
          const newMeta = new Map(state.conversationMeta)
          newMeta.set(conversationId, newMetaEntry)

          const newConversations = new Map(state.conversations)
          newConversations.set(conversationId, { ...conv, unreadCount: updated.unreadCount, lastReadAt: updated.lastReadAt })

          return { conversationMeta: newMeta, conversations: newConversations }
        })
      },

      clearFirstNewMessageId: (conversationId) => {
        set((state) => {
          if (!state.firstNewMessageMarkers.has(conversationId)) return state
          const newMarkers = new Map(state.firstNewMessageMarkers)
          newMarkers.delete(conversationId)
          return { firstNewMessageMarkers: newMarkers }
        })
      },

      updateLastSeenMessageId: (conversationId, messageId) => {
        set((state) => {
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          if (!meta) return state

          const messages = state.messages.get(conversationId) || []
          const updated = notifState.onMessageSeen(
            {
              unreadCount: meta.unreadCount,
              mentionsCount: 0,
              lastReadAt: meta.lastReadAt,
              lastSeenMessageId: meta.lastSeenMessageId,
              firstNewMessageId: state.firstNewMessageMarkers.get(conversationId),
            },
            messageId,
            messages
          )

          // No change (same reference or same value)
          if (updated.lastSeenMessageId === meta.lastSeenMessageId) return state

          const newMeta = new Map(state.conversationMeta)
          newMeta.set(conversationId, { ...meta, lastSeenMessageId: updated.lastSeenMessageId })

          if (conv) {
            const newConversations = new Map(state.conversations)
            newConversations.set(conversationId, { ...conv, lastSeenMessageId: updated.lastSeenMessageId })
            return { conversationMeta: newMeta, conversations: newConversations }
          }

          return { conversationMeta: newMeta }
        })
      },

      applyRemoteDisplayed: (conversationId, stanzaId, messagesOverride) => {
        set((state) => {
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          if (!meta) return state

          // A non-active conversation keeps no resident array (memory windowing), so
          // mergeMAMMessages passes the just-merged array here; otherwise read RAM.
          const messages = messagesOverride ?? (state.messages.get(conversationId) || [])
          const match = messages.find((m) => m.stanzaId === stanzaId)

          if (!match) {
            // Message not yet loaded — remember the stanza-id as a high-water
            // mark to be resolved when the message cache is loaded.
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(conversationId, { ...meta, pendingRemoteDisplayedStanzaId: stanzaId })

            if (conv) {
              const newConversations = new Map(state.conversations)
              newConversations.set(conversationId, { ...conv, pendingRemoteDisplayedStanzaId: stanzaId })
              return { conversationMeta: newMeta, conversations: newConversations }
            }

            return { conversationMeta: newMeta }
          }

          // Forward-only advance using the shared comparator (compares by index).
          const updated = notifState.onMessageSeen(
            {
              unreadCount: meta.unreadCount,
              mentionsCount: 0,
              lastReadAt: meta.lastReadAt,
              lastSeenMessageId: meta.lastSeenMessageId,
              firstNewMessageId: state.firstNewMessageMarkers.get(conversationId),
            },
            match.id,
            messages
          )

          // No advance (same value or onMessageSeen guard prevented regression).
          // The matching message IS loaded and the local position is at or past
          // it, so this marker is resolved — clear any stale pending high-water
          // mark so it doesn't re-fire a no-op applyRemoteDisplayed on every
          // mergeMAMMessages. Leave lastSeenMessageId unchanged.
          if (updated.lastSeenMessageId === meta.lastSeenMessageId) {
            if (meta.pendingRemoteDisplayedStanzaId === undefined) return state
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(conversationId, { ...meta, pendingRemoteDisplayedStanzaId: undefined })
            if (conv) {
              const newConversations = new Map(state.conversations)
              newConversations.set(conversationId, {
                ...conv,
                pendingRemoteDisplayedStanzaId: undefined,
              })
              return { conversationMeta: newMeta, conversations: newConversations }
            }
            return { conversationMeta: newMeta }
          }

          const newMeta = new Map(state.conversationMeta)
          newMeta.set(conversationId, {
            ...meta,
            lastSeenMessageId: updated.lastSeenMessageId,
            // Resolved → clear any stale pending marker.
            pendingRemoteDisplayedStanzaId: undefined,
          })

          // XEP-0490: if this marker advances the CURRENTLY ACTIVE conversation, the
          // new-message divider was already derived at activation from the (now stale)
          // local read position — e.g. the fresh-session seed landed just after the
          // conversation opened, so the fold at activation missed it. Recompute the
          // divider from the advanced position so it reflects the synced read instead
          // of freezing at the local one (the view otherwise stays at the last local
          // place and only jumps to the synced place on the next open). Reuse
          // onActivate's forward-scan derivation. For a non-active conversation the
          // divider is recomputed on its next activation, so leave the map untouched.
          let newMarkers = state.firstNewMessageMarkers
          if (state.activeConversationId === conversationId) {
            const divider = notifState.onActivate(
              {
                unreadCount: 0,
                mentionsCount: 0,
                lastReadAt: meta.lastReadAt,
                lastSeenMessageId: updated.lastSeenMessageId,
                firstNewMessageId: undefined,
              },
              messages,
              { treatDelayedAsNew: true }
            ).firstNewMessageId
            newMarkers = new Map(state.firstNewMessageMarkers)
            if (divider) newMarkers.set(conversationId, divider)
            else newMarkers.delete(conversationId)
          }

          if (conv) {
            const newConversations = new Map(state.conversations)
            newConversations.set(conversationId, {
              ...conv,
              lastSeenMessageId: updated.lastSeenMessageId,
              // Keep the combined map coherent with conversationMeta.
              pendingRemoteDisplayedStanzaId: undefined,
            })
            return { conversationMeta: newMeta, conversations: newConversations, firstNewMessageMarkers: newMarkers }
          }

          return { conversationMeta: newMeta, firstNewMessageMarkers: newMarkers }
        })
      },

      hasConversation: (id) => {
        return get().conversations.has(id)
      },

      archiveConversation: (id) => {
        set((state) => {
          const newArchived = new Set(state.archivedConversations)
          newArchived.add(id)
          // Clear active conversation if we're archiving it
          const newActiveId = state.activeConversationId === id ? null : state.activeConversationId
          return { archivedConversations: newArchived, activeConversationId: newActiveId }
        })
      },

      unarchiveConversation: (id) => {
        set((state) => {
          const newArchived = new Set(state.archivedConversations)
          newArchived.delete(id)
          return { archivedConversations: newArchived }
        })
      },

      mergeServerConversations: (convs) => {
        set((state) => {
          const newEntities = new Map(state.conversationEntities)
          const newMeta = new Map(state.conversationMeta)
          const newConversations = new Map(state.conversations)
          const newArchived = new Set(state.archivedConversations)

          for (const serverConv of convs) {
            if (newConversations.has(serverConv.id)) {
              // Existing conversation: sync archived status
              if (serverConv.archived) {
                newArchived.add(serverConv.id)
              } else {
                newArchived.delete(serverConv.id)
              }
            } else {
              // New conversation: add to all maps
              const entity: ConversationEntity = {
                id: serverConv.id,
                name: serverConv.name,
                type: serverConv.type,
              }
              const meta: ConversationMetadata = {
                unreadCount: 0,
              }
              const conv: Conversation = { ...entity, ...meta }

              newEntities.set(serverConv.id, entity)
              newMeta.set(serverConv.id, meta)
              newConversations.set(serverConv.id, conv)

              if (serverConv.archived) {
                newArchived.add(serverConv.id)
              }
            }
          }

          return {
            conversationEntities: newEntities,
            conversationMeta: newMeta,
            conversations: newConversations,
            archivedConversations: newArchived,
          }
        })
      },

      setTyping: (conversationId, jid, isTyping) => {
        if (isTyping) {
          // Set auto-clear timeout in case "paused" is missed
          setTypingTimeout(conversationId, jid, () => {
            // Auto-clear this user's typing state after timeout
            get().setTyping(conversationId, jid, false)
          })
        } else {
          // Clear the timeout when explicitly stopping
          clearTypingTimeout(conversationId, jid)
        }

        set((state) => {
          const newTypingStates = new Map(state.typingStates)
          const typingSet = new Set(newTypingStates.get(conversationId) || [])

          if (isTyping) {
            typingSet.add(jid)
          } else {
            typingSet.delete(jid)
          }

          if (typingSet.size > 0) {
            newTypingStates.set(conversationId, typingSet)
          } else {
            newTypingStates.delete(conversationId)
          }

          return { typingStates: newTypingStates }
        })
      },

      clearAllTyping: () => {
        clearAllTypingTimeouts()
        set({ typingStates: new Map() })
      },

      updateReactions: (conversationId, messageId, reactorJid, emojis) => {
        set((state) => {
          const convMessages = state.messages.get(conversationId)
          if (!convMessages) return state

          // Resolve by id/stanzaId first, origin-id only as fallback (reactions
          // may reference any tier; origin-id must not shadow a real id).
          const messageIndex = findMessageIndexById(convMessages, messageId)
          if (messageIndex === -1) return state

          const message = convMessages[messageIndex]
          const currentReactions = message.reactions || {}

          // Remove reactor from all existing reactions
          const newReactions: Record<string, string[]> = {}
          for (const [emoji, reactors] of Object.entries(currentReactions)) {
            const filtered = reactors.filter((jid) => jid !== reactorJid)
            if (filtered.length > 0) {
              newReactions[emoji] = filtered
            }
          }

          // Add reactor to new emojis
          for (const emoji of emojis) {
            if (!newReactions[emoji]) {
              newReactions[emoji] = []
            }
            newReactions[emoji].push(reactorJid)
          }

          const updatedMessage = {
            ...message,
            reactions: Object.keys(newReactions).length > 0 ? newReactions : undefined,
          }

          // Update in IndexedDB asynchronously
          void messageCache.updateMessage(message.id, { reactions: updatedMessage.reactions })

          const newMessages = new Map(state.messages)
          const updatedConvMessages = [...convMessages]
          updatedConvMessages[messageIndex] = updatedMessage
          newMessages.set(conversationId, updatedConvMessages)

          return { messages: newMessages }
        })
      },

      updateMessage: (conversationId, messageId, updates) => {
        set((state) => {
          const convMessages = state.messages.get(conversationId)
          if (!convMessages) return state

          // Resolve by id/stanzaId first, origin-id only as fallback. XEP-0308
          // corrections reference the origin-id; retractions/MAM may use stanzaId.
          const messageIndex = findMessageIndexById(convMessages, messageId)
          if (messageIndex === -1) return state

          const newMessages = new Map(state.messages)
          const updatedConvMessages = [...convMessages]
          const updatedMessage = {
            ...convMessages[messageIndex],
            ...updates,
          }
          updatedConvMessages[messageIndex] = updatedMessage
          newMessages.set(conversationId, updatedConvMessages)

          // Update in IndexedDB asynchronously (non-blocking)
          // Use the actual message id (not the lookup id which could be stanzaId)
          void messageCache.updateMessage(convMessages[messageIndex].id, updates)

          // Update search index: re-index if body changed, remove if retracted
          if (updates.isRetracted) {
            void searchIndex.removeMessage(updatedMessage)
          } else if (updates.body) {
            void searchIndex.updateMessage(updatedMessage)
          }

          // Refresh the lastMessage preview when this update touches it. Match
          // positionally (the updated message is the newest array element) OR by
          // identity (the updated message IS the current preview). The identity
          // tier is load-bearing for deferred decrypt: an encrypted message can
          // be the stored preview while a trailing bodiless-signal placeholder
          // (an encrypted reaction/retraction) sits after it in the array, so a
          // purely positional gate would leave the sidebar stuck on
          // "[OpenPGP-encrypted message]" after the real message decrypts.
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          const isLastMessage = messageIndex === updatedConvMessages.length - 1
          const isPreviewMessage =
            !!meta?.lastMessage &&
            findMessageIndexById([meta.lastMessage], updatedMessage.id) !== -1
          if (isLastMessage || isPreviewMessage) {
            if (meta && conv) {
              // Update metadata map
              const newMeta = new Map(state.conversationMeta)
              newMeta.set(conversationId, { ...meta, lastMessage: updatedMessage })

              // Update combined map
              const newConversations = new Map(state.conversations)
              newConversations.set(conversationId, { ...conv, lastMessage: updatedMessage })

              return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations }
            }
          }

          return { messages: newMessages }
        })
      },

      clearMessageStanzaId: (conversationId, stanzaId) => {
        set((state) => {
          const convMessages = state.messages.get(conversationId)
          if (!convMessages) return state

          const messageIndex = convMessages.findIndex((message) => message.stanzaId === stanzaId)
          if (messageIndex === -1) return state

          const newMessages = new Map(state.messages)
          const updatedConvMessages = [...convMessages]
          const { stanzaId: _staleStanzaId, ...updatedMessage } = convMessages[messageIndex]
          updatedConvMessages[messageIndex] = updatedMessage
          newMessages.set(conversationId, updatedConvMessages)

          void messageCache.updateMessage(convMessages[messageIndex].id, { stanzaId: undefined })

          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          const wasLastMessage =
            !!meta?.lastMessage &&
            (meta.lastMessage.id === updatedMessage.id || meta.lastMessage.stanzaId === stanzaId)

          if (meta && conv && wasLastMessage) {
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(conversationId, { ...meta, lastMessage: updatedMessage })

            const newConversations = new Map(state.conversations)
            newConversations.set(conversationId, { ...conv, lastMessage: updatedMessage })

            return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations }
          }

          return { messages: newMessages }
        })
      },

      getMessage: (conversationId, messageId) => {
        const convMessages = get().messages.get(conversationId)
        if (!convMessages) return undefined
        return findMessageById(convMessages, messageId)
      },

      getConversationLastTimestamp: (conversationId) => {
        const state = get()
        // Prefer conversationMeta (frequently-updated); fall back to the combined
        // conversations map for backward compat with persist/tests.
        const lastMessage =
          state.conversationMeta.get(conversationId)?.lastMessage ??
          state.conversations.get(conversationId)?.lastMessage
        return lastMessage?.timestamp?.getTime()
      },

      removeMessage: (conversationId, messageId) => {
        set((state) => {
          const convMessages = state.messages.get(conversationId)
          if (!convMessages) return state

          const messageIndex = findMessageIndexById(convMessages, messageId)
          if (messageIndex === -1) return state

          const removed = convMessages[messageIndex]
          const updatedConvMessages = convMessages.filter((_, i) => i !== messageIndex)
          const newMessages = new Map(state.messages)
          newMessages.set(conversationId, updatedConvMessages)

          // Mirror updateMessage: keep the search index and durable cache in
          // sync, using the message's real id (not the lookup id).
          void searchIndex.removeMessage(removed)
          void messageCache.deleteMessage(removed.id)

          // If the removed message was the conversation preview, recompute it.
          // This is the cleanup path for a deferred-decrypt that resolved an
          // encrypted reaction/retraction placeholder: removeMessage drops the
          // bodiless placeholder, and the preview falls back to the newest
          // remaining previewable message instead of keeping a stale pointer.
          const meta = state.conversationMeta.get(conversationId)
          const wasLastMessage =
            !!meta?.lastMessage &&
            (meta.lastMessage.id === removed.id ||
              (!!removed.stanzaId && meta.lastMessage.stanzaId === removed.stanzaId) ||
              (!!removed.originId && meta.lastMessage.originId === removed.originId))

          if (wasLastMessage) {
            const conv = state.conversations.get(conversationId)
            const lastMessage = findLastPreviewableMessage(updatedConvMessages)
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(conversationId, { ...meta!, lastMessage })
            const newConversations = new Map(state.conversations)
            if (conv) newConversations.set(conversationId, { ...conv, lastMessage })
            return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations }
          }

          return { messages: newMessages }
        })
      },

      triggerAnimation: (conversationId, animation) => {
        set({ activeAnimation: { conversationId, animation } })
      },

      clearAnimation: () => {
        set({ activeAnimation: null })
      },

      setTargetMessageId: (id) => {
        set({ targetMessageId: id })
      },

      setDraft: (conversationId, text) => {
        set((state) => ({
          drafts: draftState.setDraft(state.drafts, conversationId, text),
        }))
      },

      getDraft: (conversationId) => {
        return draftState.getDraft(get().drafts, conversationId)
      },

      clearDraft: (conversationId) => {
        set((state) => ({
          drafts: draftState.clearDraft(state.drafts, conversationId),
        }))
      },

      // XEP-0313: MAM (Message Archive Management)
      setMAMLoading: (conversationId, isLoading) => {
        set((state) => ({
          mamQueryStates: mamState.setMAMLoading(state.mamQueryStates, conversationId, isLoading),
        }))
      },

      setMAMError: (conversationId, error) => {
        set((state) => ({
          mamQueryStates: mamState.setMAMError(state.mamQueryStates, conversationId, error),
        }))
      },

      mergeMAMMessages: (conversationId, mamMessages, rsm, complete, direction) => {
        // Captured from inside set() so the post-set MDS marker resolution can read the
        // merged array even for a non-active conversation (whose array isn't in RAM).
        let mergedForMarker: Message[] = []
        set((state) => {
          // Get existing messages for this conversation
          const rawExisting = state.messages.get(conversationId) || []

          // Backfill server stanzaIds from archived copies onto stanzaId-less
          // in-memory messages (e.g. outgoing messages) before merging, so the
          // live copy gains a valid backward-pagination cursor. The archived
          // copy itself still dedups away below.
          const { messages: existingMessages, patched } = backfillArchiveIds(rawExisting, mamMessages, getChatMessageKeys)
          for (const p of patched) {
            void messageCache.updateMessage(p.id, { stanzaId: p.stanzaId!, ...(p.originId ? { originId: p.originId } : {}) })
          }

          // Choose merge strategy based on direction:
          // - Backward (scroll up for older): optimized prepend avoids full re-sort
          // - Forward (catching up with newer): requires full sort since messages are newer
          const { merged: trimmed, newMessages } =
            direction === 'backward'
              ? prependOlderMessages(
                  existingMessages,
                  mamMessages,
                  getChatMessageKeys,
                  RESIDENT_WINDOW_SIZE
                )
              : mergeAndProcessMessages(
                  existingMessages,
                  mamMessages,
                  getChatMessageKeys,
                  RESIDENT_WINDOW_SIZE
                )
          mergedForMarker = trimmed

          // Newest fetched message timestamp marks the gap edge for an incomplete
          // forward catch-up (parity with rooms).
          const newestFetchedTimestamp = direction === 'forward' && mamMessages.length > 0
            ? Math.max(...mamMessages.map(m => m.timestamp?.getTime() ?? 0))
            : undefined

          // Update MAM query state with pagination cursor using the two-marker approach
          // This must always be updated to track query completion and cursors
          const newStates = mamState.setMAMQueryCompleted(
            state.mamQueryStates,
            conversationId,
            complete,
            direction,
            rsm.first, // Pagination cursor for fetching older messages
            newestFetchedTimestamp
          )

          // Mirror the forward gap into the PERSISTED conversationGaps (account-scoped
          // via the chat storage blob) so the marker survives a reload. Forward
          // complete=false sets it, complete=true clears it; backward leaves it.
          // `end` = oldest message held above the gap.
          let newGaps = state.conversationGaps
          if (direction === 'forward') {
            const gapStart = newStates.get(conversationId)?.forwardGapTimestamp
            const gapEnd = gapStart !== undefined ? computeGapEnd(trimmed, gapStart) : undefined
            newGaps = syncGap(state.conversationGaps, conversationId, gapStart, gapEnd)
          }

          // If no new messages (all duplicates), only update MAM state to avoid
          // unnecessary re-renders. Exception: a stanzaId backfill onto existing
          // RAM messages must persist — but only for the ACTIVE conversation
          // (non-active conversations keep no resident array).
          const isActive = state.activeConversationId === conversationId
          if (newMessages.length === 0) {
            if (patched.length === 0 || !isActive) {
              return { mamQueryStates: newStates, conversationGaps: newGaps }
            }
            const backfilledMap = new Map(state.messages)
            backfilledMap.set(conversationId, trimmed)
            return { messages: backfilledMap, mamQueryStates: newStates, conversationGaps: newGaps }
          }

          // Persist to IndexedDB regardless of active state (durable history).
          const persistableMessages = newMessages.filter(msg => !msg.noLocalStore)
          if (persistableMessages.length > 0) {
            void messageCache.saveMessages(persistableMessages)
            searchIndex.indexMessages(persistableMessages).catch((e) => console.warn('[searchIndex] indexMessages failed:', e))
          }

          // Sidebar preview: newest previewable message (skips bodiless signal
          // placeholders; heals a stuck encrypted-fallback preview via
          // shouldReplaceLastMessage / isResolvedSamePreview).
          const lastMessage = findLastPreviewableMessage(trimmed)
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          const previewUpdate = !!(
            meta && conv && lastMessage &&
            (shouldReplaceLastMessage(meta.lastMessage, lastMessage) ||
              isResolvedSamePreview(meta.lastMessage, lastMessage))
          )

          // NON-ACTIVE conversation (background catch-up): the messages are durable
          // in IndexedDB and the preview/gap are updated, but we DON'T populate the
          // resident array. Only the active conversation is kept in RAM, so a
          // reconnect's forward catch-up can't refill a backgrounded conversation
          // toward the cap. It rehydrates from cache on open.
          if (!isActive) {
            if (previewUpdate) {
              const newMeta = new Map(state.conversationMeta)
              newMeta.set(conversationId, { ...meta!, lastMessage })
              const newConversations = new Map(state.conversations)
              newConversations.set(conversationId, { ...conv!, lastMessage })
              return { mamQueryStates: newStates, conversationMeta: newMeta, conversations: newConversations, conversationGaps: newGaps }
            }
            return { mamQueryStates: newStates, conversationGaps: newGaps }
          }

          // ACTIVE conversation: populate the resident messages map.
          const newMessagesMap = new Map(state.messages)
          newMessagesMap.set(conversationId, trimmed)

          // A backward (scroll-up) merge uses keep-oldest and can evict the newest tail,
          // sliding the window off the live edge (same gate as loadOlderMessagesFromCache).
          // Forward catch-up keeps the newest, so it never slides.
          const newestEvicted =
            direction === 'backward' &&
            trimmed[trimmed.length - 1]?.id !== existingMessages[existingMessages.length - 1]?.id
          let newWindowAtLiveEdge = state.windowAtLiveEdge
          if (newestEvicted) {
            newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
            newWindowAtLiveEdge.set(conversationId, false)
          }

          if (previewUpdate) {
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(conversationId, { ...meta!, lastMessage })
            const newConversations = new Map(state.conversations)
            newConversations.set(conversationId, { ...conv!, lastMessage })
            return { messages: newMessagesMap, mamQueryStates: newStates, conversationMeta: newMeta, conversations: newConversations, conversationGaps: newGaps, windowAtLiveEdge: newWindowAtLiveEdge }
          }

          return { messages: newMessagesMap, mamQueryStates: newStates, conversationGaps: newGaps, windowAtLiveEdge: newWindowAtLiveEdge }
        })

        // XEP-0490: a remote displayed marker may have arrived before its message.
        // Now that messages are merged into state, try to resolve the pending marker
        // forward-only. applyRemoteDisplayed re-reads the merged messages, resolves
        // lastSeenMessageId, and clears pendingRemoteDisplayedStanzaId on success.
        const pending = get().conversationMeta.get(conversationId)?.pendingRemoteDisplayedStanzaId
        if (pending) {
          get().applyRemoteDisplayed(conversationId, pending, mergedForMarker)
        }
      },

      getMAMQueryState: (conversationId) => {
        return mamState.getMAMQueryState(get().mamQueryStates, conversationId)
      },

      resetMAMStates: () => {
        set({ mamQueryStates: new Map() })
      },

      markAllNeedsCatchUp: () => {
        set((state) => ({
          mamQueryStates: mamState.markAllNeedsCatchUp(state.mamQueryStates),
        }))
      },

      clearNeedsCatchUp: (conversationId) => {
        set((state) => ({
          mamQueryStates: mamState.clearNeedsCatchUp(state.mamQueryStates, conversationId),
        }))
      },

      updateLastMessagePreview: (conversationId, lastMessage) => {
        set((state) => {
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          if (!meta || !conv) return state

          // Never let a bodiless signal placeholder become the preview
          if (!isPreviewableMessage(lastMessage)) return state

          // Update if newer, or if the existing preview is a stuck placeholder
          if (!shouldReplaceLastMessage(meta.lastMessage, lastMessage)) return state

          // Update metadata map
          const newMeta = new Map(state.conversationMeta)
          newMeta.set(conversationId, { ...meta, lastMessage })

          // Update combined map for backward compatibility
          const newConversations = new Map(state.conversations)
          newConversations.set(conversationId, { ...conv, lastMessage })

          return { conversationMeta: newMeta, conversations: newConversations }
        })
      },

      refreshLastMessageContent: (conversationId, messageId, updates) => {
        set((state) => {
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          // Fall back to the combined map for persist/test states that lack meta.
          const existing = meta?.lastMessage ?? conv?.lastMessage
          if (!existing) return state

          // Only touch the preview when it IS this message — matched across the
          // id/stanzaId/originId tiers so a MAM-id copy still resolves.
          if (findMessageIndexById([existing], messageId) === -1) return state

          const updated = { ...existing, ...updates }

          const newMeta = new Map(state.conversationMeta)
          if (meta) newMeta.set(conversationId, { ...meta, lastMessage: updated })

          const newConversations = new Map(state.conversations)
          if (conv) newConversations.set(conversationId, { ...conv, lastMessage: updated })

          return { conversationMeta: newMeta, conversations: newConversations }
        })
      },

      // Load messages from IndexedDB cache for a conversation
      // For initial load (no 'before'), loads the LATEST 100 messages to show most recent first
      loadMessagesFromCache: async (conversationId, options = {}) => {
        const { limit = 100, before, peek } = options
        try {
          const cachedMessages = await messageCache.getMessages(conversationId, {
            limit,
            before,
            // When loading without 'before', get the latest messages (most recent)
            // This prevents showing old messages and jumping to recent ones
            latest: !before,
          })

          // `peek`: pure read that returns the messages WITHOUT writing the store —
          // used to compute a catch-up cursor for a non-active conversation without
          // pulling its history into RAM (only the active conversation is resident).
          if (!peek && cachedMessages.length > 0) {
            // A latest-N load (no `before` cursor) makes the newest window resident —
            // this is the activation / recenter path, so the window is back at the live
            // edge. Clear any explicit `false` (absent = at the edge). A `before`-anchored
            // load (deep scroll-back restore) is NOT the live edge and leaves the flag.
            const recenter = !before
            set((state) => {
              const update = mergeCachedChatMessages(state, conversationId, cachedMessages)
              if (!recenter || !state.windowAtLiveEdge.has(conversationId)) return update ?? state
              const newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
              newWindowAtLiveEdge.delete(conversationId)
              return { ...(update ?? {}), windowAtLiveEdge: newWindowAtLiveEdge }
            })
          }

          return cachedMessages
        } catch (error) {
          console.warn('Failed to load messages from cache:', error)
          return []
        }
      },

      loadMessagesAroundFromCache: async (conversationId, anchorMessageId, options = {}) => {
        try {
          const slice = await messageCache.getMessagesAround(conversationId, anchorMessageId, options)
          if (slice.length > 0) {
            set((state) => mergeCachedChatMessages(state, conversationId, slice) ?? state)
          }
          return slice
        } catch (error) {
          console.warn('Failed to load messages around anchor from cache:', error)
          return []
        }
      },

      // Load older messages from IndexedDB (for lazy scrolling before hitting MAM)
      loadOlderMessagesFromCache: async (conversationId, limit = 50) => {
        const state = get()
        const existingMessages = state.messages.get(conversationId) || []
        const oldestMessage = existingMessages[0]

        if (!oldestMessage) {
          return []
        }

        try {
          const olderMessages = await messageCache.getMessages(conversationId, {
            limit,
            before: oldestMessage.timestamp,
          })

          if (olderMessages.length > 0) {
            set((state) => {
              const currentMessages = state.messages.get(conversationId) || []

              // Merge older messages at the beginning and trim using shared utility.
              // Load-older slides the window (keep oldest) so scroll-back past the bound works.
              const merged = [...olderMessages, ...currentMessages]
              const trimmed = trimMessagesKeepOldest(merged, RESIDENT_WINDOW_SIZE)

              const newMessagesMap = new Map(state.messages)
              newMessagesMap.set(conversationId, trimmed)

              // If keep-oldest evicted the newest resident message, the window has slid
              // off the live edge → gate live appends in addMessage. If the batch fit
              // under the bound (newest unchanged), leave the flag as-is.
              const newestEvicted =
                trimmed[trimmed.length - 1]?.id !== currentMessages[currentMessages.length - 1]?.id
              if (!newestEvicted) return { messages: newMessagesMap }

              const newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
              newWindowAtLiveEdge.set(conversationId, false)
              return { messages: newMessagesMap, windowAtLiveEdge: newWindowAtLiveEdge }
            })
          }

          return olderMessages
        } catch (error) {
          console.warn('Failed to load older messages from cache:', error)
          return []
        }
      },

      switchAccount: (jid) => {
        clearAllTypingTimeouts()
        set(loadScopedChatState(jid))
      },

      reset: () => {
        clearAllTypingTimeouts()
        // New session → the XEP-0490 synced read marker may be folded again on first open.
        mdsConsumedThisSession.clear()
        // Clear persisted data on logout
        try {
          localStorage.removeItem(getScopedStorageKey())
        } catch {
          // Ignore storage errors
        }
        // Clear IndexedDB messages asynchronously
        void messageCache.clearAllMessages()
        set(createEmptyChatState())
      },
    }),
    {
      name: STORAGE_KEY_BASE,
      storage: {
        getItem: () => {
          const scopedStorageKey = getScopedStorageKey()
          try {
            const str = localStorage.getItem(scopedStorageKey)
            if (!str) return null
            const parsed = JSON.parse(str)
            return { state: deserializeState(parsed.state) }
          } catch {
            // Corrupted data, clear and start fresh
            localStorage.removeItem(scopedStorageKey)
            return null
          }
        },
        setItem: (_, value) => {
          const scopedStorageKey = getScopedStorageKey()
          try {
            const state = value.state as ChatState
            const serialized = serializeState(state)
            localStorage.setItem(scopedStorageKey, JSON.stringify({ state: serialized }))
          } catch {
            // Storage quota exceeded or other error, continue without persistence
          }
        },
        removeItem: () => {
          try {
            localStorage.removeItem(getScopedStorageKey())
          } catch {
            // Ignore storage errors
          }
        },
      },
      partialize: (state) => ({
        // Persist separated maps (Phase 6)
        conversationEntities: state.conversationEntities,
        conversationMeta: state.conversationMeta,
        // Also persist combined map for backward compatibility
        conversations: state.conversations,
        // Note: messages are NOT persisted in localStorage anymore - they're in IndexedDB
        // This allows unlimited message storage and efficient pagination
        messages: new Map(), // Empty - messages loaded from IndexedDB on demand
        // Note: activeConversationId is NOT meaningfully persisted - always null.
        // It's managed by ChatLayout's session storage (ViewStateData) to avoid
        // dual-persistence conflicts that cause incorrect unread badge behavior.
        activeConversationId: null,
        archivedConversations: state.archivedConversations,
        // Persist drafts so they survive page reloads
        drafts: state.drafts,
        // Persist history gaps so the "Load missing messages" marker survives reload
        conversationGaps: state.conversationGaps,
      }),
    }
    )
  )
)

export type { ChatState }
