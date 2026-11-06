import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockInvoke = vi.fn()
const widgetCalls = () => mockInvoke.mock.calls.filter(([command]) => command === 'plugin:widgets|set_unread_list')

function store<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => void listeners.delete(listener) },
    set: (next: T) => { state = next; listeners.forEach((listener) => listener()) },
  }
}
const asStore = (holder: { current: unknown }) => holder.current as ReturnType<typeof store<unknown>>
const { connectionStore, chatStore, roomStore } = vi.hoisted(() => ({
  connectionStore: { current: null as unknown }, chatStore: { current: null as unknown }, roomStore: { current: null as unknown },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    get connectionStore() { return connectionStore.current },
    get chatStore() { return chatStore.current },
    get roomStore() { return roomStore.current },
  }
})

import {
  clearUnreadWidgetList, resetSharedUnreadWidgetList, shareUnreadWidgetList, startUnreadWidgetPublisher, unreadWidgetList,
  type UnreadWidgetList,
} from './unreadWidget'

type Rooms = Parameters<typeof unreadWidgetList>[2]

function rooms(list: Array<{ jid: string; name?: string; unreadCount?: number; mentionsCount?: number; notifyAll?: boolean }>): Rooms {
  return {
    roomEntities: new Map(list.map((r) => [r.jid, { jid: r.jid, name: r.name ?? r.jid, joined: true }])),
    roomMeta: new Map(list.map((r) => [r.jid, {
      unreadCount: r.unreadCount ?? 0, mentionsCount: r.mentionsCount ?? 0, notifyAll: r.notifyAll,
    }])),
  } as unknown as Rooms
}

const chats = [
  { id: 'alice@example.com', name: 'Alice Martin', unreadCount: 2, lastMessage: { timestamp: new Date('2026-11-04T10:42:00Z') } },
  { id: 'bruno@example.com', name: 'Bruno Roux', unreadCount: 1, lastMessage: { timestamp: new Date('2026-11-04T09:58:00Z') } },
] as unknown as Array<{ id: string; name: string; unreadCount: number; lastMessage: { timestamp: Date } }>

