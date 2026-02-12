/**
 * Render Loop Detector
 *
 * Detects runaway render loops and breaks them before the app freezes.
 * Works by tracking render frequency PER COMPONENT and throwing an error
 * if too many renders happen in a short time window.
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
  hasTriggered: boolean
  hasWarned: boolean
  renderHistory: RenderEntry[]  // Last N renders for debugging
}

const componentStates = new Map<string, ComponentState>()

// Track Zustand selector values for debugging
interface SelectorEntry {
  componentName: string
  selectorName: string
  value: unknown
  timestamp: number
}
const selectorHistory: SelectorEntry[] = []
const MAX_SELECTOR_HISTORY = 50

// Configuration - per component thresholds
const MAX_RENDERS_PER_WINDOW = 200  // Max renders allowed per component in time window
const WARNING_THRESHOLD = 50        // Warn at this many renders (before throwing)
const TIME_WINDOW_MS = 1000         // Time window in milliseconds
const COOLDOWN_MS = 5000            // Cooldown before resetting after trigger
const MAX_RENDER_HISTORY = 20       // Keep last N renders per component for debugging
const WAKE_GRACE_PERIOD_MS = 3000   // Suppress warnings for this long after wake

// Track if we're in a grace period (e.g., after wake from sleep)
let wakeGraceUntil = 0

function getComponentState(componentName: string): ComponentState {
  let state = componentStates.get(componentName)
  if (!state) {
    state = { renderCount: 0, windowStart: Date.now(), hasTriggered: false, hasWarned: false, renderHistory: [] }
    componentStates.set(componentName, state)
  }
  return state
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
  const state = getComponentState(componentName)

  // Don't check during cooldown period
  if (state.hasTriggered) return

  const now = Date.now()

  // Reset window if enough time has passed
  if (now - state.windowStart > TIME_WINDOW_MS) {
    state.renderCount = 0
    state.windowStart = now
    state.hasWarned = false
    state.renderHistory = []
  }

  state.renderCount++

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
  // Skip warning during wake grace period (expected high render frequency after sleep)
  const inGracePeriod = now < wakeGraceUntil
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
  }

  if (state.renderCount > MAX_RENDERS_PER_WINDOW) {
    state.hasTriggered = true

    // Collect debugging information
    const debugInfo = {
      component: componentName,
      renderCount: state.renderCount,
      windowMs: TIME_WINDOW_MS,
      recentSelectors: selectorHistory.filter(s => now - s.timestamp < 2000).slice(-20),
      renderHistory: state.renderHistory,
    }

    // Log detailed debug info before throwing
    console.error(
      `[RenderLoopDetector] Detected render loop in ${componentName}. ` +
      `${state.renderCount} renders in ${TIME_WINDOW_MS}ms. Breaking the loop.`
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
      state.hasTriggered = false
      state.renderCount = 0
      state.windowStart = Date.now()
      state.hasWarned = false
      state.renderHistory = []
    }, COOLDOWN_MS)

    throw new Error(
      `Render loop detected in ${componentName}. ` +
      `The app rendered ${state.renderCount} times in ${TIME_WINDOW_MS}ms. ` +
      `This usually indicates a bug in useEffect dependencies or state updates. ` +
      `Check console for detailed debug info.`
    )
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
export function trackSelectorChange(componentName: string, selectorName: string, value: unknown): void {
  if (process.env.NODE_ENV !== 'development') return

  selectorHistory.push({
    componentName,
    selectorName,
    value: typeof value === 'object' ? `[${typeof value}]` : value,
    timestamp: Date.now(),
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
  const now = Date.now()
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
  wakeGraceUntil = 0
}

/**
 * Start a grace period during which render loop warnings are suppressed.
 * Use after wake from sleep or other expected high-render-frequency events.
 * The error threshold is NOT suppressed - only warnings.
 */
export function startWakeGracePeriod(): void {
  wakeGraceUntil = Date.now() + WAKE_GRACE_PERIOD_MS
}

/**
 * Get current render statistics for debugging.
 */
export function getRenderStats(): Record<string, { count: number; windowMs: number; triggered: boolean }> {
  const stats: Record<string, { count: number; windowMs: number; triggered: boolean }> = {}
  const now = Date.now()
  for (const [name, state] of componentStates) {
    stats[name] = {
      count: state.renderCount,
      windowMs: now - state.windowStart,
      triggered: state.hasTriggered,
    }
  }
  return stats
}
