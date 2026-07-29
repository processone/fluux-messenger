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
let ready: Promise<void> | null = null
let sessionAnnounced = false

let attachments = 0
/**
 * Identifies the CURRENT attachment. React can run a previous effect's cleanup
 * after the next effect has already attached; a cleanup that blindly cleared the
 * timer would silently stop the digest schedule for the rest of the session.
 */
let attachmentToken = 0
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
 * Resolves once the tokenizer holds its key.
 *
 * Awaited before the first record, because one written earlier would carry
 * `tokenKeyId: "unknown"` — and that field is the correlation boundary, so an
 * unattributable record is worse than a late one.
 *
 * Never rejects: a cached rejection would make every later awaiter throw and the
 * session record would never be attempted again, so a failure is logged and
 * swallowed. Records still work; their tokens simply stay unresolved.
 */
export function whenReady(): Promise<void> {
  if (!ready) {
    ready = initTokenizer().catch((err: unknown) => {
      console.warn(`[Anomaly] tokenizer unavailable, tokens will not resolve: ${String(err)}`)
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
  void whenReady().then(() => rec.record({ id: ID.sessionStart, sev: 'drift' }))
}

/**
 * Attach subscriptions and timers. Idempotent: a second call while already
 * attached is a no-op returning a cleanup that does nothing.
 *
 * @returns cleanup that detaches what THIS call attached. It does not destroy the
 * runtime.
 */
export function install(): () => void {
  if (digestTimer) return () => {}

  attachments++
  const token = ++attachmentToken
  const rec = runtime()

  markAnomalyBuild()
  announceSessionOnce(rec)

  digestTimer = setInterval(() => rec.flushDigest(DIGEST_INTERVAL_MS), DIGEST_INTERVAL_MS)

  const onVisibility = () => {
    // Best effort: the WebView gives no guarantee that asynchronous I/O completes
    // during teardown, so a missing trailing digest is normal and never a signal.
    if (document.visibilityState === 'hidden') rec.flushDigest(DIGEST_INTERVAL_MS)
  }
  document.addEventListener('visibilitychange', onVisibility)
  detachListener = () => document.removeEventListener('visibilitychange', onVisibility)

  return () => {
    // Only the owner may detach. A stale cleanup arriving after a later attach must
    // not disarm it.
    if (token !== attachmentToken) return
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
  attachmentToken = 0
}

/** Diagnostic: how many times `install()` actually attached. */
export function installCount(): number {
  return attachments
}
