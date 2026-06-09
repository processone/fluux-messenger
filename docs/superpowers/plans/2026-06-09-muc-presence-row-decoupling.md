# MUC Presence-Churn Row Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a MUC presence stanza re-render only the message rows authored by the affected occupant, instead of the entire non-virtualized room message list.

**Architecture:** Invert sender resolution — resolve each message's sender (and reply-target avatar) in the list layer (`renderMessage`, cheap Map lookups), then pass only reference-stable objects (`occupant`, `selfOccupant`) and primitives down to the memoized `RoomMessageBubbleWrapper`, which stops referencing `room`. Because `roomStore.addOccupant` preserves unchanged occupants' object refs, a presence change for occupant X changes props only for X's rows; every other row's shallow memo bails.

**Tech Stack:** React 19 (+ React Compiler), Zustand, Vitest + @testing-library/react, TypeScript. Spec: `docs/superpowers/specs/2026-06-09-muc-presence-row-decoupling-design.md`.

---

## File Structure

- **Create** `apps/fluux/src/components/conversation/roomSenderResolution.ts` — pure resolution: `selectSelfOccupant`, `resolveRoomSender`, `resolveReplyAvatar`, `stableNickSet`. One responsibility: turn live room state + a message into reference/value-stable per-row data. No React.
- **Create** `apps/fluux/src/components/conversation/roomSenderResolution.test.ts` — unit tests for the pure functions.
- **Modify** `apps/fluux/src/components/RoomView.tsx` — `RoomMessageList` (`renderMessage`, `knownNicks`, a `replyContext` per-message cache) and `RoomMessageBubbleWrapper` (slim prop interface; consume resolved props).
- **Create** `apps/fluux/src/components/roomRowPresenceMemo.test.tsx` — render-count regression guard.

`RoomOccupant`, `Room`, `RoomMessage`, `RoomAffiliation`, `RoomRole`, `ContactIdentity` are imported from `@fluux/sdk`. Helpers `getBareJid`, `getPresenceFromShow`, `canModerate`, `canBan` from `@fluux/sdk`; `getConsistentTextColor` from `../Avatar`; `whisperCounterpartPresent`, `buildReplyContext` from `./conversation` (re-exported via `./conversation/index`).

---

## Task 1: Pure module — `selectSelfOccupant` + `stableNickSet`

**Files:**
- Create: `apps/fluux/src/components/conversation/roomSenderResolution.ts`
- Test: `apps/fluux/src/components/conversation/roomSenderResolution.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { selectSelfOccupant, stableNickSet } from './roomSenderResolution'
import type { RoomOccupant } from '@fluux/sdk'

const occ = (nick: string, extra: Partial<RoomOccupant> = {}): RoomOccupant =>
  ({ nick, role: 'participant', affiliation: 'none', ...extra } as RoomOccupant)

describe('selectSelfOccupant', () => {
  it('returns the occupant matching myNick', () => {
    const map = new Map([['me', occ('me')], ['you', occ('you')]])
    expect(selectSelfOccupant(map, 'me')?.nick).toBe('me')
  })
  it('returns undefined when myNick is undefined or absent', () => {
    const map = new Map([['you', occ('you')]])
    expect(selectSelfOccupant(map, undefined)).toBeUndefined()
    expect(selectSelfOccupant(map, 'me')).toBeUndefined()
  })
})

describe('stableNickSet', () => {
  it('returns the SAME set ref when the nick set is unchanged across calls', () => {
    const a = new Map([['x', occ('x')], ['y', occ('y')]])
    const first = stableNickSet(a, undefined)
    // New occupants Map (presence flap) but identical key set:
    const b = new Map([['x', occ('x', { show: 'away' })], ['y', occ('y')]])
    const second = stableNickSet(b, first)
    expect(second).toBe(first)
  })
  it('returns a NEW set ref when a nick is added or removed', () => {
    const a = new Map([['x', occ('x')]])
    const first = stableNickSet(a, undefined)
    const b = new Map([['x', occ('x')], ['z', occ('z')]])
    const second = stableNickSet(b, first)
    expect(second).not.toBe(first)
    expect(second.has('z')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/roomSenderResolution.test.ts`
