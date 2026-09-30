/**
 * Which pending events already raised a banner or sound, per account.
 *
 * The events store is not persisted, and the server redelivers pending contact
 * requests at every login, so without this record each login would alert again
 * for a request the user was already told about. When storage is unavailable
 * only this cross-session record is lost.
 */

/**
 * A banner and a sound are separate alerts: each keeps its own record, so
 * having raised one never suppresses the other.
 */
export type EventAlert = 'banner' | 'sound'

const KEY_PREFIXES: Record<EventAlert, string> = {
  banner: 'fluux:notified-events:',
  sound: 'fluux:notified-event-sounds:',
}

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

function load(storageKey: string): StoredEvent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
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

function save(storageKey: string, entries: StoredEvent[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, JSON.stringify(entries))
  } catch {
    // Quota or disabled storage.
  }
}

export function notifiedEventMemory(account: string, alert: EventAlert = 'banner'): NotifiedEventMemory {
  const storageKey = KEY_PREFIXES[alert] + account
  return {
    has: (key) => {
      const entries = load(storageKey)
      save(storageKey, entries)
      return entries.some((entry) => entry.key === key)
    },
    remember: (key) => {
      const entries = load(storageKey).filter((entry) => entry.key !== key)
      entries.push({ key, expiresAt: Date.now() + MAX_AGE_MS })
      save(storageKey, entries.slice(-MAX_ENTRIES))
    },
    forget: (key) => {
      const entries = load(storageKey)
      if (entries.some((entry) => entry.key === key)) {
        save(storageKey, entries.filter((entry) => entry.key !== key))
      }
    },
  }
}

/** Drop the records for one account, or for every account. */
export function clearNotifiedEventMemory(account?: string): void {
  const prefixes = Object.values(KEY_PREFIXES)
  try {
    if (account) {
      prefixes.forEach((prefix) => localStorage.removeItem(prefix + account))
      return
    }
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key)
    }
    keys.forEach((key) => localStorage.removeItem(key))
  } catch {
    // Storage unavailable: nothing persisted to clear.
  }
}
