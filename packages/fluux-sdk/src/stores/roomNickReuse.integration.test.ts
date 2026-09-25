/**
 * A reused MUC nick after a retraction, driven through the whole SDK path:
 * wire stanza → Chat module → SDK event → store binding → room store → cache.
 *
 * XEP-0421 lets a room hand a nick to a new occupant once its owner leaves.
 * Alice writes a message, retracts it and leaves; Bob takes the freed nick and
 * writes a message whose client id collides with Alice's. The two now share a
 * room, a `from` and a client id — the `from+id` rung of the identity ladder —
 * and only the surrounding evidence (XEP-0421 occupant ids, XEP-0359 archive
 * ids) can tell them apart. Bob's message must display normally: it is not a
 * copy of the message Alice deleted.
 *
 * The cases run the same script under every combination of evidence so the
 * rule for when the `from+id` rung stops being authoritative is stated by the
 * data, not implied by a single fixture. Where occupant ids or archive ids
 * disagree, that disagreement separates the two. Where neither exists, the
 * delivery channel does: Bob's message is a first delivery, and a tombstone
 * cannot absorb one (docs/MESSAGE_IDENTIFIERS.md §3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

import { XMPPClient, bindStoresForTesting } from '../core/XMPPClient'
import { createMockXmppClient, createMockElement, type MockXmppClient } from '../core/test-utils'
import { createDefaultStoreBindings } from '../core/defaultStoreBindings'
import {
  NS_FALLBACK,
  NS_MUC_USER,
  NS_OCCUPANT_ID,
  NS_RETRACT,
  NS_STANZA_ID,
} from '../core/namespaces'
import { chatStore } from './chatStore'
import { connectionStore } from './connectionStore'
import { rosterStore } from './rosterStore'
import { roomStore } from './roomStore'
import { createRoom, roomWindow, seedRoomWindow } from './roomStore.testHelpers'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import { _clearRetractedIdentitiesForTesting } from '../utils/retractedIdentities'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'

let mockXmppClientInstance: MockXmppClient

vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

import { client as xmppClientFactory } from '@xmpp/client'

const ME = 'me@example.com'
const ROOM = 'team@conference.example.com'
const NICK = 'alice'
const FROM = `${ROOM}/${NICK}`
/** The client id both occupants issue. Client ids carry no uniqueness guarantee. */
const SHARED_ID = 'client-7'
const ALICE_BODY = 'alice wrote this and deleted it'
const BOB_BODY = 'bob wrote this and never deleted it'

type MockChild = { name: string; attrs?: Record<string, string>; text?: string; children?: MockChild[] }

function occupantIdChild(occupantId: string | undefined): MockChild[] {
  return occupantId ? [{ name: 'occupant-id', attrs: { xmlns: NS_OCCUPANT_ID, id: occupantId } }] : []
}

function groupchat(body: string, evidence: { occupantId?: string; stanzaId?: string; delayed?: boolean }) {
  const children: MockChild[] = [
    { name: 'body', text: body },
    ...occupantIdChild(evidence.occupantId),
    ...(evidence.stanzaId ? [{ name: 'stanza-id', attrs: { xmlns: NS_STANZA_ID, by: ROOM, id: evidence.stanzaId } }] : []),
    // XEP-0045 §7.2.15: discussion history carries a XEP-0203 delay stamp.
    ...(evidence.delayed ? [{ name: 'delay', attrs: { xmlns: 'urn:xmpp:delay', from: ROOM, stamp: new Date(Date.now() - 120_000).toISOString() } }] : []),
  ]
  return createMockElement('message', { from: FROM, to: ME, type: 'groupchat', id: SHARED_ID }, children)
}

/** XEP-0424: the sender names the message by its archive id when it has one, else by client id. */
function retraction(reference: string, occupantId: string | undefined) {
  const children: MockChild[] = [
    { name: 'retract', attrs: { xmlns: NS_RETRACT, id: reference } },
    { name: 'body', text: 'This person attempted to retract a previous message' },
    { name: 'fallback', attrs: { xmlns: NS_FALLBACK, for: NS_RETRACT } },
    ...occupantIdChild(occupantId),
  ]
  return createMockElement('message', { from: FROM, to: ME, type: 'groupchat', id: 'retraction-1' }, children)
}

