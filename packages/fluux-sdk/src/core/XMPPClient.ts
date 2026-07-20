import { Client, Element } from '@xmpp/client'
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
  PresenceOptions,
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
import { ensureCryptoRandomUUID } from './polyfill'
import { createStoreBindings } from '../bindings/storeBindings'
import { setupStoreSideEffects } from './sideEffects'
import { defaultStores, type SDKStores } from '../stores'
import { detectPlatform } from './platform'
import { isDeadSocketError } from './modules/connectionUtils'
import { getBareJid, getDomain } from './jid'
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
import { ConversationSync } from './modules/ConversationSync'
import { Mds } from './modules/Mds'
import { WebPush } from './modules/WebPush'
import { EntityTime } from './modules/EntityTime'
import { LastActivity } from './modules/LastActivity'
import { MAM } from './modules/MAM'
import { Poll } from './modules/Poll'
import { E2EEManager, InMemoryStorageBackend, type StorageBackend, type XMPPPrimitives } from './e2ee'
import { DeferredDecryptEngine } from './e2ee/deferredDecrypt'
import { SessionLifecycleEngine } from './sessionLifecycle'
import { dataToElement } from './e2ee/stanzaAdapter'
import { NS_MAM } from './namespaces'
import { createDefaultStoreBindings } from './defaultStoreBindings'
import { createPresenceReader, type PresenceReader } from './presenceReader'
import { initSearchIndex, backfillFromMessageCache } from '../utils/searchIndex'
import { getMessagesWithEncryptedPayload, updateMessage as cacheUpdateMessage, deleteMessage as cacheDeleteMessage } from '../utils/messageCache'

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

export class XMPPClient {
  protected currentJid: string | null = null
  private storageAdapter?: StorageAdapter
  private shouldAutoReconnect?: () => boolean
  private e2eeStorageBackend: StorageBackend = new InMemoryStorageBackend()
  private proxyAdapter?: ProxyAdapter
  private privacyOptions?: PrivacyOptions
  private stateSnapshot?: StateSnapshot
  /**
   * The store bundle backing this client (default bindings, event→store
   * wiring, account switching). Defaults to the process-wide singletons; an
   * injected bundle is the store-injection seam (see `stores/sdkStores.ts`).
   * @internal
   */
  private readonly sdkStores: SDKStores

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
   * constructed on successful connection (via `ensureE2EEManager`, driven by
   * the session-lifecycle engine) when the JID becomes known. Torn down on
   * explicit disconnect.
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
   * Narrow read surface over the presence machine, injected into every module
   * via `moduleDeps.presence`. Built once in the constructor from the presence
   * getters (machine snapshot + any custom `presenceOptions`), so it survives
   * re-init via {@link bindStores}.
   * @internal
   */
  private presenceReader!: PresenceReader

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
   * E2EE deferred-decrypt engine. Repairs messages stored with an
   * `encryptedPayload` once the blocking condition clears (plugin registered,
   * key unlocked, peer key arrived). Constructed in {@link initializeModules}
   * with getters onto the live manager / stores / identity.
   * @internal
   */
  private deferredDecrypt!: DeferredDecryptEngine

  /**
   * Post-connection orchestration engine — routes to the SM-resume/fresh-session
   * path, owns the session-generation staleness guard, and merges the server
   * conversation list. Constructed in {@link initializeModules} with the domain
   * modules it drives. Entry point is `handleConnectionSuccess` (wired onto the
   * Connection success handler); `isSmResumed()` and `mergeServerConversations`
   * are consulted from the module event wiring.
   * @internal
   */
  private sessionLifecycle!: SessionLifecycleEngine

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
    // Legacy webviews lack crypto.randomUUID, which @xmpp/client calls when
    // generating ids. Installed here (not as an import-time side effect) so
    // it survives tree-shaking and covers the /core entry point too.
    ensureCryptoRandomUUID()

    // Detect platform early for caps/client identification
    // This is async but we fire-and-forget; the result is cached for later use
    void detectPlatform()

    // Resolve the store bundle (injected or the process-wide singletons). Set
    // before initializeModules / setupBindings, which both read it.
    this.sdkStores = config.stores ?? defaultStores

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

