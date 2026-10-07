/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import * as sdk from '@fluux/sdk'
import type { ContactIdentity, Room, RoomMessage, RoomOccupant } from '@fluux/sdk'
import { RoomMessageList } from './RoomView'

vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
const { avatarRender } = vi.hoisted(() => ({ avatarRender: vi.fn() }))
vi.mock('./Avatar', () => ({
  Avatar: (props: { name?: string; avatarUrl?: string; identifier: string }) => {
    avatarRender(props)
    return <div data-testid="avatar" data-name={props.name} data-avatar-url={props.avatarUrl} data-identifier={props.identifier} />
  },
  getConsistentTextColor: () => '#000000',
}))

const props = {
  scrollerRef: { current: null },
  isAtBottomRef: { current: true },
  contactsByJid: new Map<string, ContactIdentity>(),
  sendReaction: vi.fn(), votePoll: vi.fn(), closePoll: vi.fn(), onReply: vi.fn(), onEdit: vi.fn(),
  lastOutgoingMessageId: null, lastMessageId: null, typingUsers: [], activeReactionPickerMessageId: null,
  onReactionPickerChange: vi.fn(), retractMessage: vi.fn(), moderateMessage: vi.fn(), selectedMessageId: null,
  hasKeyboardSelection: false, showToolbarForSelection: false, clearFirstNewMessageId: vi.fn(), setAffiliation: vi.fn(), isJoined: true,
}

