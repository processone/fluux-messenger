import { client, Client, Element, xml } from '@xmpp/client'
import { createActor } from 'xstate'
import { BaseModule, type ModuleDependencies } from './BaseModule'
import type { ConnectOptions, ConnectionMethod } from '../types'
import { getDomain, getLocalPart, getResource } from '../jid'
import { getClientIdentity, CLIENT_FEATURES } from '../caps'
import { NS_DISCO_INFO, NS_PING } from '../namespaces'
import { discoverWebSocket } from '../../utils/websocketDiscovery'
import { flushPendingRoomMessages } from '../../utils/messageCache'
import { logInfo, logWarn, logError as logErr } from '../logger'
import {
  type SmPatchState,
  createSmPatchState,
  patchSmAckDebounce,
  patchSmAckQueue,
  flushSmAckDebounce,
  clearSmAckDebounce,
} from './smPatches'
import {
  connectionMachine,
  getConnectionStatusFromState,
  getReconnectInfoFromContext,
  isTerminalState,
  type ConnectionActor,
  type ConnectionStateValue,
} from '../connectionMachine'

// Timeout for graceful client stop (stream close + socket close)
// When the socket is already dead, xmpp.js stop() can hang waiting for events
const CLIENT_STOP_TIMEOUT_MS = 2000

// Timeout for a single reconnection attempt (proxy restart + XMPP negotiation).
// If xmpp.js hangs during connection negotiation (e.g., the WebSocket connects
// but XMPP stream negotiation stalls), this ensures the attempt is abandoned
// and the next retry can begin.
const RECONNECT_ATTEMPT_TIMEOUT_MS = 30_000

// Timeout for proxy adapter restart during reconnection.
// After a WiFi switch, the proxy's TCP connection attempt may hang waiting for
// DNS resolution on the old network. This ensures we fail fast and fall through
// to the WebSocket fallback.
const PROXY_RESTART_TIMEOUT_MS = 10_000

/**
 * Race a promise against a timeout. Resolves with void if the timeout fires first.
 * Used to prevent hanging on xmpp.js stop() when the socket is already dead.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([
    promise,
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ])
}

// Dev-only error logging (checks Vite dev mode, excludes test mode)
const isDev = (() => {
  try {
    // @ts-expect-error - import.meta.env may not exist in all environments
    const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined
    return env?.DEV === true && env?.MODE !== 'test'
  } catch {
    return false
  }
})()

const logError = (...args: unknown[]) => {
  if (isDev) {
    console.error('[XMPP]', ...args)
  }
}

/**
 * Connection lifecycle and stream management module.
 *
 * Handles the XMPP connection lifecycle including:
 * - Connection establishment and disconnection
 * - XEP-0198: Stream Management (session resumption, message reliability)
 * - Automatic reconnection with exponential backoff (1s → 2s → 4s → ... → max 2 min)
 * - Dead socket detection and recovery (e.g., after system sleep)
 * - Connection event handling (online, offline, error, reconnecting)
 * - IQ handler registration (roster pushes, disco queries, pings)
 *
 * @remarks
 * The module implements custom reconnection logic instead of xmpp.js's built-in
 * reconnect to provide exponential backoff, user feedback (countdown), and
 * proper Stream Management state hydration for session resumption.
 *
 * Stream Management (XEP-0198) allows:
 * - Session resumption after brief disconnections (network switches, laptop sleep)
 * - Message reliability with acknowledgements
 * - 10-minute resumption window (server-configurable)
 *
 * @example
 * ```typescript
 * // Access via XMPPClient
 * await client.connect({ jid: 'user@example.com', password: 'secret', server: 'example.com' })
 * await client.disconnect()
 *
 * // Manual reconnection control
 * client.connection.cancelReconnect()
 * client.connection.triggerReconnect()
 *
 * // Check connection health after sleep
 * const isAlive = await client.verifyConnection()
 * ```
 *
 * @category Modules
 */
export class Connection extends BaseModule {
  private xmpp: Client | null = null
  private credentials: ConnectOptions | null = null
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null

  /**
   * XState connection state machine actor.
   * Replaces the error-prone boolean flags (isReconnecting, hasEverConnected,
   * isManualDisconnect, disconnectReason) with explicit, auditable state transitions.
   * See connectionMachine.ts for the state diagram and invariants.
   */
  private connectionActor: ConnectionActor

  // Original server string before proxy resolution (e.g. "process-one.net", "tls://host:5223")
  // Needed to restart the proxy on reconnect — credentials.server holds the resolved local WS URL
  private originalServer: string = ''

  // Resolved endpoint from proxy (e.g. "tls://chat.example.com:5223")
  // Used on reconnect to skip SRV resolution which may return different results after DNS cache flush
  private resolvedEndpoint: string | null = null

  // Track SM resume state to properly handle 'fail' events
  // Stanzas in queue BEFORE resume should report as lost
  // Stanzas sent AFTER resume are normal sends that failed for other reasons
  private smResumeCompleted = false

  // Cached SM state - survives socket death for reconnection
  // Updated when SM is enabled/resumed, cleared on manual disconnect
  private cachedSmState: { id: string; inbound: number } | null = null

  // SM patches state (ack debounce timer + original send reference)
  // See smPatches.ts for implementation details
  private smPatchState: SmPatchState = createSmPatchState()

  // Callback for post-connection setup (roster, presence, carbons, etc.)
  private onConnectionSuccess?: (isResumption: boolean, previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>) => Promise<void>

  // Callback for disconnect notification
  private onDisconnect?: () => void

  // Callback for stanza routing
  private onStanza?: (stanza: Element) => void

  // Convenience accessors
  protected get stores() { return this.deps.stores! }
  protected get emit() { return this.deps.emit }
  protected get storageAdapter() { return this.deps.storageAdapter }

  constructor(deps: ModuleDependencies) {
    super(deps)

    // Create and start the connection state machine actor
    this.connectionActor = createActor(connectionMachine).start()

    // Subscribe to machine state changes to sync with the connection store
    this.connectionActor.subscribe((snapshot) => {
      const stateValue = snapshot.value as ConnectionStateValue
      const status = getConnectionStatusFromState(stateValue)
      const { attempt, reconnectTargetTime } = getReconnectInfoFromContext(snapshot.context)

      // Sync status to store
      this.stores.connection.setStatus(status)
      this.stores.connection.setReconnectState(attempt, reconnectTargetTime)

      // Sync error to store
      if (snapshot.context.lastError) {
        this.stores.connection.setError(snapshot.context.lastError)
      }
    })
  }

  /**
   * Get the connection state machine actor.
   * Exposed for XMPPClient to wire up and for advanced usage.
   */
  getConnectionActor(): ConnectionActor {
    return this.connectionActor
  }

  /**
   * Handle incoming stanza (ConnectionModule doesn't handle stanzas directly).
   */
  handle(_stanza: Element): boolean {
    return false
  }

  // ============================================================================
  // Machine State Helpers
  // ============================================================================

  /** Check if the machine is in a reconnecting state (any substate). */
  private isInReconnectingState(): boolean {
    const snapshot = this.connectionActor.getSnapshot()
    const value = snapshot.value as ConnectionStateValue
    return typeof value === 'object' && 'reconnecting' in value
  }

  /** Check if the machine is in a connected state (any substate). */
  private isInConnectedState(): boolean {
    const snapshot = this.connectionActor.getSnapshot()
    const value = snapshot.value as ConnectionStateValue
    return typeof value === 'object' && 'connected' in value
  }

  /** Check if the machine is in a terminal state (any substate). */
  private isInTerminalState(): boolean {
    const snapshot = this.connectionActor.getSnapshot()
    return isTerminalState(snapshot.value as ConnectionStateValue)
  }

  /** Get the current machine state value. */
  private getMachineState(): ConnectionStateValue {
    return this.connectionActor.getSnapshot().value as ConnectionStateValue
  }

  // ============================================================================
  // Session State Persistence (via StorageAdapter)
  // ============================================================================

