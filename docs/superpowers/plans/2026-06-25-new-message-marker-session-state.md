# New-Message Marker as Session State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lastSeenMessageId` the single durable, MDS-synced read position, move the new-message divider (`firstNewMessageId`) into a session-only per-store map, and fix the bug where opening a conversation restores the divider to a stale position when the XEP-0490 read marker resolved late.

**Architecture:** The pure `notificationState` module stays the divider-derivation engine and is not modified. Each store stops storing `firstNewMessageId` inside its metadata map and instead parks it in a new session-only `firstNewMessageMarkers: Map<jid, messageId>` that is never persisted. `activateConversation` / `activateRoom` resolve a pending MDS marker (via the existing `applyRemoteDisplayed`) before `onActivate` derives the divider, so the divider reflects the synced read position.

**Tech Stack:** TypeScript, Zustand vanilla stores (`subscribeWithSelector`; chat also wraps `persist`), Vitest, React hooks.

## Global Constraints

- Reference spec: `docs/superpowers/specs/2026-06-25-new-message-marker-session-state-design.md`.
- `notificationState.ts` (`packages/fluux-sdk/src/stores/shared/notificationState.ts`) MUST NOT change. It remains the derivation engine; `EntityNotificationState` keeps `firstNewMessageId` as its computed currency.
- `lastSeenMessageId` stays in `conversationMeta` / `roomMeta` and stays persisted for chat. Do NOT touch its persistence or the MDS publisher (`mdsSideEffects.ts`).
- New session field name: `firstNewMessageMarkers` (Map<string, string>, jid to messageId). Never add it to any serialize / partialize output.
- SDK store unit tests run from `packages/fluux-sdk`: `npx vitest run <path>`.
- After changing SDK types, rebuild the SDK before app typecheck: `npm run build:sdk`.
- Final gate before any "done" claim: `npm run typecheck` and `npm test` pass with no errors or stderr (per `.claude/CLAUDE.md`).
- No em-dashes or en-dashes in any user-facing string (none are added here, but keep code comments plain too).
- Commit after each task. Never include any Claude footer in commit messages.

---

## File Structure

SDK (source):
- `packages/fluux-sdk/src/core/types/chat.ts` — remove `firstNewMessageId` from `ConversationMetadata`.
- `packages/fluux-sdk/src/core/types/room.ts` — remove `firstNewMessageId` from `RoomMetadata`.
- `packages/fluux-sdk/src/stores/chatStore.ts` — add `firstNewMessageMarkers`; activation fix; route writes; drop the legacy deserialize line.
- `packages/fluux-sdk/src/stores/roomStore.ts` — add `firstNewMessageMarkers`; activation fix; route writes; drop `firstNewMessageId` from `updateRoom` routing.
- `packages/fluux-sdk/src/stores/chatSelectors.ts` — `firstNewMessageIdFor` reads the map.
- `packages/fluux-sdk/src/stores/roomSelectors.ts` — `firstNewMessageIdFor` reads the map.
- `packages/fluux-sdk/src/hooks/useChatActive.ts` — source the active marker from the map; expose it as a standalone field.
- `packages/fluux-sdk/src/hooks/useRoomActive.ts` — source the active marker from the map; expose it as a standalone field.

SDK (tests):
- `packages/fluux-sdk/src/stores/chatStore.mds.test.ts` — add activation-fix test + de-persistence test.
- `packages/fluux-sdk/src/stores/roomStore.mds.test.ts` — add activation-fix test.

App:
- `apps/fluux/src/components/ChatView.tsx` — read `firstNewMessageId` from the hook, not from `activeConversation`.
- `apps/fluux/src/components/RoomView.tsx` — read `firstNewMessageId` from the hook, not from `activeRoom`.

Untouched on purpose: `notificationState.ts`, `mdsSideEffects.ts`, `serializeState`/`partialize` (the divider de-persists automatically once it leaves the metadata type).

---

## Task 1: Chat restore-bug fix (resolve pending MDS marker at activation)

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (the `activateConversation` action, ~604-612)
- Test: `packages/fluux-sdk/src/stores/chatStore.mds.test.ts`

