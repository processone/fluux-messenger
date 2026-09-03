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
import { chatReadStateGeneration, chatStore, connectionStore, getStorageScopeJid, isAhead, onArchiveMerge, readRecountDeferrals, roomReadStateGeneration, roomStore, setMeasurementEnabled } from '@fluux/sdk'
import { clearAnomalyMetricHandler, setAnomalyMetricHandler } from '../utils/anomalyMetric'
import {
  clearAnomalyObservationHandler,
  setAnomalyObservationHandler,
} from '../utils/anomalyObservation'
import { createDenominatorTracker, type DenominatorName } from './denominators'
import { convToken, roomToken, warmConversation, warmRoom } from './identity'
import { createEnvironmentReader, createForegroundShare } from './environment'
import { watchPerfMeasures, type PerfMeasureWatch } from './perfMeasures'
import { metricConstant } from './detectors/metricCounts'
import {
  clearAnomalySignalHandler,
  setAnomalySignalHandler,
  signalAnomaly,
} from '../utils/anomalySignal'
import type { ViewportKind } from '../utils/viewportAtBottom'
import { detectOS, platform } from '@/platform'
import { recordForSignal } from './detectors/signalRecords'
import { inboundReplyFacts, outboundFacts, type ElementLike } from './detectors/stanzaFacts'
import { createTrafficDetector, type TrafficDetector } from './detectors/xmppTraffic'
import { createArchiveMergeDetector } from './detectors/archiveMerge'
import { createPointerRegressionDetector } from './detectors/pointerRegression'
import { browserWorld, startDetectorTick, type DetectorTick } from './detectors/tick'
import { markAnomalyBuild } from './gate'
import { createRecorder, type Recorder } from './recorder'
import { createMemorySink } from './sinks/memory'
import { createPluginFsWriter, createTauriSink } from './sinks/tauri'
import { ID, METRIC, RECOUNT_METRIC, TAG, initTokenizer, isTokenizerReady, type Opaque } from './values'

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
let storeUnsubscribes: (() => void) | null = null
let clientUnsubscribes: (() => void) | null = null
let archiveMergeUnsubscribe: (() => void) | null = null
let trafficDetector: TrafficDetector | null = null
let perfWatch: PerfMeasureWatch | null = null

/**
 * What the traffic detector needs from the client.
 *
 * Structural rather than `XMPPClient`: this module is unit-tested without a client,
 * and a type naming the class would drag the SDK barrel into those tests.
 */
export interface TrafficClient {
  onApplicationStanzaOut(handler: (stanza: ElementLike) => void): () => void
  onStanza(handler: (stanza: ElementLike) => void): () => void
}

type ProbeWindow = Window & {
  __fluuxAnomalies?: string[]
  __fluuxAnomalyProbeSignal?: typeof signalAnomaly
}

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
 * Defaults to `false`, the conservative direction: an unknown window is treated as
 * possibly slid up, which suppresses `fab-at-live-edge` rather than reporting a FAB
 * that may be legitimately offering "jump to latest".
 */