  /**
   * Persist SM state to storage for session resumption across page reloads.
   * Called whenever cachedSmState is updated.
   * @internal
   */
  private async persistSmState(): Promise<void> {
    if (!this.storageAdapter || !this.cachedSmState || !this.credentials?.jid) {
      return
    }
    try {
      // Include joined rooms for fallback rejoin if SM resumption fails
      const joinedRooms = (this.stores.room.joinedRooms() ?? []).map(room => ({
        jid: room.jid,
        nickname: room.nickname,
        password: room.password,
        autojoin: room.autojoin,
      }))

      await this.storageAdapter.setSessionState(this.credentials.jid, {
        smId: this.cachedSmState.id,
        smInbound: this.cachedSmState.inbound,
        resource: this.credentials.resource || '',
        timestamp: Date.now(),
        joinedRooms,
      })
    } catch {
      // Storage errors are non-fatal - silently ignore
    }
  }

  /**
   * Load SM state from storage.
   * @internal
   */
  private async loadSmStateFromStorage(jid: string): Promise<{
    smState: { id: string; inbound: number } | null
    joinedRooms: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>
  }> {
    if (!this.storageAdapter) {
      return { smState: null, joinedRooms: [] }
    }
    try {
      const state = await this.storageAdapter.getSessionState(jid)
      if (state) {
        // Check if state is stale (> 10 minutes old - typical SM timeout)
        const SM_TIMEOUT = 10 * 60 * 1000 // 10 minutes
        if (Date.now() - state.timestamp > SM_TIMEOUT) {
          await this.storageAdapter.clearSessionState(jid)
          // SM state is stale, but joined rooms are still useful for rejoin
          return { smState: null, joinedRooms: state.joinedRooms ?? [] }
        }
        return {
          smState: {
            id: state.smId,
            inbound: state.smInbound,
          },
          joinedRooms: state.joinedRooms ?? [],
        }
      }
    } catch {
      // Storage errors are non-fatal
    }
    return { smState: null, joinedRooms: [] }
  }

  /**
   * Clear SM state from storage.
   * Called on manual disconnect.
   * @internal
   */
  private async clearSmStateFromStorage(): Promise<void> {
    if (!this.storageAdapter || !this.credentials?.jid) {
      return
    }
    try {
      await this.storageAdapter.clearSessionState(this.credentials.jid)
    } catch {
      // Storage errors are non-fatal
    }
  }

  /**
   * Persist current SM state to storage synchronously.
   * Call this before page unload to capture the latest inbound counter.
   *
   * @remarks
   * The SM inbound counter is updated on each received stanza. To ensure
   * session resumption works correctly after page reload, call this method
   * in a beforeunload handler to capture the latest value.
   *
   * Also persists the list of currently joined rooms, so that if SM resumption
   * fails after page reload, those rooms can be rejoined.
   *
   * This is a public wrapper around the internal persistSmState method.
   * It uses synchronous storage (sessionStorage.setItem) to ensure the
   * write completes before the page unloads.
   */
  persistSmStateNow(): void {
    if (!this.storageAdapter || !this.cachedSmState || !this.credentials?.jid) {
      return
    }

    // Get list of currently joined rooms for fallback rejoin if SM resumption fails
    // Filter out quickchat rooms - they're transient and won't exist after everyone leaves
    const joinedRooms = (this.stores.room.joinedRooms() ?? [])
      .filter(room => !room.isQuickChat)
      .map(room => ({
        jid: room.jid,
        nickname: room.nickname,
        password: room.password,
        autojoin: room.autojoin,
      }))

    // Use synchronous storage write for beforeunload reliability
    // The async persistSmState() may not complete before unload
    const state = {
      smId: this.cachedSmState.id,
      smInbound: this.cachedSmState.inbound,
      resource: this.credentials.resource || '',
      timestamp: Date.now(),
      joinedRooms,
    }
    try {
      // Direct synchronous write for beforeunload
      sessionStorage.setItem(`fluux:session:${this.credentials.jid}`, JSON.stringify(state))
    } catch {
      // Storage errors are non-fatal
    }
  }

  /**
   * Set callback for post-connection success handling.
   * Called after connection succeeds (both initial connect and reconnect).
   */
  setConnectionSuccessHandler(handler: (isResumption: boolean, previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>) => Promise<void>): void {
    this.onConnectionSuccess = handler
  }

  /**
   * Set callback for disconnect notification.
   * Called when the connection is lost (manual disconnect, error, or unexpected).
   */
  setDisconnectHandler(handler: () => void): void {
    this.onDisconnect = handler
  }

  /**
   * Set callback for stanza routing.
   * Called for each incoming stanza to route to modules.
   */
  setStanzaHandler(handler: (stanza: Element) => void): void {
    this.onStanza = handler
  }

  /**
   * Get the current XMPP client instance (for modules that need direct access).
   */
  getClient(): Client | null {
    return this.xmpp
  }