Expected: FAIL — "selectSelfOccupant is not a function" (module/exports missing).

- [ ] **Step 3: Write minimal implementation**

```ts
import type { RoomOccupant } from '@fluux/sdk'

export function selectSelfOccupant(
  occupants: ReadonlyMap<string, RoomOccupant>,
  myNick: string | undefined,
): RoomOccupant | undefined {
  return myNick ? occupants.get(myNick) : undefined
}

/**
 * Returns a Set of occupant nicks whose reference is STABLE across presence
 * (show/status) churn — it only changes when the nick set itself changes.
 * Pass the previous result as `prev` to enable the bail.
 */
export function stableNickSet(
  occupants: ReadonlyMap<string, RoomOccupant>,
  prev: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (prev && prev.size === occupants.size) {
    let same = true
    for (const nick of occupants.keys()) {
      if (!prev.has(nick)) { same = false; break }
    }
    if (same) return prev
  }
  return new Set(occupants.keys())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/roomSenderResolution.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/roomSenderResolution.ts apps/fluux/src/components/conversation/roomSenderResolution.test.ts
git commit -m "feat(rooms): add selectSelfOccupant + stableNickSet resolution helpers"
```

---

## Task 2: `resolveRoomSender` — the per-row sender slice

This lifts the resolution currently inline in `RoomMessageBubbleWrapper` at `RoomView.tsx:1131-1182`, `:1357`, `:1384` into a pure function. Compare your implementation against those lines to keep behavior identical.

**Files:**
- Modify: `apps/fluux/src/components/conversation/roomSenderResolution.ts`
- Test: `apps/fluux/src/components/conversation/roomSenderResolution.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { resolveRoomSender } from './roomSenderResolution'
import type { Room, RoomMessage } from '@fluux/sdk'

const room = (over: Partial<Room>): Room => ({
  jid: 'r@conf', nickname: 'me', joined: true, supportsReactions: true,
  occupants: new Map(), nickToJidCache: new Map(), nickToAvatarCache: new Map(),
  ...over,
} as Room)
const msg = (over: Partial<RoomMessage>): RoomMessage =>
  ({ id: '1', nick: 'alice', isOutgoing: false, isPrivate: false, ...over } as RoomMessage)

describe('resolveRoomSender', () => {
  it('resolves avatar + presence from the live occupant by nick', () => {
    const alice = { nick: 'alice', role: 'participant', affiliation: 'none', show: 'away', avatar: 'blob:a' } as any
    const r = room({ occupants: new Map([['alice', alice]]) })
    const s = resolveRoomSender(msg({}), r, new Map(), undefined)
    expect(s.occupant).toBe(alice)            // stable live ref
    expect(s.senderAvatar).toBe('blob:a')
    expect(s.avatarPresence).toBe('away')
    expect(s.resolvedSenderName).toBe('alice')
  })

  it('falls back to occupant-id match when nick is not a current occupant', () => {
    const bob = { nick: 'bob2', occupantId: 'oid-bob', role: 'participant', affiliation: 'none', show: 'online' } as any
    const r = room({ occupants: new Map([['bob2', bob]]) })
    const s = resolveRoomSender(msg({ nick: 'bob', occupantId: 'oid-bob' }), r, new Map(), undefined)
    expect(s.occupant).toBe(bob)
    expect(s.resolvedSenderName).toBe('bob2')  // occupantIdMatchNick wins
  })

  it('reports avatarPresence offline when occupant absent (joined room)', () => {
    const s = resolveRoomSender(msg({ nick: 'ghost' }), room({}), new Map(), undefined)
    expect(s.avatarPresence).toBe('offline')
  })

  it('counterpartPresent is true for non-private messages', () => {
    const s = resolveRoomSender(msg({ isPrivate: false }), room({}), new Map(), undefined)
    expect(s.counterpartPresent).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/roomSenderResolution.test.ts -t resolveRoomSender`
