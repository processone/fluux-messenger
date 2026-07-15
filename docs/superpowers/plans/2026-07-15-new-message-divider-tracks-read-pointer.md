# New-message divider tracks the read pointer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "New messages" divider and the scroll-to-bottom FAB badge follow reading progress by keying both off the existing persisted read pointer (`lastSeenMessageId`): the badge counts unread below the pointer, and the divider snaps to the first unread message after the pointer when the reader scrolls back up.

**Architecture:** Reuse the already-advancing, already-MDS-synced `lastSeenMessageId`. A new pure store action recomputes the session-only divider from the pointer (mirroring `applyRemoteDisplayed`'s active-divider recompute). The app exposes the pointer to the active view and triggers the recompute on scroll-up. No new persisted state, no MDS/unread/notification changes.

**Tech Stack:** TypeScript, Zustand vanilla stores (`@fluux/sdk`), React (`apps/fluux`), Vitest (unit + jsdom), Playwright (`test:scroll`).

## Global Constraints

- SDK public API stays clean; app never imports `@xmpp/client`. New SDK exports used by the app get added to the app test mock (`apps/fluux/src/test-setup.ts`) via the `importOriginal` spread.
- Both stores treat delayed messages as new: pass `{ treatDelayedAsNew: true }` to `onActivate` (matches every existing chat AND room call site — verified `chatStore.ts:1168`, `roomStore.ts:1804`).
- The divider (`firstNewMessageId`) is session-only (`firstNewMessageMarkers` map) and never persisted. The new action must not write `lastSeenMessageId`, `unreadCount`, `lastReadAt`, or trigger MDS.
- Run `npm run build:sdk` before app typecheck when SDK types change.
- Every scroll-affecting change is gated on `npm run test:scroll` (Chromium + WebKit) before it is considered done.
- Never include a Claude footer in commits.

---

### Task 1: SDK store action `resyncDividerToReadPointer` (chat + room)

Recompute the session-only divider from the current read pointer, for one conversation/room. Forward-only and idempotent by construction (the pointer only advances; `onActivate` scans forward from it).

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (add to the store interface near the `clearFirstNewMessageId` type at ~`:249`, and the impl right after `clearFirstNewMessageId` at `:1099-1106`)
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (interface near `:550`, impl right after `clearFirstNewMessageId` at `:1738-1745`)
- Test: `packages/fluux-sdk/src/stores/chatStore.resyncDivider.test.ts` (new)
- Test: `packages/fluux-sdk/src/stores/roomStore.resyncDivider.test.ts` (new)

**Interfaces:**
- Consumes: `notifState.onActivate(state, messages, options?)` from `shared/notificationState.ts` — returns `EntityNotificationState` with `.firstNewMessageId`. `EntityNotificationState = { unreadCount, mentionsCount, lastReadAt, lastSeenMessageId, firstNewMessageId }`.
- Produces: `resyncDividerToReadPointer(conversationId: string) => void` on both `ChatStore` and `RoomStore`.

**Typing note for the tests:** the seed objects below are illustrative shapes. The store's `ConversationMeta` / `Message` / room `Room` types likely require more fields. Before running, open the type of `conversationMeta`'s value (chat) and `rooms`/`roomMeta` values (room) and either fill the required fields or add a local `as ConversationMeta` / `as Message` cast so `setState` typechecks. Do not weaken the store types to accommodate the test.

- [ ] **Step 1: Write the failing test (chat)**

Create `packages/fluux-sdk/src/stores/chatStore.resyncDivider.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from './chatStore'

const CID = 'alice@example.com'

// Minimal message factory matching NotificationMessage fields the derivation reads.
function msg(id: string, opts: { outgoing?: boolean; delayed?: boolean } = {}) {
  return {
    id,
    from: opts.outgoing ? 'me@example.com' : CID,
    body: id,
    timestamp: new Date(2024, 0, 1, 12, Number(id.replace(/\D/g, '')) || 0),
    isOutgoing: !!opts.outgoing,
    isDelayed: !!opts.delayed,
    type: 'chat' as const,
  }
}

function seed(opts: { lastSeen: string | undefined; marker: string | undefined; messages: ReturnType<typeof msg>[] }) {
  const meta = new Map()
  meta.set(CID, { unreadCount: 0, lastReadAt: new Date(2024, 0, 1, 12, 0), lastSeenMessageId: opts.lastSeen })
  const messages = new Map()
  messages.set(CID, opts.messages)
  const markers = new Map<string, string>()
  if (opts.marker) markers.set(CID, opts.marker)
  useChatStore.setState({ conversationMeta: meta, messages, firstNewMessageMarkers: markers })
}

describe('chatStore.resyncDividerToReadPointer', () => {
  beforeEach(() => {
    useChatStore.setState({ conversationMeta: new Map(), messages: new Map(), firstNewMessageMarkers: new Map(), conversations: new Map() })
  })

  it('advances an existing divider to the first unread after the pointer', () => {
    // pointer at m2 (read up to m2), divider still at entry m1; unread starts at m3
    seed({ lastSeen: 'm2', marker: 'm1', messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3'), msg('m4')] })
    useChatStore.getState().resyncDividerToReadPointer(CID)
    expect(useChatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m3')
  })

  it('is idempotent once the divider already sits at first-unread-after-pointer', () => {
    seed({ lastSeen: 'm2', marker: 'm3', messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3'), msg('m4')] })
    const before = useChatStore.getState().firstNewMessageMarkers
    useChatStore.getState().resyncDividerToReadPointer(CID)
    // same value, and the map reference is unchanged (no-op set returns state)
    expect(useChatStore.getState().firstNewMessageMarkers).toBe(before)
    expect(useChatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m3')
  })

  it('no-ops when there is no existing divider (never resurrects a cleared one)', () => {
    seed({ lastSeen: 'm2', marker: undefined, messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3')] })
    useChatStore.getState().resyncDividerToReadPointer(CID)
    expect(useChatStore.getState().firstNewMessageMarkers.has(CID)).toBe(false)
  })

  it('clears the divider when the pointer is at the newest message', () => {
    seed({ lastSeen: 'm3', marker: 'm1', messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3')] })
    useChatStore.getState().resyncDividerToReadPointer(CID)
    expect(useChatStore.getState().firstNewMessageMarkers.has(CID)).toBe(false)
  })

  it('skips outgoing messages when choosing the first unread', () => {
    // m3 is our own message; first incoming unread after pointer m2 is m4
    seed({ lastSeen: 'm2', marker: 'm1', messages: [msg('m1'), msg('m2'), msg('m3', { outgoing: true }), msg('m4')] })
    useChatStore.getState().resyncDividerToReadPointer(CID)
    expect(useChatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m4')
  })

  it('does not touch lastSeenMessageId or unreadCount', () => {
    seed({ lastSeen: 'm2', marker: 'm1', messages: [msg('m1'), msg('m2'), msg('m3')] })
    useChatStore.getState().resyncDividerToReadPointer(CID)
    const meta = useChatStore.getState().conversationMeta.get(CID)!
    expect(meta.lastSeenMessageId).toBe('m2')
    expect(meta.unreadCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.resyncDivider.test.ts`
Expected: FAIL — `resyncDividerToReadPointer is not a function`.

- [ ] **Step 3: Add the chat interface type**

In `packages/fluux-sdk/src/stores/chatStore.ts`, in the store state interface, immediately after the `clearFirstNewMessageId: (conversationId: string) => void` type declaration (near `:249`), add:

```typescript
  /** Recompute the session-only "New messages" divider from the current read pointer
   *  (lastSeenMessageId) for this conversation. Forward-only and idempotent: sets the divider to
   *  the first unread message after the pointer, or clears it when the pointer is at the newest.
   *  No-op when there is no existing divider. Touches nothing but firstNewMessageMarkers. */
  resyncDividerToReadPointer: (conversationId: string) => void
```

- [ ] **Step 4: Add the chat implementation**

In `packages/fluux-sdk/src/stores/chatStore.ts`, immediately after the `clearFirstNewMessageId` implementation (after `:1106`), add:

```typescript
      resyncDividerToReadPointer: (conversationId) => {
        set((state) => {
          // Only reposition an EXISTING divider — never resurrect one the reader has cleared.
          if (!state.firstNewMessageMarkers.has(conversationId)) return state
          const meta = state.conversationMeta.get(conversationId)
          if (!meta) return state
          const messages = state.messages.get(conversationId) || []

          // Same recompute pattern as applyRemoteDisplayed's active-divider branch: derive the
          // divider from the pointer via onActivate and keep only .firstNewMessageId.
          const divider = notifState.onActivate(
            {
              unreadCount: 0,
              mentionsCount: 0,
              lastReadAt: meta.lastReadAt,
              lastSeenMessageId: meta.lastSeenMessageId,
              firstNewMessageId: undefined,
            },
            messages,
            { treatDelayedAsNew: true }
          ).firstNewMessageId

          if (divider === state.firstNewMessageMarkers.get(conversationId)) return state
          const newMarkers = new Map(state.firstNewMessageMarkers)
          if (divider) newMarkers.set(conversationId, divider)
          else newMarkers.delete(conversationId)
          return { firstNewMessageMarkers: newMarkers }
        })
      },
```

- [ ] **Step 5: Run the chat test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.resyncDivider.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Write the failing test (room)**

Create `packages/fluux-sdk/src/stores/roomStore.resyncDivider.test.ts` mirroring the chat test, but seed room state. Room reads messages from `roomRuntime.get(jid).messages` (fallback `rooms.get(jid).messages`) and meta from `roomMeta`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useRoomStore } from './roomStore'

