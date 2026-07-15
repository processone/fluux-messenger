# Replayable Easter Eggs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a received easter-egg animation reach the user even when its conversation is inactive — surfaced as a clickable toast, played on open, and replayable from a dismissible chip.

**Architecture:** The SDK emits enriched `chat:animation` / `room:animation` events (adding sender identity). The store binding plays the animation *only* for the active conversation. A new app hook handles the inactive case (toast + a transient in-memory pending-egg store). On open, the view auto-plays any pending egg and keeps a "Replay" chip (a widget shared with reaction mentions) until dismissed.

**Tech Stack:** TypeScript, React, Zustand (vanilla + React stores), Vitest, react-i18next, `@fluux/sdk`.

## Global Constraints

- SDK public API stays clean; apps consume via hooks/types only — no `@xmpp/client` imports in the app.
- After any SDK source change, run `npm run build:sdk` before app typecheck/tests.
- New SDK export/field used by the app that a test asserts must be reflected in the app SDK mock (`apps/fluux/src/test-setup.ts`, via `importOriginal` spread).
- i18n: every new key is added to **all 33 locale files** in `apps/fluux/src/i18n/locales/`. Claude authors the translations. No em-dash connectors in copy. Edit locale JSON surgically: parse → mutate → `JSON.stringify(obj, null, 4) + "\n"`.
- Any translated label asserted in a test must be added to the i18n subset in `apps/fluux/src/test-setup.ts`.
- Commit after every task. Never include a Claude footer in commits.
- Before declaring done: `npm test`, `npm run typecheck`, and the linter must pass with no errors/stderr.

---

## File Structure

**SDK (`packages/fluux-sdk/`):**
- Modify `src/core/types/sdk-events.ts` — add `senderJid` to `chat:animation`, `senderNick` to `room:animation`.
- Modify `src/core/modules/Chat.ts` — populate the new fields at the 3 emit sites (receive-chat, receive-room, send).
- Modify `src/bindings/storeBindings.ts` — guard `triggerAnimation` to the active conversation.

**App (`apps/fluux/`):**
- Create `src/components/conversation/MentionChip.tsx` — shared presentational pill.
- Modify `src/components/conversation/ReactionMentions.tsx` — render via `MentionChip`.
- Create `src/stores/easterEggMentionStore.ts` — transient per-conversation pending-egg store.
- Create `src/hooks/easterEggNotificationDecision.ts` — pure decision function.
- Create `src/hooks/useEasterEggNotifications.ts` — subscribes to SDK animation events.
- Modify `src/components/ChatLayout.tsx` — mount the hook.
- Create `src/components/conversation/EasterEggMentions.tsx` — the Replay chip.
- Modify `src/components/ChatView.tsx` + `src/components/RoomView.tsx` — mount the chip and add on-open auto-play.
- Modify all 33 files in `src/i18n/locales/` — new `easterEgg.*` keys + `common.dismiss`.

---

## Task 1: SDK — enrich animation events

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts` (`chat:animation` ~178, `room:animation` ~362)
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (receive ~384-388, send ~1536-1541)
- Test: `packages/fluux-sdk/src/core/modules/Chat.test.ts`

**Interfaces:**
- Produces: `chat:animation` payload `{ conversationId: string; animation: string; senderJid: string }`; `room:animation` payload `{ roomJid: string; animation: string; senderNick: string }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/core/modules/Chat.test.ts` (follow the existing `createMockElement` / `_emit('stanza', …)` pattern already used in this file):

```typescript
it('emits chat:animation with the sender bare JID on receipt', () => {
  const events: any[] = []
  client.subscribe('chat:animation', (e) => events.push(e))
  const stanza = createMockElement('message', { from: 'ava@fluux.chat/phone', to: 'me@fluux.chat', type: 'chat' }, [
    { name: 'easter-egg', attrs: { xmlns: 'urn:fluux:easter-egg:0', animation: 'fireworks' } },
  ])
  mockXmppClientInstance._emit('stanza', stanza)
  expect(events).toEqual([{ conversationId: 'ava@fluux.chat', animation: 'fireworks', senderJid: 'ava@fluux.chat' }])
})

