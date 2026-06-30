# Events dissolution 2B — reactions in-conversation, delete the activity log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface received reactions as ephemeral attention — a clickable toast when out of the conversation, a transient in-flow mention when in the conversation and the reacted message is off-screen — then delete the activity log entirely (store, hooks, views, the SDK `ActivityLogHook`, and all reaction-mute state) and remove the Events rail destination.

**Architecture:** Reuses the **existing** SDK `chat:reactions` / `room:reactions` client events (the same ones `ActivityLogHook` consumed) rather than inventing a new event. The only SDK additions are (a) an `isLive` flag on those two events so the app can ignore MAM-replayed reactions, and (b) deleting `ActivityLogHook` + the activity store/types. The app gains a small ephemeral `reactionMentionStore`, a `useReactionNotifications` subscription hook (modeled on `apps/fluux/src/hooks/useSDKErrorToasts.ts`), an in-flow mention component, and a clickable reaction toast. **No reaction muting** (dropped per the resolved design).

**Tech Stack:** React 18 + TypeScript, Zustand (`@fluux/sdk` + app stores), React Router v7, react-i18next, Vitest + @testing-library/react, Tailwind.

## Global Constraints

- **Depends on Plan 2A** (`2026-06-30-events-dissolution-2a-redistribution-archive.md`): `EventsView` is gone, the `'events'` destination already renders only `<ActivityLogView />`, and `'archive'` is already removed from `SidebarView`.
- **SDK changes here require `npm run build:sdk`** before app typecheck, and updates to the `@fluux/sdk` mock in `apps/fluux/src/test-setup.ts` (remove the deleted activity-log surface; add `isLive` where the reaction events are referenced).
- **Live-only notifications.** Reaction notifications fire ONLY for `isLive === true` events. MAM replay (`MAM.ts`) emits `isLive: false`; live delivery (`Chat.ts`) emits `isLive: true`.
- **No reaction muting.** Delete `mutedReactionConversations` / `mutedReactionMessages`, their actions, and `isReactionMuted` along with the activity store. No header toggle, no `⋯` mute menu.
- **On-message reaction badge is unchanged** (it is applied by `storeBindings.ts` `on('chat:reactions')` / `on('room:reactions')`, lines 197 / 389 — do NOT touch that path).
- **i18n:** new keys → all 33 locales (real translations, no em-dash) + the test-setup subset. French values given.
- **Persisted-view fallback:** removing `'events'` from `SidebarView` must degrade a persisted/bookmarked `'events'` (or a `/events` URL) to `'messages'`, never throw (reuse the normalization added for `'archive'` in 2A).
- **Commands:** app test `cd apps/fluux && npx vitest run <path>`; SDK test `cd packages/fluux-sdk && npx vitest run <path>`; `npm run build:sdk`; `npm run typecheck`; `npm run lint`. Never include a Claude footer in commits.

---

## File Structure

**New files**
- `apps/fluux/src/stores/reactionMentionStore.ts` — ephemeral per-conversation in-flow reaction mentions (not persisted).
- `apps/fluux/src/stores/reactionMentionStore.test.ts`
- `apps/fluux/src/hooks/useReactionNotifications.ts` — subscribes to `chat:reactions`/`room:reactions`; dispatches toast or mention.
- `apps/fluux/src/hooks/reactionNotificationDecision.ts` — pure decision helper (testable).
- `apps/fluux/src/hooks/reactionNotificationDecision.test.ts`
- `apps/fluux/src/components/conversation/ReactionMentions.tsx` — the in-flow mention pill stack (rendered above the composer).
- `apps/fluux/src/components/conversation/ReactionMentions.test.tsx`

**Modified files (SDK)**
- `packages/fluux-sdk/src/core/types/sdk-events.ts` — add `isLive` to `chat:reactions` and `room:reactions`.
- `packages/fluux-sdk/src/core/modules/MAM.ts` (lines 1669, 1733) — emit `isLive: false`.
- `packages/fluux-sdk/src/core/modules/Chat.ts` (lines 1256, 1259, 1840, 1843) — emit `isLive: true`.
- `packages/fluux-sdk/src/provider/XMPPProvider.tsx` (line 184 + import line 9) — stop registering `ActivityLogHook`.
- **Delete (SDK):** `packages/fluux-sdk/src/core/eventHooks/ActivityLogHook.ts`, `packages/fluux-sdk/src/stores/activityLogStore.ts`, `packages/fluux-sdk/src/core/types/activity.ts` (if it only serves the log), the `useActivityLog` hook + `useActivityLogStore` react wrapper, and their exports in `packages/fluux-sdk/src/index.ts` / the react entry + `core/eventHooks/index.ts`.
- `apps/fluux/src/test-setup.ts` — remove the activity-log mock surface (`activityLogStore`, `useActivityLog`, `useActivityLogStore`, lines ~236/458–478); ensure the reaction-event mocks carry `isLive`.

