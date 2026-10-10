/**
 * Frame-anchored driver for the bottom-pin window, shared by the scroll invariants.
 *
 * Arm the probe before the stimulus: Node round-trips and wall-clock delays cannot establish
 * that a modelled change lands inside a frame-counted pin. Steps run from the `PIN start` trace,
 * with frame delays relative to the preceding step. SDK updates count only when their commit
 * selector appears in the tracked row; the next step is scheduled after that DOM commit.
 *
 * A non-superseded completion with SDK steps remaining is a premise failure, including completion
 * during a commit's layout effects. Credit the current DOM commit before classifying completion,
 * then cancel queued delivery when the window closes early.
 *
 * A completion caused synchronously by a modelled scroll event is instead a terminal outcome,
 * including `user-takeover`. Remaining modelled events still run before the caller measures
 * geometry, so a genuine bail remains subject to the invariant's assertions.
 */
import type { Page } from '@playwright/test'

/** Pin stimuli the invariants drive. Mirrors `LiveEdgeBrowserPorts.trigger`. */
export type PinTrigger = 'switch' | 'new-message' | 'container-shrink'

/**
 * How a pin run ended. `superseded` is deliberately absent: it means a NEWER pin took ownership,
 * so the position is still being driven and the wait must continue to that run's own ending.
 */
export type PinOutcome = 'settled' | 'best-effort' | 'user-takeover'

/**
 * One modelled engine event or SDK update, scheduled `afterFrames` rAFs after the previous step (or after
 * `PIN start` for the first). Frames, not milliseconds — that is the whole point of this module.
 */
export interface PinGrowthStep {
  /** Names the step in the premise diagnosis. */
  label: string
  /** rAF frames to wait before applying this step. 1 = the next frame. */
  afterFrames: number
  /** Model post-paint row growth: set the tracked row's `min-height` to this many px. */
  growRowToPx?: number
  /** Model movement outside attributed application writes: add this delta (clamped at 0) before dispatching. */
  scrollTopDelta?: number
  /** Deliver a real store update, then wait for its DOM commit before scheduling the next step. */
  sdkUpdate?: { conversationId: string; messageId: string; updates: Record<string, unknown> }
  /** Required for SDK updates: an initially absent descendant selector proving the DOM commit. */
  commitSelector?: string
}

export interface PinModelSpec {
  trigger: PinTrigger
  /** The row a growth step resizes, and the row whose presence is recorded at latch time. */
  messageId?: string
  /** Empty (the default) simply waits out the pin without modelling anything. */
  steps?: PinGrowthStep[]
}

interface PinCompletionRecord {
  outcome: string
  distFromBottom: number | null
  afterSteps: number
}

/** Everything Node needs to tell a premise breach from a pin that ran and ended. */
interface PinModelState {
  trigger: string
  pinStarted: boolean
  /** Whether the tracked row was mounted when the pin latched — advisory, never a latch condition. */
  rowPresentAtPinStart: boolean | null
  reasserts: number
  supersededCount: number
  stepsRun: string[]
  stepsTotal: number
  /** Set when a step could not be applied at all (scroller or row gone). */
  failedStep: string | null
  /** The pin ended while the model still had steps left — the window closed under the model. */
  earlyCompletion: PinCompletionRecord | null
  /** The pin ended after the model finished. This is the outcome the caller asserts against. */
  completion: PinCompletionRecord | null
}

/**
 * Budget for a pin to start and finish once the stimulus has been applied. The wait it bounds is
 * frame-counted (60 re-assert frames at most), so this only has to cover those frames at a very
 * low frame rate — 30s is 60 frames at 2fps, far below any healthy runner. It is a hang ceiling,
 * not a convergence allowance: every premise breach below throws immediately instead of burning it,
 * and reaching it means no pin ever started or none ever ended, both of which are reported as such.
 */
const PIN_TERMINAL_TIMEOUT_MS = 30_000

/** Node-side poll interval while waiting for the in-page probe to reach a terminal state. */
const PIN_POLL_INTERVAL_MS = 50

/**
 * Arm the in-page probe. Call this BEFORE the stimulus that opens the pin — that ordering is what
 * removes the race, so it is not merely tidier.
 *
 * Requires the scroll-decision trace (`__fluuxScrollDebug(true)`): the probe reads the same
 * `[Scroll] PIN …` console lines the marker-reentry and resident-top invariants already read,
 * by wrapping `console.warn` in the page. The wrapper always forwards to the original, so
 * Playwright's own console events — and any other listener — are unaffected.
 */
