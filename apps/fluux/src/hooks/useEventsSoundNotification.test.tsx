/**
 * The contact-request sound is for a request the user has not been alerted to.
 *
 * The events store is empty at every launch and the server redelivers pending
 * requests at login, so redelivery alone must not ring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { connectionStore } from '@fluux/sdk'

const { oscillatorStart, requests } = vi.hoisted(() => ({
  oscillatorStart: vi.fn(),
  requests: { current: [] as Array<{ from: string }> },
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    usePresence: () => ({ presenceStatus: 'online' }),
    useEvents: () => ({ subscriptionRequests: requests.current }),
  }
})

import { useEventsSoundNotification } from './useEventsSoundNotification'
import { useSettingsStore } from '@/stores/settingsStore'

const request = (from: string) => ({ from })

function mount() {
  return renderHook(() => useEventsSoundNotification())
}

function deliver(rerender: () => void, ...from: string[]) {
  requests.current = from.map(request)
  rerender()
}

describe('useEventsSoundNotification', () => {
  beforeEach(() => {
    localStorage.clear()
    oscillatorStart.mockClear()
    requests.current = []
    useSettingsStore.setState({ soundEnabled: true })
    connectionStore.setState({ jid: 'me@example.com/laptop' })

    const param = { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    window.AudioContext = function AudioContext(this: Function) {
      return {
        currentTime: 0,
        state: 'running',
        destination: {},
        createOscillator: () => ({ connect: vi.fn(), frequency: { value: 0 }, type: 'sine', start: oscillatorStart, stop: vi.fn() }),
        createGain: () => ({ connect: vi.fn(), gain: param }),
        resume: () => Promise.resolve(),
      }
    } as unknown as typeof AudioContext
  })

  afterEach(() => {
    connectionStore.setState({ jid: null })
  })

  it('plays once for a new request', () => {
    const { rerender } = mount()
    deliver(rerender, 'alice@example.com')
    expect(oscillatorStart).toHaveBeenCalled()
  })

  it('plays once when several requests arrive together', () => {
    const { rerender } = mount()
    deliver(rerender, 'alice@example.com', 'bob@example.com')
    expect(oscillatorStart).toHaveBeenCalledTimes(2) // the two tones of one sound
  })

  it('stays silent for a request already present when the hook mounts', () => {
    requests.current = [request('alice@example.com')]
    mount()
    expect(oscillatorStart).not.toHaveBeenCalled()
  })

  it('stays silent when the server redelivers a request the user was already alerted to', () => {
    const first = mount()
    deliver(first.rerender, 'alice@example.com')
    oscillatorStart.mockClear()
    first.unmount()

    // Next launch: the store is empty again, then the server redelivers.
    requests.current = []
    const second = mount()
    deliver(second.rerender, 'alice@example.com')

    expect(oscillatorStart).not.toHaveBeenCalled()
  })

  it('does not consume the banner record of the same request', () => {
    const { rerender } = mount()
    deliver(rerender, 'alice@example.com')
    expect(localStorage.getItem('fluux:notified-events:me@example.com')).toBeNull()
  })

  it('plays again for a new request from the same person once the earlier one was resolved', () => {
    const { rerender } = mount()
    deliver(rerender, 'alice@example.com')
    deliver(rerender)
    oscillatorStart.mockClear()

    deliver(rerender, 'alice@example.com')

    expect(oscillatorStart).toHaveBeenCalled()
  })

  it('stays silent when the sound option is off', () => {
    useSettingsStore.setState({ soundEnabled: false })
    const { rerender } = mount()
    deliver(rerender, 'alice@example.com')
    expect(oscillatorStart).not.toHaveBeenCalled()
  })
})
