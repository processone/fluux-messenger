import { describe, it, expect, onTestFinished } from 'vitest'
import { DemoClient } from './DemoClient'
import { roomStore } from '../stores/roomStore'

describe('DemoClient groupchat echo', () => {
  it('ignores composing and paused states and echoes a real message exactly once', async () => {
    const client = new DemoClient()
    onTestFinished(() => {
      client.destroy()
      roomStore.getState().reset()
    })
    client.populateDemo({
      self: { jid: 'you@fluux.chat', nick: 'You', domain: 'fluux.chat' },
      contacts: [],
      presences: [],
      conversations: [],
      messages: new Map(),
      rooms: [],
    })
    const roomJid = 'echo@conference.fluux.chat'
    await client.rooms.joinRoom(roomJid, 'You')
    await client.rooms.joinResult(roomJid)

    await client.messages.sendChatState(roomJid, 'composing')
    expect.soft(roomStore.getState().messages.get(roomJid) ?? []).toHaveLength(0)

    await client.messages.sendChatState(roomJid, 'paused')
    expect.soft(roomStore.getState().messages.get(roomJid) ?? []).toHaveLength(0)

    const id = await client.messages.sendMessage(roomJid, 'Hello room!')
    const messages = roomStore.getState().messages.get(roomJid) ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id, body: 'Hello room!', isOutgoing: true })
  })
})
