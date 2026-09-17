/**
 * Which pending events already raised a system notification, per account.
 *
 * The events store is not persisted, and the server redelivers pending contact
 * requests at every login, so without this record each login would alert again
 * for a request the user was already told about. When storage is unavailable
 * only this cross-session record is lost.
 */

const KEY_PREFIX = 'fluux:notified-events:'

/** Bounds the record; the oldest entries are forgotten first. */
const MAX_ENTRIES = 500
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface StoredEvent {
  key: string
  expiresAt: number
}

export interface NotifiedEventMemory {
  has: (key: string) => boolean
  remember: (key: string) => void
  forget: (key: string) => void
}

function load(account: string): StoredEvent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY_PREFIX + account) ?? '[]')
    const now = Date.now()
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): StoredEvent[] => {
      if (typeof entry === 'string') return [{ key: entry, expiresAt: now + MAX_AGE_MS }]
      if (
        entry
        && typeof entry === 'object'
        && typeof (entry as StoredEvent).key === 'string'
        && typeof (entry as StoredEvent).expiresAt === 'number'
        && (entry as StoredEvent).expiresAt > now
      ) return [entry as StoredEvent]
      return []
    })
  } catch {
    return []
  }
}

function save(account: string, entries: StoredEvent[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(KEY_PREFIX + account)
    else localStorage.setItem(KEY_PREFIX + account, JSON.stringify(entries))
  } catch {
    // Quota or disabled storage.
  }
}

export function notifiedEventMemory(account: string): NotifiedEventMemory {
  return {
    has: (key) => {
      const entries = load(account)
      save(account, entries)
      return entries.some((entry) => entry.key === key)
    },
    remember: (key) => {
      const entries = load(account).filter((entry) => entry.key !== key)
      entries.push({ key, expiresAt: Date.now() + MAX_AGE_MS })
      save(account, entries.slice(-MAX_ENTRIES))
    },
    forget: (key) => {
      const entries = load(account)
      if (entries.some((entry) => entry.key === key)) {
        save(account, entries.filter((entry) => entry.key !== key))
      }
    },
  }
}

/** Drop the record for one account, or for every account. */
export function clearNotifiedEventMemory(account?: string): void {
  try {
    if (account) {
      localStorage.removeItem(KEY_PREFIX + account)
      return
    }
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(KEY_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => localStorage.removeItem(key))
  } catch {
    // Storage unavailable: nothing persisted to clear.
  }
}
