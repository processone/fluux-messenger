import { xml, type Element } from '@xmpp/client'
import { BaseModule, type ModuleDependencies } from './BaseModule'
import { RoomMarkerOrder } from './RoomMarkerOrder'
import { generateUUID } from '../../utils/uuid'
import { getBareJid, getResource } from '../jid'
import { NS_CHAT_MARKERS, NS_DISCO_INFO, NS_DATA_FORMS, NS_OCCUPANT_ID, NS_STANZA_ID, NS_HINTS, NS_MUC_USER, NS_MAM, NS_RSM, NS_FORWARD, NS_DELAY } from '../namespaces'
import type { RoomMessage } from '../types'
import type { MessageRowRef } from '../types/messageRow'
import { exactPosition, isAfterBoundary } from '../../stores/shared/readState'
import { getRoomModerationId, messageRowRef } from '../../utils/roomStanzaId'
import { roomSelf, isOwnRoomMessage } from '../../utils/roomSelf'
import { openIndexedDB } from '../../utils/idbConnection'

export interface RoomReadConsent {
  /** @deprecated Compatibility summary only: true when at least one room is selected, not a master consent. */
  enabled: boolean
  rooms: string[]
}
export interface RoomReader { occupantId: string; nick: string; avatar?: string }
interface Position { row: MessageRowRef; archiveId: string }
interface DiscoveryProof { features: string[]; count: number; epoch: number; connection: ReturnType<ModuleDependencies['getXmpp']> }
interface AccountState { consent: RoomReadConsent; sent: Record<string, Position> }
interface DiscoveryRequest {
  epoch: number; connection: DiscoveryProof['connection']; task: Promise<boolean>; isCurrent: () => boolean
  retryStep: number; retryAt?: number; retryTimer?: ReturnType<typeof setTimeout>
}
export const ROOM_MARKER_DISCOVERY_RETRY_DELAYS = [5_000, 10_000, 20_000, 40_000, 60_000] as const
const REQUEST_RETRY_MS = ROOM_MARKER_DISCOVERY_RETRY_DELAYS[0]
export const ROOM_MARKER_ORDER_PAGE_LIMIT = 20
export const ROOM_READ_MARKERS_STORAGE_KEY = 'fluux-room-read-markers'
const STORAGE_PREFIX = ROOM_READ_MARKERS_STORAGE_KEY + ':'
const CLEAR_GENERATION_KEY = STORAGE_PREFIX + 'clear-generation'
const storageKey = (account: string, kind: 'consent' | 'watermarks' | 'migration') => STORAGE_PREFIX + JSON.stringify([account, kind])
let storageRevision = 0
let allAccountsClearRevision = 0
const accountClearRevisions = new Map<string, number>()
const clearGeneration = (account: string) => `${allAccountsClearRevision}:${accountClearRevisions.get(account) ?? 0}`

