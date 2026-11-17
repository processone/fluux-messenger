import { subscribeDiagnostics, chatStore, roomStore, connectionStore, getStorageScopeJid, generateUUID, readStateGeneration, resolveNotifyLevel, hasBadgeActivity, type RecountDeferralReason } from '@fluux/sdk'

export const BADGE_DIAGNOSTICS_KEY = 'fluux:badge-diagnostics:v1'
export const BADGE_DIAGNOSTICS_LIMITS = { events: 1000, bytes: 1024 * 1024, ageMs: 7 * 24 * 60 * 60 * 1000 } as const
const phases = ['decrypt-start', 'decrypt-complete', 'arrival', 'storage', 'read-state', 'read-decision', 'visibility', 'badge-request', 'badge-result', 'recount'] as const
const statuses = ['pending', 'succeeded', 'failed', 'discarded', 'unavailable', 'unsupported', 'accepted', 'refused', 'stale', 'changed', 'observed'] as const
const numbers = ['unreadBefore', 'unreadAfter', 'mentionsBefore', 'mentionsAfter', 'count', 'chats', 'rooms', 'events'] as const
const booleans = ['active', 'visible', 'focused', 'pageVisible', 'viewportAtEdge', 'outgoing', 'delayed', 'retryPayloadRetained', 'pointerChanged', 'joined', 'notifyAll', 'badgeIncluded'] as const
const recountReasons: Record<RecountDeferralReason, true> = {
  'active-skipped': true, 'no-meta': true, 'pointerless-defer': true,
  'pending-remote-displayed': true, 'no-floor': true, 'history-not-caught-up': true,
  'context-changed': true, 'coverage-missing': true, 'coverage-unresolvable': true,
  'coverage-short-of-floor': true, 'cache-unavailable': true, 'recount-superseded': true,
  'input-version-changed': true, 'pointer-changed': true,
}
const token = /^[a-f0-9-]{36}:\d{1,9}$/
type BadgeTarget = 'desktop-native' | 'widget-publisher' | 'native-push' | 'web'
type Phase = typeof phases[number]
type Status = typeof statuses[number]
type Fields = Partial<Record<typeof numbers[number], number> & Record<typeof booleans[number], boolean>>
type Input = Fields & {
  phase: Phase
  badgeTarget?: BadgeTarget
  status: Status
  entityKind?: 'chat' | 'room'
  entityId?: string
  messageKey?: string
  accountScope?: string
  source?: 'live' | 'archive'
  requestId?: string
  recountReason?: RecountDeferralReason
}
type Event = Fields & { badgeTarget?: BadgeTarget; recountReason?: RecountDeferralReason; time: number; phase: Phase; status: Status; entityKind?: 'chat' | 'room'; source?: 'live' | 'archive'; entity?: string; message?: string; request?: string }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

/** Only allowlisted scalars cross this boundary, including when reopening saved data. */
function sanitize(value: unknown): Event | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (!phases.includes(input.phase as Phase) || !statuses.includes(input.status as Status)
    || typeof input.time !== 'number' || !Number.isFinite(input.time)) return null
  const event: Event = { time: input.time, phase: input.phase as Phase, status: input.status as Status }
  if (input.badgeTarget === 'desktop-native' || input.badgeTarget === 'widget-publisher' || input.badgeTarget === 'native-push' || input.badgeTarget === 'web') event.badgeTarget = input.badgeTarget
  if (typeof input.recountReason === 'string' && Object.prototype.hasOwnProperty.call(recountReasons, input.recountReason)) event.recountReason = input.recountReason as RecountDeferralReason
  if (input.entityKind === 'chat' || input.entityKind === 'room') event.entityKind = input.entityKind
  if (input.source === 'live' || input.source === 'archive') event.source = input.source
  for (const key of ['entity', 'message', 'request'] as const) {
    if (typeof input[key] === 'string' && token.test(input[key])) event[key] = input[key]
  }
  for (const key of numbers) {
    const n = input[key]
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000) event[key] = n
  }
  for (const key of booleans) if (typeof input[key] === 'boolean') event[key] = input[key]
  return event
}

