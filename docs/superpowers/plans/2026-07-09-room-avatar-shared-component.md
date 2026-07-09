# RoomAvatar Shared Component Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a single `RoomAvatar` component so every room/group avatar renders as a rounded square with a Hash fallback, and retire the three divergent per-site implementations.

**Architecture:** `RoomAvatar` is a thin wrapper over the existing `Avatar` component that hard-codes `shape="square"` and a size-tuned Hash `fallbackIcon`. Three call sites (`CommandPalette`, `RoomHeader`, `ConversationList`) migrate to it; the sidebar's hand-rolled `<img>` + broken-image state is deleted, inheriting Avatar's WebKit broken-blob detection for free.

**Tech Stack:** React 19 + TypeScript, Tailwind, Vitest + @testing-library/react, lucide-react icons.

## Global Constraints

- Run app unit tests from `apps/fluux` (the repo-root vitest config lacks the `@` alias): `cd apps/fluux && npx vitest run <file>`.
- No new user-facing copy or i18n keys are introduced in this plan.
- Pre-existing typecheck failures in `apps/fluux/src/demo.tsx` (missing `deferredDecrypt` on `DemoClient`, from commit `cac27179`) are OUT OF SCOPE and unrelated; do not attempt to fix them. Judge typecheck success by the absence of NEW errors in the files this plan touches.
- `AvatarSize` = `'xs' | 'sm' | 'header' | 'md' | 'lg' | 'xl'` (exported from `apps/fluux/src/components/Avatar.tsx`).
- Working tree note: `CommandPalette.tsx` currently carries an uncommitted interim one-line fix (`shape={item.type === 'room' ? 'square' : 'circle'}`). Task 2 removes it; its `old_string` below matches that current state.

---

### Task 1: RoomAvatar component

**Files:**
- Create: `apps/fluux/src/components/RoomAvatar.tsx`
- Test: `apps/fluux/src/components/RoomAvatar.test.tsx`

**Interfaces:**
- Consumes: `Avatar`, `AvatarSize` from `./Avatar`; `Hash` from `lucide-react`; `ReactNode` from `react`.
- Produces:
  ```ts
  interface RoomAvatarProps {
    identifier: string        // room JID
    name?: string
    avatarUrl?: string
    size?: AvatarSize         // default 'sm'
    overlay?: ReactNode
    className?: string
  }
  export function RoomAvatar(props: RoomAvatarProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/RoomAvatar.test.tsx`:

```tsx
import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/react'
import { RoomAvatar } from './RoomAvatar'

describe('RoomAvatar', () => {
  test('renders a rounded square, not a circle', () => {
    const { container } = render(<RoomAvatar identifier="team@conference.example.com" name="Team" />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('rounded-xl')
    expect(root.className).not.toContain('rounded-full')
  })

  test('shows the Hash fallback when no avatarUrl is given', () => {
    const { container } = render(<RoomAvatar identifier="team@conference.example.com" name="Team" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  test('renders the image when avatarUrl is provided', () => {
    const { container } = render(
      <RoomAvatar identifier="team@conference.example.com" name="Team" avatarUrl="blob:room" />
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('blob:room')
  })

  test('forwards an overlay', () => {
    const { getByTestId } = render(
      <RoomAvatar identifier="team@conference.example.com" name="Team" overlay={<span data-testid="ov" />} />
    )
    expect(getByTestId('ov')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/RoomAvatar.test.tsx`
Expected: FAIL — cannot resolve `./RoomAvatar` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/fluux/src/components/RoomAvatar.tsx`:

```tsx
import { type ReactNode } from 'react'
import { Hash } from 'lucide-react'
import { Avatar, type AvatarSize } from './Avatar'

/**
 * Hash-icon size per avatar size, tuned to roughly 55-60% of the box so the
 * glyph reads clearly without touching the edges. Keeps the fallback
 * consistent across every room-avatar call site.
 */
const HASH_SIZE: Record<AvatarSize, string> = {
  xs: 'size-3.5',
  sm: 'size-4',
  header: 'size-5',
  md: 'size-6',
  lg: 'size-7',
  xl: 'size-12',
}

export interface RoomAvatarProps {
  /** Room JID. Drives the consistent fallback color and identity. */
  identifier: string
  name?: string
  avatarUrl?: string
  size?: AvatarSize
  /** Optional overlay, e.g. the sidebar typing indicator. */
  overlay?: ReactNode
  className?: string
}

/**
 * A room/group avatar: an {@link Avatar} with the room contract baked in —
 * rounded-square shape and a Hash fallback icon — so no caller has to remember
 * that rooms are square. Rooms have no presence, so no presence props here.
 */
