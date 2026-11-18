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
import { parseBookmarkItem } from '../bookmarkItem'
import { resolveNotifyLevel } from '../notifyLevel'

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

/** A stored bookmark with a password and Fluux's own level beside the other extensions. */
const fullItem = ({ extensions, password, notify }: { extensions: string; password?: string; notify?: string }) =>
  `<item id="${ROOM}"><conference xmlns="${NS_BOOKMARKS}" name="Team" autojoin="true"><nick>tester</nick>` +
  (password ? `<password>${password}</password>` : '') +
  `<extensions>${notify ? `<notify xmlns="${NS_FLUUX}">${notify}</notify>` : ''}${extensions}</extensions></conference></item>`

/** Fluux's copy, from a refresh on an earlier connection. */
const OLDER = { extensions: CLIENT_STATE, password: 'old-secret' }
/** What another app stored afterwards, while Fluux was away. */
const NEWER_STATE = '<state xmlns="http://myclient.example/bookmark/state" minimized="false"/>'
const NEWER = { extensions: NEWER_STATE, password: 'new-secret', notify: 'all' }

const isItemRead = (iq: Element) => !!iq.getChild('pubsub')?.getChild('items')
const isAllItemsRead = (iq: Element) => isItemRead(iq) && !iq.getChild('pubsub')?.getChild('items')?.getChild('item')

