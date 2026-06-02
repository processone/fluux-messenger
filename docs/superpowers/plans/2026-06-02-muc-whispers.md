# MUC Whispers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add XEP-0045 §7.5 private messages ("whispers") to MUC rooms — inline in the room timeline, ephemeral (never persisted), with occupant-menu and message-nick entry points.

**Architecture:** A dedicated `sendWhisper` on the Chat module builds a `type='chat'` stanza addressed to `room@service/nick` with a `muc#user` marker. A receive-side detection branch (placed *before* the existing `muc#user→groupchat` reclassification) routes incoming `type='chat'` messages from a joined room occupant to a new `processRoomWhisper`, which emits a new `room:whisper` SDK event. Whisper `RoomMessage`s carry `isPrivate`/`whisperWith` flags and `noStore: true`, so the existing IndexedDB persistence layer (already gated on `noStore`) skips them — no new persistence code. The app renders them inline with a "private" badge and adds a sticky composer "whisper mode".

**Tech Stack:** TypeScript, `@xmpp/client` (ltx elements), Zustand stores, React, Vitest, i18next.

**Spec:** [docs/superpowers/specs/2026-06-02-muc-whispers-design.md](../specs/2026-06-02-muc-whispers-design.md)

**Note on persistence:** the spec described "exclude `isPrivate` from persistence"; the actual mechanism is the pre-existing `noStore` message hint (`roomStore.addMessage` at `roomStore.ts:858` skips IndexedDB when `noStore` is set, and MAM persistence filters `!msg.noStore` at `roomStore.ts:1779`). This plan sets `noStore: true` on whispers instead of adding a new filter.

**Discovered during planning — needs a product call (see Task 7):** an item `rooms.sendPrivateMessage` already exists in the nick context menu (`RoomView.tsx:537`) but it calls `onStartChat(bareJid)` — i.e. it opens a *real 1:1 chat* via the occupant's bare JID (only works in non-anonymous rooms; this is the "full private message" the user explicitly did **not** want). This plan **keeps** that item and **adds a distinct "Whisper"** item (works in anonymous rooms too, ephemeral). If the user prefers to replace the old behavior, Task 7 is the only change needed.

---

## File Structure

**SDK (`packages/fluux-sdk/`):**
- `src/core/types/room.ts` — add `isPrivate?`/`whisperWith?` to `RoomMessage`.
- `src/core/types/sdk-events.ts` — add `room:whisper` event.
- `src/core/modules/Chat.ts` — add `sendWhisper`, whisper detection, `processRoomWhisper`.
- `src/core/modules/Chat.whisper.test.ts` — **new** — send + receive whisper tests.
- `src/bindings/storeBindings.ts` — bind `room:whisper` → `roomStore.addMessage`.
- `src/bindings/storeBindings.test.ts` — binding test.
- `src/hooks/useRoomActive.ts` — expose `sendWhisper`.

**App (`apps/fluux/`):**
- `src/components/conversation/MessageBubble.tsx` — `isPrivate`/`whisperWith` props + badge + tint.
- `src/components/RoomView.tsx` — whisper-mode state, nick-menu "Whisper" item, wiring.
- `src/test-setup.ts` (or the shared `@fluux/sdk` mock) — add `sendWhisper` to the `useRoomActive` mock.
- i18n locale files — new keys, all locales.

---

## Task 1: Data model — `RoomMessage` fields + `room:whisper` event

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/room.ts:134` (inside `RoomMessage`)
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts:276` (inside `RoomEvents`, after `room:message`)

- [ ] **Step 1: Add fields to `RoomMessage`**

In `room.ts`, inside `interface RoomMessage`, after the `occupantId?: string` field (line ~134), add:

```ts
  /**
   * XEP-0045 §7.5: true if this is a private message ("whisper") exchanged
   * with a single room occupant rather than a public room message.
   */
  isPrivate?: boolean
  /**
   * Nick of the whisper counterpart: the recipient if outgoing, the sender
   * if incoming. Always identifies the *remote* occupant.
   */
  whisperWith?: string
```

- [ ] **Step 2: Add the `room:whisper` event**

In `sdk-events.ts`, inside `interface RoomEvents`, immediately after the `'room:message'` block (ends line ~276), add:

```ts
  /**
   * Private message ("whisper") received or sent in a room (XEP-0045 §7.5).
   * Separate from `room:message` so bindings can mark it ephemeral and the
   * UI can badge it. The carried message has `isPrivate: true` and
   * `noStore: true`.
   */
  'room:whisper': {
    roomJid: string
    message: RoomMessage
    incrementUnread?: boolean
    incrementMentions?: boolean
  }
```

- [ ] **Step 3: Build the SDK to typecheck**

Run: `npm run build:sdk`
Expected: build succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/fluux-sdk/src/core/types/room.ts packages/fluux-sdk/src/core/types/sdk-events.ts
git commit -m "feat(muc): add whisper fields to RoomMessage and room:whisper event"
```

---

## Task 2: SDK — `sendWhisper` on the Chat module

**Files:**
- Create: `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts`
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (add method after `sendMessage`, ~line 869)

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts`:

```ts
/**
 * MUC Whisper Tests (XEP-0045 §7.5 private messages)
 *
 * Covers sending whispers (sendWhisper) and routing incoming whispers
 * (type='chat' from a joined room occupant) to the room:whisper event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  createMockRoom,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

let mockXmppClientInstance: MockXmppClient

vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))
vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

import { client as xmppClientFactory } from '@xmpp/client'

describe('MUC Whispers', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)
    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function connectClient() {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com', password: 'secret', server: 'example.com', skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.clearAllMocks()
  }

  describe('sendWhisper', () => {
    it('sends a type=chat stanza to room/nick with a muc#user marker', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      await xmppClient.chat.sendWhisper('room@conference.example.com', 'bob', 'psst hello')

      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.name).toBe('message')
      expect(sent.attrs.to).toBe('room@conference.example.com/bob')
      expect(sent.attrs.type).toBe('chat')

      const bodyEl = sent.children.find((c: any) => c.name === 'body')
      expect(bodyEl.children[0]).toBe('psst hello')

      const xEl = sent.children.find((c: any) => c.name === 'x')
      expect(xEl).toBeDefined()
      expect(xEl.attrs.xmlns).toBe('http://jabber.org/protocol/muc#user')

      const originId = sent.children.find((c: any) => c.name === 'origin-id')
      expect(originId).toBeDefined()
    })

    it('emits room:whisper (not chat:message) for the outgoing whisper', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      await xmppClient.chat.sendWhisper('room@conference.example.com', 'bob', 'psst hello')

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isPrivate: true,
          isOutgoing: true,
          whisperWith: 'bob',
          noStore: true,
          body: 'psst hello',
        }),
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts`
Expected: FAIL — `xmppClient.chat.sendWhisper is not a function`.

- [ ] **Step 3: Implement `sendWhisper`**

In `Chat.ts`, immediately after the `sendMessage` method closes (line ~869), add:

```ts
  /**
   * XEP-0045 §7.5: send a private message ("whisper") to a single room
   * occupant. Unlike {@link sendMessage}, this preserves the `/nick`
   * resource (sendMessage strips it for type='chat') and emits `room:whisper`
   * instead of `chat:message` so the message is treated as an ephemeral room
   * private message rather than a 1:1 conversation.
   *
   * @param roomJid bare room JID, e.g. 'room@conference.example.com'
   * @param nick    target occupant's nickname
   * @param body    message text
   * @returns the generated message id
   */
  async sendWhisper(roomJid: string, nick: string, body: string): Promise<string> {
    const id = generateUUID()
    const to = `${roomJid}/${nick}`

    const message = xml('message', { to, type: 'chat', id },
      xml('body', {}, body),
      xml('active', { xmlns: NS_CHATSTATES }),
      xml('x', { xmlns: NS_MUC_USER }),
      createOriginIdElement(id),
    )
    await this.deps.sendStanza(message)

    const ourNick = this.deps.stores?.room.getRoom(roomJid)?.nickname || ''
    const whisper: RoomMessage = {
      type: 'groupchat',
      id,
      originId: id,
      roomJid,
      from: `${roomJid}/${ourNick}`,
      nick: ourNick,
      body,
      timestamp: new Date(),
      isOutgoing: true,
      isPrivate: true,
      whisperWith: nick,
      noStore: true,
    }
    this.deps.emitSDK('room:whisper', {
      roomJid,
      message: whisper,
      incrementUnread: false,
      incrementMentions: false,
    })
    return id
  }
```

