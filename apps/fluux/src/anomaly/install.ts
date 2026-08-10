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
 * Two things attach here. The signal-to-record adapter connects the neutral signal
 * seam used by both always-shipped monitors and dev-only detectors. The detector tick
 * samples the app once a second for the two timed detectors. Nothing decides in this
 * file: the monitors and the pure detectors under `detectors/` own their verdicts.
 *
 * @module Anomaly/Install
 */
import { chatStore, getStorageScopeJid, readRecountDeferrals, roomStore } from '@fluux/sdk'
import { clearAnomalySignalHandler, setAnomalySignalHandler } from '../utils/anomalySignal'
import type { ViewportKind } from '../utils/viewportAtBottom'
import { isTauri } from '../utils/tauri'
import { recordForSignal } from './detectors/signalRecords'
import { browserWorld, startDetectorTick, type DetectorTick } from './detectors/tick'
import { markAnomalyBuild } from './gate'
import { createRecorder, type Recorder } from './recorder'
import { createMemorySink } from './sinks/memory'
import { createPluginFsWriter, createTauriSink } from './sinks/tauri'
import { ID, RECOUNT_METRIC, initTokenizer } from './values'

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
let detectorTick: DetectorTick | null = null

/**
 * Read the active conversation from the vanilla stores.
 *
 * A room takes precedence: both ids can be set at once (the last conversation stays in
 * `chatStore` while a room is open), and the ROOM is what is on screen. Getting this
 * backwards would attribute a room's unread count to a stale 1:1 — a wrong entity in
 * the log, which is worse than no record.
 */
function readActiveConversation(): { kind: ViewportKind; id: string } | null {
  const roomJid = roomStore.getState().activeRoomJid
  if (roomJid) return { kind: 'room', id: roomJid }
  const conversationId = chatStore.getState().activeConversationId
  if (conversationId) return { kind: 'conversation', id: conversationId }
  return null
}

/** The one canonical unread count for whichever entity is on screen. */
function readUnreadCount(kind: ViewportKind, id: string): number {
  const meta =
    kind === 'room'
      ? roomStore.getState().roomMeta.get(id)
      : chatStore.getState().conversationMeta.get(id)
  // Absent meta is 0, not "unknown": a conversation with no metadata has nothing
  // unread, and inventing a non-zero count would fabricate an anomaly.
  return meta?.unreadCount ?? 0
}

/**
 * Is the loaded window at the tail of the archive.
 *
 * Rooms keep it on `roomRuntime`, conversations in a `windowAtLiveEdge` map — one fact
 * in two shapes. Defaults to `false`, the conservative direction: an unknown window is
 * treated as possibly slid up, which suppresses `fab-at-live-edge` rather than
 * reporting a FAB that may be legitimately offering "jump to latest".
 */
function readWindowAtLiveEdge(kind: ViewportKind, id: string): boolean {
  return kind === 'room'
    ? (roomStore.getState().roomRuntime.get(id)?.windowAtLiveEdge ?? false)
    : (chatStore.getState().windowAtLiveEdge.get(id) ?? false)
}

/**
 * Cumulative deferral tallies as of the last digest, so each window reports a delta.
 *
 * The SDK counts for the life of the process; a digest describes one window. Without
 * this the same deferrals would be re-reported every five minutes and a quiet window
 * would look identical to a busy one.
 */
const lastDeferrals = new Map<string, number>()

/**
 * Fold the SDK's recount-deferral tallies into the recorder before a digest.
 *
 * Why the anomaly log rather than a store subscription: these say why an unread badge
 * kept a stale value, and the badge staying stale is what
 * `read-state/unread-survives-focus` already reports. Having both in the same digest
 * is what turns "the badge was wrong" into "the badge was wrong BECAUSE coverage was
 * missing" (issue #1211).
 */
function foldRecountDeferrals(rec: Recorder): void {
  for (const [key, total] of Object.entries(readRecountDeferrals())) {
    const previous = lastDeferrals.get(key) ?? 0
    if (total <= previous) continue
    const metric = RECOUNT_METRIC[key]
    // An unknown key means the SDK grew a reason this build has no constant for.
    // Dropping it is right: a counter name is a closed registry, and inventing one
    // from a string that crossed a package boundary is the hole that registry closes.
    if (metric) rec.count(metric, total - previous)
    lastDeferrals.set(key, total)
  }
}

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

    // The message-list scroll sentinels and `stallSentinel` cannot import this
    // tree — they ship in release builds. They signal into a neutral seam
    // instead, and this is where the seam is connected. Registration is idempotent
    // (the handler is a fresh closure over the same runtime), so a StrictMode
    // remount replaces it rather than stacking a second one.
    setAnomalySignalHandler((signal) => {
      const input = recordForSignal(signal)
      if (input) rec.record(input)
    })

    // The timed detectors. Started here rather than at module scope so it shares the
    // refcount: a StrictMode remount must not leave two intervals sampling, which
    // would double every verdict and turn the duplicate into a phantom suppression.
    detectorTick = startDetectorTick(
      browserWorld(
        readActiveConversation,
        readUnreadCount,
        () => getStorageScopeJid() ?? '',
        readWindowAtLiveEdge,
      ),
    )

    digestTimer = setInterval(() => {
      foldRecountDeferrals(rec)
      rec.flushDigest(DIGEST_INTERVAL_MS)
    }, DIGEST_INTERVAL_MS)

    const onVisibility = () => {
      // Best effort: the WebView gives no guarantee that asynchronous I/O completes
      // during teardown, so a missing trailing digest is normal and never a signal.
      if (document.visibilityState === 'hidden') {
        foldRecountDeferrals(rec)
        rec.flushDigest(DIGEST_INTERVAL_MS)
      }
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
    detectorTick?.stop()
    detectorTick = null
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
  detectorTick?.stop()
  detectorTick = null
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
  lastDeferrals.clear()
}

/** Diagnostic: how many times `install()` actually attached. */
export function installCount(): number {
  return attachments
}