export function RoomAvatar({
  identifier,
  name,
  avatarUrl,
  size = 'sm',
  overlay,
  className,
}: RoomAvatarProps) {
  return (
    <Avatar
      shape="square"
      size={size}
      identifier={identifier}
      name={name}
      avatarUrl={avatarUrl}
      overlay={overlay}
      className={className}
      fallbackIcon={<Hash className={HASH_SIZE[size]} />}
    />
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/RoomAvatar.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/RoomAvatar.tsx apps/fluux/src/components/RoomAvatar.test.tsx
git commit -m "feat(ui): add RoomAvatar shared component"
```

---

### Task 2: Migrate CommandPalette

**Files:**
- Modify: `apps/fluux/src/components/CommandPalette.tsx` (room avatar branch, ~line 661; imports)
- Test: `apps/fluux/src/components/CommandPalette.test.tsx` (add regression lock)

**Interfaces:**
- Consumes: `RoomAvatar` from `./RoomAvatar` (Task 1).

- [ ] **Step 1: Write the failing regression test**

Add this test inside the top-level `describe('CommandPalette', () => { ... })` block in `apps/fluux/src/components/CommandPalette.test.tsx` (e.g. right after the existing `it` that asserts `screen.getByText('Development')` is in the document, ~line 193):

```tsx
    it('renders room rows with a rounded-square avatar, never a circle', () => {
      render(<CommandPalette {...defaultProps} />)
      // "Development" has unreadCount 0 and mentionsCount 0, so its row has no
      // unread badge (badges are rounded-full) — the only shaped element is its avatar.
      const row = screen.getByText('Development').closest('button')!
      expect(row.querySelector('.rounded-xl')).not.toBeNull()
      expect(row.querySelector('.rounded-full')).toBeNull()
    })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "rounded-square"`
Expected: FAIL — the interim Avatar path with `shape={...}` may already pass; if it does, this test is confirming pre-migration behavior. To make the test meaningfully fail-first, temporarily confirm by checking it goes RED against the pre-interim state is NOT required. Proceed: run the test and note the result (PASS is acceptable here because the interim fix already set the shape; the regression lock's purpose is to stay green through the migration).

Note: This is a regression-lock test, not a red-green driver — the interim one-liner already satisfies it. Its value is guarding the behavior once the interim line is deleted in Step 3.

- [ ] **Step 3: Migrate the room branch and imports**

In `apps/fluux/src/components/CommandPalette.tsx`, add the import next to the existing `import { Avatar } from './Avatar'` line (~line 20):

```tsx
import { RoomAvatar } from './RoomAvatar'
```

Replace the entity-avatar block. Old (current working-tree state, ~lines 661-675):

```tsx
                      {item.avatarIdentifier !== undefined ? (
                        <Avatar
                          size={avatarSize}
                          shape={item.type === 'room' ? 'square' : 'circle'}
                          identifier={item.avatarIdentifier}
                          name={item.label}
                          avatarUrl={item.avatarUrl}
                          presence={item.presence}
                          forceOffline={forceOffline}
                          presenceBorderColor="border-fluux-chat"
                          fallbackIcon={
                            item.type === 'room'
                              ? <Hash className={isCompact ? 'size-3.5' : 'size-4'} />
                              : undefined
                          }
                        />
```

New:

```tsx
                      {item.avatarIdentifier !== undefined ? (
                        item.type === 'room' ? (
                          <RoomAvatar
                            size={avatarSize}
                            identifier={item.avatarIdentifier}
                            name={item.label}
                            avatarUrl={item.avatarUrl}
                          />
                        ) : (
                          <Avatar
                            size={avatarSize}
                            identifier={item.avatarIdentifier}
                            name={item.label}
                            avatarUrl={item.avatarUrl}
                            presence={item.presence}
                            forceOffline={forceOffline}
                            presenceBorderColor="border-fluux-chat"
                          />
                        )
```

Note: `Hash` remains imported and used elsewhere in this file (the Views group). `isCompact` remains used elsewhere. Do not remove either import/variable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`
Expected: PASS (all existing tests + the new regression lock; 100 total).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/CommandPalette.test.tsx
git commit -m "refactor(command-palette): render rooms via RoomAvatar"
```

---

### Task 3: Migrate RoomHeader

**Files:**
- Modify: `apps/fluux/src/components/RoomHeader.tsx` (avatar block ~lines 118-133; imports at lines 12 and 28)
- Test: `apps/fluux/src/components/RoomHeader.test.tsx` (existing — must stay green)

**Interfaces:**
- Consumes: `RoomAvatar` from `./RoomAvatar` (Task 1).

- [ ] **Step 1: Migrate the avatar block**

In `apps/fluux/src/components/RoomHeader.tsx`, add the import (near the other component imports at the top of the file):

```tsx
import { RoomAvatar } from './RoomAvatar'
```

Replace the avatar/fallback block. Old (~lines 117-134):

```tsx
      {/* Room Avatar or Icon */}
      {room.avatar ? (
        <Avatar
          identifier={room.jid}
          name={room.name}
          avatarUrl={room.avatar}
          size="header"
          shape="square"
        />
      ) : (
        <div
          className="size-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: generateConsistentColorHexSync(room.jid, { saturation: 60, lightness: 45 }) }}
        >
          <Hash className="size-5 text-white" />
        </div>
      )}
```

New:

```tsx
      {/* Room Avatar or Icon */}
      <RoomAvatar
        identifier={room.jid}
        name={room.name}
        avatarUrl={room.avatar}
        size="header"
      />
```

- [ ] **Step 2: Remove now-unused imports**

`Hash` and `generateConsistentColorHexSync` were only used in the block just deleted (verified: single usage each).

- Remove `Hash,` from the `lucide-react` import (line ~28). Keep every other icon in that import.
- Change the SDK import at line 12 from:
  ```tsx
  import { generateConsistentColorHexSync, getUniqueOccupantCount } from '@fluux/sdk'
  ```
  to:
  ```tsx
  import { getUniqueOccupantCount } from '@fluux/sdk'
  ```
- If `Avatar` is no longer referenced anywhere else in `RoomHeader.tsx`, remove its import too. Verify first: `grep -n "Avatar" apps/fluux/src/components/RoomHeader.tsx` — if the only remaining hits are the removed line and `AvatarCropModal` / `RoomAvatar`, drop the `Avatar` import; otherwise keep it.

- [ ] **Step 3: Run tests + typecheck to verify**

Run: `cd apps/fluux && npx vitest run src/components/RoomHeader.test.tsx`
Expected: PASS (all existing tests).

Run: `cd apps/fluux && npx tsc --noEmit 2>&1 | grep -i "RoomHeader"`
Expected: no output (no new type errors in RoomHeader; unused-import errors would surface here if a removal was wrong).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/RoomHeader.tsx
git commit -m "refactor(room-header): render room avatar via RoomAvatar"
```

---

### Task 4: Migrate ConversationList (retire sidebar duplication)

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/ConversationList.tsx` (avatar block ~lines 291-318; state ~lines 245-246; imports at lines 1, 6-12, 21)

**Interfaces:**
- Consumes: `RoomAvatar` from `../RoomAvatar` (Task 1).

- [ ] **Step 1: Add the import**

In `apps/fluux/src/components/sidebar-components/ConversationList.tsx`, next to `import { Avatar, TypingIndicator } from '../Avatar'` (line ~16):

```tsx
import { RoomAvatar } from '../RoomAvatar'
```

- [ ] **Step 2: Replace the group-chat avatar branch**

Old (~lines 292-307, the `isGroupChat` true branch only):

```tsx
          {isGroupChat ? (
            room?.avatar && !roomAvatarBroken ? (
              <img
                src={room.avatar}
                alt={conversation.name}
                className={`${avatarBox} rounded-xl object-cover`}
                draggable={false}
                onError={() => setRoomAvatarBroken(true)}
                onLoad={(e) => { if (e.currentTarget.naturalWidth === 0) setRoomAvatarBroken(true) }}
              />
            ) : (
              <Hash
                className={`${avatarBox} p-1.5 rounded-xl text-white`}
                style={{ backgroundColor: generateConsistentColorHexSync(conversation.id, { saturation: 60, lightness: 45 }) }}
              />
            )
          ) : (
```

New:

```tsx
          {isGroupChat ? (
            <RoomAvatar
              identifier={conversation.id}
              name={conversation.name}
              avatarUrl={room?.avatar}
              size={avatarSize}
              overlay={isTyping && !isActive ? <TypingIndicator /> : undefined}
            />
          ) : (
```

Note: the `<Avatar>` contact branch (the `: (` else) is unchanged. `avatarBox` may still be used elsewhere in the row (e.g. layout); leave it. The sidebar room Hash icon becomes marginally smaller than before (normalized to match the palette/header) — this is the intended de-divergence.

- [ ] **Step 3: Remove the now-dead broken-image state**

Delete the state and its reset effect (~lines 243-246), i.e. remove:

```tsx
  // (WebKit reclaim across sleep) would otherwise show a broken-image glyph;
  // fall back to the Hash icon instead. Reset when the URL changes.
  const [roomAvatarBroken, setRoomAvatarBroken] = useState(false)
  useEffect(() => { setRoomAvatarBroken(false) }, [room?.avatar])
```

(Keep the preceding lines of that comment block that describe unrelated logic only if they do; the two lines shown above and their immediate comment are what the room-avatar logic owned. Broken-blob handling now lives inside `Avatar`.)

- [ ] **Step 4: Remove now-unused imports**

Verify each is unused after Steps 2-3, then remove:
- `Hash` from `import { Hash, Trash2, Archive, ArchiveRestore, MessageCircle } from 'lucide-react'` (line ~21). Confirm with `grep -n "Hash" apps/fluux/src/components/sidebar-components/ConversationList.tsx` — expect only the import line remains.
- `generateConsistentColorHexSync` from the `@fluux/sdk` import block (line ~9). Confirm with `grep -n "generateConsistentColorHexSync" .../ConversationList.tsx` — expect only the import line remains.
- `useEffect` from `import React, { useState, useRef, useEffect, memo } from 'react'` (line 1) — ONLY if the effect removed in Step 3 was its sole usage. Confirm with `grep -n "useEffect" .../ConversationList.tsx` — if only the import line remains, remove `useEffect`; otherwise keep it. (`useState` stays: it has other usages.)

- [ ] **Step 5: Typecheck to verify no new errors**

Run: `cd apps/fluux && npx tsc --noEmit 2>&1 | grep -i "ConversationList"`
Expected: no output. (Unused-import or unused-var errors would appear here if a removal in Step 4 was wrong or missed.)

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/ConversationList.tsx
git commit -m "refactor(sidebar): render room avatars via RoomAvatar, drop hand-rolled img"
```

---

### Task 5: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: all suites pass, no stderr. In particular RoomAvatar (4), CommandPalette (100), RoomHeader, and the broader suite are green.

- [ ] **Step 2: Build the SDK, then typecheck the app**

Run: `npm run build:sdk && cd apps/fluux && npx tsc --noEmit`
Expected: the ONLY remaining errors are the pre-existing `src/demo.tsx` failures listed in Global Constraints. No errors in `RoomAvatar.tsx`, `CommandPalette.tsx`, `RoomHeader.tsx`, or `ConversationList.tsx`.

- [ ] **Step 3: Visual check in the preview (demo mode)**

Start the worktree dev server (`dev-strict`, port 5180 — strictPort avoids the worktree black-screenshot issue), open `http://localhost:5180/demo.html?tutorial=false`, then verify all three surfaces render rooms as rounded squares:
- Cmd-K palette (type `#`): room rows show `rounded-xl` avatars (Team Chat, Design Review).
- A room header (open a room): avatar is a rounded square.
- Sidebar rooms list: group-chat rows show rounded-square avatars, and the Hash fallback + any room with an image both render correctly.

Confirm via `preview_inspect` / `preview_eval` that the avatar container `border-radius` is `12px` (`rounded-xl`), not `9999px`, at each site.

- [ ] **Step 4: Final commit (if any verification-driven tweaks were needed)**

If Step 3 surfaced a fix, commit it:

```bash
git add -A
git commit -m "fix(ui): <describe verification-driven tweak>"
```

Otherwise no commit is needed — the work is done across Tasks 1-4.

---

## Self-Review

**Spec coverage:**
- RoomAvatar component with baked-in square + Hash fallback + room color → Task 1. ✓
- Discrete-props API (no SDK Room coupling) → Task 1 `RoomAvatarProps`. ✓
- CommandPalette migration, drop `presenceBorderColor` on room rows → Task 2. ✓
- RoomHeader collapse of Avatar + hand-rolled fallback → Task 3. ✓
- ConversationList retire raw `<img>` + `roomAvatarBroken` + local color → Task 4. ✓
- Tests: RoomAvatar unit tests + CommandPalette regression lock → Tasks 1-2; existing suites stay green → Tasks 3-5. ✓
- Out of scope (presence rings, mention avatar, SDK changes) → respected; no task touches them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; unused-import removals are conditional with exact grep verification commands. ✓

**Type consistency:** `RoomAvatarProps` field names (`identifier`, `name`, `avatarUrl`, `size`, `overlay`, `className`) are used identically at all three call sites. `AvatarSize` union matches `Avatar.tsx`. `HASH_SIZE` is keyed by every `AvatarSize` member. ✓
