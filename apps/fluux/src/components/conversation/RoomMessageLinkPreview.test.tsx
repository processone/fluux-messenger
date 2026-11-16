import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRoomMessageLink, connectionStore, roomStore, type BaseMessage, type Room, type RoomMessage } from '@fluux/sdk'
import { RoomMessageLinkPreview } from './RoomMessageLinkPreview'

vi.unmock('@fluux/sdk/react')
const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@fluux/sdk', async original => ({
  ...await original<typeof import('@fluux/sdk')>(),
  useXMPPContext: () => ({ client: client }),
}))
const client = { messages: { readRoomMessagePreview: read } }
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? ({ 'chat.messageDeleted': 'Message deleted' }[key] ?? key) }) }))

const jid = 'team@conference.example.org'
const target: RoomMessage = { type: 'groupchat', roomJid: jid, id: 'team-update', stanzaId: '1731490000123456', originId: undefined,
  from: `${jid}/Bob`, nick: 'Bob', occupantId: 'bob', body: 'The release notes are ready for review.', timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false }
const room: Room = { jid, name: 'Team', nickname: 'Alice', joined: true, isBookmarked: true,
  occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
const link = buildRoomMessageLink(jid, target.stanzaId!)
const shared: BaseMessage = { type: 'chat', id: 'shared-link', stanzaId: undefined, originId: undefined,
  from: 'bob@example.org', body: link, timestamp: new Date(), isOutgoing: false }
const formatTime = (date: Date) => date.toISOString().slice(11, 16)
function show(message = shared) { return render(<RoomMessageLinkPreview message={message} formatTime={formatTime} />) }

beforeEach(() => {
  vi.resetAllMocks()
  roomStore.getState().reset()
  connectionStore.getState().setJid('alice@example.org/web')
  read.mockResolvedValue({ kind: 'found', message: target })
})
afterEach(() => { roomStore.getState().reset(); connectionStore.getState().setJid(null) })

// Approved piece 2: reader-built quote for members, Join chip otherwise, and
// late archive results must never reveal room content after access/account loss.
describe('room link reader previews', () => {
  it('shows only Join for a non-member, without even reading cached content', () => {
    roomStore.getState().addRoom({ ...room, joined: false }, [target])
    show()
    expect(screen.getByRole('link', { name: 'Team Join the room to see it' }).getAttribute('href')).toBe(link)
    expect(screen.queryByText(target.body)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('shows a member quote from resident history with sender, time and room', () => {
    roomStore.getState().addRoom(room, [target])
    show()
    expect(screen.getByText('Team')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('10:00')).toBeTruthy()
    expect(screen.getByText(target.body)).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
    act(() => roomStore.getState().addRoom({ ...room, joined: false }))
    expect(screen.queryByText(target.body)).toBeNull()
    expect(screen.getByText('Join the room to see it')).toBeTruthy()
  })

  it('prefers a data reference to the body and resolves a missing resident quote read-only', async () => {
    roomStore.getState().addRoom(room)
    const bodyLink = buildRoomMessageLink('design@conference.example.org', '550e8400-e29b-41d4-a716-446655440000')
    show({ ...shared, body: bodyLink, references: [{ type: 'data', uri: link }] })
    await screen.findByText(target.body)
    expect(read).toHaveBeenCalledWith(jid, target.stanzaId)
    expect(screen.getByRole('link').getAttribute('href')).toBe(link)
  })

  it.each(['membership', 'account'])('discards a late quote after changing %s', async change => {
    roomStore.getState().addRoom(room)
    let finish!: (result: { kind: 'found'; message: RoomMessage }) => void
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    show()
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await act(async () => {
      if (change === 'membership') roomStore.getState().addRoom({ ...room, joined: false })
      else connectionStore.getState().setJid('carol@example.org/web')
      finish({ kind: 'found', message: target })
    })
    expect(screen.queryByText(target.body)).toBeNull()
    expect(screen.getByText('Join the room to see it')).toBeTruthy()
  })

  it.each([['absent', 'Message deleted'], ['unknown', 'Open message in room']])('distinguishes %s from other lookup outcomes', async (kind, notice) => {
    roomStore.getState().addRoom(room)
    read.mockResolvedValue({ kind })
    show()
    await screen.findByText(notice)
    expect(screen.queryByText(target.body)).toBeNull()
  })

  it('reacts to target retraction and never exposes encrypted fallback text', () => {
    roomStore.getState().addRoom(room, [{ ...target, unsupportedEncryption: { name: 'OMEMO', namespace: 'eu.siacs.conversations.axolotl' } }])
    show()
    expect(screen.queryByText(target.body)).toBeNull()
    act(() => roomStore.getState().addRoom(room, [{ ...target, isRetracted: true, body: '' }]))
    expect(screen.getByText('Message deleted')).toBeTruthy()
  })

  it('does not interpret undecrypted or retracted sharing messages', () => {
    const view = show({ ...shared, isRetracted: true })
    expect(screen.queryByRole('link')).toBeNull()
    view.rerender(<RoomMessageLinkPreview message={{ ...shared, unsupportedEncryption: { name: 'OMEMO', namespace: 'eu.siacs.conversations.axolotl' } }} formatTime={formatTime} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})