  /**
   * Connect to XMPP server.
   *
   * The server parameter can be:
   * - A full WebSocket URL (wss://example.com:5443/ws) - used directly
   * - A domain name (example.com) - XEP-0156 discovery is attempted, falls back to wss://{domain}/ws
   */
  async connect({ jid, password, server, resource, smState, lang, previouslyJoinedRooms, skipDiscovery, disableSmKeepalive }: ConnectOptions): Promise<void> {
    // If the machine is not in idle state, reset it first.
    // This handles the case where connect() is called while already connected
    // (e.g., user clicks Connect again after a previous session).
    const currentState = this.getMachineState()
    if (currentState !== 'idle') {
      this.connectionActor.send({ type: 'DISCONNECT' })
    }
    // Signal the machine that a user-initiated connection is starting.
    // This resets any terminal/disconnected state back to idle, then transitions to connecting.
    this.connectionActor.send({ type: 'CONNECT' })

    // Emit SDK event for connection starting
    this.deps.emitSDK('connection:status', { status: 'connecting' })

    // Check connection mode
    const userProvidedWebSocketUrl = server.startsWith('ws://') || server.startsWith('wss://')
    // tls:// and tcp:// URIs are explicit server specs for the proxy (not WebSocket URLs)
    const isExplicitTcpUri = server.startsWith('tls://') || server.startsWith('tcp://')
    const hasProxy = !!this.deps.proxyAdapter
    const useProxy = hasProxy && !userProvidedWebSocketUrl

    // Debug logging
    this.stores.console.addEvent(
      `Connection setup: hasProxy=${hasProxy}, userProvidedWebSocketUrl=${userProvidedWebSocketUrl}, isExplicitTcpUri=${isExplicitTcpUri}, server="${server}"`,
      'connection'
    )

    // Resolve server URL:
    // - With proxy adapter: pass server string to proxy (handles URI parsing + SRV)
    // - Without proxy or explicit WebSocket URL: Perform WebSocket URL resolution
    // Note: tls:// and tcp:// URIs are treated as proxy targets, not WebSocket URLs
    let resolvedServer: string
    let connectionMethod: ConnectionMethod = 'websocket'
    if (useProxy) {
      // Proxy mode: pass server string as-is (proxy parses URI formats and does SRV)
      resolvedServer = server || getDomain(jid)
      this.stores.console.addEvent(`Proxy mode: using "${resolvedServer}" for proxy`, 'connection')
    } else if (isExplicitTcpUri) {
      // tls:// or tcp:// URI without proxy — not usable, fall back to domain
      this.stores.console.addEvent(`TCP URI "${server}" not usable without proxy, falling back to WebSocket discovery`, 'connection')
      resolvedServer = this.shouldSkipDiscovery('', skipDiscovery)
        ? this.getWebSocketUrl('', getDomain(jid))
        : await this.resolveWebSocketUrl('', getDomain(jid))
    } else {
      // WebSocket mode: resolve WebSocket URL via discovery
      resolvedServer = this.shouldSkipDiscovery(server, skipDiscovery)
        ? this.getWebSocketUrl(server, getDomain(jid))
        : await this.resolveWebSocketUrl(server, getDomain(jid))
    }

    // Start proxy if available
    if (useProxy) {
      this.stores.console.addEvent(`Starting proxy for: ${resolvedServer}`, 'connection')
      try {
        const proxyResult = await this.deps.proxyAdapter!.startProxy(resolvedServer)

        resolvedServer = proxyResult.url
        connectionMethod = proxyResult.connectionMethod
        this.resolvedEndpoint = proxyResult.resolvedEndpoint ?? null
        this.stores.console.addEvent(`Proxy started: ${server || getDomain(jid)} via ${proxyResult.url} (${connectionMethod})`, 'connection')
      } catch (err) {
        // If proxy fails to start, fall back to WebSocket connection
        const errorMsg = err instanceof Error ? err.message : String(err)
        this.stores.console.addEvent(`Failed to start proxy: ${errorMsg}, falling back to WebSocket`, 'error')
        connectionMethod = 'websocket'
        // Resolve proper WebSocket URL for fallback (resolvedServer is currently the raw domain)
        const domain = getDomain(jid)
        resolvedServer = this.shouldSkipDiscovery(server, skipDiscovery)
          ? this.getWebSocketUrl(server, domain)
          : await this.resolveWebSocketUrl(server, domain)
      }
    }

    // Store connection method for display
    this.stores.connection.setConnectionMethod(connectionMethod)

    // Store credentials for potential reconnection (with resolved URL)
    this.credentials = { jid, password, server: resolvedServer, resource, lang, disableSmKeepalive }
    this.originalServer = server || getDomain(jid)

    // Load SM state and joined rooms from storage if not provided (for session resumption across page reloads)
    // Note: Only await if storage adapter exists to avoid blocking tests using fake timers
    let effectiveSmState = smState
    let effectiveJoinedRooms = previouslyJoinedRooms
    if (this.storageAdapter) {
      const storedState = await this.loadSmStateFromStorage(jid)
      if (!effectiveSmState && storedState.smState) {
        effectiveSmState = storedState.smState
        this.stores.console.addEvent('Loaded SM state from storage for session resumption', 'sm')
      }
      // Load joined rooms from storage if not explicitly provided
      // These are used for fallback rejoin if SM resumption fails
      if (!effectiveJoinedRooms && storedState.joinedRooms.length > 0) {
        effectiveJoinedRooms = storedState.joinedRooms
        this.stores.console.addEvent(
          `Loaded ${storedState.joinedRooms.length} previously joined rooms from storage`,
          'connection'
        )
      }
    }

    this.xmpp = this.createXmppClient({ jid, password, server: resolvedServer, resource, lang })
    this.hydrateStreamManagement(effectiveSmState)
    this.setupHandlers()

    return new Promise((resolve, reject) => {
      this.setupConnectionHandlers(
        async (isResumption) => {
          // Signal machine: initial connection succeeded
          this.connectionActor.send({ type: 'CONNECTION_SUCCESS' })
          await this.handleConnectionSuccess(isResumption, `Connected as ${jid}`, effectiveJoinedRooms)
          resolve()
        },
        (err) => {
          logError('Connection error:', err.message)
          logErr(`Connection error: ${err.message}`)
          // Signal machine: initial connection failed → terminal.initialFailure
          this.connectionActor.send({ type: 'CONNECTION_ERROR', error: err.message })
          this.stores.console.addEvent(`Connection error: ${err.message}`, 'error')
          // Emit SDK event for connection error
          this.deps.emitSDK('connection:status', { status: 'error', error: err.message })
          this.emit('error', err)
          reject(err)
        }
      )
    })
  }

  /**
   * Disconnect from XMPP server.
   */
  async disconnect(): Promise<void> {
    // Signal machine: user-initiated disconnect
    this.connectionActor.send({ type: 'DISCONNECT' })
    this.clearTimers()

    // Clear cached SM state - manual disconnect means fresh session next time
    this.cachedSmState = null

    // Clear SM state from storage (do this before nulling credentials since we need the JID)
    await this.clearSmStateFromStorage()

    // Flush any pending room messages to IndexedDB before disconnecting
    // to ensure all messages received during this session are persisted
    await flushPendingRoomMessages()

    if (this.xmpp) {
      // Save reference to prevent race condition:
      // If connect() is called during stop(), it creates a new client.
      // We should only null out the client we're stopping, not the new one.
      const clientToStop = this.xmpp
      this.xmpp = null
      this.credentials = null
      this.originalServer = ''
      this.resolvedEndpoint = null
      // Set status and log BEFORE stop() to prevent race with session persistence
      this.stores.connection.setStatus('disconnected')
      this.stores.connection.setJid(null)
      this.stores.connection.setConnectionMethod(null)
      this.stores.console.addEvent('Disconnected', 'connection')
      // Emit SDK event for disconnect
      this.deps.emitSDK('connection:status', { status: 'offline' })
      // Flush any pending debounced SM ack before closing the stream
      flushSmAckDebounce(this.smPatchState, clientToStop)
      // Close the XMPP stream BEFORE stopping the proxy so the </stream:stream>
      // close can flow through the WebSocket-to-TLS bridge. If we stop the proxy
      // first, xmpp.js tries to write to a dead WebSocket and gets stuck.
      await withTimeout(clientToStop.stop(), CLIENT_STOP_TIMEOUT_MS)
    } else {
      this.stores.connection.setStatus('disconnected')
      this.stores.connection.setJid(null)
      this.stores.console.addEvent('Disconnected', 'connection')
      // Emit SDK event for disconnect
      this.deps.emitSDK('connection:status', { status: 'offline' })
    }

    // Stop the proxy AFTER the XMPP stream is closed (fire-and-forget).
    // The stream close already went through the proxy above, so this just
    // cleans up the listener. No need to await — avoid blocking on IPC.
    if (this.deps.proxyAdapter) {
      this.deps.proxyAdapter.stopProxy().catch(() => {})
      this.stores.console.addEvent('Stopped proxy', 'connection')
    }
  }

  /**
   * Cancel any pending reconnection attempts.
   */
  cancelReconnect(): void {
    this.clearTimers()
    // Signal machine: cancel reconnect → transitions to disconnected
    this.connectionActor.send({ type: 'CANCEL_RECONNECT' })
  }

  /**
   * Clear reconnection timer handles without changing machine state.
   * Used by disconnect(), cancelReconnect(), and triggerReconnect().
   */
  private clearTimers(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }

  /**
   * Immediately trigger a reconnection attempt.
   *
   * Use this when the app becomes visible while in a reconnecting state,
   * since background timers may have been suspended by the browser/OS.
   * This cancels any pending scheduled reconnection attempts immediately.
   */
  triggerReconnect(): void {
    if (!this.isInReconnectingState() || !this.credentials) return

    // Cancel the pending scheduled reconnect timers
    this.clearTimers()

    // Signal machine: skip waiting, go directly to attempting
    this.connectionActor.send({ type: 'TRIGGER_RECONNECT' })

    // Attempt immediately (fire-and-forget, errors handled internally)
    void this.attemptReconnect()
  }

  /**
   * Get Stream Management state for session resumption (XEP-0198).
   * Returns null if SM is not available or not enabled.
   *
   * Uses cached state as fallback when the live client is unavailable
   * (e.g., after socket death during sleep). The cache is updated
   * whenever SM is enabled or resumed.
   */
  getStreamManagementState(): { id: string; inbound: number } | null {
    // Try to get live state from the xmpp client
    if (this.xmpp?.streamManagement) {
      const sm = this.xmpp.streamManagement as any
      if (sm.id) {
        // Update cache with latest state
        this.cachedSmState = {
          id: sm.id,
          inbound: sm.inbound || 0,
        }
        return this.cachedSmState
      }
    }

    // Fall back to cached state (survives socket death)
    return this.cachedSmState
  }

