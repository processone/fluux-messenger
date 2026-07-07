# Gated Room Typing Indicator in the Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a typing indicator on a joined room's sidebar row only when the room is caught up (zero unread) and not the active room, and make the 1:1 sidebar typing overlay follow the same suppress-on-active rule.

**Architecture:** A pure helper computes the visible typing nicks for a room (own nick + ignored users removed). `RoomItem` gates on `joined && unreadCount === 0 && !isActive` and replaces its preview line with a compact variant of the existing text `TypingIndicator`. `ConversationItem` gains a `!isActive` guard on its existing avatar typing overlay. No SDK changes — `room.typingUsers` is already tracked, and `RoomItem` already re-renders on its own room's typing churn.

**Tech Stack:** React + TypeScript, Zustand stores (`@fluux/sdk`), Vitest + Testing Library, Tailwind, react-i18next.

## Global Constraints

- No new SDK work — `room.typingUsers` is already tracked in `roomStore`.
- No new i18n strings — reuse the existing `chat.typing.{one,two,three,many}` keys.
- Preserve the sidebar's per-row subscription model — do not introduce list-wide subscriptions; each row subscribes only to its own room / ignore entry.
- Reuse the ignore filter the room view already applies: `isMessageFromIgnoredUser(ignoredForRoom, { nick }, cache)` from `@fluux/sdk`, with `ignoredForRoom` from `useIgnoreStore((s) => s.ignoredUsers[roomJid] ?? EMPTY)`.
- Run app tests per-workspace: `cd apps/fluux && npx vitest run <path>`.

---

### Task 1: `visibleRoomTypingNicks` pure helper

**Files:**
- Create: `apps/fluux/src/utils/roomTyping.ts`
- Test: `apps/fluux/src/utils/roomTyping.test.ts`

**Interfaces:**
- Consumes: `Room` (type) and `isMessageFromIgnoredUser` from `@fluux/sdk`; `IgnoredUser` (type) from `@fluux/sdk/stores`.
- Produces: `visibleRoomTypingNicks(room: Room, ignoredForRoom: IgnoredUser[]): string[]` — order-preserving array of typing nicknames with the user's own nick and ignored users removed; `[]` when none apply.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/roomTyping.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

// isMessageFromIgnoredUser treats a user as ignored when their nick appears in
// the ignored list. Mock it so the helper test does not depend on the real
// nick→JID resolution.
vi.mock('@fluux/sdk', () => ({
  isMessageFromIgnoredUser: (
    ignored: { nick?: string }[],
    msg: { nick?: string },
  ) => ignored.some((i) => i.nick === msg.nick),
}))

import { visibleRoomTypingNicks } from './roomTyping'
import type { Room } from '@fluux/sdk'

const makeRoom = (over: Partial<Room> = {}): Room =>
  ({
    jid: 'team@conference.fluux.chat',
    nickname: 'me',
    nickToJidCache: new Map(),
    typingUsers: new Set<string>(),
    ...over,
  }) as Room

