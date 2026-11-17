/* eslint-disable @typescript-eslint/triple-slash-reference -- the app's type-check lacks the SDK's ambient module declaration */
/// <reference path="../../../../packages/fluux-sdk/src/types/xmpp-xml.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { xml, type Element } from '@xmpp/client'
import { Roster } from '../../../../packages/fluux-sdk/src/core/modules/Roster'
import { Chat } from '../../../../packages/fluux-sdk/src/core/modules/Chat'
import { MAM } from '../../../../packages/fluux-sdk/src/core/modules/MAM'
import { createMockPresenceReader, createMockStores } from '../../../../packages/fluux-sdk/src/core/test-utils'
import { ForwardMessageModal } from './ForwardMessageModal'

// Review: one scripted-client sequence from capability announcements, discovery and its timeout, through
// the modal's choice, to the stanza the real Chat module emits. Only the XMPP stream and the stores are scripted.
const NS_FORWARD_COPY = 'urn:fluux:forward-copy:0'
const NS_FORWARD = 'urn:xmpp:forward:0'
const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info'
const NS_CAPS = 'http://jabber.org/protocol/caps'
const emma = 'emma@fluux.chat'
const roomJid = 'design@conference.fluux.chat'
const link = 'xmpp:design@conference.fluux.chat?join;msg=1731490000123456'

const session = vi.hoisted(() => ({ roster: undefined as unknown, chat: undefined as unknown }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@fluux/sdk', async () => ({
  matchNameOrJid: (await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')).matchNameOrJid,
  useRoster: () => ({ contacts: [{ jid: 'emma@fluux.chat', name: 'Emma' }] }),
  useChatActions: () => ({
    sendMessage: (to: string, body: string, options?: unknown) => (session.chat as Chat).sendMessage(to, body, options as never),
    supportsForwardedCopy: (jid: string) => (session.roster as Roster).supportsForwardedCopy(jid),
  }),
  useRoomActions: () => ({ sendMessage: vi.fn() }),
  roomStore: { getState: () => ({ rooms: new Map() }) },
  chatStore: { getState: () => ({ conversations: new Map() }) },
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ conversations: new Map() }),
  useRoomStore: (selector: (state: unknown) => unknown) => selector({ rooms: new Map() }),
  useConnectionStore: (selector: (state: unknown) => unknown) => selector({ status: 'online' }),
}))

type Resolve = (iq: Element) => void
function script(online: string[], features: Record<string, string[]>, hold = false) {
  const resources = new Map(online.map(resource => [resource, {}]))
  const stores = createMockStores()
  stores.roster.getContact = vi.fn(() => ({ jid: emma, resources })) as never
  const pending: Resolve[] = []
  const answer = (iq: Element) => xml('iq', { type: 'result' }, xml('query', { xmlns: NS_DISCO_INFO },
    ...(features[iq.attrs.to as string] ?? []).map(name => xml('feature', { var: name }))))
  const sendIQ = vi.fn((iq: Element, timeoutMs?: number) => hold
    ? new Promise<Element>((_, reject) => { setTimeout(() => reject(new Error('IQ timed out')), timeoutMs ?? 30_000) })
    : Promise.resolve(answer(iq)))
  const sendStanza = vi.fn()
  const deps = { stores, presence: createMockPresenceReader(), getCurrentJid: () => 'alice@example.org/web', getXmpp: () => null,
    sendStanza, sendIQ, emit: vi.fn(), emitSDK: vi.fn() } as never
  const roster = new Roster(deps)
  const chat = new Chat(deps, new MAM(deps))
  session.roster = roster; session.chat = chat
  const present = (resource: string, ver: string) => {
    resources.set(resource, {})
    roster.handle(xml('presence', { from: `${emma}/${resource}` },
      xml('c', { xmlns: NS_CAPS, hash: 'sha-1', node: 'https://fluux.chat', ver })))
  }
  return { present, sendIQ, sendStanza, resources, pending, answer, features }
}

const forwardTo = async (sendStanza: ReturnType<typeof vi.fn>) => {
  render(<ForwardMessageModal link={link} quote={{ author: 'Bob', text: 'Ship it', from: `${roomJid}/Bob` }} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('chat.forwardDestination'), { target: { value: 'em' } })
  fireEvent.keyDown(screen.getByLabelText('chat.forwardDestination'), { key: 'Enter' })
  fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: 'Please review' } })
  fireEvent.click(screen.getByRole('button', { name: 'chat.forwardSend' }))
  return sendStanza
}
const sent = (sendStanza: ReturnType<typeof vi.fn>): Element => sendStanza.mock.calls[0][0]

describe('forward from the modal to the emitted stanza', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  it('sends the structured copy when every online device announced support', async () => {
    const s = script([], {})
    s.features[`${emma}/phone`] = [NS_FORWARD_COPY]; s.features[`${emma}/web`] = [NS_FORWARD_COPY]
    s.present('phone', 'v1'); s.present('web', 'v2')
    await forwardTo(s.sendStanza)
    await waitFor(() => expect(s.sendStanza).toHaveBeenCalledOnce())
    const stanza = sent(s.sendStanza)
    expect(stanza.getChild('forwarded', NS_FORWARD)?.getChild('message')?.getChildText('body')).toBe('Ship it')
    expect(stanza.getChildText('body')).not.toContain('> Bob wrote:')
  })

  it('sends the quote when a device without support is online', async () => {
    const s = script([], {})
    s.features[`${emma}/phone`] = [NS_FORWARD_COPY]
    s.present('phone', 'v1'); s.present('web', 'v2')
    await forwardTo(s.sendStanza)
    await waitFor(() => expect(s.sendStanza).toHaveBeenCalledOnce())
    expect(sent(s.sendStanza).getChild('forwarded', NS_FORWARD)).toBeUndefined()
    expect(sent(s.sendStanza).getChildText('body')).toContain('> Bob wrote:')
  })

  it('sends the quote when an unsupported device joins while discovery is pending', async () => {
    const s = script([], {})
    s.features[`${emma}/phone`] = [NS_FORWARD_COPY]
    s.present('phone', 'v1')
    let release: () => void = () => {}
    s.sendIQ.mockImplementation((iq: Element) => new Promise<Element>(resolve => { release = () => resolve(s.answer(iq)) }))
    s.present('phone', 'v1b') // announces again so the discovery has to run
    await forwardTo(s.sendStanza)
    await waitFor(() => expect(s.sendIQ).toHaveBeenCalled())
    s.present('tablet', 'v3') // joins, unsupported, while the answer is outstanding
    release()
    await waitFor(() => expect(s.sendStanza).toHaveBeenCalledOnce())
    expect(sent(s.sendStanza).getChild('forwarded', NS_FORWARD)).toBeUndefined()
    expect(sent(s.sendStanza).getChildText('body')).toContain('> Bob wrote:')
  })

  it('sends the quote when discovery never answers', async () => {
    const s = script([], {}, true)
    s.present('phone', 'v1')
    await forwardTo(s.sendStanza)
    await waitFor(() => expect(s.sendIQ).toHaveBeenCalled())
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await waitFor(() => expect(s.sendStanza).toHaveBeenCalledOnce())
    expect(sent(s.sendStanza).getChild('forwarded', NS_FORWARD)).toBeUndefined()
    expect(sent(s.sendStanza).getChildText('body')).toContain('> Bob wrote:')
  })
})
