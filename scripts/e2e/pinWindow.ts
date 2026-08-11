/**
 * Frame-anchored driver for the bottom-pin window, shared by the scroll invariants.
 *
 * WHAT IT SOLVES
 *
 * Several invariants have to act *inside* the live-edge pin loop: they model an engine behaviour
 * (a row growing after paint, an engine firing a scroll event mid-pin) that only means anything
 * while the pin still owns scrollTop. The pin's lifetime is FRAME bound, not wall-clock bound —
 * it re-asserts for up to 60 frames and exits early after 8 consecutive quiet ones, so on a 60Hz
 * frame budget it can be over in ~130ms.
 *
 * Driving that from Node cannot be made reliable. The old shape was:
 *
 *     append the message   →   waitForSelector   →   evaluate(rAF → grow + dispatch scroll)
 *
 * Everything between the append and the growth is CDP round-trips whose cost is wall-clock and
 * load bound, while the window they must land in is counted in frames. On an idle machine the
 * growth landed a few frames into the pin; on a loaded one (a full suite, or `npm test` running
 * beside it) the 8 quiet frames elapsed first, the pin completed, and the growth landed after the
 * window had closed. The invariant then failed on its own premise — reported as the generic "the
 * bottom-pin loop never reported completion", which reads exactly like the send-stick defect it
 * guards. Measured on a loaded laptop: ~1 failure in 18 sequential runs, unrelated to the code
 * under test. Injecting a 1.2s delay before the growth reproduces it 100%.
 *
 * THE FIX: anchor the model to the pin's own frames, not to wall-clock. The growth script is armed
 * in the page BEFORE the stimulus and runs from the `PIN start` trace line, N rAFs in. The pin
 * always has 8+ frames of runway ahead of a model that needs 1-3, whatever the frame rate, so the
 * premise now holds by construction rather than by luck. Node only observes.
 *
 * PREMISE VS BAIL. The point of these invariants is that a pin which BAILS strands a send below
 * the fold, so nothing here may let a bail pass quietly. The probe therefore reports a precise
 * diagnosis string and the wait fails on any of them; what changes is only that "your model never
 * ran inside the window" and "the pin ran and ended badly" are no longer the same message. A
 * terminal completion — including `user-takeover`, the shape a genuine bail takes — is handed back
 * to the caller so its geometry assertions run and fail on the real symptom.
 */
import type { Page } from '@playwright/test'

/** Pin stimuli the invariants drive. Mirrors `LiveEdgeBrowserPorts.trigger`. */
export type PinTrigger = 'switch' | 'new-message'

/**
 * How a pin run ended. `superseded` is deliberately absent: it means a NEWER pin took ownership,
 * so the position is still being driven and the wait must continue to that run's own ending.
 */
export type PinOutcome = 'settled' | 'best-effort' | 'user-takeover'

/**
 * One modelled engine event, scheduled `afterFrames` rAFs after the previous step (or after
 * `PIN start` for the first). Frames, not milliseconds — that is the whole point of this module.
 */
export interface PinGrowthStep {
  /** Names the step in the premise diagnosis. */
  label: string
  /** rAF frames to wait before applying this step. 1 = the next frame. */
  afterFrames: number
  /** Model post-paint row growth: set the tracked row's `min-height` to this many px. */
  growRowToPx?: number
  /** Model an engine reporting a short scrollTop: add this delta (clamped at 0) before dispatching. */
  scrollTopDelta?: number
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

    /** Run `body` exactly `count` animation frames from now (count <= 0 runs it synchronously). */
    const afterFrames = (count: number, body: () => void) => {
      if (count <= 0) {
        body()
        return
      }
      let left = count
      const tick = () => {
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
        return
      }
      state.completion ??= record
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
    ;(window as any).__fluuxPinModelObserve = undefined
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
