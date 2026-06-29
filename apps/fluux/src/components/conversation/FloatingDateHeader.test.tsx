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
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  function scroll(container: HTMLElement) {
    const scroller = container.querySelector('[data-scroller]') as HTMLElement
    fireEvent.scroll(scroller)
    // flush the rAF-coalesced compute (vitest fake timers shim rAF as a ~16ms macrotask)
    act(() => {
      vi.advanceTimersByTime(20)
    })
  }

  it('shows the date pill on scroll with a non-null date', () => {
    const { container } = render(<Host getTopDate={() => '2026-06-28'} />)
    const overlay = container.querySelector('[data-floating-date]') as HTMLElement
    expect(overlay.className).toContain('opacity-0') // hidden at rest

    scroll(container)

    expect(overlay.className).toContain('opacity-100')
    // 2026-06-28 is yesterday relative to test run date (2026-06-29), so
    // formatDateHeader returns "Yesterday" — assert truthy as authorized by the brief.
    expect(container.querySelector('[data-floating-date-pill]')?.textContent).toBeTruthy()
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