const occupant = (nick: string): RoomOccupant => ({ nick, role: 'participant', affiliation: 'none' })
let roomNumber = 0
const fixture = (own = false) => {
  const nick = 'Alice/Work@Home'
  const room: Room = {
    jid: `reactors-${roomNumber++}@conference.example.test`, name: 'Reactors', nickname: own ? nick : 'Me', joined: true,
    occupants: new Map([['Bob', occupant('Bob')], ['Carol', occupant('Carol')], [nick, occupant(nick)], ['Zoe', occupant('Zoe')], ['Other', occupant('Other')]]),
    nickToAvatarCache: new Map(), nickToJidCache: new Map([[nick, 'alice@example.test']]),
  } as Room
  const messages: RoomMessage[] = ['Bob', 'Carol'].map((sender, index): RoomMessage => ({
    type: 'groupchat', id: sender, roomJid: room.jid, from: `${room.jid}/${sender}`, nick: sender, body: `${sender}'s message`,
    occupantId: undefined, stanzaId: undefined, originId: undefined,
    timestamp: new Date(1000 + index * 1000), isOutgoing: false,
    reactions: sender === 'Bob' ? { '🔥': [nick] } : { '👍': ['Zoe'] },
  }))
  return { nick, room, messages }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('live room reactor details', () => {
  it('keeps an anonymous reactor nickname and fallback avatar after departure', () => {
    vi.useFakeTimers()
    const { room, messages } = fixture()
    room.jid = 'r@conf'
    const nick = 'r@conf/Alice'
    room.nickToJidCache = new Map()
    room.nickToAvatarCache = new Map()
    room.occupants.set(nick, occupant(nick))
    room.occupants.set('Alice', { ...occupant('Alice'), avatar: '/wrong-alice.png' })
    for (const message of messages) {
      message.roomJid = room.jid
      message.from = `${room.jid}/${message.nick}`
    }
    messages[0].reactions = { '🔥': [nick] }
    const view = render(<RoomMessageList {...props} room={room} messages={messages} />)
    fireEvent.touchStart(screen.getByRole('button', { name: '🔥1' }))
    act(() => vi.advanceTimersByTime(500))
    const sheet = screen.getByRole('dialog', { name: 'chat.reactions' })
    const departed = { ...room, occupants: new Map(room.occupants) }
    departed.occupants.delete(nick)
    for (const currentRoom of [room, departed]) {
      view.rerender(<RoomMessageList {...props} room={currentRoom} messages={messages} />)
      expect(screen.getByRole('dialog', { name: 'chat.reactions' })).toBe(sheet)
      expect(within(sheet).getByText(nick)).toBeInTheDocument()
      expect(within(sheet).queryByText('Alice')).toBeNull()
      const avatar = within(sheet).getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-name', nick)
      expect(avatar).toHaveAttribute('data-identifier', nick)
      expect(avatar).not.toHaveAttribute('data-avatar-url')
    }
    fireEvent.click(within(sheet).getByRole('button', { name: 'common.close' }))
    fireEvent.mouseEnter(screen.getByRole('button', { name: '🔥1' }).parentElement!)
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole('tooltip')).toHaveTextContent(nick)
  })

  it.each(['occupant', 'avatar-cache', 'jid-cache'].flatMap(source => ['stored-nick', 'qualified-jid-source'].map(representation => ({ source, representation }))))(
    'preserves same-room-prefix nicknames in the tooltip and sheet from $source as $representation', ({ source, representation }) => {
      vi.useFakeTimers()
      const { room, messages } = fixture()
      const nick = `${room.jid}/Alice`
      room.occupants.set('Alice', { ...occupant('Alice'), avatar: '/wrong-alice.png' })
      if (source === 'occupant') room.occupants.set(nick, { ...occupant(nick), avatar: '/correct.png' })
      if (source === 'avatar-cache') room.nickToAvatarCache!.set(nick, '/correct.png')
      if (source === 'jid-cache') room.nickToJidCache!.set(nick, 'correct@example.test')
      messages[0].reactions = { '🔥': [representation === 'stored-nick' ? nick : sdk.getResource(`${room.jid}/${nick}`)!] }
      const contactsByJid = new Map<string, ContactIdentity>([['correct@example.test', { jid: 'correct@example.test', name: 'Correct', avatar: '/correct.png' }]])
      render(<RoomMessageList {...props} room={room} messages={messages} contactsByJid={contactsByJid} />)
      const chip = screen.getByRole('button', { name: '🔥1' })
      fireEvent.mouseEnter(chip.parentElement!)
      act(() => vi.advanceTimersByTime(300))
      expect(screen.getByRole('tooltip')).toHaveTextContent(nick)
      fireEvent.mouseLeave(chip.parentElement!)
      fireEvent.touchStart(chip)
      act(() => vi.advanceTimersByTime(500))
      const sheet = screen.getByRole('dialog', { name: 'chat.reactions' })
      expect(within(sheet).getByText(nick)).toBeInTheDocument()
      expect(within(sheet).queryByText('Alice')).toBeNull()
      const avatar = within(sheet).getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-name', nick)
      expect(avatar).toHaveAttribute('data-avatar-url', '/correct.png')
      expect(avatar).toHaveAttribute('data-identifier', source === 'jid-cache' ? 'correct@example.test' : nick)
    },
  )

  it.each(['occupant', 'nick-cache', 'contact', 'self'].flatMap(source => ['stored-nick', 'qualified-jid-source'].map(representation => ({ source, representation }))))(
    'updates an open sheet from $source using $representation identities', ({ source, representation }) => {
      vi.useFakeTimers()
      const { nick, room, messages } = fixture(source === 'self')
      if (representation === 'qualified-jid-source') messages[0].reactions = { '🔥': [sdk.getResource(`${room.jid}/${nick}`)!] }
      const rowRender = vi.spyOn(sdk, 'useReferencedMessage').mockReturnValue(undefined)
      const view = render(<RoomMessageList {...props} room={room} messages={messages} />)
      fireEvent.touchStart(screen.getByRole('button', { name: '🔥1' }))
      act(() => vi.advanceTimersByTime(500))
      const sheet = screen.getByRole('dialog', { name: 'chat.reactions' })
      const avatar = () => within(sheet).getByTestId('avatar')
      expect(avatar()).not.toHaveAttribute('data-avatar-url')
      rowRender.mockClear()
      avatarRender.mockClear()
      const updated = source === 'occupant' ? { ...room, occupants: new Map(room.occupants).set(nick, { ...occupant(nick), avatar: '/completed.png' }) }
        : source === 'nick-cache' ? { ...room, nickToAvatarCache: new Map([[nick, '/completed.png']]) } : room
      const contactsByJid = source === 'contact' ? new Map<string, ContactIdentity>([['alice@example.test', { jid: 'alice@example.test', name: 'Alice', avatar: '/completed.png' }]]) : props.contactsByJid
      view.rerender(<RoomMessageList {...props} room={updated} messages={messages} contactsByJid={contactsByJid} ownAvatar={source === 'self' ? '/completed.png' : undefined} />)
      expect(screen.getByRole('dialog', { name: 'chat.reactions' })).toBe(sheet)
      expect(avatar()).toHaveAttribute('data-name', nick)
      expect(avatar()).toHaveAttribute('data-avatar-url', '/completed.png')
      expect(avatar()).toHaveAttribute('data-identifier', 'alice@example.test')
      if (source === 'occupant' || source === 'nick-cache') {
        expect(rowRender).toHaveBeenCalledTimes(1)
        expect(avatarRender.mock.calls.some(([data]) => data.name === 'Carol')).toBe(false)
      }
      rowRender.mockClear()
      avatarRender.mockClear()
      const unrelated = { ...updated, occupants: new Map(updated.occupants).set('Other', { ...occupant('Other'), avatar: '/unrelated.png' }) }
      view.rerender(<RoomMessageList {...props} room={unrelated} messages={messages} contactsByJid={contactsByJid} ownAvatar={source === 'self' ? '/completed.png' : undefined} />)
      expect(avatar()).toHaveAttribute('data-avatar-url', '/completed.png')
      expect(rowRender).not.toHaveBeenCalled()
      expect(avatarRender).not.toHaveBeenCalled()
      view.rerender(<RoomMessageList {...props} room={room} messages={messages} />)
      expect(screen.getByRole('dialog', { name: 'chat.reactions' })).toBe(sheet)
      expect(avatar()).not.toHaveAttribute('data-avatar-url')
    },
  )
})
