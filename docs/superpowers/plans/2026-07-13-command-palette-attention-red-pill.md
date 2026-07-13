# Command Palette Attention Red Pill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the command palette's default view, put notify-all rooms with unread into the "Needs attention" group and color the attention-tier pill red, reusing the SDK's `roomActivityTone`.

**Architecture:** A single predicate, `isAttentionItem`, decides both group membership and pill color. Room `CommandItem`s carry an `activityTone` computed via `roomActivityTone(room)` (existing `@fluux/sdk` export). DMs qualify on plain unread. All changes are in `apps/fluux/src/components/CommandPalette.tsx`; no SDK or i18n changes.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react (app workspace, happy-dom).

## Global Constraints

- Change lives entirely in the app layer; **no** SDK, type, or i18n changes.
- Reuse `roomActivityTone` from `@fluux/sdk` — do not re-derive the tone rule in component logic.
- Two-tier pill model must match the sidebar: **red = attention** (`bg-fluux-brand`), **grey = ambient unread** (`bg-fluux-hover`).
- Pills remain default-view only (unchanged guard `isDefaultView && (unreadCount ?? 0) > 0`).
- Tests run per-workspace: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`. Must pass with no stderr.
- The test file fully mocks `@fluux/sdk` (no `importOriginal`); any new SDK symbol the component imports must be added to that mock.

---

### Task 1: Test harness — expose `roomActivityTone` in the SDK mock and make room fixtures overridable

The component will import `roomActivityTone` from `@fluux/sdk`. The test's manual mock must provide it, and the new behavior tests need to inject a notify-all room without disturbing the shared ordering fixtures used by existing tests.

**Files:**
- Modify: `apps/fluux/src/components/CommandPalette.test.tsx`

**Interfaces:**
- Produces: an SDK mock exposing `roomActivityTone(room)` with the same rule as `packages/fluux-sdk/src/stores/roomSelectors.ts`; a reassignable `mockRooms` binding reset per test.

- [ ] **Step 1: Make `mockRooms` reassignable and reset per test**

Change the `mockRooms` declaration (currently `const mockRooms = [...]` at ~line 17) so the array can be swapped by individual tests, mirroring the existing `mockArchivedConversations` pattern. Rename the literal to a default and add a mutable binding:

```typescript
const defaultRooms: Array<{ jid: string; name: string; joined: boolean; unreadCount?: number; mentionsCount?: number; notifyAll?: boolean; notifyAllPersistent?: boolean; muted?: boolean; lastMessage?: { body: string; timestamp?: Date } }> = [
  { jid: 'dev@conference.example.com', name: 'Development', joined: true, unreadCount: 0, mentionsCount: 0, lastMessage: { body: 'PR merged successfully', timestamp: new Date('2026-07-07T08:00:00Z') } },
  { jid: 'general@conference.example.com', name: 'General Chat', joined: true, unreadCount: 3, mentionsCount: 0 },
  { jid: 'announce@conference.example.com', name: 'Announcements', joined: true, unreadCount: 1, mentionsCount: 1, lastMessage: { body: 'Release is out', timestamp: new Date('2026-07-07T11:00:00Z') } },
]
let mockRooms = defaultRooms
```

- [ ] **Step 2: Reset `mockRooms` in the outer `beforeEach`**

In the `beforeEach` (currently ~line 147), add the reset alongside the other resets:

```typescript
    mockRooms = defaultRooms
```

- [ ] **Step 3: Add `roomActivityTone` to the `@fluux/sdk` mock**

In the `vi.mock('@fluux/sdk', () => ({ ... }))` factory (~line 42), add a faithful copy of the selector (the manual mock does not spread the real module, so the logic is inlined here to match `roomSelectors.ts`):

```typescript
  roomActivityTone: (room: { joined?: boolean; muted?: boolean; unreadCount?: number; mentionsCount?: number; notifyAll?: boolean; notifyAllPersistent?: boolean }) => {
    if (!room.joined || room.muted) return 'none'
    const notifyAll = room.notifyAll || room.notifyAllPersistent
    if ((room.mentionsCount ?? 0) > 0 || (notifyAll && (room.unreadCount ?? 0) > 0)) return 'accent'
    if ((room.unreadCount ?? 0) > 0) return 'neutral'
    return 'none'
  },
