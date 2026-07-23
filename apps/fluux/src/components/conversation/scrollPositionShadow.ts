import { isScrollDebugEnabled } from '@/utils/scrollDebug'
import type { DesiredPosition, PositioningPhase } from './scrollPositionModel'

export type ShadowPhaseCategory =
  | 'waiting'
  | 'positioning'
  | 'applied'
  | 'paused'
  | 'fallback'
  | 'idle'

export interface ShadowActualDecision {
  desired: DesiredPosition | null
  phase: ShadowPhaseCategory
}

export interface ScrollShadowDivergence {
  event: string
  conversationId: string
  generation: number | null
  expected: ShadowActualDecision
  actual: ShadowActualDecision
}

export interface ScrollShadowInstrumentationError {
  event: string
  conversationId: string
  message: string
}

export interface ScrollShadowSnapshot {
  decisionCount: number
  divergenceCount: number
  instrumentationErrorCount: number
  generationCount: number
  lastGeneration: number
  divergences: ScrollShadowDivergence[]
  instrumentationErrors: ScrollShadowInstrumentationError[]
}

const MAX_RETAINED_DIVERGENCES = 50
const MAX_RETAINED_INSTRUMENTATION_ERRORS = 50

const diagnostics: ScrollShadowSnapshot = {
  decisionCount: 0,
  divergenceCount: 0,
  instrumentationErrorCount: 0,
  generationCount: 0,
  lastGeneration: 0,
  divergences: [],
  instrumentationErrors: [],
}

function cloneSnapshot(): ScrollShadowSnapshot {
  return {
    ...diagnostics,
    divergences: diagnostics.divergences.map((item) => ({
      ...item,
      expected: { ...item.expected },
      actual: { ...item.actual },
    })),
    instrumentationErrors: diagnostics.instrumentationErrors.map((item) => ({
      ...item,
    })),
  }
}

export function resetScrollShadowDiagnostics(): void {
  diagnostics.decisionCount = 0
  diagnostics.divergenceCount = 0
  diagnostics.instrumentationErrorCount = 0
  diagnostics.generationCount = 0
  diagnostics.lastGeneration = 0
  diagnostics.divergences = []
  diagnostics.instrumentationErrors = []
}

export function getScrollShadowSnapshot(): ScrollShadowSnapshot {
  return cloneSnapshot()
}

/**
 * Shadow observation must never interfere with the live scroll path it watches. Keep the error
 * boundary here rather than scattering validator-specific guards through production call sites:
 * branded fact constructors are deliberately strict, while malformed/transient geometry is a
 * diagnostic failure that must be counted and skipped, not thrown through a React effect or event.
 */
export function runScrollShadowSafely<T>(input: {
  event: string
  conversationId: string
  observe: () => T
  fallback: T
}): T {
  try {
    return input.observe()
  } catch (error) {
    let message = 'unknown shadow instrumentation error'
    try {
      message = error instanceof Error ? error.message : String(error)
    } catch {
      // Keep the boundary no-throw even for hostile error values.
    }
    const instrumentationError: ScrollShadowInstrumentationError = {
      event: input.event,
      conversationId: input.conversationId,
      message,
    }
    diagnostics.instrumentationErrorCount += 1
    diagnostics.instrumentationErrors.push(instrumentationError)
    if (
      diagnostics.instrumentationErrors.length >
      MAX_RETAINED_INSTRUMENTATION_ERRORS
    ) {
      diagnostics.instrumentationErrors.shift()
    }
    if (isScrollDebugEnabled()) {
      try {
        console.warn('[ScrollShadow] instrumentation error', instrumentationError)
      } catch {
        // Console instrumentation must not punch through the shadow boundary either.
      }
    }
    return input.fallback
  }
}

export function recordShadowGeneration(generation: number): void {
  diagnostics.generationCount += 1
  if (generation <= diagnostics.lastGeneration) {
    recordShadowDivergence({
      event: 'generation-order',
      conversationId: '',
      generation,
      expected: { desired: null, phase: 'applied' },
      actual: { desired: null, phase: 'fallback' },
    })
    return
  }
  diagnostics.lastGeneration = generation
}

export function phaseCategory(phase: PositioningPhase | null): ShadowPhaseCategory {
  if (!phase) return 'idle'
  switch (phase.kind) {
    case 'resolving':
    case 'pending':
    case 'loading-around':
    case 'recentering-live-edge':
      return 'waiting'
    case 'mounting':
    case 'reconciling':
      return 'positioning'
    case 'position-applied':
    case 'settled':
      return 'applied'
    case 'paused-user-input':
      return 'paused'
    case 'unavailable':
      return 'fallback'
  }
}

function sameDesired(left: DesiredPosition | null, right: DesiredPosition | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function compareShadowDecision(input: {
  event: string
  conversationId: string
  generation: number | null
  expected: ShadowActualDecision
  actual: ShadowActualDecision
}): boolean {
  diagnostics.decisionCount += 1
  if (
    sameDesired(input.expected.desired, input.actual.desired) &&
    input.expected.phase === input.actual.phase
  ) {
    return true
  }
  recordShadowDivergence(input)
  return false
}

function recordShadowDivergence(divergence: ScrollShadowDivergence): void {
  diagnostics.divergenceCount += 1
  diagnostics.divergences.push(divergence)
  if (diagnostics.divergences.length > MAX_RETAINED_DIVERGENCES) {
    diagnostics.divergences.shift()
  }
  if (isScrollDebugEnabled()) {
    console.warn('[ScrollShadow] divergence', divergence)
  }
}

declare global {
  interface Window {
    __fluuxScrollShadow?: (reset?: boolean) => ScrollShadowSnapshot
  }
}

if (typeof window !== 'undefined') {
  window.__fluuxScrollShadow = (reset = false) => {
    if (reset) resetScrollShadowDiagnostics()
    return getScrollShadowSnapshot()
  }
}
