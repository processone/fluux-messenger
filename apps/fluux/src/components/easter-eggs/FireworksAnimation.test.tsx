// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, screen } from '@testing-library/react'
import { FireworksAnimation } from './FireworksAnimation'

describe('FireworksAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('auto-dismisses after duration plus fade-out', () => {
    const onComplete = vi.fn()
    render(<FireworksAnimation onComplete={onComplete} duration={1000} />)
    act(() => vi.advanceTimersByTime(1000))
    expect(onComplete).not.toHaveBeenCalled() // fade-out still running
    act(() => vi.advanceTimersByTime(500))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('dismisses early on click', () => {
    const onComplete = vi.fn()
    const { container } = render(<FireworksAnimation onComplete={onComplete} duration={60000} />)
    fireEvent.click(container.firstChild as Element)
    act(() => vi.advanceTimersByTime(500))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('does not fire onComplete twice when clicked and the timer then elapses', () => {
    const onComplete = vi.fn()
    const { container } = render(<FireworksAnimation onComplete={onComplete} duration={1000} />)
    fireEvent.click(container.firstChild as Element)
    act(() => vi.advanceTimersByTime(2000))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('renders a dismiss hint and is aria-hidden', () => {
    render(<FireworksAnimation onComplete={vi.fn()} />)
    expect(screen.getByText('Click anywhere to dismiss')).toBeInTheDocument()
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})
