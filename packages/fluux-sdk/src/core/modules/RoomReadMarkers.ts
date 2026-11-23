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

export interface RoomReadConsent { enabled: boolean; rooms: string[] }
export interface RoomReader { occupantId: string; nick: string; avatar?: string }
interface Position { row: MessageRowRef; archiveId: string }
interface DiscoveryProof { features: string[]; count: number; epoch: number; connection: ReturnType<ModuleDependencies['getXmpp']> }
interface AccountState { consent: RoomReadConsent; sent: Record<string, Position> }
export const ROOM_READ_MARKERS_STORAGE_KEY = 'fluux-room-read-markers'
const STORAGE_PREFIX = ROOM_READ_MARKERS_STORAGE_KEY + ':'
const storageKey = (account: string, kind: 'consent' | 'watermarks') => STORAGE_PREFIX + JSON.stringify([account, kind])
let storageRevision = 0
/** Remove consent and published-position references with the account's local data. */
export function clearRoomReadMarkersLocalData(account: string | null, allAccounts = false) {
  storageRevision++
  try {
    if (!allAccounts) {
      if (account) for (const kind of ['consent', 'watermarks'] as const) localStorage.removeItem(storageKey(getBareJid(account), kind))
      return
    }
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch { /* An unavailable storage cannot enable sharing. */ }
}
const NONE: readonly RoomReader[] = Object.freeze([])
const REQUIRED = ['muc_membersonly', 'muc_hidden', 'muc_nonanonymous', NS_OCCUPANT_ID, NS_STANZA_ID]
const CONTRADICTORY = ['muc_public', 'muc_open', 'muc_semianonymous', 'muc_anonymous']
const keyOf = (row: MessageRowRef) => JSON.stringify([row.id, row.occupantId ?? '', row.stanzaId ?? ''])
const canMark = (row: RoomMessage, roomJid: string) => !!getRoomModerationId(row) && row.roomJid === roomJid && !row.isPrivate
  && !row.systemEvent && !row.securityContext && !row.encryptedPayload && !row.unsupportedEncryption && !row.contentAvailability

/**
 * Room-only XEP-0333. Peer positions never enter the message or local-read stores.
 * `viewed` is a separate, explicit viewport seam: local/MDS read events cannot send.
 * Only proven server-archive order determines advancement; neither nicknames,
 * client IDs nor timestamps can order peer positions. A missing/ambiguous target is not relocated.
 */
export class RoomReadMarkers extends BaseModule {
  private seenStorageRevision = storageRevision
  private accounts = new Map<string, AccountState>()
  private orders = new Map<string, RoomMarkerOrder>()
  private proofs = new Map<string, DiscoveryProof>()
  private epochs = new Map<string, number>()
  private positions = new Map<string, Map<string, Position>>()
  private badgeRooms = new Set<string>()
  private badges = new Map<string, Map<string, readonly RoomReader[]>>()
  private listeners = new Set<() => void>()
  private pending = new Map<string, Promise<void>>()
  private queued = new Map<string, { row: RoomMessage; epoch: number; consent: number; isCurrent: () => boolean }>()
  private consentRevision = 0
  private lifecycle = 0

  constructor(deps: ModuleDependencies, private focused = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) { super(deps) }

  private capture() {
    const session = super.captureQuery()
    const lifecycle = this.lifecycle
    return { isCurrent: () => session.isCurrent() && lifecycle === this.lifecycle }
  }
  /** Cancel old asynchronous work on provider teardown or module replacement. */
  cancelPending() {
    this.lifecycle++
    this.queued.clear(); this.pending.clear(); this.proofs.clear()
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
    return getBareJid(this.deps.getCurrentJid() ?? '')
  }
  private roomKey(roomJid: string) { return JSON.stringify([this.account(), roomJid]) }
  private storageKey(kind: 'consent' | 'watermarks') { return storageKey(this.account(), kind) }
  private state(): AccountState {
    const account = this.account()
    let state = this.accounts.get(account)
    if (!state) {
      state = { consent: { enabled: false, rooms: [] }, sent: {} }
      try {
        const consent = JSON.parse(localStorage.getItem(this.storageKey('consent')) ?? 'null') as RoomReadConsent | null
        const watermarks = JSON.parse(localStorage.getItem(this.storageKey('watermarks')) ?? 'null') as Pick<AccountState, 'sent'> | null
        if (consent && typeof consent.enabled === 'boolean' && Array.isArray(consent.rooms)) {
          state.consent = { enabled: consent.enabled, rooms: consent.rooms.filter(room => typeof room === 'string' && getBareJid(room) === room) }
        }
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
  private persist(kind: 'consent' | 'watermarks' = 'watermarks'): boolean {
    if (!this.account()) return false
    const state = this.state()
    try { localStorage.setItem(this.storageKey(kind), JSON.stringify(kind === 'consent' ? state.consent : { sent: state.sent })); return true } catch { return false }
  }
  /** Re-read this account's durable choices/watermarks, without creating a viewed event. */
  reload() { this.accounts.delete(this.account()); this.notify() }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify() { for (const listener of this.listeners) listener() }
  getConsent = (): RoomReadConsent => this.state().consent
  isEnabledFor(roomJid: string) { const consent = this.getConsent(); return consent.enabled && consent.rooms.includes(roomJid) }
  setEnabled(enabled: boolean) {
    this.consentRevision++
    const state = this.state()
    state.consent = { ...state.consent, enabled }
    const saved = this.persist('consent')
    if (!saved) this.failConsentSave(state)
    this.notify()
    return saved
  }
  setRoomEnabled(roomJid: string, enabled: boolean) {
    this.consentRevision++
    if (!roomJid || getBareJid(roomJid) !== roomJid) return
    const state = this.state()
    const rooms = state.consent.rooms.filter(room => room !== roomJid)
    state.consent = { ...state.consent, rooms: enabled ? [...rooms, roomJid] : rooms }
    const saved = this.persist('consent')
    if (!saved) this.failConsentSave(state)
    this.notify()
    return saved
  }
  private failConsentSave(state: AccountState) {
    state.consent = { enabled: false, rooms: [] }
    // In particular, quota exhaustion must not leave an older opt-in ready to
    // reactivate on restart. Removing a key does not need more storage space.
    try { localStorage.removeItem(this.storageKey('consent')) } catch { /* The UI reports the unsaved choice. */ }
  }

  private async discover(roomJid: string): Promise<boolean> {
    const room = this.getRoomWithOccupants(roomJid)
    if (!room?.joined || room.isJoining || !this.deps.getXmpp()) return false
    const key = this.roomKey(roomJid)
    const epoch = this.epochs.get(key) ?? 0
    const query = this.capture()
    try {
      const response = await this.deps.sendIQ(xml('iq', { type: 'get', to: roomJid }, xml('query', { xmlns: NS_DISCO_INFO })), 10_000)
      if (!query.isCurrent() || epoch !== (this.epochs.get(key) ?? 0) || response.attrs.from !== roomJid) return false
      const info = response.getChild('query', NS_DISCO_INFO)
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
    } catch { return false }
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
    return !!own?.occupantId && proof.count === room.occupants.size && proof.count > 0 && proof.count < 20
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
  private async forward(roomJid: string, previous: string, candidate: string): Promise<boolean> {
    const order = this.order(roomJid)
    if (previous === candidate || order.after(previous, candidate)) return false
    if (order.after(candidate, previous)) return true
    if (!this.deps.registerMAMCollector) return false
    // A restart or a nonresident target can leave no common page. Read server
    // order without putting probe messages in the timeline or touching coverage.
    // Bound the read; an unproved relation stops sharing rather than guessing.
    const session = this.capture()
    let after = previous
    for (let page = 0; page < 20; page++) {
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
        if (!session.isCurrent() || response.attrs.from !== roomJid || !fin) return false
        order.page(ids, { after })
        if (order.after(candidate, previous)) return true
        const last = fin.getChild('set', NS_RSM)?.getChildText('last')
        if (fin.attrs.complete === 'true' || !last || last === after || ids.at(-1) !== last) return false
        after = last
      } catch { return false } finally { unregister() }
    }
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
      this.proofs.delete(key)
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
      return true
    }
    return false
  }

  private async target(roomJid: string, id: string, additional: readonly RoomMessage[]): Promise<RoomMessage | null> {
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
    if (previous && !await this.forward(roomJid, previous.archiveId, position.archiveId)) return
    if (!query.isCurrent() || epoch !== (this.epochs.get(key) ?? 0) || !this.eligible(roomJid)) return
    // Another live/archive resolver can finish during the order probe.
    const latest = positions.get(occupantId)
    if (latest && latest !== previous && !this.order(roomJid).after(position.archiveId, latest.archiveId)) return
    positions.set(occupantId, position)
    this.positions.set(key, positions)
    if (occupantId === roomSelf(room).occupantId) {
      const sent = this.state().sent[roomJid]
      const advances = !sent || await this.forward(roomJid, sent.archiveId, position.archiveId)
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
    if (!held || this.order(roomJid).after(row.stanzaId!, held.row.stanzaId!)) {
      this.queued.set(key, { row, epoch: this.epochs.get(key) ?? 0, consent: this.consentRevision, isCurrent: query.isCurrent })
    }
    const running = this.pending.get(key)
    if (running) return running
    // Advances that arrive before discovery finishes collapse to the furthest
    // actually visible incoming row. This queue is never fed by read-store events.
    const task = Promise.resolve().then(async () => {
      while (this.queued.has(key)) {
        const initial = this.queued.get(key)!
        const discovered = initial.isCurrent() && await this.discover(roomJid)
        if (!initial.isCurrent()) break
        const candidate = this.queued.get(key)
        this.queued.delete(key)
        if (!candidate) continue
        const current = () => candidate.isCurrent() && candidate.epoch === (this.epochs.get(key) ?? 0)
          && candidate.consent === this.consentRevision && this.focused() && this.isEnabledFor(roomJid) && this.eligible(roomJid)
        if (!discovered || !current()) continue
        const confirmed = await this.target(roomJid, candidate.row.stanzaId!, [])
        if (!confirmed || keyOf(messageRowRef(confirmed)) !== keyOf(messageRowRef(candidate.row)) || !current()) continue
        const room = this.getRoomWithOccupants(roomJid)!
        if (confirmed.isOutgoing || isOwnRoomMessage(confirmed.nick, confirmed.occupantId, roomSelf(room))
          || !room.readPointer || isAfterBoundary(exactPosition(confirmed, 'room'), room.readPointer.order)) continue
        const position = { row: messageRowRef(confirmed), archiveId: confirmed.stanzaId! }
        const previous = this.state().sent[roomJid]
        const reflected = this.positions.get(key)?.get(roomSelf(room).occupantId ?? '')
        if (reflected && !await this.forward(roomJid, reflected.archiveId, position.archiveId)) continue
        if (previous && !await this.forward(roomJid, previous.archiveId, position.archiveId)) continue
        if (!current() || !this.rememberSent(roomJid, position)) continue
        await this.deps.sendStanza(xml('message', { type: 'groupchat', to: roomJid },
          xml('displayed', { xmlns: NS_CHAT_MARKERS, id: position.archiveId }), xml('store', { xmlns: NS_HINTS })))
      }
    })
    this.pending.set(key, task)
    void task.finally(() => { if (this.pending.get(key) === task) this.pending.delete(key) }).catch(() => {})
    return task
  }

  /** Roster/position changes rebuild only the per-row badge snapshots. */
  roomChanged(roomJid: string) {
    const key = this.roomKey(roomJid)
    const room = this.getRoomWithOccupants(roomJid)
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
