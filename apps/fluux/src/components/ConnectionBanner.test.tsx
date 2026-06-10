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
let mockIsVerifying = false
let mockReconnectTargetTime: number | null = null
let mockReconnectAttempt = 0
const cancelReconnect = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}|${JSON.stringify(opts)}` : key,
  }),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (
    selector: (s: {
      status: string
      isVerifying: boolean
      reconnectTargetTime: number | null
      reconnectAttempt: number
    }) => unknown
  ) =>
    selector({
      status: mockStatus,
      isVerifying: mockIsVerifying,
      reconnectTargetTime: mockReconnectTargetTime,
      reconnectAttempt: mockReconnectAttempt,
    }),
}))

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({ client: { cancelReconnect } }),
}))

describe('ConnectionBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockStatus = 'online'
    mockIsVerifying = false
    mockReconnectTargetTime = null
    mockReconnectAttempt = 0
    cancelReconnect.mockClear()
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

  // The banner is the SINGLE connection-incident surface: it absorbs the
  // countdown / attempt details and the cancel action that used to live in
  // the sidebar user-menu chip (now reduced to a static presence line).

  it('shows the retry countdown and attempt number when scheduled', () => {
    mockStatus = 'reconnecting'
    mockReconnectTargetTime = Date.now() + 5000
    mockReconnectAttempt = 3
    render(<ConnectionBanner />)

    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('status.reconnectingIn')
    expect(banner.textContent).toContain('"attempt":3')
  })

  it('falls back to the plain reconnecting label without a scheduled retry', () => {
    mockStatus = 'reconnecting'
    render(<ConnectionBanner />)
    expect(screen.getByRole('status').textContent).toContain('connectionBanner.reconnecting')
  })

  it('lets the user cancel a pending reconnection', () => {
    mockStatus = 'reconnecting'
    render(<ConnectionBanner />)

    const cancel = screen.getByRole('button', { name: 'status.cancelReconnection' })
    cancel.click()
    expect(cancelReconnect).toHaveBeenCalledTimes(1)
  })

  it('offers no cancel action outside of reconnecting', () => {
    mockStatus = 'connecting'
    render(<ConnectionBanner />)
    act(() => {
      vi.advanceTimersByTime(CONNECTING_BANNER_DELAY_MS)
    })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('surfaces a stalled post-wake verification while status stays online', () => {
    // connected.verifying machine sub-state: status === 'online' + isVerifying.
    // Same grace delay as connecting — brief verifications never flash.
    mockStatus = 'online'
    mockIsVerifying = true
    render(<ConnectionBanner />)

    expect(screen.queryByRole('status')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(CONNECTING_BANNER_DELAY_MS)
    })
    expect(screen.getByRole('status').textContent).toContain('connectionBanner.connecting')
  })
})
