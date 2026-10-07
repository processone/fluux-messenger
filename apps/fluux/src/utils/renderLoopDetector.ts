/**
 * Render Loop Detector
 *
 * Detects runaway render loops and breaks them before the app freezes.
 * Works by tracking render frequency PER COMPONENT and throwing an error
 * for either a dense burst or a high rate sustained across consecutive windows.
 *
 * Enhanced with:
 * - Warning thresholds before throwing
 * - Stack trace capture for debugging
 * - Zustand selector tracking
 * - Detailed render history for post-mortem analysis
 */

// Track renders per component (not globally, to avoid false positives during heavy loading)
interface RenderEntry {
  timestamp: number
  stack?: string
}

interface ComponentState {
  renderCount: number
  windowStart: number
  loopRenderCount: number
  loopWindowStart: number
  error: Error | null
  hasWarned: boolean
  renderHistory: RenderEntry[]  // Last N renders for debugging
  // EWMA warnings smooth render intervals independently of the hard-break windows.
  emaRate: number          // exponentially-weighted moving average of renders/sec
  lastRenderTs: number     // timestamp of the previous render (0 = none yet)
  sustainedSince: number   // when emaRate first crossed the sustained threshold (0 = not sustained)
  lastSustainedWarn: number // last sustained-rate warning timestamp (cooldown)
  hardBreakSince: number | null
}

const componentStates = new Map<string, ComponentState>()

// See getRenderTally() for the counter contract.
const renderTally = new Map<string, number>()

// Track Zustand selector values for debugging
interface SelectorEntry {
  componentName: string
  selectorName: string
  value: unknown
  extra?: string
  timestamp: number
}
const selectorHistory: SelectorEntry[] = []
const MAX_SELECTOR_HISTORY = 100

// Configuration - per component thresholds
const MAX_RENDERS_PER_WINDOW = 200  // Max renders allowed per component in the loop window
const WARNING_THRESHOLD = 30        // Warn at this many renders (before throwing)
const TIME_WINDOW_MS = 1000         // Time window in milliseconds
// Reserve the immediate break for dense bursts; slower loops use the sustained limit.
const LOOP_TIME_WINDOW_MS = 10
const COOLDOWN_MS = 5000            // Cooldown before resetting after trigger
const MAX_RENDER_HISTORY = 20       // Keep last N renders per component for debugging
const WAKE_GRACE_PERIOD_MS = 3000   // Suppress warnings for this long after wake
const SYNC_GRACE_PERIOD_MS = 15000  // Raise hard-break thresholds after fresh connection (MAM + roster + room catch-up)
const SYNC_GRACE_THRESHOLD = 500    // Hard-break threshold during sync grace period
const INTERACTION_GRACE_MS = 1500   // Suppress warnings for this long after a keystroke (covers inter-key gaps; rolling)
// EWMA warnings expose persistent churn without throwing.
const SUSTAINED_RATE_PER_SEC = 40   // Warn above this many renders/sec...
const SUSTAINED_DURATION_MS = 3000  // ...when held for at least this long...
const SUSTAINED_COOLDOWN_MS = 10000 // ...at most once per this cooldown (so it never spams).
const EWMA_TAU_MS = 1500            // EWMA time constant (smooths instantaneous spikes)
// Evaluate completed TIME_WINDOW_MS windows; a rate at or below the threshold
// or a gap of at least TIME_WINDOW_MS resets the sustained duration. Initial
// catch-up can sustain higher rates, so windows overlapping sync grace use its limit.
const SUSTAINED_HARD_RATE_PER_SEC = 150
// Allow transient incoming-message bursts before treating a high rate as runaway.
const SUSTAINED_HARD_DURATION_MS = 5000

// Track if we're in a grace period (e.g., after wake from sleep)
let wakeGraceUntil = 0
// Track sync grace period (raised hard-break thresholds during initial connection sync)
let syncGraceUntil = 0
// Track interaction grace period (suppress warnings during active typing — a
// controlled input legitimately re-renders ~1-2× per keystroke, which fast typing
// or OS key-repeat pushes past the warning threshold without any actual loop).
let interactionGraceUntil = 0

// Injectable clock — defaults to Date.now. The sustained-rate detector needs
// multi-second timing, which is impractical to exercise with real time, so tests
// drive it via __setClock. Production always uses Date.now.
let nowFn: () => number = Date.now

/** Test seam: override the detector's clock. Reset by resetRenderLoopDetector(). @internal */
export function __setClock(fn: () => number): void {
  nowFn = fn
}

function getComponentState(componentName: string): ComponentState {
  let state = componentStates.get(componentName)
  if (!state) {
    state = {
      renderCount: 0, windowStart: nowFn(), loopRenderCount: 0, loopWindowStart: nowFn(),
      error: null, hasWarned: false, renderHistory: [],
      emaRate: 0, lastRenderTs: 0, sustainedSince: 0, lastSustainedWarn: 0,
      hardBreakSince: null,
    }
    componentStates.set(componentName, state)
  }
  return state
}

