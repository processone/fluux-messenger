import { createStore } from 'zustand/vanilla'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import type { Message, Conversation, ConversationEntity, ConversationMetadata, HistoryQueryState, PageInfo } from '../core/types'
import { isNoLocalStore } from '../core/types/message-internal'
import { setTypingTimeout, clearTypingTimeout, clearAllTypingTimeouts } from './typingTimeout'
import { findMessageById, findMessageIndexById } from '../utils/messageLookup'
import { logInfo } from '../core/logger'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import * as mamState from './shared/mamState'
import type { HistoryQueryDirection } from './shared/mamState'
import { syncGapAfterArchiveMerge, messagePageExtent, newestMessageStanzaId, type GapInterval } from './shared/mamGap'
import {
  syncCoverageAfterArchiveMerge,
  walkExtentBottomId,
  isCaughtUpForCounting,
  resolveCoverageBottom,
  type CoverageRecord,
  type MergeArchiveExtras,
} from './shared/mamCoverage'
import {
  computeFloor,
  pointerlessDefers,
  worthReconcilingOnDeactivate,
  isAfterBoundary,
  exactPosition,
  isRenderableStoredMessage,
  type PointerOrder,
} from './shared/readState'
import {
  transientCounts,
  noteTransient,
  pruneTransient,
  removeTransient,
  clearTransientScope,
  clearTransientEntity,
  transientIdentity,
  transientAliases,
  type ScopeKey as TransientScopeKey,
} from './shared/transientUnread'
import {
  beginViewportGeneration,
  currentViewportEvidence,
  clearViewportEvidence,
  type EvidenceKey as ViewportEvidenceKey,
} from './shared/viewportEvidence'
import { createArchiveSaveChain } from './shared/archiveSaveChain'
import * as draftState from './shared/draftState'
import * as timeline from './shared/messageTimeline'
import { isPreviewableMessage, findLastPreviewableMessage, shouldReplaceLastMessage } from './shared/lastMessageUtils'
import { derivePreviewAfterMerge } from './shared/previewState'
import { draftConversationMaps, rebuildCompatEntry } from './shared/conversationMaps'
import { addPendingRetraction, applyPendingRetractions, type PendingRetraction } from './shared/pendingRetractions'
import { createRemoteDividerAdvanceTracker } from './shared/dividerAdvance'
import { locallyPublishedDisplayed } from '../core/localMdsPublishes'
import { isAhead } from './shared/readPointer'
import { getBareJid } from '../core/jid'
import { resolveRemoteDisplayed, createMdsSessionGate, foldPendingRemoteDisplayed } from './shared/readMarkerSync'
import {
  advance,
  deserializeReadPointer,
  makeReadPointer,
  type ReadPointer,
} from './shared/readPointer'
import * as notifState from './shared/notificationState'
import { markerDebugLog } from '../utils/markerDebug'
import { connectionStore } from './connectionStore'
import { buildScopedStorageKey, getStorageScopeJid } from '../utils/storageScope'
import {
  recordRecountDeferral,
  type RecountDeferralReason,
} from './shared/recountDiagnostics'
import { createRecountRetryScheduler } from './shared/recountRetry'
import { createPendingEntityWrites } from './shared/pendingEntityWrites'
import { flushKey, flush as flushThrottledStorage } from './shared/throttledStorage'
import { scheduleDurableMaps, cancelDurableMaps, forgetAllDurableMapBaselines, noteCoverageTransition } from './shared/durableMapPersist'
// Sliding-window bound (messages kept resident per conversation; rest live in IndexedDB + MAM).
// Read via getResidentWindowSize() so a DEV/DEMO/TEST caller can shrink it — see shared/residentWindow.ts.
import { getResidentWindowSize } from './shared/residentWindow'
import { clearMarker, lastMessageTimestamp, clearCoverageEntry, clearGapAnchor } from './shared/keyedMapEdits'

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

// XEP-0490 first-open-per-session fold gate (see shared/readMarkerSync).
// Reset on reset() (logout/account switch); module-level so it is naturally
// per app session.
const mdsGate = createMdsSessionGate()
const remoteDividerAdvances = createRemoteDividerAdvanceTracker()

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
): Partial<Pick<ChatState, 'messages' | 'conversationEntities' | 'conversationMeta' | 'conversations' | 'pendingRetractions'>> | null {
  const existingMessages = state.messages.get(conversationId) || []

  const { merged, newMessages } = timeline.latestSlice(
    existingMessages,
    cachedMessages,
    chatTimelineConfig()
  )
  if (newMessages.length === 0) return null

  // XEP-0424: a retraction recorded while this conversation was unloaded applies
  // here, the moment its target becomes resident.
  const resolved = resolvePendingRetractions(state, conversationId, merged)
  const trimmed = resolved.messages

  const newMessagesMap = new Map(state.messages)
  newMessagesMap.set(conversationId, trimmed)

  // Sidebar preview via the shared policy: the newest previewable message
  // supersedes (or heals) the stored preview — e.g. opening a conversation
  // whose stored preview is a stuck placeholder heals it here.
  const meta = state.conversationMeta.get(conversationId)
  const { lastMessage, changed } = derivePreviewAfterMerge(meta?.lastMessage, trimmed, findLastPreviewableMessage)
  const retractionPatch = resolved.pendingRetractions ? { pendingRetractions: resolved.pendingRetractions } : {}
  if (changed) {
    const draft = draftConversationMaps(state)
    if (draft.patchMeta(conversationId, { lastMessage })) {
      return { messages: newMessagesMap, ...draft.commit(), ...retractionPatch }
    }
  }

  return { messages: newMessagesMap, ...retractionPatch }
}

/** XEP-0424 authorship gate: only a message's own author may retract it. */
export const chatRetractionAuthor = (message: Message, record: PendingRetraction): boolean =>
  message.from === record.actorJid

/**
 * Replay a conversation's pending retractions against a slice of its messages.
 *
 * Returns the patched slice plus the new `pendingRetractions` map when anything
 * resolved (`undefined` when nothing did, so callers can skip the state write).
 * Tombstones are written through to the durable cache — the record is dropped
 * once resolved, so the tombstone has to outlive it. `persist: false` is for a
 * message not yet in the cache: its own save writes the tombstone, and a
 * concurrent update would race that save.
 */
