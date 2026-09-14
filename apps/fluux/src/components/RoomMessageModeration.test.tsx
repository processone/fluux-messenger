import 'fake-indexeddb/auto'
import { clearAllMessages, saveRoomMessage, getRoomMessage } from '@fluux/sdk/cache'
import { roomStore } from '@fluux/sdk/stores'
import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import en from '@/i18n/locales/en.json'
import type { Room, RoomMessage } from '@fluux/sdk'
import { XMPPClient } from '@fluux/sdk/core'
import { xml } from '@fluux/sdk/xmpp'
import { resolveRoomSender } from './conversation/roomSenderResolution'
import { RoomMessageList } from './RoomView'

beforeAll(() => { i18n.addResourceBundle('en', 'translation', en, true, true) })

vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))
vi.mock('./conversation', async importOriginal => {
  const actual = await importOriginal<typeof import('./conversation')>()
  return {
    ...actual,
    MessageBubble: ({ message, onDelete, replyContext }: { message: RoomMessage; onDelete: () => void; replyContext?: { body: string } }) =>
      <><button type="button" onClick={onDelete}>Delete test message</button><span>{message.body}</span><span>{replyContext?.body}</span></>,
  }
})

const target: RoomMessage = {
  type: 'groupchat', id: 'client-id', stanzaId: 'server-id', occupantId: 'sender',
  stanzaIdAuthority: { stanzaId: 'server-id', roomJid: 'room@conference.example.com', accountJid: null, id: 'client-id', from: 'room@conference.example.com/Alice', occupantId: 'sender' },
  roomJid: 'room@conference.example.com', from: 'room@conference.example.com/Alice',
  nick: 'Alice', body: 'Spam', timestamp: new Date(), isOutgoing: false,
}
const room: Room = {
  jid: target.roomJid, name: 'Room', nickname: 'Me', joined: true,
  supportsModeration: true, isBookmarked: true, unreadCount: 0, mentionsCount: 0,
  typingUsers: new Set(), occupants: new Map([
    ['Me', { nick: 'Me', role: 'moderator', affiliation: 'owner' }],
    ['Alice', { nick: 'Alice', role: 'participant', affiliation: 'member', occupantId: 'sender' }],
  ]),
}

function listProps(): ComponentProps<typeof RoomMessageList> {
  return {
    messages: [target], room, scrollerRef: { current: null }, isAtBottomRef: { current: true },
    onLiveEdgeMeasured: vi.fn(), contactsByJid: new Map(),
    sendReaction: vi.fn(), votePoll: vi.fn(), closePoll: vi.fn(), onReply: vi.fn(), onEdit: vi.fn(),
    lastOutgoingMessageId: null, lastMessageId: target.id, typingUsers: [],
    activeReactionPickerMessageId: null, onReactionPickerChange: vi.fn(),
    retractMessage: vi.fn(), moderateMessage: vi.fn(), selectedMessageId: null,
    hasKeyboardSelection: false, showToolbarForSelection: false, clearFirstNewMessageId: vi.fn(),
    isJoined: true, isHistoryComplete: true, setAffiliation: vi.fn(),
  }
}

