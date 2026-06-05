# MUC Composer / RoomView Render Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the MUC composer subtree from re-rendering on every room-store write (messages, typing, presence), which on WebKitGTK sustains a half-freeze that kills `WebKitWebProcess`.

**Architecture:** The composer (`RoomMessageInput`, defined inside `RoomView.tsx`) re-renders 1:1 with `RoomView` because nothing is memoized and `useRoomActive()` rebuilds `activeRoom` on every store write. Fix: subscribe the composer only to the slices it needs via the existing focused SDK hooks (`useRoomEntity`, `useRoomOccupants`), gate whispers through a single-occupant boolean selector, take actions/message-nicks non-reactively, wrap `RoomMessageInput` in `React.memo`, and stabilize the props `RoomView` passes it. Then cheapen `RoomView`'s own re-render (memoized children + memoized computations).

**Tech Stack:** React 19, Zustand (vanilla stores + `useRoomStore`), Vitest + @testing-library/react, TypeScript. Monorepo: `@fluux/sdk` (real stores) + `@xmpp/fluux` app (mocks `@fluux/sdk` in tests).

**Spec:** `docs/superpowers/specs/2026-06-04-muc-composer-render-decoupling-design.md`

**Key facts (verified):**
- `addMessage` preserves the `occupants` Map reference (`roomStore.ts:932` does `{ ...existingRuntime, messages: newMessages }`), so `roomSelectors.runtimeOccupantsFor(jid)` is reference-stable across message traffic.
- Focused hooks already exist and are exported from `@fluux/sdk`: `useRoomEntity`, `useRoomMetadata`, `useRoomMessages`, `useRoomOccupants` (`packages/fluux-sdk/src/hooks/useMetadataSubscriptions.ts:185-255`). **No new SDK hooks are needed.**
- `RoomMessageInput` is an unexported function inside `apps/fluux/src/components/RoomView.tsx:1458`; `roomStore` is already imported in that module (used at `RoomView.tsx:1623`).
- App tests mock `@fluux/sdk` (with `importOriginal` spread) and `@fluux/sdk/react` (`useRoomStore` fully replaced) in `apps/fluux/src/test-setup.ts`.

---

## Task 1: Characterize the load-bearing property — `useRoomOccupants` stability (SDK)

`useRoomOccupants` already exists and is correct; this test locks in the property the whole fix depends on (stable across messages, reactive to occupants). It passes immediately — it is a guard/characterization test, not fail-first.

**Files:**
- Create: `packages/fluux-sdk/src/hooks/useMetadataSubscriptions.renderStability.test.tsx`

- [ ] **Step 1: Write the characterization test**

```tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRoomOccupants } from './useMetadataSubscriptions'
import { roomStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  createRoom,
  createRoomMessage,
} from './renderStability.helpers'

const JID = 'roomA@conference.example.com'

describe('useRoomOccupants render stability', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      mamQueryStates: new Map(),
      activeAnimation: null,
      drafts: new Map(),
    })
  })

  it('does NOT re-render when the active room receives messages', () => {
    act(() => {
      roomStore.getState().addRoom(createRoom(JID, { joined: true }))
      roomStore.getState().setActiveRoom(JID)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const occupants = useRoomOccupants(JID)
        return { renderCount, occupants }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount
    const mapAfterMount = result.current.occupants

    act(() => {
      for (let i = 0; i < 10; i++) {
        roomStore.getState().addMessage(JID, createRoomMessage(JID, 'user1', `m${i}`, { id: `m-${i}` }))
      }
    })

    expect(result.current.renderCount).toBe(rendersAfterMount)
    expect(result.current.occupants).toBe(mapAfterMount) // same reference
  })

  it('DOES re-render when an occupant joins or leaves the active room', () => {
    act(() => {
      roomStore.getState().addRoom(createRoom(JID, { joined: true }))
      roomStore.getState().setActiveRoom(JID)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const occupants = useRoomOccupants(JID)
        return { renderCount, occupants }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    act(() => {
      roomStore.getState().addOccupant(JID, { nick: 'alice', affiliation: 'member', role: 'participant' })
    })
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterMount)
    expect(result.current.occupants.has('alice')).toBe(true)

    const rendersAfterJoin = result.current.renderCount
    act(() => {
      roomStore.getState().removeOccupant(JID, 'alice')
    })
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterJoin)
    expect(result.current.occupants.has('alice')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `cd packages/fluux-sdk && npx vitest run src/hooks/useMetadataSubscriptions.renderStability.test.tsx`
Expected: PASS (characterizes existing correct behavior). If `createRoom`'s signature differs, adjust the call to match `renderStability.helpers.tsx`.

- [ ] **Step 3: Commit**

```bash
git add packages/fluux-sdk/src/hooks/useMetadataSubscriptions.renderStability.test.tsx
git commit -m "test(sdk): characterize useRoomOccupants stability across message churn"
```

---

## Task 2: `useWhisperCounterpartPresent` — single-occupant, whisper-mode-only gate (app)

A hook that returns a boolean derived from the *single* counterpart's presence, so the consumer re-renders only when that boolean flips. Returns `false` (no work) when not in whisper mode.

**Files:**
- Create: `apps/fluux/src/hooks/useWhisperCounterpartPresent.ts`
- Create: `apps/fluux/src/hooks/useWhisperCounterpartPresent.test.tsx`
- Modify: `apps/fluux/src/hooks/index.ts`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRoomStore } from '@fluux/sdk/react'
import { useWhisperCounterpartPresent } from './useWhisperCounterpartPresent'
import type { WhisperTarget } from '@/components/conversation'

const JID = 'room@conf.example.com'

function mockOccupants(occ: Map<string, { occupantId?: string }>) {
  // The app globally mocks useRoomStore; make it run the selector against a
  // state whose roomRuntime contains our occupants for JID.
  ;(useRoomStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: unknown) => unknown) => {
    const state = { roomRuntime: new Map([[JID, { occupants: occ }]]) }
    return selector ? selector(state) : state
  })
}

describe('useWhisperCounterpartPresent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns false when there is no whisper target', () => {
    mockOccupants(new Map())
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, null))
    expect(result.current).toBe(false)
  })

  it('returns true when the counterpart is present (by nick)', () => {
    mockOccupants(new Map([['bob', {}]]))
    const target: WhisperTarget = { nick: 'bob' }
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, target))
    expect(result.current).toBe(true)
  })

  it('returns false when the counterpart has left', () => {
    mockOccupants(new Map([['alice', {}]]))
    const target: WhisperTarget = { nick: 'bob' }
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, target))
    expect(result.current).toBe(false)
  })

  it('matches on occupant-id, not a recycled nick', () => {
    // "bob" now exists but with a DIFFERENT occupant-id than captured.
    mockOccupants(new Map([['bob', { occupantId: 'newperson' }]]))
    const target: WhisperTarget = { nick: 'bob', occupantId: 'original' }
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, target))
    expect(result.current).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useWhisperCounterpartPresent.test.tsx`
Expected: FAIL — `useWhisperCounterpartPresent` does not exist.

- [ ] **Step 3: Implement the hook**

```ts
// apps/fluux/src/hooks/useWhisperCounterpartPresent.ts
import { useRoomStore } from '@fluux/sdk/react'
import { whisperTargetPresent, type WhisperTarget } from '@/components/conversation'

/**
 * Whether a whisper counterpart is still present in `roomJid`.
 *
 * Narrow by design (XEP-0045 §7.5): subscribes to a single derived boolean, so
 * the consumer re-renders only when this counterpart's presence flips — not on
 * every occupant/message/typing change in the room. Returns `false` (no work)
 * when not in whisper mode (`target` is null/undefined). Occupant-id aware via
 * {@link whisperTargetPresent}, with a nick fallback.
 */
export function useWhisperCounterpartPresent(
  roomJid: string,
  target: WhisperTarget | null | undefined,
): boolean {
  return useRoomStore((s) => {
    if (!target) return false
    const occupants = s.roomRuntime.get(roomJid)?.occupants
    return occupants ? whisperTargetPresent(target, occupants) : false
  })
}
```

Confirm `WhisperTarget` and `whisperTargetPresent` are re-exported from `@/components/conversation` (the index barrel). If not, import from `@/components/conversation/whisperTarget` instead.

- [ ] **Step 4: Export from the hooks barrel**

In `apps/fluux/src/hooks/index.ts`, add after the `useTypeToFocus` export:

```ts
export { useWhisperCounterpartPresent } from './useWhisperCounterpartPresent'
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useWhisperCounterpartPresent.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useWhisperCounterpartPresent.ts apps/fluux/src/hooks/useWhisperCounterpartPresent.test.tsx apps/fluux/src/hooks/index.ts
git commit -m "feat(rooms): add useWhisperCounterpartPresent narrow presence gate"
```

---

## Task 3: Widen the app test mocks for focused room subscriptions

