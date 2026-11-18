/* eslint-disable @typescript-eslint/triple-slash-reference -- the app's type-check lacks the SDK's ambient module declaration */
/// <reference path="../../../../packages/fluux-sdk/src/types/xmpp-xml.d.ts" />
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Element } from '@xmpp/client'
import { Chat } from '../../../../packages/fluux-sdk/src/core/modules/Chat'
import { MAM } from '../../../../packages/fluux-sdk/src/core/modules/MAM'
import { parseMessageContent } from '../../../../packages/fluux-sdk/src/core/modules/messagingUtils'
import { createMockPresenceReader, createMockStores } from '../../../../packages/fluux-sdk/src/core/test-utils'
import { ForwardMessageModal } from './ForwardMessageModal'

// One scripted-client sequence from the modal's send to the stanza the real Chat module emits, and from that
// stanza to what a receiver reads. Only the XMPP stream and the stores are scripted; no device is asked.
const NS_FORWARD = 'urn:xmpp:forward:0'
const NS_FALLBACK = 'urn:xmpp:fallback:0'
const roomJid = 'design@conference.fluux.chat'
const link = 'xmpp:design@conference.fluux.chat?join;msg=1731490000123456'

const session = vi.hoisted(() => ({ chat: undefined as unknown }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@fluux/sdk', async () => ({
  matchNameOrJid: (await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')).matchNameOrJid,
  useRoster: () => ({ contacts: [{ jid: 'emma@fluux.chat', name: 'Emma' }] }),
  useChatActions: () => ({
    sendMessage: (to: string, body: string, options?: unknown) => (session.chat as Chat).sendMessage(to, body, options as never),
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

function script() {
  const stores = createMockStores()
  const sendStanza = vi.fn()
  const sendIQ = vi.fn()
  const deps = { stores, presence: createMockPresenceReader(), getCurrentJid: () => 'alice@example.org/web', getXmpp: () => null,
    sendStanza, sendIQ, emit: vi.fn(), emitSDK: vi.fn() } as never
  session.chat = new Chat(deps, new MAM(deps))
  return { sendStanza, sendIQ }
}

const forwardTo = (comment: string) => {
  render(<ForwardMessageModal link={link} quote={{ author: 'Bob', text: 'Ship it', from: `${roomJid}/Bob` }} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('chat.forwardDestination'), { target: { value: 'em' } })
  fireEvent.keyDown(screen.getByLabelText('chat.forwardDestination'), { key: 'Enter' })
  fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: comment } })
  fireEvent.click(screen.getByRole('button', { name: 'chat.forwardSend' }))
}

describe('forward from the modal to the emitted stanza and back', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('sends one stanza with the quote, the copy and a copy fallback, and asks no device', async () => {
    const s = script()
    forwardTo('Please review')
    await waitFor(() => expect(s.sendStanza).toHaveBeenCalledOnce())
    expect(s.sendIQ).not.toHaveBeenCalled()
    const stanza: Element = s.sendStanza.mock.calls[0][0]
    const body = stanza.getChildText('body')!
    const quote = '> Bob wrote:\n> Ship it\n'
    expect(body).toBe(`Please review\n${quote}${link}`)
    expect(stanza.getChild('forwarded', NS_FORWARD)?.getChild('message')?.getChildText('body')).toBe('Ship it')
    const copyFallback = stanza.getChildren('fallback').filter(el => (el as Element).attrs.for === NS_FORWARD)
    expect(copyFallback).toHaveLength(1)
    const range = (copyFallback[0] as Element).getChild('body', NS_FALLBACK)!
    expect(body.slice(Number(range.attrs.start), Number(range.attrs.end))).toBe(`${quote}${link}`)
  })

  it('is read back as a copy with the quote range marked, so a reader that shows the copy can hide it', async () => {
    const s = script()
    forwardTo('Please review')
    await waitFor(() => expect(s.sendStanza).toHaveBeenCalledOnce())
    const stanza: Element = s.sendStanza.mock.calls[0][0]
    const body = stanza.getChildText('body')!
    const parsed = parseMessageContent({ messageEl: stanza, body })
    expect(parsed.forwarded?.text).toBe('Ship it')
    const { begin, end } = parsed.forwarded!.fallback!
    expect(parsed.processedBody.slice(begin, end)).toBe(`> Bob wrote:\n> Ship it\n${link}`)
    expect(parsed.processedBody.slice(0, begin)).toBe('Please review\n')
  })

  it('leaves the whole body to read when the copy is gone, as an archive that strips extensions delivers it', async () => {
    const s = script()
    forwardTo('Please review')
    await waitFor(() => expect(s.sendStanza).toHaveBeenCalledOnce())
    const stanza: Element = s.sendStanza.mock.calls[0][0]
    stanza.children = stanza.children.filter(child => typeof child === 'string' || (child as Element).name !== 'forwarded')
    const parsed = parseMessageContent({ messageEl: stanza, body: stanza.getChildText('body')! })
    expect(parsed.forwarded).toBeUndefined()
    expect(parsed.processedBody).toContain('> Bob wrote:')
  })
})
