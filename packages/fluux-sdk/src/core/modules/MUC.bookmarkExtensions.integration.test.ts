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
import { NS_BOOKMARKS, NS_FLUUX } from '../namespaces'
import type { SDKEvents } from '../types/sdk-events'

// XEP-0402 §3.4: clients MUST preserve any XML elements they do not understand
// within a bookmark's <extensions/>. A publish replaces the stored item, so
// before this, renaming a bookmark, toggling autojoin, saving a learned
// password or changing Fluux's own notify level deleted every extension
// another client of the account had stored for the room.
const OWN_JID = 'tester@localhost/fluux'
const ROOM = 'team@conference.localhost'

// XEP-0402's Example 5 client state, and an XEP-0492 notification setting.
const CLIENT_STATE = '<state xmlns="http://myclient.example/bookmark/state" minimized="true"/>'
const NOTIFICATION_SETTINGS = '<notify xmlns="urn:xmpp:notification-settings:1"><never/></notify>'

const bookmarkItem = (extensions: string) =>
  `<item id="${ROOM}"><conference xmlns="${NS_BOOKMARKS}" name="Team" autojoin="true">` +
  `<nick>tester</nick><extensions>${extensions}</extensions></conference></item>`

/** The server's answer to Fluux's bookmark fetch. */
const fetchResult = (extensions: string) => parse(
  `<iq type="result" from="tester@localhost" to="${OWN_JID}">` +
  `<pubsub xmlns="http://jabber.org/protocol/pubsub"><items node="${NS_BOOKMARKS}">${bookmarkItem(extensions)}</items></pubsub></iq>`,
) as unknown as Element

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

  /** The <extensions> children of the last bookmark Fluux published, split by owner. */
  const published = () => {
    const iq = sendIQ.mock.calls[sendIQ.mock.calls.length - 1]![0] as Element
    const extensions = iq.getChild('pubsub')?.getChild('publish')?.getChild('item')
      ?.getChild('conference', NS_BOOKMARKS)?.getChild('extensions')
    const children = (extensions?.children ?? []).filter((c): c is Element => typeof c !== 'string')
    return {
      foreign: children.filter((c) => !c.is('notify', NS_FLUUX)).map(String),
      fluuxNotify: children.filter((c) => c.is('notify', NS_FLUUX)).map((c) => c.getText()),
    }
  }

  it('publishes the other clients\' extensions unchanged when the bookmark is renamed', async () => {
    await muc.fetchBookmarks()

    await muc.setBookmark(ROOM, { name: 'Team renamed', nick: 'tester', autojoin: true })

    expect(published().foreign).toEqual([CLIENT_STATE, NOTIFICATION_SETTINGS])
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
