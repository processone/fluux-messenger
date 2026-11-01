/**
 * Stream Management state persistence.
 *
 * Manages the SM state cache (survives socket death) and
 * storage persistence (survives page reload). Extracted from
 * Connection.ts for independent testing and clearer boundaries.
 */

import type { StorageAdapter, JoinedRoomInfo } from '../types'
import type { ResolutionLogger } from './serverResolution'
import { DEFAULT_SM_MAX_SECONDS, isWithinSmWindow, resolveSmWindowMs } from './smResumptionPolicy'

/**
 * The slice of the live xmpp.js client that SM capture reads.
 *
 * Deliberately narrower than `Client`: `getState` only ever reads the four
 * Stream Management counters, so callers (and test doubles) need not stand up
 * a whole client to be typed correctly.
 */
export interface SmStateSource {
  streamManagement?: {
    id?: string | null
    inbound?: number
    outbound?: number
    outbound_q?: unknown[]
  } | null
}

/** Cached SM state: lives in memory, survives socket death. */
export interface SmStateCache {
  id: string
  inbound: number
  /**
   * Total outbound stanzas the server is expected to know about on resume
   * (= `sm.outbound` + pending `outbound_q.length` at capture time).
   * Used to hydrate `sm.outbound` so xmpp.js's ackQueue runs 0 iterations
   * when the server's `<resumed h=N/>` comes back. See smPersistence tests
   * and Connection.hydrateStreamManagement for the full resume flow.
   */
  outbound: number
  /** When this entry last captured live state (ms since epoch). Not renewed by reads while interrupted. */
  timestamp: number
  /** Resumption window (ms) negotiated for this session. */
  windowMs: number
  /**
   * When the session was interrupted (socket loss, sleep, reload), ms since epoch.
   * The window runs from here; without it, from the last live capture (`timestamp`).
   */
  interruptedAt?: number
}

/** Dependencies injected by Connection. */
export interface SmPersistenceDeps {
  storageAdapter?: StorageAdapter
  getJoinedRooms: () => JoinedRoomInfo[]
  console: ResolutionLogger
  /** Resumption duration this client requests (seconds); caps any window kept locally. */
  requestSeconds?: number
}

/** Result of loading SM state from storage. */
export interface SmLoadResult {
  smState: SmStateCache | null
  joinedRooms: JoinedRoomInfo[]
}

/**
 * Manages SM (Stream Management) state caching and persistence.
 *
 * - In-memory cache survives socket death within a session
 * - Async storage persistence survives page reloads
 * - Sync persistence for beforeunload handlers
 */
export class SmPersistence {
  private cache: SmStateCache | null = null
  private deps: SmPersistenceDeps

  constructor(deps: SmPersistenceDeps) {
    this.deps = deps
  }

  // ── Cache operations ──────────────────────────────────────────────────────

  private get requestSeconds(): number {
    return this.deps.requestSeconds ?? DEFAULT_SM_MAX_SECONDS
  }

  /** Whether `entry` may still be resumed now: the window runs from the interruption, else the last capture. */
  private eligible(entry: SmStateCache): boolean {
    const windowMs = Math.min(entry.windowMs, this.requestSeconds * 1000)
    return isWithinSmWindow(entry.interruptedAt ?? entry.timestamp, Date.now(), windowMs)
  }

  /**
   * A new session was enabled. Resets any prior grant, even when the server
   * omits `max`, so a window never leaks from one session to the next.
   * @returns the window (ms) now in force
   */
  beginSession(id: string, inbound: number, advertisedMax: unknown): number {
    const windowMs = resolveSmWindowMs(this.requestSeconds, advertisedMax)
    this.cache = { id, inbound, outbound: 0, timestamp: Date.now(), windowMs }
    return windowMs
  }

  /** Seed the cache from a record loaded from storage so a later resumption keeps its window. */
  adopt(state: SmStateCache): void {
    this.cache = { ...state }
  }

  /** Update cache when SM is resumed. Keeps the negotiated window and clears the interruption. */
  updateCache(id: string, inbound: number, outbound: number): void {
    const windowMs = this.cache?.id === id
      ? this.cache.windowMs
      : resolveSmWindowMs(this.requestSeconds, undefined)
    this.cache = { id, inbound, outbound, timestamp: Date.now(), windowMs }
  }

  /** The window (ms) of the current session, if any. */
  getWindowMs(): number | null {
    return this.cache ? Math.min(this.cache.windowMs, this.requestSeconds * 1000) : null
  }

  /**
   * Start the resumption window at `at` (default now). Only the first
   * interruption counts: repeated losses and failed reconnects cannot slide it.
   */
  markInterrupted(at: number = Date.now()): void {
    if (this.cache && this.cache.interruptedAt == null) {
      this.cache.interruptedAt = Math.min(at, Date.now())
    }
  }

  /** The connection was verified live: the prior interruption is over. */
  clearInterruption(): void {
    if (this.cache) delete this.cache.interruptedAt
  }

  /** Get cached SM state (null if there is none or its window has run out). */
  getCache(): SmStateCache | null {
    return this.cache && this.eligible(this.cache) ? this.cache : null
  }

  /** Clear cache (manual disconnect → fresh session next time). */
  clearCache(): void {
    this.cache = null
  }

