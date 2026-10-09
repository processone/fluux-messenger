import { captureStorageScope } from '../../utils/storageScope'
import { logWarn } from '../../core/logger'

type Kind = 'chat' | 'room'
const operations = new Map<string, Promise<void>>()

/** Order opted-in updates with complete cache hydration, including its store commit. */
export function withMessageCacheOperation<T>(kind: Kind, entityId: string, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([captureStorageScope().jid, kind, entityId])
  const previous = operations.get(key)
  const result = previous ? previous.then(action) : action()
  const settled = result.then(() => {}, () => {})
  operations.set(key, settled)
  void settled.then(() => { if (operations.get(key) === settled) operations.delete(key) })
  return result
}

/** An update during hydration writes afterward, then patches only a target now resident. */
export function handoffMessageUpdate<T>(
  kind: Kind,
  entityId: string,
  isCurrent: () => boolean,
  resolveTarget: () => Promise<T | null>,
  persist: (message: T) => Promise<unknown>,
  applyResident: (message: T) => void,
): Promise<void> {
  return withMessageCacheOperation(kind, entityId, async () => {
    if (!isCurrent()) return
    const message = await resolveTarget()
    if (!message || !isCurrent()) return
    try {
      await persist(message)
    } finally {
      if (isCurrent()) applyResident(message)
    }
  }).catch(error => logWarn(`Failed to persist message update: ${String(error)}`))
}