/** Bounded, local-only diagnostic journal. Never accepts payloads or exception text. */
export class BadgeDiagnosticJournal {
  private events: Event[] = []
  private readonly session = generateUUID()
  private sequence = 0
  private identities = new Map<string, string>()
  private persistence: 'available' | 'unavailable' = 'available'

  constructor(private readonly storage: () => Storage, private readonly now: () => number = Date.now) {
    try {
      const raw = storage().getItem(BADGE_DIAGNOSTICS_KEY)
      // Refuse oversized/corrupt input before parsing it.
      if (raw && raw.length <= BADGE_DIAGNOSTICS_LIMITS.bytes) {
        const saved: unknown = JSON.parse(raw)
        if (Array.isArray(saved)) this.events = saved.map(sanitize).filter((e): e is Event => e !== null)
      }
    } catch { this.persistence = 'unavailable' }
    this.sweep()
  }

  private anonymous(parts: unknown[]): string {
    const key = JSON.stringify(parts)
    let value = this.identities.get(key)
    if (!value) {
      value = `${this.session}:${++this.sequence}`
      this.identities.set(key, value)
      // Raw identities exist only in this bounded, process-local map.
      if (this.identities.size > 2000) this.identities.delete(this.identities.keys().next().value!)
    }
    return value
  }

  record(input: Input): void {
    const identity = [input.accountScope, input.entityKind, input.entityId]
    const event = sanitize({ ...input, time: this.now(),
      entity: input.entityId ? this.anonymous(['entity', ...identity]) : undefined,
      message: input.messageKey ? this.anonymous(['message', ...identity, input.messageKey]) : undefined,
      request: input.requestId ? this.anonymous(['request', input.requestId]) : undefined,
    })
    if (!event) return
    this.events.push(event)
    this.sweep()
  }

  nextExpiryDelay(): number | undefined {
    if (!this.events.length) return undefined
    return Math.max(1, Math.min(...this.events.map(event => event.time)) + BADGE_DIAGNOSTICS_LIMITS.ageMs - this.now())
  }

  sweep(): void {
    const now = this.now()
    this.events = this.events.filter(event => event.time > now - BADGE_DIAGNOSTICS_LIMITS.ageMs && event.time <= now)
      .slice(-BADGE_DIAGNOSTICS_LIMITS.events)
    // Records contain ASCII only; reserve space for the export's fixed metadata.
    while (JSON.stringify(this.events).length > BADGE_DIAGNOSTICS_LIMITS.bytes - 2048) this.events.shift()
    try {
      this.storage().setItem(BADGE_DIAGNOSTICS_KEY, JSON.stringify(this.events))
      this.persistence = 'available'
    } catch { this.persistence = 'unavailable' }
  }

  export(): string {
    this.sweep()
    return JSON.stringify({ format: 'fluux-badge-diagnostics', version: 1,
      persistence: this.persistence, limits: BADGE_DIAGNOSTICS_LIMITS,
      notice: 'Local diagnostic decisions only. No message text, addresses, keys or raw errors. Tokens correlate only within a bounded process session. Native success means the call completed, not that the OS drew a badge.',
      events: this.events,
    }, null, 0)
  }
}

let journal: BadgeDiagnosticJournal | undefined
function current(): BadgeDiagnosticJournal {
  return journal ??= new BadgeDiagnosticJournal(() => localStorage)
}

export function recordBadgeDiagnostic(input: Input): void {
  // Diagnostics must never prevent an arrival, read transition or native badge call.
  try { current().record({ ...input, accountScope: input.accountScope ?? getStorageScopeJid() ?? '' }); if (stop) scheduleSweep() } catch { /* Nonessential local diagnostics. */ }
}
export function exportBadgeDiagnostics(): string { return current().export() }