  /**
   * Verify the connection is alive by sending a ping and waiting for response.
   * Call this after wake from sleep or long inactivity to check connection health.
   * Returns true if connection is healthy, false if dead/reconnecting.
   *
   * @param timeoutMs - Maximum time to wait for response (default: 10 seconds)
   */
  async verifyConnection(timeoutMs = 10000): Promise<boolean> {
    if (!this.xmpp) return false
    const verifyStart = Date.now()

    // Transition the machine to connected.verifying if currently healthy.
    // When called from notifySystemState, WAKE is already sent. When called
    // directly (e.g., client.verifyConnection()), we send WAKE here so the
    // machine state and store stay consistent.
    if (this.isInConnectedState()) {
      this.connectionActor.send({ type: 'WAKE' })
    }

    try {
      // Send a Stream Management request (<r/>) if available, otherwise a ping
      const sm = this.xmpp.streamManagement as any
      if (sm?.enabled) {
        // SM request - wait for <a/> acknowledgment with timeout
        const ackReceived = await this.waitForSmAck(timeoutMs)
        if (!ackReceived) {
          // Timeout waiting for ack - connection is dead
          this.stores.console.addEvent('Verification timed out waiting for SM ack', 'connection')
          this.connectionActor.send({ type: 'VERIFY_FAILED' })
          this.handleDeadSocket()
          return false
        }
      } else {
        // Fallback: send a ping IQ and wait for response
        const iqCaller = (this.xmpp as any).iqCaller
        if (iqCaller) {
          const ping = xml(
            'iq',
            { type: 'get', id: `ping_${Date.now()}`, to: getDomain(this.credentials?.jid || '') },
            xml('ping', { xmlns: NS_PING })
          )
          await Promise.race([
            iqCaller.request(ping),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Ping timeout')), timeoutMs)
            ),
          ])
        } else {
          // No iqCaller available - just send and hope for the best
          const ping = xml(
            'iq',
            { type: 'get', id: `ping_${Date.now()}` },
            xml('ping', { xmlns: NS_PING })
          )
          await this.xmpp.send(ping)
        }
      }

      // Connection verified — signal machine: verifying → healthy
      this.connectionActor.send({ type: 'VERIFY_SUCCESS' })
      logInfo(`Connection verified (${Date.now() - verifyStart}ms)`)
      return true
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (this.isDeadSocketError(errorMessage) || errorMessage.includes('timeout')) {
        this.connectionActor.send({ type: 'VERIFY_FAILED' })
        this.handleDeadSocket()
      }
      return false
    }
  }

  /**
   * Wait for a Stream Management acknowledgment (<a/>) with timeout.
   * @internal
   */
  private waitForSmAck(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.xmpp) {
        resolve(false)
        return
      }

      let resolved = false

      // Cleanup helper
      const cleanup = (timeoutId: ReturnType<typeof setTimeout>) => {
        clearTimeout(timeoutId)
        ;(this.xmpp as any)?.off?.('nonza', handleNonza)
      }

      // Listen for <a/> nonza - defined as a hoisted function for cleanup reference
      const handleNonza = (nonza: Element) => {
        if (nonza.is('a', 'urn:xmpp:sm:3') && !resolved) {
          resolved = true
          cleanup(timeoutId)
          resolve(true)
        }
      }

      ;(this.xmpp as any)?.on?.('nonza', handleNonza)

      // Timeout - must be set up before send() to be in scope for cleanup
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          ;(this.xmpp as any)?.off?.('nonza', handleNonza)
          resolve(false)
        }
      }, timeoutMs)

      // Send <r/> request
      this.xmpp.send(xml('r', { xmlns: 'urn:xmpp:sm:3' })).catch(() => {
        if (!resolved) {
          resolved = true
          cleanup(timeoutId)
          resolve(false)
        }
      })
    })
  }

  /**
   * Handle a dead socket by cleaning up and scheduling reconnection.
   * This is called when we detect the WebSocket died silently (e.g., after sleep).
   */
  handleDeadSocket(): void {
    // Don't reconnect if already reconnecting, in terminal state, or disconnected
    if (this.isInReconnectingState() || this.isInTerminalState()) {
      return
    }
    const machineState = this.getMachineState()
    if (machineState === 'disconnected' || machineState === 'idle') {
      return
    }

    this.stores.console.addEvent('Dead connection detected, will reconnect', 'connection')
    logWarn('Dead connection detected, will reconnect')

    // Signal machine: SOCKET_DIED → transitions to reconnecting.waiting
    // (incrementAttempt action computes backoff delay)
    this.connectionActor.send({ type: 'SOCKET_DIED' })

    // IMPORTANT: Null the client reference SYNCHRONOUSLY before any async operations.
    // This prevents a race condition where the old client's 'online' event fires
    // during cleanup, causing handleConnectionSuccess to run and set status='online'
    // while xmpp is about to become null.
    // This matches the pattern used in disconnect().
    const clientToClean = this.xmpp
    this.xmpp = null

    // Clear any pending SM ack debounce (socket is dead, don't try to send)
    clearSmAckDebounce(this.smPatchState)
    // Stop the old client (fire-and-forget since socket is already dead)
    if (clientToClean) {
      clientToClean.stop().catch(() => {})
    }

    // Start timer-driven reconnection based on machine context
    this.startReconnectTimer()
  }

  /**
   * Notify the SDK of a system state change.
   *
   * This is the recommended way for apps to signal platform-specific events
   * (wake from sleep, visibility changes) to the SDK. The SDK handles the
   * appropriate protocol response internally.
   *
   * @param state - The system state change:
   *   - 'awake': System woke from sleep (time-gap detected). SDK verifies connection and reconnects if dead.
   *   - 'sleeping': System is going to sleep. SDK may gracefully disconnect.
   *   - 'visible': App became visible/foreground. Only triggers reconnect if already reconnecting.
   *   - 'hidden': App went to background. SDK may reduce keepalive frequency.
   * @param sleepDurationMs - Optional duration of sleep/inactivity in milliseconds.
   *   If provided and exceeds SM session timeout (~10 min), skips verification and
   *   immediately triggers reconnect (the SM session is definitely expired).
   *
   * @example
   * ```typescript
   * // App detects wake from sleep with duration
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
    switch (state) {
      case 'awake': {
        const sleepSec = sleepDurationMs != null ? Math.round(sleepDurationMs / 1000) : null
        logInfo(`System state: awake${sleepSec != null ? ` (sleep: ${sleepSec}s)` : ''}`)
        // Verify connection health after wake from sleep (time-gap detected)
        // This is the reliable indicator of potential socket death
        if (this.isInConnectedState()) {
          // Send WAKE to the machine — if sleep exceeds SM timeout, the guard
          // transitions directly to reconnecting (skipping verification).
          // Otherwise, transitions to connected.verifying.
          this.connectionActor.send({ type: 'WAKE', sleepDurationMs })

          // After the machine transition, check if we went to reconnecting
          // (long sleep) or verifying (short sleep)
          if (this.isInReconnectingState()) {
            const sleepSecs = Math.round((sleepDurationMs ?? 0) / 1000)
            this.stores.console.addEvent(
              `System state: ${state}, sleep duration ${sleepSecs}s exceeds SM timeout - reconnecting immediately`,
              'connection'
            )
            // Machine already transitioned to reconnecting — clean up and start timer
            const clientToClean = this.xmpp
            this.xmpp = null
            clearSmAckDebounce(this.smPatchState)
            if (clientToClean) {
              clientToClean.stop().catch(() => {})
            }
            this.startReconnectTimer()
          } else {
            // Short sleep — verify connection health
            this.stores.console.addEvent(`System state: ${state}, verifying connection`, 'connection')
            const isHealthy = await this.verifyConnection()
            if (!isHealthy) {
              this.stores.console.addEvent('Connection dead after wake, reconnecting...', 'connection')
              // verifyConnection() already sent VERIFY_FAILED and called handleDeadSocket
              // internally on timeout/error. But if xmpp was null, it returns false
              // without triggering reconnect. Ensure reconnection is triggered.
              this.handleDeadSocket()
            }
          }
        } else if (this.isInReconnectingState()) {
          // Trigger immediate reconnect if we were already reconnecting
          this.stores.console.addEvent(`System state: ${state}, triggering immediate reconnect`, 'connection')
          this.triggerReconnect()
        }
        break
      }

      case 'visible':
        // App became visible - don't verify connection (no indication of socket death)
        // Only trigger reconnect if we were already in reconnecting state
        if (this.isInReconnectingState()) {
          logInfo('System state: visible, triggering immediate reconnect')
          this.stores.console.addEvent('System state: visible, triggering immediate reconnect', 'connection')
          this.triggerReconnect()
        }
        break

      case 'sleeping':
        // System is going to sleep - we could optionally set XA presence
        // For now, just log it. The WebSocket will likely die during sleep
        // and we'll handle reconnection when we wake.
        this.stores.console.addEvent('System state: sleeping', 'connection')
        break

      case 'hidden':
        // App went to background - could reduce keepalive frequency
        // For now, just log it
        this.stores.console.addEvent('System state: hidden', 'connection')
        break
    }
  }

  // ==================== Private Methods ====================

  /**
   * Check if WebSocket discovery should be skipped.
   * Returns true if:
   * - skipDiscovery option is explicitly set
   * - server is already a WebSocket URL (no discovery needed)
   */
  private shouldSkipDiscovery(server: string, skipDiscovery?: boolean): boolean {
    return skipDiscovery === true || server.startsWith('ws://') || server.startsWith('wss://')
  }

  /**
   * Get WebSocket URL synchronously (used when discovery is skipped).
   * Returns the server if it's already a WebSocket URL, otherwise constructs default URL.
   */
  private getWebSocketUrl(server: string, domain: string): string {
    if (server.startsWith('ws://') || server.startsWith('wss://')) {
      return server
    }
    return `wss://${server || domain}/ws`
  }

  /**
   * Resolve WebSocket URL for a server via XEP-0156 discovery.
   *
   * Attempts discovery on the domain and falls back to default URL if discovery fails.
   * Note: This method is only called when discovery is NOT skipped.
   *
   * @param server - Server parameter (domain name)
   * @param domain - XMPP domain from the JID (used for discovery)
   * @returns Resolved WebSocket URL
   */
  private async resolveWebSocketUrl(server: string, domain: string): Promise<string> {
    // The server parameter might be a domain - attempt XEP-0156 discovery
    // Use the JID domain for discovery (more reliable than server param)
    const discoveryDomain = server || domain

    this.stores.console.addEvent(
      `Attempting XEP-0156 WebSocket discovery for ${discoveryDomain}...`,
      'connection'
    )

    try {
      const discoveredUrl = await discoverWebSocket(discoveryDomain, 5000)
      if (discoveredUrl) {
        this.stores.console.addEvent(
          `XEP-0156 discovery successful: ${discoveredUrl}`,
          'connection'
        )
        return discoveredUrl
      }
    } catch (err) {
      // Discovery failed - will use fallback
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.stores.console.addEvent(
        `XEP-0156 discovery failed: ${errorMsg}`,
        'connection'
      )
    }

    // Fall back to default URL pattern
    const fallbackUrl = `wss://${discoveryDomain}/ws`
    this.stores.console.addEvent(
      `Using default WebSocket URL: ${fallbackUrl}`,
      'connection'
    )
    return fallbackUrl
  }

  /**
   * Create an xmpp.js client instance with the given options.
   * Centralizes client creation for both initial connect and reconnect.
   *
   * Note: The server parameter should already be a resolved WebSocket URL
   * from resolveWebSocketUrl() or from stored credentials during reconnect.
   */
  private createXmppClient(options: ConnectOptions): Client {
    const { jid, password, server, resource, lang } = options
    // Server should already be a WebSocket URL (resolved by connect() or stored from previous connect)
    // Keep the fallback for backwards compatibility with stored credentials
    const wsUrl = server.startsWith('ws') ? server : `wss://${server}/ws`
    const domain = getDomain(jid)
    const username = getLocalPart(jid)

    const xmppClient = client({
      service: wsUrl,
      domain,
      username,
      password,
      resource,
      lang,
    })

    this.disableBuiltInReconnect(xmppClient)

    // Request 10-minute SM resumption timeout (XEP-0198)
    // The server may grant less, but this allows longer session survival
    // during brief disconnections (e.g., network switches, laptop sleep)
    const sm = xmppClient.streamManagement as any
    if (sm) {
      sm.preferredMaximum = 600 // 10 minutes in seconds

      // Optionally disable xmpp.js's built-in SM keepalive interval
      // when the app implements its own keepalive (e.g., native timer)
      if (this.credentials?.disableSmKeepalive) {
        // Set to very high value to effectively disable (24 hours)
        sm.requestAckInterval = 24 * 60 * 60 * 1000
      }

      patchSmAckDebounce(this.smPatchState, xmppClient)
      patchSmAckQueue(sm)
    }

    return xmppClient
  }

  /**
   * Disable xmpp.js built-in auto-reconnect (@xmpp/reconnect module).
   *
   * We implement our own reconnection logic instead because xmpp.js reconnect:
   * - Uses a fixed 1 second delay with no exponential backoff
   * - Doesn't provide UI feedback (countdown to next attempt)
   * - Doesn't give us control over Stream Management state hydration timing
   *
   * Our custom implementation provides:
   * - Exponential backoff (1s → 2s → 4s → ... → max 2 minutes)
   * - Reconnection countdown displayed to user
   * - Proper SM state hydration for session resumption (XEP-0198)
   * - Full control over post-connect logic (roster, presence, carbons)
   */
  private disableBuiltInReconnect(xmppClient: Client): void {
    const reconnect = (xmppClient as any)?.reconnect
    if (reconnect?.stop) {
      reconnect.stop()
    }
  }

  /**
   * Hydrate Stream Management state for session resumption (XEP-0198).
   * Must be called after creating the client but before starting.
   */
  private hydrateStreamManagement(smState?: { id: string; inbound: number }): void {
    // Reset resume tracking - we're starting a new resume attempt
    // This ensures 'fail' events during resume are properly logged as resume failures
    this.smResumeCompleted = false

    if (!smState || !this.xmpp?.streamManagement) return
    const sm = this.xmpp.streamManagement as any
    sm.id = smState.id
    sm.inbound = smState.inbound
    this.stores.console.addEvent(
      `Attempting SM session resumption (id: ${smState.id.slice(0, 8)}..., h: ${smState.inbound})`,
      'sm'
    )
  }

  /**
   * Sets up connection event handlers and starts the XMPP connection.
   *
   * When SM resume succeeds, xmpp.js emits 'resumed' (NOT 'online').
   * When SM resume fails (or no SM state), xmpp.js emits 'online'.
   *
   * @param onConnected - Callback called when connected, with isResumption=true if SM resumed
   * @param onError - Callback called on error
   */
  private setupConnectionHandlers(
    onConnected: (isResumption: boolean) => void | Promise<void>,
    onError: (err: Error) => void
  ): void {
    if (!this.xmpp) return

    let resolved = false

    const handleResult = (isResumption: boolean) => {
      if (resolved) return
      resolved = true
      onConnected(isResumption)
    }

    // Listen for SM events
    const sm = this.xmpp.streamManagement as any
    if (sm?.on) {
      // SM successfully enabled (new session)
      sm.on('enabled', () => {
        const smId = sm.id ? sm.id.slice(0, 8) + '...' : 'none'
        const smMax = sm.max != null ? `${sm.max}s` : 'unknown'
        this.stores.console.addEvent(`Stream Management enabled (id: ${smId})`, 'sm')
        logInfo(`SM enabled (id: ${smId}, server max: ${smMax})`)
        // New session means no pending resume, so any future 'fail' events are real failures
        this.smResumeCompleted = true
        // Cache SM state for reconnection (survives socket death)
        if (sm.id) {
          this.cachedSmState = {
            id: sm.id,
            inbound: sm.inbound || 0,
          }
          // Persist to storage for session resumption across page reloads
          void this.persistSmState()
        }
      })
      // SM session successfully resumed (from xmpp.js plugin)
      sm.on('resumed', () => {
        this.stores.console.addEvent('Stream Management session resumed', 'sm')
        logInfo(`SM session resumed (id: ${sm.id ? sm.id.slice(0, 8) + '...' : 'none'}, h: ${sm.inbound ?? 0})`)
        // Mark resume as completed - any 'fail' events after this are for new stanzas, not resume failures
        this.smResumeCompleted = true
        // Update cached SM state (survives socket death for next reconnection)
        if (sm.id) {
          this.cachedSmState = {
            id: sm.id,
            inbound: sm.inbound || 0,
          }
          // Persist to storage for session resumption across page reloads
          void this.persistSmState()
        }
        handleResult(true)
      })
      // Listen for SM resumption failure - called once per unacknowledged stanza
      // IMPORTANT: This fires for stanzas that were in the queue BEFORE resume,
      // not for stanzas sent after a successful resume. If smResumeCompleted is true,
      // these are stanzas that failed to send for other reasons (e.g., socket died).
      sm.on('fail', (stanza: unknown) => {
        const stanzaStr = stanza instanceof Error ? stanza.message : String(stanza)
        if (!this.smResumeCompleted) {
          // Stanza was in queue before resume attempt - server rejected them
          this.stores.console.addEvent(`SM stanza lost (resume rejected): ${stanzaStr}`, 'sm')
        } else {
          // Stanza sent after successful resume - this is a send failure, not resume failure
          this.stores.console.addEvent(`SM stanza send failed: ${stanzaStr}`, 'sm')
        }
        // Note: xmpp.js will fall back to new session and emit 'online'
      })
    }

    // Also listen for <resumed/> stanza directly, since xmpp.js's SM plugin
    // may not emit 'resumed' event when we manually hydrate SM state.
    // We also need to manually update the SM plugin state so getStreamManagementState() works.
    // NOTE: We use setTimeout to run AFTER xmpp.js's own SM plugin processing,
    // which otherwise resets the state after our update.
    ;(this.xmpp as any).on('nonza', (nonza: Element) => {
      if (nonza.is('resumed', 'urn:xmpp:sm:3')) {
        const previd = nonza.attrs.previd as string
        const inbound = this.xmpp?.streamManagement ? (this.xmpp.streamManagement as any).inbound : 0
        this.stores.console.addEvent(`Stream Management session resumed (id: ${previd.slice(0, 8)}...)`, 'sm')

        // Update cached SM state (survives socket death for next reconnection)
        this.cachedSmState = {
          id: previd,
          inbound: inbound,
        }
        // Persist to storage for session resumption across page reloads
        void this.persistSmState()

        // Delay to run after xmpp.js's SM plugin finishes processing
        setTimeout(() => {
          const sm = this.xmpp?.streamManagement as any
          if (sm) {
            sm.id = previd
            sm.enabled = true
            sm.inbound = inbound // Preserve the inbound counter
          }
        }, 0)

        handleResult(true)
      }
    })

    // Standard online event - fired when:
    // 1. New session (no SM state provided)
    // 2. SM resumption FAILED and fell back to new session
    // Note: When SM resume succeeds, xmpp.js does NOT emit 'online', only 'resumed'
    // Therefore, whenever 'online' fires, it's a new session.
    this.xmpp.on('online', () => {
      handleResult(false)
    })

    this.xmpp.on('error', (err: Error) => {
      if (resolved) return
      resolved = true
      onError(err)
    })

    this.xmpp.start().catch((err: Error) => {
      if (resolved) return
      resolved = true
      onError(err)
    })
  }

  /**
   * Setup connection event handlers (error, offline, etc.).
   */
  private setupHandlers(): void {
    if (!this.xmpp) return

    // Log all incoming/outgoing XML to console store
    this.xmpp.on('element', (element: Element) => {
      this.stores?.console.addPacket('incoming', element.toString())
    })
    this.xmpp.on('send', (element: Element) => {
      this.stores?.console.addPacket('outgoing', element.toString())
    })

    // Register IQ handlers using iq-callee
    const iqCallee = (this.xmpp as any).iqCallee
    if (iqCallee) {
      // Roster pushes (type="set") - handled by emitting stanza event
      iqCallee.set('jabber:iq:roster', 'query', (context: { stanza: Element }) => {
        this.emit('stanza', context.stanza)
        // Route to RosterModule via callback
        if (this.onStanza) {
          this.onStanza(context.stanza)
        }
        return true // Return truthy to indicate we handled it (sends empty result)
      })

      // Disco#info queries (type="get") - XEP-0030/XEP-0115
      iqCallee.get(NS_DISCO_INFO, 'query', (context: { stanza?: Element; element?: Element }) => {
        const clientIdentity = getClientIdentity()
        const identity = xml('identity', {
          category: clientIdentity.category,
          type: clientIdentity.type,
          name: clientIdentity.name,
        })

        const sortedFeatures = [...CLIENT_FEATURES].sort()
        const features = sortedFeatures.map(f => xml('feature', { var: f }))

        // Get node attribute from incoming query (caps verification request)
        const node = context?.element?.attrs?.node

        // Build query attributes - include node if it was in the request (XEP-0115 requirement)
        const queryAttrs: Record<string, string> = { xmlns: NS_DISCO_INFO }
        if (node) {
          queryAttrs.node = node
        }

        return xml('query', queryAttrs, identity, ...features)
      })

      // Ping queries (type="get") - XEP-0199
      iqCallee.get(NS_PING, 'ping', () => {
        return true // Return truthy to indicate we handled it (sends empty result)
      })
    }

    // Handle incoming stanzas - call the stanza handler callback if set
    this.xmpp.on('stanza', (stanza) => {
      // Emit for XMPPClient event emitter
      this.emit('stanza', stanza)

      // Call stanza routing callback if set
      if (this.onStanza) {
        this.onStanza(stanza)
      }
    })

    // Handle stream errors (including resource conflict)
    this.xmpp.on('error', (err: Error) => {
      const message = err.message?.toLowerCase() || ''

      // Detect resource conflict (another client logged in with same resource)
      if (message.includes('conflict')) {
        this.connectionActor.send({ type: 'CONFLICT' })
        this.clearTimers()
        this.stores.console.addEvent('Disconnected: Resource conflict (another client connected)', 'error')
        console.error('[XMPP] Resource conflict: another client connected with the same account')
        this.stores.events.addSystemNotification(
          'resource-conflict',
          'Session Replaced',
          'Another client connected with the same account. Auto-reconnect is disabled to prevent conflicts. Please reconnect manually when ready.'
        )
        // Clear credentials to prevent accidental reconnect
        this.credentials = null
      } else if (message.includes('not-authorized') || message.includes('auth')) {
        this.connectionActor.send({ type: 'AUTH_ERROR' })
        this.clearTimers()
        this.stores.console.addEvent('Disconnected: Authentication error', 'error')
        console.error('[XMPP] Authentication failed: not-authorized')
        this.credentials = null
      }
    })

    // Handle unexpected socket closure (XEP-0198 Stream Management aware)
    // IMPORTANT: xmpp.js emits 'disconnect' when socket closes unexpectedly,
    // and 'offline' only after stop() is called. We disabled the built-in
    // reconnect module, so WE must handle 'disconnect' for reconnection.
    // See: https://github.com/xmppjs/xmpp.js/tree/main/packages/client
    //
    // WORKAROUND: Cast to 'any' because @types/xmpp__client doesn't properly
    // inherit the 'disconnect' event from @types/xmpp__connection's StatusEvents.
    // The event is documented and works at runtime. A fix should be submitted to:
    // https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/xmpp__client
    ;(this.xmpp as any).on('disconnect', (context: { clean: boolean; reason?: unknown }) => {
      const wasClean = context?.clean ?? false
      // Extract close code for file log diagnostics
      const rawReason = context?.reason
      let closeInfo = ''
      if (rawReason && typeof rawReason === 'object' && 'code' in rawReason) {
        const evt = rawReason as { code: number; reason?: string }
        closeInfo = evt.reason ? `, code: ${evt.code}, reason: ${evt.reason}` : `, code: ${evt.code}`
      }
      logInfo(`Socket disconnected (clean: ${wasClean}${closeInfo})`)
      this.stores.console.addEvent(
        `Socket disconnected (clean: ${wasClean})`,
        'connection'
      )

      // Notify disconnect handler (for presence machine, etc.)
      // Skip during reconnection - we're not truly disconnected, just cycling the socket
      if (!this.isInReconnectingState()) {
        this.onDisconnect?.()
      }

      // The machine state determines what to do on socket disconnect.
      // Terminal states (conflict, auth) and disconnected state are already handled
      // by the error handler or disconnect() method above.
      const machineState = this.getMachineState()

      if (machineState === 'disconnected') {
        // Manual disconnect - will transition to offline via stop()
        this.stores.console.addEvent('Socket closed (manual disconnect)', 'connection')
      } else if (this.isInTerminalState()) {
        // Terminal state (conflict, auth, maxRetries, initialFailure)
        // Already handled — the error handler or connect() rejection sent the event.
        // For initial failure, provide a helpful error message.
        const stateValue = machineState as { terminal: string }
        if (stateValue.terminal === 'initialFailure') {
          let reason = ''
          const rawReason = context?.reason
          if (rawReason instanceof Error) {
            reason = rawReason.message
          } else if (rawReason && typeof rawReason === 'object' && 'code' in rawReason) {
            const evt = rawReason as { code: number; reason?: string }
            reason = evt.reason
              ? `WebSocket closed (code: ${evt.code}, ${evt.reason})`
              : `WebSocket closed (code: ${evt.code})`
          } else if (rawReason) {
            reason = String(rawReason)
          }
          // When using the local proxy (tls/starttls), an immediate WebSocket close
          // with code 1006 typically means the OS firewall blocked the connection
          // to the local proxy listener (common on Windows first launch).
          const proxyServer = this.credentials?.server ?? ''
          const isProxyMode = !!this.deps.proxyAdapter
            && (proxyServer.startsWith('ws://127.0.0.1:') || proxyServer.startsWith('ws://[::1]:'))
          const isAbnormalClose = rawReason && typeof rawReason === 'object' && 'code' in rawReason
            && (rawReason as { code: number }).code === 1006
          let errorMsg: string
          if (isProxyMode && isAbnormalClose) {
            errorMsg = 'Connection failed: Unable to reach local proxy. If a firewall prompt appeared, allow the connection and try again.'
          } else if (reason) {
            errorMsg = `Connection failed: ${reason}`
          } else {
            errorMsg = 'Connection failed. Check your server address and try again.'
          }
          this.stores.connection.setError(errorMsg)
          this.stores.console.addEvent('Initial connection failed (no auto-reconnect)', 'connection')
          console.warn(`[XMPP] Initial connection failed (clean: ${wasClean}, reason: ${reason || 'unknown'}). Server: ${this.originalServer || 'unknown'}`)
          // Clear credentials so login form shows fresh
          this.credentials = null
        }
        // For conflict/auth terminal states, credentials were already cleared by error handler
      } else if (this.isInReconnectingState()) {
        // Already reconnecting - this disconnect event is from cleaning up old client
        this.stores.console.addEvent('Socket closed (reconnect in progress)', 'connection')
      } else if (!this.credentials) {
        // No credentials - cannot reconnect
        this.stores.console.addEvent('Socket closed (no credentials to reconnect)', 'connection')
      } else if (machineState === 'connecting') {
        // Still in connecting state — the CONNECTION_ERROR was already sent by connect()
        // This is the socket close that follows the error, nothing more to do
        this.stores.console.addEvent('Socket closed (connection attempt ended)', 'connection')
      } else {
        // Unexpected disconnect while connected — send SOCKET_DIED to trigger reconnect
        this.stores.console.addEvent('Connection lost unexpectedly, will reconnect', 'connection')
        this.connectionActor.send({ type: 'SOCKET_DIED' })
        this.startReconnectTimer()
      }
    })

    // Handle final offline state (only after stop() is called)
    // This is the terminal state - no reconnection will happen
    this.xmpp.on('offline', () => {
      this.emit('offline')
      // 'offline' only fires after we call stop(), so this is for cleanup only
      // All reconnection logic is handled in the 'disconnect' handler above
    })
  }

  /**
   * Handle successful connection (both initial connect and reconnect).
   * Centralizes post-connect logic: status update, presence, roster, carbons, bookmarks.
   *
   * @param isResumption - True if this was an SM session resumption
   * @param logMessage - Message to log (different for connect vs reconnect)
   * @param previouslyJoinedRooms - Rooms to rejoin after new session (reconnect only)
   */
  private async handleConnectionSuccess(
    isResumption: boolean,
    logMessage: string,
    previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>
  ): Promise<void> {
    // Guard: if xmpp was cleaned up during async connection negotiation, abort.
    // This can happen if handleDeadSocket() was called while we were connecting.
    if (!this.xmpp) {
      this.stores.console.addEvent('Connection success aborted - client was cleaned up', 'connection')
      return
    }

    // Machine state is already updated: CONNECTION_SUCCESS was sent before this call.
    // The subscription will sync status='online' and reset reconnect state.
    // Clear any lingering timers from a previous reconnect cycle.
    this.clearTimers()

    this.stores.console.addEvent(
      isResumption ? logMessage.replace('Connected', 'Session resumed') : logMessage,
      'connection'
    )

    // Log session summary to file log
    const sessionType = isResumption ? 'SM resumed' : 'fresh'
    logInfo(`Connected: ${sessionType}`)

    // Log the bound resource
    if (this.credentials?.jid) {
      const resource = getResource(this.credentials.jid)
      if (resource) {
        logInfo(`Bound resource: ${resource}`)
      }
    }

    // Emit SDK events for connection online and authenticated
    this.deps.emitSDK('connection:status', { status: 'online' })
    if (this.credentials?.jid) {
      this.deps.emitSDK('connection:authenticated', { jid: this.credentials.jid })
    }

    // Emit appropriate event
    this.emit(isResumption ? 'resumed' : 'online')

    // Call registered post-connection handler (if set)
    if (this.onConnectionSuccess) {
      await this.onConnectionSuccess(isResumption, previouslyJoinedRooms)
    }
  }

  /**
   * Start timer-driven reconnection based on the machine's context.
   *
   * The machine has already transitioned to reconnecting.waiting and computed
   * the backoff delay (context.nextRetryDelayMs). This method reads that delay,
   * starts the countdown timer, and fires RETRY_TIMER_EXPIRED when done.
   *
   * Orchestration in machine, execution in Connection.ts.
   */
  private startReconnectTimer(): void {
    // Guard: only start timers if machine is in reconnecting state
    if (!this.isInReconnectingState() || !this.credentials) {
      return
    }

    // Read delay from machine context (already computed by incrementAttempt action)
    const snapshot = this.connectionActor.getSnapshot()
    const { reconnectAttempt, nextRetryDelayMs } = snapshot.context

    this.stores.console.addEvent(
      `Reconnecting (attempt ${reconnectAttempt}, delay ${Math.round(nextRetryDelayMs / 1000)}s)`,
      'connection'
    )
    logInfo(`Reconnecting (attempt ${reconnectAttempt}, delay ${Math.round(nextRetryDelayMs / 1000)}s)`)
    // Emit SDK events for reconnecting status
    this.deps.emitSDK('connection:status', { status: 'reconnecting' })
    this.deps.emitSDK('connection:reconnecting', { attempt: reconnectAttempt, delayMs: nextRetryDelayMs })
    this.emit('reconnecting', reconnectAttempt, nextRetryDelayMs)

    // The UI reads reconnectTargetTime from the store to display a local countdown.
    // No interval needed here — the machine already set the target time.

    this.reconnectTimeout = setTimeout(() => {
      // Signal machine: timer expired → transitions to reconnecting.attempting
      this.connectionActor.send({ type: 'RETRY_TIMER_EXPIRED' })
      void this.attemptReconnect()
    }, nextRetryDelayMs)
  }

  /**
   * Attempt to reconnect with saved credentials.
   *
   * Includes a defensive check for the xmpp.js client status before proceeding.
   * This handles edge cases where the reconnect timer was suspended by the OS
   * (e.g., during sleep) and the connection state may have changed.
   */
  private async attemptReconnect(): Promise<void> {
    // Guard: only attempt if machine is still in reconnecting state
    if (!this.credentials || !this.isInReconnectingState()) {
      return
    }

    // Defensive check: verify xmpp.js client is not already online.
    // This shouldn't happen in normal flow, but guards against edge cases.
    if (this.xmpp && (this.xmpp as any).status === 'online') {
      this.stores.console.addEvent('Connection still online - cancelling reconnect attempt', 'connection')
      this.connectionActor.send({ type: 'CONNECTION_SUCCESS' })
      return
    }

    // Emit SDK event for connecting status (machine is in reconnecting.attempting)
    this.deps.emitSDK('connection:status', { status: 'connecting' })

    try {
      // Save SM state before stopping the old client (for session resumption)
      const smState = this.getStreamManagementState()
      if (smState) {
        this.stores.console.addEvent(
          `Saved SM state for resumption (id: ${smState.id.slice(0, 8)}..., h: ${smState.inbound})`,
          'sm'
        )
      } else {
        this.stores.console.addEvent('No SM state available, will start new session', 'sm')
      }

      // Save joined rooms before cleanup (for rejoin on new session)
      // These are rooms that were actively joined but may not have autojoin=true
      const previouslyJoinedRooms = this.stores.room.joinedRooms() ?? []

      // Clean up old client and stop the proxy (the TCP connection is dead)
      await this.cleanupClient()

      // Restart the proxy if available
      // The proxy must be restarted with the original server string (not the local WS URL)
      // because the previous proxy's TCP connection to the XMPP server is dead
      const userProvidedWebSocketUrl = this.originalServer.startsWith('ws://') || this.originalServer.startsWith('wss://')

      if (this.deps.proxyAdapter && !userProvidedWebSocketUrl) {
        try {
          // Stop the old proxy first (if still running)
          try { await this.deps.proxyAdapter.stopProxy() } catch { /* may not be running */ }
          // Prefer cached resolved endpoint to skip SRV re-resolution
          // (SRV may return different results after DNS cache flush, e.g. after system sleep)
          const proxyServer = this.resolvedEndpoint || this.originalServer
          const proxyResult = await Promise.race([
            this.deps.proxyAdapter.startProxy(proxyServer),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Proxy restart timed out')), PROXY_RESTART_TIMEOUT_MS)
            ),
          ])
          this.credentials.server = proxyResult.url
          this.stores.connection.setConnectionMethod(proxyResult.connectionMethod)
          this.resolvedEndpoint = proxyResult.resolvedEndpoint ?? null
          this.stores.console.addEvent(
            `Proxy restarted for reconnect: ${proxyResult.url} (${proxyResult.connectionMethod}) [endpoint: ${proxyServer}]`,
            'connection'
          )
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          // If reconnect with cached endpoint failed, retry with original server (fresh SRV)
          if (this.resolvedEndpoint) {
            this.stores.console.addEvent(
              `Cached endpoint failed: ${errorMsg}, retrying with SRV resolution`,
              'connection'
            )
            this.resolvedEndpoint = null
            try {
              const proxyResult = await Promise.race([
                this.deps.proxyAdapter.startProxy(this.originalServer),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('Proxy restart timed out (SRV fallback)')), PROXY_RESTART_TIMEOUT_MS)
                ),
              ])
              this.credentials.server = proxyResult.url
              this.stores.connection.setConnectionMethod(proxyResult.connectionMethod)
              this.resolvedEndpoint = proxyResult.resolvedEndpoint ?? null
              this.stores.console.addEvent(
                `Proxy restarted via SRV fallback: ${proxyResult.url} (${proxyResult.connectionMethod})`,
                'connection'
              )
            } catch (fallbackErr) {
              const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
              this.stores.console.addEvent(`Failed to restart proxy on reconnect: ${fallbackMsg}`, 'error')
              this.credentials.server = `wss://${getDomain(this.credentials.jid)}/ws`
              this.stores.connection.setConnectionMethod('websocket')
            }
          } else {
            this.stores.console.addEvent(`Failed to restart proxy on reconnect: ${errorMsg}`, 'error')
            this.credentials.server = `wss://${getDomain(this.credentials.jid)}/ws`
            this.stores.connection.setConnectionMethod('websocket')
          }
        }
      }

      // Create new client with stored credentials (server may have been updated by proxy restart)
      this.xmpp = this.createXmppClient(this.credentials)
      this.hydrateStreamManagement(smState ?? undefined)
      this.setupHandlers()

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Reconnect attempt timed out after ${RECONNECT_ATTEMPT_TIMEOUT_MS / 1000}s`))
        }, RECONNECT_ATTEMPT_TIMEOUT_MS)

        this.setupConnectionHandlers(
          async (isResumption) => {
            clearTimeout(timeout)
            // Signal machine: reconnect succeeded → connected.healthy
            this.connectionActor.send({ type: 'CONNECTION_SUCCESS' })
            await this.handleConnectionSuccess(
              isResumption,
              'Reconnected',
              previouslyJoinedRooms
            )
            resolve()
          },
          (err) => {
            clearTimeout(timeout)
            reject(err)
          }
        )
      })
    } catch (err) {
      logError('Reconnect failed:', err)
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      this.stores.console.addEvent(`Reconnect attempt failed: ${errorMsg}`, 'error')
      logErr(`Reconnect failed: ${errorMsg}`)
      // Signal machine: reconnect failed → either back to waiting (with incrementAttempt)
      // or terminal.maxRetries (if exhausted)
      this.connectionActor.send({ type: 'CONNECTION_ERROR', error: errorMsg })

      // If machine transitioned back to reconnecting.waiting, start another timer
      if (this.isInReconnectingState()) {
        this.startReconnectTimer()
      }
      // If machine went to terminal.maxRetries, no more timers needed
      // (the subscription will sync the error status to the store)
    }
  }

  /**
   * Clean up the current XMPP client connection.
   * Used before reconnecting or when detecting a dead socket.
   *
   * IMPORTANT: Nulls this.xmpp FIRST to prevent race conditions where
   * the old client fires events during stop(). This matches the pattern
   * used in disconnect().
   */
  private async cleanupClient(): Promise<void> {
    const clientToClean = this.xmpp
    if (!clientToClean) return

    // Null the reference FIRST to prevent race conditions
    this.xmpp = null

    // Clear any pending SM ack debounce timer
    clearSmAckDebounce(this.smPatchState)

    try {
      await withTimeout(clientToClean.stop(), CLIENT_STOP_TIMEOUT_MS)
    } catch {
      // Ignore stop errors during cleanup
    }
  }

  /**
   * Check if an error indicates a dead WebSocket connection.
   * This can happen after system sleep when the socket dies silently.
   */
  private isDeadSocketError(errorMessage: string): boolean {
    // Common dead socket error patterns
    return (
      errorMessage.includes('socket.write') ||
      errorMessage.includes('null is not an object') ||
      errorMessage.includes('Cannot read properties of null') ||
      errorMessage.includes('socket is null') ||
      errorMessage.includes('Socket not available') ||
      errorMessage.includes('WebSocket is not open')
    )
  }
}
