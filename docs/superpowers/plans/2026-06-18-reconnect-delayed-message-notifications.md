# Delayed 1:1 Message Notifications on Reconnect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unseen 1:1 messages delivered on reconnect (SM replay / offline flush) fire native notifications — one per conversation — while the window is hidden or the app is inactive.

**Architecture:** Two parts. (1) SDK: replace the `isDelayed` + 5-min-freshness blocks in `shouldNotifyConversation()` with an *unseen* check driven by `unreadCount`/`lastSeenMessageId`, so notify-worthiness mirrors unread-worthiness. (2) App: a pure per-conversation coalescer plus a short "catch-up window" (opened on each transition into the `online` status) that collapses a reconnect burst into one notification per conversation; live messages outside the window stay immediate.

**Tech Stack:** TypeScript, Zustand (SDK stores), React hooks, Vitest, Tauri (`@tauri-apps/plugin-notification` + native macOS path).

## Global Constraints

- Rooms (MUC) notification behavior MUST NOT change: only `shouldNotifyConversation` changes; `shouldNotifyRoom` keeps its `isDelayed` block. New `EntityContext` fields are **optional**.
- Scope is live delivery paths only (SM replay + offline flush). MAM catch-up (`mergeMAMMessages`) stays notification-free.
- `CATCHUP_WINDOW_MS = 3000`.
- Coalescing lives entirely in the app layer; the SDK only decides "notify-worthy."
- After editing SDK source in this worktree, run `npm run build:sdk` and ensure the app resolves the rebuilt `@fluux/sdk` (worktree resolves `@fluux/sdk` to the root repo's `dist`; sync the built dist to the root's `packages/fluux-sdk/dist`). SDK's own tests use local source and pass without this; only the app→SDK boundary needs it.
- Per-workspace test runs: `cd packages/fluux-sdk && npx vitest run <file>` for SDK; `cd apps/fluux && npx vitest run <file>` for app. Do not run bare `vitest` from repo root.
- Never include a Claude footer in commits.

---

## File Structure

- `packages/fluux-sdk/src/stores/shared/notificationState.ts` — gate + `EntityContext` (Task 1).
- `packages/fluux-sdk/src/stores/shared/notificationState.test.ts` — rewrite + add cases (Task 1).
- `packages/fluux-sdk/src/hooks/useNotificationEvents.ts` — pass new ctx fields (Task 2).
- `packages/fluux-sdk/src/hooks/useNotificationEvents.test.tsx` — ctx wiring + dedup (Task 2).
- `apps/fluux/src/hooks/notificationCoalescer.ts` — new pure buffer (Task 3).
- `apps/fluux/src/hooks/notificationCoalescer.test.ts` — new (Task 3).
- `apps/fluux/src/hooks/useDesktopNotifications.ts` — catch-up window + coalescing (Task 4).
- `apps/fluux/src/hooks/useDesktopNotifications.catchup.test.tsx` — new focused test (Task 4).

---

