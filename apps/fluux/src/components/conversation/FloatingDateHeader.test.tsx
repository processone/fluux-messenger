// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { useRef, useEffect } from 'react'
import { FloatingDateHeader } from './FloatingDateHeader'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'dates.today' ? 'Today' : key === 'dates.yesterday' ? 'Yesterday' : key),
    i18n: { language: 'en' },
  }),
}))

// Test host: gives the component a real scroll element + a controllable getTopDate.
function Host({ getTopDate, fadeDelayMs }: { getTopDate: () => string | null; fadeDelayMs?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // expose the scroller so the test can dispatch scroll events
    ;(window as unknown as Record<string, unknown>).__scroller = ref.current
  }, [])
  return (
    <div style={{ position: 'relative' }}>
      <div ref={ref} data-scroller style={{ overflow: 'auto' }} />
      <FloatingDateHeader scrollerRef={ref} getTopDate={getTopDate} fadeDelayMs={fadeDelayMs} />
    </div>
  )
}

describe('FloatingDateHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Run the scroll-coalescing rAF synchronously. Whether fake timers also fake
    // rAF is environment-dependent under jsdom, which made the rAF-flush flaky;
    // a synchronous frame keeps the scroll compute deterministic. The fade-out
    // still rides the faked setTimeout below.
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
  })

  function scroll(container: HTMLElement) {
    const scroller = container.querySelector('[data-scroller]') as HTMLElement
    act(() => {
      fireEvent.scroll(scroller)
    })
  }

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

  it('fades out after the fade delay once scrolling stops', () => {
    const { container } = render(<Host getTopDate={() => '2026-06-28'} fadeDelayMs={1200} />)
    scroll(container)
    const overlay = container.querySelector('[data-floating-date]') as HTMLElement
    expect(overlay.className).toContain('opacity-100')

    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(overlay.className).toContain('opacity-0')
  })

  it('stays hidden when getTopDate returns null (topmost is a separator)', () => {
    const { container } = render(<Host getTopDate={() => null} />)
    scroll(container)
    const overlay = container.querySelector('[data-floating-date]') as HTMLElement
    expect(overlay.className).toContain('opacity-0')
  })
})