describe('bookmark extensions Fluux does not own', () => {
  let muc: MUC
  let pubsub: PubSub
  let sendIQ: ReturnType<typeof vi.fn>
  let serverItem: Element
  /** The connection Fluux is on; each connection attempt has its own. */
  let connection: object
  /** The account Fluux is signed in to. */
  let currentJid: string

  beforeEach(() => {
    roomStore.setState(roomStore.getInitialState(), true)
    connection = {}
    currentJid = OWN_JID

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
      getCurrentJid: () => currentJid,
      getXmpp: () => connection,
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

  /** The bookmark Fluux published last, as the server reads it. */
  const publishedConference = () => {
    const sent = sendIQ.mock.calls[sendIQ.mock.calls.length - 1]![0] as Element
    return (parse(sent.toString()) as unknown as Element).getChild('pubsub')?.getChild('publish')
      ?.getChild('item')?.getChild('conference', NS_BOOKMARKS)
  }

  /** What Fluux sent since the last clear, in order: a read of the stored bookmark, or a publish. */
  const sentKinds = () => sendIQ.mock.calls.flatMap(([iq]) => {
    const sent = iq as Element
    const request = sent.getChild('pubsub')
    if (!request) return []
    if (request.getChild('publish')) return ['publish']
    if (request.getChild('retract')) return ['remove']
    return isAllItemsRead(sent) ? ['refresh'] : ['read']
  })

  /** The room's answer to Fluux's own join: Fluux is in the room. */
  const selfPresence = () => parse(
    `<presence from="${ROOM}/tester" to="${OWN_JID}"><x xmlns="http://jabber.org/protocol/muc#user">` +
    '<item affiliation="member" role="participant"/><status code="110"/></x></presence>',
  ) as unknown as Element

  /** A new connection attempt: a page reload, or a reconnection, resumed or not. */
  const reconnect = () => { connection = {} }

  /** The server answers bookmark publishes, and fails every read the test names. */
  const failReads = (which: (iq: Element) => boolean) => {
    sendIQ.mockImplementation(async (iq: Element) => {
      if (isItemRead(iq) && which(iq)) throw new Error('timeout')
      return isItemRead(iq) ? serverItem : parse('<iq type="result"/>')
    })
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

  // A copy Fluux holds can be older than the stored bookmark after a page
  // reload or a reconnection: the snapshot predates changes made elsewhere, and
  // a resumed stream delivers again events Fluux already handled. Only the
  // connection's own bookmark refresh, or Fluux's own save on it, shows the
  // copy is current.
  describe('after a reconnection or a page reload', () => {
    beforeEach(async () => {
      serverItem = fetchResult('', fullItem(OLDER))
      await muc.fetchBookmarks()
      reconnect()
      serverItem = fetchResult('', fullItem(NEWER))
      sendIQ.mockClear()
    })

    it('keeps what another app stored while Fluux was away when the bookmark refresh fails', async () => {
      failReads(isAllItemsRead)
      await muc.fetchBookmarks()
      expect(roomStore.getState().getRoom(ROOM)?.password).toBe('old-secret')

      // Toggling autojoin from the room menu names nothing else.
      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })

      expect(sentKinds()).toEqual(['refresh', 'read', 'publish'])
      expect(published()).toEqual({ foreign: [NEWER_STATE], fluuxNotify: ['all'] })
      expect(publishedConference()?.getChildText('password')).toBe('new-secret')
      expect(roomStore.getState().getRoom(ROOM)).toMatchObject({ password: 'new-secret', notifyAllPersistent: true, bookmarkExtensions: [NEWER_STATE] })
    })

    it('reads the stored bookmark when a resumed stream delivered an older version again and no refresh ran', async () => {
      // A short resume skips the refresh. The server sends again a bookmark
      // event Fluux had handled, older than what it stores now.
      pubsub.handle(pepEvent(fullItem(OLDER)))

      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })

      expect(sentKinds()).toEqual(['read', 'publish'])
      expect(published()).toEqual({ foreign: [NEWER_STATE], fluuxNotify: ['all'] })
      expect(publishedConference()?.getChildText('password')).toBe('new-secret')
    })

    it('keeps the stored password when the notification level changes', async () => {
      failReads(isAllItemsRead)
      await muc.fetchBookmarks()

      await muc.setRoomNotifyLevel(ROOM, 'none', true)

      expect(sentKinds()).toEqual(['refresh', 'read', 'publish'])
      expect(published()).toEqual({ foreign: [NEWER_STATE], fluuxNotify: ['none'] })
      expect(publishedConference()?.getChildText('password')).toBe('new-secret')
    })

    it('publishes nothing when the bookmark refresh and the read both fail', async () => {
      failReads(() => true)
      await muc.fetchBookmarks()

      await expect(muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })).rejects.toThrow('timeout')

      expect(sentKinds()).toEqual(['refresh', 'read'])
    })

    it('reads while the refresh has not answered, and trusts Fluux\'s copy once it has', async () => {
      let answerRefresh!: () => void
      sendIQ.mockImplementation((iq: Element) => {
        if (isAllItemsRead(iq)) return new Promise((resolve) => { answerRefresh = () => resolve(serverItem) })
        return Promise.resolve(isItemRead(iq) ? serverItem : parse('<iq type="result"/>'))
      })
      const refresh = muc.fetchBookmarks()

      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })
      expect(sentKinds()).toEqual(['refresh', 'read', 'publish'])

      answerRefresh()
      await refresh
      sendIQ.mockClear()
      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: true })

      expect(sentKinds()).toEqual(['publish'])
      expect(published()).toEqual({ foreign: [NEWER_STATE], fluuxNotify: ['all'] })
    })

    it('publishes from Fluux\'s copy without a read once this connection\'s refresh answered', async () => {
      await muc.fetchBookmarks()
      sendIQ.mockClear()

      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })

      expect(sentKinds()).toEqual(['publish'])
      expect(published()).toEqual({ foreign: [NEWER_STATE], fluuxNotify: ['all'] })
      expect(publishedConference()?.getChildText('password')).toBe('new-secret')
    })

    it('reads only before the first save of a room when the refresh failed', async () => {
      failReads(isAllItemsRead)
      await muc.fetchBookmarks()

      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })
      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: true })

      expect(sentKinds()).toEqual(['refresh', 'read', 'publish', 'publish'])
      expect(published()).toEqual({ foreign: [NEWER_STATE], fluuxNotify: ['all'] })
    })

    it('reads a room the refresh did not return', async () => {
      const OTHER = 'other@conference.localhost'
      sendIQ.mockImplementation(async (iq: Element) => {
        if (isAllItemsRead(iq)) {
          return fetchResult('', `<item id="${OTHER}"><conference xmlns="${NS_BOOKMARKS}" name="Other"/></item>`)
        }
        return isItemRead(iq) ? serverItem : parse('<iq type="result"/>')
      })
      await muc.fetchBookmarks()

      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: true })

      expect(sentKinds()).toEqual(['refresh', 'read', 'publish'])
      expect(published().foreign).toEqual([NEWER_STATE])
    })

    it('confirms nothing with a refresh that answers after Fluux moved to another connection', async () => {
      let answerRefresh!: () => void
      sendIQ.mockImplementation((iq: Element) => {
        if (isAllItemsRead(iq)) return new Promise((resolve) => { answerRefresh = () => resolve(serverItem) })
        return Promise.resolve(isItemRead(iq) ? serverItem : parse('<iq type="result"/>'))
      })
      const refresh = muc.fetchBookmarks()
      reconnect()
      answerRefresh()
      await refresh
      sendIQ.mockClear()

      await muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })

      expect(sentKinds()).toEqual(['read', 'publish'])
    })

    // Two saves of the room started while the first read of the stored
    // bookmark is unanswered: before the fix both read the same bookmark, so
    // the second published it over the first one's change.
    describe('when a second save starts before the first read answers', () => {
      /** The stored bookmark as the server keeps it across reads, publishes and removals. */
      let stored: string | null
      /** Reads of the stored bookmark the test has not answered yet, oldest first. */
      let unansweredReads: Array<{ answer: () => void; fail: () => void }>
      /** When set, the server holds its answer to a removal until the test lets it through. */
      let holdRemovals: boolean
      let unansweredRemovals: Array<() => void>

      beforeEach(async () => {
        stored = fullItem(NEWER)
        unansweredReads = []
        holdRemovals = false
        unansweredRemovals = []
        sendIQ.mockImplementation((iq: Element) => {
          if (isAllItemsRead(iq)) return Promise.reject(new Error('timeout'))
          if (isItemRead(iq)) {
            // The server handles requests in the order they arrive: a read
            // answers with the bookmark stored when it was sent, even if the
            // test lets the answer through later.
            const storedWhenSent = stored
            return new Promise((resolve, reject) => {
              unansweredReads.push({
                answer: () => resolve(fetchResult('', storedWhenSent ?? '')),
                fail: () => reject(new Error('timeout')),
              })
            })
          }
          const request = iq.getChild('pubsub')
          const item = request?.getChild('publish')?.getChild('item')
          if (item) stored = item.toString()
          if (request?.getChild('retract')) {
            stored = null
            if (holdRemovals) {
              return new Promise((resolve) => { unansweredRemovals.push(() => resolve(parse('<iq type="result"/>'))) })
            }
          }
          return Promise.resolve(parse('<iq type="result"/>'))
        })
        // The refresh on this connection fails.
        await muc.fetchBookmarks()
      })

      /** Let every save that can move on do so, up to its next unanswered request. */
      const settleTurn = () => new Promise((resolve) => setTimeout(resolve, 0))

      /**
       * Answer the reads one at a time, oldest first, each only once every
       * save started has sent what it can, until the given saves finish.
       * Returns the most reads that were waiting at once.
       */
      const answerReadsUntilDone = async (...saves: Array<Promise<unknown>>) => {
        let done = false
        void Promise.allSettled(saves).then(() => { done = true })
        let mostUnanswered = 0
        while (!done) {
          await settleTurn()
          mostUnanswered = Math.max(mostUnanswered, unansweredReads.length)
          unansweredReads.shift()?.answer()
        }
        await settleTurn()
        return mostUnanswered
      }

      const storedBookmark = () => (stored ? parseBookmarkItem(parse(stored) as unknown as Element) : null)

      it('keeps Off chosen just before an autojoin toggle', async () => {
        const off = muc.setRoomNotifyLevel(ROOM, 'none', true)
        const toggle = muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })

        const mostUnanswered = await answerReadsUntilDone(off, toggle)

        await expect(Promise.all([off, toggle])).resolves.toBeDefined()
        expect(storedBookmark()).toMatchObject({
          autojoin: false, notifyLevel: 'none', password: 'new-secret', extensions: [NEWER_STATE],
        })
        expect(roomStore.getState().getRoom(ROOM)).toMatchObject({ autojoin: false, notifyOffPersistent: true })
        // Only the first save reads: the toggle waits for it, then trusts the copy it saved.
        expect(mostUnanswered).toBe(1)
        expect(sentKinds()).toEqual(['refresh', 'read', 'publish', 'publish'])
      })

      it('keeps an autojoin toggle made just before a notification change', async () => {
        const toggle = muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })
        const off = muc.setRoomNotifyLevel(ROOM, 'none', true)

        await answerReadsUntilDone(toggle, off)

        expect(storedBookmark()).toMatchObject({ autojoin: false, notifyLevel: 'none', password: 'new-secret' })
        expect(sentKinds()).toEqual(['refresh', 'read', 'publish', 'publish'])
      })

      it('keeps Off chosen just before the password learned on join is saved', async () => {
        const off = muc.setRoomNotifyLevel(ROOM, 'none', true)
        await muc.joinRoom(ROOM, 'tester', { password: 'learned' })
        muc.handle(selfPresence())

        await answerReadsUntilDone(off)

        expect(storedBookmark()).toMatchObject({ notifyLevel: 'none', password: 'learned', extensions: [NEWER_STATE] })
        expect(sentKinds()).toEqual(['refresh', 'read', 'publish', 'publish'])
      })

      it('removes the bookmark when the removal follows a save still reading', async () => {
        const toggle = muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })
        const remove = muc.removeBookmark(ROOM)

        await answerReadsUntilDone(toggle, remove)

        expect(stored).toBeNull()
        expect(sentKinds()).toEqual(['refresh', 'read', 'publish', 'remove'])
        // A room Fluux is not in leaves the store with its bookmark.
        expect(roomStore.getState().getRoom(ROOM)?.isBookmarked).toBeFalsy()
      })

      it('runs the next save of the room when the one before it fails', async () => {
        const failing = muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })
        const next = muc.setRoomNotifyLevel(ROOM, 'none', true)
        await settleTurn()
        expect(unansweredReads).toHaveLength(1)
        unansweredReads.shift()!.fail()
        await expect(failing).rejects.toThrow('timeout')

        await answerReadsUntilDone(next)

        await expect(next).resolves.toBeUndefined()
        expect(sentKinds()).toEqual(['refresh', 'read', 'read', 'publish'])
        expect(storedBookmark()).toMatchObject({ autojoin: true, notifyLevel: 'none', password: 'new-secret' })
      })

      it('keeps Off for the session when a removal queued before it wins', async () => {
        roomStore.getState().setRoomJoined(ROOM, true)
        holdRemovals = true
        const remove = muc.removeBookmark(ROOM)
        // Chosen while the removal waits for its answer: the room still shows as bookmarked.
        const off = muc.setRoomNotifyLevel(ROOM, 'none', true)
        await settleTurn()
        unansweredRemovals.shift()!()

        await expect(Promise.all([remove, off])).resolves.toBeDefined()
        expect(stored).toBeNull()
        expect(sentKinds()).toEqual(['refresh', 'remove'])
        const room = roomStore.getState().getRoom(ROOM)
        expect(room?.isBookmarked).toBe(false)
        expect(resolveNotifyLevel(room)).toBe('none')
        expect(room).toMatchObject({ notifyOff: true })
        expect(room?.notifyOffPersistent).toBeFalsy()
      })

      it('does not save a learned password into a bookmark a queued removal took away', async () => {
        holdRemovals = true
        const remove = muc.removeBookmark(ROOM)
        await muc.joinRoom(ROOM, 'tester', { password: 'learned' })
        muc.handle(selfPresence())
        // The join learned the password, so Fluux queued its save.
        expect(roomStore.getState().getRoom(ROOM)?.password).toBe('learned')
        unansweredRemovals.shift()!()
        await remove
        await settleTurn()

        expect(stored).toBeNull()
        expect(sentKinds()).toEqual(['refresh', 'remove'])
      })
    })

    // A bookmark request can stay unanswered past a disconnection: the writes
    // queued behind it belong to the account that asked for them, never to
    // the one signed in when their turn comes.
    describe('when another account signs in while a bookmark request is unanswered', () => {
      let unansweredReads: Array<{ answer: () => void; fail: () => void }>

      beforeEach(async () => {
        unansweredReads = []
        sendIQ.mockImplementation((iq: Element) => {
          if (isAllItemsRead(iq)) return Promise.reject(new Error('timeout'))
          if (isItemRead(iq)) {
            const answer = serverItem
            return new Promise((resolve, reject) => {
              unansweredReads.push({ answer: () => resolve(answer), fail: () => reject(new Error('timeout')) })
            })
          }
          return Promise.resolve(parse('<iq type="result"/>'))
        })
        await muc.fetchBookmarks()
      })

      /** Disconnect, then sign in to another account with its own connection. */
      const switchAccount = () => {
        connection = {}
        currentJid = 'someone-else@localhost/fluux'
      }

      it.each([
        ['fails', 'fail'],
        ['answers', 'answer'],
      ] as const)('sends nothing to the new account when the old request then %s', async (_, outcome) => {
        const toggle = muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: false })
        const typedPassword = muc.setBookmark(ROOM, { name: 'Team', nick: 'tester', autojoin: true, password: 'typed-secret' })
        const remove = muc.removeBookmark(ROOM)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(unansweredReads).toHaveLength(1)
        const before = roomStore.getState().getRoom(ROOM)

        switchAccount()
        sendIQ.mockClear()
        unansweredReads.shift()![outcome]()
        const results = await Promise.allSettled([toggle, typedPassword, remove])

        // Nothing reaches the new account's connection, and its store is untouched.
        expect(sentKinds()).toEqual([])
        expect(roomStore.getState().getRoom(ROOM)).toBe(before)
        expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected'])
        const reasons = results.map((r) => (r as PromiseRejectedResult).reason as Error)
        expect(reasons.slice(1).map((e) => e.name)).toEqual(['AbortError', 'AbortError'])
        expect(reasons[0]!.name).toBe(outcome === 'fail' ? 'Error' : 'AbortError')
      })
    })
  })
})
