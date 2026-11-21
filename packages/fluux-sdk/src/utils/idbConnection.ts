import { logWarn } from '../core/logger'

/**
 * How long an open may take before an upgrade starts. Past it the cache gives
 * up and runs without IndexedDB. An open that needs no upgrade completes in
 * milliseconds, and connections opened by this code release themselves on
 * `versionchange`, so a wait this long means an older client or a frozen tab
 * is holding the database. Upgrade time is not counted: a migration may be slow.
 */
export const BLOCKED_OPEN_TIMEOUT_MS = 10_000

let defaultBlockedTimeoutMs: number | null = BLOCKED_OPEN_TIMEOUT_MS

/**
 * Set the deadline used when an open does not pass its own; null disables it.
 * The SDK test setup disables it: tests that advance fake timers while a real
 * open is in flight would otherwise trip it.
 * @internal
 */
export function _setBlockedOpenTimeoutForTesting(ms: number | null): void {
  defaultBlockedTimeoutMs = ms
}

/** An IndexedDB open gave up waiting for another connection to close. */
export class StorageBlockedError extends Error {
  constructor(readonly database: string) {
    super(`IndexedDB "${database}" is held open by another connection`)
    this.name = 'StorageBlockedError'
  }
}

/** Callbacks a guarded open wires into its IndexedDB request. */
export interface GuardedOpenHooks {
  /** The open is waiting for other connections to close (`blocked`). Diagnostic only. */
  blocked: () => void
  /**
   * Call first in the upgrade callback. False when the open already gave up:
   * the caller must abort the version-change transaction so an abandoned
   * open never migrates the database.
   */
  proceed: () => boolean
  /**
   * Another connection wants a newer version (`versionchange`, idb's
   * `blocking`). Closes this connection so the upgrade can run.
   */
  release: (db: { close(): void }) => void
  /** The browser closed the connection (idb's `terminated`, `close`). */
  lost: () => void
}

export interface GuardedOpenOptions {
  /** Database name, for diagnostics. */
  database: string
  /**
   * The connection is gone, released or lost. The owner drops its cached
   * connection promise here so the next access reopens.
   */
  onClosed: () => void
  /** Overrides the default deadline; null disables it. */
  blockedTimeoutMs?: number | null
}

/**
 * Open an IndexedDB connection that cannot stall its callers or another
 * client's schema upgrade.
 *
 * Without it, two hazards stay silent: an open blocked by a connection that
 * never closes waits forever (every cache read awaits it), and a connection
 * that ignores `versionchange` blocks a newer client's upgrade the same way.
 */
export function openGuarded<T extends { close(): void }>(
  open: (hooks: GuardedOpenHooks) => Promise<T>,
  { database, onClosed, blockedTimeoutMs = defaultBlockedTimeoutMs }: GuardedOpenOptions,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let abandoned = false
  let giveUp!: (error: Error) => void
  const abandonedOpen = new Promise<never>((_, reject) => { giveUp = reject })

  const stopWaiting = () => {
    clearTimeout(timer)
    timer = undefined
  }

  // Armed before the request: an open queued behind another client's pending
  // upgrade or deletion waits without ever receiving `blocked`.
  if (blockedTimeoutMs !== null) {
    timer = setTimeout(() => {
      timer = undefined
      abandoned = true
      logWarn(`[Storage] ${database}: not open after ${blockedTimeoutMs}ms, continuing without it`)
      giveUp(new StorageBlockedError(database))
    }, blockedTimeoutMs)
  }

  const hooks: GuardedOpenHooks = {
    blocked: () => {
      if (!settled && !abandoned) logWarn(`[Storage] ${database}: waiting for another tab to release the database`)
    },
    proceed: () => {
      stopWaiting()
      return !abandoned
    },
    release: (db) => {
      db.close()
      onClosed()
    },
    lost: onClosed,
  }

  const opening = open(hooks)
  void opening.then(
    (db) => {
      settled = true
      stopWaiting()
      // An open that was given up on and needed no upgrade still succeeds
      // later; its connection would block the next upgrade if kept.
      if (abandoned) db.close()
    },
    () => {
      settled = true
      stopWaiting()
    },
  )
  return Promise.race([opening, abandonedOpen])
}

export interface OpenIndexedDBOptions extends Omit<GuardedOpenOptions, 'database'> {
  upgrade: (db: IDBDatabase, oldVersion: number, transaction: IDBTransaction) => void
}

/** {@link openGuarded} for code using the raw IndexedDB API rather than `idb`. */
export function openIndexedDB(name: string, version: number, { upgrade, ...options }: OpenIndexedDBOptions): Promise<IDBDatabase> {
  return openGuarded<IDBDatabase>((hooks) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onblocked = hooks.blocked
    request.onupgradeneeded = (event) => {
      const transaction = request.transaction!
      if (!hooks.proceed()) {
        transaction.abort()
        return
      }
      upgrade(request.result, event.oldVersion, transaction)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => hooks.release(db)
      db.onclose = hooks.lost
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  }), { database: name, ...options })
}
