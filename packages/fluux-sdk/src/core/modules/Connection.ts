import { client, Client, Element, xml } from '@xmpp/client'
import { createActor } from 'xstate'
import { BaseModule, type ModuleDependencies } from './BaseModule'
import type { ConnectOptions, ConnectionMethod } from '../types'
import { getDomain, getLocalPart, getResource } from '../jid'
import { getClientIdentity, CLIENT_FEATURES } from '../caps'
import { NS_DISCO_INFO, NS_PING } from '../namespaces'
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
import {
  withTimeout,
  forceDestroyClient,
  isDeadSocketError,
  CLIENT_STOP_TIMEOUT_MS,
  RECONNECT_ATTEMPT_TIMEOUT_MS,
} from './connectionUtils'
import {
  shouldSkipDiscovery,
  getWebSocketUrl,
  resolveWebSocketUrl,
} from './serverResolution'
import { SmPersistence } from './smPersistence'
import { ProxyManager } from './proxyManager'

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

/** Upper bound for best-effort disconnect cleanup tasks (storage/cache). */
const DISCONNECT_CLEANUP_TIMEOUT_MS = 2000

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

  /**
   * XState connection state machine actor.
   * Replaces the error-prone boolean flags (isReconnecting, hasEverConnected,
   * isManualDisconnect, disconnectReason) with explicit, auditable state transitions.
   * See connectionMachine.ts for the state diagram and invariants.
   */
  private connectionActor: ConnectionActor

  // Proxy lifecycle manager (start / restart / stop with fallback chain)
  private proxyManager: ProxyManager

  // Track SM resume state to properly handle 'fail' events
  // Stanzas in queue BEFORE resume should report as lost
  // Stanzas sent AFTER resume are normal sends that failed for other reasons
  private smResumeCompleted = false

  // SM state persistence (cache + storage)
  private smPersistence: SmPersistence

  // SM patches state (ack debounce timer + original send reference)
  // See smPatches.ts for implementation details
  private smPatchState: SmPatchState = createSmPatchState()

  // Callback for post-connection setup (roster, presence, carbons, etc.)
  private onConnectionSuccess?: (isResumption: boolean, previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>) => Promise<void>

  // Callback for disconnect notification
  private onDisconnect?: () => void

  // Callback for stanza routing
  private onStanza?: (stanza: Element) => void

  // Track previous machine state to detect state-entry side effects
  private previousMachineState: ConnectionStateValue = 'idle'

  // Convenience accessors
  protected get stores() { return this.deps.stores! }
  protected get emit() { return this.deps.emit }
  protected get storageAdapter() { return this.deps.storageAdapter }

  constructor(deps: ModuleDependencies) {
    super(deps)

    // Create proxy manager
    this.proxyManager = new ProxyManager({
      proxyAdapter: deps.proxyAdapter,
      console: { addEvent: (msg, cat) => this.stores.console.addEvent(msg, cat) },
    })

    // Create SM persistence helper
    this.smPersistence = new SmPersistence({
      storageAdapter: deps.storageAdapter,
      getJoinedRooms: () => (this.stores.room.joinedRooms() ?? []).map(room => ({
        jid: room.jid,
        nickname: room.nickname,
        password: room.password,
        autojoin: room.autojoin,
      })),
      console: { addEvent: (msg, cat) => this.stores.console.addEvent(msg, cat) },
    })

    // Create and start the connection state machine actor
    this.connectionActor = createActor(connectionMachine).start()
    this.previousMachineState = this.getMachineState()

    // Subscribe to machine state changes to sync with the connection store
    this.connectionActor.subscribe((snapshot) => {
      const previousState = this.previousMachineState
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

      // Entering reconnecting.waiting schedules the next attempt in the state machine.
      // Emit reconnect diagnostics once per waiting entry.
      if (this.didEnterReconnectingSubstate(previousState, stateValue, 'waiting')) {
        const { reconnectAttempt, nextRetryDelayMs } = snapshot.context
        this.stores.console.addEvent(
          `Reconnecting (attempt ${reconnectAttempt}, delay ${Math.round(nextRetryDelayMs / 1000)}s)`,
          'connection'
        )
        logInfo(`Reconnecting (attempt ${reconnectAttempt}, delay ${Math.round(nextRetryDelayMs / 1000)}s)`)
        this.deps.emitSDK('connection:status', { status: 'reconnecting' })
        this.deps.emitSDK('connection:reconnecting', { attempt: reconnectAttempt, delayMs: nextRetryDelayMs })
        this.emit('reconnecting', reconnectAttempt, nextRetryDelayMs)
      }

      // Entering reconnecting.attempting is the single place we start a reconnect try.
      if (this.didEnterReconnectingSubstate(previousState, stateValue, 'attempting')) {
        void this.attemptReconnect()
      }

      this.previousMachineState = stateValue
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

  /** Check whether a machine state is a specific reconnecting substate. */
  private isReconnectingSubstate(
    state: ConnectionStateValue,
    substate: 'waiting' | 'attempting'
  ): boolean {
    return typeof state === 'object' && 'reconnecting' in state && state.reconnecting === substate
  }

  /** Detect entry into a reconnecting substate. */
  private didEnterReconnectingSubstate(
    previous: ConnectionStateValue,
    current: ConnectionStateValue,
    substate: 'waiting' | 'attempting'
  ): boolean {
    return !this.isReconnectingSubstate(previous, substate) && this.isReconnectingSubstate(current, substate)
  }

  /** Detect the local Rust proxy WebSocket endpoint format. */
  private isLocalProxyServer(server: string): boolean {
    return server.startsWith('ws://127.0.0.1:') || server.startsWith('ws://[::1]:')
  }

  /**
   * Persist current SM state to storage synchronously.
   * Call this before page unload to capture the latest inbound counter.
   *
   * Uses synchronous sessionStorage write to ensure the write completes
   * before the page unloads. Also persists joined rooms for fallback rejoin.
   */
  persistSmStateNow(): void {
    if (!this.credentials?.jid) return

    // Get latest SM state from live client (updates cache)
    this.smPersistence.getState(this.xmpp)

    // Filter out quickchat rooms — they're transient and won't exist after everyone leaves
    const joinedRooms = (this.stores.room.joinedRooms() ?? [])
      .filter(room => !room.isQuickChat)
      .map(room => ({
        jid: room.jid,
        nickname: room.nickname,
        password: room.password,
        autojoin: room.autojoin,
      }))

    this.smPersistence.persistNow(this.credentials.jid, this.credentials.resource || '', joinedRooms)
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
    const useProxy = this.proxyManager.hasProxy && !userProvidedWebSocketUrl

    // Debug logging
    this.stores.console.addEvent(
      `Connection setup: hasProxy=${this.proxyManager.hasProxy}, userProvidedWebSocketUrl=${userProvidedWebSocketUrl}, isExplicitTcpUri=${isExplicitTcpUri}, server="${server}"`,
      'connection'
    )

    // Resolve server URL:
    // - With proxy adapter: delegate to ProxyManager (handles URI parsing, SRV, fallback)
    // - Without proxy or explicit WebSocket URL: Perform WebSocket URL resolution
    let resolvedServer: string
    let connectionMethod: ConnectionMethod = 'websocket'
    if (useProxy) {
      // Proxy mode: ensure always-on proxy is running (idempotent)
      const result = await this.proxyManager.ensureProxy(server, getDomain(jid), skipDiscovery)
      resolvedServer = result.server
      connectionMethod = result.connectionMethod
    } else if (isExplicitTcpUri) {
      // tls:// or tcp:// URI without proxy — not usable, fall back to domain
      this.stores.console.addEvent(`TCP URI "${server}" not usable without proxy, falling back to WebSocket discovery`, 'connection')
      resolvedServer = shouldSkipDiscovery('', skipDiscovery)
        ? getWebSocketUrl('', getDomain(jid))
        : await resolveWebSocketUrl('', getDomain(jid), this.stores.console)
    } else {
      // WebSocket mode: resolve WebSocket URL via discovery
      resolvedServer = shouldSkipDiscovery(server, skipDiscovery)
        ? getWebSocketUrl(server, getDomain(jid))
        : await resolveWebSocketUrl(server, getDomain(jid), this.stores.console)
    }

    // Store connection method for display
    this.stores.connection.setConnectionMethod(connectionMethod)

    // Store credentials for potential reconnection (with resolved URL)
    this.credentials = { jid, password, server: resolvedServer, resource, lang, disableSmKeepalive }

    // Load SM state and joined rooms from storage if not provided (for session resumption across page reloads)
    // Note: Only await if storage adapter exists to avoid blocking tests using fake timers
    let effectiveSmState = smState
    let effectiveJoinedRooms = previouslyJoinedRooms
    if (this.storageAdapter) {
      const storedState = await this.smPersistence.load(jid)
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

    // ── Synchronous phase ──
    // All state transitions happen BEFORE any await, so the UI sees
    // 'disconnected' immediately and callers can safely chain cleanup
    // (e.g. clearLocalData) without racing with async steps below.

    // Capture references needed for async cleanup before nulling them
    const clientToStop = this.xmpp
    const jidForSmCleanup = this.credentials?.jid

    if (clientToStop) {
      this.xmpp = null
    }
    this.credentials = null

    // Ensure presence machine and listeners get a deterministic disconnect signal
    // even when socket close events are ignored as stale.
    this.onDisconnect?.()

    this.stores.connection.setStatus('disconnected')
    this.stores.connection.setJid(null)
    this.stores.connection.setConnectionMethod(null)
    this.stores.console.addEvent('Disconnected', 'connection')
    this.deps.emitSDK('connection:status', { status: 'offline' })

    // ── Async cleanup phase ──
    // SM persistence, room message flush, and XMPP stream close.
    // Safe to run after UI has transitioned.

    this.smPersistence.clearCache()
    if (jidForSmCleanup) {
      try {
        let timedOut = false
        await Promise.race([
          this.smPersistence.clear(jidForSmCleanup),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              timedOut = true
              resolve()
            }, DISCONNECT_CLEANUP_TIMEOUT_MS)
          }),
        ])
        if (timedOut) {
          logWarn(`Disconnect cleanup: SM state clear timed out after ${DISCONNECT_CLEANUP_TIMEOUT_MS}ms`)
          this.stores.console.addEvent('Disconnect cleanup warning: SM state clear timed out', 'error')
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logWarn(`Disconnect cleanup: failed to clear SM state for ${jidForSmCleanup}: ${message}`)
        this.stores.console.addEvent(`Disconnect cleanup warning: failed to clear SM state (${message})`, 'error')
      }
    }

    try {
      let timedOut = false
      await Promise.race([
        flushPendingRoomMessages(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true
            resolve()
          }, DISCONNECT_CLEANUP_TIMEOUT_MS)
        }),
      ])
      if (timedOut) {
        logWarn(`Disconnect cleanup: room message flush timed out after ${DISCONNECT_CLEANUP_TIMEOUT_MS}ms`)
        this.stores.console.addEvent('Disconnect cleanup warning: room message flush timed out', 'error')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logWarn(`Disconnect cleanup: failed to flush room message buffer: ${message}`)
      this.stores.console.addEvent(`Disconnect cleanup warning: failed to flush message cache (${message})`, 'error')
    }

    if (clientToStop) {
      flushSmAckDebounce(this.smPatchState, clientToStop)
      try {
        await withTimeout(clientToStop.stop(), CLIENT_STOP_TIMEOUT_MS)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logWarn(`Disconnect cleanup: client stop failed: ${message}`)
        this.stores.console.addEvent(`Disconnect cleanup warning: socket close failed (${message})`, 'error')
      } finally {
        // Ensure the old transport is really closed. A graceful stop can return
        // while the underlying socket is still lingering, which delays a fast
        // manual re-login on the same resource.
        forceDestroyClient(clientToStop)
      }
    }
  }

  /**
   * Cancel any pending reconnection attempts.
   */
  cancelReconnect(): void {
    // Signal machine: cancel reconnect → transitions to disconnected
    this.connectionActor.send({ type: 'CANCEL_RECONNECT' })
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

    // Signal machine: skip waiting, go directly to attempting.
    // The state-machine subscription starts the reconnect attempt.
    this.connectionActor.send({ type: 'TRIGGER_RECONNECT' })
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
    return this.smPersistence.getState(this.xmpp)
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
      if (isDeadSocketError(errorMessage) || errorMessage.includes('timeout')) {
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
        ;(this.xmpp as any)?.off?.('disconnect', handleDisconnect)
      }

      // Listen for <a/> nonza - defined as a hoisted function for cleanup reference
      const handleNonza = (nonza: Element) => {
        if (nonza.is('a', 'urn:xmpp:sm:3') && !resolved) {
          resolved = true
          cleanup(timeoutId)
          resolve(true)
        }
      }

      // Abort immediately if socket disconnects during verification
      const handleDisconnect = () => {
        if (!resolved) {
          resolved = true
          cleanup(timeoutId)
          resolve(false)
        }
      }

      ;(this.xmpp as any)?.on?.('nonza', handleNonza)
      ;(this.xmpp as any)?.on?.('disconnect', handleDisconnect)

      // Timeout - must be set up before send() to be in scope for cleanup
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          ;(this.xmpp as any)?.off?.('nonza', handleNonza)
          ;(this.xmpp as any)?.off?.('disconnect', handleDisconnect)
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
    // Don't reconnect from terminal states.
    if (this.isInTerminalState()) {
      return
    }
    const machineState = this.getMachineState()
    if (machineState === 'disconnected' || machineState === 'idle') {
      return
    }

    // If we're not already reconnecting, transition now.
    // When VERIFY_FAILED already moved the machine to reconnecting, we still need
    // the cleanup side effects below.
    if (!this.isInReconnectingState()) {
      this.stores.console.addEvent('Dead connection detected, will reconnect', 'connection')
      logWarn('Dead connection detected, will reconnect')

      // Signal machine: SOCKET_DIED → transitions to reconnecting.waiting
      // (incrementAttempt action computes backoff delay)
      this.connectionActor.send({ type: 'SOCKET_DIED' })
    }

    // IMPORTANT: Null the client reference SYNCHRONOUSLY before any async operations.
    // This prevents a race condition where the old client's 'online' event fires
    // during cleanup, causing handleConnectionSuccess to run and set status='online'
    // while xmpp is about to become null.
    // This matches the pattern used in disconnect().
    const clientToClean = this.xmpp
    this.xmpp = null

    // Clear any pending SM ack debounce (socket is dead, don't try to send)
    clearSmAckDebounce(this.smPatchState)
    // Forcefully destroy old client (socket is already dead, graceful stop() can hang)
    if (clientToClean) {
      forceDestroyClient(clientToClean)
    }

    // Reconnect scheduling is handled by the state machine (`reconnecting.waiting`).
    // Proxy restart is centralized in attemptReconnect() to keep start/stop
    // ordering serialized in one place.
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
            // Machine already transitioned to reconnecting — clean up dead client.
            const clientToClean = this.xmpp
            this.xmpp = null
            clearSmAckDebounce(this.smPatchState)
            if (clientToClean) {
              forceDestroyClient(clientToClean)
            }
          } else {
            // Short sleep — verify connection health
            this.stores.console.addEvent(`System state: ${state}, verifying connection`, 'connection')
            const isHealthy = await this.verifyConnection()
            if (!isHealthy && !this.isInReconnectingState()) {
              // Only trigger reconnection if the disconnect handler hasn't already done so
              // during the async verifyConnection() await
              this.stores.console.addEvent('Connection dead after wake, reconnecting...', 'connection')
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
          this.smPersistence.updateCache(sm.id, sm.inbound || 0)
          // Persist to storage for session resumption across page reloads
          if (this.credentials?.jid) {
            void this.smPersistence.persist(this.credentials.jid, this.credentials.resource || '')
          }
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
          this.smPersistence.updateCache(sm.id, sm.inbound || 0)
          // Persist to storage for session resumption across page reloads
          if (this.credentials?.jid) {
            void this.smPersistence.persist(this.credentials.jid, this.credentials.resource || '')
          }
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
        this.smPersistence.updateCache(previd, inbound)
        // Persist to storage for session resumption across page reloads
        if (this.credentials?.jid) {
          void this.smPersistence.persist(this.credentials.jid, this.credentials.resource || '')
        }

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

    // Handle disconnect during connection handshake.
    // If the socket closes before 'online' or 'error' fires (e.g., proxy TCP
    // connect failed, network not ready after wake), reject immediately instead
    // of waiting for the 30s reconnect attempt timeout.
    ;(this.xmpp as any).on('disconnect', () => {
      if (resolved) return
      resolved = true
      onError(new Error('Socket disconnected during connection handshake'))
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

    // Handle stream errors (including resource conflict and server shutdown)
    this.xmpp.on('error', (err: Error) => {
      const message = err.message?.toLowerCase() || ''
      logInfo(`Stream error: ${message}`)

      // Detect resource conflict (another client logged in with same resource)
      if (message.includes('conflict')) {
        this.connectionActor.send({ type: 'CONFLICT' })
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
        this.stores.console.addEvent('Disconnected: Authentication error', 'error')
        console.error('[XMPP] Authentication failed: not-authorized')
        this.credentials = null
      } else if (message.includes('system-shutdown') || message.includes('reset')) {
        // Server is restarting — proactively clean up and reconnect.
        // xmpp.js calls disconnect() fire-and-forget on stream errors, which creates
        // a complex race with the incoming <close/> frame. By handling the error here,
        // we null the client reference immediately, preventing the disconnect handler
        // from firing when xmpp.js's own disconnect() completes later.
        this.stores.console.addEvent('Server restarting (system-shutdown), will reconnect', 'connection')
        logInfo('Server restart detected (system-shutdown), initiating proactive reconnect')

        // Notify disconnect handler (for presence machine, etc.)
        this.onDisconnect?.()

        const clientToClean = this.xmpp
        this.xmpp = null
        clearSmAckDebounce(this.smPatchState)

        this.connectionActor.send({ type: 'SOCKET_DIED' })

        // Forcefully destroy old client — strip listeners and close socket
        // to prevent stale events from interfering with reconnection
        if (clientToClean) {
          forceDestroyClient(clientToClean)
        }
      } else if (message.includes('econnerror') || isDeadSocketError(message)) {
        // Transport is definitively broken (commonly reported as "websocket econnerror"
        // when the Rust proxy bridge dies). Trigger dead-socket recovery immediately
        // instead of waiting for disconnect-event ordering.
        this.stores.console.addEvent('Stream transport error, forcing reconnect recovery', 'connection')
        logWarn('Stream transport error detected, initiating dead-socket recovery')
        this.handleDeadSocket()
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
    //
    // Capture current client reference for stale-client detection.
    // When the error handler (e.g., system-shutdown) nulls this.xmpp and starts
    // reconnection, the old client's async disconnect() still fires 'disconnect'
    // events. Without this guard, those stale events would interfere with the
    // reconnect already in progress.
    const registeredClient = this.xmpp
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

      // Guard: ignore events from clients that have been replaced or cleaned up.
      // This happens when the error handler (system-shutdown, etc.) already nulled
      // this.xmpp and started reconnection — the old client's async disconnect()
      // fires 'disconnect' later, but we must not act on it.
      if (this.xmpp !== registeredClient) {
        const machineState = this.getMachineState()
        const machineStateText = JSON.stringify(machineState)
        const isExpectedBridgeClose = wasClean
          && rawReason
          && typeof rawReason === 'object'
          && 'code' in rawReason
          && (rawReason as { code: number }).code === 1000
          && 'reason' in rawReason
          && (rawReason as { reason?: string }).reason === 'Bridge closed'
        if (!isExpectedBridgeClose) {
          logInfo(`Disconnect from stale client, ignoring (state=${machineStateText}${closeInfo})`)
          this.stores.console.addEvent(
            `Socket closed (stale client, state=${machineStateText}, ignoring)`,
            'connection'
          )
        }

        // Recovery fallback: if the machine still believes we're connected
        // when a stale disconnect arrives, force reconnect transition instead
        // of silently staying in a wedged connected state.
        if (typeof machineState === 'object' && 'connected' in machineState) {
          logWarn(`Stale disconnect arrived while machine still connected (state=${JSON.stringify(machineState)}${closeInfo})`)
          this.stores.console.addEvent(
            'Socket closed from stale client while connected, forcing reconnect recovery',
            'connection'
          )
          this.connectionActor.send({ type: 'SOCKET_DIED' })
        }
        return
      }

      // Notify disconnect handler (for presence machine, etc.)
      // Skip during reconnection - we're not truly disconnected, just cycling the socket
      if (!this.isInReconnectingState()) {
        this.onDisconnect?.()
      }

      // The machine state determines what to do on socket disconnect.
      // Terminal states (conflict, auth) and disconnected state are already handled
      // by the error handler or disconnect() method above.
      const machineState = this.getMachineState()
      logInfo(`Disconnect handler: machineState=${JSON.stringify(machineState)}`)

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
          const isProxyMode = this.proxyManager.hasProxy
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
          console.warn(`[XMPP] Initial connection failed (clean: ${wasClean}, reason: ${reason || 'unknown'}). Server: ${this.proxyManager.getOriginalServer() || 'unknown'}`)
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
        logInfo('Unexpected disconnect, initiating reconnect')
        this.connectionActor.send({ type: 'SOCKET_DIED' })

        // Null the client reference synchronously to prevent race conditions:
        // - verifyConnection() may be awaiting and will see xmpp=null, returning false fast
        // - attemptReconnect() won't try to check status of dead client
        this.xmpp = null
        clearSmAckDebounce(this.smPatchState)
        // Don't call stop() on the old client — it's already cleaning itself up
        // via xmpp.js's own disconnect(). Calling stop() triggers a second disconnect()
        // on the same client, causing duplicate state transitions and event emissions.
      }
    })

    // Handle final offline state (only after stop() is called)
    // This is the terminal state - no reconnection will happen
    this.xmpp.on('offline', () => {
      logInfo('Client offline event fired')
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
   * Attempt to reconnect with saved credentials.
   *
   * Called when the machine enters `reconnecting.attempting`.
   */
  private async attemptReconnect(): Promise<void> {
    logInfo('attemptReconnect: starting')
    this.stores.console.addEvent(
      `Reconnect attempt starting (state=${JSON.stringify(this.getMachineState())})`,
      'connection'
    )

    // Guard: only attempt from reconnecting.attempting with credentials.
    const machineState = this.getMachineState()
    if (!this.credentials || !this.isReconnectingSubstate(machineState, 'attempting')) {
      logInfo('attemptReconnect: guard failed (no credentials or not in reconnecting.attempting)')
      return
    }

    try {
      // Defensive check: verify xmpp.js client is not already online.
      // This shouldn't happen in normal flow, but guards against edge cases.
      if (this.xmpp && (this.xmpp as any).status === 'online') {
        this.stores.console.addEvent('Connection still online - cancelling reconnect attempt', 'connection')
        this.connectionActor.send({ type: 'CONNECTION_SUCCESS' })
        return
      }

      // Emit SDK event for connecting status (machine is in reconnecting.attempting)
      this.deps.emitSDK('connection:status', { status: 'connecting' })

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

      // Clean up old client (the proxy stays running — each new WS connection
      // creates a fresh TCP/TLS connection with independent DNS resolution)
      this.cleanupClient()
      logInfo('attemptReconnect: old client cleaned up')

      // In desktop proxy mode, force-refresh the proxy before each reconnect
      // attempt to recover from local ws://[::1]:PORT listener failures.
      let reconnectOptions = this.credentials
      if (this.proxyManager.hasProxy && this.isLocalProxyServer(reconnectOptions.server)) {
        const domain = getDomain(reconnectOptions.jid)
        const proxyServer = this.proxyManager.getOriginalServer() || domain
        const proxyRefreshStart = Date.now()
        this.stores.console.addEvent(
          `Reconnect: refreshing proxy endpoint (target=${proxyServer})`,
          'connection'
        )
        const refreshed = await this.proxyManager.restartProxy(proxyServer, domain)
        const proxyRefreshMs = Date.now() - proxyRefreshStart
        reconnectOptions = { ...reconnectOptions, server: refreshed.server }
        this.credentials = reconnectOptions
        this.stores.connection.setConnectionMethod(refreshed.connectionMethod)
        this.stores.console.addEvent(
          `Reconnect: proxy refreshed in ${proxyRefreshMs}ms -> ${refreshed.server}`,
          'connection'
        )
        logInfo(`attemptReconnect: proxy refreshed (${refreshed.server}) in ${proxyRefreshMs}ms`)
      }

      // Create new client with stored credentials (proxy URL is still valid)
      this.xmpp = this.createXmppClient(reconnectOptions)
      this.hydrateStreamManagement(smState ?? undefined)
      this.setupHandlers()
      logInfo('attemptReconnect: new client created, calling start()')

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
    }
  }

  /**
   * Clean up the current XMPP client connection.
   * Used before reconnecting or when detecting a dead socket.
   *
   * IMPORTANT: Nulls this.xmpp FIRST to prevent race conditions where
   * the old client fires events during cleanup. This matches the pattern
   * used in disconnect().
   *
   * Uses forceful cleanup instead of graceful stop():
   * - Strips all event listeners to prevent stale events
   * - Force-closes the socket without waiting for XMPP stream close
   * - This avoids hangs when xmpp.js stop() blocks on a dead socket
   */
  private cleanupClient(): void {
    const clientToClean = this.xmpp
    if (!clientToClean) {
      logInfo('cleanupClient: no client to clean')
      return
    }

    logInfo('cleanupClient: stopping old client')

    // Null the reference FIRST to prevent race conditions
    this.xmpp = null

    // Clear any pending SM ack debounce timer
    clearSmAckDebounce(this.smPatchState)

    // Forcefully destroy the old client
    forceDestroyClient(clientToClean)

    logInfo('cleanupClient: old client cleaned up (forceful)')
  }

}
