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

it('offers individual and sender moderation for an existing cache entry without authority metadata', async () => {
  const cached = { ...target }
  const props = { ...listProps(), messages: [cached] }
  const onModerateSender = vi.fn()
  expect(resolveRoomSender(cached, room, new Map(), room.occupants.get('Me')).canModerate).toBe(true)
  render(<RoomMessageList {...props} onModerateSender={onModerateSender} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  expect(screen.getByRole('button', { name: /Review messages from Alice/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Spam.*hide/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove message' }))
  expect(props.moderateMessage).toHaveBeenCalledWith(room.jid, cached.stanzaId, 'Spam')
})

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
    render(<RoomMessageList {...listProps()} messages={[{ ...target, occupantId: undefined }]} onModerateSender={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
    expect(screen.queryByRole('button', { name: /Review messages from/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove message' })).toBeInTheDocument()
  })
})


it('constructs room quotations from the cached archive owner ahead of a resident Spam alias', async () => {
  await clearAllMessages()
  const original = { ...target, body: 'Legitimate cached original' }
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
  const message = { ...target, stanzaId, isOutgoing: true }
  const props = { ...listProps(), messages: [message] }
  render(<RoomMessageList {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
  expect(props.retractMessage).toHaveBeenCalledExactlyOnceWith(room.jid, stanzaId ?? message.id)
  expect(props.moderateMessage).not.toHaveBeenCalled()
})

it.each(['Enter', 'button'])('moderates an existing cached message through %s without refetching it', async trigger => {
  await clearAllMessages()
  const legacy = { ...target, id: `legacy-client-${trigger}`, stanzaId: `legacy-archive-${trigger}`, body: 'Legacy body' }
  await saveRoomMessage(legacy)
  const cached = (await getRoomMessage(room.jid, legacy.id, legacy.from))!
  const client = new ModerationClient({ debug: false })
  ingestionClient = client
  const other = { ...legacy, id: 'other', stanzaId: 'other-archive', occupantId: 'other', body: 'Keep' }
  roomStore.getState().addRoom(room, [cached, other])
  const props = { ...listProps(), messages: [cached], moderateMessage: vi.fn(client.rooms.moderateMessage.bind(client.rooms)) }
  render(<RoomMessageList {...props} />)
  expect(resolveRoomSender(cached, room, new Map(), room.occupants.get('Me')).canModerate).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  if (trigger === 'Enter') fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  else fireEvent.click(screen.getByRole('button', { name: 'Remove message' }))
  await props.moderateMessage.mock.results[0].value
  expect(client.requests).toHaveLength(1)
  expect(client.requests[0].getChild('moderate', 'urn:xmpp:message-moderate:1')?.attrs.id).toBe(legacy.stanzaId)
  expect(roomStore.getState().messages.get(room.jid)?.find(row => row.id === other.id)?.isRetracted).not.toBe(true)
})

it.each(['Enter', 'button'])('refuses %s after an open dialog loses moderator permissions', async trigger => {
  const { message } = await ingestTarget(true)
  const props = { ...listProps(), messages: [message] }
  const view = render(<RoomMessageList {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete test message' }))
  view.rerender(<RoomMessageList {...props} room={{ ...room, occupants: new Map([['Me', { nick: 'Me', role: 'participant', affiliation: 'member' }]]) }} />)
  expect(screen.getByRole('button', { name: 'Remove message' })).toBeDisabled()
  if (trigger === 'Enter') fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  else fireEvent.click(screen.getByRole('button', { name: 'Remove message' }))
  expect(props.moderateMessage).not.toHaveBeenCalled()
})
