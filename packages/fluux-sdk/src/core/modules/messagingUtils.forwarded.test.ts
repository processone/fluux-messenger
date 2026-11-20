import { describe, expect, it } from 'vitest'
import { xml } from '@xmpp/client'
import { parseForwardedCopy, parseMessageContent } from './messagingUtils'

const NSF = 'urn:xmpp:forward:0'
const copy = (...inner: unknown[]) => xml('message', { type: 'chat' }, xml('body', {}, 'hello'),
  xml('forwarded', { xmlns: NSF }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-11-17T09:30:00Z' }),
    xml('message', { xmlns: 'jabber:client', from: 'room@conference.example.org/Bob' }, ...(inner as never[]))))

// Plan: bounded, non-recursive parsing; attribution to the claimed author stays separate from the forwarder.
describe('parseForwardedCopy', () => {
  it('reads the plain body, the occupant nickname and the original time', () => {
    expect(parseForwardedCopy(copy(xml('body', {}, 'Ship it')))).toEqual({
      author: 'Bob', from: 'room@conference.example.org/Bob', text: 'Ship it', timestamp: Date.UTC(2026, 10, 17, 9, 30) })
  })

  it('attributes a direct copy to its bare sender address, a room copy to the nickname', () => {
    const direct = (type: string) => xml('message', { type: 'chat' }, xml('body', {}, 'hi'),
      xml('forwarded', { xmlns: NSF }, xml('message', { xmlns: 'jabber:client', type, from: 'bob@example.org/phone' }, xml('body', {}, 'x'))))
    expect(parseForwardedCopy(direct('chat'))).toMatchObject({ author: 'bob@example.org', type: 'chat' })
    expect(parseForwardedCopy(direct('groupchat'))).toMatchObject({ author: 'phone', type: 'groupchat' })
  })

  it('ignores a nested forward, receipts and other extensions of the inner message', () => {
    const el = copy(xml('body', {}, 'outer'), xml('forwarded', { xmlns: NSF }, xml('message', {}, xml('body', {}, 'nested'))),
      xml('request', { xmlns: 'urn:xmpp:receipts' }))
    expect(parseForwardedCopy(el)).toMatchObject({ text: 'outer' })
  })

  it('bounds the text, strips control and bidirectional override characters, and drops an empty copy', () => {
    const long = parseForwardedCopy(copy(xml('body', {}, `a‮b\u0000${'x'.repeat(5000)}`)))!
    expect(Array.from(long.text).length).toBeLessThanOrEqual(4001)
    expect(long.text).not.toContain('\u202e')
    expect(long.text).not.toContain('\u0000')
    expect(parseForwardedCopy(copy(xml('body', {}, '  ')))).toBeUndefined()
    expect(parseForwardedCopy(copy())).toBeUndefined()
  })

  it('ignores a forwarded child in another namespace and does not apply to room messages', () => {
    const el = xml('message', {}, xml('forwarded', { xmlns: 'urn:other' }, xml('message', {}, xml('body', {}, 'x'))))
    expect(parseForwardedCopy(el)).toBeUndefined()
    expect(parseMessageContent({ messageEl: copy(xml('body', {}, 'Ship it')), body: 'hello', messageContext: 'room' }).forwarded).toBeUndefined()
    expect(parseMessageContent({ messageEl: copy(xml('body', {}, 'Ship it')), body: 'hello' }).forwarded?.text).toBe('Ship it')
  })
})

// Captain's choice on FLM-332: the original's ids ride in the copy so a reader can find it again.
describe('parseForwardedCopy ids of the original', () => {
  const NSID = 'urn:xmpp:sid:0'
  it('reads the original id and the archive id with its archive', () => {
    const parsed = parseForwardedCopy(xml('message', {}, xml('forwarded', { xmlns: NSF },
      xml('message', { xmlns: 'jabber:client', from: 'bob@example.org', type: 'chat', id: 'orig-1' }, xml('body', {}, 'hi'),
        xml('stanza-id', { xmlns: NSID, by: 'me@example.org', id: 'arch-9' })))))
    expect(parsed).toMatchObject({ id: 'orig-1', stanzaId: 'arch-9', stanzaIdBy: 'me@example.org' })
  })
  it('ignores an archive id without its archive and a stanza-id in another namespace; a copy without ids stays valid', () => {
    const parsed = parseForwardedCopy(xml('message', {}, xml('forwarded', { xmlns: NSF },
      xml('message', { xmlns: 'jabber:client', from: 'bob@example.org', type: 'chat' }, xml('body', {}, 'hi'),
        xml('stanza-id', { xmlns: NSID, id: 'arch-9' }), xml('stanza-id', { xmlns: 'urn:other', by: 'x@y', id: 'z' })))))
    expect(parsed).toEqual({ author: 'bob@example.org', from: 'bob@example.org', text: 'hi', type: 'chat' })
  })
})