```

- [ ] **Step 4: Run the existing suite to confirm the harness change is inert**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`
Expected: PASS — all existing tests still green (fixtures unchanged in value; `roomActivityTone` unused by the component yet, so its presence in the mock is harmless).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/CommandPalette.test.tsx
git commit -m "test(command-palette): expose roomActivityTone mock + overridable room fixtures"
```

---

### Task 2: Promote notify-all-unread rooms into "Needs attention" and color the attention pill red

Add `activityTone` to room `CommandItem`s, use `isAttentionItem` for group membership, tier-sort, and pill color.

**Files:**
- Modify: `apps/fluux/src/components/CommandPalette.tsx`
- Test: `apps/fluux/src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `roomActivityTone` and type `RoomActivityTone` from `@fluux/sdk`.
- Produces: `CommandItem.activityTone?: RoomActivityTone`; helper `isAttentionItem(item: CommandItem): boolean`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block near the existing "Needs attention group" / "Unread badge" blocks in `CommandPalette.test.tsx`. It reassigns `mockRooms` to include a notify-all room, and asserts membership + pill colors. The badge span is located by its count text within the row (same approach as the existing "Unread badge" test), and the color is read from that span's `className`.

```typescript
  describe('Notify-all rooms in attention (red pill)', () => {
    function getGroupContainer(labelText: string): HTMLElement {
      const label = screen.getByText(labelText)
      return label.parentElement as HTMLElement
    }

    it('promotes a notify-all room with unread (no mention) into the attention group', () => {
      mockRooms = [
        ...defaultRooms,
        { jid: 'ops@conference.example.com', name: 'Ops Alerts', joined: true, unreadCount: 4, mentionsCount: 0, notifyAllPersistent: true, lastMessage: { body: 'disk 90%', timestamp: new Date('2026-07-07T07:00:00Z') } },
      ]
      render(<CommandPalette {...defaultProps} />)
      const attention = getGroupContainer('Needs attention')
      expect(within(attention).getByText('Ops Alerts')).toBeInTheDocument()
    })

    it('gives a notify-all unread room a red (bg-fluux-brand) pill', () => {
      mockRooms = [
        ...defaultRooms,
        { jid: 'ops@conference.example.com', name: 'Ops Alerts', joined: true, unreadCount: 4, mentionsCount: 0, notifyAllPersistent: true },
      ]
      render(<CommandPalette {...defaultProps} />)
      const row = screen.getByText('Ops Alerts').closest('button')!
      const badge = within(row).getByText('4')
      expect(badge.className).toContain('bg-fluux-brand')
    })

    it('gives an ordinary unread room (not notify-all, no mention) a grey (bg-fluux-hover) pill', () => {
      render(<CommandPalette {...defaultProps} />)
      // General Chat: unread 3, mentionsCount 0, no notify-all -> neutral tone
      const row = screen.getByText('General Chat').closest('button')!
      const badge = within(row).getByText('3')
      expect(badge.className).toContain('bg-fluux-hover')
    })

    it('gives an unread DM a red (bg-fluux-brand) pill', () => {
      render(<CommandPalette {...defaultProps} />)
      // Bob: unreadCount 2 -> attention tier -> red
      const row = screen.getByText('Bob Jones').closest('button')!
      const badge = within(row).getByText('2')
      expect(badge.className).toContain('bg-fluux-brand')
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Notify-all rooms in attention"`
Expected: FAIL — "Ops Alerts" is not in the attention group (current filter keys off `mentionsCount` only); Bob's pill is `bg-fluux-hover` not `bg-fluux-brand` (current color keys off `mentionsCount`).

- [ ] **Step 3: Import the selector and its type**

In `apps/fluux/src/components/CommandPalette.tsx`, extend the existing `@fluux/sdk` import (line 14) to add `roomActivityTone`, and the type-only import (line 18) to add `RoomActivityTone`:

```typescript
import { useChat, useRoom, useRoster, matchNameOrJid, getLocalPart, searchStore, roomActivityTone } from '@fluux/sdk'
```
```typescript
import type { PresenceStatus, RoomActivityTone } from '@fluux/sdk'
```

- [ ] **Step 4: Add `activityTone` to the `CommandItem` interface**

In the `CommandItem` interface (~line 33), add the optional field after `mentionsCount`:

```typescript
  /** Activity tone for room rows, from roomActivityTone(): 'accent' = attention tier. */
  activityTone?: RoomActivityTone
```

- [ ] **Step 5: Add the `isAttentionItem` predicate**