describe('visibleRoomTypingNicks', () => {
  it('returns [] when nobody is typing', () => {
    expect(visibleRoomTypingNicks(makeRoom(), [])).toEqual([])
  })

  it('returns the typing nicks in order', () => {
    const room = makeRoom({ typingUsers: new Set(['Alice', 'Bob']) })
    expect(visibleRoomTypingNicks(room, [])).toEqual(['Alice', 'Bob'])
  })

  it('excludes the user own nickname', () => {
    const room = makeRoom({ nickname: 'me', typingUsers: new Set(['me', 'Alice']) })
    expect(visibleRoomTypingNicks(room, [])).toEqual(['Alice'])
  })

  it('excludes ignored users', () => {
    const room = makeRoom({ typingUsers: new Set(['Alice', 'Troll']) })
    expect(visibleRoomTypingNicks(room, [{ nick: 'Troll' }] as never)).toEqual(['Alice'])
  })

  it('returns [] when the only typist is ignored or self', () => {
    const room = makeRoom({ nickname: 'me', typingUsers: new Set(['me', 'Troll']) })
    expect(visibleRoomTypingNicks(room, [{ nick: 'Troll' }] as never)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/roomTyping.test.ts`
Expected: FAIL — `visibleRoomTypingNicks` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/fluux/src/utils/roomTyping.ts`:

```typescript
import { isMessageFromIgnoredUser, type Room } from '@fluux/sdk'
import type { IgnoredUser } from '@fluux/sdk/stores'

/**
 * Nicknames to display as "typing" on a room's sidebar row, with the user's own
 * nick and any ignored users removed. Order-preserving. Returns [] when none apply.
 *
 * Mirrors the ignore filter RoomView applies to its live typing indicator so the
 * sidebar and the open room agree on who counts as typing.
 */
export function visibleRoomTypingNicks(room: Room, ignoredForRoom: IgnoredUser[]): string[] {
  if (!room.typingUsers || room.typingUsers.size === 0) return []
  const own = room.nickname
  const cache = room.nickToJidCache
  return Array.from(room.typingUsers).filter(
    (nick) => nick !== own && !isMessageFromIgnoredUser(ignoredForRoom, { nick }, cache),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/roomTyping.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/roomTyping.ts apps/fluux/src/utils/roomTyping.test.ts
git commit --no-gpg-sign -m "feat(sidebar): visibleRoomTypingNicks helper for gated room typing"
```

---

### Task 2: Compact variant for the text `TypingIndicator`

**Files:**
- Modify: `apps/fluux/src/components/conversation/TypingIndicator.tsx`
- Test: `apps/fluux/src/components/conversation/TypingIndicator.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TypingIndicator` now accepts `variant?: 'default' | 'compact'` (default `'default'`). `compact` drops the message-view padding and uses `text-xs` with a truncating label, so the indicator fits a sidebar preview line. The dots and `chat.typing.*` text are unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/TypingIndicator.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { TypingIndicator } from './TypingIndicator'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('TypingIndicator variants', () => {
  it('renders nothing when no one is typing', () => {
    const { container } = render(<TypingIndicator typingUsers={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('uses message-view padding by default', () => {
    const { container } = render(<TypingIndicator typingUsers={['Alice']} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('py-2')
    expect(root.className).toContain('text-sm')
  })

  it('drops padding and shrinks text in the compact variant', () => {
    const { container } = render(
      <TypingIndicator typingUsers={['Alice']} variant="compact" />,
    )
    const root = container.firstChild as HTMLElement
    expect(root.className).not.toContain('py-2')
    expect(root.className).toContain('text-xs')
  })

  it('still renders three shimmer dots in the compact variant', () => {
    const { container } = render(
      <TypingIndicator typingUsers={['Alice']} variant="compact" />,
    )
    expect(container.querySelectorAll('.typing-dot').length).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/TypingIndicator.test.tsx`
Expected: FAIL — the compact test finds `py-2` (variant not implemented yet).

- [ ] **Step 3: Write minimal implementation**

In `apps/fluux/src/components/conversation/TypingIndicator.tsx`, add the prop and branch the container/label classes. Replace the interface addition and the `return` block:

Add to `TypingIndicatorProps` (after `formatUser?`):

```tsx
  /**
   * Visual density. 'default' is the message-view sizing; 'compact' drops the
   * padding and uses text-xs so it fits a sidebar preview line.
   */
  variant?: 'default' | 'compact'
```

Update the signature default:

```tsx
export function TypingIndicator({ typingUsers, formatUser, className = '', variant = 'default' }: TypingIndicatorProps) {
```

Replace the final `return (...)` with:

```tsx
  const containerClass =
    variant === 'compact'
      ? `text-xs text-fluux-muted italic flex items-center gap-1.5 min-w-0 ${className}`
      : `py-2 px-4 text-sm text-fluux-muted italic flex items-center gap-2 ${className}`

  return (
    <div className={containerClass}>
      {/* Dots bounce and shimmer through the aurora hues (delays + colors in CSS). */}
      <span className="flex gap-0.5 flex-shrink-0" aria-hidden="true">
        <span className="size-1.5 rounded-full typing-dot" />
        <span className="size-1.5 rounded-full typing-dot" />
        <span className="size-1.5 rounded-full typing-dot" />
      </span>
      <span className={variant === 'compact' ? 'truncate' : ''}>{text}</span>
    </div>
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/TypingIndicator.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify the message-view usage still compiles**

Run: `cd apps/fluux && npx vitest run src/components/RoomView` (if a RoomView test exists) or skip. Then typecheck: `npm run typecheck`
Expected: PASS — the new prop is optional, existing call sites are unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/conversation/TypingIndicator.tsx apps/fluux/src/components/conversation/TypingIndicator.test.tsx
git commit --no-gpg-sign -m "feat(typing): compact variant for sidebar preview line"
```

---

### Task 3: `RoomItem` — gate and render room typing in the preview line

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/RoomsList.tsx`
- Test: `apps/fluux/src/components/sidebar-components/RoomsList.typing.test.tsx`

**Interfaces:**
- Consumes: `visibleRoomTypingNicks` (Task 1); `TypingIndicator` compact variant (Task 2); `useIgnoreStore` from `@fluux/sdk/react`.
- Produces: `RoomItem` exported (was module-private) for testing. When `room.joined && room.unreadCount === 0 && !isActive` and at least one non-self, non-ignored occupant is typing, the row's second line renders `<TypingIndicator variant="compact" typingUsers={nicks} />` instead of the message preview.

- [ ] **Step 1: Add the imports and stable empty array**

In `apps/fluux/src/components/sidebar-components/RoomsList.tsx`:

Change the `@fluux/sdk/react` import (currently `import { useChatStore, useRoomStore } from '@fluux/sdk/react'`) to:

```tsx
import { useChatStore, useRoomStore, useIgnoreStore } from '@fluux/sdk/react'
```

Add these imports near the other local imports (e.g. after the `formatLocalizedPreview` import):

```tsx
import { visibleRoomTypingNicks } from '@/utils/roomTyping'
import { TypingIndicator } from '../conversation/TypingIndicator'
```

Add a module-scope stable empty array (near the top of the file, after imports) to keep the `useIgnoreStore` selector from returning a fresh `[]` each render:

```tsx
// Stable empty reference for the ignore selector — avoids a new array identity
// per render (which would defeat the per-row memo / trip a render loop).
const EMPTY_IGNORED_ARRAY: import('@fluux/sdk/stores').IgnoredUser[] = []
```

- [ ] **Step 2: Write the failing test**

Create `apps/fluux/src/components/sidebar-components/RoomsList.typing.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Room } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

// Real helper is fine (pure); stub the ignore predicate it calls.
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    isMessageFromIgnoredUser: (ignored: { nick?: string }[], msg: { nick?: string }) =>
      ignored.some((i) => i.nick === msg.nick),
    roomActivityTone: () => 'neutral',
    generateConsistentColorHexSync: () => '#123456',
  }
})

const h = vi.hoisted(() => ({ room: null as Room | null, ignored: [] as unknown[] }))

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (selector: (s: {
    getRoom: (jid: string) => Room | null
    drafts: Map<string, string>
  }) => unknown) => selector({ getRoom: () => h.room, drafts: new Map() }),
  useChatStore: (selector: (s: unknown) => unknown) => selector({}),
  useIgnoreStore: (selector: (s: { ignoredUsers: Record<string, unknown[]> }) => unknown) =>
    selector({ ignoredUsers: { 'team@conference.fluux.chat': h.ignored } }),
}))

vi.mock('@/hooks', () => ({
  useContextMenu: () => ({
    isOpen: false,
    longPressTriggered: { current: false },
    handleContextMenu: () => {},
    handleTouchStart: () => {},
    handleTouchEnd: () => {},
    position: { x: 0, y: 0 },
    menuRef: { current: null },
    close: () => {},
  }),
  // Imported at module scope by RoomsList() (the parent list), never called in
  // this test since only RoomItem is rendered — stubbed so the import resolves.
  useListKeyboardNav: () => ({}),
  useRouteSync: () => ({}),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Import AFTER mocks so RoomItem picks them up.
import { RoomItem } from './RoomsList'

const makeRoom = (over: Partial<Room> = {}): Room =>
  ({
    jid: 'team@conference.fluux.chat',
    name: 'Team',
    joined: true,
    isJoining: false,
    nickname: 'me',
    nickToJidCache: new Map(),
    occupants: new Map(),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set<string>(),
    lastMessage: null,
    avatar: undefined,
    subject: undefined,
    autojoin: false,
    isBookmarked: false,
    ...over,
  }) as unknown as Room

const noop = () => {}
const renderRoom = (room: Room, isActive = false) => {
  h.room = room
  h.ignored = []
  return render(
    <RoomItem
      roomJid={room.jid}
      isActive={isActive}
      isSelected={false}
      isKeyboardNav={false}
      onSelect={noop}
      onActivate={noop}
      onJoin={noop}
      onLeave={noop}
      onEditBookmark={noop}
      onRemoveBookmark={noop}
      onToggleAutojoin={noop}
    />,
  )
}

describe('RoomItem sidebar typing', () => {
  it('shows the typing indicator when caught up and someone is typing', () => {
    renderRoom(makeRoom({ typingUsers: new Set(['Alice']) }))
    // chat.typing.one is the i18n key rendered by the compact TypingIndicator
    expect(screen.getByText('chat.typing.one')).toBeTruthy()
  })

  it('hides typing when there is unread activity', () => {
    renderRoom(makeRoom({ unreadCount: 2, typingUsers: new Set(['Alice']) }))
    expect(screen.queryByText('chat.typing.one')).toBeNull()
  })

  it('hides typing on the active room', () => {
    renderRoom(makeRoom({ typingUsers: new Set(['Alice']) }), true)
    expect(screen.queryByText('chat.typing.one')).toBeNull()
  })

  it('hides typing when the only typist is the user themselves', () => {
    renderRoom(makeRoom({ typingUsers: new Set(['me']) }))
    expect(screen.queryByText('chat.typing.one')).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/RoomsList.typing.test.tsx`
Expected: FAIL — `RoomItem` is not exported (import is `undefined`).

- [ ] **Step 4: Export `RoomItem` and wire the gate**

In `RoomsList.tsx`:

Change `const RoomItem = memo(function RoomItem({` to:

```tsx
export const RoomItem = memo(function RoomItem({
```

Add the ignore subscription among the existing hooks, immediately after `const draft = useRoomStore((s) => s.drafts.get(roomJid))` (before `if (!room) return null`):

```tsx
  const ignoredForRoom = useIgnoreStore((s) => s.ignoredUsers[roomJid] ?? EMPTY_IGNORED_ARRAY)
```

After the `if (!room) return null` guard and near the `lastMessage` derivation, compute the gated typing nicks:

```tsx
  // Sidebar typing is intentionally quiet: only surface it on a joined room the
  // user is caught up on (zero unread) and is not currently viewing — the moment
  // a settled conversation is about to get a new message. Busy rooms keep their
  // unread badge and paint no typing (the two never fight for the same pixels).
  const typingNicks =
    room.joined && room.unreadCount === 0 && !isActive
      ? visibleRoomTypingNicks(room, ignoredForRoom)
      : []
  const showTyping = typingNicks.length > 0
```

Now replace the preview `<p>` (the block starting `<p dir="auto" className={\`truncate text-xs opacity-75 ${draft ? 'italic' : ''}\`}>` and its `draft ? ... : ...` chain) so typing takes precedence. Wrap it:

```tsx
          {showTyping ? (
            <TypingIndicator variant="compact" typingUsers={typingNicks} />
          ) : (
            <p dir="auto" className={`truncate text-xs opacity-75 ${draft ? 'italic' : ''}`}>
              {draft ? (
                <>{t('conversations.draft')}: {draft}</>
              ) : room.isJoining ? (
                <span className="italic">{t('rooms.joining')}</span>
              ) : lastMessage ? (
                <span className={lastMessage.isRetracted ? 'italic' : ''}>
                  {lastMessage.isOutgoing ? `${t('chat.me')}: ` : `${lastMessage.nick}: `}
                  {lastMessage.isRetracted ? t('chat.messageDeleted') : formatLocalizedPreview(lastMessage, t)}
                </span>
              ) : room.joined ? (
                room.subject ? (
                  <span className="text-fluux-muted">{room.subject}</span>
                ) : (
                  <span className="text-fluux-muted italic">{t('rooms.noMessages')}</span>
                )
              ) : (
                <>
                  {room.nickname && t('rooms.asNickname', { nickname: room.nickname })}
                  {room.autojoin && ` • ${t('rooms.autoJoin')}`}
                </>
              )}
            </p>
          )}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/RoomsList.typing.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/RoomsList.tsx apps/fluux/src/components/sidebar-components/RoomsList.typing.test.tsx
git commit --no-gpg-sign -m "feat(sidebar): gated room typing indicator in the preview line"
```

---

### Task 4: `ConversationItem` — suppress the 1:1 typing overlay on the active chat

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/ConversationList.tsx:316`
- Test: `apps/fluux/src/components/sidebar-components/ConversationList.typing.test.tsx`

**Interfaces:**
- Consumes: existing `isActive` prop on `ConversationItem`.
- Produces: the 1:1 avatar typing overlay renders only when `isTyping && !isActive`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/sidebar-components/ConversationList.typing.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Conversation } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('./SidebarListMenu', () => ({
  useSidebarListMenu: () => ({
    getItemMenuProps: () => ({}),
    isOpen: false,
    longPressTriggered: { current: false },
  }),
}))

vi.mock('./types', () => ({
  useSidebarZone: () => ({ current: null }),
  ContactTooltipContent: () => null,
}))

// Expose whether the avatar received a truthy typing overlay.
vi.mock('../Avatar', () => ({
  Avatar: ({ overlay }: { overlay?: unknown }) => (
    <div data-testid="avatar" data-has-overlay={overlay ? 'true' : 'false'} />
  ),
  TypingIndicator: () => <span data-testid="typing-dot" />,
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
}))

const h = vi.hoisted(() => ({ conversation: null as Conversation | null }))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useChatStore: (selector: (s: {
    conversations: Map<string, Conversation>
    typingStates: Map<string, Set<string>>
    drafts: Map<string, string>
  }) => unknown) =>
    selector({
      conversations: new Map(h.conversation ? [[h.conversation.id, h.conversation]] : []),
      // The contact is composing to us.
      typingStates: new Map([['emma@fluux.chat', new Set(['emma@fluux.chat'])]]),
      drafts: new Map(),
    }),
  useRosterStore: (selector: (s: { contacts: Map<string, unknown> }) => unknown) =>
    selector({ contacts: new Map([['emma@fluux.chat', { presence: 'online' }]]) }),
  useRoomStore: (selector: (s: { getRoom: (jid: string) => undefined }) => unknown) =>
    selector({ getRoom: () => undefined }),
}))

import { ConversationItem } from './ConversationList'

const makeConversation = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'emma@fluux.chat',
    name: 'Emma',
    type: 'chat',
    unreadCount: 0,
    lastMessage: { id: 'm1', body: 'hi', timestamp: new Date(), isOutgoing: false },
    ...over,
  }) as Conversation

const renderItem = (isActive: boolean) => {
  h.conversation = makeConversation()
  return render(
    <ConversationItem conversationId="emma@fluux.chat" isActive={isActive} onClick={() => {}} />,
  )
}

describe('ConversationItem typing overlay suppression', () => {
  it('shows the typing overlay when the chat is not active', () => {
    renderItem(false)
    expect(screen.getByTestId('avatar').getAttribute('data-has-overlay')).toBe('true')
  })

  it('suppresses the typing overlay when the chat is active', () => {
    renderItem(true)
    expect(screen.getByTestId('avatar').getAttribute('data-has-overlay')).toBe('false')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/ConversationList.typing.test.tsx`
Expected: FAIL — the active case still passes a truthy overlay (`data-has-overlay` is `'true'`).

- [ ] **Step 3: Add the `!isActive` guard**

In `apps/fluux/src/components/sidebar-components/ConversationList.tsx`, change line 316 from:

```tsx
              overlay={isTyping ? <TypingIndicator /> : undefined}
```

to:

```tsx
              overlay={isTyping && !isActive ? <TypingIndicator /> : undefined}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/ConversationList.typing.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/ConversationList.tsx apps/fluux/src/components/sidebar-components/ConversationList.typing.test.tsx
git commit --no-gpg-sign -m "feat(sidebar): suppress 1:1 typing overlay on the active chat"
```

---

### Task 5: Full verification and demo eyeball

**Files:** none (verification only).

- [ ] **Step 1: Run the affected test suites**

Run:
```bash
cd apps/fluux && npx vitest run src/utils/roomTyping.test.ts src/components/conversation/TypingIndicator.test.tsx src/components/sidebar-components/RoomsList.typing.test.tsx src/components/sidebar-components/ConversationList.typing.test.tsx
```
Expected: all PASS, no stderr.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck` then `npm run lint`.
Expected: both PASS.

- [ ] **Step 3: Demo-mode eyeball**

Run the app in demo mode (`npm run dev` → `http://localhost:5173/demo.html`). Find a joined room with zero unread that is not the currently open conversation, trigger an occupant "composing" state (seed via demo controls), and confirm:
- The room row's preview line shows the compact "… is typing" indicator with aurora dots.
- Opening that room hides the sidebar indicator (active-room suppression).
- A room with unread shows its badge and no typing indicator.

If demo controls cannot drive a room composing state, note it and rely on the render tests from Tasks 1–4 as the behavioral proof.

- [ ] **Step 4: No commit** — this task changes no files.

---

## Notes for the implementer

- **Why `RoomItem` re-renders without a new subscription:** `RoomItem` subscribes to `useRoomStore((s) => s.getRoom(roomJid))`, which returns the combined room object from the `rooms` map (`roomStore.ts:1153`). Every `typingUsers` mutation replaces that map entry with a fresh object (`roomStore.ts:961`, `roomStore.ts:1877`), so the row already re-renders on its own room's typing churn — this feature only decides whether to paint. The Task 3 render test and the Task 5 demo step confirm the reactivity holds; if a future change starts mutating `typingUsers` in place, add a dedicated `useRoomStore((s) => (s.getRoom(roomJid)?.typingUsers.size ?? 0) > 0)` boolean selector.
- **Typing precedence over draft:** in Task 3 the typing indicator replaces the whole preview line, including the draft line. This is intentional — typing is a transient live signal that reverts the instant it stops, restoring the draft.
- **Two different `TypingIndicator` components:** the 1:1 overlay (Task 4) uses the dot-only `TypingIndicator` exported from `../Avatar`; the room preview line (Task 3) uses the text `TypingIndicator` from `../conversation/TypingIndicator`. Only the latter gains the `compact` variant.