function occupantPresence(type: 'available' | 'unavailable', occupantId: string | undefined) {
  const children: MockChild[] = [
    { name: 'x', attrs: { xmlns: NS_MUC_USER }, children: [{ name: 'item', attrs: { affiliation: 'member', role: 'participant' } }] },
    ...occupantIdChild(occupantId),
  ]
  return createMockElement('presence', { from: FROM, to: ME, ...(type === 'unavailable' ? { type } : {}) }, children)
}

/**
 * Let the stores' fire-and-forget durable writes settle. A retraction resolves
 * through several sequential IndexedDB round trips, and fake-indexeddb completes
 * each on a macrotask, so this drains macrotasks rather than microtasks.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

interface Evidence {
  /** XEP-0421 occupant ids the room stamps on each occupant's message. */
  alice: string | undefined
  bob: string | undefined
  /** XEP-0359 archive ids the room's MAM stamps on each message. */
  aliceArchive: string | undefined
  bobArchive: string | undefined
  /** Alice's message reached this client through discussion history: the client joined after it. */
  aliceViaHistory?: boolean
}

const cases: Array<{ name: string } & Evidence> = [
  {
    name: 'occupant ids and archive ids on both messages',
    alice: 'occ-alice', bob: 'occ-bob', aliceArchive: 'archive-alice', bobArchive: 'archive-bob',
  },
  {
    name: 'occupant ids on both, no archive ids (room without MAM)',
    alice: 'occ-alice', bob: 'occ-bob', aliceArchive: undefined, bobArchive: undefined,
  },
  {
    name: 'archive ids on both, no occupant ids (room without XEP-0421)',
    alice: undefined, bob: undefined, aliceArchive: 'archive-alice', bobArchive: 'archive-bob',
  },
  {
    name: 'no occupant ids and no archive ids on either message',
    alice: undefined, bob: undefined, aliceArchive: undefined, bobArchive: undefined,
  },
  {
    name: 'occupant id on Bob only, no archive ids',
    alice: undefined, bob: 'occ-bob', aliceArchive: undefined, bobArchive: undefined,
  },
  {
    name: 'occupant id on Alice only, no archive ids',
    alice: 'occ-alice', bob: undefined, aliceArchive: undefined, bobArchive: undefined,
  },
  {
    name: 'late joiner: Alice\'s message came through history, no ids on either',
    alice: undefined, bob: undefined, aliceArchive: undefined, bobArchive: undefined, aliceViaHistory: true,
  },
]

