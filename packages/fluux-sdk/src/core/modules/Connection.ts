import { client, Client, Element, xml } from '@xmpp/client'
import { getMechanism } from '@xmpp/client/lib/createOnAuthenticate.js'
import { createActor } from 'xstate'
import { BaseModule, type ModuleDependencies } from './BaseModule'
import type { ConnectOptions, ConnectionMethod } from '../types'
import { getBareJid, getDomain, getLocalPart, getResource } from '../jid'
import { getClientIdentity, CLIENT_FEATURES } from '../caps'
import { NS_DISCO_INFO, NS_PING, NS_TIME } from '../namespaces'
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
  type ConnectionMachineEvent,
  type ConnectionStateValue,
} from '../connectionMachine'
import {
  withTimeout,
  forceDestroyClient,
  isDeadSocketError,
} from './connectionUtils'
import {
  DIRECT_WEBSOCKET_PRECHECK_TIMEOUT_MS,
  CLIENT_STOP_TIMEOUT_MS,
  DISCONNECT_CLEANUP_TIMEOUT_MS,
  NETWORK_READY_TIMEOUT_MS,
  NETWORK_SETTLE_DELAY_MS,
  RECONNECT_ATTEMPT_TIMEOUT_MS,
  SASL_AUTH_TIMEOUT_MS,
  VERIFY_CONNECTION_TIMEOUT_MS,
  WAKE_VERIFY_TIMEOUT_MS,
} from './connectionTimeouts'
import {
  shouldSkipDiscovery,
  getWebSocketUrl,
  discoverWebSocketUrl,
  FAST_XEP0156_DISCOVERY_TIMEOUT_MS,
  resolveWebSocketUrl,
} from './serverResolution'
import { SmPersistence } from './smPersistence'
import { fetchFastToken, saveFastToken, deleteFastToken } from '../fastTokenStorage'
import { ProxyManager } from './proxyManager'
import { isConnectionTraceEnabled } from './connectionDiagnostics'

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

// Stream/SASL auth failures are terminal and should not be retried.
// Keep this list explicit to avoid classifying generic stanza `type="auth"`
// errors (e.g. PEP/pubsub permissions) as account authentication failures.
const AUTH_STREAM_ERROR_MARKERS = [
  'not-authorized',
  'invalid-authzid',
  'invalid-mechanism',
  'mechanism-too-weak',
  'credentials-expired',
  'temporary-auth-failure',
]

