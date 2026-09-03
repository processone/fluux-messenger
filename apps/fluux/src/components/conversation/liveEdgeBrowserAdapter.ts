import type { MessageVirtualizer } from './messageVirtualizer'
import { messageRowElements } from './messageRowIdentity'
import type {
  LiveEdgeExecutor,
  PositionExecutionLease,
  PositionFrameLoop,
} from './positioningController'
import type { LiveEdgeRequest } from './scrollPositionModel'
import { deriveReachabilityForDesired } from './scrollPositionFacts'
import {
  createPinRunTracker,
  readPinRepaintMode,
  shouldForceRepaint,
  type PinRepaintMode,
} from './pinBottomRun'
import { hasAnomalyObservationHandler, observeAnomaly } from '../../utils/anomalyObservation'
import {
  createPinRepaintBurst,
  pinBurstProbeLine,
  type PinRepaintBurst,
} from './pinRepaintBurst'
import { createRenderCostProbe, type RenderCostProbe } from '@/utils/renderCostProbe'
import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'

// While re-pinning, treat the list as not-yet-pinned whenever it sits more than this many pixels
// above the true bottom. The change-detection guard (re-pin only when scrollHeight moved) can miss
// the frame where the last row's measurement settles — coalesced height deltas, or a height delta
// captured into the previous frame's baseline — leaving the view a row short with no further change
// to react to. WebKit (the desktop WKWebView) hits this intermittently; Chromium masks it via
// overflow-anchor. Re-asserting on measured distance self-heals it: scrollToIndex(last,'end') is a
// no-op once truly pinned, so this converges and cannot oscillate. Sub-row tolerance keeps it from
// firing on harmless subpixel rounding.
export const BOTTOM_PIN_TOLERANCE = 4
// A pin run whose cumulative forced work (layout flushes + scroll writes + repaints) reaches this
// is worth one rate-limited [PinLoopProbe] line in fluux.log — it attributes the layoutPaint cost
// RenderCostProbe can only measure in aggregate. ~3 frame budgets; healthy runs stay far below.
const PIN_PROBE_THRESHOLD_MS = 50
// Pin triggers that represent NEW CONTENT landing at the bottom (as opposed to a user/layout event
// like a conversation switch, FAB tap, or viewport resize). Only these feed the repaint-burst
// coalescer: a rapid run of them — live chatter, a reaction storm, images decoding, or a reconnect
// flushing queued messages — is exactly the burst whose per-arrival forced repaints freeze WebKitGTK.
const CONTENT_ARRIVAL_TRIGGERS: ReadonlySet<string> = new Set([
  'new-message',
  'content-growth',
  'media-load',
  'row-growth',
  'mam-catchup-complete',
])

const distanceFromBottom = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight

export interface LiveEdgeWindowFacts {
  hasRows: boolean
  windowAtLiveEdge: boolean
}

export interface LiveEdgeBrowserAdapterOptions {
  getScroller: () => HTMLElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  getActiveConversationId: () => string
  /**
   * Window facts must come from a ref, not the render that built an executor. A live-edge executor
   * can outlive that render: the unread-marker fallback carries one from entry and promotes it from
   * inside a rAF frame, long after the cached slice landed. Describing the entry window there
   * reports `empty-window` for a window that has since filled, which parks the promoted execution in
   * `pending` with no frame loop — and no later stimulus revives it.
   */
  getWindowFacts: () => LiveEdgeWindowFacts
  /** Background MAM paging suppresses forced repaints; `undefined` means "not loading". */
  isLoadingOlder: () => boolean | undefined
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  setMeasuredAtBottom: (atLiveEdge: boolean) => void
  recordProgrammaticWrite: (conversationId: string) => void
  /** Injectable for tests; production reads `localStorage`. */
  readRepaintMode?: () => PinRepaintMode
  now?: () => number
  log?: (action: string, data?: Record<string, unknown>) => void
}

/**
 * Per-execution ports. Unlike the window facts above, these deliberately belong to the render that
 * built the executor: forward-window availability and the conversation whose bottom intent is being
 * recorded are structural facts of that request, not live geometry to re-read mid-run.
 */
export interface LiveEdgeBrowserPorts {
  /** Names the stimulus in diagnostics and selects burst/first-frame behaviour. */
  trigger: string
  /** Conversation entry historically animated the non-virtualized FAB/End write. */
  smoothNonVirtualized?: boolean
  rememberBottomIntent: () => void
  canRecenter: boolean
  recenterVersion?: string
  recenter?: LiveEdgeExecutor['recenter']
}

