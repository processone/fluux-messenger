import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MUC } from './MUC'
import type { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createStoreBindings, type StoreRefs } from '../../bindings/storeBindings'
import { roomStore } from '../../stores/roomStore'
import { createMockElement, createMockPresenceReader, createMockStoreRefs } from '../test-utils'
import { resolveNotifyLevel } from '../notifyLevel'
import type { SDKEvents } from '../types/sdk-events'

// FLM-189 decision 7: on a room without a bookmark, Off lasts for the session.
// It must not be kept as a saved choice that survives leaving the room and is
// then published by the automatic bookmark on the next join.
const ROOM = 'quiet@conference.example.org'

describe('room notification level through the store binding', () => {
  let muc: MUC
  let sendIQ: ReturnType<typeof vi.fn>

  beforeEach(() => {
    roomStore.setState(roomStore.getInitialState(), true)
    roomStore.getState().addRoom({
      jid: ROOM, name: 'Quiet', nickname: 'mynick', joined: true, isBookmarked: false,
      occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
    })

    const handlers = new Map<string, (payload: unknown) => void>()
    const source = {
      subscribe: (event: string, handler: (payload: unknown) => void) => { handlers.set(event, handler); return () => handlers.delete(event) },
    }
    const refs = createMockStoreRefs()
    createStoreBindings(source as never, () => ({ ...refs, room: roomStore.getState() }) as unknown as StoreRefs)

    sendIQ = vi.fn().mockResolvedValue(createMockElement('iq', { type: 'result' }))
    const deps = {
      stores: { get room() { return roomStore.getState() } },
      presence: createMockPresenceReader(),
      sendIQ,
      sendStanza: vi.fn(),
      emit: vi.fn(),
      emitSDK: <K extends keyof SDKEvents>(event: K, payload: SDKEvents[K]) => handlers.get(event)?.(payload),
      getCurrentJid: () => 'user@example.com/resource',
    } as unknown as ModuleDependencies
    muc = new MUC(deps, { forceCatchUpAllRooms: vi.fn() } as unknown as MAM)
  })

  const level = () => resolveNotifyLevel(roomStore.getState().rooms.get(ROOM))

  it('forgets Off chosen on an unbookmarked room once the room is left', async () => {
    await muc.setRoomNotifyLevel(ROOM, 'none', true)
    expect(level()).toBe('none')
    expect(sendIQ).not.toHaveBeenCalled()

    roomStore.getState().setRoomJoined(ROOM, false)
    roomStore.getState().setRoomJoined(ROOM, true)

    expect(level()).toBe('mentions')
    expect(roomStore.getState().rooms.get(ROOM)?.notifyOffPersistent).toBeFalsy()
  })

  it('saves Off on a bookmarked room, and it survives leaving the room', async () => {
    roomStore.getState().setBookmark(ROOM, { name: 'Quiet', nick: 'mynick' })

    await muc.setRoomNotifyLevel(ROOM, 'none', true)
    roomStore.getState().setRoomJoined(ROOM, false)
    roomStore.getState().setRoomJoined(ROOM, true)

    expect(level()).toBe('none')
    expect(sendIQ).toHaveBeenCalledOnce()
  })
})
