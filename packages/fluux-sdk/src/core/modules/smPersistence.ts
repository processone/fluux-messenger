/**
 * Stream Management state persistence.
 *
 * Manages the SM state cache (survives socket death) and
 * storage persistence (survives page reload). Extracted from
 * Connection.ts for independent testing and clearer boundaries.
 */

import type { Client, SmOutboundQueueItem } from '@xmpp/client'
import type { StorageAdapter, JoinedRoomInfo, SmResumptionState } from '../types'
import type { ResolutionLogger } from './serverResolution'
import { DEFAULT_SM_MAX_SECONDS, isWithinSmWindow, resolveSmWindowMs } from './smResumptionPolicy'
import { NS_STANZA_ID } from '../namespaces'

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
    /** `max` of the `<enabled/>` that started this session, as xmpp.js recorded it. */
    max?: unknown
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

/** What a discarded client had sent without an acknowledgement. */
export interface SmUnacknowledged {
  id: string
  /** The client's acknowledged stanza count when it was discarded. */
  acked: number
  /** Its stanzas after `acked`, in sending order. */
  items: SmOutboundQueueItem[]
}

/**
 * A chat message sent without an acknowledgement. Holds what is needed to find
 * its row and nothing of its content, because it is written to session storage.
 */
export interface SmUnconfirmedMessage {
  id: string
  /** The conversation it was sent to. */
  to: string
  /** The session it was sent in. Absent once the message is known to be unconfirmed. */
  session?: string
  /** Its position in that session's sent count, compared with the server's `h`. */
  sequence?: number
}

const unconfirmedStorageKey = (jid: string) => `fluux:session-unconfirmed:${jid}`

/**
 * The conversation messages among a client's unacknowledged stanzas. A message
 * of a conversation carries its own id as origin-id, including an encrypted one,
 * whose origin-id stays outside the encrypted payload.
 */
function unconfirmedMessagesIn(session: string, items: readonly unknown[], acked: number): SmUnconfirmedMessage[] {
  const messages: SmUnconfirmedMessage[] = []
  items.forEach((item, index) => {
    const stanza = (item as Partial<SmOutboundQueueItem> | null)?.stanza
    if (stanza?.name !== 'message' || stanza.attrs?.type !== 'chat') return
    const { id, to } = stanza.attrs
    if (typeof id !== 'string' || !id || typeof to !== 'string' || !to) return
    if (stanza.getChild?.('origin-id', NS_STANZA_ID)?.attrs.id !== id) return
    messages.push({ id, to, session, sequence: acked + index + 1 })
  })
  return messages
}

/** One record per message, oldest to newest in: a Retry reuses the id, and its latest attempt decides. */
function latestById(messages: readonly SmUnconfirmedMessage[]): SmUnconfirmedMessage[] {
  const byId = new Map<string, SmUnconfirmedMessage>()
  for (const message of messages) byId.set(message.id, message)
  return [...byId.values()]
}