const isAuthStreamError = (message: string): boolean =>
  AUTH_STREAM_ERROR_MARKERS.some(marker => message.includes(marker))

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

  // Set by handleDeadSocket to signal that error recovery is already in progress.
  // Prevents setupConnectionHandlers' error handler from rejecting the connection
  // promise and sending CONNECTION_ERROR that would disrupt the new reconnect.
  private deadSocketRecoveryInProgress = false

  // Timestamp of last wake-from-sleep event. Used by attemptReconnect to add a
  // short settle delay — navigator.onLine goes true before the network path is
  // fully functional (DNS, TLS, Wi-Fi re-association), causing SASL timeouts.
  private lastWakeTimestamp = 0

  // Timestamp when the connection was lost (set in handleDeadSocket).
  // Used to compute disconnect duration and pass it to XMPPClient so SM
  // resumption can skip heavy room refresh for short disconnects.
  private disconnectedAtTimestamp = 0

  // Callback for post-connection setup (roster, presence, carbons, etc.)
  private onConnectionSuccess?: (isResumption: boolean, previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>, disconnectDurationMs?: number) => Promise<void>

  // Callback for disconnect notification
  private onDisconnect?: () => void

  // Callback for stanza routing
  private onStanza?: (stanza: Element) => void

  // Track previous machine state to detect state-entry side effects
  private previousMachineState: ConnectionStateValue = 'idle'
  private disconnectOperationSeq = 0

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

      const previousText = JSON.stringify(previousState)
      const currentText = JSON.stringify(stateValue)
      if (previousText !== currentText) {
        const transitionMessage = `Machine transition: ${previousText} -> ${currentText} (attempt=${attempt}, target=${reconnectTargetTime ?? 'none'}, error=${snapshot.context.lastError ?? 'none'})`
        this.logTrace(transitionMessage)
      }

      // Sync status to store
      const isVerifying = typeof stateValue === 'object' && 'connected' in stateValue && stateValue.connected === 'verifying'
      this.stores.connection.setStatus(status)
      this.stores.connection.setIsVerifying(isVerifying)
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
        this.attemptReconnect().catch((err) => {
          // Safety net: if attemptReconnect() rejects with an unhandled error
          // (e.g., exception in cleanup or outside the inner try/catch), ensure
          // the machine always exits the 'attempting' state.
          const errorMsg = err instanceof Error ? err.message : String(err)
          logErr(`attemptReconnect: unhandled rejection: ${errorMsg}`)
          this.sendMachineEvent(
            { type: 'CONNECTION_ERROR', error: errorMsg },
            'attemptReconnect:unhandled-rejection'
          )
        })
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

  /** Emit verbose connection diagnostics only when trace mode is enabled. */
  private logTrace(message: string): void {
    if (!isConnectionTraceEnabled()) return
    this.stores.console.addEvent(message, 'connection')
    logInfo(message)
  }

  /**
   * Send an event to the connection state machine with verbose transition logging.
   */
  private sendMachineEvent(event: ConnectionMachineEvent, source: string): void {
    const before = this.getMachineState()
    this.connectionActor.send(event)
    const after = this.getMachineState()
    const beforeText = JSON.stringify(before)
    const afterText = JSON.stringify(after)
    const message = `Machine event ${event.type} from ${source}: ${beforeText} -> ${afterText}`
    this.logTrace(message)
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
  setConnectionSuccessHandler(handler: (isResumption: boolean, previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>, disconnectDurationMs?: number) => Promise<void>): void {
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
   * - A domain name (example.com)
   *   - Web/no-proxy: XEP-0156 discovery, then fallback to wss://{domain}/ws
   *   - Desktop with proxy: fast XEP-0156 check only, then fallback to TCP/SRV via proxy
   */
  async connect({ jid, password, server, resource, smState, lang, previouslyJoinedRooms, skipDiscovery, disableSmKeepalive, rememberSession, autoRetryOnTransientFailure }: ConnectOptions): Promise<void> {
    // Guard: if already connecting, connected, or reconnecting, ignore the call.
    // This prevents double-connect races (e.g., rapid button clicks, concurrent
    // auto-connect paths) that would create two XMPP sockets binding the same
    // resource, leading to a conflict ping-pong loop.
    const currentState = this.getMachineState()
    if (currentState === 'connecting' || this.isInConnectedState() || this.isInReconnectingState()) {
      logInfo(`connect() ignored: already in state ${JSON.stringify(currentState)}`)
      return
    }

    // Signal the machine that a user-initiated connection is starting.
    // CONNECT transitions to `connecting` from idle, disconnected, and terminal states.
    this.sendMachineEvent({ type: 'CONNECT' }, 'connect:start')

    // Tell the machine whether to auto-retry transient transport failures
    // during the initial `connecting` state. Sent AFTER CONNECT so the flag
    // survives resetReconnectState actions that fire on terminal→connecting
    // or similar transitions. The guard reads retryInitialFailure from
    // context when CONNECTION_ERROR is eventually dispatched.
    this.sendMachineEvent(
      { type: 'SET_RETRY_INITIAL', retry: autoRetryOnTransientFailure === true },
      'connect:set-retry-initial'
    )

    // Emit SDK event for connection starting
    this.deps.emitSDK('connection:status', { status: 'connecting' })

    // Check connection mode
    const domain = getDomain(jid)
    const userProvidedWebSocketUrl = server.startsWith('ws://') || server.startsWith('wss://')
    // tls:// and tcp:// URIs are explicit server specs for the proxy (not WebSocket URLs)
    const isExplicitTcpUri = server.startsWith('tls://') || server.startsWith('tcp://')
    const canUseProxy = this.proxyManager.hasProxy && !userProvidedWebSocketUrl
    const preferWebSocketFirst = canUseProxy && !isExplicitTcpUri

    // Debug logging
    this.stores.console.addEvent(
      `Connection setup: hasProxy=${this.proxyManager.hasProxy}, userProvidedWebSocketUrl=${userProvidedWebSocketUrl}, isExplicitTcpUri=${isExplicitTcpUri}, preferWebSocketFirst=${preferWebSocketFirst}, server="${server}"`,
      'connection'
    )

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

    const resolveDirectWebSocket = async (): Promise<string | null> => {
      // Proxy-capable desktop path: check XEP-0156 only with a short timeout.
      // If no endpoint is advertised, immediately switch to TCP/SRV proxy.
      if (preferWebSocketFirst) {
        // In Tauri proxy-capable mode we only try WebSocket when explicitly
        // configured by the app (already a ws:// / wss:// URL) or discovered
        // via XEP-0156. For plain domains with skipDiscovery enabled, do not
        // synthesize a default wss://domain/ws URL; switch directly to proxy.
        if (skipDiscovery === true) {
          this.stores.console.addEvent(
            'Connection strategy: skipDiscovery enabled on proxy-capable desktop, switching directly to SRV/proxy',
            'connection'
          )
          return null
        }
        return discoverWebSocketUrl(
          server,
          domain,
          this.stores.console,
          FAST_XEP0156_DISCOVERY_TIMEOUT_MS
        )
      }
      if (shouldSkipDiscovery(server, skipDiscovery)) {
        return getWebSocketUrl(server, domain)
      }
      return resolveWebSocketUrl(server, domain, this.stores.console)
    }

    const attemptConnection = async (resolvedServer: string, connectionMethod: ConnectionMethod): Promise<void> => {
      this.stores.connection.setConnectionMethod(connectionMethod)
      this.credentials = { jid, password, server: resolvedServer, resource, lang, disableSmKeepalive, rememberSession }
      this.xmpp = this.createXmppClient({ jid, password, server: resolvedServer, resource, lang, rememberSession })
      this.hydrateStreamManagement(effectiveSmState)
      this.setupHandlers()

      await new Promise<void>((resolve, reject) => {
        this.setupConnectionHandlers(
          async (isResumption) => {
            // Signal machine: initial connection succeeded
            this.sendMachineEvent({ type: 'CONNECTION_SUCCESS' }, 'connect:connection-success')
            try {
              await this.handleConnectionSuccess(isResumption, `Connected as ${jid}`, effectiveJoinedRooms)
              resolve()
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          },
          (err) => reject(err)
        )
      })
    }

    try {
      // Preferred path on desktop for domain inputs:
      // 1) try direct WebSocket first (XEP-0156 discovery only),
      // 2) then fall back to SRV/proxy only if direct WebSocket fails.
      // The winning endpoint is persisted in this.credentials.server and reused
      // by reconnect attempts so we avoid repeating discovery/SRV checks each time.
      if (preferWebSocketFirst) {
        const directWebSocketUrl = await resolveDirectWebSocket()
        if (directWebSocketUrl) {
          this.stores.console.addEvent(
            `Connection strategy: trying direct WebSocket first (${directWebSocketUrl})`,
            'connection'
          )

          try {
            const timeoutSentinel = Symbol('direct-ws-precheck-timeout')
            const result = await Promise.race([
              attemptConnection(directWebSocketUrl, 'websocket').then(
                () => ({ ok: true as const }),
                (error) => ({ ok: false as const, error })
              ),
              new Promise<typeof timeoutSentinel>((resolve) => {
                setTimeout(() => resolve(timeoutSentinel), DIRECT_WEBSOCKET_PRECHECK_TIMEOUT_MS)
              }),
            ])

            if (result === timeoutSentinel) {
              throw new Error(
                `Direct WebSocket pre-check timed out after ${DIRECT_WEBSOCKET_PRECHECK_TIMEOUT_MS}ms`
              )
            }

            if (!result.ok) {
              throw result.error
            }

            return
          } catch (webSocketError) {
            const errorMsg = webSocketError instanceof Error ? webSocketError.message : String(webSocketError)
            if (this.isInTerminalState()) {
              throw webSocketError
            }
            this.stores.console.addEvent(
              `Direct WebSocket connection failed (${errorMsg}), falling back to SRV/proxy`,
              'error'
            )
            this.cleanupClient()
          }
        } else {
          const xepFallbackMessage =
            `XEP-0156 discovery returned no WebSocket endpoint for ${server || domain}, switching to SRV/proxy`
          this.stores.console.addEvent(
            `Connection strategy: ${xepFallbackMessage}`,
            'connection'
          )
          logInfo(xepFallbackMessage)
        }

        const proxyFallback = await this.proxyManager.ensureProxy(server, domain, skipDiscovery)
        this.stores.console.addEvent(
          `Connection strategy: retrying via proxy (${proxyFallback.server})`,
          'connection'
        )
        await attemptConnection(proxyFallback.server, proxyFallback.connectionMethod)
        return
      }

      if (canUseProxy) {
        // Explicit tcp:// or tls:// inputs should remain proxy-first.
        const proxyResult = await this.proxyManager.ensureProxy(server, domain, skipDiscovery)
        await attemptConnection(proxyResult.server, proxyResult.connectionMethod)
        return
      }

      if (isExplicitTcpUri) {
        // tls:// or tcp:// URI without proxy — not usable, fall back to domain
        this.stores.console.addEvent(`TCP URI "${server}" not usable without proxy, falling back to WebSocket discovery`, 'connection')
        const fallbackWebSocket = shouldSkipDiscovery('', skipDiscovery)
          ? getWebSocketUrl('', domain)
          : await resolveWebSocketUrl('', domain, this.stores.console)
        await attemptConnection(fallbackWebSocket, 'websocket')
        return
      }

      const directWebSocketUrl = await resolveDirectWebSocket()
      if (!directWebSocketUrl) {
        throw new Error('No WebSocket endpoint discovered via XEP-0156')
      }
      await attemptConnection(directWebSocketUrl, 'websocket')
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      logError('Connection error:', error.message)
      logErr(`Connection error: ${error.message}`)
      // Signal machine: initial connection failed. The machine's `connecting`
      // state routes CONNECTION_ERROR either to terminal.initialFailure
      // (default), to reconnecting.waiting (when SET_RETRY_INITIAL was set
      // to true by the caller), or — if a CONFLICT/AUTH_ERROR fired
      // synchronously from the stream-error handler — the machine is
      // already in a terminal state and CONNECTION_ERROR is ignored.
      this.sendMachineEvent({ type: 'CONNECTION_ERROR', error: error.message }, 'connect:connection-error')
      this.stores.console.addEvent(`Connection error: ${error.message}`, 'error')
      // Emit SDK event for connection error
      this.deps.emitSDK('connection:status', { status: 'error', error: error.message })
      this.emit('error', error)
      // Decide whether to throw based on the machine's POST-event state.
      // If the machine is in reconnecting.* the retry loop owns the outcome
      // and callers should not clear credentials. For terminal states or
      // disconnected, throw so callers see the failure.
      if (this.isInReconnectingState()) {
        return
      }
      throw error
    }
  }

  /**
   * Disconnect from XMPP server.
   */
  async disconnect(): Promise<void> {
    const disconnectOp = ++this.disconnectOperationSeq
    const disconnectStart = Date.now()
    const logDisconnect = (message: string) => {
      const elapsed = Date.now() - disconnectStart
      const line = `Disconnect op#${disconnectOp} +${elapsed}ms: ${message}`
      this.logTrace(line)
    }

    logDisconnect(`begin (state=${JSON.stringify(this.getMachineState())}, hasClient=${!!this.xmpp}, hasCredentials=${!!this.credentials})`)

    // Signal machine: user-initiated disconnect
    this.sendMachineEvent({ type: 'DISCONNECT' }, 'disconnect:user')

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
    this.stores.connection.setAuthMechanism(null)
    this.stores.console.addEvent('Disconnected', 'connection')
    this.deps.emitSDK('connection:status', { status: 'offline' })
    logDisconnect('sync phase complete (store transitioned to disconnected)')

    // ── Async cleanup phase ──
    // SM persistence, room message flush, and XMPP stream close.
    // Safe to run after UI has transitioned.

    this.smPersistence.clearCache()
    logDisconnect('SM in-memory cache cleared')
    if (jidForSmCleanup) {
      logDisconnect(`clearing persisted SM state for ${jidForSmCleanup}`)
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
          logDisconnect('persisted SM state clear timed out')
        } else {
          logDisconnect('persisted SM state clear complete')
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logWarn(`Disconnect cleanup: failed to clear SM state for ${jidForSmCleanup}: ${message}`)
        this.stores.console.addEvent(`Disconnect cleanup warning: failed to clear SM state (${message})`, 'error')
        logDisconnect(`persisted SM state clear failed (${message})`)
      }
    }

    logDisconnect('flushing pending room message cache')
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
        logDisconnect('room message flush timed out')
      } else {
        logDisconnect('room message flush complete')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logWarn(`Disconnect cleanup: failed to flush room message buffer: ${message}`)
      this.stores.console.addEvent(`Disconnect cleanup warning: failed to flush message cache (${message})`, 'error')
      logDisconnect(`room message flush failed (${message})`)
    }

    if (clientToStop) {
      logDisconnect('stopping xmpp client (non-blocking)')
      flushSmAckDebounce(this.smPatchState, clientToStop)

      // Start graceful stop in background but never block disconnect() completion on it.
      // On Linux/proxy paths, xmpp.js stop can stall even after the machine is already
      // in disconnected state, which leaves UI flows waiting on a promise that should
      // only be best-effort cleanup.
      try {
        const stopPromise = clientToStop.stop()
        void withTimeout(stopPromise, CLIENT_STOP_TIMEOUT_MS)
          .then(() => {
            logDisconnect('xmpp client stop completed in background (or timed out safely)')
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err)
            logWarn(`Disconnect cleanup: client stop failed: ${message}`)
            this.stores.console.addEvent(`Disconnect cleanup warning: socket close failed (${message})`, 'error')
            logDisconnect(`xmpp client stop failed in background (${message})`)
          })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logWarn(`Disconnect cleanup: client stop failed: ${message}`)
        this.stores.console.addEvent(`Disconnect cleanup warning: socket close failed (${message})`, 'error')
        logDisconnect(`xmpp client stop failed to start (${message})`)
      }

      // Ensure the old transport is really closed immediately. A graceful stop can
      // return late or never, and keeping this synchronous prevents disconnect() from
      // wedging UI flows.
      forceDestroyClient(clientToStop)
      logDisconnect('force-destroyed xmpp client transport')
    }

    logDisconnect('complete')
  }

  /**
   * Cancel any pending reconnection attempts.
   */
  cancelReconnect(): void {
    // Signal machine: cancel reconnect → transitions to disconnected
    this.sendMachineEvent({ type: 'CANCEL_RECONNECT' }, 'cancelReconnect:user')
  }

  /**
   * Immediately trigger a reconnection attempt.
   *
   * Use this when the app becomes visible while in a reconnecting state,
   * since background timers may have been suspended by the browser/OS.
   * This cancels any pending scheduled reconnection attempts immediately.
   */
  triggerReconnect(): void {
    if (!this.isInReconnectingState() || !this.credentials) {
      const message = `triggerReconnect skipped (reconnecting=${this.isInReconnectingState()}, hasCredentials=${!!this.credentials}, state=${JSON.stringify(this.getMachineState())})`
      this.stores.console.addEvent(message, 'connection')
      logInfo(message)
      return
    }

    // Signal machine: skip waiting, go directly to attempting.
    // The state-machine subscription starts the reconnect attempt.
    this.sendMachineEvent({ type: 'TRIGGER_RECONNECT' }, 'triggerReconnect')
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
  async verifyConnection(timeoutMs = VERIFY_CONNECTION_TIMEOUT_MS): Promise<boolean> {
    if (!this.xmpp) return false
    const verifyStart = Date.now()

    // Transition the machine to connected.verifying if currently healthy.
    // When called from handleAwake, WAKE is already sent. When called
    // directly (e.g., client.verifyConnection()), we send WAKE here so the
    // machine state and store stay consistent.
    if (this.isInConnectedState()) {
      this.sendMachineEvent({ type: 'WAKE' }, 'verifyConnection:wake')
    }

    const result = await this.probeConnection(timeoutMs, 'verify')

    if (result === 'healthy') {
      this.sendMachineEvent({ type: 'VERIFY_SUCCESS' }, 'verifyConnection:success')
      logInfo(`Connection verified (${Date.now() - verifyStart}ms)`)
      return true
    }
    if (result === 'stale') return true // client replaced — new connection is fine

    this.stores.console.addEvent('Verification failed, reconnecting', 'connection')
    this.sendMachineEvent({ type: 'VERIFY_FAILED' }, 'verifyConnection:failed')
    this.handleDeadSocket({ source: 'verify-failed' })
    return false
  }

  /**
   * Lightweight connection health check for routine keepalive.
   *
   * Unlike {@link verifyConnection}, this does NOT transition the state machine
   * to `connected.verifying`. It silently sends an SM `<r/>` request and waits
   * for an `<a/>` acknowledgment. If the check passes, nothing happens (no
   * status change, no logging). If it fails, {@link handleDeadSocket} triggers
   * reconnection.
   *
   * Use this for periodic health checks (e.g., Rust-driven keepalive) where the
   * connection is expected to be healthy.
   */
  async verifyConnectionHealth(timeoutMs = VERIFY_CONNECTION_TIMEOUT_MS): Promise<boolean> {
    if (!this.xmpp || !this.isInConnectedState()) return false

    const result = await this.probeConnection(timeoutMs, 'keepalive')

    if (result === 'healthy') return true
    if (result === 'stale') return true

    if (!this.isInConnectedState()) return false
    this.stores.console.addEvent('Keepalive health check failed, reconnecting', 'connection')
    this.handleDeadSocket({ source: 'keepalive-failed' })
    return false
  }

  /**
   * Probe connection health via SM ack or ping fallback.
   *
   * Shared implementation for {@link verifyConnection} and
   * {@link verifyConnectionHealth}. Returns a discriminated result so the
   * caller can decide how to handle each outcome (machine transitions, logging).
   */
  private async probeConnection(
    timeoutMs: number,
    label: string
  ): Promise<'healthy' | 'dead' | 'stale'> {
    const clientAtStart = this.xmpp
    if (!clientAtStart) return 'dead'

    try {
      const sm = clientAtStart.streamManagement as any
      if (sm?.enabled) {
        const ackReceived = await this.waitForSmAck(timeoutMs)
        if (this.xmpp && this.xmpp !== clientAtStart) {
          logInfo(`${label}: client replaced during await, ignoring stale result`)
          return 'stale'
        }
        if (!ackReceived) return 'dead'
      } else {
        // Fallback: send a ping IQ and wait for response
        const iqCaller = (clientAtStart as any).iqCaller
        if (iqCaller) {
          const ping = xml(
            'iq',
            { type: 'get', id: `${label}_${Date.now()}`, to: getDomain(this.credentials?.jid || '') },
            xml('ping', { xmlns: NS_PING })
          )
          await Promise.race([
            iqCaller.request(ping),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Ping timeout')), timeoutMs)
            ),
          ])
        } else {
          // No iqCaller available — fire-and-forget ping
          const ping = xml(
            'iq',
            { type: 'get', id: `${label}_${Date.now()}` },
            xml('ping', { xmlns: NS_PING })
          )
          await clientAtStart.send(ping)
        }
      }

      // If client was replaced during the await, treat as stale
      if (this.xmpp && this.xmpp !== clientAtStart) return 'stale'
      return 'healthy'
    } catch (err) {
      if (this.xmpp && this.xmpp !== clientAtStart) return 'stale'
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (isDeadSocketError(errorMessage) || errorMessage.includes('timeout')) {
        return 'dead'
      }
      return 'dead'
    }
  }

  /**
   * Wait for a Stream Management acknowledgment (<a/>) with timeout.
   * @internal
   */
  private waitForSmAck(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      // Capture the client reference at call time. If the client is swapped
      // (reconnect), we must not act on the stale timeout — forceDestroyClient
      // strips listeners (including handleDisconnect), so the timeout is the
      // only exit path for orphaned waits.
      const client = this.xmpp
      if (!client) {
        resolve(false)
        return
      }

      let resolved = false

      // Cleanup helper
      const cleanup = (timeoutId: ReturnType<typeof setTimeout>) => {
        clearTimeout(timeoutId)
        ;(client as any)?.off?.('nonza', handleNonza)
        ;(client as any)?.off?.('disconnect', handleDisconnect)
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

      ;(client as any)?.on?.('nonza', handleNonza)
      ;(client as any)?.on?.('disconnect', handleDisconnect)

      // Timeout - must be set up before send() to be in scope for cleanup
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          ;(client as any)?.off?.('nonza', handleNonza)
          ;(client as any)?.off?.('disconnect', handleDisconnect)
          resolve(false)
        }
      }, timeoutMs)

      // Send <r/> request
      client.send(xml('r', { xmlns: 'urn:xmpp:sm:3' })).catch(() => {
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
  handleDeadSocket(options?: { immediateReconnect?: boolean; source?: string }): void {
    const immediateReconnect = options?.immediateReconnect ?? false
    const source = options?.source ?? 'unknown'

    this.logTrace(
      `Dead-socket recovery invoked (source=${source}, state=${JSON.stringify(this.getMachineState())}, reconnecting=${this.isInReconnectingState()}, hasCredentials=${!!this.credentials})`
    )

    // Don't reconnect from terminal states.
    if (this.isInTerminalState()) {
      this.stores.console.addEvent('Dead-socket recovery skipped: machine in terminal state', 'connection')
      return
    }
    const machineState = this.getMachineState()
    if (machineState === 'disconnected' || machineState === 'idle') {
      this.stores.console.addEvent(
        `Dead-socket recovery skipped: machine state is ${JSON.stringify(machineState)}`,
        'connection'
      )
      return
    }

    // Signal to setupConnectionHandlers' error handler that recovery is already
    // in progress. Must be set BEFORE cleanupClient/triggerReconnect so the
    // EventEmitter snapshot handler sees it and skips its own onError/reject.
    this.deadSocketRecoveryInProgress = true

    // Record when the connection was lost so SM resumption can measure the gap.
    if (this.disconnectedAtTimestamp === 0) {
      this.disconnectedAtTimestamp = Date.now()
    }

    // If we're not already reconnecting, transition now.
    // When VERIFY_FAILED already moved the machine to reconnecting, we still need
    // the cleanup side effects below.
    if (!this.isInReconnectingState()) {
      this.stores.console.addEvent('Dead connection detected, will reconnect', 'connection')
      logWarn('Dead connection detected, will reconnect')

      // Signal machine: SOCKET_DIED → transitions to reconnecting.waiting
      // (incrementAttempt action computes backoff delay)
      this.sendMachineEvent({ type: 'SOCKET_DIED' }, `handleDeadSocket:${source}`)
    }

    // Capture SM state into cache BEFORE cleaning up the client.
    // This ensures the cache has the latest sm.id + inbound counter
    // for session resumption in attemptReconnect().
    // Note: the state machine tracks smResumeViable — attemptReconnect reads it
    // from context to decide whether to hydrate SM state or start fresh.
    this.smPersistence.getState(this.xmpp)
    this.cleanupClient()

    if (immediateReconnect) {
      this.stores.console.addEvent(
        `Dead-socket recovery: triggering immediate reconnect (state=${JSON.stringify(this.getMachineState())})`,
        'connection'
      )
      this.triggerReconnect()
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
      case 'awake':
        await this.handleAwake(sleepDurationMs)
        break

      case 'visible':
        if (this.isInReconnectingState()) {
          logInfo('System state: visible, triggering immediate reconnect')
          this.stores.console.addEvent('System state: visible, triggering immediate reconnect', 'connection')
          this.triggerReconnect()
        }
        break

      case 'sleeping':
        this.sendMachineEvent({ type: 'SLEEP' }, 'notifySystemState:sleeping')
        this.stores.console.addEvent('System state: sleeping', 'connection')
        break

      case 'hidden':
        this.stores.console.addEvent('System state: hidden', 'connection')
        break
    }
  }

  // ==================== Private Methods ====================

  /**
   * Handle wake-from-sleep: verify or reconnect depending on sleep duration.
   *
   * - Connected + long sleep (> SM timeout): transition to reconnecting, clean up dead client.
   * - Connected + short sleep: verify connection health (SM ack or ping).
   * - Already reconnecting: send WAKE to reset backoff and retry immediately.
   */
  private async handleAwake(sleepDurationMs?: number): Promise<void> {
    const sleepSec = sleepDurationMs != null ? Math.round(sleepDurationMs / 1000) : null
    logInfo(`System state: awake${sleepSec != null ? ` (sleep: ${sleepSec}s)` : ''}`)

    this.lastWakeTimestamp = Date.now()

    if (this.isInConnectedState()) {
      // Send WAKE to the machine — if sleep exceeds SM timeout, the guard
      // transitions directly to reconnecting.  Otherwise → connected.verifying.
      this.sendMachineEvent({ type: 'WAKE', sleepDurationMs }, 'handleAwake')

      if (this.isInReconnectingState()) {
        // Long sleep exceeded SM timeout — clean up the dead client.
        this.stores.console.addEvent(
          `System state: awake, sleep duration ${sleepSec}s exceeds SM timeout - reconnecting immediately`,
          'connection'
        )
        this.cleanupClient()
      } else {
        // Short sleep — verify connection health with shorter timeout.
        // After sleep the socket is almost certainly dead; a long timeout
        // feels like a UI freeze.
        this.stores.console.addEvent('System state: awake, verifying connection', 'connection')
        const isHealthy = await this.verifyConnection(WAKE_VERIFY_TIMEOUT_MS)
        if (!isHealthy && !this.isInReconnectingState()) {
          this.stores.console.addEvent('Connection dead after wake, reconnecting...', 'connection')
          // Use immediateReconnect to bypass the XState `after` timer which
          // fires unreliably after sleep (observed 25s+ delays for a 1s timer).
          // TRIGGER_RECONNECT skips waiting and goes directly to attempting.
          this.handleDeadSocket({ immediateReconnect: true, source: 'wake-verify-failed' })
        }
      }
    } else if (this.isInReconnectingState()) {
      // Wait for network before sending WAKE — otherwise we race to create
      // a WebSocket before the OS network stack is ready after sleep.
      const networkReady = await this.waitForNetworkReady()
      if (networkReady) {
        // Clean up the stale client from any in-flight attempt. After sleep,
        // its WebSocket and JS timers are unreliable — the 30s reconnect
        // timeout may have been paused and could fire at the wrong time,
        // potentially destroying a newer client. Tearing down now ensures
        // the stale attempt fails fast and the WAKE event triggers a clean
        // fresh attempt.
        this.cleanupClient()
        // Send WAKE (not TRIGGER_RECONNECT) so the state machine resets
        // the backoff counter — sleep/wake failures shouldn't accumulate.
        this.stores.console.addEvent('System state: awake, triggering immediate reconnect (backoff reset)', 'connection')
        this.sendMachineEvent({ type: 'WAKE', sleepDurationMs }, 'handleAwake:reconnecting')
      } else {
        this.stores.console.addEvent('System state: awake, but network not ready — will retry on next wake or timer', 'connection')
        logInfo('handleAwake: network not ready after wake, skipping WAKE event')
      }
    }
  }

  /**
   * Wait for the browser to report network availability.
   * Returns true if online, false if timed out while offline.
   *
   * After wake-from-sleep, the OS network stack may need several seconds
   * to reinitialize. This prevents wasting reconnect attempts on a
   * network that isn't ready yet.
   */
  private waitForNetworkReady(timeoutMs: number = NETWORK_READY_TIMEOUT_MS): Promise<boolean> {
    // Fast path: already online
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      return Promise.resolve(true)
    }

    // SSR / non-browser: assume online (navigator not available)
    if (typeof navigator === 'undefined' || typeof window === 'undefined') {
      return Promise.resolve(true)
    }

    logInfo('waitForNetworkReady: browser reports offline, waiting for online event')
    this.stores.console.addEvent('Waiting for network to become available...', 'connection')

    return new Promise<boolean>((resolve) => {
      let settled = false

      const onOnline = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        window.removeEventListener('online', onOnline)
        logInfo('waitForNetworkReady: network became available')
        this.stores.console.addEvent('Network became available', 'connection')
        resolve(true)
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        window.removeEventListener('online', onOnline)
        logWarn(`waitForNetworkReady: timed out after ${timeoutMs}ms`)
        this.stores.console.addEvent(
          `Network wait timed out after ${Math.round(timeoutMs / 1000)}s`,
          'connection'
        )
        resolve(false)
      }, timeoutMs)

      window.addEventListener('online', onOnline)
    })
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
      resource,
      lang,
      credentials: async (
        authenticate: (creds: Record<string, unknown>, mechanism: string, userAgent?: unknown) => Promise<void>,
        mechanisms: string[],
        fast: { fetch: () => Promise<string | null> } | null,
        entity: { isSecure: () => boolean }
      ) => {
        const creds: Record<string, unknown> = { username }
        if (password) creds.password = password
        if (fast) {
          const token = await fast.fetch()
          if (token) {
            creds.token = token
            logInfo('FAST token available, will attempt token-based auth')
          } else {
            logInfo('FAST token not available, falling back to password')
          }
        } else {
          logInfo('FAST module not present on this connection')
        }

        // Detect auth method explicitly
        const hasToken = !!creds.token
        const hasPassword = !!password
        if (!hasPassword && !hasToken) {
          throw new Error('No credentials available (no password and no FAST token)')
        }

        const mechanism: string = getMechanism({ mechanisms, entity, credentials: creds })
        const authMethod = hasToken ? 'fast-token' : 'password'

        this.stores.connection.setAuthMechanism(mechanism)
        this.stores.connection.setAuthMethod(authMethod)
        this.stores.console.addEvent(
          `Auth: ${authMethod === 'fast-token' ? 'FAST token' : 'password'} (SASL: ${mechanism})`,
          'connection'
        )
        logInfo(`Auth: ${authMethod} (SASL: ${mechanism}, offered: ${mechanisms.join(', ')})`)
        const saslStart = Date.now()
        let saslTimeoutId: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          Promise.resolve(authenticate(creds, mechanism)).then(() => {
            clearTimeout(saslTimeoutId)
            logInfo(`SASL complete (${Date.now() - saslStart}ms)`)
          }),
          new Promise<never>((_, reject) => {
            saslTimeoutId = setTimeout(() => {
              logErr(`SASL timeout after ${SASL_AUTH_TIMEOUT_MS}ms`)
              reject(new Error('SASL authentication timed out'))
            }, SASL_AUTH_TIMEOUT_MS)
          }),
        ])
      },
    })

    // Wire FAST token persistence to localStorage (XEP-0484)
    // xmpp.js default storage is in-memory only — tokens would be lost on page reload.
    // This enables password-less reconnection for up to 14 days on web.
    // Token saving is gated on rememberSession — users must opt in via "Remember Me".
    const fastModule = (xmppClient as any).fast
    if (fastModule) {
      const bareJid = getBareJid(jid)
      fastModule.fetchToken = () => fetchFastToken(bareJid)
      fastModule.saveToken = options.rememberSession
        ? (t: { mechanism: string; token: string; expiry?: string }) => {
            logInfo(`FAST token saved (mechanism: ${t.mechanism}, expiry: ${t.expiry ?? 'none'})`)
            saveFastToken(bareJid, t)
          }
        : () => { /* rememberSession disabled — do not persist FAST token */ }
      fastModule.deleteToken = () => {
        logInfo('FAST token invalidated/deleted')
        deleteFastToken(bareJid)
      }
    }

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
  ): () => void {
    if (!this.xmpp) return () => {}

    let resolved = false

    const handleResult = (isResumption: boolean) => {
      if (resolved) return
      resolved = true
      onConnected(isResumption)
    }

    // Listen for SM fail events (stanzas lost during resume or send)
    const sm = this.xmpp.streamManagement as any
    if (sm?.on) {
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

    // Listen for SM nonzas directly (<enabled/> and <resumed/>).
    // xmpp.js's SM plugin does NOT emit 'enabled' or 'resumed' events on its
    // EventEmitter when we manually hydrate SM state, so we intercept the raw
    // stanzas to reliably update our cache and persistence.
    ;(this.xmpp as any).on('nonza', (nonza: Element) => {
      if (nonza.is('enabled', 'urn:xmpp:sm:3')) {
        // SM successfully enabled (new session)
        const smId = nonza.attrs.id ? String(nonza.attrs.id).slice(0, 8) + '...' : 'none'
        const smMax = nonza.attrs.max != null ? `${nonza.attrs.max}s` : 'unknown'
        this.stores.console.addEvent(`Stream Management enabled (id: ${smId})`, 'sm')
        logInfo(`SM enabled (id: ${smId}, server max: ${smMax})`)
        // New session means no pending resume, so any future 'fail' events are real failures
        this.smResumeCompleted = true
        // Cache SM state for reconnection (survives socket death).
        // Read from the live SM object since xmpp.js has already processed the attrs.
        const smObj = this.xmpp?.streamManagement as any
        if (smObj?.id) {
          this.smPersistence.updateCache(smObj.id, smObj.inbound || 0)
          if (this.credentials?.jid) {
            void this.smPersistence.persist(this.credentials.jid, this.credentials.resource || '')
          }
        }
      } else if (nonza.is('resumed', 'urn:xmpp:sm:3')) {
        // SM session successfully resumed
        const previd = nonza.attrs.previd as string
        const inbound = this.xmpp?.streamManagement ? (this.xmpp.streamManagement as any).inbound : 0
        this.stores.console.addEvent(`Stream Management session resumed (id: ${previd.slice(0, 8)}...)`, 'sm')
        logInfo(`SM session resumed (id: ${previd.slice(0, 8)}..., h: ${inbound})`)
        // Mark resume as completed - any 'fail' events after this are for new stanzas, not resume failures
        this.smResumeCompleted = true

        // Update cached SM state (survives socket death for next reconnection)
        this.smPersistence.updateCache(previd, inbound)
        if (this.credentials?.jid) {
          void this.smPersistence.persist(this.credentials.jid, this.credentials.resource || '')
        }

        // Delay to run after xmpp.js's SM plugin finishes processing,
        // which otherwise resets the state after our update.
        setTimeout(() => {
          const smObj = this.xmpp?.streamManagement as any
          if (smObj) {
            smObj.id = previd
            smObj.enabled = true
            smObj.inbound = inbound
          }
        }, 0)

        logInfo(`Connection handshake complete: SM resumed (resolved=${resolved})`)
        handleResult(true)
      }
    })

    // Standard online event - fired when:
    // 1. New session (no SM state provided)
    // 2. SM resumption FAILED and fell back to new session
    // Note: When SM resume succeeds, xmpp.js does NOT emit 'online', only 'resumed'
    // Therefore, whenever 'online' fires, it's a new session.
    this.xmpp.on('online', () => {
      logInfo(`Connection handshake complete: online (resolved=${resolved})`)
      handleResult(false)
    })

    this.xmpp.on('error', (err: Error) => {
      logInfo(`Connection handshake error: ${err.message} (resolved=${resolved})`)
      if (resolved) return
      // If handleDeadSocket already initiated recovery (e.g., econnerror handled
      // by setupHandlers' error handler first), don't reject the promise — that
      // would send CONNECTION_ERROR and disrupt the already-in-progress reconnect.
      if (this.deadSocketRecoveryInProgress) {
        resolved = true
        return
      }
      resolved = true
      onError(err)
    })

    // Handle disconnect during connection handshake.
    // If the socket closes before 'online' or 'error' fires (e.g., proxy TCP
    // connect failed, network not ready after wake), reject immediately instead
    // of waiting for the 30s reconnect attempt timeout.
    ;(this.xmpp as any).on('disconnect', () => {
      logInfo(`Connection handshake disconnect (resolved=${resolved})`)
      if (resolved) return
      resolved = true
      onError(new Error('Socket disconnected during connection handshake'))
    })

    this.xmpp.start().catch((err: Error) => {
      logInfo(`Connection start() rejected: ${err.message} (resolved=${resolved})`)
      if (resolved) return
      resolved = true
      onError(err)
    })

    // Return an abort function that marks this attempt as settled.
    // The reconnect timeout calls this to prevent stale events (e.g., a
    // belated 'online' from a destroyed client) from triggering
    // CONNECTION_SUCCESS after the attempt has been abandoned.
    return () => { resolved = true }
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

      // Entity Time queries (type="get") - XEP-0202
      iqCallee.get(NS_TIME, 'time', () => {
        const now = new Date()
        const offsetMinutes = -now.getTimezoneOffset()
        const sign = offsetMinutes >= 0 ? '+' : '-'
        const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')
        const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0')
        const tzo = `${sign}${hours}:${minutes}`
        const utc = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
        return xml('time', { xmlns: NS_TIME },
          xml('tzo', {}, tzo),
          xml('utc', {}, utc)
        )
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
        this.sendMachineEvent({ type: 'CONFLICT' }, 'stream-error:conflict')
        this.stores.console.addEvent('Disconnected: Resource conflict (another client connected)', 'error')
        console.error('[XMPP] Resource conflict: another client connected with the same account')
        this.stores.events.addSystemNotification(
          'resource-conflict',
          'Session Replaced',
          'Another client connected with the same account. Auto-reconnect is disabled to prevent conflicts. Please reconnect manually when ready.'
        )
        // Clear credentials to prevent accidental reconnect
        this.credentials = null
      } else if (isAuthStreamError(message)) {
        this.sendMachineEvent({ type: 'AUTH_ERROR' }, 'stream-error:auth')
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

        this.sendMachineEvent({ type: 'SOCKET_DIED' }, 'stream-error:system-shutdown')

        // Forcefully destroy old client — strip listeners and close socket
        // to prevent stale events from interfering with reconnection
        if (clientToClean) {
          forceDestroyClient(clientToClean)
        }
      } else if (message.includes('econnerror') || isDeadSocketError(message)) {
        // Transport is definitively broken (commonly reported as "websocket econnerror"
        // when the Rust proxy bridge dies). Trigger dead-socket recovery immediately
        // instead of waiting for disconnect-event ordering.
        this.stores.console.addEvent(
          `Stream transport error context: state=${JSON.stringify(this.getMachineState())}`,
          'connection'
        )
        this.stores.console.addEvent('Stream transport error, forcing reconnect recovery', 'connection')
        logWarn('Stream transport error detected, initiating dead-socket recovery')
        this.handleDeadSocket({ immediateReconnect: true, source: 'stream-error' })
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

        return
      }

      // Notify disconnect handler (for presence machine, etc.)
      // Skip during reconnection - we're not truly disconnected, just cycling the socket
      if (!this.isInReconnectingState()) {
        this.onDisconnect?.()
      }

      // The machine state determines what to do on socket disconnect.
      // Terminal states (conflict/auth/initialFailure) and disconnected state are already handled
      // by the error handler or disconnect() method above.
      const machineState = this.getMachineState()
      logInfo(`Disconnect handler: machineState=${JSON.stringify(machineState)}`)

      if (machineState === 'disconnected') {
        // Manual disconnect - will transition to offline via stop()
        this.stores.console.addEvent('Socket closed (manual disconnect)', 'connection')
      } else if (this.isInTerminalState()) {
        // Terminal state (conflict, authFailed, initialFailure)
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
        this.sendMachineEvent({ type: 'SOCKET_DIED' }, 'disconnect:unexpected')

        // Capture SM state into cache BEFORE nulling the client reference.
        this.smPersistence.getState(this.xmpp)

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
   * Ordering note:
   * - Emits `connection:status=online`, `connection:authenticated`, and `online/resumed` first.
   * - Then delegates to XMPPClient post-connect flow (`onConnectionSuccess`) which sends
   *   protocol traffic in its documented order.
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

    // Compute how long we were disconnected (0 means first connect, not reconnect)
    const disconnectDurationMs = this.disconnectedAtTimestamp > 0
      ? Date.now() - this.disconnectedAtTimestamp
      : undefined
    this.disconnectedAtTimestamp = 0

    // Call registered post-connection handler (if set)
    if (this.onConnectionSuccess) {
      await this.onConnectionSuccess(isResumption, previouslyJoinedRooms, disconnectDurationMs)
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

    // Wait for network availability after wake-from-sleep.
    // The OS network stack may need several seconds to reinitialize after wake.
    // Without this gate, WebSocket connect fails immediately with ECONNERROR,
    // burning through backoff attempts while the network isn't ready.
    const networkReady = await this.waitForNetworkReady()
    if (!networkReady) {
      logInfo('attemptReconnect: network not available, signaling error to retry later')
      this.stores.console.addEvent('Reconnect skipped: network not available', 'connection')
      this.sendMachineEvent(
        { type: 'CONNECTION_ERROR', error: 'Network not available' },
        'attemptReconnect:network-not-ready'
      )
      return
    }

    // After wake-from-sleep, navigator.onLine goes true before the network path
    // is fully functional (DNS cache cold, Wi-Fi re-association in progress, TLS
    // session tickets expired). WebSocket TCP handshake may succeed but SASL
    // exchanges hang on the half-ready path, causing repeated 15s timeouts.
    // A short settle delay lets the OS finish re-establishing connectivity.
    const msSinceWake = Date.now() - this.lastWakeTimestamp
    if (this.lastWakeTimestamp > 0 && msSinceWake < NETWORK_SETTLE_DELAY_MS + 1_000) {
      const settleMs = Math.max(0, NETWORK_SETTLE_DELAY_MS - msSinceWake)
      if (settleMs > 0) {
        logInfo(`attemptReconnect: waiting ${settleMs}ms for network to settle after wake`)
        this.stores.console.addEvent(`Waiting ${Math.round(settleMs / 1000)}s for network to settle after wake`, 'connection')
        await new Promise((resolve) => setTimeout(resolve, settleMs))
      }
    }

    // Track which client this attempt creates, so the outer catch block can
    // detect if a WAKE event replaced it with a newer attempt's client.
    let clientCreatedByThisAttempt: unknown = null

    try {
      // Capture rooms early so reconnect recovery can still rejoin them even if
      // we short-circuit because the transport is already back online.
      // Use live store first, but fall back to SM-persisted room list if the store
      // was cleared by markAllRoomsNotJoined() during a failed reconnect cycle.
      const liveJoinedRooms = this.stores.room.joinedRooms() ?? []
      let previouslyJoinedRooms: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }> = liveJoinedRooms
      if (liveJoinedRooms.length <= 1 && this.credentials) {
        try {
          const persisted = await this.smPersistence.load(this.credentials.jid)
          if (persisted.joinedRooms.length > liveJoinedRooms.length) {
            this.stores.console.addEvent(
              `Using SM-persisted room list (${persisted.joinedRooms.length} rooms) — live store only has ${liveJoinedRooms.length}`,
              'sm'
            )
            previouslyJoinedRooms = persisted.joinedRooms
          }
        } catch { /* storage errors are non-fatal */ }
      }

      // Defensive check: verify xmpp.js client is not already online.
      // This shouldn't happen in normal flow, but guards against edge cases.
      if (this.xmpp && (this.xmpp as any).status === 'online') {
        this.stores.console.addEvent('Connection still online - cancelling reconnect attempt', 'connection')
        this.sendMachineEvent({ type: 'CONNECTION_SUCCESS' }, 'attemptReconnect:already-online')
        await this.handleConnectionSuccess(false, 'Reconnected', previouslyJoinedRooms)
        return
      }

      // Emit SDK event for connecting status (machine is in reconnecting.attempting)
      this.deps.emitSDK('connection:status', { status: 'connecting' })

      // Check whether the state machine considers SM resume viable.
      // The machine tracks sleep duration via connected.sleeping → SOCKET_DIED/WAKE
      // and sets smResumeViable accordingly. This is the single source of truth.
      const { smResumeViable } = this.connectionActor.getSnapshot().context
      const smState = smResumeViable ? this.getStreamManagementState() : null
      if (!smResumeViable) {
        logInfo('SM resume not viable (long sleep or expired), starting fresh session')
        this.smPersistence.clearCache()
        this.stores.console.addEvent('SM resume skipped (long sleep detected by state machine)', 'sm')
      } else if (smState) {
        this.stores.console.addEvent(
          `Saved SM state for resumption (id: ${smState.id.slice(0, 8)}..., h: ${smState.inbound})`,
          'sm'
        )
      } else {
        this.stores.console.addEvent('No SM state available, will start new session', 'sm')
      }

      // Clean up old client (the proxy stays running — each new WS connection
      // creates a fresh TCP/TLS connection with independent DNS resolution)
      this.cleanupClient()
      logInfo('attemptReconnect: old client cleaned up')

      const connectWithOptions = async (options: ConnectOptions): Promise<void> => {
        this.deadSocketRecoveryInProgress = false
        this.xmpp = this.createXmppClient(options)
        // Capture the client for this specific attempt so we can detect if a
        // newer attempt replaced it (e.g., WAKE triggered a fresh attempt while
        // this timeout was paused during sleep).
        const clientForThisAttempt = this.xmpp
        clientCreatedByThisAttempt = this.xmpp
        this.hydrateStreamManagement(smState ?? undefined)
        this.setupHandlers()
        logInfo(`attemptReconnect: new client created, calling start() (${options.server})`)

        await new Promise<void>((resolve, reject) => {
          const attemptStart = Date.now()
          const timeout = setTimeout(() => {
            const elapsed = Date.now() - attemptStart
            if (elapsed > RECONNECT_ATTEMPT_TIMEOUT_MS * 1.5) {
              logInfo(`Reconnect timeout fired late (${Math.round(elapsed / 1000)}s elapsed, expected ${RECONNECT_ATTEMPT_TIMEOUT_MS / 1000}s) — system likely slept through it`)
            }

            // Abort connection handlers to prevent stale events (e.g., a
            // belated 'online') from triggering CONNECTION_SUCCESS after timeout.
            abortHandlers()

            // Guard: if a newer attempt replaced this client (e.g., WAKE during
            // sleep triggered a fresh attempt), don't destroy the new client.
            if (this.xmpp !== clientForThisAttempt) {
              logInfo('Stale reconnect timeout fired for superseded client, skipping cleanup')
              reject(new Error('Reconnect attempt superseded'))
              return
            }

            // Always clean up and reject on timeout, even if it fired late.
            // The wake handler will trigger a fresh reconnect attempt with
            // correct SM state. Ignoring stale timeouts risks leaving the
            // promise hanging forever if no subsequent wake event fires.
            logWarn(`Reconnect attempt timed out after ${Math.round(elapsed / 1000)}s, cleaning up stale client`)
            this.cleanupClient()
            reject(new Error(`Reconnect attempt timed out after ${Math.round(elapsed / 1000)}s`))
          }, RECONNECT_ATTEMPT_TIMEOUT_MS)

          const abortHandlers = this.setupConnectionHandlers(
            async (isResumption) => {
              clearTimeout(timeout)
              // Signal machine: reconnect succeeded → connected.healthy
              this.sendMachineEvent({ type: 'CONNECTION_SUCCESS' }, 'attemptReconnect:success')
              try {
                await this.handleConnectionSuccess(
                  isResumption,
                  'Reconnected',
                  previouslyJoinedRooms
                )
                resolve()
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)))
              }
            },
            (err) => {
              clearTimeout(timeout)
              reject(err)
            }
          )
        })
      }

      let reconnectOptions = this.credentials
      // Reconnect should reuse the previously selected endpoint (direct WS or
      // cached local proxy URL). This keeps reconnect fast and avoids repeating
      // discovery/SRV resolution on every retry.
      const reconnectUsesCachedProxy = this.proxyManager.hasProxy && this.isLocalProxyServer(reconnectOptions.server)
      if (reconnectUsesCachedProxy) {
        this.stores.console.addEvent(
          `Reconnect: reusing cached proxy endpoint (${reconnectOptions.server})`,
          'connection'
        )
      }

      try {
        await connectWithOptions(reconnectOptions)
      } catch (reconnectError) {
        const errorMsg = reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
        // Only when reconnecting through a cached local proxy endpoint and that
        // endpoint fails do we refresh/restart the proxy and retry once.
        const shouldRefreshProxy = reconnectUsesCachedProxy && !this.isInTerminalState()
        if (!shouldRefreshProxy) {
          throw reconnectError
        }

        const reconnectDomain = getDomain(reconnectOptions.jid)
        const proxyServer = this.proxyManager.getOriginalServer() || reconnectDomain
        this.stores.console.addEvent(
          `Reconnect: cached proxy endpoint failed (${errorMsg}), refreshing endpoint`,
          'connection'
        )
        this.cleanupClient()
        const proxyRefreshStart = Date.now()
        const refreshed = await this.proxyManager.restartProxy(proxyServer, reconnectDomain)
        const proxyRefreshMs = Date.now() - proxyRefreshStart
        reconnectOptions = { ...reconnectOptions, server: refreshed.server }
        this.credentials = reconnectOptions
        this.stores.connection.setConnectionMethod(refreshed.connectionMethod)
        this.stores.console.addEvent(
          `Reconnect: proxy refreshed in ${proxyRefreshMs}ms -> ${refreshed.server}`,
          'connection'
        )
        logInfo(`attemptReconnect: proxy refreshed (${refreshed.server}) in ${proxyRefreshMs}ms`)

        await connectWithOptions(reconnectOptions)
      }
    } catch (err) {
      // Guard: if a WAKE event already replaced this attempt's client with a
      // newer one, don't destroy the new client or send CONNECTION_ERROR — the
      // new attempt is already in progress.
      if (this.xmpp != null && this.xmpp !== clientCreatedByThisAttempt) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        logInfo(`Stale attemptReconnect catch (client replaced): ${errorMsg}`)
        return
      }

      // Ensure the failed attempt's client is destroyed to prevent stale events
      // (e.g., delayed 'online' from resource binding) from interfering with
      // subsequent reconnect attempts.
      this.cleanupClient()

      logError('Reconnect failed:', err)
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      this.stores.console.addEvent(`Reconnect attempt failed: ${errorMsg}`, 'error')
      logErr(`Reconnect failed: ${errorMsg}`)
      // Signal machine: reconnect failed → back to waiting (attempt/delay are
      // saturated by the state machine once the backoff ceiling is reached).
      this.sendMachineEvent({ type: 'CONNECTION_ERROR', error: errorMsg }, 'attemptReconnect:error')
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
    this.deadSocketRecoveryInProgress = false

    // Clear any pending SM ack debounce timer
    clearSmAckDebounce(this.smPatchState)

    // Forcefully destroy the old client
    forceDestroyClient(clientToClean)

    logInfo('cleanupClient: old client cleaned up (forceful)')
  }

}