**Modified files (app)**
- `apps/fluux/src/components/ChatLayout.tsx` — mount `useReactionNotifications()`; remove `activityPreviewEvent` / `useActivityLogStore` / `activityLogStore` / `ActivityContextView` wiring (lines 17, 25, 30, 194, 903–906).
- `apps/fluux/src/hooks/useViewNavigation.ts` — remove `activityLogStore.getState().setPreviewEvent(null)` calls (lines 13, 102, 165).
- `apps/fluux/src/stores/toastStore.ts` + `apps/fluux/src/components/ToastContainer.tsx` — optional `onClick` on a toast (clickable reaction toast).
- `apps/fluux/src/components/Sidebar.tsx` — remove the Events `IconRailNavLink`, the `events` content/title branches, and the `<ActivityLogView />` render.
- `apps/fluux/src/components/sidebar-components/types.tsx`, `apps/fluux/src/hooks/useRouteSync.ts`, `useViewNavigation.ts`, `useKeyboardShortcuts.ts`, `useSessionPersistence.ts` — remove `'events'`.
- `apps/fluux/src/components/CommandPalette.tsx` — remove the Events entry if present.
- **Delete (app):** `ActivityLogView.tsx`, `ActivityContextView.tsx`, `activityNavigation.ts` + their tests.
- ChatView / RoomView — render `<ReactionMentions conversationId=… />` above the composer.

---

## Task 1: SDK — add `isLive` to the reaction events

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts` (the `chat:reactions` and `room:reactions` payload types, lines 132 / 306)
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (1669, 1733)
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (1256, 1259, 1840, 1843)
- Test: a focused SDK test (e.g. extend an existing MAM/Chat reactions test, or add `packages/fluux-sdk/src/core/modules/reactionsLiveFlag.test.ts`)

**Interfaces — Produces:**
- `chat:reactions` payload gains `isLive: boolean`; `room:reactions` payload gains `isLive: boolean`.
- MAM emits `isLive: false`; Chat (live delivery + own echo) emits `isLive: true`.

- [ ] **Step 1: Add the field to the event types**

In `packages/fluux-sdk/src/core/types/sdk-events.ts`, add `isLive: boolean` to both the `'chat:reactions'` (line 132) and `'room:reactions'` (line 306) payload shapes (keep `timestamp` optional as today).

- [ ] **Step 2: Write the failing test**

Create `packages/fluux-sdk/src/core/modules/reactionsLiveFlag.test.ts` asserting the emit values. Model it on the existing MAM/Chat module tests (mock `emitSDK`, drive a reaction stanza through the handler, assert the emitted payload includes `isLive`):

```ts
import { describe, it, expect, vi } from 'vitest'
// ... import/construct the Chat + MAM modules as the existing module tests do,
// with a spy on deps.emitSDK.

it('Chat emits live reactions with isLive: true', () => {
  // drive an incoming live reaction stanza; assert:
  // expect(emitSDK).toHaveBeenCalledWith('chat:reactions', expect.objectContaining({ isLive: true }))
})

it('MAM emits replayed reactions with isLive: false', () => {
  // drive a MAM result containing a reaction; assert:
  // expect(emitSDK).toHaveBeenCalledWith('chat:reactions', expect.objectContaining({ isLive: false }))
})
```

> Follow the existing test harness for these modules (`Chat.test.ts` / `MAM.test.ts`) for how to construct the module and feed stanzas. Reuse their stanza builders.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/reactionsLiveFlag.test.ts`
Expected: FAIL (no `isLive` emitted).

- [ ] **Step 4: Add `isLive` at the four emit sites**

- `MAM.ts:1669` (`chat:reactions`) and `MAM.ts:1733` (`room:reactions`): add `isLive: false` to the emitted object.
- `Chat.ts:1256` / `Chat.ts:1259` (own-echo) and `Chat.ts:1840` / `Chat.ts:1843` (incoming live): add `isLive: true` to each emitted object.

