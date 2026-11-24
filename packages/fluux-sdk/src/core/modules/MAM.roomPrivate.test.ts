import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { parse } from 'ltx'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader, createMockStores } from '../test-utils'
import { NS_DELAY, NS_FORWARD, NS_MAM, NS_MUC_USER, NS_RSM } from '../namespaces'

const OWN = 'alice@example.org'
const ROOM = 'studio@groups.example.org'
const EXTERNAL_ROOM = 'garden@community.example.net'
const PERSON = 'bob@chat.example.net/phone'
const STAMP = '2026-09-18T10:30:00Z'

const chat = (id: string, from: string, to: string, text: string, ...extra: Element[]) =>
  xml('message', { type: 'chat', id, from, to }, xml('body', {}, text), ...extra)
const received = chat('private-in', `${ROOM}/Bob`, OWN, 'Room note from Bob')
const sent = chat('private-out', `${OWN}/desktop`, `${EXTERNAL_ROOM}/Carla`, 'Room note to Carla', xml('x', { xmlns: NS_MUC_USER }))
const notice = chat('notice', ROOM, `${OWN}/desktop`, 'Room notice')
const direct = chat('direct', PERSON, OWN, 'Ordinary direct note')

type Page = { messages: Element[]; complete?: boolean }
function harness(...pages: Page[]) {
  const stores = createMockStores()
  stores.admin.getMucServiceJid.mockReturnValue('groups.example.org')
  stores.chat.getAllConversations.mockReturnValue([{ id: ROOM, messages: [] }])
  const emitSDK = vi.fn()
  let collector: ((stanza: Element) => void) | undefined
  const sendIQ = vi.fn(async (iq: Element) => {
    const query = iq.getChild('query', NS_MAM)!
    const page = pages.shift()
    if (!page) throw new Error('Unexpected archive query')
    const ids = page.messages.map(message => `archive-${message.attrs.id}`)
    page.messages.forEach((message, i) => collector!(xml('message', { from: OWN },
      xml('result', { xmlns: NS_MAM, queryid: query.attrs.queryid, id: ids[i] },
        xml('forwarded', { xmlns: NS_FORWARD }, xml('delay', { xmlns: NS_DELAY, stamp: STAMP }), parse(message.toString()))))))
    return xml('iq', { type: 'result' }, xml('fin', { xmlns: NS_MAM, complete: String(page.complete ?? true) },
      xml('set', { xmlns: NS_RSM }, xml('first', {}, ids[0]), xml('last', {}, ids.at(-1)))))
  })
  const deps: ModuleDependencies = {
    stores, presence: createMockPresenceReader(), getCurrentJid: () => `${OWN}/desktop`,
    getXmpp: () => null, sendStanza: vi.fn(), sendIQ, emit: vi.fn(), emitSDK,
    registerMAMCollector: (_id, handler) => { collector = handler; return () => { collector = undefined } },
  }
  return { mam: new MAM(deps), stores, sendIQ, emitSDK }
}

const messageIds = (result: { messages: { id: string }[] }) => result.messages.map(message => message.id)

describe('Private room messages in the account archive', () => {
  it('walks past a private-only page and keeps valid bare-address chat history', async () => {
    const { mam, sendIQ, emitSDK } = harness({ messages: [received], complete: false }, { messages: [notice] })

    expect(messageIds(await mam.queryArchive({ with: ROOM, max: 1 }))).toEqual(['notice'])
    expect(sendIQ.mock.calls[1]?.[0].getChild('query', NS_MAM)?.getChild('set', NS_RSM)?.getChildText('before')).toBe('archive-private-in')
    expect(emitSDK).toHaveBeenCalledWith('chat:history-messages', expect.objectContaining({
      conversationId: ROOM, messages: [expect.objectContaining({ id: 'notice' })], complete: true,
    }))
  })

  it('does not apply a room occupant’s archived correction to a bare-address chat message', async () => {
    const edit = chat('private-edit', `${ROOM}/Bob`, OWN, 'Private edit',
      xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: 'notice' }))
    const { mam } = harness({ messages: [notice, edit] })

    const result = await mam.queryArchive({ with: ROOM })
    expect(result.messages.map(({ id, body }) => [id, body])).toEqual([['notice', 'Room notice']])
  })

  it('keeps an archived whisper out of the chat preview', async () => {
    const { mam, stores } = harness({ messages: [notice, received] })

    await mam.refreshConversationPreviews()

    expect(stores.chat.updateLastMessagePreview).toHaveBeenCalledExactlyOnceWith(ROOM, expect.objectContaining({ id: 'notice' }))
  })

  it('keeps an outgoing whisper to an unrecognized room out of account search and keeps a normal full-JID result', async () => {
    const { mam } = harness({ messages: [sent, direct] })

    expect(messageIds(await mam.searchArchive({ query: 'note' }))).toEqual(['direct'])
  })

  it('retains the private entry as an exact archive cursor but never returns it as a chat row', async () => {
    const { mam, sendIQ } = harness({ messages: [received] }, { messages: [notice] }, { messages: [received] })

    expect(await mam.lookUpArchivedMessage(ROOM, false, 'archive-notice')).toMatchObject({
      kind: 'found', row: { id: 'notice' },
    })
    expect(sendIQ.mock.calls[1]?.[0].getChild('query', NS_MAM)?.getChild('set', NS_RSM)?.getChildText('after')).toBe('archive-private-in')
    expect(await mam.lookUpArchivedMessage(ROOM, false, 'archive-private-in')).toEqual({ kind: 'found', timestamp: new Date(STAMP) })
  })
})