const JID = 'room@conference.example.com'

function msg(id: string, opts: { outgoing?: boolean; delayed?: boolean } = {}) {
  return {
    id,
    from: `${JID}/${opts.outgoing ? 'me' : 'bob'}`,
    body: id,
    timestamp: new Date(2024, 0, 1, 12, Number(id.replace(/\D/g, '')) || 0),
    isOutgoing: !!opts.outgoing,
    isDelayed: !!opts.delayed,
    type: 'groupchat' as const,
  }
}

function seed(opts: { lastSeen: string | undefined; marker: string | undefined; messages: ReturnType<typeof msg>[] }) {
  const rooms = new Map()
  rooms.set(JID, { jid: JID, messages: opts.messages, unreadCount: 0, mentionsCount: 0, lastReadAt: new Date(2024, 0, 1, 12, 0), lastSeenMessageId: opts.lastSeen })
  const roomMeta = new Map()
  roomMeta.set(JID, { unreadCount: 0, mentionsCount: 0, lastReadAt: new Date(2024, 0, 1, 12, 0), lastSeenMessageId: opts.lastSeen })
  const roomRuntime = new Map()
  roomRuntime.set(JID, { messages: opts.messages })
  const markers = new Map<string, string>()
  if (opts.marker) markers.set(JID, opts.marker)
  useRoomStore.setState({ rooms, roomMeta, roomRuntime, firstNewMessageMarkers: markers })
}