  /**
   * Get SM state: prefer live state from the xmpp client, fall back to cache.
   * The cache survives socket death, so it's available even when the client is gone.
   * Returns null once the resumption window has run out.
   *
   * @param xmpp - The xmpp.js client instance (may be null after socket death)
   */
  getState(xmpp: SmStateSource | null): SmStateCache | null {
    const sm = xmpp?.streamManagement
    if (sm?.id) {
      // Capture total outbound: already-acked (sm.outbound) + still-pending (outbound_q).
      // Server's <resumed h=N/> counts *every* stanza it received, acked or not — so
      // persisting just sm.outbound would leave us short when the queue was non-empty
      // at disconnect and the crash path would re-open.
      const pendingOutbound = Array.isArray(sm.outbound_q) ? sm.outbound_q.length : 0
      const previous = this.cache?.id === sm.id ? this.cache : null
      this.cache = {
        id: sm.id,
        inbound: sm.inbound || 0,
        outbound: (sm.outbound || 0) + pendingOutbound,
        // A frozen live object read after the interruption is not a fresh capture.
        timestamp: previous?.interruptedAt != null ? previous.timestamp : Date.now(),
        windowMs: previous?.windowMs ?? resolveSmWindowMs(this.requestSeconds, undefined),
        interruptedAt: previous?.interruptedAt,
      }
    }
    return this.cache && this.eligible(this.cache) ? this.cache : null
  }

  // ── Storage operations ────────────────────────────────────────────────────

  /**
   * Persist SM state + joined rooms to async storage.
   * Called after SM enabled/resumed events.
   */
  async persist(jid: string, resource: string): Promise<void> {
    if (!this.deps.storageAdapter || !this.cache) {
      return
    }
    try {
      const joinedRooms = this.deps.getJoinedRooms()

      // If current joinedRooms is empty, preserve previously persisted rooms.
      // This avoids overwriting valid room data during SM negotiation when
      // rooms haven't joined yet (e.g. SM enabled fires before bookmark join).
      let roomsToSave = joinedRooms
      if (joinedRooms.length === 0) {
        const existing = await this.deps.storageAdapter.getSessionState(jid)
        if (existing?.joinedRooms && existing.joinedRooms.length > 0) {
          roomsToSave = existing.joinedRooms
        }
      }

      await this.deps.storageAdapter.setSessionState(jid, {
        smId: this.cache.id,
        smInbound: this.cache.inbound,
        smOutbound: this.cache.outbound,
        smWindowMs: this.cache.windowMs,
        smInterruptedAt: this.cache.interruptedAt,
        resource: resource || '',
        timestamp: this.cache.timestamp,
        joinedRooms: roomsToSave,
      })
    } catch {
      // Storage errors are non-fatal
    }
  }

  /**
   * Persist SM state synchronously via sessionStorage.
   * Used in beforeunload handler where async writes may not complete.
   *
   * @param jid - The user's JID (used as storage key)
   * @param resource - The XMPP resource
   * @param getJoinedRooms - Callback that returns rooms to persist
   *        (may differ from deps.getJoinedRooms — beforeunload filters quickchat rooms)
   */
  persistNow(jid: string, resource: string, joinedRooms?: JoinedRoomInfo[]): void {
    if (!this.deps.storageAdapter || !this.cache) {
      return
    }

    const rooms = joinedRooms ?? this.deps.getJoinedRooms()

    const state = {
      smId: this.cache.id,
      smInbound: this.cache.inbound,
      smOutbound: this.cache.outbound,
      smWindowMs: this.cache.windowMs,
      smInterruptedAt: this.cache.interruptedAt,
      resource: resource || '',
      timestamp: this.cache.timestamp,
      joinedRooms: rooms,
    }
    try {
      // Direct synchronous write for beforeunload reliability
      sessionStorage.setItem(`fluux:session:${jid}`, JSON.stringify(state))
    } catch {
      // Storage errors are non-fatal
    }
  }

  /**
   * Load SM state + joined rooms from storage.
   * Returns stale rooms even if SM state is expired (useful for rejoin).
   *
   * Stale storage is NOT cleared — the `joinedRooms` field is still useful
   * across subsequent reconnect cycles, and wiping it here would force the
   * next `persist()` call (which runs with an empty store on fresh `<enabled/>`)
   * to save an empty room list, stranding the rejoin path.
   */
  async load(jid: string): Promise<SmLoadResult> {
    if (!this.deps.storageAdapter) {
      return { smState: null, joinedRooms: [] }
    }
    try {
      const state = await this.deps.storageAdapter.getSessionState(jid)
      if (state) {
        const joinedRooms = state.joinedRooms ?? []
        // Records saved before the window was stored keep their original ten minutes.
        const windowMs = typeof state.smWindowMs === 'number' && state.smWindowMs > 0
          ? state.smWindowMs
          : DEFAULT_SM_MAX_SECONDS * 1000
        const loaded: SmStateCache = {
          id: state.smId,
          inbound: state.smInbound,
          outbound: state.smOutbound,
          timestamp: state.timestamp,
          windowMs,
          interruptedAt: typeof state.smInterruptedAt === 'number' ? state.smInterruptedAt : undefined,
        }
        // Expired or unsafe timestamps, or records saved before smOutbound existed
        // (ackQueue would crash when the server's h exceeds our count), cannot resume.
        // Keep the rooms for rejoin.
        if (typeof state.smId !== 'string' || !state.smId
          || typeof state.smOutbound !== 'number' || !this.eligible(loaded)) {
          return { smState: null, joinedRooms }
        }
        return { smState: loaded, joinedRooms }
      }
    } catch {
      // Storage errors are non-fatal
    }
    return { smState: null, joinedRooms: [] }
  }

  /** Clear SM state from storage (manual disconnect). */
  async clear(jid: string): Promise<void> {
    if (!this.deps.storageAdapter) {
      return
    }
    try {
      await this.deps.storageAdapter.clearSessionState(jid)
    } catch {
      // Storage errors are non-fatal
    }
  }
}
