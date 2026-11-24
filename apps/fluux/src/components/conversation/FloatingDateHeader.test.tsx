// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { useRef, useEffect } from 'react'
import { FloatingDateHeader, FLOATING_DATE_LIVE_EDGE_PX } from './FloatingDateHeader'
import { refreshCurrentDay } from '@/stores/currentDayStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'dates.today' ? 'Today' : key === 'dates.yesterday' ? 'Yesterday' : key),
    i18n: { language: 'en' },
  }),
}))

// Test host: gives the component a real scroll element + a controllable getTopDate.
function Host({ getTopDate, suppressed, onSelect }: { getTopDate: () => string | null; suppressed?: boolean; onSelect?: (date: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // expose the scroller so the test can dispatch scroll events
    ;(window as unknown as Record<string, unknown>).__scroller = ref.current
  }, [])
  return (
    <div data-conversation-thread="chat" style={{ position: 'relative' }}>
      <button type="button" data-header-overflow-trigger>Conversation actions</button>
      <div ref={ref} data-scroller style={{ overflow: 'auto' }} />
      <FloatingDateHeader scrollerRef={ref} getTopDate={getTopDate} suppressed={suppressed} onSelect={onSelect} />
    </div>
  )
}

describe('FloatingDateHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Run the scroll-coalescing rAF synchronously. Whether fake timers also fake
    // rAF is environment-dependent under jsdom, which made the rAF-flush flaky;
    // a synchronous frame keeps the scroll compute deterministic.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    refreshCurrentDay()
  })

  /** jsdom has no layout: give the scroller the geometry of a list `fromBottom` px above its end. */
  function scroll(container: HTMLElement, fromBottom = 500) {
    const scroller = container.querySelector('[data-scroller]') as HTMLElement
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 3000 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 3000 - 600 - fromBottom })
    act(() => {
      fireEvent.scroll(scroller)
    })
  }

  const overlayOf = (container: HTMLElement) => container.querySelector('[data-floating-date]') as HTMLElement

  it('shows the date pill on scroll with a non-null date', () => {
    vi.setSystemTime(new Date('2026-06-30T12:00:00'))
    const { container } = render(<Host getTopDate={() => '2026-06-28'} />)
    const overlay = container.querySelector('[data-floating-date]') as HTMLElement
    expect(overlay.className).toContain('opacity-0') // hidden at rest

    scroll(container)

    expect(overlay.className).toContain('opacity-100')
    // With the clock at 2026-06-30, 2026-06-28 is neither today nor yesterday,
    // so formatDateHeader returns the PPP locale form (e.g. "June 28, 2026") — assert the year.
    expect(container.querySelector('[data-floating-date-pill]')?.textContent).toContain('2026')
  })

  it('stays visible after scrolling stops while away from the newest messages', () => {
    const { container } = render(<Host getTopDate={() => '2026-06-28'} />)
    scroll(container)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(overlayOf(container).className).toContain('opacity-100')
    expect(overlayOf(container)).toHaveAttribute('aria-hidden', 'false')
  })

  it('hides at the newest messages', () => {
    const { container } = render(<Host getTopDate={() => '2026-06-28'} />)
    scroll(container)
    expect(overlayOf(container).className).toContain('opacity-100')

    scroll(container, 0)
    expect(overlayOf(container).className).toContain('opacity-0')
    expect(overlayOf(container)).toHaveAttribute('aria-hidden', 'true')
  })

  it('treats a position just above the bottom as the newest messages', () => {
    const { container } = render(<Host getTopDate={() => '2026-06-28'} />)
    scroll(container, FLOATING_DATE_LIVE_EDGE_PX)
    expect(overlayOf(container).className).toContain('opacity-0')

    scroll(container, FLOATING_DATE_LIVE_EDGE_PX + 1)
    expect(overlayOf(container).className).toContain('opacity-100')
  })

  it('yields to another overlay while suppressed', () => {
    const { container, rerender } = render(<Host getTopDate={() => '2026-06-28'} suppressed />)
    scroll(container)
    expect(overlayOf(container).className).toContain('opacity-0')

    rerender(<Host getTopDate={() => '2026-06-28'} suppressed={false} />)
    expect(overlayOf(container).className).toContain('opacity-100')
  })

  it('stays hidden when getTopDate returns null (topmost is a separator)', () => {
    const { container } = render(<Host getTopDate={() => null} />)
    scroll(container)
    const overlay = container.querySelector('[data-floating-date]') as HTMLElement
    expect(overlay.className).toContain('opacity-0')
  })

  it('updates its relative label after the local day changes', () => {
    vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
    refreshCurrentDay()

    const { container } = render(<Host getTopDate={() => '2026-02-10'} />)
    scroll(container)
    expect(container.querySelector('[data-floating-date-pill]')).toHaveTextContent('Today')

    vi.setSystemTime(new Date(2026, 1, 11, 9, 0))
    act(() => {
      refreshCurrentDay()
    })

    expect(container.querySelector('[data-floating-date-pill]')).toHaveTextContent('Yesterday')
  })

  // Approved day-pill accessibility plan: a disappearing focused pill leaves usable focus.
  it.each(['live edge', 'unread overlay', 'top separator'] as const)('returns focus to actions when hidden by %s', (reason) => {
    let date: string | null = '2026-06-28'
    const getTopDate = () => date
    const { container, rerender } = render(<Host getTopDate={getTopDate} onSelect={() => {}} />)
    scroll(container)
    const pill = container.querySelector('[data-floating-date-pill] button') as HTMLButtonElement
    act(() => { pill.focus() })
    expect(pill).toHaveFocus()
    if (reason === 'unread overlay') rerender(<Host getTopDate={getTopDate} onSelect={() => {}} suppressed />)
    else {
      if (reason === 'top separator') date = null
      scroll(container, reason === 'live edge' ? 0 : 500)
    }
    expect(container.querySelector('[data-header-overflow-trigger]')).toHaveFocus()
    expect(overlayOf(container)).toHaveAttribute('inert')
    expect(overlayOf(container)).toHaveAttribute('aria-hidden', 'true')
    expect(pill.tabIndex).toBe(-1)
  })

  it('opens jump to date at its day when clicked, and leaves the tab order while hidden', () => {
    vi.setSystemTime(new Date('2026-06-30T12:00:00'))
    const onSelect = vi.fn()
    const { container } = render(<Host getTopDate={() => '2026-06-28'} onSelect={onSelect} />)
    scroll(container)
    const pill = container.querySelector('[data-floating-date-pill] button') as HTMLButtonElement
    expect(pill.getAttribute('aria-label')).toBe('chat.jumpToDate.fromPill')
    expect(pill.tabIndex).toBe(0)
    fireEvent.click(pill)
    expect(onSelect).toHaveBeenCalledWith('2026-06-28')

    scroll(container, 0)
    expect(pill.tabIndex).toBe(-1)
  })
})
