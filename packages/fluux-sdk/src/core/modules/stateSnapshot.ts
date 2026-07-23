/**
 * SDK-owned snapshot of SM-resumable state.
 *
 * Everything the XMPP server preserves across a Stream Management resume
 * (joined rooms with occupants, roster with per-resource presence, server
 * discovery, own profile) is mirrored here. The snapshot has three jobs:
 *
 *  1. **Auto-persist** store updates to `StorageAdapter` — debounced, one
 *     bucket per domain, so routine state churn doesn't hammer storage.
 *  2. **Hydrate** stores from storage before the socket is started, so any
 *     stanza the server replays on resume lands on a populated state
 *     instead of silently patching empty Maps.
 *  3. **Flush** pending writes on demand (e.g. `beforeunload`).
 *
 * Design rule: the *live* store is the source of truth at runtime. Storage
 * exists only to survive page context loss (reload, crash, tab switch).
 */
import type { StorageAdapter } from '../types/storage'
import type {
  Contact,
  Room,
  RoomOccupant,
  RoomMessage,
  ResourcePresence,
  ServerInfo,
  HttpUploadService,
} from '../types'
import { rosterStore } from '../../stores/rosterStore'
import { roomStore } from '../../stores/roomStore'
import { connectionStore } from '../../stores/connectionStore'
import {
  deserializeReadPointer,
  serializeReadPointer,
  type SerializedReadPointer,
} from '../../stores/shared/readPointer'
import { logInfo } from '../logger'

const PERSIST_DEBOUNCE_MS = 500

/**
 * Keep the most recent N messages per room in the snapshot so the UI has
 * context when hydrating on reload. Matches ejabberd's default join history.
 */
const MAX_MESSAGES_PER_ROOM = 50

// ── Serialized shapes ──────────────────────────────────────────────────────

interface SerializedResource extends Omit<ResourcePresence, 'lastInteraction'> {
  lastInteraction?: string
}

interface SerializedContact extends Omit<Contact, 'resources' | 'lastInteraction' | 'lastSeen' | 'avatar'> {
  resources?: [string, SerializedResource][]
  lastInteraction?: string
  lastSeen?: string
}

interface SerializedRoomMessage extends Omit<RoomMessage, 'timestamp' | 'retractedAt'> {
  timestamp: string
  retractedAt?: string
}

interface SerializedRoom {
  jid: string
  name: string
  nickname: string
  joined: boolean
  subject?: string
  avatarHash?: string
  occupants: [string, RoomOccupant][]
  selfOccupant?: RoomOccupant
  unreadCount: number
  mentionsCount: number
  isBookmarked: boolean
  autojoin?: boolean
  password?: string
  notifyAll?: boolean
  notifyAllPersistent?: boolean
  isQuickChat?: boolean
  muted?: boolean
  supportsMAM?: boolean
  supportsReactions?: boolean
  supportsHats?: boolean
  isIrcGateway?: boolean
  /**
   * Where the user has read to (#1081), replacing the `lastReadAt` this shape
   * used to carry. A snapshot without it restores rooms with no read position at
   * all, and `recomputeCountsFromPointer` treats a pointerless entity as fresh:
   * pointer snapped to the newest message, counts zeroed, unread history
   * silently marked read. The pointer is forward-only, so that is permanent.
   */
  readPointer?: SerializedReadPointer
  messages: SerializedRoomMessage[]
}

interface SerializedServerSnapshot {
  serverInfo: ServerInfo | null
  httpUploadService: HttpUploadService | null
}

interface SerializedProfile {
  avatarHash: string | null
  nickname: string | null
  ownResources?: [string, SerializedResource][]
}

// ── Serializers ────────────────────────────────────────────────────────────

function serializeResource(r: ResourcePresence): SerializedResource {
  return {
    ...r,
    lastInteraction: r.lastInteraction?.toISOString(),
  }
}

function deserializeResource(r: SerializedResource): ResourcePresence {
  return {
    ...r,
    lastInteraction: r.lastInteraction ? new Date(r.lastInteraction) : undefined,
  }
}

