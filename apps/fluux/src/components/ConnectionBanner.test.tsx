import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import {
  ConnectionBanner,
  CONNECTING_BANNER_DELAY_MS,
  CONNECTED_BANNER_HIDE_MS,
} from './ConnectionBanner'

// UX_REVIEW §4.1 — connection state must be visible at the top of the app:
// immediate banner on mid-session drops ('reconnecting'), delayed banner on
// slow connects ('connecting'/'verifying'), brief green confirmation once
// back online, and nothing at all for fast startups.

let mockStatus = 'online'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: mockStatus }),
}))

describe('ConnectionBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockStatus = 'online'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing while online', () => {
    const { container } = render(<ConnectionBanner />)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the reconnecting banner immediately on a mid-session drop', () => {
    mockStatus = 'reconnecting'
    render(<ConnectionBanner />)

    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('connectionBanner.reconnecting')
  })

  it('shows the connecting banner only after the grace delay', () => {
    mockStatus = 'connecting'
    render(<ConnectionBanner />)

    expect(screen.queryByRole('status')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(CONNECTING_BANNER_DELAY_MS)
    })
    expect(screen.getByRole('status').textContent).toContain('connectionBanner.connecting')
  })

  it('never flashes when a connect resolves before the grace delay', () => {
    mockStatus = 'connecting'
    const { rerender } = render(<ConnectionBanner />)

    act(() => {
      vi.advanceTimersByTime(CONNECTING_BANNER_DELAY_MS - 500)
    })
    mockStatus = 'online'
    rerender(<ConnectionBanner />)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('confirms recovery with a transient connected banner', () => {
    mockStatus = 'reconnecting'
    const { rerender } = render(<ConnectionBanner />)
    expect(screen.getByRole('status').textContent).toContain('connectionBanner.reconnecting')

    mockStatus = 'online'
    rerender(<ConnectionBanner />)
    expect(screen.getByRole('status').textContent).toContain('connectionBanner.connected')

    act(() => {
      vi.advanceTimersByTime(CONNECTED_BANNER_HIDE_MS)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('treats verifying like connecting', () => {
    mockStatus = 'verifying'
    render(<ConnectionBanner />)

    expect(screen.queryByRole('status')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(CONNECTING_BANNER_DELAY_MS)
    })
    expect(screen.getByRole('status').textContent).toContain('connectionBanner.connecting')
  })

  it('announces politely to screen readers', () => {
    mockStatus = 'reconnecting'
    render(<ConnectionBanner />)
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
  })
})