- [ ] **Step 5: Run the test + build the SDK**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/reactionsLiveFlag.test.ts && cd .. && npm run build:sdk`
Expected: PASS, then a clean SDK build.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/types/sdk-events.ts packages/fluux-sdk/src/core/modules/MAM.ts packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/reactionsLiveFlag.test.ts
git commit -m "feat(sdk): tag chat/room reaction events with isLive (live vs MAM replay)"
```

---

## Task 2: App — `reactionMentionStore` (ephemeral)

**Files:**
- Create: `apps/fluux/src/stores/reactionMentionStore.ts`
- Create: `apps/fluux/src/stores/reactionMentionStore.test.ts`

**Interfaces — Produces:**
```ts
export interface ReactionMention {
  id: string            // `${conversationId}:${messageId}` (one per reacted message; latest wins)
  conversationId: string
  messageId: string
  reactorName: string
  emoji: string
  preview: string       // short text of the reacted message
}
interface ReactionMentionState {
  mentions: Map<string, ReactionMention[]>   // keyed by conversationId
  addMention: (m: ReactionMention) => void   // de-dupes by id within the conversation (latest wins)
  dismissMention: (conversationId: string, id: string) => void
  clearConversation: (conversationId: string) => void
}
export const useReactionMentionStore // zustand hook (create)
export const reactionMentionStore    // vanilla store handle (getState/subscribe) for the side-effect
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { reactionMentionStore } from './reactionMentionStore'

const m = (over = {}) => ({ id: 'c1:msg1', conversationId: 'c1', messageId: 'msg1', reactorName: 'Marie', emoji: '❤️', preview: 'hi', ...over })

describe('reactionMentionStore', () => {
  beforeEach(() => reactionMentionStore.getState().clearConversation('c1'))

  it('adds a mention and reads it back by conversation', () => {
    reactionMentionStore.getState().addMention(m())
    expect(reactionMentionStore.getState().mentions.get('c1')?.length).toBe(1)
  })
  it('de-dupes by id (latest wins) instead of stacking duplicates', () => {
    reactionMentionStore.getState().addMention(m({ emoji: '❤️' }))
    reactionMentionStore.getState().addMention(m({ emoji: '👍' }))
    const list = reactionMentionStore.getState().mentions.get('c1')!
    expect(list.length).toBe(1)
    expect(list[0].emoji).toBe('👍')
  })
  it('dismisses a mention', () => {
    reactionMentionStore.getState().addMention(m())
    reactionMentionStore.getState().dismissMention('c1', 'c1:msg1')
    expect(reactionMentionStore.getState().mentions.get('c1')?.length ?? 0).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/stores/reactionMentionStore.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the store** (mirror the `create` + vanilla-handle pattern used by `toastStore.ts`):

```ts
import { create } from 'zustand'

export interface ReactionMention {
  id: string
  conversationId: string
  messageId: string
  reactorName: string
  emoji: string
  preview: string
}

interface ReactionMentionState {
  mentions: Map<string, ReactionMention[]>
  addMention: (m: ReactionMention) => void
  dismissMention: (conversationId: string, id: string) => void
  clearConversation: (conversationId: string) => void
}

export const useReactionMentionStore = create<ReactionMentionState>((set) => ({
  mentions: new Map(),
  addMention: (m) => set((s) => {
    const next = new Map(s.mentions)
    const list = (next.get(m.conversationId) ?? []).filter((x) => x.id !== m.id)
    next.set(m.conversationId, [...list, m])
    return { mentions: next }
  }),
  dismissMention: (conversationId, id) => set((s) => {
    const next = new Map(s.mentions)
    const list = (next.get(conversationId) ?? []).filter((x) => x.id !== id)
    if (list.length) next.set(conversationId, list); else next.delete(conversationId)
    return { mentions: next }
  }),
  clearConversation: (conversationId) => set((s) => {
    if (!s.mentions.has(conversationId)) return s
    const next = new Map(s.mentions)
    next.delete(conversationId)
    return { mentions: next }
  }),
}))

