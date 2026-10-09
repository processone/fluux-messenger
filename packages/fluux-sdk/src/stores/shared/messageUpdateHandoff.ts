import { captureStorageScope } from '../../utils/storageScope'
import { logWarn } from '../../core/logger'
import type { Message, RoomMessage } from '../../core/types'

type Kind = 'chat' | 'room'
const operations = new Map<string, Promise<void>>()
type Row = Message | RoomMessage
interface ResidentUpdate {
  fields: readonly string[]
  matchesTarget: (message: Row) => boolean
}
const residentUpdates = new Map<string, Set<ResidentUpdate>>()

interface ImmediateMessageUpdate<T> {
  persist: () => Promise<T>
  fields?: readonly string[]
  matchesTarget?: (message: Row) => boolean
  applyResident: (result: T, isLatest: (message: Row, field: string) => boolean) => void | Promise<void>
}

/** Select accepted fields that have not been superseded. */
export function messageUpdateFields<T extends object>(message: T, updates: Partial<T>, canApply: (field: string) => boolean): Partial<T> {
  const result: Partial<T> = {}
  for (const key of Object.keys(updates) as (keyof T & string)[]) {
    if (canApply(key)) result[key] = message[key]
  }
  return result
}

/** Order opted-in updates with complete cache hydration, including its store commit. */
export function withMessageCacheOperation<T>(kind: Kind, entityId: string, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([captureStorageScope().jid, kind, entityId])
  return enqueueMessageCacheOperation(key, action)
}

function enqueueMessageCacheOperation<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = operations.get(key)
  const result = previous ? previous.then(action) : action()
  const settled = result.then(() => {}, () => {})
  operations.set(key, settled)
  void settled.then(() => { if (operations.get(key) === settled) operations.delete(key) })
  return result
}

/** Reconcile durable updates after preceding cache hydration has committed its resident rows. */
export function handoffMessageUpdate<T>(
  kind: Kind,
  entityId: string,
  isCurrent: () => boolean,
  update: ImmediateMessageUpdate<T>,
): Promise<void>
export function handoffMessageUpdate<T>(
  kind: Kind,
  entityId: string,
  isCurrent: () => boolean,
  resolveTarget: () => Promise<T | null>,
  persist: (message: T) => Promise<unknown>,
  applyResident: (message: T) => void,
): Promise<void>
export function handoffMessageUpdate<T>(
  kind: Kind,
  entityId: string,
  isCurrent: () => boolean,
  resolveTarget: (() => Promise<T | null>) | ImmediateMessageUpdate<T>,
  persist?: (message: T) => Promise<unknown>,
  applyResident?: (message: T) => void,
): Promise<void> {
  if (typeof resolveTarget !== 'function') {
    // Live store mutations and their durable writes start synchronously. Only
    // reconciliation waits for the preceding hydration's resident commit.
    const update = resolveTarget
    const key = JSON.stringify([captureStorageScope().jid, kind, entityId])
    const pending = residentUpdates.get(key) ?? new Set<ResidentUpdate>()
    const accepted: ResidentUpdate = { fields: update.fields ?? [], matchesTarget: update.matchesTarget ?? (() => false) }
    pending.add(accepted)
    residentUpdates.set(key, pending)
    const isLatest = (message: Row, field: string) => {
      let later = false
      for (const candidate of pending) {
        if (candidate === accepted) { later = true; continue }
        if (later && candidate.fields.includes(field) && candidate.matchesTarget(message)) return false
      }
      return true
    }
    const started = isCurrent()
      ? update.persist().then(result => ({ result }), error => ({ error }))
      : Promise.resolve(null)
    return enqueueMessageCacheOperation(key, async () => {
      const completed = await started
      if (!completed) return
      if ('error' in completed) throw completed.error
      if (isCurrent()) await update.applyResident(completed.result, isLatest)
    }).catch(error => logWarn(`Failed to persist message update: ${String(error)}`)).finally(() => {
      pending.delete(accepted)
      if (!pending.size && residentUpdates.get(key) === pending) residentUpdates.delete(key)
    })
  }
  return withMessageCacheOperation(kind, entityId, async () => {
    if (!isCurrent()) return
    const message = await resolveTarget()
    if (!message || !isCurrent()) return
    try {
      await persist!(message)
    } finally {
      if (isCurrent()) applyResident!(message)
    }
  }).catch(error => logWarn(`Failed to persist message update: ${String(error)}`))
}
