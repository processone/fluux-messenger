import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RenderLoopWarningBanner } from './RenderLoopBoundary'
import { detectRenderLoop, resetRenderLoopDetector } from '@/utils/renderLoopDetector'

// test-setup.ts mocks the detector globally; this suite needs the real counters.
vi.mock('@/utils/renderLoopDetector', async (importOriginal) => await importOriginal())

const WARNING_THRESHOLD = 30

/** Calls the detector during render, exactly as an instrumented component does. */
function Offender(): null {
  detectRenderLoop('Offender')
  return null
}

describe('RenderLoopWarningBanner', () => {
  let errors: string[]

  beforeEach(() => {
    resetRenderLoopDetector()
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not set state while the offending component is still rendering', () => {
    // Mount first so the banner's listener is attached before the warning fires.
    const { rerender } = render(
      <>
        <RenderLoopWarningBanner />
        <div />
      </>,
    )

    // Warm the window to one render short of the threshold.
    for (let i = 0; i < WARNING_THRESHOLD - 1; i++) detectRenderLoop('Offender')

    // This render is the one that trips the warning — the detector dispatches while
    // React is rendering Offender, so a listener that setStates violates React's rules.
    rerender(
      <>
        <RenderLoopWarningBanner />
        <Offender />
      </>,
    )

    expect(errors.filter((e) => e.includes('Cannot update a component'))).toEqual([])
  })

  it('still surfaces the warning to the user', async () => {
    const { rerender } = render(
      <>
        <RenderLoopWarningBanner />
        <div />
      </>,
    )

    for (let i = 0; i < WARNING_THRESHOLD - 1; i++) detectRenderLoop('Offender')
    rerender(
      <>
        <RenderLoopWarningBanner />
        <Offender />
      </>,
    )

    // Deferring the dispatch must not drop it — the banner still has to appear.
    await waitFor(() => {
      expect(screen.getByText(/Render loop warning/)).toBeInTheDocument()
    })
  })
})
