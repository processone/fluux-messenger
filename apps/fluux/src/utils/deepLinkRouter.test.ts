import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'
import {
  classifyDeepLink,
  routeDeepLink,
  ensureDeepLinkRouter,
  setStartupLoginHandler,
  setNavigationHandler,
  takeQueuedDeepLinks,
  clearQueuedDeepLinks,
  resetDeepLinkRouterForTests,
  LAUNCH_LINK_WAIT_MS,
} from './deepLinkRouter'

// Source: captain decisions kept from FLM-14/FLM-15 — a login link replaces the
// saved account at any moment during startup; room-join and message links are
// navigation only — and the review findings on readers of the launch URL.

const mockOnOpenUrl = vi.fn()
const mockGetCurrent = vi.fn()
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: (cb: (urls: string[]) => void) => mockOnOpenUrl(cb),
  getCurrent: () => mockGetCurrent(),
}))

const LOGIN = 'xmpp:alice@example.com?connect;server=wss://example.com/ws'
const BARE = 'xmpp:alice@example.com'
const JOIN = 'xmpp:team@conference.example.com?join'
const MESSAGE = 'xmpp:bob@example.com?message;body=hi'
const SHORTCUT = 'net.processone.fluux://shortcut?account=a@example.com&kind=chat&id=b@example.com'

describe('classifyDeepLink', () => {
  it.each([
    [LOGIN, 'login'],
    [BARE, 'login'],
    ['xmpp:alice@chat.example.com?connect', 'login'],
    [JOIN, 'navigation'],
    [MESSAGE, 'navigation'],
    ['xmpp:room@conference.example.com', 'navigation'],
    [SHORTCUT, 'navigation'],
    ['xmpp:not-a-jid', 'navigation'],
  ])('%s is %s', (uri, intent) => {
    expect(classifyDeepLink(uri)).toBe(intent)
  })
})

describe('routeDeepLink', () => {
  beforeEach(() => {
    resetDeepLinkRouterForTests()
    useLoginPrefillStore.getState().clearPrefill()
  })

  it('during startup: a login link goes to the startup owner, navigation waits in the queue', () => {
    const startup = vi.fn()
    const navigation = vi.fn()
    setStartupLoginHandler(startup)
    setNavigationHandler(navigation)

    routeDeepLink(JOIN)
    routeDeepLink(LOGIN)

    expect(navigation).not.toHaveBeenCalled()
    expect(startup).toHaveBeenCalledWith(expect.objectContaining({ jid: 'alice@example.com', server: 'wss://example.com/ws' }), LOGIN)
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
    expect(takeQueuedDeepLinks()).toEqual([JOIN])
  })

  it('with the chat view up: every link navigates, as before', () => {
    const navigation = vi.fn()
    const dispose = setNavigationHandler(navigation)
    routeDeepLink(BARE)
    routeDeepLink(JOIN)
    expect(navigation.mock.calls.map(([uri]) => uri)).toEqual([BARE, JOIN])
    expect(takeQueuedDeepLinks()).toEqual([])

    dispose()
    routeDeepLink(JOIN)
    expect(navigation).toHaveBeenCalledTimes(2)
  })

  it('with the login form up: a login link prefills it, navigation waits for the next online', () => {
    routeDeepLink(JOIN)
    routeDeepLink(MESSAGE)
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
    routeDeepLink(LOGIN)
    expect(useLoginPrefillStore.getState().prefill).toMatchObject({ jid: 'alice@example.com' })
    expect(takeQueuedDeepLinks()).toEqual([JOIN, MESSAGE])
    expect(takeQueuedDeepLinks()).toEqual([])
  })

  it('clearQueuedDeepLinks drops what is waiting', () => {
    routeDeepLink(JOIN)
    clearQueuedDeepLinks()
    expect(takeQueuedDeepLinks()).toEqual([])
  })
})

describe('ensureDeepLinkRouter', () => {
  beforeEach(() => {
    resetDeepLinkRouterForTests()
    useLoginPrefillStore.getState().clearPrefill()
    mockOnOpenUrl.mockReset().mockResolvedValue(() => {})
    mockGetCurrent.mockReset().mockResolvedValue(null)
    setPlatformForTesting({ shell: 'desktop', os: 'macos' })
  })
  afterEach(() => {
    setPlatformForTesting({ shell: 'web', os: 'macos' })
    vi.useRealTimers()
  })

  it('arms the live listener before reading the launch URL, and dispatches the launch URL once', async () => {
    const order: string[] = []
    mockOnOpenUrl.mockImplementation(() => { order.push('listen'); return Promise.resolve(() => {}) })
    mockGetCurrent.mockImplementation(() => { order.push('getCurrent'); return Promise.resolve([LOGIN]) })

    await Promise.all([ensureDeepLinkRouter(), ensureDeepLinkRouter()])
    await ensureDeepLinkRouter()

    expect(order).toEqual(['listen', 'getCurrent'])
    expect(useLoginPrefillStore.getState().prefill).toMatchObject({ jid: 'alice@example.com' })
  })

  it('routes links the listener delivers', async () => {
    let deliver: ((urls: string[]) => void) | undefined
    mockOnOpenUrl.mockImplementation((cb: (urls: string[]) => void) => { deliver = cb; return Promise.resolve(() => {}) })
    await ensureDeepLinkRouter()
    const startup = vi.fn()
    setStartupLoginHandler(startup)
    deliver!([JOIN, LOGIN])
    expect(startup).toHaveBeenCalledTimes(1)
    expect(takeQueuedDeepLinks()).toEqual([JOIN])
  })

  it('does not hold the caller when the launch URL never answers', async () => {
    vi.useFakeTimers()
    mockGetCurrent.mockReturnValue(new Promise(() => {}))
    const ready = ensureDeepLinkRouter()
    await vi.advanceTimersByTimeAsync(LAUNCH_LINK_WAIT_MS + 1)
    await expect(ready).resolves.toBeUndefined()
  })

  it('does nothing where there are no deep link events (web)', async () => {
    setPlatformForTesting({ shell: 'web', os: 'macos' })
    await ensureDeepLinkRouter()
    expect(mockOnOpenUrl).not.toHaveBeenCalled()
    expect(mockGetCurrent).not.toHaveBeenCalled()
  })
})