async function armPinModel(page: Page, spec: PinModelSpec): Promise<void> {
  await page.evaluate((input) => {
    const steps = input.steps ?? []
    const state = {
      trigger: input.trigger,
      pinStarted: false,
      rowPresentAtPinStart: null as boolean | null,
      reasserts: 0,
      supersededCount: 0,
      stepsRun: [] as string[],
      stepsTotal: steps.length,
      failedStep: null as string | null,
      earlyCompletion: null as PinCompletionRecord | null,
      completion: null as PinCompletionRecord | null,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    w.__fluuxPinModel = state

    const scroller = (): HTMLElement | null =>
      document.querySelector('[data-message-list]')
    const row = (): HTMLElement | null => {
      if (!input.messageId) return null
      const s = scroller()
      return s
        ? s.querySelector(`[data-message-id="${CSS.escape(input.messageId)}"]`)
        : null
    }

    let disarmed = false
    /** Run `body` exactly `count` animation frames from now (count <= 0 runs it synchronously). */
    const afterFrames = (count: number, body: () => void) => {
      if (disarmed) return
      if (count <= 0) {
        body()
        return
      }
      let left = count
      const tick = () => {
        if (disarmed) return
        if (left <= 1) {
          body()
          return
        }
        left -= 1
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }

    /**
     * True only while a modelled event is being delivered. The pin can react to that very event and
     * complete synchronously inside `dispatchEvent` — a BAIL, which is exactly what these models
     * exist to provoke. Without this flag such a completion looks identical to the pin quietly
     * expiring between steps, and the genuine bail would be filed as a premise breach.
     *
     * The window is deliberately the synchronous dispatch and nothing more, so it credits only
     * completions this model actually caused. The cost is that a NON-final step which writes
     * `scrollTopDelta` also queues a native scroll echo the engine delivers later, outside the
     * window; if a future model needs that shape, widen this to the end of the step's frame rather
     * than let the echo's completion be reported as a premise breach.
     */
    let dispatching = false
    let pendingCommit: (() => boolean) | null = null
    let pendingObserver: MutationObserver | null = null

    const runStep = (index: number) => {
      const step = steps[index]
      if (!step) return
      afterFrames(step.afterFrames, () => {
        const s = scroller()
        const el = row()
        if (!s || (input.messageId && !el)) {
          state.failedStep = step.label
          return
        }
        if (step.sdkUpdate) {
          if (!step.commitSelector || el?.querySelector(step.commitSelector)) {
            state.failedStep = `${step.label}: commit selector missing or already present`
            return
          }
          const committed = () => {
            if (!el?.querySelector(step.commitSelector!)) return false
            pendingObserver?.disconnect()
            pendingObserver = null
            pendingCommit = null
            state.stepsRun.push(step.label)
            runStep(index + 1)
            return true
          }
          pendingCommit = committed
          pendingObserver = new MutationObserver(committed)
          pendingObserver.observe(s, { childList: true, subtree: true })
          w.__demoClient.emitSDK('chat:message-updated', step.sdkUpdate)
          return
        }
        if (typeof step.growRowToPx === 'number' && el) {
          el.style.minHeight = `${step.growRowToPx}px`
        }
        if (typeof step.scrollTopDelta === 'number') {
          s.scrollTop = Math.max(0, s.scrollTop + step.scrollTopDelta)
        }
        state.stepsRun.push(step.label)
        dispatching = true
        try {
          s.dispatchEvent(new Event('scroll', { bubbles: true }))
        } finally {
          dispatching = false
        }
        runStep(index + 1)
      })
    }

    w.__fluuxPinModelObserve = (args: unknown[]) => {
      const head = args[0]
      const data = args[1] as Record<string, unknown> | undefined
      if (typeof head !== 'string' || head.indexOf('[Scroll] PIN ') !== 0) return
      if (head === '[Scroll] PIN re-assert') {
        state.reasserts += 1
        return
      }
      if (!data || typeof data !== 'object') return
      if (data.trigger !== input.trigger) return

      if (head === '[Scroll] PIN start') {
        // Latch the FIRST matching pin after arming — the stimulus applied next. The row check is
        // recorded, never gating: losing the latch because a row had not committed yet would report
        // "no pin ever started", which is the opposite of what happened.
        if (state.pinStarted) return
        state.pinStarted = true
        state.rowPresentAtPinStart = input.messageId ? !!row() : null
        runStep(0)
        return
      }

      if (head !== '[Scroll] PIN completed') return
      if (!state.pinStarted) return
      // Layout effects can end a pin during the commit, before MutationObserver delivery.
      pendingCommit?.()
      // A newer pin now owns the position; this run ending says nothing about where we land.
      if (data.outcome === 'superseded') {
        state.supersededCount += 1
        return
      }
      const record: PinCompletionRecord = {
        outcome: String(data.outcome),
        distFromBottom:
          typeof data.distFromBottom === 'number' ? data.distFromBottom : null,
        afterSteps: state.stepsRun.length,
      }
      // Ending mid-model but NOT while a modelled event was in flight means the window closed on
      // its own — the model was never asked. That is the premise breach.
      if (state.stepsRun.length < state.stepsTotal && !dispatching) {
        state.earlyCompletion ??= record
        disarmed = true
        pendingObserver?.disconnect()
        pendingObserver = null
        pendingCommit = null
        return
      }
      state.completion ??= record
    }
    w.__fluuxPinModelDisconnect = () => {
      disarmed = true
      pendingObserver?.disconnect()
      pendingCommit = null
    }

    if (!w.__fluuxPinModelHooked) {
      w.__fluuxPinModelHooked = true
      const original = console.warn.bind(console)
      console.warn = (...args: unknown[]) => {
        try {
          w.__fluuxPinModelObserve?.(args)
        } catch {
          // The probe must never be able to break the trace it reads.
        }
        original(...args)
      }
    }
  }, spec)
}

/** Stop observing, so a later pin cannot mutate a state the caller has already read. */
async function disarmPinModel(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    w.__fluuxPinModelObserve = undefined
    w.__fluuxPinModelDisconnect?.()
  })
}

