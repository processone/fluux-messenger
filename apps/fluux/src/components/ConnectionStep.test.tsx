import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ConnectionStepSlot, DEGRADED_STATUS_GRACE_MS, CATCH_UP_STEP_LIMIT_MS } from './ConnectionStep'
import { ChatHeader } from './ChatHeader'

// FLM-120: the sidebar chip is invisible when a conversation is open on a
// narrow screen, so the open conversation's header subtitle (and the list
// title on narrow screens) shows the same reconnection step, after the same
// 2 s grace, without ever changing the header height.

let mockStatus = 'online'
let mockIsVerifying = false
let mockIsCatchingUp = false
let mockReconnectTargetTime: number | null = null

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({ dragRegionProps: {} }),
  useAnchoredMenu: () => ({ triggerRef: { current: null }, menuRef: { current: null }, position: { x: 0, y: 0 } }),
  useClickOutside: () => {},
}))
vi.mock('@/hooks/useHasHover', () => ({ useHasHover: () => true, hasHover: () => true }))

vi.mock('@fluux/sdk/react', () => ({
  useRosterStore: (selector: (s: { contacts: Map<string, unknown> }) => unknown) =>
    selector({
      contacts: new Map([['emma@example.com', { jid: 'emma@example.com', name: 'Emma', presence: 'online', statusMessage: 'En ligne' }]]),
    }),
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({ status: mockStatus, isVerifying: mockIsVerifying, isCatchingUp: mockIsCatchingUp, reconnectTargetTime: mockReconnectTargetTime }),
  useContactTime: () => null,
  useLastActivity: vi.fn(),
}))
vi.mock('./Avatar', () => ({ Avatar: () => <div /> }))
vi.mock('@/utils/statusText', () => ({ getTranslatedStatusText: (c: { statusMessage: string }) => c.statusMessage }))

const renderHeader = () =>
  render(<ChatHeader name="Emma" type="chat" jid="emma@example.com" contact={{ jid: 'emma@example.com' } as never} />)

describe('connection step in the conversation header', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockStatus = 'online'
    mockIsVerifying = false
    mockIsCatchingUp = false
    mockReconnectTargetTime = null
  })
  afterEach(() => vi.useRealTimers())

  it('keeps the contact presence while online', () => {
    renderHeader()
    expect(screen.getByText('En ligne')).toBeTruthy()
    expect(screen.queryByTestId('connection-step')).toBeNull()
  })

  it('shows nothing before the grace delay, then the countdown instead of presence', () => {
    mockStatus = 'reconnecting'
    mockReconnectTargetTime = Date.now() + 5000
    renderHeader()
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 1) })
    expect(screen.queryByTestId('connection-step')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByTestId('connection-step').textContent).toContain('status.reconnectingStep|{"seconds":3}')
    expect(screen.queryByText('En ligne')).toBeNull()
  })

  it.each([
    ['connecting', false, 'status.connecting'],
    ['verifying', false, 'status.verifying'],
    ['online', true, 'status.verifying'],
  ])('shows the %s step (isVerifying=%s)', (status, isVerifying, key) => {
    mockStatus = status
    mockIsVerifying = isVerifying
    renderHeader()
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    expect(screen.getByTestId('connection-step').textContent).toContain(key)
  })

  it('returns to the presence line once online, header height class unchanged', () => {
    mockStatus = 'connecting'
    const { container, rerender } = renderHeader()
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    expect(container.querySelector('header')!.className).toContain('h-14')
    mockStatus = 'online'
    rerender(<ChatHeader name="Emma" type="chat" jid="emma@example.com" contact={{ jid: 'emma@example.com' } as never} />)
    expect(screen.getByText('En ligne')).toBeTruthy()
    expect(container.querySelector('header')!.className).toContain('h-14')
  })

  it('announces only the step, not the ticking countdown', () => {
    mockStatus = 'reconnecting'
    mockReconnectTargetTime = Date.now() + 9000
    renderHeader()
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    expect(screen.getByRole('status').textContent).toBe('status.reconnecting')
  })
})

describe('connection step review fixes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockStatus = 'online'
    mockIsVerifying = false
    mockIsCatchingUp = false
    mockReconnectTargetTime = null
  })
  afterEach(() => vi.useRealTimers())

  it('shows "Connecting..." for a running retry (status stays reconnecting, no countdown target)', () => {
    mockStatus = 'reconnecting'
    mockReconnectTargetTime = null
    renderHeader()
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    expect(screen.getByTestId('connection-step').textContent).toContain('status.connecting')
  })

  it('continues the outage grace when a header mounts mid-outage', () => {
    mockStatus = 'connecting'
    // The always-mounted sidebar title records the start of the outage.
    render(<ConnectionStepSlot narrowOnly>Messages</ConnectionStepSlot>)
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS + 500) })
    // User opens a chat now: no stale presence, the step is there on first paint.
    renderHeader()
    expect(screen.getAllByTestId('connection-step').length).toBe(2)
    expect(screen.queryByText('En ligne')).toBeNull()
  })

  it('mounts the live region empty before the step text arrives', () => {
    mockStatus = 'connecting'
    renderHeader()
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('')
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toBe('status.connecting')
  })
})

describe('list title', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockStatus = 'online'
    mockIsVerifying = false
  })
  afterEach(() => vi.useRealTimers())

  it('swaps in the step on narrow screens after the grace delay and keeps the title for md+', () => {
    mockStatus = 'connecting'
    render(<ConnectionStepSlot narrowOnly>Messages</ConnectionStepSlot>)
    expect(screen.queryByTestId('connection-step')).toBeNull()
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    expect(screen.getByTestId('connection-step').className).toContain('md:hidden')
    expect(screen.getByText('Messages').className).toContain('hidden md:inline')
  })
})

describe('"Updating..." while missed messages arrive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockStatus = 'online'
    mockIsVerifying = false
    mockIsCatchingUp = false
    mockReconnectTargetTime = null
  })
  afterEach(() => vi.useRealTimers())

  // A fresh element each time, so rerender re-reads the mocked store.
  const header = () => <ChatHeader name="Emma" type="chat" jid="emma@example.com" contact={{ jid: 'emma@example.com' } as never} />

  it('follows the reconnection, then gives way to presence when the catch-up ends', () => {
    mockStatus = 'reconnecting'
    const { rerender } = render(header())
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    mockStatus = 'online'
    mockIsCatchingUp = true
    rerender(header())
    expect(screen.getByTestId('connection-step').textContent).toContain('status.updating')
    expect(screen.queryByText('En ligne')).toBeNull()
    mockIsCatchingUp = false
    rerender(header())
    expect(screen.queryByTestId('connection-step')).toBeNull()
    expect(screen.getByText('En ligne')).toBeTruthy()
  })

  it('stops after the time limit even if the catch-up is still running', () => {
    mockIsCatchingUp = true
    render(header())
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    expect(screen.getByTestId('connection-step').textContent).toContain('status.updating')
    act(() => { vi.advanceTimersByTime(CATCH_UP_STEP_LIMIT_MS) })
    expect(screen.queryByTestId('connection-step')).toBeNull()
    expect(screen.getByText('En ligne')).toBeTruthy()
  })

  it('does not flash for a catch-up shorter than the grace delay', () => {
    mockIsCatchingUp = true
    const { rerender } = render(header())
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 1) })
    mockIsCatchingUp = false
    rerender(header())
    act(() => { vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS) })
    expect(screen.queryByTestId('connection-step')).toBeNull()
  })
})
