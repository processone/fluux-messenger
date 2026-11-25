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
const storageKey = (account: string, kind: 'consent' | 'watermarks' | 'migration' | 'continuity') => STORAGE_PREFIX + JSON.stringify([account, kind])
// A compact 128-bit epoch fits in the space freed by even an empty legacy choice.
function clearFence() {
  const hex = generateUUID().split('-').join('')
  const bytes = Array.from({ length: 16 }, (_, i) => String.fromCharCode(Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16))).join('')
  return '!' + btoa(bytes).slice(0, -2)
}
let storageRevision = 0
interface ClearGuard { generation: string | null; legacy: Record<string, string>; open: boolean }
function readClearGuard(): ClearGuard {
  const raw = localStorage.getItem(CLEAR_GENERATION_KEY)
  if (raw === null) return { generation: null, legacy: {}, open: true }
  try {
    const value = JSON.parse(raw) as { generation?: unknown; legacy?: unknown }
    if (typeof value.generation === 'string' && !!value.generation && value.legacy && typeof value.legacy === 'object' && !Array.isArray(value.legacy)
      && Object.values(value.legacy).every(entry => typeof entry === 'string')) {
      return { generation: value.generation, legacy: value.legacy as Record<string, string>, open: false }
    }
  } catch { /* Earlier guards stored only the generation. */ }
  return { generation: raw, legacy: {}, open: false }
}
function pruneLegacyPermission(account: string) {
  const guard = readClearGuard()
  if (typeof guard.legacy[account] !== 'string') return
  delete guard.legacy[account]
  localStorage.setItem(CLEAR_GENERATION_KEY, JSON.stringify({ generation: guard.generation, legacy: guard.legacy }))
}
interface SavedConsent {
  raw: string | null
  fence: string | null
  clearToken: string | null
  cleared: boolean
  rooms: string[]
  generation?: string
  epoch: string
  edits: Record<string, string>
  revoked: string[]
  needsMigration: boolean
  legacyChoice?: string
}
interface ConsentFence { epoch: string; edits?: Record<string, string>; generation?: string; revoked?: string[]; input?: string }
function readConsentFence(raw: string | null): ConsentFence | undefined {
  if (raw?.startsWith('!')) return { epoch: raw }
  try {
    const parsed: unknown = JSON.parse(raw?.startsWith('~') ? raw.slice(1) : raw ?? 'null')
    const value = (raw?.startsWith('~') && Array.isArray(parsed)
      ? { version: 3, generation: parsed[0], epoch: parsed[1], revoked: parsed[4] === 1 ? parsed[2] : undefined, edits: parsed[3], input: parsed[5] ?? undefined } : parsed) as { version?: unknown; epoch?: unknown; edits?: unknown; generation?: unknown; revoked?: unknown; input?: unknown } | null
    if (value?.version === 3 && typeof value.epoch === 'string' && value.edits && typeof value.edits === 'object' && !Array.isArray(value.edits)
      && Object.values(value.edits).every(edit => typeof edit === 'string')
      && (value.generation === undefined || (typeof value.generation === 'string' && !!value.generation))
      && (value.input === undefined || typeof value.input === 'string')
      && (value.revoked === undefined || (typeof value.generation === 'string' && Array.isArray(value.revoked) && value.revoked.every(room => typeof room === 'string' && !!room && getBareJid(room) === room)))) return { epoch: value.epoch, edits: value.edits as Record<string, string>, generation: value.generation as string | undefined, revoked: value.revoked as string[] | undefined, input: value.input as string | undefined }
  } catch { /* Unknown fences cannot supply trusted ordering history. */ }
  return undefined
}
function consentFenceValue(edits: Record<string, string>, epoch: string, generation: string, revoked: string[], input?: string) {
  return JSON.stringify({ version: 3, epoch, edits, generation, revoked, input })
}
function readConsentContinuity(account: string): { generation: string; input?: string; inputId?: string } | undefined {
  const raw = localStorage.getItem(storageKey(account, 'continuity'))
  try {
    const value = JSON.parse(raw ?? 'null') as { generation?: unknown; input?: unknown; inputId?: unknown } | null
    if (typeof value?.generation === 'string' && value.generation && (value.input === undefined || typeof value.input === 'string')
      && (value.inputId === undefined || (typeof value.inputId === 'string' && !!value.inputId))) return value as { generation: string; input?: string; inputId?: string }
  } catch { /* Invalid proof cannot establish preference continuity. */ }
  return undefined
}
function writeConsentContinuity(account: string, generation: string, input?: string) {
  const previous = input === undefined ? undefined : readConsentContinuity(account)
  const inputId = input === undefined ? undefined
    : previous?.generation === generation && previous.input === input && previous.inputId ? previous.inputId : generateUUID()
  localStorage.setItem(storageKey(account, 'continuity'), JSON.stringify({ generation, input, inputId }))
  return inputId
}
function readSavedRoomConsent(account: string): SavedConsent {
  const raw = localStorage.getItem(storageKey(account, 'consent'))
  const fence = localStorage.getItem(storageKey(account, 'migration'))
  const history = readConsentFence(fence)
  const continuity = readConsentContinuity(account)
  const fenceEpoch = history?.epoch
  const guard = readClearGuard()
  const clearToken = guard.generation
  let value: unknown = null
  try { value = JSON.parse(raw ?? 'null') } catch { /* Malformed preferences convert to off, never to consent. */ }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const validRooms = Array.isArray(record?.rooms) && record.rooms.every(room =>
    typeof room === 'string' && !!room && getBareJid(room) === room)
  const validEdits = record?.edits && typeof record.edits === 'object' && !Array.isArray(record.edits)
    && Object.values(record.edits).every(edit => typeof edit === 'string')
  const overlay = history?.revoked !== undefined && !!history.generation
  const current = record?.version === 3 && validRooms && typeof record.generation === 'string' && !!record.generation
    && (!history?.generation || (record.generation === history.generation && continuity?.generation === history.generation))
    && typeof record.epoch === 'string' && validEdits && (overlay || fenceEpoch === undefined || record.epoch === fenceEpoch)
    && (overlay || !history?.edits || (Object.keys(history.edits).length === Object.keys(record.edits as object).length
      && Object.entries(history.edits).every(([room, edit]) => (record.edits as Record<string, string>)[room] === edit)))
  const cleared = !overlay && !!fenceEpoch && !current
  const oldRooms = validRooms ? [...new Set(record!.rooms as string[])] : []
  const retained = !!history?.revoked?.length && raw !== null && !!history.input && history.input === continuity?.inputId
    && continuity?.generation === history.generation && continuity?.input === raw
  const previous = (retained || !history?.edits) && !cleared && record?.version === 2 && validRooms
  const legacy = (retained || fence === null) && record?.version === undefined && typeof record?.enabled === 'boolean' && validRooms
  const choice = previous || legacy ? JSON.stringify([previous ? 2 : 0, previous || record?.enabled === true, previous || record?.enabled === true ? oldRooms : []]) : undefined
  const allowed = retained || guard.open || (choice !== undefined && guard.legacy[account] === choice)
  const rooms = current || (allowed && (previous || (legacy && record?.enabled === true))) ? oldRooms.filter(room => !history?.revoked?.includes(room)) : []
  return {
    raw, fence, clearToken, rooms, cleared,
    generation: current ? record.generation as string : history?.generation
      ? raw !== null && continuity?.generation === history.generation ? history.generation : 'absent:' + history.generation
      : JSON.stringify([account, clearToken, fenceEpoch ?? '']),
    epoch: fenceEpoch ?? (current ? record.epoch as string : ''),
    edits: { ...(history?.edits ?? (current ? record.edits as Record<string, string> : {})) },
    revoked: history?.revoked ?? [],
    needsMigration: !cleared && raw !== null && !current,
    legacyChoice: allowed ? choice : undefined,
  }
}
function sameConsentBoundary(left: SavedConsent, right: SavedConsent) {
  return left.generation === right.generation
}
function roomConsentValue(saved: SavedConsent, rooms: string[], edits = saved.edits, epoch = saved.epoch) {
  return JSON.stringify({ version: 3, generation: saved.generation ?? generateUUID(), epoch, edits, rooms })
}
function persistRoomConsent(account: string, saved: SavedConsent, rooms: string[], edits = saved.edits, epoch = saved.epoch) {
  const generation = saved.generation ?? generateUUID()
  const revoked = [...new Set([...saved.revoked, ...saved.rooms.filter(room => !rooms.includes(room)),
    ...Object.keys(edits).filter(room => !rooms.includes(room) && edits[room] !== saved.edits[room])])]
  const input = saved.legacyChoice && revoked.length ? saved.raw ?? undefined : undefined
  let inputId: string | undefined
  // Reserve valid input before fencing it out; clearing can erase this proof without reopening import.
  if (input !== undefined) inputId = writeConsentContinuity(account, generation, input)
  let failed: { error: unknown } | undefined
  try { pruneLegacyPermission(account) } catch (error) { failed = { error } }
  try { localStorage.setItem(storageKey(account, 'migration'), consentFenceValue(edits, epoch, generation, revoked, inputId)) } catch (error) { failed = { error } }
  if (failed) throw failed.error
  if (input === undefined) writeConsentContinuity(account, generation)
  localStorage.setItem(storageKey(account, 'consent'), roomConsentValue({ ...saved, generation }, rooms, edits, epoch))
  const remaining = revoked.filter(room => !rooms.includes(room))
  // A revocation is lifted only after its new On exists in the permission record.
  if (remaining.length !== revoked.length) {
    try { localStorage.setItem(storageKey(account, 'migration'), consentFenceValue(edits, epoch, generation, remaining)) } catch { return false }
  }
  return true
}
function removeConsentWithBarrier(account: string, epoch = clearFence()) {
  try { localStorage.removeItem(storageKey(account, 'consent')); localStorage.removeItem(storageKey(account, 'continuity')) } catch { /* Local guards cover denied removal. */ }
  try { localStorage.setItem(storageKey(account, 'migration'), epoch) } catch { /* The surviving fence still blocks legacy import and retains ordering. */ }
}
// Conversion orders earlier On without pretending to be a newer user choice.
function migrationEdits(saved: SavedConsent) {
  const edits = { ...saved.edits }
  for (const room of saved.rooms) if (!edits[room]) edits[room] = 'm:' + generateUUID()
  return edits
}
function sameRoomChoice(opening: SavedConsent, latest: SavedConsent, room: string) {
  return (opening.edits[room] ?? '') === (latest.edits[room] ?? '') || (!opening.edits[room] && latest.edits[room]?.startsWith('m:'))
}
function readRoomWatermarks(account: string): Record<string, Position> {
  const value = JSON.parse(localStorage.getItem(storageKey(account, 'watermarks')) ?? 'null') as Pick<AccountState, 'sent'> | null
  const sent: Record<string, Position> = {}
  if (value === null) return sent
  if (!value.sent || typeof value.sent !== 'object' || Array.isArray(value.sent)) throw new Error('Invalid room watermark storage')
  for (const [room, position] of Object.entries(value.sent)) {
    if (typeof position?.archiveId !== 'string' || typeof position.row?.id !== 'string' || position.row.stanzaId !== position.archiveId) throw new Error('Invalid room watermark')
    sent[room] = { row: position.row, archiveId: position.archiveId }
  }
  return sent
}

