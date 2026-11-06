import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatStore, connectionStore, roomStore, rosterStore } from '@fluux/sdk'
import { setPlatformForTesting } from '@/platform'
import { startAppleConversationMirror, clearAppleConversationMirror } from '@/platform/apple/conversationMirror'
import { DESKTOP_WIDGET_HEARTBEAT_MS, clearUnreadWidgetList, resetSharedUnreadWidgetList, startUnreadWidgetPublisher } from './unreadWidget'

// This suite needs the actual SDK stores, not the application's global store stand-ins.
vi.unmock('@fluux/sdk')

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue({ written: true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

// Accepted macOS widget plan: publish while the window is closed, keep cached avatars local,
// and never restore an account after sign-out. Real SDK stores drive the native IPC boundary.
describe('native macOS unread widget publication', () => {
  let restore: () => void = () => {}
  let stop: (() => void) | undefined
  let releasePending: () => void = () => {}
  beforeEach(() => {
    restore = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    vi.useFakeTimers()
    invoke.mockReset().mockResolvedValue({ written: true })
    resetSharedUnreadWidgetList()
    chatStore.getState().reset()
    roomStore.getState().reset()
    rosterStore.getState().reset()
    connectionStore.getState().setJid('me@example.com/desktop')
  })
  afterEach(async () => {
    releasePending()
    releasePending = () => {}
    stop?.()
    stop = undefined
    await vi.advanceTimersByTimeAsync(0)
    resetSharedUnreadWidgetList()
    restore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renews an unchanged list while running, then stays cleared through later heartbeats', async () => {
    chatStore.getState().addConversation({ id: 'alice@example.com', name: 'Alice Martin', type: 'chat', unreadCount: 2 })
    stop = startUnreadWidgetPublisher(() => 1, DESKTOP_WIDGET_HEARTBEAT_MS)
    await vi.advanceTimersByTimeAsync(500)
    const first = invoke.mock.lastCall?.[1].list
    expect(first).toMatchObject({ account: 'me@example.com', total: 2, rows: [{ id: 'alice@example.com', unread: 2 }] })
    // Desktop refresh policy uses a fifteen-minute heartbeat, not per-minute reloads.
    await vi.advanceTimersByTimeAsync(DESKTOP_WIDGET_HEARTBEAT_MS - 1000)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke.mock.lastCall?.[1].heartbeat).toBe(true)
    expect(invoke.mock.lastCall?.[1].list.updated).toBeGreaterThan(first.updated)
    expect(invoke.mock.lastCall?.[1].list.rows).toEqual(first.rows)
    await clearUnreadWidgetList()
    invoke.mockClear()
    await vi.advanceTimersByTimeAsync(2 * DESKTOP_WIDGET_HEARTBEAT_MS)
    expect(invoke).not.toHaveBeenCalled()
    stop()
    stop = undefined
    connectionStore.getState().setJid(null)
    await vi.advanceTimersByTimeAsync(2 * DESKTOP_WIDGET_HEARTBEAT_MS)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('renews the first session publication but not an ordinary hook remount', async () => {
    chatStore.getState().addConversation({ id: 'alice@example.com', name: 'Alice Martin', type: 'chat', unreadCount: 2 })
    stop = startUnreadWidgetPublisher(() => 0, DESKTOP_WIDGET_HEARTBEAT_MS)
    await vi.advanceTimersByTimeAsync(500)
    expect(invoke.mock.lastCall?.[1].heartbeat).toBe(true)
    stop()
    stop = startUnreadWidgetPublisher(() => 0, DESKTOP_WIDGET_HEARTBEAT_MS)
    await vi.advanceTimersByTimeAsync(500)
    expect(invoke).toHaveBeenCalledTimes(1)
    await clearUnreadWidgetList()
    connectionStore.getState().setJid(null)
    connectionStore.getState().setJid('me@example.com/desktop')
    stop()
    stop = startUnreadWidgetPublisher(() => 0, DESKTOP_WIDGET_HEARTBEAT_MS)
    await vi.advanceTimersByTimeAsync(500)
    expect(invoke.mock.lastCall?.[1].heartbeat).toBe(true)
    expect(invoke.mock.lastCall?.[1].list.account).toBe('me@example.com')
  })

  it('routes the shared avatar mirror to the widget plugin and wipes it at sign-out', async () => {
    const bytes = readFileSync('public/logo.png')
    const hash = createHash('sha1').update(bytes).digest('hex')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: async () => ({ size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }) }))
    rosterStore.setState({ accountJid: 'me@example.com', isLoaded: true, contacts: new Map([
      ['alice@example.com', { jid: 'alice@example.com', name: 'Alice Martin', subscription: 'both', groups: [], presence: 'online', avatar: 'blob:cached-avatar', avatarHash: hash }],
    ]) })
    stop = startAppleConversationMirror()
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke).toHaveBeenCalledWith('plugin:widgets|set_sender_names', expect.objectContaining({ names: expect.objectContaining({ account: 'me@example.com', avatars: { 'alice@example.com': hash } }) }))
    expect(invoke).toHaveBeenCalledWith('plugin:widgets|set_notification_avatar', { avatar: { account: 'me@example.com', hash, data: bytes.toString('base64') } })
    await clearAppleConversationMirror()
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenLastCalledWith('plugin:widgets|set_sender_names', { names: { account: null, contacts: {}, rooms: {}, avatars: {} } })
    invoke.mockClear()
    rosterStore.setState({ contacts: new Map() })
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('leaves a final wipe after a late names write and before the next account', async () => {
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    releasePending = release
    let first = true
    let diskAccount: string | null = null
    const owners: Array<string | null> = []
    invoke.mockImplementation(async (command, args) => {
      if (command === 'plugin:widgets|set_sender_names') {
        const owner = args.names.account as string | null
        owners.push(owner)
        if (first && owner) { first = false; await delayed }
        diskAccount = owner
      }
      return { written: true, supported: true }
    })
    stop = startAppleConversationMirror()
    await vi.advanceTimersByTimeAsync(1000)
    await clearAppleConversationMirror()
    expect(diskAccount).toBeNull()
    connectionStore.getState().setJid('other@example.com/desktop')
    rosterStore.setState({ accountJid: 'other@example.com', isLoaded: true, contacts: new Map() })
    stop = startAppleConversationMirror()
    await vi.advanceTimersByTimeAsync(1000)
    expect(owners).toEqual(['me@example.com', null])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(owners).toEqual(['me@example.com', null, null, 'other@example.com'])
    expect(diskAccount).toBe('other@example.com')
  })

  it.each(['publisher', 'mirror'] as const)('disables both producers after an unsupported reply to the %s', async (first) => {
    invoke.mockResolvedValue({ written: false, supported: false })
    const bytes = readFileSync('public/logo.png')
    const hash = createHash('sha1').update(bytes).digest('hex')
    rosterStore.setState({ accountJid: 'me@example.com', isLoaded: true, contacts: new Map([
      ['alice@example.com', { jid: 'alice@example.com', name: 'Alice Martin', subscription: 'both', groups: [], presence: 'online', avatar: 'blob:cached-avatar', avatarHash: hash }],
    ]) })
    const fetchImage = vi.fn().mockResolvedValue({ blob: async () => ({ size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }) })
    vi.stubGlobal('fetch', fetchImage)
    if (first === 'publisher') stop = startUnreadWidgetPublisher(() => 0, DESKTOP_WIDGET_HEARTBEAT_MS)
    else stop = startAppleConversationMirror()
    await vi.advanceTimersByTimeAsync(1500)
    expect(invoke).toHaveBeenCalledTimes(1)
    const stopOther = first === 'publisher' ? startAppleConversationMirror() : startUnreadWidgetPublisher(() => 0, DESKTOP_WIDGET_HEARTBEAT_MS)
    rosterStore.setState({ contacts: new Map() })
    chatStore.getState().addConversation({ id: 'alice@example.com', name: 'Alice Martin', type: 'chat', unreadCount: 1 })
    await vi.advanceTimersByTimeAsync(2 * DESKTOP_WIDGET_HEARTBEAT_MS)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(fetchImage).not.toHaveBeenCalled()
    stopOther()
  })

  it.each([{ shell: 'desktop', os: 'windows' }, { shell: 'web', os: 'macos' }, { shell: 'desktop', os: 'macos', osVersion: '13.7.8' }] as const)('does not publish a mirror on $shell/$os', async (target) => {
    restore()
    restore = setPlatformForTesting(target)
    stop = startAppleConversationMirror()
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke).not.toHaveBeenCalled()
  })
})
