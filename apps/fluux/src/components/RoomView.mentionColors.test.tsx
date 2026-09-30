/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { Room, RoomMessage, RoomOccupant } from '@fluux/sdk'
import { auroraSenderColor } from '@/utils/senderColor'
import { RoomMessageList } from './RoomView'

vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))

const props = {
  scrollerRef: { current: null },
  isAtBottomRef: { current: true },
  contactsByJid: new Map(),
  sendReaction: vi.fn(),
  votePoll: vi.fn(),
  closePoll: vi.fn(),
  onReply: vi.fn(),
  onEdit: vi.fn(),
  lastOutgoingMessageId: null,
  lastMessageId: null,
  typingUsers: [],
  activeReactionPickerMessageId: null,
  onReactionPickerChange: vi.fn(),
  retractMessage: vi.fn(),
  moderateMessage: vi.fn(),
  selectedMessageId: null,
  hasKeyboardSelection: false,
  showToolbarForSelection: false,
  clearFirstNewMessageId: vi.fn(),
  setAffiliation: vi.fn(),
  isJoined: true,
}

let nextRoom = 0
const room = (): Room => ({
  jid: `mentions-${nextRoom++}@conf.example.com`, name: 'Mentions', nickname: 'Me',
  joined: true, occupants: new Map(), nickToJidCache: new Map(), nickToAvatarCache: new Map(),
} as Room)
const occupant = (nick: string, occupantId: string): RoomOccupant => ({
  nick, occupantId, role: 'participant', affiliation: 'none',
})
const message = (r: Room, overrides: Partial<RoomMessage> = {}): RoomMessage => ({
  type: 'groupchat', id: 'mention', stanzaId: undefined, originId: undefined, occupantId: undefined,
  roomJid: r.jid, from: `${r.jid}/Alice`, nick: 'Alice', body: 'Hello @bob',
  timestamp: new Date('2026-02-01T12:00:00Z'), isOutgoing: false,
  ...overrides,
})
const pill = (container: HTMLElement) => container.querySelector<HTMLElement>(
  '[data-message-id="mention"] [data-msg-text] span.rounded.font-medium',
)
const expectColor = (container: HTMLElement, color: string) => {
  const expected = document.createElement('span')
  expected.style.color = color
  expect(pill(container)).not.toBeNull()
  expect(pill(container)?.style.color).toBe(expected.style.color)
}

describe('room mention colors across memo boundaries', () => {
  it.each([
    { body: 'Hello @Bob', isDarkMode: true },
    { body: 'Hello @bob', isDarkMode: false },
    { body: '/me greets @BOB', isDarkMode: true },
    { body: 'bob: hello', isDarkMode: false },
    { body: 'Hello Bob', isDarkMode: true, mentions: [{ type: 'mention' as const, begin: 6, end: 9, uri: 'xmpp:room@conf/Bob' }] },
  ])('updates a mounted mention when history supplies its identity: $body', ({ body, isDarkMode, mentions }) => {
    const r = room()
    const mention = message(r, { body, mentions })
    const { container, rerender } = render(
      <RoomMessageList {...props} room={r} messages={[mention]} isDarkMode={isDarkMode} />,
    )
    const row = container.querySelector('[data-message-id="mention"]')
    const oldColor = pill(container)?.style.color
    // Prepend within the same date group so the mention row stays mounted.
    const author = message(r, {
      id: 'author', nick: 'Bob', from: `${r.jid}/Bob`, body: 'Earlier message',
      occupantId: 'oid-bob', timestamp: new Date('2026-02-01T11:59:00Z'),
    })
    rerender(<RoomMessageList {...props} room={r} messages={[author, mention]} isDarkMode={isDarkMode} />)
    expect(container.querySelector('[data-message-id="mention"]')).toBe(row)
    expectColor(container, auroraSenderColor('oid-bob', isDarkMode))
    expect(pill(container)?.style.color).not.toBe(oldColor)
    rerender(<RoomMessageList {...props} room={r} messages={[mention]} isDarkMode={isDarkMode} />)
    expectColor(container, auroraSenderColor('oid-bob', isDarkMode))
  })

  it.each(['Hello @bob', 'bob: hello'])('retains presence identity outside the window through leave, remount and rejoin: %s', body => {
    const r = room()
    const present = { ...r, occupants: new Map([['Bob', occupant('Bob', 'oid-bob')]]) }
    const messages = [message(r, { body })]
    const view = render(<RoomMessageList {...props} room={present} messages={messages} isDarkMode />)
    const color = auroraSenderColor('oid-bob', true)
    expectColor(view.container, color)
    view.rerender(<RoomMessageList {...props} room={r} messages={messages} isDarkMode />)
    expectColor(view.container, color)
    view.unmount()
    const reopened = render(<RoomMessageList {...props} room={r} messages={messages} isDarkMode />)
    expectColor(reopened.container, color)
    reopened.rerender(<RoomMessageList {...props} room={present} messages={messages} isDarkMode />)
    expectColor(reopened.container, color)
  })

  it('keeps old self mentions self-colored until another occupant takes the nick', () => {
    const r = room()
    const original = { ...r, occupants: new Map([['Me', occupant('Me', 'oid-me')]]) }
    const mention = message(r, { body: 'Hello @me' })
    const own = message(r, { id: 'own', nick: 'Me', occupantId: 'oid-me', isOutgoing: true, body: 'My message' })
    const view = render(<RoomMessageList {...props} room={original} messages={[own, mention]} isDarkMode />)
    expectColor(view.container, 'var(--fluux-text-self)')
    const renamed = { ...r, nickname: 'NewMe', occupants: new Map([['NewMe', occupant('NewMe', 'oid-me')]]) }
    const notice = message(r, { id: 'notice', nick: 'Me', body: '', systemEvent: { kind: 'nick-changed', oldNick: 'Me', newNick: 'NewMe' } })
    view.rerender(<RoomMessageList {...props} room={renamed} messages={[mention, notice]} isDarkMode />)
    expectColor(view.container, 'var(--fluux-text-self)')
    const recycled = { ...renamed, occupants: new Map([...renamed.occupants, ['Me', occupant('Me', 'oid-other')]]) }
    view.rerender(<RoomMessageList {...props} room={recycled} messages={[mention]} isDarkMode />)
    expectColor(view.container, auroraSenderColor('oid-other', true))
  })

  it('keeps identities scoped to their room', () => {
    const first = room()
    const present = { ...first, occupants: new Map([['Bob', occupant('Bob', 'oid-bob')]]) }
    const view = render(<RoomMessageList {...props} room={present} messages={[message(first)]} isDarkMode />)
    expectColor(view.container, auroraSenderColor('oid-bob', true))
    const second = room()
    view.rerender(<RoomMessageList {...props} room={second} messages={[message(second)]} isDarkMode />)
    expectColor(view.container, auroraSenderColor('bob', true))
    view.rerender(<RoomMessageList {...props} room={first} messages={[message(first)]} isDarkMode />)
    expectColor(view.container, auroraSenderColor('oid-bob', true))
  })

  it('learns authors from loaded messages excluded from the display list', () => {
    const r = room()
    const mention = message(r)
    const author = message(r, { id: 'hidden-author', nick: 'Bob', occupantId: 'oid-bob' })
    const view = render(<RoomMessageList {...props} room={r} messages={[mention]} identityMessages={[author, mention]} isDarkMode />)
    expectColor(view.container, auroraSenderColor('oid-bob', true))
    expect(view.container.querySelector('[data-message-id="hidden-author"]')).toBeNull()
  })
})