let stop: (() => void) | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSweep(): void {
  clearTimeout(expiryTimer)
  const delay = current().nextExpiryDelay()
  if (delay !== undefined) expiryTimer = setTimeout(() => { current().sweep(); scheduleSweep() }, delay)
}
/** Start before React renders; no debug switch, server request or account access. */
export function startBadgeDiagnostics(): () => void {
  try { return installBadgeDiagnostics() } catch { return () => {} }
}

function installBadgeDiagnostics(): () => void {
  if (stop) return stop
  current().sweep()
  let chatScope = getStorageScopeJid()
  let chatEpoch = readStateGeneration('chat', '').store
  const subscriptions = [
    subscribeDiagnostics(event => {
      if (event.kind === 'badge-decision') recordBadgeDiagnostic(event)
      else if (event.kind === 'unread-recount') recordBadgeDiagnostic({ phase: 'recount', status: event.verdict.status === 'deferred' ? 'pending' : 'observed', entityKind: event.entityKind, entityId: event.entityId,
        ...(event.verdict.status === 'deferred' ? { recountReason: event.verdict.reason }
          : { unreadBefore: event.verdict.previousCount, unreadAfter: event.verdict.count }) })
    }, { kinds: ['badge-decision', 'unread-recount'] }),
    chatStore.subscribe((state, previous) => {
      const scope = getStorageScopeJid()
      // The store epoch also catches a reload of the same account after reset.
      const epoch = readStateGeneration('chat', '').store
      if (scope !== chatScope || epoch !== chatEpoch) { chatScope = scope; chatEpoch = epoch; return }
      for (const [id, entity] of state.conversations) {
        const before = previous.conversations.get(id)
        if (before?.unreadCount === entity.unreadCount && before?.readPointer === entity.readPointer) continue
        recordBadgeDiagnostic({ phase: 'read-state', status: 'changed', entityKind: 'chat', entityId: id,
          unreadBefore: before?.unreadCount, unreadAfter: entity.unreadCount, pointerChanged: before?.readPointer !== entity.readPointer })
      }
    }),
    roomStore.subscribe((state, previous) => {
      for (const [id, entity] of state.roomMeta) {
        const before = previous.roomMeta.get(id)
        const joined = state.roomEntities.get(id)?.joined === true
        const level = resolveNotifyLevel(entity)
        const notifyAll = level === 'all'
        if (before?.unreadCount === entity.unreadCount && before?.readPointer === entity.readPointer
          && before?.mentionsCount === entity.mentionsCount
          && resolveNotifyLevel(before) === level
          && (previous.roomEntities.get(id)?.joined === true) === joined) continue
        recordBadgeDiagnostic({ phase: 'read-state', status: 'changed', entityKind: 'room', entityId: id,
          unreadBefore: before?.unreadCount, unreadAfter: entity.unreadCount, pointerChanged: before?.readPointer !== entity.readPointer,
          mentionsBefore: before?.mentionsCount, mentionsAfter: entity.mentionsCount, joined, notifyAll,
          badgeIncluded: joined && hasBadgeActivity(entity) })
      }
    }),
    connectionStore.subscribe((state, before) => {
      if (state.windowVisible !== before.windowVisible) recordBadgeDiagnostic({ phase: 'visibility', status: 'changed', visible: state.windowVisible })
    }),
  ]
  stop = () => { subscriptions.forEach(off => off()); clearTimeout(expiryTimer); stop = undefined }
  scheduleSweep()
  return stop
}

/** Full local-data wipe: discard memory and its timer before removing durable history. */
export function purgeBadgeDiagnostics(): void {
  clearTimeout(expiryTimer)
  expiryTimer = undefined
  journal = undefined
  try { localStorage.removeItem(BADGE_DIAGNOSTICS_KEY) } catch { /* Storage may already be unavailable. */ }
}

/** Test isolation without clearing unrelated app storage. */
export function resetBadgeDiagnosticsForTesting(): void { stop?.(); journal = undefined }