function isStoredUnconfirmed(value: unknown): value is SmUnconfirmedMessage {
  const entry = value as Partial<SmUnconfirmedMessage> | null
  if (typeof entry?.id !== 'string' || !entry.id || typeof entry.to !== 'string' || !entry.to) return false
  if (entry.session === undefined) return entry.sequence === undefined
  return typeof entry.session === 'string' && Number.isSafeInteger(entry.sequence)
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
  private unacknowledged: SmUnacknowledged | null = null
  /** Messages restored from storage, and those now known to be unconfirmed (no `session`). */
  private unconfirmed: SmUnconfirmedMessage[] = []
  /** Records handed over by `takeUnconfirmed` whose result has not come back yet. */
  private reportingUnconfirmed = new Set<SmUnconfirmedMessage>()
  /** Ids of messages a Retry is sending, until the stream holds the new attempt. */
  private retrying = new Set<string>()
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
    this.settleNewSession()
    this.cache = { id, inbound, outbound: 0, timestamp: Date.now(), windowMs }
    return windowMs
  }

  /**
   * Keep what a client about to be discarded has sent without an acknowledgement,
   * so the next client can resend it if the server resumes this session. A client
   * without a session id has nothing to add, and leaves what was kept in place.
   *
   * Memory only: these stanzas can hold message text, so they are never written
   * to storage, and a page reload cannot resend them. A reload keeps only which
   * messages they were (see `saveUnconfirmed`).
   */
  keepUnacknowledged(xmpp: Client | null): void {
    const sm = xmpp?.streamManagement
    if (!sm?.id || !Array.isArray(sm.outbound_q)) return
    this.unacknowledged = { id: sm.id, acked: sm.outbound || 0, items: [...sm.outbound_q] }
  }

  /** What was kept for session `id`, if anything. */
  getUnacknowledged(id: string): SmUnacknowledged | null {
    return this.unacknowledged?.id === id ? this.unacknowledged : null
  }

  // ── Messages the server did not confirm ───────────────────────────────────

  /**
   * Save which messages have no acknowledgement yet, for the next page load.
   * Synchronous, for page-unload handlers. Stores ids, addresses and positions,
   * never message text.
   */
  saveUnconfirmed(jid: string, xmpp: SmStateSource | null): void {
    const sm = xmpp?.streamManagement
    const live = sm?.id && Array.isArray(sm.outbound_q)
      ? unconfirmedMessagesIn(sm.id, sm.outbound_q, sm.outbound || 0)
      : []
    const kept = this.unacknowledged
      ? unconfirmedMessagesIn(this.unacknowledged.id, this.unacknowledged.items, this.unacknowledged.acked)
      : []
    // An attempt still queued from before a Retry says nothing about the Retry, which has not gone out.
    const tracked = [...kept, ...live].filter((message) => !this.retrying.has(message.id))
    this.writeUnconfirmed(jid, latestById([...this.unconfirmed, ...tracked]))
  }

  /** Read back what the previous page load saved. */
  restoreUnconfirmed(jid: string): void {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(unconfirmedStorageKey(jid)) ?? '[]')
      if (!Array.isArray(stored)) return
      this.unconfirmed = latestById([...stored.filter(isStoredUnconfirmed), ...this.unconfirmed])
    } catch {
      // Storage errors are non-fatal
    }
  }

  /**
   * The server resumed `session` and reported having received `h` stanzas.
   * Restored messages past `h` never arrived, and their text is gone with the
   * previous page. Messages kept in memory are not counted: they are being resent.
   */
  settleResumed(session: string, h: number): void {
    this.unconfirmed = this.unconfirmed.flatMap((message) => {
      if (message.session === undefined) return [message]
      if (message.session === session && message.sequence! <= h) return []
      return [{ id: message.id, to: message.to }]
    })
  }

  /**
   * A new session started, so the server will not say what the old one received.
   * Everything still waiting becomes unconfirmed. An archived copy clears a
   * message that did arrive.
   */
  settleNewSession(): void {
    const kept = this.unacknowledged
      ? unconfirmedMessagesIn(this.unacknowledged.id, this.unacknowledged.items, this.unacknowledged.acked)
      : []
    this.unacknowledged = null
    this.unconfirmed = latestById([...this.unconfirmed, ...kept]).map((message) =>
      message.session === undefined ? message : { id: message.id, to: message.to })
  }

  /**
   * Hand over the messages known to be unconfirmed. Each stays recorded, in memory
   * and in storage, until `settleUnconfirmed` says its mark was saved, so a reload
   * or a failed write in between cannot lose it.
   */
  takeUnconfirmed(jid: string): SmUnconfirmedMessage[] {
    const taken = this.unconfirmed.filter(
      (message) => message.session === undefined
        && !this.reportingUnconfirmed.has(message)
        && !this.retrying.has(message.id),
    )
    for (const message of taken) this.reportingUnconfirmed.add(message)
    this.writeUnconfirmed(jid, this.unconfirmed)
    return taken
  }

  /** The result of a handed-over message: settled forgets it, otherwise the next connection reports it again. */
  settleUnconfirmed(jid: string, message: SmUnconfirmedMessage, settled: boolean): void {
    if (!this.reportingUnconfirmed.delete(message) || !settled) return
    this.unconfirmed = this.unconfirmed.filter((held) => held !== message)
    this.writeUnconfirmed(jid, this.unconfirmed)
  }

  /**
   * A Retry has cleared the visible error and is preparing the message. Until the
   * stream holds it, this record is what shows it was not delivered if the page
   * reloads, so it is saved now and not reported on this page meanwhile.
   */
  beginRetry(jid: string, id: string, to: string): void {
    this.retrying.add(id)
    this.unconfirmed = [...this.unconfirmed.filter((message) => message.id !== id), { id, to }]
    this.writeUnconfirmed(jid, this.unconfirmed)
  }

  /** Sent: the stream tracks this attempt now. Not sent: the record stays and is reported again. */
  endRetry(jid: string, id: string, sent: boolean): void {
    if (!this.retrying.delete(id) || !sent) return
    this.unconfirmed = this.unconfirmed.filter((message) => message.id !== id)
    this.writeUnconfirmed(jid, this.unconfirmed)
  }

  private writeUnconfirmed(jid: string, messages: readonly SmUnconfirmedMessage[]): void {
    try {
      if (messages.length > 0) sessionStorage.setItem(unconfirmedStorageKey(jid), JSON.stringify(messages))
      else sessionStorage.removeItem(unconfirmedStorageKey(jid))
    } catch {
      // Storage errors are non-fatal
    }
  }

  /**
   * Turn stored or caller-supplied state into a validated cache entry, or null
   * when it can no longer be resumed. Missing metadata means the original ten
   * minutes; without an interruption time the window runs from the capture, so
   * reading or saving the entry before a resumption cannot renew it.
   */
  restore(state: SmResumptionState): SmStateCache | null {
    if (typeof state.id !== 'string' || !state.id || typeof state.outbound !== 'number') return null
    const timestamp = typeof state.timestamp === 'number' ? state.timestamp : Date.now()
    const entry: SmStateCache = {
      id: state.id,
      inbound: state.inbound,
      outbound: state.outbound,
      timestamp,
      windowMs: typeof state.windowMs === 'number' && state.windowMs > 0
        ? state.windowMs
        : DEFAULT_SM_MAX_SECONDS * 1000,
      interruptedAt: typeof state.interruptedAt === 'number' ? state.interruptedAt : timestamp,
    }
    return this.eligible(entry) ? entry : null
  }

  /** Seed the cache from restored state so a later resumption keeps its window. */
  adopt(state: SmStateCache): void {
    this.cache = { ...state }
  }

  /** Update cache when SM is resumed. Keeps the negotiated window and clears the interruption. */
  updateCache(id: string, inbound: number, outbound: number): void {
    const windowMs = this.cache?.id === id
      ? this.cache.windowMs
      : resolveSmWindowMs(this.requestSeconds, undefined)
    this.cache = { id, inbound, outbound, timestamp: Date.now(), windowMs }
    // The resumed client holds whatever is still unacknowledged from here on.
    this.unacknowledged = null
  }

  /** The window (ms) of the current session, if any. */
  getWindowMs(): number | null {
    return this.cache ? Math.min(this.cache.windowMs, this.requestSeconds * 1000) : null
  }

  /**
   * Start the resumption window at `at` (default now). The earliest anchor
   * wins: a later loss or failed reconnect cannot advance it, while an earlier
   * suspension time supplied afterwards (wake after socket loss) can pull it back.
   */
  markInterrupted(at: number = Date.now()): void {
    if (!this.cache || !Number.isFinite(at)) return
    const anchor = Math.min(at, Date.now())
    this.cache.interruptedAt = Math.min(this.cache.interruptedAt ?? anchor, anchor)
  }

  /** The connection was verified live: the prior interruption is over. */
  clearInterruption(): void {
    if (this.cache) delete this.cache.interruptedAt
  }

  /** Get cached SM state (null if there is none or its window has run out). */
  getCache(): SmStateCache | null {
    return this.cache && this.eligible(this.cache) ? this.cache : null
  }

  /**
   * Stop trying to resume. What was kept stays until the new session starts,
   * which reports it as unconfirmed.
   */
  abandonResumption(): void {
    this.cache = null
  }

  /** Clear cache (manual disconnect → fresh session next time). */
  clearCache(): void {
    this.cache = null
    this.unacknowledged = null
    this.unconfirmed = []
    this.reportingUnconfirmed.clear()
    this.retrying.clear()
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
        windowMs: previous?.windowMs ?? resolveSmWindowMs(this.requestSeconds, sm.max),
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
        // Expired or unsafe records, or records saved before smOutbound existed
        // (ackQueue would crash when the server's h exceeds our count), cannot
        // resume. Keep the rooms for rejoin.
        const loaded = this.restore({
          id: state.smId,
          inbound: state.smInbound,
          outbound: state.smOutbound,
          timestamp: state.timestamp,
          windowMs: state.smWindowMs,
          interruptedAt: state.smInterruptedAt,
        })
        return { smState: loaded, joinedRooms }
      }
    } catch {
      // Storage errors are non-fatal
    }
    return { smState: null, joinedRooms: [] }
  }

  /** Clear SM state from storage (manual disconnect). */
  async clear(jid: string): Promise<void> {
    this.writeUnconfirmed(jid, [])
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