export interface EmergencyLiveEdgeWrite {
  smoothNonVirtualized?: boolean
  rememberBottomIntent: () => void
}

/**
 * Owns every bottom-specific browser mechanic: tail-layout flushes for late WebKit measurement, the
 * missed-frame distance correction, repaint-burst coalescing, background-MAM repaint suppression,
 * and the `overflowY` stale-paint repair. These are executor mechanics under the controller lease,
 * not a second positioning authority.
 *
 * The repaint burst and the run-cost probe are adapter-scoped, so a rapid run of superseding
 * content-arrival pins coalesces into one trailing repaint across executors.
 */
export class LiveEdgeBrowserAdapter {
  private burst: PinRepaintBurst | null = null
  private runProbe: RenderCostProbe | null = null

  constructor(private readonly options: LiveEdgeBrowserAdapterOptions) {}

  /** Drop repaint debt from a conversation being left so it cannot flush into the next one. */
  resetRepaintDebt(): void {
    this.burst?.reset()
  }

  /**
   * Last-resort one-shot when controller construction or arbitration fails. Keep this write behind
   * the same browser boundary as normal live-edge execution, but deliberately outside its repaint
   * and convergence machinery: without a current lease there is no safe loop to continue.
   */
  emergencyWrite(input: EmergencyLiveEdgeWrite): boolean {
    const scroller = this.options.getScroller()
    if (!scroller) return false
    const virtualizer = this.options.getVirtualizer()
    if (virtualizer && virtualizer.itemCount > 0) {
      virtualizer.scrollToIndex(virtualizer.itemCount - 1, { align: 'end' })
    } else if (input.smoothNonVirtualized) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    } else {
      scroller.scrollTop = scroller.scrollHeight
    }
    input.rememberBottomIntent()
    return true
  }

  createExecutor(ports: LiveEdgeBrowserPorts): LiveEdgeExecutor {
    const options = this.options
    const now = options.now ?? (() => performance.now())
    const burst = (this.burst ??= createPinRepaintBurst())
    const run = createPinRunTracker()
    const repaintMode = options.readRepaintMode
      ? options.readRepaintMode()
      : readPinRepaintMode(
          typeof window === 'undefined' ? undefined : window.localStorage,
        )
    let initialized = false
    let lastHeight = 0
    let wroteAny = false

    const flushTailLayout = () => {
      const scroller = options.getScroller()
      if (!scroller) return
      const started = now()
      scroller.getBoundingClientRect()
      const rows = messageRowElements(scroller)
      for (let i = Math.max(0, rows.length - 3); i < rows.length; i++) {
        rows[i].getBoundingClientRect()
      }
      run.addMs('flush', now() - started)
    }

    const forceRepaint = () => {
      const scroller = options.getScroller()
      if (!scroller) return
      const started = now()
      scroller.style.overflowY = 'hidden'
      void scroller.offsetHeight
      scroller.style.overflowY = ''
      run.addMs('repaint', now() - started)
    }

    const repaintCoalesced = (moved: boolean) => {
      if (!shouldForceRepaint(moved, repaintMode, options.isLoadingOlder())) return
      if (repaintMode === 'on-write' && burst.suppress(now())) {
        burst.markSuppressed()
        return
      }
      forceRepaint()
    }

    const writeVirtualizedPin = (): boolean => {
      const scroller = options.getScroller()
      const virtualizer = options.getVirtualizer()
      if (!scroller || !virtualizer || virtualizer.itemCount === 0) return false
      const before = scroller.scrollTop
      const started = now()
      virtualizer.scrollToIndex(virtualizer.itemCount - 1, { align: 'end' })
      run.addMs('scroll', now() - started)
      const moved = scroller.scrollTop !== before
      wroteAny ||= moved
      repaintCoalesced(moved)
      return moved
    }

    const flushOwedRepaint = () => {
      if (!burst.owed()) return
      forceRepaint()
      console.warn(pinBurstProbeLine(ports.trigger, burst.settle()))
    }

    return {
      reachability: () => {
        const facts = options.getWindowFacts()
        return deriveReachabilityForDesired({
          desired: { kind: 'live-edge', follow: true },
          hasRows: facts.hasRows,
          windowAtLiveEdge: facts.windowAtLiveEdge,
          virtualizer: options.getVirtualizer(),
          scroller: options.getScroller(),
          loadAround: 'unavailable',
          canRecenter: ports.canRecenter,
        })
      },
      recenterVersion: ports.recenterVersion,
      recenter: ports.recenter,
      beginLoop: (lease) => options.beginLoop(lease),
      positionFrame: (
        request: LiveEdgeRequest,
        lease: PositionExecutionLease,
      ) => {
        if (
          !lease.isCurrent() ||
          options.getActiveConversationId() !== request.conversationId
        ) {
          return { kind: 'unavailable' }
        }
        const scroller = options.getScroller()
        if (!scroller) return { kind: 'unavailable' }
        const virtualizer = options.getVirtualizer()

        if (!virtualizer) {
          const firstFrame = !initialized
          const before = scroller.scrollTop
          if (ports.smoothNonVirtualized && firstFrame) {
            scroller.scrollTo({
              top: scroller.scrollHeight,
              behavior: 'smooth',
            })
          } else {
            scroller.scrollTop = scroller.scrollHeight
          }
          initialized = true
          ports.rememberBottomIntent()
          return {
            kind: 'positioned',
            scrollTop: scroller.scrollTop,
            atLiveEdge: true,
            wrote: scroller.scrollTop !== before,
            // Conversation entry historically issued one deferred raw write after the immediate
            // layout-effect write. Keep that exact two-write edge-case repair under controller
            // scheduling; all other non-virtualized stimuli remain one-shot.
            reassert: firstFrame && ports.trigger === 'switch',
          }
        }
        if (virtualizer.itemCount === 0) return { kind: 'unavailable' }

        if (!initialized) {
          initialized = true
          if (CONTENT_ARRIVAL_TRIGGERS.has(ports.trigger)) {
            burst.note(now())
          }
          flushTailLayout()
          writeVirtualizedPin()
          lastHeight = scroller.scrollHeight
          ports.rememberBottomIntent()
          options.log?.('PIN start', {
            trigger: ports.trigger,
            itemCount: virtualizer.itemCount,
            distFromBottom: distanceFromBottom(scroller),
          })
          return {
            kind: 'positioned',
            scrollTop: scroller.scrollTop,
            atLiveEdge: distanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD,
            wrote: true,
            reassert: true,
          }
        }

        flushTailLayout()
        const height = scroller.scrollHeight
        const distance = distanceFromBottom(scroller)
        const needsWrite =
          height !== lastHeight || distance > BOTTOM_PIN_TOLERANCE
        if (needsWrite) {
          options.log?.('PIN re-assert', {
            distFromBottom: distance,
            heightChanged: height !== lastHeight,
          })
          lastHeight = height
          writeVirtualizedPin()
        }
        run.frame(needsWrite)
        return {
          kind: 'positioned',
          scrollTop: scroller.scrollTop,
          atLiveEdge: distanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD,
          wrote: needsWrite,
          reassert: true,
        }
      },
      complete: (request, outcome) => {
        if (options.getActiveConversationId() !== request.conversationId) return
        const scroller = options.getScroller()
        if (outcome === 'user-takeover' || outcome === 'superseded') {
          // Cancellation abandons this executor's paint obligation. Carrying the debt into a newer
          // generation could repaint after genuine user takeover or charge unrelated content.
          burst.reset()
        } else if (outcome === 'best-effort' && scroller) {
          flushTailLayout()
          if (burst.owed()) {
            flushOwedRepaint()
          } else if (
            shouldForceRepaint(wroteAny, repaintMode, options.isLoadingOlder())
          ) {
            forceRepaint()
          }
        } else if (outcome === 'settled') {
          flushOwedRepaint()
        }

        if (scroller) {
          const remaining = distanceFromBottom(scroller)
          options.setMeasuredAtBottom(remaining < AT_BOTTOM_THRESHOLD)
          options.recordProgrammaticWrite(request.conversationId)
          // A run that reports itself settled while the viewport is still beyond the
          // threshold it just used has not done what it was asked. Reported as the
          // measurement it already is, never as a verdict: one short settle is
          // ordinary (a smooth scroll still animating, a commit a frame behind), and
          // only a clock can tell that from a growth nothing absorbed. Reuses
          // `remaining` — this adds no layout read to the pin's forced work.
          if (outcome === 'settled' && hasAnomalyObservationHandler()) {
            observeAnomaly({
              kind: 'live-edge-pin-settled',
              conversationId: request.conversationId,
              distFromBottom: remaining,
              thresholdPx: AT_BOTTOM_THRESHOLD,
            })
          }
        }
        const probe = (this.runProbe ??= createRenderCostProbe({
          thresholdMs: PIN_PROBE_THRESHOLD_MS,
        }))
        if (probe.record(run.totalForcedMs(), now())) {
          console.warn(run.summaryLine(ports.trigger))
        }
        options.log?.('PIN completed', {
          trigger: ports.trigger,
          outcome,
          distFromBottom: scroller ? distanceFromBottom(scroller) : null,
        })
      },
    }
  }
}