async function readPinModel(page: Page): Promise<PinModelState | null> {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => ((window as any).__fluuxPinModel as PinModelState | null) ?? null,
  )
}

type Diagnosis =
  | { kind: 'terminal'; completion: PinCompletionRecord }
  /** The model never ran inside the window — the invariant's premise, not its subject. */
  | { kind: 'premise'; message: string }
  /** Still in flight; the message is what a timeout would report. */
  | { kind: 'pending'; message: string }

function diagnose(state: PinModelState | null, spec: PinModelSpec): Diagnosis {
  if (!state) {
    return { kind: 'premise', message: 'the in-page pin probe was never armed' }
  }
  const model =
    `${state.stepsRun.length}/${state.stepsTotal} modelled steps (ran: ${
      state.stepsRun.join(', ') || 'none'
    })` +
    (state.rowPresentAtPinStart === null
      ? ''
      : `; the tracked row was ${state.rowPresentAtPinStart ? '' : 'NOT '}mounted at PIN start`)
  if (state.failedStep) {
    return {
      kind: 'premise',
      message: `modelled step "${state.failedStep}" could not be applied — the scroll container or the tracked row was gone; ${model}`,
    }
  }
  if (state.earlyCompletion) {
    return {
      kind: 'premise',
      message:
        `the ${spec.trigger} pin ended (outcome: ${state.earlyCompletion.outcome}, ` +
        `distFromBottom: ${state.earlyCompletion.distFromBottom}) after only ` +
        `${state.earlyCompletion.afterSteps}/${state.stepsTotal} modelled steps, so the growth this ` +
        'invariant models landed OUTSIDE the pin window it must land inside. This is a harness ' +
        `premise breach, not a send-stick regression: the pin was never asked the question. ${model}`,
    }
  }
  // Both must be true before the caller measures: the pin has ended AND the model has finished.
  // A pin that bails on the FIRST modelled event still has later steps queued, and reading geometry
  // between them would report a position the model was still moving.
  if (state.completion && state.stepsRun.length >= state.stepsTotal) {
    return { kind: 'terminal', completion: state.completion }
  }
  if (state.completion) {
    return {
      kind: 'pending',
      message: `the pin ended (outcome: ${state.completion.outcome}) on a modelled event, but the model never finished: ${model}`,
    }
  }
  if (!state.pinStarted) {
    return {
      kind: 'pending',
      message: `no "PIN start" for trigger "${spec.trigger}" ever arrived — the stimulus opened no bottom-pin window (scroll trace enabled?)`,
    }
  }
  if (state.stepsRun.length < state.stepsTotal) {
    return {
      kind: 'pending',
      message: `the pin started but the modelled growth never finished: ${model}`,
    }
  }
  return {
    kind: 'pending',
    message: `the ${spec.trigger} pin never reported completion after the modelled growth (${state.reasserts} re-asserts, ${state.supersededCount} supersessions)`,
  }
}

/**
 * Apply `stimulus`, then resolve once the pin it opened has FINISHED — settled, best-effort, or
 * yielded to takeover. Never waits for the test to pass: a pin that bails still reports completion,
 * so the caller's geometry assertions still run and still fail on a genuine bail. Returns the
 * outcome so those assertions can name it.
 *
 * Throws — with a message that says which — when the invariant's premise did not hold: the model
 * could not be applied, or the pin window closed before the model finished.
 */
export async function withPinWindow(
  page: Page,
  spec: PinModelSpec,
  stimulus: () => Promise<void>,
): Promise<PinOutcome> {
  await armPinModel(page, spec)
  try {
    await stimulus()
    const deadline = Date.now() + PIN_TERMINAL_TIMEOUT_MS
    for (;;) {
      const diagnosis = diagnose(await readPinModel(page), spec)
      if (diagnosis.kind === 'terminal') {
        return diagnosis.completion.outcome as PinOutcome
      }
      if (diagnosis.kind === 'premise') {
        throw new Error(`pin-window premise: ${diagnosis.message}`)
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `pin-window timeout after ${PIN_TERMINAL_TIMEOUT_MS}ms: ${diagnosis.message}`,
        )
      }
      await page.waitForTimeout(PIN_POLL_INTERVAL_MS)
    }
  } finally {
    await disarmPinModel(page).catch(() => {})
  }
}