function serializeContact(c: Contact): SerializedContact {
  // Avatar blob URLs are per-page and will be rebuilt from the cache using
  // avatarHash; don't persist them.
  const { avatar: _avatar, ...rest } = c
  return {
    ...rest,
    resources: c.resources
      ? Array.from(c.resources.entries()).map(([k, r]) => [k, serializeResource(r)])
      : undefined,
    lastInteraction: c.lastInteraction?.toISOString(),
    lastSeen: c.lastSeen?.toISOString(),
  }
}

function deserializeContact(c: SerializedContact): Contact {
  return {
    ...c,
    resources: c.resources
      ? new Map(c.resources.map(([k, r]) => [k, deserializeResource(r)]))
      : undefined,
    lastInteraction: c.lastInteraction ? new Date(c.lastInteraction) : undefined,
    lastSeen: c.lastSeen ? new Date(c.lastSeen) : undefined,
  } as Contact
}

function serializeRoomMessage(m: RoomMessage): SerializedRoomMessage {
  return {
    ...m,
    timestamp: m.timestamp.toISOString(),
    retractedAt: m.retractedAt?.toISOString(),
  }
}

function deserializeRoomMessage(m: SerializedRoomMessage): RoomMessage {
  return {
    ...m,
    timestamp: new Date(m.timestamp),
    retractedAt: m.retractedAt ? new Date(m.retractedAt) : undefined,
  }
}

function serializeRoom(r: Room): SerializedRoom {
  return {
    jid: r.jid,
    name: r.name,
    nickname: r.nickname,
    joined: r.joined,
    subject: r.subject,
    avatarHash: r.avatarHash,
    occupants: Array.from(r.occupants.entries()),
    selfOccupant: r.selfOccupant,
    unreadCount: r.unreadCount,
    mentionsCount: r.mentionsCount,
    isBookmarked: r.isBookmarked,
    autojoin: r.autojoin,
    password: r.password,
    notifyAll: r.notifyAll,
    notifyAllPersistent: r.notifyAllPersistent,
    isQuickChat: r.isQuickChat,
    muted: r.muted,
    supportsMAM: r.supportsMAM,
    supportsReactions: r.supportsReactions,
    supportsHats: r.supportsHats,
    isIrcGateway: r.isIrcGateway,
    readPointer: r.readPointer ? serializeReadPointer(r.readPointer) : undefined,
    messages: r.messages.slice(-MAX_MESSAGES_PER_ROOM).map(serializeRoomMessage),
  }
}

function deserializeRoom(r: SerializedRoom): Room {
  return {
    ...r,
    occupants: new Map(r.occupants),
    typingUsers: new Set<string>(),
    messages: (r.messages || []).map(deserializeRoomMessage),
    // Rebuilt rather than carried by the spread: the persisted `timestamp` is a
    // number, and a pointer holding one would compare false against every
    // message Date it met instead of throwing. `deserializeReadPointer` yields
    // `undefined` for anything malformed, which `addRoom` then resolves from the
    // durable read state rather than trusting the snapshot.
    readPointer: deserializeReadPointer(r.readPointer),
    avatar: undefined,
  } as Room
}

// ── Module ─────────────────────────────────────────────────────────────────

export interface StateSnapshotDeps {
  storageAdapter?: StorageAdapter
  getJid: () => string | null
}

type Bucket = 'roster' | 'rooms' | 'serverInfo' | 'profile'

export class StateSnapshot {
  private unsubscribers: Array<() => void> = []
  private writeTimers = new Map<Bucket, ReturnType<typeof setTimeout>>()

  constructor(private deps: StateSnapshotDeps) {}

