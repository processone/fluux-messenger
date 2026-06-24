# Whisper Operation Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make corrections, reactions, retractions, and typing indicators on a whisper (XEP-0045 §7.5 private message) stay private — addressed to the one occupant, never broadcast to the room — both when sent and when received.

**Architecture:** The SDK auto-detects when an operation targets a stored whisper (a `RoomMessage` with `isPrivate` + `whisperWith`) and rewrites the wire recipient to `room@conf/nick` (`type=chat`, `<x muc#user/>`, `<no-store/>`, origin-id reference). The receive side routes incoming whisper sub-feature stanzas through the existing room-scoped handlers (a whisper's `bareFrom`/`bareTo` already resolves to the room JID). The app keeps the action buttons on whisper bubbles, gated to 1:1-DM parity.

**Tech Stack:** TypeScript, Zustand (vanilla stores), `@xmpp/client` (`xml` builder), React, Vitest, `@testing-library/react`.

## Global Constraints

- **Build the SDK before app typecheck:** after changing SDK types/exports run `npm run build:sdk`.
- **Tests must pass with no stderr; typecheck and lint must pass before any commit.**
- **No em-dashes / en-dashes in user-facing strings** (UI/i18n). Internal code comments and this doc are exempt.
- **No `@xmpp/client` imports in the app** — the app consumes the SDK through hooks/types only.
- **Whispers are `<no-store>`** — every whisper operation references the original by **origin-id** (`originId ?? id`), never a stanza-id, and carries `<no-store>`.
- **Namespaces (already exported from `packages/fluux-sdk/src/core/namespaces.ts`):** `NS_MUC_USER='http://jabber.org/protocol/muc#user'`, `NS_HINTS='urn:xmpp:hints'`, `NS_REACTIONS='urn:xmpp:reactions:0'`, `NS_CORRECTION='urn:xmpp:message-correct:0'`, `NS_RETRACT='urn:xmpp:message-retract:1'`, `NS_OCCUPANT_ID='urn:xmpp:occupant-id:0'`, `NS_CHATSTATES='http://jabber.org/protocol/chatstates'`, `NS_OOB='jabber:x:oob'`. All are already imported in `Chat.ts`.

## File Structure

- `packages/fluux-sdk/src/core/errors.ts` — add `WhisperCounterpartGoneError` (next to `RoomJoinError`).
- `packages/fluux-sdk/src/index.ts` — export the new error.
- `packages/fluux-sdk/src/core/modules/Chat.ts` — `resolveWhisperRouting` helper; whisper branches in `sendCorrection`/`sendReaction`/`sendRetraction`; receive-side whisper sub-feature routing; new `sendWhisperChatState`.
- `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts` — all SDK whisper-operation tests.
- `packages/fluux-sdk/src/hooks/{useRoomActive,useRoom,useRoomActions}.ts` — expose `sendWhisperChatState`.
- `apps/fluux/src/components/conversation/messageActionCapabilities.ts` (new) — pure capability helper.
- `apps/fluux/src/components/conversation/messageActionCapabilities.test.ts` (new) — its tests.
- `apps/fluux/src/components/conversation/MessageBubble.tsx` — use the capability helper.
- `apps/fluux/src/components/conversation/whisperTarget.ts` — add `decideChatStateRoute`.
- `apps/fluux/src/components/conversation/whisperTarget.test.ts` — its tests.
- `apps/fluux/src/components/RoomView.tsx` — route typing privately; catch `WhisperCounterpartGoneError`.

---

### Task 1: SDK whisper routing helper + `sendCorrection`

**Files:**
- Modify: `packages/fluux-sdk/src/core/errors.ts`
- Modify: `packages/fluux-sdk/src/index.ts:657`
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (`sendCorrection` ~1237-1341; new `resolveWhisperRouting`)
- Test: `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts`

**Interfaces:**
- Produces: `class WhisperCounterpartGoneError extends Error { roomJid: string; nick: string }`
- Produces: `private resolveWhisperRouting(roomJid: string, messageId: string): { recipient: string; referenceId: string; nick: string } | null` — returns `null` for non-whisper targets; **throws** `WhisperCounterpartGoneError` when the counterpart has left. Consumed by Tasks 2 and 3.

- [ ] **Step 1: Write the failing tests**

Add to `Chat.whisper.test.ts`. Add the error import at the top with the other imports:

```typescript
import { WhisperCounterpartGoneError } from '../errors'
```

Then add this describe block (after the existing `describe('incoming whispers', ...)`):

```typescript
describe('whisper operations (send)', () => {
  const ROOM = 'room@conference.example.com'

  function roomWithBob(occupants = new Map([
    ['bob', { nick: 'bob', affiliation: 'member', role: 'participant', occupantId: 'occ-bob' }],
  ])) {
    return createMockRoom(ROOM, { joined: true, nickname: 'me', occupants })
  }

  function storedWhisper(overrides: Record<string, unknown> = {}) {
    return {
      type: 'groupchat', id: 'w-1', originId: 'w-1', roomJid: ROOM,
      from: `${ROOM}/me`, nick: 'me', body: 'secret', timestamp: new Date(),
      isOutgoing: true, isPrivate: true, whisperWith: 'bob', whisperWithOccupantId: 'occ-bob',
      ...overrides,
    }
  }

  it('sendCorrection on a whisper addresses room/nick privately (type=chat, muc#user, no-store, origin-id)', async () => {
    await connectClient()
    vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
    vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

    await xmppClient.chat.sendCorrection(ROOM, 'w-1', 'fixed secret', 'groupchat')

    const sent = mockXmppClientInstance.send.mock.calls[0][0]
    expect(sent.attrs.to).toBe(`${ROOM}/bob`)
    expect(sent.attrs.type).toBe('chat')
    const replace = sent.children.find((c: any) => c.name === 'replace')
    expect(replace.attrs.id).toBe('w-1')
    expect(sent.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user')).toBeDefined()
    expect(sent.children.find((c: any) => c.name === 'no-store')).toBeDefined()
  })

  it('sendCorrection on a public room message still broadcasts to the room (no regression)', async () => {
    await connectClient()
    vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
    vi.mocked(mockStores.room.getMessage).mockReturnValue({
      type: 'groupchat', id: 'm-1', originId: 'm-1', roomJid: ROOM, from: `${ROOM}/me`,
      nick: 'me', body: 'hi', timestamp: new Date(), isOutgoing: true,
    } as any)

    await xmppClient.chat.sendCorrection(ROOM, 'm-1', 'hi fixed', 'groupchat')

    const sent = mockXmppClientInstance.send.mock.calls[0][0]
    expect(sent.attrs.to).toBe(ROOM)
    expect(sent.attrs.type).toBe('groupchat')
    expect(sent.children.find((c: any) => c.name === 'no-store')).toBeUndefined()
  })

  it('throws WhisperCounterpartGoneError and sends nothing when the counterpart has left', async () => {
    await connectClient()
    vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob(new Map()))
    vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

    await expect(
      xmppClient.chat.sendCorrection(ROOM, 'w-1', 'x', 'groupchat'),
    ).rejects.toThrow(WhisperCounterpartGoneError)
    expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
  })

  it('re-resolves the current nick from occupant-id after a rename', async () => {
    await connectClient()
    vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob(new Map([
      ['bobby', { nick: 'bobby', affiliation: 'member', role: 'participant', occupantId: 'occ-bob' }],
    ])))
    vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

    await xmppClient.chat.sendCorrection(ROOM, 'w-1', 'fixed', 'groupchat')

    expect(mockXmppClientInstance.send.mock.calls[0][0].attrs.to).toBe(`${ROOM}/bobby`)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "whisper operations \(send\)"`
Expected: FAIL — `WhisperCounterpartGoneError` is not exported / correction still goes to the room with `type=groupchat`.

- [ ] **Step 3: Add the error class**

In `packages/fluux-sdk/src/core/errors.ts`, after the `RoomJoinError` class, add:

```typescript
/**
 * Thrown by the whisper operation send path (correction/reaction/retraction)
 * when the target occupant is no longer present in the room — left, or the nick
 * has been recycled by a different occupant-id. The operation must NEVER fall
 * back to a public room broadcast, so the send path throws this instead.
 */
export class WhisperCounterpartGoneError extends Error {
  readonly roomJid: string
  readonly nick: string

  constructor(roomJid: string, nick: string) {
    super(`Whisper counterpart "${nick}" is no longer present in ${roomJid}`)
    this.name = 'WhisperCounterpartGoneError'
    this.roomJid = roomJid
    this.nick = nick
    Object.setPrototypeOf(this, WhisperCounterpartGoneError.prototype)
  }
}
```

- [ ] **Step 4: Export the error**

In `packages/fluux-sdk/src/index.ts`, change line 657 from:

```typescript
export { RoomJoinError } from './core/errors'
```

to:

```typescript
export { RoomJoinError, WhisperCounterpartGoneError } from './core/errors'
```

- [ ] **Step 5: Add the `resolveWhisperRouting` helper**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, add this private method immediately before `getMessageReferenceId` (search for `private getMessageReferenceId`). It uses `WhisperCounterpartGoneError`, so add it to the existing import from `../errors` (search for the line importing `RoomJoinError` if present, otherwise add `import { WhisperCounterpartGoneError } from '../errors'` near the other core imports):

```typescript
  /**
   * XEP-0045 §7.5: when an operation (correction/reaction/retraction) targets a
   * stored whisper, address it privately to the one occupant — never broadcast to
   * the room. Returns the private routing derived from the stored message, or null
   * when the target is a normal public/1:1 message (caller keeps its existing path).
   *
   * The current nick is re-resolved from the counterpart's stable occupant-id
   * (XEP-0421) so the operation survives a rename. If the counterpart has left
   * (occupant-id gone, or nick gone in rooms without occupant-id), it throws
   * WhisperCounterpartGoneError — it must NEVER fall back to the room-broadcast path.
   */
  private resolveWhisperRouting(
    roomJid: string,
    messageId: string,
  ): { recipient: string; referenceId: string; nick: string } | null {
    const msg = this.deps.stores?.room.getMessage(roomJid, messageId)
    if (!msg?.isPrivate || !msg.whisperWith) return null

    const occupants = this.deps.stores?.room.getRoom(roomJid)?.occupants
    let nick: string | null = null
    if (msg.whisperWithOccupantId && occupants) {
      for (const [occNick, occ] of occupants) {
        if (occ.occupantId === msg.whisperWithOccupantId) { nick = occNick; break }
      }
    } else if (occupants?.has(msg.whisperWith)) {
      nick = msg.whisperWith
    }
    if (!nick) throw new WhisperCounterpartGoneError(roomJid, msg.whisperWith)

    return { recipient: `${roomJid}/${nick}`, referenceId: msg.originId ?? messageId, nick }
  }
```

- [ ] **Step 6: Wire `sendCorrection`**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, in `sendCorrection`, replace the opening recipient/original/referenceId computation. Change from:

```typescript
    const recipient = type === 'chat' ? getBareJid(to) : to

    // XEP-0308 (Last Message Correction) has NO group-chat carve-out — unlike
    // XEP-0461 replies, XEP-0444 reactions and XEP-0424 retractions, which all
    // switch to the server/MUC stanza-id. A correction MUST reference the id the
    // ORIGINAL SENDER assigned: the origin-id (XEP-0359) when present, otherwise
    // the message id. Referencing the stanza-id breaks correction matching on
    // compliant clients (they render the edit as a brand-new message).
    const original = type === 'groupchat'
      ? this.deps.stores?.room.getMessage(to, originalMessageId)
      : this.deps.stores?.chat.getMessage(to, originalMessageId)
    const referenceId = original?.originId ?? originalMessageId
```

to:

```typescript
    // XEP-0045 §7.5: if the target is a whisper, address the correction privately
    // to the one occupant (type=chat to room/nick + muc#user + no-store) instead of
    // broadcasting to the room. Throws WhisperCounterpartGoneError if they have left.
    const whisper = type === 'groupchat' ? this.resolveWhisperRouting(to, originalMessageId) : null
    const isWhisper = whisper !== null
    const recipient = isWhisper ? whisper.recipient : (type === 'chat' ? getBareJid(to) : to)
    const wireType: 'chat' | 'groupchat' = isWhisper ? 'chat' : type

    // XEP-0308 (Last Message Correction) has NO group-chat carve-out — unlike
    // XEP-0461 replies, XEP-0444 reactions and XEP-0424 retractions, which all
    // switch to the server/MUC stanza-id. A correction MUST reference the id the
    // ORIGINAL SENDER assigned: the origin-id (XEP-0359) when present, otherwise
    // the message id. Referencing the stanza-id breaks correction matching on
    // compliant clients (they render the edit as a brand-new message).
    const original = type === 'groupchat'
      ? this.deps.stores?.room.getMessage(to, originalMessageId)
      : this.deps.stores?.chat.getMessage(to, originalMessageId)
    const referenceId = isWhisper ? whisper.referenceId : (original?.originId ?? originalMessageId)
```

Then add the whisper markers. Find the line `children.push(createOriginIdElement(correctionStanzaId))` in `sendCorrection` and insert immediately after it:

```typescript
    if (isWhisper) {
      children.push(xml('x', { xmlns: NS_MUC_USER }), xml('no-store', { xmlns: NS_HINTS }))
    }
```

Finally, change the send line from:

```typescript
    await this.deps.sendStanza(xml('message', { to: recipient, type, id: correctionStanzaId }, ...children))
```

to:

```typescript
    await this.deps.sendStanza(xml('message', { to: recipient, type: wireType, id: correctionStanzaId }, ...children))
```

(The E2EE branch stays gated on `type === 'chat'`; a whisper has `type === 'groupchat'`, so it is already excluded. The optimistic `room:message-updated` emit also stays keyed on `type`.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "whisper operations \(send\)"`
Expected: PASS (4 tests).

- [ ] **Step 8: Build SDK, typecheck, lint**

Run: `npm run build:sdk && npm run typecheck` (from repo root)
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/fluux-sdk/src/core/errors.ts packages/fluux-sdk/src/index.ts packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts
git commit -m "feat(whisper): route corrections privately to the occupant (XEP-0045 §7.5)"
```

---

### Task 2: `sendReaction` whisper routing

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (`sendReaction` ~1145-1208)
- Test: `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts`

**Interfaces:**
- Consumes: `resolveWhisperRouting` (Task 1).

- [ ] **Step 1: Write the failing test**

Add inside the `describe('whisper operations (send)', ...)` block in `Chat.whisper.test.ts`:

```typescript
it('sendReaction on a whisper addresses room/nick privately with no-store (not the room)', async () => {
  await connectClient()
  vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
  vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

  await xmppClient.chat.sendReaction(ROOM, 'w-1', ['👍'], 'groupchat')

  const sent = mockXmppClientInstance.send.mock.calls[0][0]
  expect(sent.attrs.to).toBe(`${ROOM}/bob`)
  expect(sent.attrs.type).toBe('chat')
  const reactions = sent.children.find((c: any) => c.name === 'reactions')
  expect(reactions.attrs.id).toBe('w-1')
  expect(sent.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user')).toBeDefined()
  expect(sent.children.find((c: any) => c.name === 'no-store')).toBeDefined()
  expect(sent.children.find((c: any) => c.name === 'store')).toBeUndefined()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "sendReaction on a whisper"`
Expected: FAIL — reaction goes to the room with `type=groupchat` and a `<store>` hint.

- [ ] **Step 3: Wire `sendReaction`**

In `sendReaction`, replace:

```typescript
    const recipient = type === 'chat' ? getBareJid(to) : to

    // For MUC, prefer stanzaId (server-assigned, stable) over client-generated id
    // Other clients (e.g. Gajim) reference messages by stanzaId in reactions
    const referenceId = this.getMessageReferenceId(to, messageId, type)
```

with:

```typescript
    // XEP-0045 §7.5: a reaction on a whisper is addressed privately to the one
    // occupant; whispers are <no-store> so the reference is the origin-id.
    const whisper = type === 'groupchat' ? this.resolveWhisperRouting(to, messageId) : null
    const isWhisper = whisper !== null
    const recipient = isWhisper ? whisper.recipient : (type === 'chat' ? getBareJid(to) : to)
    const wireType: 'chat' | 'groupchat' = isWhisper ? 'chat' : type

    // For MUC, prefer stanzaId (server-assigned, stable) over client-generated id
    // Other clients (e.g. Gajim) reference messages by stanzaId in reactions
    const referenceId = isWhisper ? whisper.referenceId : this.getMessageReferenceId(to, messageId, type)
```

Then change the store-hint else-branch. Replace:

```typescript
    if (type === 'chat' && peerCanEncrypt) {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_REACTION_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'store',
      })
    } else {
      children.push(xml('store', { xmlns: NS_HINTS }))
    }

    const message = xml('message', { to: recipient, type, id: reactionStanzaId }, ...children)
```

with:

```typescript
    if (type === 'chat' && peerCanEncrypt) {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_REACTION_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'store',
      })
    } else if (isWhisper) {
      // Whisper reaction: muc#user marker + no-store (kept off the room archive).
      children.push(xml('x', { xmlns: NS_MUC_USER }), xml('no-store', { xmlns: NS_HINTS }))
    } else {
      children.push(xml('store', { xmlns: NS_HINTS }))
    }

    const message = xml('message', { to: recipient, type: wireType, id: reactionStanzaId }, ...children)
```

(`peerCanEncrypt` stays false for a whisper because its computation is gated on `type === 'chat'`. The optimistic `room:reactions` emit stays keyed on `type === 'groupchat'`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "sendReaction on a whisper"`
Expected: PASS.

- [ ] **Step 5: Run the full whisper suite + typecheck**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts && cd .. && cd .. && npm run build:sdk && npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts
git commit -m "feat(whisper): route reactions privately to the occupant"
```

---

### Task 3: `sendRetraction` whisper routing

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (`sendRetraction` ~1368-1417)
- Test: `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts`

**Interfaces:**
- Consumes: `resolveWhisperRouting` (Task 1).

- [ ] **Step 1: Write the failing test**

Add inside `describe('whisper operations (send)', ...)`:

```typescript
it('sendRetraction on a whisper addresses room/nick privately with no-store (not the room)', async () => {
  await connectClient()
  vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
  vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

  await xmppClient.chat.sendRetraction(ROOM, 'w-1', 'groupchat')

  const sent = mockXmppClientInstance.send.mock.calls[0][0]
  expect(sent.attrs.to).toBe(`${ROOM}/bob`)
  expect(sent.attrs.type).toBe('chat')
  const retract = sent.children.find((c: any) => c.name === 'retract')
  expect(retract.attrs.id).toBe('w-1')
  expect(sent.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user')).toBeDefined()
  expect(sent.children.find((c: any) => c.name === 'no-store')).toBeDefined()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "sendRetraction on a whisper"`
Expected: FAIL — retraction goes to the room with `type=groupchat`.

- [ ] **Step 3: Wire `sendRetraction`**

In `sendRetraction`, replace:

```typescript
    const recipient = type === 'chat' ? getBareJid(to) : to

    // For MUC, prefer stanzaId (server-assigned, stable) for the retraction reference
    const referenceId = this.getMessageReferenceId(to, originalMessageId, type)
```

with:

```typescript
    // XEP-0045 §7.5: a retraction of a whisper is addressed privately to the one
    // occupant; whispers are <no-store> so the reference is the origin-id.
    const whisper = type === 'groupchat' ? this.resolveWhisperRouting(to, originalMessageId) : null
    const isWhisper = whisper !== null
    const recipient = isWhisper ? whisper.recipient : (type === 'chat' ? getBareJid(to) : to)
    const wireType: 'chat' | 'groupchat' = isWhisper ? 'chat' : type

    // For MUC, prefer stanzaId (server-assigned, stable) for the retraction reference
    const referenceId = isWhisper ? whisper.referenceId : this.getMessageReferenceId(to, originalMessageId, type)
```

Then find `createOriginIdElement(retractionStanzaId),` inside the `children` array of `sendRetraction`. After the `const children = [ ... ]` array literal closes, insert:

```typescript
    if (isWhisper) {
      children.push(xml('x', { xmlns: NS_MUC_USER }), xml('no-store', { xmlns: NS_HINTS }))
    }
```

Finally, change the send line from:

```typescript
    await this.deps.sendStanza(
      xml('message', { to: recipient, type, id: retractionStanzaId }, ...children),
    )
```

to:

```typescript
    await this.deps.sendStanza(
      xml('message', { to: recipient, type: wireType, id: retractionStanzaId }, ...children),
    )
```

(The E2EE branch stays gated on `type === 'chat'`; the optimistic emit stays keyed on `type`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "sendRetraction on a whisper"`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run build:sdk && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts
git commit -m "feat(whisper): route retractions privately to the occupant"
```

---

### Task 4: Receive-side — apply incoming whisper operations to the thread

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (the `if (isWhisper) { ... }` branch ~254-265 in `handleMessageInternal`)
- Test: `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts`

**Interfaces:**
- Consumes existing private handlers: `handleIncomingReaction`, `handleIncomingRetraction`, `handleIncomingCorrection`, `processRoomWhisper`.

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `Chat.whisper.test.ts`:

```typescript
describe('whisper operations (receive)', () => {
  const ROOM = 'room@conference.example.com'

  beforeEach(() => {
    vi.mocked(mockStores.room.getRoom).mockReturnValue(
      createMockRoom(ROOM, { joined: true, nickname: 'me' }),
    )
  })

  it('incoming whisper reaction updates the whisper thread, not a new whisper', async () => {
    await connectClient()
    vi.mocked(mockStores.room.getRoom).mockReturnValue(createMockRoom(ROOM, { joined: true, nickname: 'me' }))

    const stanza = createMockElement('message', {
      from: `${ROOM}/bob`, to: 'user@example.com', type: 'chat', id: 'r-1',
    }, [
      { name: 'reactions', attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'w-1' }, children: [{ name: 'reaction', text: '👍' }] },
      { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
      { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
    ])
    mockXmppClientInstance._emit('stanza', stanza)

    expect(emitSDKSpy).toHaveBeenCalledWith('room:reactions', expect.objectContaining({
      roomJid: ROOM, messageId: 'w-1', reactorNick: 'bob', emojis: ['👍'],
    }))
    expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
  })

  it('incoming whisper correction updates the existing whisper (not a new whisper)', async () => {
    await connectClient()
    vi.mocked(mockStores.room.getRoom).mockReturnValue(createMockRoom(ROOM, { joined: true, nickname: 'me' }))
    vi.mocked(mockStores.room.getMessage).mockReturnValue({
      id: 'bw-1', originId: 'bw-1', from: `${ROOM}/bob`, nick: 'bob', body: 'old',
      isPrivate: true, whisperWith: 'bob', occupantId: 'occ-bob', timestamp: new Date(),
    } as any)

    const stanza = createMockElement('message', {
      from: `${ROOM}/bob`, to: 'user@example.com', type: 'chat', id: 'corr-1',
    }, [
      { name: 'body', text: 'new text' },
      { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'bw-1' } },
      { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
      { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
    ])
    mockXmppClientInstance._emit('stanza', stanza)

    expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', expect.objectContaining({
      roomJid: ROOM, messageId: 'bw-1', updates: expect.objectContaining({ body: 'new text', isEdited: true }),
    }))
    expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
  })

  it('incoming whisper retraction marks the whisper retracted (not a new whisper)', async () => {
    await connectClient()
    vi.mocked(mockStores.room.getRoom).mockReturnValue(createMockRoom(ROOM, { joined: true, nickname: 'me' }))
    vi.mocked(mockStores.room.getMessage).mockReturnValue({
      id: 'bw-1', from: `${ROOM}/bob`, nick: 'bob', occupantId: 'occ-bob',
      isPrivate: true, whisperWith: 'bob', timestamp: new Date(),
    } as any)

    const stanza = createMockElement('message', {
      from: `${ROOM}/bob`, to: 'user@example.com', type: 'chat', id: 'rt-1',
    }, [
      { name: 'body', text: 'This person attempted to retract a previous message...' },
      { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'bw-1' } },
      { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
      { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
    ])
    mockXmppClientInstance._emit('stanza', stanza)

    expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', expect.objectContaining({
      roomJid: ROOM, messageId: 'bw-1', updates: expect.objectContaining({ isRetracted: true }),
    }))
    expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "whisper operations \(receive\)"`
Expected: FAIL — current code routes every whisper to `processRoomWhisper`, so it emits `room:whisper` and never `room:reactions`/`room:message-updated`.

- [ ] **Step 3: Restructure the whisper branch**

In `Chat.ts`, replace the whole `if (isWhisper) { ... }` block (currently ~254-265):

```typescript
    // Whisper short-circuit: handle before the public sub-feature handlers
    // (chat states, reactions, corrections, retractions, moderation), which
    // are out of scope for whispers in v1.
    if (isWhisper) {
      if (body || stanza.getChild('x', NS_OOB)) {
        // from is non-null here: isWhisper guards !!from
        const whisper = this.processRoomWhisper(stanza, from!, bareFrom, body || '', isSentCarbon)
        if (whisper && !isSentCarbon) {
          this.deps.emit('message', whisper as unknown as Message)
        }
        return { handled: true, message: whisper }
      }
      // Bodyless whisper (e.g. a stray chat-state): claim and drop in v1.
      return { handled: true }
    }
```

with:

```typescript
    // Whisper sub-features (XEP-0045 §7.5). A whisper carrying <reactions>/<retract>/
    // <replace> is an operation on the EXISTING whisper thread, not a new whisper.
    // A whisper's bareFrom/bareTo is the room JID, so the room-scoped handlers
    // resolve the right conversation when type is forced to 'groupchat' (the wire
    // type is 'chat' only per the private-message convention). Order matters:
    // check operations before the new-body fall-through.
    if (isWhisper) {
      const whisperReactionsEl = stanza.getChild('reactions', NS_REACTIONS)
      if (whisperReactionsEl) {
        this.handleIncomingReaction(stanza, whisperReactionsEl, from!, bareFrom, bareTo, 'groupchat', isSentCarbon)
        return { handled: true }
      }

      const whisperRetractEl = stanza.getChild('retract', NS_RETRACT)
      if (whisperRetractEl?.attrs.id) {
        // Consume even if it matches no stored message — the body is just the
        // XEP-0428 fallback notice, never shown as a new whisper.
        this.handleIncomingRetraction(
          whisperRetractEl.attrs.id, from!, bareFrom, bareTo, 'groupchat', isSentCarbon,
          stanza.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id,
        )
        return { handled: true }
      }

      const whisperReplaceEl = stanza.getChild('replace', NS_CORRECTION)
      if (whisperReplaceEl?.attrs.id && body && this.handleIncomingCorrection(
        stanza, whisperReplaceEl.attrs.id, from!, bareFrom, bareTo, body, 'groupchat', isSentCarbon,
      )) {
        return { handled: true }
      }

      // Genuine new whisper (body or media), or a correction that matched no stored
      // message (e.g. evicted) — show the (corrected) text as a whisper.
      if (body || stanza.getChild('x', NS_OOB)) {
        // from is non-null here: isWhisper guards !!from
        const whisper = this.processRoomWhisper(stanza, from!, bareFrom, body || '', isSentCarbon)
        if (whisper && !isSentCarbon) {
          this.deps.emit('message', whisper as unknown as Message)
        }
        return { handled: true, message: whisper }
      }
      // Bodyless whisper (e.g. a stray chat-state): claim and drop.
      return { handled: true }
    }
```

- [ ] **Step 4: Run the receive tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "whisper operations \(receive\)"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full whisper suite (regression) + typecheck**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts && cd ../.. && npm run build:sdk && npm run typecheck`
Expected: PASS — the existing incoming-whisper tests (plain new whisper, carbon, muc#user marker) still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts
git commit -m "feat(whisper): apply incoming corrections/reactions/retractions to the thread"
```

---

### Task 5: `sendWhisperChatState` + hook exposure

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (new method after `sendChatState` ~1119)
- Modify: `packages/fluux-sdk/src/hooks/useRoomActive.ts`, `useRoom.ts`, `useRoomActions.ts`
- Test: `packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts`

**Interfaces:**
- Produces: `async sendWhisperChatState(roomJid: string, nick: string, state: ChatStateNotification): Promise<void>` — exposed on each room hook with the same signature. Consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Add inside `describe('whisper operations (send)', ...)` in `Chat.whisper.test.ts`:

```typescript
it('sendWhisperChatState sends a private chat-state to room/nick (muc#user, no-store)', async () => {
  await connectClient()

  await xmppClient.chat.sendWhisperChatState(ROOM, 'bob', 'composing')

  const sent = mockXmppClientInstance.send.mock.calls[0][0]
  expect(sent.attrs.to).toBe(`${ROOM}/bob`)
  expect(sent.attrs.type).toBe('chat')
  expect(sent.children.find((c: any) => c.name === 'composing')).toBeDefined()
  expect(sent.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user')).toBeDefined()
  expect(sent.children.find((c: any) => c.name === 'no-store')).toBeDefined()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "sendWhisperChatState"`
Expected: FAIL — `sendWhisperChatState` is not a function.

- [ ] **Step 3: Add the SDK method**

In `Chat.ts`, immediately after the `sendChatState` method (after its closing `}` at ~1119), add:

```typescript
  /**
   * Send a chat state (XEP-0085) privately to a single room occupant — the typing
   * indicator for a whisper (XEP-0045 §7.5). Unlike sendChatState('groupchat'),
   * which broadcasts to the room, this addresses room/nick with the muc#user marker
   * and a no-store hint, so the room never sees that you are whispering.
   */
  async sendWhisperChatState(roomJid: string, nick: string, state: ChatStateNotification): Promise<void> {
    const message = xml('message', { to: `${roomJid}/${nick}`, type: 'chat' },
      xml(state, { xmlns: NS_CHATSTATES }),
      xml('x', { xmlns: NS_MUC_USER }),
      xml('no-store', { xmlns: NS_HINTS }),
    )
    await this.deps.sendStanza(message)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.whisper.test.ts -t "sendWhisperChatState"`
Expected: PASS.

- [ ] **Step 5: Expose on `useRoomActive`**

In `packages/fluux-sdk/src/hooks/useRoomActive.ts`, after the `sendChatState` `useCallback` (search for `const sendChatState = useCallback`), add:

```typescript
  const sendWhisperChatState = useCallback(
    async (roomJid: string, nick: string, state: ChatStateNotification) => {
      await client.chat.sendWhisperChatState(roomJid, nick, state)
    },
    [client]
  )
```

Then add `sendWhisperChatState,` to BOTH the returned object and its dependency array (search for the two existing `sendChatState,` entries near lines 443 and 480 and add the new name beside each).

- [ ] **Step 6: Expose on `useRoom` and `useRoomActions`**

Repeat Step 5 verbatim in `packages/fluux-sdk/src/hooks/useRoom.ts` (after `const sendChatState = useCallback` ~297; add beside the `sendChatState,` entries ~605 and ~657) and in `packages/fluux-sdk/src/hooks/useRoomActions.ts` (after ~198; beside `sendChatState,` ~430 and ~482). Confirm `ChatStateNotification` is imported in each file (it already is in `useRoomActive.ts:5`; add it to the type import in the other two if missing).

- [ ] **Step 7: Build SDK + typecheck**

Run: `npm run build:sdk && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/hooks/useRoomActive.ts packages/fluux-sdk/src/hooks/useRoom.ts packages/fluux-sdk/src/hooks/useRoomActions.ts packages/fluux-sdk/src/core/modules/Chat.whisper.test.ts
git commit -m "feat(whisper): add sendWhisperChatState for private typing indicators"
```

---

### Task 6: App — pure capability helper + MessageBubble gating

**Files:**
- Create: `apps/fluux/src/components/conversation/messageActionCapabilities.ts`
- Test: `apps/fluux/src/components/conversation/messageActionCapabilities.test.ts`
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx`

**Interfaces:**
- Produces: `computeMessageActions(inputs: MessageActionInputs): MessageActionCapabilities` with `{ canReply, canEdit, canDelete, canReact }`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/messageActionCapabilities.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeMessageActions } from './messageActionCapabilities'

const base = {
  isOutgoing: true, isPrivate: false, isLastOutgoing: true, isLastMessage: false,
  inThread: false, counterpartGone: false, isIrcGateway: false, canModerate: false,
  reactionsEnabled: true,
}

describe('computeMessageActions', () => {
  it('public own last message: edit/delete/react/reply all allowed', () => {
    const a = computeMessageActions(base)
    expect(a).toEqual({ canReply: true, canEdit: true, canDelete: true, canReact: true })
  })

  it('whisper with the counterpart gone: every action disabled', () => {
    const a = computeMessageActions({ ...base, isPrivate: true, inThread: true, counterpartGone: true })
    expect(a).toEqual({ canReply: false, canEdit: false, canDelete: false, canReact: false })
  })

  it('incoming whisper: no moderation-based delete even for a moderator', () => {
    const a = computeMessageActions({
      ...base, isOutgoing: false, isPrivate: true, inThread: true, isLastOutgoing: false, canModerate: true,
    })
    expect(a.canDelete).toBe(false) // private message cannot be moderated
    expect(a.canReact).toBe(true)   // can still react while counterpart present
  })

  it('public message a moderator can delete: moderation delete still allowed', () => {
    const a = computeMessageActions({
      ...base, isOutgoing: false, isLastOutgoing: false, canModerate: true,
    })
    expect(a.canDelete).toBe(true)
  })

  it('IRC gateway: no edit/delete', () => {
    const a = computeMessageActions({ ...base, isIrcGateway: true })
    expect(a.canEdit).toBe(false)
    expect(a.canDelete).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/messageActionCapabilities.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the helper**

Create `apps/fluux/src/components/conversation/messageActionCapabilities.ts`:

```typescript
/**
 * Pure capability rules for a message's action surfaces (hover toolbar + touch
 * action sheet). Extracted so the whisper (XEP-0045 §7.5) gating is testable.
 *
 * Whisper parity with a 1:1 DM:
 * - own whisper: edit / delete (retract) / react / reply
 * - incoming whisper: react / reply (NO edit; NO moderation-delete)
 * - any whisper: disabled once the counterpart has left (counterpartGone)
 */
export interface MessageActionInputs {
  isOutgoing: boolean
  /** The message is a whisper (private MUC message). */
  isPrivate: boolean
  isLastOutgoing: boolean
  isLastMessage: boolean
  /** The message is rendered inside a whisper thread. */
  inThread: boolean
  /** Whisper counterpart has left the room (thread is read-only). */
  counterpartGone: boolean
  isIrcGateway: boolean
  canModerate: boolean
  /** The room exposes reactions (stable occupant identity available). */
  reactionsEnabled: boolean
}

export interface MessageActionCapabilities {
  canReply: boolean
  canEdit: boolean
  canDelete: boolean
  canReact: boolean
}

export function computeMessageActions(i: MessageActionInputs): MessageActionCapabilities {
  return {
    canReply: (!i.isLastMessage || i.inThread) && !i.counterpartGone,
    canEdit: i.isOutgoing && i.isLastOutgoing && !i.isIrcGateway && !i.counterpartGone,
    // XEP-0045 §7.5: a private whisper cannot be moderated (no server archive), so
    // the moderator path is suppressed for whispers; gate on counterpart presence.
    canDelete: (i.isOutgoing || (i.canModerate && !i.isPrivate)) && !i.isIrcGateway && !i.counterpartGone,
    canReact: i.reactionsEnabled && !i.counterpartGone,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/messageActionCapabilities.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the helper into MessageBubble**

In `apps/fluux/src/components/conversation/MessageBubble.tsx`:

(a) Add the import near the other `./` imports (e.g. below the `MessageToolbar` import):

```typescript
import { computeMessageActions } from './messageActionCapabilities'
```

(b) Immediately BEFORE the line `// Whether reactions are enabled for this message (room has stable occupant identity)` (~line 343), insert:

```typescript
  const inThread = !!whisperThread
  const counterpartGone = inThread && counterpartPresent === false
```

(c) Immediately AFTER `const reactionsEnabled = onReaction !== undefined` (~line 344), insert:

```typescript
  const actions = computeMessageActions({
    isOutgoing: message.isOutgoing,
    isPrivate: !!message.isPrivate,
    isLastOutgoing,
    isLastMessage,
    inThread,
    counterpartGone,
    isIrcGateway,
    canModerate: canModerate === true,
    reactionsEnabled,
  })
```

(d) Change the `handleReaction` guard. Replace `const handleReaction = reactionsEnabled ? (emoji: string) => {` with `const handleReaction = actions.canReact ? (emoji: string) => {`.

(e) Remove the now-duplicate lines in the later block. The block currently reads:

```typescript
  const inThread = !!whisperThread
  const threadStart = whisperThread === 'start' || whisperThread === 'solo'
  const threadEnd = whisperThread === 'end' || whisperThread === 'solo'
  // Counterpart left the room: the thread becomes read-only (can't reply privately).
  const counterpartGone = inThread && counterpartPresent === false
```

Change it to (delete the `inThread` and `counterpartGone` lines, now defined above):

```typescript
  const threadStart = whisperThread === 'start' || whisperThread === 'solo'
  const threadEnd = whisperThread === 'end' || whisperThread === 'solo'
```

(f) Replace the capability block:

```typescript
  const canReply = (!isLastMessage || inThread) && !counterpartGone
  const canEdit = message.isOutgoing && isLastOutgoing && !isIrcGateway
  const canDelete = (message.isOutgoing || canModerate === true) && !isIrcGateway
  const canCopyBody = !!message.body && !message.isRetracted && !message.encryptedPayload && !message.unsupportedEncryption
  const hasMessageActions = !message.isRetracted && (reactionsEnabled || canReply || canEdit || canDelete || canCopyBody)
```

with (destructure from `actions` so the existing JSX references to `canReply`/`canEdit`/`canDelete` keep working unchanged):

```typescript
  const { canReply, canEdit, canDelete } = actions
  const canCopyBody = !!message.body && !message.isRetracted && !message.encryptedPayload && !message.unsupportedEncryption
  const hasMessageActions = !message.isRetracted && (actions.canReact || canReply || canEdit || canDelete || canCopyBody)
```

- [ ] **Step 6: Typecheck + run the bubble tests**

Run: `npm run typecheck && cd apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx src/components/conversation/messageActionCapabilities.test.ts`
Expected: PASS — no regression in the existing MessageBubble tests; the new capability tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/conversation/messageActionCapabilities.ts apps/fluux/src/components/conversation/messageActionCapabilities.test.ts apps/fluux/src/components/conversation/MessageBubble.tsx
git commit -m "feat(whisper): gate message actions to 1:1-DM parity on whisper bubbles"
```

---

### Task 7: App — private typing routing + counterpart-gone handling

**Files:**
- Modify: `apps/fluux/src/components/conversation/whisperTarget.ts`
- Test: `apps/fluux/src/components/conversation/whisperTarget.test.ts`
- Modify: `apps/fluux/src/components/RoomView.tsx`

**Interfaces:**
- Consumes: `sendWhisperChatState` from `useRoomActive` (Task 5); `WhisperCounterpartGoneError` from `@fluux/sdk` (Task 1).
- Produces: `decideChatStateRoute(whisperTarget, shouldSendTypingNotifications): ChatStateRoute`.

- [ ] **Step 1: Write the failing test**

Add to `apps/fluux/src/components/conversation/whisperTarget.test.ts`:

```typescript
import { decideChatStateRoute } from './whisperTarget'

describe('decideChatStateRoute', () => {
  it('suppresses typing when notifications are disabled', () => {
    expect(decideChatStateRoute({ nick: 'bob' }, false)).toEqual({ target: 'none' })
  })

  it('routes to the room when not whispering', () => {
    expect(decideChatStateRoute(null, true)).toEqual({ target: 'room' })
  })

  it('routes privately to the whisper target', () => {
    expect(decideChatStateRoute({ nick: 'bob' }, true)).toEqual({ target: 'whisper', nick: 'bob' })
  })
})
```

(If `whisperTarget.test.ts` does not exist yet, create it with the standard header: `import { describe, it, expect } from 'vitest'` plus the block above.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/whisperTarget.test.ts -t "decideChatStateRoute"`
Expected: FAIL — `decideChatStateRoute` is not exported.

- [ ] **Step 3: Add the pure router**

Append to `apps/fluux/src/components/conversation/whisperTarget.ts`:

```typescript
/**
 * Where a composer chat-state (typing indicator) should go. While a whisper is
 * being composed it must be addressed privately to the target (XEP-0045 §7.5),
 * never broadcast to the room. `none` suppresses the state entirely.
 */
export type ChatStateRoute =
  | { target: 'whisper'; nick: string }
  | { target: 'room' }
  | { target: 'none' }

export function decideChatStateRoute(
  whisperTarget: WhisperTarget | null,
  shouldSendTypingNotifications: boolean,
): ChatStateRoute {
  if (!shouldSendTypingNotifications) return { target: 'none' }
  return whisperTarget ? { target: 'whisper', nick: whisperTarget.nick } : { target: 'room' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/whisperTarget.test.ts -t "decideChatStateRoute"`
Expected: PASS.

- [ ] **Step 5: Wire `sendWhisperChatState` through RoomView**

In `apps/fluux/src/components/RoomView.tsx`:

(a) Add `sendWhisperChatState` to the `useRoomActive()` destructure (line 81): insert `sendWhisperChatState,` next to `sendChatState,`.

(b) In `RoomMessageInputProps` (search for `sendChatState: (roomJid: string, state: ChatStateNotification) => Promise<void>` ~1549), add below it:

```typescript
  sendWhisperChatState: (roomJid: string, nick: string, state: ChatStateNotification) => Promise<void>
```

(c) In the `RoomMessageInput` destructured params (search for `sendChatState,` ~1580), add `sendWhisperChatState,` beside it.

(d) Where `RoomMessageInput` is rendered (search for `sendChatState={sendChatState}` ~572), add below it:

```tsx
            sendWhisperChatState={sendWhisperChatState}
```

(e) Add the import for the router. In the `@/hooks`/conversation imports area, import `decideChatStateRoute` from the whisper-target module. It is already imported as a sibling — confirm `whisperTarget` utilities are imported; if `decideWhisperSend` is imported from `./conversation/whisperTarget` (or `@/components/conversation/whisperTarget`), add `decideChatStateRoute` to that same import statement.

(f) Replace `handleTypingState` (~1831):

```typescript
  const handleTypingState = (state: 'composing' | 'paused') => {
    if (shouldSendTypingNotifications) {
      void sendChatState(roomJid, state)
    }
  }
```

with:

```typescript
  const handleTypingState = (state: 'composing' | 'paused') => {
    const route = decideChatStateRoute(whisperTarget, shouldSendTypingNotifications)
    if (route.target === 'whisper') void sendWhisperChatState(roomJid, route.nick, state)
    else if (route.target === 'room') void sendChatState(roomJid, state)
  }
```

- [ ] **Step 6: Catch `WhisperCounterpartGoneError` in the operation handlers**

In `RoomView.tsx`:

(a) Add `WhisperCounterpartGoneError` to the existing `@fluux/sdk` import.

(b) Wrap the whisper-capable operation calls so a race (counterpart leaves between render and click) surfaces the existing toast instead of an unhandled rejection. Replace `handleReaction` (~1249) body's `sendReaction` call site, `handleCorrection` (~1740), and `handleRetract` (~1746) to catch. For `handleCorrection`:

```typescript
  const handleCorrection = async (messageId: string, newBody: string, attachment?: import('@fluux/sdk').FileAttachment): Promise<boolean> => {
    try {
      await sendCorrection(roomJid, messageId, newBody, attachment)
      return true
    } catch (e) {
      if (e instanceof WhisperCounterpartGoneError) {
        addToast('info', t('rooms.whisperCounterpartGone', { nick: e.nick }))
        return false
      }
      throw e
    }
  }
```

For `handleRetract`:

```typescript
  const handleRetract = async (messageId: string): Promise<void> => {
    try {
      await retractMessage(roomJid, messageId)
    } catch (e) {
      if (e instanceof WhisperCounterpartGoneError) {
        addToast('info', t('rooms.whisperCounterpartGone', { nick: e.nick }))
        return
      }
      throw e
    }
  }
```

For the reaction handler (`handleReaction` ~1249, in the bubble wrapper), wrap the `void sendReaction(...)` / `void votePoll(...)` calls similarly — change the regular-reaction path from `void sendReaction(roomJid, message.id, newReactions)` to:

```typescript
    sendReaction(roomJid, message.id, newReactions).catch((e) => {
      if (e instanceof WhisperCounterpartGoneError) addToast('info', t('rooms.whisperCounterpartGone', { nick: e.nick }))
      else console.error(e)
    })
```

(Confirm `addToast` and `t` are in scope in each handler's component; both are already used elsewhere in `RoomView.tsx`. If `addToast` is not in scope in the bubble-wrapper component, pass it down or use the existing toast hook already imported in that component.)

- [ ] **Step 7: Typecheck + run app tests**

Run: `npm run build:sdk && npm run typecheck && cd apps/fluux && npx vitest run src/components/conversation/whisperTarget.test.ts src/components/RoomMessageInput.memo.test.tsx src/components/RoomView.test.tsx`
Expected: PASS, no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/conversation/whisperTarget.ts apps/fluux/src/components/conversation/whisperTarget.test.ts apps/fluux/src/components/RoomView.tsx
git commit -m "feat(whisper): private typing indicators + counterpart-gone handling"
```

---

### Task 8: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, no stderr.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual smoke (demo mode if a whisper fixture exists, else a real room)**

Verify, against a second client joined to the same room: edit / react / retract on a whisper are received privately by the counterpart and are NOT visible to other occupants; while composing a whisper, other occupants do not see a typing indicator; public-room edit/react/retract still work unchanged.

---

## Self-Review

**1. Spec coverage:**
- §1 Send-side routing → Tasks 1-3 (`resolveWhisperRouting` + the three send methods). ✓
- §2 Receive-side matching → Task 4. ✓
- §3 Reference-ids / no-store → `resolveWhisperRouting.referenceId = originId ?? id`; `<no-store>` appended in Tasks 1-3, 5. ✓
- §4 Store updates / carbon sync → optimistic emits unchanged (keyed on `type`); carbon path covered by Task 4's receive routing (sent-carbon unwraps through `handleMessageInternal`). ✓
- §5 UI capabilities → Task 6 (capability table encoded in `computeMessageActions`). ✓
- §6 Typing indicator → Task 5 (`sendWhisperChatState`) + Task 7 (routing). ✓
- §7 Link-preview guard → no behavioural change required; the whisper send path returns before `processLinkPreview`. (No task needed; documented as a non-change.) ✓
- Edge cases (rename, counterpart-gone) → Task 1 helper + tests; (incoming correction before new-body) → Task 4 ordering. ✓

**2. Placeholder scan:** No TBD/TODO; every code step contains complete code and exact commands. ✓

**3. Type consistency:** `resolveWhisperRouting` returns `{ recipient, referenceId, nick }` and is used identically in Tasks 1-3. `sendWhisperChatState(roomJid, nick, state)` signature matches across Chat.ts, the three hooks, and the RoomView prop. `computeMessageActions` inputs/outputs match between the helper and its MessageBubble call site. `decideChatStateRoute` return shape matches its consumer in `handleTypingState`. `WhisperCounterpartGoneError.nick` is read in the RoomView catch. ✓

**Note for the implementer:** Task 7 Step 6 touches handlers in two different inner components of `RoomView.tsx` (the bubble wrapper for reactions, the input component for correction/retraction). Confirm `addToast`/`t` scope in each before wiring; if the reaction handler lacks `addToast`, prefer logging there and rely on the Task 6 button-gating (the SDK throw is a backstop, already covered by Task 1-3 tests).