## Task 1: SDK gate — unseen-based `shouldNotifyConversation`

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` (`EntityContext` ~62-65; `shouldNotifyConversation` ~429-437)
- Test: `packages/fluux-sdk/src/stores/shared/notificationState.test.ts` (fixtures ~41-44; `shouldNotifyConversation` block ~592-621)

**Interfaces:**
- Produces: `shouldNotifyConversation(msg: NotificationMessage, ctx: EntityContext): boolean` — unchanged signature. `EntityContext` gains optional `unreadCount?: number` and `lastSeenMessageId?: string`.

- [ ] **Step 1: Update the `EntityContext` fixtures and rewrite the `shouldNotifyConversation` test block**

In `notificationState.test.ts`, replace the four context fixtures (lines ~41-44) with versions that carry an unseen message:

```ts
const ACTIVE_VISIBLE: EntityContext = { isActive: true, windowVisible: true, unreadCount: 1 }
const ACTIVE_HIDDEN: EntityContext = { isActive: true, windowVisible: false, unreadCount: 1 }
const INACTIVE_VISIBLE: EntityContext = { isActive: false, windowVisible: true, unreadCount: 1 }
const INACTIVE_HIDDEN: EntityContext = { isActive: false, windowVisible: false, unreadCount: 1 }
```

Then replace the entire `describe('shouldNotifyConversation', ...)` block (lines ~592-621) with:

```ts
describe('shouldNotifyConversation', () => {
  it('returns true for incoming unseen message when user cannot see it', () => {
    const msg = makeMsg()
    expect(shouldNotifyConversation(msg, INACTIVE_VISIBLE)).toBe(true)
    expect(shouldNotifyConversation(msg, INACTIVE_HIDDEN)).toBe(true)
    expect(shouldNotifyConversation(msg, ACTIVE_HIDDEN)).toBe(true)
  })

  it('returns false when user sees it (active + visible)', () => {
    expect(shouldNotifyConversation(makeMsg(), ACTIVE_VISIBLE)).toBe(false)
  })

  it('returns false for outgoing messages', () => {
    expect(shouldNotifyConversation(makeMsg({ isOutgoing: true }), INACTIVE_HIDDEN)).toBe(false)
  })

  it('returns true for a delayed but unseen message (reconnect offline delivery)', () => {
    expect(shouldNotifyConversation(makeMsg({ isDelayed: true }), INACTIVE_HIDDEN)).toBe(true)
  })

  it('returns true for an old but unseen message (freshness is not a gate)', () => {
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    expect(
      shouldNotifyConversation(makeMsg({ timestamp: hoursAgo, isDelayed: true }), INACTIVE_HIDDEN),
    ).toBe(true)
  })

  it('returns false when there is nothing unseen (unreadCount 0)', () => {
    expect(
      shouldNotifyConversation(makeMsg(), { isActive: false, windowVisible: false, unreadCount: 0 }),
    ).toBe(false)
  })

  it('returns false when lastMessage is the already-seen message', () => {
    expect(
      shouldNotifyConversation(makeMsg({ id: 'm5' }), {
        isActive: false,
        windowVisible: false,
        unreadCount: 1,
        lastSeenMessageId: 'm5',
      }),
    ).toBe(false)
  })

  it('returns false when context omits unreadCount (defensive default)', () => {
    expect(
      shouldNotifyConversation(makeMsg(), { isActive: false, windowVisible: false }),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts -t "shouldNotifyConversation"`
Expected: FAIL — the delayed/old/unreadCount cases fail against the current `isDelayed`+freshness gate.

- [ ] **Step 3: Extend `EntityContext` in `notificationState.ts`**

Replace the `EntityContext` interface (lines ~61-65):

```ts
/** Context about the entity's current visibility and unread state. */
export interface EntityContext {
  isActive: boolean
  windowVisible: boolean
  /** Current unread count for the entity; used to decide notify-worthiness. */
  unreadCount?: number
  /** ID of the last message the user has seen; suppresses re-notify of seen content. */
  lastSeenMessageId?: string
}
```

- [ ] **Step 4: Rewrite `shouldNotifyConversation`**

Replace the function body (lines ~429-437) and update its doc comment:

```ts
/**
 * Should a conversation message trigger a notification?
 *
 * Notify-worthiness mirrors unread-worthiness: notify for an incoming message the
 * user has not yet seen, when they can't currently see it (not active, or window
 * hidden). Delivery mechanism (isDelayed) and message age are intentionally NOT
 * discriminators — an offline/replayed message delivered on reconnect is "new to me".
 * The unseen check (unreadCount + lastSeenMessageId) keeps MAM history backfill and
 * re-synced duplicates silent and is self-limiting (lastSeenMessageId only advances).
 */
export function shouldNotifyConversation(
  msg: NotificationMessage,
  ctx: EntityContext
): boolean {
  if (msg.isOutgoing) return false
  if (ctx.isActive && ctx.windowVisible) return false
  if ((ctx.unreadCount ?? 0) <= 0) return false
  if (msg.id === ctx.lastSeenMessageId) return false
  return true
}
```

- [ ] **Step 5: Run the full notificationState test file**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts`
Expected: PASS (all describe blocks, including the untouched `shouldNotifyRoom` block).

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/notificationState.ts packages/fluux-sdk/src/stores/shared/notificationState.test.ts
git commit -m "feat(sdk): notify for unseen delayed 1:1 messages (drop isDelayed/freshness gate)"
```

---

## Task 2: SDK hook — pass unread context + prove the wiring

**Files:**
- Modify: `packages/fluux-sdk/src/hooks/useNotificationEvents.ts` (~126-134)
- Test: `packages/fluux-sdk/src/hooks/useNotificationEvents.test.tsx`

**Interfaces:**
- Consumes: `shouldNotifyConversation` with the extended `EntityContext` (Task 1).
- Produces: no signature change; `onConversationMessage(conv, message)` now fires for delayed-but-unseen messages.

- [ ] **Step 1: Add the failing wiring + dedup tests**

Append to `useNotificationEvents.test.tsx` inside the top-level `describe('useNotificationEvents', ...)`, after the existing blocks:

```ts
describe('conversation reconnect delivery', () => {
  it('notifies for a delayed, unseen incoming message', () => {
    const onConversationMessage = vi.fn()
    renderHook(() => useNotificationEvents({ onConversationMessage }))

    act(() => {
      mockConversations.set('alice@example.com', {
        id: 'alice@example.com',
        name: 'Alice',
        unreadCount: 1,
        lastSeenMessageId: undefined,
        lastMessage: {
          id: 'm1',
          timestamp: new Date(),
          isOutgoing: false,
          isDelayed: true,
          from: 'alice@example.com',
        },
      })
      triggerChatStoreUpdate()
    })

    expect(onConversationMessage).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the latest message is already seen', () => {
    const onConversationMessage = vi.fn()
    renderHook(() => useNotificationEvents({ onConversationMessage }))

    act(() => {
      mockConversations.set('bob@example.com', {
        id: 'bob@example.com',
        name: 'Bob',
        unreadCount: 0,
        lastSeenMessageId: 'm1',
        lastMessage: {
          id: 'm1',
          timestamp: new Date(),
          isOutgoing: false,
          isDelayed: true,
          from: 'bob@example.com',
        },
      })
      triggerChatStoreUpdate()
    })

    expect(onConversationMessage).not.toHaveBeenCalled()
  })

  it('does not notify twice for the same message id', () => {
    const onConversationMessage = vi.fn()
    renderHook(() => useNotificationEvents({ onConversationMessage }))

    const conv = {
      id: 'carol@example.com',
      name: 'Carol',
      unreadCount: 1,
      lastSeenMessageId: undefined,
      lastMessage: {
        id: 'm9',
        timestamp: new Date(),
        isOutgoing: false,
        isDelayed: false,
        from: 'carol@example.com',
      },
    }
    act(() => {
      mockConversations.set('carol@example.com', conv)
      triggerChatStoreUpdate()
      triggerChatStoreUpdate() // same lastMessage id → no second notification
    })

    expect(onConversationMessage).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `cd packages/fluux-sdk && npx vitest run src/hooks/useNotificationEvents.test.tsx -t "conversation reconnect delivery"`
Expected: FAIL on "notifies for a delayed, unseen incoming message" — the hook does not yet pass `unreadCount`/`lastSeenMessageId`, so `shouldNotifyConversation` sees `unreadCount` undefined → `false`.

- [ ] **Step 3: Pass the unread context from the hook**

In `useNotificationEvents.ts`, replace the `shouldNotifyConversation(...)` call (lines ~126-134) with:

```ts
          const notify = shouldNotifyConversation(
            {
              id: conv.lastMessage.id,
              timestamp: conv.lastMessage.timestamp,
              isOutgoing: conv.lastMessage.isOutgoing,
              isDelayed: conv.lastMessage.isDelayed,
            },
            {
              isActive,
              windowVisible,
              unreadCount: conv.unreadCount,
              lastSeenMessageId: conv.lastSeenMessageId,
            }
          )
```

- [ ] **Step 4: Run the new tests and the full file**

Run: `cd packages/fluux-sdk && npx vitest run src/hooks/useNotificationEvents.test.tsx`
Expected: PASS.

- [ ] **Step 5: Rebuild the SDK so the app resolves the new behavior/types**

Run: `npm run build:sdk`
Then ensure the app boundary resolves the rebuilt dist (worktree resolves `@fluux/sdk` to the root repo's `dist`):

Run: `rsync -a --delete packages/fluux-sdk/dist/ ../../packages/fluux-sdk/dist/ 2>/dev/null || cp -R packages/fluux-sdk/dist/. ../../packages/fluux-sdk/dist/`
Expected: no error. (If the worktree already has a `node_modules/@fluux/sdk` symlink to its own package, this is a no-op; the goal is that `cd apps/fluux && npx tsc` sees the new optional `EntityContext` fields.)

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/hooks/useNotificationEvents.ts packages/fluux-sdk/src/hooks/useNotificationEvents.test.tsx
git commit -m "feat(sdk): pass unread context into conversation notify decision"
```

---

## Task 3: App — pure notification coalescer

**Files:**
- Create: `apps/fluux/src/hooks/notificationCoalescer.ts`
- Test: `apps/fluux/src/hooks/notificationCoalescer.test.ts`

**Interfaces:**
- Produces:
  - `interface CoalescedEntry<T> { id: string; payload: T }`
  - `interface NotificationCoalescer<T> { isOpen(): boolean; open(): void; add(id: string, payload: T): boolean; flush(): CoalescedEntry<T>[]; drop(): void }`
  - `function createNotificationCoalescer<T>(): NotificationCoalescer<T>`
  - `add` returns `true` when buffered (window open), `false` when the caller should dispatch immediately. `flush` returns one entry per id (latest payload, insertion order) and closes the window. `drop` clears + closes without returning entries.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/hooks/notificationCoalescer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createNotificationCoalescer } from './notificationCoalescer'

describe('createNotificationCoalescer', () => {
  it('is closed initially and add returns false (caller dispatches immediately)', () => {
    const c = createNotificationCoalescer<string>()
    expect(c.isOpen()).toBe(false)
    expect(c.add('a', 'x')).toBe(false)
  })

  it('buffers latest payload per id while open and flushes one entry per id in insertion order', () => {
    const c = createNotificationCoalescer<string>()
    c.open()
    expect(c.isOpen()).toBe(true)
    expect(c.add('a', 'a1')).toBe(true)
    expect(c.add('a', 'a2')).toBe(true) // latest wins
    expect(c.add('b', 'b1')).toBe(true)
    expect(c.flush()).toEqual([
      { id: 'a', payload: 'a2' },
      { id: 'b', payload: 'b1' },
    ])
  })

  it('flush closes the window and clears the buffer', () => {
    const c = createNotificationCoalescer<string>()
    c.open()
    c.add('a', 'a1')
    c.flush()
    expect(c.isOpen()).toBe(false)
    expect(c.flush()).toEqual([])
  })

  it('drop clears the buffer and closes without returning entries', () => {
    const c = createNotificationCoalescer<string>()
    c.open()
    c.add('a', 'a1')
    c.drop()
    expect(c.isOpen()).toBe(false)
    expect(c.flush()).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/hooks/notificationCoalescer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the coalescer**

Create `apps/fluux/src/hooks/notificationCoalescer.ts`:

```ts
/**
 * Per-id notification coalescer (pure, no timers).
 *
 * Used by useDesktopNotifications to collapse a reconnect "catch-up" burst into
 * one notification per conversation. The owning hook controls timing (open the
 * window on reconnect, flush after a fixed delay); this buffer only decides what
 * to keep. While open, the latest payload per id wins; while closed, callers
 * dispatch immediately.
 */
export interface CoalescedEntry<T> {
  id: string
  payload: T
}

export interface NotificationCoalescer<T> {
  /** Whether the coalescing window is currently open. */
  isOpen(): boolean
  /** Open the window; subsequent add() calls buffer instead of returning false. */
  open(): void
  /** Buffer the latest payload for id. Returns true if buffered, false if window closed. */
  add(id: string, payload: T): boolean
  /** Return one entry per id (latest payload, insertion order), clear, and close. */
  flush(): CoalescedEntry<T>[]
  /** Clear the buffer and close without returning entries. */
  drop(): void
}

export function createNotificationCoalescer<T>(): NotificationCoalescer<T> {
  let open = false
  const buffer = new Map<string, T>()

  return {
    isOpen: () => open,
    open: () => {
      open = true
    },
    add: (id, payload) => {
      if (!open) return false
      buffer.set(id, payload)
      return true
    },
    flush: () => {
      const entries = Array.from(buffer, ([id, payload]) => ({ id, payload }))
      buffer.clear()
      open = false
      return entries
    },
    drop: () => {
      buffer.clear()
      open = false
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/hooks/notificationCoalescer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/notificationCoalescer.ts apps/fluux/src/hooks/notificationCoalescer.test.ts
git commit -m "feat(app): add pure per-conversation notification coalescer"
```

---

## Task 4: App — catch-up window wiring in `useDesktopNotifications`

**Files:**
- Modify: `apps/fluux/src/hooks/useDesktopNotifications.ts` (imports ~1-21; component body ~32-50; `showConversationNotification` title ~128-129; `useNotificationEvents({...})` ~230-233)
- Test: `apps/fluux/src/hooks/useDesktopNotifications.catchup.test.tsx` (new)

**Interfaces:**
- Consumes: `createNotificationCoalescer` (Task 3); `useConnectionStatus` from `@fluux/sdk` returning `{ status: ConnectionStatus }`.
- Produces: notifications routed through a catch-up window; no exported signature change.

- [ ] **Step 1: Write the failing catch-up test**

Create `apps/fluux/src/hooks/useDesktopNotifications.catchup.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

// Capture the conversation handler passed to useNotificationEvents.
let capturedOnConversationMessage:
  | ((conv: unknown, message: unknown) => void)
  | undefined

// Drive connection status from the test.
let currentStatus = 'connecting'
const setStatus = (s: string) => {
  currentStatus = s
}

const showWebNotification = vi.fn()

vi.mock('./useNotificationEvents', () => ({
  useNotificationEvents: (handlers: {
    onConversationMessage?: (conv: unknown, message: unknown) => void
  }) => {
    capturedOnConversationMessage = handlers.onConversationMessage
  },
}))

vi.mock('./useNotificationPermission', () => ({
  useNotificationPermission: () => {},
  getNotificationPermissionGranted: () => true,
  isTauri: false,
}))

vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({
    navigateToConversation: vi.fn(),
    navigateToRoom: vi.fn(),
  }),
}))

vi.mock('@/utils/webNotification', () => ({
  showWebNotification: (...args: unknown[]) => showWebNotification(...args),
}))

vi.mock('@/utils/notificationAvatar', () => ({
  getNotificationAvatarUrl: () => Promise.resolve(undefined),
}))

vi.mock('@/utils/messagePreviewText', () => ({
  formatLocalizedPreview: (m: { body?: string }) => m.body ?? '',
}))

vi.mock('@/utils/notificationDebug', () => ({
  notificationDebug: { desktopNotification: vi.fn() },
}))

vi.mock('@/utils/notificationRouting', () => ({
  routeNotificationTarget: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('@fluux/sdk', () => ({
  rosterStore: { getState: () => ({ getContact: () => undefined }) },
  usePresence: () => ({ presenceStatus: 'online' }),
  useConnectionStatus: () => ({ status: currentStatus }),
}))

import { useDesktopNotifications } from './useDesktopNotifications'

const conv = (id: string) => ({
  id,
  name: id,
  unreadCount: 1,
  lastSeenMessageId: undefined,
})
const msg = (id: string, body: string) => ({
  id,
  from: `${id}@example.com`,
  body,
  timestamp: new Date(),
  isOutgoing: false,
})

// showConversationNotification is async (awaits the avatar URL before calling
// showWebNotification), so assertions must let queued microtasks settle.
const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useDesktopNotifications catch-up window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    showWebNotification.mockClear()
    capturedOnConversationMessage = undefined
    currentStatus = 'connecting'
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('coalesces a reconnect burst into one notification per conversation', async () => {
    const { rerender } = renderHook(() => useDesktopNotifications())

    // Transition into online → catch-up window opens.
    act(() => {
      setStatus('online')
      rerender()
    })

    act(() => {
      capturedOnConversationMessage?.(conv('alice'), msg('a1', 'a'))
      capturedOnConversationMessage?.(conv('alice'), msg('a2', 'b'))
      capturedOnConversationMessage?.(conv('bob'), msg('b1', 'c'))
    })

    // Nothing fired yet — all buffered.
    expect(showWebNotification).not.toHaveBeenCalled()

    // Window closes after CATCHUP_WINDOW_MS (3000); async advance flushes the
    // awaited avatar-URL chain inside the flushed dispatches.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(showWebNotification).toHaveBeenCalledTimes(2) // alice + bob
  })

  it('dispatches immediately outside the catch-up window', async () => {
    const { rerender } = renderHook(() => useDesktopNotifications())
    await act(async () => {
      setStatus('online')
      rerender()
      await vi.advanceTimersByTimeAsync(3000) // window opens then closes
    })
    showWebNotification.mockClear()

    await act(async () => {
      capturedOnConversationMessage?.(conv('carol'), msg('c1', 'd'))
      await flushMicrotasks()
    })

    expect(showWebNotification).toHaveBeenCalledTimes(1)
  })

  it('drops buffered notifications when the connection leaves online', async () => {
    const { rerender } = renderHook(() => useDesktopNotifications())
    act(() => {
      setStatus('online')
      rerender()
    })
    act(() => {
      capturedOnConversationMessage?.(conv('dave'), msg('d1', 'e'))
    })

    // Connection drops before the window flushes.
    await act(async () => {
      setStatus('reconnecting')
      rerender()
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(showWebNotification).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/hooks/useDesktopNotifications.catchup.test.tsx`
Expected: FAIL — with no window, the burst dispatches immediately (3 calls, not the coalesced 2) and the drop test still fires a notification.

- [ ] **Step 3: Add imports and constants**

In `useDesktopNotifications.ts`, update the SDK import (line 3) to add `useConnectionStatus`:

```ts
import { rosterStore, usePresence, useConnectionStatus } from '@fluux/sdk'
```

Add the coalescer import after the `useNotificationEvents` import (after line 10):

```ts
import { createNotificationCoalescer } from './notificationCoalescer'
```

Add a module-level constant just below the imports (after line 21):

```ts
/** Duration of the post-reconnect window during which offline-delivery
 *  notifications are coalesced to one per conversation. */
const CATCHUP_WINDOW_MS = 3000
```

- [ ] **Step 4: Add the window state, dispatcher ref, and handler in the component body**

In `useDesktopNotifications()`, after the existing `presenceStatusRef` declaration (line ~41) add:

```ts
  const { status } = useConnectionStatus()
  const prevStatusRef = useRef(status)
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coalescerRef = useRef(
    createNotificationCoalescer<{ conv: Conversation; message: Message }>(),
  )
  const showConvNotifRef = useRef<(conv: Conversation, message: Message) => void>(
    () => {},
  )
```

- [ ] **Step 5: Add the unread-count suffix to the title**

In `showConversationNotification` (lines ~128-130), replace:

```ts
    const senderName = message.from.split('@')[0]
    const title = conv.name || senderName
    const body = formatLocalizedPreview(message, t)
```

with:

```ts
    const senderName = message.from.split('@')[0]
    const baseTitle = conv.name || senderName
    // When a reconnect backlog collapsed into one notification, surface the count.
    const title = conv.unreadCount > 1 ? `${baseTitle} (${conv.unreadCount})` : baseTitle
    const body = formatLocalizedPreview(message, t)
```

- [ ] **Step 6: Wire the dispatcher ref, window effect, and coalescing handler**

Immediately before the `useNotificationEvents({ ... })` call (line ~230), add:

```ts
  // Keep a ref to the latest dispatcher so the window-close timer is never stale.
  useEffect(() => {
    showConvNotifRef.current = showConversationNotification
  })

  // Open a catch-up window on each transition into 'online' (fresh connect,
  // SM resume, or post-wake verify→online). Buffer per-conversation during the
  // window; flush one notification per conversation when it closes. Drop the
  // buffer if the connection leaves 'online' before flushing.
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    const coalescer = coalescerRef.current

    if (status === 'online' && prev !== 'online') {
      coalescer.open()
      if (windowTimerRef.current) clearTimeout(windowTimerRef.current)
      windowTimerRef.current = setTimeout(() => {
        windowTimerRef.current = null
        for (const { payload } of coalescer.flush()) {
          void showConvNotifRef.current(payload.conv, payload.message)
        }
      }, CATCHUP_WINDOW_MS)
    }

    if (status !== 'online' && prev === 'online') {
      if (windowTimerRef.current) {
        clearTimeout(windowTimerRef.current)
        windowTimerRef.current = null
      }
      coalescer.drop()
    }
  }, [status])

  // Drop any pending buffer on unmount.
  useEffect(
    () => () => {
      if (windowTimerRef.current) clearTimeout(windowTimerRef.current)
      coalescerRef.current.drop()
    },
    [],
  )

  // Route conversation notifications through the coalescer while the window is open.
  const handleConversationMessage = (conv: Conversation, message: Message) => {
    const coalescer = coalescerRef.current
    if (coalescer.isOpen()) {
      coalescer.add(conv.id, { conv, message })
      return
    }
    void showConversationNotification(conv, message)
  }
```

Then change the `useNotificationEvents` call (lines ~230-233) to use the new handler:

```ts
  useNotificationEvents({
    onConversationMessage: handleConversationMessage,
    onRoomMessage: showRoomNotification,
  })
```

- [ ] **Step 7: Run the catch-up tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/hooks/useDesktopNotifications.catchup.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 8: Add `useConnectionStatus` to the existing test mocks**

`useDesktopNotifications` now calls `useConnectionStatus()`. The `posting` and `routing` tests fully replace `@fluux/sdk` with local mocks (not `importOriginal`), so `useConnectionStatus` would be `undefined` and throw. Add it to both, returning a non-online status so no catch-up window opens (preserving their immediate-dispatch assumptions).

In `apps/fluux/src/hooks/useDesktopNotifications.routing.test.tsx` (line ~35), change the mock to:

```ts
vi.mock('@fluux/sdk', () => ({ rosterStore: { getState: () => ({ getContact: () => undefined }) }, usePresence: () => ({ presenceStatus: 'online' }), useConnectionStatus: () => ({ status: 'disconnected' }) }))
```

In `apps/fluux/src/hooks/useDesktopNotifications.posting.test.tsx` (lines ~52-54), add the line inside the mock object:

```ts
vi.mock('@fluux/sdk', () => ({
  rosterStore: { getState: () => ({ getContact: () => undefined }) },
  usePresence: () => ({ presenceStatus: 'online' }),
  useConnectionStatus: () => ({ status: 'disconnected' }),
```

(Leave the remaining lines of each existing mock unchanged.)

- [ ] **Step 9: Run the existing desktop-notification tests for regressions**

Run: `cd apps/fluux && npx vitest run src/hooks/useDesktopNotifications.posting.test.tsx src/hooks/useDesktopNotifications.routing.test.tsx`
Expected: PASS. (These exercise the immediate-dispatch path, which is unchanged when no catch-up window is open — status is `'disconnected'` in those tests.)

- [ ] **Step 10: Commit**

```bash
git add apps/fluux/src/hooks/useDesktopNotifications.ts apps/fluux/src/hooks/useDesktopNotifications.catchup.test.tsx apps/fluux/src/hooks/useDesktopNotifications.posting.test.tsx apps/fluux/src/hooks/useDesktopNotifications.routing.test.tsx
git commit -m "feat(app): coalesce reconnect notifications into one per conversation"
```

---

## Task 5: Full verification + manual check

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS. If the app fails on the new optional `EntityContext` fields, re-run Task 2 Step 5 (rebuild SDK + sync dist).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Run the SDK and app test suites for the touched areas**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts src/hooks/useNotificationEvents.test.tsx`
Then: `cd apps/fluux && npx vitest run src/hooks/notificationCoalescer.test.ts src/hooks/useDesktopNotifications.catchup.test.tsx src/hooks/useDesktopNotifications.posting.test.tsx src/hooks/useDesktopNotifications.routing.test.tsx`
Expected: all PASS, no stderr.

- [ ] **Step 4: Manual verification (window hidden) — record the result**

Build/run the desktop app (`npm run tauri:dev`). Then:
1. Connect; hide the window to tray (red button).
2. Sleep the Mac > 12 min (forces SM expiry → offline-flush). From another client, send several 1:1 messages across 2+ conversations during the sleep.
3. Wake **without** opening the window. Expect: one native notification per conversation, count in the title for multi-message conversations; unread badge consistent.
4. Repeat with a ~3-min sleep (SM-resume path) for the same expectation.

Expected: notifications appear per conversation; no per-message storm; no notification for a conversation that was already open+visible.

- [ ] **Step 5: Final commit if any verification fixes were needed**

```bash
git add -A
git commit -m "test: verify reconnect notification coalescing"
```

(Skip if nothing changed.)