function resolvePendingRetractions(
  state: ChatState,
  conversationId: string,
  slice: Message[],
  options: { persist?: boolean } = {}
): { messages: Message[]; pendingRetractions?: ChatState['pendingRetractions'] } {
  const pending = state.pendingRetractions.get(conversationId)
  if (!pending || pending.length === 0) return { messages: slice }

  const { messages, applied, remaining } = applyPendingRetractions(slice, pending, chatRetractionAuthor)
  if (remaining.length === pending.length) return { messages }

  if (options.persist !== false) {
    for (const { messageId, retractedAt } of applied) {
      void messageCache.updateMessage(messageId, { isRetracted: true, retractedAt })
      const retracted = findMessageById(messages, messageId)
      if (retracted) void searchIndex.removeMessage(retracted)
    }
  }

  const nextPending = new Map(state.pendingRetractions)
  if (remaining.length === 0) nextPending.delete(conversationId)
  else nextPending.set(conversationId, remaining)
  return { messages, pendingRetractions: nextPending }
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

/** Timeline config for the shared resident-window machine (see shared/messageTimeline.ts). */
function chatTimelineConfig(): timeline.TimelineConfig<Message> {
  return { getKeys: getChatMessageKeys, windowSize: getResidentWindowSize(), kind: 'chat' }
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
 * import { chatStore } from '@fluux/sdk'
 *
 * // Get all conversations (combined entity + metadata)
 * const conversations = chatStore.getState().conversations
 *
 * // Subscribe to metadata only (sidebar optimization)
 * chatStore.subscribe(
 *   (state) => state.conversationMeta,
 *   () => console.log('Metadata changed')
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
  activeAnimation: { conversationId: string; animation: string; senderName?: string } | null
  // Message drafts per conversation (persisted to localStorage)
  drafts: Map<string, string>
  // XEP-0313: MAM query state per conversation (ephemeral, not persisted)
  mamQueryStates: Map<string, HistoryQueryState>
  // Persisted history-gap intervals per conversation (in the account-scoped chat
  // blob; drives the gap marker). Parity with roomStore.roomGaps.
  conversationGaps: Map<string, GapInterval>
  // Persisted contiguous-with-live coverage per conversation (positive twin of
  // conversationGaps; survives fresh sessions and gap closure). Parity with
  // roomStore.roomCoverage. See shared/mamCoverage.ts.
  conversationCoverage: Map<string, CoverageRecord>
  // XEP-0424 retractions whose target was not resident when they arrived (only the
  // ACTIVE conversation keeps messages in RAM, and a target older than the loaded
  // slice is absent even there). Persisted so the tombstone still lands after a
  // reload; each record clears the moment its target loads. See
  // shared/pendingRetractions.ts.
  pendingRetractions: Map<string, PendingRetraction[]>
  // Target message to scroll to after navigation (ephemeral, not persisted)
  targetMessageId: string | null
  // Session-only new-message divider per conversation (jid -> messageId). Derived
  // at activation from the read pointer; never persisted (absent from serializeState).
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
  // The last message that genuinely ARRIVED in each conversation, as opposed to
  // the last message we currently DISPLAY (conversationMeta.lastMessage).
  //
  // Written only by addMessage, past the duplicate early-returns — so it changes
  // exactly once per delivered message and never for a duplicate echo, a MAM or
  // cache merge, or a preview swap. That makes it the authoritative "a message
  // arrived" signal for notification consumers, which must not fire twice for
  // one message.
  //
  // lastMessage cannot serve that role: it is display state and legitimately
  // moves BACKWARDS as well as forwards (a merge demotes it off a bodiless
  // placeholder onto an older previewable message; addMessage sets it from an
  // offline-replay message with no timestamp guard). Diffing it re-reads an
  // already-delivered message as new — see useNotificationEvents.
  //
  // EPHEMERAL: never persisted (absent from partialize). A restored arrival
  // would be re-read as a fresh delivery on the next launch.
  lastArrivedMessage: Map<string, Message>
  /**
   * Monotonic per-conversation versions incremented whenever `appendLive`
   * places a genuine arrival before the resident timeline's live edge.
   *
   * @remarks
   * Stable public API. The versions are ephemeral and reset with the store.
   */
  interiorPlacementVersions: Map<string, number>

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
  /** Esc / mark-all-read: advance the read pointer to the newest known
   *  message, zero the unread count, drop the divider. The MDS publisher
   *  picks up the pointer advance via the conversationMeta watch. */
  markReadToNewest: (conversationId: string) => void
  clearFirstNewMessageId: (conversationId: string) => void
  /** Recompute the session-only "New messages" divider from the current read pointer
   *  for this conversation. Forward-only and idempotent: repositions the
   *  divider to the first unread message after the pointer when one exists. Never clears an
   *  existing divider when the pointer is at the newest (nothing unread) — that state is kept
   *  alive deliberately after a FAB jump-to-present so the jump-to-last-read pill can offer a
   *  return; clearing is owned by the explicit read-through / mark-read paths.
   *  No-op when there is no existing divider. Touches nothing but firstNewMessageMarkers.
   *  Only meaningful for the ACTIVE conversation: that is where the resident `messages` array
   *  lives. On a deactivated conversation `setActiveConversation` deletes the messages entry, so
   *  the recompute sees an empty array and would SILENTLY clear the divider — callers must only
   *  invoke this for the active conversation. */
  resyncDividerToReadPointer: (conversationId: string) => void
  advanceReadPointer: (conversationId: string, messageId: string) => void
  /**
   * XEP-0490: apply a remote device's last-displayed marker. Advances
   * the read pointer forward-only. Pending and ordering semantics are owned by
   * the shared `readMarkerSync` resolver.
   */
  applyRemoteDisplayed: (
    conversationId: string,
    stanzaId: string,
    messagesOverride?: Message[],
  ) => void
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
   * exception is `{ allowActive: true }`: callers that establish new durable
   * counting input while the entity is active must opt into the guarded
   * archive derivation.
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
  /**
   * Epoch ms of the conversation's persisted last-known message (the entity
   * preview), or undefined. Used as a last-resort forward catch-up cursor so a
   * persisted conversation whose message cache is empty this run still
   * forward-fills its offline gap instead of a `before:''` fetch-latest.
   */
  getConversationLastTimestamp: (conversationId: string) => number | undefined
  triggerAnimation: (conversationId: string, animation: string, senderName?: string) => void
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
   * @param page - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeMAMMessages: (conversationId: string, messages: Message[], page: PageInfo, complete: boolean, direction: HistoryQueryDirection, isFetchLatest?: boolean, preserveGapMarker?: boolean, extras?: MergeArchiveExtras) => void
  /**
   * Strip a purged archive id from the persisted gap anchor (`startId`),
   * keeping the `start` timestamp so the next catch-up resume uses the
   * timestamp fallback and progresses. Called via the `chat:mam-anchor-purged`
   * binding when an `after:`-anchored query hit item-not-found. Only strips a
   * MATCHING id — a gap whose anchor already advanced is left untouched.
   */
  clearConversationGapAnchor: (conversationId: string, purgedStartId: string) => void
  /** Persisted contiguous-with-live coverage record, if any. */
  getConversationCoverage: (conversationId: string) => CoverageRecord | undefined
  /** Drop the coverage record; with `ifBottomId`, only when it matches
   *  `bottomId` (purge-event guard — the anchor is known gone). */
  clearConversationCoverage: (conversationId: string, ifBottomId?: string) => void
  getMAMQueryState: (conversationId: string) => HistoryQueryState
  resetMAMStates: () => void
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
  /**
   * Mirror of {@link loadOlderMessagesFromCache} for the opposite direction: loads the next-newer
   * cache slice AFTER the resident newest message and appends it, evicting the OLDEST resident
   * messages at the bound (keep-newest) instead of the newest. Used to slide the window back down
   * after a scroll-back has moved it off the live edge. Sets the conversation's live-edge flag when
   * the cache has nothing newer left (the window has reached the tail).
   */
  loadNewerMessagesFromCache: (conversationId: string, limit?: number) => Promise<Message[]>
  /**
   * Jump-to-latest: reset the resident window to the newest slice from cache and mark the window
   * at the live edge. Thin wrapper around {@link loadMessagesFromCache}'s latest-N path (which
   * already clears the slid flag on recenter); kept as its own action for the UI's jump-to-latest
   * affordance.
   */
  recenterToLatest: (conversationId: string) => Promise<void>
  setTargetMessageId: (id: string | null) => void
  switchAccount: (jid: string | null) => void
  reset: () => void
}

// Serializes this store's archive-page writes; see shared/archiveSaveChain.ts.
const conversationArchiveSaves = createArchiveSaveChain()

// Per-entity recount version for `recomputeUnreadForConversation`'s
// latest-wins commit. Two recounts for the same conversation can race (a slow
// cursor started before a fast one) — bumping this BEFORE either awaits and
// re-checking it immediately before the final commit means an older recount
// that resolves last is discarded rather than overwriting the newer result.
// Cleared on logout/account switch: a stale version surviving into a new
// account can only ever cause an extra discarded recompute, never a wrong
// write (the recompute also re-checks `conversationMeta` under the same key).
const chatRecountVersion = new Map<string, number>()
const chatUnreadInputVersion = new Map<string, number>()
const chatPendingUnreadWrites = createPendingEntityWrites()
const chatEntityEpoch = new Map<string, number>()
const chatRecountRetry = createRecountRetryScheduler((error) => {
  console.warn('Unread recount retry failed for a conversation:', error)
})

function bumpChatRecountVersion(conversationId: string): number {
  const next = (chatRecountVersion.get(conversationId) ?? 0) + 1
  chatRecountVersion.set(conversationId, next)
  return next
}

function bumpChatUnreadInputVersion(conversationId: string): void {
  chatUnreadInputVersion.set(conversationId, (chatUnreadInputVersion.get(conversationId) ?? 0) + 1)
}

function chatRecountReady(conversationId: string): boolean {
  const mam = mamState.getMAMQueryState(chatStore.getState().mamQueryStates, conversationId)
  return !chatPendingUnreadWrites.has(conversationId) &&
    !conversationArchiveSaves.has(conversationId) &&
    isCaughtUpForCounting(mam)
}

function currentChatEntityEpoch(conversationId: string): number {
  return chatEntityEpoch.get(conversationId) ?? 0
}

let chatCacheEpoch = 0

/**
 * The account scope this store last saw its OWN transient-overlay
 * entries filed under. Tracked separately from `getStorageScopeJid()` because
 * by the time `switchAccount` runs, the global scope has ALREADY flipped to
 * the incoming account (XMPPClient calls `setStorageScopeJid` before
 * `switchAccount`) — `getStorageScopeJid()` there would name the NEW account,
 * not the one being torn down.
 */
let lastChatTransientScope: string | null = null

/** Test-only: drop all per-conversation archive-save chain entries. */
export function _resetChatArchiveSavesForTesting(): void {
  conversationArchiveSaves.clear()
  chatCacheEpoch++
}

/**
 * Read state as it may appear ON DISK, which is not the same shape as in memory.
 *
 * `lastSeenMessageId` / `lastReadAt` were deleted from the live types in #1081,
 * but blobs written by every release before it still carry them and nothing
 * else. {@link scheduleReadPointerBackfill} reads them here to build the
 * `readPointer` those users have never had. Deleting them from this type would
 * silently orphan every pre-#1081 read position — and the pointer is
 * forward-only, so a position lost that way never comes back.
 *
 * `serializeState` WRITES them back for any conversation that still has no
 * `readPointer` (see {@link unmigratedLegacyReadState}). The migration resolves
 * nothing at all in several legitimate cases — an id the message cache no longer
 * holds, a timestamp older than every cached message, a single failed IndexedDB
 * open — and dropping the source values on the first persist would turn a
 * retryable miss into permanent loss: the next launch would find a conversation
 * with neither a pointer nor anything to build one from, and would fall back to
 * counting unread from its `historyFloor` creation watermark instead of the read
 * position these fields still encode.
 */
interface PersistedReadState {
  lastSeenMessageId?: string
  lastReadAt?: Date | string
}

/** The legacy pair as it exists in memory, dates already parsed. */
interface LegacyReadState {
  lastSeenMessageId?: string
  lastReadAt?: Date
}

/**
 * This blob is a verbatim `JSON.stringify` of the live objects, so the pointer
 * goes to disk in its in-memory shape: `tiebreak` under its own name, keeping
 * its `id`, and `timestamp` as an ISO string. That differs from
 * `serializeReadPointer`'s epoch-ms, id-less form used by room read state and
 * the state snapshot; `deserializeReadPointer` reads both.
 */
type PersistedConversationMetadata = ConversationMetadata & PersistedReadState
type PersistedConversation = Conversation & PersistedReadState

/**
 * Legacy read state still waiting to become a `readPointer`, keyed by the
 * storage key the state it came from is written back under.
 *
 * Captured at rehydrate by {@link deserializeState} and re-emitted by
 * {@link serializeState} until a pointer lands, which makes the #1081 migration
 * idempotent and retryable across launches rather than one-shot.
 *
 * Keyed by storage key, not merely held as "the last blob loaded", because the
 * key is the only thing that ties these values to the account they belong to. An
 * account switch that finds no blob for the new account never re-enters
 * `deserializeState`, so a single unkeyed map would survive into the new
 * account's writes — and two accounts talking to the same contact share a
 * conversation id, so the previous account's read position would be migrated
 * into the new account's conversation. Keying by storage key makes that
 * impossible: a lookup under the new account's key simply misses.
 */
const unmigratedLegacyReadState = new Map<string, Map<string, LegacyReadState>>()

/**
 * The transient-overlay scope key for a conversation. `accountScope`
 * mirrors {@link unmigratedLegacyReadState}'s own per-account keying: a bare
 * conversation id can collide across accounts (two accounts chatting with the
 * same contact), so the overlay — like the legacy-read-state map — is scoped
 * by the account JID, never a bare entity id.
 */
function chatTransientScopeKey(conversationId: string): TransientScopeKey {
  return { accountScope: getStorageScopeJid() ?? '', kind: 'chat', entityId: conversationId }
}

function invalidateChatEntity(conversationId: string): void {
  chatEntityEpoch.set(conversationId, currentChatEntityEpoch(conversationId) + 1)
  conversationArchiveSaves.cancel(conversationId)
  chatPendingUnreadWrites.cancel(conversationId)
  chatRecountRetry.cancel(conversationId)
  chatRecountVersion.delete(conversationId)
  chatUnreadInputVersion.delete(conversationId)
  clearTransientEntity(chatTransientScopeKey(conversationId))
}

/**
 * The viewport-evidence key for a conversation. Same shape/rationale
 * as {@link chatTransientScopeKey}: scoped by account JID so a bare
 * conversation id can't collide across accounts.
 */
function chatViewportEvidenceKey(conversationId: string): ViewportEvidenceKey {
  return { accountScope: getStorageScopeJid() ?? '', kind: 'chat', entityId: conversationId }
}

// Serialization types for localStorage
// Note: messages are NOT persisted in localStorage - they're in IndexedDB
// Only conversations metadata, archivedConversations, and drafts are persisted here
interface PersistedState {
  // New separated storage
  conversationEntities?: [string, ConversationEntity][]
  conversationMeta?: [string, PersistedConversationMetadata][]
  // Legacy combined storage, read-only: blobs written before the entity/meta
  // split carry this and nothing else. Never written any more — the new-format
  // load rebuilds the compat map from the two maps above, so persisting it was
  // storing the same data a second time (halving every write to remove it).
  conversations?: [string, PersistedConversation][]
  archivedConversations?: string[] // Optional for backwards compatibility
  drafts?: [string, string][] // Optional for backwards compatibility
  conversationGaps?: [string, GapInterval][] // Optional for backwards compatibility
  conversationCoverage?: [string, CoverageRecord][] // Optional for backwards compatibility
  pendingRetractions?: [string, PendingRetraction[]][] // Optional for backwards compatibility
  // Legacy fields, kept for backwards compatibility when reading old storage
  messages?: [string, Message[]][] // May exist in old storage, will be migrated
  activeConversationId?: string | null
}

/**
 * Conversation entries for disk, carrying forward the legacy read state of any
 * conversation the #1081 migration has not resolved into a `readPointer` yet.
 *
 * Runs on every store mutation, so the steady state must cost nothing: once the
 * migration has finished (and for every user who never had legacy state) `legacy`
 * is absent or empty and this is the same single `Array.from` it replaced. The
 * per-entry work only exists while something is still un-migrated, and even then
 * it is one `Map.get` per conversation and one object spread per conversation
 * that still owes a pointer.
 *
 * A conversation that HAS a pointer emits nothing: the pointer supersedes the
 * legacy pair, so re-emitting it would leave a stale second opinion on disk —
 * exactly the two-independent-fields shape #1081 removed.
 */
function withUnmigratedReadState<T extends { readPointer?: ReadPointer }>(
  entries: Map<string, T>,
  legacy: Map<string, LegacyReadState> | undefined
): [string, T & PersistedReadState][] {
  if (!legacy || legacy.size === 0) return Array.from(entries.entries())
  const out: [string, T & PersistedReadState][] = []
  for (const [id, value] of entries) {
    const carry = value.readPointer ? undefined : legacy.get(id)
    out.push(carry ? [id, { ...value, ...carry }] : [id, value])
  }
  return out
}

// Serialize Maps to arrays for JSON storage
function serializeState(state: Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'messages' | 'archivedConversations' | 'drafts'> & { conversationGaps?: Map<string, GapInterval>; conversationCoverage?: Map<string, CoverageRecord>; pendingRetractions?: Map<string, PendingRetraction[]> }, storageKey: string): PersistedState {
  // Un-migrated legacy read state belonging to THIS blob (see the map's doc).
  const legacy = unmigratedLegacyReadState.get(storageKey)
  return {
    // Serialize separated maps. The `conversations` compat map is
    // deliberately NOT written: `deserializeState` rebuilds it from these two
    // (see its new-format branch), and `shared/conversationMaps` guarantees the
    // live map is nothing but that rebuild, so the copy was pure duplication.
    conversationEntities: Array.from(state.conversationEntities.entries()),
    conversationMeta: withUnmigratedReadState(state.conversationMeta, legacy),
    // Messages are NOT stored in localStorage - they're in IndexedDB
    archivedConversations: Array.from(state.archivedConversations),
    drafts: Array.from(state.drafts.entries()),
    // Persisted history gaps (account-scoped via the chat storage key)
    conversationGaps: Array.from((state.conversationGaps ?? new Map<string, GapInterval>()).entries()),
    // Persisted contiguous-with-live coverage (positive twin of the gaps)
    conversationCoverage: Array.from((state.conversationCoverage ?? new Map<string, CoverageRecord>()).entries()),
    // XEP-0424 retractions still waiting for their target to load
    pendingRetractions: Array.from((state.pendingRetractions ?? new Map<string, PendingRetraction[]>()).entries()),
  }
}

/**
 * One-shot migration of legacy read state to a {@link ReadPointer}.
 *
 * Every branch resolves AT OR BEHIND the user's true position, never ahead.
 * Today's `lastReadAt` means "timestamp of the newest LOADED message when I last
 * activated" — not "the message I read up to" — so treating it as an upper bound
 * and taking the newest message at or before it is the closest honest reading.
 * The pointer is forward-only: under-advancing costs the user a few extra unread
 * messages, over-advancing destroys the position for good.
 */
export async function migrateReadPointer(
  conversationId: string,
  legacy: LegacyReadState
): Promise<ReadPointer | undefined> {
  const { lastSeenMessageId, lastReadAt } = legacy

  if (lastSeenMessageId && lastReadAt) {
    // A FLOOR, and the type now says so: `lastReadAt` is at or behind the
    // message `lastSeenMessageId` names, so the position is known only to a
    // millisecond. It also enters `local` — no archive id was ever stored here,
    // and it must never acquire one: a floor's name and order already disagree,
    // so giving it a wire name would widen that inconsistency (`withArchiveId`
    // refuses this pointer for exactly that reason).
    return { order: { role: 'floor', timestamp: lastReadAt.getTime() }, identity: { state: 'local', messageId: lastSeenMessageId } }
  }

  if (lastSeenMessageId) {
    // Resolved BY ITS IDENTIFIER, so "I know exactly which archived message this
    // is" is earned: the row's own archive id may ride along, and this pointer
    // mints `addressable` when the cached row carries one. Contrast the
    // timestamp-resolved branch below, which cannot make that claim.
    const cached = await messageCache.getMessage(lastSeenMessageId)
    if (cached) return makeReadPointer(cached, 'chat')
    return undefined
  }

  if (lastReadAt) {
    // Newest message at or before the timestamp. The bounds are EXCLUSIVE on
    // both ends (messageCache.ts: `IDBKeyRange.bound([...], [...], true, true)`),
    // so we probe one millisecond past the timestamp to make the upper bound
    // inclusive; `before` forces the backwards cursor, so `limit: 1` yields the
    // NEWEST match rather than the oldest.
    //
    // `after` is what keeps the range inside this conversation. With an upper
    // bound alone the cursor has no floor, so a conversation with nothing at or
    // before the timestamp walks backwards through every lower-sorting
    // conversation's rows — `limit` cannot stop it, because the result array
    // never fills. That is one `cursor.continue()` per cached message, on the
    // startup path.
    const [newest] = await messageCache.getMessages(conversationId, {
      after: new Date(0),
      before: new Date(lastReadAt.getTime() + 1),
      limit: 1,
    })
    if (!newest) return undefined

    // Deliberately WITHOUT the row's archive id, so this pointer mints `local`.
    //
    // This row was located by TIMESTAMP, not by identity, and two messages can
    // share a millisecond — so it can be the wrong message. The pointer is
    // internally consistent either way (it takes this row's id, timestamp and
    // tie-break together), and the ORDER is unchanged by dropping the archive
    // id. What an `addressable` identity would add is a claim of exactness we
    // never established, and the XEP-0490 publisher would then send that archive
    // id to the user's other devices as an exact read position — forward-only,
    // and unrecoverable if it names the wrong row.
    //
    // `local` is the honest encoding: claim exactness only where we have it.
    // It costs nothing lasting — this pointer still converges through the normal
    // paths, when the position next advances onto a message that carries an
    // archive id, or when the publisher resolves it.
    const timestampLocatedLocalSource = {
      id: newest.id,
      timestamp: newest.timestamp,
    }
    return makeReadPointer(timestampLocatedLocalSource, 'chat')
  }

  return undefined
}

/**
 * Fill `readPointer` into a conversation that was restored without one.
 *
 * Forward-only via {@link advance}: if the user opened the conversation and read
 * on before the backfill resolved, their newer position wins and this is a
 * no-op. The migrated candidate is derived from legacy fields captured at
 * rehydrate, so it is at or behind the true position by construction — it can
 * only ever fill a gap, never push the pointer past something unread.
 *
 * `conversationMeta` and `conversations` are written in ONE `setState` (see
 * shared/conversationMaps), so the conversation is never observable holding a
 * pointer in one map and not the other. Until this lands it simply looks
 * un-migrated, which is a valid state.
 */
function applyMigratedReadPointer(conversationId: string, migrated: ReadPointer): void {
  chatStore.setState((state) => {
    const meta = state.conversationMeta.get(conversationId)
    // Gone (deleted, logged out, account switched) — nothing to migrate into.
    if (!meta) return {}

    const current = meta.readPointer
    const next = advance(current, migrated)
    if (next === current) return {}

    const draft = draftConversationMaps(state)
    draft.patchMeta(conversationId, { readPointer: next })
    return draft.commit()
  })
}

/**
 * Post-rehydrate backfill: give every restored conversation a `readPointer`.
 *
 * `deserializeState` is synchronous and the migration needs the message cache,
 * so this runs fire-and-forget after the restored state lands — the same shape
 * as the localStorage-messages → IndexedDB migration below it. Conversations
 * persisted before #1081 carry only `lastSeenMessageId` / `lastReadAt`, which
 * are not live fields; without this pass they would have no pointer at all.
 * `legacyReadState` is what the blob held for each conversation, read off the
 * persisted shape (see {@link PersistedReadState}) rather than off the restored
 * metadata, which has nowhere to keep it.
 *
 * The "already has one" skip deliberately consults the RESTORED pointer, not
 * the raw persisted value: a corrupt on-disk pointer deserializes to
 * `undefined`, and such a conversation should be backfilled from its legacy
 * fields rather than left with nothing.
 *
 * The scope jid is captured up front: an account switch mid-pass must not write
 * the previous account's positions into the new account's conversations.
 *
 * The same `pending` map is registered as {@link unmigratedLegacyReadState} for
 * `storageKey`, so `serializeState` keeps writing the legacy values back until
 * this pass (or the user's own reading) produces a pointer. Registration happens
 * synchronously, BEFORE the pass yields: `switchAccount` calls `set()` inside the
 * same call that reaches here, and that `set` still persists synchronously —
 * `switchAccount` calls `flush()` first, closing any open throttle window, so
 * this write takes the throttle's leading edge.
 */
function scheduleReadPointerBackfill(
  conversationMeta: Map<string, ConversationMetadata>,
  legacyReadState: Map<string, LegacyReadState>,
  storageKey: string
): void {
  const pending = new Map<string, LegacyReadState>()
  for (const [id, meta] of conversationMeta) {
    // Already migrated (or written this session) — leave it alone.
    if (meta.readPointer) continue
    const legacy = legacyReadState.get(id)
    // Never read: no legacy state to carry forward, so no pointer is correct.
    if (!legacy?.lastSeenMessageId && !legacy?.lastReadAt) continue
    pending.set(id, { lastSeenMessageId: legacy.lastSeenMessageId, lastReadAt: legacy.lastReadAt })
  }
  // Set OR delete: a reload that finds nothing left to migrate must retire the
  // previous registration for this key, not leave it re-emitting forever.
  if (pending.size === 0) {
    unmigratedLegacyReadState.delete(storageKey)
    return
  }
  unmigratedLegacyReadState.set(storageKey, pending)

  const scopeAtSchedule = getStorageScopeJid()
  void (async () => {
    // Yield a full task before touching the store. `deserializeState` runs from
    // INSIDE the persist middleware's `getItem`, so the restored state has not
    // been applied yet. With today's synchronous storage that ordering is safe
    // without the yield — zustand wraps `getItem` in a synchronous thenable and
    // runs the whole `hydrate()` chain, `set(stateFromStorage)` included, before
    // control returns, so no continuation of ours can preempt it. The yield is
    // insurance against a future ASYNC storage, where `set` would land in a
    // later task and the both-fields branch below (which needs no cache read)
    // could otherwise write a pointer into a conversation that does not exist
    // yet — a silent no-op, and exactly the loss this backfill cannot survive. It also
    // keeps the store reference off the module's own evaluation stack.
    await new Promise((resolve) => setTimeout(resolve, 0))

    for (const [conversationId, legacy] of pending) {
      // Isolated per conversation: an unhandled throw here would cancel the pass
      // for every conversation still queued, and the migration deletes the legacy
      // fields — a skipped conversation loses its read position for good.
      try {
        const migrated = await migrateReadPointer(conversationId, legacy)
        if (getStorageScopeJid() !== scopeAtSchedule) return
        // A conversation whose legacy position can NEVER resolve (lastReadAt
        // predates every cached message, or a lastSeenMessageId the cache never
        // holds) stays in `pending` permanently, and serializeState keeps
        // re-emitting its legacy pair every launch so a later launch — whose
        // cache may hold more — can still resolve it. That is deliberate and
        // self-limiting: the set only ever holds pre-#1081 conversations
        // (legacy fields are never written fresh).
        //
        // Being stuck does not cost the conversation its count: no
        // `hasUnmigratedLegacyReadState` stand-down sits ahead of the derivation
        // in recomputeUnreadForConversation, which writes no pointer. So
        // a stuck conversation IS reconciled by the archive recount, the
        // coalesce/overlay fold-in, and every later cold-start recount, exactly
        // like any other entity — from its readPointer if a direct path
        // (activation, markAsRead, XEP-0490) has written one, otherwise from its
        // `historyFloor`. That is NOT the common case here, though: this backfill
        // only ever enqueues pointerless conversations, and a pre-#1081 restore
        // typically carries a non-zero persisted `unreadCount`. For that shape,
        // `pointerlessDefers` stands the recount down before `historyFloor` is
        // ever consulted, and the badge stays stale until the
        // pointer itself resolves. With a persisted zero (or no floor at all),
        // `if (!floor) return` defers it too, as it does everywhere.
        //
        // The read POSITION is still never inferred here: pointerless entities
        // count from the floor and the recount commits nothing but unreadCount,
        // so a stuck conversation cannot have its position advanced by the
        // reconciliation — only its badge corrected.
        if (!migrated) continue
        applyMigratedReadPointer(conversationId, migrated)
        // Deliberately AFTER the apply. The apply's `setState` replaces the
        // pending thunk with a newer snapshot, so whichever thunk eventually
        // runs already carries the pointer and already omits the legacy pair
        // — `serializeState` skips any conversation holding a pointer — so
        // nothing is gained by dropping the entry first, while a throw in
        // between would leave the conversation pointerless AND legacy-less,
        // which is the state this whole mechanism exists to prevent.
        pending.delete(conversationId)
      } catch (error) {
        // Left in `pending`, so the values survive this launch's writes and the
        // next launch tries again.
        console.warn(`Read pointer migration failed for ${conversationId}:`, error)
      }
    }
  })()
}

/**
 * Cold-start recount trigger: the persisted `unreadCount` restored by
 * `deserializeState` is the last count this device wrote — trusted at the
 * moment it was written, but potentially stale by however much arrived while
 * the app was closed. Schedule an archive-derived recompute for every
 * restored conversation so the badge reconciles once this session's MAM
 * catch-up establishes coverage; until then `recomputeUnreadForConversation`
 * defers (coverage isn't proven yet at this point), which is exactly why the
 * restored value paints immediately instead of flashing to zero.
 *
 * Fire-and-forget and scope-guarded like {@link scheduleReadPointerBackfill}:
 * `deserializeState` is synchronous and runs from inside the persist
 * middleware's `getItem`, before the restored state has actually landed, so
 * this yields a task first. An account switch mid-pass must not recompute
 * into the new account's conversations.
 */
function scheduleColdStartRecounts(conversationMeta: Map<string, ConversationMetadata>, storageKey: string): void {
  const ids = Array.from(conversationMeta.keys())
  if (ids.length === 0) return

  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const conversationId of ids) {
      if (getScopedStorageKey() !== storageKey) return
      try {
        await chatStore.getState().recomputeUnreadForConversation(conversationId)
      } catch (error) {
        // Isolated per conversation: one failure must not cancel the recount
        // for every conversation still queued.
        console.warn(`Cold-start unread recount failed for ${conversationId}:`, error)
      }
    }
  })()
}

