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
  updateCache(id: string, inbound: number): void {
    this.cache = { id, inbound }
  }

  /** Clear cache (manual disconnect → fresh session next time). */
  clearCache(): void {
    this.cache = null
  }

  /** Get cached SM state (may be null if no SM session). */
  getCache(): SmStateCache | null {
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
        // Update cache with latest state
        this.cache = { id: sm.id, inbound: sm.inbound || 0 }
        return this.cache
      }
    }
    // Fall back to cached state (survives socket death)
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
      await this.deps.storageAdapter.setSessionState(jid, {
        smId: this.cache.id,
        smInbound: this.cache.inbound,
        resource: resource || '',
        timestamp: Date.now(),
        joinedRooms,
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
          await this.deps.storageAdapter.clearSessionState(jid)
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