export const reactionMentionStore = useReactionMentionStore
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/stores/reactionMentionStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/stores/reactionMentionStore.ts apps/fluux/src/stores/reactionMentionStore.test.ts
git commit -m "feat(reactions): add ephemeral reaction-mention store"
```

---

## Task 3: App — reaction notification decision + subscription hook

**Files:**
- Create: `apps/fluux/src/hooks/reactionNotificationDecision.ts`
- Create: `apps/fluux/src/hooks/reactionNotificationDecision.test.ts`
- Create: `apps/fluux/src/hooks/useReactionNotifications.ts`
- Modify: `apps/fluux/src/components/ChatLayout.tsx` (mount the hook)
- Modify: `apps/fluux/src/i18n/locales/*` + test-setup (mention/toast copy)

**Interfaces — Produces:**
```ts
// reactionNotificationDecision.ts
export interface ReactionEvent { conversationId: string; messageId: string; reactorName: string; emojis: string[]; isLive: boolean }
export interface ReactionContext { activeConversationId: string | null; isLastMessage: boolean; isOwnOutgoing: boolean }
export type ReactionDecision =
  | { kind: 'none' }
  | { kind: 'toast' }
  | { kind: 'mention' }
export function decideReactionNotification(ev: ReactionEvent, ctx: ReactionContext): ReactionDecision
```
Rules: `none` if `!ev.isLive` or `!ev.emojis.length` or `!ctx.isOwnOutgoing`; else `mention` if `ev.conversationId === ctx.activeConversationId && !ctx.isLastMessage`; else `none` if active && isLastMessage (badge suffices); else `toast` (not active).

- Consumes: existing `chat:reactions` / `room:reactions` events via `useXMPP().client` (template: `apps/fluux/src/hooks/useSDKErrorToasts.ts`); the own-outgoing filter logic from `ActivityLogHook` (lines 85–91 chat, 100–107 room); `chatStore`/`roomStore` for last-message + active state; `reactionMentionStore` (Task 2); `toastStore` clickable toast (Task 4); `scrollToMessage` (`apps/fluux/src/components/conversation/messageGrouping.ts`).

- [ ] **Step 1: Write the failing decision test**

```ts
import { describe, it, expect } from 'vitest'
import { decideReactionNotification } from './reactionNotificationDecision'

const ev = (over = {}) => ({ conversationId: 'c1', messageId: 'm1', reactorName: 'Marie', emojis: ['❤️'], isLive: true, ...over })

describe('decideReactionNotification', () => {
  it('ignores non-live reactions (MAM replay)', () => {
    expect(decideReactionNotification(ev({ isLive: false }), { activeConversationId: 'c1', isLastMessage: false, isOwnOutgoing: true }).kind).toBe('none')
  })
  it('ignores reactions on messages that are not our own outgoing', () => {
    expect(decideReactionNotification(ev(), { activeConversationId: null, isLastMessage: false, isOwnOutgoing: false }).kind).toBe('none')
  })
  it('shows a toast when the conversation is not active', () => {
    expect(decideReactionNotification(ev(), { activeConversationId: 'other', isLastMessage: false, isOwnOutgoing: true }).kind).toBe('toast')
  })
  it('shows an in-flow mention when active and the target is not the last message', () => {
    expect(decideReactionNotification(ev(), { activeConversationId: 'c1', isLastMessage: false, isOwnOutgoing: true }).kind).toBe('mention')
  })
  it('shows nothing when active and the target IS the last message (badge suffices)', () => {
    expect(decideReactionNotification(ev(), { activeConversationId: 'c1', isLastMessage: true, isOwnOutgoing: true }).kind).toBe('none')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/reactionNotificationDecision.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the decision helper**

```ts
export interface ReactionEvent { conversationId: string; messageId: string; reactorName: string; emojis: string[]; isLive: boolean }
export interface ReactionContext { activeConversationId: string | null; isLastMessage: boolean; isOwnOutgoing: boolean }
export type ReactionDecision = { kind: 'none' } | { kind: 'toast' } | { kind: 'mention' }

export function decideReactionNotification(ev: ReactionEvent, ctx: ReactionContext): ReactionDecision {
  if (!ev.isLive || ev.emojis.length === 0 || !ctx.isOwnOutgoing) return { kind: 'none' }
  if (ev.conversationId === ctx.activeConversationId) {
    return ctx.isLastMessage ? { kind: 'none' } : { kind: 'mention' }
  }
  return { kind: 'toast' }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/reactionNotificationDecision.test.ts`
Expected: PASS

- [ ] **Step 5: Implement `useReactionNotifications`** (template: `useSDKErrorToasts.ts`)

```ts
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP } from '@fluux/sdk/react'
import { chatStore, roomStore, connectionStore, getBareJid } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'
import { useReactionMentionStore } from '@/stores/reactionMentionStore'
import { useRouteSync } from '@/hooks'
import { scrollToMessage } from '@/components/conversation/messageGrouping'
import { decideReactionNotification } from './reactionNotificationDecision'

export function useReactionNotifications() {
  const { client } = useXMPP()
  const { t } = useTranslation()
  const { navigateToMessages, navigateToRooms } = useRouteSync()

  useEffect(() => {
    if (!client) return

    const onChat = ({ conversationId, messageId, reactorJid, emojis, isLive }: { conversationId: string; messageId: string; reactorJid: string; emojis: string[]; isLive: boolean }) => {
      const myJid = getBareJid(connectionStore.getState().jid ?? '')
      if (getBareJid(reactorJid) === myJid) return
      const messages = chatStore.getState().messages.get(conversationId)
      const message = messages?.find((m) => m.id === messageId)
      if (!message?.isOutgoing) return
      const isLast = messages && messages.length > 0 ? messages[messages.length - 1].id === messageId : false
      const decision = decideReactionNotification(
        { conversationId, messageId, reactorName: reactorJid.split('@')[0], emojis, isLive },
        { activeConversationId: chatStore.getState().activeConversationId, isLastMessage: isLast, isOwnOutgoing: true },
      )
      dispatch(decision, { conversationId, messageId, reactorName: reactorJid.split('@')[0], emoji: emojis[0], preview: message.body?.slice(0, 80) ?? '', isRoom: false })
    }

    const onRoom = ({ roomJid, messageId, reactorNick, emojis, isLive }: { roomJid: string; messageId: string; reactorNick: string; emojis: string[]; isLive: boolean }) => {
      const room = roomStore.getState().rooms.get(roomJid)
      if (!room || reactorNick === room.nickname) return
      const message = roomStore.getState().getMessage(roomJid, messageId)
      if (!message || message.nick !== room.nickname) return
      const isActive = roomStore.getState().activeRoomJid === roomJid
      // Rooms surface mentions like 1:1; reuse the same decision with activeConversationId mapped to the active room.
      const decision = decideReactionNotification(
        { conversationId: roomJid, messageId, reactorName: reactorNick, emojis, isLive },
        { activeConversationId: isActive ? roomJid : null, isLastMessage: false, isOwnOutgoing: true },
      )
      dispatch(decision, { conversationId: roomJid, messageId, reactorName: reactorNick, emoji: emojis[0], preview: message.body?.slice(0, 80) ?? '', isRoom: true })
    }

    const dispatch = (
      decision: ReturnType<typeof decideReactionNotification>,
      m: { conversationId: string; messageId: string; reactorName: string; emoji: string; preview: string; isRoom: boolean },
    ) => {
      if (decision.kind === 'none') return
      const label = t('reactions.mention', { name: m.reactorName, emoji: m.emoji, preview: m.preview })
      if (decision.kind === 'toast') {
        useToastStore.getState().addToast('info', label, 6000, () => {
          if (m.isRoom) navigateToRooms(m.conversationId)
          else navigateToMessages(m.conversationId)
          setTimeout(() => scrollToMessage(m.messageId), 100)
        })
      } else {
        useReactionMentionStore.getState().addMention({ id: `${m.conversationId}:${m.messageId}`, ...m })
      }
    }

    client.on('chat:reactions', onChat)
    client.on('room:reactions', onRoom)
    return () => {
      client.off('chat:reactions', onChat)
      client.off('room:reactions', onRoom)
    }
  }, [client, t, navigateToMessages, navigateToRooms])
}
```

> Confirm: (a) `client.on` / `client.off` are the subscription methods (mirror `useSDKErrorToasts.ts`); (b) `chatStore.getState().messages` row shape has `.id` / `.isOutgoing` / `.body` (it does — see `findMessageById` usage in `ActivityLogHook`); (c) `roomStore.getState().getMessage(roomJid, id)` exists (used by `ActivityLogHook` line 106); (d) the `addToast` 4th `onClick` arg lands with Task 4.

- [ ] **Step 6: Add i18n key** `reactions.mention` = "{{emoji}} {{name}} reacted to '{{preview}}'" (en) / fr "{{emoji}} {{name}} a réagi à « {{preview}} »", plus `reactions.see` = "See" / "Voir". Add to all 33 locales + test-setup subset.

- [ ] **Step 7: Mount the hook in `ChatLayout`**

In `apps/fluux/src/components/ChatLayout.tsx`, call `useReactionNotifications()` near the other top-level hooks (e.g. alongside `useSDKErrorToasts()` if present).

- [ ] **Step 8: Run the decision test + typecheck**

Run: `cd apps/fluux && npx vitest run src/hooks/reactionNotificationDecision.test.ts && cd .. && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/hooks/reactionNotificationDecision.ts apps/fluux/src/hooks/reactionNotificationDecision.test.ts apps/fluux/src/hooks/useReactionNotifications.ts apps/fluux/src/components/ChatLayout.tsx apps/fluux/src/i18n/locales apps/fluux/src/test-setup.ts
git commit -m "feat(reactions): notify received reactions via toast or in-flow mention"
```

---

## Task 4: App — clickable reaction toast

**Files:**
- Modify: `apps/fluux/src/stores/toastStore.ts`
- Modify: `apps/fluux/src/components/ToastContainer.tsx`
- Modify: `apps/fluux/src/stores/toastStore.test.ts` (if present) or create

**Interfaces — Produces:**
- `addToast(type, message, duration?, onClick?)` — adds an optional `onClick`; `Toast` gains `onClick?: () => void`. When present, the toast row is a button that runs `onClick` then dismisses.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { useToastStore } from './toastStore'

it('stores an onClick handler on the toast', () => {
  const fn = vi.fn()
  const id = useToastStore.getState().addToast('info', 'hi', 4000, fn)
  const toast = useToastStore.getState().toasts.find((x) => x.id === id)
  expect(toast?.onClick).toBe(fn)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/stores/toastStore.test.ts`
Expected: FAIL (4th arg / `onClick` not supported).

- [ ] **Step 3: Implement** — in `toastStore.ts`, add `onClick?: () => void` to the `Toast` interface and the `addToast` signature `addToast: (type, message, duration?, onClick?) => string`, storing it on the toast object. In `ToastContainer.tsx`, when `toast.onClick` is set, render the content as a clickable element (`role="button"`, `onClick={() => { toast.onClick!(); removeToast(toast.id) }}`, `cursor-pointer`); keep the explicit close (✕) button working.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/stores/toastStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/stores/toastStore.ts apps/fluux/src/components/ToastContainer.tsx apps/fluux/src/stores/toastStore.test.ts
git commit -m "feat(toast): support a clickable toast action"
```

---

## Task 5: App — in-flow reaction mention component

**Files:**
- Create: `apps/fluux/src/components/conversation/ReactionMentions.tsx`
- Create: `apps/fluux/src/components/conversation/ReactionMentions.test.tsx`
- Modify: ChatView + RoomView (render the component above the composer)

**Interfaces — Produces:**
```ts
interface ReactionMentionsProps { conversationId: string }
export function ReactionMentions(props: ReactionMentionsProps): JSX.Element | null
```
Renders the `reactionMentionStore` entries for `conversationId` as a stack of centered muted pills just above the composer (NOT interleaved into the virtualized list). Each pill: "{emoji} {name} reacted to '{preview}'" + a "See" button (`scrollToMessage(messageId)`) + a dismiss ✕ (`dismissMention`).

> **Rendering decision (flag for reviewer):** the spec described the mention as "in-flow." Interleaving a non-message row into the virtualized `MessageList` is invasive; this plan renders the mentions as a pinned stack directly above the composer (same visual register, no virtualizer change). The user noted the rendering was open ("à voir comment nous en ferons le rendu"). If interleaving is required, that is a separate virtualizer task.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { reactionMentionStore } from '@/stores/reactionMentionStore'
import { ReactionMentions } from './ReactionMentions'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }) }))
const scrollToMessage = vi.fn()
vi.mock('./messageGrouping', () => ({ scrollToMessage: (id: string) => scrollToMessage(id) }))

describe('ReactionMentions', () => {
  beforeEach(() => { vi.clearAllMocks(); reactionMentionStore.getState().clearConversation('c1') })

  it('renders nothing when there are no mentions', () => {
    const { container } = render(<ReactionMentions conversationId="c1" />)
    expect(container.firstChild).toBeNull()
  })
  it('renders a mention, jumps on See, and dismisses on ✕', () => {
    reactionMentionStore.getState().addMention({ id: 'c1:m1', conversationId: 'c1', messageId: 'm1', reactorName: 'Marie', emoji: '❤️', preview: 'hi' })
    render(<ReactionMentions conversationId="c1" />)
    fireEvent.click(screen.getByText('reactions.see'))
    expect(scrollToMessage).toHaveBeenCalledWith('m1')
    fireEvent.click(screen.getByLabelText('common.dismiss'))
    expect(reactionMentionStore.getState().mentions.get('c1')?.length ?? 0).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/ReactionMentions.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `ReactionMentions.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useReactionMentionStore } from '@/stores/reactionMentionStore'
import { scrollToMessage } from './messageGrouping'

interface ReactionMentionsProps { conversationId: string }

export function ReactionMentions({ conversationId }: ReactionMentionsProps) {
  const { t } = useTranslation()
  const mentions = useReactionMentionStore((s) => s.mentions.get(conversationId))
  const dismissMention = useReactionMentionStore((s) => s.dismissMention)

  if (!mentions || mentions.length === 0) return null

  return (
    <div className="px-3 pb-1 space-y-1">
      {mentions.map((m) => (
        <div key={m.id} className="mx-auto max-w-md flex items-center justify-center gap-2 text-xs text-fluux-muted bg-fluux-hover/60 rounded-full px-3 py-1">
          <span className="truncate">{t('reactions.mention', { name: m.reactorName, emoji: m.emoji, preview: m.preview })}</span>
          <button onClick={() => scrollToMessage(m.messageId)} className="font-medium text-fluux-brand hover:underline flex-shrink-0">
            {t('reactions.see')}
          </button>
          <button onClick={() => dismissMention(conversationId, m.id)} aria-label={t('common.dismiss')} className="text-fluux-muted hover:text-fluux-text flex-shrink-0">
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/ReactionMentions.test.tsx`
Expected: PASS

- [ ] **Step 5: Mount above the composer in ChatView and RoomView**

In `ChatView` and `RoomView`, render `<ReactionMentions conversationId={activeConversationId|activeRoomJid} />` between the message list and the composer. Also clear stale mentions on conversation switch: in each view, on `conversationId` change, call `reactionMentionStore.getState().clearConversation(previousId)` (or clear when the user has clearly seen them — simplest: clear the active conversation's mentions when it becomes active/last message is reached). Keep it minimal: clear on unmount / conversation change.

> Confirm the exact prop name for the active id in each view (ChatView uses the active conversation id; RoomView the active room jid) and the composer mount point.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/conversation/ReactionMentions.tsx apps/fluux/src/components/conversation/ReactionMentions.test.tsx apps/fluux/src/components/conversation/ChatView.tsx apps/fluux/src/components/conversation/RoomView.tsx
git commit -m "feat(reactions): show transient in-flow reaction mentions above the composer"
```

---

## Task 6: Delete the activity log + remove the Events rail destination

**Files:** (delete) `ActivityLogView.tsx`, `ActivityContextView.tsx`, `activityNavigation.ts` + tests; (SDK delete) `ActivityLogHook.ts`, `activityLogStore.ts`, `useActivityLog`, `useActivityLogStore`, `types/activity.ts`; (modify) `XMPPProvider.tsx`, `index.ts` (SDK + react entry), `ChatLayout.tsx`, `useViewNavigation.ts`, `Sidebar.tsx`, `types.tsx`, `useRouteSync.ts`, `useKeyboardShortcuts.ts`, `useSessionPersistence.ts`, `CommandPalette.tsx`, `apps/fluux/src/test-setup.ts`.

**Interfaces:** After this task, `SidebarView` has no `'events'`; the Events rail icon is gone; `/events` degrades to `/messages`; the SDK no longer exports any activity-log symbol; reactions notify only via Tasks 2–5.

- [ ] **Step 1: Stop registering `ActivityLogHook`**

In `packages/fluux-sdk/src/provider/XMPPProvider.tsx`, remove the import (line 9) and the `client.registerHook(new ActivityLogHook(client))` call (line 184).

- [ ] **Step 2: Delete the SDK activity-log files and exports**

```bash
git rm packages/fluux-sdk/src/core/eventHooks/ActivityLogHook.ts packages/fluux-sdk/src/stores/activityLogStore.ts
```
Remove from `packages/fluux-sdk/src/core/eventHooks/index.ts` the `ActivityLogHook` export; from `packages/fluux-sdk/src/index.ts` remove `activityLogStore`, `useActivityLog`, the `ActivityEvent` / `ReactionReceivedPayload` / activity types (and delete `packages/fluux-sdk/src/core/types/activity.ts` if nothing else uses it — grep first); from the react entry remove `useActivityLogStore`. Delete the `useActivityLog` hook file. Grep for any remaining SDK importers and remove them.

- [ ] **Step 3: Delete the app activity-log files**

```bash
git rm apps/fluux/src/components/sidebar-components/ActivityLogView.tsx apps/fluux/src/components/ActivityContextView.tsx apps/fluux/src/components/sidebar-components/activityNavigation.ts apps/fluux/src/components/sidebar-components/activityNavigation.test.ts
```
(Also remove any `ActivityLogView.test.tsx` / `ActivityContextView.test.tsx` if present.)

- [ ] **Step 4: Remove the app wiring**

- `ChatLayout.tsx`: remove the `ActivityContextView` lazy import (line 17), the `activityLogStore` / `useActivityLogStore` imports (25, 30), `const activityPreviewEvent = useActivityLogStore(...)` (194), and the `) : activityPreviewEvent ? ( … )` branch (903–906).
- `useViewNavigation.ts`: remove `activityLogStore` import (13) and the `setPreviewEvent(null)` calls (102, 165).
- `Sidebar.tsx`: remove the Events `IconRailNavLink` (`Bell`), the `events` branch of the content switch (now `<ActivityLogView />` — remove the whole branch) and the `events` title-switch branch; remove the `Bell` import if unused.
- `types.tsx`: remove `'events'` from `SidebarView` and `VIEW_PATHS`.
- `useRouteSync.ts`: remove the `/events` parse line and `navigateToEvents` (or alias to messages); `useKeyboardShortcuts.ts`: remove `'events'`; `useSessionPersistence.ts`: extend the normalization (from 2A) so a persisted `'events'` also degrades to `'messages'`.
- `CommandPalette.tsx`: remove any Events entry.
- `apps/fluux/src/test-setup.ts`: remove the `activityLogStore` / `useActivityLog` / `useActivityLogStore` mock blocks (≈236, 458–478); ensure reaction-event mocks carry `isLive`.

- [ ] **Step 5: Rebuild SDK, typecheck, lint**

Run: `npm run build:sdk && npm run typecheck && npm run lint`
Expected: PASS. The compiler enumerates every dangling `'events'` literal and every removed import — fix each until clean.

- [ ] **Step 6: Run the affected suites**

Run: `./scripts/test-affected.sh main`
Expected: PASS. Remove/adjust any test that asserted the activity log, the `'events'` view, or `setPreviewEvent`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(events): delete the activity log and remove the Events rail destination"
```

---

## Task 7: Full verification (2B)

- [ ] **Step 1: Build SDK + typecheck** — Run: `npm run build:sdk && npm run typecheck` — Expected: PASS
- [ ] **Step 2: Lint** — Run: `npm run lint` — Expected: PASS
- [ ] **Step 3: Full test run** — Run: `npm test` — Expected: PASS, no stderr. (Confirms no dangling activity-log references in either workspace.)
- [ ] **Step 4: Demo smoke (manual)** — `npm run dev` → `demo.html`:
  - A reaction to one of your messages, received while you are in another conversation, raises a clickable toast; clicking opens the conversation and scrolls to the message.
  - A reaction on an older (off-screen) message in the active conversation shows a centered mention pill above the composer with "See" (jumps) and ✕ (dismisses).
  - A reaction on the last visible message shows no toast/mention (only the on-message badge updates).
  - Reconnecting after offline activity does NOT produce a burst of reaction toasts (MAM replay is `isLive: false`).
  - The rail has no Events (Bell) icon; visiting `/events` lands on Messages. No activity-log view exists anywhere.
- [ ] **Step 5: Commit any fixups** — `git commit -am "chore: 2B verification fixups"`

---

## Self-review notes (decisions for the reviewer)

1. **Reuses existing `chat:reactions` / `room:reactions` events** instead of a new SDK event — the only SDK additions are the `isLive` flag and the deletion of `ActivityLogHook` + the activity store/types. The on-message badge path (`storeBindings.ts`) is untouched.
2. **`isLive` is the MAM guard.** MAM emits `false`, Chat emits `true`; the app notifies only on `true`. If any other code path emits these events, audit it for the correct `isLive` value.
3. **In-flow mentions render above the composer, not interleaved** in the virtualized list (rendering was left open by the user). Flag if interleaving is required.
4. **No reaction muting** — the mute state is deleted with the activity log, per the resolved design. A mute control can be reintroduced later behind a header notify submenu (which would also need creating for 1:1 chats).
5. **MUC reactions** use the same toast/mention path as 1:1. The user said a reactions control for MUC is "to be seen later"; this plan does not add per-room reaction settings, only the same notification surfaces.
6. **Clearing stale mentions** (Task 5 Step 5) is kept minimal (clear on conversation change). If mentions should auto-clear when the user scrolls the target into view, that is a follow-up.
