import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader, createMockStores } from '../test-utils'

const NS = 'urn:xmpp:mam:2'
const NS_RSM = 'http://jabber.org/protocol/rsm'
const ACCOUNT = 'me@example.com'
const PEER = 'juliet@example.com'
const ROOM = 'lobby@conference.example.com'

type Entry = { archiveId: string; message: Element; stamp: string }

/**
 * An archive answering one-item RSM pages. `unknownCursor` is what the server does with a
 * `before`/`after` cursor it does not hold: Prosody answers item-not-found; ejabberd reads its
 * archive ids as timestamps and pages from where that id would sit.
 */
function harness(archive: Entry[], options: { unknownCursor?: 'item-not-found' | 'position'; fail?: 'error' | 'no-fin'; vanishAfterFirst?: boolean } = {}) {
  let collector: ((stanza: Element) => void) | undefined
  const emitSDK = vi.fn()
  const sendIQ = vi.fn(async (iq: Element) => {
    if (options.fail === 'error') throw new Error('internal-server-error')
    if (options.fail === 'no-fin') return xml('iq', { type: 'result' })
    const query = iq.getChild('query', NS)!
    const set = query.getChild('set', NS_RSM)!
    const before = set.getChildText('before') ?? undefined
    const after = set.getChildText('after') ?? undefined
    const cursor = before ?? after
    // The predecessor found by the first query is deleted before the second one.
    if (options.vanishAfterFirst && after !== undefined) throw Object.assign(new Error('item-not-found'), { condition: 'item-not-found' })
    let index = cursor === undefined ? -1 : archive.findIndex((e) => e.archiveId === cursor)
    if (cursor !== undefined && index === -1) {
      if ((options.unknownCursor ?? 'item-not-found') === 'item-not-found') {
        throw Object.assign(new Error('item-not-found'), { condition: 'item-not-found' })
      }
      index = archive.findIndex((e) => e.archiveId > cursor)
      if (index === -1) index = archive.length
      if (after !== undefined) index -= 1
    }
    const page = before !== undefined ? archive.slice(Math.max(0, index - 1), index)
      : after !== undefined ? archive.slice(index + 1, index + 2)
      : archive.slice(0, 1)
    for (const entry of page) {
      collector!(xml('message', { from: iq.attrs.to ?? ACCOUNT },
        xml('result', { xmlns: NS, queryid: query.attrs.queryid, id: entry.archiveId },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
            xml('delay', { xmlns: 'urn:xmpp:delay', stamp: entry.stamp }), entry.message))))
    }
    return xml('iq', { type: 'result' }, xml('fin', { xmlns: NS, complete: 'false' }))
  })
  const deps: ModuleDependencies = {
    stores: createMockStores(), presence: createMockPresenceReader(), getCurrentJid: () => ACCOUNT,
    getXmpp: () => null, sendStanza: vi.fn(), sendIQ, emit: vi.fn(), emitSDK,
    registerMAMCollector: (_id, handler) => { collector = handler; return () => { collector = undefined } },
  }
  return { mam: new MAM(deps), sendIQ, emitSDK }
}

function rsm(iq: Element, name: 'before' | 'after' | 'max'): string | undefined {
  return iq.getChild('query', NS)!.getChild('set', NS_RSM)!.getChildText(name) ?? undefined
}

const hasForm = (iq: Element): boolean => !!iq.getChild('query', NS)!.getChild('x', 'jabber:x:data')

const stamp = (n: number) => new Date(Date.UTC(2026, 4, 1, 10, n)).toISOString()
const chat = (archiveId: string, n: number): Entry => ({
  archiveId, stamp: stamp(n),
  message: xml('message', { from: PEER, to: ACCOUNT, type: 'chat', id: `client-${archiveId}` }, xml('body', {}, archiveId)),
})
const history = [chat('a1', 1), chat('a3', 3), chat('a5', 5)]