describe('a reused nick after a retraction, through the live room path', () => {
  let xmppClient: XMPPClient

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory()
    localStorageMock.clear()
    _resetStorageScopeForTesting()
    messageCache._resetDBForTesting()
    searchIndex._resetDBForTesting()
    _clearRetractedIdentitiesForTesting()
    chatStore.getState().reset()
    connectionStore.getState().reset()
    rosterStore.getState().reset()
    roomStore.getState().reset()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as never)
    xmppClient = new XMPPClient({ debug: false })
    bindStoresForTesting(xmppClient, createDefaultStoreBindings())

    const connected = xmppClient.connect({ jid: ME, password: 'secret', server: 'example.com', skipDiscovery: true })
    mockXmppClientInstance._emit('online')
    await connected
    setStorageScopeJid(ME)
    await searchIndex.initSearchIndex(ME)

    roomStore.getState().addRoom(createRoom(ROOM, { nickname: 'me', joined: true }))
    roomStore.getState().setActiveRoom(ROOM)
    await settle()
  })

  afterEach(async () => {
    xmppClient.destroy()
    await searchIndex.closeSearchIndex()
    roomStore.getState().reset()
    vi.clearAllMocks()
  })

  function receive(stanza: ReturnType<typeof createMockElement>): void {
    mockXmppClientInstance._emit('stanza', stanza)
  }

  async function play(evidence: Evidence): Promise<void> {
    receive(groupchat(ALICE_BODY, { occupantId: evidence.alice, stanzaId: evidence.aliceArchive, delayed: evidence.aliceViaHistory }))
    await settle()
    receive(retraction(evidence.aliceArchive ?? SHARED_ID, evidence.alice))
    await settle()
    receive(occupantPresence('unavailable', evidence.alice))
    receive(occupantPresence('available', evidence.bob))
    await settle()
    receive(groupchat(BOB_BODY, { occupantId: evidence.bob, stanzaId: evidence.bobArchive }))
    await settle()
  }

  it.each(cases)('$name: Bob\'s message displays normally', async (evidence) => {
    await play(evidence)

    const resident = roomWindow(ROOM)
    const alice = resident.find((message) => message.occupantId === evidence.alice && message.body !== BOB_BODY)
    expect(alice, 'Alice\'s row stays as the tombstone').toMatchObject({ id: SHARED_ID, isRetracted: true })

    const bob = resident.find((message) => message.body === BOB_BODY)
    expect(bob, 'Bob\'s message is a resident row').toBeDefined()
    expect(bob?.isRetracted, 'Bob\'s message is not displayed as deleted').toBeFalsy()
    expect(bob?.occupantId).toBe(evidence.bob)

    const cached = await messageCache.getRoomMessages(ROOM)
    const cachedBob = cached.find((message) => message.body === BOB_BODY)
    expect(cachedBob, 'Bob\'s message survives in the cache with its body').toBeDefined()
    expect(cachedBob?.isRetracted).toBeFalsy()
    expect(cached.filter((message) => message.isRetracted)).toHaveLength(1)
  })

  // Neither occupant ids nor archive ids on the live messages: only the delivery
  // channel keeps the two rows apart. Bob's archive copy then reaches both rows
  // through `from+id` and must attach to Bob's alone — the one closest in time.
  describe('when Bob\'s archive copy arrives afterwards', () => {
    const T0 = Date.UTC(2026, 8, 24, 12)

    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
    afterEach(() => { vi.useRealTimers() })

    async function playWithArchiveCopy(): Promise<void> {
      vi.setSystemTime(T0)
      receive(groupchat(ALICE_BODY, {}))
      await settle()
      vi.setSystemTime(T0 + 1_000)
      receive(retraction(SHARED_ID, undefined))
      await settle()
      receive(occupantPresence('unavailable', undefined))
      receive(occupantPresence('available', undefined))
      vi.setSystemTime(T0 + 60_000)
      receive(groupchat(BOB_BODY, {}))
      await settle()

      roomStore.getState().mergeRoomMAMMessages(ROOM, [{
        type: 'groupchat', roomJid: ROOM, from: FROM, nick: NICK, id: SHARED_ID, body: BOB_BODY,
        timestamp: new Date(T0 + 60_250), receivedAt: new Date(T0 + 60_500), isOutgoing: false, isDelayed: true, stanzaId: 'archive-bob', originId: undefined, occupantId: undefined,
      }], { first: 'archive-bob', last: 'archive-bob', count: 1 }, true, 'forward')
      await settle()
    }

    function expectBobIntact(messages: readonly { body?: string; isRetracted?: boolean; stanzaId?: string }[]): void {
      expect(messages.filter((message) => message.body === BOB_BODY)).toEqual([
        expect.objectContaining({ stanzaId: 'archive-bob' }),
      ])
      expect(messages.find((message) => message.body === BOB_BODY)?.isRetracted).toBeFalsy()
      expect(messages.filter((message) => message.isRetracted)).toEqual([
        expect.objectContaining({ id: SHARED_ID, stanzaId: undefined }),
      ])
      expect(messages).toHaveLength(2)
    }

    it('Bob\'s message still displays normally, and after a reload', async () => {
      await playWithArchiveCopy()

      expectBobIntact(roomWindow(ROOM))
      expectBobIntact(await messageCache.getRoomMessages(ROOM))

      _clearRetractedIdentitiesForTesting()
      seedRoomWindow(ROOM, [])
      await roomStore.getState().loadMessagesFromCache(ROOM)

      expectBobIntact(roomWindow(ROOM))
    })
  })
})
