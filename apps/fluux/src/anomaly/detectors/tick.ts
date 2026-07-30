/**
 * The sampling clock for the timed detectors.
 *
 * `unread-survives-focus` and `fab-at-live-edge` both ask whether something held
 * CONTINUOUSLY, so both need a clock rather than an event. One interval drives both;
 * `jump-target-miss` is event-driven and does not appear here.
 *
 * Sampling is deliberately shallow: read the world, hand it to pure functions, forward
 * whatever they return. No decision lives in this file, so a wrong verdict is always a
 * bug in a detector with its own tests rather than in untested glue.
 *
 * Two of the readings deliberately bypass React:
 *
 * - the FAB is read from the DOM by its `data-fab` attribute, not from
 *   `showScrollToBottom`. The whole point of `fab-at-live-edge` is to catch that state
 *   going stale, and a detector reading the suspect value could never disagree with it.
 * - the viewport is measured through `utils/viewportScroller.ts`, for the same reason.
 *
 * @module Anomaly/Detectors/Tick
 */
import { signalAnomaly } from '../../utils/anomalySignal'
import { isViewportAtBottom, type ViewportKind } from '../../utils/viewportAtBottom'
import { measureViewport } from '../../utils/viewportScroller'
import { isTokenizerReady } from '../values'
import { warmConversation, warmRoom } from '../identity'
import { createFabAtLiveEdgeDetector } from './fabAtLiveEdge'
import { createUnreadSurvivesFocusDetector } from './unreadSurvivesFocus'

/** How often the world is sampled. */
const TICK_MS = 1000

/** The FAB's marker attribute, shared with the scroll e2e suite. */
const FAB_SELECTOR = '[data-fab="scroll-to-bottom"]'

/**
 * What the tick needs from the app.
 *
 * Injected rather than imported so the driver is testable without a store, a DOM or a
 * React tree. The production wiring supplies it in `install.ts`.
 */
export interface TickWorld {
  /** The conversation on screen, or null. */
  activeConversation(): { kind: ViewportKind; id: string } | null
  /** The canonical unread count for that conversation. */
  unreadCount(kind: ViewportKind, id: string): number
  /** Account / storage scope — the only generation-ish signal public before stage 5. */
  scopeKey(): string
  /** Is the window focused AND visible. */
  focused(): boolean
  /** Is the FAB actually offered to the user. */
  fabShown(): boolean
  /** Is the loaded message window at the tail of the archive. */
  windowAtLiveEdge(kind: ViewportKind, id: string): boolean
  /** Independently measured distance to the content bottom, or null. */
  distFromBottom(kind: ViewportKind, id: string): number | null
  now(): number
}

/** Read the real app. */
export function browserWorld(
  activeConversation: () => { kind: ViewportKind; id: string } | null,
  unreadCount: (kind: ViewportKind, id: string) => number,
  scopeKey: () => string,
  windowAtLiveEdge: (kind: ViewportKind, id: string) => boolean,
): TickWorld {
  return {
    activeConversation,
    unreadCount,
    scopeKey,
    windowAtLiveEdge,
    // `hasFocus` alone is not enough: a visible-but-unfocused window and a hidden one
    // are different states, and only the first means someone might be reading.
    focused: () => document.hasFocus() && document.visibilityState === 'visible',
    // Rendered is NOT shown. The button is always in the DOM; the wrapper carries
    // `inert={!fabVisible}` (`MessageList.tsx:966`), so presence alone reads `true`
    // forever — which made the detector fire on every healthy session until the
    // control test caught it. An inert ancestor means the affordance is withdrawn.
    // `querySelectorAll`, not `querySelector`: with more than one list in the tree the
    // first match may be a hidden one, and a single-element read would then report
    // "withdrawn" while a live FAB sits further down the document.
    fabShown: () =>
      Array.from(document.querySelectorAll(FAB_SELECTOR)).some(
        (fab) => fab.closest('[inert]') === null,
      ),
    distFromBottom: (kind, id) => measureViewport(kind, id)?.distFromBottom ?? null,
    now: () => Date.now(),
  }
}

export interface DetectorTick {
  /** Sample once and emit any verdicts. Exposed so a test need not wait a second. */
  sample(): void
  stop(): void
}

export function startDetectorTick(world: TickWorld, intervalMs = TICK_MS): DetectorTick {
  const unread = createUnreadSurvivesFocusDetector()
  const fab = createFabAtLiveEdgeDetector()

  /**
   * Which conversation the tokenizer has CONFIRMED warm.
   *
   * Not "which one we asked about": `warmToken` returns silently when the tokenizer
   * holds no key yet, so a latch taken on the call rather than on its result marks a
   * conversation warm that nothing warmed, and every later tick then skips it. The
   * episode keeps running with the entity unresolved — and the record that loses it is
   * the FIRST of the session, the one that says something just started going wrong.
   */
  let warmedFor: string | null = null
  /**
   * A warm already asked for and not yet resolved.
   *
   * Without it a slow HMAC would start a fresh warm on every tick, since `warmedFor`
   * is only set on resolution.
   */
  let warmInFlight: string | null = null

  function sample(): void {
    const now = world.now()
    const active = world.activeConversation()

    // Warm the token BEFORE any record can reference this conversation. `tokenSync`
    // cannot hash on demand — HMAC is async — so an unwarmed conversation serializes
    // as `c:unresolved`, which is safe but uncorrelatable: the record would name no
    // entity at all. Warming on change costs one HMAC per conversation opened.
    if (active) {
      const target = `${active.kind}:${active.id}`
      // Skip entirely until the tokenizer holds its key: warming before then is a
      // no-op, and the next tick retries. Latch only once the warm has RESOLVED, so a
      // rejected warm also retries rather than being recorded as done.
      if (warmedFor !== target && warmInFlight !== target && isTokenizerReady()) {
        warmInFlight = target
        void (active.kind === 'room' ? warmRoom(active.id) : warmConversation(active.id))
          .then(() => {
            warmedFor = target
          })
          .finally(() => {
            if (warmInFlight === target) warmInFlight = null
          })
      }
    }

    const unreadVerdict = unread.observe(
      {
        active,
        focused: world.focused(),
        viewportAtBottom: active ? isViewportAtBottom(active.kind, active.id) : false,
        unreadCount: active ? world.unreadCount(active.kind, active.id) : 0,
        scopeKey: world.scopeKey(),
      },
      now,
    )
    if (unreadVerdict) {
      signalAnomaly({
        name: 'read-state/unread-survives-focus',
        kind: unreadVerdict.active.kind,
        id: unreadVerdict.active.id,
        unreadCount: unreadVerdict.unreadCount,
        heldMs: unreadVerdict.heldMs,
      })
    }

    const fabVerdict = fab.observe(
      {
        fabShown: world.fabShown(),
        distFromBottom: active ? world.distFromBottom(active.kind, active.id) : null,
        windowAtLiveEdge: active ? world.windowAtLiveEdge(active.kind, active.id) : false,
      },
      now,
    )
    if (fabVerdict) {
      signalAnomaly({
        name: 'scroll/fab-at-live-edge',
        distFromBottom: fabVerdict.distFromBottom,
        heldMs: fabVerdict.heldMs,
      })
    }
  }

  const id = setInterval(sample, intervalMs)
  return {
    sample,
    stop: () => clearInterval(id),
  }
}
