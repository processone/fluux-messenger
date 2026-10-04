import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { setPlatformForTesting } from '@/platform'

const mockInvoke = vi.fn().mockResolvedValue(undefined)

type Listener = () => void
function store<T>(initial: T) {
  let state = initial
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set: (next: T) => {
      state = next
      listeners.forEach((listener) => listener())
    },
  }
}

const { rosterStore, roomStore } = vi.hoisted(() => ({
  rosterStore: { current: null as unknown },
  roomStore: { current: null as unknown },
}))

vi.mock('@fluux/sdk', () => ({
  get rosterStore() { return rosterStore.current },
  get roomStore() { return roomStore.current },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))

import { pushSenderNames, usePushSenderNames } from './usePushSenderNames'

type Named = { jid: string; name: string }
const roster = (...contacts: Named[]) => ({ contacts: new Map(contacts.map((c) => [c.jid, c])) })
const rooms = (...list: Named[]) => ({ rooms: new Map(list.map((r) => [r.jid, r])) })

describe('pushSenderNames', () => {
  it('maps contacts and rooms by JID, skipping blank names', () => {
    expect(pushSenderNames(
      [{ jid: 'alice@example.com', name: 'Alice' }, { jid: 'bob@example.com', name: ' ' }],
      [{ jid: 'team@muc.example.com', name: 'Team' }],
    )).toEqual({
      contacts: { 'alice@example.com': 'Alice' },
      rooms: { 'team@muc.example.com': 'Team' },
    })
  })
})

describe('usePushSenderNames', () => {
  let restorePlatform: () => void
  let rosterState: ReturnType<typeof store<ReturnType<typeof roster>>>
  let roomState: ReturnType<typeof store<ReturnType<typeof rooms>>>

  beforeEach(() => {
    vi.useFakeTimers()
    mockInvoke.mockClear()
    rosterState = store(roster())
    roomState = store(rooms())
    rosterStore.current = rosterState
    roomStore.current = roomState
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
  })

  afterEach(() => {
    restorePlatform()
    vi.useRealTimers()
  })

  const shared = () => mockInvoke.mock.calls.map(([, args]) => (args as { names: unknown }).names)

  it('shares the names once the stores settle', async () => {
    renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    roomState.set(rooms({ jid: 'team@muc.example.com', name: 'Team' }))

    await vi.advanceTimersByTimeAsync(1000)

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_sender_names', {
      names: { contacts: { 'alice@example.com': 'Alice' }, rooms: { 'team@muc.example.com': 'Team' } },
    })
  })

  it('writes again only when a name changes', async () => {
    renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    await vi.advanceTimersByTimeAsync(1000)

    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice Martin' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared()).toEqual([
      { contacts: { 'alice@example.com': 'Alice' }, rooms: {} },
      { contacts: { 'alice@example.com': 'Alice Martin' }, rooms: {} },
    ])
  })

  it('writes while the stores keep changing', async () => {
    renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    for (let i = 0; i < 5; i++) {
      roomState.set(rooms())
      await vi.advanceTimersByTimeAsync(400)
    }

    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('keeps the last session names while the stores are still empty, then clears them once emptied', async () => {
    renderHook(() => usePushSenderNames())
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockInvoke).not.toHaveBeenCalled()

    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    await vi.advanceTimersByTimeAsync(1000)
    rosterState.set(roster())
    await vi.advanceTimersByTimeAsync(1000)

    expect(shared()).toEqual([
      { contacts: { 'alice@example.com': 'Alice' }, rooms: {} },
      { contacts: {}, rooms: {} },
    ])
  })

  it('shares nothing without native push', async () => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))

    await vi.advanceTimersByTimeAsync(1000)

    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
