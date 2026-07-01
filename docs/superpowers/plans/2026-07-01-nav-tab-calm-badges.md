# Calm Two-Tone Nav-Tab Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a calm grey "new messages" dot on the `#` rooms tab (accent-blue when mentioned or notify-all), keep the DM tab red via a themable token, and align the per-row badges to the same three-tone palette.

**Architecture:** A new pure store selector `roomTabIndicator()` returns `'none' | 'neutral' | 'accent'` for the rooms tab. `IconRailNavLink` gains a `tone` prop mapping to dot colours. A new CSS token `--fluux-badge-strong` de-hardcodes the DM red. Per-row room/DM badges are recoloured to match.

**Tech Stack:** React + TypeScript, Zustand vanilla stores, Tailwind (CSS-variable colour tokens), Vitest + Testing Library.

## Global Constraints

- Three tones, low → high urgency: `neutral` = `bg-fluux-gray` (ambient room unread); `accent` = `bg-fluux-brand` (room mention / notify-all); `strong` = `bg-fluux-badge-strong` (DMs).
- Accent wins over neutral on the rooms tab. Muted rooms are fully silent — they contribute neither tone, even with a mention.
- Tabs render plain dots only (no numeric counts); the existing numeric-badge path (`badgeCount`) is unchanged and keeps `bg-fluux-red`.
- SDK type changes require `npm run build:sdk` before the app typechecks (worktree resolves `@fluux/sdk` to built dist).
- Run tests per-workspace, not bare `vitest` from root.

---

### Task 1: Themable `badge-strong` token + `tone` prop on `IconRailNavLink`

**Files:**
- Modify: `apps/fluux/src/index.css` (after line 361)
- Modify: `apps/fluux/tailwind.config.js` (after line 45)
- Modify: `apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx`
- Test: `apps/fluux/src/components/sidebar-components/IconRailNavLink.test.tsx`

**Interfaces:**
- Produces: `IconRailNavLink` accepts `tone?: 'neutral' | 'accent' | 'strong'` (default `'strong'`). The dot `<span>` colour is `bg-fluux-gray` (neutral), `bg-fluux-brand` (accent), or `bg-fluux-badge-strong` (strong). Tailwind class `bg-fluux-badge-strong` resolves to `var(--fluux-badge-strong)` → `var(--fluux-status-error)`.

- [ ] **Step 1: Add the CSS token.** In `apps/fluux/src/index.css`, immediately after line 361 (`  --fluux-badge-text: var(--fluux-text-on-accent);`), add:

```css
  /* Strong badge (direct messages) — the loudest unread tone. Separate from the
     error red so themes can retune notification urgency without touching danger
     buttons/toasts. Defaults to the status-error red. */
  --fluux-badge-strong: var(--fluux-status-error);
```

- [ ] **Step 2: Expose the Tailwind colour.** In `apps/fluux/tailwind.config.js`, immediately after line 45 (`          'badge-text': 'var(--fluux-badge-text)',`), add:

```js
          'badge-strong': 'var(--fluux-badge-strong)',
```

- [ ] **Step 3: Update the failing tests first.** In `IconRailNavLink.test.tsx`, the two existing dot assertions expect the old red. Change line 114 from:

```tsx
      const badge = container.querySelector('.bg-fluux-red')
```
to:
```tsx
      const badge = container.querySelector('.bg-fluux-badge-strong')
```

And change line 132 the same way (the "should not render badge" test):

```tsx
      const badge = container.querySelector('.bg-fluux-badge-strong')
```

Leave line 345 (`span.bg-fluux-red`, the numeric-badge test) unchanged — the numeric path keeps its red.

- [ ] **Step 4: Add tone tests.** Append this block inside the `describe('rendering', ...)` group in `IconRailNavLink.test.tsx`, after the "should not render badge when showBadge is false" test (after line 134):