**Interfaces:**
- Consumes: existing `applyRemoteDisplayed(conversationId, stanzaId, messagesOverride?)`, `loadMessagesFromCache`, `setActiveConversation`.
- Produces: no signature change to `activateConversation: (id: string | null) => Promise<void>`; behavior change only.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/stores/chatStore.mds.test.ts`. First add the selector import at the top of the file (after the existing imports on lines 10-12):

```typescript
import { chatSelectors } from './chatSelectors'
```

Then append this `describe` block at the end of the file:

```typescript
describe('chatStore.activateConversation — XEP-0490 divider sync', () => {
  beforeEach(() => chatStore.getState().reset())

  it('folds a pending remote read marker into lastSeenMessageId before deriving the divider', async () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]
    seedMessages(cid, messages)

    // Local read is stale at m2; a remote device read up to s4, seeded as pending
    // before the messages were loaded (the fresh-session MDS seed ordering).
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm2', pendingRemoteDisplayedStanzaId: 's4' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId: 'm2', pendingRemoteDisplayedStanzaId: 's4' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)

    // The pending marker is resolved at activation, advancing the read position.
    expect(chatStore.getState().conversationMeta.get(cid)?.lastSeenMessageId).toBe('m4')
    // So the divider reflects the synced read (m4 is the last message → nothing new),
    // NOT the stale 'm3' it would show if the marker resolved after onActivate.
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.mds.test.ts -t "folds a pending remote read marker"`
Expected: FAIL. `lastSeenMessageId` is `'m2'` (pending not resolved at activation) and the divider is `'m3'`.

- [ ] **Step 3: Implement the fix**

In `packages/fluux-sdk/src/stores/chatStore.ts`, replace the `activateConversation` action (currently ~604-612):

```typescript
      activateConversation: async (id) => {
        const token = ++activationToken
        if (id) {
          await get().loadMessagesFromCache(id, { limit: 100 })
          // A newer activation started while the cache read was in flight
          if (token !== activationToken) return
        }
        get().setActiveConversation(id)
      },
```

with:

```typescript
      activateConversation: async (id) => {
        const token = ++activationToken
        if (id) {
          await get().loadMessagesFromCache(id, { limit: 100 })
          // A newer activation started while the cache read was in flight
          if (token !== activationToken) return
          // XEP-0490: fold any pending remote read position into lastSeenMessageId
          // BEFORE setActiveConversation derives the new-message divider. The fresh
          // session MDS seed runs before messages load, so the marker is stashed as
          // pendingRemoteDisplayedStanzaId; resolve it now (forward-only, against the
          // just-loaded messages) so the divider reflects reads synced from other
          // devices instead of the stale local position.
          const pending = get().conversationMeta.get(id)?.pendingRemoteDisplayedStanzaId
          if (pending) get().applyRemoteDisplayed(id, pending)
        }
        get().setActiveConversation(id)
      },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.mds.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.mds.test.ts
git commit -m "fix(mds): resolve pending read marker at chat activation so the new-message divider lands at the synced position"
```

---

## Task 2: Room restore-bug fix (resolve pending MDS marker at activation)

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (the `activateRoom` action, ~1445-1455)
- Test: `packages/fluux-sdk/src/stores/roomStore.mds.test.ts`

**Interfaces:**
- Consumes: existing `applyRemoteDisplayed(roomJid, stanzaId, messagesOverride?)`, `loadMessagesFromCache`, `setActiveRoom`.
- Produces: no signature change to `activateRoom: (roomJid: string | null) => Promise<void>`; behavior change only.

- [ ] **Step 1: Write the failing test**

Add the selector import near the top of `packages/fluux-sdk/src/stores/roomStore.mds.test.ts` (after line 5):

```typescript
import { roomSelectors } from './roomSelectors'
```

Append this `describe` block at the end of the file:

```typescript
describe('roomStore.activateRoom — XEP-0490 divider sync', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    vi.clearAllMocks()
  })

  it('folds a pending remote room marker into lastSeenMessageId before deriving the divider', async () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m4', 's4', 4)], 'm2')
    // A remote device read up to s4, seeded as pending before messages loaded.
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      const existing = m.get(ROOM)!
      m.set(ROOM, { ...existing, pendingRemoteDisplayedStanzaId: 's4' })
      return { roomMeta: m }
    })

    await roomStore.getState().activateRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m4')
    expect(roomSelectors.firstNewMessageIdFor(ROOM)(roomStore.getState())).toBeUndefined()
  })
})
```

Note: this test's `beforeEach` already includes `firstNewMessageMarkers: new Map()`, which the store gains in Task 4. Until Task 4 lands it is an inert extra key on the partial `setState` (zustand shallow-merges), so it is harmless now and correct later.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts -t "folds a pending remote room marker"`
Expected: FAIL. `lastSeenMessageId` is `'m2'` and the divider is `'m3'`.

- [ ] **Step 3: Implement the fix**

In `packages/fluux-sdk/src/stores/roomStore.ts`, replace the `activateRoom` action (currently ~1445-1455):

```typescript
  activateRoom: async (roomJid) => {
    const token = ++activationToken
    if (roomJid) {
      await get().loadMessagesFromCache(roomJid, { limit: 100 })
      // A newer activation started while the cache read was in flight
      if (token !== activationToken) return
    }
    get().setActiveRoom(roomJid)
  },
```

with:

```typescript
  activateRoom: async (roomJid) => {
    const token = ++activationToken
    if (roomJid) {
      await get().loadMessagesFromCache(roomJid, { limit: 100 })
      // A newer activation started while the cache read was in flight
      if (token !== activationToken) return
      // XEP-0490: fold any pending remote read position into lastSeenMessageId
      // BEFORE setActiveRoom derives the new-message divider (parity with
      // chatStore.activateConversation). Forward-only against the loaded messages.
      const pending = get().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId
      if (pending) get().applyRemoteDisplayed(roomJid, pending)
    }
    get().setActiveRoom(roomJid)
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.mds.test.ts
git commit -m "fix(mds): resolve pending read marker at room activation so the new-message divider lands at the synced position"
```

---

## Task 3: Chat divider into a session-only map (de-persist + decouple)