// Deserialize arrays back to Maps, restore Date objects
// Also handles migration of old localStorage messages to IndexedDB
//
// `storageKey` is the key this state will be PERSISTED under, which is not
// always the key it was read from: the pre-scope migration below reads the
// unscoped blob and writes the scoped one. The un-migrated legacy read state is
// registered under the write key so `serializeState` can find it again.
function deserializeState(persisted: PersistedState, storageKey: string): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'archivedConversations' | 'drafts' | 'conversationGaps' | 'conversationCoverage' | 'pendingRetractions'> {
  // Helper to restore Date objects in lastMessage
  const restoreLastMessage = (lastMessage?: Message): Message | undefined => {
    if (!lastMessage) return undefined
    return { ...lastMessage, timestamp: new Date(lastMessage.timestamp) }
  }

  // Helper to restore a persisted Date (it lands on disk as an ISO string,
  // even though the in-memory type says Date). Used for the legacy `lastReadAt`
  // and for historyFloor, which is compared against message timestamps — a
  // string there would make every comparison lie rather than throw.
  const restoreDate = (value?: Date | string): Date | undefined => {
    if (!value) return undefined
    return value instanceof Date ? value : new Date(value)
  }

  // Legacy read state as it sits on disk, keyed by conversation. Not part of any
  // live type any more (#1081) — read here purely to feed the readPointer
  // backfill at the bottom of this function.
  const legacyReadState = new Map<string, LegacyReadState>()
  const captureLegacyReadState = (id: string, source: PersistedReadState): void => {
    const lastReadAt = restoreDate(source.lastReadAt)
    if (!source.lastSeenMessageId && !lastReadAt) return
    legacyReadState.set(id, { lastSeenMessageId: source.lastSeenMessageId, lastReadAt })
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
      persisted.conversationMeta!.map(([id, meta]) => {
        captureLegacyReadState(id, meta)
        // Named explicitly rather than spread, so the legacy read-state keys are
        // dropped from the live object instead of riding along invisibly.
        const { lastSeenMessageId: _seen, lastReadAt: _readAt, ...rest } = meta
        return [
          id,
          {
            ...rest,
            // The persisted count paints on cold start. Zeroing it here flashed
            // empty badges on every launch until something recomputed (#1081).
            unreadCount: meta.unreadCount ?? 0,
            lastMessage: restoreLastMessage(meta.lastMessage),
            historyFloor: restoreDate(meta.historyFloor),
            // The persisted value is untrusted, not really a `ReadPointer`: a chat
            // pointer riding inside `conversationMeta` goes through a plain
            // `JSON.stringify`, so its `timestamp` lands on disk as an ISO string
            // even though the in-memory type says `Date` (#1081).
            readPointer: deserializeReadPointer(meta.readPointer),
          },
        ]
      })
    )

    // Rebuild the combined map from the separated maps. This — not the blob —
    // is where `conversations` comes from on every new-format load, which is
    // why the map is not persisted at all. `shared/conversationMaps`
    // holds the same expression and is the only writer while the store is live,
    // so a restored map and a mutated one cannot disagree.
    conversations = new Map()
    for (const [id, entity] of conversationEntities) {
      const meta = conversationMeta.get(id)
      if (meta) {
        conversations.set(id, rebuildCompatEntry(entity, meta))
      }
    }
  } else {
    // Legacy format: deserialize combined map and extract separated maps
    conversations = new Map(
      (persisted.conversations ?? []).map(([id, conv]) => {
        captureLegacyReadState(id, conv)
        const { lastSeenMessageId: _seen, lastReadAt: _readAt, ...rest } = conv
        return [
          id,
          {
            ...rest,
            // Default to 'chat' for conversations stored before the type field was added
            type: conv.type ?? 'chat',
            // See the new-format branch: the persisted count survives the restore.
            unreadCount: conv.unreadCount ?? 0,
            lastMessage: restoreLastMessage(conv.lastMessage),
            historyFloor: restoreDate(conv.historyFloor),
            readPointer: deserializeReadPointer(conv.readPointer),
          },
        ]
      })
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
        readPointer: conv.readPointer,
        historyFloor: conv.historyFloor,
      })
    }
  }

  // Give every restored conversation a readPointer (fire-and-forget; #1081).
  // Runs after the restored maps land, since the resolution needs the async
  // message cache and this function is synchronous.
  scheduleReadPointerBackfill(conversationMeta, legacyReadState, storageKey)

  // Recount trigger (cold-start rehydrate): reconcile every restored
  // conversation's badge against the archive once this session's MAM catch-up
  // proves coverage (see scheduleColdStartRecounts's doc).
  scheduleColdStartRecounts(conversationMeta, storageKey)

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

  // Restore coverage records (backwards compatible - default to empty map)
  const conversationCoverage = new Map<string, CoverageRecord>(persisted.conversationCoverage || [])

  // Restore pending retractions (backwards compatible - default to empty map)
  const pendingRetractions = new Map<string, PendingRetraction[]>(persisted.pendingRetractions || [])

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
    conversationCoverage,
    pendingRetractions,
  }
}

function createEmptyChatState(): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'activationPending' | 'archivedConversations' | 'typingStates' | 'activeAnimation' | 'drafts' | 'mamQueryStates' | 'conversationGaps' | 'conversationCoverage' | 'pendingRetractions' | 'targetMessageId' | 'firstNewMessageMarkers' | 'windowAtLiveEdge' | 'lastArrivedMessage' | 'interiorPlacementVersions'> {
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
    conversationCoverage: new Map(),
    pendingRetractions: new Map(),
    targetMessageId: null,
    firstNewMessageMarkers: new Map(),
    windowAtLiveEdge: new Map(),
    lastArrivedMessage: new Map(),
    interiorPlacementVersions: new Map(),
  }
}

/**
 * One-time migration from pre-scope storage.
 *
 * Legacy versions stored chat data under a single unscoped key. For safety, we only migrate
 * conversation lists (active + archived classification) and intentionally skip drafts/messages.
 */
function migrateLegacyConversationListsToScoped(jid: string | null): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'archivedConversations' | 'typingStates' | 'activeAnimation' | 'drafts' | 'mamQueryStates' | 'conversationGaps' | 'conversationCoverage' | 'pendingRetractions' | 'targetMessageId' | 'firstNewMessageMarkers' | 'windowAtLiveEdge' | 'lastArrivedMessage' | 'interiorPlacementVersions'> | null {
  if (!jid) return null

  const legacyKey = getLegacyStorageKey()
  const scopedStorageKey = getScopedStorageKey(jid)
  if (legacyKey === scopedStorageKey) return null

  try {
    const legacyRaw = localStorage.getItem(legacyKey)
    if (!legacyRaw) return null

    const parsed = JSON.parse(legacyRaw)
    // Read from the unscoped key, but the state lands under the scoped one — so
    // that is where its un-migrated legacy read state has to be registered.
    const restored = deserializeState(parsed.state, scopedStorageKey)
    const migrated = createEmptyChatState()

    migrated.conversationEntities = restored.conversationEntities
    migrated.conversationMeta = restored.conversationMeta
    migrated.conversations = restored.conversations
    migrated.archivedConversations = restored.archivedConversations

    // The blob written here carries entities + meta only; the new-format read
    // branch rebuilds the compat map from them on the next load.
    const serialized = serializeState({
      conversationEntities: migrated.conversationEntities,
      conversationMeta: migrated.conversationMeta,
      messages: migrated.messages,
      archivedConversations: migrated.archivedConversations,
      drafts: migrated.drafts,
    }, scopedStorageKey)

    // Persist migrated conversation lists to scoped storage and clear the legacy key.
    localStorage.setItem(scopedStorageKey, JSON.stringify({ state: serialized }))
    localStorage.removeItem(legacyKey)

    return migrated
  } catch {
    return null
  }
}