async function withConsentStorage<T>(action: () => T): Promise<T> {
  const db = await openIndexedDB('fluux-room-read-coordination', 1, {
    upgrade: db => { db.createObjectStore('consent') },
    onClosed: () => {},
  })
  try {
    return await new Promise<T>((resolve, reject) => {
      // A single readwrite scope orders every tab's consent edits, conversion
      // and clears. Keep the localStorage work synchronous inside its request.
      const transaction = db.transaction('consent', 'readwrite')
      let result: T
      let failure: unknown
      transaction.objectStore('consent').get('turn').onsuccess = () => {
        try { result = action() } catch (error) { failure = error; transaction.abort() }
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Room consent transaction aborted'))
    })
  } finally { db.close() }
}

/** Remove consent and published-position references after earlier queued writes. */
export async function clearRoomReadMarkersLocalData(account: string | null, allAccounts = false): Promise<boolean> {
  const scoped = account ? getBareJid(account) : null
  if (!allAccounts && !scoped) return true
  storageRevision++
  if (allAccounts) { allAccountsClearRevision++; accountClearRevisions.clear() }
  else accountClearRevisions.set(scoped!, (accountClearRevisions.get(scoped!) ?? 0) + 1)
  const remove = () => {
    if (!allAccounts) {
      for (const kind of ['consent', 'watermarks', 'migration'] as const) localStorage.removeItem(storageKey(scoped!, kind))
      localStorage.setItem(CLEAR_GENERATION_KEY, generateUUID())
      return
    }
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
    localStorage.setItem(CLEAR_GENERATION_KEY, generateUUID())
  }
  try { await withConsentStorage(remove); return true } catch {
    // A denied coordination database must not stop the caller from erasing its
    // remaining account data. Report failure even when direct removal succeeds.
    try { remove() } catch { return false }
    return false
  }
}
export const ROOM_MARKER_OCCUPANT_LIMIT = 20
const NONE: readonly RoomReader[] = Object.freeze([])
const REQUIRED = ['muc_membersonly', 'muc_hidden', 'muc_nonanonymous', NS_OCCUPANT_ID, NS_STANZA_ID]
const CONTRADICTORY = ['muc_public', 'muc_open', 'muc_semianonymous', 'muc_anonymous']
const keyOf = (row: MessageRowRef) => JSON.stringify([row.id, row.occupantId ?? '', row.stanzaId ?? ''])
const canMark = (row: RoomMessage, roomJid: string) => !!getRoomModerationId(row) && row.roomJid === roomJid && !row.isPrivate
  && !row.systemEvent && !row.securityContext && !row.encryptedPayload && !row.unsupportedEncryption && !row.contentAvailability

/** Only a standalone marker may bypass the ordinary message owners. */
export function isStandaloneRoomReadMarker(stanza: Element): boolean {
  return stanza.is('message') && stanza.attrs.type === 'groupchat' && !!stanza.getChild('displayed', NS_CHAT_MARKERS)
    && stanza.children.every(child => typeof child === 'string' ? !child.trim() :
      child.is('displayed', NS_CHAT_MARKERS) || child.is('occupant-id', NS_OCCUPANT_ID)
      || child.is('stanza-id', NS_STANZA_ID) || child.is('origin-id', NS_STANZA_ID)
      || child.is('delay', NS_DELAY) || child.is('archived', 'urn:xmpp:mam:tmp')
      || ['store', 'no-store', 'no-copy', 'no-permanent-store'].some(name => child.is(name, NS_HINTS)))
}

/**
 * Room-only XEP-0333. Peer positions never enter the message or local-read stores.
 * `viewed` is a separate, explicit viewport seam: local/MDS read events cannot send.
 * Only proven server-archive order determines advancement; neither nicknames,
 * client IDs nor timestamps can order peer positions. A missing/ambiguous target is not relocated.
 */
export class RoomReadMarkers extends BaseModule {
  private seenStorageRevision = storageRevision
  private accounts = new Map<string, AccountState>()
  private refusedConsent = new Set<string>()
  private migrations = new Map<string, Promise<boolean>>()
  private consentEdits = new Map<string, symbol>()
  private stateConnection: ReturnType<ModuleDependencies['getXmpp']> | undefined
  private orders = new Map<string, RoomMarkerOrder>()
  private proofs = new Map<string, DiscoveryProof>()
  private discovery = new Map<string, DiscoveryRequest>()
  private probes = new Map<string, { revision: number; cursor: string; complete: boolean; retryAt?: number }>()
  private orderPending = new Map<string, { task: Promise<boolean>; isCurrent: () => boolean }>()
  private epochs = new Map<string, number>()
  private positions = new Map<string, Map<string, Position>>()
  private badgeRooms = new Set<string>()
  private badges = new Map<string, Map<string, readonly RoomReader[]>>()
  private listeners = new Set<() => void>()
  private pending = new Map<string, { task: Promise<void>; isCurrent: () => boolean }>()
  private queued = new Map<string, { row: RoomMessage; epoch: number; consent: number; isCurrent: () => boolean }>()
  private consentRevision = 0
  private lifecycle = 0

  constructor(deps: ModuleDependencies, private focused = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) { super(deps) }
  private onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === this.storageKey('consent') || event.key === this.storageKey('watermarks') || event.key === this.storageKey('migration')) this.reload()
  }

  private capture() {
    const session = super.captureQuery()
    const lifecycle = this.lifecycle
    const localDataRevision = storageRevision
    return { isCurrent: () => session.isCurrent() && lifecycle === this.lifecycle && localDataRevision === storageRevision }
  }
  /** Cancel old asynchronous work on provider teardown or module replacement. */
  cancelPending() {
    this.lifecycle++
    for (const request of this.discovery.values()) clearTimeout(request.retryTimer)
    this.queued.clear(); this.pending.clear(); this.proofs.clear(); this.discovery.clear(); this.probes.clear(); this.orderPending.clear()
    if (typeof window !== 'undefined') window.removeEventListener('storage', this.onStorage)
    const hadBadges = this.badgeRooms.size > 0
    this.badgeRooms.clear(); this.badges.clear()
    if (hadBadges) this.notify()
  }

  private account() {
    if (this.seenStorageRevision !== storageRevision) {
      this.seenStorageRevision = storageRevision
      this.consentRevision++
      this.accounts.clear(); this.proofs.clear(); this.orders.clear()
      this.positions.clear(); this.badges.clear(); this.badgeRooms.clear(); this.queued.clear()
    }
    const account = getBareJid(this.deps.getCurrentJid() ?? '')
    const connection = this.deps.getXmpp()
    if (connection !== this.stateConnection) {
      this.stateConnection = connection
      this.consentRevision++
      this.accounts.delete(account)
      this.queued.clear()
    }
    return account
  }
  private roomKey(roomJid: string) { return JSON.stringify([this.account(), roomJid]) }
  private storageKey(kind: 'consent' | 'watermarks' | 'migration') { return storageKey(this.account(), kind) }
  private state(): AccountState {
    const account = this.account()
    let state = this.accounts.get(account)
    if (!state) {
      state = { consent: { enabled: false, rooms: [] }, sent: {} }
      try {
        const watermarks = JSON.parse(localStorage.getItem(this.storageKey('watermarks')) ?? 'null') as Pick<AccountState, 'sent'> | null
        if (watermarks !== null) {
          if (!watermarks.sent || typeof watermarks.sent !== 'object' || Array.isArray(watermarks.sent)) throw new Error('Invalid room watermark storage')
          for (const [room, position] of Object.entries(watermarks.sent)) {
            if (typeof position?.archiveId !== 'string' || typeof position.row?.id !== 'string' || position.row.stanzaId !== position.archiveId) throw new Error('Invalid room watermark')
            state.sent[room] = { row: position.row, archiveId: position.archiveId }
          }
        }
      } catch { state = { consent: { enabled: false, rooms: [] }, sent: {} } }
      this.accounts.set(account, state)
    }
    return state
  }
  private readSavedConsent(account = this.account()) {
    const raw = localStorage.getItem(storageKey(account, 'consent'))
    const migrated = localStorage.getItem(storageKey(account, 'migration'))
    let value: unknown = null
    try { value = JSON.parse(raw ?? 'null') } catch { /* Malformed preferences convert to off, never to consent. */ }
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : null
    const validRooms = Array.isArray(record?.rooms) && record.rooms.every(room =>
      typeof room === 'string' && !!room && getBareJid(room) === room)
    const current = record?.version === 2 && validRooms
    const legacy = migrated === null && record?.version === undefined && typeof record?.enabled === 'boolean' && validRooms
    const rooms = current || (legacy && record?.enabled === true) ? [...new Set(record!.rooms as string[])] : []
    return { rooms, needsMigration: raw !== null && (migrated !== '2' || !current) }
  }
  private async writeConsent(update?: (rooms: string[]) => string[]): Promise<boolean> {
    const account = this.account()
    const generation = clearGeneration(account)
    if (!account) return false
    let changed = false
    try {
      // This anonymous generation also catches a paused tab still opening its
      // coordination connection when another runtime completes account clearing.
      const storedGeneration = localStorage.getItem(CLEAR_GENERATION_KEY)
      return await withConsentStorage(() => {
        if (generation !== clearGeneration(account) || storedGeneration !== localStorage.getItem(CLEAR_GENERATION_KEY)) {
          this.refusedConsent.add(account)
          return false
        }
        try {
          const saved = this.readSavedConsent(account)
          if (!update && !saved.needsMigration) return true
          const rooms = update ? update(this.refusedConsent.has(account) ? [] : saved.rooms) : saved.rooms
          changed = true
          // Fence first; failure of either write removes the reusable old opt-in.
          localStorage.setItem(storageKey(account, 'migration'), '2')
          localStorage.setItem(storageKey(account, 'consent'), JSON.stringify({ version: 2, rooms }))
          this.refusedConsent.delete(account)
          this.consentRevision++
          const state = this.accounts.get(account)
          if (state) state.consent = { enabled: rooms.length > 0, rooms }
          return true
        } catch {
          changed = true
          this.failConsentSave(account)
          return false
        }
      })
    } catch {
      if (changed || update) this.failConsentSave(account)
      else this.refusedConsent.add(account)
      return false
    } finally {
      if (changed && account === this.account()) this.notify()
    }
  }
  private migrateConsent() {
    const account = this.account()
    const pending = this.migrations.get(account)
    if (pending) return pending
    const task = this.writeConsent().finally(() => {
      if (this.migrations.get(account) === task) this.migrations.delete(account)
    })
    this.migrations.set(account, task)
    return task
  }
  private persist(): boolean {
    if (!this.account()) return false
    try { localStorage.setItem(this.storageKey('watermarks'), JSON.stringify({ sent: this.state().sent })); return true } catch { return false }
  }
  /** Re-read durable choices without creating a viewed event or missing account keys. */
  reload() {
    this.consentRevision++; this.queued.clear(); this.accounts.delete(this.account()); this.notify()
    try {
      if (this.readSavedConsent().needsMigration) return this.migrateConsent()
    } catch { this.refusedConsent.add(this.account()) }
    return Promise.resolve(true)
  }
  subscribe = (listener: () => void) => {
    if (!this.listeners.size && typeof window !== 'undefined') window.addEventListener('storage', this.onStorage)
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', this.onStorage)
    }
  }
  private notify() { for (const listener of this.listeners) listener() }
  getConsent = (): RoomReadConsent => {
    const state = this.state()
    if (this.refusedConsent.has(this.account())) {
      if (state.consent.enabled || state.consent.rooms.length) state.consent = { enabled: false, rooms: [] }
      return state.consent
    }
    // Recheck the durable choice at the send boundary too: a storage event can
    // still be queued when this tab takes the connection back.
    let consent: RoomReadConsent = { enabled: false, rooms: [] }
    if (this.account()) {
      try {
        const saved = this.readSavedConsent()
        if (saved.needsMigration) void this.migrateConsent()
        else consent = { enabled: saved.rooms.length > 0, rooms: saved.rooms }
      } catch { this.refusedConsent.add(this.account()) }
    }
    if (JSON.stringify(consent) !== JSON.stringify(state.consent)) {
      this.consentRevision++
      state.consent = consent
    }
    return state.consent
  }
  isEnabledFor(roomJid: string) { return !this.consentEdits.has(this.roomKey(roomJid)) && this.getConsent().rooms.includes(roomJid) }
  /** @deprecated Only legacy opt-out is supported; opting in requires an explicit room choice. */
  setEnabled(enabled: boolean): Promise<boolean> {
    if (enabled) return Promise.resolve(false)
    this.refusedConsent.add(this.account())
    this.consentRevision++; this.queued.clear(); this.notify()
    return this.writeConsent(() => [])
  }
  setRoomEnabled(roomJid: string, enabled: boolean): Promise<boolean> {
    if (!roomJid || getBareJid(roomJid) !== roomJid) return Promise.resolve(false)
    const key = this.roomKey(roomJid)
    const edit = Symbol()
    // A save can wait behind another tab's transaction. Suppress this tab immediately,
    // rather than allowing an already-queued viewed event to publish meanwhile.
    this.consentEdits.set(key, edit)
    this.consentRevision++; this.queued.clear(); this.notify()
    return this.writeConsent(latest => {
      const rooms = latest.filter(room => room !== roomJid)
      return enabled ? [...rooms, roomJid] : rooms
    }).finally(() => {
      if (this.consentEdits.get(key) === edit) this.consentEdits.delete(key)
      this.notify()
    })
  }
  private failConsentSave(account: string) {
    this.refusedConsent.add(account)
    const state = this.accounts.get(account)
    if (state) state.consent = { enabled: false, rooms: [] }
    // In particular, quota exhaustion must not leave an older opt-in ready to
    // reactivate on restart. Removing a key does not need more storage space.
    try { localStorage.removeItem(storageKey(account, 'consent')) } catch { /* The UI reports the unsaved choice. */ }
  }

  private discover(roomJid: string): Promise<boolean> {
    const key = this.roomKey(roomJid)
    const epoch = this.epochs.get(key) ?? 0
    const connection = this.deps.getXmpp()
    const proof = this.proofs.get(key)
    if (proof?.epoch === epoch && proof.connection === connection) return Promise.resolve(this.eligible(roomJid))
    const pending = this.discovery.get(key)
    const continuing = pending?.epoch === epoch && pending.connection === connection && pending.isCurrent()
    if (continuing && (pending.retryAt === undefined || Date.now() < pending.retryAt)) return pending.task
    clearTimeout(pending?.retryTimer)
    const query = this.capture()
    const task = Promise.resolve().then(() => this.queryDiscovery(roomJid))
    const entry: DiscoveryRequest = { epoch, connection, task, isCurrent: query.isCurrent, retryStep: continuing ? pending.retryStep : 0 }
    this.discovery.set(key, entry)
    void task.finally(() => {
      if (this.discovery.get(key) === entry && entry.retryAt === undefined) this.discovery.delete(key)
    }).catch(() => {})
    return task
  }

  private async queryDiscovery(roomJid: string): Promise<boolean> {
    const room = this.getRoomWithOccupants(roomJid)
    if (!room?.joined || room.isJoining || !this.deps.getXmpp()) return false
    const key = this.roomKey(roomJid)
    const epoch = this.epochs.get(key) ?? 0
    const query = this.capture()
    try {
      const response = await this.deps.sendIQ(xml('iq', { type: 'get', to: roomJid }, xml('query', { xmlns: NS_DISCO_INFO })), 10_000)
      if (!query.isCurrent() || epoch !== (this.epochs.get(key) ?? 0)) return false
      const info = response.attrs.from === roomJid ? response.getChild('query', NS_DISCO_INFO) : undefined
      const forms = info?.getChildren('x', NS_DATA_FORMS).filter(form => {
        const type = form.getChildren('field').filter(field => field.attrs.var === 'FORM_TYPE')
        return form.attrs.type === 'result' && type.length === 1 && type[0].getChildren('value').length === 1
          && type[0].getChildText('value') === 'http://jabber.org/protocol/muc#roominfo'
      }) ?? []
      const counts = forms.length === 1 ? forms[0].getChildren('field').filter(field => field.attrs.var === 'muc#roominfo_occupants') : []
      const value = counts.length === 1 && counts[0].getChildren('value').length === 1 ? counts[0].getChildText('value') : ''
      const count = /^\d+$/.test(value ?? '') ? Number(value) : NaN
      const features = info?.getChildren('feature').map(feature => feature.attrs.var) ?? []
      this.proofs.set(key, { features, count, epoch, connection: this.deps.getXmpp() })
      this.roomChanged(roomJid)
      return this.eligible(roomJid)
    } catch {
      const request = this.discovery.get(key)
      if (query.isCurrent() && epoch === (this.epochs.get(key) ?? 0) && request?.epoch === epoch) {
        // A transport failure is not negative room evidence. Retain the last
        // proven display; the old epoch still forbids sending until rechecked.
        const delay = ROOM_MARKER_DISCOVERY_RETRY_DELAYS[request.retryStep]
        request.retryStep = Math.min(request.retryStep + 1, ROOM_MARKER_DISCOVERY_RETRY_DELAYS.length - 1)
        // Slow persistent failures without losing eventual recovery. A new
        // roster/config epoch or connection restarts the initial delay.
        request.retryAt = Date.now() + delay
        request.retryTimer = setTimeout(() => {
          if (this.discovery.get(key) !== request || !query.isCurrent()) return
          // The elapsed timer is the due signal, even if wall time moved back.
          request.retryAt = -Infinity
          const held = this.queued.get(key)
          if (held?.isCurrent() && held.epoch === (this.epochs.get(key) ?? 0)
            && held.consent === this.consentRevision && this.focused() && this.isEnabledFor(roomJid)) {
            void this.viewed(roomJid, held.row).catch(() => {})
          } else {
            if (held && this.queued.get(key) === held) this.queued.delete(key)
            if (this.positions.has(key)) void this.discover(roomJid).catch(() => {})
          }
        }, delay)
      }
      return false
    }
  }

  /** @internal Join-owned exclusions only; not a positive eligibility proof. */
  mayQualify(roomJid: string): boolean {
    const room = this.getRoomWithOccupants(roomJid)
    return !!room?.joined && !room.isJoining && room.isPrivate !== false && room.isNonAnonymous !== false
      && room.occupants.size < ROOM_MARKER_OCCUPANT_LIMIT
  }

  /** @internal Revalidate a read-only room proof without publishing a position. */
  async ensureEligible(roomJid: string): Promise<boolean> {
    if (!this.mayQualify(roomJid)) return false
    return this.eligible(roomJid) || this.discover(roomJid)
  }

  eligible(roomJid: string): boolean {
    const key = this.roomKey(roomJid)
    const proof = this.proofs.get(key)
    const room = this.getRoomWithOccupants(roomJid)
    if (!proof || !room?.joined || room.isJoining || !this.deps.getXmpp() || proof.connection !== this.deps.getXmpp()
      || proof.epoch !== (this.epochs.get(key) ?? 0) || !REQUIRED.every(feature => proof.features.includes(feature))
      || CONTRADICTORY.some(feature => proof.features.includes(feature))) return false
    // Non-anonymous rooms deliver the full live roster on join. Cross-check the
    // room's own discovery count, including this session, rather than guessing.
    const own = room.occupants.get(room.nickname)
    return !!own?.occupantId && proof.count === room.occupants.size && proof.count > 0 && proof.count < ROOM_MARKER_OCCUPANT_LIMIT
      && [...room.occupants.values()].every(occupant => !!occupant.occupantId)
  }

  private order(roomJid: string) {
    const key = this.roomKey(roomJid)
    let order = this.orders.get(key)
    if (!order) { order = new RoomMarkerOrder(); this.orders.set(key, order) }
    return order
  }
  /** The archive supplies page order and its RSM cursor, independently of row timestamps. */
  recordArchiveOrder(roomJid: string, ids: readonly string[], cursor?: { before?: string; after?: string }) {
    this.order(roomJid).page(ids, cursor)
  }
  private async forward(roomJid: string, previous: string, candidate: string, allowPurged = false, resumeCapped = true): Promise<boolean> {
    const order = this.order(roomJid)
    if (previous === candidate || order.after(previous, candidate)) return false
    if (order.after(candidate, previous)) return true
    const key = JSON.stringify([this.roomKey(roomJid), previous, allowPurged])
    const pending = this.orderPending.get(key)
    if (pending?.isCurrent()) {
      await pending.task
      return this.order(roomJid).after(candidate, previous)
    }
    const session = this.capture()
    const roomKey = this.roomKey(roomJid)
    const epoch = this.epochs.get(roomKey) ?? 0
    const entry = {
      task: this.probeForward(roomJid, previous, candidate, allowPurged, resumeCapped, key),
      isCurrent: () => session.isCurrent() && epoch === (this.epochs.get(roomKey) ?? 0),
    }
    this.orderPending.set(key, entry)
    try { return await entry.task }
    finally { if (this.orderPending.get(key) === entry) this.orderPending.delete(key) }
  }

  private async probeForward(roomJid: string, previous: string, candidate: string, allowPurged: boolean, resumeCapped: boolean, probeKey: string): Promise<boolean> {
    const order = this.order(roomJid)
    // A restart or a nonresident target can leave no common page. Read server
    // order without putting probe messages in the timeline or touching coverage.
    // Bound the read; an unproved relation stops sharing rather than guessing.
    const session = this.capture()
    const roomKey = this.roomKey(roomJid)
    const epoch = this.epochs.get(roomKey) ?? 0
    const isCurrent = () => session.isCurrent() && epoch === (this.epochs.get(roomKey) ?? 0)
    const held = this.probes.get(probeKey)
    if (held?.retryAt && Date.now() < held.retryAt) return false
    if (held && held.revision === order.revision && (held.complete || !resumeCapped)) return false
    if (allowPurged && (!held || held.retryAt !== undefined) && this.deps.lookUpRoomArchiveAnchor) {
      const anchor = await this.deps.lookUpRoomArchiveAnchor(roomJid, previous)
      if (!isCurrent()) return false
      // The existing archive read-anchor contract treats a positively purged
      // anchor as older than retained history, never a failed/unknown lookup.
      if (anchor.kind === 'absent') { order.page([candidate], { after: previous }); return true }
    }
    if (!this.deps.registerMAMCollector) return false
    let after = held?.cursor ?? previous
    const remember = (complete: boolean, failed = false) => {
      if (this.probes.size >= 4096) this.probes.clear()
      this.probes.set(probeKey, { revision: order.revision, cursor: after, complete,
        retryAt: failed ? Date.now() + REQUEST_RETRY_MS : undefined })
    }
    for (let page = 0; page < ROOM_MARKER_ORDER_PAGE_LIMIT; page++) {
      if (!isCurrent()) return false;
      const queryid = generateUUID()
      const ids: string[] = []
      const unregister = this.deps.registerMAMCollector(queryid, stanza => {
        const result = stanza.getChild('result', NS_MAM)
        const message = result?.getChild('forwarded', NS_FORWARD)?.getChild('message')
        if (stanza.attrs.from === roomJid && result?.attrs.queryid === queryid && result.attrs.id
          && message?.attrs.type === 'groupchat' && getBareJid(message.attrs.from ?? '') === roomJid) ids.push(result.attrs.id)
      })
      try {
        const response = await this.deps.sendIQ(xml('iq', { type: 'set', to: roomJid },
          xml('query', { xmlns: NS_MAM, queryid },
            xml('x', { xmlns: NS_DATA_FORMS, type: 'submit' }, xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM))),
            xml('set', { xmlns: NS_RSM }, xml('max', {}, '100'), xml('after', {}, after)))), 10_000)
        const fin = response.getChild('fin', NS_MAM)
        if (!isCurrent()) return false
        if (response.attrs.from !== roomJid || !fin) { remember(false, true); return false }
        order.page(ids, { after })
        const last = fin.getChild('set', NS_RSM)?.getChildText('last')
        const canContinue = !!last && last !== after && ids.at(-1) === last
        if (canContinue) after = last
        remember(fin.attrs.complete === 'true', fin.attrs.complete !== 'true' && !canContinue)
        if (ids.includes(candidate)) {
          // A resumed RSM walk proves the whole interval even when the bounded
          // in-memory graph no longer retains its earliest individual edges.
          order.page([candidate], { after: previous })
          remember(fin.attrs.complete === 'true', fin.attrs.complete !== 'true' && !canContinue)
          return true
        }
        if (order.after(candidate, previous)) return true
        if (fin.attrs.complete === 'true' || !canContinue) return false
      } catch { if (isCurrent()) remember(false, true); return false } finally { unregister() }
    }
    remember(false)
    return false
  }

  /** Called before routing; it never claims direct chats or private room messages. */
  observe(stanza: Element): boolean {
    const from = stanza.attrs.from ?? ''
    const roomJid = getBareJid(from)
    if (!this.deps.stores?.room.getRoom(roomJid)) return false
    if (stanza.is('message') && stanza.attrs.type === 'groupchat' && !stanza.getChild('delay', NS_DELAY)) {
      const ids = stanza.getChildren('stanza-id', NS_STANZA_ID).filter(id => id.attrs.by === roomJid && id.attrs.id)
      if (ids.length === 1) this.order(roomJid).live(ids[0].attrs.id)
    }
    const config = stanza.is('message') && stanza.getChild('x', NS_MUC_USER)?.getChildren('status')
      .some(status => ['104', '170', '171', '172', '173'].includes(status.attrs.code))
    if (stanza.is('presence') || config) {
      const key = this.roomKey(roomJid)
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1)
      // Keep the last display proof while revalidating. Its old epoch already
      // forbids sending; removing it would unnecessarily resize every row.
      const query = this.capture()
      queueMicrotask(() => {
        if (!query.isCurrent()) return
        this.roomChanged(roomJid)
        // Revalidate display after a roster/configuration change. This cannot send.
        if (this.positions.has(key)) void this.discover(roomJid)
      })
    }
    if (stanza.is('message') && stanza.attrs.type === 'groupchat' && stanza.getChild('displayed', NS_CHAT_MARKERS) && !stanza.getChild('body')) {
      void this.receive(roomJid, stanza, [], !!stanza.getChild('delay', NS_DELAY)).catch(() => {})
      return isStandaloneRoomReadMarker(stanza)
    }
    return false
  }

  private async target(roomJid: string, id: string, additional: readonly RoomMessage[]): Promise<RoomMessage | null> {
    await this.deps.stores?.room.waitForMessageArrivals?.(roomJid)
    const resident = this.deps.stores?.room.getAllRoomMessages().find(room => room.jid === roomJid)?.messages ?? []
    const cached = await this.deps.stores?.room.getMessageByArchiveId?.(roomJid, id)
    const candidates = [...additional, ...resident, ...(cached ? [cached] : [])].filter(row => row.stanzaId === id)
    const unique = new Map(candidates.map(row => [keyOf(messageRowRef(row)), row]))
    if (unique.size !== 1) return null
    const row = [...unique.values()][0]
    return canMark(row, roomJid) ? row : null
  }

  async receive(roomJid: string, stanza: Element, additional: readonly RoomMessage[] = [], archived = false): Promise<void> {
    const displays = stanza.getChildren('displayed', NS_CHAT_MARKERS)
    const actors = stanza.getChildren('occupant-id', NS_OCCUPANT_ID)
    if (stanza.attrs.type !== 'groupchat' || getBareJid(stanza.attrs.from ?? '') !== roomJid || !getResource(stanza.attrs.from ?? '')
      || stanza.getChild('body') || displays.length !== 1 || !displays[0].attrs.id || actors.length !== 1 || !actors[0].attrs.id) return
    const query = this.capture()
    const key = this.roomKey(roomJid)
    if ((!this.eligible(roomJid) && !await this.discover(roomJid)) || !query.isCurrent()) return
    const epoch = this.epochs.get(key) ?? 0
    const row = await this.target(roomJid, displays[0].attrs.id, additional)
    if (!row || !query.isCurrent() || epoch !== (this.epochs.get(key) ?? 0) || !this.eligible(roomJid)) return
    const room = this.getRoomWithOccupants(roomJid)!
    const occupantId = actors[0].attrs.id
    const nick = getResource(stanza.attrs.from) ?? ''
    if (!archived && room.occupants.get(nick)?.occupantId !== occupantId) return
    const position = { row: messageRowRef(row), archiveId: row.stanzaId! }
    const positions = this.positions.get(key) ?? new Map<string, Position>()
    const previous = positions.get(occupantId)
    if (previous && !await this.forward(roomJid, previous.archiveId, position.archiveId, false, !archived)) return
    if (!query.isCurrent() || epoch !== (this.epochs.get(key) ?? 0) || !this.eligible(roomJid)) return
    // Another live/archive resolver can finish during the order probe.
    const latest = positions.get(occupantId)
    if (latest && latest !== previous && !this.order(roomJid).after(position.archiveId, latest.archiveId)) return
    positions.set(occupantId, position)
    this.positions.set(key, positions)
    if (occupantId === roomSelf(room).occupantId) {
      const sent = this.state().sent[roomJid]
      const advances = !sent || await this.forward(roomJid, sent.archiveId, position.archiveId, true, !archived)
      if (advances && query.isCurrent() && epoch === (this.epochs.get(key) ?? 0) && this.eligible(roomJid)) {
        this.rememberSent(roomJid, position)
      }
    }
    this.roomChanged(roomJid)
  }

  private rememberSent(roomJid: string, position: Position): boolean {
    const state = this.state()
    const previous = state.sent[roomJid]
    if (previous && !this.order(roomJid).after(position.archiveId, previous.archiveId)) return false
    state.sent[roomJid] = position
    // Write before the stream: an uncertain send must not be replayed as a new
    // read after restart. A failed durable write prevents publication entirely.
    if (!this.persist()) { if (previous) state.sent[roomJid] = previous; else delete state.sent[roomJid]; return false }
    return true
  }

  /** Explicit focused viewport evidence, after the existing read writer ran. */
  viewed(roomJid: string, row: RoomMessage): Promise<void> {
    if (!this.focused() || !this.isEnabledFor(roomJid) || !canMark(row, roomJid) || row.isOutgoing) return Promise.resolve()
    if (this.state().sent[roomJid]?.archiveId === row.stanzaId) return Promise.resolve()
    const key = this.roomKey(roomJid)
    const query = this.capture()
    const held = this.queued.get(key)
    if (!held || !held.isCurrent() || held.epoch !== (this.epochs.get(key) ?? 0) || held.consent !== this.consentRevision
      || this.order(roomJid).after(row.stanzaId!, held.row.stanzaId!)) {
      this.queued.set(key, { row, epoch: this.epochs.get(key) ?? 0, consent: this.consentRevision, isCurrent: query.isCurrent })
    }
    const running = this.pending.get(key)
    if (running?.isCurrent()) return running.task
    // Advances that arrive before discovery finishes collapse to the furthest
    // actually visible incoming row. This queue is never fed by read-store events.
    const task = Promise.resolve().then(async () => {
      while (query.isCurrent() && this.queued.has(key)) {
        const initial = this.queued.get(key)!
        const discovered = initial.isCurrent() && await this.discover(roomJid)
        if (!initial.isCurrent()) {
          if (this.queued.get(key) === initial) this.queued.delete(key)
          continue
        }
        const candidate = this.queued.get(key)
        if (!candidate) continue
        const authorized = () => candidate.isCurrent() && candidate.epoch === (this.epochs.get(key) ?? 0)
          && candidate.consent === this.consentRevision && this.focused() && this.isEnabledFor(roomJid)
        if (!discovered && authorized()) {
          if (candidate.epoch !== initial.epoch) continue
          if (this.discovery.get(key)?.retryAt !== undefined) break
        }
        this.queued.delete(key)
        const current = () => authorized() && this.eligible(roomJid)
        if (!discovered || !current()) continue
        const confirmed = await this.target(roomJid, candidate.row.stanzaId!, [])
        if (!confirmed || keyOf(messageRowRef(confirmed)) !== keyOf(messageRowRef(candidate.row)) || !current()) continue
        const room = this.getRoomWithOccupants(roomJid)!
        if (confirmed.isOutgoing || isOwnRoomMessage(confirmed.nick, confirmed.occupantId, roomSelf(room))
          || !room.readPointer || isAfterBoundary(exactPosition(confirmed, 'room'), room.readPointer.order)) continue
        const position = { row: messageRowRef(confirmed), archiveId: confirmed.stanzaId! }
        const previous = this.state().sent[roomJid]
        const reflected = this.positions.get(key)?.get(roomSelf(room).occupantId ?? '')
        if (reflected && !await this.forward(roomJid, reflected.archiveId, position.archiveId, true)) continue
        if (previous && !await this.forward(roomJid, previous.archiveId, position.archiveId, true)) continue
        if (!current() || !this.rememberSent(roomJid, position)) continue
        await this.deps.sendStanza(xml('message', { type: 'groupchat', to: roomJid },
          xml('displayed', { xmlns: NS_CHAT_MARKERS, id: position.archiveId }), xml('store', { xmlns: NS_HINTS })))
      }
    })
    const entry = { task, isCurrent: query.isCurrent }
    this.pending.set(key, entry)
    void task.finally(() => { if (this.pending.get(key) === entry) this.pending.delete(key) }).catch(() => {})
    return task
  }

  /** Roster/position changes rebuild only the per-row badge snapshots. */
  roomChanged(roomJid: string) {
    const key = this.roomKey(roomJid)
    const room = this.getRoomWithOccupants(roomJid)
    const proof = this.proofs.get(key)
    if (room?.joined && !room.isJoining && proof && proof.connection === this.deps.getXmpp()
      && proof.epoch !== (this.epochs.get(key) ?? 0)) return
    const before = this.badges.get(key) ?? new Map<string, readonly RoomReader[]>()
    const after = new Map<string, RoomReader[]>()
    const wasEligible = this.badgeRooms.has(key)
    const eligible = !!room && this.eligible(roomJid)
    if (eligible) this.badgeRooms.add(key)
    else this.badgeRooms.delete(key)
    if (room && eligible) {
      const self = roomSelf(room).occupantId
      for (const occupant of room.occupants.values()) {
        if (!occupant.occupantId || occupant.occupantId === self) continue
        const position = this.positions.get(key)?.get(occupant.occupantId)
        if (!position) continue
        const rowKey = keyOf(position.row)
        const readers = after.get(rowKey) ?? []
        if (!readers.some(reader => reader.occupantId === occupant.occupantId)) readers.push({ occupantId: occupant.occupantId, nick: occupant.nick, avatar: occupant.avatar })
        after.set(rowKey, readers)
      }
    }
    let changed = wasEligible !== eligible || before.size !== after.size
    const next = new Map<string, readonly RoomReader[]>()
    for (const [row, readers] of after) {
      const held = before.get(row)
      if (held && JSON.stringify(held) === JSON.stringify(readers)) next.set(row, held)
      else { next.set(row, readers); changed = true }
    }
    this.badges.set(key, next)
    if (changed) this.notify()
  }
  showsBadges(roomJid: string): boolean { return this.badgeRooms.has(this.roomKey(roomJid)) }
  readers(roomJid: string, row: MessageRowRef): readonly RoomReader[] { return this.badges.get(this.roomKey(roomJid))?.get(keyOf(messageRowRef(row))) ?? NONE }
}