/**
 * Dispatch a detector event *after* the current render finishes.
 *
 * detectRenderLoop is called from a component's render phase, so dispatching
 * synchronously would run listeners mid-render. A listener that sets state — the
 * on-screen warning banner does — then trips React's "Cannot update a component
 * while rendering a different component" invariant, turning a diagnostic into a
 * second error that points at the innocent component being rendered.
 *
 * A macrotask defers past the whole render+commit cycle. queueMicrotask would not
 * be reliable: React can yield mid-render, which flushes microtasks before commit.
 * The detail payload is captured by value at call time, so the snapshot still
 * describes the render that tripped the threshold.
 */
function dispatchAfterRender(type: string, detail: unknown): void {
  if (typeof window === 'undefined') return
  setTimeout(() => {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail }))
    } catch {
      // CustomEvent not available — ignore
    }
  }, 0)
}

/**
 * Get a simplified stack trace for debugging.
 * Only captures in development mode to minimize overhead.
 */
function getCapturedStack(): string | undefined {
  if (process.env.NODE_ENV !== 'development') return undefined
  try {
    const stack = new Error().stack
    if (!stack) return undefined
    // Skip first 3 lines (Error, getCapturedStack, detectRenderLoop)
    // and filter to only show app files
    return stack
      .split('\n')
      .slice(3, 10)
      .filter(line => line.includes('/src/') && !line.includes('node_modules'))
      .join('\n')
  } catch {
    return undefined
  }
}

/**
 * Call this at the start of components that might be involved in render loops.
 * Throws an error if a render loop is detected, which can be caught by an ErrorBoundary.
 *
 * @param componentName - Name of the component for error message
 * @throws Error if render loop detected
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   detectRenderLoop('MyComponent')
 *   // ... rest of component
 * }
 * ```
 */
