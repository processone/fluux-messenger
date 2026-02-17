/**
 * Proxy lifecycle manager.
 *
 * Manages the always-on proxy: started once and reused across reconnects.
 * DNS/SRV resolution is handled per-connection by the Rust proxy, so
 * the SDK only needs to ensure the proxy is running.
 *
 * Falls back to WebSocket if the proxy fails to start.
 */

import type { ProxyAdapter } from '../types'
import { shouldSkipDiscovery, getWebSocketUrl, resolveWebSocketUrl, type ResolutionLogger } from './serverResolution'
import { isConnectionTraceEnabled } from './connectionDiagnostics'
import { PROXY_START_TIMEOUT_MS, PROXY_STOP_TIMEOUT_MS } from './connectionTimeouts'

/** Dependencies injected by Connection. */
export interface ProxyManagerDeps {
  proxyAdapter?: ProxyAdapter
  console: ResolutionLogger
}

/** Result from proxy operations: where to connect + how. */
export interface ServerResult {
  server: string
  connectionMethod: 'proxy' | 'websocket'
}

// Re-exported for backward compatibility with existing imports/tests.
export { PROXY_START_TIMEOUT_MS, PROXY_STOP_TIMEOUT_MS }

type ProxyLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping'

/**
 * Manages the always-on proxy lifecycle.
 *
 * The proxy is started once and reused across reconnects. Each new
 * WebSocket connection to the proxy creates a fresh TCP/TLS connection
 * with independent DNS resolution (handled by the Rust side).
 */
export class ProxyManager {
  private deps: ProxyManagerDeps
  private originalServer: string = ''
  private proxyUrl: string | null = null
  private lifecycleState: ProxyLifecycleState = 'stopped'
  private lifecycleQueue: Promise<void> = Promise.resolve()
  private operationId: number = 0

