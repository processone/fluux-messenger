/**
 * Lifecycle for the anomaly system.
 *
 * The RUNTIME is a module-level singleton, created once and never torn down.
 * React.StrictMode runs effects install → cleanup → install on mount; if cleanup
 * destroyed the recorder, the second install would rebuild the counters, cooldown
 * map and breadcrumb ring, so a remount would silently reset every bound the design
 * relies on while the session kept its id. Only SUBSCRIPTIONS are attached and
 * detached — the runtime outlives them.
 *
 * Stage 1 registers NO detectors. This establishes the contract they attach to.
 *
 * @module Anomaly/Install
 */
import { isTauri } from '../utils/tauri'
import { markAnomalyBuild } from './gate'
import { createRecorder, type Recorder } from './recorder'
import { createMemorySink } from './sinks/memory'
import { createPluginFsWriter, createTauriSink } from './sinks/tauri'
import { ID, initTokenizer } from './values'

const DIGEST_INTERVAL_MS = 5 * 60 * 1000

const sessionId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sid-${Date.now()}`

let recorder: Recorder | null = null
let ready: Promise<boolean> | null = null
let sessionAnnounced = false

let attachments = 0
/**
 * How many live handles hold the attachment.
 *
 * React can run a previous effect's cleanup after the next effect has already
 * mounted. A guard keyed on "who attached last" does not help, because the second
 * install finds the timer already armed and returns without claiming ownership —
 * so the first cleanup tears down an attachment the second holder still depends
 * on, and the digest schedule dies for the rest of the session. Counting holders
 * and detaching only at zero is what actually survives that interleaving.
 */
let attachRefs = 0
let digestTimer: ReturnType<typeof setInterval> | null = null
let detachListener: (() => void) | null = null

function runtime(): Recorder {
  if (!recorder) {
    recorder = createRecorder({
      // The web and demo builds have no filesystem; the sidecar is desktop-only.
      sink: isTauri() ? createTauriSink(createPluginFsWriter()) : createMemorySink(),
      now: () => Date.now(),
      build: `${__APP_VERSION__}+${__GIT_COMMIT__}`,
      sid: sessionId,
    })
  }
  return recorder
}

export function getRecorder(): Recorder | null {
  return recorder
}

/**
 * Resolves to whether the tokenizer holds its key.
 *
 * Never REJECTS — a cached rejection would make every later awaiter throw — but it
 * does report failure, because a caller that cannot tell success from failure will
 * happily write a record stamped `tokenKeyId: "unknown"`, which is unattributable
 * to a token space and therefore worse than no record at all.
 *
 * A failed attempt is not cached: the promise is cleared so the next call retries.
 */
export function whenReady(): Promise<boolean> {
  if (!ready) {
    ready = initTokenizer()
      .then(() => true)
      .catch((err: unknown) => {
        console.warn(`[Anomaly] tokenizer unavailable: ${String(err)}`)
        ready = null
        return false
      })
  }
  return ready
}

/**
 * Emit the one session-start record, at most once per process.
 *
 * This belongs to the RUNTIME, not to an attachment: a callback attached inside
 * `install()` fires once per StrictMode attach, and while the per-id cooldown would
 * hide the duplicate record it would still count a phantom suppressed entry, so
 * every Dev session would open with a suppression that means nothing.
 */
function announceSessionOnce(rec: Recorder): void {
  if (sessionAnnounced) return
  sessionAnnounced = true
  void whenReady().then((ok) => {
    // Latch only on success. A tokenizer failure must leave the announcement
    // pending, so a later attach can retry it rather than the session silently
    // never opening.
    if (!ok) {
      sessionAnnounced = false
      return
    }
    rec.record({ id: ID.sessionStart, sev: 'drift' })
  })
}

/**
 * Attach subscriptions and timers. Idempotent: a second call while already
 * attached is a no-op returning a cleanup that does nothing.
 *
 * @returns cleanup that detaches what THIS call attached. It does not destroy the
 * runtime.
 */
export function install(): () => void {
  const rec = runtime()
  markAnomalyBuild()
  announceSessionOnce(rec)

  attachRefs++
  if (attachRefs === 1) {
    attachments++

    digestTimer = setInterval(() => rec.flushDigest(DIGEST_INTERVAL_MS), DIGEST_INTERVAL_MS)

    const onVisibility = () => {
      // Best effort: the WebView gives no guarantee that asynchronous I/O completes
      // during teardown, so a missing trailing digest is normal and never a signal.
      if (document.visibilityState === 'hidden') rec.flushDigest(DIGEST_INTERVAL_MS)
    }
    document.addEventListener('visibilitychange', onVisibility)
    detachListener = () => document.removeEventListener('visibilitychange', onVisibility)
  }

  let released = false
  return () => {
    // Per-handle, so a double cleanup cannot over-release and detach an attachment
    // another holder still needs.
    if (released) return
    released = true

    attachRefs--
    if (attachRefs > 0) return

    detachListener?.()
    detachListener = null
    if (digestTimer) clearInterval(digestTimer)
    digestTimer = null
  }
}

/** Test-only: tears down the runtime as well as the subscriptions. */
export function resetInstallForTesting(): void {
  detachListener?.()
  detachListener = null
  if (digestTimer) clearInterval(digestTimer)
  digestTimer = null
  recorder = null
  ready = null
  sessionAnnounced = false
  attachments = 0
  attachRefs = 0
}

/** Diagnostic: how many times `install()` actually attached. */
export function installCount(): number {
  return attachments
}