  /**
   * Load persisted snapshot into the live stores.
   *
   * Callers MUST invoke this before handing the socket to xmpp.js: SM replay
   * stanzas are patches on existing state, not full snapshots, so any occupant
   * leave / presence change / message for a non-populated room is lost.
   *
   * Each store slice is hydrated only when currently empty — an app-level
   * persistence layer (or mid-session reconnect continuity) that has already
   * populated the store wins, which avoids overwriting potentially-fresher
   * data with a stale snapshot.
   */
  async hydrate(jid: string): Promise<void> {
    const adapter = this.deps.storageAdapter
    if (!adapter) return

    try {
      if (adapter.getRoster && rosterStore.getState().contacts.size === 0) {
        const saved = (await adapter.getRoster(jid)) as SerializedContact[] | null
        if (Array.isArray(saved) && saved.length > 0) {
          rosterStore.getState().setContacts(saved.map(deserializeContact))
          logInfo(`StateSnapshot: hydrated ${saved.length} contact(s)`)
        }
      }

      if (adapter.getRooms && roomStore.getState().rooms.size === 0) {
        const saved = (await adapter.getRooms(jid)) as SerializedRoom[] | null
        if (Array.isArray(saved) && saved.length > 0) {
          const addRoom = roomStore.getState().addRoom
          for (const s of saved) {
            addRoom(deserializeRoom(s))
          }
          logInfo(`StateSnapshot: hydrated ${saved.length} room(s)`)
        }
      }

      const conn = connectionStore.getState()
      if (adapter.getServerInfo && !conn.serverInfo) {
        const saved = (await adapter.getServerInfo(jid)) as SerializedServerSnapshot | null
        if (saved?.serverInfo) conn.setServerInfo(saved.serverInfo)
        if (saved?.httpUploadService) conn.setHttpUploadService(saved.httpUploadService)
      }

      if (adapter.getProfile && !conn.ownNickname && !conn.ownAvatarHash) {
        const saved = (await adapter.getProfile(jid)) as SerializedProfile | null
        if (saved?.nickname) conn.setOwnNickname(saved.nickname)
        if (saved?.avatarHash) {
          // setOwnAvatar(null, hash) records the hash so the avatar cache can
          // rebuild the blob URL asynchronously. Leaving the blob URL itself
          // unset — it's a per-page ObjectURL and must be recreated.
          conn.setOwnAvatar(null, saved.avatarHash)
        }
        if (saved?.ownResources) {
          for (const [resource, r] of saved.ownResources) {
            const p = deserializeResource(r)
            conn.updateOwnResource(resource, p.show, p.priority, p.status, p.lastInteraction, p.client)
          }
        }
      }
    } catch (err) {
      logInfo(`StateSnapshot: hydrate failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Subscribe to store changes and persist debounced.
   * Must be called after stores are initialized; safe to call multiple times
   * (idempotent — `stop()` first if re-binding).
   */
  start(): void {
    const adapter = this.deps.storageAdapter
    if (!adapter || this.unsubscribers.length > 0) return

    // Roster contacts — includes per-resource presence.
    // rosterStore doesn't use subscribeWithSelector middleware, so we diff manually.
    if (adapter.setRoster) {
      let prevContacts = rosterStore.getState().contacts
      this.unsubscribers.push(
        rosterStore.subscribe((state) => {
          if (state.contacts === prevContacts) return
          prevContacts = state.contacts
          this.schedule('roster', () => {
            const jid = this.deps.getJid()
            if (!jid || !adapter.setRoster) return
            const serialized = Array.from(state.contacts.values()).map(serializeContact)
            return adapter.setRoster(jid, serialized)
          })
        })
      )
    }

    // Rooms — full room state minus runtime-only caches
    if (adapter.setRooms) {
      this.unsubscribers.push(
        roomStore.subscribe(
          (s) => s.rooms,
          (rooms) => this.schedule('rooms', () => {
            const jid = this.deps.getJid()
            if (!jid || !adapter.setRooms) return
            const serialized = Array.from(rooms.values())
              .filter((r) => !r.isQuickChat)
              .map(serializeRoom)
            return adapter.setRooms(jid, serialized)
          })
        )
      )
    }

    // Server info + HTTP upload — cached to skip disco on reload
    if (adapter.setServerInfo) {
      const writeServerInfo = () => this.schedule('serverInfo', () => {
        const jid = this.deps.getJid()
        if (!jid || !adapter.setServerInfo) return
        const s = connectionStore.getState()
        return adapter.setServerInfo(jid, {
          serverInfo: s.serverInfo,
          httpUploadService: s.httpUploadService,
        })
      })
      this.unsubscribers.push(
        connectionStore.subscribe((s) => s.serverInfo, writeServerInfo)
      )
      this.unsubscribers.push(
        connectionStore.subscribe((s) => s.httpUploadService, writeServerInfo)
      )
    }

    // Own profile + resources
    if (adapter.setProfile) {
      const writeProfile = () => this.schedule('profile', () => {
        const jid = this.deps.getJid()
        if (!jid || !adapter.setProfile) return
        const s = connectionStore.getState()
        const payload: SerializedProfile = {
          avatarHash: s.ownAvatarHash,
          nickname: s.ownNickname,
          ownResources: s.ownResources.size > 0
            ? Array.from(s.ownResources.entries()).map(([k, r]) => [k, serializeResource(r)])
            : undefined,
        }
        return adapter.setProfile(jid, payload)
      })
      this.unsubscribers.push(connectionStore.subscribe((s) => s.ownAvatarHash, writeProfile))
      this.unsubscribers.push(connectionStore.subscribe((s) => s.ownNickname, writeProfile))
      this.unsubscribers.push(connectionStore.subscribe((s) => s.ownResources, writeProfile))
    }
  }

  /** Tear down subscriptions and cancel any pending debounced writes. */
  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers.length = 0
    for (const t of this.writeTimers.values()) clearTimeout(t)
    this.writeTimers.clear()
  }

  /**
   * Flush pending debounced writes immediately. Async — callers that need
   * synchronous persistence (beforeunload) should use `persistSmStateNow`
   * instead, which writes the critical SM counters synchronously.
   */
  async flush(): Promise<void> {
    const adapter = this.deps.storageAdapter
    const jid = this.deps.getJid()
    for (const t of this.writeTimers.values()) clearTimeout(t)
    this.writeTimers.clear()
    if (!adapter || !jid) return

    const jobs: Array<Promise<unknown>> = []

    if (adapter.setRoster) {
      const serialized = Array.from(rosterStore.getState().contacts.values()).map(serializeContact)
      jobs.push(adapter.setRoster(jid, serialized))
    }
    if (adapter.setRooms) {
      const serialized = Array.from(roomStore.getState().rooms.values())
        .filter((r) => !r.isQuickChat)
        .map(serializeRoom)
      jobs.push(adapter.setRooms(jid, serialized))
    }
    if (adapter.setServerInfo) {
      const s = connectionStore.getState()
      jobs.push(adapter.setServerInfo(jid, {
        serverInfo: s.serverInfo,
        httpUploadService: s.httpUploadService,
      }))
    }
    if (adapter.setProfile) {
      const s = connectionStore.getState()
      const payload: SerializedProfile = {
        avatarHash: s.ownAvatarHash,
        nickname: s.ownNickname,
        ownResources: s.ownResources.size > 0
          ? Array.from(s.ownResources.entries()).map(([k, r]) => [k, serializeResource(r)])
          : undefined,
      }
      jobs.push(adapter.setProfile(jid, payload))
    }

    await Promise.allSettled(jobs)
  }

  /** Clear all snapshot data for a JID. Used on logout. */
  async clear(jid: string): Promise<void> {
    const adapter = this.deps.storageAdapter
    if (!adapter) return
    const jobs: Array<Promise<unknown>> = []
    if (adapter.clearRoster) jobs.push(adapter.clearRoster(jid))
    if (adapter.clearRooms) jobs.push(adapter.clearRooms(jid))
    if (adapter.clearServerInfo) jobs.push(adapter.clearServerInfo(jid))
    if (adapter.clearProfile) jobs.push(adapter.clearProfile(jid))
    await Promise.allSettled(jobs)
  }

  private schedule(bucket: Bucket, fn: () => Promise<unknown> | undefined): void {
    const existing = this.writeTimers.get(bucket)
    if (existing) clearTimeout(existing)
    const t = setTimeout(async () => {
      this.writeTimers.delete(bucket)
      try {
        await fn()
      } catch {
        // Storage errors are non-fatal — next change will try again.
      }
    }, PERSIST_DEBOUNCE_MS)
    this.writeTimers.set(bucket, t)
  }
}