```tsx
    it('renders a strong (red) dot by default', () => {
      const Wrapper = createWrapper('/')
      const { container } = render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
          showBadge={true}
        />,
        { wrapper: Wrapper }
      )
      expect(container.querySelector('.bg-fluux-badge-strong')).toBeInTheDocument()
    })

    it('renders a neutral (grey) dot when tone="neutral"', () => {
      const Wrapper = createWrapper('/')
      const { container } = render(
        <IconRailNavLink
          icon={Hash}
          label="Rooms"
          view="rooms"
          pathPrefix="/rooms"
          onNavigate={vi.fn()}
          showBadge={true}
          tone="neutral"
        />,
        { wrapper: Wrapper }
      )
      expect(container.querySelector('.bg-fluux-gray')).toBeInTheDocument()
      expect(container.querySelector('.bg-fluux-badge-strong')).toBeNull()
    })

    it('renders an accent (blue) dot when tone="accent"', () => {
      const Wrapper = createWrapper('/')
      const { container } = render(
        <IconRailNavLink
          icon={Hash}
          label="Rooms"
          view="rooms"
          pathPrefix="/rooms"
          onNavigate={vi.fn()}
          showBadge={true}
          tone="accent"
        />,
        { wrapper: Wrapper }
      )
      const dot = container.querySelector('span.bg-fluux-brand')
      expect(dot).toBeInTheDocument()
    })
```

- [ ] **Step 5: Run the tests to verify they fail.**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/IconRailNavLink.test.tsx`
Expected: FAIL — the `tone` prop doesn't exist yet and the default dot still renders `bg-fluux-red`, so the new/updated assertions fail.

- [ ] **Step 6: Implement the `tone` prop.** In `IconRailNavLink.tsx`, add the prop to the interface. Replace lines 13-15:

```tsx
  showBadge?: boolean
  /** When > 0, renders a red numeric badge (clamped to 99+). Takes precedence over showBadge. */
  badgeCount?: number
```
with:
```tsx
  showBadge?: boolean
  /** Dot colour when showBadge is true. Defaults to 'strong' (red) to preserve prior behaviour. */
  tone?: 'neutral' | 'accent' | 'strong'
  /** When > 0, renders a red numeric badge (clamped to 99+). Takes precedence over showBadge. */
  badgeCount?: number
```

Destructure it: change lines 32-33:

```tsx
  showBadge,
  badgeCount,
```
to:
```tsx
  showBadge,
  tone = 'strong',
  badgeCount,
```

After line 39 (`  const hasCount = ...`), add the tone→class map:

```tsx
  const dotToneClass =
    tone === 'neutral'
      ? 'bg-fluux-gray'
      : tone === 'accent'
        ? 'bg-fluux-brand'
        : 'bg-fluux-badge-strong'
```

Replace the dot span (line 62):

```tsx
          <span className="absolute top-0 end-0 size-3 bg-fluux-red rounded-full border-2 border-fluux-sidebar" />
```
with:
```tsx
          <span className={`absolute top-0 end-0 size-3 ${dotToneClass} rounded-full border-2 border-fluux-sidebar`} />
```

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/IconRailNavLink.test.tsx`
Expected: PASS (all rendering, tone, and numeric-badge tests green).

- [ ] **Step 8: Commit.**

```bash
git add apps/fluux/src/index.css apps/fluux/tailwind.config.js \
  apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx \
  apps/fluux/src/components/sidebar-components/IconRailNavLink.test.tsx
git commit -m "feat(sidebar): add themable badge-strong token and tone prop to IconRailNavLink"
```

---

