import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import {
  StatusDisplay,
  StatusOrPresence,
  DEGRADED_STATUS_GRACE_MS,
} from './PresenceSelector'

// Issue #515 reverted the top-of-layout ConnectionBanner (it lived in normal
// flow, so every appearance reflowed the whole UI). The sidebar user-menu chip
// is again the single connection-incident surface: spinner, retry countdown,
// attempt number and inline cancel action — swapping one fixed-height line for
// another so the layout never moves. Degraded states only surface after a
// grace delay: fast silent SM resumptions show nothing at all.

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
  // StatusDisplay reads the latest persistent system alert; no alerts in these tests.
  useEventsStore: (selector: (s: { systemNotifications: unknown[] }) => unknown) =>
    selector({ systemNotifications: [] }),
}))

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({ client: { cancelReconnect } }),
  usePresence: () => ({
    presenceStatus: 'online',
    statusMessage: '',
    setPresence: vi.fn(),
  }),
}))

beforeEach(() => {
  mockStatus = 'online'
  mockIsVerifying = false
  mockReconnectTargetTime = null
  mockReconnectAttempt = 0
  cancelReconnect.mockClear()
})

describe('StatusDisplay (user-menu chip)', () => {
  it('shows the retry countdown and attempt number while reconnecting', () => {
    mockStatus = 'reconnecting'
    mockReconnectTargetTime = Date.now() + 5000
    mockReconnectAttempt = 3
    const { container } = render(<StatusDisplay status="reconnecting" />)

    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(container.textContent).toContain('status.reconnectingIn')
    expect(container.textContent).toContain('"attempt":3')
  })

  it('falls back to the plain reconnecting label without a scheduled retry', () => {
    mockStatus = 'reconnecting'
    const { container } = render(<StatusDisplay status="reconnecting" />)
    expect(container.textContent).toContain('status.reconnecting')
  })

  it('lets the user cancel a pending reconnection inline', () => {
    mockStatus = 'reconnecting'
    render(<StatusDisplay status="reconnecting" />)

    const cancel = screen.getByRole('button', { name: 'status.cancelReconnection' })
    cancel.click()
    expect(cancelReconnect).toHaveBeenCalledTimes(1)
  })

  it.each(['verifying', 'connecting'])('shows an animated %s line', (status) => {
    mockStatus = status
    const { container } = render(<StatusDisplay status={status} />)

    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(container.textContent).toContain(`status.${status}`)
    // No cancel action outside of reconnecting
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('still reports a terminal connection error', () => {
    mockStatus = 'error'
    render(<StatusDisplay status="error" />)
    expect(screen.getByText('status.connectionError')).toBeTruthy()
  })

  it('still reports disconnected', () => {
    mockStatus = 'disconnected'
    render(<StatusDisplay status="disconnected" />)
    expect(screen.getByText('status.disconnected')).toBeTruthy()
  })
})

describe('StatusOrPresence (degraded-state swap with grace)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the presence selector while online', () => {
    const { container } = render(<StatusOrPresence />)
    expect(container.textContent).toContain('presence.online')
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('keeps the presence selector during the grace window on a drop', () => {
    mockStatus = 'reconnecting'
    const { container } = render(<StatusOrPresence />)

    act(() => {
      vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 500)
    })
    expect(container.textContent).toContain('presence.online')
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('swaps to the status line after the grace delay', () => {
    mockStatus = 'reconnecting'
    const { container } = render(<StatusOrPresence />)

    act(() => {
      vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS)
    })
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(container.textContent).toContain('status.reconnecting')
  })

  it('never flashes when the connection recovers within the grace window', () => {
    mockStatus = 'reconnecting'
    const { container, rerender } = render(<StatusOrPresence />)

    act(() => {
      vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 500)
    })
    mockStatus = 'online'
    rerender(<StatusOrPresence />)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(container.textContent).toContain('presence.online')
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('restores the presence selector once back online', () => {
    mockStatus = 'reconnecting'
    const { container, rerender } = render(<StatusOrPresence />)
    act(() => {
      vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS)
    })
    expect(container.querySelector('.animate-spin')).not.toBeNull()

    mockStatus = 'online'
    rerender(<StatusOrPresence />)
    expect(container.textContent).toContain('presence.online')
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('surfaces a stalled post-wake verification while status stays online', () => {
    // connected.verifying machine sub-state: status === 'online' + isVerifying.
    mockStatus = 'online'
    mockIsVerifying = true
    const { container } = render(<StatusOrPresence />)

    expect(container.querySelector('.animate-spin')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS)
    })
    expect(container.textContent).toContain('status.verifying')
  })

  it('shows terminal states immediately, without grace', () => {
    mockStatus = 'error'
    const { container } = render(<StatusOrPresence />)
    expect(container.textContent).toContain('status.connectionError')
  })
})
