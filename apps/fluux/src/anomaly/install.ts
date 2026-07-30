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
 * The only thing attached so far is the sentinel fan-out: the existing scroll and
 * stall monitors keep their prose and additionally signal into a neutral seam,
 * which is connected here. No detection logic lives in this tree.
 *
 * @module Anomaly/Install
 */
import { clearAnomalySignalHandler, setAnomalySignalHandler } from '../utils/anomalySignal'
import { isTauri } from '../utils/tauri'
import { recordForSignal } from './detectors/sentinelFanout'
import { markAnomalyBuild } from './gate'
import { createRecorder, type Recorder } from './recorder'
import { createMemorySink } from './sinks/memory'
import { createPluginFsWriter, createTauriSink } from './sinks/tauri'
import { ID, initTokenizer } from './values'

const DIGEST_INTERVAL_MS = 5 * 60 * 1000
/**
 * The session announcement retries itself, because nothing else will.
 *
 * In a real StrictMode cycle both mounts happen before the first readiness promise
 * settles, so the second one finds the announcement already claimed and registers
 * no callback of its own. When that shared promise then fails there is no third
 * mount to notice, and neither the digest timer nor a visibilitychange calls back
 * into the announcement — the session would simply never open.
 */
const SESSION_RETRY_MS = 2000
const SESSION_MAX_ATTEMPTS = 3

/**
 * Retry delay, overridable ONLY by tests.
 *
 * The retry path involves real WebCrypto, which fake timers cannot advance, so a
 * test either waits two real seconds or shortens the delay. A named seam is
 * clearer than either a three-second test or a pile of crypto mocks.
 */
let sessionRetryMs = SESSION_RETRY_MS

const sessionId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sid-${Date.now()}`

let recorder: Recorder | null = null
let ready: Promise<boolean> | null = null
let sessionAnnounced = false
let sessionAttempts = 0
let sessionRetryTimer: ReturnType<typeof setTimeout> | null = null

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
  attemptSessionRecord(rec)
}

function attemptSessionRecord(rec: Recorder): void {
  sessionAttempts++
  void whenReady().then((ok) => {
    if (ok) {
      rec.record({ id: ID.sessionStart, sev: 'drift' })
      return
    }
    if (sessionAttempts >= SESSION_MAX_ATTEMPTS) {
      console.warn(
        `[Anomaly] session record abandoned after ${SESSION_MAX_ATTEMPTS} attempts; ` +
          'this session has no key-space anchor',
      )
      return
    }
    // whenReady() cleared its cached promise on failure, so this re-initialises.
    sessionRetryTimer = setTimeout(() => {
      sessionRetryTimer = null
      attemptSessionRecord(rec)
    }, sessionRetryMs)
  })
}

/**
 * Acquire a hold on the shared subscriptions, attaching them on the first hold.
 *
 * NOT a no-op when already attached: the call takes a reference, so its cleanup is
 * required — skipping it would leave the timer and listener alive for the rest of
 * the session.
 *
 * @returns a release for THIS hold. The subscriptions come down when the last hold
 * is released; the runtime itself is never destroyed.
 */
export function install(): () => void {
  const rec = runtime()
  markAnomalyBuild()
  announceSessionOnce(rec)

  attachRefs++
  if (attachRefs === 1) {
    attachments++

    // The sentinels in `useMessageListScroll` and `stallSentinel` cannot import
    // this tree — they ship in release builds. They signal into a neutral seam
    // instead, and this is where the seam is connected. Registration is idempotent
    // (the handler is a fresh closure over the same runtime), so a StrictMode
    // remount replaces it rather than stacking a second one.
    setAnomalySignalHandler((signal) => {
      const input = recordForSignal(signal)
      if (input) rec.record(input)
    })

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

    clearAnomalySignalHandler()
    detachListener?.()
    detachListener = null
    if (digestTimer) clearInterval(digestTimer)
    digestTimer = null
  }
}

/** Test-only: shorten the session-record retry delay. */
export function setSessionRetryDelayForTesting(ms: number): void {
  sessionRetryMs = ms
}

/** Test-only: tears down the runtime as well as the subscriptions. */
export function resetInstallForTesting(): void {
  clearAnomalySignalHandler()
  detachListener?.()
  detachListener = null
  if (digestTimer) clearInterval(digestTimer)
  digestTimer = null
  if (sessionRetryTimer) clearTimeout(sessionRetryTimer)
  sessionRetryTimer = null
  recorder = null
  ready = null
  sessionAnnounced = false
  sessionAttempts = 0
  sessionRetryMs = SESSION_RETRY_MS
  attachments = 0
  attachRefs = 0
}

/** Diagnostic: how many times `install()` actually attached. */
export function installCount(): number {
  return attachments
}