export function detectRenderLoop(componentName: string): void {
  // Cumulative tally (never resets on its own) — the perf-baseline signal.
  // Counted before the cooldown check so EVERY render is tallied. See
  // getRenderTally / resetRenderTally.
  renderTally.set(componentName, (renderTally.get(componentName) ?? 0) + 1)

  const state = getComponentState(componentName)

  // React retries a failed render before committing the error boundary. Keep
  // throwing during cooldown so that retry cannot resume the same runaway loop.
  if (state.error) throw state.error

  const now = nowFn()
  const windowMs = now - state.windowStart
  const windowRate = windowMs > 0 ? state.renderCount * 1000 / windowMs : 0
  let sustainedHardBreak = false

  // Reset window if enough time has passed
  if (windowMs >= TIME_WINDOW_MS) {
    const sustainedThreshold = state.windowStart < syncGraceUntil
      ? SYNC_GRACE_THRESHOLD : SUSTAINED_HARD_RATE_PER_SEC
    if (windowRate > sustainedThreshold && now - state.lastRenderTs < TIME_WINDOW_MS) {
      state.hardBreakSince ??= state.windowStart
    } else {
      state.hardBreakSince = null
    }
    sustainedHardBreak = state.hardBreakSince !== null && now - state.hardBreakSince >= SUSTAINED_HARD_DURATION_MS
    state.renderCount = 0
    state.windowStart = now
    state.hasWarned = false
    state.renderHistory = []
  }

  state.renderCount++
  if (now - state.loopWindowStart > LOOP_TIME_WINDOW_MS) {
    state.loopRenderCount = 0
    state.loopWindowStart = now
  }
  state.loopRenderCount++

  // Track render history for debugging
  state.renderHistory.push({
    timestamp: now,
    stack: getCapturedStack(),
  })
  // Keep only the last N entries
  if (state.renderHistory.length > MAX_RENDER_HISTORY) {
    state.renderHistory.shift()
  }

  // Warning threshold - log but don't throw
  // Skip warning during a grace period (expected high render frequency): after
  // sleep/wake, or while the user is actively typing into a controlled input.
  const inGracePeriod = now < wakeGraceUntil || now < interactionGraceUntil

  if (state.lastRenderTs !== 0) {
    const dt = now - state.lastRenderTs
    if (dt > 0) {
      const inst = 1000 / dt
      const alpha = 1 - Math.exp(-dt / EWMA_TAU_MS)
      state.emaRate += alpha * (inst - state.emaRate)
    }
  }
  state.lastRenderTs = now

  if (state.emaRate >= SUSTAINED_RATE_PER_SEC) {
    if (state.sustainedSince === 0) state.sustainedSince = now
    const heldFor = now - state.sustainedSince
    if (!inGracePeriod && heldFor >= SUSTAINED_DURATION_MS && now - state.lastSustainedWarn > SUSTAINED_COOLDOWN_MS) {
      state.lastSustainedWarn = now
      console.warn(
        `[RenderLoopDetector] Sustained render rate: ${componentName} averaging ` +
        `${state.emaRate.toFixed(0)}/sec for ${(heldFor / 1000).toFixed(1)}s ` +
        `(sub-threshold storm — likely a broken memo or a churning store map).`
      )
      dispatchAfterRender('fluux:render-loop-sustained', {
        componentName, rate: Math.round(state.emaRate), heldMs: heldFor,
      })
    }
  } else {
    state.sustainedSince = 0
  }

  if (state.renderCount === WARNING_THRESHOLD && !state.hasWarned && !inGracePeriod) {
    state.hasWarned = true
    console.warn(
      `[RenderLoopDetector] Warning: ${componentName} has rendered ${state.renderCount} times in ${TIME_WINDOW_MS}ms. ` +
      `This may indicate a render loop developing. Check recent state changes.`
    )
    // Log recent selector changes if any
    const recentSelectors = selectorHistory
      .filter(s => now - s.timestamp < 1000)
      .slice(-10)
    if (recentSelectors.length > 0) {
      console.warn('[RenderLoopDetector] Recent selector value changes:', recentSelectors)
    }
    // Dispatch a window event so the app can surface an on-screen warning
    // (useful on mobile where the console is hard to reach).
    dispatchAfterRender('fluux:render-loop-warning', {
      componentName, renderCount: state.renderCount, windowMs: TIME_WINDOW_MS,
    })
  }

  const effectiveThreshold = now < syncGraceUntil ? SYNC_GRACE_THRESHOLD : MAX_RENDERS_PER_WINDOW
  const heldMs = state.hardBreakSince === null ? 0 : now - state.hardBreakSince
  if (state.loopRenderCount > effectiveThreshold || sustainedHardBreak) {
    const reason = sustainedHardBreak
      ? `The app sustained ${windowRate.toFixed(0)} renders/sec for ${heldMs}ms. `
      : `The app rendered ${state.loopRenderCount} times in ${LOOP_TIME_WINDOW_MS}ms. `
    state.error = new Error(
      `Render loop detected in ${componentName}. ` + reason +
      `This usually indicates a bug in useEffect dependencies or state updates. ` +
      `Check console for detailed debug info.`
    )

    // Collect debugging information
    const debugInfo = {
      component: componentName,
      renderCount: state.loopRenderCount,
      windowMs: LOOP_TIME_WINDOW_MS,
      sustainedRate: windowRate,
      sustainedMs: heldMs,
      recentSelectors: selectorHistory.filter(s => now - s.timestamp < 2000).slice(-20),
      renderHistory: state.renderHistory,
    }

    // Log detailed debug info before throwing
    console.error(
      `[RenderLoopDetector] Detected render loop in ${componentName}. ` + reason + `Breaking the loop.`
    )
    console.error('[RenderLoopDetector] Debug info:', debugInfo)

    // Log render timestamps to show the pattern
    if (state.renderHistory.length > 1) {
      const intervals = state.renderHistory.slice(1).map((r, i) =>
        r.timestamp - state.renderHistory[i].timestamp
      )
      console.error(`[RenderLoopDetector] Render intervals (ms): ${intervals.join(', ')}`)
    }

    // Log stack traces from recent renders
    const stacksWithLines = state.renderHistory
      .filter(r => r.stack)
      .map(r => r.stack)
    if (stacksWithLines.length > 0) {
      console.error('[RenderLoopDetector] Recent render call stacks:', stacksWithLines.slice(-3))
    }

    // Reset after cooldown
    setTimeout(() => {
      state.error = null
      state.renderCount = 0
      state.windowStart = nowFn()
      state.loopRenderCount = 0
      state.loopWindowStart = state.windowStart
      state.hasWarned = false
      state.renderHistory = []
      state.emaRate = 0
      state.lastRenderTs = 0
      state.sustainedSince = 0
      state.lastSustainedWarn = 0
      state.hardBreakSince = null
    }, COOLDOWN_MS)

    throw state.error
  }
}

/**
 * Track a Zustand selector value change for debugging render loops.
 * Call this when a selector returns a new value.
 *
 * @param componentName - The component using this selector
 * @param selectorName - A descriptive name for the selector
 * @param value - The new value (will be stringified for logging)
 */
