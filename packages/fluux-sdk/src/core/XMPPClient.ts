import { xml, Client, Element } from '@xmpp/client'
import { createActor, type Subscription, type Snapshot } from 'xstate'
import type {
  ConnectOptions,
  StoreBindings,
  XMPPClientEvents,
  XMPPClientConfig,
  SDKEvents,
  SDKEventHandler,
  StorageAdapter,
  PrivacyOptions,
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
} from '../stores'
import { detectPlatform } from './platform'

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
import { Chat } from './modules/Chat'
import { Roster } from './modules/Roster'
import { MUC } from './modules/MUC'
import { Admin } from './modules/Admin'
import { Profile } from './modules/Profile'
import { Discovery } from './modules/Discovery'
import { Connection } from './modules/Connection'
import { PubSub } from './modules/PubSub'
import { Blocking } from './modules/Blocking'
import { MAM } from './modules/MAM'
import { NS_CARBONS, NS_MAM } from './namespaces'
import { createDefaultStoreBindings, type DefaultStoreBindingsOptions } from './defaultStoreBindings'

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
  private currentJid: string | null = null
  private storageAdapter?: StorageAdapter
  private privacyOptions?: PrivacyOptions

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

    // Subscribe to persist state changes to sessionStorage
    this.presenceActor.subscribe(() => {
      savePresenceSnapshot(this.presenceActor)
    })

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

    // Set up presence sync (machine state -> XMPP presence)
    // The subscription is permanent for the lifetime of the client.
    // We don't store the unsubscribe function because in React StrictMode,
    // destroy() is called between mount cycles but the client persists.
    this.setupPresenceSync(this.presenceActor)

    // Set up SDK event -> Zustand store bindings
    // This wires SDK events (e.g., 'chat:message') to store updates (e.g., chatStore.addMessage)
    // Note: We don't store the unsubscribe function because:
    // 1. Bindings are permanent for the lifetime of the client
    // 2. In React StrictMode, destroy() is called between mount cycles but the client persists
    // 3. Bindings are garbage collected when the client is
    createStoreBindings(this, () => ({
      connection: connectionStore.getState(),
      chat: chatStore.getState(),
      roster: rosterStore.getState(),
      room: roomStore.getState(),
      events: eventsStore.getState(),
      admin: adminStore.getState(),
      blocking: blockingStore.getState(),
      console: consoleStore.getState(),
    }))

    // Set up store-based side effects (activeConversation -> load cache, MAM fetch)
    // Note: Like store bindings, we don't store the unsubscribe function because:
    // 1. Side effects are permanent for the lifetime of the client
    // 2. In React StrictMode, destroy() is called between mount cycles but the client persists
    // 3. Subscriptions are garbage collected when the client is
    setupStoreSideEffects(this)
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

    const moduleDeps = {
      stores: this.stores,
      sendStanza: (stanza: Element) => this.sendStanza(stanza),
      sendIQ: (iq: Element) => (this.getXmpp() as any)?.iqCaller?.request(iq),
      getCurrentJid: () => this.currentJid,
      emit: <K extends keyof XMPPClientEvents>(event: K, ...args: Parameters<XMPPClientEvents[K]>) => this.emit(event, ...args),
      emitSDK: <K extends keyof SDKEvents>(event: K, payload: SDKEvents[K]) => this.emitSDK(event, payload),
      getXmpp: () => this.getXmpp(),
      storageAdapter: this.storageAdapter,
      registerMAMCollector: (queryId: string, collector: (stanza: Element) => void) => this.registerMAMCollector(queryId, collector),
      privacyOptions: this.privacyOptions,
    }

    this.connection = new Connection(moduleDeps)
    this.pubsub = new PubSub(moduleDeps)
    this.mam = new MAM(moduleDeps)
    this.chat = new Chat(moduleDeps, this.mam)
    this.roster = new Roster(moduleDeps)
    this.muc = new MUC(moduleDeps)
    this.admin = new Admin(moduleDeps)
    this.profile = new Profile(moduleDeps)
    this.discovery = new Discovery(moduleDeps)
    this.blocking = new Blocking(moduleDeps)

    // Set up post-connection handler
    this.connection.setConnectionSuccessHandler(async (isResumption, previouslyJoinedRooms) => {
      await this.handleConnectionSuccess(isResumption, previouslyJoinedRooms)
    })

    // Set up disconnect handler to transition presence machine
    this.connection.setDisconnectHandler(() => {
      this.presenceActor.send({ type: 'DISCONNECT' })
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
      const modules = [this.pubsub, this.blocking, this.chat, this.roster, this.muc, this.profile, this.discovery]
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
        // Fetch sidebar preview immediately for MAM-enabled rooms
        // For non-MAM rooms, history is requested via <history maxstanzas="50"/> on join
        if (room?.supportsMAM && !room.isQuickChat) {
          this.mam.fetchPreviewForRoom(roomJid).catch(() => {})
        }
      })

      // Listen for room avatar updates from presence
      this.on('roomAvatarUpdate', (roomJid, photoHash) => {
        this.profile.fetchRoomAvatar(roomJid, photoHash).catch(() => {})
      })

      // Listen for avatar metadata updates (XEP-0084)
      // Emitted by PubSub module for real events or Roster for vcard-temp:x:update
      this.on('avatarMetadataUpdate', (jid, hash) => {
        if (hash) {
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
    this.currentJid = options.jid
    this.stores?.connection.setJid(options.jid)
    return this.connection.connect(options)
  }

  /**
   * Disconnect from the XMPP server.
   *
   * @returns Promise that resolves when disconnected
   *
   * @example
   * ```typescript
   * await client.disconnect()
   * ```
   */
  async disconnect(): Promise<void> {
    this.currentJid = null
    // Clear session-scoped tracking data
    this.xep0084AvatarChecked.clear()
    return this.connection.disconnect()
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
   * Immediately trigger a reconnection attempt.
   *
   * @remarks
   * Useful when you want to reconnect without waiting for the
   * automatic reconnection timer.
   */
  triggerReconnect(): void {
    this.connection.triggerReconnect()
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
   *   client.triggerReconnect()
   * }
   * ```
   */
  async verifyConnection(): Promise<boolean> {
    return this.connection.verifyConnection()
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
    // NOTE: We intentionally do NOT clean up store bindings, presence sync,
    // or the presence actor here.
    //
    // All of these are created once in the constructor and persist for the
    // lifetime of the client. In React StrictMode, useEffect cleanup runs
    // between mount cycles, but the client ref persists. If we cleaned up
    // these resources here, they couldn't be recreated without making a new
    // client, which would break presence state.
    //
    // Specifically:
    // - Store bindings wire SDK events to Zustand stores
    // - Presence sync subscription sends XMPP presence on machine state changes
    // - Presence actor manages presence state machine
    //
    // All resources will be garbage collected when the client itself is.
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

      // Send XMPP presence to server (including MUC rooms)
      // currentShow is already in XMPP format (undefined = online, 'away', 'dnd', 'xa')
      this.roster.setPresence(currentShow || 'online', currentStatus ?? undefined)
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
  getStreamManagementState(): { id: string; inbound: number } | null {
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
      if (this.isDeadSocketError(errorMessage)) {
        this.connection.handleDeadSocket()
      }
      throw err
    }
  }

  // ============================================================================
  // Internal Methods
  // ============================================================================

  private getXmpp(): Client | null {
    return this.connection.getClient()
  }

  /**
   * Handle successful connection (both initial connect and reconnect).
   */
  private async handleConnectionSuccess(
    isResumption: boolean,
    previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>
  ): Promise<void> {
    // Transition presence machine to connected state
    // This is done early so the machine is in the correct state before sending presence
    this.presenceActor.send({ type: 'CONNECT' })

    // Always reset MAM states on any reconnection (including SM resumption)
    // This ensures we can fetch messages that arrived while we were disconnected.
    // SM guarantees delivery of in-flight messages, but MAM may have accumulated
    // new messages (especially in MUC rooms) while we were offline.
    this.stores?.chat.resetMAMStates()
    this.stores?.room.resetRoomMAMStates()

    if (!isResumption) {
      // Reset state for fresh session
      this.stores?.roster.resetAllPresence()
      this.stores?.connection.clearOwnResources()

      // Fetch roster before sending presence
      await this.roster.fetchRoster()
      this.enableCarbons()
    }

    // Send initial presence
    await this.roster.sendInitialPresence()

    // For SM resumption, probe offline contacts
    if (isResumption) {
      this.stores?.console.addEvent('Sending presence probes to refresh contact status', 'sm')
      this.roster.sendPresenceProbes().catch(() => {})
    }

    // Continue setup for new sessions
    if (!isResumption) {
      const { roomsToAutojoin } = await this.muc.fetchBookmarks()

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
      if (previouslyJoinedRooms && previouslyJoinedRooms.length > 0) {
        const nonAutojoinRooms = previouslyJoinedRooms.filter(r => !autojoinJids.has(r.jid))
        if (nonAutojoinRooms.length > 0) {
          await this.muc.rejoinActiveRooms(nonAutojoinRooms)
        }
      }

      // Always join autojoin bookmarks (both fresh connect and reconnect)
      if (roomsToAutojoin.length > 0) {
        for (const room of roomsToAutojoin) {
          this.muc.joinRoom(room.jid, room.nick, { password: room.password }).catch((err) => {
            console.error(`[XMPPClient] Failed to autojoin room ${room.jid}:`, err)
          })
        }
      }

      // Server discovery is less critical - can block on slow servers, so do it after rooms are joined
      await this.discovery.fetchServerInfo()
      this.discovery.discoverHttpUploadService().catch(() => {})
      this.profile.fetchOwnProfile().catch(() => {})
    }

    // Always re-discover admin commands
    this.admin.discoverAdminCommands().catch(() => {})

    // MAM is now lazy - triggered by side effects when opening conversations/rooms
    // This avoids large MAM queries for ALL conversations on connect

    // Refresh sidebar previews in the background
    // After being offline, lastMessage previews may be stale (messages exchanged on other devices)
    // This fetches max=1 message per conversation/room to update the sidebar without loading full history
    this.mam.refreshConversationPreviews().catch(() => {})

    // Refresh room previews after a short delay to allow auto-joined rooms to complete joining
    // Room joins are asynchronous (server must send self-presence), so we wait a bit
    setTimeout(() => {
      this.mam.refreshRoomPreviews().catch(() => {})
    }, 2000)
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

  private async sendStanza(stanza: Element): Promise<void> {
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
      if (this.isDeadSocketError(errorMessage)) {
        this.connection.handleDeadSocket()
      }
      throw err
    }
  }

  private isDeadSocketError(errorMessage: string): boolean {
    return (
      errorMessage.includes('socket.write') ||
      errorMessage.includes('null is not an object') ||
      errorMessage.includes('Cannot read properties of null') ||
      errorMessage.includes('socket is null') ||
      errorMessage.includes('WebSocket is not open')
    )
  }
}
