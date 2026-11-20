import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ignoreStore } from '@fluux/sdk/stores'
import { useIgnoreSync } from './useIgnoreSync'

vi.unmock('@fluux/sdk/stores')

const ROOM = 'room@conference.example.com'
const spammer = { identifier: 'occ-spam', displayName: 'Spammer' }
const troll = { identifier: 'occ-troll', displayName: 'Troll' }

const connection = { status: 'online' as string }
const rooms = { activeRoomJid: ROOM as string | null }

const ignore = {
  fetchIgnoredUsersForRoom: vi.fn(),
  setIgnoredUsers: vi.fn(),
  removeIgnoredUsers: vi.fn(),
}

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useXMPP: () => ({ client: { ignore } }),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: typeof connection) => unknown) => selector(connection),
  useRoomStore: (selector: (s: typeof rooms) => unknown) => selector(rooms),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useIgnoreSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    connection.status = 'online'
    rooms.activeRoomJid = ROOM
    ignoreStore.getState().reset()
    ignore.fetchIgnoredUsersForRoom.mockReset()
    ignore.setIgnoredUsers.mockReset().mockResolvedValue(undefined)
    ignore.removeIgnoredUsers.mockReset().mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not publish before the room fetch has settled', async () => {
    const fetch = deferred<typeof spammer[]>()
    ignore.fetchIgnoredUsersForRoom.mockReturnValue(fetch.promise)
    renderHook(() => useIgnoreSync())

    act(() => { ignoreStore.getState().addIgnored(ROOM, troll) })
    await act(async () => { vi.advanceTimersByTime(1500) })

    expect(ignore.setIgnoredUsers).not.toHaveBeenCalled()
  })

  it('keeps and publishes an edit made while the fetch was in flight', async () => {
    const fetch = deferred<typeof spammer[]>()
    ignore.fetchIgnoredUsersForRoom.mockReturnValue(fetch.promise)
    renderHook(() => useIgnoreSync())

    act(() => { ignoreStore.getState().addIgnored(ROOM, troll) })
    await act(async () => { fetch.resolve([spammer]) })

    expect(ignoreStore.getState().getIgnoredForRoom(ROOM)).toEqual([troll])
    expect(ignore.setIgnoredUsers).toHaveBeenCalledWith(ROOM, [troll])
  })

  it('lets the server list win when nothing changed locally', async () => {
    ignore.fetchIgnoredUsersForRoom.mockResolvedValue([spammer])
    renderHook(() => useIgnoreSync())
    await act(async () => {})

    expect(ignoreStore.getState().getIgnoredForRoom(ROOM)).toEqual([spammer])
    expect(ignore.setIgnoredUsers).not.toHaveBeenCalled()
  })

  it('discards a fetch that resolves after a disconnect', async () => {
    const fetch = deferred<typeof spammer[]>()
    ignore.fetchIgnoredUsersForRoom.mockReturnValue(fetch.promise)
    const { rerender } = renderHook(() => useIgnoreSync())

    connection.status = 'disconnected'
    rerender()
    await act(async () => { fetch.resolve([spammer]) })

    expect(ignoreStore.getState().getIgnoredForRoom(ROOM)).toEqual([])
  })

  it('retries a failed publish on the next change and reports the failure', async () => {
    ignore.fetchIgnoredUsersForRoom.mockResolvedValue([])
    ignore.setIgnoredUsers.mockRejectedValueOnce(new Error('pep down'))
    renderHook(() => useIgnoreSync())
    await act(async () => {})

    act(() => { ignoreStore.getState().addIgnored(ROOM, spammer) })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(console.warn).toHaveBeenCalled()

    act(() => { ignoreStore.getState().addIgnored(ROOM, troll) })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(ignore.setIgnoredUsers).toHaveBeenLastCalledWith(ROOM, [spammer, troll])
    expect(ignore.setIgnoredUsers).toHaveBeenCalledTimes(2)
  })
})