describe('unreadWidgetList', () => {
  it('lists the conversations the badge counts and totals like the badge, events included', () => {
    const list = unreadWidgetList('me@example.com', chats, rooms([
      { jid: 'dev@muc.example.com', name: 'ejabberd-dev', unreadCount: 14, mentionsCount: 1 },
      { jid: 'busy@muc.example.com', unreadCount: 40 },
    ]), 2, 1000)

    expect(list.rows.map(r => r.id)).toEqual(['alice@example.com', 'bruno@example.com', 'dev@muc.example.com'])
    expect(list.total).toBe(3 + 2)
    expect(list).toMatchObject({ account: 'me@example.com', updated: 1000 })
    expect(list.rows[2]).toMatchObject({ kind: 'groupchat', name: 'ejabberd-dev', unread: 14, mentions: 1 })
  })

  it('carries no message text', () => {
    const withText = [{ ...chats[0], lastMessage: { timestamp: new Date(), body: 'a secret plan' } }] as never
    expect(JSON.stringify(unreadWidgetList('me@example.com', withText, rooms([]), 0))).not.toContain('secret')
  })

  it('keeps the total when more conversations are unread than rows are kept', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}@example.com`, name: `C${i}`, unreadCount: 1 })) as never
    const list = unreadWidgetList('me@example.com', many, rooms([]), 0)
    expect(list.total).toBe(30)
    expect(list.rows.length).toBeLessThan(30)
  })
})

describe('shareUnreadWidgetList', () => {
  beforeEach(() => { mockInvoke.mockReset(); mockInvoke.mockResolvedValue(undefined); resetSharedUnreadWidgetList() })

  it('checks native shared state on every call, leaving content deduplication to its writer', async () => {
    const list = unreadWidgetList('me@example.com', chats, rooms([]), 0, 1)
    await shareUnreadWidgetList(list)
    await shareUnreadWidgetList({ ...list, updated: 2 })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(mockInvoke).toHaveBeenCalledWith('plugin:widgets|set_unread_list', { list })
    await shareUnreadWidgetList(null)
    expect(mockInvoke).toHaveBeenLastCalledWith('plugin:widgets|set_unread_list', { list: null })
  })

  it('sends again after a failed write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockInvoke.mockRejectedValueOnce(new Error('nope'))
    const list = unreadWidgetList('me@example.com', chats, rooms([]), 0)
    await shareUnreadWidgetList(list)
    await shareUnreadWidgetList(list)
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })
})

describe('startUnreadWidgetPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers(); mockInvoke.mockReset(); mockInvoke.mockResolvedValue(undefined); resetSharedUnreadWidgetList()
    connectionStore.current = store({ jid: 'me@example.com/phone', status: 'online', isCatchingUp: false })
    chatStore.current = store({ conversations: new Map() })
    roomStore.current = store({ roomEntities: new Map(), roomMeta: new Map() })
  })
  afterEach(() => { resetSharedUnreadWidgetList(); vi.restoreAllMocks(); vi.useRealTimers() })

  it('publishes after a store changes, and empties the list when signed out', async () => {
    const stop = startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    expect(mockInvoke).toHaveBeenLastCalledWith('plugin:widgets|set_unread_list',
      { list: expect.objectContaining({ account: 'me@example.com', total: 0, rows: [] }) })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_badge',
      { badge: { account: 'me@example.com', updated: expect.any(Number), unread: [], events: 0, notifyAllRooms: [] } })

    asStore(chatStore).set({ conversations: new Map([[chats[0].id, chats[0]]]) })
    await vi.advanceTimersByTimeAsync(600)
    expect(mockInvoke.mock.lastCall?.[1].list.rows.map((r: { id: string }) => r.id)).toEqual(['alice@example.com'])

    asStore(connectionStore).set({ jid: null })
    await vi.advanceTimersByTimeAsync(600)
    expect(mockInvoke).toHaveBeenLastCalledWith('plugin:widgets|set_unread_list', { list: null })
    stop()
  })

  it('republishes an unchanged app snapshot on warm resume after an extension added a stale row', async () => {
    const sharedFile = { list: null as UnreadWidgetList | null }
    mockInvoke.mockImplementation((_command: string, { list }: { list: UnreadWidgetList | null }) => {
      if (_command === 'plugin:widgets|set_unread_list') sharedFile.list = structuredClone(list)
      return Promise.resolve()
    })
    const stop = startUnreadWidgetPublisher(() => 0)
    try {
      await vi.advanceTimersByTimeAsync(600)
      expect(sharedFile.list?.rows).toEqual([])
      // The extension changed the shared file, not the app's own already-read stores.
      sharedFile.list = unreadWidgetList('me@example.com', [chats[0]], rooms([]), 0, 2)
      asStore(connectionStore).set({ jid: 'me@example.com/phone', status: 'online', isCatchingUp: false, windowVisible: true })
      await vi.advanceTimersByTimeAsync(600)
      console.info('warm-resume shared state:', JSON.stringify(sharedFile.list))
      expect(sharedFile.list?.rows).toEqual([])
      expect(sharedFile.list?.total).toBe(0)
      expect(widgetCalls()).toHaveLength(2)
    } finally { stop() }
  })

  it.each([
    { status: 'connecting' }, { isVerifying: true }, { isCatchingUp: true }, { replayOwners: 1 },
  ])('keeps extension state until the current stores are ready: %j', async (pending) => {
    asStore(connectionStore).set({ jid: 'me@example.com/phone', status: 'online', ...pending })
    startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    expect(mockInvoke).not.toHaveBeenCalled()
    asStore(connectionStore).set({ jid: 'me@example.com/phone', status: 'online', isCatchingUp: false })
    await vi.advanceTimersByTimeAsync(600)
    expect(widgetCalls()).toHaveLength(1)
  })

  it('publishes same-total unread membership changes to both mirrors', async () => {
    asStore(chatStore).set({ conversations: new Map([[chats[0].id, chats[0]]]) })
    startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    asStore(chatStore).set({ conversations: new Map([[chats[1].id, chats[1]]]) })
    await vi.advanceTimersByTimeAsync(600)
    expect(mockInvoke).toHaveBeenCalledWith('plugin:push|set_badge',
      { badge: { account: 'me@example.com', updated: expect.any(Number), unread: ['bruno@example.com'], events: 0, notifyAllRooms: [] } })
    const lastWidget = widgetCalls().at(-1)?.[1].list
    expect(lastWidget).toMatchObject({ total: 1, rows: [{ id: 'bruno@example.com' }] })
    const lastBadge = mockInvoke.mock.calls.filter(([command]) => command === 'plugin:push|set_badge').at(-1)?.[1].badge
    expect(lastBadge.updated).toBe(lastWidget.updated)
  })

  it('waits for the actual badge membership acknowledgement before sending the widget list', async () => {
    let acknowledge!: () => void
    mockInvoke.mockImplementation((command: string) => command === 'plugin:push|set_badge'
      ? new Promise<void>(resolve => { acknowledge = resolve }) : Promise.resolve())
    startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    expect(widgetCalls()).toHaveLength(0)
    acknowledge()
    await vi.advanceTimersByTimeAsync(1)
    expect(widgetCalls()).toHaveLength(1)
  })

  it('does not send widget state after a failed badge membership write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockInvoke.mockRejectedValueOnce(new Error('shared state unavailable'))
    startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    expect(widgetCalls()).toHaveLength(0)
    asStore(chatStore).set({ conversations: new Map() })
    await vi.advanceTimersByTimeAsync(600)
    expect(widgetCalls()).toHaveLength(1)
  })

  it('flushes a pending known snapshot before the webview is hidden and removes the listener on stop', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const stop = startUnreadWidgetPublisher(() => 0)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(1)
    expect(widgetCalls()).toHaveLength(1)
    stop()
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(600)
    expect(widgetCalls()).toHaveLength(1)
    visibility.mockRestore()
  })

  it('does not bring the account back while a sign-out clears the list (FLM-418 R1)', async () => {
    const stop = startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    mockInvoke.mockClear()
    // A change is pending when the sign-out starts, with the account still connected.
    asStore(chatStore).set({ conversations: new Map([[chats[0].id, chats[0]]]) })
    const cleared = clearUnreadWidgetList()
    await vi.advanceTimersByTimeAsync(2000)
    await cleared
    expect(widgetCalls().map(call => call[1].list)).toEqual([null])
    // Later changes for the same account, such as unmounting, stay silent too.
    asStore(chatStore).set({ conversations: new Map() })
    await vi.advanceTimersByTimeAsync(2000)
    stop()
    expect(widgetCalls()).toHaveLength(1)
  })

  it('publishes again when the same account signs back in after the publisher was unmounted (FLM-418 R1)', async () => {
    const stop = startUnreadWidgetPublisher(() => 0)
    await clearUnreadWidgetList()
    // The sign-out ends and the layout unmounts before any debounced publication could reset the block.
    stop()
    asStore(connectionStore).set({ jid: null })
    asStore(connectionStore).set({ jid: 'me@example.com/phone', status: 'online', isCatchingUp: false })
    mockInvoke.mockClear()
    const next = startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    next()
    expect(mockInvoke.mock.lastCall?.[1].list).toMatchObject({ account: 'me@example.com' })
  })

  it('publishes for another account after a sign-out', async () => {
    startUnreadWidgetPublisher(() => 0)
    await clearUnreadWidgetList()
    asStore(connectionStore).set({ jid: 'other@example.com/phone', status: 'online', isCatchingUp: false })
    await vi.advanceTimersByTimeAsync(600)
    expect(mockInvoke.mock.lastCall?.[1].list).toMatchObject({ account: 'other@example.com' })
  })
})
