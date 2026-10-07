/**
 * Keeps localStorage keys in native storage on hosts whose webview may evict
 * its own storage (WKWebView on iOS).
 *
 * The native side is the source of truth for every key except those that
 * describe the IndexedDB cache: the webview evicts IndexedDB and localStorage
 * together, so those keys stay in the webview and vanish with the cache they
 * describe. Restoring them alone would claim a cache that no longer exists.
 *
 * Reads are synchronous, from a copy loaded before the app is imported; each
 * write updates that copy and is sent to native storage at the end of the task.
 * The native file format is documented in `src-tauri/src/native_storage.rs`.
 */

/** A batch of writes. `set` and `remove` never name the same key. */
export interface StorageChange {
  clear: boolean
  set: Record<string, string>
  remove: string[]
}

export interface NativeStorageBackend {
  load(): Promise<Record<string, string>>
  apply(change: StorageChange): Promise<void>
}

const WEBVIEW_ONLY_EXACT_OR_SCOPED = [
  'xmpp-chat-storage',
  'fluux-room-gaps',
  'fluux-room-coverage',
  'fluux:lastArchivedPreviewCheck',
  'fluux:lastRosterDiscovery',
  'fluux:msg-heights',
]
const WEBVIEW_ONLY_PREFIXES = ['fluux:cache-marker:']

/** Whether a key stays in the webview, alongside the IndexedDB cache it describes. */
export function isWebviewOnlyKey(key: string): boolean {
  return (
    WEBVIEW_ONLY_EXACT_OR_SCOPED.some((base) => key === base || key.startsWith(`${base}:`)) ||
    WEBVIEW_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix))
  )
}

export interface InstalledNativeStorage {
  /** Resolves once every write made so far has reached native storage. */
  flush(): Promise<void>
  /** Restores the original Storage methods. */
  uninstall(): void
}

/**
 * Routes `target`'s native keys to `entries`, persisted through `backend`.
 *
 * Patches `Storage.prototype` because a write to a Storage instance's own
 * properties stores an item instead of overriding a method. Other Storage
 * instances (sessionStorage) pass through untouched.
 */
export function installNativeLocalStorage(
  target: Storage,
  initial: Record<string, string>,
  backend: NativeStorageBackend,
): InstalledNativeStorage {
  const proto = Object.getPrototypeOf(target) as Storage
  const lengthDescriptor = Object.getOwnPropertyDescriptor(proto, 'length')!
  const original = {
    getItem: proto.getItem,
    setItem: proto.setItem,
    removeItem: proto.removeItem,
    clear: proto.clear,
    key: proto.key,
  }
  const webviewKeys = (): string[] => {
    const keys: string[] = []
    const length = lengthDescriptor.get!.call(target) as number
    for (let i = 0; i < length; i++) {
      const key = original.key.call(target, i)
      if (key !== null) keys.push(key)
    }
    return keys
  }

  const entries = new Map(Object.entries(initial))
  const pending = new Map<string, string | null>()
  let clearPending = false
  let scheduled = false
  let chain: Promise<void> = Promise.resolve()

  /** Sends the pending writes; resolves to whether this batch was stored. */
  const send = (): Promise<boolean> => {
    scheduled = false
    if (!clearPending && pending.size === 0) return chain.then(() => true)
    const change: StorageChange = { clear: clearPending, set: {}, remove: [] }
    for (const [key, value] of pending) {
      if (value === null) change.remove.push(key)
      else change.set[key] = value
    }
    pending.clear()
    clearPending = false
    const stored = chain.then(() => backend.apply(change)).then(
      () => true,
      (error: unknown) => {
        console.error('[NativeStorage] Write failed:', error)
        return false
      },
    )
    chain = stored.then(() => undefined)
    return stored
  }
  const record = (key: string, value: string | null) => {
    pending.set(key, value)
    if (!scheduled) {
      scheduled = true
      queueMicrotask(send)
    }
  }

  // A key still in the webview was written after the last native load (first
  // launch, or a launch where native storage was unavailable), so it wins.
  // The webview copy is dropped only once native storage holds it.
  const migrated: string[] = []
  for (const key of webviewKeys()) {
    if (isWebviewOnlyKey(key)) continue
    const value = original.getItem.call(target, key)
    if (value === null) continue
    entries.set(key, value)
    record(key, value)
    migrated.push(key)
  }

  const isNative = (storage: Storage, key: string) => storage === target && !isWebviewOnlyKey(key)
  const allKeys = () => [...webviewKeys().filter(isWebviewOnlyKey), ...entries.keys()]

  proto.getItem = function (this: Storage, key: string) {
    key = String(key)
    return isNative(this, key) ? (entries.get(key) ?? null) : original.getItem.call(this, key)
  }
  proto.setItem = function (this: Storage, key: string, value: string) {
    key = String(key)
    if (!isNative(this, key)) return original.setItem.call(this, key, value)
    value = String(value)
    entries.set(key, value)
    record(key, value)
  }
  proto.removeItem = function (this: Storage, key: string) {
    key = String(key)
    if (!isNative(this, key)) return original.removeItem.call(this, key)
    if (!entries.delete(key)) return
    record(key, null)
  }
  proto.clear = function (this: Storage) {
    original.clear.call(this)
    if (this !== target) return
    entries.clear()
    pending.clear()
    clearPending = true
    if (!scheduled) {
      scheduled = true
      queueMicrotask(send)
    }
  }
  proto.key = function (this: Storage, index: number) {
    if (this !== target) return original.key.call(this, index)
    return allKeys()[index] ?? null
  }
  Object.defineProperty(proto, 'length', {
    ...lengthDescriptor,
    get(this: Storage) {
      return this === target ? allKeys().length : lengthDescriptor.get!.call(this)
    },
  })

  if (migrated.length > 0) {
    void send().then((stored) => {
      if (!stored) return
      for (const key of migrated) original.removeItem.call(target, key)
    })
  }

  return {
    flush: () => send().then(() => undefined),
    uninstall: () => {
      Object.assign(proto, original)
      Object.defineProperty(proto, 'length', lengthDescriptor)
    },
  }
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export const tauriNativeStorage: NativeStorageBackend = {
  load: () => invoke<Record<string, string>>('native_storage_load'),
  apply: (change) => invoke<void>('native_storage_apply', { change }),
}

/**
 * Loads native storage and routes localStorage through it. Must finish before
 * any module that reads localStorage at import time is imported.
 *
 * When native storage is unavailable, localStorage is left as is: the app
 * keeps working on webview storage, and the next launch migrates what it wrote.
 */
export async function bootNativeLocalStorage(backend: NativeStorageBackend = tauriNativeStorage): Promise<void> {
  try {
    const initial = await backend.load()
    installNativeLocalStorage(window.localStorage, initial, backend)
  } catch (error) {
    console.error('[NativeStorage] Unavailable, keeping webview storage:', error)
  }
}
