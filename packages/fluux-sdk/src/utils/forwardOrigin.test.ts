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
      .toEqual({ kind: 'chat', conversationId: 'memberbot@xmpp.org', messageId: 'orig-1' })
    expect(await findForwardedOrigin(copy({ timestamp: T + 90_000 }), 'me@example.org', ['memberbot@xmpp.org']))
      .toEqual({ kind: 'chat', conversationId: 'memberbot@xmpp.org', messageId: 'orig-1' })
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
      .toEqual({ kind: 'chat', conversationId: 'alice@example.org', messageId: 'mine' })
  })

  it('matches a copy cut at the length limit by its prefix', async () => {
    await messageCache.saveMessage(chat('memberbot@xmpp.org', { id: 'long', body: 'Thank you for voting, again and again' }))
    expect(await findForwardedOrigin(copy(), 'me@example.org', [])).toMatchObject({ messageId: 'long' })
  })

  it('finds a room original in local history by nickname, time and text', async () => {
    const row = { type: 'groupchat', id: 'r1', roomJid: 'tech@conference.example.org', from: 'tech@conference.example.org/jenkins', nick: 'jenkins',
      body: 'BUILD SUCCESS', timestamp: new Date(T), isOutgoing: false, stanzaId: '88', originId: undefined } as unknown as RoomMessage
    await messageCache.saveRoomMessage(row)
    const m = { forwarded: { author: 'jenkins', from: 'tech@conference.example.org/jenkins', text: 'BUILD SUCCESS', type: 'groupchat' as const, timestamp: T } }
    expect(await findForwardedOrigin(m, 'me@example.org', [])).toEqual({ kind: 'room', roomJid: 'tech@conference.example.org', stanzaId: '88' })
  })
})
