import { beforeEach, describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { MUC } from './MUC'
import type { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockStores, createMockRoom } from '../test-utils'
import { NS_DATA_FORMS, NS_DELAY } from '../namespaces'

const roomJid = 'room@conference.example.org'
const request = { id: 'voice-1', stanzaId: 'voice-1', roomJid, nick: 'Visitor', jid: 'visitor@example.org/mobile' }
const formType = 'http://jabber.org/protocol/muc#request'
const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
function approval(from = roomJid, role = 'participant'): Element {
  return xml('message', { from, id: request.id },
    xml('x', { xmlns: NS_DATA_FORMS, type: 'form' },
      field('FORM_TYPE', formType), field('muc#role', role),
      field('muc#jid', request.jid), field('muc#roomnick', request.nick),
      field('muc#request_allow', 'false')))
}

describe('MUC voice requests', () => {
  const sendStanza = vi.fn()
  const emitSDK = vi.fn()
  const stores = createMockStores()
  let muc: MUC

  beforeEach(() => {
    vi.clearAllMocks()
    stores.room.getRoom.mockReturnValue(createMockRoom(roomJid, {
      jid: roomJid, joined: true,
      selfOccupant: { nick: 'Mod', role: 'moderator', affiliation: 'admin' },
    }))
    muc = new MUC({ stores, sendStanza, emitSDK } as unknown as ModuleDependencies, {} as MAM)
  })

  it('delivers the service voice approval form as a typed request', () => {
    expect(muc.handle(approval())).toBe(true)
    expect(emitSDK).toHaveBeenCalledWith('events:voice-request', request)
  })

  it('delivers a service voice approval form replayed with delay metadata after stream resumption', () => {
    const stanza = approval()
    stanza.children.push(xml('delay', { xmlns: NS_DELAY, from: 'example.org', stamp: '2026-09-11T08:00:00Z' }, 'Resent'))

    expect(muc.handle(stanza)).toBe(true)
    expect(emitSDK).toHaveBeenCalledExactlyOnceWith('events:voice-request', request)
  })

  it.each([
    { joined: false, role: 'moderator' },
    { joined: true, role: 'participant' },
    { joined: true, role: 'visitor' },
  ] as const)('ignores replayed approval forms when joined=$joined and role=$role', ({ joined, role }) => {
    stores.room.getRoom.mockReturnValue(createMockRoom(roomJid, {
      jid: roomJid, joined,
      selfOccupant: { nick: 'Me', role, affiliation: 'admin' },
    }))
    const stanza = approval()
    stanza.children.push(xml('delay', { xmlns: NS_DELAY, from: 'example.org', stamp: '2026-09-11T08:00:00Z' }, 'Resent'))

    muc.handle(stanza)

    expect(emitSDK).not.toHaveBeenCalled()
  })

  it.each([
    ['occupant message', () => approval(`${roomJid}/Spoof`)],
    ['unknown room', () => approval('unknown@conference.example.org')],
    ['privilege escalation', () => approval(roomJid, 'moderator')],
    ['groupchat message', () => { const stanza = approval(); stanza.attrs.type = 'groupchat'; return stanza }],
    ['error echo', () => { const stanza = approval(); stanza.attrs.type = 'error'; return stanza }],
    ['missing identity', () => { const stanza = approval(); stanza.getChild('x')!.children = stanza.getChild('x')!.getChildren('field').filter(f => f.attrs.var !== 'muc#jid'); return stanza }],
  ])('does not queue a %s', (_name, build) => {
    // Only the actual joined room is trusted to send moderator approval forms.
    stores.room.getRoom.mockImplementation(jid => jid === roomJid ? createMockRoom(roomJid, {
      jid: roomJid, joined: true, selfOccupant: { nick: 'Mod', role: 'moderator', affiliation: 'admin' },
    }) : undefined)
    muc.handle(build())
    expect(emitSDK).not.toHaveBeenCalled()
  })

  it('ignores approval forms when we are not a joined moderator', () => {
    stores.room.getRoom.mockReturnValue(createMockRoom(roomJid, { jid: roomJid, joined: true,
      selfOccupant: { nick: 'Me', role: 'participant', affiliation: 'member' } }))
    muc.handle(approval())
    expect(emitSDK).not.toHaveBeenCalled()
  })

  it('requests participant voice using a message data form', async () => {
    stores.room.getRoom.mockReturnValue(createMockRoom(roomJid, { jid: roomJid, joined: true,
      selfOccupant: { nick: 'Me', role: 'visitor', affiliation: 'none' } }))
    await muc.requestVoice(roomJid)
    expect(sendStanza).toHaveBeenCalledTimes(1)
    const stanza = sendStanza.mock.calls[0][0] as Element
    expect(stanza.name).toBe('message')
    expect(stanza.attrs.to).toBe(roomJid)
    expect(stanza.attrs.type).not.toBe('groupchat')
    const form = stanza.getChild('x', NS_DATA_FORMS)!
    expect(form.attrs.type).toBe('submit')
    expect(Object.fromEntries(form.getChildren('field').map(f => [f.attrs.var, f.getChildText('value')]))).toEqual({
      FORM_TYPE: formType, 'muc#role': 'participant',
    })
  })

  it('declines an unrelated error with no id', () => {
    expect(muc.handle(xml('message', { from: roomJid, type: 'error' }, xml('error', { type: 'cancel' })))).toBe(false)
    expect(emitSDK).not.toHaveBeenCalled()
  })

  it('rejects outgoing actions when our role does not permit them', async () => {
    await expect(muc.requestVoice(roomJid)).rejects.toThrow()
    stores.room.getRoom.mockReturnValue(createMockRoom(roomJid, { joined: true,
      selfOccupant: { nick: 'Me', role: 'visitor', affiliation: 'none' } }))
    await expect(muc.approveVoiceRequest(request)).rejects.toThrow()
    expect(sendStanza).not.toHaveBeenCalled()
  })

  it('surfaces a server refusal of an approval while retaining the request', async () => {
    await muc.approveVoiceRequest(request)
    expect(muc.handle(xml('message', { from: roomJid, id: request.id, type: 'error' },
      xml('error', { type: 'auth' }, xml('forbidden', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }))))).toBe(true)
    expect(emitSDK).toHaveBeenCalledWith('events:voice-request-status', expect.objectContaining({ roomJid, status: 'error', requestId: request.id }))
    expect(emitSDK).not.toHaveBeenCalledWith('events:voice-request-removed', expect.anything())
  })

  it('reports a correlated request error even if it arrives before the send promise settles', async () => {
    stores.room.getRoom.mockReturnValue(createMockRoom(roomJid, { joined: true,
      selfOccupant: { nick: 'Me', role: 'visitor', affiliation: 'none' } }))
    sendStanza.mockImplementationOnce(async (stanza: Element) => {
      muc.handle(xml('message', { from: roomJid, id: stanza.attrs.id, type: 'error' },
        xml('error', { type: 'auth' }, xml('forbidden', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }))))
    })
    await muc.requestVoice(roomJid)
    expect(emitSDK).toHaveBeenCalledWith('events:voice-request-status', expect.objectContaining({ roomJid, status: 'error' }))
    expect(emitSDK).not.toHaveBeenCalledWith('events:voice-request-status', { roomJid, status: 'sent' })
  })

  it('retains a request until the server confirms voice through presence', async () => {
    await muc.approveVoiceRequest(request)
    expect(emitSDK).not.toHaveBeenCalledWith('events:voice-request-removed', expect.anything())
  })

  it('rejects approval when a nickname now belongs to a different visitor', async () => {
    stores.room.getRoom.mockReturnValue(createMockRoom(roomJid, { joined: true,
      selfOccupant: { nick: 'Mod', role: 'moderator', affiliation: 'admin' },
      occupants: new Map([[request.nick, { nick: request.nick, jid: 'someone-else@example.org', role: 'visitor', affiliation: 'none' }]]) }))
    await expect(muc.approveVoiceRequest(request)).rejects.toThrow()
    expect(sendStanza).not.toHaveBeenCalled()
  })

  it('approves the full requesting identity without changing affiliation', async () => {
    await muc.approveVoiceRequest(request)
    expect(sendStanza).toHaveBeenCalledTimes(1)
    const stanza = sendStanza.mock.calls[0][0] as Element
    expect(stanza.attrs).toMatchObject({ to: roomJid, id: request.id })
    expect(Object.fromEntries(stanza.getChild('x', NS_DATA_FORMS)!.getChildren('field').map(f => [f.attrs.var, f.getChildText('value')]))).toEqual({
      FORM_TYPE: formType, 'muc#role': 'participant', 'muc#jid': request.jid,
      'muc#roomnick': request.nick, 'muc#request_allow': 'true',
    })
  })
})
