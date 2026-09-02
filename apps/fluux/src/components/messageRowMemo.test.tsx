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

// Row-render-count guard for the non-virtualized full-mount path (still shipping until
// the old path is removed). Force the flag OFF so all rows mount and the counts are
// comparable; virtualization mounts only the window, a separate concern.
vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))
import { act, fireEvent, render, screen } from '@testing-library/react'

// Count inner MessageBubble renders by message id. Both ChatMessageBubble and
// RoomMessageBubbleWrapper render <MessageBubble message={message} .../>, so the
// id is available on the mock's props.
const bubbleRenders: Record<string, number> = {}
interface CapturedBubbleProps {
  message: { id: string; occupantId?: string }
  isSelected?: boolean
  isLastOutgoing?: boolean
  isLastMessage?: boolean
  hideToolbar?: boolean
  isHovered?: boolean
  isCurrentMatch?: boolean
  onReaction?: (emoji: string) => void
  onPollVote?: (emoji: string) => void
  onClosePoll?: () => void
  onDelete?: () => Promise<void>
}
const bubblePropsByOccupant = new Map<string, CapturedBubbleProps>()
vi.mock('./conversation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversation')>()
  return {
    ...actual,
    MessageBubble: (props: CapturedBubbleProps) => {
      const { message } = props
      bubbleRenders[message.id] = (bubbleRenders[message.id] ?? 0) + 1
      bubblePropsByOccupant.set(`${message.id}:${message.occupantId ?? ''}`, props)
      return null
    },
  }
})

import { ChatMessageList } from './ChatView'
import { RoomMessageList } from './RoomView'
import type { Message, PollData, RoomMessage, Room } from '@fluux/sdk'
import { messageRowId } from './conversation/messageRowIdentity'

beforeEach(() => {
  for (const k of Object.keys(bubbleRenders)) delete bubbleRenders[k]
  bubblePropsByOccupant.clear()
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
  firstNewMessageRow: undefined,
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
  firstNewMessageRow: undefined,
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
  it('keeps occupant-conflicting room interaction state row-local', () => {
    const poll: PollData = {
      title: 'Choose',
      options: [{ emoji: '1️⃣', label: 'One' }, { emoji: '2️⃣', label: 'Two' }],
      settings: { allowMultiple: false, hideResultsBeforeVote: false },
    }
    const messages = [
      { ...roomMessages(1)[0], id: 'shared', occupantId: 'occupant-a', poll, isOutgoing: true },
      { ...roomMessages(1)[0], id: 'shared', occupantId: 'occupant-b', poll, isOutgoing: true },
      {
        ...roomMessages(1)[0],
        id: 'closed',
        occupantId: 'occupant-b',
        pollClosed: { title: 'Choose', pollMessageId: 'shared', results: [] },
      },
    ]
    const secondRowId = messageRowId(messages[1])!

    render(<RoomMessageList
      messages={messages}
      {...ROOM_PROPS}
      selectedMessageId={secondRowId}
      lastOutgoingMessageId={secondRowId}
      lastMessageId={secondRowId}
      activeReactionPickerMessageId={secondRowId}
      currentMatchId={secondRowId}
    />)

    const first = bubblePropsByOccupant.get('shared:occupant-a')!
    const second = bubblePropsByOccupant.get('shared:occupant-b')!
    expect(first).toMatchObject({
      isSelected: false,
      isLastOutgoing: false,
      isLastMessage: false,
      hideToolbar: true,
      isCurrentMatch: false,
    })
    expect(second).toMatchObject({
      isSelected: true,
      isLastOutgoing: true,
      isLastMessage: true,
      hideToolbar: false,
      isCurrentMatch: true,
    })
    expect(first.onClosePoll).toBeTypeOf('function')
    expect(second.onClosePoll).toBeUndefined()
  })

  it('uses archive references for room reactions, polls, and retraction', async () => {
    const poll: PollData = {
      title: 'Choose',
      options: [{ emoji: '1️⃣', label: 'One' }, { emoji: '2️⃣', label: 'Two' }],
      settings: { allowMultiple: false, hideResultsBeforeVote: false },
    }
    const message = {
      ...roomMessages(1)[0],
      id: 'client-id',
      stanzaId: 'archive-id',
      originId: 'origin-id',
      occupantId: 'occupant-a',
      poll,
      isOutgoing: true,
    }
    const sendReaction = vi.fn().mockResolvedValue(undefined)
    const votePoll = vi.fn().mockResolvedValue(undefined)
    const closePoll = vi.fn().mockResolvedValue('closed-id')
    const retractMessage = vi.fn().mockResolvedValue(undefined)
    render(<RoomMessageList
      messages={[message]}
      {...ROOM_PROPS}
      sendReaction={sendReaction}
      votePoll={votePoll}
      closePoll={closePoll}
      retractMessage={retractMessage}
    />)
    const bubble = bubblePropsByOccupant.get('client-id:occupant-a')!

    bubble.onReaction?.('👍')
    expect(sendReaction).toHaveBeenCalledWith(stubRoom.jid, 'archive-id', ['👍'])
    bubble.onReaction?.('1️⃣')
    expect(votePoll).toHaveBeenCalledWith(stubRoom.jid, 'archive-id', '1️⃣', [], poll)
    bubble.onPollVote?.('2️⃣')
    expect(votePoll).toHaveBeenLastCalledWith(stubRoom.jid, 'archive-id', '2️⃣', [], poll, false)
    bubble.onClosePoll?.()
    expect(closePoll).toHaveBeenCalledWith(stubRoom.jid, 'archive-id')

    await act(async () => { await bubble.onDelete?.() })
    const confirm = screen.getAllByText('chat.deleteMessage').find(element => element.tagName === 'BUTTON')
    fireEvent.click(confirm!)
    expect(retractMessage).toHaveBeenCalledWith(stubRoom.jid, 'archive-id')
  })

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

  it('RoomMessageList: starting to type (isComposing toggling) does not re-render existing rows', () => {
    // Same decoupling as the 1:1 path: composing state hides hover toolbars via
    // a container CSS class, not a per-row prop, so a typing burst must not
    // re-render (and relayout) the whole room message list.
    const msgs = roomMessages(5)
    const { rerender } = render(<RoomMessageList messages={msgs} {...ROOM_PROPS} />)
    const initial = { ...bubbleRenders }
    expect(Object.keys(initial).sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])

    rerender(<RoomMessageList messages={msgs} {...{ ...ROOM_PROPS, isComposing: true }} />)
    for (const id of Object.keys(initial)) {
      expect(bubbleRenders[id]).toBe(initial[id])
    }
  })
})