function readWindowAtLiveEdge(kind: ViewportKind, id: string): boolean {
  const store = kind === 'room' ? roomStore : chatStore
  return store.getState().windowAtLiveEdge.get(id) ?? false
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

/**
 * Foreground-time accumulator for the environment block.
 *
 * Module scope, alongside the recorder, because it must span attachments: a
 * StrictMode remount would otherwise restart the window and report the session as
 * fully foreground however long it had been buried.
 */
function documentIsForeground(): boolean {
  return typeof document !== 'undefined'
    && document.visibilityState === 'visible'
    && (typeof document.hasFocus !== 'function' || document.hasFocus())
}

const foregroundShare = createForegroundShare(
  documentIsForeground(),
  Date.now(),
)

function runtime(): Recorder {
  if (!recorder) {
    recorder = createRecorder({
      // The web and demo builds have no filesystem; the sidecar is desktop-only.
      sink: platform().hasNativeLogFiles ? createTauriSink(createPluginFsWriter()) : createMemorySink(),
      now: () => Date.now(),
      build: `${__APP_VERSION__}+${__GIT_COMMIT__}`,
      sid: sessionId,
      env: createEnvironmentReader({
        os: detectOS(),
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        width: () => (typeof window === 'undefined' ? 0 : window.innerWidth),
        // One today. A seam rather than a literal so multi-account does not ship a
        // baseline silently mixing one-account and many-account sessions.
        accounts: () => 1,
        // Taken, not peeked: the share resets so each digest describes its own
        // window, which is what `windowMs` already promises about every other field.
        foreground: () => foregroundShare.take(Date.now()),
      }),
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
export function install(client?: TrafficClient): () => void {
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
      perfWatch?.drain()
      const input = recordForSignal(signal)
      if (input) rec.record(input)
    })
    const probeWindow = window as ProbeWindow
    if (Array.isArray(probeWindow.__fluuxAnomalies)) {
      probeWindow.__fluuxAnomalyProbeSignal = signalAnomaly
    }

    // Metrics arrive by NAME from the neutral seam, and become constants here. An
    // unmapped name is dropped rather than counted under a string: a counter name is
    // a closed registry, and inventing one from a free string is the hole it closes.
    setAnomalyMetricHandler((name, by) => {
      const metric = metricConstant(name)
      if (metric) rec.count(metric, by)
    })

    // Denominators are DERIVED from store state rather than signalled, so counting
    // them costs production no call sites at all.
    const DENOMINATORS: Readonly<Record<DenominatorName, Opaque>> = {
      'message.arrivals.conversation': METRIC.messageArrivals,
      'message.arrivals.room': METRIC.roomMessageArrivals,
      'room.switches': METRIC.roomSwitches,
    }
    // The crumb sink is the whole point of detecting these here rather than only
    // counting them: an anomaly record carries the last 50 crumbs, so a freeze or a
    // stuck badge arrives with the events that preceded it instead of bare numbers.
    const denominators = createDenominatorTracker(
      (name) => rec.count(DENOMINATORS[name], 1),
      (parts) => rec.crumb(parts),
    )
    // Warm the entity as it becomes active rather than on the next sampler tick.
    //
    // This does NOT rescue the crumb written in this same callback: the token is
    // frozen when the crumb is created, and the HMAC has not resolved by then. The
    // FIRST activation of an entity is therefore always `c:unresolved`, and nothing
    // can change that — the entity is unknown until it is first seen. What this buys
    // is everything after: the record written a second later, and every later
    // activation of the same entity, all name it properly instead of waiting up to a
    // full tick for the sampler to get there.
    const warmActive = (kind: 'room' | 'conversation', id: string | null): void => {
      if (!id || !isTokenizerReady()) return
      void (kind === 'room' ? warmRoom(id) : warmConversation(id)).catch(() => {
        // Reported by `recorder/entity-warm-failing`; a crumb must never throw.
      })
    }

    /**
     * Warm an entity at OBSERVATION time, not at record time.
     *
     * `tokenSync` resolves from cache or returns the unresolved sentinel and warms
     * in the background — which is enough for a repeating crumb but not for a
     * ONE-SHOT record: an unanswered IQ or a redundant query names its target once
     * and never again, and a record that says `c:unresolved` cannot be attributed
     * to anything. Every observation here precedes its record — a redundancy is
     * recorded on a later send, an unanswered IQ on a later sweep — so warming
     * when the entity is first SEEN is what makes the record nameable.
     *
     * Idempotent and deduplicated inside the tokenizer, so the steady-state cost
     * is a map lookup.
     */
    const warmEntity = (kind: 'room' | 'conversation', id: string): void => {
      if (!id || !isTokenizerReady()) return
      void (kind === 'room' ? warmRoom(id) : warmConversation(id)).catch(() => {
        // Reported by `recorder/entity-warm-failing`; observation must not throw.
      })
    }

    let activeEntity = readActiveConversation()
    let activeObservationQueued = false
    let storeObserversAttached = true
    const observeActiveEntity = (): void => {
      if (activeObservationQueued) return
      activeObservationQueued = true
      queueMicrotask(() => {
        activeObservationQueued = false
        if (!storeObserversAttached) return
        if (chatStore.getState().activationPending || roomStore.getState().activationPending) return

        const next = readActiveConversation()
        const changed = next?.kind !== activeEntity?.kind || next?.id !== activeEntity?.id
        if (changed && next) warmActive(next.kind, next.id)
        denominators.observeActive(next, activeEntity)
        activeEntity = next
      })
    }

    // Every read-pointer write, watched for the one direction it must never take.
    // The pointer and its generation are read in the SAME callback: a generation
    // learned later than the pointer it explains would turn an account switch into
    // a phantom regression.
    const pointerRegression = createPointerRegressionDetector({
      record: (input) => rec.record(input),
      token: (kind, id) => (kind === 'room' ? roomToken(id) : convToken(id)),
      isAhead,
    })

    /**
     * Scan the metadata map that just changed.
     *
     * Guarded on the map's identity by the caller: it is recreated only when
     * metadata actually changes, so message traffic — by far the most frequent
     * store event — costs one reference comparison.
     */
    const scanPointers = <T extends { readPointer?: Parameters<typeof isAhead>[0] }>(
      kind: 'chat' | 'room',
      nextMeta: ReadonlyMap<string, T>,
      prevMeta: ReadonlyMap<string, T>,
      generation: (id: string) => { store: number; entity: number },
    ): void => {
      for (const [id, meta] of nextMeta) {
        if (prevMeta.get(id) === meta) continue
        warmEntity(kind === 'room' ? 'room' : 'conversation', id)
        pointerRegression.observe({
          kind,
          id,
          pointer: meta.readPointer,
          generation: generation(id),
        })
      }
    }

    const seedPointers = <T extends { readPointer?: Parameters<typeof isAhead>[0] }>(
      kind: 'chat' | 'room',
      meta: ReadonlyMap<string, T>,
      generation: (id: string) => { store: number; entity: number },
    ): void => {
      for (const [id, value] of meta) {
        pointerRegression.observe({
          kind,
          id,
          pointer: value.readPointer,
          generation: generation(id),
        })
      }
    }

    seedPointers('chat', chatStore.getState().conversationMeta, chatReadStateGeneration)
    seedPointers('room', roomStore.getState().roomMeta, roomReadStateGeneration)

    const unsubChat = chatStore.subscribe((next, prev) => {
      denominators.observeArrivals(
        { lastArrivedMessage: next.lastArrivedMessage, isRoom: false },
        { lastArrivedMessage: prev.lastArrivedMessage, isRoom: false },
      )
      if (next.conversationMeta !== prev.conversationMeta) {
        scanPointers('chat', next.conversationMeta, prev.conversationMeta, chatReadStateGeneration)
      }
      observeActiveEntity()
    })
    const unsubRooms = roomStore.subscribe((next, prev) => {
      denominators.observeArrivals(
        { lastArrivedMessage: next.lastArrivedMessage, isRoom: true },
        { lastArrivedMessage: prev.lastArrivedMessage, isRoom: true },
      )
      if (next.roomMeta !== prev.roomMeta) {
        scanPointers('room', next.roomMeta, prev.roomMeta, roomReadStateGeneration)
      }
      observeActiveEntity()
    })
    storeUnsubscribes = () => {
      storeObserversAttached = false
      unsubChat()
      unsubRooms()
    }

    // The archive merge seam. Store-side, so it attaches with or without a client:
    // a merge can be driven by a cache rehydrate as well as by a live walk.
    const archiveMerge = createArchiveMergeDetector({
      record: (input) => rec.record(input),
      count: (key, by) => rec.count(key, by),
      token: (report) =>
        report.entityKind === 'room' ? roomToken(report.entityId) : convToken(report.entityId),
    })
    archiveMergeUnsubscribe = onArchiveMerge((report) => {
      warmEntity(report.entityKind === 'room' ? 'room' : 'conversation', report.entityId)
      archiveMerge.observe(report)
    })

    // The application IQ traffic detectors. Absent a client — a unit test, or a
    // harness that mounts the runtime on its own — nothing attaches and nothing is
    // reported, rather than a detector observing a half-wired session.
    if (client) {
      const traffic = createTrafficDetector({
        record: (input) => rec.record(input),
        token: (jid) => convToken(jid),
      })
      trafficDetector = traffic

      const offOut = client.onApplicationStanzaOut((stanza) => {
        const facts = outboundFacts(stanza)
        if (!facts) return
        warmEntity('conversation', facts.to)
        traffic.observeOut(facts, Date.now())
      })
      const offIn = client.onStanza((stanza) => {
        const facts = inboundReplyFacts(stanza)
        if (facts) traffic.observeIn(facts, Date.now())
      })
      // A connection boundary makes every pending request unanswerable through no
      // fault of the app, and re-querying disco after a reconnect is correct — the
      // server may not even be the same one. The connection store carries this;
      // the client's own lifecycle bus is internal to the SDK.
      const offConnection = connectionStore.subscribe((next, prev) => {
        if (next.status !== prev.status) traffic.reset()
      })
      clientUnsubscribes = () => {
        offOut()
        offIn()
        offConnection()
      }
    }

    // Ask the SDK to time its heaviest synchronous operations, and watch for the
    // slow ones. Off in every other build: the SDK ships this disabled, so a
    // consumer that never calls in pays nothing.
    perfWatch = watchPerfMeasures((parts) => rec.crumb(parts))
    setMeasurementEnabled(perfWatch !== null)

    // The timed detectors. Started here rather than at module scope so it shares the
    // refcount: a StrictMode remount must not leave two intervals sampling, which
    // would double every verdict and turn the duplicate into a phantom suppression.
    detectorTick = startDetectorTick({
      ...browserWorld(
        readActiveConversation,
        readUnreadCount,
        () => getStorageScopeJid() ?? '',
        readWindowAtLiveEdge,
      ),
      // The sampler is the only thing that can say the app was alive at a given
      // instant. Wall clock cannot: the WebView freezes timers while hidden, so a
      // suspended hour and an hour of use are indistinguishable afterwards.
      onSample: (now) => {
        foregroundShare.sample(now)
        // The sampler is the only thing that knows the app was alive at this
        // instant. Sweeping on a timer of its own would report every request in
        // flight when the WebView froze as unanswered.
        trafficDetector?.sweep(Date.now())
      },
    })

    // Raw measurements from the release-shipped scroll subsystem. Registered after
    // the tick exists, since it is the tick that holds the clock they need
    // confirming against.
    setAnomalyObservationHandler((observation) => {
      detectorTick?.observeRaw(observation)
    })

    digestTimer = setInterval(() => {
      foldRecountDeferrals(rec)
      rec.flushDigest(DIGEST_INTERVAL_MS)
    }, DIGEST_INTERVAL_MS)

    let lastForeground = documentIsForeground()
    const onForegroundBoundary = (event: Event) => {
      const visible = document.visibilityState === 'visible'
      const focused = event.type === 'focus'
        ? true
        : event.type === 'blur'
          ? false
          : typeof document.hasFocus !== 'function' || document.hasFocus()
      const foreground = visible && focused
      if (foreground !== lastForeground) {
        lastForeground = foreground
        foregroundShare.note(foreground, Date.now())
        rec.crumb([foreground ? TAG.focus : TAG.blur])
      }
      // A freeze reported just after a return to the foreground is a different event
      // from one during steady use — the WebView may have been resuming rather than
      // blocked — and only the crumb can tell them apart after the fact.
      // Best effort: the WebView gives no guarantee that asynchronous I/O completes
      // during teardown, so a missing trailing digest is normal and never a signal.
      if (!visible && event.type === 'visibilitychange') {
        foldRecountDeferrals(rec)
        rec.flushDigest(DIGEST_INTERVAL_MS)
      }
    }
    document.addEventListener('visibilitychange', onForegroundBoundary)
    window.addEventListener('focus', onForegroundBoundary)
    window.addEventListener('blur', onForegroundBoundary)
    detachListener = () => {
      document.removeEventListener('visibilitychange', onForegroundBoundary)
      window.removeEventListener('focus', onForegroundBoundary)
      window.removeEventListener('blur', onForegroundBoundary)
    }
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
    delete (window as ProbeWindow).__fluuxAnomalyProbeSignal
    clearAnomalyMetricHandler()
    storeUnsubscribes?.()
    storeUnsubscribes = null
    clientUnsubscribes?.()
    clientUnsubscribes = null
    archiveMergeUnsubscribe?.()
    archiveMergeUnsubscribe = null
    trafficDetector = null
    perfWatch?.stop()
    perfWatch = null
    setMeasurementEnabled(false)
    clearAnomalyObservationHandler()
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
  delete (window as ProbeWindow).__fluuxAnomalyProbeSignal
  clearAnomalyMetricHandler()
  storeUnsubscribes?.()
  storeUnsubscribes = null
  clientUnsubscribes?.()
  clientUnsubscribes = null
  archiveMergeUnsubscribe?.()
  archiveMergeUnsubscribe = null
  trafficDetector = null
  perfWatch?.stop()
  perfWatch = null
  setMeasurementEnabled(false)
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