  constructor(deps: ProxyManagerDeps) {
    this.deps = deps
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Whether a proxy adapter is available. */
  get hasProxy(): boolean {
    return !!this.deps.proxyAdapter
  }

  /** Set original server on initial connect. */
  setOriginalServer(server: string): void {
    this.originalServer = server
  }

  /** Get the original server string (pre-proxy). */
  getOriginalServer(): string {
    return this.originalServer
  }

  /** Get the cached proxy WS URL (for reconnection without IPC). */
  getProxyUrl(): string | null {
    return this.proxyUrl
  }

  /** Current proxy lifecycle state (for diagnostics). */
  getLifecycleState(): ProxyLifecycleState {
    return this.lifecycleState
  }

  // ── Serialized lifecycle operations ───────────────────────────────────────

  /**
   * Serialize proxy lifecycle operations to prevent concurrent start/stop races.
   */
  private runSerialized<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    const opId = ++this.operationId
    const queuedAt = Date.now()
    const execute = async () => {
      const waitedMs = Date.now() - queuedAt
      if (isConnectionTraceEnabled()) {
        this.deps.console.addEvent(
          `Proxy op#${opId} start: ${operationName} (wait=${waitedMs}ms, state=${this.lifecycleState})`,
          'connection'
        )
      }
      const startedAt = Date.now()
      try {
        const result = await operation()
        const durationMs = Date.now() - startedAt
        if (isConnectionTraceEnabled()) {
          this.deps.console.addEvent(
            `Proxy op#${opId} done: ${operationName} (${durationMs}ms, state=${this.lifecycleState})`,
            'connection'
          )
        }
        return result
      } catch (err) {
        const durationMs = Date.now() - startedAt
        const errorMsg = err instanceof Error ? err.message : String(err)
        this.deps.console.addEvent(
          `Proxy op#${opId} failed: ${operationName} after ${durationMs}ms (${errorMsg})`,
          'error'
        )
        throw err
      }
    }

    const run = this.lifecycleQueue.then(execute, execute)
    this.lifecycleQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Bound adapter calls so a hung IPC operation cannot wedge the lifecycle queue.
   *
   * Uses a settled-result race to avoid unhandled rejections when the timeout
   * wins and the original promise settles later.
   */
  private async runWithTimeout<T>(
    operationName: string,
    timeoutMs: number,
    operation: Promise<T>
  ): Promise<T> {
    const timeoutSentinel = Symbol('proxy-timeout')
    const settledOperation = operation.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    )

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        settledOperation,
        new Promise<typeof timeoutSentinel>((resolve) => {
          timeoutId = setTimeout(() => resolve(timeoutSentinel), timeoutMs)
        }),
      ])

      if (result === timeoutSentinel) {
        this.deps.console.addEvent(
          `Proxy operation timeout: ${operationName} after ${timeoutMs}ms`,
          'error'
        )
        throw new Error(`${operationName} timed out after ${timeoutMs}ms`)
      }

      if (!result.ok) {
        throw result.error
      }

      return result.value
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }

  // ── Stop proxy ────────────────────────────────────────────────────────────

  /**
   * Stop the running proxy (best-effort) and clear the cached local URL.
   *
   * Does not fail when no proxy adapter is configured.
   */
  async stopProxy(): Promise<void> {
    return this.runSerialized('stopProxy', async () => {
      await this.stopProxyUnlocked()
    })
  }

  private async stopProxyUnlocked(): Promise<void> {
    if (!this.deps.proxyAdapter) return
    if (this.lifecycleState === 'stopped' && !this.proxyUrl) return

    this.lifecycleState = 'stopping'
    try {
      await this.runWithTimeout(
        'stopProxy',
        PROXY_STOP_TIMEOUT_MS,
        this.deps.proxyAdapter.stopProxy()
      )
    } finally {
      this.proxyUrl = null
      this.lifecycleState = 'stopped'
    }
  }

  // ── Ensure proxy is running ─────────────────────────────────────────────

  /**
   * Ensure the proxy is running for the given server.
   *
   * If already running for the same server, returns the cached URL
   * (the Rust side also checks this, but caching avoids the IPC round-trip).
   * Falls back to WebSocket discovery if the proxy fails to start.
   *
   * @param server - Original server string (domain, tls://host:port, etc.)
   * @param domain - XMPP domain from the JID
   * @param skipDiscovery - Whether to skip XEP-0156 discovery on fallback
   */
  async ensureProxy(
    server: string,
    domain: string,
    skipDiscovery?: boolean
  ): Promise<ServerResult> {
    const target = server || domain
    return this.runSerialized(
      `ensureProxy(${target})`,
      async () => this.ensureProxyUnlocked(server, domain, skipDiscovery)
    )
  }

  private async ensureProxyUnlocked(
    server: string,
    domain: string,
    skipDiscovery?: boolean
  ): Promise<ServerResult> {
    if (!this.deps.proxyAdapter) {
      throw new Error('No proxy adapter available')
    }

    const target = server || domain

    // If we already have a proxy URL for the same server, reuse it
    if (this.proxyUrl && this.originalServer === (server || domain)) {
      this.deps.console.addEvent(`Reusing proxy: ${this.proxyUrl}`, 'connection')
      this.lifecycleState = 'running'
      return { server: this.proxyUrl, connectionMethod: 'proxy' }
    }

    // Different target while running: stop first so Rust side starts cleanly.
    if (this.proxyUrl && this.originalServer !== target) {
      this.deps.console.addEvent(`Proxy target changed: ${this.originalServer} -> ${target}, restarting`, 'connection')
      try {
        await this.stopProxyUnlocked()
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        this.deps.console.addEvent(`Failed to stop proxy before restart: ${errorMsg}`, 'error')
      }
    }

    this.deps.console.addEvent(`Starting proxy for: ${target}`, 'connection')
    this.lifecycleState = 'starting'

    try {
      const proxyResult = await this.runWithTimeout(
        'startProxy',
        PROXY_START_TIMEOUT_MS,
        this.deps.proxyAdapter.startProxy(target)
      )
      this.proxyUrl = proxyResult.url
      this.originalServer = target
      this.lifecycleState = 'running'
      this.deps.console.addEvent(
        `Proxy started: ${target} via ${proxyResult.url}`,
        'connection'
      )
      return {
        server: proxyResult.url,
        connectionMethod: 'proxy',
      }
    } catch (err) {
      // Proxy failed — fall back to WebSocket
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.deps.console.addEvent(`Failed to start proxy: ${errorMsg}, falling back to WebSocket`, 'error')
      this.proxyUrl = null
      this.lifecycleState = 'stopped'

      const resolvedServer = shouldSkipDiscovery(server, skipDiscovery)
        ? getWebSocketUrl(server, domain)
        : await resolveWebSocketUrl(server, domain, this.deps.console)

      return {
        server: resolvedServer,
        connectionMethod: 'websocket',
      }
    }
  }

  /**
   * Force a proxy restart and return a fresh connection target.
   *
   * Useful for recovery after local proxy/socket failures where a cached
   * localhost WebSocket URL may no longer be valid.
   */
  async restartProxy(
    server: string,
    domain: string,
    skipDiscovery?: boolean
  ): Promise<ServerResult> {
    const target = server || domain
    return this.runSerialized(`restartProxy(${target})`, async () => {
      if (!this.deps.proxyAdapter) {
        throw new Error('No proxy adapter available')
      }

      this.deps.console.addEvent(`Restarting proxy for: ${target}`, 'connection')

      try {
        await this.stopProxyUnlocked()
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        this.deps.console.addEvent(`Failed to stop proxy during restart: ${errorMsg}`, 'error')
      }

      return this.ensureProxyUnlocked(target, domain, skipDiscovery)
    })
  }
}