Add this helper next to `roomTier` (~line 159), above `buildDefaultGroups`:

```typescript
// Attention tier: unread DMs, plus rooms whose activity tone is 'accent'
// (a mention, or a notify-all room with unread). Drives both the "Needs
// attention" group membership and the red pill.
function isAttentionItem(item: CommandItem): boolean {
  if (item.type === 'room') return item.activityTone === 'accent'
  return (item.unreadCount ?? 0) > 0
}
```

- [ ] **Step 6: Populate `activityTone` on room items**

In the joined-rooms builder loop (~line 380, the `items.push({ ... })` for `type: 'room'`), add the computed tone after `mentionsCount`:

```typescript
        activityTone: roomActivityTone(room),
```

- [ ] **Step 7: Use `isAttentionItem` for the attention group membership**

In `buildDefaultGroups` (~line 183), replace the two-filter attention computation:

```typescript
  const unreadConvs = conversations.filter((i) => (i.unreadCount ?? 0) > 0)
  const mentionRooms = roomItems.filter((i) => (i.mentionsCount ?? 0) > 0)
  const attention = [...unreadConvs, ...mentionRooms].sort(byRecency).slice(0, ATTENTION_CAP)
```

with the predicate-driven version (interleave attention DMs + attention rooms by recency):

```typescript
  const attentionConvs = conversations.filter(isAttentionItem)
  const attentionRooms = roomItems.filter(isAttentionItem)
  const attention = [...attentionConvs, ...attentionRooms].sort(byRecency).slice(0, ATTENTION_CAP)
```

- [ ] **Step 8: Rank accent rooms at tier 0 in `roomTier`**

Update `roomTier` (~line 160) so leftover-Rooms-group ordering agrees with the new membership rule (accent = top tier, then plain unread, then read):

```typescript
function roomTier(item: CommandItem): number {
  if (item.activityTone === 'accent') return 0
  if ((item.unreadCount ?? 0) > 0) return 1
  return 2
}
```

- [ ] **Step 9: Color the pill by `isAttentionItem`**

In the render (~line 705), change the pill color condition from `(item.mentionsCount ?? 0) > 0` to `isAttentionItem(item)`:

```tsx
                          className={`ms-2 flex-shrink-0 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-xs font-semibold ${
                            isAttentionItem(item)
                              ? 'bg-fluux-brand text-white'
                              : 'bg-fluux-hover text-fluux-text'
                          }`}
```

- [ ] **Step 10: Run the new tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Notify-all rooms in attention"`
Expected: PASS (all four cases).

- [ ] **Step 11: Run the full CommandPalette suite for regressions**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`
Expected: PASS. Note: the existing "does not promote an unread room without a mention" (General Chat) still passes — General Chat has no notify-all, so tone is `neutral`. The "orders rooms mentions-first" test still passes — Announcements is `accent` (tier 0), General Chat `neutral` (tier 1), Development read (tier 2).

- [ ] **Step 12: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 13: Commit**

```bash
git add apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/CommandPalette.test.tsx
git commit -m "feat(command-palette): notify-all rooms in Needs attention + red attention pill"
```

---

## Self-Review

**Spec coverage:**
- "notify-all rooms with unread → Needs attention" → Task 2 Steps 5–7 (`isAttentionItem` + membership). ✓
- "red pill for attention tier (incl. unread DMs)" → Task 2 Step 9. ✓
- "grey pill for ambient unread rooms" → covered by the `else` branch; asserted in Task 2 Step 1 (General Chat). ✓
- "reuse `roomActivityTone`" → Task 2 Steps 3, 6. ✓
- "`roomTier` consistent with membership" → Task 2 Step 8. ✓
- "default-view only, no i18n/SDK changes" → no i18n/SDK files touched; pill guard unchanged. ✓
- Testing (notify-all room in attention + red, ordinary unread grey, unread DM red, mention room unchanged) → Task 2 Step 1 plus existing mention-room tests retained. ✓
- "ensure the mock exposes `roomActivityTone`" → Task 1 Step 3. ✓

**Placeholder scan:** No TBD/TODO; all code shown. ✓

**Type consistency:** `activityTone?: RoomActivityTone` defined (Task 2 Step 4) and set with `roomActivityTone(room)` (Step 6); `isAttentionItem(item: CommandItem): boolean` defined once (Step 5) and used in Steps 7 and 9; `roomTier` reads `activityTone` set in Step 6. Consistent. ✓
