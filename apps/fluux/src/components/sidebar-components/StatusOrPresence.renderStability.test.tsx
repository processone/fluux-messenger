/**
 * Regression guards for the #515 revert (reconnect status back in the sidebar
 * chip), beyond the behavior tests in PresenceSelector.statusDisplay.test.tsx:
 *
 * 1. Render isolation — while the chip shows the presence selector, reconnect
 *    metadata churn (reconnectTargetTime/reconnectAttempt updating on every
 *    retry cycle) must NOT re-render the chip. #483 removed those
 *    subscriptions from Sidebar for exactly this reason; the revert keeps them
 *    confined to StatusDisplay, which only mounts while degraded.
 * 2. Grace-timer reset — a connection flapping in and out of 'reconnecting'
 *    gets a FULL fresh grace window on every drop; rapid flaps never surface.
 * 3. Live countdown — the per-second retry countdown actually ticks.
 *
 * Unlike the sibling test file (static mock variables + manual rerender),
 * these use a real subscribable store so the components re-render through
 * their own subscriptions — the thing being guarded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Profiler, useSyncExternalStore } from 'react'
import { render, act } from '@testing-library/react'
import { StatusOrPresence, DEGRADED_STATUS_GRACE_MS } from './PresenceSelector'

interface ConnState {
  status: string
  isVerifying: boolean
  reconnectTargetTime: number | null
  reconnectAttempt: number
}

const initialState: ConnState = {
  status: 'online',
  isVerifying: false,
  reconnectTargetTime: null,
  reconnectAttempt: 0,
}

// Minimal zustand-like store: setState notifies subscribers, and the
// useConnectionStore mock re-renders consumers only when their selected
// value changes (useSyncExternalStore snapshot equality).
const store = {
  state: { ...initialState },
  listeners: new Set<() => void>(),
  setState(partial: Partial<ConnState>) {
    store.state = { ...store.state, ...partial }
    store.listeners.forEach((l) => l())
  },
  subscribe(listener: () => void) {
    store.listeners.add(listener)
    return () => store.listeners.delete(listener)
  },
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}|${JSON.stringify(opts)}` : key,
  }),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: <T,>(selector: (s: ConnState) => T): T =>
    useSyncExternalStore(store.subscribe, () => selector(store.state)),
  // StatusDisplay reads the latest persistent system alert; none in these tests.
  useEventsStore: (selector: (s: { systemNotifications: unknown[] }) => unknown) =>
    selector({ systemNotifications: [] }),
}))

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({ client: { cancelReconnect: vi.fn() } }),
  usePresence: () => ({
    presenceStatus: 'online',
    statusMessage: '',
    setPresence: vi.fn(),
  }),
}))

beforeEach(() => {
  vi.useFakeTimers()
  store.state = { ...initialState }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('StatusOrPresence render isolation', () => {
  it('ignores reconnect-metadata churn while showing the presence selector', () => {
    let commits = 0
    const { container } = render(
      <Profiler id="chip" onRender={() => commits++}>
        <StatusOrPresence />
      </Profiler>
    )
    expect(container.textContent).toContain('presence.online')
    const baseline = commits

    // Retry-cycle churn: attempt/target update repeatedly while the machine
    // is in reconnecting.waiting elsewhere. The chip subscribes only to
    // status/isVerifying, so nothing here may re-render it.
    act(() => store.setState({ reconnectTargetTime: Date.now() + 5000, reconnectAttempt: 1 }))
    act(() => store.setState({ reconnectTargetTime: Date.now() + 10000, reconnectAttempt: 2 }))
    act(() => store.setState({ reconnectTargetTime: null, reconnectAttempt: 0 }))

    expect(commits).toBe(baseline)
    expect(container.textContent).toContain('presence.online')
  })
})

describe('StatusOrPresence grace-timer reset on flapping', () => {
  it('gives every drop a full fresh grace window', () => {
    const { container } = render(<StatusOrPresence />)

    // First drop: ride most of the grace window, then recover.
    act(() => store.setState({ status: 'reconnecting' }))
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 200))
    act(() => store.setState({ status: 'online' }))
    expect(container.textContent).toContain('presence.online')

    // Second drop right after: the previous timer must not carry over —
    // another near-full grace window still shows the presence selector.
    act(() => store.setState({ status: 'reconnecting' }))
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 200))
    expect(container.textContent).toContain('presence.online')

    // Only once the second drop outlasts its own grace does the status show.
    act(() => vi.advanceTimersByTime(200))
    expect(container.textContent).toContain('status.reconnecting')
  })
})

describe('StatusDisplay countdown', () => {
  it('ticks down once per second while a retry is scheduled', () => {
    act(() =>
      store.setState({
        status: 'reconnecting',
        reconnectTargetTime: Date.now() + DEGRADED_STATUS_GRACE_MS + 5000,
        reconnectAttempt: 2,
      })
    )
    const { container } = render(<StatusOrPresence />)
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS))

    expect(container.textContent).toContain('"seconds":5')
    expect(container.textContent).toContain('"attempt":2')

    act(() => vi.advanceTimersByTime(2000))
    expect(container.textContent).toContain('"seconds":3')

    // Saturates at 0 instead of going negative once the target passes.
    act(() => vi.advanceTimersByTime(10_000))
    expect(container.textContent).toContain('"seconds":0')
  })
})
