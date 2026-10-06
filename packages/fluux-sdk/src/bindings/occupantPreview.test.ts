import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreBindings } from './storeBindings'
import { createMockClientWithSDKEvents, createMockStoreRefs } from '../core/test-utils'
import { roomStore } from '../stores/roomStore'
import { ignoreStore } from '../stores/ignoreStore'
import { createRoom, createMessage, seedRoomWindow } from '../stores/roomStore.testHelpers'
import type { RoomMessage, RoomOccupant } from '../core/types'
import * as messageCache from '../utils/messageCache'

vi.mock('../utils/messageCache', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/messageCache')>(),
  isMessageCacheAvailable: vi.fn(() => true),
  getRoomMessages: vi.fn(),
  getRoomMessagesAround: vi.fn(),
  saveRoomMessage: vi.fn().mockResolvedValue(undefined),
  saveRoomMessageWithResult: vi.fn().mockResolvedValue(true),
  saveRoomMessages: vi.fn().mockResolvedValue(true),
  reconcileRoomHistoryMessages: vi.fn(async (messages: RoomMessage[]) => messages),
}))

const roomJid = 'preview@conference.example.test'
const otherRoom = 'other@conference.example.test'
const bob: RoomOccupant = {
  nick: 'Bob', jid: 'bob@example.test/resource', role: 'participant', affiliation: 'member',
}
const visible = createMessage('visible', roomJid, 'Alice', 'Visible', false, new Date('2026-10-01T10:00:00Z'))
const ignored = createMessage('ignored', roomJid, 'Bob', 'Ignored', false, new Date('2026-10-01T10:01:00Z'))