async function withConsentStorage<T>(action: () => T, onTransactionStart?: () => void): Promise<T> {
  const db = await openIndexedDB('fluux-room-read-coordination', 1, {
    upgrade: db => { db.createObjectStore('consent') },
    onClosed: () => {},
  })
  try {
    return await new Promise<T>((resolve, reject) => {
      // Transactions order commits, not the user's earlier choice. Room edit
      // revisions reject superseded opt-ins before this synchronous commit.
      const transaction = db.transaction('consent', 'readwrite')
      onTransactionStart?.()
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
  const writeBarrier = (key: string, value: string) => {
    try { localStorage.setItem(key, value); return true } catch { return false }
  }
  const remove = () => {
    if (!allAccounts) {
      for (const kind of ['consent', 'watermarks', 'continuity'] as const) localStorage.removeItem(storageKey(scoped!, kind))
      writeBarrier(storageKey(scoped!, 'migration'), clearFence())
      let preserved = true
      const legacy: Record<string, string> = Object.create(null)
      const accounts: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key?.startsWith(STORAGE_PREFIX)) continue
        try {
          const parts: unknown = JSON.parse(key.slice(STORAGE_PREFIX.length))
          if (Array.isArray(parts) && parts.length === 2 && typeof parts[0] === 'string' && parts[0] !== scoped && parts[1] === 'consent') accounts.push(parts[0])
        } catch { /* The shared clear guard is not an account record. */ }
      }
      for (const other of accounts) {
        let saved: SavedConsent | undefined
        try {
          saved = readSavedRoomConsent(other)
          // Store the self-contained choice first so either refusal preserves valid consent.
          if (saved.needsMigration) {
            const generation = saved.generation ?? generateUUID()
            const edits = migrationEdits(saved)
            localStorage.setItem(storageKey(other, 'consent'), roomConsentValue({ ...saved, generation }, saved.rooms, edits))
            writeConsentContinuity(other, generation)
            localStorage.setItem(storageKey(other, 'migration'), consentFenceValue(edits, saved.epoch, generation, saved.revoked))
          }
        } catch {
          preserved = false
          // Only unchanged, previously valid surviving choices may bypass sealing.
          if (saved?.legacyChoice && saved.rooms.length && localStorage.getItem(storageKey(other, 'consent')) === saved.raw) legacy[other] = saved.legacyChoice
        }
      }
      if (!writeBarrier(CLEAR_GENERATION_KEY, JSON.stringify({ generation: generateUUID(), legacy }))) return false
      localStorage.removeItem(storageKey(scoped!, 'migration'))
      return preserved
    }
    const keys: string[] = []
    const accounts = new Set<string>()
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(STORAGE_PREFIX) || key === CLEAR_GENERATION_KEY) continue
      keys.push(key)
      try {
        const parts: unknown = JSON.parse(key.slice(STORAGE_PREFIX.length))
        if (Array.isArray(parts) && parts.length === 2 && typeof parts[0] === 'string') accounts.add(parts[0])
      } catch { /* Non-account feature keys are still erased. */ }
    }
    // Replace the seal before deleting any existing protection.
    let sealed = writeBarrier(CLEAR_GENERATION_KEY, generateUUID())
    if (!sealed) {
      try { for (const account of Object.keys(readClearGuard().legacy)) accounts.add(account) }
      catch { /* Unreadable permissions cannot be reconstructed; the clear reports failure. */ }
    }
    const fences = new Set([...accounts].map(account => storageKey(account, 'migration')))
    for (const key of keys) {
      if (!sealed && fences.has(key)) continue
      localStorage.removeItem(key)
    }
    if (!sealed) sealed = writeBarrier(CLEAR_GENERATION_KEY, generateUUID())
    if (sealed) {
      for (const key of fences) localStorage.removeItem(key)
    } else {
      let compacted = false
      for (const account of accounts) compacted = writeBarrier(storageKey(account, 'migration'), clearFence()) || compacted
      if (!compacted || !writeBarrier(CLEAR_GENERATION_KEY, generateUUID())) return false
      for (const key of fences) localStorage.removeItem(key)
    }
    return true
  }
  try { return await withConsentStorage(remove) } catch {
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
  private consentEdits = new Map<string, { isCurrent: () => boolean }>()
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
  private queued = new Map<string, { row: RoomMessage; epoch: number; consent: number; isCurrent: () => boolean; sessionCurrent: () => boolean; watermarkCurrent: () => boolean }>()
  private consentRevision = 0
  private lifecycle = 0

  constructor(deps: ModuleDependencies, private focused = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) { super(deps) }
  private onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === this.storageKey('continuity') || event.key === this.storageKey('consent') || event.key === this.storageKey('watermarks') || event.key === this.storageKey('migration')) this.reload()
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
  private storageKey(kind: 'consent' | 'watermarks' | 'migration' | 'continuity') { return storageKey(this.account(), kind) }
  private state(): AccountState {
    const account = this.account()
    let state = this.accounts.get(account)
    if (!state) {
      state = { consent: { enabled: false, rooms: [] }, sent: {} }
      try {
        state.sent = readRoomWatermarks(account)
      } catch { state = { consent: { enabled: false, rooms: [] }, sent: {} } }
      this.accounts.set(account, state)
    }
    return state
  }
  private readSavedConsent(account = this.account()) { return readSavedRoomConsent(account) }
  private async writeConsent(change?: { room: string; enabled: boolean } | { allOff: true }, captured?: SavedConsent, onCaptured?: (saved: SavedConsent) => void): Promise<boolean> {
    const account = this.account()
    if (!account) return false
    let changed = false
    let transactionStarted = false
    let initial: SavedConsent | undefined
    let attempted: SavedConsent | undefined
    const optingOut = !!change && (!('room' in change) || !change.enabled)
    const recoverRevocation = (mutating?: SavedConsent) => {
      if (!optingOut || !initial || !change || this.account() !== account) return
      let latest: SavedConsent
      try { latest = mutating ?? this.readSavedConsent(account) } catch { return }
      if (!sameConsentBoundary(initial, latest)) return
      const opening = initial
      const revoked = ('room' in change ? [change.room] : opening.rooms).filter(room =>
        sameRoomChoice(opening, latest, room))
      if ('room' in change && !revoked.length) return
      const rooms = latest.rooms.filter(room => !revoked.includes(room))
      const edits = { ...latest.edits }
      for (const room of revoked) edits[room] = generateUUID()
      const epoch = 'room' in change ? latest.epoch : latest.epoch.startsWith('!') ? clearFence() : generateUUID()
      changed = true
      const compact = () => {
        // Recovery preserves account identity so unrelated Off survives; the epoch rejects older On.
        const epoch = clearFence()
        try {
          const retainedEdits = Object.fromEntries(rooms.flatMap(room => latest.edits[room] ? [[room, latest.edits[room]]] : []))
          const input = latest.legacyChoice && revoked.length ? latest.raw ?? undefined : undefined
          const generation = latest.generation ?? generateUUID()
          const inputId = writeConsentContinuity(account, generation, input)
          localStorage.setItem(storageKey(account, 'migration'), '~' + JSON.stringify([generation, epoch, [...new Set([...latest.revoked, ...revoked])], retainedEdits, 1, inputId]))
          localStorage.setItem(storageKey(account, 'consent'), roomConsentValue({ ...latest, generation }, rooms, retainedEdits, epoch))
        } catch {
          if (!rooms.length) removeConsentWithBarrier(account, epoch)
        }
      }
      if (mutating) compact()
      else {
        try { persistRoomConsent(account, latest, rooms, edits, epoch) } catch { compact() }
      }
      this.consentRevision++
    }
    const recoverUnchanged = (durable: boolean) => {
      if ((!changed && !change) || !initial || this.account() !== account) return
      try {
        const latest = this.readSavedConsent(account)
        if (initial.raw !== latest.raw || initial.fence !== latest.fence || initial.clearToken !== latest.clearToken) return
      } catch { return }
      changed = true
      this.failConsentSave(account, !!change, durable)
    }
    try {
      initial = captured ?? this.readSavedConsent(account)
      onCaptured?.(initial)
      const opening = initial
      return await withConsentStorage(() => {
        try {
          const saved = this.readSavedConsent(account)
          if (!change && !saved.needsMigration) return true
          if (change && 'room' in change && change.enabled) {
            if (!saved.needsMigration && saved.rooms.includes(change.room)) return true
            const changedAccount = opening.generation ? opening.generation !== saved.generation
              : opening.clearToken !== saved.clearToken || opening.cleared !== saved.cleared
            if (changedAccount || opening.epoch !== saved.epoch || (opening.edits[change.room] ?? '') !== (saved.edits[change.room] ?? '')) return false
          }
          // Target erasure supersedes Off even if older code rewrites preferences afterward.
          if (optingOut && !sameConsentBoundary(opening, saved)) return true
          let rooms = saved.rooms
          const edits = saved.needsMigration ? migrationEdits(saved) : { ...saved.edits }
          let epoch = saved.epoch
          if (change && 'room' in change) {
            rooms = rooms.filter(room => room !== change.room)
            if (change.enabled) rooms.push(change.room)
            edits[change.room] = generateUUID()
          } else if (change) { rooms = []; epoch = saved.epoch.startsWith('!') ? clearFence() : generateUUID() }
          attempted = saved
          changed = true
          const committed = persistRoomConsent(account, saved, rooms, edits, epoch)
          const effective = committed ? rooms : rooms.filter(room => !saved.revoked.includes(room))
          this.refusedConsent.delete(account)
          this.consentRevision++
          const state = this.accounts.get(account)
          if (state) state.consent = { enabled: effective.length > 0, rooms: effective }
          return committed
        } catch {
          if (optingOut) recoverRevocation(attempted)
          else if (changed) {
            // Existing revocations already protect the retained input during a background retry.
            if (change || !attempted?.legacyChoice || !attempted.revoked.length) this.failConsentSave(account, !!change)
          } else recoverUnchanged(true)
          return false
        }
      }, () => { transactionStarted = true })
    } catch {
      // Revocation before mutation is distinct from replaying destructive cleanup after abort.
      if (optingOut && !changed) {
        try { await withConsentStorage(() => recoverRevocation()) } catch { /* Local suppression survives unavailable coordination. */ }
      } else recoverUnchanged(!transactionStarted)
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
  /** Re-read durable choices without creating a viewed event or missing account keys. */
  reload() {
    this.consentRevision++; this.queued.clear(); this.accounts.delete(this.account()); this.notify()
    try {
      if (this.readSavedConsent().needsMigration) return this.migrateConsent()
    } catch { return Promise.resolve(false) }
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
        if (!saved.needsMigration || (saved.revoked.length && saved.legacyChoice)) consent = { enabled: saved.rooms.length > 0, rooms: saved.rooms }
      } catch { /* A read failure hides sharing without discarding durable choices. */ }
    }
    const unknown = this.consentEdits.get(this.roomKey(''))
    if (unknown?.isCurrent()) return { enabled: false, rooms: [] }
    const rooms = consent.rooms.filter(room => {
      const key = this.roomKey(room)
      const edit = this.consentEdits.get(key)
      if (edit && !edit.isCurrent()) this.consentEdits.delete(key)
      return !this.consentEdits.has(key)
    })
    consent = { enabled: rooms.length > 0, rooms }
    if (JSON.stringify(consent) !== JSON.stringify(state.consent)) {
      this.consentRevision++
      state.consent = consent
    }
    return state.consent
  }
  isEnabledFor(roomJid: string) {
    const key = this.roomKey(roomJid)
    const edit = this.consentEdits.get(key)
    if (edit && !edit.isCurrent()) this.consentEdits.delete(key)
    return !this.consentEdits.has(key) && this.getConsent().rooms.includes(roomJid)
  }
  /** @deprecated Only legacy opt-out is supported; opting in requires an explicit room choice. */
  setEnabled(enabled: boolean): Promise<boolean> {
    if (enabled) return Promise.resolve(false)
    const account = this.account()
    let boundary: SavedConsent | undefined
    try { boundary = this.readSavedConsent(account) } catch { /* Selected rooms are unknown until the operation captures them. */ }
    const unknownKey = this.roomKey('')
    let unreadable: { history?: ConsentFence; clearToken: string | null } | undefined
    if (!boundary) {
      try { unreadable = { history: readConsentFence(localStorage.getItem(storageKey(account, 'migration'))), clearToken: readClearGuard().generation } }
      catch { /* No readable ownership means suppression cannot yet be retired as superseded. */ }
    }
    let edits = (boundary?.rooms ?? []).map(room => this.beginConsentEdit(room, account, boundary))
    const unknown = { isCurrent: () => {
      if (this.account() !== account) { this.consentEdits.delete(unknownKey); return false }
      try {
        const latest = this.readSavedConsent(account)
        let rooms = latest.rooms
        if (unreadable) {
          const history = unreadable.history
          const generation = history?.generation ?? JSON.stringify([account, unreadable.clearToken, history?.epoch ?? ''])
          const retainedLegacy = !history?.generation && latest.fence === null && !!latest.legacyChoice
          if (latest.generation !== generation && !retainedLegacy) rooms = []
          else rooms = rooms.filter(room => (history?.edits?.[room] ?? '') === (latest.edits[room] ?? '')
            || (!history?.edits?.[room] && latest.edits[room]?.startsWith('m:')))
        }
        edits = rooms.map(room => this.beginConsentEdit(room, account, latest))
        boundary = latest
        this.consentEdits.delete(unknownKey)
        return false
      } catch { return true }
    } }
    if (!boundary) this.consentEdits.set(unknownKey, unknown)
    this.consentRevision++; this.queued.clear(); this.notify()
    let saved = false
    return this.writeConsent({ allOff: true }, boundary, captured => {
      if (!boundary) { edits = captured.rooms.map(room => this.beginConsentEdit(room, account, captured)); boundary = captured }
      if (this.consentEdits.get(unknownKey) === unknown) this.consentEdits.delete(unknownKey)
    }).then(result => { saved = result; return result }).finally(() => {
      if (boundary && this.consentEdits.get(unknownKey) === unknown) this.consentEdits.delete(unknownKey)
      for (const { key, edit } of edits) if (saved && this.consentEdits.get(key) === edit) this.consentEdits.delete(key)
      this.notify()
    })
  }
  private beginConsentEdit(roomJid: string, account: string, boundary?: SavedConsent) {
    const key = this.roomKey(roomJid)
    const edit = { isCurrent: () => {
      if (this.account() !== account) return false
      try {
        if (!boundary) return true
        const latest = this.readSavedConsent(account)
        return sameConsentBoundary(boundary, latest) && sameRoomChoice(boundary, latest, roomJid)
      } catch { return true }
    } }
    this.consentEdits.set(key, edit)
    return { key, edit }
  }
  setRoomEnabled(roomJid: string, enabled: boolean): Promise<boolean> {
    if (!roomJid || getBareJid(roomJid) !== roomJid) return Promise.resolve(false)
    this.consentEdits.get(this.roomKey(''))?.isCurrent()
    const account = this.account()
    let boundary: SavedConsent | undefined
    try { boundary = this.readSavedConsent(account) } catch { /* Unreadable state stays locally suppressed. */ }
    const { key, edit } = this.beginConsentEdit(roomJid, account, boundary)
    // A save can wait behind another tab's transaction. Suppress this tab immediately,
    // rather than allowing an already-queued viewed event to publish meanwhile.
    this.consentRevision++; this.queued.clear(); this.notify()
    let saved = false
    return this.writeConsent({ room: roomJid, enabled }, boundary).then(result => { saved = result; return result }).finally(() => {
      if (this.consentEdits.get(key) === edit && (saved || enabled)) this.consentEdits.delete(key)
      this.notify()
    })
  }
  private failConsentSave(account: string, explicitChoice = true, durable = true) {
    if (explicitChoice) this.refusedConsent.add(account)
    const state = this.accounts.get(account)
    if (state) state.consent = { enabled: false, rooms: [] }
    if (!durable) return
    // Deletion frees space for a compact barrier without retaining a failed On snapshot.
    removeConsentWithBarrier(account)
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
          const enabled = this.isEnabledFor(roomJid)
          const held = this.queued.get(key)
          if (held?.isCurrent() && held.epoch === (this.epochs.get(key) ?? 0)
            && held.consent === this.consentRevision && this.focused() && enabled) {
            void this.publishQueued(roomJid).catch(() => {})
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

  async receive(roomJid: string, stanza: Element, additional: readonly RoomMessage[] = [], archived = false, replayCurrent?: () => boolean): Promise<void> {
    const displays = stanza.getChildren('displayed', NS_CHAT_MARKERS)
    const actors = stanza.getChildren('occupant-id', NS_OCCUPANT_ID)
    if (stanza.attrs.type !== 'groupchat' || getBareJid(stanza.attrs.from ?? '') !== roomJid || !getResource(stanza.attrs.from ?? '')
      || stanza.getChild('body') || displays.length !== 1 || !displays[0].attrs.id || actors.length !== 1 || !actors[0].attrs.id) return
    const query = this.capture()
    const watermarkCurrent = replayCurrent ?? this.captureReplayBoundary()
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
        await this.rememberSent(roomJid, position, () => watermarkCurrent() && query.isCurrent()
          && epoch === (this.epochs.get(key) ?? 0) && this.eligible(roomJid))
      }
    }
    this.roomChanged(roomJid)
  }

  /** Capture before archive work starts; late replay must not restore erased local positions. */
  captureReplayBoundary() {
    const account = this.account()
    try {
      const saved = this.readSavedConsent(account)
      return () => {
        try {
          const latest = this.readSavedConsent(account)
          return this.account() === account && (saved.generation ? saved.generation === latest.generation : saved.clearToken === latest.clearToken && saved.cleared === latest.cleared && saved.epoch === latest.epoch)
        } catch { return false }
      }
    } catch { return () => false }
  }

  private async rememberSent(roomJid: string, position: Position, isCurrent: () => boolean, dispatch?: (commit: () => void) => Promise<void>): Promise<boolean> {
    let delivery: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
    let saved = false
    try {
      saved = await withConsentStorage(() => {
        const account = this.account()
        if (!account) return false
        const sent = readRoomWatermarks(account)
        const previous = sent[roomJid]
        if (previous && !this.order(roomJid).after(position.archiveId, previous.archiveId)) return false
        if (!isCurrent()) return false
        sent[roomJid] = position
        let active = true
        let wrote = false
        const commit = () => {
          if (!active || wrote || !isCurrent()) throw new Error('Room viewing is no longer current')
          localStorage.setItem(storageKey(account, 'watermarks'), JSON.stringify({ sent }))
          this.state().sent = sent
          wrote = true
        }
        try {
          if (dispatch) {
            try { delivery = dispatch(commit).then(() => ({ ok: true as const }), error => ({ ok: false as const, error })) }
            catch (error) { delivery = Promise.resolve({ ok: false, error }) }
          } else commit()
        } finally { active = false }
        return wrote
      })
    } catch { saved = false }
    const result = await delivery
    if (result && !result.ok) throw result.error
    return saved
  }

  /** Explicit focused viewport evidence, after the existing read writer ran. */
  viewed(roomJid: string, row: RoomMessage, viewCurrent: () => boolean = () => true): Promise<void> {
    if (!this.focused() || !this.isEnabledFor(roomJid) || !canMark(row, roomJid) || row.isOutgoing) return Promise.resolve()
    if (this.state().sent[roomJid]?.archiveId === row.stanzaId) return Promise.resolve()
    const key = this.roomKey(roomJid)
    const query = this.capture()
    const watermarkCurrent = this.captureReplayBoundary()
    const held = this.queued.get(key)
    if (!held || !held.isCurrent() || !held.watermarkCurrent() || held.epoch !== (this.epochs.get(key) ?? 0) || held.consent !== this.consentRevision
      || this.order(roomJid).after(row.stanzaId!, held.row.stanzaId!)) {
      this.queued.set(key, { row, epoch: this.epochs.get(key) ?? 0, consent: this.consentRevision, isCurrent: () => query.isCurrent() && viewCurrent(), sessionCurrent: query.isCurrent, watermarkCurrent })
    }
    return this.publishQueued(roomJid)
  }

  private publishQueued(roomJid: string): Promise<void> {
    const key = this.roomKey(roomJid)
    const observation = this.queued.get(key)
    if (!observation) return Promise.resolve()
    const query = { isCurrent: observation.sessionCurrent }
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
        const authorized = () => {
          const enabled = this.isEnabledFor(roomJid)
          return candidate.isCurrent() && candidate.epoch === (this.epochs.get(key) ?? 0)
            && candidate.consent === this.consentRevision && this.focused() && enabled
        }
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
        if (!current()) continue
        const withinReadBoundary = () => {
          const latest = this.getRoomWithOccupants(roomJid)?.readPointer
          return !!latest && !isAfterBoundary(exactPosition(confirmed, 'room'), latest.order)
        }
        await this.rememberSent(roomJid, position, () => candidate.watermarkCurrent() && current() && withinReadBoundary(),
          commit => this.deps.sendStanza(xml('message', { type: 'groupchat', to: roomJid },
            xml('displayed', { xmlns: NS_CHAT_MARKERS, id: position.archiveId }), xml('store', { xmlns: NS_HINTS })), commit))
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
