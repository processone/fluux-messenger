/**
 * Per-key leading + trailing throttle over `localStorage`.
 *
 * Every persisted store in the SDK re-serializes its whole blob on each
 * mutation. During post-connect MAM catch-up that is one synchronous
 * `JSON.stringify` + disk write per page — a main-thread stall on mobile
 * WebKit, where `setItem` is a synchronous disk write.
 *
 * `produce` is a LAZY THUNK, not a string. The expensive part is the
 * serialization, not `setItem`, so coalesced writes must skip it entirely:
 * a 180-page catch-up costs ~20 serializations rather than 180.
 *
 * Throttle, not debounce. A debounce resets its timer on every write, so a
 * continuous burst defers the write for the whole burst and leaves all of it
 * at risk on an abrupt close. This writes at a steady ~1/window and is never
 * starved: on-disk state is never more than one window stale.
 *
 * NOT safe for data that records a durable EVENT rather than a lagging mirror
 * of reconstructible state — see `flushKey` and chatStore's pending
 * retractions.
 */

import { measured } from '../../utils/measure'

/**
 * Deliberately not `PERSIST_DEBOUNCE_MS` from `stateSnapshot.ts` (500 ms).
 * That is a different mechanism (debounce, SM snapshot) and the two constants
 * must be able to move independently.
 */
const WINDOW_MS = 1000

interface Entry {
  timer: ReturnType<typeof setTimeout>
  /** Latest thunk received while the window was open; undefined = window idle. */
  pending?: () => string
}

/** Open windows, keyed by storage key. Absence of a key means no open window. */
const entries = new Map<string, Entry>()

let lifecycleRegistered = false

/**
 * Serialize and write, absorbing every failure.
 *
 * Both halves can throw: `produce` runs user serialization, and `setItem`
 * throws on quota exhaustion and in private mode. Every call site this module
 * replaced swallowed storage errors and continued without persistence, and a
 * throw escaping here would propagate out of a `set()` call or a `pagehide`
 * handler.
 */
function write(key: string, produce: () => string): boolean {
  try {
    // Both halves block, and the module header above names the consequence: the
    // serialization is the expensive part and `setItem` is a synchronous disk
    // write. This is the single chokepoint for every persisted write, so measuring
    // here covers the leading edge, the trailing timer and every flush.
    measured('persist', () => localStorage.setItem(key, produce()))
    return true
  } catch {
    // Continue without persistence, as every replaced call site did — but the
    // CALLER must know, so it can avoid arming a window around a write that
    // never landed.
    return false
  }
}

function onTimer(key: string): void {
  const entry = entries.get(key)
  if (!entry) return

  const pending = entry.pending
  if (!pending) {
    // Quiet window — close it. The next schedule takes the leading edge.
    entries.delete(key)
    return
  }

  // Cleared BEFORE the write: a throwing `produce` must not leave the thunk
  // armed to be retried forever.
  entry.pending = undefined
  if (!write(key, pending)) {
    // Failed write: close the window instead of rearming. Leaving a timer
    // armed around a failure would make the next good save wait a full window
    // for no reason; closing lets it take the leading edge immediately.
    entries.delete(key)
    return
  }
  // Open a fresh window rather than closing. This is what makes a sustained
  // burst write at a steady rate instead of going silent after two writes.
  entry.timer = setTimeout(() => onTimer(key), WINDOW_MS)
}

function registerLifecycleHandlers(): void {
  if (lifecycleRegistered) return
  // Guarded so importing the SDK in Node (bots, tests, SSR) has no side effect.
  // Deliberately checked BEFORE latching the flag: a windowless environment
  // (e.g. a bot process that later attaches a `window` shim) must be able to
  // register on a later call rather than being permanently locked out here.
  if (typeof window === 'undefined') return
  lifecycleRegistered = true
  // `pagehide` and `visibilitychange` are the pair that fires reliably on
  // mobile WebKit; `beforeunload` is desktop belt-and-braces.
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
}

/**
 * Persist `produce()` under `key`, coalescing bursts.
 *
 * `key` must be resolved by the CALLER, before calling — never inside
 * `produce`. A trailing write that fires after an account switch has to land
 * under the key that was current when its state was produced.
 */
export function schedule(key: string, produce: () => string): void {
  registerLifecycleHandlers()

  const entry = entries.get(key)
  if (entry) {
    entry.pending = produce
    return
  }

  // Only arm a window if the leading write actually landed. A failed write
  // must leave no window and no timer, so the next schedule can retry
  // immediately on its own leading edge rather than being coalesced behind a
  // window that is guarding nothing.
  if (!write(key, produce)) return
  entries.set(key, { timer: setTimeout(() => onTimer(key), WINDOW_MS) })
}

/**
 * Force one key's pending write out now and close its window.
 *
 * The durability escape hatch for data that must not sit in a pending thunk.
 * Carries no thunk of its own — it flushes whatever the caller already
 * scheduled, so it costs nothing when the leading edge has already written.
 */
export function flushKey(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  entries.delete(key)
  if (entry.pending) write(key, entry.pending)
}

/**
 * Drop one key's pending write and close its window.
 *
 * Call BEFORE `localStorage.removeItem` on any clear path, or a write
 * scheduled moments earlier fires afterwards and resurrects what was cleared.
 */
export function cancel(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  entries.delete(key)
}

/** Write every pending thunk now and close all windows. */
export function flush(): void {
  for (const [key, entry] of entries) {
    clearTimeout(entry.timer)
    if (entry.pending) write(key, entry.pending)
  }
  entries.clear()
}

/**
 * Test-only: drop all windows without writing.
 *
 * Lifecycle listeners are deliberately NOT unregistered — `flush` is
 * idempotent, and re-registering per suite would stack duplicates.
 * @internal
 */
export function _resetForTesting(): void {
  for (const entry of entries.values()) clearTimeout(entry.timer)
  entries.clear()
}
