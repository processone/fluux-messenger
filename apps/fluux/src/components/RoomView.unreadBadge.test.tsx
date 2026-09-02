/**
 * @vitest-environment jsdom
 *
 * Regression guard for rooms' in-list unread
 * surfaces being frozen. RoomView.tsx used to read `unreadCount={room.unreadCount}` where
 * `room` is `stableRoom ?? activeRoom` — a deliberately frozen memo (RoomView.tsx ~341-360)
 * that refreshes only when jid/nickname/joined/supportsReactions/isIrcGateway/occupants/
 * nickToJidCache/nickToAvatarCache change. roomStore.addMessage produces a new room object
 * with a bumped unreadCount but the SAME occupants/cache references, so that frozen snapshot
 * never picked up the new count — the divider label, floating pill and FAB badge inside an
 * OPEN room stayed pinned at the activation-time value forever.
 *
 * Fix: RoomView now threads `unreadCount` into RoomMessageList as its OWN prop, sourced
 * straight off `activeRoom` (never off `room`/`stableRoom`). This test renders the actual
 * `RoomMessageList` component RoomView delegates to, holds the `room` prop byte-identical
 * across a rerender (mirroring the frozen stableRoom snapshot exactly, including its own
 * stale `unreadCount` field) while bumping only the sibling `unreadCount` prop — exactly the
 * shape of a live addMessage update while the room stays open.
 */
import { describe, it, expect, vi } from 'vitest'

// Non-virtualized path: deterministic DOM, matches the other RoomMessageList render tests
// (messageRowMemo.test.tsx, roomRowPresenceMemo.test.tsx).
vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))

import { render } from '@testing-library/react'
import { RoomMessageList } from './RoomView'
import type { RoomMessage, Room } from '@fluux/sdk'

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

// A byte-identical object across both renders — mirrors the frozen `stableRoom` snapshot
// RoomView passes as the `room` prop. Its OWN `unreadCount` field is seeded to match the
// FIRST render's count and deliberately never updated, exactly like the real frozen memo:
// if the fix regresses back to reading `room.unreadCount` internally, the second render
// would still see this stale "3", not the fresh "9" fed through the sibling prop.
const frozenRoom = {
  jid: 'team@conf.example.com',
  name: 'team',
  nickname: 'Me',
  joined: true,
  isJoining: false,
  supportsReactions: true,
  occupants: new Map(),
  nickToJidCache: new Map(),
  nickToAvatarCache: new Map(),
  unreadCount: 3,
} as unknown as Room

const ROOM_PROPS = {
  scrollerRef: { current: null },
  isAtBottomRef: { current: true },
  room: frozenRoom,
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
  activeReactionPickerMessageId: null,
  onReactionPickerChange: vi.fn(),
  retractMessage: vi.fn(),
  moderateMessage: vi.fn(),
  selectedMessageId: null,
  hasKeyboardSelection: false,
  showToolbarForSelection: false,
  firstNewMessageRow: { id: 'r2' },
  readPointerId: 'r1',
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

const divider = () => document.querySelector('[data-new-message-marker]')

const fab = (root: ParentNode) =>
  root.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLElement | null
const fabBadge = (root: ParentNode) => fab(root)?.querySelector('span') ?? null

function setupScrollContainer(container: HTMLDivElement) {
  let scrollTopValue = 0
  Object.defineProperty(container, 'scrollHeight', { value: 2000, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollTopValue,
    set: (v) => { scrollTopValue = v },
    configurable: true,
  })
  Object.defineProperty(container, 'scrollTo', {
    value: vi.fn((opts: ScrollToOptions) => { scrollTopValue = opts.top ?? scrollTopValue }),
    configurable: true,
  })
}

describe('RoomView unread badge — FIX 1 regression guard (frozen stableRoom)', () => {
  it('divider label and FAB badge track a fresh unreadCount even though the `room` prop (the frozen stableRoom snapshot) is byte-identical and stale across the rerender', () => {
    const msgs = roomMessages(5)
    const { container, rerender } = render(
      <RoomMessageList messages={msgs} unreadCount={3} {...ROOM_PROPS} />
    )

    expect(divider()?.textContent).toContain('3 new messages')

    const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement
    expect(scrollContainer).toBeTruthy()
    setupScrollContainer(scrollContainer)
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(fabBadge(document.body)?.textContent).toBe('3')

    // Same `room` reference (the frozen snapshot never changes — its own `unreadCount: 3`
    // field is left untouched), same `messages` array identity even — only the sibling
    // `unreadCount` prop bumps, exactly like a live addMessage update while the room stays
    // open with the same occupants/cache refs.
    rerender(<RoomMessageList messages={msgs} unreadCount={9} {...ROOM_PROPS} />)

    expect(divider()?.textContent).toContain('9 new messages')
    expect(fabBadge(document.body)?.textContent).toBe('9')
  })
})
