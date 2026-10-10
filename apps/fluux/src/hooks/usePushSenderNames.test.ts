import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createHash } from 'node:crypto'
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

const { rosterStore, roomStore, connectionStore } = vi.hoisted(() => ({
  rosterStore: { current: null as unknown },
  roomStore: { current: null as unknown },
  connectionStore: { current: null as unknown },
}))

vi.mock('@fluux/sdk', () => ({
  get rosterStore() { return rosterStore.current },
  get roomStore() { return roomStore.current },
  get connectionStore() { return connectionStore.current },
}))

vi.mock('@/platform/ios/shareSuggestions', () => ({ startIOSShareSuggestions: () => () => {} }))
vi.mock('@/platform/ios/notificationSounds', () => ({ startIOSNotificationSounds: () => () => {} }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))

import { pushSenderNames, usePushSenderNames } from './usePushSenderNames'

type Named = { jid: string; name: string; avatar?: string; avatarHash?: string }
const roster = (...contacts: Named[]) => ({ accountJid: 'me@example.com', isLoaded: true, contacts: new Map(contacts.map((c) => [c.jid, c])) })
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
  let connectionState: ReturnType<typeof store<{ jid: string | null }>>
  let restorePlatform: () => void
  let rosterState: ReturnType<typeof store<ReturnType<typeof roster>>>
  let roomState: ReturnType<typeof store<ReturnType<typeof rooms>>>

  beforeEach(() => {
    vi.useFakeTimers()
    mockInvoke.mockClear()
    mockInvoke.mockResolvedValue({ written: true })
    rosterState = store(roster())
    roomState = store(rooms())
    rosterStore.current = rosterState
    roomStore.current = roomState
    connectionState = store({ jid: 'me@example.com/phone' as string | null })
    connectionStore.current = connectionState
    vi.stubGlobal('crypto', { subtle: { digest: async (algorithm: string, bytes: ArrayBuffer) =>
      Uint8Array.from(createHash(algorithm.toLowerCase().replace('-', '')).update(new Uint8Array(bytes)).digest()).buffer,
    } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: async () => ({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) }))
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
  })

  afterEach(() => {
    restorePlatform()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const shared = () => mockInvoke.mock.calls.filter(([command]) => command === 'plugin:push|set_sender_names').map(([, args]) => (args as { names: unknown }).names)

  it('shares the names once the stores settle', async () => {
    renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    roomState.set(rooms({ jid: 'team@muc.example.com', name: 'Team' }))

    await vi.advanceTimersByTimeAsync(1000)

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_sender_names', {
      names: { account: 'me@example.com', avatars: {}, contacts: { 'alice@example.com': 'Alice' }, rooms: { 'team@muc.example.com': 'Team' } },
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
      { account: 'me@example.com', avatars: {}, contacts: { 'alice@example.com': 'Alice' }, rooms: {} },
      { account: 'me@example.com', avatars: {}, contacts: { 'alice@example.com': 'Alice Martin' }, rooms: {} },
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

  it('preserves only an uninitialized snapshot and clears on an empty roster response', async () => {
    rosterState.set({ ...roster(), isLoaded: false })
    const hook = renderHook(() => usePushSenderNames())
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared()).toEqual([{ account: 'me@example.com', preserveIfEmpty: true, avatars: {}, contacts: {}, rooms: {} }])

    rosterState.set(roster())
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared().at(-1)).toEqual({ account: 'me@example.com', avatars: {}, contacts: {}, rooms: {} })
    expect(shared()).toHaveLength(2)

    hook.unmount()
    renderHook(() => usePushSenderNames())
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared().at(-1)).not.toHaveProperty('preserveIfEmpty')
  })

  it('clears when the empty roster response arrives before the first write', async () => {
    rosterState.set({ ...roster(), isLoaded: false })
    renderHook(() => usePushSenderNames())
    rosterState.set(roster())
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared()).toEqual([{ account: 'me@example.com', avatars: {}, contacts: {}, rooms: {} }])
  })

  it('publishes an empty snapshot for an authenticated empty roster and removes deleted contacts', async () => {
    renderHook(() => usePushSenderNames())
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared()).toEqual([{ account: 'me@example.com', avatars: {}, contacts: {}, rooms: {} }])
    mockInvoke.mockClear()

    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    await vi.advanceTimersByTimeAsync(1000)
    rosterState.set(roster())
    await vi.advanceTimersByTimeAsync(1000)

    expect(shared()).toEqual([
      { account: 'me@example.com', avatars: {}, contacts: { 'alice@example.com': 'Alice' }, rooms: {} },
      { account: 'me@example.com', avatars: {}, contacts: {}, rooms: {} },
    ])
  })

  it('refreshes the mirror when an avatar changes without a name change', async () => {
    renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: 'a'.repeat(40), avatar: 'blob:fixture-a' }))
    await vi.advanceTimersByTimeAsync(1000)
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: 'b'.repeat(40), avatar: 'blob:fixture-b' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared()).toHaveLength(2)
    expect(shared()[1]).toMatchObject({ avatars: { 'alice@example.com': 'b'.repeat(40) } })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_notification_avatar', {
      avatar: { account: 'me@example.com', hash: 'b'.repeat(40), data: 'AQID' },
    })
  })

  it.each(['alice@example.com', 'team@muc.example.com'])('normalizes UUID-keyed cached avatars for %s', async (jid) => {
    renderHook(() => usePushSenderNames())
    const entity = { jid, name: 'Fixture', avatarHash: '12345678-1234-1234-1234-123456789abc', avatar: 'blob:uuid-fixture' }
    if (jid === 'alice@example.com') rosterState.set(roster(entity))
    else roomState.set(rooms(entity))
    await vi.advanceTimersByTimeAsync(1000)
    const hash = createHash('sha1').update(new Uint8Array([1, 2, 3])).digest('hex')
    expect(shared().at(-1)).toMatchObject({ avatars: { [jid]: hash } })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_notification_avatar', {
      avatar: { account: 'me@example.com', hash, data: 'AQID' },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, 'a'.repeat(40)])('refreshes editor data URIs despite an old hash of %s', async (avatarHash) => {
    renderHook(() => usePushSenderNames())
    const jid = 'team@muc.example.com'
    roomState.set(rooms({ jid, name: 'Team', avatarHash, avatar: 'data:image/png;base64,AQID' }))
    await vi.advanceTimersByTimeAsync(1000)
    const firstHash = createHash('sha1').update(new Uint8Array([1, 2, 3])).digest('hex')
    expect(shared().at(-1)).toMatchObject({ avatars: { [jid]: firstHash } })

    vi.mocked(fetch).mockResolvedValue({ blob: async () => ({ size: 3, arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer }) } as unknown as Response)
    roomState.set(rooms({ jid, name: 'Team', avatarHash, avatar: 'data:image/png;base64,BAUG' }))
    await vi.advanceTimersByTimeAsync(1000)
    const nextHash = createHash('sha1').update(new Uint8Array([4, 5, 6])).digest('hex')
    expect(shared().at(-1)).toMatchObject({ avatars: { [jid]: nextHash } })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_notification_avatar', {
      avatar: { account: 'me@example.com', hash: nextHash, data: 'BAUG' },
    })
    expect(shared()).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('deduplicates normalized images with an existing XMPP hash', async () => {
    const hash = createHash('sha1').update(new Uint8Array([1, 2, 3])).digest('hex')
    renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: hash, avatar: 'blob:fixture' }))
    roomState.set(rooms({ jid: 'team@muc.example.com', name: 'Team', avatar: 'data:image/png;base64,AQID' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared().at(-1)).toMatchObject({ avatars: { 'alice@example.com': hash, 'team@muc.example.com': hash } })
    expect(mockInvoke.mock.calls.filter(([command]) => command === 'plugin:push|set_notification_avatar')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not revive an old account during avatar normalization', async () => {
    let release!: (value: Response) => void
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve }))
    const hook = renderHook(() => usePushSenderNames())
    roomState.set(rooms({ jid: 'team@muc.example.com', name: 'Team', avatar: 'data:image/png;base64,AQID' }))
    await vi.advanceTimersByTimeAsync(1000)
    connectionState.set({ jid: null })
    hook.unmount()
    release({ blob: async () => ({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) } as unknown as Response)
    await vi.advanceTimersByTimeAsync(0)
    expect(shared()).toEqual([{ account: null, contacts: {}, rooms: {}, avatars: {} }])
    expect(mockInvoke.mock.calls.filter(([command]) => command === 'plugin:push|set_notification_avatar')).toHaveLength(0)
  })

  it('removes an avatar while keeping the contact name', async () => {
    renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: 'a'.repeat(40), avatar: 'blob:fixture' }))
    await vi.advanceTimersByTimeAsync(1000)
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared().at(-1)).toMatchObject({ contacts: { 'alice@example.com': 'Alice' }, avatars: {} })
  })

  it('deduplicates contact and room images with the same hash', async () => {
    renderHook(() => usePushSenderNames())
    const hash = 'a'.repeat(40)
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: hash, avatar: 'blob:fixture' }))
    roomState.set(rooms({ jid: 'team@muc.example.com', name: 'Team', avatarHash: hash, avatar: 'blob:fixture' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared().at(-1)).toMatchObject({ avatars: { 'alice@example.com': hash, 'team@muc.example.com': hash } })
    expect(mockInvoke.mock.calls.filter(([command]) => command === 'plugin:push|set_notification_avatar')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('waits for cache blob availability and never fetches remote avatar URLs', async () => {
    renderHook(() => usePushSenderNames())
    const hash = 'a'.repeat(40)
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: hash, avatar: 'https://example.com/avatar' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).not.toHaveBeenCalled()
    expect(shared().at(-1)).toMatchObject({ avatars: {} })
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: hash, avatar: 'blob:fixture' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared().at(-1)).toMatchObject({ avatars: { 'alice@example.com': hash } })
  })

  it('does not retry rejected images on unrelated store updates', async () => {
    mockInvoke.mockResolvedValue({ written: false })
    renderHook(() => usePushSenderNames())
    const contact = { jid: 'alice@example.com', name: 'Alice', avatarHash: 'a'.repeat(40), avatar: 'blob:fixture' }
    rosterState.set(roster(contact))
    await vi.advanceTimersByTimeAsync(1000)
    rosterState.set(roster({ ...contact }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockInvoke.mock.calls.filter(([command]) => command === 'plugin:push|set_notification_avatar')).toHaveLength(1)
  })

  it('mirrors every roster and room hash beyond 200 images', async () => {
    vi.mocked(fetch).mockResolvedValue({ blob: async () => ({ size: 2 * 1024 * 1024 + 1 }) } as unknown as Response)
    renderHook(() => usePushSenderNames())
    rosterState.set(roster(...Array.from({ length: 201 }, (_, index) => ({
      jid: `contact${index}@example.com`, name: `Contact ${index}`,
      avatarHash: index.toString(16).padStart(40, '0'), avatar: `blob:fixture-${index}`,
    }))))
    roomState.set(rooms({ jid: 'team@muc.example.com', name: 'Team', avatarHash: 'f'.repeat(40), avatar: 'blob:fixture-room' }))
    await vi.advanceTimersByTimeAsync(1000)
    const snapshot = shared().at(-1) as { avatars: Record<string, string> }
    expect(Object.keys(snapshot.avatars)).toHaveLength(202)
    expect(snapshot.avatars['team@muc.example.com']).toBe('f'.repeat(40))
  })

  it('wipes on logout even when the hook unmounts immediately', async () => {
    const hook = renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice' }))
    await vi.advanceTimersByTimeAsync(1000)
    connectionState.set({ jid: null })
    hook.unmount()
    await vi.advanceTimersByTimeAsync(0)
    expect(shared().at(-1)).toEqual({ account: null, contacts: {}, rooms: {}, avatars: {} })
  })

  it('wipes before mirroring another account', async () => {
    renderHook(() => usePushSenderNames())
    await vi.advanceTimersByTimeAsync(1000)
    connectionState.set({ jid: 'other@example.com/device' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared().slice(-2)).toEqual([
      { account: null, contacts: {}, rooms: {}, avatars: {} },
      { account: 'other@example.com', preserveIfEmpty: true, contacts: {}, rooms: {}, avatars: {} },
    ])
  })

  it.each([false, true])('never relabels retained contacts during a slow account switch (logout: %s)', async (logout) => {
    renderHook(() => usePushSenderNames())
    const hash = 'a'.repeat(40)
    rosterState.set(roster({ jid: 'private@example.com', name: 'Private', avatarHash: hash, avatar: 'blob:private' }))
    roomState.set(rooms({ jid: 'private@muc.example.com', name: 'Private Room', avatarHash: hash, avatar: 'blob:private-room' }))
    await vi.advanceTimersByTimeAsync(1000)
    mockInvoke.mockClear()
    vi.mocked(fetch).mockClear()
    if (logout) connectionState.set({ jid: null })
    connectionState.set({ jid: 'other@example.com/device' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetch).not.toHaveBeenCalled()
    for (const snapshot of shared()) {
      expect(snapshot).toMatchObject({ contacts: {}, rooms: {}, avatars: {} })
    }
    expect(shared().at(-1)).toMatchObject({ account: 'other@example.com', preserveIfEmpty: true })

    roomState.set(rooms())
    rosterState.set({ ...roster({ jid: 'bob@example.com', name: 'Bob', avatarHash: 'b'.repeat(40), avatar: 'blob:bob' }), accountJid: 'other@example.com' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared().at(-1)).toEqual({ account: 'other@example.com', contacts: { 'bob@example.com': 'Bob' }, rooms: {}, avatars: { 'bob@example.com': 'b'.repeat(40) } })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_notification_avatar', {
      avatar: { account: 'other@example.com', hash: 'b'.repeat(40), data: 'AQID' },
    })
  })

  it('rejects a retained previous-account roster on a fresh hook mount', async () => {
    connectionState.set({ jid: 'other@example.com/device' })
    rosterState.set(roster({ jid: 'private@example.com', name: 'Private', avatarHash: 'a'.repeat(40), avatar: 'blob:private' }))
    renderHook(() => usePushSenderNames())
    await vi.advanceTimersByTimeAsync(1000)
    expect(shared()).toEqual([{ account: 'other@example.com', preserveIfEmpty: true, contacts: {}, rooms: {}, avatars: {} }])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not revive an old account after a pending blob read', async () => {
    let release!: (value: Response) => void
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve }))
    const hook = renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: 'a'.repeat(40), avatar: 'blob:fixture-a' }))
    await vi.advanceTimersByTimeAsync(1000)
    connectionState.set({ jid: null })
    hook.unmount()
    release({ blob: async () => ({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) } as unknown as Response)
    await vi.advanceTimersByTimeAsync(0)
    expect(shared().at(-1)).toMatchObject({ account: null, avatars: {} })
    expect(mockInvoke.mock.calls.filter(([command]) => command === 'plugin:push|set_notification_avatar')).toHaveLength(0)
  })

  it('orders an old-session wipe before a new session across hook remounts', async () => {
    let release!: () => void
    mockInvoke.mockImplementation((command: string) => command === 'plugin:push|set_notification_avatar'
      ? new Promise(resolve => { release = () => resolve({ written: true }) })
      : Promise.resolve())
    const oldSession = renderHook(() => usePushSenderNames())
    rosterState.set(roster({ jid: 'alice@example.com', name: 'Alice', avatarHash: 'a'.repeat(40), avatar: 'blob:fixture' }))
    await vi.advanceTimersByTimeAsync(1000)
    connectionState.set({ jid: null })
    oldSession.unmount()
    connectionState.set({ jid: 'other@example.com/device' })
    rosterState.set({ ...roster({ jid: 'bob@example.com', name: 'Bob' }), accountJid: 'other@example.com' })
    renderHook(() => usePushSenderNames())
    await vi.advanceTimersByTimeAsync(1000)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(shared().at(-1)).toMatchObject({ account: 'other@example.com', contacts: { 'bob@example.com': 'Bob' } })
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
