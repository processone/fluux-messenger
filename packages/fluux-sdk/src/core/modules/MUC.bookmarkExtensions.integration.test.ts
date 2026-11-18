import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parse } from 'ltx'
import type { Element } from '@xmpp/client'
import { MUC } from './MUC'
import { PubSub } from './PubSub'
import type { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createStoreBindings, type StoreRefs } from '../../bindings/storeBindings'
import { roomStore } from '../../stores/roomStore'
import { createMockPresenceReader, createMockStoreRefs } from '../test-utils'
import { StateSnapshot } from './stateSnapshot'
import type { StorageAdapter } from '../types/storage'
import { NS_BOOKMARKS, NS_FLUUX } from '../namespaces'
import type { SDKEvents } from '../types/sdk-events'

// XEP-0402 §3.4: clients MUST preserve any XML elements they do not understand
// within a bookmark's <extensions/>. A publish replaces the stored item, so
// before this, renaming a bookmark, toggling autojoin, saving a learned
// password or changing Fluux's own notify level deleted every extension
// another client of the account had stored for the room.
const OWN_JID = 'tester@localhost/fluux'
const ACCOUNT = 'tester@localhost'
const ROOM = 'team@conference.localhost'

// XEP-0402's Example 5 client state, and an XEP-0492 notification setting.
const CLIENT_STATE = '<state xmlns="http://myclient.example/bookmark/state" minimized="true"/>'
const NOTIFICATION_SETTINGS = '<notify xmlns="urn:xmpp:notification-settings:1"><never/></notify>'

const bookmarkItem = (extensions: string) =>
  `<item id="${ROOM}"><conference xmlns="${NS_BOOKMARKS}" name="Team" autojoin="true">` +
  `<nick>tester</nick><extensions>${extensions}</extensions></conference></item>`

/** The server's answer to a bookmark read: every bookmark, or the one item asked for. */
const fetchResult = (extensions: string, item = bookmarkItem(extensions)) => parse(
  `<iq type="result" from="${ACCOUNT}" to="${OWN_JID}">` +
  `<pubsub xmlns="http://jabber.org/protocol/pubsub"><items node="${NS_BOOKMARKS}">${item}</items></pubsub></iq>`,
) as unknown as Element

/** The room as a snapshot written by a Fluux version that did not keep extensions holds it. */
const preChangeSnapshotRoom = {
  jid: ROOM, name: 'Team', nickname: 'tester', joined: false, occupants: [],
  unreadCount: 0, mentionsCount: 0, isBookmarked: true, autojoin: true, messages: [],
}

const isPublish = (iq: Element) => !!iq.getChild('pubsub')?.getChild('publish')

/** A PEP notification another client's publish or retraction triggers. */
const pepEvent = (itemsContent: string) => parse(
  `<message from="tester@localhost" to="${OWN_JID}" type="headline">` +
  `<event xmlns="http://jabber.org/protocol/pubsub#event"><items node="${NS_BOOKMARKS}">${itemsContent}</items></event></message>`,
) as unknown as Element

