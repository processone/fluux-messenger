import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader, createMockStores } from '../test-utils'

const NS = 'urn:xmpp:mam:2'
const ACCOUNT = 'me@example.com'
const PEER = 'juliet@example.com'
const ROOM = 'lobby@conference.example.com'
const STAMP = '2026-05-01T10:00:00.000Z'

type Reply = { entries: { archiveId: string; message: Element }[] } | 'error' | 'no-fin'

function harness(reply: Reply) {
  let collector: ((stanza: Element) => void) | undefined
  const emitSDK = vi.fn()
  const sendIQ = vi.fn(async (iq: Element) => {
    if (reply === 'error') throw new Error('feature-not-implemented')
    if (reply === 'no-fin') return xml('iq', { type: 'result' })
    const queryId = iq.getChild('query', NS)!.attrs.queryid
    for (const entry of reply.entries) {
      collector!(xml('message', { from: iq.attrs.to ?? ACCOUNT },
        xml('result', { xmlns: NS, queryid: queryId, id: entry.archiveId },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
            xml('delay', { xmlns: 'urn:xmpp:delay', stamp: STAMP }), entry.message))))
    }
    return xml('iq', { type: 'result' }, xml('fin', { xmlns: NS, complete: 'true' }))
  })
  const deps: ModuleDependencies = {
    stores: createMockStores(), presence: createMockPresenceReader(), getCurrentJid: () => ACCOUNT,
    getXmpp: () => null, sendStanza: vi.fn(), sendIQ, emit: vi.fn(), emitSDK,
    registerMAMCollector: (_id, handler) => { collector = handler; return () => { collector = undefined } },
  }
  return { mam: new MAM(deps), sendIQ, emitSDK }
}

function formField(iq: Element, name: string): string | undefined {
  const form = iq.getChild('query', NS)!.getChild('x', 'jabber:x:data')!
  return form.getChildren('field').find((f) => f.attrs.var === name)?.getChildText('value') ?? undefined
}

const chatMessage = (id: string) => xml('message', { from: PEER, to: ACCOUNT, type: 'chat', id }, xml('body', {}, 'hello'))

describe('MAM.lookUpArchivedMessage', () => {
  it('asks the conversation archive for exactly that id and returns the row without storing it', async () => {
    const h = harness({ entries: [{ archiveId: 'arch-9', message: chatMessage('client-9') }] })

    const result = await h.mam.lookUpArchivedMessage(PEER, false, 'arch-9')

    expect(result).toMatchObject({ kind: 'found', row: { id: 'client-9', stanzaId: 'arch-9', timestamp: new Date(STAMP) } })
    const iq = h.sendIQ.mock.calls[0][0]
    expect(formField(iq, 'with')).toBe(PEER)
    expect(formField(iq, '{urn:xmpp:mam:2}ids')).toBe('arch-9')
    expect(h.emitSDK).not.toHaveBeenCalled()
  })

  it('asks the room archive for the id', async () => {
    const h = harness({ entries: [{ archiveId: 'room-arch', message: xml('message', { from: `${ROOM}/alice`, type: 'groupchat', id: 'c1' }, xml('body', {}, 'hi')) }] })

    const result = await h.mam.lookUpArchivedMessage(ROOM, true, 'room-arch')

    expect(result).toMatchObject({ kind: 'found', row: { roomJid: ROOM, stanzaId: 'room-arch', timestamp: new Date(STAMP) } })
    expect(h.sendIQ.mock.calls[0][0].attrs.to).toBe(ROOM)
    expect(formField(h.sendIQ.mock.calls[0][0], 'with')).toBeUndefined()
  })

  it('reports the message absent when the archive returns nothing for the id', async () => {
    const h = harness({ entries: [] })
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'arch-9')).toEqual({ kind: 'absent' })
  })

  it('reports found without a row for an entry this client does not display', async () => {
    const h = harness({ entries: [{ archiveId: 'arch-9', message: xml('message', { from: PEER, type: 'chat', id: 'r' },
      xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'x' }, xml('reaction', {}, '👍'))) }] })
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'arch-9')).toEqual({ kind: 'found', timestamp: new Date(STAMP) })
  })

  it.each([
    ['the query fails', 'error' as const],
    ['the archive answers without a fin', 'no-fin' as const],
    ['the archive ignores the id and returns another message', { entries: [{ archiveId: 'other', message: chatMessage('client-1') }] }],
  ])('reports unknown when %s', async (_label, reply) => {
    const h = harness(reply)
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'arch-9')).toEqual({ kind: 'unknown' })
  })
})
