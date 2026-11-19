import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { ForwardedCopy, Message, RoomMessage } from '../core/types'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import * as messageCache from './messageCache'
import { findForwardedOrigin, forwardedCopyRoomLink } from './forwardOrigin'

const T = Date.UTC(2026, 10, 18, 18, 52)
const chat = (conversationId: string, o: Partial<Message> = {}): Message => ({
  stanzaId: undefined, originId: undefined, type: 'chat', id: 'm1', conversationId, from: conversationId,
  body: 'Thank you for voting', timestamp: new Date(T), isOutgoing: false, ...o })
const copy = (o: Partial<ForwardedCopy> = {}): Pick<{ forwarded?: ForwardedCopy; references?: never[] }, 'forwarded' | 'references'> =>
  ({ forwarded: { author: 'memberbot@xmpp.org', from: 'memberbot@xmpp.org', text: 'Thank you for voting', timestamp: T, type: 'chat', ...o } })

// Plan FLM-332: a click finds the original by link, carried ids, then sender, time and text, in local history only.
describe('findForwardedOrigin', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    setStorageScopeJid('me@example.org')
    globalThis.indexedDB = new IDBFactory()
    messageCache._resetDBForTesting()
  })

  it('uses the room message link the forward generated, not one pasted in the comment', async () => {
    const link = 'xmpp:tech@conference.example.org?join;msg=77'
    const pasted = 'xmpp:other@conference.example.org?join;msg=1'
    const message = { forwarded: { author: 'bot', text: 'x', fallback: { begin: 0, end: 5, text: `> bot\n${link}` } } as ForwardedCopy,
      references: [{ type: 'data' as const, uri: pasted }, { type: 'data' as const, uri: link }] }
    expect(forwardedCopyRoomLink(message)).toEqual({ roomJid: 'tech@conference.example.org', stanzaId: '77' })
    expect(await findForwardedOrigin(message, 'me@example.org', [])).toEqual({ kind: 'room', roomJid: 'tech@conference.example.org', stanzaId: '77' })
  })

  it('opens a room original by the carried archive id even without a link', async () => {
    const m = { forwarded: { author: 'Bob', from: 'tech@conference.example.org/Bob', text: 'x', type: 'groupchat' as const, stanzaId: '5', stanzaIdBy: 'tech@conference.example.org' } }
    expect(await findForwardedOrigin(m, 'me@example.org', [])).toEqual({ kind: 'room', roomJid: 'tech@conference.example.org', stanzaId: '5' })
  })

  it('ignores an archive id named by a different archive than the room', async () => {
    const m = { forwarded: { author: 'Bob', from: 'tech@conference.example.org/Bob', text: 'x', type: 'groupchat' as const, stanzaId: '5', stanzaIdBy: 'evil@conference.example.org' } }
    expect(await findForwardedOrigin(m, 'me@example.org', [])).toBeNull()
  })

  it('finds a direct original by its carried id, then by sender, time and text', async () => {
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'orig-1' }))
    expect(await findForwardedOrigin(copy({ id: 'orig-1', timestamp: undefined }), 'me@example.org', ['memberbot@xmpp.org']))
      .toEqual({ kind: 'chat', conversationId: 'memberbot@xmpp.org', row: { id: 'orig-1' } })
    expect(await findForwardedOrigin(copy({ timestamp: T + 90_000 }), 'me@example.org', ['memberbot@xmpp.org']))
      .toEqual({ kind: 'chat', conversationId: 'memberbot@xmpp.org', row: { id: 'orig-1' } })
  })

  it('does not match another time, another sender or other text', async () => {
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'orig-1' }))
    expect(await findForwardedOrigin(copy({ timestamp: T + 5 * 60_000 }), 'me@example.org', [])).toBeNull()
    expect(await findForwardedOrigin(copy({ from: 'other@xmpp.org', author: 'other@xmpp.org' }), 'me@example.org', [])).toBeNull()
    expect(await findForwardedOrigin(copy({ text: 'Something else' }), 'me@example.org', [])).toBeNull()
  })

  it('finds the account\'s own message in whichever conversation holds it', async () => {
    await messageCache.saveMessage(chat('alice@example.org', { id: 'mine', from: 'me@example.org', isOutgoing: true, body: 'on my way' }))
    await messageCache.saveMessage(chat('bob@example.org', { id: 'theirs', body: 'on my way' }))
    const m = copy({ from: 'me@example.org', author: 'me@example.org', text: 'on my way' })
    expect(await findForwardedOrigin(m, 'me@example.org', ['bob@example.org', 'alice@example.org']))
      .toEqual({ kind: 'chat', conversationId: 'alice@example.org', row: { id: 'mine' } })
  })

  it('matches a copy cut at the length limit by its prefix, and a shorter copy only exactly', async () => {
    const full = 'x'.repeat(4000)
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'long', body: `${full} and the rest` }))
    expect(await findForwardedOrigin(copy({ text: full }), 'me@example.org', [])).toMatchObject({ row: { id: 'long' } })
    expect(await findForwardedOrigin(copy({ text: 'Thank you' }), 'me@example.org', [])).toBeNull()
  })

  it('finds a room original in local history by nickname, time and text', async () => {
    const row = { type: 'groupchat', id: 'r1', roomJid: 'tech@conference.example.org', from: 'tech@conference.example.org/jenkins', nick: 'jenkins',
      body: 'BUILD SUCCESS', timestamp: new Date(T), isOutgoing: false, stanzaId: '88', originId: undefined } as unknown as RoomMessage
    await messageCache.saveRoomMessage(row)
    const m = { forwarded: { author: 'jenkins', from: 'tech@conference.example.org/jenkins', text: 'BUILD SUCCESS', type: 'groupchat' as const, timestamp: T } }
    expect(await findForwardedOrigin(m, 'me@example.org', [])).toEqual({ kind: 'room', roomJid: 'tech@conference.example.org', stanzaId: '88' })
  })

  it('finds a row by the original id even when its client id differs, and by the own-archive id first', async () => {
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'c1', originId: 'o1', timestamp: new Date(T + 60 * 60_000) }))
    expect(await findForwardedOrigin(copy({ id: 'o1', timestamp: T }), 'me@example.org', [])).toMatchObject({ row: { id: 'c1' } })
  })

  it('targets the second of two rows sharing a client id by the archive id, and keeps its identity', async () => {
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'dup', stanzaId: 'a-1', body: 'first' }))
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'dup', stanzaId: 'a-2', body: 'Thank you for voting', timestamp: new Date(T + 10_000) }))
    expect(await findForwardedOrigin(copy({ id: 'dup', stanzaId: 'a-2', stanzaIdBy: 'me@example.org' }), 'me@example.org', []))
      .toEqual({ kind: 'chat', conversationId: 'memberbot@xmpp.org', row: { id: 'dup', stanzaId: 'a-2' } })
  })

  it('picks the closest of repeated messages, and rejects a tie', async () => {
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'far', timestamp: new Date(T - 100_000) }))
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'near', timestamp: new Date(T + 5_000) }))
    expect(await findForwardedOrigin(copy(), 'me@example.org', [])).toMatchObject({ row: { id: 'near' } })
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'tie', timestamp: new Date(T - 5_000) }))
    expect(await findForwardedOrigin(copy(), 'me@example.org', [])).toBeNull()
  })

  it('does not pick an own message by conversation order when two conversations hold it equally', async () => {
    for (const [conv, id] of [['alice@example.org', 'a'], ['bob@example.org', 'b']] as const)
      await messageCache.saveMessage(chat(conv, { id, from: 'me@example.org', isOutgoing: true, body: 'on my way' }))
    const m = copy({ from: 'me@example.org', author: 'me@example.org', text: 'on my way' })
    expect(await findForwardedOrigin(m, 'me@example.org', ['alice@example.org', 'bob@example.org'])).toBeNull()
  })

  it('looks only in the sender\'s own conversation for another sender\'s message', async () => {
    await messageCache.saveMessage(chat('carol@example.org', { id: 'elsewhere', from: 'memberbot@xmpp.org' }))
    expect(await findForwardedOrigin(copy(), 'me@example.org', ['carol@example.org'])).toBeNull()
  })

  it('picks the room row closest in time and rejects a tie', async () => {
    const row = (id: string, stanzaId: string, at: number) => ({ type: 'groupchat', id, roomJid: 'tech@conference.example.org', from: 'tech@conference.example.org/jenkins',
      nick: 'jenkins', body: 'BUILD SUCCESS', timestamp: new Date(at), isOutgoing: false, stanzaId, originId: undefined }) as unknown as RoomMessage
    await messageCache.saveRoomMessage(row('r1', '1', T - 60_000))
    await messageCache.saveRoomMessage(row('r2', '2', T + 10_000))
    const m = { forwarded: { author: 'jenkins', from: 'tech@conference.example.org/jenkins', text: 'BUILD SUCCESS', type: 'groupchat' as const, timestamp: T } }
    expect(await findForwardedOrigin(m, 'me@example.org', [])).toEqual({ kind: 'room', roomJid: 'tech@conference.example.org', stanzaId: '2' })
    await messageCache.saveRoomMessage(row('r3', '3', T - 10_000))
    expect(await findForwardedOrigin(m, 'me@example.org', [])).toBeNull()
  })

  it('takes the link that ends the marked text, whatever order the references are in', () => {
    const quoted = 'xmpp:other@conference.example.org?join;msg=1'
    const source = 'xmpp:tech@conference.example.org?join;msg=77'
    const forwarded = { author: 'bot', text: 'x', fallback: { begin: 0, end: 5, text: `> bot wrote:\n> ${quoted}\n${source}` } } as ForwardedCopy
    for (const order of [[source, quoted], [quoted, source]])
      expect(forwardedCopyRoomLink({ forwarded, references: order.map(uri => ({ type: 'data' as const, uri })) })).toEqual({ roomJid: 'tech@conference.example.org', stanzaId: '77' })
  })

  it('rejects when the account changed while it ran', async () => {
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'orig-1' }))
    const pending = findForwardedOrigin(copy(), 'me@example.org', [])
    setStorageScopeJid('someone-else@example.org')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