it('emits room:animation with the sender nick on receipt', () => {
  const events: any[] = []
  client.subscribe('room:animation', (e) => events.push(e))
  const stanza = createMockElement('message', { from: 'room@conf.fluux.chat/ava', type: 'groupchat' }, [
    { name: 'easter-egg', attrs: { xmlns: 'urn:fluux:easter-egg:0', animation: 'fireworks' } },
  ])
  mockXmppClientInstance._emit('stanza', stanza)
  expect(events).toEqual([{ roomJid: 'room@conf.fluux.chat', animation: 'fireworks', senderNick: 'ava' }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.test.ts -t animation`
Expected: FAIL — payloads lack `senderJid` / `senderNick`.

- [ ] **Step 3: Update the event type definitions**

In `packages/fluux-sdk/src/core/types/sdk-events.ts`:

```typescript
  /** Animation triggered (easter egg) */
  'chat:animation': {
    conversationId: string
    animation: string
    senderJid: string
  }
```

```typescript
  /** Room animation triggered */
  'room:animation': {
    roomJid: string
    animation: string
    senderNick: string
  }
```

- [ ] **Step 4: Populate the fields at the receive emit site**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, replace the easter-egg receive block (~384-388). `from`, `bareFrom` are already in scope; `getResource` is already imported (line 4):

```typescript
        if (type === 'groupchat') {
          this.deps.emitSDK('room:animation', { roomJid: bareFrom, animation, senderNick: getResource(from ?? '') ?? '' })
        } else {
          this.deps.emitSDK('chat:animation', { conversationId: bareFrom, animation, senderJid: bareFrom })
        }
```

- [ ] **Step 5: Populate the fields at the send emit site**

In the same file, the send echo (~1536-1541). The sender is us; the hook skips own sends, so identity is cosmetic — use our own bare JID / empty nick:

```typescript
    // SDK event only - binding calls store.triggerAnimation
    if (type === 'groupchat') {
      this.deps.emitSDK('room:animation', { roomJid: to, animation, senderNick: '' })
    } else {
      this.deps.emitSDK('chat:animation', { conversationId: to, animation, senderJid: getBareJid(this.deps.getCurrentJid() ?? '') })
    }
```

- [ ] **Step 6: Build the SDK and run the test**

Run: `npm run build:sdk && cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.test.ts -t animation`
Expected: PASS.

- [ ] **Step 7: Reflect the new fields in any app emit-site tests / mock if referenced**

Run: `cd apps/fluux && npx vitest run 2>&1 | grep -i animation || echo "no app refs"`
If an app test constructs these payloads, add the new field. Otherwise no change.

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/types/sdk-events.ts packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.test.ts
git commit -m "feat(sdk): add sender identity to animation events"
```

---

## Task 2: Extract shared `MentionChip`

**Files:**
- Create: `apps/fluux/src/components/conversation/MentionChip.tsx`
- Modify: `apps/fluux/src/components/conversation/ReactionMentions.tsx`
- Test: `apps/fluux/src/components/conversation/MentionChip.test.tsx`

**Interfaces:**
- Produces: `MentionChip({ label, actionLabel, onAction, onDismiss, icon? }: { label: string; actionLabel: string; onAction: () => void; onDismiss: () => void; icon?: ReactNode })`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/MentionChip.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MentionChip } from './MentionChip'

describe('MentionChip', () => {
  it('renders label + action and fires callbacks', () => {
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    render(<MentionChip label="Ava sent fireworks" actionLabel="Replay" onAction={onAction} onDismiss={onDismiss} />)
    expect(screen.getByText('Ava sent fireworks')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Replay'))
    expect(onAction).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('common.dismiss'))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MentionChip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `MentionChip`**

Create `apps/fluux/src/components/conversation/MentionChip.tsx`:

```tsx
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

interface MentionChipProps {
  label: string
  actionLabel: string
  onAction: () => void
  onDismiss: () => void
  icon?: ReactNode
}

/** Shared pill used above the composer for transient conversation notices (reaction mentions, easter eggs). */
export function MentionChip({ label, actionLabel, onAction, onDismiss, icon }: MentionChipProps) {
  const { t } = useTranslation()
  return (
    <div className="mx-auto max-w-md flex items-center justify-center gap-2 text-xs text-fluux-muted bg-fluux-hover/60 rounded-full px-3 py-1">
      {icon}
      <span className="truncate">{label}</span>
      <button onClick={onAction} className="font-medium text-fluux-brand hover:underline flex-shrink-0">
        {actionLabel}
      </button>
      <button onClick={onDismiss} aria-label={t('common.dismiss')} className="text-fluux-muted hover:text-fluux-text flex-shrink-0">
        <X className="size-3" />
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Refactor `ReactionMentions` to use `MentionChip`**

Replace the body of `apps/fluux/src/components/conversation/ReactionMentions.tsx` render map:

```tsx
import { useTranslation } from 'react-i18next'
import { useReactionMentionStore } from '@/stores/reactionMentionStore'
import { MentionChip } from './MentionChip'

interface ReactionMentionsProps {
  conversationId: string
  onSee: (messageId: string) => void
}

export function ReactionMentions({ conversationId, onSee }: ReactionMentionsProps) {
  const { t } = useTranslation()
  const mentions = useReactionMentionStore((s) => s.mentions.get(conversationId))
  const dismissMention = useReactionMentionStore((s) => s.dismissMention)

  if (!mentions || mentions.length === 0) return null

  return (
    <div className="px-3 pb-1 space-y-1">
      {mentions.map((m) => (
        <MentionChip
          key={m.id}
          label={t('reactions.mention', { name: m.reactorName, emoji: m.emoji, preview: m.preview })}
          actionLabel={t('reactions.see')}
          onAction={() => onSee(m.messageId)}
          onDismiss={() => dismissMention(conversationId, m.id)}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Run tests**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MentionChip.test.tsx src/components/conversation/ReactionMentions.test.tsx`
Expected: PASS (both the new chip test and the existing reaction-mention tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/conversation/MentionChip.tsx apps/fluux/src/components/conversation/MentionChip.test.tsx apps/fluux/src/components/conversation/ReactionMentions.tsx
git commit -m "refactor(conversation): extract shared MentionChip from ReactionMentions"
```

---

## Task 3: `easterEggMentionStore`

**Files:**
- Create: `apps/fluux/src/stores/easterEggMentionStore.ts`
- Test: `apps/fluux/src/stores/easterEggMentionStore.test.ts`

**Interfaces:**
- Produces: `PendingEasterEgg { id: string; conversationId: string; animation: string; senderName: string }`; store `useEasterEggMentionStore` with `mentions: Map<string, PendingEasterEgg>`, `add(egg)` (latest-wins per conversation), `dismiss(conversationId)`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/stores/easterEggMentionStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useEasterEggMentionStore } from './easterEggMentionStore'

const egg = (conversationId: string, animation: string, senderName = 'ava') => ({
  id: conversationId, conversationId, animation, senderName,
})

describe('easterEggMentionStore', () => {
  beforeEach(() => useEasterEggMentionStore.setState({ mentions: new Map() }))

  it('adds a pending egg', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.animation).toBe('fireworks')
  })

  it('latest egg wins per conversation', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    useEasterEggMentionStore.getState().add(egg('a@x', 'christmas'))
    expect(useEasterEggMentionStore.getState().mentions.size).toBe(1)
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.animation).toBe('christmas')
  })

  it('dismiss removes the conversation entry', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    useEasterEggMentionStore.getState().dismiss('a@x')
    expect(useEasterEggMentionStore.getState().mentions.has('a@x')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/stores/easterEggMentionStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the store**

Create `apps/fluux/src/stores/easterEggMentionStore.ts`:

```typescript
import { create } from 'zustand'

export interface PendingEasterEgg {
  id: string
  conversationId: string
  animation: string
  senderName: string
}

interface EasterEggMentionState {
  mentions: Map<string, PendingEasterEgg>
  add: (egg: PendingEasterEgg) => void
  dismiss: (conversationId: string) => void
}

export const useEasterEggMentionStore = create<EasterEggMentionState>((set) => ({
  mentions: new Map(),
  // Latest egg wins: one pending egg per conversation.
  add: (egg) => set((s) => {
    const next = new Map(s.mentions)
    next.set(egg.conversationId, egg)
    return { mentions: next }
  }),
  dismiss: (conversationId) => set((s) => {
    if (!s.mentions.has(conversationId)) return s
    const next = new Map(s.mentions)
    next.delete(conversationId)
    return { mentions: next }
  }),
}))

export const easterEggMentionStore = useEasterEggMentionStore
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/stores/easterEggMentionStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/stores/easterEggMentionStore.ts apps/fluux/src/stores/easterEggMentionStore.test.ts
git commit -m "feat(stores): add transient easter-egg mention store"
```

---

## Task 4: Pure `decideEasterEggNotification`

**Files:**
- Create: `apps/fluux/src/hooks/easterEggNotificationDecision.ts`
- Test: `apps/fluux/src/hooks/easterEggNotificationDecision.test.ts`

**Interfaces:**
- Produces: `EasterEggContext { isOwn: boolean; isActive: boolean }`; `EasterEggDecision = { kind: 'none' } | { kind: 'notify' }`; `decideEasterEggNotification(ctx: EasterEggContext): EasterEggDecision`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/easterEggNotificationDecision.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { decideEasterEggNotification } from './easterEggNotificationDecision'

describe('decideEasterEggNotification', () => {
  it('ignores our own egg', () => {
    expect(decideEasterEggNotification({ isOwn: true, isActive: false })).toEqual({ kind: 'none' })
  })
  it('ignores an egg for the active conversation (the binding plays it)', () => {
    expect(decideEasterEggNotification({ isOwn: false, isActive: true })).toEqual({ kind: 'none' })
  })
  it('notifies for an egg from someone else in an inactive conversation', () => {
    expect(decideEasterEggNotification({ isOwn: false, isActive: false })).toEqual({ kind: 'notify' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/easterEggNotificationDecision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the decision function**

Create `apps/fluux/src/hooks/easterEggNotificationDecision.ts`:

```typescript
export interface EasterEggContext {
  isOwn: boolean
  isActive: boolean
}

export type EasterEggDecision = { kind: 'none' } | { kind: 'notify' }

/**
 * Pure decision for a received easter egg.
 * - none    if it is our own send (already played on send)
 * - none    if the conversation is active (the store binding plays it there)
 * - notify  otherwise — toast + store a pending egg for on-open replay
 */
export function decideEasterEggNotification(ctx: EasterEggContext): EasterEggDecision {
  if (ctx.isOwn) return { kind: 'none' }
  if (ctx.isActive) return { kind: 'none' }
  return { kind: 'notify' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/easterEggNotificationDecision.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/easterEggNotificationDecision.ts apps/fluux/src/hooks/easterEggNotificationDecision.test.ts
git commit -m "feat(hooks): add pure easter-egg notification decision"
```

---

## Task 5: Binding guard — play only for the active conversation

**Files:**
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts` (`chat:animation` ~220, `room:animation` ~409)
- Test: `packages/fluux-sdk/src/bindings/storeBindings.test.ts` (create if absent; otherwise add cases)

**Interfaces:**
- Consumes: `chat:animation` / `room:animation` events (Task 1); store state `activeConversationId` / `activeRoomJid` and method `triggerAnimation`.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/bindings/storeBindings.test.ts` (mirror existing binding tests in that file — they wire `emitSDK` through a mock store set; reuse that harness). Assert:

```typescript
it('plays a chat animation only when the conversation is active', () => {
  stores.chat.activeConversationId = 'ava@x'
  emit('chat:animation', { conversationId: 'ava@x', animation: 'fireworks', senderJid: 'ava@x' })
  expect(stores.chat.triggerAnimation).toHaveBeenCalledWith('ava@x', 'fireworks')

  stores.chat.triggerAnimation.mockClear()
  stores.chat.activeConversationId = 'other@x'
  emit('chat:animation', { conversationId: 'ava@x', animation: 'fireworks', senderJid: 'ava@x' })
  expect(stores.chat.triggerAnimation).not.toHaveBeenCalled()
})
```

If `storeBindings.test.ts` does not exist, instead add an equivalent assertion in the existing binding test setup used elsewhere, or create the file following the pattern in `packages/fluux-sdk/src/bindings/` (a mock `getStores()` returning spy-backed `chat`/`room` objects and a local `emit` that invokes the registered `on` handler).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/bindings/storeBindings.test.ts -t animation`
Expected: FAIL — currently `triggerAnimation` is called unconditionally.

- [ ] **Step 3: Guard both handlers**

In `packages/fluux-sdk/src/bindings/storeBindings.ts`:

```typescript
  on('chat:animation', ({ conversationId, animation }) => {
    const stores = getStores()
    // Only auto-play in the active conversation; inactive eggs are surfaced by
    // useEasterEggNotifications (toast + pending-egg store) and played on open.
    if (stores.chat.activeConversationId === conversationId) {
      stores.chat.triggerAnimation(conversationId, animation)
    }
  })
```

```typescript
  on('room:animation', ({ roomJid, animation }) => {
    const stores = getStores()
    if (stores.room.activeRoomJid === roomJid) {
      stores.room.triggerAnimation(roomJid, animation)
    }
  })
```

- [ ] **Step 4: Build SDK and run tests**

Run: `npm run build:sdk && cd packages/fluux-sdk && npx vitest run src/bindings/storeBindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/bindings/storeBindings.ts packages/fluux-sdk/src/bindings/storeBindings.test.ts
git commit -m "feat(sdk): play received animation only for the active conversation"
```

---

## Task 6: `useEasterEggNotifications` hook + mount

**Files:**
- Create: `apps/fluux/src/hooks/useEasterEggNotifications.ts`
- Modify: `apps/fluux/src/components/ChatLayout.tsx` (add call next to `useReactionNotifications()` ~99)
- Test: `apps/fluux/src/hooks/useEasterEggNotifications.test.tsx`

**Interfaces:**
- Consumes: `chat:animation` / `room:animation` (Task 1), `decideEasterEggNotification` (Task 4), `useEasterEggMentionStore.add` (Task 3), `useNavigateToTarget`, `useToastStore.addToast`, `t('easterEgg.mention')`.
- Produces: `useEasterEggNotifications(): void`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/useEasterEggNotifications.test.tsx`. Mirror `useReactionNotifications.test.tsx` (mock `useXMPP` to expose a controllable `subscribe`, mock `useNavigateToTarget`). Core assertions:

```tsx
// After firing a chat:animation for an INACTIVE conversation from another user:
//  - useToastStore.addToast called once with an 'info' toast
//  - useEasterEggMentionStore has a pending egg for that conversation
// After firing for the ACTIVE conversation, or for our own senderJid:
//  - no toast, no pending egg
```

Use `chatStore.setState({ activeConversationId: 'other@x' })` to make the target inactive, and `connectionStore.setState({ jid: 'me@x/res' })` so the own-check has a self JID. Assert `useEasterEggMentionStore.getState().mentions.get('ava@x')?.animation === 'fireworks'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useEasterEggNotifications.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the hook**

Create `apps/fluux/src/hooks/useEasterEggNotifications.ts`:

```typescript
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP } from '@fluux/sdk'
import { chatStore, roomStore, connectionStore, getBareJid, getLocalPart } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'
import { useEasterEggMentionStore } from '@/stores/easterEggMentionStore'
import { useNavigateToTarget } from './useNavigateToTarget'
import { decideEasterEggNotification } from './easterEggNotificationDecision'

/**
 * Surfaces easter eggs received while their conversation is inactive:
 * a clickable toast (navigate + play on open) plus a transient pending-egg
 * marker that drives the Replay chip. Active-conversation and own-send eggs
 * are handled by the store binding (immediate play), so this hook ignores them.
 *
 * Call once in ChatLayout alongside useReactionNotifications.
 */
export function useEasterEggNotifications(): void {
  const { client } = useXMPP()
  const { t } = useTranslation()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()

  useEffect(() => {
    if (!client?.subscribe) return

    const unsubChat = client.subscribe('chat:animation', ({ conversationId, animation, senderJid }) => {
      const myJid = getBareJid(connectionStore.getState().jid ?? '')
      const isOwn = getBareJid(senderJid) === myJid
      const isActive = chatStore.getState().activeConversationId === conversationId
      if (decideEasterEggNotification({ isOwn, isActive }).kind !== 'notify') return

      const senderName = getLocalPart(senderJid)
      useToastStore.getState().addToast('info', t('easterEgg.mention', { name: senderName }), 6000, () => {
        navigateToConversation(conversationId)
      })
      useEasterEggMentionStore.getState().add({ id: conversationId, conversationId, animation, senderName })
    })

    const unsubRoom = client.subscribe('room:animation', ({ roomJid, animation, senderNick }) => {
      const room = roomStore.getState().rooms.get(roomJid)
      if (!room) return
      const isOwn = senderNick === room.nickname
      const isActive = roomStore.getState().activeRoomJid === roomJid
      if (decideEasterEggNotification({ isOwn, isActive }).kind !== 'notify') return

      useToastStore.getState().addToast('info', t('easterEgg.mention', { name: senderNick }), 6000, () => {
        navigateToRoom(roomJid)
      })
      useEasterEggMentionStore.getState().add({ id: roomJid, conversationId: roomJid, animation, senderName: senderNick })
    })

    return () => {
      unsubChat()
      unsubRoom()
    }
  }, [client, t, navigateToConversation, navigateToRoom])
}
```

- [ ] **Step 4: Mount the hook in ChatLayout**

In `apps/fluux/src/components/ChatLayout.tsx`, add the import and call next to `useReactionNotifications()` (~99):

```typescript
import { useEasterEggNotifications } from '@/hooks/useEasterEggNotifications'
```
```typescript
  useReactionNotifications()
  useEasterEggNotifications()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useEasterEggNotifications.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useEasterEggNotifications.ts apps/fluux/src/hooks/useEasterEggNotifications.test.tsx apps/fluux/src/components/ChatLayout.tsx
git commit -m "feat(hooks): surface inactive-conversation easter eggs via toast + pending store"
```

---

## Task 7: `EasterEggMentions` chip + view mounts

**Files:**
- Create: `apps/fluux/src/components/conversation/EasterEggMentions.tsx`
- Modify: `apps/fluux/src/components/ChatView.tsx` (~526, near `<ReactionMentions .../>`)
- Modify: `apps/fluux/src/components/RoomView.tsx` (~607, near `<ReactionMentions .../>`)
- Test: `apps/fluux/src/components/conversation/EasterEggMentions.test.tsx`

**Interfaces:**
- Consumes: `useEasterEggMentionStore` (Task 3), `MentionChip` (Task 2).
- Produces: `EasterEggMentions({ conversationId, onReplay }: { conversationId: string; onReplay: (animation: string) => void })`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/EasterEggMentions.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EasterEggMentions } from './EasterEggMentions'
import { useEasterEggMentionStore } from '@/stores/easterEggMentionStore'

describe('EasterEggMentions', () => {
  beforeEach(() => useEasterEggMentionStore.setState({ mentions: new Map() }))

  it('renders nothing without a pending egg', () => {
    const { container } = render(<EasterEggMentions conversationId="a@x" onReplay={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('replays and dismisses a pending egg', () => {
    useEasterEggMentionStore.getState().add({ id: 'a@x', conversationId: 'a@x', animation: 'fireworks', senderName: 'ava' })
    const onReplay = vi.fn()
    render(<EasterEggMentions conversationId="a@x" onReplay={onReplay} />)
    fireEvent.click(screen.getByText('easterEgg.replay'))
    expect(onReplay).toHaveBeenCalledWith('fireworks')
    fireEvent.click(screen.getByLabelText('common.dismiss'))
    expect(useEasterEggMentionStore.getState().mentions.has('a@x')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/EasterEggMentions.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the chip**

Create `apps/fluux/src/components/conversation/EasterEggMentions.tsx`:

```tsx
import { useTranslation } from 'react-i18next'
import { useEasterEggMentionStore } from '@/stores/easterEggMentionStore'
import { MentionChip } from './MentionChip'

interface EasterEggMentionsProps {
  conversationId: string
  /** Replay the stored animation in the active view (chat or room triggerAnimation). */
  onReplay: (animation: string) => void
}

export function EasterEggMentions({ conversationId, onReplay }: EasterEggMentionsProps) {
  const { t } = useTranslation()
  const egg = useEasterEggMentionStore((s) => s.mentions.get(conversationId))
  const dismiss = useEasterEggMentionStore((s) => s.dismiss)

  if (!egg) return null

  return (
    <div className="px-3 pb-1">
      <MentionChip
        label={t('easterEgg.mention', { name: egg.senderName })}
        actionLabel={t('easterEgg.replay')}
        onAction={() => onReplay(egg.animation)}
        onDismiss={() => dismiss(conversationId)}
      />
    </div>
  )
}
```

- [ ] **Step 4: Mount in ChatView**

In `apps/fluux/src/components/ChatView.tsx`, add the import and render the chip directly after the existing `<ReactionMentions .../>` (~526):

```tsx
import { EasterEggMentions } from './conversation/EasterEggMentions'
```
```tsx
      <ReactionMentions conversationId={activeConversation.id} onSee={(id) => chatStore.getState().setTargetMessageId(id)} />
      <EasterEggMentions conversationId={activeConversation.id} onReplay={(animation) => chatStore.getState().triggerAnimation(activeConversation.id, animation)} />
```

- [ ] **Step 5: Mount in RoomView**

In `apps/fluux/src/components/RoomView.tsx`, add the import and render directly after the existing `<ReactionMentions .../>` (~607):

```tsx
import { EasterEggMentions } from './conversation/EasterEggMentions'
```
```tsx
        <ReactionMentions conversationId={activeRoom.jid} onSee={(id) => roomStore.getState().setTargetMessageId(id)} />
        <EasterEggMentions conversationId={activeRoom.jid} onReplay={(animation) => roomStore.getState().triggerAnimation(activeRoom.jid, animation)} />
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/conversation/EasterEggMentions.test.tsx && cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/bastille-animation-trigger-0df9e1 && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/conversation/EasterEggMentions.tsx apps/fluux/src/components/conversation/EasterEggMentions.test.tsx apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/RoomView.tsx
git commit -m "feat(conversation): add replayable easter-egg chip above the composer"
```

---

## Task 8: On-open auto-play

**Files:**
- Modify: `apps/fluux/src/components/ChatView.tsx` (activation effect area ~217-224)
- Modify: `apps/fluux/src/components/RoomView.tsx` (activation effect area ~387)

**Interfaces:**
- Consumes: `useEasterEggMentionStore` (Task 3), `chatStore.triggerAnimation` / `roomStore.triggerAnimation`.

- [ ] **Step 1: Add the auto-play effect in ChatView**

In `apps/fluux/src/components/ChatView.tsx`, add the import and a new effect keyed on the active conversation id. Place it after the existing conversation-change effect (~224):

```tsx
import { easterEggMentionStore } from '@/stores/easterEggMentionStore'
```
```tsx
  // Auto-play a pending easter egg once when its conversation opens. The chip
  // stays (via EasterEggMentions) as a Replay control until dismissed.
  useEffect(() => {
    const id = activeConversation?.id
    if (!id) return
    const egg = easterEggMentionStore.getState().mentions.get(id)
    if (egg) chatStore.getState().triggerAnimation(id, egg.animation)
  }, [activeConversation?.id])
```

- [ ] **Step 2: Add the auto-play effect in RoomView**

In `apps/fluux/src/components/RoomView.tsx`, add the import and the analogous effect keyed on `activeRoom?.jid`:

```tsx
import { easterEggMentionStore } from '@/stores/easterEggMentionStore'
```
```tsx
  useEffect(() => {
    const jid = activeRoom?.jid
    if (!jid) return
    const egg = easterEggMentionStore.getState().mentions.get(jid)
    if (egg) roomStore.getState().triggerAnimation(jid, egg.animation)
  }, [activeRoom?.jid])
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification in demo mode**

The animation is a 6s full-screen overlay and the effect uses rAF-adjacent timers, so unit tests can't observe playback (headless freezes transitions/rAF). Verify in the browser preview instead:
1. `preview_start` the dev server; open `http://localhost:5173/demo.html?virt=1` (clear `xmpp-chat-storage` first — see demo verification notes).
2. With conversation B focused, inject/trigger an egg for conversation A (demo JIDs are short, e.g. `ava@fluux.chat`).
3. Confirm: a toast appears; clicking it navigates to A and the fireworks play; the Replay chip is shown above the composer; Replay re-triggers; dismiss removes the chip.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/RoomView.tsx
git commit -m "feat(conversation): auto-play pending easter egg on conversation open"
```

---

## Task 9: i18n keys across all 33 locales

**Files:**
- Modify: all 33 files in `apps/fluux/src/i18n/locales/*.json`
- Modify: `apps/fluux/src/test-setup.ts` (add asserted keys to the i18n subset)

**Interfaces:**
- Consumes: nothing. Produces the `easterEgg.mention`, `easterEgg.replay`, and `common.dismiss` translations used by Tasks 2/6/7.

- [ ] **Step 1: Add English keys**

In `apps/fluux/src/i18n/locales/en.json`, add an `easterEgg` block and a `common.dismiss` key (parse → mutate → `JSON.stringify(obj, null, 4) + "\n"`):

```json
"easterEgg": {
    "mention": "{{name}} sent you an animation",
    "replay": "Replay"
}
```
and within the existing `common` object:
```json
"dismiss": "Dismiss"
```

Note: copy is animation-agnostic (the chip only knows the wire `animation` name). No em-dash connectors.

- [ ] **Step 2: Translate into the other 32 locales**

For each other locale file, add the same three keys with a correct translation for that language (Claude authors these). Use the surgical parse/mutate/stringify approach; do not reformat unrelated keys.

- [ ] **Step 3: Add asserted keys to the test i18n subset**

In `apps/fluux/src/test-setup.ts`, add `easterEgg.mention`, `easterEgg.replay`, and `common.dismiss` to the i18n resource subset so component tests that assert these labels resolve them (the tests above assert the raw key strings, e.g. `easterEgg.replay`; if `test-setup.ts` maps them to English, update those assertions to the English text instead — pick one and keep it consistent).

- [ ] **Step 4: Validate JSON + run the full app suite**

Run: `cd apps/fluux && node -e "require('fs').readdirSync('src/i18n/locales').forEach(f=>JSON.parse(require('fs').readFileSync('src/i18n/locales/'+f)))" && npx vitest run`
Expected: all locale files parse; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales apps/fluux/src/test-setup.ts
git commit -m "i18n(easter-eggs): add mention/replay/dismiss keys across all locales"
```

---

## Task 10: Full verification & cleanup

**Files:** none (verification only)

- [ ] **Step 1: Full test + typecheck + lint**

Run: `npm test && npm run typecheck && npm run lint` (from the worktree root)
Expected: all green, no stderr.

- [ ] **Step 2: End-to-end demo check (per Task 8, Step 4)**

Re-run the browser verification for both a 1:1 conversation and a room, confirming toast → navigate → play → Replay → dismiss, and that an egg received while the conversation IS active still plays immediately with no chip.

- [ ] **Step 3: Regression check on existing playback**

Confirm sending `/bastille` from the active conversation still plays immediately (send echo via the guarded binding), and that switching between conversations no longer replays a stale animation.

---

## Self-Review Notes (addressed)

- **Spec coverage:** SDK enrichment (§1→T1), store (§2→T3), shared widget (§3→T2/T7), hook + toast/discovery (§4→T6), binding guard + on-open + replay (§5→T5/T7/T8), i18n (§6→T9), tests (§7→T1-T7,T9). All spec sections mapped.
- **Type consistency:** `triggerAnimation(id, animation)` signature reused everywhere; store method names `add`/`dismiss`; `PendingEasterEgg` fields `{ id, conversationId, animation, senderName }` used identically in T3/T6/T7/T8; event fields `senderJid`/`senderNick` consistent T1→T5/T6.
- **Latent gap noted:** `common.dismiss` was previously unresolved in `ReactionMentions` (returned the raw key); T9 adds it properly, improving the existing reaction chip too.
