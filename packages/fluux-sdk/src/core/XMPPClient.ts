import { xml, Client, Element } from '@xmpp/client'
import { createActor, type Subscription, type Snapshot } from 'xstate'
import type { EventHook } from './EventHook'
import type {
  ConnectOptions,
  StoreBindings,
  XMPPClientEvents,
  XMPPClientConfig,
  SDKEvents,
  SDKEventHandler,
  StorageAdapter,
  ProxyAdapter,
  PrivacyOptions,
  FileAttachment,
  MessageSecurityContext,
} from './types'
import {
  presenceMachine,
  getPresenceShowFromState,
  getPresenceStatusFromState,
  isAutoAwayState,
  type PresenceActor,
  type PresenceStateValue,
  type PresenceContext as PresenceMachineContext,
} from './presenceMachine'
import type { ConnectionActor, ConnectionStateValue } from './connectionMachine'
import { generateUUID } from '../utils/uuid'
import { createStoreBindings } from '../bindings/storeBindings'
import { setupStoreSideEffects } from './sideEffects'
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
  activityLogStore,
} from '../stores'
import { detectPlatform, getCachedPlatform } from './platform'
import { isDeadSocketError } from './modules/connectionUtils'
import { parseMessageContent, applyRetraction } from './modules/messagingUtils'
import {
  FRESH_SESSION_IQ_TIMEOUT_MS,
  FRESH_SESSION_SETUP_TIMEOUT_MS,
} from './modules/connectionTimeouts'
import { getBareJid, getLocalPart, getDomain } from './jid'
import { createE2EEDiagnosticLogger } from './e2eeDiagnosticLogger'
import { getStorageScopeJid, setStorageScopeJid } from '../utils/storageScope'

/**
 * Session storage key for persisting presence machine state.
 */
const PRESENCE_STORAGE_KEY = 'fluux:presence-machine'

/**
 * Load persisted presence machine snapshot from sessionStorage.
 * Returns undefined if storage is unavailable (Node.js) or no saved state.
 */
function loadPersistedPresence(): Snapshot<unknown> | undefined {
  if (typeof sessionStorage === 'undefined') {
    return undefined
  }
  try {
    const stored = sessionStorage.getItem(PRESENCE_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      // Restore Date objects in context
      if (parsed.context?.idleSince) {
        parsed.context.idleSince = new Date(parsed.context.idleSince)
      }
      return parsed
    }
  } catch {
    // Invalid or missing stored state, start fresh
  }
  return undefined
}

/**
 * Save presence machine snapshot to sessionStorage.
 * No-op if storage is unavailable (Node.js).
 */
