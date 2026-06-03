import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RenderLoopBoundary } from './RenderLoopBoundary'

/** Renders nothing but throws the given value during render. */
function Thrower({ value }: { value: unknown }): null {
  throw value
}

describe('RenderLoopBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('catches a non-Error throw without crashing the boundary itself', () => {
    // React re-logs caught errors to console.error; silence to keep output pristine.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // A child throwing a plain object must NOT escape the boundary. If
    // getDerivedStateFromError dereferences error.message on a non-Error,
    // it throws, React tears down the whole tree, and the user gets a
    // silent blank "freeze". The boundary must absorb it and show fallback.
    expect(() =>
      render(
        <RenderLoopBoundary>
          <Thrower value={{ shape: 'plain-object' }} />
        </RenderLoopBoundary>,
      ),
    ).not.toThrow()

    expect(screen.getByText('Something Went Wrong')).toBeInTheDocument()
  })

  it('still shows the render-loop UI for a render-loop Error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <RenderLoopBoundary>
        <Thrower value={new Error('Render loop detected in RoomView. 201 renders in 1000ms.')} />
      </RenderLoopBoundary>,
    )

    expect(screen.getByText('Render Loop Detected')).toBeInTheDocument()
  })
})