The composer will call the real `useRoomEntity`/`useRoomOccupants` (which read `state.roomRuntime`/`state.roomEntities`) and read actions/messages via `roomStore.getState()`. The current mocks don't expose those, so RoomView tests would throw. Add them first so the suite stays green when Task 4 lands.

**Files:**
- Modify: `apps/fluux/src/test-setup.ts`

- [ ] **Step 1: Add runtime/entity/meta maps + actions to the `@fluux/sdk/react` `useRoomStore` mock**

Replace the `useRoomStore` mock state block (currently at `apps/fluux/src/test-setup.ts:305-317`) with:

```ts
  useRoomStore: vi.fn((selector) => {
    const state = {
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      drafts: new Map(),
      activeRoomJid: null,
      setActiveRoom: vi.fn(),
      addRoom: vi.fn(),
      markAsRead: vi.fn(),
      clearFirstNewMessageId: vi.fn(),
      setDraft: vi.fn(),
      getDraft: () => '',
      clearDraft: vi.fn(),
      roomsWithUnreadCount: () => 0,
      getMAMQueryState: () => ({ isLoading: false, hasMoreHistory: false }),
    }
    return selector ? selector(state) : state
  }),
```

- [ ] **Step 2: Add draft + getRoom accessors to the `@fluux/sdk` `roomStore` mock**

Replace the `roomStore` block (currently at `apps/fluux/src/test-setup.ts:152-161`) with:

```ts
    roomStore: {
      getState: () => ({
        rooms: new Map(),
        roomRuntime: new Map(),
        activeRoomJid: null,
        setActiveRoom: vi.fn(),
        markAsRead: vi.fn(),
        clearFirstNewMessageId: vi.fn(),
        getRoom: () => undefined,
        getDraft: () => '',
        setDraft: vi.fn(),
        clearDraft: vi.fn(),
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
```

- [ ] **Step 3: Verify the existing suite still passes**

Run: `cd apps/fluux && npx vitest run src/components/RoomView`  (and any `MessageComposer` tests)
Expected: PASS (no behavior change yet; mocks only widened).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/test-setup.ts
git commit -m "test(app): widen room store mocks for focused subscriptions"
```

---

## Task 4: Memoize `RoomMessageInput` + narrow its subscriptions

This is the core fix. Export `RoomMessageInput`, wrap it in `React.memo`, replace the churning `room` prop and the internal `useRoomActive()` with focused subscriptions and non-reactive reads.

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx` (the `RoomMessageInput` component, `:1427-1965`)
- Create: `apps/fluux/src/components/RoomMessageInput.memo.test.tsx`

- [ ] **Step 1: Write the failing memoization test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

// Count MessageComposer renders via a spy module mock.
const composerRenders = { count: 0 }
vi.mock('./MessageComposer', () => ({
  MessageComposer: () => { composerRenders.count++; return <div data-testid="composer" /> },
  MESSAGE_INPUT_BASE_CLASSES: '',
  MESSAGE_INPUT_OVERLAY_CLASSES: '',
}))

import { RoomMessageInput } from './RoomView'

function makeRoom() {
  return {
    jid: 'room@conf.example.com', name: 'Room', nickname: 'me',
    occupants: new Map(), messages: [], joined: true,
  } as never
}

// Stable props defined once so only the parent's own state changes between renders.
const STABLE = {
  room: makeRoom(),
  sendMessage: vi.fn(), sendCorrection: vi.fn(), retractMessage: vi.fn(),
  sendChatState: vi.fn(), sendEasterEgg: vi.fn(), sendPoll: vi.fn(),
  replyingTo: null, onCancelReply: vi.fn(), editingMessage: null, onCancelEdit: vi.fn(),
  isConnected: true, sendWhisper: vi.fn(), whisperTarget: null,
}

function Harness() {
  const [, setTick] = useState(0)
  return (
    <>
      <button onClick={() => setTick((t) => t + 1)}>tick</button>
      <RoomMessageInput {...(STABLE as never)} />
    </>
  )
}

