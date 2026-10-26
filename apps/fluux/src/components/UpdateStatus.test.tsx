import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { connectionStore } from '@fluux/sdk/stores'
import { UpdateStatus } from './UpdateStatus'

vi.unmock('@fluux/sdk/react')
vi.unmock('@fluux/sdk/stores')

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, opts?: { target: string }) => opts ? `${key}: ${opts.target}` : key,
}) }))

// FLM-168 and the captain's single-owner requirement: views only read a scope.
describe('read-only scoped update display', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    connectionStore.getState().reset()
    connectionStore.getState().setStatus('online')
  })
  afterEach(() => { connectionStore.getState().reset(); vi.useRealTimers() })
  const begin = () => connectionStore.getState().beginUpdate(['chat:emma@fluux.chat', 'messages'])
  const chat = <UpdateStatus scope="chat:emma@fluux.chat" target="Emma">Online</UpdateStatus>

  it('preserves presence for other-target and unknown work', () => {
    connectionStore.getState().beginCatchUp()
    connectionStore.getState().beginUpdate(['room:team@conference.fluux.chat', 'rooms'])
    render(chat)
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByText('Online')).toBeTruthy()
    expect(screen.queryByTestId('update-text')).toBeNull()
    expect(screen.queryByTestId('update-icon')).toBeNull()
  })

  it('restores presence at 5 s, keeps the icon and announces start/end but not the phase change', () => {
    const end = begin()
    render(chat)
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('')
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByTestId('update-text').textContent).toBe('status.retrievingMessages')
    expect(region.textContent).toBe('status.retrievingFor: Emma')
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText('Online')).toBeTruthy()
    expect(screen.getByTestId('update-icon').querySelector('svg')!.classList.contains('animate-spin')).toBe(false)
    expect(region.textContent).toBe('status.retrievingFor: Emma')
    act(end)
    expect(screen.queryByTestId('update-icon')).toBeNull()
    expect(region.textContent).toBe('status.retrievalEndedFor: Emma')
  })

  it('keeps a list title, and explains its icon with tap or keyboard', () => {
    begin()
    render(<UpdateStatus scope="messages" target="Messages" list><h1>Messages</h1></UpdateStatus>)
    act(() => vi.advanceTimersByTime(2500))
    expect(screen.getByRole('heading').textContent).toBe('Messages')
    expect(screen.queryByTestId('update-text')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'status.retrievingFor: Messages' })
    fireEvent.click(trigger)
    expect(screen.getByRole('tooltip').textContent).toBe('status.retrievingFor: Messages')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(trigger.querySelector('button')).toBeNull()
  })

  it('does not restart time or create a timer when a view mounts, switches or unmounts', () => {
    const end = begin()
    act(() => vi.advanceTimersByTime(6000))
    const timers = vi.getTimerCount()
    const view = render(chat)
    expect(screen.getByTestId('update-icon')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(timers)
    view.rerender(<UpdateStatus scope="chat:other@fluux.chat" target="Other">Away</UpdateStatus>)
    expect(screen.queryByTestId('update-icon')).toBeNull()
    view.rerender(chat)
    expect(screen.getByTestId('update-icon')).toBeTruthy()
    view.unmount()
    expect(vi.getTimerCount()).toBe(timers)
    end()
  })

  // FLM-171 F1: navigation and wake verification must not replay completion
  // left in the owner's latest snapshot by an earlier retrieval episode.
  it.each([
    ['chat:other@fluux.chat', 'chat:emma@fluux.chat'],
    ['room:other@conference.fluux.chat', 'room:team@conference.fluux.chat'],
    ['messages', 'rooms'],
    ['rooms', 'messages'],
  ] as const)('does not announce stale completion when %s switches to %s', (away, completed) => {
    const end = connectionStore.getState().beginUpdate([completed])
    act(() => vi.advanceTimersByTime(2500))
    end()
    const view = render(<UpdateStatus scope={away} target="Away">Away</UpdateStatus>)
    view.rerender(<UpdateStatus scope={completed} target="Completed">Online</UpdateStatus>)
    expect(screen.getByRole('status').textContent).toBe('')
    view.rerender(<UpdateStatus target="Contacts">Contacts</UpdateStatus>)
    view.rerender(<UpdateStatus scope={completed} target="Completed">Online</UpdateStatus>)
    expect(screen.getByRole('status').textContent).toBe('')

    let nextEnd!: () => void
    act(() => { nextEnd = connectionStore.getState().beginUpdate([completed]) })
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByRole('status').textContent).toBe('status.retrievingFor: Completed')
    act(nextEnd)
    expect(screen.getByRole('status').textContent).toBe('status.retrievalEndedFor: Completed')
  })

  it.each([true, false])('does not replay completion on healthy return (ended before verification: %s)', endedBefore => {
    const end = begin()
    render(chat)
    act(() => vi.advanceTimersByTime(2500))
    if (endedBefore) act(end)
    act(() => connectionStore.getState().setIsVerifying(true))
    if (!endedBefore) act(end)
    act(() => vi.advanceTimersByTime(1000)) // shorter than the reconnect grace
    act(() => connectionStore.getState().setIsVerifying(false))
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('observes a new end after healthy return without replaying the existing start', () => {
    const end = begin()
    render(chat)
    act(() => vi.advanceTimersByTime(2500))
    act(() => connectionStore.getState().setIsVerifying(true))
    act(() => vi.advanceTimersByTime(1000))
    act(() => connectionStore.getState().setIsVerifying(false))
    expect(screen.getByRole('status').textContent).toBe('')
    act(end)
    expect(screen.getByRole('status').textContent).toBe('status.retrievalEndedFor: Emma')
  })

  it('does not announce an end when no active snapshot was committed to this view', () => {
    render(chat)
    act(() => {
      const end = begin()
      vi.advanceTimersByTime(2500)
      end()
    })
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('gives degraded connection/error states priority without announcing successful retrieval', () => {
    begin()
    render(chat)
    act(() => vi.advanceTimersByTime(2500))
    act(() => connectionStore.getState().setIsVerifying(true))
    expect(screen.queryByTestId('update-text')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
    act(() => connectionStore.getState().setStatus('error'))
    expect(screen.queryByTestId('update-icon')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