(`xml`, `generateUUID`, `createOriginIdElement`, `NS_CHATSTATES`, `NS_MUC_USER`, and the `RoomMessage` type are already imported in this file.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts`
Expected: PASS (2 tests in the `sendWhisper` block).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts
git commit -m "feat(muc): add Chat.sendWhisper for XEP-0045 private messages"
```

---

## Task 3: SDK — receive-side whisper detection + `processRoomWhisper`

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` — `handleMessageInternal` (lines ~206–231) and add `processRoomWhisper` after `processRoomMessage` (~line 1992)
- Modify: `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts` (add a `describe('incoming whispers')` block)

- [ ] **Step 1: Write the failing tests**

Append this block inside the top-level `describe('MUC Whispers', ...)` in `Chat.whisper.test.ts`, after the `sendWhisper` describe:

```ts
  describe('incoming whispers', () => {
    it('routes type=chat from a joined room occupant to room:whisper', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      const stanza = createMockElement('message', {
        from: 'room@conference.example.com/bob',
        to: 'user@example.com',
        type: 'chat',
        id: 'w-1',
      }, [{ name: 'body', text: 'between us' }])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isPrivate: true,
          isOutgoing: false,
          nick: 'bob',
          whisperWith: 'bob',
          noStore: true,
          body: 'between us',
        }),
        incrementUnread: true,
        incrementMentions: true,
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('does NOT reclassify a whisper carrying a muc#user marker as public', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      const stanza = createMockElement('message', {
        from: 'room@conference.example.com/bob',
        to: 'user@example.com',
        type: 'chat',
        id: 'w-2',
      }, [
        { name: 'body', text: 'still private' },
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
    })

    it('still routes type=chat from a non-joined JID to chat:message (no regression)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(undefined)

      const stanza = createMockElement('message', {
        from: 'contact@example.com/phone',
        to: 'user@example.com',
        type: 'chat',
        id: 'c-1',
      }, [{ name: 'body', text: 'hi' }])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts`
Expected: FAIL — the first two tests emit `room:message` or `chat:message` instead of `room:whisper`.

- [ ] **Step 3: Add the detection branch in `handleMessageInternal`**

In `Chat.ts`, the current block (lines ~206–231) reads:

```ts
    const from = stanza.attrs.from
    const to = stanza.attrs.to
    let type = stanza.attrs.type || 'chat'
    const hasMucUserElement = !!stanza.getChild('x', NS_MUC_USER)

    if (type === 'error') {
      this.handleErrorMessage(stanza, from)
      return { handled: true }
    }

    // XEP-0280: Ignore messages with <private/> element
    if (stanza.getChild('private', NS_CARBONS)) {
      return { handled: true }
    }

    if (type === 'chat' && hasMucUserElement) {
      type = 'groupchat'
    }

    const body = stanza.getChildText('body')
    const bareFrom = from ? getBareJid(from) : undefined
    const bareTo = to ? getBareJid(to) : undefined

    if (!bareFrom) {
      return { handled: false }
    }
```

Replace it with (adds `isWhisper` detection, guards the reclassification, and short-circuits after `bareFrom`):

```ts
    const from = stanza.attrs.from
    const to = stanza.attrs.to
    let type = stanza.attrs.type || 'chat'
    const hasMucUserElement = !!stanza.getChild('x', NS_MUC_USER)

    if (type === 'error') {
      this.handleErrorMessage(stanza, from)
      return { handled: true }
    }

    // XEP-0280: Ignore messages with <private/> element
    if (stanza.getChild('private', NS_CARBONS)) {
      return { handled: true }
    }

    // XEP-0045 §7.5: a type='chat' message whose `from` is an occupant of a
    // joined room (room@service/nick) is a private message ("whisper"), not a
    // public room message. Detect it BEFORE the muc#user→groupchat
    // reclassification below, which would otherwise surface it publicly.
    const isWhisper =
      type === 'chat' &&
      !!from && !!getResource(from) &&
      this.deps.stores?.room.getRoom(getBareJid(from))?.joined === true

    if (type === 'chat' && hasMucUserElement && !isWhisper) {
      type = 'groupchat'
    }

    const body = stanza.getChildText('body')
    const bareFrom = from ? getBareJid(from) : undefined
    const bareTo = to ? getBareJid(to) : undefined

    if (!bareFrom) {
      return { handled: false }
    }

    // Whisper short-circuit: handle before the public sub-feature handlers
    // (chat states, reactions, corrections, retractions, moderation), which
    // are out of scope for whispers in v1.
    if (isWhisper) {
      if (body || stanza.getChild('x', NS_OOB)) {
        const whisper = this.processRoomWhisper(stanza, from!, bareFrom, body || '', isCarbonCopy, isSentCarbon)
        if (whisper && !isSentCarbon) {
          this.deps.emit('message', whisper as unknown as Message)
        }
        return { handled: true, message: whisper }
      }
      // Bodyless whisper (e.g. a stray chat-state): claim and drop in v1.
      return { handled: true }
    }
```

- [ ] **Step 4: Add `processRoomWhisper`**

In `Chat.ts`, immediately after the `processRoomMessage` method closes (line ~1992, right before `verifyPollClosed`), add:

```ts
  /**
   * XEP-0045 §7.5: build a RoomMessage for an incoming/sent private message.
   * Mirrors the core of processRoomMessage but marks the message private and
   * ephemeral (noStore), and skips public-only concerns (polls, public
   * mention scanning). Emits `room:whisper`.
   */
  private processRoomWhisper(
    stanza: Element,
    from: string,
    bareFrom: string,
    body: string,
    _isCarbonCopy: boolean,
    isSentCarbon: boolean
  ): RoomMessage | null {
    const roomJid = bareFrom
    const nick = getResource(from) || ''
    const room = this.deps.stores?.room.getRoom(roomJid)
    if (!room) return null

    const isOutgoing = isSentCarbon || (room.nickname.toLowerCase() === nick.toLowerCase())
    const parsed = parseMessageContent({
      messageEl: stanza,
      body,
      preserveFullReplyToJid: true,
      messageContext: 'room',
    })
    const messageId = stanza.attrs.id || generateStableMessageId(from, parsed.timestamp, body)
    const occupantId = stanza.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id

    // whisperWith is always the remote occupant: the sender for incoming, or
    // (rare sent-carbon case) the recipient derived from the `to` resource.
    const whisperWith = isOutgoing ? (getResource(stanza.attrs.to) || nick) : nick

    const message: RoomMessage = {
      type: 'groupchat',
      id: messageId,
      ...(parsed.originId && { originId: parsed.originId }),
      roomJid,
      from,
      nick,
      body: parsed.processedBody,
      timestamp: parsed.timestamp,
      isOutgoing,
      isPrivate: true,
      whisperWith,
      noStore: true,
      ...(parsed.attachment && { attachment: parsed.attachment }),
      ...(occupantId && { occupantId }),
    }

    this.deps.emitSDK('room:whisper', {
      roomJid,
      message,
      incrementUnread: !isOutgoing,
      incrementMentions: !isOutgoing,
    })
    return message
  }
```

(`parseMessageContent`, `generateStableMessageId`, `getResource`, `getBareJid`, `NS_OCCUPANT_ID`, `NS_OOB`, `Element`, `Message`, `RoomMessage` are already imported in this file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Run the routing test suite to confirm no regression**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.routing.test.ts`
Expected: PASS (all existing routing tests still green).

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts
git commit -m "feat(muc): detect and route incoming whispers to room:whisper"
```

---

## Task 4: SDK — bind `room:whisper` to the room store

**Files:**
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts` (after the `room:message` binding, ~line 300)
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.test.ts` (add a test)

- [ ] **Step 1: Write the failing test**

In `storeBindings.test.ts`, find the describe block that tests room bindings (search for `'room:message'`) and add this test inside it. It mirrors the existing room:message binding test style — adapt the harness variable names (`emitEvent`/`mockStores`) to match the ones already used in that file:

```ts
  it('room:whisper adds an ephemeral (noStore) message to the room store', () => {
    emitEvent('room:whisper', {
      roomJid: 'room@conf.example.com',
      message: {
        type: 'groupchat',
        id: 'w-1',
        roomJid: 'room@conf.example.com',
        from: 'room@conf.example.com/bob',
        nick: 'bob',
        body: 'between us',
        timestamp: new Date(),
        isOutgoing: false,
        isPrivate: true,
        whisperWith: 'bob',
        noStore: true,
      },
      incrementUnread: true,
      incrementMentions: true,
    })

    expect(mockStores.room.addMessage).toHaveBeenCalledWith(
      'room@conf.example.com',
      expect.objectContaining({ id: 'w-1', isPrivate: true, noStore: true }),
      expect.objectContaining({ incrementUnread: true, incrementMentions: true }),
    )
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/bindings/storeBindings.test.ts`
Expected: FAIL — `room:whisper` has no binding, so `addMessage` is not called.

- [ ] **Step 3: Add the binding**

In `storeBindings.ts`, directly after the `on('room:message', ...)` block closes (line ~300), add:

```ts
  on('room:whisper', ({ roomJid, message, incrementUnread, incrementMentions }) => {
    const stores = getStores()
    const ignoredUsers = stores.ignore.getIgnoredForRoom(roomJid)
    const nickToJidCache = stores.room.getRoom(roomJid)?.nickToJidCache
    // Suppress notifications for ignored occupants
    const doNotNotify = isMessageFromIgnoredUser(ignoredUsers, message, nickToJidCache)
    // Whisper is already noStore — addMessage appends to runtime only.
    stores.room.addMessage(roomJid, message, {
      incrementUnread: !!incrementUnread && !doNotNotify,
      incrementMentions: !!incrementMentions && !doNotNotify,
    })
  })
```

(`getStores` and `isMessageFromIgnoredUser` are already imported and used by the `room:message` binding above.)

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fluux-sdk && npx vitest run src/bindings/storeBindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/bindings/storeBindings.ts packages/fluux-sdk/src/bindings/storeBindings.test.ts
git commit -m "feat(muc): bind room:whisper to roomStore.addMessage"
```

---

## Task 5: SDK — expose `sendWhisper` from `useRoomActive` + app mock

**Files:**
- Modify: `packages/fluux-sdk/src/hooks/useRoomActive.ts` (add callback after `sendMessage`, ~line 160; add to the hook's return object)
- Modify: `apps/fluux/src/test-setup.ts` (add `sendWhisper` to the `useRoomActive` mock)

- [ ] **Step 1: Add the `sendWhisper` callback**

In `useRoomActive.ts`, directly after the `sendMessage` `useCallback` (closes line ~160), add:

```ts
  const sendWhisper = useCallback(
    async (roomJid: string, nick: string, body: string): Promise<string> => {
      return await client.chat.sendWhisper(roomJid, nick, body)
    },
    [client]
  )
```

- [ ] **Step 2: Add `sendWhisper` to the hook's return object**

Find the hook's final `return { ... }` object (the large object listing `sendMessage`, `sendReaction`, etc.). Add `sendWhisper` next to `sendMessage`:

```ts
    sendMessage,
    sendWhisper,
```

Verify the key is present:
Run: `grep -n "sendWhisper" packages/fluux-sdk/src/hooks/useRoomActive.ts`
Expected: 3 matches (the import-free callback definition, and the return key, plus any reference).

- [ ] **Step 3: Rebuild the SDK**

Run: `npm run build:sdk`
Expected: build succeeds.

- [ ] **Step 4: Add `sendWhisper` to the app's SDK mock**

In `apps/fluux/src/test-setup.ts`, locate the `useRoomActive` mock (search for `sendMessage: vi.fn`). Add to the returned object:

```ts
    sendWhisper: vi.fn().mockResolvedValue('whisper-id'),
```

(If `useRoomActive` is mocked by spreading `importOriginal`, this step may be unnecessary — verify by running the app test suite in Step 5 and only add the line if a `sendWhisper is not a function` error appears.)

- [ ] **Step 5: Run the app test suite (smoke)**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS (no `sendWhisper is not a function` errors).

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/hooks/useRoomActive.ts apps/fluux/src/test-setup.ts
git commit -m "feat(muc): expose sendWhisper via useRoomActive"
```

---

## Task 6: App — private badge + tint in `MessageBubble`

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx` — props (~line 61), destructure (~line 261), content tint (~line 362), badge in nick header (~line 405)

- [ ] **Step 1: Add props to `MessageBubbleProps`**

In `MessageBubble.tsx`, inside `interface MessageBubbleProps`, after `senderOccupantJid?: string` (line ~61), add:

```ts
  /** XEP-0045 §7.5: render this message as a private "whisper". */
  isPrivate?: boolean
  /** Whisper counterpart nick (recipient if outgoing, sender if incoming). */
  whisperWith?: string
```

- [ ] **Step 2: Destructure the new props**

In the component's parameter destructuring (the block starting ~line 234 with `senderName,`), add near `senderOccupantJid,`:

```ts
  isPrivate,
  whisperWith,
```

- [ ] **Step 3: Import the `Lock` icon**

At the top of the file, add `Lock` to the existing `lucide-react` import (find the line importing icons such as `MessageCircle`/`User`). Example:

```ts
import { /* ...existing icons..., */ Lock } from 'lucide-react'
```

- [ ] **Step 4: Tint the content container for private messages**

On the content container `div` (line ~362), append a conditional class. Current:

```tsx
        <div className={`relative flex-1 min-w-0 ${isSelected ? 'bg-fluux-selection -my-0.5 py-0.5 -ms-2 ps-2 -me-4 pe-4 rounded-s' : ''}`}>
```

Change to:

```tsx
        <div className={`relative flex-1 min-w-0 ${isSelected ? 'bg-fluux-selection -my-0.5 py-0.5 -ms-2 ps-2 -me-4 pe-4 rounded-s' : ''} ${isPrivate ? 'border-s-2 border-fluux-accent ps-2 -ms-2' : ''}`}>
```

- [ ] **Step 5: Add the badge in the nick header**

In the nick header row, after the timestamp `<span>` (line ~405, closing `</span>` of the time), add:

```tsx
            {isPrivate && (
              <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-fluux-accent/15 text-fluux-accent font-medium">
                <Lock className="size-3" />
                {message.isOutgoing
                  ? t('rooms.whisperTo', { nick: whisperWith })
                  : t('rooms.whisperFrom', { nick: whisperWith })}
              </span>
            )}
```

(`t` is already in scope — it is used at line ~407 for the security tooltip.)

- [ ] **Step 6: Update the memo comparator**

In `arePropsEqual` (line ~131), add an early-out so badge changes re-render. After the `prev.message.body !== next.message.body` check (~line 134), add:

```ts
  if (prev.isPrivate !== next.isPrivate) return false
  if (prev.whisperWith !== next.whisperWith) return false
```

- [ ] **Step 7: Typecheck**

Run: `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` (or `npm run typecheck` from repo root)
Expected: no errors (the i18n keys `rooms.whisperTo`/`rooms.whisperFrom` are added in Task 9; typecheck does not validate translation existence).

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageBubble.tsx
git commit -m "feat(muc): render private badge and tint for whispers in MessageBubble"
```

---

## Task 7: App — whisper-mode state, nick-menu item, and wiring in `RoomView`

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx` — state (~line 176), `sendWhisper` from hook (~line 73), nick-menu item (~line 543), props passed to `RoomMessageInput` (~line 449), pass `isPrivate`/`whisperWith` to `MessageBubble` (~line 1250), clear on room change

> **Product decision (see plan header):** this task ADDS a distinct "Whisper" menu item and KEEPS the existing `rooms.sendPrivateMessage` (real 1:1) item. To instead REPLACE the old behavior, skip Step 3's new item and change line ~539 `onClick={() => { onStartChat(bareJid); ... }}` to `onClick={() => { setWhisperTarget(nickMenuTarget); ... }}`.

- [ ] **Step 1: Destructure `sendWhisper` from the hook**

On the `useRoomActive()` destructuring (line ~73), add `sendWhisper` to the list (next to `sendMessage`):

```ts
  const { activeRoom, activeMessages, /* ... */ sendMessage, sendWhisper, /* ... */ } = useRoomActive()
```

- [ ] **Step 2: Add whisper-target state**

Near the existing nick-menu state (line ~176, after `const [nickMenuTarget, setNickMenuTarget] = useState<string | null>(null)`), add:

```ts
  const [whisperTarget, setWhisperTarget] = useState<string | null>(null)
```

And clear it when the active room changes — add after the state (or near other `useEffect`s):

```ts
  useEffect(() => {
    setWhisperTarget(null)
  }, [activeRoom?.jid])
```

- [ ] **Step 3: Add the "Whisper" item to the nick context menu**

In the nick menu (line ~537), directly after the existing `{bareJid && onStartChat && ( <MenuButton ... rooms.sendPrivateMessage ... /> )}` block, add a whisper item that is NOT gated on `bareJid` (works in anonymous rooms) and hidden for our own nick:

```tsx
            {nickMenuTarget !== activeRoom.nickname && (
              <MenuButton
                onClick={() => { setWhisperTarget(nickMenuTarget); nickMenu.close() }}
                icon={<Lock className="size-4" />}
                label={t('rooms.whisper')}
              />
            )}
```

Add `Lock` to the existing `lucide-react` import at the top of `RoomView.tsx` (the line importing `MessageCircle`, `EyeOff`, `User`, `Settings`).

- [ ] **Step 4: Pass whisper props to `RoomMessageInput`**

At the `<RoomMessageInput ... />` render site (line ~449), add these props:

```tsx
            whisperTarget={whisperTarget}
            onClearWhisper={() => setWhisperTarget(null)}
            sendWhisper={sendWhisper}
```

- [ ] **Step 5: Pass `isPrivate`/`whisperWith` to `MessageBubble`**

Find where the per-room message component renders `<MessageBubble ... />` (the component around line ~981–1260 that wires `onNickContextMenu` at ~1250). Add:

```tsx
        isPrivate={message.isPrivate}
        whisperWith={message.whisperWith}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: errors only about the not-yet-added `RoomMessageInputProps` fields (`whisperTarget`, `onClearWhisper`, `sendWhisper`) — these are added in Task 8. If you are doing Tasks 7 and 8 together, expect no errors after Task 8.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx
git commit -m "feat(muc): add whisper menu item and whisper-mode state to RoomView"
```

---

## Task 8: App — composer whisper mode in `RoomMessageInput`

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx` — `RoomMessageInputProps` (~line 1366), params (~line 1394), `handleSend` (~line 1533), the component's returned JSX (the `<MessageComposer .../>` at ~line 1790+)

- [ ] **Step 1: Extend `RoomMessageInputProps`**

In `interface RoomMessageInputProps` (line ~1366), after the `sendMessage` signature (line ~1369), add:

```ts
  whisperTarget?: string | null
  onClearWhisper?: () => void
  sendWhisper: (roomJid: string, nick: string, body: string) => Promise<string>
```

- [ ] **Step 2: Destructure the new params**

In the `RoomMessageInput({ ... })` parameter list (line ~1394), add near `sendMessage,`:

```ts
  whisperTarget,
  onClearWhisper,
  sendWhisper,
```

- [ ] **Step 3: Branch `handleSend` for whisper mode**

At the very start of `handleSend` (line ~1533), before the `replyTo` logic, add a whisper short-circuit (whispers are text-only in v1):

```ts
  const handleSend = async (sendText: string): Promise<boolean> => {
    // Whisper mode (XEP-0045 §7.5): text-only, ephemeral, no reply/attachment.
    if (whisperTarget) {
      const body = sendText.trim()
      if (!body) return false
      const messageId = await sendWhisper(room.jid, whisperTarget, body)
      onMessageIdSent?.(messageId)
      clearDraft(room.jid)
      onMessageSent?.()
      setTimeout(() => clearFirstNewMessageId(room.jid), 500)
      return true
    }

    // ... existing reply/attachment/sendMessage logic unchanged ...
```

- [ ] **Step 4: Render the whisper banner + Esc-to-exit**

Locate the component's `return (` with `<MessageComposer ... onSend={handleSend} ... />` (line ~1790+). Wrap the returned content in a fragment-bearing `div` that captures `Escape`, and render the banner above the composer. Import `Lock` and `X` from `lucide-react` at the top of the file (add to the existing import).

Replace the outermost returned element so it becomes:

```tsx
  return (
    <div
      onKeyDownCapture={(e) => {
        if (whisperTarget && e.key === 'Escape') {
          e.stopPropagation()
          onClearWhisper?.()
        }
      }}
    >
      {whisperTarget && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 mb-1 rounded bg-fluux-accent/10 text-sm text-fluux-accent">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <Lock className="size-4 shrink-0" />
            <span className="truncate">{t('rooms.whisperingTo', { nick: whisperTarget })}</span>
          </span>
          <button
            type="button"
            onClick={() => onClearWhisper?.()}
            aria-label={t('common.cancel')}
            className="shrink-0 rounded p-0.5 hover:bg-fluux-accent/20"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      {/* existing <MessageComposer ... /> goes here unchanged */}
    </div>
  )
```

Keep the existing `<MessageComposer ... />` JSX exactly as-is, moved inside the new wrapper `div`. (If the original return already had a wrapping element, add `onKeyDownCapture` to it and insert the banner as its first child instead of introducing a new `div`.)

- [ ] **Step 5: Typecheck + rebuild SDK if needed**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Verify in the browser preview**

Start the dev server and verify the whisper flow renders:
- preview_start (web dev server), open a room in demo mode (`/demo.html`).
- Right-click an occupant's nick in a message → confirm a "Whisper" item appears.
- Click it → confirm the banner "Whispering to @nick" appears above the composer with a close (✕) button.
- Type text and send → confirm the message appears inline with a 🔒 private badge and left border tint.
- Press the ✕ (and separately Esc) → confirm the banner clears and the composer returns to public.
- Capture a preview_screenshot of a sent whisper for the handoff.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx
git commit -m "feat(muc): add sticky whisper mode to the room composer"
```

---

## Task 9: i18n keys (all locales) + final verification

**Files:**
- Modify: every locale file under the app i18n directory.

- [ ] **Step 1: Locate the locale files**

Run: `grep -rln "sendPrivateMessage" apps/fluux/src`
Expected: a list of locale files (one per language, ~33). Note the directory and the file format (JSON or TS).

- [ ] **Step 2: Add the new keys to the English locale (canonical)**

In the English locale file, inside the `rooms` namespace (next to `sendPrivateMessage`), add:

```json
"whisper": "Whisper privately",
"whisperingTo": "Whispering to {{nick}} · only they will see this",
"whisperTo": "Private to {{nick}}",
"whisperFrom": "Private from {{nick}}"
```

(If `common.cancel` does not already exist, reuse the existing cancel/close key the app already uses for the banner's aria-label — verify with `grep -rn "cancel" <english-locale-file>` and adjust the `aria-label` in Task 8 Step 4 to the existing key.)

- [ ] **Step 3: Translate the four keys into every other locale**

For each non-English locale file found in Step 1, add the same four keys with proper translations (keep the `{{nick}}` interpolation placeholder intact). Do not leave English placeholders — translate all locales (per project i18n policy).

- [ ] **Step 4: Full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Full test suite**

Run: `npm test`
Expected: all tests pass, no stderr noise.

- [ ] **Step 6: Lint**

Run: `npm run lint` (or the project's configured lint command)
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src
git commit -m "feat(muc): add i18n keys for whispers in all locales"
```

---

## Self-Review notes (already reconciled)

- **Spec §6 storage** — implemented via the existing `noStore` hint, not a new persist filter (see plan header note).
- **Spec §7 send path on `client.room`** — the spec's UI section loosely referenced `client.room.sendWhisper`; the method lives on the Chat module (`client.chat.sendWhisper`), consistent with all other message sends. The hook (`useRoomActive`) is the app-facing surface.
- **Spec §8 ordering** — handled by computing `isWhisper` before the `muc#user→groupchat` reclassification and short-circuiting after `bareFrom` is computed (Task 3 Step 3).
- **Spec §10 entry points** — both chosen entry points (occupant click, message action) funnel through the existing nick context menu, which is reachable from a message's author nick/avatar (`onNickContextMenu`). One menu item covers both. Verify during Task 8 Step 6 that the menu is also reachable from any occupant-list panel; if a separate panel exists with its own menu, wiring the same `setWhisperTarget` there is a trivial follow-up.
- **Spec §11 notifications** — incoming whispers pass `incrementMentions: true` so they bump the mention counter (Task 3 / Task 4).
- **Spec §12 delivery errors** — out of scope for these tasks beyond the existing `type='error'` handling; surfacing per-whisper failure inline is a post-v1 follow-up (Spec §16).
```
