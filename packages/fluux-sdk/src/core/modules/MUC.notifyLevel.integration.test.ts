import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parse } from 'ltx'
import type { Element } from '@xmpp/client'
import { MUC } from './MUC'
import type { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createStoreBindings, type StoreRefs } from '../../bindings/storeBindings'
import { roomStore } from '../../stores/roomStore'
import { createMockElement, createMockPresenceReader, createMockStoreRefs } from '../test-utils'
import { resolveNotifyLevel, savedNotifyLevel } from '../notifyLevel'
import { parseBookmarkItem } from '../bookmarkItem'
import type { SDKEvents } from '../types/sdk-events'

// FLM-189 decision 7: on a room without a bookmark, Off lasts for the session.
// It must not be kept as a saved choice that survives leaving the room and is
// then published by the automatic bookmark on the next join.
const ROOM = 'quiet@conference.example.org'

describe('room notification level through the store binding', () => {
  let muc: MUC
  let sendIQ: ReturnType<typeof vi.fn>
  const connection = {}

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
      stores: {
        get room() { return roomStore.getState() },
        connection: { getOwnNickname: () => null, getJid: () => 'user@example.com/resource' },
      },
      presence: createMockPresenceReader(),
      sendIQ,
      sendStanza: vi.fn(),
      emit: vi.fn(),
      emitSDK: <K extends keyof SDKEvents>(event: K, payload: SDKEvents[K]) => handlers.get(event)?.(payload),
      getCurrentJid: () => 'user@example.com/resource',
      getXmpp: () => connection,
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
    // The bookmark refresh on this connection returns the room: nothing from other clients
    sendIQ.mockResolvedValueOnce(parse(
      '<iq type="result"><pubsub xmlns="http://jabber.org/protocol/pubsub"><items node="urn:xmpp:bookmarks:1">' +
      `<item id="${ROOM}"><conference xmlns="urn:xmpp:bookmarks:1" name="Quiet"><nick>mynick</nick></conference></item>` +
      '</items></pubsub></iq>',
    ) as unknown as Element)
    await muc.fetchBookmarks()
    sendIQ.mockClear()

    await muc.setRoomNotifyLevel(ROOM, 'none', true)
    roomStore.getState().setRoomJoined(ROOM, false)
    roomStore.getState().setRoomJoined(ROOM, true)

    expect(level()).toBe('none')
    expect(sendIQ).toHaveBeenCalledOnce()
  })

  // A level chosen in the room header used to be written to the room's saved
  // fields before its bookmark publish. When the server refused the publish,
  // the header still showed it as saved, and the next bookmark save, such as
  // an Auto-join toggle, published it. The room now shows again what it had.
  describe('when the server refuses the bookmark save', () => {
    /** The room's bookmark item as the server stores it. */
    let stored: string
    /** How the server answers each next publish; it stores the item once the list is empty. */
    let publishAnswers: Array<'store' | 'refuse'>
    /** What ejabberd answers a publish whose options do not match the node. */
    const conflict = () => Object.assign(new Error('conflict'), { name: 'StanzaError', condition: 'conflict' })

    const bookmarkStoring = async (notify?: 'all' | 'none') => {
      stored = `<item id="${ROOM}"><conference xmlns="urn:xmpp:bookmarks:1" name="Quiet" autojoin="true"><nick>mynick</nick>` +
        (notify ? `<extensions><notify xmlns="urn:xmpp:fluux:0">${notify}</notify></extensions>` : '') +
        '</conference></item>'
      // The bookmark refresh on this connection returns the room
      await muc.fetchBookmarks()
    }

    beforeEach(() => {
      publishAnswers = []
      sendIQ.mockImplementation(async (iq: Element) => {
        const pubsub = iq.getChild('pubsub')
        if (pubsub?.getChild('items')) {
          return parse(`<iq type="result"><pubsub xmlns="http://jabber.org/protocol/pubsub"><items node="urn:xmpp:bookmarks:1">${stored}</items></pubsub></iq>`)
        }
        const item = pubsub?.getChild('publish')?.getChild('item')
        if (item) {
          if (publishAnswers.shift() === 'refuse') throw conflict()
          stored = item.toString()
        }
        return parse('<iq type="result"/>')
      })
    })

    const room = () => roomStore.getState().rooms.get(ROOM)!
    const storedBookmark = () => parseBookmarkItem(parse(stored) as unknown as Element)

    it.each(['all', 'none'] as const)('shows Mentions only again, not %s as saved', async (refusedLevel) => {
      await bookmarkStoring()
      publishAnswers = ['refuse']

      await expect(muc.setRoomNotifyLevel(ROOM, refusedLevel, true)).rejects.toThrow('conflict')

      expect(level()).toBe('mentions')
      expect(savedNotifyLevel(room())).toBe('mentions')
      expect(room()).toMatchObject({ notifyAll: undefined, notifyOff: undefined })
      expect(storedBookmark()?.notifyLevel).toBe('mentions')
    })

    it('keeps the saved All messages when Off is refused, and the next Auto-join toggle stores All messages', async () => {
      await bookmarkStoring('all')
      publishAnswers = ['refuse']

      await expect(muc.setRoomNotifyLevel(ROOM, 'none', true)).rejects.toThrow('conflict')
      expect(level()).toBe('all')
      expect(savedNotifyLevel(room())).toBe('all')

      // What the rooms list sends when Auto-join is toggled
      await muc.setBookmark(ROOM, { name: room().name, nick: room().nickname, autojoin: !room().autojoin })

      expect(storedBookmark()).toMatchObject({ autojoin: false, notifyLevel: 'all' })
    })

    it('shows again the session choice the room had before', async () => {
      await bookmarkStoring()
      await muc.setRoomNotifyLevel(ROOM, 'all', false)
      publishAnswers = ['refuse']

      await expect(muc.setRoomNotifyLevel(ROOM, 'none', true)).rejects.toThrow('conflict')

      expect(level()).toBe('all')
      expect(room()).toMatchObject({ notifyAll: true })
      expect(room().notifyOff).toBeFalsy()
      expect(savedNotifyLevel(room())).toBe('mentions')
    })

    it('does not bring that session choice back once the room is left', async () => {
      await bookmarkStoring()
      await muc.setRoomNotifyLevel(ROOM, 'all', false)
      publishAnswers = ['refuse']

      const off = muc.setRoomNotifyLevel(ROOM, 'none', true)
      // Left while the save is under way, which ends the session choice
      roomStore.getState().setRoomJoined(ROOM, false)

      await expect(off).rejects.toThrow('conflict')
      expect(room()).toMatchObject({ notifyAll: undefined, notifyOff: undefined })
      expect(level()).toBe('mentions')
    })

    it('shows the level as saved, in place of the session choice, once the bookmark stores it', async () => {
      await bookmarkStoring()
      await muc.setRoomNotifyLevel(ROOM, 'none', false)

      await muc.setRoomNotifyLevel(ROOM, 'all', true)

      expect(room()).toMatchObject({ notifyAll: undefined, notifyOff: undefined, notifyAllPersistent: true })
      expect(level()).toBe('all')
      expect(storedBookmark()?.notifyLevel).toBe('all')
    })

    // Off for the session first; a saved level the bookmark stores replaces it.
    it.each([
      ['refused', 'stored', 'none', 'none'],
      ['stored', 'refused', 'all', 'all'],
      ['refused', 'refused', 'mentions', 'none'],
    ] as const)('saves All messages %s and Off, chosen before it answered, %s: stores %s and applies %s', async (first, second, stored, applied) => {
      await bookmarkStoring()
      await muc.setRoomNotifyLevel(ROOM, 'none', false)
      const answer = (outcome: 'refused' | 'stored') => (outcome === 'refused' ? 'refuse' : 'store')
      publishAnswers = [answer(first), answer(second)]

      const results = await Promise.allSettled([
        muc.setRoomNotifyLevel(ROOM, 'all', true),
        muc.setRoomNotifyLevel(ROOM, 'none', true),
      ])

      expect(results.map((r) => r.status)).toEqual([first, second].map((o) => (o === 'refused' ? 'rejected' : 'fulfilled')))
      expect(storedBookmark()?.notifyLevel).toBe(stored)
      expect(savedNotifyLevel(room())).toBe(stored)
      expect(level()).toBe(applied)
    })
  })
})