function savePresenceSnapshot(actor: PresenceActor): void {
  if (typeof sessionStorage === 'undefined') {
    return
  }
  try {
    const snapshot = actor.getPersistedSnapshot()
    sessionStorage.setItem(PRESENCE_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage full or unavailable, ignore
  }
}
import { StateSnapshot } from './modules/stateSnapshot'
import { Chat } from './modules/Chat'
import { Roster } from './modules/Roster'
import { MUC } from './modules/MUC'
import { Admin } from './modules/Admin'
import { Profile } from './modules/Profile'
import { Discovery } from './modules/Discovery'
import { Connection } from './modules/Connection'
import { PubSub } from './modules/PubSub'
import { Blocking } from './modules/Blocking'
import { Ignore } from './modules/Ignore'
import { ConversationSync, type SyncedConversation } from './modules/ConversationSync'
import { Mds } from './modules/Mds'
import { WebPush } from './modules/WebPush'
import { EntityTime } from './modules/EntityTime'
import { LastActivity } from './modules/LastActivity'
import { MAM } from './modules/MAM'
import { Poll } from './modules/Poll'
import { E2EEManager, InMemoryStorageBackend, type StorageBackend, type XMPPPrimitives } from './e2ee'
import { dataToElement } from './e2ee/stanzaAdapter'
import { decryptStanzaInPlace, COULD_NOT_DECRYPT_BODY, MESSAGE_REJECTED_BODY } from './e2ee/stanzaDecrypt'
import { NS_CARBONS, NS_MAM, NS_P1_PUSH_WEBPUSH, NS_REACTIONS, NS_RETRACT } from './namespaces'
import { createDefaultStoreBindings, type DefaultStoreBindingsOptions } from './defaultStoreBindings'
import { logDebug, logInfo, logWarn } from './logger'
import { SDK_VERSION } from '../version'
import { initSearchIndex, backfillFromMessageCache } from '../utils/searchIndex'
import { getMessagesWithEncryptedPayload, updateMessage as cacheUpdateMessage, deleteMessage as cacheDeleteMessage } from '../utils/messageCache'
import { bumpAvatarResumeCount } from '../utils/avatarCache'

/**
 * Core XMPP client with namespace-based module API.
 *
 * The XMPPClient provides a high-level interface for XMPP protocol operations,
 * organized into domain-specific modules accessible via namespaces.
 *
 * @remarks
 * This client is typically used through the {@link XMPPProvider} in React applications,
 * but can also be used standalone for non-React applications or bots.
 *
 * @example Basic usage with React
 * ```tsx
 * import { XMPPProvider, useXMPP, useConnection } from '@fluux/sdk'
 *
 * function App() {
 *   return (
 *     <XMPPProvider>
 *       <Chat />
 *     </XMPPProvider>
 *   )
 * }
 *
 * function Chat() {
 *   const client = useXMPP()
 *   const { connect, status } = useConnection()
 *
 *   const handleConnect = () => {
 *     connect({ jid: 'user@example.com', password: 'secret', server: 'example.com' })
 *   }
 *
 *   const sendMessage = () => {
 *     client.chat.sendMessage('friend@example.com', 'Hello!')
 *   }
 * }
 * ```
 *
 * @example Namespace-based module API
 * ```typescript
 * // Chat operations
 * client.chat.sendMessage(to, body)
 * client.chat.sendReaction(to, messageId, emoji)
 *
 * // MUC (Multi-User Chat) operations
 * client.muc.joinRoom(roomJid, nickname)
 * client.muc.sendRoomMessage(roomJid, body)
 *
 * // Roster operations
 * client.roster.add(jid, name)
 * client.roster.remove(jid)
 *
 * // Profile operations
 * client.profile.publishOwnAvatar(base64Data, mimeType)
 * client.profile.setNickname(nickname)
 *
 * // Admin operations (XEP-0133)
 * client.admin.discoverAdminCommands()
 * client.admin.executeCommand(node)
 *
 * // Service discovery
 * client.discovery.fetchServerInfo()
 * ```
 *
 * @category Core
 */

/**
 * A bodiless signal stanza recovered from a deferred decrypt. The whole
 * element rode inside the encrypted payload (so the server never saw it), and
 * it has no `<body>` — it targets ANOTHER message rather than carrying content.
 * The placeholder "message" it was provisionally stored under must be replaced
 * by applying the signal to its target.
 */
type RetryModification =
  | { type: 'reactions'; targetId: string; emojis: string[] }
  | { type: 'retract'; targetId: string }

/**
 * Result of a single deferred-decrypt attempt.
 * - `decrypted`: plaintext recovered — update body/security/attachment, clear `encryptedPayload`.
 * - `modification`: decrypt surfaced a bodiless signal (XEP-0444 reaction or XEP-0424 retraction) —
 *   apply it to its target and remove the placeholder; there is no message body to update.
 * - `unsupported`: protocol we have no plugin for — clear `encryptedPayload`, tag `unsupportedEncryption`, keep body.
 * - `rejected`: signature is invalid (final, never retryable) — a real message placeholder is
 *   replaced with a "[Message rejected]" body; a bodiless-signal placeholder (forged reaction/
 *   retraction) is removed entirely so it never surfaces as a ghost bubble.
 * - `pending`: still cannot decrypt (key locked / plugin not ready) — leave `encryptedPayload`.
 */
type RetryOutcome =
  | { kind: 'decrypted'; body: string; securityContext?: MessageSecurityContext; attachment?: FileAttachment }
  | { kind: 'modification'; modification: RetryModification }
  | { kind: 'unsupported'; info: { namespace: string; name: string } }
  | { kind: 'rejected'; securityContext?: MessageSecurityContext }
  | { kind: 'pending' }

export class XMPPClient {
  protected currentJid: string | null = null
  private storageAdapter?: StorageAdapter
  private shouldAutoReconnect?: () => boolean
  private e2eeStorageBackend: StorageBackend = new InMemoryStorageBackend()
  private proxyAdapter?: ProxyAdapter
  private privacyOptions?: PrivacyOptions
  private stateSnapshot?: StateSnapshot

  /**
   * Connection management module.
   * Handles connecting, disconnecting, reconnection, and Stream Management (XEP-0198).
   */
  public connection!: Connection

  /**
   * Chat module for 1:1 messaging.
   * Handles messages, reactions, chat states, corrections, and MAM queries.
   */
  public chat!: Chat

  /**
   * End-to-end encryption plugin host. `null` before the first successful
   * connection — the manager is tied to a logged-in identity and is
   * constructed in {@link XMPPClient.handleConnectionSuccess} when the JID
   * becomes known. Torn down on explicit disconnect.
   *
   * Apps register {@link E2EEPlugin} implementations here after the client
   * is `online`; the Chat module consults the manager when sending and
   * receiving messages. No plugins are registered by default — messages
   * flow in cleartext until the app opts in by calling `e2ee.register()`.
   */
  public e2ee: E2EEManager | null = null

  /**
   * Roster management module.
   * Handles contact list, presence, and subscription management.
   */
  public roster!: Roster

  /**
   * Multi-User Chat (MUC) module.
   * Handles room operations, bookmarks, and group messaging.
   */
  public muc!: MUC

  /**
   * Server administration module (XEP-0133).
   * Handles admin commands and server management operations.
   */
  public admin!: Admin

  /**
   * Profile management module.
   * Handles avatars, nicknames, and vCard operations.
   */
  public profile!: Profile

  /**
   * Service discovery module (XEP-0030).
   * Handles server feature discovery and HTTP upload service discovery.
   */
  public discovery!: Discovery

  /**
   * PubSub module (XEP-0060).
   * Handles incoming PubSub events for avatars, nicknames, and other PEP data.
   */
  public pubsub!: PubSub

  /**
   * Blocking module (XEP-0191).
   * Handles blocklist management for blocking/unblocking JIDs.
   */
  public blocking!: Blocking

  /**
   * Ignore module.
   * Manages per-room ignored user lists via PEP (XEP-0223 private storage).
   */
  public ignore!: Ignore

  /**
   * Poll module.
   * Manages reaction-based polls in MUC rooms.
   */
  public poll!: Poll

  /**
   * Conversation sync module.
   * Persists 1:1 conversation lists (active + archived) via PEP (XEP-0223 private storage).
   */
  public conversationSync!: ConversationSync

  /**
   * MDS module (XEP-0490: Message Displayed Synchronization).
   * Publishes/fetches per-conversation last-displayed stanza-ids via PEP.
   */
  public mds!: Mds

  /**
   * Web Push module (p1:push).
   * Handles VAPID-based push notification registration with ejabberd Business Edition.
   */
  public webPush!: WebPush

  /**
   * Entity Time module (XEP-0202).
   * Queries contacts for their local time and caches timezone offsets.
   */
  public entityTime!: EntityTime

  /**
   * Last Activity module (XEP-0012).
   * Queries the server for when an offline contact was last active.
   */
  public lastActivity!: LastActivity

  /**
   * Message Archive Management module (XEP-0313).
   * Handles querying message history for 1:1 conversations and MUC rooms.
   */
  public mam!: MAM

  /**
   * XState presence actor managing user presence state.
   *
   * The presence machine handles explicit state transitions for user presence
   * (online, away, dnd) and automatic transitions (auto-away, auto-xa on sleep).
   *
   * **For React apps**: XMPPProvider exposes this via PresenceContext for hooks.
   *
   * **For bots/headless**: Access directly to send presence events:
   *
   * @example Setting presence manually (bots)
   * ```typescript
   * client.presenceActor.send({ type: 'SET_PRESENCE', show: 'dnd', status: 'Busy' })
   * ```
   *
   * @example Notifying idle detection
   * ```typescript
   * client.presenceActor.send({ type: 'IDLE_DETECTED', since: new Date() })
   * ```
   */
  public presenceActor!: PresenceActor

  /**
   * XState connection actor managing connection lifecycle state.
   *
   * The connection machine handles explicit state transitions for the XMPP
   * connection (idle, connecting, connected, reconnecting, terminal, disconnected)
   * with exponential backoff and proper error handling.
   *
   * **For React apps**: Access via XMPPProvider for UI status binding.
   *
   * **For bots/headless**: Access directly to monitor connection state:
   *
   * @example Monitoring connection state
   * ```typescript
   * client.connectionActor.subscribe((snapshot) => {
   *   console.log('Connection state:', snapshot.value)
   * })
   * ```
   */
  public connectionActor!: ConnectionActor

  private stores: StoreBindings | null = null
  private eventHandlers: Map<keyof XMPPClientEvents, Set<XMPPClientEvents[keyof XMPPClientEvents]>> = new Map()

  /**
   * New SDK event handlers with object payloads.
   * This is the new event system that will eventually replace eventHandlers.
   */
  private sdkEventHandlers: Map<keyof SDKEvents, Set<SDKEventHandler<keyof SDKEvents>>> = new Map()

  /**
   * Tracks contacts we've already checked for XEP-0084 (PEP) avatars.
   * Prevents repeated queries when a contact has empty XEP-0153 photo
   * but no XEP-0084 avatar either. Cleared on disconnect.
   */
  private xep0084AvatarChecked: Set<string> = new Set()

  /**
   * MAM query collectors registry.
   * Maps query IDs to callbacks that collect MAM result stanzas.
   * This avoids adding temporary listeners to the xmpp client.
   * @internal
   */
  private mamCollectors: Map<string, (stanza: Element) => void> = new Map()

  /**
   * Whether modules have been initialized.
   * @internal
   */
  private modulesInitialized = false

  /**
   * Whether the current session was established via SM resumption.
   * Used to skip MAM operations that are unnecessary after SM replay.
   * @internal
   */
  private isSmResumedSession = false

  /**
   * Guard flag for {@link retryPendingDecrypts}. Prevents concurrent
   * retry loops when multiple triggers (plugin-registered, key-unlocked)
   * fire close together.
   * @internal
   */
  private isRetryingDecrypts = false

  /**
   * Set when a retry is requested while {@link retryPendingDecrypts} is
   * already running. The in-flight pass re-runs once on completion so a
   * trigger that arrives mid-pass (e.g. key-unlocked landing while the
   * plugin-registered pass is still in flight) is coalesced, never dropped.
   * @internal
   */
  private retryDecryptsRequested = false

  /**
   * Monotonically increasing session generation counter.
   * Incremented each time handleConnectionSuccess runs.
   * Used by handleFreshSession/handleSmResumption to detect stale runs and abort early
   * when a newer connection supersedes the current one (e.g., system sleep during async chain).
   * @internal
   */
  private sessionGeneration = 0

  /**
   * Cleanup functions for all subscriptions and bindings.
   * Torn down in destroy() and re-established by setupBindings().
   * @internal
   */
  private cleanupFunctions: (() => void)[] = []

  /**
   * Registered event hooks (Obsidian-inspired plugin pattern).
   * Hooks subscribe to SDK events with automatic lifecycle cleanup.
   * @internal
   */
  private eventHooks: Map<string, EventHook> = new Map()

  /**
   * Creates a new XMPPClient instance.
   *
   * The client automatically uses the SDK's global Zustand stores. For most use
   * cases (bots, React apps), you don't need to provide any configuration.
   *
   * @param config - Optional configuration
   *
   * @example Simple bot
   * ```typescript
   * const client = new XMPPClient()
   * await client.connect({ jid: 'bot@example.com', password: 'secret' })
   *
   * client.subscribe('chat:message', ({ message }) => {
   *   console.log(`${message.from}: ${message.body}`)
   * })
   * ```
   *
   * @example With debug logging
   * ```typescript
   * const client = new XMPPClient({ debug: true })
   * ```
   */
  constructor(config: XMPPClientConfig = {}) {
    // Detect platform early for caps/client identification
    // This is async but we fire-and-forget; the result is cached for later use
    void detectPlatform()

    // Store storage adapter for session persistence
    this.storageAdapter = config.storageAdapter
    this.shouldAutoReconnect = config.shouldAutoReconnect
    this.proxyAdapter = config.proxyAdapter
    // Store privacy options for avatar fetching behavior
    this.privacyOptions = config.privacyOptions

    // Initialize presence actor with persistence
    // Try to restore from persisted snapshot (sessionStorage if available)
    // Force state to 'disconnected' while preserving context - the snapshot may
    // have been saved in a 'connected' state, but since the XMPP connection is
    // not yet established, we need to start in 'disconnected'. This preserves
    // context (lastUserPreference, autoAwayConfig, idleSince) while ensuring
    // the state is correct. When connection is established, handleConnectionSuccess
    // will send CONNECT to transition to the correct connected substate based on
    // lastUserPreference.
    const persistedSnapshot = loadPersistedPresence() as
      | (Snapshot<PresenceMachineContext> & { value: PresenceStateValue })
      | undefined
    if (persistedSnapshot) {
      // Force state to 'disconnected' while keeping all context intact
      // The snapshot may have been saved in a 'connected' state, but since
      // XMPP is not connected yet, we need to start in 'disconnected'
      persistedSnapshot.value = 'disconnected'
    }
    this.presenceActor = createActor(presenceMachine, {
      snapshot: persistedSnapshot,
    }).start()

    // Note: presence persistence subscription is set up in setupBindings()
    // so it can be re-established after destroy() in React StrictMode.

    // Create presence options that read from the machine (single source of truth)
    const presenceOptions: DefaultStoreBindingsOptions = {
      getPresenceShow: () => {
        const state = this.presenceActor.getSnapshot()
        const stateValue = state.value as PresenceStateValue
        return getPresenceStatusFromState(stateValue)
      },
      getStatusMessage: () => {
        const state = this.presenceActor.getSnapshot()
        return (state.context as PresenceMachineContext).statusMessage
      },
      getIsAutoAway: () => {
        const state = this.presenceActor.getSnapshot()
        const stateValue = state.value as PresenceStateValue
        return isAutoAwayState(stateValue)
      },
      getPreAutoAwayState: () => {
        const state = this.presenceActor.getSnapshot()
        return (state.context as PresenceMachineContext).preAutoAwayState
      },
      getPreAutoAwayStatusMessage: () => {
        const state = this.presenceActor.getSnapshot()
        return (state.context as PresenceMachineContext).preAutoAwayStatusMessage
      },
      setPresenceState: (show, message) => {
        // Send event to machine - it manages state transitions
        const showMap = { online: 'online', away: 'away', dnd: 'dnd', offline: 'online' } as const
        this.presenceActor.send({
          type: 'SET_PRESENCE',
          show: showMap[show] || 'online',
          status: message ?? undefined,
        })
      },
      setAutoAway: () => {
        // No-op: auto-away is managed by the machine via IDLE_DETECTED events
      },
      clearPreAutoAwayState: () => {
        // No-op: pre-auto-away state is managed by the machine internally
      },
      // Merge any custom options provided by the user
      ...config.presenceOptions,
    }

    // Initialize with default store bindings (using global Zustand stores)
    this.initializeModules(createDefaultStoreBindings(presenceOptions))

    // Set up all bindings (presence sync, store bindings, side effects).
    // Extracted to a method so XMPPProvider can call setupBindings/destroy
    // in useEffect for proper React StrictMode support.
    this.setupBindings()
  }

  /**
   * Set up store bindings, presence sync, and side effects.
   *
   * This wires SDK events to Zustand store updates, sets up presence
   * synchronization, and initializes store-based side effects.
   *
   * Can be called after {@link destroy} to re-establish bindings
   * (used by XMPPProvider for React StrictMode compatibility).
   */
  setupBindings(): void {
    // Clean up any existing bindings first (idempotent)
    for (const cleanup of this.cleanupFunctions) {
      try { cleanup() } catch { /* ignore */ }
    }
    this.cleanupFunctions = []

    // Subscribe to persist presence state changes to sessionStorage
    const presencePersistSubscription = this.presenceActor.subscribe(() => {
      savePresenceSnapshot(this.presenceActor)
    })
    this.cleanupFunctions.push(() => presencePersistSubscription.unsubscribe())

    // Set up presence sync (machine state -> XMPP presence)
    const unsubscribePresenceSync = this.setupPresenceSync(this.presenceActor)
    this.cleanupFunctions.push(unsubscribePresenceSync)

    // Set up SDK event -> Zustand store bindings
    // This wires SDK events (e.g., 'chat:message') to store updates (e.g., chatStore.addMessage)
    const unsubscribeStoreBindings = createStoreBindings(this, () => ({
      connection: connectionStore.getState(),
      chat: chatStore.getState(),
      roster: rosterStore.getState(),
      room: roomStore.getState(),
      events: eventsStore.getState(),
      admin: adminStore.getState(),
      blocking: blockingStore.getState(),
      console: consoleStore.getState(),
      ignore: ignoreStore.getState(),
    }))
    this.cleanupFunctions.push(unsubscribeStoreBindings)

    // Set up store-based side effects (activeConversation -> load cache, MAM fetch)
    const unsubscribeSideEffects = setupStoreSideEffects(this)
    this.cleanupFunctions.push(unsubscribeSideEffects)
  }

  /**
   * Bind custom stores for state management.
   *
   * XMPPClient initializes with default Zustand stores automatically.
   * This method is primarily for testing with mock stores.
   *
   * @param stores - Store bindings for state management
   * @internal
   */
  bindStores(stores: StoreBindings): void {
    // Re-initialize modules with the provided stores
    // This overwrites the default initialization from the constructor
    this.initializeModules(stores)
  }

  /**
   * Initialize all modules with the provided store bindings.
   * This is called from the constructor with default bindings,
   * or from bindStores() for backwards compatibility.
   *
   * @internal
   */
  private initializeModules(stores: StoreBindings): void {
    // Prevent double initialization unless explicitly overwriting via bindStores
    if (this.modulesInitialized && this.stores === stores) {
      return
    }

    this.stores = stores

    // E2EEManager is NOT constructed here — it's tied to a logged-in
    // identity. See `ensureE2EEManager` (called from handleConnectionSuccess)
    // and `tearDownE2EEManager` (called on disconnect). Modules access it
    // via `moduleDeps.getE2EEManager()`, which returns `null` before login.

    const moduleDeps = {
      stores: this.stores,
      sendStanza: (stanza: Element) => this.sendStanza(stanza),
      sendIQ: (iq: Element, timeoutMs?: number) => this.sendIQ(iq, timeoutMs),
      getCurrentJid: () => this.currentJid,
      emit: <K extends keyof XMPPClientEvents>(event: K, ...args: Parameters<XMPPClientEvents[K]>) => this.emit(event, ...args),
      emitSDK: <K extends keyof SDKEvents>(event: K, payload: SDKEvents[K]) => this.emitSDK(event, payload),
      getXmpp: () => this.getXmpp(),
      storageAdapter: this.storageAdapter,
      proxyAdapter: this.proxyAdapter,
      registerMAMCollector: (queryId: string, collector: (stanza: Element) => void) => this.registerMAMCollector(queryId, collector),
      privacyOptions: this.privacyOptions,
      getE2EEManager: () => this.e2ee,
      shouldAutoReconnect: this.shouldAutoReconnect,
    }

    this.connection = new Connection(moduleDeps)
    this.connectionActor = this.connection.getConnectionActor()
    this.pubsub = new PubSub(moduleDeps)
    this.mam = new MAM(moduleDeps)
    this.chat = new Chat(moduleDeps, this.mam)
    this.poll = new Poll(moduleDeps, this.chat)
    this.roster = new Roster(moduleDeps)
    this.muc = new MUC(moduleDeps)
    this.admin = new Admin(moduleDeps)
    this.profile = new Profile(moduleDeps)
    this.discovery = new Discovery(moduleDeps)
    this.blocking = new Blocking(moduleDeps)
    this.ignore = new Ignore(moduleDeps)
    this.conversationSync = new ConversationSync(moduleDeps)
    this.mds = new Mds(moduleDeps)
    this.webPush = new WebPush(moduleDeps)
    this.entityTime = new EntityTime(moduleDeps)
    this.lastActivity = new LastActivity(moduleDeps)

    // Set up post-connection handler
    this.connection.setConnectionSuccessHandler(async (isResumption, previouslyJoinedRooms, disconnectDurationMs) => {
      await this.handleConnectionSuccess(isResumption, previouslyJoinedRooms, disconnectDurationMs)
    })

    // Set up disconnect handler to transition presence machine
    this.connection.setDisconnectHandler(() => {
      this.presenceActor.send({ type: 'DISCONNECT' })
      // Tear down the E2EEManager when the user disconnects — the manager
      // is tied to a logged-in identity. If they reconnect (same JID or
      // different), we rebuild fresh in handleConnectionSuccess so there's
      // no stale account state.
      void this.tearDownE2EEManager()
    })

    // Set up stanza router - Connection will call this for each incoming stanza
    this.connection.setStanzaHandler((stanza: Element) => {
      // Emit for external listeners
      this.emit('stanza', stanza)

      // Dispatch to MAM collectors first (before module routing)
      // This handles MAM query results without adding temporary listeners
      this.dispatchToMAMCollectors(stanza)

      // Route to modules (order matters - first handler to return true wins)
      // PubSub before Chat so PubSub events aren't treated as chat messages
      // Blocking before Roster so blocklist pushes are handled correctly
      const modules = [this.pubsub, this.blocking, this.poll, this.chat, this.roster, this.muc, this.profile, this.discovery, this.lastActivity]
      for (const module of modules) {
        if (module.handle(stanza)) break
      }
    })

    // Only set up event listeners once
    if (!this.modulesInitialized) {
      // Listen for MUC join events to fetch room avatars and preview
      this.on('mucJoined', (roomJid) => {
        const room = this.stores?.room.getRoom(roomJid)
        if (room && !room.avatar && !room.avatarFromPresence) {
          this.profile.fetchRoomAvatar(roomJid).catch(() => {})
        }
        // Restore cached avatars for occupants whose presence lacked vcard-temp:x:update
        this.profile.restoreOccupantAvatarsFromCache(roomJid).catch(() => {})
        // Fetch sidebar preview immediately for MAM-enabled rooms
        // For non-MAM rooms, history is requested via <history maxstanzas="50"/> on join
        // Skip on SM resumption — server already replayed all undelivered stanzas
        if (room?.supportsMAM && !room.isQuickChat && !this.isSmResumedSession) {
          this.mam.fetchPreviewForRoom(roomJid).catch(() => {})
        }
      })

      // Listen for room avatar updates from presence
      this.on('roomAvatarUpdate', (roomJid, photoHash) => {
        this.profile.fetchRoomAvatar(roomJid, photoHash).catch(() => {})
      })

      // Listen for MUC occupant avatar updates (XEP-0398)
      // Emitted by MUC module when an occupant's presence contains vcard-temp:x:update
      this.on('occupantAvatarUpdate', (roomJid, nick, hash, realJid) => {
        // Only fetch if the avatar hash changed to avoid re-downloading on every presence
        const room = this.stores?.room.getRoom(roomJid)
        const occupant = room?.occupants.get(nick)
        if (occupant?.avatarHash === hash && occupant?.avatar) {
          // Same hash and already have avatar blob - skip fetch
          return
        }
        this.profile.fetchOccupantAvatar(roomJid, nick, hash, realJid).catch(() => {})
      })

      // Listen for avatar metadata updates (XEP-0084)
      // Emitted by PubSub module for real events or Roster for vcard-temp:x:update
      this.on('avatarMetadataUpdate', (jid, hash) => {
        if (hash) {
          // Skip if contact already has this avatar hash with a loaded avatar
          const contact = this.stores?.roster.getContact(jid)
          if (contact?.avatarHash === hash && contact?.avatar) {
            return
          }
          this.profile.fetchAvatarData(jid, hash).catch(() => {})
        } else {
          // Avatar was removed
          this.stores?.roster.updateAvatar(jid, null)
        }
      })

      // Listen for contacts missing XEP-0153 avatar (empty <photo/> in presence)
      // These contacts may use XEP-0084 (PEP) avatars instead (like Conversations)
      this.on('contactMissingXep0153Avatar', (jid) => {
        // Only fetch if:
        // 1. Contact doesn't already have an avatar
        // 2. We haven't already checked this contact this session (prevents overfetching)
        const contact = this.stores?.roster.getContact(jid)
        if (!contact?.avatar && !contact?.avatarHash && !this.xep0084AvatarChecked.has(jid)) {
          this.xep0084AvatarChecked.add(jid)
          this.profile.fetchContactAvatarMetadata(jid).catch(() => {})
        }
      })

      // Restore cached avatar hashes for offline contacts when roster loads
      this.on('rosterLoaded', () => {
        this.profile.restoreAllContactAvatarHashes().catch(() => {})
      })
    }

    // Start the snapshot subscriber so SM-resumable state (rooms, roster,
    // server info, own profile) is persisted as it changes. Hydration on
    // connect() will read it back before the socket starts, so SM replays
    // land on populated state.
    if (this.storageAdapter) {
      this.stateSnapshot?.stop()
      this.stateSnapshot = new StateSnapshot({
        storageAdapter: this.storageAdapter,
        getJid: () => this.currentJid ? getBareJid(this.currentJid) : null,
      })
      this.stateSnapshot.start()
    }

    this.modulesInitialized = true
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  /**
   * Subscribe to client events.
   *
   * @param event - The event name to subscribe to
   * @param handler - The callback function to invoke when the event fires
   * @returns A function to unsubscribe from the event
   *
   * @example
   * ```typescript
   * // Subscribe to message events
   * const unsubscribe = client.on('message', (message) => {
   *   console.log('Received:', message.body)
   * })
   *
   * // Later, unsubscribe
   * unsubscribe()
   * ```
   */
  on<K extends keyof XMPPClientEvents>(
    event: K,
    handler: XMPPClientEvents[K]
  ): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(handler)
    return () => this.eventHandlers.get(event)?.delete(handler)
  }

  private emit<K extends keyof XMPPClientEvents>(
    event: K,
    ...args: Parameters<XMPPClientEvents[K]>
  ): void {
    this.eventHandlers.get(event)?.forEach((handler) => {
      // Type assertion needed because the Map stores handlers as a union type
      // but we know at runtime that handlers for this event accept these args
      ;(handler as (...args: Parameters<XMPPClientEvents[K]>) => void)(...args)
    })
  }

  // ============================================================================
  // New SDK Event System (object payloads)
  // ============================================================================

  /**
   * Subscribe to SDK events with object payloads.
   *
   * This is the new event system designed for event-based decoupling.
   * Events use object payloads instead of positional arguments for better
   * extensibility and type safety.
   *
   * @param event - The event name (e.g., 'chat:message', 'room:joined')
   * @param handler - Callback receiving the event payload object
   * @returns Unsubscribe function
   *
   * @example Bot listening to messages
   * ```typescript
   * client.subscribe('chat:message', ({ message }) => {
   *   console.log(`${message.from}: ${message.body}`)
   *   if (message.body?.includes('hello')) {
   *     client.chat.sendMessage(message.from, 'Hello!')
   *   }
   * })
   * ```
   *
   * @example Wiring to custom state management
   * ```typescript
   * client.subscribe('roster:loaded', ({ contacts }) => {
   *   myStore.setContacts(contacts)
   * })
   * ```
   */
  subscribe<K extends keyof SDKEvents>(
    event: K,
    handler: SDKEventHandler<K>
  ): () => void {
    if (!this.sdkEventHandlers.has(event)) {
      this.sdkEventHandlers.set(event, new Set())
    }
    this.sdkEventHandlers.get(event)!.add(handler as SDKEventHandler<keyof SDKEvents>)
    return () => this.sdkEventHandlers.get(event)?.delete(handler as SDKEventHandler<keyof SDKEvents>)
  }

  /**
   * Emit an SDK event with object payload.
   *
   * @internal Used by modules to emit events
   */
  emitSDK<K extends keyof SDKEvents>(event: K, payload: SDKEvents[K]): void {
    this.sdkEventHandlers.get(event)?.forEach((handler) => {
      ;(handler as SDKEventHandler<K>)(payload)
    })
  }

  /**
   * Subscribe to raw XMPP stanza events.
   *
   * @param handler - Callback invoked for each incoming stanza
   * @returns A function to unsubscribe
   *
   * @example
   * ```typescript
   * const unsubscribe = client.onStanza((stanza) => {
   *   console.log('Raw stanza:', stanza.toString())
   * })
   * ```
   */
  onStanza(handler: (stanza: Element) => void): () => void {
    return this.on('stanza', handler)
  }

  // ============================================================================
  // MAM Query Collector Registry
  // ============================================================================

  /**
   * Register a MAM query collector.
   * The collector will be called for each stanza that might be a MAM result.
   * This replaces adding temporary listeners to the xmpp client.
   *
   * @param queryId - The MAM query ID
   * @param collector - Callback to handle matching stanzas
   * @returns A function to unregister the collector
   * @internal Used by MAM module
   */
  registerMAMCollector(queryId: string, collector: (stanza: Element) => void): () => void {
    this.mamCollectors.set(queryId, collector)
    return () => this.mamCollectors.delete(queryId)
  }

  /**
   * Dispatch a stanza to any registered MAM collectors.
   * Called from the stanza handler before module routing.
   *
   * @param stanza - The incoming stanza
   * @internal
   */
  private dispatchToMAMCollectors(stanza: Element): void {
    // Only process if we have active collectors
    if (this.mamCollectors.size === 0) return

    // Pass to all collectors - they will check if the stanza matches their query
    this.mamCollectors.forEach((collector) => {
      try {
        collector(stanza)
      } catch {
        // Collector errors shouldn't crash the stanza handler
      }
    })
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to an XMPP server.
   *
   * @param options - Connection options including JID, password, and server
   * @returns Promise that resolves when connected
   * @throws Error if connection fails
   *
   * @example
   * ```typescript
   * await client.connect({
   *   jid: 'user@example.com',
   *   password: 'secret',
   *   server: 'example.com'
   * })
   * ```
   *
   * @example With Stream Management resumption
   * ```typescript
   * const smState = client.getStreamManagementState()
   * await client.connect({
   *   jid: 'user@example.com',
   *   password: 'secret',
   *   server: 'example.com',
   *   smState // Resume previous session
   * })
   * ```
   */
  async connect(options: ConnectOptions): Promise<void> {
    const scopedJid = getBareJid(options.jid)
    const previousScope = getStorageScopeJid()
    if (previousScope !== scopedJid) {
      setStorageScopeJid(scopedJid)
      chatStore.getState().switchAccount(scopedJid)
      roomStore.getState().switchAccount(scopedJid)
      activityLogStore.getState().rehydrate()
      ignoreStore.getState().rehydrate()
    }

    // Open the search index DB and backfill from message cache if needed (one-time migration)
    void (async () => {
      try {
        await initSearchIndex(scopedJid)
        await backfillFromMessageCache()
      } catch {
        // Ignore — search index is non-critical for connection
      }
    })()

    this.currentJid = options.jid
    this.stores?.connection.setJid(options.jid)

    // Hydrate stores from the persisted snapshot BEFORE handing the socket
    // to xmpp.js. SM replay delivers diffs (occupant leaves, new messages,
    // presence changes) as patches on existing state — if the stores are
    // empty on resume the diffs are silently lost.
    if (this.stateSnapshot) {
      await this.stateSnapshot.hydrate(scopedJid)
    }

    return this.connection.connect(options)
  }

  /**
   * Disconnect from the XMPP server.
   *
   * @param options.invalidateFastToken - When true and a FAST token
   *   (XEP-0484) is stored for this account, request server-side
   *   invalidation before tearing down the transport. Use this on
   *   explicit user logout so the stored token can no longer be
   *   replayed from another device.
   *
   * @returns Promise that resolves when disconnected
   *
   * @example
   * ```typescript
   * // Regular disconnect (preserves the FAST token)
   * await client.disconnect()
   *
   * // Explicit logout — also drops the server-side FAST token
   * await client.disconnect({ invalidateFastToken: true })
   * ```
   */
  async disconnect(options: { invalidateFastToken?: boolean } = {}): Promise<void> {
    this.currentJid = null
    // Clear session-scoped tracking data
    this.xep0084AvatarChecked.clear()
    this.entityTime?.clearCache()
    this.lastActivity?.clearCache()
    return this.connection.disconnect(options)
  }

  /**
   * Cancel any pending reconnection attempts.
   *
   * @remarks
   * Useful when the user explicitly wants to stay disconnected,
   * for example when logging out.
   */
  cancelReconnect(): void {
    this.connection.cancelReconnect()
  }

  /**
   * Nudge the reconnect loop forward if it is currently stuck waiting.
   *
   * @remarks
   * Only does work when the state machine is in `reconnecting.waiting`: it
   * skips the remaining backoff delay and transitions to `attempting`.
   * When the machine is in `reconnecting.attempting` the signal is ignored,
   * and outside of reconnecting states this method early-returns. Safe to
   * call repeatedly as a heartbeat (e.g., from a native-thread keepalive).
   */
  nudgeReconnect(): void {
    this.connection.nudgeReconnect()
  }

  /**
   * Verify the connection is alive by sending an XMPP ping (XEP-0199).
   *
   * @returns Promise that resolves to true if the server responds, false otherwise
   *
   * @example
   * ```typescript
   * const isAlive = await client.verifyConnection()
   * if (!isAlive) {
   *   client.nudgeReconnect()
   * }
   * ```
   */
  async verifyConnection(): Promise<boolean> {
    return this.connection.verifyConnection()
  }

  /**
   * Lightweight connection health check for routine keepalive.
   *
   * Unlike {@link verifyConnection}, this does NOT change connection status
   * or trigger presence events. Suitable for periodic health checks where
   * the connection is expected to be healthy.
   *
   * @returns Promise that resolves to true if healthy, false if dead
   */
  async verifyConnectionHealth(): Promise<boolean> {
    return this.connection.verifyConnectionHealth()
  }

  /**
   * Handle a keepalive tick from an external clock (e.g., Rust native timer).
   *
   * The SDK routes the tick internally based on connection state and the
   * display-power signal: nudges a stalled reconnect loop, runs a health
   * check when connected, or no-ops. When `displayActive` is `false` the
   * tick does no network work and only informs the state machine.
   *
   * @param displayActive Primary-display power state (undefined = legacy
   *   payload, treated as active / fail-open).
   * @param sleptMs Real wall-clock elapsed reported by the native loop.
   */
  handleKeepaliveTick(displayActive?: boolean, sleptMs?: number): void {
    this.connection.handleKeepaliveTick(displayActive, sleptMs)
  }

  /**
   * Notify the SDK of a system state change.
   *
   * This is the recommended way for apps to signal platform-specific events
   * (wake from sleep, visibility changes) to the SDK. The SDK handles the
   * appropriate protocol response internally.
   *
   * **Headless Client Pattern**: The app is responsible for detecting platform
   * events (Tauri sleep notifications, visibility API, etc.), while the SDK
   * handles the XMPP protocol response.
   *
   * @param state - The system state change:
   *   - 'awake': System woke from sleep. SDK verifies connection and reconnects if dead.
   *   - 'sleeping': System is going to sleep. SDK may gracefully disconnect.
   *   - 'visible': App became visible/foreground. SDK verifies connection.
   *   - 'hidden': App went to background.
   * @param sleepDurationMs - Optional duration of sleep/inactivity in milliseconds.
   *   If provided and exceeds SM session timeout (~10 min), skips verification and
   *   immediately triggers reconnect (the SM session is definitely expired).
   *
   * @example
   * ```typescript
   * // App detects wake from sleep with duration (e.g., via time-gap detection)
   * client.notifySystemState('awake', sleepGapMs)
   *
   * // App visibility changed
   * document.addEventListener('visibilitychange', () => {
   *   client.notifySystemState(document.hidden ? 'hidden' : 'visible')
   * })
   * ```
   */
  async notifySystemState(
    state: 'awake' | 'sleeping' | 'visible' | 'hidden',
    sleepDurationMs?: number
  ): Promise<void> {
    // Signal presence machine for relevant states.
    // This makes notifySystemState the single orchestration point:
    // one call handles both presence transitions and connection verification.
    switch (state) {
      case 'awake':
        this.presenceActor.send({ type: 'WAKE_DETECTED' })
        break
      case 'sleeping':
        this.presenceActor.send({ type: 'SLEEP_DETECTED' })
        break
    }
    // Delegate to connection module for connection-level handling
    return this.connection.notifySystemState(state, sleepDurationMs)
  }

  /**
   * Clear persisted presence state (called on explicit logout).
   *
   * @example
   * ```typescript
   * client.clearPersistedPresence()
   * await client.disconnect()
   * ```
   */
  clearPersistedPresence(): void {
    if (typeof sessionStorage === 'undefined') {
      return
    }
    try {
      sessionStorage.removeItem(PRESENCE_STORAGE_KEY)
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Clean up the client instance.
   *
   * Call this when destroying the client to clean up subscriptions and resources.
   * For React apps, XMPPProvider calls this automatically on unmount.
   *
   * @example
   * ```typescript
   * client.destroy()
   * ```
   */
  destroy(): void {
    // Unload all event hooks
    for (const hook of this.eventHooks.values()) {
      hook.onunload()
    }
    this.eventHooks.clear()

    // Clean up all subscriptions (store bindings, side effects, presence sync,
    // presence persistence) to prevent memory leaks
    for (const cleanup of this.cleanupFunctions) {
      try { cleanup() } catch { /* ignore */ }
    }
    this.cleanupFunctions = []

    // Tear down the snapshot subscriber + cancel pending debounced writes
    this.stateSnapshot?.stop()
    this.stateSnapshot = undefined

    // Clean up MUC pending joins to prevent orphaned timeouts
    this.muc?.cleanup()
  }

  /**
   * Flush any pending debounced snapshot writes to storage.
   *
   * Call this from `beforeunload`/`pagehide` handlers so the latest store
   * state (roster, rooms, profile) survives page reload. SM counters still
   * need `persistSmState()` — they use synchronous storage for write
   * reliability during unload.
   */
  async flushStateSnapshot(): Promise<void> {
    if (this.stateSnapshot) {
      await this.stateSnapshot.flush()
    }
  }

  /**
   * Clear the persisted snapshot for the current JID. Called on explicit
   * logout so a subsequent login starts with an empty store.
   */
  async clearStateSnapshot(): Promise<void> {
    const jid = this.currentJid ? getBareJid(this.currentJid) : null
    if (this.stateSnapshot && jid) {
      await this.stateSnapshot.clear(jid)
    }
  }

  // ============================================================================
  // Event Hook Registry (Obsidian-inspired)
  // ============================================================================

  /**
   * Register and activate an event hook.
   *
   * The hook's `onload()` method is called immediately. All event
   * subscriptions registered inside `onload()` via `registerEvent()`
   * will be automatically cleaned up when the hook is unregistered
   * or the client is destroyed.
   *
   * @param hook - The event hook to register
   * @throws Error if a hook with the same ID is already registered
   *
   * @example
   * ```typescript
   * const hook = new ActivityLogHook(client)
   * client.registerHook(hook)
   * ```
   */
  registerHook(hook: EventHook): void {
    if (this.eventHooks.has(hook.id)) {
      throw new Error(`EventHook "${hook.id}" is already registered`)
    }
    this.eventHooks.set(hook.id, hook)
    hook.onload()
  }

  /**
   * Unregister and deactivate an event hook.
   *
   * Calls the hook's `onunload()` method which cleans up all
   * registered event subscriptions.
   *
   * @param hookId - The ID of the hook to unregister
   */
  unregisterHook(hookId: string): void {
    const hook = this.eventHooks.get(hookId)
    if (hook) {
      hook.onunload()
      this.eventHooks.delete(hookId)
    }
  }

  /**
   * Get a registered hook by ID.
   *
   * @param hookId - The ID of the hook to retrieve
   * @returns The hook instance, or undefined if not found
   */
  getHook(hookId: string): EventHook | undefined {
    return this.eventHooks.get(hookId)
  }

  /**
   * Set up presence synchronization between the presence machine and XMPP server.
   *
   * Subscribes to the presence actor and automatically sends XMPP presence
   * when the machine state changes.
   *
   * @param presenceActor - The XState presence actor to sync with
   * @returns Unsubscribe function to stop the sync
   * @internal
   */
  private setupPresenceSync(presenceActor: PresenceActor): () => void {
    let previousShow: string | undefined
    let previousStatus: string | null = null
    let isFirstUpdate = true
    let consecutiveErrors = 0
    let lastErrorTime = 0
    const ERROR_SUPPRESSION_THRESHOLD = 3  // Suppress after 3 consecutive errors
    const ERROR_RESET_INTERVAL = 30000     // Reset error count after 30s of no errors

    const subscription: Subscription = presenceActor.subscribe((state) => {
      // Only sync when connected to XMPP server
      const connectionStatus = this.stores?.connection.getStatus()

      // Get current presence from state machine
      const stateValue = state.value as PresenceStateValue
      const currentShow = getPresenceShowFromState(stateValue)
      const currentStatus = (state.context as PresenceMachineContext).statusMessage

      // Skip if not online OR if reconnecting (socket may be in bad state)
      if (connectionStatus !== 'online') {
        // Only log occasionally to avoid spam during reconnection storms
        if (connectionStatus !== 'reconnecting' || consecutiveErrors === 0) {
          this.stores?.console.addEvent(
            `[PresenceSync] Skipped: not online (status: ${connectionStatus})`,
            'presence'
          )
        }
        return
      }

      // Additional guard: verify socket is actually usable before attempting send
      const xmpp = this.getXmpp()
      if (!xmpp) {
        // Socket is null but status says online - race condition, skip silently
        return
      }

      // Skip initial subscription (handled by sendInitialPresence on connect)
      // Must check this BEFORE the change detection, since initial values match 'online'
      if (isFirstUpdate) {
        isFirstUpdate = false
        previousShow = currentShow
        previousStatus = currentStatus
        this.stores?.console.addEvent(
          `[PresenceSync] First update, setting baseline: show=${currentShow ?? 'online'}`,
          'presence'
        )
        return
      }

      // Check if presence actually changed
      if (currentShow === previousShow && currentStatus === previousStatus) {
        return
      }

      this.stores?.console.addEvent(
        `[PresenceSync] Presence changed: ${previousShow ?? 'online'} → ${currentShow ?? 'online'}, sending XMPP presence`,
        'presence'
      )

      previousShow = currentShow
      previousStatus = currentStatus

      // Send broadcast presence to server + directed presence to MUC rooms
      // currentShow is already in XMPP format (undefined = online, 'away', 'dnd', 'xa')
      const showValue = currentShow || 'online'
      const statusValue = currentStatus ?? undefined
      Promise.all([
        this.roster.setPresence(showValue, statusValue),
        this.muc.sendPresenceToRooms(showValue, statusValue),
      ])
        .then(() => {
          // Reset error count on success
          consecutiveErrors = 0
        })
        .catch((err) => {
          const now = Date.now()

          // Reset error count if it's been a while since last error
          if (now - lastErrorTime > ERROR_RESET_INTERVAL) {
            consecutiveErrors = 0
          }

          consecutiveErrors++
          lastErrorTime = now

          // Only log first few errors, then suppress to avoid log spam
          if (consecutiveErrors <= ERROR_SUPPRESSION_THRESHOLD) {
            console.error('[PresenceSync] Failed to send XMPP presence:', err)
            this.stores?.console.addEvent(
              `[PresenceSync] ERROR: Failed to send presence: ${err}`,
              'presence'
            )
          } else if (consecutiveErrors === ERROR_SUPPRESSION_THRESHOLD + 1) {
            // Log once that we're suppressing further errors
            this.stores?.console.addEvent(
              `[PresenceSync] Suppressing further errors (${consecutiveErrors} consecutive failures)`,
              'presence'
            )
          }
          // Errors are still handled by sendStanza which triggers reconnect
        })
    })

    return () => subscription.unsubscribe()
  }

  /**
   * Get Stream Management state for session resumption (XEP-0198).
   *
   * @returns The SM state if available, or null if not connected/not supported
   *
   * @remarks
   * Save this state before disconnecting to resume the session later.
   * This allows maintaining message reliability across reconnections.
   *
   * @example
   * ```typescript
   * // Save state before page unload
   * const smState = client.getStreamManagementState()
   * sessionStorage.setItem('sm', JSON.stringify(smState))
   *
   * // Restore on reconnect
   * const saved = JSON.parse(sessionStorage.getItem('sm'))
   * await client.connect({ ...options, smState: saved })
   * ```
   */
  getStreamManagementState(): { id: string; inbound: number; outbound: number } | null {
    return this.connection.getStreamManagementState()
  }

  /**
   * Persist current Stream Management state to storage.
   *
   * Call this before page unload to capture the latest SM inbound counter.
   * The SDK automatically persists SM state on enable/resume, but the inbound
   * counter is updated on each received stanza. Call this method in a
   * beforeunload handler to ensure the latest value is saved for session
   * resumption after page reload.
   *
   * @remarks
   * This method uses synchronous storage (sessionStorage.setItem) to ensure
   * the write completes before the page unloads. Async operations may not
   * complete during page unload.
   *
   * @example
   * ```typescript
   * window.addEventListener('beforeunload', () => {
   *   client.persistSmState()
   * })
   * ```
   */
  persistSmState(): void {
    this.connection.persistSmStateNow()
  }

  // ============================================================================
  // Core Utilities
  // ============================================================================

  /**
   * Get the current user's JID (Jabber ID).
   *
   * @returns The full JID if connected, null otherwise
   */
  getJid(): string | null {
    return this.currentJid
  }

  /**
   * Check if the client is currently connected.
   *
   * @returns true if connected, false otherwise
   */
  isConnected(): boolean {
    return this.getXmpp() !== null && this.currentJid !== null
  }

  /**
   * Check if the server supports Message Archive Management (XEP-0313).
   *
   * @returns true if MAM is supported, false otherwise
   *
   * @remarks
   * MAM support is discovered during connection via service discovery.
   * This method returns false if not connected or if the server
   * doesn't advertise MAM support.
   */
  supportsMAM(): boolean {
    const serverInfo = this.stores?.connection.getServerInfo?.()
    return serverInfo?.features?.includes(NS_MAM) ?? false
  }

  /**
   * Send a raw XML string directly to the server.
   *
   * @param xmlString - The raw XML to send
   * @throws Error if not connected
   *
   * @remarks
   * This is primarily intended for the XMPP console/debugging feature.
   * For normal operations, use the module APIs instead.
   *
   * @example
   * ```typescript
   * await client.sendRawXml('<presence/>')
   * ```
   */
  async sendRawXml(xmlString: string): Promise<void> {
    const xmpp = this.getXmpp()
    if (!xmpp) {
      // Defensive check: if client is null but status says 'online', fix the inconsistency
      const currentStatus = this.stores?.connection.getStatus?.()
      if (currentStatus === 'online') {
        this.stores?.console.addEvent('Client null but status online - triggering reconnect', 'error')
        this.connection.handleDeadSocket()
      }
      throw new Error('Not connected')
    }
    try {
      await (xmpp as any).write(xmlString)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (isDeadSocketError(errorMessage)) {
        this.connection.handleDeadSocket()
      }
      throw err
    }
  }

  // ============================================================================
  // Internal Methods
  // ============================================================================

  private getXmpp(): Client | null {
    const xmpp = this.connection.getClient()
    if (!xmpp) return null

    // Only expose the transport once the connection machine reached a connected state.
    // This makes auth completion ("online"/SM resumed) the single synchronous gate.
    const machineState = this.connectionActor.getSnapshot().value as ConnectionStateValue
    const isConnectedState =
      typeof machineState === 'object' && machineState !== null && 'connected' in machineState
    return isConnectedState ? xmpp : null
  }

  /**
   * Handle successful connection — dispatches to SM resume or fresh session path.
   */
  private async handleConnectionSuccess(
    isResumption: boolean,
    previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>,
    disconnectDurationMs?: number
  ): Promise<void> {
    // Increment session generation to invalidate any in-progress handleFreshSession/handleSmResumption.
    // If the system sleeps during an await below and a reconnect fires, the new call increments
    // this counter again, causing the stale run to bail out at its next checkpoint.
    const generation = ++this.sessionGeneration

    // Session-scoped discovery caches (e.g. the account PEP probe) must not
    // leak across sessions — server capabilities can change between logins.
    this.discovery.resetSessionCache()

    const platform = getCachedPlatform() ?? 'unknown'
    logInfo(`SDK v${SDK_VERSION}, platform: ${platform}, session #${generation}`)

    // Transition presence machine to connected state
    this.presenceActor.send({ type: 'CONNECT' })

    // Track session type for guards (e.g., skip MAM preview on mucJoined during SM replay)
    this.isSmResumedSession = isResumption

    // The E2EEManager is tied to a logged-in identity. Construct it the
    // first time we reach `online` (account JID now known), or rebuild it
    // if the previous manager was for a different identity. On a plain
    // SM-resume/reconnect with the same JID we reuse the existing manager
    // so registered plugins stay registered.
    this.ensureE2EEManager()

    if (isResumption) {
      await this.handleSmResumption(generation, previouslyJoinedRooms, disconnectDurationMs)
    } else {
      await this.handleFreshSession(previouslyJoinedRooms, generation)
    }

    // Only run post-session tasks if this generation is still current
    if (this.isSessionStale(generation)) return

    // Write cache integrity marker (used to detect cache clear during SM resumption).
    // Written on both fresh and resumed sessions so the marker is always refreshed.
    try {
      if (this.currentJid) {
        localStorage.setItem(`fluux:cache-marker:${this.currentJid}`, Date.now().toString())
      }
    } catch { /* ignore storage errors */ }

    // Always re-discover admin commands (lightweight, no MAM)
    this.admin.discoverAdminCommands().catch(() => {})
  }

  /**
   * Replace the E2EE storage backend. Call this before registering any
   * plugins — typically in the `online` event handler, before calling
   * `registerE2EEPlugins`. The active manager (if any) is also updated so
   * subsequent plugin registrations use the new backend.
   *
   * The primary use case is injecting a persistent IndexedDB backend on web
   * (where the default InMemoryStorageBackend would lose key material on
   * page reload).
   */
  setE2EEStorageBackend(backend: StorageBackend): void {
    this.e2eeStorageBackend = backend
    this.e2ee?.setStorage(backend)
  }

  /**
   * Signal that the E2EE private key has been unlocked (e.g. web passphrase
   * entered). Triggers an automatic retry of all pending decryptions.
   */
  notifyE2EEKeyUnlocked(): void {
    this.emitSDK('e2ee:key-unlocked', undefined)
    void this.retryPendingDecrypts()
  }

  /**
   * Re-decrypt all stored messages that carry an {@link encryptedPayload}
   * because decryption failed at receive time (no plugin registered, key
   * locked, etc.).
   *
   * Iterates both chat and room stores, reconstructs the stanza from the
   * serialized XML, and re-runs {@link decryptStanzaInPlace}. On success
   * the message body + securityContext are updated in-place via
   * `store.updateMessage()`, and the `encryptedPayload` is cleared.
   *
   * Protected by a flag to prevent concurrent retry loops when multiple
   * triggers fire close together.
   *
   * @returns the number of messages successfully decrypted
   */
  async retryPendingDecrypts(): Promise<number> {
    if (this.isRetryingDecrypts) {
      // A pass is already running. Remember the request so the in-flight
      // pass re-runs on completion rather than dropping this trigger.
      this.retryDecryptsRequested = true
      return 0
    }
    const manager = this.e2ee
    if (!manager || !manager.hasPlugins()) return 0
    if (!this.stores) return 0

    this.isRetryingDecrypts = true
    let decryptedCount = 0
    // Chat messages handled by the in-memory pass below, so the durable-cache
    // pass can skip them (keyed by conversationId + message id).
    const handledChatKeys = new Set<string>()

    try {
      const chatBindings = this.stores.chat
      const roomBindings = this.stores.room

      // --- 1:1 chat messages ---
      // Read state from the imported Zustand stores (getState), mutate
      // through StoreBindings so the abstract API contract is honoured.
      const chatMessages = chatStore.getState().messages
      for (const [conversationId, messages] of chatMessages) {
        for (const msg of messages) {
          if (!msg.encryptedPayload) continue
          handledChatKeys.add(`${conversationId} ${msg.id}`)
          const outcome = await this.retryDecryptSingle(
            manager, msg.encryptedPayload, msg.from, conversationId,
          )
          if (outcome.kind === 'decrypted') {
            chatBindings.updateMessage(conversationId, msg.id, {
              body: outcome.body,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              ...(outcome.attachment && { attachment: outcome.attachment }),
              encryptedPayload: undefined,
            })
            decryptedCount++
          } else if (outcome.kind === 'modification') {
            this.applyDeferredChatModification(conversationId, msg, outcome.modification, chatBindings)
            decryptedCount++
          } else if (outcome.kind === 'rejected') {
            this.resolveRejectedChatPlaceholder(conversationId, msg, outcome.securityContext, chatBindings)
          } else if (outcome.kind === 'unsupported') {
            chatBindings.updateMessage(conversationId, msg.id, {
              encryptedPayload: undefined,
              unsupportedEncryption: outcome.info,
            })
          }
        }
      }

      // --- Room messages ---
      const roomRuntimes = roomStore.getState().roomRuntime
      for (const [roomJid, runtime] of roomRuntimes) {
        for (const msg of runtime.messages) {
          if (!msg.encryptedPayload) continue
          const outcome = await this.retryDecryptSingle(
            manager, msg.encryptedPayload, msg.from, roomJid, 'room',
          )
          if (outcome.kind === 'decrypted') {
            roomBindings.updateMessage(roomJid, msg.id, {
              body: outcome.body,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              ...(outcome.attachment && { attachment: outcome.attachment }),
              encryptedPayload: undefined,
            })
            decryptedCount++
          } else if (outcome.kind === 'rejected') {
            // MUC carries no encrypted bodiless signals, so a rejected room
            // message always has real content — warn the user and clear the stash.
            roomBindings.updateMessage(roomJid, msg.id, {
              body: MESSAGE_REJECTED_BODY,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              encryptedPayload: undefined,
            })
          } else if (outcome.kind === 'unsupported') {
            roomBindings.updateMessage(roomJid, msg.id, {
              encryptedPayload: undefined,
              unsupportedEncryption: outcome.info,
            })
          }
        }
      }

      // --- Durable cache (web fresh-session reload) ---
      // Conversations the user has not opened are absent from the in-memory
      // store, so the loops above miss their stashed messages — they would
      // stay permanently "could not be decrypted" even after unlock. Repair
      // them straight in IndexedDB. The sparse `encryptedPayload` index makes
      // this O(pending), not a full-archive scan, and near-free when nothing
      // is pending (the steady state).
      for (const msg of await getMessagesWithEncryptedPayload()) {
        const conversationId = msg.conversationId
        if (!msg.encryptedPayload || !conversationId) continue
        if (handledChatKeys.has(`${conversationId} ${msg.id}`)) continue
        const outcome = await this.retryDecryptSingle(
          manager, msg.encryptedPayload, msg.from, conversationId,
        )
        if (outcome.kind === 'decrypted') {
          const updates = {
            body: outcome.body,
            ...(outcome.securityContext && { securityContext: outcome.securityContext }),
            ...(outcome.attachment && { attachment: outcome.attachment }),
            encryptedPayload: undefined,
          }
          await cacheUpdateMessage(msg.id, updates)
          // The conversation's messages aren't loaded (durable path), so the
          // in-memory sidebar preview would keep the "[OpenPGP-encrypted
          // message]" fallback. Heal it when this message IS the preview.
          chatBindings.refreshLastMessageContent?.(conversationId, msg.id, updates)
          decryptedCount++
        } else if (outcome.kind === 'modification') {
          // Conversation isn't loaded in memory. Apply best-effort to the
          // in-memory target (no-op if absent) and drop the durable placeholder
          // so it can't resurrect as a "[could not decrypt]" bubble. The store
          // binding's removeMessage only touches in-memory state, so delete
          // from the durable cache explicitly. For never-opened conversations
          // the signal is reconciled on the next MAM catch-up, when the
          // now-unlocked key decrypts it inline.
          this.applyDeferredChatModification(conversationId, msg, outcome.modification, chatBindings)
          await cacheDeleteMessage(msg.id)
          decryptedCount++
        } else if (outcome.kind === 'rejected') {
          if (msg.body === COULD_NOT_DECRYPT_BODY) {
            // Bodiless-signal placeholder (forged reaction/retraction) — drop it.
            await cacheDeleteMessage(msg.id)
          } else {
            const updates = {
              body: MESSAGE_REJECTED_BODY,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              encryptedPayload: undefined,
            }
            await cacheUpdateMessage(msg.id, updates)
            chatBindings.refreshLastMessageContent?.(conversationId, msg.id, updates)
          }
        } else if (outcome.kind === 'unsupported') {
          const updates = {
            encryptedPayload: undefined,
            unsupportedEncryption: outcome.info,
          }
          await cacheUpdateMessage(msg.id, updates)
          chatBindings.refreshLastMessageContent?.(conversationId, msg.id, updates)
        }
      }

      if (decryptedCount > 0) {
        logInfo(`E2EE deferred decrypt: successfully decrypted ${decryptedCount} message(s)`)
      }
    } finally {
      this.isRetryingDecrypts = false
    }

    // A trigger that arrived mid-pass was coalesced — run once more so its
    // newly-available state (e.g. a just-unlocked key) is applied.
    if (this.retryDecryptsRequested) {
      this.retryDecryptsRequested = false
      decryptedCount += await this.retryPendingDecrypts()
    }

    return decryptedCount
  }

  /**
   * Apply a bodiless signal (XEP-0444 reaction or XEP-0424 retraction)
   * recovered from a deferred decrypt to its target message, then remove the
   * "[could not decrypt]" placeholder it was provisionally stored under. The
   * sender of the placeholder stanza is the actor — our own bare JID for a
   * self-outgoing MAM replay, the peer's for an inbound one. A retraction is
   * only honoured when that actor authored the target (mirrors the live path).
   */
  private applyDeferredChatModification(
    conversationId: string,
    placeholder: { id: string; from: string },
    modification: RetryModification,
    chatBindings: StoreBindings['chat'],
  ): void {
    const actorJid = getBareJid(placeholder.from)
    if (modification.type === 'reactions') {
      chatBindings.updateReactions(conversationId, modification.targetId, actorJid, modification.emojis)
    } else {
      const target = chatBindings.getMessage(conversationId, modification.targetId)
      const updates = applyRetraction(!!target && target.from === actorJid)
      if (updates) chatBindings.updateMessage(conversationId, modification.targetId, updates)
    }
    chatBindings.removeMessage(conversationId, placeholder.id)
  }

  /**
   * Resolve a chat placeholder whose deferred decrypt was finally rejected
   * (invalid signature — final, never retried again). A bodiless-signal
   * placeholder still carries the {@link COULD_NOT_DECRYPT_BODY} marker that
   * stanzaDecrypt stamps onto reactions/retractions; it is removed entirely so
   * a forged signal never surfaces as a ghost bubble. A real message
   * placeholder (any other body) is replaced with a "[Message rejected]" body
   * so the user is warned the message could not be trusted.
   */
  private resolveRejectedChatPlaceholder(
    conversationId: string,
    placeholder: { id: string; body: string },
    securityContext: MessageSecurityContext | undefined,
    chatBindings: StoreBindings['chat'],
  ): void {
    if (placeholder.body === COULD_NOT_DECRYPT_BODY) {
      chatBindings.removeMessage(conversationId, placeholder.id)
    } else {
      chatBindings.updateMessage(conversationId, placeholder.id, {
        body: MESSAGE_REJECTED_BODY,
        ...(securityContext && { securityContext }),
        encryptedPayload: undefined,
      })
    }
  }

  /**
   * Attempt to decrypt a single stashed payload — either a full original
   * `<message>` stanza (current format, keeps outer reply/fallback context)
   * or a bare encrypted element (legacy persisted stashes).
   * @returns `RetryOutcome` describing whether decryption succeeded, the
   *   protocol is unsupported, or the message should remain pending.
   * @internal
   */
  private async retryDecryptSingle(
    manager: E2EEManager,
    encryptedPayloadXml: string,
    senderJid: string,
    peer: string,
    messageContext: 'chat' | 'room' = 'chat',
  ): Promise<RetryOutcome> {
    try {
      const ltx = await import('ltx')
      const parsedPayload = ltx.parse(encryptedPayloadXml) as unknown as Element

      // Current stashes hold the full original <message> stanza so outer
      // cleartext context (XEP-0461 <reply>, XEP-0428 <fallback> ranges)
      // survives until this retry. Stashes persisted before that format
      // hold just the encrypted child and need a minimal wrapper.
      const stanza =
        parsedPayload.name === 'message'
          ? parsedPayload
          : (xml('message', { from: senderJid }, parsedPayload) as Element)
      if (!stanza.attrs.from) stanza.attrs.from = senderJid

      // Detect self-outgoing (sent carbon or MAM self-replay): when the
      // sender's bare JID equals our own, the signcrypt envelope's <to/>
      // addresses the conversation peer — not us — so the plugin's
      // reflection check must be inverted via isSelfOutgoing.
      const ownBareJid = this.currentJid ? getBareJid(this.currentJid) : ''
      const isSelfOutgoing = ownBareJid !== '' && getBareJid(senderJid) === ownBareJid

      const result = await decryptStanzaInPlace(
        stanza, manager, peer, 'archive',
        isSelfOutgoing ? { isSelfOutgoing: true } : undefined,
      )

      // Protocol we have no plugin for (e.g. OMEMO): nothing to retry. Drop the
      // encryptedPayload and tag the message so the already-stored fallback body
      // renders with an "unsupported method" hint.
      if (result.unsupportedEncryption) {
        return { kind: 'unsupported', info: result.unsupportedEncryption }
      }

      if (!result.attempted || result.encryptedPayloadXml) {
        // Still can't decrypt
        return { kind: 'pending' }
      }

      // A rejected signature is final — never retryable. decryptStanzaInPlace
      // threw before unwrapping the payload, so no <reactions>/<retract>/<body>
      // was surfaced; the caller decides whether to show a "[Message rejected]"
      // bubble (real message placeholder) or drop it (bodiless-signal placeholder).
      if (result.securityContext?.trust === 'rejected') {
        return {
          kind: 'rejected',
          securityContext: {
            protocolId: result.securityContext.protocolId,
            trust: result.securityContext.trust,
            ...(result.securityContext.notes && { notes: result.securityContext.notes }),
          },
        }
      }

      // Bodiless signal stanzas (XEP-0444 reactions, XEP-0424 retractions)
      // carry no <body> — the whole element rode inside the encrypted payload
      // and now sits at the stanza root after decryptStanzaInPlace unwrapped
      // it. These were stored under a "[could not decrypt]" placeholder while
      // the key was locked; returning 'pending' here (the historical body-only
      // behaviour) silently dropped them. Surface them as a modification so the
      // caller applies the signal to its target and removes the placeholder.
      const reactionsEl = stanza.getChild('reactions', NS_REACTIONS)
      if (reactionsEl?.attrs.id) {
        const emojis = reactionsEl
          .getChildren('reaction')
          .map((r) => r.getText())
          .filter(Boolean)
        return {
          kind: 'modification',
          modification: { type: 'reactions', targetId: reactionsEl.attrs.id, emojis },
        }
      }
      const retractEl = stanza.getChild('retract', NS_RETRACT)
      if (retractEl?.attrs.id) {
        return { kind: 'modification', modification: { type: 'retract', targetId: retractEl.attrs.id } }
      }

      // Extract the decrypted body
      const body = stanza.getChildText('body')
      if (!body) return { kind: 'pending' }

      // Re-run the shared content parse on the decrypted stanza: strips
      // XEP-0428 fallback ranges (e.g. the XEP-0461 reply quote that the
      // sender prefixed to the encrypted body) and extracts the attachment
      // (aesgcm:// URI, XEP-0446 file metadata, XEP-0264 thumbnails).
      // Legacy bare-element stashes carry no outer <fallback>, so their
      // body passes through unchanged.
      const parsed = parseMessageContent({ messageEl: stanza, body, messageContext })
      const processedBody = parsed.processedBody
      const attachment = parsed.attachment
      if (attachment) {
        logDebug(
          `E2EE deferred decrypt: attachment from ${getDomain(senderJid)} — ` +
          `url=${attachment.url.slice(0, 40)}… mediaType=${attachment.mediaType ?? 'none'} ` +
          `encrypted=${!!attachment.encryption} name=${attachment.name ? '<redacted>' : 'none'}`,
        )
      }

      // Map SecurityContext to MessageSecurityContext
      let securityContext: MessageSecurityContext | undefined
      if (result.securityContext) {
        securityContext = {
          protocolId: result.securityContext.protocolId,
          trust: result.securityContext.trust,
          ...(result.securityContext.notes && { notes: result.securityContext.notes }),
          ...(result.securityContext.fingerprint && { fingerprint: result.securityContext.fingerprint }),
        }
      }

      return {
        kind: 'decrypted',
        body: processedBody,
        ...(securityContext && { securityContext }),
        ...(attachment && { attachment }),
      }
    } catch (err) {
      logWarn(`E2EE deferred decrypt failed for message from ${getDomain(senderJid)}: ${err instanceof Error ? err.message : String(err)}`)
      return { kind: 'pending' }
    }
  }

  /**
   * Re-attempt deferred decrypts AND upgrade stale trust for a specific
   * peer, triggered when that peer's PEP key material changes.
   *
   * Two categories of stored messages are handled:
   *
   * 1. Messages with `encryptedPayload` — the peer key was not available
   *    when the message was first processed, so the signature could not be
   *    verified. Re-decrypt now that the key may be cached.
   *
   * 2. Old messages without `encryptedPayload` but with
   *    `securityContext.trust === 'untrusted'` and a "not cached" note —
   *    these were persisted before the payload-stash fix landed. We cannot
   *    re-verify their signatures (the ciphertext is gone), but the
   *    decryption + signcrypt envelope validation succeeded, so upgrading
   *    to `tofu` is a sound pragmatic trade-off.
   */
  private async retryPendingDecryptsForPeer(peer: string): Promise<void> {
    const manager = this.e2ee
    if (!manager || !manager.hasPlugins()) return
    if (!this.stores) return

    const chatBindings = this.stores.chat
    const chatMessages = chatStore.getState().messages
    const peerMessages = chatMessages.get(peer)
    if (!peerMessages) return

    let updated = 0
    for (const msg of peerMessages) {
      if (msg.encryptedPayload) {
        const outcome = await this.retryDecryptSingle(
          manager, msg.encryptedPayload, msg.from, peer,
        )
        if (outcome.kind === 'decrypted') {
          chatBindings.updateMessage(peer, msg.id, {
            body: outcome.body,
            ...(outcome.securityContext && { securityContext: outcome.securityContext }),
            ...(outcome.attachment && { attachment: outcome.attachment }),
            encryptedPayload: undefined,
          })
          updated++
        } else if (outcome.kind === 'unsupported') {
          chatBindings.updateMessage(peer, msg.id, {
            encryptedPayload: undefined,
            unsupportedEncryption: outcome.info,
          })
          updated++
        }
        continue
      }
      if (
        msg.securityContext?.trust === 'untrusted' &&
        msg.securityContext.notes?.some((n) => n.includes('not cached'))
      ) {
        chatBindings.updateMessage(peer, msg.id, {
          securityContext: {
            protocolId: msg.securityContext.protocolId,
            trust: 'tofu',
          },
        })
        updated++
      }
    }
    if (updated > 0) {
      logInfo(`E2EE peer key change: updated ${updated} message(s) for ${getDomain(peer)}`)
    }
  }

  /**
   * Build the E2EEManager if it doesn't yet exist, or if the previous
   * manager was bound to a different JID. On a plain reconnect/SM-resume
   * for the same identity this is a no-op and existing plugins stay
   * registered.
   *
   * @internal
   */
  private ensureE2EEManager(): void {
    if (!this.currentJid) return
    const bareJid = getBareJid(this.currentJid)
    if (this.e2ee) {
      // Already built for this identity — leave it alone.
      if (this.e2ee.getAccountJid() === bareJid) return
      // Different JID: tear down and rebuild. Fire-and-forget shutdown
      // since we don't want to block the connect path on plugin cleanup.
      void this.e2ee.shutdown().catch(() => {})
      this.e2ee = null
    }

    const e2eeLogger = createE2EEDiagnosticLogger({
      addEvent: (message, category) => this.stores?.console.addEvent(message, category),
    })

    this.e2ee = new E2EEManager({
      storage: this.e2eeStorageBackend,
      xmpp: this.buildE2EEPrimitives(),
      account: { jid: bareJid },
      logger: e2eeLogger,
    })
    // Route plugin-reported security upgrades (e.g. a late-arriving
    // sender key flipping a previously-untrusted message to trusted)
    // onto the SDK event surface so store bindings can patch messages
    // in place. Stays alive for the lifetime of this manager; a shutdown
    // in tearDownE2EEManager releases the manager and with it the listener.
    this.e2ee.onSecurityContextUpdated(({ peer, messageId, securityContext, body }) => {
      e2eeLogger.info(`trust updated for ${getDomain(peer)} msg ${messageId}: ${securityContext.trust}`)
      this.emitSDK('message:security-updated', {
        conversationId: peer,
        messageId,
        securityContext,
        ...(body !== undefined && { body }),
      })
    })
    // When a plugin registers, emit a SDK event so backgroundSync (and other
    // listeners) can trigger deferred decryption of messages that arrived
    // before the plugin was available.
    this.e2ee.onPluginRegistered((pluginId) => {
      this.emitSDK('e2ee:plugin-registered', { pluginId })
    })
    // When a peer's key material changes (PEP notification), re-attempt
    // deferred decrypts: messages that were decrypted successfully but
    // with untrusted trust (peer key not cached at decrypt time) can now
    // have their signature verified and trust upgraded to tofu/verified.
    // Also upgrade old persisted messages that lack encryptedPayload.
    this.e2ee.onPeerKeysChanged((peer) => {
      void this.retryPendingDecryptsForPeer(peer)
    })
    // When a plugin reports the local key just became usable (passphrase
    // entered, server backup restored, key file imported, identity replaced),
    // run the same retry as notifyE2EEKeyUnlocked. Driving this from the plugin
    // means every restore site is covered automatically — UI code no longer
    // has to remember to call notifyE2EEKeyUnlocked at each one.
    this.e2ee.onKeyUnlocked(() => {
      this.notifyE2EEKeyUnlocked()
    })
  }

  /**
   * Tear down the E2EEManager on disconnect. Existing plugin state on the
   * native side (e.g. Sequoia keys cached in Rust) is not affected — this
   * only releases the host-side object so a subsequent reconnect starts
   * from a clean slate.
   *
   * @internal
   */
  private async tearDownE2EEManager(): Promise<void> {
    const manager = this.e2ee
    if (!manager) return
    this.e2ee = null
    await manager.shutdown().catch(() => {})
  }

  /**
   * Build the XMPPPrimitives adapter that plugins use to publish/fetch via
   * PEP and probe peers via disco. Extracted from the construction site so
   * `ensureE2EEManager` stays readable.
   *
   * @internal
   */
  private buildE2EEPrimitives(): XMPPPrimitives {
    return {
      sendStanza: async (data) => {
        await this.sendStanza(dataToElement(data))
      },
      queryDisco: async (jid) => {
        return this.discovery.queryInfo(jid)
      },
      publishPEP: async (node, item, options) => {
        await this.pubsub.publish(node, item, options)
      },
      retractPEP: async (node, itemId) => {
        await this.pubsub.retract(node, itemId)
      },
      deletePEP: async (node) => {
        await this.pubsub.deleteNode(node)
      },
      queryPEP: async (jid, node, maxItems) => {
        return this.pubsub.query(jid, node, maxItems)
      },
      subscribePEP: (jid, node, cb) => {
        return this.pubsub.subscribe(jid, node, cb)
      },
    }
  }

  /**
   * Check if the current session generation is still active.
   * Returns true if a newer connection was established, meaning
   * the current async chain should abort.
   * @internal
   */
  private isSessionStale(generation: number): boolean {
    return this.sessionGeneration !== generation
  }

  /**
   * Guard: check if session generation is still current and log + return true if stale.
   * Centralizes the repeated pattern of checking + logging at async checkpoints.
   */
  private isSessionSuperseded(gen: number, checkpoint: string): boolean {
    if (this.sessionGeneration === gen) return false
    logInfo(`${checkpoint} (session superseded)`)
    return true
  }

  /**
   * SM Resumption path (XEP-0198).
   *
   * When SM resumes successfully, the server replays all undelivered stanzas.
   * No MAM queries, no roster fetch, no carbons enable needed.
   *
   * Send sequence:
   * 1) Send initial presence
   * 2) Send presence probes to refresh contact status
   */
  private async handleSmResumption(
    generation?: number,
    previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>,
    disconnectDurationMs?: number
  ): Promise<void> {
    const gen = generation ?? this.sessionGeneration

    // Check if local cache was cleared (e.g., Ctrl-Shift+R on Linux clears WebKit cache).
    // If the sentinel marker is missing, localStorage was wiped — upgrade to full sync
    // while keeping the SM connection alive.
    const jid = this.currentJid
    try {
      const cacheMarker = jid ? localStorage.getItem(`fluux:cache-marker:${jid}`) : null
      if (!cacheMarker) {
        logInfo('SM resumption: cache marker missing — local storage was cleared, upgrading to full sync')
        this.stores?.console.addEvent('Cache cleared during SM session — performing full sync', 'sm')
        this.isSmResumedSession = false
        await this.handleFreshSession(previouslyJoinedRooms, gen)
        // Emit 'online' so side effects (MAM sync, background sync) run their fresh session path.
        // Connection.ts already emitted 'resumed', but side effects need 'online' to trigger.
        if (!this.isSessionStale(gen)) {
          this.emit('online')
        }
        return
      }
    } catch { /* ignore storage errors (e.g., SSR environments) */ }

    const SM_SHORT_DISCONNECT_MS = 120_000
    const isShortDisconnect = disconnectDurationMs != null
      && disconnectDurationMs < SM_SHORT_DISCONNECT_MS

    // Refresh avatar blob URLs — WebKit can reclaim them across an OS sleep, which
    // surfaces as a long/unknown-duration resumption. Skip on short network blips:
    // the URLs are still live there, so refreshing would re-read every avatar from
    // IndexedDB and re-create its blob URL on every reconnection for no benefit.
    if (!isShortDisconnect) {
      bumpAvatarResumeCount() // diagnostic: count refresh-triggering resumes (memory probe)
      this.profile.refreshAllAvatarBlobUrls().catch(() => {})
    }

    await this.roster.sendInitialPresence()
    if (this.isSessionSuperseded(gen, 'SM resumption aborted after sendInitialPresence')) return

    this.stores?.console.addEvent('Sending presence probes to refresh contact status', 'sm')
    this.roster.sendPresenceProbes().catch(() => {})

    // SM resumption preserves MUC membership on the server side, so we do NOT
    // rejoin rooms or refresh presence here. The store's room list (whether
    // in-memory from the previous session or hydrated from storage on page
    // reload) is authoritative; any diff the server accumulated during the
    // disconnect — occupant leaves/joins, messages, presence changes — is
    // delivered via the SM replay queue and patched onto that state.
    //
    // Bookmarks are PEP items, not SM-queued stanzas, so they may have
    // changed on another client while disconnected. For long/unknown-duration
    // disconnects, refresh them and pick up any newly-autojoined rooms.
    if (isShortDisconnect) {
      const sec = Math.round(disconnectDurationMs / 1000)
      logInfo(`SM resumption: short disconnect (${sec}s) — skipping bookmark fetch`)
      this.stores?.console.addEvent(
        `SM resumption: short disconnect (${sec}s) — skipping bookmark fetch`,
        'sm'
      )
    } else {
      const sec = disconnectDurationMs != null ? Math.round(disconnectDurationMs / 1000) : 'unknown'
      logInfo(`SM resumption: disconnect ${sec}s — fetching bookmarks`)
      this.stores?.console.addEvent(
        `SM resumption: disconnect ${sec}s — fetching bookmarks`,
        'sm'
      )

      this.muc.fetchBookmarks(FRESH_SESSION_IQ_TIMEOUT_MS).then(({ roomsToAutojoin }) => {
        if (this.isSessionStale(gen)) return
        for (const room of roomsToAutojoin) {
          if (!this.stores?.room.getRoom(room.jid)?.joined) {
            this.muc.joinRoom(room.jid, room.nick, { password: room.password }).catch(() => {})
          }
        }
      }).catch(() => {})
    }
  }

  /**
   * Fresh session path (new session or SM resume failed).
   *
   * Full initialization with explicit send sequence:
   * 1) Fetch roster
   * 2) Enable carbons
   * 3) Send initial presence
   * 4) Fetch bookmarks
   * 5) Discover MUC service (async)
   * 6) Rejoin previously active rooms and autojoin bookmarked rooms
   * 7) Run server/upload/profile discovery (async)
   *
   * Background sync side effects trigger MAM queries once server info is available.
   */
  private async handleFreshSession(
    previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>,
    generation?: number
  ): Promise<void> {
    const gen = generation ?? this.sessionGeneration
    const iqTimeout = FRESH_SESSION_IQ_TIMEOUT_MS

    // Race the entire setup against a safety timeout to prevent hanging
    // after sleep/wake when the connection is unstable.
    const setupWork = this.runFreshSessionSetup(previouslyJoinedRooms, gen, iqTimeout)
    const setupStart = Date.now()
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), FRESH_SESSION_SETUP_TIMEOUT_MS)
    )

    const result = await Promise.race([setupWork.then(() => 'done' as const), timeoutPromise])
    if (result === 'timeout') {
      const elapsed = Date.now() - setupStart
      // If elapsed time far exceeds the requested delay, the system slept
      // through it.  Ignore this stale timeout — the wake handler will
      // trigger a fresh reconnect attempt.
      if (elapsed > FRESH_SESSION_SETUP_TIMEOUT_MS * 1.5) {
        logInfo(`Fresh session setup timeout fired stale (${Math.round(elapsed / 1000)}s elapsed) — ignoring`)
        return
      }
      logInfo(`Fresh session setup timed out after ${FRESH_SESSION_SETUP_TIMEOUT_MS / 1000}s`)
      this.stores?.console.addEvent(
        `Fresh session setup timed out after ${FRESH_SESSION_SETUP_TIMEOUT_MS / 1000}s — will retry on next reconnect`,
        'error'
      )
      throw new Error(`Fresh session setup timed out after ${FRESH_SESSION_SETUP_TIMEOUT_MS / 1000}s`)
    }
  }

  /**
   * Core fresh session setup logic, extracted so handleFreshSession can race it
   * against a safety timeout.
   */
  private async runFreshSessionSetup(
    previouslyJoinedRooms: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }> | undefined,
    gen: number,
    iqTimeout: number
  ): Promise<void> {
    // Reset MAM states so background sync will re-fetch message history
    this.stores?.chat.resetMAMStates()
    this.stores?.room.resetRoomMAMStates()

    // Reset presence and resources for fresh session
    this.stores?.roster.resetAllPresence()
    this.stores?.connection.clearOwnResources()

    // NOTE: markAllRoomsNotJoined() is intentionally deferred to just before
    // rejoinActiveRooms() below. Clearing it here would leave the room store in
    // a "nothing joined" state for the duration of roster/bookmark fetches — if
    // the session is aborted in that window (slow server, socket death), a
    // subsequent SM-resumed reconnect lands on corrupted state with no way to
    // recover. Keeping the flags until the actual rejoin preserves the live
    // view; joinRoom()'s skip-guard gets lifted atomically with the rejoin.

    // Fire-and-forget discovery calls — start immediately, independent of the serial
    // session setup chain. These must not be blocked by slow IQ responses (roster,
    // bookmarks, conversation sync) or the overall session setup timeout.
    this.discovery.fetchServerInfo().then(() => {
      const serverInfo = this.stores?.connection.getServerInfo?.()
      const hasWebPush = serverInfo?.features.includes(NS_P1_PUSH_WEBPUSH)
      const pushEnabled = this.stores?.connection.getWebPushEnabled?.() ?? true
      console.log('[WebPush] Server disco: p1:push:webpush feature =', hasWebPush,
        '| pushEnabled =', pushEnabled, '| All features:', serverInfo?.features)
      if (hasWebPush && pushEnabled) {
        this.webPush.queryServices().catch((err) => {
          console.warn('[WebPush] queryServices failed:', err)
        })
      }
    }).catch(() => {})
    this.discovery.discoverHttpUploadService().catch(() => {})
    this.profile.fetchOwnProfile().catch(() => {})

    // Fetch roster before sending presence
    await this.roster.fetchRoster(iqTimeout)
    if (this.isSessionSuperseded(gen, 'Fresh session aborted after fetchRoster')) return
    this.enableCarbons()
    logInfo('Fresh session: roster fetched, enabling carbons')

    // Send initial presence
    await this.roster.sendInitialPresence()
    if (this.isSessionSuperseded(gen, 'Fresh session aborted after sendInitialPresence')) return

    // Bookmarks and room joins
    const { roomsToAutojoin } = await this.muc.fetchBookmarks(iqTimeout)
    if (this.isSessionSuperseded(gen, 'Fresh session aborted after fetchBookmarks')) return

    // Fetch and merge server-side conversation list (XEP-0223)
    try {
      const serverConversations = await this.conversationSync.fetchConversations(iqTimeout)
      if (this.isSessionSuperseded(gen, 'Fresh session aborted after fetchConversations')) return
      if (serverConversations.length > 0) {
        this.mergeServerConversations(serverConversations)
      }
    } catch {
      // Best-effort: conversation list sync is not critical
    }

    // Discover MUC service and check service-level MAM support BEFORE joining rooms
    // This allows queryRoomFeatures() to fall back to service-level MAM detection
    // when room-level disco fails (e.g., XSF rooms that don't respond to disco)
    this.muc.discoverMucService().catch(() => {})

    // Restore cached room avatars for bookmarked rooms
    this.profile.restoreAllRoomAvatarHashes().catch(() => {})

    // Rejoin rooms BEFORE server info fetch - server info can block on slow/unresponsive servers
    // Two scenarios: reconnect (previouslyJoinedRooms provided) vs fresh connect
    //
    // On reconnect: rejoin non-autojoin rooms that were active, PLUS autojoin bookmarks
    // On fresh connect: just join autojoin bookmarks
    //
    // Filter previouslyJoinedRooms to exclude any rooms that are in roomsToAutojoin
    // (the autojoin state might have changed on another client since we captured it)
    const autojoinJids = new Set(roomsToAutojoin.map(r => r.jid))

    // Rejoin non-autojoin rooms that were previously joined (reconnect only)
    const rejoinCount = previouslyJoinedRooms?.filter(r => !autojoinJids.has(r.jid)).length ?? 0
    if (roomsToAutojoin.length > 0 || rejoinCount > 0) {
      logInfo(`Fresh session: ${roomsToAutojoin.length} rooms to autojoin, ${rejoinCount} to rejoin`)
    }

    const hasRoomsToRejoin =
      (previouslyJoinedRooms && previouslyJoinedRooms.length > 0) ||
      roomsToAutojoin.length > 0

    if (hasRoomsToRejoin) {
      // Lift joinRoom()'s skip-guard just before actually rejoining. Doing this
      // here (vs at the top of runFreshSessionSetup) means the previous session's
      // room state stays visible through roster/bookmark fetches, so a socket
      // death in that window doesn't strand the store in "nothing joined".
      this.stores?.room.markAllRoomsNotJoined()
    }

    if (previouslyJoinedRooms && previouslyJoinedRooms.length > 0) {
      const nonAutojoinRooms = previouslyJoinedRooms.filter(r => !autojoinJids.has(r.jid))
      if (nonAutojoinRooms.length > 0) {
        await this.muc.rejoinActiveRooms(nonAutojoinRooms)
        if (this.isSessionSuperseded(gen, 'Fresh session aborted after rejoinActiveRooms')) return
      }
    }

    // Always join autojoin bookmarks (both fresh connect and reconnect)
    if (roomsToAutojoin.length > 0) {
      for (const room of roomsToAutojoin) {
        // Issue #37: don't silently autojoin a room that exposes the user's real JID
        // (non-anonymous, non-private) unless they've already acknowledged it. Inspect
        // via disco#info first; if it exposes the JID and isn't acknowledged, leave it
        // bookmarked-but-not-joined so the user joins it deliberately from the UI (where
        // the exposure warning is shown). Otherwise pass the features straight to
        // joinRoom() so it doesn't re-run disco.
        void (async () => {
          const features = await this.muc.queryRoomFeatures(room.jid).catch(() => null)
          if (this.isSessionSuperseded(gen, 'Fresh session aborted before autojoin')) return
          const exposesRealJid = features ? (features.isNonAnonymous && !features.isPrivate) : false
          if (exposesRealJid && !this.stores?.room.isNonAnonymousRoomAcknowledged(room.jid)) {
            logInfo(`Skipping autojoin of non-anonymous room ${room.jid} (real-JID exposure not acknowledged)`)
            return
          }
          this.muc.joinRoom(room.jid, room.nick, { password: room.password, knownFeatures: features }).catch((err) => {
            console.error(`[XMPPClient] Failed to autojoin room ${room.jid}:`, err)
          })
        })()
      }
    }

  }

  /**
   * Merge server-side conversation list into the local chatStore.
   *
   * - Server conversations not in local store → create locally
   * - Shared conversations → apply server's archived status
   * - Local-only conversations → keep as-is (synced back via debounced publish)
   */
  private mergeServerConversations(serverConvs: SyncedConversation[]): void {
    const chat = this.stores?.chat
    const roster = this.stores?.roster
    if (!chat) return

    // Build batch: resolve names upfront, then apply all in a single store update
    const batch = serverConvs.map((serverConv) => {
      const contact = roster?.getContact(serverConv.jid)
      const name = contact?.name || getLocalPart(serverConv.jid)
      return {
        id: serverConv.jid,
        name,
        type: 'chat' as const,
        archived: serverConv.archived,
      }
    })

    if (chat.mergeServerConversations) {
      chat.mergeServerConversations(batch)
    } else {
      // Fallback: add individually (for custom store implementations)
      for (const entry of batch) {
        if (chat.hasConversation(entry.id)) {
          if (entry.archived) {
            chat.archiveConversation?.(entry.id)
          } else {
            chat.unarchiveConversation?.(entry.id)
          }
        } else {
          chat.addConversation({ id: entry.id, name: entry.name, type: entry.type, unreadCount: 0 })
          if (entry.archived) {
            chat.archiveConversation?.(entry.id)
          }
        }
      }
    }
    logInfo(`Conversation sync: merged ${serverConvs.length} conversations from server`)
  }

  private enableCarbons(): void {
    const xmpp = this.getXmpp()
    if (!xmpp) return

    const enableCarbons = xml(
      'iq',
      { type: 'set', id: `carbons_${generateUUID()}` },
      xml('enable', { xmlns: NS_CARBONS })
    )

    this.sendStanza(enableCarbons)
    this.stores?.console.addEvent('Message Carbons enabled', 'connection')
  }

  protected async sendStanza(stanza: Element): Promise<void> {
    const xmpp = this.getXmpp()
    if (!xmpp) {
      // Defensive check: if client is null but status says 'online', fix the inconsistency
      // This can happen in rare race conditions (e.g., socket died but status not yet updated)
      const currentStatus = this.stores?.connection.getStatus?.()
      if (currentStatus === 'online') {
        this.stores?.console.addEvent('Client null but status online - triggering reconnect', 'error')
        this.connection.handleDeadSocket()
      }
      throw new Error('Not connected')
    }

    // Additional socket health check: verify the underlying socket exists
    // This catches the race condition where xmpp client exists but socket is dead
    const socket = (xmpp as any).socket
    if (!socket) {
      const currentStatus = this.stores?.connection.getStatus?.()
      if (currentStatus === 'online') {
        this.stores?.console.addEvent('Socket null but status online - triggering reconnect', 'error')
        this.connection.handleDeadSocket()
      }
      throw new Error('Socket not available')
    }

    try {
      await xmpp.send(stanza)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (isDeadSocketError(errorMessage)) {
        this.connection.handleDeadSocket()
      }
      throw err
    }
  }

  protected async sendIQ(iq: Element, timeoutMs?: number): Promise<Element> {
    const xmpp = this.getXmpp()
    if (!xmpp) {
      const currentStatus = this.stores?.connection.getStatus?.()
      if (currentStatus === 'online') {
        this.stores?.console.addEvent('Client null but status online (IQ) - triggering reconnect', 'error')
        this.connection.handleDeadSocket()
      }
      throw new Error('Not connected')
    }

    const socket = (xmpp as any).socket
    if (!socket) {
      const currentStatus = this.stores?.connection.getStatus?.()
      if (currentStatus === 'online') {
        this.stores?.console.addEvent('Socket null but status online (IQ) - triggering reconnect', 'error')
        this.connection.handleDeadSocket()
      }
      throw new Error('Socket not available')
    }

    try {
      const request = (xmpp as any).iqCaller.request(iq)
      if (timeoutMs != null) {
        return await Promise.race([
          request,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`IQ timeout after ${timeoutMs}ms`)), timeoutMs)
          ),
        ])
      }
      return await request
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (isDeadSocketError(errorMessage)) {
        this.connection.handleDeadSocket()
      }
      throw err
    }
  }

}