    // Presence getters read from the machine (single source of truth), merged
    // with any custom integration the consumer provided. Modules consume these
    // through the injected PresenceReader (moduleDeps.presence), not the
    // connection store binding — presence is machine state, not store state.
    const presenceOptions: PresenceOptions = {
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
      // Merge any custom options provided by the user
      ...config.presenceOptions,
    }
    this.presenceReader = createPresenceReader(presenceOptions)

    // Initialize with default store bindings (using global Zustand stores)
    this.initializeModules(createDefaultStoreBindings(this.sdkStores))

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
      connection: this.sdkStores.connection.getState(),
      chat: this.sdkStores.chat.getState(),
      roster: this.sdkStores.roster.getState(),
      room: this.sdkStores.room.getState(),
      events: this.sdkStores.events.getState(),
      admin: this.sdkStores.admin.getState(),
      blocking: this.sdkStores.blocking.getState(),
      console: this.sdkStores.console.getState(),
      ignore: this.sdkStores.ignore.getState(),
    }))
    this.cleanupFunctions.push(unsubscribeStoreBindings)

    // Set up store-based side effects (activeConversation -> load cache, MAM fetch)
    const unsubscribeSideEffects = setupStoreSideEffects(this)
    this.cleanupFunctions.push(unsubscribeSideEffects)

    // (Re)start the snapshot subscriber. Kept here rather than in
    // initializeModules() (which runs once) so it is re-established after
    // destroy() tears it down — otherwise a React StrictMode remount would
    // leave SM-resumable persistence disabled for the client's lifetime.
    this.startStateSnapshot()
  }

  /**
   * (Re)create the snapshot subscriber that persists SM-resumable state
   * (rooms, roster, server info, own profile) as stores change. Hydration on
   * connect() reads it back before the socket starts, so SM replays land on
   * populated state.
   *
   * Idempotent: stops any existing subscriber first. No-op without a storage
   * adapter. Paired with the teardown in {@link destroy}.
   */
  private startStateSnapshot(): void {
    if (!this.storageAdapter) return
    this.stateSnapshot?.stop()
    this.stateSnapshot = new StateSnapshot({
      storageAdapter: this.storageAdapter,
      getJid: () => this.currentJid ? getBareJid(this.currentJid) : null,
    })
    this.stateSnapshot.start()
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

    // Deferred-decrypt engine reads/writes through getters so it always sees
    // the current manager, stores, and identity — never a captured snapshot.
    this.deferredDecrypt = new DeferredDecryptEngine({
      getManager: () => this.e2ee,
      getStores: () => this.stores,
      getOwnBareJid: () => (this.currentJid ? getBareJid(this.currentJid) : ''),
      cache: {
        getMessagesWithEncryptedPayload,
        updateMessage: cacheUpdateMessage,
        deleteMessage: cacheDeleteMessage,
      },
    })

    // E2EEManager is NOT constructed here — it's tied to a logged-in
    // identity. See `ensureE2EEManager` (called from handleConnectionSuccess)
    // and `tearDownE2EEManager` (called on disconnect). Modules access it
    // via `moduleDeps.getE2EEManager()`, which returns `null` before login.

    const moduleDeps = {
      stores: this.stores,
      presence: this.presenceReader,
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

    // Post-connection orchestration. Drives the domain modules just built; the
    // churny bits (stores, JID, transport) are read through getters so a
    // re-init or reconnect always sees the live value.
    this.sessionLifecycle = new SessionLifecycleEngine({
      discovery: this.discovery,
      admin: this.admin,
      roster: this.roster,
      muc: this.muc,
      profile: this.profile,
      webPush: this.webPush,
      conversationSync: this.conversationSync,
      getStores: () => this.stores,
      getCurrentJid: () => this.currentJid,
      getXmpp: () => this.getXmpp(),
      ensureE2EEManager: () => this.ensureE2EEManager(),
      sendStanza: (stanza) => this.sendStanza(stanza),
      emitOnline: () => this.emit('online'),
      connectPresence: () => this.presenceActor.send({ type: 'CONNECT' }),
    })

    // Set up post-connection handler
    this.connection.setConnectionSuccessHandler(async (isResumption, previouslyJoinedRooms, disconnectDurationMs) => {
      await this.sessionLifecycle.handleConnectionSuccess(isResumption, previouslyJoinedRooms, disconnectDurationMs)
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
        if (room?.supportsMAM && !room.isQuickChat && !this.sessionLifecycle.isSmResumed()) {
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

      // Live conversation-list sync: another of our own devices archived/
      // unarchived (or added) a 1:1 conversation and the server pushed the
      // updated PEP list. Reconcile it into the local store immediately,
      // reusing the same merge path as the fresh-session fetch.
      this.subscribe('conversation:list-synced', ({ conversations }) => {
        this.sessionLifecycle.mergeServerConversations(conversations)
      })
    }

    // The snapshot subscriber is (re)created in setupBindings() — not here —
    // so it survives the destroy()/setupBindings() pair React StrictMode runs
    // on remount. See startStateSnapshot().

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
      this.sdkStores.chat.getState().switchAccount(scopedJid)
      this.sdkStores.room.getState().switchAccount(scopedJid)
      this.sdkStores.ignore.getState().rehydrate()
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
   * const hook = new MyCustomHook(client)
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
    const xmpp = this.requireTransport()
    try {
      await xmpp.write(xmlString)
    } catch (err) {
      this.repairAndRethrowSendError(err)
    }
  }

  /**
   * Fetch the live transport for an outbound write, or throw.
   *
   * Repairs the "status says online but the client/socket is gone" race by
   * triggering a reconnect before throwing. `label` distinguishes the console
   * diagnostics (e.g. 'IQ'); `checkSocket` additionally verifies the
   * underlying socket exists (the client object can outlive a dead socket).
   */
  private requireTransport(label = '', options: { checkSocket?: boolean } = {}): Client {
    const suffix = label ? ` (${label})` : ''
    const xmpp = this.getXmpp()
    if (!xmpp) {
      this.reconnectIfStatusOnline(`Client null but status online${suffix} - triggering reconnect`)
      throw new Error('Not connected')
    }
    if (options.checkSocket && !xmpp.socket) {
      this.reconnectIfStatusOnline(`Socket null but status online${suffix} - triggering reconnect`)
      throw new Error('Socket not available')
    }
    return xmpp
  }

  /** Trigger a dead-socket reconnect when the store still believes we are online. */
  private reconnectIfStatusOnline(message: string): void {
    const currentStatus = this.stores?.connection.getStatus?.()
    if (currentStatus === 'online') {
      this.stores?.console.addEvent(message, 'error')
      this.connection.handleDeadSocket()
    }
  }

  /** Classify an outbound-write failure, kick off a reconnect on a dead socket, and rethrow. */
  private repairAndRethrowSendError(err: unknown): never {
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (isDeadSocketError(errorMessage)) {
      this.connection.handleDeadSocket()
    }
    throw err
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
   * Re-decrypt all stored messages that carry an `encryptedPayload` because
   * decryption failed at receive time (no plugin registered, key locked, etc.).
   * Delegates to the {@link DeferredDecryptEngine}; kept on the client because
   * backgroundSync triggers it via `client.retryPendingDecrypts()`.
   *
   * @returns the number of messages successfully decrypted
   */
  async retryPendingDecrypts(): Promise<number> {
    return this.deferredDecrypt.retryPending()
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
      void this.deferredDecrypt.retryForPeer(peer)
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

  protected async sendStanza(stanza: Element): Promise<void> {
    const xmpp = this.requireTransport('', { checkSocket: true })
    try {
      await xmpp.send(stanza)
    } catch (err) {
      this.repairAndRethrowSendError(err)
    }
  }

  protected async sendIQ(iq: Element, timeoutMs?: number): Promise<Element> {
    const xmpp = this.requireTransport('IQ', { checkSocket: true })
    try {
      const request = xmpp.iqCaller.request(iq)
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
      this.repairAndRethrowSendError(err)
    }
  }

}