describe('RoomMessageInput memoization', () => {
  it('does not re-render MessageComposer when the parent re-renders with identical props', () => {
    render(<Harness />)
    const afterMount = composerRenders.count
    fireEvent.click(screen.getByText('tick'))
    fireEvent.click(screen.getByText('tick'))
    expect(composerRenders.count).toBe(afterMount) // memo bailout
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/RoomMessageInput.memo.test.tsx`
Expected: FAIL — `RoomMessageInput` is not exported (import error) and/or composer re-renders on each tick.

- [ ] **Step 3: Export + memoize the component**

In `apps/fluux/src/components/RoomView.tsx`, change the declaration at `:1458` from:

```tsx
function RoomMessageInput({
```

to a memoized, exported component. Replace the closing `}` of the function (currently `:1965`) so the function is wrapped:

```tsx
export const RoomMessageInput = memo(function RoomMessageInput({
```

…and at the end of the component body (the `)` + `}` that currently close the function at `:1965`), close the `memo(...)` call:

```tsx
})
```

Add `memo` to the React import at the top of the file (find `import React, { ... } from 'react'` and add `memo`, or add `import { memo } from 'react'`).

- [ ] **Step 4: Replace `room` reads with focused subscriptions**

Within `RoomMessageInput`:

a) Change the props: in `RoomMessageInputProps` (`:1428`) replace `room: Room` with `roomJid: string`. In the destructure (`:1459`) replace `room,` with `roomJid,`.

b) At the top of the body (after `const { t } = useTranslation()`), derive room data from focused hooks and non-reactive reads. Remove the line `const { setDraft, getDraft, clearDraft, clearFirstNewMessageId } = useRoomActive()` (`:1490`) and replace with:

```tsx
  const entity = useRoomEntity(roomJid)
  const roomName = entity?.name ?? roomJid
  const roomNickname = entity?.nickname ?? ''
  const occupants = useRoomOccupants(roomJid)
  const { setDraft, getDraft, clearDraft, clearFirstNewMessageId } = roomStore.getState()
```

Import `useRoomEntity` and `useRoomOccupants` from `@fluux/sdk` (add to the existing `@fluux/sdk` import in RoomView, alongside `useRoomActive`/types).

c) Replace the whisper gate (`:1497`). The hook is called unconditionally (it
returns `false` for a null target), then combined into the gate boolean:

```tsx
  const counterpartPresent = useWhisperCounterpartPresent(roomJid, whisperTarget)
  const whisperCounterpartGone = !!whisperTarget && !counterpartPresent
```

Import `useWhisperCounterpartPresent` from `@/hooks`.

d) Replace every other `room.X` reference in the component body with the focused equivalents:
- `room.jid` → `roomJid`
- `room.name` → `roomName`
- `room.nickname` → `roomNickname`
- `room.occupants` → `occupants`
- `shouldSendTypingNotifications` (`:1536`): `occupants.size < MAX_ROOM_SIZE_FOR_TYPING`
- `messageNicks` (`:1539-1553`): read messages/affiliated members non-reactively so the composer does NOT subscribe to messages:

```tsx
  const messageNicks = (() => {
    const nicks = new Set<string>()
    const liveRoom = roomStore.getState().getRoom(roomJid)
    for (const msg of liveRoom?.messages ?? []) nicks.add(msg.nick)
    for (const member of liveRoom?.affiliatedMembers ?? []) {
      if (member.nick) nicks.add(member.nick)
    }
    return nicks
  })()
```

- the send-time backstop (`:1623`) already uses `roomStore.getState().getRoom(room.jid)` — change `room.jid` → `roomJid`.
- `useConversationDraft({ conversationId: room.jid, ... })` (`:1516`) → `conversationId: roomJid`.
- `useMentionAutocomplete(text, cursorPosition, room.occupants, room.nickname, room.jid, messageNicks)` (`:1556`) → `(text, cursorPosition, occupants, roomNickname, roomJid, messageNicks)`.

- [ ] **Step 5: Update the call site in `RoomView`**

At `RoomView.tsx:496` replace `room={activeRoom}` with `roomJid={activeRoom.jid}`. (Other props are stabilized in Task 5.)

- [ ] **Step 6: Build the SDK + run tests**

Run: `npm run build:sdk` then `cd apps/fluux && npx vitest run src/components/RoomMessageInput.memo.test.tsx src/components/RoomView`
Expected: PASS — composer no longer re-renders on parent ticks; existing RoomView/whisper/mention/draft tests stay green. Fix any type errors surfaced by the prop rename.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx apps/fluux/src/components/RoomMessageInput.memo.test.tsx
git commit -m "perf(rooms): memoize composer and narrow its room-store subscriptions"
```

---

## Task 5: Stabilize the props `RoomView` passes to the composer

`React.memo` only helps if every prop is reference-stable across `RoomView` re-renders. Wrap the inline handlers/objects.

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx` (the `RoomView` component body, ~`:213-528`)

- [ ] **Step 1: Wrap the handlers and upload object**

- `scrollToBottom` (`:214`), `handleMediaLoad` (`:225`), `handleInputResize` (`:234`): wrap each in `useCallback(() => { ... }, [])` (they only touch refs, no reactive deps).
- `uploadStateObj` (`:204`): `const uploadStateObj = useMemo(() => ({ isUploading, progress, error: uploadError, clearError: clearUploadError }), [isUploading, progress, uploadError, clearUploadError])`.
- The inline `onMessageIdSent` arrow (`:521-525`): hoist to a `useCallback((id: string) => { ... }, [])` named `handleMessageIdSent` and pass it.
- The inline `onClearWhisper` arrow `() => setWhisperTarget(null)` (`:527`): hoist to `const handleClearWhisper = useCallback(() => setWhisperTarget(null), [])`.
- Verify `handleCancelReply`, `handleCancelEdit`, `handleEditLastMessage`, `handleFileDrop`, `handleRemovePendingAttachment`, `processMessageForLinkPreview` are already `useCallback` with stable deps; if any close over `activeRoom`, change them to read `activeRoomRef.current` (the ref already exists at `:271`) or take `roomJid`, so their identity is stable.

Add `useCallback`/`useMemo` to the React import if not present.

- [ ] **Step 2: Verify the memo test still passes with realistic props**

Run: `cd apps/fluux && npx vitest run src/components/RoomMessageInput.memo.test.tsx src/components/RoomView`
Expected: PASS. (The Task 4 memo test guards the boundary; existing RoomView tests guard behavior.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx
git commit -m "perf(rooms): stabilize composer props so memo bailout holds"
```

---

## Task 6: Cheapen `RoomView`'s own re-render (part 3)

`RoomView` still re-renders on room-store writes (it orchestrates messages + occupants). Make that cheap: memoize the expensive per-render computations and the heavy children so a re-render doesn't cascade.

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx`

- [ ] **Step 1: Memoize per-render computations**

- `messagesById = createMessageLookup(activeMessages)` (`:262`): `const messagesById = useMemo(() => createMessageLookup(activeMessages), [activeMessages])`.
- `displayMessages` (the filtering that feeds `RoomMessageList`/`PollBanner`): wrap in `useMemo` keyed on its real inputs (`activeMessages`, ignore list, etc.). Locate its definition and add the `useMemo` with the exact dependency array it reads.

- [ ] **Step 2: Memoize the stable-prop children**

Wrap `RoomHeader` and `PollBanner` definitions in `React.memo` (in their own files). For each, confirm the props `RoomView` passes are reference-stable (the callbacks are from `useRoomActive` actions or `useCallback`); wrap any inline arrows passed to them in `useCallback`. Do **not** memoize `RoomMessageList` in this task if its props include freshly-built arrays/objects — note it as a follow-up rather than forcing it here.

- [ ] **Step 3: Run the room test suite + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/RoomView src/components/conversation` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx apps/fluux/src/components/RoomHeader.tsx apps/fluux/src/components/conversation/PollBanner.tsx
git commit -m "perf(rooms): memoize RoomView computations and stable-prop children"
```

---

## Task 7: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Full test suite (no stderr)**

Run: `npm test`
Expected: all suites PASS, no unhandled errors/warnings in stderr (per CLAUDE.md).

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 3: Manual dev verification (WebKitGTK proxy not reproducible in CI)**

In `npm run dev` demo mode, open a busy room and confirm via React DevTools Profiler ("Highlight updates") or a temporary `react-scan` that the composer no longer flashes on incoming messages/typing — only on occupant changes and your own typing. Record the before/after in the PR description.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin perf/muc-composer-render-decoupling
gh pr create --fill
```

---

## Self-review notes (addressed)

- **Spec coverage:** SDK focused hooks → already exist, characterized in Task 1 (spec §1 amended: hooks pre-exist; whisper gate lives app-side per existing layering, not in the SDK). Composer memo + narrowing → Tasks 4–5 (spec §2). RoomView churn → Task 6 (spec §3). Testing → Tasks 1, 2, 4 + gate in Task 7 (spec §4).
- **Deviation from spec:** `selectWhisperCounterpartPresent` is realized as the app hook `useWhisperCounterpartPresent` (whisper logic already lives app-side in `conversation/whisperTarget.ts`); no SDK selector is added. Same behavior, less layering churn.
- **Known test-env limitation:** the end-to-end composer render-count under *real* store churn is not asserted in CI (the app mocks `@fluux/sdk`). It is covered indirectly by Task 1 (SDK, real store) + Task 4 (memo boundary) and confirmed manually via the dev profiler in Task 7 Step 3.