This task removes `firstNewMessageId` from `ConversationMetadata`, adds the session map, routes all writes, and rewires the selector / hook / view. The TypeScript compiler is the checklist: once the field leaves the type, every remaining write or read is a compile error to fix.

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/chat.ts:112`
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (state interface ~97-119; `createEmptyChatState` ~389-404; `addConversation` ~628; `setActiveConversation` ~547/551/579/583/593; `addMessage` ~776/787; `markAsRead` ~846; `clearFirstNewMessageId` ~860-885; `deserializeState` ~342)
- Modify: `packages/fluux-sdk/src/stores/chatSelectors.ts:231`
- Modify: `packages/fluux-sdk/src/hooks/useChatActive.ts`
- Modify: `apps/fluux/src/components/ChatView.tsx:475`
- Test: `packages/fluux-sdk/src/stores/chatStore.mds.test.ts`

**Interfaces:**
- Produces: `ChatState.firstNewMessageMarkers: Map<string, string>` (session-only); `chatSelectors.firstNewMessageIdFor(id)` now reads it; `useChatActive()` returns a top-level `firstNewMessageId?: string` for the active conversation.
- Consumes: `notifState.onActivate/onDeactivate/onClearMarker/onMessageReceived` return values (unchanged).

- [ ] **Step 1: Write the failing tests (map home + de-persistence)**

Append to `packages/fluux-sdk/src/stores/chatStore.mds.test.ts`:

```typescript
describe('chatStore — new-message divider is session-only', () => {
  beforeEach(() => chatStore.getState().reset())

  it('parks the divider in firstNewMessageMarkers, not in conversationMeta', () => {
    const cid = 'juliet@capulet.example'
    // m1 outgoing-read baseline, then two incoming unread messages.
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 2, lastSeenMessageId: 'm1' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 2, lastSeenMessageId: 'm1' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().setActiveConversation(cid)

    // Divider derived at m2 (first unread after m1) and stored in the session map.
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toBe('m2')
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m2')
    // The metadata entry carries NO divider field.
    expect('firstNewMessageId' in (chatStore.getState().conversationMeta.get(cid) as object)).toBe(false)
  })

  it('never writes the divider to persisted storage', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 1, lastSeenMessageId: 'm1' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 1, lastSeenMessageId: 'm1' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
    chatStore.getState().setActiveConversation(cid)
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toBe('m2')

    // Whatever the persist middleware wrote must not mention the divider.
    const dump = JSON.stringify(localStorage)
    expect(dump.includes('firstNewMessageId')).toBe(false)
    expect(dump.includes('firstNewMessageMarkers')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.mds.test.ts -t "session-only"`
Expected: FAIL — `firstNewMessageMarkers` does not exist yet (`undefined.get` throws), and `firstNewMessageId` is still in meta and persisted.

- [ ] **Step 3: Remove the field from the metadata type**

In `packages/fluux-sdk/src/core/types/chat.ts`, delete these two lines from `ConversationMetadata` (currently ~111-112):

```typescript
  /** ID of the first unread message (calculated when switching to conversation) */
  firstNewMessageId?: string
```

(`Conversation extends ConversationEntity, ConversationMetadata` therefore also loses the field. That is intended.)

- [ ] **Step 4: Add the session map to the store state and initial state**

In `packages/fluux-sdk/src/stores/chatStore.ts`, add to the `ChatState` interface after the `targetMessageId: string | null` data field (~119):

```typescript
  // Session-only new-message divider per conversation (jid -> messageId). Derived
  // at activation from lastSeenMessageId; never persisted (absent from serializeState).
  firstNewMessageMarkers: Map<string, string>
```

In `createEmptyChatState`, add `firstNewMessageMarkers` to BOTH the `Pick<...>` return type and the returned object. The return type union must include it:

```typescript
function createEmptyChatState(): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'archivedConversations' | 'typingStates' | 'activeAnimation' | 'drafts' | 'mamQueryStates' | 'conversationGaps' | 'targetMessageId' | 'firstNewMessageMarkers'> {
  return {
    conversationEntities: new Map(),
    conversationMeta: new Map(),
    conversations: new Map(),
    messages: new Map(),
    activeConversationId: null,
    archivedConversations: new Set(),
    typingStates: new Map(),
    activeAnimation: null,
    drafts: new Map(),
    mamQueryStates: new Map(),
    conversationGaps: new Map(),
    targetMessageId: null,
    firstNewMessageMarkers: new Map(),
  }
}
```

Note: `reset()` calls `createEmptyChatState()`, so the map is cleared on logout automatically. `deserializeState` does not return `firstNewMessageMarkers`, so after a rehydrate it falls back to the store's default empty map — correct (no divider until activation).

- [ ] **Step 5: Route the `setActiveConversation` writes to the map**

In `setActiveConversation`, the deactivate-previous branch currently writes the cleared marker into meta and conversations (~547, ~551). Replace the `set((state) => { ... })` body of that branch so it removes the previous conversation's map entry instead. Replace lines ~540-554:

```typescript
          set((state) => {
            const newMessages = new Map(state.messages)
            newMessages.delete(prevId)
            if (!hadMarker) {
              return { messages: newMessages }
            }
            const newMeta = new Map(state.conversationMeta)
            if (prevMeta) newMeta.set(prevId, { ...prevMeta, firstNewMessageId: clearedFirstNewMessageId })
            const newConversations = new Map(state.conversations)
            const prevConv = newConversations.get(prevId)
            if (prevConv) {
              newConversations.set(prevId, { ...prevConv, firstNewMessageId: clearedFirstNewMessageId })
            }
            return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations }
          })
```

with (note `clearedFirstNewMessageId` from `onDeactivate` is always `undefined`, so we just delete the entry):

```typescript
          set((state) => {
            const newMessages = new Map(state.messages)
            newMessages.delete(prevId)
            if (!hadMarker) {
              return { messages: newMessages }
            }
            const newMarkers = new Map(state.firstNewMessageMarkers)
            newMarkers.delete(prevId)
            return { messages: newMessages, firstNewMessageMarkers: newMarkers }
          })
```

In the same action, the activate branch builds `newMetaEntry` (with `firstNewMessageId: activated.firstNewMessageId`, ~583) and a combined-map entry (~593). Replace lines ~577-596:

```typescript
            set((state) => {
              const newMetaEntry = {
                ...(meta ?? { unreadCount: 0, lastReadAt: undefined, lastSeenMessageId: undefined, firstNewMessageId: undefined }),
                unreadCount: activated.unreadCount,
                lastReadAt: activated.lastReadAt,
                lastSeenMessageId: activated.lastSeenMessageId,
                firstNewMessageId: activated.firstNewMessageId,
              }
              const newMeta = new Map(state.conversationMeta)
              newMeta.set(id, newMetaEntry)
              const newConversations = new Map(state.conversations)
              newConversations.set(id, {
                ...conv,
                unreadCount: activated.unreadCount,
                lastReadAt: activated.lastReadAt,
                lastSeenMessageId: activated.lastSeenMessageId,
                firstNewMessageId: activated.firstNewMessageId,
              })
              return { conversationMeta: newMeta, conversations: newConversations, activeConversationId: id }
            })
```

with:

```typescript
            set((state) => {
              const newMetaEntry = {
                ...(meta ?? { unreadCount: 0, lastReadAt: undefined, lastSeenMessageId: undefined }),
                unreadCount: activated.unreadCount,
                lastReadAt: activated.lastReadAt,
                lastSeenMessageId: activated.lastSeenMessageId,
              }
              const newMeta = new Map(state.conversationMeta)
              newMeta.set(id, newMetaEntry)
              const newConversations = new Map(state.conversations)
              newConversations.set(id, {
                ...conv,
                unreadCount: activated.unreadCount,
                lastReadAt: activated.lastReadAt,
                lastSeenMessageId: activated.lastSeenMessageId,
              })
              const newMarkers = new Map(state.firstNewMessageMarkers)
              if (activated.firstNewMessageId) newMarkers.set(id, activated.firstNewMessageId)
              else newMarkers.delete(id)
              return { conversationMeta: newMeta, conversations: newConversations, activeConversationId: id, firstNewMessageMarkers: newMarkers }
            })
```

- [ ] **Step 6: Route the `addMessage` write to the map**

In `addMessage`, remove `firstNewMessageId` from the meta entry (~776) and the combined entry (~787), and update the map from `notif.firstNewMessageId`. The two `set` objects must drop the `firstNewMessageId:` line; then change the three `return` statements in this block to also carry the markers map. Replace the block from `// Update metadata map` (~768) through the final `return` (~803):

```typescript
            // Update metadata map
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(msg.conversationId, {
              ...meta,
              unreadCount: notif.unreadCount,
              lastReadAt: notif.lastReadAt,
              lastMessage: previewMessage,
              lastSeenMessageId: notif.lastSeenMessageId,
              firstNewMessageId: notif.firstNewMessageId,
            })

            // Update combined map for backward compatibility
            const newConversations = new Map(state.conversations)
            newConversations.set(msg.conversationId, {
              ...conv,
              unreadCount: notif.unreadCount,
              lastReadAt: notif.lastReadAt,
              lastMessage: previewMessage,
              lastSeenMessageId: notif.lastSeenMessageId,
              firstNewMessageId: notif.firstNewMessageId,
            })

            // Auto-unarchive conversation when new incoming message arrives
            // (outgoing messages should not trigger unarchive)
            if (!msg.isOutgoing) {
              const newArchived = new Set(state.archivedConversations)
              if (newArchived.has(msg.conversationId)) {
                newArchived.delete(msg.conversationId)
                return {
                  messages: newMessages,
                  conversationMeta: newMeta,
                  conversations: newConversations,
                  archivedConversations: newArchived,
                }
              }
            }

            return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations }
```

with:

```typescript
            // Update metadata map
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(msg.conversationId, {
              ...meta,
              unreadCount: notif.unreadCount,
              lastReadAt: notif.lastReadAt,
              lastMessage: previewMessage,
              lastSeenMessageId: notif.lastSeenMessageId,
            })

            // Update combined map for backward compatibility
            const newConversations = new Map(state.conversations)
            newConversations.set(msg.conversationId, {
              ...conv,
              unreadCount: notif.unreadCount,
              lastReadAt: notif.lastReadAt,
              lastMessage: previewMessage,
              lastSeenMessageId: notif.lastSeenMessageId,
            })

            // Session-only divider: onMessageReceived only sets it for the active,
            // window-hidden case; otherwise it is preserved. Mirror that into the map.
            const newMarkers = new Map(state.firstNewMessageMarkers)
            if (notif.firstNewMessageId) newMarkers.set(msg.conversationId, notif.firstNewMessageId)
            else newMarkers.delete(msg.conversationId)

            // Auto-unarchive conversation when new incoming message arrives
            // (outgoing messages should not trigger unarchive)
            if (!msg.isOutgoing) {
              const newArchived = new Set(state.archivedConversations)
              if (newArchived.has(msg.conversationId)) {
                newArchived.delete(msg.conversationId)
                return {
                  messages: newMessages,
                  conversationMeta: newMeta,
                  conversations: newConversations,
                  archivedConversations: newArchived,
                  firstNewMessageMarkers: newMarkers,
                }
              }
            }

            return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations, firstNewMessageMarkers: newMarkers }
```

- [ ] **Step 7: Drop the divider from the `markAsRead` fallback and `addConversation`**

In `markAsRead`, the inline default object (~846) lists `firstNewMessageId: undefined`. Change:

```typescript
          const newMetaEntry = {
            ...(meta ?? { unreadCount: 0, lastReadAt: undefined, lastSeenMessageId: undefined, firstNewMessageId: undefined }),
            unreadCount: updated.unreadCount,
            lastReadAt: updated.lastReadAt,
          }
```

to:

```typescript
          const newMetaEntry = {
            ...(meta ?? { unreadCount: 0, lastReadAt: undefined, lastSeenMessageId: undefined }),
            unreadCount: updated.unreadCount,
            lastReadAt: updated.lastReadAt,
          }
```

In `addConversation` (~622-629), remove the `firstNewMessageId` line from the `meta` object:

```typescript
          const meta: ConversationMetadata = {
            unreadCount: conv.unreadCount,
            lastMessage: conv.lastMessage,
            lastReadAt: conv.lastReadAt,
            lastSeenMessageId: conv.lastSeenMessageId,
            firstNewMessageId: conv.firstNewMessageId,
          }
```

to:

```typescript
          const meta: ConversationMetadata = {
            unreadCount: conv.unreadCount,
            lastMessage: conv.lastMessage,
            lastReadAt: conv.lastReadAt,
            lastSeenMessageId: conv.lastSeenMessageId,
          }
```

- [ ] **Step 8: Rewrite `clearFirstNewMessageId` to clear the map**

Replace the whole `clearFirstNewMessageId` action (~860-885) with a version that operates on the map:

```typescript
      clearFirstNewMessageId: (conversationId) => {
        set((state) => {
          if (!state.firstNewMessageMarkers.has(conversationId)) return state
          const newMarkers = new Map(state.firstNewMessageMarkers)
          newMarkers.delete(conversationId)
          return { firstNewMessageMarkers: newMarkers }
        })
      },
```

(`notifState.onClearMarker` is no longer needed here; its only job was to null the field. If `onClearMarker` is now unused across the codebase, leave it — it is covered by `notificationState.test.ts` and removing it is out of scope.)

- [ ] **Step 9: Drop the legacy deserialize line**

In `deserializeState`, the legacy-format branch builds a `conversationMeta` entry (~337-343) that sets `firstNewMessageId: conv.firstNewMessageId`. Remove that one line:

```typescript
      conversationMeta.set(id, {
        unreadCount: conv.unreadCount,
        lastMessage: conv.lastMessage,
        lastReadAt: conv.lastReadAt,
        lastSeenMessageId: conv.lastSeenMessageId,
        firstNewMessageId: conv.firstNewMessageId,
      })
```

becomes:

```typescript
      conversationMeta.set(id, {
        unreadCount: conv.unreadCount,
        lastMessage: conv.lastMessage,
        lastReadAt: conv.lastReadAt,
        lastSeenMessageId: conv.lastSeenMessageId,
      })
```

(The new-format branch spreads `...meta`; any stale `firstNewMessageId` in old persisted data is carried at runtime but is not in the type and is never read — harmless. `serializeState` writes whatever is in `conversationMeta`, which no longer contains the divider, so it de-persists automatically.)

- [ ] **Step 10: Repoint the selector to the map**

In `packages/fluux-sdk/src/stores/chatSelectors.ts`, change `firstNewMessageIdFor` (~231):

```typescript
  firstNewMessageIdFor: (conversationId: string) => (state: ChatState): string | undefined => {
    return state.conversations.get(conversationId)?.firstNewMessageId
  },
```

to:

```typescript
  firstNewMessageIdFor: (conversationId: string) => (state: ChatState): string | undefined => {
    return state.firstNewMessageMarkers.get(conversationId)
  },
```

- [ ] **Step 11: Source the active marker from the map in `useChatActive` and expose it**

In `packages/fluux-sdk/src/hooks/useChatActive.ts`, change the `activeFirstNewMessageId` selector to read the map:

```typescript
  const activeFirstNewMessageId = useChatStore((s) => {
    if (!s.activeConversationId) return undefined
    return s.conversationMeta.get(s.activeConversationId)?.firstNewMessageId
  })
```

to:

```typescript
  const activeFirstNewMessageId = useChatStore((s) => {
    if (!s.activeConversationId) return undefined
    return s.firstNewMessageMarkers.get(s.activeConversationId)
  })
```

In the `activeConversation` `useMemo`, remove the now-invalid `firstNewMessageId` property from the reconstructed object:

```typescript
    return {
      id: activeConversationId,
      name: activeConvName,
      type: activeConvType,
      firstNewMessageId: activeFirstNewMessageId,
      // Not used by active view components — sidebar uses useChat() for these
      unreadCount: 0,
      lastMessage: undefined,
      lastReadAt: undefined,
      lastSeenMessageId: undefined,
    }
```

to:

```typescript
    return {
      id: activeConversationId,
      name: activeConvName,
      type: activeConvType,
      // Not used by active view components — sidebar uses useChat() for these
      unreadCount: 0,
      lastMessage: undefined,
      lastReadAt: undefined,
      lastSeenMessageId: undefined,
    }
```

In the final return `useMemo` object, add `firstNewMessageId: activeFirstNewMessageId` as a top-level field and add `activeFirstNewMessageId` to its dependency array. Change:

```typescript
  return useMemo(
    () => ({
      activeConversationId,
      activeConversation,
      activeMessages,
      activeTypingUsers,
      activeAnimation,
      targetMessageId,
      supportsMAM,
      activeMAMState,
      ...actions,
    }),
    [
      activeConversationId, activeConversation, activeMessages,
      activeTypingUsers, activeAnimation, targetMessageId, supportsMAM, activeMAMState,
      actions,
    ]
  )
```

to:

```typescript
  return useMemo(
    () => ({
      activeConversationId,
      activeConversation,
      firstNewMessageId: activeFirstNewMessageId,
      activeMessages,
      activeTypingUsers,
      activeAnimation,
      targetMessageId,
      supportsMAM,
      activeMAMState,
      ...actions,
    }),
    [
      activeConversationId, activeConversation, activeFirstNewMessageId, activeMessages,
      activeTypingUsers, activeAnimation, targetMessageId, supportsMAM, activeMAMState,
      actions,
    ]
  )
```

- [ ] **Step 12: Read the divider from the hook in `ChatView`**

In `apps/fluux/src/components/ChatView.tsx`, find where `useChatActive()` is destructured (it currently pulls `activeConversation`) and add `firstNewMessageId` to that destructure. Then change line ~475:

```tsx
            firstNewMessageId={activeConversation.firstNewMessageId}
```

to:

```tsx
            firstNewMessageId={firstNewMessageId}
```

(The downstream `ChatViewInner` prop named `firstNewMessageId` at ~567 and its use at ~689 are unchanged — only the source of the value at the `useChatActive` call site changes.)

- [ ] **Step 13: Rebuild SDK and run typecheck + tests**

```bash
npm run build:sdk
npm run typecheck
```
Expected: PASS (no references to `conversationMeta.firstNewMessageId` or `Conversation.firstNewMessageId` remain).

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore.mds.test.ts src/stores/chatStore.test.ts src/stores/chatSelectors.test.ts src/hooks/useChat.test.tsx
```
Expected: PASS, including the Task 1 activation test and the Task 3 session-only tests. If `chatStore.test.ts` or `chatSelectors.test.ts` assert `meta.firstNewMessageId`, update those assertions to read via `firstNewMessageMarkers` / `firstNewMessageIdFor` (same behavior, new home).

- [ ] **Step 14: Commit**

```bash
git add packages/fluux-sdk/src/core/types/chat.ts packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.mds.test.ts packages/fluux-sdk/src/stores/chatSelectors.ts packages/fluux-sdk/src/hooks/useChatActive.ts apps/fluux/src/components/ChatView.tsx
git commit -m "refactor(chat): move new-message divider to a session-only map; de-persist it"
```

---

## Task 4: Room divider into a session-only map (decouple, symmetric with chat)

Same shape as Task 3 for rooms. Rooms were never persisted, so there is no de-persist step; this is the architectural symmetry. The compiler is again the checklist.

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/room.ts:251`
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (state interface ~307-334; `createEmptyRoomState` ~471-493; `addRoom` ~533; `updateRoom` metaFields ~582 and write ~633; `addMessage` ~1098/1118; `setActiveRoom` ~1380/1386/1421/1433; `clearFirstNewMessageId` ~1457-1483)
- Modify: `packages/fluux-sdk/src/stores/roomSelectors.ts:327`
- Modify: `packages/fluux-sdk/src/hooks/useRoomActive.ts`
- Modify: `apps/fluux/src/components/RoomView.tsx:541`
- Test: `packages/fluux-sdk/src/stores/roomStore.mds.test.ts`

**Interfaces:**
- Produces: `RoomState.firstNewMessageMarkers: Map<string, string>`; `roomSelectors.firstNewMessageIdFor(jid)` reads it; `useRoomActive()` returns a top-level `firstNewMessageId?: string` for the active room.

- [ ] **Step 1: Write the failing test (map home)**

Append to `packages/fluux-sdk/src/stores/roomStore.mds.test.ts`:

```typescript
describe('roomStore — new-message divider is session-only', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    vi.clearAllMocks()
  })

  it('parks the divider in firstNewMessageMarkers, not in roomMeta', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      const existing = m.get(ROOM)!
      m.set(ROOM, { ...existing, unreadCount: 2 })
      return { roomMeta: m }
    })

    roomStore.getState().setActiveRoom(ROOM)

    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('m2')
    expect(roomSelectors.firstNewMessageIdFor(ROOM)(roomStore.getState())).toBe('m2')
    expect('firstNewMessageId' in (roomStore.getState().roomMeta.get(ROOM) as object)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts -t "session-only"`
Expected: FAIL — `firstNewMessageMarkers` is undefined.

- [ ] **Step 3: Remove the field from `RoomMetadata`**

In `packages/fluux-sdk/src/core/types/room.ts`, delete these two lines from `RoomMetadata` (~250-251):

```typescript
  /** ID of the first unread message (calculated when switching to room) */
  firstNewMessageId?: string
```

(`Room extends RoomEntity, RoomMetadata, RoomRuntime` loses the field too. Intended.)

- [ ] **Step 4: Add the session map to `RoomState` and `createEmptyRoomState`**

In `packages/fluux-sdk/src/stores/roomStore.ts`, add to the `RoomState` interface after `targetMessageId: string | null` (~334):

```typescript
  // Session-only new-message divider per room (jid -> messageId). Derived at
  // activation from lastSeenMessageId; never persisted.
  firstNewMessageMarkers: Map<string, string>
```

In `createEmptyRoomState`, add `'firstNewMessageMarkers'` to the `Pick<...>` return type union and `firstNewMessageMarkers: new Map(),` to the returned object (mirroring Task 3 Step 4).

- [ ] **Step 5: Remove the divider from `addRoom` and `updateRoom`**

In `addRoom` (~533), remove `firstNewMessageId: room.firstNewMessageId` from the `meta` object it builds.

In `updateRoom`, remove `'firstNewMessageId'` from the `metaFields` array (~582):

```typescript
      const metaFields = ['unreadCount', 'mentionsCount', 'typingUsers', 'notifyAll',
        'notifyAllPersistent', 'lastReadAt', 'firstNewMessageId', 'lastInteractedAt'] as const
```

becomes:

```typescript
      const metaFields = ['unreadCount', 'mentionsCount', 'typingUsers', 'notifyAll',
        'notifyAllPersistent', 'lastReadAt', 'lastInteractedAt'] as const
```

and remove `firstNewMessageId: updatedRoom.firstNewMessageId,` from the `newMeta.set(roomJid, { ... })` object inside the `if (hasMetaUpdate)` block (~633).

- [ ] **Step 6: Route the `addMessage` write to the map**

In `addMessage`, remove `firstNewMessageId: updated.firstNewMessageId,` from BOTH the combined `newRooms.set(...)` object (~1098) and the `newMeta.set(...)` object (~1118). Then update the map and add it to the return. Change the tail of the action:

```typescript
      // Update metadata
      const newMeta = new Map(state.roomMeta)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          unreadCount: updated.unreadCount,
          mentionsCount: updated.mentionsCount,
          lastReadAt: updated.lastReadAt,
          firstNewMessageId: updated.firstNewMessageId,
          lastMessage,
          lastInteractedAt: newLastInteractedAt,
        })
      }

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta }
```

to:

```typescript
      // Update metadata
      const newMeta = new Map(state.roomMeta)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          unreadCount: updated.unreadCount,
          mentionsCount: updated.mentionsCount,
          lastReadAt: updated.lastReadAt,
          lastMessage,
          lastInteractedAt: newLastInteractedAt,
        })
      }

      // Session-only divider (parity with chatStore.addMessage).
      const newMarkers = new Map(state.firstNewMessageMarkers)
      if (updated.firstNewMessageId) newMarkers.set(roomJid, updated.firstNewMessageId)
      else newMarkers.delete(roomJid)

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta, firstNewMessageMarkers: newMarkers }
```

(Also remove the `firstNewMessageId: updated.firstNewMessageId,` line from the earlier `newRooms.set(roomJid, { ...existing, ... })` at ~1098.)

- [ ] **Step 7: Route the `setActiveRoom` writes to the map**

In `setActiveRoom`, the deactivate-previous branch writes the cleared marker to the combined room (~1380) and meta (~1386). Replace its `set((state) => { ... })`:

```typescript
      set((state) => {
        // Evict from the runtime mirror (messages live here).
        const newRuntime = new Map(state.roomRuntime)
        const prevRuntime = newRuntime.get(prevJid)
        if (prevRuntime && prevRuntime.messages.length > 0) {
          newRuntime.set(prevJid, { ...prevRuntime, messages: [] })
        }

        // Evict from the combined map mirror; carry the (possibly cleared) marker.
        const newRooms = new Map(state.rooms)
        const prevRoom = newRooms.get(prevJid)
        if (prevRoom) {
          const updatedPrevRoom = { ...prevRoom, messages: [] }
          if (hadMarker) updatedPrevRoom.firstNewMessageId = clearedFirstNewMessageId
          newRooms.set(prevJid, updatedPrevRoom)
        }

        const newMeta = new Map(state.roomMeta)
        if (prevMeta && hadMarker) {
          newMeta.set(prevJid, { ...prevMeta, firstNewMessageId: clearedFirstNewMessageId })
        }

        return { roomRuntime: newRuntime, rooms: newRooms, roomMeta: newMeta }
      })
```

with (`clearedFirstNewMessageId` is always `undefined`, so just delete the entry):

```typescript
      set((state) => {
        // Evict from the runtime mirror (messages live here).
        const newRuntime = new Map(state.roomRuntime)
        const prevRuntime = newRuntime.get(prevJid)
        if (prevRuntime && prevRuntime.messages.length > 0) {
          newRuntime.set(prevJid, { ...prevRuntime, messages: [] })
        }

        // Evict from the combined map mirror.
        const newRooms = new Map(state.rooms)
        const prevRoom = newRooms.get(prevJid)
        if (prevRoom) {
          newRooms.set(prevJid, { ...prevRoom, messages: [] })
        }

        const newMarkers = new Map(state.firstNewMessageMarkers)
        if (hadMarker) newMarkers.delete(prevJid)

        return { roomRuntime: newRuntime, rooms: newRooms, firstNewMessageMarkers: newMarkers }
      })
```

In the activate branch, remove `firstNewMessageId: activated.firstNewMessageId,` from `newMetaEntry` (~1421) and from the `newRooms.set(roomJid, { ...room, ... })` object (~1433), then carry the map. Replace the `set((state) => { ... })`:

```typescript
        set((state) => {
          const newMetaEntry = {
            ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            lastReadAt: activated.lastReadAt,
            lastSeenMessageId: activated.lastSeenMessageId,
            firstNewMessageId: activated.firstNewMessageId,
            lastInteractedAt: newLastInteractedAt,
          }
          const newMeta = new Map(state.roomMeta)
          newMeta.set(roomJid, newMetaEntry)
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, {
            ...room,
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            lastReadAt: activated.lastReadAt,
            lastSeenMessageId: activated.lastSeenMessageId,
            firstNewMessageId: activated.firstNewMessageId,
            lastInteractedAt: newLastInteractedAt,
          })
          return { roomMeta: newMeta, rooms: newRooms, activeRoomJid: roomJid }
        })
```

with:

```typescript
        set((state) => {
          const newMetaEntry = {
            ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            lastReadAt: activated.lastReadAt,
            lastSeenMessageId: activated.lastSeenMessageId,
            lastInteractedAt: newLastInteractedAt,
          }
          const newMeta = new Map(state.roomMeta)
          newMeta.set(roomJid, newMetaEntry)
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, {
            ...room,
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            lastReadAt: activated.lastReadAt,
            lastSeenMessageId: activated.lastSeenMessageId,
            lastInteractedAt: newLastInteractedAt,
          })
          const newMarkers = new Map(state.firstNewMessageMarkers)
          if (activated.firstNewMessageId) newMarkers.set(roomJid, activated.firstNewMessageId)
          else newMarkers.delete(roomJid)
          return { roomMeta: newMeta, rooms: newRooms, activeRoomJid: roomJid, firstNewMessageMarkers: newMarkers }
        })
```

- [ ] **Step 8: Rewrite `clearFirstNewMessageId` to clear the map**

Replace the whole room `clearFirstNewMessageId` action (~1457-1483) with:

```typescript
  clearFirstNewMessageId: (roomJid) => {
    set((state) => {
      if (!state.firstNewMessageMarkers.has(roomJid)) return state
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.delete(roomJid)
      return { firstNewMessageMarkers: newMarkers }
    })
  },
```

- [ ] **Step 9: Repoint the room selector**

In `packages/fluux-sdk/src/stores/roomSelectors.ts`, change `firstNewMessageIdFor` (~327):

```typescript
  firstNewMessageIdFor: (roomJid: string) => (state: RoomState): string | undefined => {
    return state.rooms.get(roomJid)?.firstNewMessageId
  },
```

to:

```typescript
  firstNewMessageIdFor: (roomJid: string) => (state: RoomState): string | undefined => {
    return state.firstNewMessageMarkers.get(roomJid)
  },
```

- [ ] **Step 10: Source the active marker from the map in `useRoomActive` and expose it**

In `packages/fluux-sdk/src/hooks/useRoomActive.ts`, add a selector that reads the map (next to the existing `activeRoomMeta` selector, ~61):

```typescript
  const activeFirstNewMessageId = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.firstNewMessageMarkers.get(s.activeRoomJid)
  })
```

The `activeRoom` `useMemo` spreads `...activeRoomMeta`, which no longer carries the divider; that is correct. Add `firstNewMessageId: activeFirstNewMessageId` as a top-level field of the hook's return object and include `activeFirstNewMessageId` in that return memo's dependency array (mirror Task 3 Step 11). If `useRoomActive` has no outer return memo, return it as a plain top-level property alongside `activeRoom`.

- [ ] **Step 11: Read the divider from the hook in `RoomView`**

In `apps/fluux/src/components/RoomView.tsx`, add `firstNewMessageId` to the `useRoomActive()` destructure, then change line ~541:

```tsx
            firstNewMessageId={activeRoom.firstNewMessageId}
```

to:

```tsx
            firstNewMessageId={firstNewMessageId}
```

(The inner-component prop `firstNewMessageId` at ~817/860 and its use at ~1071 are unchanged.)

- [ ] **Step 12: Rebuild SDK and run typecheck + tests**

```bash
npm run build:sdk
npm run typecheck
```
Expected: PASS (no `roomMeta.firstNewMessageId` / `Room.firstNewMessageId` references remain).

```bash
cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts src/stores/roomStore.test.ts src/stores/roomStore.mds.test.ts src/stores/roomSelectors.test.ts src/hooks/useRoom.test.tsx
```
Expected: PASS. Update any `roomStore.test.ts` assertions that read `meta.firstNewMessageId` / `room.firstNewMessageId` to read via `firstNewMessageMarkers` / `firstNewMessageIdFor`.

- [ ] **Step 13: Commit**

```bash
git add packages/fluux-sdk/src/core/types/room.ts packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.mds.test.ts packages/fluux-sdk/src/stores/roomSelectors.ts packages/fluux-sdk/src/hooks/useRoomActive.ts apps/fluux/src/components/RoomView.tsx
git commit -m "refactor(room): move new-message divider to a session-only map (symmetry with chat)"
```

---

## Task 5: Full verification and spec commit

**Files:**
- No source changes (verification + docs).

- [ ] **Step 1: Build SDK and typecheck the whole monorepo**

Run: `npm run build:sdk && npm run typecheck`
Expected: PASS with no errors.

- [ ] **Step 2: Run the entire test suite**

Run: `npm test`
Expected: PASS, no errors, no stderr. Pay special attention to: `chatStore.test.ts`, `roomStore.test.ts`, `chatSelectors.test.ts`, `roomSelectors.test.ts`, `notificationState.test.ts` (must be untouched and green), `useChat.test.tsx`, `useRoom.test.tsx`, and any app test that mocks `useChatActive`/`useRoomActive` (ensure the mock exposes the new top-level `firstNewMessageId`).

- [ ] **Step 3: Run the linter**

Run: `npm run lint`
Expected: PASS (no unused-import warnings; if `onClearMarker` import became unused in a store, remove that import).

- [ ] **Step 4: Manual smoke (demo mode), optional but recommended**

Per `.claude/CLAUDE.md`: `npm run dev`, open `http://localhost:5173/demo.html`. Open a conversation/room with unread messages, confirm the "new messages" divider renders and scroll lands on it; switch away and back, confirm the divider recomputes. Reload the page, confirm no stale divider survives before activation.

- [ ] **Step 5: Commit the design spec**

```bash
git add docs/superpowers/specs/2026-06-25-new-message-marker-session-state-design.md docs/superpowers/plans/2026-06-25-new-message-marker-session-state.md
git commit -m "docs: spec + plan for session-only new-message divider (XEP-0490 read-position cleanup)"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Spec 4.1 session map → Task 3 Step 4 (chat), Task 4 Step 4 (room).
- Spec 4.2 type removal → Task 3 Step 3, Task 4 Step 3.
- Spec 4.3 notificationState unchanged → Global Constraints + no task touches it.
- Spec 4.4 store routing → Task 3 Steps 5-9, Task 4 Steps 5-8.
- Spec 4.5 activation bug fix → Task 1, Task 2.
- Spec 4.6 selectors/hooks/views → Task 3 Steps 10-12, Task 4 Steps 9-11.
- Spec 6 frozen-while-active → preserved: `onMessageSeen`/`applyRemoteDisplayed` never write the divider map; only activation and `addMessage`'s active-hidden path do.
- Spec 7 testing → Task 1/2 (activation), Task 3 Step 1 (map home + de-persist), Task 4 Step 1 (map home).
- Spec 8 migration → Task 3 Step 9 (legacy line dropped; new-format spread harmless).

**Placeholder scan:** none — every step has exact code or exact commands.

**Type consistency:** new field `firstNewMessageMarkers: Map<string, string>` used identically in both stores; selector returns `string | undefined`; hooks expose top-level `firstNewMessageId?: string`. `applyRemoteDisplayed`, `loadMessagesFromCache`, `setActiveConversation`/`setActiveRoom` signatures unchanged.