### Task 2: `roomTabIndicator()` selector in the SDK room store

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (interface near line 548; implementation near line 2487)
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts`

**Interfaces:**
- Produces: `roomTabIndicator: () => 'none' | 'neutral' | 'accent'` on the room store. Returns `'accent'` if any joined, non-muted room has `mentionsCount > 0` or (`notifyAll || notifyAllPersistent`) with `unreadCount > 0`; else `'neutral'` if any joined, non-muted room has `unreadCount > 0`; else `'none'`. Muted rooms are skipped entirely. Return value is a primitive string (stable for Zustand subscriptions).

- [ ] **Step 1: Write the failing tests.** In `roomStore.test.ts`, add this block immediately after the `describe('totalNotifiableUnreadCount', ...)` block closes (after line 1704):

```tsx
  describe('roomTabIndicator', () => {
    it("returns 'none' when there are no rooms", () => {
      expect(roomStore.getState().roomTabIndicator()).toBe('none')
    })

    it("returns 'neutral' for plain unread in a non-muted joined room", () => {
      roomStore.getState().addRoom(createRoom('r1@conference.example.com', {
        joined: true,
        unreadCount: 3,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('neutral')
    })

    it("returns 'accent' when a room has a mention", () => {
      roomStore.getState().addRoom(createRoom('r1@conference.example.com', {
        joined: true,
        unreadCount: 3,
        mentionsCount: 1,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('accent')
    })

    it("returns 'accent' for unread in a notifyAll room (no mention)", () => {
      roomStore.getState().addRoom(createRoom('r1@conference.example.com', {
        joined: true,
        unreadCount: 2,
        notifyAllPersistent: true,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('accent')
    })

    it('lets accent win over neutral across rooms', () => {
      roomStore.getState().addRoom(createRoom('plain@conference.example.com', {
        joined: true,
        unreadCount: 5,
      }))
      roomStore.getState().addRoom(createRoom('mention@conference.example.com', {
        joined: true,
        unreadCount: 1,
        mentionsCount: 1,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('accent')
    })

    it("keeps muted rooms silent, even with a mention ('none')", () => {
      roomStore.getState().addRoom(createRoom('muted@conference.example.com', {
        joined: true,
        unreadCount: 4,
        mentionsCount: 2,
        muted: true,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('none')
    })

    it('ignores non-joined rooms', () => {
      roomStore.getState().addRoom(createRoom('bookmarked@conference.example.com', {
        joined: false,
        isBookmarked: true,
        unreadCount: 9,
        mentionsCount: 3,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('none')
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t roomTabIndicator`
Expected: FAIL — `roomTabIndicator is not a function`.

- [ ] **Step 3: Declare the method on the store interface.** In `roomStore.ts`, after line 548 (`  roomsWithUnreadCount: () => number ...`), add:

```tsx
  roomTabIndicator: () => 'none' | 'neutral' | 'accent' // Rooms tab dot tone
```

- [ ] **Step 4: Implement the selector.** In `roomStore.ts`, immediately after the `roomsWithUnreadCount: () => { ... }` implementation closes (after line 2487), add:

```tsx
  roomTabIndicator: () => {
    let hasNeutral = false
    for (const [jid, entity] of get().roomEntities) {
      if (!entity.joined) continue
      const meta = get().roomMeta.get(jid)
      if (!meta || meta.muted) continue
      const notifyAll = meta.notifyAll || meta.notifyAllPersistent
      if (meta.mentionsCount > 0 || (notifyAll && meta.unreadCount > 0)) {
        return 'accent'
      }
      if (meta.unreadCount > 0) hasNeutral = true
    }
    return hasNeutral ? 'neutral' : 'none'
  },
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t roomTabIndicator`
Expected: PASS (all seven cases green).

- [ ] **Step 6: Rebuild the SDK so the app sees the new type.**

Run: `npm run build:sdk`
Expected: build succeeds with no errors.

- [ ] **Step 7: Commit.**

```bash
git add packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.test.ts
git commit -m "feat(sdk): add roomTabIndicator selector for the rooms tab tone"
```

---

### Task 3: Wire the sidebar tabs to the new tones

**Files:**
- Modify: `apps/fluux/src/components/Sidebar.tsx` (lines 103-104, 113-114, 239-254)
- Modify: `apps/fluux/src/test-setup.ts` (useRoomStore mock, after line 415)
- Modify: `apps/fluux/src/components/Sidebar.archiveToggle.test.tsx` (useRoomStore override, lines 66-69)

**Interfaces:**
- Consumes: `roomTabIndicator()` from Task 2; `tone` prop from Task 1.
- Produces: rooms tab shows a dot (`showBadge`) when the indicator isn't `'none'`, tinted `accent` or `neutral`; DM tab explicitly `tone="strong"`.

- [ ] **Step 1: Add `roomTabIndicator` to the global test mock.** In `apps/fluux/src/test-setup.ts`, in the `useRoomStore` mock state object, after line 415 (`      roomsWithUnreadCount: () => 0,`), add:

```tsx
      roomTabIndicator: () => 'none',
```

- [ ] **Step 2: Update the archiveToggle test override.** In `apps/fluux/src/components/Sidebar.archiveToggle.test.tsx`, replace the `useRoomStore` override (lines 66-69):

```tsx
  useRoomStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      totalMentionsCount: () => 0,
      totalNotifiableUnreadCount: () => 0,
    }),
```
with:
```tsx
  useRoomStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      roomTabIndicator: () => 'none',
    }),
```

- [ ] **Step 3: Replace the room selectors in `Sidebar.tsx`.** Change lines 103-104:

```tsx
  const totalMentionsCount = useRoomStore((s) => s.totalMentionsCount())
  const totalNotifiableUnreadCount = useRoomStore((s) => s.totalNotifiableUnreadCount())
```
to:
```tsx
  const roomTabTone = useRoomStore((s) => s.roomTabIndicator())
```

- [ ] **Step 4: Update the diagnostic tracking.** Change lines 113-114:

```tsx
  trackSelectorChange('Sidebar', 'totalMentionsCount', totalMentionsCount)
  trackSelectorChange('Sidebar', 'totalNotifiableUnreadCount', totalNotifiableUnreadCount)
```
to:
```tsx
  trackSelectorChange('Sidebar', 'roomTabTone', roomTabTone)
```

- [ ] **Step 5: Set the DM tab tone explicitly.** In the messages `IconRailNavLink` (lines 239-246), add a `tone` line after `showBadge={totalUnread > 0}` (line 245):

```tsx
          showBadge={totalUnread > 0}
          tone="strong"
```

- [ ] **Step 6: Drive the rooms tab from the indicator.** In the rooms `IconRailNavLink` (lines 247-254), replace line 253:

```tsx
          showBadge={totalMentionsCount > 0 || totalNotifiableUnreadCount > 0}
```
with:
```tsx
          showBadge={roomTabTone !== 'none'}
          tone={roomTabTone === 'accent' ? 'accent' : 'neutral'}
```

- [ ] **Step 7: Typecheck and run the sidebar test.**

Run: `npm run typecheck && cd apps/fluux && npx vitest run src/components/Sidebar.archiveToggle.test.tsx`
Expected: typecheck passes (no reference to the removed `totalMentionsCount`/`totalNotifiableUnreadCount` locals); Sidebar test PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/fluux/src/components/Sidebar.tsx apps/fluux/src/test-setup.ts \
  apps/fluux/src/components/Sidebar.archiveToggle.test.tsx
git commit -m "feat(sidebar): drive rooms tab dot from roomTabIndicator, DM tab uses strong tone"
```

---

### Task 4: Recolour the per-row badges to match the palette

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/RoomsList.tsx` (lines 432, 437)
- Modify: `apps/fluux/src/components/sidebar-components/ConversationList.tsx` (line 315)

**Interfaces:**
- Consumes: `bg-fluux-gray`, `bg-fluux-badge`/`bg-fluux-badge-text`, `bg-fluux-badge-strong` tokens (Task 1 for `badge-strong`).
- Produces: room unread dot = grey; room mention pill = accent; DM count badge = strong red. No behavioural change — colours only.

- [ ] **Step 1: Recolour the room unread dot.** In `RoomsList.tsx`, change line 432:

```tsx
                <div className="size-2.5 rounded-full bg-fluux-brand flex-shrink-0" />
```
to:
```tsx
                <div className="size-2.5 rounded-full bg-fluux-gray flex-shrink-0" />
```

- [ ] **Step 2: Recolour the room mention pill to accent.** In `RoomsList.tsx`, change line 437:

```tsx
              <span className="min-w-5 h-5 px-1.5 bg-fluux-red text-white text-xs font-bold rounded-full flex-shrink-0 flex items-center justify-center">
```
to:
```tsx
              <span className="min-w-5 h-5 px-1.5 bg-fluux-badge text-fluux-badge-text text-xs font-bold rounded-full flex-shrink-0 flex items-center justify-center">
```

(`bg-fluux-badge` resolves to the same accent fill as `bg-fluux-brand`; the paired `text-fluux-badge-text` guarantees readable text on both light and dark accents.)

- [ ] **Step 3: Recolour the DM count badge to strong.** In `ConversationList.tsx`, change line 315:

```tsx
            <span className="absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 bg-fluux-badge text-fluux-badge-text text-[10px] font-bold rounded-full flex items-center justify-center">
```
to:
```tsx
            <span className="absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 bg-fluux-badge-strong text-white text-[10px] font-bold rounded-full flex items-center justify-center">
```

- [ ] **Step 4: Run the affected component tests + typecheck.**

Run: `npm run typecheck && cd apps/fluux && npx vitest run src/components/sidebar-components/`
Expected: PASS — no test asserts these specific colour classes, so existing tests stay green; typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/fluux/src/components/sidebar-components/RoomsList.tsx \
  apps/fluux/src/components/sidebar-components/ConversationList.tsx
git commit -m "feat(sidebar): align per-row room/DM badges to the three-tone palette"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole workspace.**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run the SDK room-store tests.**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts`
Expected: PASS, including the new `roomTabIndicator` block.

- [ ] **Step 3: Run the affected app tests.**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/IconRailNavLink.test.tsx src/components/Sidebar.archiveToggle.test.tsx src/components/sidebar-components/`
Expected: PASS with no stderr.

- [ ] **Step 4: Manual demo check (optional but recommended).** Run `npm run dev`, open `http://localhost:5173/demo.html`, and confirm: the `#` tab shows a grey dot when rooms have plain unread, a blue dot when a room has a mention or notify-all unread, and nothing when all such rooms are muted/read; the DM tab dot is red; per-row room unread dots are grey, mention pills blue, DM counts red.

---

## Self-Review

**Spec coverage:**
- Palette (grey/accent/strong) → Task 1 (token + tone map), Task 4 (per-row).
- New `--fluux-badge-strong` token → Task 1 Steps 1-2.
- `#` rooms tab neutral/accent/none logic incl. muted-silent + notifyAll-accent + accent-wins → Task 2 selector + tests, Task 3 wiring.
- DM tab keeps red via token → Task 3 Step 5 (`tone="strong"`) + Task 1 token.
- Per-row room mention (red→blue), room unread (blue→grey), DM count (blue→strong) → Task 4.
- Testing (SDK matrix + IconRailNavLink tones) → Task 2 Step 1, Task 1 Step 4.

**Placeholder scan:** none — every code step shows the exact before/after.

**Type consistency:** `roomTabIndicator()` returns `'none' | 'neutral' | 'accent'` in the interface (Task 2 Step 3), implementation (Step 4), mocks (Task 3 Steps 1-2), and consumer (Task 3 Step 6, which maps `'accent'`→`'accent'` else `'neutral'`). `tone` prop union `'neutral' | 'accent' | 'strong'` is identical in the interface (Task 1 Step 6) and every call site (Task 3 Steps 5-6).