describe('preview decisions with queued occupant identities', () => {
  let client: ReturnType<typeof createMockClientWithSDKEvents>
  let unsubscribe: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    roomStore.getState().reset()
    ignoreStore.getState().reset()
    roomStore.getState().addRoom(createRoom(roomJid, { joined: true, nickname: 'Me' }))
    roomStore.getState().addRoom(createRoom(otherRoom, { joined: true, nickname: 'Me' }))
    vi.runOnlyPendingTimers()
    client = createMockClientWithSDKEvents()
    const refs = createMockStoreRefs()
    unsubscribe = createStoreBindings(client, () => ({
      ...refs, room: roomStore.getState(), ignore: ignoreStore.getState(),
    }))
    vi.mocked(messageCache.getRoomMessages).mockResolvedValue([visible, ignored])
    vi.mocked(messageCache.getRoomMessagesAround).mockResolvedValue([visible, ignored])
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'bob@example.test', displayName: 'Bob' })
  })

  afterEach(() => {
    unsubscribe()
    ignoreStore.getState().reset()
    roomStore.getState().reset()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const queueIdentities = () => {
    client.emit('room:occupant-joined', { roomJid, occupant: bob })
    client.emit('room:occupant-joined', { roomJid: otherRoom, occupant: bob })
    expect(roomStore.getState().getRoom(roomJid)?.nickToJidCache?.get('Bob')).toBeUndefined()
  }

  const expectPreview = (message: RoomMessage | undefined) => {
    expect(roomStore.getState().getRoom(roomJid)?.lastMessage).toEqual(message)
    expect(roomStore.getState().roomMeta.get(roomJid)?.lastMessage).toEqual(message)
    expect(roomStore.getState().roomRuntime.get(roomJid)?.nickToJidCache?.get('Bob')).toBe('bob@example.test')
    expect(roomStore.getState().getRoom(otherRoom)?.occupants.size).toBe(0)
    vi.advanceTimersByTime(16)
    expect(roomStore.getState().getRoom(roomJid)?.lastMessage).toEqual(message)
    expect(roomStore.getState().getRoom(otherRoom)?.occupants.get('Bob')).toEqual(bob)
  }

  it('rejects an ignored MAM preview before the presence timer', () => {
    roomStore.getState().updateLastMessagePreview(roomJid, visible)
    queueIdentities()
    roomStore.getState().updateLastMessagePreview(roomJid, ignored)
    expectPreview(visible)
  })

  it.each(['forward', 'backward'] as const)('filters a %s MAM merge using accepted identities', direction => {
    queueIdentities()
    roomStore.getState().mergeRoomMAMMessages(roomJid, [visible, ignored], {}, true, direction)
    expectPreview(visible)
  })

  it.each(['latest', 'around', 'older', 'newer', 'recenter'] as const)(
    'filters the %s cache window before its preview is committed', async path => {
      const state = roomStore.getState()
      if (path === 'older') seedRoomWindow(roomJid, [ignored])
      if (path === 'newer') seedRoomWindow(roomJid, [visible])
      queueIdentities()
      if (path === 'latest') await state.loadMessagesFromCache(roomJid)
      if (path === 'around') await state.loadMessagesAroundFromCache(roomJid, { id: visible.id })
      if (path === 'older') await state.loadOlderMessagesFromCache(roomJid)
      if (path === 'newer') await state.loadNewerMessagesFromCache(roomJid)
      if (path === 'recenter') await state.recenterToLatest(roomJid)
      expectPreview(visible)
    },
  )

  it.each(['single', 'batch'] as const)('refreshes identities after a pending %s cache preview read', async path => {
    let complete!: (messages: RoomMessage[]) => void
    vi.mocked(messageCache.getRoomMessages).mockImplementation(jid => jid === roomJid
      ? new Promise(resolve => { complete = resolve }) : Promise.resolve([]))
    const pending = path === 'single'
      ? roomStore.getState().loadPreviewFromCache(roomJid)
      : roomStore.getState().hydratePreviewsFromCache()
    queueIdentities()
    complete([visible, ignored])
    const result = await pending
    if (path === 'single') expect(result).toEqual(visible)
    expectPreview(visible)
  })

  it('uses current identity when a batch waits for another room cache read', async () => {
    let completeOther!: (messages: RoomMessage[]) => void
    vi.mocked(messageCache.getRoomMessages).mockImplementation(jid => jid === roomJid
      ? Promise.resolve([visible, ignored]) : new Promise(resolve => { completeOther = resolve }))
    const pending = roomStore.getState().hydratePreviewsFromCache()
    await Promise.resolve()
    queueIdentities()
    completeOther([])
    await pending
    expectPreview(visible)
  })

  it('does not use a room object captured before an already-committed identity change', async () => {
    let complete!: (messages: RoomMessage[]) => void
    vi.mocked(messageCache.getRoomMessages).mockReturnValue(new Promise(resolve => { complete = resolve }))
    const pending = roomStore.getState().loadPreviewFromCache(roomJid)
    client.emit('room:occupant-joined', { roomJid, occupant: bob })
    vi.advanceTimersByTime(16)
    complete([visible, ignored])
    expect(await pending).toEqual(visible)
    expect(roomStore.getState().getRoom(roomJid)?.lastMessage).toEqual(visible)
  })

  it('filters a direct message preview at the store action boundary', async () => {
    queueIdentities()
    await roomStore.getState().addMessage(roomJid, ignored)
    expectPreview(undefined)
  })

  it.each(['visible', 'ignored-only', 'unloaded'] as const)('recalculates an ignored preview with %s resident history', history => {
    ignoreStore.getState().reset()
    seedRoomWindow(roomJid, history === 'visible' ? [visible, ignored] : history === 'ignored-only' ? [ignored] : [])
    roomStore.getState().updateLastMessagePreview(roomJid, ignored)
    queueIdentities()
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'bob@example.test', displayName: 'Bob' })
    expectPreview(history === 'visible' ? visible : undefined)
  })

  it('keeps ignored identities filtered when another user is unignored', () => {
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'Alice', displayName: 'Alice' })
    seedRoomWindow(roomJid, [visible, ignored])
    queueIdentities()
    ignoreStore.getState().removeIgnored(roomJid, 'Alice')
    expectPreview(visible)
  })

  it('accepts ordinary previews and does not flush rooms for unrelated ignore changes', () => {
    queueIdentities()
    ignoreStore.getState().addIgnored('unrelated@conference.example.test', { identifier: 'Bob', displayName: 'Bob' })
    expect(roomStore.getState().getRoom(roomJid)?.occupants.size).toBe(0)
    roomStore.getState().updateLastMessagePreview(roomJid, visible)
    expectPreview(visible)
  })

  it('unregisters the preview barrier when bindings are removed', () => {
    queueIdentities()
    unsubscribe()
    const room = roomStore.getState().getRoom(roomJid)
    const listener = vi.fn()
    const detach = roomStore.subscribe(listener)
    try {
      roomStore.getState().updateLastMessagePreview(roomJid, visible)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(roomStore.getState().getRoom(roomJid)?.occupants).toBe(room?.occupants)
    } finally { detach() }
  })
})
