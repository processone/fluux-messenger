/**
 * @vitest-environment jsdom
 *
 * Render-count regression guard for the message-row memo fix.
 *
 * Bug (both views): every existing message row re-rendered on every new message
 * because the row's `memo` was broken by unstable per-row props — a fresh
 * `messagesById` Map, inline `onReactionPickerChange`/`onMouseEnter` closures in
 * `renderMessage`, a recombined `room` object, an unmemoized `contactsByJid`, a
 * fresh `closedPollIds` Set, and unstable reply/nick callbacks. react-scan
 * measured ChatMessageBubble at 2720 and RoomMessageBubbleWrapper at 4984 renders
 * for a 40-message flood (≈ Σ list-length).
 *
 * Guard: when the list re-renders with a NEW `messages` array (same items, as
 * happens on every append), the existing rows must NOT re-render — their `memo`
 * must bail because every per-row prop is referentially stable. We count renders
 * of the inner MessageBubble, keyed by message id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

// Count inner MessageBubble renders by message id. Both ChatMessageBubble and
// RoomMessageBubbleWrapper render <MessageBubble message={message} .../>, so the
// id is available on the mock's props.
const bubbleRenders: Record<string, number> = {}
vi.mock('./conversation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversation')>()
  return {
    ...actual,
    MessageBubble: ({ message }: { message: { id: string } }) => {
      bubbleRenders[message.id] = (bubbleRenders[message.id] ?? 0) + 1
      return null
    },
  }
})

import { ChatMessageList } from './ChatView'
import { RoomMessageList } from './RoomView'
import type { Message, RoomMessage, Room } from '@fluux/sdk'

beforeEach(() => {
  for (const k of Object.keys(bubbleRenders)) delete bubbleRenders[k]
})

function chatMessages(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    from: 'alice@example.com',
    body: `message ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i),
    isOutgoing: false,
    type: 'chat',
  })) as unknown as Message[]
}

function roomMessages(n: number): RoomMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    stanzaId: `s${i}`,
    from: 'team@conf.example.com/Alice',
    nick: 'Alice',
    body: `message ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i),
    isOutgoing: false,
    type: 'groupchat',
  })) as unknown as RoomMessage[]
}

const stubRoom = {
  jid: 'team@conf.example.com',
  name: 'team',
  nickname: 'Me',
  joined: true,
  isJoining: false,
  supportsReactions: true,
  occupants: new Map(),
  nickToJidCache: new Map(),
  nickToAvatarCache: new Map(),
} as unknown as Room

// Stable props shared across both renders — only the `messages` array reference
// changes, exactly like a real message append.
const CHAT_PROPS = {
  contactsByJid: new Map(),
  typingUsers: [] as string[],
  scrollerRef: { current: null },
  isAtBottomRef: { current: true },
  conversationId: 'alice@example.com',
  conversationType: 'chat' as const,
  sendReaction: vi.fn(),
  myBareJid: 'me@example.com',
  ownAvatar: null,
  ownNickname: null,
  onReply: vi.fn(),
  onEdit: vi.fn(),
  lastOutgoingMessageId: null,
  lastMessageId: 'c4',
  isComposing: false,
  activeReactionPickerMessageId: null,
  onReactionPickerChange: vi.fn(),
  retractMessage: vi.fn(),
  retryMessage: vi.fn(),
  selectedMessageId: null,
  hasKeyboardSelection: false,
  showToolbarForSelection: false,
  firstNewMessageId: undefined,
  targetMessageId: null,
  clearTargetMessageId: vi.fn(),
  clearFirstNewMessageId: vi.fn(),
  onMessageSeen: vi.fn(),
  isDarkMode: false,
  onScrollToTop: vi.fn(),
  isLoadingOlder: false,
  isHistoryComplete: false,
  isInitialLoading: false,
  highlightTerms: undefined,
  currentMatchId: undefined,
  lastSentMessageId: null,
}

const ROOM_PROPS = {
  scrollerRef: { current: null },
  isAtBottomRef: { current: true },
  room: stubRoom,
  contactsByJid: new Map(),
  ownAvatar: null,
  sendReaction: vi.fn(),
  votePoll: vi.fn(),
  closePoll: vi.fn(),
  onReply: vi.fn(),
  onEdit: vi.fn(),
  lastOutgoingMessageId: null,
  lastMessageId: 'r4',
  typingUsers: [] as string[],
  isComposing: false,
  activeReactionPickerMessageId: null,
  onReactionPickerChange: vi.fn(),
  retractMessage: vi.fn(),
  moderateMessage: vi.fn(),
  selectedMessageId: null,
  hasKeyboardSelection: false,
  showToolbarForSelection: false,
  firstNewMessageId: undefined,
  targetMessageId: null,
  clearTargetMessageId: vi.fn(),
  clearFirstNewMessageId: vi.fn(),
  onMessageSeen: vi.fn(),
  isJoined: true,
  isDarkMode: false,
  onMediaLoad: vi.fn(),
  onScrollToTop: vi.fn(),
  isLoadingOlder: false,
  isHistoryComplete: false,
  onNickContextMenu: vi.fn(),
  onNickTouchStart: vi.fn(),
  onNickTouchEnd: vi.fn(),
  setAffiliation: vi.fn(),
  highlightTerms: undefined,
  currentMatchId: undefined,
  lastSentMessageId: null,
  forwardGapTimestamp: undefined,
  onCatchUpHistory: vi.fn(),
  isCatchingUp: false,
}

describe('message-row memo bailout (render-perf regression guard)', () => {
  it('ChatMessageList: appending a message does not re-render existing rows', () => {
    const msgs = chatMessages(5)
    const { rerender } = render(<ChatMessageList messages={msgs} {...CHAT_PROPS} />)
    const initial = { ...bubbleRenders }
    expect(Object.keys(initial).sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])

    // New array reference (same items) — the exact shape of a message append.
    rerender(<ChatMessageList messages={[...msgs]} {...CHAT_PROPS} />)
    for (const id of Object.keys(initial)) {
      expect(bubbleRenders[id]).toBe(initial[id])
    }
  })

  it('ChatMessageList: starting to type (isComposing toggling) does not re-render existing rows', () => {
    // `isComposing` flips true on the first keystroke and false ~1.5s after the
    // last. It used to be threaded into every row's `hideToolbar`, so each
    // typing burst re-rendered (and relayouted) the whole list. Hiding hover
    // toolbars while composing is now a container CSS concern, so the rows must
    // NOT re-render when composing state changes.
    const msgs = chatMessages(5)
    const { rerender } = render(<ChatMessageList messages={msgs} {...CHAT_PROPS} />)
    const initial = { ...bubbleRenders }
    expect(Object.keys(initial).sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])

    // Same messages array — only composing state changed.
    rerender(<ChatMessageList messages={msgs} {...{ ...CHAT_PROPS, isComposing: true }} />)
    for (const id of Object.keys(initial)) {
      expect(bubbleRenders[id]).toBe(initial[id])
    }
  })

  it('RoomMessageList: appending a message does not re-render existing rows', () => {
    const msgs = roomMessages(5)
    const { rerender } = render(<RoomMessageList messages={msgs} {...ROOM_PROPS} />)
    const initial = { ...bubbleRenders }
    expect(Object.keys(initial).sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])

    rerender(<RoomMessageList messages={[...msgs]} {...ROOM_PROPS} />)
    for (const id of Object.keys(initial)) {
      expect(bubbleRenders[id]).toBe(initial[id])
    }
  })
})
