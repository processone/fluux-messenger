import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Component, type ReactNode } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { RegionErrorBoundary } from './RegionErrorBoundary'

let shouldThrow = true

function Boom({ error = new Error('boom') }: { error?: unknown }): ReactNode {
  if (shouldThrow) throw error
  return <p>recovered</p>
}

class OuterBoundary extends Component<{ children: ReactNode }, { caught: string | null }> {
  state = { caught: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { caught: error.message }
  }
  render() {
    return this.state.caught ? <p>outer caught: {this.state.caught}</p> : this.props.children
  }
}

describe('RegionErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('contains a crash to its region and keeps siblings rendered', () => {
    render(
      <div>
        <p>sibling</p>
        <RegionErrorBoundary region="main">
          <Boom />
        </RegionErrorBoundary>
      </div>,
    )
    expect(screen.getByText('sibling')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('errorBoundary.title')
  })

  it('renders the region again when the user retries', () => {
    render(
      <RegionErrorBoundary region="main">
        <Boom />
      </RegionErrorBoundary>,
    )
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: 'errorBoundary.retry' }))
    expect(screen.getByText('recovered')).toBeInTheDocument()
  })

  it('clears the error when the reset key changes', () => {
    const { rerender } = render(
      <RegionErrorBoundary region="main" resetKey="a">
        <Boom />
      </RegionErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    shouldThrow = false
    rerender(
      <RegionErrorBoundary region="main" resetKey="b">
        <Boom />
      </RegionErrorBoundary>,
    )
    expect(screen.getByText('recovered')).toBeInTheDocument()
  })

  it('keeps the fallback while the reset key is unchanged', () => {
    const { rerender } = render(
      <RegionErrorBoundary region="main" resetKey="a">
        <Boom />
      </RegionErrorBoundary>,
    )
    shouldThrow = false
    rerender(
      <RegionErrorBoundary region="main" resetKey="a">
        <Boom />
      </RegionErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('offers a way back when the region has one', () => {
    const onBack = vi.fn()
    render(
      <RegionErrorBoundary region="main" onBack={onBack}>
        <Boom />
      </RegionErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('renders a one-line placeholder for a message row', () => {
    render(
      <RegionErrorBoundary region="message" variant="message">
        <Boom />
      </RegionErrorBoundary>,
    )
    expect(screen.getByText('errorBoundary.message')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('accepts a thrown value that is not an Error', () => {
    render(
      <RegionErrorBoundary region="main">
        <Boom error="plain string" />
      </RegionErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('hands render-loop errors to the boundary above it', () => {
    render(
      <OuterBoundary>
        <RegionErrorBoundary region="main">
          <Boom error={new Error('Render loop detected in Foo. ')} />
        </RegionErrorBoundary>
      </OuterBoundary>,
    )
    expect(screen.getByText(/outer caught: Render loop detected/)).toBeInTheDocument()
  })

  it('reports the crash with its region name', () => {
    render(
      <RegionErrorBoundary region="sidebar" variant="panel">
        <Boom />
      </RegionErrorBoundary>,
    )
    expect(console.error).toHaveBeenCalledWith(
      '[RegionErrorBoundary:sidebar] Render failed:',
      expect.any(Error),
      expect.anything(),
    )
  })
})