Expected: FAIL — "resolveRoomSender is not a function".

- [ ] **Step 3: Write implementation**

Add to `roomSenderResolution.ts` (lift logic from `RoomView.tsx:1131-1188`, `:1357`, `:1384`):

```ts
import { getBareJid, getPresenceFromShow, canModerate, canBan } from '@fluux/sdk'
import { whisperCounterpartPresent } from './'
import type { Room, RoomMessage, RoomRole, RoomAffiliation, ContactIdentity } from '@fluux/sdk'

export interface ResolvedRoomSender {
  occupant: RoomOccupant | undefined
  occupantIdMatchNick: string | undefined
  avatarPresence: 'online' | 'away' | 'dnd' | 'offline' | undefined
  senderAvatar: string | undefined
  resolvedSenderName: string
  senderRole: RoomRole | undefined
  senderAffiliation: RoomAffiliation | undefined
  senderBareJidForBan: string | undefined
  canModerate: boolean
  canBan: boolean
  counterpartPresent: boolean
}

export function resolveRoomSender(
  message: RoomMessage,
  room: Room,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  selfOccupant: RoomOccupant | undefined,
): ResolvedRoomSender {
  let occupant = room.occupants.get(message.nick)
  let occupantIdMatchNick: string | undefined
  if (!occupant && message.occupantId) {
    for (const occ of room.occupants.values()) {
      if (occ.occupantId === message.occupantId) { occupant = occ; occupantIdMatchNick = occ.nick; break }
    }
  }

  const canModerateMsg = !message.isOutgoing && selfOccupant
    ? canModerate(selfOccupant.role, selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false

  const senderBareJidForBan = occupant?.jid
    ? getBareJid(occupant.jid)
    : room.nickToJidCache?.get(message.nick)
  const canBanUser = !message.isOutgoing && selfOccupant && senderBareJidForBan
    ? canBan(selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false

  const senderBareJid = occupant?.jid
    ? getBareJid(occupant.jid)
    : room.nickToJidCache?.get(message.nick) || room.nickToJidCache?.get(occupantIdMatchNick ?? '')
  const contact = senderBareJid ? contactsByJid.get(senderBareJid) : undefined
  const cachedAvatar = room.nickToAvatarCache?.get(message.nick)
    || room.nickToAvatarCache?.get(occupantIdMatchNick ?? '')
  const senderAvatar = occupant?.avatar || cachedAvatar || contact?.avatar

  const resolvedSenderName = occupantIdMatchNick
    || (contact?.name && !occupant ? contact.name : null)
    || message.nick

  return {
    occupant,
    occupantIdMatchNick,
    avatarPresence: room.joined ? (occupant ? getPresenceFromShow(occupant.show) : 'offline') : undefined,
    senderAvatar,
    resolvedSenderName,
    senderRole: occupant?.role,
    senderAffiliation: occupant?.affiliation,
    senderBareJidForBan,
    canModerate: canModerateMsg,
    canBan: !!canBanUser,
    counterpartPresent: message.isPrivate ? whisperCounterpartPresent(message, room.occupants) : true,
  }
}
```

Add `RoomOccupant` to the existing type import at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/roomSenderResolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/roomSenderResolution.ts apps/fluux/src/components/conversation/roomSenderResolution.test.ts
git commit -m "feat(rooms): resolveRoomSender pure per-row sender resolution"
```

---

## Task 3: `resolveReplyAvatar` — reply-target avatar (lifts RoomView.tsx:1244-1254)

The reply preview resolves a DIFFERENT occupant (the quoted message's sender). Extract just the avatar/identifier resolution so the wrapper no longer needs `room.occupants` for it.

**Files:**
- Modify: `apps/fluux/src/components/conversation/roomSenderResolution.ts`
- Test: `apps/fluux/src/components/conversation/roomSenderResolution.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { resolveReplyAvatar } from './roomSenderResolution'

