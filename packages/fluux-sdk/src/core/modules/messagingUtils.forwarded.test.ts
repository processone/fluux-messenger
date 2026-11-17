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

  it('ignores a nested forward, receipts and other extensions of the inner message', () => {
    const el = copy(xml('body', {}, 'outer'), xml('forwarded', { xmlns: NSF }, xml('message', {}, xml('body', {}, 'nested'))),
      xml('request', { xmlns: 'urn:xmpp:receipts' }))
    expect(parseForwardedCopy(el)).toMatchObject({ text: 'outer' })
  })

  it('bounds the text, strips control and bidirectional override characters, and drops an empty copy', () => {
    const long = parseForwardedCopy(copy(xml('body', {}, `a‮b\u0000${'x'.repeat(5000)}`)))!
    expect(Array.from(long.text).length).toBeLessThanOrEqual(4001)
    expect(long.text).not.toMatch(/[‮\u0000]/)
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