describe('roomStore.resyncDividerToReadPointer', () => {
  beforeEach(() => {
    useRoomStore.setState({ rooms: new Map(), roomMeta: new Map(), roomRuntime: new Map(), firstNewMessageMarkers: new Map() })
  })

  it('advances an existing divider to the first unread after the pointer', () => {
    seed({ lastSeen: 'm2', marker: 'm1', messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3'), msg('m4')] })
    useRoomStore.getState().resyncDividerToReadPointer(JID)
    expect(useRoomStore.getState().firstNewMessageMarkers.get(JID)).toBe('m3')
  })

  it('no-ops when there is no existing divider', () => {
    seed({ lastSeen: 'm2', marker: undefined, messages: [msg('m1'), msg('m2'), msg('m3')] })
    useRoomStore.getState().resyncDividerToReadPointer(JID)
    expect(useRoomStore.getState().firstNewMessageMarkers.has(JID)).toBe(false)
  })

  it('clears the divider when the pointer is at the newest message', () => {
    seed({ lastSeen: 'm3', marker: 'm1', messages: [msg('m1'), msg('m2'), msg('m3')] })
    useRoomStore.getState().resyncDividerToReadPointer(JID)
    expect(useRoomStore.getState().firstNewMessageMarkers.has(JID)).toBe(false)
  })
})
```

- [ ] **Step 7: Run to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.resyncDivider.test.ts`
Expected: FAIL — not a function.

- [ ] **Step 8: Add the room interface type**

In `packages/fluux-sdk/src/stores/roomStore.ts`, after the `clearFirstNewMessageId` type (near `:550`), add the same doc-commented signature:

```typescript
  /** Recompute the session-only "New messages" divider from the current read pointer
   *  (lastSeenMessageId) for this room. Forward-only, idempotent, no-op when no divider exists.
   *  Touches nothing but firstNewMessageMarkers. */
  resyncDividerToReadPointer: (roomJid: string) => void
```

- [ ] **Step 9: Add the room implementation**

In `packages/fluux-sdk/src/stores/roomStore.ts`, after `clearFirstNewMessageId` (`:1745`), add:

```typescript
  resyncDividerToReadPointer: (roomJid) => {
    set((state) => {
      if (!state.firstNewMessageMarkers.has(roomJid)) return state
      const meta = state.roomMeta.get(roomJid)
      const existing = state.rooms.get(roomJid)
      if (!meta && !existing) return state
      const runtime = state.roomRuntime.get(roomJid)
      const messages = runtime?.messages ?? existing?.messages ?? []
      const lastSeenMessageId = meta?.lastSeenMessageId ?? existing?.lastSeenMessageId
      const lastReadAt = meta?.lastReadAt ?? existing?.lastReadAt

      const divider = notifState.onActivate(
        { unreadCount: 0, mentionsCount: 0, lastReadAt, lastSeenMessageId, firstNewMessageId: undefined },
        messages,
        { treatDelayedAsNew: true }
      ).firstNewMessageId

      if (divider === state.firstNewMessageMarkers.get(roomJid)) return state
      const newMarkers = new Map(state.firstNewMessageMarkers)
      if (divider) newMarkers.set(roomJid, divider)
      else newMarkers.delete(roomJid)
      return { firstNewMessageMarkers: newMarkers }
    })
  },
```

- [ ] **Step 10: Run both SDK tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.resyncDivider.test.ts src/stores/roomStore.resyncDivider.test.ts`
Expected: PASS (all).

- [ ] **Step 11: SDK typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/chatStore.resyncDivider.test.ts packages/fluux-sdk/src/stores/roomStore.resyncDivider.test.ts
git commit -m "feat(sdk): add resyncDividerToReadPointer to recompute divider from read pointer"
```

---

### Task 2: Wire the pointer into the UI (badge + divider snap)

Expose `lastSeenMessageId` and `resyncDividerToReadPointer` to the active view, thread them to `MessageList`, switch the FAB badge from the local watermark to the pointer, and snap the divider on scroll-up.

**Files:**
- Modify: `packages/fluux-sdk/src/hooks/useChatActions.ts` (delegation, beside `clearFirstNewMessageId` `:126-128`)
- Modify: `packages/fluux-sdk/src/hooks/useRoomActions.ts` (delegation, beside `clearFirstNewMessageId` `:205-207`)
- Modify: `packages/fluux-sdk/src/hooks/useChatActive.ts` (expose `lastSeenMessageId` selector — currently hardcoded `undefined` at `:113`; re-export the action)
- Modify: `packages/fluux-sdk/src/hooks/useRoomActive.ts` (same, `:87`/`:500`)
- Modify: `apps/fluux/src/test-setup.ts` (add the new fields to the `useChatActive`/`useRoomActive` mock if present)
- Modify: `apps/fluux/src/components/conversation/ChatView.tsx` (destructure `lastSeenMessageId`/`resyncDividerToReadPointer`; pass `lastSeenMessageId` + `onResyncDivider` to `ChatMessageList` → `MessageList`; extend the `ChatMessageList` props type)
- Modify: `apps/fluux/src/components/conversation/RoomView.tsx` (same)
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` (badge → pointer; remove local watermark; add snap trigger; add the two props)
- Test: `apps/fluux/src/components/conversation/MessageList.fab.test.tsx` (update badge tests to be pointer-prop-driven; add snap-trigger test)

**Interfaces:**
- Consumes: `resyncDividerToReadPointer(id)` (Task 1); `bottomVisibleMessageId: string | null`, `firstNewMessageId?: string` (already on `MessageList` / its scroll hook); `countNewBelowViewport(messages, firstNewMessageId, bottomVisibleId)` (existing `unreadBadge.ts`).
- Produces: new `MessageList` props `lastSeenMessageId?: string` and `onResyncDivider?: (conversationId: string) => void`.

- [ ] **Step 1: Expose the action in the action hooks**

In `packages/fluux-sdk/src/hooks/useChatActions.ts`, beside `clearFirstNewMessageId` (`:126-128`), add:

```typescript
  const resyncDividerToReadPointer = useCallback((conversationId: string) => {
    chatStore.getState().resyncDividerToReadPointer(conversationId)
  }, [])
```

Add `resyncDividerToReadPointer` to the returned `actions` memo object and its dependency list (mirror how `clearFirstNewMessageId` appears at `:226`/`:250`).

In `packages/fluux-sdk/src/hooks/useRoomActions.ts`, mirror beside `:205-207` / `:261` using `roomStore.getState().resyncDividerToReadPointer(roomJid)`.

- [ ] **Step 2: Expose `lastSeenMessageId` + the action in the active hooks**

In `packages/fluux-sdk/src/hooks/useChatActive.ts`:
- Add a selector: `const activeLastSeenMessageId = useChatStore((s) => s.conversationMeta.get(s.activeConversationId)?.lastSeenMessageId)`.
- Return it as `lastSeenMessageId` (replace the hardcoded `lastSeenMessageId: undefined` at `:113`, or add a top-level `lastSeenMessageId` field to the returned object — match how `firstNewMessageId` is returned at `:319`).
- Re-list `resyncDividerToReadPointer` (destructured from `useChatActions`) in the returned `actions` memo + deps (mirror `clearFirstNewMessageId` at `:296`/`:310`).

In `packages/fluux-sdk/src/hooks/useRoomActive.ts`: mirror — selector `useRoomStore((s) => s.roomMeta.get(s.activeRoomJid)?.lastSeenMessageId)` returned as `lastSeenMessageId`, and re-list the action (mirror `:432`/`:474`).

- [ ] **Step 3: Update the app test mock**

In `apps/fluux/src/test-setup.ts`, if `useChatActive`/`useRoomActive` are mocked, add `lastSeenMessageId: undefined` and `resyncDividerToReadPointer: vi.fn()` (inside `actions`) to the mock return so app tests that consume the real hook shape keep compiling. If the mock uses `importOriginal` spread, no change is needed — verify by running the app suite in Step 11.

- [ ] **Step 4: Build SDK + typecheck the SDK exposure**

Run: `npm run build:sdk && cd packages/fluux-sdk && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Add the two props to MessageList and thread them from the views**

In `apps/fluux/src/components/conversation/MessageList.tsx`, add to `MessageListProps` (beside `firstNewMessageId` / `clearFirstNewMessageId` near `:80`):

```typescript
  /** Persisted read pointer for this conversation — the badge counts unread below it. */
  lastSeenMessageId?: string
  /** Recompute the divider from the read pointer (called when the reader scrolls back up). */
  onResyncDivider?: (conversationId: string) => void
```

Destructure both in the component signature.

In `ChatView.tsx`: destructure `lastSeenMessageId` and `resyncDividerToReadPointer` from `useChatActive()` (beside `firstNewMessageId` at `:56`); wrap the action:

```typescript
  const handleResyncDivider = useCallback(
    (conversationId: string) => resyncDividerToReadPointer(conversationId),
    [resyncDividerToReadPointer],
  )
```

Pass `lastSeenMessageId={lastSeenMessageId}` and `onResyncDivider={handleResyncDivider}` to `ChatMessageList` (beside `firstNewMessageId` at `:499`), add both to the `ChatMessageList` props type (`:653`), and forward them to `MessageList` (`:753`). Mirror all of this in `RoomView.tsx` (`:96`, `:576`, `:1148`) using the room `roomJid`.

- [ ] **Step 6: Write the failing badge test (pointer-driven)**

In `apps/fluux/src/components/conversation/MessageList.fab.test.tsx`, the badge is now prop-driven by `lastSeenMessageId` (no geometry needed). Replace the geometry-based decrement/forward-only tests with prop-driven ones, and keep the "no badge without divider" cases. Add:

```typescript
it('badge counts unread below the read pointer', () => {
  const messages = createTestMessages(10) // msg-0 .. msg-9
  const { rerender } = render(
    <MessageList
      messages={messages}
      conversationId="conv-1"
      clearFirstNewMessageId={vi.fn()}
      firstNewMessageId="msg-3"
      lastSeenMessageId="msg-2" // read up to msg-2 → unread = msg-3..msg-9 = 7
      renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
    />
  )
  const scrollCtx = setupScrollContainer()
  if (!scrollCtx) return
  simulateScrollUp(scrollCtx.container) // just to show the FAB

  const badge = () => scrollCtx.container.parentElement
    ?.querySelector('button[aria-label="chat.scrollToBottom"]')?.querySelector('span')
  expect(badge()?.textContent).toBe('7')

  // Pointer advances to msg-6 (read further) → unread = msg-7..msg-9 = 3
  rerender(
    <MessageList
      messages={messages}
      conversationId="conv-1"
      clearFirstNewMessageId={vi.fn()}
      firstNewMessageId="msg-3"
      lastSeenMessageId="msg-6"
      renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
    />
  )
  expect(badge()?.textContent).toBe('3')
})
```

Expected count math: `countNewBelowViewport(messages, 'msg-3', 'msg-6')` → markerIdx 3, bottomIdx 6, belowStart `max(7,3)=7`, count `10-7=3`.

- [ ] **Step 7: Run to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageList.fab.test.tsx`
Expected: FAIL — `lastSeenMessageId` not consumed yet (badge still uses the removed watermark or shows the wrong number).

- [ ] **Step 8: Switch the badge to the pointer; remove the local watermark**

In `MessageList.tsx`, delete the `deepestReadMessageId` state and its two `useEffect`s (the reset-on-`firstNewMessageId` and the forward-only advance), and change the badge memo to:

```typescript
  const fabBadgeCount = useMemo(
    () => countNewBelowViewport(deduplicatedMessages, firstNewMessageId, lastSeenMessageId ?? null),
    [deduplicatedMessages, firstNewMessageId, lastSeenMessageId],
  )
```

Keep the `bottomVisibleMessageId` destructure from `useMessageListScroll` — it is used by the snap trigger in Step 9. Remove the now-unused `useState` import only if nothing else in the file uses it (check first; leave it if used elsewhere).

- [ ] **Step 9: Add the scroll-up snap trigger**

In `MessageList.tsx`, after the badge memo, add:

```typescript
  // When the reader scrolls back ABOVE the read pointer, snap the "New messages" divider to the
  // first unread after the pointer ("here's how far I got"). Forward-only + idempotent in the store,
  // so a slightly noisy trigger is harmless. Compares the bottom-most-visible row (from the scroll
  // hook) against the pointer, both resolved in the resident message array.
  useEffect(() => {
    if (!firstNewMessageId || !lastSeenMessageId || !bottomVisibleMessageId || !onResyncDivider) return
    const bIdx = deduplicatedMessages.findIndex((m) => m.id === bottomVisibleMessageId)
    const pIdx = deduplicatedMessages.findIndex((m) => m.id === lastSeenMessageId)
    const dIdx = deduplicatedMessages.findIndex((m) => m.id === firstNewMessageId)
    // Scrolled above the pointer (bIdx < pIdx) and the divider still trails it (dIdx <= pIdx).
    if (bIdx >= 0 && pIdx > bIdx && dIdx !== -1 && dIdx <= pIdx) {
      onResyncDivider(conversationId)
    }
  }, [bottomVisibleMessageId, lastSeenMessageId, firstNewMessageId, deduplicatedMessages, conversationId, onResyncDivider])
```

- [ ] **Step 10: Write the snap-trigger test**

Add to `MessageList.fab.test.tsx` (this needs the geometry helper `simulateScrollTo` retained from the earlier badge work; keep it):

```typescript
it('snaps the divider to the pointer when the reader scrolls back up', () => {
  const onResyncDivider = vi.fn()
  const messages = createTestMessages(10)
  render(
    <MessageList
      messages={messages}
      conversationId="conv-1"
      clearFirstNewMessageId={vi.fn()}
      firstNewMessageId="msg-3"   // divider at entry
      lastSeenMessageId="msg-6"   // read pointer deeper than divider
      onResyncDivider={onResyncDivider}
      renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
    />
  )
  const scrollCtx = setupScrollContainer()
  if (!scrollCtx) return
  // Scroll to the top so the bottom-most-visible row (msg-4) is above the pointer (msg-6).
  simulateScrollTo(scrollCtx.container, 0)
  expect(onResyncDivider).toHaveBeenCalledWith('conv-1')
})

it('does not snap while the reader is at or below the pointer', () => {
  const onResyncDivider = vi.fn()
  const messages = createTestMessages(10)
  render(
    <MessageList
      messages={messages}
      conversationId="conv-1"
      clearFirstNewMessageId={vi.fn()}
      firstNewMessageId="msg-3"
      lastSeenMessageId="msg-3"   // pointer == divider, reader hasn't gone past it
      onResyncDivider={onResyncDivider}
      renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
    />
  )
  const scrollCtx = setupScrollContainer()
  if (!scrollCtx) return
  simulateScrollTo(scrollCtx.container, 0) // bottom-visible msg-4 is BELOW the pointer msg-3
  expect(onResyncDivider).not.toHaveBeenCalled()
})
```

- [ ] **Step 11: Run the app tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/conversation/` then `cd ../.. && npm run typecheck`
Expected: PASS (all conversation tests, including the new badge + snap tests); typecheck clean.

- [ ] **Step 12: Commit**

```bash
git add packages/fluux-sdk/src/hooks apps/fluux/src/test-setup.ts apps/fluux/src/components/conversation/ChatView.tsx apps/fluux/src/components/conversation/RoomView.tsx apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/components/conversation/MessageList.fab.test.tsx
git commit -m "feat(chat): divider and FAB badge follow the read pointer; snap divider on scroll-up"
```

---

### Task 3: Scroll-invariant verification + browser check

Prove the mid-session divider move does not drift the scroll position or trip the render-loop guard, and observe the behavior end-to-end.

**Files:**
- Possibly modify: `apps/fluux/scripts/scroll-invariants.ts` (only if adding a divider-snap invariant)

- [ ] **Step 1: Run the scroll-invariant gate**

Run: `npm run build:sdk && npm run test:scroll`
Expected: all invariants PASS on Chromium AND WebKit (in particular invariant-5 "no RenderLoopDetector warning" and the jump-to-last-read pill test). If any fail, diagnose the divider-row-height-shift interaction (content-anchor restore) before proceeding.

- [ ] **Step 2: (Optional) add a divider-snap invariant**

If Step 1 reveals fragility worth locking down, add a test to `scroll-invariants.ts`: open a room with a divider and a backlog, scroll down (pointer advances), scroll back up, assert (a) the scroll position does not jump more than the existing per-frame tolerance and (b) the `[data-message-id]` carrying the `NewMessageMarker` moved to a later message. Re-run `npm run test:scroll`.

- [ ] **Step 3: Browser check in demo mode**

Start the worktree dev server (`.claude/launch.json` → `worktree-awesome-yalow`, or add one on a free port). Open `http://localhost:<port>/demo.html?tutorial=false&virt=1`. In `__chatStore`, plant a marker and a pointer on the active conversation, then drive `[data-message-list].scrollTop` and read `[data-fab="scroll-to-bottom"] span` (in a separate `javascript_tool` call so React settles) to confirm: badge decrements on read-down, holds on scroll-up, and on scroll-up the `Nouveaux messages` divider has moved to the deepest-read boundary. Screenshot for the record.

- [ ] **Step 4: Final full verification + commit any invariant**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add apps/fluux/scripts/scroll-invariants.ts
git commit -m "test(scroll): lock divider-snap position stability on scroll-up"
```
(Skip the commit if Step 2 added nothing.)

---

## Notes for the implementer

- The earlier increment on this branch (uncommitted: `unreadBadge.ts`, hook `bottomVisibleMessageId`, and the now-removed local watermark in `MessageList`) is the starting point. Task 2 removes the local watermark and re-points the badge; keep `unreadBadge.ts` and `bottomVisibleMessageId`.
- Line numbers are from the current branch and may drift as you edit — locate by symbol (`clearFirstNewMessageId`, `firstNewMessageId`) and mirror it.
- If SSH commit signing is unavailable, commit with `--no-gpg-sign` (previously approved for this environment).