describe('message delete dialog bulk entry', () => {
  it('offers sender review without deleting and passes the exact message identity', () => {
    const props = listProps()
    const onModerateSender = vi.fn()
    render(<RoomMessageList {...props} onModerateSender={onModerateSender} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
    fireEvent.click(screen.getByRole('button', { name: /Review messages from Alice/ }))
    expect(onModerateSender).toHaveBeenCalledWith(target)
    expect(props.moderateMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Review messages from Alice/ })).not.toBeInTheDocument()
  })

  it('offers Spam as a canonical reason for single-message moderation', () => {
    const props = listProps()
    render(<RoomMessageList {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
    fireEvent.click(screen.getByRole('button', { name: /Spam.*hide/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove message' }))
    expect(props.moderateMessage).toHaveBeenCalledWith(room.jid, target.stanzaId, 'Spam')
  })

  it('keeps the existing single-message removal', () => {
    const props = listProps()
    const onModerateSender = vi.fn()
    render(<RoomMessageList {...props} onModerateSender={onModerateSender} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove message' }))
    expect(props.moderateMessage).toHaveBeenCalledWith(room.jid, target.stanzaId, undefined)
    expect(onModerateSender).not.toHaveBeenCalled()
  })

  it('does not group an author using only a recyclable nickname', () => {
    render(<RoomMessageList {...listProps()} messages={[{ ...target, occupantId: undefined, stanzaIdAuthority: { ...target.stanzaIdAuthority!, occupantId: undefined } }]} onModerateSender={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
    expect(screen.queryByRole('button', { name: /Review messages from/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove message' })).toBeInTheDocument()
  })
})


it('constructs room quotations from the cached archive owner ahead of a resident Spam alias', async () => {
  await clearAllMessages()
  const original = { ...target, stanzaIdAuthority: undefined, body: 'Legitimate cached original' }
  await saveRoomMessage(original)
  const collision = { ...target, id: target.stanzaId!, stanzaId: 'other-archive', occupantId: 'other',
    isRetracted: true, isModerated: true, moderationReason: 'Spam' }
  roomStore.setState({ messages: new Map([[room.jid, [collision]]]), pendingRetractions: new Map() })
  const reply = { ...target, id: 'reply', stanzaId: 'reply-archive', body: 'Reply',
    replyTo: { id: target.stanzaId!, to: target.from, fallbackBody: 'Fallback quotation' } }
  render(<RoomMessageList {...listProps()} messages={[reply]} />)
  await waitFor(() => expect(screen.getByText(original.body)).toBeInTheDocument())
})

let ingestionClient: XMPPClient | undefined
class ModerationClient extends XMPPClient {
  readonly requests: ReturnType<typeof xml>[] = []
  protected override async sendIQ(iq: ReturnType<typeof xml>): Promise<ReturnType<typeof xml>> {
    this.requests.push(iq)
    return xml('iq', { type: 'result', id: iq.attrs.id })
  }
}
afterEach(() => { ingestionClient?.destroy(); ingestionClient = undefined })

async function ingestTarget(verified: boolean) {
  await clearAllMessages()
  const other = { ...target, id: 'other-client', stanzaId: 'colliding-id', occupantId: 'other-author', from: `${room.jid}/Bob`, nick: 'Bob', body: 'Legitimate row' }
  roomStore.getState().addRoom(room, [other])
  ingestionClient = new XMPPClient({ debug: false })
  const stanza = xml('message', { from: target.from, id: 'colliding-id', type: 'groupchat' },
    xml('body', {}, 'Incoming target'),
    xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'sender' }),
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: 'foreign.example.com', id: 'foreign-id' }))
  if (verified) stanza.children.push(xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: room.jid, id: 'verified-id' }))
  ingestionClient.messages.handle(stanza)
  const message = roomStore.getState().messages.get(room.jid)!.find(row => row.body === 'Incoming target')!
  expect(message).toBeDefined()
  expect(message.stanzaId).toBe(verified ? 'verified-id' : undefined)
  return { message, other }
}

it.each([false, true])('requires a room ID for individual action eligibility after real ingestion (verified: %s)', async verified => {
  const { message } = await ingestTarget(verified)
  const sender = resolveRoomSender(message, room, new Map(), room.occupants.get('Me'))
  expect(sender.canModerate).toBe(verified)
})

it('closes individual moderation when an open target loses its room ID', async () => {
  const { message } = await ingestTarget(true)
  const props = { ...listProps(), messages: [message] }
  const view = render(<RoomMessageList {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  expect(screen.getByRole('textbox')).toBeInTheDocument()
  view.rerender(<RoomMessageList {...props} messages={[{ ...message, stanzaId: undefined }]} />)
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove message' })).not.toBeInTheDocument()
  expect(props.moderateMessage).not.toHaveBeenCalled()
  expect(props.retractMessage).not.toHaveBeenCalled()
})

it.each(['Enter', 'button'])('submits only the verified room ID through %s after real ingestion', async trigger => {
  const { message, other } = await ingestTarget(true)
  const props = { ...listProps(), messages: [message] }
  render(<RoomMessageList {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  fireEvent.click(screen.getByRole('button', { name: /Spam.*hide/ }))
  if (trigger === 'Enter') fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  else fireEvent.click(screen.getByRole('button', { name: 'Remove message' }))
  expect(props.moderateMessage).toHaveBeenCalledExactlyOnceWith(room.jid, 'verified-id', 'Spam')
  expect(roomStore.getState().messages.get(room.jid)?.find(row => row.stanzaId === other.stanzaId)).toEqual(other)
})

it.each([undefined, 'legacy-stanza-id'])('preserves self-retraction with unverified room ID %s', stanzaId => {
  const message = { ...target, stanzaId, stanzaIdAuthority: undefined, isOutgoing: true }
  const props = { ...listProps(), messages: [message] }
  render(<RoomMessageList {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
  expect(props.retractMessage).toHaveBeenCalledExactlyOnceWith(room.jid, stanzaId ?? message.id)
  expect(props.moderateMessage).not.toHaveBeenCalled()
})

it.each(['Enter', 'button'])('preserves a legacy cached row but refuses individual %s moderation', async trigger => {
  await clearAllMessages()
  const confirmedId = `confirmed-original-${trigger}`
  const legacy = { ...target, id: `legacy-client-${trigger}`, stanzaId: `legacy-archive-${trigger}`,
    stanzaIdAuthority: undefined, body: 'Legacy visible body' }
  await saveRoomMessage(legacy)
  const cached = (await getRoomMessage(room.jid, legacy.id, legacy.from))!
  expect(cached.body).toBe(legacy.body)
  const client = new ModerationClient({ debug: false })
  ingestionClient = client
  const other = { ...legacy, id: `distinct-client-${trigger}`, occupantId: 'other', from: `${room.jid}/Bob`, nick: 'Bob', body: 'Distinct archive owner' }
  roomStore.getState().addRoom(room, [cached, other])
  const props = { ...listProps(), messages: [cached], moderateMessage: vi.fn(client.rooms.moderateMessage.bind(client.rooms)) }
  const view = render(<RoomMessageList {...props} />)
  expect.soft(resolveRoomSender(cached, room, new Map(), room.occupants.get('Me')).canModerate).toBe(false)
  expect(screen.getByText(legacy.body)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  const textbox = screen.queryByRole('textbox')
  const button = screen.queryByRole('button', { name: 'Remove message' })
  if (trigger === 'Enter' && textbox) fireEvent.keyDown(textbox, { key: 'Enter' })
  if (trigger === 'button' && button) fireEvent.click(button)
  expect(props.moderateMessage).not.toHaveBeenCalled()
  expect(client.requests).toEqual([])
  expect(await getRoomMessage(room.jid, legacy.id, legacy.from)).toMatchObject({ body: legacy.body, stanzaId: legacy.stanzaId })
  client.messages.handle(xml('message', { from: legacy.from, type: 'groupchat', id: legacy.id },
    xml('delay', { xmlns: 'urn:xmpp:delay', stamp: legacy.timestamp.toISOString() }),
    xml('body', {}, legacy.body), xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: legacy.occupantId! }),
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: room.jid, id: confirmedId })))
  await waitFor(() => expect(roomStore.getState().messages.get(room.jid)!.filter(row => row.id === legacy.id))
    .toMatchObject([{ stanzaId: confirmedId }]))
  const confirmed = roomStore.getState().messages.get(room.jid)!.find(row => row.id === legacy.id)!
  expect(confirmed.stanzaId).toBe(confirmedId)
  view.rerender(<RoomMessageList {...props} messages={[confirmed]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  if (trigger === 'Enter') fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  else fireEvent.click(screen.getByRole('button', { name: 'Remove message' }))
  expect(client.requests).toHaveLength(1)
  expect(client.requests[0].getChild('moderate', 'urn:xmpp:message-moderate:1')?.attrs.id).toBe(confirmedId)
  await props.moderateMessage.mock.results[0].value
  expect(roomStore.getState().messages.get(room.jid)?.find(row => row.id === other.id)?.isRetracted).not.toBe(true)
})

it.each(['Enter', 'button'])('refuses %s after an open dialog loses authority without losing its ID', async trigger => {
  const { message } = await ingestTarget(true)
  const props = { ...listProps(), messages: [message] }
  const view = render(<RoomMessageList {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  view.rerender(<RoomMessageList {...props} messages={[{ ...message, stanzaIdAuthority: undefined }]} />)
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove message' })).not.toBeInTheDocument()
  if (trigger === 'Enter') fireEvent.keyDown(document, { key: 'Enter' })
  else fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  expect(props.moderateMessage).not.toHaveBeenCalled()
})
