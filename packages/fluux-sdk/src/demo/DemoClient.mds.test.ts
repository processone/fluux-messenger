/**
 * Demo-mode XEP-0490 (MDS) simulation:
 * - DemoClient answers the MDS PEP-node IQs (publish / items / retract) from an
 *   in-memory node, so `client.mds.*` round-trips work without a server.
 * - simulateRemoteDisplayed() plays the "another device read up to X" +notify:
 *   it seeds the node AND emits `read:displayed-synced` like PubSub would.
 * - populateDemo defaults a stanza-id onto seeded messages (marker resolution
 *   matches on `m.stanzaId`, so markers against id-less demo messages could
 *   never resolve).
 */
import { describe, it, expect, vi } from 'vitest'
import { DemoClient } from './DemoClient'
import type { DemoData } from './types'
import type { Room, RoomMessage } from '../core/types/room'
import type { Message } from '../core/types/chat'

function makeClient(): DemoClient {
  const client = new DemoClient()
  ;(client as unknown as { currentJid: string | null }).currentJid = 'you@fluux.chat'
  ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'
  return client
}

const ROOM_JID = 'team@conference.fluux.chat'

describe('DemoClient MDS PEP node simulation', () => {
  it('publishDisplayed then fetchAllDisplayed round-trips the marker', async () => {
    const client = makeClient()
    await client.mds.publishDisplayed('ava@fluux.chat', 'sid-42', 'you@fluux.chat')

    const markers = await client.mds.fetchAllDisplayed()
    expect(markers).toEqual([{ conversationJid: 'ava@fluux.chat', stanzaId: 'sid-42' }])
  })

  it('a re-publish for the same conversation overwrites the item (current-value node)', async () => {
    const client = makeClient()
    await client.mds.publishDisplayed('ava@fluux.chat', 'sid-42', 'you@fluux.chat')
    await client.mds.publishDisplayed('ava@fluux.chat', 'sid-99', 'you@fluux.chat')

    const markers = await client.mds.fetchAllDisplayed()
    expect(markers).toEqual([{ conversationJid: 'ava@fluux.chat', stanzaId: 'sid-99' }])
  })

  it('retractDisplayed removes the item', async () => {
    const client = makeClient()
    await client.mds.publishDisplayed('ava@fluux.chat', 'sid-42', 'you@fluux.chat')
    await client.mds.retractDisplayed('ava@fluux.chat')

    expect(await client.mds.fetchAllDisplayed()).toEqual([])
  })

  it('fetchAllDisplayed returns [] when nothing was published', async () => {
    const client = makeClient()
    expect(await client.mds.fetchAllDisplayed()).toEqual([])
  })
})

describe('DemoClient.simulateRemoteDisplayed', () => {
  it('emits read:displayed-synced with the conversation and stanza-id', () => {
    const client = makeClient()
    const received: Array<{ conversationId: string; stanzaId: string }> = []
    client.subscribe('read:displayed-synced', (payload) => received.push(payload))

    client.simulateRemoteDisplayed('ava@fluux.chat', 'sid-7')

    expect(received).toEqual([{ conversationId: 'ava@fluux.chat', stanzaId: 'sid-7' }])
  })

  it('seeds the node so a later fetchAllDisplayed (fresh-session seed) sees it', async () => {
    const client = makeClient()
    client.simulateRemoteDisplayed('ava@fluux.chat', 'sid-7')

    const markers = await client.mds.fetchAllDisplayed()
    expect(markers).toEqual([{ conversationJid: 'ava@fluux.chat', stanzaId: 'sid-7' }])
  })
})

describe('DemoClient.populateDemo stanza-id defaulting', () => {
  function makeDemoData(): DemoData {
    const chatMessage: Message = {
      type: 'chat',
      id: 'demo-msg-1',
      conversationId: 'ava@fluux.chat',
      from: 'ava@fluux.chat',
      body: 'hi',
      timestamp: new Date(),
      isOutgoing: false,
    }
    const roomMessages: RoomMessage[] = [
      {
        type: 'groupchat', id: 'demo-room-1', from: `${ROOM_JID}/Emma`, nick: 'Emma',
        body: 'hello', timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
      },
      {
        type: 'groupchat', id: 'demo-room-2', from: `${ROOM_JID}/Emma`, nick: 'Emma',
        body: 'explicit', timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
        stanzaId: 'custom-sid',
      },
    ]
    return {
      self: { jid: 'you@fluux.chat', nick: 'You', domain: 'fluux.chat' },
      contacts: [],
      presences: [],
      conversations: [],
      messages: new Map([['ava@fluux.chat', [chatMessage]]]),
      rooms: [
        {
          room: { jid: ROOM_JID, name: 'Team', joined: true, messages: [] } as unknown as Room,
          occupants: [],
          messages: roomMessages,
        },
      ],
    }
  }

  it('defaults stanzaId to sid-<id> on seeded messages and preserves explicit ones', () => {
    const client = makeClient()
    const emitted: Array<{ event: string; payload: unknown }> = []
    vi.spyOn(client as unknown as { emitSDK: (e: string, p: unknown) => void }, 'emitSDK')
      .mockImplementation((event, payload) => emitted.push({ event, payload }))

    client.populateDemo(makeDemoData())

    const chatMsgs = emitted
      .filter((e) => e.event === 'chat:message')
      .map((e) => (e.payload as { message: Message }).message)
    expect(chatMsgs).toHaveLength(1)
    expect(chatMsgs[0].stanzaId).toBe('sid-demo-msg-1')

    const roomMsgs = emitted
      .filter((e) => e.event === 'room:message')
      .map((e) => (e.payload as { message: RoomMessage }).message)
    expect(roomMsgs).toHaveLength(2)
    expect(roomMsgs.find((m) => m.id === 'demo-room-1')?.stanzaId).toBe('sid-demo-room-1')
    expect(roomMsgs.find((m) => m.id === 'demo-room-2')?.stanzaId).toBe('custom-sid')
  })
})