describe('resolveReplyAvatar', () => {
  it('prefers occupant avatar, then cache, then contact', () => {
    const r = room({
      occupants: new Map([['alice', { nick: 'alice', avatar: 'blob:occ' } as any]]),
      nickToAvatarCache: new Map([['alice', 'blob:cache']]),
    })
    const res = resolveReplyAvatar('alice', r, new Map(), 'me', 'blob:own')
    expect(res).toEqual({ avatarUrl: 'blob:occ', avatarIdentifier: 'alice' })
  })
  it('uses own avatar when the reply nick is me', () => {
    expect(resolveReplyAvatar('me', room({}), new Map(), 'me', 'blob:own'))
      .toEqual({ avatarUrl: 'blob:own', avatarIdentifier: 'me' })
  })
  it('returns undefined identifier-safe result for a null nick', () => {
    expect(resolveReplyAvatar(undefined, room({}), new Map(), 'me', undefined))
      .toEqual({ avatarUrl: undefined, avatarIdentifier: 'unknown' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/roomSenderResolution.test.ts -t resolveReplyAvatar`
Expected: FAIL — "resolveReplyAvatar is not a function".

- [ ] **Step 3: Write implementation**

```ts
export function resolveReplyAvatar(
  nick: string | undefined,
  room: Room,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  myNick: string | undefined,
  ownAvatar: string | null | undefined,
): { avatarUrl: string | undefined; avatarIdentifier: string } {
  if (nick === myNick && nick) {
    return { avatarUrl: ownAvatar || undefined, avatarIdentifier: nick }
  }
  const occupantForReply = nick ? room.occupants.get(nick) : undefined
  const senderBareJid = occupantForReply?.jid
    ? getBareJid(occupantForReply.jid)
    : (nick ? room.nickToJidCache?.get(nick) : undefined)
  const contactAvatar = senderBareJid ? contactsByJid.get(senderBareJid)?.avatar : undefined
  const cachedReplyAvatar = nick ? room.nickToAvatarCache?.get(nick) : undefined
  return {
    avatarUrl: occupantForReply?.avatar || cachedReplyAvatar || contactAvatar,
    avatarIdentifier: nick || 'unknown',
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/roomSenderResolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/roomSenderResolution.ts apps/fluux/src/components/conversation/roomSenderResolution.test.ts
git commit -m "feat(rooms): resolveReplyAvatar for reply-preview avatar resolution"
```

---

## Task 4: Stabilize `knownNicks` in RoomMessageList

`knownNicks` (`RoomView.tsx:917-923`) is `useMemo`'d on `room.occupants`, whose ref is replaced on every show flap → it returns a fresh `Set` and busts every row. Replace it with a ref-stable derivation using `stableNickSet`.

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx:917-923`

- [ ] **Step 1: Replace the `knownNicks` memo**

Old (`:916-923`):
```tsx
  // Set of known occupant nicknames for IRC-style mention highlighting
  const knownNicks = useMemo(() => {
    const nicks = new Set<string>()
    for (const nick of room.occupants.keys()) {
      nicks.add(nick)
    }
    return nicks
  }, [room.occupants])
```

New:
```tsx
  // Set of known occupant nicknames for IRC-style mention highlighting.
  // Ref-stable across presence (show/status) churn — only changes when the nick
  // SET changes — so it does not bust every memoized row on each presence stanza.
  const knownNicksRef = useRef<ReadonlySet<string>>(new Set())
  knownNicksRef.current = stableNickSet(room.occupants, knownNicksRef.current)
  const knownNicks = knownNicksRef.current
```

Add `stableNickSet` to the import from `./conversation/roomSenderResolution` (create the import line). `useRef` is already imported (`RoomView.tsx:1`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Run existing RoomView tests to confirm no regression**

Run: `cd apps/fluux && npx vitest run src/components/RoomView.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx
git commit -m "perf(rooms): stabilize knownNicks across presence churn"
```

---

## Task 5: Wire resolution into `renderMessage`; stabilize `replyContext`

Resolve the sender per message and pass resolved props instead of `room`. Stabilize `replyContext` with a per-message cache so its object ref is stable when its inputs are unchanged.

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx` (RoomMessageList body around `:906-1001`)

**Module prerequisite:** add `senderBareJid: string | undefined` to `ResolvedRoomSender` and return it (the superset JID already computed in `resolveRoomSender`). The wrapper needs it to compute `contact` for `senderColor` (`RoomView.tsx:1186`), which uses the occupant-id-fallback JID, NOT `senderBareJidForBan`.

- [ ] **Step 1: Add `selfOccupant` above `renderMessage`**

Insert after the `knownNicks` block (~`:923`):
```tsx
  const selfOccupant = useMemo(
    () => selectSelfOccupant(room.occupants, room.nickname),
    [room.occupants, room.nickname],
  )
```

Import `selectSelfOccupant`, `resolveRoomSender`, `resolveReplyAvatar`, `stableNickSet` from `./conversation/roomSenderResolution`.

- [ ] **Step 2: Rewrite `renderMessage` to resolve + pass slim props (primitives only)**

Replace the `renderMessage` body (`:962-1002`). `msg.replyTo` is a `ReplyInfo` `{ id, to, fallbackBody }` (NOT a string). Derive the reply target the way `buildReplyContext` does (`MessageBubble.tsx:660-661`): `originalMessage = getMessageById(replyTo.id)`, fallback JID = `replyTo.to`. Pass the reply avatar as two **primitives** so no object ever busts the memo — the wrapper builds `replyContext` itself from them.

```tsx
  const renderMessage = (msg: RoomMessage, idx: number, groupMessages: RoomMessage[]) => {
    const sender = resolveRoomSender(msg, room, contactsByJid, selfOccupant)

    // Resolve the reply-preview avatar to primitives (the wrapper builds the
    // replyContext object internally — see Task 6 — so nothing object-shaped
    // is passed that could bust the row memo on presence churn).
    let replyAvatarUrl: string | undefined
    let replyAvatarIdentifier: string | undefined
    if (msg.replyTo) {
      const original = getMessageById(msg.replyTo.id)
      const replyNick = original?.nick || (msg.replyTo.to ? msg.replyTo.to.split('/').pop() : undefined)
      const ra = resolveReplyAvatar(replyNick, room, contactsByJid, room.nickname, ownAvatar)
      replyAvatarUrl = ra.avatarUrl
      replyAvatarIdentifier = ra.avatarIdentifier
    }

    return (
      <RoomMessageBubbleWrapper
        message={msg}
        showAvatar={shouldShowAvatar(groupMessages, idx)}
        whisperThread={whisperThreadPosition(groupMessages, idx)}
        getMessageById={getMessageById}
        roomJid={room.jid}
        myNick={room.nickname}
        supportsReactions={room.supportsReactions !== false}
        occupant={sender.occupant}
        avatarPresence={sender.avatarPresence}
        senderAvatar={sender.senderAvatar}
        resolvedSenderName={sender.resolvedSenderName}
        senderRole={sender.senderRole}
        senderAffiliation={sender.senderAffiliation}
        senderBareJid={sender.senderBareJid}
        senderBareJidForBan={sender.senderBareJidForBan}
        canModerate={sender.canModerate}
        canBan={sender.canBan}
        counterpartPresent={sender.counterpartPresent}
        replyAvatarUrl={replyAvatarUrl}
        replyAvatarIdentifier={replyAvatarIdentifier}
        knownNicks={knownNicks}
        contactsByJid={contactsByJid}
        ownAvatar={ownAvatar}
        sendReaction={sendReaction}
        votePoll={votePoll}
        closePoll={closePoll}
        isPollClosed={closedPollIds.has(msg.id)}
        onReply={onReply}
        onEdit={onEdit}
        isLastOutgoing={msg.id === lastOutgoingMessageId}
        isLastMessage={msg.id === lastMessageId}
        hideToolbar={isComposing || (activeReactionPickerMessageId !== null && activeReactionPickerMessageId !== msg.id)}
        onReactionPickerChange={onReactionPickerChange}
        retractMessage={retractMessage}
        moderateMessage={moderateMessage}
        isSelected={msg.id === selectedMessageId}
        hasKeyboardSelection={hasKeyboardSelection}
        showToolbarForSelection={showToolbarForSelection}
        isDarkMode={isDarkMode}
        onMediaLoad={onMediaLoad}
        isHovered={hoveredMessageId === msg.id}
        onMouseEnter={handleMessageHover}
        onMouseLeave={handleMessageLeave}
        formatTime={formatTime}
        timeFormat={effectiveTimeFormat}
        onNickContextMenu={onNickContextMenu}
        onNickTouchStart={onNickTouchStart}
        onNickTouchEnd={onNickTouchEnd}
        setAffiliation={setAffiliation}
        highlightTerms={highlightTerms}
        isCurrentMatch={msg.id === currentMatchId}
      />
    )
  }
```

> Note: `buildRoomReplyContext` is a thin wrapper (Task 6) around the existing `buildReplyContext` that feeds the resolved `replyAvatar` instead of reading `room` inside the callbacks. `msg.replyTo` is the existing reply-id field — confirm its exact name in `RoomMessage` and adjust if different.

- [ ] **Step 3: Typecheck (expect failures referencing missing wrapper props)**

Run: `npm run typecheck`
Expected: FAIL — `RoomMessageBubbleWrapperProps` does not yet have `occupant`, `roomJid`, etc., and `buildRoomReplyContext` is undefined. This is expected; Task 6 fixes it. Do NOT commit yet.

---

## Task 6: Slim `RoomMessageBubbleWrapper` to consume resolved props

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx` (`RoomMessageBubbleWrapperProps` `:1032-1081`; the wrapper body `:1083-1500`)

- [ ] **Step 1: Replace the prop interface's `room` with the resolved fields**

In `RoomMessageBubbleWrapperProps` remove `room: Room` and add:
```tsx
  roomJid: string
  myNick: string | undefined
  supportsReactions: boolean
  occupant: RoomOccupant | undefined
  avatarPresence: 'online' | 'away' | 'dnd' | 'offline' | undefined
  senderAvatar: string | undefined
  resolvedSenderName: string
  senderRole: RoomRole | undefined
  senderAffiliation: RoomAffiliation | undefined
  senderBareJid: string | undefined          // superset JID, for senderColor's contact lookup
  senderBareJidForBan: string | undefined
  canModerate: boolean
  canBan: boolean
  counterpartPresent: boolean
  replyAvatarUrl: string | undefined          // primitives; wrapper builds replyContext from these
  replyAvatarIdentifier: string | undefined
```

- [ ] **Step 2: Delete the internal resolution; use props**

In the wrapper body delete `:1131-1182` (sender/self/avatar/name/permission resolution). KEEP the `replyContext` build (`:1219-1257`) but rewrite its avatar callback to use the passed primitives instead of `room` (see Step 3). Replace remaining `room.*` reads:
- `room.jid` → `roomJid` (handleReaction `:1201`, handlePollVote `:1216`, `senderOccupantJid` `:1362`, `closePoll` call).
- `room.nickname`/`myNick` → `myNick` prop.
- `room.supportsReactions !== false` (`:1365`) → `supportsReactions` prop.
- `occupant`, `senderAvatar`, `resolvedSenderName`, `canModerateMsg`→`canModerate`, `senderRole`/`senderAffiliation`, `avatarPresence`, `counterpartPresent` → use the props.
- `contact` (for `senderColor` `:1186`): `const contact = senderBareJid ? contactsByJid.get(senderBareJid) : undefined` using the new `senderBareJid` prop (the superset JID, matching the original `:1164-1168`).
- `avatarPresence={...}` (`:1357`) → `avatarPresence={avatarPresence}`.
- `counterpartPresent={...}` (`:1384`) → `counterpartPresent={counterpartPresent}`.

After this, the wrapper must contain **no** reference to `room` (grep to confirm — Step 4).

- [ ] **Step 3: Build `replyContext` inside the wrapper from the avatar primitives**

Replace the existing `buildReplyContext(...)` call in the wrapper body (`:1220-1257`) so its avatar callback returns the passed `replyAvatarUrl`/`replyAvatarIdentifier` props instead of reading `room`. The name and color callbacks already take only `(originalMsg, fallbackId)` and need no `room` — keep them as-is:

```tsx
  const replyContext = buildReplyContext(
    message,
    getMessageById,
    (originalMsg, fallbackId) =>
      originalMsg ? originalMsg.nick : (fallbackId ? fallbackId.split('/').pop() || 'Unknown' : 'Unknown'),
    (originalMsg, fallbackId, dark) => {
      if (originalMsg?.isOutgoing) return 'var(--fluux-text-accent)'
      const nick = originalMsg?.nick || (fallbackId ? fallbackId.split('/').pop() : undefined)
      return nick ? getConsistentTextColor(nick, dark) : 'var(--fluux-brand)'
    },
    () => ({ avatarUrl: replyAvatarUrl, avatarIdentifier: replyAvatarIdentifier ?? 'unknown' }),
    isDarkMode,
  )
```

This builds `replyContext` only when the row actually re-renders — it's a render output, not a prop, so it never affects the memo. `buildReplyContext` returns `undefined` early when `message.replyTo` is absent, so non-reply rows pay nothing.

- [ ] **Step 4: Confirm the wrapper no longer references `room`, then typecheck + tests**

```bash
awk 'NR>=1083 && NR<=1520' apps/fluux/src/components/RoomView.tsx | grep -n 'room\.' || echo "CLEAN: no room.* in wrapper"
```
Expected: `CLEAN`.
Run: `npm run typecheck` → PASS.
Run: `cd apps/fluux && npx vitest run src/components/RoomView.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx
git commit -m "perf(rooms): pass resolved per-row sender data to room message rows"
```

---

## Task 7: Render-count regression guard

Prove the win: a presence flap for one occupant re-renders only that occupant's rows; a join of an unrelated occupant re-renders no existing rows.

**Files:**
- Create: `apps/fluux/src/components/roomRowPresenceMemo.test.tsx`

Follow the EXACT pattern of `apps/fluux/src/components/messageRowMemo.test.tsx`: render `RoomMessageList` DIRECTLY (not full RoomView — avoids the rosterStore mock-gap) with a stub `room` prop; mock `./conversation`'s `MessageBubble` to count renders keyed by `message.id`; drive re-renders with `rerender(...)`. Reuse that file's `ROOM_PROPS` stub shape.

Simulate a presence flap the way `roomStore.addOccupant` does: build a NEW `room` object with a NEW `occupants` Map in which ONLY the flapped occupant's object is a new reference (show changed); every other occupant keeps the SAME object reference. That ref-preservation is what lets unaffected rows bail.

- [ ] **Step 1: Write the guard test**

Three occupants (alice, bob, carol), each authoring some messages. Assertions:

```tsx
// Setup: occupants alice/bob/carol (stable object refs A0,B0,C0); messages from each.
// Render RoomMessageList with room0 = { ...stubRoom, occupants: Map(A0,B0,C0) }.
//
// TEST 1 (the core win) — presence FLAP of alice (set-preserving):
//   room1 = { ...room0, occupants: new Map([['alice', {...A0, show:'away'}], ['bob', B0], ['carol', C0]]) }
//   rerender(<RoomMessageList room={room1} messages={sameMsgsArray} {...ROOM_PROPS} />)
//   EXPECT: alice's rows re-rendered (delta === alice's message count);
//           bob's and carol's rows delta === 0  (memo bailed).
//
// TEST 2 — message APPEND (new messages array, occupants unchanged):
//   rerender with messages=[...msgs, newBobMsg], room=room0
//   EXPECT: every pre-existing row delta === 0 (only the new row mounts).
```

Do NOT assert that an occupant JOIN/LEAVE bails — a nick-set change intentionally
changes `knownNicks` (mention highlighting), so rows re-render by design. Add a
one-line comment in the test documenting this so the omission is not mistaken for a gap.

Assert exact counts, not ranges. Use a real `getPresenceFromShow`-compatible `show` value (e.g. `'away'`) so `avatarPresence` actually changes for the flapped occupant.

- [ ] **Step 2: Run — verify it passes against the new code**

Run: `cd apps/fluux && npx vitest run src/components/roomRowPresenceMemo.test.tsx`
Expected: PASS. (If it FAILS showing all rows re-render on the flap, a `room.*` prop leaked into the wrapper — re-check Task 6 Step 4.)

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/components/roomRowPresenceMemo.test.tsx
git commit -m "test(rooms): guard per-occupant row re-render on presence churn"
```

---

## Task 8: Full verification + perf-harness measurement

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, lint, full app + SDK suites**

```bash
npm run typecheck
npm run lint
cd apps/fluux && npx vitest run
```
Expected: typecheck clean; lint 0 errors; all tests pass with no stderr from changed code.

- [ ] **Step 2: Measure with the demo perf harness (perf-stress-ui skill)**

Per `.claude/skills/perf-stress-ui`: `npm run dev`, open
`http://localhost:5173/demo.html?tutorial=false&stress=rooms:15,messages:150,mode:backfill&perf=1`,
open a deep room, then drive a sustained presence churn:
```js
// fire-and-forget in one eval, read counters in another
for (let i=0;i<60;i++) window.__demoClient.emitSDK('room:occupant-joined', { roomJid, occupant: {/* flap one nick's show */} })
```
Expected: per the `__rc` never-resetting counter recipe, `RoomMessageBubbleWrapper` renders scale with the number of *flapping* occupants, NOT with `messages:150`. Record before/after counts in the PR description.

- [ ] **Step 3: Final commit / PR**

The branch `fix/muc-presence-row-decoupling` is ready for PR. Do not push without maintainer go-ahead.

---

## Self-Review (completed by plan author)

- **Spec coverage:** resolve-in-list/pass-primitives (Tasks 2,5,6); reply-target resolution — *added beyond spec* (Task 3) since the wrapper has a second occupant-resolution site the spec under-specified; `knownNicks` stabilization (Task 4); render-count guard (Task 7); virtualization explicitly excluded (no task). ✓
- **Type consistency:** `ResolvedRoomSender` fields used in Task 5/6 match Task 2's definition; `RoomOccupant`/`RoomRole`/`RoomAffiliation` are the `@fluux/sdk` names (confirmed in `RoomView.tsx:4`). `buildRoomReplyContext` defined in Task 6, used in Task 5 (forward reference — Task 5 typecheck is expected to fail until Task 6; called out in Task 5 Step 3).
- **Known soft spots flagged for the implementer:** (a) confirm `RoomMessage.replyTo` field name; (b) `senderColor`'s `contact` lookup uses `senderBareJid` which may differ from `senderBareJidForBan` — Task 6 Step 2 says verify and, if they diverge, return a `senderColorJid` from `resolveRoomSender`; (c) the guard test must use exact counts.
