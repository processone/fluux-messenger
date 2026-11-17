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

  // The echo uses the shared receive parser, so a reply plus forward keeps its marker in frame.
  it('echoes a reply-plus-forward with the quote removed and the marker rebased to the shown body', async () => {
    const client = new DemoClient()
    onTestFinished(() => { client.destroy(); roomStore.getState().reset() })
    client.populateDemo({ self: { jid: 'you@fluux.chat', nick: 'You', domain: 'fluux.chat' },
      contacts: [], presences: [], conversations: [], messages: new Map(), rooms: [] })
    const roomJid = 'echo@conference.fluux.chat'
    await client.rooms.joinRoom(roomJid, 'You')
    await client.rooms.joinResult(roomJid)
    const link = `xmpp:${roomJid}?join;msg=1731490000123456`
    const quote = '> Bob wrote:\n> Ship it\n'
    const body = `Look\n${quote}${link}`
    await client.messages.sendMessage(roomJid, body, { replyTo: { id: 'earlier', to: `${roomJid}/Carol`, fallback: { author: 'Carol', body: 'Question?' } },
      references: [{ type: 'data', uri: link, begin: 5 + quote.length, end: body.length, forwardFallback: { begin: 5, end: body.length } }] })
    const [echoed] = roomStore.getState().messages.get(roomJid) ?? []
    expect(echoed.body).toBe(body)
    const ref = echoed.references![0] as { begin: number; end: number; forwardFallback: { begin: number; end: number } }
    expect(echoed.body.slice(ref.begin, ref.end)).toBe(link)
    expect(echoed.body.slice(ref.forwardFallback.begin, ref.forwardFallback.end)).toBe(quote + link)
  })
})