describe('MAM.lookUpArchivedMessage', () => {
  it('finds a message through its predecessor and returns its row without storing it', async () => {
    const h = harness(history)

    const result = await h.mam.lookUpArchivedMessage(PEER, false, 'a3')

    expect(result).toMatchObject({ kind: 'found', timestamp: new Date(stamp(3)), row: { id: 'client-a3', stanzaId: 'a3' } })
    const [first, second] = h.sendIQ.mock.calls.map(([iq]) => iq)
    expect([rsm(first, 'before'), rsm(first, 'max')]).toEqual(['a3', '1'])
    expect([rsm(second, 'after'), rsm(second, 'max')]).toEqual(['a1', '1'])
    expect(h.sendIQ.mock.calls.some(([iq]) => hasForm(iq))).toBe(false)
    expect(h.emitSDK).not.toHaveBeenCalled()
  })

  it('finds the oldest message, which has no predecessor', async () => {
    const h = harness(history)

    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'a1')).toMatchObject({ kind: 'found', row: { stanzaId: 'a1' } })
    const second = h.sendIQ.mock.calls[1][0]
    expect([rsm(second, 'before'), rsm(second, 'after')]).toEqual([undefined, undefined])
  })

  it('looks in the room archive', async () => {
    const h = harness([{ archiveId: 'r1', stamp: stamp(1),
      message: xml('message', { from: `${ROOM}/alice`, type: 'groupchat', id: 'c1' }, xml('body', {}, 'hi')) }])

    expect(await h.mam.lookUpArchivedMessage(ROOM, true, 'r1')).toMatchObject({ kind: 'found', row: { roomJid: ROOM, stanzaId: 'r1' } })
    expect(h.sendIQ.mock.calls[0][0].attrs.to).toBe(ROOM)
  })

  it('reports absent when the server rejects the id as a cursor', async () => {
    const h = harness(history, { unknownCursor: 'item-not-found' })
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'a4')).toEqual({ kind: 'absent' })
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })

  it('reports absent when the message after its predecessor is another one', async () => {
    const h = harness(history, { unknownCursor: 'position' })
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'a4')).toEqual({ kind: 'absent' })
  })

  it('reports absent when nothing follows its predecessor', async () => {
    const h = harness(history, { unknownCursor: 'position' })
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'a9')).toEqual({ kind: 'absent' })
  })

  it('reports absent for an empty archive', async () => {
    const h = harness([], { unknownCursor: 'position' })
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'a1')).toEqual({ kind: 'absent' })
  })

  it('reports unknown when the predecessor disappears between the two queries', async () => {
    const h = harness(history, { vanishAfterFirst: true })
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'a3')).toEqual({ kind: 'unknown' })
  })

  it('reports found without a row for an entry this client does not display', async () => {
    const h = harness([chat('a1', 1), { archiveId: 'a2', stamp: stamp(2),
      message: xml('message', { from: PEER, type: 'chat', id: 'r' },
        xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'x' }, xml('reaction', {}, '👍'))) }])
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'a2')).toEqual({ kind: 'found', timestamp: new Date(stamp(2)) })
  })

  it.each([
    ['the query fails', 'error' as const],
    ['the archive answers without a fin', 'no-fin' as const],
  ])('reports unknown when %s', async (_label, fail) => {
    const h = harness(history, { fail })
    expect(await h.mam.lookUpArchivedMessage(PEER, false, 'a3')).toEqual({ kind: 'unknown' })
  })
})

describe('MAM.fetchRoomMessageById', () => {
  const room = (archiveId: string, n: number): Entry => ({
    archiveId, stamp: stamp(n),
    message: xml('message', { from: `${ROOM}/alice`, type: 'groupchat', id: `c-${archiveId}` }, xml('body', {}, archiveId)),
  })
  const sentFields = (h: ReturnType<typeof harness>) => h.sendIQ.mock.calls.flatMap(([iq]) =>
    iq.getChild('query', NS)!.getChild('x', 'jabber:x:data')?.getChildren('field').map((f) => f.attrs.var) ?? [])

  it('fetches the room message through RSM paging and publishes it', async () => {
    const h = harness([room('r1', 1), room('r2', 2), room('r3', 3)], { unknownCursor: 'position' })

    const message = await h.mam.fetchRoomMessageById(ROOM, 'r2')

    expect(message).toMatchObject({ roomJid: ROOM, stanzaId: 'r2', body: 'r2' })
    expect(sentFields(h)).toEqual([])
    expect(h.emitSDK).toHaveBeenCalledWith('room:message', expect.objectContaining({ roomJid: ROOM, message: expect.objectContaining({ stanzaId: 'r2' }) }))
  })

  it('returns null for an id the room archive does not hold', async () => {
    const h = harness([room('r1', 1), room('r3', 3)], { unknownCursor: 'position' })

    expect(await h.mam.fetchRoomMessageById(ROOM, 'r2')).toBeNull()
    expect(h.emitSDK).not.toHaveBeenCalledWith('room:message', expect.anything())
  })
})