describe('bookmark extensions Fluux does not own', () => {
  let muc: MUC
  let pubsub: PubSub
  let sendIQ: ReturnType<typeof vi.fn>
  let serverItem: Element

  beforeEach(() => {
    roomStore.setState(roomStore.getInitialState(), true)

    const handlers = new Map<string, (payload: unknown) => void>()
    const source = {
      subscribe: (event: string, handler: (payload: unknown) => void) => { handlers.set(event, handler); return () => handlers.delete(event) },
    }
    const refs = createMockStoreRefs()
    createStoreBindings(source as never, () => ({ ...refs, room: roomStore.getState() }) as unknown as StoreRefs)

    serverItem = fetchResult(`${CLIENT_STATE}${NOTIFICATION_SETTINGS}`)
    sendIQ = vi.fn(async (iq: Element) =>
      iq.getChild('pubsub')?.getChild('items') ? serverItem : parse('<iq type="result"/>'))
    const deps = {
      stores: {
        get room() { return roomStore.getState() },
        connection: { getOwnNickname: () => null, getJid: () => OWN_JID },
      },
      presence: createMockPresenceReader(),
      sendIQ,
      sendStanza: vi.fn(),
      emit: vi.fn(),
      emitSDK: <K extends keyof SDKEvents>(event: K, payload: SDKEvents[K]) => handlers.get(event)?.(payload),
      getCurrentJid: () => OWN_JID,
    } as unknown as ModuleDependencies
    muc = new MUC(deps, { forceCatchUpAllRooms: vi.fn() } as unknown as MAM)
    pubsub = new PubSub(deps)
  })

  /** The <extensions> children of the last bookmark Fluux published, as the server reads them. */
  const publishedChildren = () => {
    const sent = sendIQ.mock.calls[sendIQ.mock.calls.length - 1]![0] as Element
    const iq = parse(sent.toString()) as unknown as Element
    const extensions = iq.getChild('pubsub')?.getChild('publish')?.getChild('item')
      ?.getChild('conference', NS_BOOKMARKS)?.getChild('extensions')
    return (extensions?.children ?? []).filter((c): c is Element => typeof c !== 'string')
  }

  /** The same children, split by owner. */
  const published = () => {
    const children = publishedChildren()
    return {
      foreign: children.filter((c) => !c.is('notify', NS_FLUUX)).map(String),
      fluuxNotify: children.filter((c) => c.is('notify', NS_FLUUX)).map((c) => c.getText()),
    }
  }

  /** Restore the stores from a snapshot an older Fluux wrote, as a page reload does. */
  const hydratePreChangeSnapshot = async () => {
    const storageAdapter = { getRooms: vi.fn(async () => [preChangeSnapshotRoom]) } as unknown as StorageAdapter
    await new StateSnapshot({ storageAdapter, getJid: () => ACCOUNT }).hydrate(ACCOUNT)
    const restored = roomStore.getState().getRoom(ROOM)
    expect(restored?.isBookmarked).toBe(true)
    expect(restored?.bookmarkExtensions).toBeUndefined()
  }

  it('publishes the other clients\' extensions unchanged when the bookmark is renamed', async () => {
    await muc.fetchBookmarks()

    await muc.setBookmark(ROOM, { name: 'Team renamed', nick: 'tester', autojoin: true })

    expect(published().foreign).toEqual([CLIENT_STATE, NOTIFICATION_SETTINGS])
  })

  it('keeps the namespaces another client\'s extensions inherit when the bookmark is renamed', async () => {
    // A default namespace and a prefix used only in an attribute value, both
    // declared above <extensions> rather than on the extensions themselves.
    serverItem = fetchResult('', `<item id="${ROOM}">` +
      `<b:conference xmlns:b="${NS_BOOKMARKS}" xmlns="urn:example:client" xmlns:q="urn:example:quiet" name="Team" autojoin="true">` +
      '<b:nick>tester</b:nick><b:extensions><state minimized="true"/><setting level="q:never"/></b:extensions></b:conference></item>')
    await muc.fetchBookmarks()

    await muc.setBookmark(ROOM, { name: 'Team renamed', nick: 'tester', autojoin: true })

    const [state, setting] = publishedChildren() as Array<Element & { findNS(prefix: string): string | undefined }>
    expect(state!.is('state', 'urn:example:client')).toBe(true)
    expect(state!.attrs.minimized).toBe('true')
    expect(setting!.is('setting', 'urn:example:client')).toBe(true)
    expect(setting!.findNS('q')).toBe('urn:example:quiet')
  })

  it('reads the bookmark before the first save after a reload from an older snapshot, while the bookmark refresh has not answered', async () => {
    await hydratePreChangeSnapshot()

    await muc.setBookmark(ROOM, { name: 'Team renamed', nick: 'tester', autojoin: true })

    expect(published().foreign).toEqual([CLIENT_STATE, NOTIFICATION_SETTINGS])
  })

  it('publishes nothing when that read fails, so the save cannot delete what it did not see', async () => {
    await hydratePreChangeSnapshot()
    sendIQ.mockImplementation(async (iq: Element) => {
      if (iq.getChild('pubsub')?.getChild('items')) throw new Error('timeout')
      return parse('<iq type="result"/>')
    })

    await expect(muc.setBookmark(ROOM, { name: 'Team renamed', nick: 'tester', autojoin: true })).rejects.toThrow('timeout')

    expect(sendIQ.mock.calls.map(([iq]) => iq as Element).filter(isPublish)).toEqual([])
  })

  it('replaces only Fluux\'s own notify element when the level changes', async () => {
    serverItem = fetchResult(`${CLIENT_STATE}<notify xmlns="${NS_FLUUX}">all</notify>`)
    await muc.fetchBookmarks()

    await muc.setRoomNotifyLevel(ROOM, 'none', true)
    expect(published()).toEqual({ foreign: [CLIENT_STATE], fluuxNotify: ['none'] })

    await muc.setRoomNotifyLevel(ROOM, 'mentions', true)
    expect(published()).toEqual({ foreign: [CLIENT_STATE], fluuxNotify: [] })
  })

  it('publishes what another client stored last, not an earlier copy', async () => {
    await muc.fetchBookmarks()
    const changedState = '<state xmlns="http://myclient.example/bookmark/state" minimized="false"/>'
    pubsub.handle(pepEvent(bookmarkItem(changedState)))

    await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })

    expect(published().foreign).toEqual([changedState])
  })

  it('forgets the extensions of a bookmark deleted elsewhere, so bookmarking the room again starts clean', async () => {
    await muc.fetchBookmarks()
    roomStore.getState().setRoomJoined(ROOM, true)
    pubsub.handle(pepEvent(`<retract id="${ROOM}"/>`))

    await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: true })

    expect(published().foreign).toEqual([])
  })
})