export function trackSelectorChange(componentName: string, selectorName: string, value: unknown, extra?: string): void {
  if (process.env.NODE_ENV !== 'development') return

  // Describe the value compactly: type + size hint for collections
  let describedValue: unknown
  if (value === null) {
    describedValue = 'null'
  } else if (Array.isArray(value)) {
    describedValue = `Array(${value.length})`
  } else if (value instanceof Map) {
    describedValue = `Map(${value.size})`
  } else if (value instanceof Set) {
    describedValue = `Set(${value.size})`
  } else if (typeof value === 'object') {
    describedValue = `[${typeof value}]`
  } else {
    describedValue = value
  }

  selectorHistory.push({
    componentName,
    selectorName,
    value: describedValue,
    extra,
    timestamp: nowFn(),
  })

  // Keep history bounded
  if (selectorHistory.length > MAX_SELECTOR_HISTORY) {
    selectorHistory.shift()
  }
}

/**
 * Get the current selector history for external analysis.
 */
export function getSelectorHistory(): SelectorEntry[] {
  return [...selectorHistory]
}

/**
 * Clear selector history (useful when starting a new debugging session).
 */
export function clearSelectorHistory(): void {
  selectorHistory.length = 0
}

/**
 * Log a summary of all tracked components and their render counts.
 * Useful for identifying which components are re-rendering frequently.
 */
export function logRenderSummary(): void {
  console.group('[RenderLoopDetector] Render Summary')
  const now = nowFn()
  for (const [name, state] of componentStates) {
    const age = now - state.windowStart
    if (state.renderCount > 0) {
      const rate = (state.renderCount / (age / 1000)).toFixed(1)
      console.log(`${name}: ${state.renderCount} renders in ${age}ms (${rate}/sec)`)
    }
  }
  console.groupEnd()
}

/**
 * Reset the detector state. Useful for testing or manual recovery.
 */
export function resetRenderLoopDetector(): void {
  componentStates.clear()
  renderTally.clear()
  wakeGraceUntil = 0
  syncGraceUntil = 0
  interactionGraceUntil = 0
  nowFn = Date.now
}

/**
 * Signal that a user-input event just occurred — a keystroke in the message
 * composer, or a scroll in the message list. Suppresses render-loop *warnings* for
 * a short rolling window so that legitimate input-driven re-renders don't read as a
 * loop: a controlled input re-renders ~1-2× per keystroke, and a fast scroll
 * re-windows the virtualized list ~once per frame. The error/throw threshold is NOT
 * affected — a genuine loop triggered while typing or scrolling still trips the hard
 * break, and the rolling window expires once the interaction stops so a sustained
 * post-interaction loop is still reported.
 */
export function notifyUserInput(): void {
  interactionGraceUntil = nowFn() + INTERACTION_GRACE_MS
}

/**
 * Start a grace period during which render loop warnings are suppressed.
 * Use after wake from sleep or other expected high-render-frequency events.
 * The error threshold is NOT suppressed - only warnings.
 */
export function startWakeGracePeriod(): void {
  wakeGraceUntil = nowFn() + WAKE_GRACE_PERIOD_MS
}

/**
 * Start a sync grace period during which dense and sustained hard-break
 * thresholds are raised. Warnings are suppressed, but both hard breaks remain
 * active and the sustained duration is unchanged. Use on fresh XMPP
 * connection when background sync will trigger many legitimate store updates
 * (MAM queries, roster load, room joins) that cause rapid component re-renders.
 */
export function startSyncGracePeriod(): void {
  syncGraceUntil = nowFn() + SYNC_GRACE_PERIOD_MS
  // Also suppress warnings during sync
  wakeGraceUntil = Math.max(wakeGraceUntil, syncGraceUntil)
}

/**
 * Cumulative render counts per component since the last resetRenderTally().
 * Unlike getRenderStats(), this never resets on its own, so it reliably captures
 * the magnitude of a flood that spans multiple seconds — the metric the perf
 * harness baselines against.
 *
 * NOTE: React StrictMode double-invokes renders in dev; divide by 2 for the
 * logical render count.
 */
export function getRenderTally(): Record<string, number> {
  return Object.fromEntries(renderTally)
}

/** Reset the cumulative render tally. Call at the start of a perf measurement. */
export function resetRenderTally(): void {
  renderTally.clear()
}

/**
 * Get current render statistics for debugging.
 * Counts use the resetting warning window during normal activity and the
 * dense-loop counter after a hard break, until recovery. windowMs is the elapsed
 * time since the corresponding window started. Use getRenderTally() for floods
 * spanning multiple windows.
 */
export function getRenderStats(): Record<string, { count: number; windowMs: number; triggered: boolean }> {
  const stats: Record<string, { count: number; windowMs: number; triggered: boolean }> = {}
  const now = nowFn()
  for (const [name, state] of componentStates) {
    stats[name] = {
      count: state.error ? state.loopRenderCount : state.renderCount,
      windowMs: now - (state.error ? state.loopWindowStart : state.windowStart),
      triggered: state.error !== null,
    }
  }
  return stats
}