function loadScopedChatState(jid: string | null): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'archivedConversations' | 'typingStates' | 'activeAnimation' | 'drafts' | 'mamQueryStates' | 'conversationGaps' | 'conversationCoverage' | 'pendingRetractions' | 'targetMessageId' | 'firstNewMessageMarkers' | 'windowAtLiveEdge' | 'lastArrivedMessage' | 'interiorPlacementVersions'> {
  const baseState = createEmptyChatState()
  const scopedStorageKey = getScopedStorageKey(jid)

  try {
    const str = localStorage.getItem(scopedStorageKey)
    if (!str) {
      const migrated = migrateLegacyConversationListsToScoped(jid)
      return migrated ?? baseState
    }
    const parsed = JSON.parse(str)
    const restored = deserializeState(parsed.state, scopedStorageKey)
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
      conversationCoverage: restored.conversationCoverage,
      pendingRetractions: restored.pendingRetractions,
    }
  } catch {
    try {
      // No `cancelDurableMaps` here, against §3.2's rule, and it is safe only
      // because of WHERE this runs: both callers are LOAD paths (store creation,
      // and `switchAccount` — which flushes and calls
      // `forgetAllDurableMapBaselines` before it gets here), so this key has
      // neither an open window nor a structural baseline to invalidate. A future
      // caller that reaches this after any write to `scopedStorageKey` must use
      // `cancelDurableMaps` instead, or a pending thunk resurrects the blob this
      // line just removed.
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
        if (prevId) remoteDividerAdvances.clear(prevId)
        if (id) remoteDividerAdvances.clear(id)

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
          // Begin a fresh viewport-evidence generation SYNCHRONOUSLY, before
          // the `set()` calls below make this activation visible to subscribers/renders.
          // This is the SOLE call site for `beginViewportGeneration` — the view only
          // ever reads the generation it produces (`currentViewportGeneration`) and
          // reports against it (`reportViewport`); it never begins one itself. Runs
          // whether or not `conv` resolves below, so every real activation of a
          // non-null id gets a fresh generation.
          beginViewportGeneration(chatViewportEvidenceKey(id))

          const conv = get().conversations.get(id)
          if (conv) {
            // Use conversationMeta if available, otherwise derive from conversations map
            const meta = get().conversationMeta.get(id)
            const notifInput: notifState.EntityNotificationState = {
              unreadCount: meta?.unreadCount ?? conv.unreadCount ?? 0,
              mentionsCount: 0,
              readPointer: meta?.readPointer ?? conv.readPointer,
              // The read BOUNDARY, not just the pointer: a conversation that has
              // never been read has no pointer, and the creation watermark is
              // then the only floor the divider can derive from.
              // `computeFloor` is pointer-wins, so this only matters
              // for the pointerless case.
              historyFloor: meta?.historyFloor ?? conv.historyFloor,
              firstNewMessageId: undefined,
            }

            const messages = get().messages.get(id) || []
            // Position the divider at the first message the canonical count
            // would count — same floor, same predicate (see onActivate).
            const activated = notifState.onActivate(notifInput, messages, 'chat')

            set((state) => {
              const draft = draftConversationMaps(state)
              draft.setMeta(id, {
                ...(draft.getMeta(id) ?? { unreadCount: 0, readPointer: undefined }),
                unreadCount: activated.unreadCount,
                readPointer: activated.readPointer,
              })
              const newMarkers = new Map(state.firstNewMessageMarkers)
              if (activated.firstNewMessageId) newMarkers.set(id, activated.firstNewMessageId)
              else newMarkers.delete(id)
              return { ...draft.commit(), activeConversationId: id, firstNewMessageMarkers: newMarkers }
            })
            // final-fix-2: reconcile the entity we just LEFT (see the trigger
            // below the final fallback `set()` for the full rationale, including
            // the `worthReconcilingOnDeactivate` guard). By this point activeConversationId
            // already reads `id`, not `prevId`, so the ordinary (non-allowActive)
            // guard in recomputeUnreadForConversation does not see prevId as
            // active and proceeds normally.
            if (prevId && prevId !== id && worthReconcilingOnDeactivate(get().conversationMeta.get(prevId))) {
              void get().recomputeUnreadForConversation(prevId)
            }
            // ...and reconcile the entity we just ENTERED — the room twin of
            // this trigger carries the full rationale. In short: the
            // convergence is a side effect of the read pointer MOVING, and
            // onMessageSeen returns its input unchanged once the pointer sits
            // on the newest loaded message. Opening a conversation already at
            // the live edge with the pointer already at newest therefore makes
            // every viewport report a no-op, schedules no recount, and strands
            // a stale badge for as long as the conversation stays open.
            // Activation was the one entry point without a recount of its own.
            //
            // A DERIVATION against the current pointer, not an unconditional
            // zero: real unread keeps a real count, and the
            // divider is repositioned rather than retired while active.
            if (activated.unreadCount > 0) {
              void get().recomputeUnreadForConversation(id, { allowActive: true })
            }
            return
          }
        }
        // Default case: conversation not found, just set active
        set({ activeConversationId: id })
        // final-fix-2: deactivation is the other trigger this fix adds (the
        // twin of advanceReadPointer's live-edge trigger below). The
        // convergence advances the READ POINTER while an entity is active but
        // never re-derives the COUNT for it — advanceReadPointer now schedules
        // that recount itself while still active, but a conversation that
        // never received another arrival after the pointer advanced would
        // otherwise carry its stale count forward until the NEXT arrival
        // bumped it. Reconciling on deactivation closes that gap: the ordinary
        // (non-allowActive) form is correct here — activeConversationId has
        // just been set above (to `id`, possibly null), so prevId reads as
        // genuinely inactive and the guard proceeds rather than skipping.
        //
        // `worthReconcilingOnDeactivate` skips a truly fresh entity (no read
        // pointer ever established AND unreadCount already 0) — there is
        // nothing this recompute could correct, and calling it anyway would
        // cost a real cache read for every close of a never-opened,
        // never-unread conversation (pins "should deactivate immediately
        // without touching the cache when passed null" in chatStore.test.ts).
        // A conversation that was genuinely read (a pointer exists) or genuinely
        // has unread (a nonzero count) still triggers, which is what the
        // acceptance scenario needs.
        if (prevId && prevId !== id && worthReconcilingOnDeactivate(get().conversationMeta.get(prevId))) {
          void get().recomputeUnreadForConversation(prevId)
        }
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
          // XEP-0490: fold any pending remote read position into readPointer
          // BEFORE setActiveConversation derives the new-message divider. The fresh
          // session MDS seed runs before messages load, so the marker is stashed as
          // pendingRemoteDisplayedStanzaId; resolve it now (forward-only, against the
          // just-loaded messages) so the divider reflects reads synced from other
          // devices instead of the stale local position. Applied only once per
          // distinct RESOLVED marker this session — a fold that could not order
          // the marker against the local pointer stays retryable, while a resolved
          // one is never re-folded (that would reposition the divider on every
          // return). Gate + retry policy live in shared/readMarkerSync.
          const foldOnce = (stage: string) => {
            const lastSeenBefore = get().conversationMeta.get(id)?.readPointer?.identity.messageId
            const fold = foldPendingRemoteDisplayed(
              mdsGate,
              id,
              () => get().conversationMeta.get(id)?.pendingRemoteDisplayedStanzaId,
              (stanzaId) => get().applyRemoteDisplayed(id, stanzaId)
            )
            if (fold.attempted) {
              markerDebugLog(`activation fold (XEP-0490 pending → divider, ${stage})`, {
                conversationId: id,
                pendingStanzaId: fold.pending,
                lastSeenBefore,
                lastSeenAfter: get().conversationMeta.get(id)?.readPointer?.identity.messageId,
                resolved: fold.resolved,
              })
            } else if (fold.pending) {
              markerDebugLog('activation fold SKIPPED (marker already resolved this session — PEP keeps it live)', {
                conversationId: id,
                pendingStanzaId: fold.pending,
              })
            }
          }
          foldOnce('latest slice')

          // Resume anchor: if the read pointer is deeper than the latest-100
          // slice, reload the window AROUND it (IndexedDB only) so the entry
          // scroll can anchor on the divider with the history the user already
          // read sitting above it. The fold above ran first — it may have
          // advanced the pointer to the synced position.
          //
          // The DIVIDER does not depend on this load. `onActivate` derives it by
          // cache POSITION — the first renderable incoming message strictly
          // after the pointer in `(timestamp, tiebreak)` order — so an
          // off-slice pointer places it exactly as well as a resident one. The
          // stale-pointer fallback ladder that made an off-slice pointer a
          // degraded case is gone. What a cache miss costs is CONTEXT: the
          // latest slice is kept, the divider lands wherever the boundary falls
          // inside it, and MAM catch-up heals the cache for the next open.
          const pointer = get().conversationMeta.get(id)?.readPointer?.identity.messageId
          if (pointer) {
            const loaded = get().messages.get(id) ?? []
            if (!loaded.some((m) => m.id === pointer)) {
              await get().loadMessagesAroundFromCache(id, pointer)
              if (token !== activationToken) return
              // Retry against the post-load slice: it may now contain both the
              // local pointer and remote marker needed for archive-index ordering.
              foldOnce('around slice')
            }
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
          const existingMeta = state.conversationMeta.get(conv.id)
          // Extract metadata fields (frequently-changing)
          const meta: ConversationMetadata = {
            unreadCount: conv.unreadCount,
            lastMessage: conv.lastMessage,
            readPointer: conv.readPointer,
            // When this conversation entered our world. Written once, at
            // creation, and never again — a floor that moved on every re-add
            // would keep burying history the user has not seen. The persisted
            // value comes back through `deserializeState`, so a conversation
            // re-added after a restart finds its original floor here.
            historyFloor: existingMeta?.historyFloor ?? conv.historyFloor ?? new Date(),
            pendingRemoteDisplayedStanzaId: conv.pendingRemoteDisplayedStanzaId,
          }

          const draft = draftConversationMaps(state)
          draft.upsert(conv.id, entity, meta)
          return draft.commit()
        })
      },

      updateConversationName: (id, name) => {
        set((state) => {
          // Name is entity data; the compat entry follows from it.
          const draft = draftConversationMaps(state)
          if (!draft.patchEntity(id, { name })) return state
          return draft.commit()
        })
      },

      deleteConversation: (id) => {
        // Delete messages from IndexedDB asynchronously
        void messageCache.deleteConversationMessages(id)
        // The durable cursors describe messages that no longer exist (Codex
        // r4 #5): drop them with the cache, and invalidate in-flight deferred
        // commits so one can't resurrect an entry for the deleted
        // conversation.
        invalidateChatEntity(id)

        set((state) => {
          // Remove from all three conversation maps
          const draft = draftConversationMaps(state)
          draft.remove(id)

          // Also delete all messages for this conversation from memory
          const newMessages = new Map(state.messages)
          newMessages.delete(id)

          // Remove from archived set if present
          const newArchived = new Set(state.archivedConversations)
          newArchived.delete(id)

          // Drop the durable cursors with the cache (Codex r4 #5)
          const newGaps = new Map(state.conversationGaps)
          newGaps.delete(id)
          const newCoverage = new Map(state.conversationCoverage)
          newCoverage.delete(id)

          // Clear active conversation if it's the one being deleted
          const newActiveId = state.activeConversationId === id ? null : state.activeConversationId

          return {
            ...draft.commit(),
            messages: newMessages,
            archivedConversations: newArchived,
            conversationGaps: newGaps,
            conversationCoverage: newCoverage,
            activeConversationId: newActiveId,
          }
        })
      },

      addMessage: (incoming) => {
        bumpChatUnreadInputVersion(incoming.conversationId)

        // XEP-0424: a retraction can outrun its target (live retraction against a
        // non-resident message, out-of-order delivery). Tombstone BEFORE the
        // append so the cache write below persists the tombstone — patching
        // afterwards would race saveMessage.
        const arrival = resolvePendingRetractions(get(), incoming.conversationId, [incoming], { persist: false })
        const msg = arrival.messages[0]
        if (arrival.pendingRetractions) set({ pendingRetractions: arrival.pendingRetractions })

        // Unread messages that are not yet durable use the transient overlay:
        // permanently for `noLocalStore`, and until a live cache write commits
        // for ordinary messages. It is computed once here, before the state update, so
        // `noteTransient` (a side-effecting Map mutation) runs exactly once
        // per arrival. Gated on `isUnseenIncomingMessage` so we never note an
        // outgoing/seen/historical arrival that `onMessageReceived` would not
        // have incremented for anyway — mirrors that pure function's own
        // branching exactly (see its doc).
        //
        // `viewportAtLiveEdge` is read here
        // too (not just inside `onMessageReceived`'s own `set()` below) so
        // `isUnseenIncomingMessage` sees the SAME evidence and genuinely
        // mirrors `onMessageReceived`'s `userSeesMessage` check — an active,
        // focused, but SCROLLED-UP conversation (not at the live edge) is
        // "unseen" here too, so a noLocalStore message arriving in that state
        // gets recorded in the overlay instead of being representable ONLY by
        // the live `+1`, which an archive-only recount can never see again.
        const priorMeta = get().conversationMeta.get(msg.conversationId)
        const viewportAtLiveEdgeForNote =
          currentViewportEvidence(chatViewportEvidenceKey(msg.conversationId)) === 'at-edge'
        const unseen = notifState.isUnseenIncomingMessage(
          msg,
          {
            isActive: get().activeConversationId === msg.conversationId,
            windowVisible: connectionStore.getState().windowVisible,
            viewportAtLiveEdge: viewportAtLiveEdgeForNote,
          },
          { treatDelayedAsNew: true }
        )
        const noteAsTransient = unseen && isRenderableStoredMessage(msg)
        let overlayUnreadDelta = 0
        let overlayRequiresRecount = false
        let acceptedMessage = false
        if (noteAsTransient && priorMeta) {
          const scopeKey = chatTransientScopeKey(msg.conversationId)
          // No boundary here: `isUnseenIncomingMessage` above already
          // establishes this is a genuine new arrival relative to the read
          // state, so only the BEFORE/AFTER *delta* matters — adding one
          // brand-new logical entry always changes the raw (unbounded) count
          // by exactly 1. (The real floor would be redundant AND riskier: a
          // fresh conversation's historyFloor is stamped "now" at creation, so
          // a message arriving within the same millisecond would tie rather
          // than compare strictly-after it, undercounting the very message
          // this branch exists to count.)
          const before = transientCounts(scopeKey, undefined).unread
          const result = noteTransient(
            scopeKey,
            { position: exactPosition(msg, 'chat') },
            transientIdentity({ id: msg.id }, 'chat'),
            transientAliases({ id: msg.id }, 'chat')
          )
          // `added` drives the +1 (case 1: brand-new logical entry). Re-reading
          // transientCounts rather than hardcoding +1 keeps this delta honest
          // against the SAME primitive the async recount uses — see
          // `transientUnread.ts`'s module doc on why the overlay must never be
          // approximated ad hoc.
          if (result.added) {
            overlayUnreadDelta = Math.max(0, transientCounts(scopeKey, undefined).unread - before)
          }
          // Handled by the archive-derived recompute scheduled after the set()
          // below; see `noteTransient`'s doc on `requiresRecount`.
          overlayRequiresRecount = result.requiresRecount
        }

        set((state) => {
          const convMessages = state.messages.get(msg.conversationId) || []

          // Shared timeline machine: dedupe (XEP-0359 keys), archive-id
          // backfill on duplicate echoes, live-edge gating (ABSENT or true =
          // at the live edge; a slid window gates the append so a fresh
          // message never splices after an OLD one), and window trim.
          const atLiveEdge = state.windowAtLiveEdge.get(msg.conversationId) !== false
          const appendObservation: timeline.AppendLiveObservation = {}
          const append = timeline.appendLive(
            convMessages,
            msg,
            atLiveEdge,
            chatTimelineConfig(),
            appendObservation
          )

          if (append.kind === 'duplicate-unchanged') return state
          if (append.kind === 'duplicate-backfilled') {
            // Persist the backfilled archive ids so pagination cursors survive a reload.
            for (const p of append.patched) {
              void messageCache.updateMessage(p.id, { stanzaId: p.stanzaId!, ...(p.originId ? { originId: p.originId } : {}) })
            }
            const patchedMap = new Map(state.messages)
            patchedMap.set(msg.conversationId, append.messages)
            return { messages: patchedMap }
          }
          acceptedMessage = true

          const newMessages = new Map(state.messages)
          newMessages.set(
            msg.conversationId,
            append.kind === 'appended' ? append.messages : convMessages
          )
          const interiorPlacementPatch = appendObservation.placement === 'interior'
            ? {
                interiorPlacementVersions: new Map(state.interiorPlacementVersions).set(
                  msg.conversationId,
                  (state.interiorPlacementVersions.get(msg.conversationId) ?? 0) + 1
                ),
              }
            : {}

          // Record the arrival. Both surviving append kinds are genuine
          // deliveries — 'appended' spliced into the resident window, 'gated'
          // held out of a window slid back into history — and the duplicate
          // kinds already returned above. This is the signal notification
          // consumers diff; see the field's declaration for why the sidebar
          // preview cannot be used instead.
          const newArrived = new Map(state.lastArrivedMessage)
          newArrived.set(msg.conversationId, msg)

          const conv = state.conversations.get(msg.conversationId)
          const meta = state.conversationMeta.get(msg.conversationId)
          if (conv && meta) {
            const isActive = state.activeConversationId === msg.conversationId
            const windowVisible = connectionStore.getState().windowVisible
            // The on-arrival pointer advance requires DEMONSTRABLY being at
            // the live edge for the CURRENT activation generation — missing/stale/
            // unknown evidence (a conversation that has never reported, or whose only
            // reports were rejected as stale) reads 'unknown' here, which is NOT
            // 'at-edge', so this conservatively resolves to false.
            const viewportAtLiveEdge = currentViewportEvidence(chatViewportEvidenceKey(msg.conversationId)) === 'at-edge'

            // Delegate notification state transition to pure function. When
            // this arrival is being noted in the transient overlay above,
            // `incrementUnread: false` suppresses this branch's OWN +1 — its
            // contribution is `overlayUnreadDelta` (applied to `unreadCount`
            // below), so the two paths can never double-count the same
            // message.
            const notif = notifState.onMessageReceived(
              {
                unreadCount: meta.unreadCount,
                mentionsCount: 0,
                readPointer: meta.readPointer,
                firstNewMessageId: state.firstNewMessageMarkers.get(msg.conversationId),
              },
              msg,
              { isActive, windowVisible, viewportAtLiveEdge },
              'chat',
              // In 1:1 chats, delayed messages are offline delivery (new messages
              // sent while user was offline), so they should increment unread
              { treatDelayedAsNew: true, incrementUnread: !noteAsTransient }
            )
            const unreadCount = Math.min(999, notif.unreadCount + overlayUnreadDelta)

            // Sidebar preview policy, shared with every bulk-merge path so the
            // four call sites can't drift again. Falls back to the existing
            // lastMessage when the arrival must not become the preview:
            // - a bodiless signal placeholder (e.g. an undecrypted encrypted
            //   reaction) has nothing to show, and
            // - a DELAYED arrival (offline replay, s2s catch-up, gateway
            //   history) can be older than what we already know. This compares
            //   `msg` directly against `meta.lastMessage` rather than reading
            //   array position, so it holds regardless of where appendLive
            //   places the message (appendLive sorts its result into archive
            //   order rather than always appending at the end) — and for a
            //   backgrounded conversation the resident array is empty anyway,
            //   so dedupe has nothing to compare against either way. Without
            //   this guard a delayed arrival drags the sidebar back to an
            //   older message and that regression persists to localStorage.
            // 'replace' on ties: arrival order breaks equal timestamps, which
            // second-precision <delay/> stamps make common in a replay burst.
            const previewMessage =
              isPreviewableMessage(msg) && shouldReplaceLastMessage(meta.lastMessage, msg, 'replace')
                ? msg
                : meta.lastMessage

            const draft = draftConversationMaps(state)
            draft.patchMeta(msg.conversationId, {
              unreadCount,
              lastMessage: previewMessage,
              readPointer: notif.readPointer,
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
                  ...draft.commit(),
                  archivedConversations: newArchived,
                  firstNewMessageMarkers: newMarkers,
                  lastArrivedMessage: newArrived,
                  ...interiorPlacementPatch,
                }
              }
            }

            return { messages: newMessages, ...draft.commit(), firstNewMessageMarkers: newMarkers, lastArrivedMessage: newArrived, ...interiorPlacementPatch }
          }

          return { messages: newMessages, lastArrivedMessage: newArrived, ...interiorPlacementPatch }
        })

        if (!acceptedMessage && overlayUnreadDelta > 0) {
          removeTransient(chatTransientScopeKey(msg.conversationId), transientIdentity({ id: msg.id }, 'chat'))
        }

        if (acceptedMessage && !isNoLocalStore(msg)) {
          const scopeAtSave = getStorageScopeJid()
          const writeToken = chatPendingUnreadWrites.begin(msg.conversationId)
          const save = messageCache.saveMessageWithResult(msg)
          void save.then((committed) => {
            const owned = chatPendingUnreadWrites.finish(msg.conversationId, writeToken)
            if (!owned || getStorageScopeJid() !== scopeAtSave) return
            if (committed && noteAsTransient) {
              const removed = removeTransient(
                chatTransientScopeKey(msg.conversationId),
                transientIdentity({ id: msg.id }, 'chat')
              )
              if (removed.removed) bumpChatUnreadInputVersion(msg.conversationId)
            }
            chatRecountRetry.resume(msg.conversationId)
          })
          searchIndex.indexMessage(msg).catch((e) => console.warn('[searchIndex] indexMessage failed:', e))
        }

        // See `noteTransient`'s doc on `requiresRecount`: only the
        // archive-derived recompute can fold this change back into the stored
        // count. No-ops for the active conversation.
        if (overlayRequiresRecount) {
          void get().recomputeUnreadForConversation(msg.conversationId)
        }
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
            readPointer: meta?.readPointer ?? conv.readPointer,
            firstNewMessageId: state.firstNewMessageMarkers.get(conversationId),
          }

          const messages = state.messages.get(conversationId) || []

          const windowAtLiveEdge = state.windowAtLiveEdge.get(conversationId) !== false
          const viewportAtLiveEdge =
            currentViewportEvidence(chatViewportEvidenceKey(conversationId)) === 'at-edge'
          const updated = notifState.onMarkAsRead(notifInput, messages, 'chat', {
            windowAtLiveEdge,
            viewportAtLiveEdge,
          })

          // Pure function returns the same reference when nothing changed.
          if (updated === notifInput) return {}

          // The read pointer just moved (or the counts were cleared) — bound the
          // transient overlay's memory now rather than waiting for a later
          // recompute trigger.
          if (updated.readPointer && updated.readPointer !== notifInput.readPointer) {
            pruneTransient(chatTransientScopeKey(conversationId), updated.readPointer.order)
          }

          const draft = draftConversationMaps(state)
          draft.setMeta(conversationId, {
            ...(draft.getMeta(conversationId) ?? { unreadCount: 0, readPointer: undefined }),
            unreadCount: updated.unreadCount,
            readPointer: updated.readPointer,
          })

          return draft.commit()
        })
      },

      markReadToNewest: (conversationId) => {
        remoteDividerAdvances.clear(conversationId)
        set((state) => {
          const existing = state.conversations.get(conversationId)
          if (!existing) return state

          const meta = state.conversationMeta.get(conversationId)
          const messages = state.messages.get(conversationId)
          const newest = messages?.[messages.length - 1] ?? meta?.lastMessage ?? existing.lastMessage
          if (!newest) return state

          // Skip update if already fully read: pointer at the computed newest id,
          // no unread count, and no "new messages" divider to clear.
          const currentSeenMessageId = (meta?.readPointer ?? existing.readPointer)?.identity.messageId
          const currentUnreadCount = meta?.unreadCount ?? existing.unreadCount ?? 0
          if (
            currentSeenMessageId === newest.id &&
            currentUnreadCount === 0 &&
            !state.firstNewMessageMarkers.has(conversationId)
          ) {
            return state
          }

          const readPointer = makeReadPointer(newest, 'chat')

          // Mark-all-read jumps the pointer straight to the newest message —
          // prune the overlay now rather than leaving every noted entry to a
          // later recompute trigger.
          pruneTransient(chatTransientScopeKey(conversationId), readPointer.order)

          const draft = draftConversationMaps(state)
          draft.setMeta(conversationId, {
            ...(draft.getMeta(conversationId) ?? { unreadCount: 0 }),
            readPointer,
            unreadCount: 0,
          })

          const newMarkers = new Map(state.firstNewMessageMarkers)
          newMarkers.delete(conversationId)

          return { ...draft.commit(), firstNewMessageMarkers: newMarkers }
        })
      },

      clearFirstNewMessageId: (conversationId) => {
        remoteDividerAdvances.clear(conversationId)
        set((state) => {
          const next = clearMarker(state.firstNewMessageMarkers, conversationId)
          return next ? { firstNewMessageMarkers: next } : state
        })
      },

      resyncDividerToReadPointer: (conversationId) => {
        set((state) => {
          // Only reposition an EXISTING divider — never resurrect one the reader has cleared.
          if (!state.firstNewMessageMarkers.has(conversationId)) return state
          const meta = state.conversationMeta.get(conversationId)
          if (!meta) return state
          const messages = state.messages.get(conversationId) || []

          // Derive the divider from the pointer via onActivate and keep only
          // .firstNewMessageId.
          const divider = notifState.onActivate(
            {
              unreadCount: 0,
              mentionsCount: 0,
              readPointer: meta.readPointer,
              // Pointerless conversations reach this too (the divider can be
              // parked by an arrival while the window was hidden), and their
              // only boundary is the creation watermark.
              historyFloor: meta.historyFloor,
              firstNewMessageId: undefined,
            },
            messages,
            'chat'
          ).firstNewMessageId

          // Only ever reposition the divider FORWARD to a real unread message. When there is no unread
          // after the pointer (divider undefined — reader is at the newest), do NOT clear it here: the
          // divider is deliberately kept alive after a FAB jump-to-present so the jump-to-last-read pill
          // can offer a return, and the explicit read-through / mark-read paths own clearing.
          if (!divider || divider === state.firstNewMessageMarkers.get(conversationId)) return state
          const newMarkers = new Map(state.firstNewMessageMarkers)
          newMarkers.set(conversationId, divider)
          return { firstNewMessageMarkers: newMarkers }
        })
      },

      advanceReadPointer: (conversationId, messageId) => {
        // Presence gate (issue #1076) — see the roomStore twin. The viewport
        // observer reports what is PAINTED, and the list auto-scrolls to arriving
        // messages whether or not the user is at the window. Rendered is not seen.
        //
        // This gate is independent of
        // where the count comes from — painted is not seen — so nothing in the
        // derived-count model makes it redundant.
        if (!connectionStore.getState().windowVisible) return

        let pointerAdvanced = false
        set((state) => {
          const meta = state.conversationMeta.get(conversationId)
          if (!meta) return state

          const messages = state.messages.get(conversationId) || []
          const atLiveEdge = state.windowAtLiveEdge.get(conversationId) !== false
          const updated = notifState.onMessageSeen(
            {
              unreadCount: meta.unreadCount,
              mentionsCount: 0,
              readPointer: meta.readPointer,
              firstNewMessageId: state.firstNewMessageMarkers.get(conversationId),
            },
            messageId,
            messages,
            'chat',
            { atLiveEdge }
          )

          // No change: onMessageSeen hands back the pointer it was given (by
          // reference) whenever it did not advance, and a fresh object when it did.
          if (updated.readPointer === meta.readPointer) return state

          pointerAdvanced = true

          // The viewport-driven pointer just advanced — bound the transient
          // overlay's memory.
          if (updated.readPointer) {
            pruneTransient(chatTransientScopeKey(conversationId), updated.readPointer.order)
          }

          const draft = draftConversationMaps(state)
          draft.patchMeta(conversationId, { readPointer: updated.readPointer })
          return draft.commit()
        })

        // onMessageSeen only ever moves the
        // pointer — it never recomputes unreadCount, and nothing else did
        // either once onActivate stopped force-zeroing the active entity. Without
        // this trigger, live-edge convergence (acceptance scenario 5: scroll an
        // active, focused conversation to the bottom) left the sidebar badge at
        // its stale pre-convergence value until the next arrival or the next
        // activation. `allowActive: true` is safe here because a pointer only
        // ever advances against the RESIDENT messages array, which only the
        // active conversation keeps (setActiveConversation evicts everyone
        // else's) — this trigger only ever fires for the entity that is, in
        // practice, active.
        if (pointerAdvanced) {
          void get().recomputeUnreadForConversation(conversationId, { allowActive: true })
        }
      },

      applyRemoteDisplayed: (conversationId, stanzaId, messagesOverride) => {
        // Set when the resolution advanced the pointer on a NON-active
        // conversation — triggers the exact cache recount below.
        let advancedNonActive = false
        // Set when the resolution advanced the pointer on the ACTIVE
        // conversation. Activation writes no unconditional zero, so the active
        // entity's count is not "already zero" here — it needs the same
        // archive-derived re-derivation as the non-active case, just with the
        // active-conversation skip in recomputeUnreadForConversation
        // explicitly bypassed (`allowActive: true`).
        let advancedActive = false
        set((state) => {
          const meta = state.conversationMeta.get(conversationId)
          if (!meta) return state

          // A non-active conversation keeps no resident array (memory windowing), so
          // mergeMAMMessages passes the just-merged array here; otherwise read RAM.
          // The resolution state machine (stash / clear-pending / forward-only
          // advance) is shared — see shared/readMarkerSync.
          const messages = messagesOverride ?? (state.messages.get(conversationId) || [])
          const resolution = resolveRemoteDisplayed(
            {
              unreadCount: meta.unreadCount,
              mentionsCount: 0,
              readPointer: meta.readPointer,
              pendingRemoteDisplayedStanzaId: meta.pendingRemoteDisplayedStanzaId,
            },
            messages,
            state.firstNewMessageMarkers.get(conversationId),
            stanzaId,
            'chat',
            { isActive: state.activeConversationId === conversationId }
          )
          if (resolution.kind === 'unchanged') return state

          const clearsPending = meta.pendingRemoteDisplayedStanzaId === stanzaId
          const metaPatch =
            resolution.kind === 'stash-pending'
              ? { pendingRemoteDisplayedStanzaId: stanzaId }
              : resolution.kind === 'clear-pending'
                ? { pendingRemoteDisplayedStanzaId: undefined }
                : resolution.kind === 'resolved-active'
                  ? clearsPending
                    ? { pendingRemoteDisplayedStanzaId: undefined }
                    : undefined
                : {
                    readPointer: resolution.readPointer,
                    ...(clearsPending && { pendingRemoteDisplayedStanzaId: undefined }),
                  }

          const draft = draftConversationMaps(state)
          if (metaPatch) draft.patchMeta(conversationId, metaPatch)

          // Inbound read-state sync (spec §4): a marker published by another
          // client advances this conversation's read position now, not on the
          // next activation. The pointer keeps the forward-only position
          // resolved above (metaPatch.readPointer) — the unread COUNT is not
          // derived from this page-scoped slice (it may be a single
          // merged page of a multi-page pointer-stitch walk, which
          // undercounts): both advance kinds instead schedule the
          // archive-derived recount below, which is ALSO what makes a
          // not-yet-caught-up entity defer rather than commit a wrong number.
          // 'advanced-active' (the active entity) is NOT exempted here:
          // its counts are not "already zero", so the active entity needs this
          // re-derivation exactly as much as a non-active one does.
          if (resolution.kind === 'advanced') {
            advancedNonActive = true
          } else if (resolution.kind === 'advanced-active') {
            advancedActive = true
          }

          // The line follows a marker another client published: that marker states those messages
          // were read, so leaving the divider in front of them would mark as new what the user has
          // already seen. Scrolling THIS view is not such evidence and does not come through here.
          let newMarkers = state.firstNewMessageMarkers
          // The line follows a marker only when it reaches FURTHER than anything this client has told
          // the account it read. Publishing pushes to every resource of the account, so a marker at or
          // behind our own last published position is our own scroll coming back — live, replayed, or
          // re-read from the node on reconnect — and letting it move the line would make scrolling move
          // it through a loop. Past that position it carries something we never claimed, whoever sent
          // it. The wire cannot name the publisher; this is the question that can be answered.
          if (resolution.kind === 'advanced-active' || resolution.kind === 'resolved-active') {
            const markerPointer = resolution.kind === 'resolved-active'
              ? resolution.markerPointer
              : resolution.readPointer
            const claimed = locallyPublishedDisplayed(
              getBareJid(connectionStore.getState().jid ?? ''),
              conversationId,
            )
            if (claimed === undefined || isAhead(markerPointer, claimed)) {
              const dividerAdvance = remoteDividerAdvances.apply(
                conversationId,
                state.firstNewMessageMarkers.get(conversationId),
                markerPointer,
                messages,
                'chat',
              )
              if (dividerAdvance.kind === 'advanced') {
                newMarkers = new Map(state.firstNewMessageMarkers)
                newMarkers.set(conversationId, dividerAdvance.divider)
              }
            }
          }

          // `resolved-active` exists only to give a live divider a chance to move; it advances no
          // pointer. When the divider did not move and no pending marker needed clearing, nothing
          // changed — and rebuilding the entry here would re-derive it and re-render every consumer on
          // each echo of this client's own scrolling.
          if (
            resolution.kind === 'resolved-active' &&
            newMarkers === state.firstNewMessageMarkers &&
            metaPatch === undefined
          ) {
            return state
          }

          return { ...draft.commit(), firstNewMessageMarkers: newMarkers }
        })

        // Archive-derived recount (trigger: pointer advance / inbound
        // marker). recomputeUnreadForConversation re-derives the count from
        // the durable archive (its own resident-or-cache slice, independent of
        // `messages`/`messagesOverride` above), deferring — leaving the last
        // TRUSTED count untouched — whenever coverage isn't proven down to the
        // new floor, rather than committing a page-scoped undercount.
        if (advancedNonActive) {
          void get().recomputeUnreadForConversation(conversationId)
        } else if (advancedActive) {
          // The active entity gets the SAME re-derivation, with the
          // active-conversation skip explicitly bypassed — see this method's
          // doc and recomputeUnreadForConversation's.
          void get().recomputeUnreadForConversation(conversationId, { allowActive: true })
        }
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
          const draft = draftConversationMaps(state)
          const newArchived = new Set(state.archivedConversations)

          for (const serverConv of convs) {
            if (draft.getEntity(serverConv.id)) {
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
                // Creation moment — same lifecycle stamp as addConversation.
                // This branch only runs for a conversation we do not have, so
                // it can never restamp an existing floor.
                historyFloor: new Date(),
              }

              draft.upsert(serverConv.id, entity, meta)

              if (serverConv.archived) {
                newArchived.add(serverConv.id)
              }
            }
          }

          return {
            ...draft.commit(),
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
          if (!convMessages) {
            // Conversation isn't active — its messages aren't resident in RAM
            // (evicted on deactivation). Update reactions directly in the
            // durable cache so the correct state loads when the conversation
            // is reactivated, instead of silently dropping the reaction.
            logInfo(`Reaction for message ${messageId} not in memory — updating in cache`)
            void messageCache.updateMessageReactions(messageId, reactorJid, emojis)
            return state
          }

          // Resolve by id/stanzaId first, origin-id only as fallback (reactions
          // may reference any tier; origin-id must not shadow a real id).
          const messageIndex = findMessageIndexById(convMessages, messageId)
          if (messageIndex === -1) {
            // The conversation is resident but the target message is not (the
            // sliding window evicted it). Update the durable cache so the
            // reaction survives instead of being silently dropped.
            logInfo(`Reaction for message ${messageId} not in resident window — updating in cache`)
            void messageCache.updateMessageReactions(messageId, reactorJid, emojis)
            return state
          }

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
        let recountNeeded = false
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

          // A retraction may target a `noLocalStore` message noted in
          // the transient overlay (e.g. a Quick Chat message) — drop it so it
          // stops contributing, and schedule a recount if it actually left
          // (safe to call for every retraction: removeTransient is a no-op
          // when the alias was never noted).
          if (updates.isRetracted) {
            const removal = removeTransient(chatTransientScopeKey(conversationId), transientIdentity({ id: updatedMessage.id }, 'chat'))
            if (removal.removed) recountNeeded = true
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
          const isLastMessage = messageIndex === updatedConvMessages.length - 1
          const isPreviewMessage =
            !!meta?.lastMessage &&
            findMessageIndexById([meta.lastMessage], updatedMessage.id) !== -1
          if (isLastMessage || isPreviewMessage) {
            const draft = draftConversationMaps(state)
            if (draft.patchMeta(conversationId, { lastMessage: updatedMessage })) {
              return { messages: newMessages, ...draft.commit() }
            }
          }

          return { messages: newMessages }
        })

        if (recountNeeded) void get().recomputeUnreadForConversation(conversationId)
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
          const wasLastMessage =
            !!meta?.lastMessage &&
            (meta.lastMessage.id === updatedMessage.id || meta.lastMessage.stanzaId === stanzaId)

          if (wasLastMessage) {
            const draft = draftConversationMaps(state)
            if (draft.patchMeta(conversationId, { lastMessage: updatedMessage })) {
              return { messages: newMessages, ...draft.commit() }
            }
          }

          return { messages: newMessages }
        })
      },

      recordPendingRetraction: (conversationId, targetId, actorJid) => {
        const resident = get().messages.get(conversationId)
        const target = resident ? findMessageById(resident, targetId) : undefined
        if (target) {
          // Resolved on the spot — updateMessage carries the write-through to
          // IndexedDB and the search-index removal.
          if (!target.isRetracted && target.from === actorJid) {
            get().updateMessage(conversationId, target.id, { isRetracted: true, retractedAt: new Date() })
          }
          return
        }

        set((state) => {
          const existing = state.pendingRetractions.get(conversationId) ?? []
          const next = addPendingRetraction(existing, { targetId, actorJid, retractedAt: Date.now() })
          if (next === existing) return state
          const nextPending = new Map(state.pendingRetractions)
          nextPending.set(conversationId, next)
          return { pendingRetractions: nextPending }
        })

        // A pending retraction is a durable EVENT, not a lagging mirror: it
        // records a retraction whose target was not resident. Lose it and the
        // message is never tombstoned — once coverage marks the range covered,
        // MAM will not re-query it and the retraction never arrives again.
        //
        // `flushKey` rather than a re-serialize: the `set` above already drove
        // the persist adapter (zustand calls `setItem` synchronously inside
        // `set`), so the blob is either already on disk via the leading edge
        // or sitting in the pending thunk. This lands the second case and
        // costs nothing in the first.
        flushKey(getScopedStorageKey())
      },

      getMessage: (conversationId, messageId) => {
        const convMessages = get().messages.get(conversationId)
        if (!convMessages) return undefined
        return findMessageById(convMessages, messageId)
      },

      getConversationLastTimestamp: (conversationId) => {
        const state = get()
        return lastMessageTimestamp(state.conversationMeta, state.conversations, conversationId)
      },

      removeMessage: (conversationId, messageId) => {
        let recountNeeded = false
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

          // This may be dropping a noted `noLocalStore` message (a
          // bodiless placeholder never resolves to noLocalStore in practice,
          // but removeTransient is a harmless no-op when the alias was never
          // noted, so it is safe to call unconditionally here too).
          const removal = removeTransient(chatTransientScopeKey(conversationId), transientIdentity({ id: removed.id }, 'chat'))
          if (removal.removed) recountNeeded = true

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
            const lastMessage = findLastPreviewableMessage(updatedConvMessages)
            const draft = draftConversationMaps(state)
            draft.patchMeta(conversationId, { lastMessage })
            return { messages: newMessages, ...draft.commit() }
          }

          return { messages: newMessages }
        })

        if (recountNeeded) void get().recomputeUnreadForConversation(conversationId)
      },

      recomputeUnreadForConversation: async (conversationId, options) => {
        const allowActive = options?.allowActive ?? false
        const defer = (reason: RecountDeferralReason): void => {
          recordRecountDeferral('chat', reason)
          if (reason === 'input-version-changed') {
            chatRecountRetry.schedule(
              conversationId,
              allowActive,
              (retryOptions) => get().recomputeUnreadForConversation(conversationId, retryOptions),
              () => chatRecountReady(conversationId)
            )
          }
        }
        // Active conversation counts are usually reconciled by their own
        // synchronous path (the live-edge convergence) — skip here unless the
        // caller explicitly opted into the guarded archive derivation.
        if (!allowActive && get().activeConversationId === conversationId) return defer('active-skipped')

        // --- Defer conditions ---------------------------------------------
        //
        // ONE snapshot, read once, and every defer below decided against it —
        // the same object the derivation itself computes from. Do NOT add a
        // second `get()` and a second copy of a guard up here (#1174). Two
        // reads make "which snapshot did we check?" answerable two ways, and
        // they make each copy unfalsifiable: both read the same state and
        // evaluate the same pure predicate, so disabling one leaves the other
        // deferring and the whole suite green. With one read, deleting the
        // guard fails a test.
        //
        // The duplicate this replaced was justified as being "the correct check
        // the moment anything above it starts to await". That was not true:
        // both copies sat on the same side of every await, so the duplication
        // straddled nothing — it bought a coincidence, not a defence.
        //
        // Every guard here still sits ABOVE the first await
        // (`resolveCoverageBottom` below), so nothing can move underneath them
        // while they run. State that moves AFTER them is caught on the far side
        // by `recountContextDeferral()` and by the `pointerIdAtCompute`
        // re-check at the final commit. That is where a post-await guard
        // belongs — so if an await is ever inserted above this block, the fix
        // is a re-check after THAT await, not a second copy on this side.
        //
        // One guard also means ONE emission site for the `pointerless-defer`
        // reason (#1214), so a recorded pointerless defer is unambiguous about
        // which check produced it.
        //
        // Pointerless-with-a-trusted-nonzero-count stands down: a bare zero
        // derived for an entity that has never established a read position
        // cannot be told apart from a real "all read", and the count it would
        // overwrite was accumulated live.
        //
        // This derivation NEVER writes the read pointer. Neither snapping a
        // pointerless entity to the newest message nor advancing the pointer
        // onto an outgoing message in range belongs here: both are inferences
        // about what the user has read, and the pointer is forward-only, so a
        // wrong inference is unrecoverable. A pointerless entity counts from
        // its `historyFloor` creation watermark, and a cross-device reply moves
        // the read position only through XEP-0490.
        const metaNow = get().conversationMeta.get(conversationId)
        if (!metaNow) return defer('no-meta')
        if (metaNow.pendingRemoteDisplayedStanzaId !== undefined) return defer('pending-remote-displayed')
        if (pointerlessDefers(metaNow.readPointer, metaNow.unreadCount)) return defer('pointerless-defer')

        // Latest-wins: bumped once this call is committed to
        // running — AFTER the defers above, so a call that stands down cannot
        // cancel a recount already in flight for the same conversation — and
        // still before the first await, then re-checked immediately before
        // every commit below, so a slow recount that resolves after a faster,
        // newer one for the SAME conversation is discarded instead of
        // overwriting the newer (correct) result.
        const version = bumpChatRecountVersion(conversationId)
        const cacheEpochAtStart = chatCacheEpoch
        const entityEpochAtStart = currentChatEntityEpoch(conversationId)
        const storageScopeAtStart = getStorageScopeJid()
        const unreadInputVersionAtStart = chatUnreadInputVersion.get(conversationId) ?? 0
        const recountContextDeferral = (): RecountDeferralReason | undefined => {
          if (chatCacheEpoch !== cacheEpochAtStart || currentChatEntityEpoch(conversationId) !== entityEpochAtStart || getStorageScopeJid() !== storageScopeAtStart) {
            return 'context-changed'
          }
          if (chatRecountVersion.get(conversationId) !== version) return 'recount-superseded'
          if ((chatUnreadInputVersion.get(conversationId) ?? 0) !== unreadInputVersionAtStart) {
            return 'input-version-changed'
          }
          return undefined
        }

        // Snapshot the pointer identity the archive-derived count below is
        // computed against. Re-check it at the final commit because an
        // allowActive recount can race advanceReadPointer.
        const pointerIdAtCompute = metaNow.readPointer?.identity.messageId
        const unreadInputVersionAtCompute = chatUnreadInputVersion.get(conversationId) ?? 0

        const floor = computeFloor(metaNow.readPointer, metaNow.historyFloor)
        if (!floor) return defer('no-floor')

        // --- Coverage gate: every uncertain branch defers -
        const mam = mamState.getMAMQueryState(get().mamQueryStates, conversationId)
        if (!isCaughtUpForCounting(mam)) return defer('history-not-caught-up')

        const record = get().conversationCoverage.get(conversationId)
        const bottom = await resolveCoverageBottom(conversationId, record, false)
        const coverageContextDeferral = recountContextDeferral()
        if (coverageContextDeferral) return defer(coverageContextDeferral)
        if (bottom === 'missing') return defer('coverage-missing')
        if (bottom === 'unresolvable') {
          // Invalidate the stale record so a later merge can re-establish it,
          // guarded on the SAME bottomId so a record that already moved on
          // (a concurrent merge) is not clobbered.
          if (record) get().clearConversationCoverage(conversationId, record.bottomId)
          return defer('coverage-unresolvable')
        }
        // The boundary: the pointer's own order when there is one, so the
        // comparison is not blind to a coverage bottom sharing its exact
        // millisecond; a historyFloor-derived boundary knows only a millisecond
        // and says so (unresolved sorts conservatively).
        const floorPos: PointerOrder = metaNow.readPointer?.order ?? { role: 'floor', timestamp: floor.getTime() }

        // Safety net: this recompute is one of the "pointer advance / content
        // settled" triggers, and not every trigger path calls pruneTransient
        // directly.
        pruneTransient(chatTransientScopeKey(conversationId), floorPos)

        // A BOUNDARY test: a FLOOR (migrated) boundary reads as at-or-after its
        // millisecond, so an equal-ms bottom counts as not reaching it (#1173).
        if (isAfterBoundary(bottom, floorPos)) return defer('coverage-short-of-floor') // coverage doesn't reach the floor

        const res = await messageCache.countUnreadInArchive(conversationId, {
          floor,
          pointer: metaNow.readPointer?.order,
        })
        const countContextDeferral = recountContextDeferral()
        if (countContextDeferral) return defer(countContextDeferral)
        if (res === null) return defer('cache-unavailable') // unavailable — IndexedDB error

        // --- Latest-wins commit ---------------------------
        if (chatRecountVersion.get(conversationId) !== version) return defer('recount-superseded')
        if ((chatUnreadInputVersion.get(conversationId) ?? 0) !== unreadInputVersionAtCompute) {
          return defer('input-version-changed')
        }

        const transient = transientCounts(chatTransientScopeKey(conversationId), floorPos)
        const unreadCount = Math.min(999, res.unread + transient.unread)

        set((state) => {
          const commitContextDeferral = recountContextDeferral()
          if (commitContextDeferral) { defer(commitContextDeferral); return state }
          if (chatRecountVersion.get(conversationId) !== version) { defer('recount-superseded'); return state }
          if ((chatUnreadInputVersion.get(conversationId) ?? 0) !== unreadInputVersionAtCompute) {
            defer('input-version-changed')
            return state
          }
          if (!allowActive && state.activeConversationId === conversationId) { defer('active-skipped'); return state }
          const meta = state.conversationMeta.get(conversationId)
          if (!meta) { defer('no-meta'); return state }

          // `res.unread` was derived against `pointerIdAtCompute`
          // (metaNow.readPointer, captured before the coverage-bottom and
          // countUnreadInArchive awaits). chatRecountVersion only orders this
          // recompute against ANOTHER recompute for the same entity — it does
          // NOT order it against a direct writer like onMessageReceived's own
          // live-edge convergence, which advances the pointer and commits a
          // fresh, correct unreadCount without bumping the version. An
          // allowActive recompute (this trigger's whole point is to run while
          // still active) can therefore be in flight exactly when that direct
          // write lands. Re-reading the pointer here and bailing if it moved
          // means a result computed against a now-stale pointer never clobbers
          // the newer, correct value. An input change queues the bounded
          // trailing retry; a direct pointer advance launches its own recount.
          if (meta.readPointer?.identity.messageId !== pointerIdAtCompute) {
            defer('pointer-changed')
            return state
          }

          // Re-derive only to decide whether a background marker remains valid. The active
          // visit's landmark is preserved below.
          let newMarkers = state.firstNewMessageMarkers
          const parkedDivider = state.firstNewMessageMarkers.get(conversationId)
          if (parkedDivider !== undefined) {
            // No `historyFloor` here, deliberately: this rederivation runs only
            // when a marker is still parked, and deactivation deletes the marker
            // for every non-active conversation — so the only recounts that get
            // here are the `allowActive` ones, both triggered by a pointer
            // advance. `computeFloor` is pointer-wins.
            // This also reads only the resident `messages` array, with no cache
            // fallback. For an entity holding a parked marker over an EMPTY
            // resident array `onActivate` finds no divider position, and the
            // `parkedDivider` fallback below then decides by activity: an ACTIVE
            // conversation keeps the divider the reader is looking at, while a
            // BACKGROUND one has its stale marker retired. That empty-slice case
            // is unreachable today — activation is the sole owner of the marker,
            // and it always hydrates the resident array before ever setting one
            // — but if that invariant ever breaks, the failure direction is at
            // worst a lost "new messages" divider for a background conversation,
            // not a miscounted or corrupted read pointer.
            const slice = state.messages.get(conversationId) ?? []
            const divider = notifState.onActivate(
              { unreadCount: 0, mentionsCount: 0, readPointer: meta.readPointer, firstNewMessageId: undefined },
              slice,
              'chat'
            ).firstNewMessageId
            // The ACTIVE entity's divider does not move. It marks where the unread messages began
            // when this view was opened, so it has to outlive the reading that follows: the pointer
            // advances under it as the viewport reports rows seen, and re-deriving a position from
            // that pointer would walk the line down the screen while the reader is looking at it.
            // Only activation places it; the explicit read-through, Esc, mark-all-read and
            // deactivation paths remove it. A BACKGROUND entity still gets its stale marker retired.
            const nextDivider =
              state.activeConversationId === conversationId ? parkedDivider : divider
            if (nextDivider !== parkedDivider) {
              newMarkers = new Map(state.firstNewMessageMarkers)
              if (nextDivider) newMarkers.set(conversationId, nextDivider)
              else newMarkers.delete(conversationId)
            }
          }

          // unreadCount commits unconditionally on `exact`; mentionsCount is
          // never written — the spread below preserves it
          // (and anything else on `meta`) untouched.
          if (meta.unreadCount === unreadCount && newMarkers === state.firstNewMessageMarkers) return state

          const draft = draftConversationMaps(state)
          draft.patchMeta(conversationId, { unreadCount })
          return { ...draft.commit(), firstNewMessageMarkers: newMarkers }
        })
      },

      triggerAnimation: (conversationId, animation, senderName) => {
        set({ activeAnimation: { conversationId, animation, senderName } })
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

      mergeMAMMessages: (conversationId, archivePage, page, complete, direction, isFetchLatest = false, preserveGapMarker = false, extras = undefined) => {
        bumpChatUnreadInputVersion(conversationId)
        const cacheEpochAtMerge = chatCacheEpoch
        const entityEpochAtMerge = currentChatEntityEpoch(conversationId)
        const storageScopeAtMerge = getStorageScopeJid()

        // XEP-0424: a retraction recorded earlier can target a message arriving in
        // THIS page (the live pass missed it because nothing was resident). Patch
        // the page BEFORE it merges, so the tombstone rides the same saveMessages
        // write instead of racing it. Same array back when nothing matches.
        const replay = resolvePendingRetractions(get(), conversationId, archivePage, { persist: false })
        const mamMessages = replay.messages
        if (replay.pendingRetractions) set({ pendingRetractions: replay.pendingRetractions })

        // Newest persisted timestamp (entity preview) — the seam-formation fallback
        // when the resident array is empty this run (fresh session, history on disk).
        const fallbackHeldTs = get().getConversationLastTimestamp(conversationId)
        // Captured from inside set() so the post-set MDS marker resolution can read the
        // merged array even for a non-active conversation (whose array isn't in RAM).
        let mergedForMarker: Message[] = []
        // Recount trigger (forward MAM merge past the floor): set inside
        // set() when a forward catch-up merge landed new messages for a
        // NON-active conversation — the archive-derived recount runs after
        // set() returns (see bottom of this action).
        let shouldRecountAfterMerge = false
        let archiveCommitGate: Promise<boolean> | undefined
        let durableMessages: Message[] = []
        let coverageBootstrappedFromWalkExtent = false
        set((state) => {
          // Get existing messages for this conversation
          const rawExisting = state.messages.get(conversationId) || []

          // Shared timeline machine: archive-id backfill onto resident messages,
          // direction-aware merge (backward = optimized prepend + keep-oldest,
          // forward = full sort + keep-newest), dedupe, and eviction reporting.
          const { merged: trimmed, newMessages, patched, newestEvicted } = timeline.mergeArchive(
            rawExisting,
            mamMessages,
            direction,
            chatTimelineConfig(),
            isFetchLatest
          )
          mergedForMarker = trimmed

          // Newest fetched message timestamp marks the gap edge for an incomplete
          // forward catch-up (parity with rooms).
          const newestFetchedTimestamp = mamState.computeNewestFetchedTimestamp(mamMessages, direction)

          // Update MAM query state with pagination cursor using the two-marker approach
          // This must always be updated to track query completion and cursors
          let newStates = mamState.setMAMQueryCompleted(
            state.mamQueryStates,
            conversationId,
            complete,
            direction,
            page.first, // Pagination cursor for fetching older messages
            newestFetchedTimestamp,
            preserveGapMarker,
            isFetchLatest,
            mamState.isDisjointFromResidentWindow(rawExisting, extras?.initialBefore, isFetchLatest)
          )

          // Newest PROVEN in-memory boundary (resident extent). Undefined when the
          // resident array is empty (background/non-active entity, fresh session).
          const residentNewestTs = messagePageExtent(rawExisting).newestTs

          // Persisted gap sync (shared transition, both directions) — see
          // syncGapAfterArchiveMerge. Bounded windowed context fetches
          // (fetchContext) pass preserveGapMarker so their windowed
          // completion can't hide a real gap outside the window.
          const newGaps = syncGapAfterArchiveMerge({
            gaps: state.conversationGaps,
            id: conversationId,
            direction,
            complete,
            forwardGapTimestamp: newStates.get(conversationId)?.forwardGapTimestamp,
            merged: trimmed,
            fetched: mamMessages,
            newMessagesCount: newMessages.length,
            patchedCount: patched.length,
            isFetchLatest,
            // ONLY a proven boundary (resident extent) anchors a seam — never the
            // preview timestamp, which may be an unarchived message (noLocalStore/
            // tombstone) above the true archive newest and would plant a spurious
            // seam. When the resident array is empty there is no proven boundary:
            // detectFetchLatestSeam returns undefined and coverageBottomUnproven is
            // flagged below instead (finding 10).
            newestHeldBelowTs: residentNewestTs,
            newestHeldBelowId: newestMessageStanzaId(rawExisting),
            lastFetchedArchiveId: page.last,
            preserveGapMarker,
          })

          // Coverage-bottom proof (finding 10). A merge proves the contiguous
          // bottom when a resident boundary exists OR a recorded gap now carries a
          // proven upper edge (endId) — clear any stale unproven flag. Otherwise,
          // when a disjoint fetch-latest lands above held-below history (proven by
          // the preview) with no seam formed, the bottom is unproven — flag it so
          // the catch-up seeder won't trust cache-oldest as contiguous-to-live.
          const coverageProven = residentNewestTs !== undefined || newGaps.get(conversationId)?.endId !== undefined
          if (coverageProven) {
            newStates = mamState.setCoverageBottomUnproven(newStates, conversationId, false)
          } else if (direction === 'backward' && isFetchLatest && !newGaps.has(conversationId)) {
            const structurallyDisjoint = newMessages.length === mamMessages.length && patched.length === 0
            const pageOldestTs = messagePageExtent(mamMessages).oldestTs
            const previewBelow = fallbackHeldTs !== undefined && pageOldestTs !== undefined && pageOldestTs > fallbackHeldTs
            if (structurallyDisjoint && previewBelow) {
              newStates = mamState.setCoverageBottomUnproven(newStates, conversationId, true)
            }
          }

          // Crash-window safety (Codex r3 #1/#2, r4 #1): the gap map is
          // persisted synchronously (localStorage) while saveMessages to
          // IndexedDB is fire-and-forget AND absorbs errors. Persisting a
          // transition whose cursors reference THIS merge's page before the
          // write commits lets a crash — or a silently failed write — skip
          // the page forever: the resume cursor would point past data that
          // was never stored. That covers deletion, forward startId advance,
          // backward end/endId shrink AND formation (a formed forward gap
          // carries this page's page.last as startId). So EVERY gap transition
          // defers until the durable write reports success when the merge
          // carries persistable messages; with nothing persistable there is
          // no crash window and the transition applies immediately.
          const prevGap = state.conversationGaps.get(conversationId)
          const persistableMessages = newMessages.filter(msg => !isNoLocalStore(msg))
          const persistablePatches = patched.filter(msg => !isNoLocalStore(msg))
          const archiveWriteMessages = [...persistableMessages, ...persistablePatches]
          durableMessages = persistableMessages
          // A merge with nothing persistable still defers when earlier pages
          // of this conversation are in flight (or failed): its cursor must
          // not leap them.
          const mustGateOnChain = archiveWriteMessages.length > 0 || conversationArchiveSaves.has(conversationId)
          const deferGapCommit =
            newGaps !== state.conversationGaps &&
            mustGateOnChain
          const gapsAfterMerge = deferGapCommit ? state.conversationGaps : newGaps

          // The walk's own extent, the bootstrap's anchor when a `start`-filtered
          // catch-up leaves `initialAfter` undefined. Scanned only for the
          // direction that can use it.
          const walkOldestId = direction !== 'backward'
            ? extras?.walkOldestId ?? walkExtentBottomId(mamMessages)
            : undefined
          // Persisted coverage record; see mamCoverage.ts for the durability
          // invariant this defers on. A merge with nothing persistable
          // (signal-only give-up) applies now.
          const { coverage: newCoverage, transition: coverageTransition } = syncCoverageAfterArchiveMerge({
            coverage: state.conversationCoverage,
            id: conversationId,
            direction,
            isFetchLatest,
            preserveGapMarker,
            rsmFirst: page.first,
            fetchLatestTopId: extras?.fetchLatestTopId,
            initialBefore: extras?.initialBefore,
            sawCoverageTop: extras?.sawCoverageTop ?? false,
            walkCarriedModifications: extras?.walkCarriedModifications ?? false,
            complete,
            initialAfter: extras?.initialAfter,
            walkOldestId,
          })
          const prevCoverage = state.conversationCoverage.get(conversationId)
          const deferCoverageCommit =
            newCoverage !== state.conversationCoverage &&
            mustGateOnChain
          const coverageAfterMerge = deferCoverageCommit ? state.conversationCoverage : newCoverage
          coverageBootstrappedFromWalkExtent =
            coverageTransition === 'created' &&
            extras?.initialAfter === undefined &&
            walkOldestId !== undefined &&
            newCoverage.get(conversationId)?.bottomId === walkOldestId
          // Reported where the value actually enters the state (#1138):
          // reporting at merge time on the DEFERRED path would arm the flush for
          // a write that still carries the old record, and leave the real one
          // throttled. `noteCoverageTransition` no-ops for the safe transitions.
          if (!deferCoverageCommit) {
            noteCoverageTransition(getScopedStorageKey(), conversationId, coverageTransition)
          }

          // Deferred commit of the gap/coverage transitions, gated on the
          // given promise (this page's write chained behind every earlier
          // in-flight page — see conversationArchiveSaves). Shared by the
          // with-messages path and the nothing-persistable path below.
          const epochAtMerge = chatCacheEpoch
          const scheduleDeferredCommit = (gate: Promise<boolean>) => {
            void gate.then((committed) => {
              if (!committed) return
              if (chatCacheEpoch !== epochAtMerge || currentChatEntityEpoch(conversationId) !== entityEpochAtMerge) return
              set((s) => {
                // State may have moved on (a later merge advanced or
                // re-planted the gap/record): only transition the exact
                // value this merge computed from. Reference equality
                // suffices — every transition creates a new object. A lost
                // race leaves a LAGGING (conservative) cursor, never a
                // skipping one.
                const out: Partial<ChatState> = {}
                if (deferGapCommit && s.conversationGaps.get(conversationId) === prevGap) {
                  const next = new Map(s.conversationGaps)
                  const target = newGaps.get(conversationId)
                  if (target) next.set(conversationId, target)
                  else next.delete(conversationId)
                  out.conversationGaps = next
                }
                if (deferCoverageCommit && s.conversationCoverage.get(conversationId) === prevCoverage) {
                  const target = newCoverage.get(conversationId)
                  if (target) {
                    const next = new Map(s.conversationCoverage)
                    next.set(conversationId, target)
                    out.conversationCoverage = next
                    // The deferred half of the report above: THIS is the write
                    // that first carries the new record.
                    noteCoverageTransition(getScopedStorageKey(), conversationId, coverageTransition)
                  }
                }
                return Object.keys(out).length > 0 ? out : s
              })
            })
          }

          if (archiveWriteMessages.length > 0) {
            const savePromise = messageCache.saveMessages(archiveWriteMessages)
            archiveCommitGate = conversationArchiveSaves.chain(conversationId, savePromise)
            if (deferGapCommit || deferCoverageCommit) {
              scheduleDeferredCommit(archiveCommitGate)
            }
            if (persistableMessages.length > 0) {
              searchIndex.indexMessages(persistableMessages).catch((e) => console.warn('[searchIndex] indexMessages failed:', e))
            }
          }

          // If no new messages (all duplicates), only update MAM state to avoid
          // unnecessary re-renders. Exception: a stanzaId backfill onto existing
          // RAM messages must persist — but only for the ACTIVE conversation
          // (non-active conversations keep no resident array).
          const isActive = state.activeConversationId === conversationId
          if (newMessages.length === 0) {
            // Nothing of our own to persist, but earlier in-flight pages may
            // still gate this merge's transitions: chain a no-op save so the
            // transition applies (or is dropped) with the same ordering rules.
            if (!archiveCommitGate && (deferGapCommit || deferCoverageCommit)) {
              archiveCommitGate = conversationArchiveSaves.chain(conversationId, Promise.resolve(true))
              scheduleDeferredCommit(archiveCommitGate)
            }
            if (patched.length === 0 || !isActive) {
              return { mamQueryStates: newStates, conversationGaps: gapsAfterMerge, conversationCoverage: coverageAfterMerge }
            }
            const backfilledMap = new Map(state.messages)
            backfilledMap.set(conversationId, trimmed)
            return { messages: backfilledMap, mamQueryStates: newStates, conversationGaps: gapsAfterMerge, conversationCoverage: coverageAfterMerge }
          }

          // Sidebar preview via the shared policy: the newest previewable message
          // supersedes (or heals) the stored preview — deep-history merges must
          // not regress the sidebar.
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          const preview = derivePreviewAfterMerge(meta?.lastMessage, trimmed, findLastPreviewableMessage)
          const lastMessage = preview.lastMessage
          const previewUpdate = !!(meta && conv && preview.changed)

          // NON-ACTIVE conversation (background catch-up): the messages are durable
          // in IndexedDB and the preview/gap are updated, but we DON'T populate the
          // resident array. Only the active conversation is kept in RAM, so a
          // reconnect's forward catch-up can't refill a backgrounded conversation
          // toward the cap. It rehydrates from cache on open.
          if (!isActive) {
            // Badge hydration (spec §1): a forward merge extends contiguous
            // history past the read pointer, so an unopened conversation may
            // regain its badge after catch-up — the COUNT is derived from the
            // archive (see recomputeUnreadForConversation), never from this
            // page-scoped merged slice. The merge itself writes NO read
            // pointer: a fresh entity's floor comes from its `historyFloor`,
            // and an outgoing-message advance would be an inference the
            // forward-only pointer cannot take back. Backward merges only
            // prepend older history (nothing after the pointer changes).
            if (direction === 'forward' && newMessages.length > 0 && !coverageBootstrappedFromWalkExtent) {
              shouldRecountAfterMerge = true
            }

            if (previewUpdate) {
              const draft = draftConversationMaps(state)
              draft.patchMeta(conversationId, { lastMessage })
              return { mamQueryStates: newStates, ...draft.commit(), conversationGaps: gapsAfterMerge, conversationCoverage: coverageAfterMerge }
            }
            return { mamQueryStates: newStates, conversationGaps: gapsAfterMerge, conversationCoverage: coverageAfterMerge }
          }

          // ACTIVE conversation: populate the resident messages map.
          const newMessagesMap = new Map(state.messages)
          newMessagesMap.set(conversationId, trimmed)

          // A backward (scroll-up) merge uses keep-oldest and can evict the newest tail,
          // sliding the window off the live edge (same gate as loadOlderMessagesFromCache).
          // Forward catch-up keeps the newest, so it never slides.
          let newWindowAtLiveEdge = state.windowAtLiveEdge
          if (newestEvicted) {
            newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
            newWindowAtLiveEdge.set(conversationId, false)
          } else if (isFetchLatest && newMessages.length > 0) {
            // Fetch-latest lands the window AT the live edge by construction.
            // Accepted edge case: a fresh-session bail fetch-latest while the
            // user is deep-scrolled in THIS active conversation can evict
            // resident messages via keep-newest and jump the window to live —
            // same class as jump-to-latest. The content-anchor scroll restore
            // then degrades to an estimate rather than an exact reposition.
            newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
            newWindowAtLiveEdge.set(conversationId, true)
          }

          if (previewUpdate) {
            const draft = draftConversationMaps(state)
            draft.patchMeta(conversationId, { lastMessage })
            return { messages: newMessagesMap, mamQueryStates: newStates, ...draft.commit(), conversationGaps: gapsAfterMerge, conversationCoverage: coverageAfterMerge, windowAtLiveEdge: newWindowAtLiveEdge }
          }

          return { messages: newMessagesMap, mamQueryStates: newStates, conversationGaps: gapsAfterMerge, conversationCoverage: coverageAfterMerge, windowAtLiveEdge: newWindowAtLiveEdge }
        })

        if (archiveCommitGate) {
          void archiveCommitGate.then((committed) => {
            if (!committed || chatCacheEpoch !== cacheEpochAtMerge || currentChatEntityEpoch(conversationId) !== entityEpochAtMerge || getStorageScopeJid() !== storageScopeAtMerge) return
            let removed = false
            for (const message of durableMessages) {
              removed = removeTransient(
                chatTransientScopeKey(conversationId),
                transientIdentity({ id: message.id }, 'chat')
              ).removed || removed
            }
            if (removed) bumpChatUnreadInputVersion(conversationId)
            chatRecountRetry.resume(conversationId)
          })
        }

        // XEP-0490: a pending marker was not orderable in an earlier slice.
        // Retry against the merged messages; applyRemoteDisplayed clears
        // pendingRemoteDisplayedStanzaId only when the comparison resolves.
        const pending = get().conversationMeta.get(conversationId)?.pendingRemoteDisplayedStanzaId
        if (pending) {
          get().applyRemoteDisplayed(conversationId, pending, mergedForMarker)
        }

        // Archive-derived recount (trigger: forward MAM merge past the
        // floor). A forward catch-up merge for a non-active conversation may
        // have extended contiguous history past the read pointer — re-derive
        // the badge from the archive rather than trusting this page alone.
        if (shouldRecountAfterMerge) {
          void get().recomputeUnreadForConversation(conversationId)
        }
        if (direction === 'forward' && complete) {
          if (!archiveCommitGate && conversationArchiveSaves.has(conversationId)) {
            archiveCommitGate = conversationArchiveSaves.chain(conversationId, Promise.resolve(true))
          }
          const resume = () => {
            if (chatCacheEpoch !== cacheEpochAtMerge || currentChatEntityEpoch(conversationId) !== entityEpochAtMerge || getStorageScopeJid() !== storageScopeAtMerge) return
            chatRecountRetry.resume(conversationId)
            if (coverageBootstrappedFromWalkExtent) {
              void get().recomputeUnreadForConversation(conversationId, { allowActive: true })
            }
          }
          if (archiveCommitGate) void archiveCommitGate.then((committed) => { if (committed) resume() })
          else resume()
        }
      },

      clearConversationGapAnchor: (conversationId, purgedStartId) => {
        set((state) => {
          const next = clearGapAnchor(state.conversationGaps, conversationId, purgedStartId)
          return next ? { conversationGaps: next } : state
        })
      },

      getConversationCoverage: (conversationId) => get().conversationCoverage.get(conversationId),

      clearConversationCoverage: (conversationId, ifBottomId) => {
        set((state) => {
          const next = clearCoverageEntry(state.conversationCoverage, conversationId, ifBottomId)
          return next ? { conversationCoverage: next } : state
        })
      },

      getMAMQueryState: (conversationId) => {
        return mamState.getMAMQueryState(get().mamQueryStates, conversationId)
      },

      resetMAMStates: () => {
        set({ mamQueryStates: new Map() })
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

          const draft = draftConversationMaps(state)
          draft.patchMeta(conversationId, { lastMessage })
          return draft.commit()
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

          const draft = draftConversationMaps(state)
          draft.patchMeta(conversationId, { lastMessage: updated })
          return draft.commit()
        })
      },

      // Load messages from IndexedDB cache for a conversation
      // For initial load (no 'before'), loads the LATEST 100 messages to show most recent first
      loadMessagesFromCache: async (conversationId, options = {}) => {
        const { limit = 100, before, peek, oldest } = options
        try {
          const cachedMessages = await messageCache.getMessages(conversationId, {
            limit,
            before,
            // When loading without 'before', get the latest messages (most recent)
            // This prevents showing old messages and jumping to recent ones.
            // `oldest` opts out: ascending oldest-N (the true cache bottom).
            latest: !before && !oldest,
          })

          // `peek`: pure read that returns the messages WITHOUT writing the store —
          // used to compute a catch-up cursor for a non-active conversation without
          // pulling its history into RAM (only the active conversation is resident).
          // `oldest` is always a pure read too: the cache bottom must never
          // become the resident window (that would tear the UI off the live edge).
          if (!peek && !oldest && cachedMessages.length > 0) {
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

              // Shared timeline machine: dedupe against the resident array (a cache
              // slice can overlap at the `before:` boundary), sort, keep-oldest trim
              // (load-older slides the window so scroll-back past the bound works).
              const { merged: trimmed, newestEvicted } = timeline.loadOlderSlice(
                currentMessages,
                olderMessages,
                chatTimelineConfig()
              )

              const newMessagesMap = new Map(state.messages)
              newMessagesMap.set(conversationId, trimmed)

              // If keep-oldest evicted the newest resident message, the window has slid
              // off the live edge → gate live appends in addMessage. If the batch fit
              // under the bound (newest unchanged), leave the flag as-is.
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

      loadNewerMessagesFromCache: async (conversationId, limit = 50) => {
        const state = get()
        const existingMessages = state.messages.get(conversationId) || []
        const newestMessage = existingMessages[existingMessages.length - 1]

        if (!newestMessage) {
          return []
        }

        try {
          const newerMessages = await messageCache.getMessages(conversationId, {
            after: newestMessage.timestamp,
            limit,
          })

          // Fewer than the requested limit came back ⇒ nothing more newer remains in the
          // cache, so the window has reached the tail (live edge) regardless of whether the
          // batch was empty or partial.
          const reachedTail = newerMessages.length < limit

          if (newerMessages.length > 0) {
            set((state) => {
              const currentMessages = state.messages.get(conversationId) || []

              // Shared timeline machine: dedupe (overlap at the `after:` boundary),
              // sort, keep-newest trim (load-newer slides the window back down).
              const { merged: trimmed } = timeline.loadNewerSlice(
                currentMessages,
                newerMessages,
                chatTimelineConfig()
              )

              const newMessagesMap = new Map(state.messages)
              newMessagesMap.set(conversationId, trimmed)

              if (!reachedTail) return { messages: newMessagesMap }

              // Reached the tail: clear any slid flag (absent = at the edge).
              if (!state.windowAtLiveEdge.has(conversationId)) return { messages: newMessagesMap }
              const newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
              newWindowAtLiveEdge.delete(conversationId)
              return { messages: newMessagesMap, windowAtLiveEdge: newWindowAtLiveEdge }
            })
          } else if (reachedTail) {
            // Empty batch: still need to clear the flag if the conversation isn't already at the edge.
            set((state) => {
              if (!state.windowAtLiveEdge.has(conversationId)) return state
              const newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
              newWindowAtLiveEdge.delete(conversationId)
              return { windowAtLiveEdge: newWindowAtLiveEdge }
            })
          }

          return newerMessages
        } catch (error) {
          console.warn('Failed to load newer messages from cache:', error)
          return []
        }
      },

      recenterToLatest: async (conversationId) => {
        await get().loadMessagesFromCache(conversationId, { limit: getResidentWindowSize() })
        // loadMessagesFromCache's latest-N path (no `before`) already clears the slid flag
        // when the merge changed the resident array. Clear it here too so a jump-to-latest
        // is unambiguously at the live edge even when the cache had nothing new to merge
        // (the newest window was already fully resident).
        set((state) => {
          if (!state.windowAtLiveEdge.has(conversationId)) return state
          const newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
          newWindowAtLiveEdge.delete(conversationId)
          return { windowAtLiveEdge: newWindowAtLiveEdge }
        })
      },

      switchAccount: (jid) => {
        // The outgoing account's pending blob must land before we load the
        // incoming one: a fast A -> B -> A would otherwise reload A from a
        // blob that predates its last mutations, and that stale load becomes
        // the live state.
        flushThrottledStorage()
        // Free after the flush above: every window is closed, so the next
        // write's force-flush finds no pending thunk.
        forgetAllDurableMapBaselines()
        clearAllTypingTimeouts()
        // In-flight archive-save gates belong to the previous account; their
        // deferred commits must not land in the new account's maps.
        conversationArchiveSaves.clear()
        chatCacheEpoch++
        chatRecountVersion.clear()
        chatUnreadInputVersion.clear()
        chatPendingUnreadWrites.clear()
        chatEntityEpoch.clear()
        chatRecountRetry.clear()
        remoteDividerAdvances.reset()
        // Tear down the OUTGOING account's transient overlay entries
        // before adopting the new scope — see lastChatTransientScope's doc for
        // why this can't just read getStorageScopeJid() here.
        if (lastChatTransientScope !== null) {
          clearTransientScope(lastChatTransientScope)
          // Viewport evidence is scoped the same way — same teardown timing.
          clearViewportEvidence(lastChatTransientScope)
        }
        lastChatTransientScope = getStorageScopeJid()
        set(loadScopedChatState(jid))
      },

      reset: () => {
        clearAllTypingTimeouts()
        conversationArchiveSaves.clear()
        chatCacheEpoch++
        chatRecountVersion.clear()
        chatUnreadInputVersion.clear()
        chatPendingUnreadWrites.clear()
        chatEntityEpoch.clear()
        chatRecountRetry.clear()
        remoteDividerAdvances.reset()
        // Logout tears down this account's transient overlay too.
        // Unlike switchAccount, nothing flips the global scope before reset()
        // runs (clearLocalData calls it directly), so getStorageScopeJid()
        // here is still the account being logged out — read it directly
        // rather than through lastChatTransientScope.
        clearTransientScope(getStorageScopeJid() ?? '')
        // Viewport evidence, same account-scoped teardown.
        clearViewportEvidence(getStorageScopeJid() ?? '')
        lastChatTransientScope = null
        // New session → the XEP-0490 synced read marker may be folded again on first open.
        mdsGate.reset()
        // Logout discards the blob, so there is nothing left to carry legacy
        // read state forward into.
        unmigratedLegacyReadState.delete(getScopedStorageKey())
        // The throttle's contract: cancel BEFORE any raw removeItem. Today the
        // trailing `set(createEmptyChatState())` below happens to replace any
        // pending thunk with an empty-state one, so nothing leaks — but that is
        // coincidence, not design. Without this, moving or dropping that `set`
        // turns logout into silent data resurrection.
        cancelDurableMaps(getScopedStorageKey())
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
            return { state: deserializeState(parsed.state, scopedStorageKey) }
          } catch {
            // Corrupted data, clear and start fresh
            localStorage.removeItem(scopedStorageKey)
            return null
          }
        },
        setItem: (_, value) => {
          // Resolved HERE, not inside the thunk: a trailing write that fires
          // after a switchAccount must land under the key that was current
          // when this state was produced.
          const scopedStorageKey = getScopedStorageKey()
          const state = value.state as ChatState
          // Lazy — a coalesced write never pays for serializeState at all.
          // Error absorption lives in the throttle's `write`.
          //
          // `conversationGaps` and `conversationCoverage` ride in this one blob,
          // so their structural transitions (a gap FORMED, a coverage record
          // added/replaced/dropped) force the WHOLE blob out of the window —
          // acceptable because those transitions are rare, while the merge churn
          // that motivated the throttle is not one. Detection lives here, at the
          // single funnel every chat mutation passes through, rather than at the
          // ~8 gap/coverage mutation sites. See durableMapPersist.
          scheduleDurableMaps(
            scopedStorageKey,
            { gaps: state.conversationGaps, coverage: state.conversationCoverage },
            () => JSON.stringify({ state: serializeState(state, scopedStorageKey) })
          )
        },
        removeItem: () => {
          const scopedStorageKey = getScopedStorageKey()
          // Before the removal: a write scheduled moments ago would otherwise
          // fire afterwards and resurrect the blob. The structural baseline
          // describes that cancelled write, so it goes with it.
          cancelDurableMaps(scopedStorageKey)
          try {
            localStorage.removeItem(scopedStorageKey)
          } catch {
            // Ignore storage errors
          }
        },
      },
      partialize: (state) => ({
        // Persist separated maps
        conversationEntities: state.conversationEntities,
        conversationMeta: state.conversationMeta,
        // Empty, like `messages` below: the partialized shape has to match what
        // `getItem` hands back (deserializeState rebuilds the compat map, so it
        // is present there), but `serializeState` does not read this field and
        // nothing about it reaches disk.
        conversations: new Map<string, Conversation>(),
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
        // Persist coverage records (contiguous-with-live bottom; Codex r3 #3)
        conversationCoverage: state.conversationCoverage,
        // Persist XEP-0424 retractions still waiting for their target to load,
        // so the tombstone lands even if the app restarts first
        pendingRetractions: state.pendingRetractions,
      }),
    }
    )
  )
)

chatStore.subscribe((state, previous) => {
  const conversationId = state.activeConversationId
  if (!conversationId || !remoteDividerAdvances.has(conversationId)) return
  const parked = state.firstNewMessageMarkers.get(conversationId)
  if (parked === undefined) {
    remoteDividerAdvances.clear(conversationId)
    return
  }
  if (state.messages.get(conversationId) === previous.messages.get(conversationId)) return

  const result = remoteDividerAdvances.retry(
    conversationId,
    parked,
    state.messages.get(conversationId) ?? [],
    'chat',
    locallyPublishedDisplayed(
      getBareJid(connectionStore.getState().jid ?? ''),
      conversationId,
    ),
  )
  if (result.kind === 'advanced') {
    chatStore.setState((current) => ({
      firstNewMessageMarkers: new Map(current.firstNewMessageMarkers).set(
        conversationId,
        result.divider,
      ),
    }))
  }
})

export type { ChatState }
