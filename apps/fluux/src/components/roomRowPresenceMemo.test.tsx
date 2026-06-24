/**
 * @vitest-environment jsdom
 *
 * Render-count regression guard for the per-occupant row re-render on presence churn.
 *
 * Fix (fix/muc-presence-row-decoupling): RoomMessageList resolves each message's sender
 * in the list layer and passes stable per-row props to the memoized
 * RoomMessageBubbleWrapper — it no longer receives the whole `room` object.
 * roomStore.addOccupant preserves unchanged occupants' object references, so only the
 * changed occupant gets a new object; every other row's shallow memo should bail.
 *
 * Guard:
 *   Test 1 — presence FLAP of alice re-renders only alice's rows; bob's and carol's
 *             rows must NOT re-render.
 *   Test 2 — appending a new message does not re-render any pre-existing rows.
 *
 * NOTE on intentional omission: an occupant JOIN or LEAVE is NOT asserted to bail.
 * A nick-set change updates `knownNicks` (via stableNickSet), which is passed to all
 * rows for IRC-style mention highlighting — so all rows legitimately re-render in that
 * case. The omission is by design, not a coverage gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

// Row-render-count guard for the non-virtualized full-mount path (still shipping until
// the old path is removed). Force the flag OFF so all rows mount and the counts are
// comparable; virtualization mounts only the window, a separate concern.
vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))

// Count inner MessageBubble renders by message id. RoomMessageBubbleWrapper renders
// <MessageBubble message={message} .../>, so the id is available on the mock's props.
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

import { RoomMessageList } from './RoomView'
import type { RoomMessage, Room, RoomOccupant } from '@fluux/sdk'

beforeEach(() => {
  for (const k of Object.keys(bubbleRenders)) delete bubbleRenders[k]
})

// Build a minimal occupant object.
const occ = (nick: string, show = 'online'): RoomOccupant =>
  ({ nick, role: 'participant', affiliation: 'none', show }) as unknown as RoomOccupant

// Build a minimal RoomMessage.
const roomMsg = (id: string, nick: string): RoomMessage =>
  ({
    id,
    stanzaId: `s_${id}`,
    from: `team@conf.example.com/${nick}`,
    nick,
    body: id,
    timestamp: new Date(2024, 0, 1, 12, 0),
    isOutgoing: false,
    type: 'groupchat',
  }) as unknown as RoomMessage

const stubRoom: Room = {
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

// Stable props shared across renders — mirrors the ROOM_PROPS shape in messageRowMemo.test.tsx.
const ROOM_PROPS = {
  scrollerRef: { current: null },
  isAtBottomRef: { current: true },
  contactsByJid: new Map(),
  ownAvatar: null,
  sendReaction: vi.fn(),
  votePoll: vi.fn(),
  closePoll: vi.fn(),
  onReply: vi.fn(),
  onEdit: vi.fn(),
  lastOutgoingMessageId: null,
  lastMessageId: 'c1',
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

describe('RoomMessageList per-occupant row memo (presence-churn regression guard)', () => {
  it('Test 1: presence FLAP of alice re-renders only alice rows; bob and carol rows bail', () => {
    // Three occupants, 2 messages each.
    const A0 = occ('alice')
    const B0 = occ('bob')
    const C0 = occ('carol')
    const occupants0 = new Map<string, RoomOccupant>([
      ['alice', A0],
      ['bob', B0],
      ['carol', C0],
    ])
    const msgs: RoomMessage[] = [
      roomMsg('a0', 'alice'),
      roomMsg('b0', 'bob'),
      roomMsg('c0', 'carol'),
      roomMsg('a1', 'alice'),
      roomMsg('b1', 'bob'),
      roomMsg('c1', 'carol'),
    ]
    const room0: Room = { ...stubRoom, occupants: occupants0 }

    const { rerender } = render(
      <RoomMessageList room={room0} messages={msgs} {...ROOM_PROPS} />
    )
    const before = { ...bubbleRenders }

    // Presence flap: alice gets a NEW occupant object (show changed), bob and carol keep
    // their SAME refs — exactly what roomStore.addOccupant does on a single presence stanza.
    const room1: Room = {
      ...room0,
      occupants: new Map<string, RoomOccupant>([
        ['alice', occ('alice', 'away')], // new object — show changed
        ['bob', B0],                      // same ref — unchanged
        ['carol', C0],                    // same ref — unchanged
      ]),
    }
    rerender(<RoomMessageList room={room1} messages={msgs} {...ROOM_PROPS} />)

    // Alice's rows must have re-rendered exactly once (presence change propagated).
    expect(bubbleRenders['a0'] - (before['a0'] ?? 0)).toBe(1)
    expect(bubbleRenders['a1'] - (before['a1'] ?? 0)).toBe(1)

    // Bob's and carol's rows must NOT have re-rendered (memo bailed).
    expect(bubbleRenders['b0'] - (before['b0'] ?? 0)).toBe(0)
    expect(bubbleRenders['b1'] - (before['b1'] ?? 0)).toBe(0)
    expect(bubbleRenders['c0'] - (before['c0'] ?? 0)).toBe(0)
    expect(bubbleRenders['c1'] - (before['c1'] ?? 0)).toBe(0)
  })

  it('Test 2: appending a message does not re-render pre-existing rows', () => {
    const A0 = occ('alice')
    const B0 = occ('bob')
    const C0 = occ('carol')
    const occupants0 = new Map<string, RoomOccupant>([
      ['alice', A0],
      ['bob', B0],
      ['carol', C0],
    ])
    const msgs: RoomMessage[] = [
      roomMsg('a0', 'alice'),
      roomMsg('b0', 'bob'),
      roomMsg('c0', 'carol'),
      roomMsg('a1', 'alice'),
      roomMsg('b1', 'bob'),
      roomMsg('c1', 'carol'),
    ]
    const room0: Room = { ...stubRoom, occupants: occupants0 }

    const { rerender } = render(
      <RoomMessageList room={room0} messages={msgs} {...ROOM_PROPS} />
    )
    const before = { ...bubbleRenders }
    expect(Object.keys(before).sort()).toEqual(['a0', 'a1', 'b0', 'b1', 'c0', 'c1'])

    // Append a new bob message — same room0 ref, new messages array ref.
    rerender(
      <RoomMessageList
        room={room0}
        messages={[...msgs, roomMsg('b2', 'bob')]}
        {...ROOM_PROPS}
      />
    )

    // Every pre-existing row must NOT have re-rendered.
    for (const id of ['a0', 'a1', 'b0', 'b1', 'c0', 'c1']) {
      expect(bubbleRenders[id] - (before[id] ?? 0)).toBe(0)
    }
    // The newly mounted row b2 must have rendered at least once.
    expect(bubbleRenders['b2']).toBeGreaterThanOrEqual(1)
  })
})
