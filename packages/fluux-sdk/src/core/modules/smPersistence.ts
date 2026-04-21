/**
 * Stream Management state persistence.
 *
 * Manages the SM state cache (survives socket death) and
 * storage persistence (survives page reload). Extracted from
 * Connection.ts for independent testing and clearer boundaries.
 */

import type { StorageAdapter, JoinedRoomInfo } from '../types'
import type { ResolutionLogger } from './serverResolution'

/** SM timeout — state older than this is considered stale (10 minutes). */
const SM_TIMEOUT_MS = 10 * 60 * 1000

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
  /** When this cache entry was last updated (ms since epoch). Used for staleness detection. */
  timestamp: number
}

/** Dependencies injected by Connection. */
export interface SmPersistenceDeps {
  storageAdapter?: StorageAdapter
  getJoinedRooms: () => JoinedRoomInfo[]
  console: ResolutionLogger
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

  /** Update cache when SM is enabled or resumed. */
  updateCache(id: string, inbound: number, outbound: number): void {
    this.cache = { id, inbound, outbound, timestamp: Date.now() }
  }

  /** Clear cache (manual disconnect → fresh session next time). */
  clearCache(): void {
    this.cache = null
  }

  /** Get cached SM state (may be null if no SM session or if stale). */
  getCache(): SmStateCache | null {
    if (this.cache && Date.now() - this.cache.timestamp > SM_TIMEOUT_MS) {
      return null
    }
    return this.cache
  }

  /**
   * Get SM state: prefer live state from the xmpp client, fall back to cache.
   * The cache survives socket death, so it's available even when the client is gone.
   *
   * @param xmpp - The xmpp.js client instance (may be null after socket death)
   */
  getState(xmpp: any): SmStateCache | null {
    // Try to get live state from the xmpp client
    if (xmpp?.streamManagement) {
      const sm = xmpp.streamManagement as any
      if (sm.id) {
        // Capture total outbound: already-acked (sm.outbound) + still-pending (outbound_q).
        // Server's <resumed h=N/> counts *every* stanza it received, acked or not — so
        // persisting just sm.outbound would leave us short when the queue was non-empty
        // at disconnect and the crash path would re-open.
        const pendingOutbound = Array.isArray(sm.outbound_q) ? sm.outbound_q.length : 0
        const outbound = (sm.outbound || 0) + pendingOutbound
        this.cache = { id: sm.id, inbound: sm.inbound || 0, outbound, timestamp: Date.now() }
        return this.cache
      }
    }
    // Fall back to cached state (survives socket death), but reject stale entries.
    // After a long sleep (> SM timeout), the server has expired the session.
    // Returning null forces a fresh session instead of a doomed SM resume attempt.
    if (this.cache && Date.now() - this.cache.timestamp > SM_TIMEOUT_MS) {
      return null
    }
    return this.cache
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
        resource: resource || '',
        timestamp: Date.now(),
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
      resource: resource || '',
      timestamp: Date.now(),
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
        // Check if state is stale (> 10 minutes old — typical SM timeout)
        if (Date.now() - state.timestamp > SM_TIMEOUT_MS) {
          // SM state is stale, but joined rooms are still useful for rejoin
          return { smState: null, joinedRooms: state.joinedRooms ?? [] }
        }
        // Sessions persisted before smOutbound was introduced can't safely resume
        // — without it, ackQueue would crash when the server's h exceeds our count.
        // Drop SM state (keep rooms for rejoin).
        if (typeof state.smOutbound !== 'number') {
          return { smState: null, joinedRooms: state.joinedRooms ?? [] }
        }
        return {
          smState: {
            id: state.smId,
            inbound: state.smInbound,
            outbound: state.smOutbound,
            timestamp: state.timestamp,
          },
          joinedRooms: state.joinedRooms ?? [],
        }
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
