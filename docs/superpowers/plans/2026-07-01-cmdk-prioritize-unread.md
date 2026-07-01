# Cmd-K Prioritize Unread — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Cmd-K command palette's empty-query view, surface unread chats first — a top "Unread" section for 1:1 DMs, unread-first ordering for rooms, and count badges.

**Architecture:** All changes live in `apps/fluux/src/components/CommandPalette.tsx`. The empty-query ("default") branch of the filter/group IIFE is redirected to a new `buildDefaultGroups()` helper that partitions conversations into unread/read groups and sorts rooms by an unread tier. Unread counts already exist on the SDK `Conversation` (`unreadCount`) and `Room` (`unreadCount`, `mentionsCount`) objects the palette already consumes — no SDK changes. Badges render only in the default view.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react (jsdom), react-i18next.

## Global Constraints

- All changes confined to `apps/fluux/src/components/CommandPalette.tsx` and its test file, plus one i18n key across 33 locale files. No SDK changes.
- Behavior change applies ONLY to the empty-query default view (`!searchQuery && filterMode === 'all'`). Typed-search and prefix-filter (`@`/`#`/`>`) paths must remain byte-for-byte unchanged in output.
- New i18n key `commandPalette.unread` must be added and translated in ALL 33 locale files under `apps/fluux/src/i18n/locales/` — real translations, no English placeholders, no em-dash/en-dash connectors.
- Group display order in default view: **Unread, Messages, Rooms, Connections, Views, Actions** (Unread is new-on-top; the rest preserve today's order).
- Run app tests per-workspace, not from repo root. Verify with `npm run typecheck` before committing.

---

## File Structure

- **Modify:** `apps/fluux/src/components/CommandPalette.tsx`
  - `CommandItem` interface — add `unreadCount?`, `mentionsCount?`.
  - `ItemGroup` interface — add `key: string` (unique render key; `type` alone is no longer unique now that two groups can be `conversation`).
  - `groupItemsByType()` — set `key: type` on emitted groups.
  - New `roomTier()` helper and new `buildDefaultGroups()` helper.
  - Filter/group IIFE — route default view through `buildDefaultGroups`, expose `isDefaultView`.
  - `allItems` builder — populate `unreadCount`/`mentionsCount` on conversation and room items.
  - Render — key groups by `group.key`; render unread badge gated on `isDefaultView`.
- **Modify:** `apps/fluux/src/components/CommandPalette.test.tsx` — extend mocks, add `commandPalette.unread` to the i18n mock, add tests.
- **Modify:** all 33 files in `apps/fluux/src/i18n/locales/*.json` — add `commandPalette.unread`.

---

## Task 1: Unread DM section + dedup from Messages

Introduces the data fields, the `buildDefaultGroups` helper, the group `key`, the i18n key, and routes the default view. Rooms are NOT yet unread-sorted (Task 2) and badges are NOT yet rendered (Task 3).

**Files:**
- Modify: `apps/fluux/src/components/CommandPalette.tsx`
- Modify: `apps/fluux/src/components/CommandPalette.test.tsx`
- Modify: `apps/fluux/src/i18n/locales/*.json` (33 files)
- Test: `apps/fluux/src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: SDK `Conversation.unreadCount: number`, `Room.unreadCount: number`, `Room.mentionsCount: number` (already present on objects returned by `useChat()`/`useRoom()`).
- Produces:
  - `CommandItem` gains `unreadCount?: number` and `mentionsCount?: number`.
  - `ItemGroup` gains `key: string`.
  - `buildDefaultGroups(items: CommandItem[], t: (key: string) => string): ItemGroup[]` — returns groups in order Unread, Messages, Rooms, Connections, Views, Actions, skipping empty groups.
  - The filter/group IIFE returns an added field `isDefaultView: boolean`.

- [ ] **Step 1: Add the i18n key to the English locale**

In `apps/fluux/src/i18n/locales/en.json`, the `commandPalette` block currently ends:

```json
        "searchMessages": "Search messages for \"{{query}}\""
    },
```

Change it to add the new key (note the added comma):

```json
        "searchMessages": "Search messages for \"{{query}}\"",
        "unread": "Unread"
    },
```

- [ ] **Step 2: Add the i18n key to the other 32 locales**

In each remaining locale file, add `"unread": "<translation>"` as the last key of the `commandPalette` object (adding a comma after the previous last key, exactly as in Step 1). Use these translations:

| File | Value |
|------|-------|
| ar.json | `غير مقروءة` |
| be.json | `Непрачытаныя` |
| bg.json | `Непрочетени` |
| ca.json | `No llegits` |
| cs.json | `Nepřečtené` |
| da.json | `Ulæste` |
| de.json | `Ungelesen` |
| el.json | `Μη αναγνωσμένα` |
| es.json | `No leídos` |
| et.json | `Lugemata` |
| fi.json | `Lukematta` |
| fr.json | `Non lus` |
| ga.json | `Neamhléite` |
| he.json | `לא נקראו` |
| hr.json | `Nepročitano` |
| hu.json | `Olvasatlan` |
| is.json | `Ólesin` |
| it.json | `Non letti` |
| lt.json | `Neperskaityti` |
| lv.json | `Nelasīti` |
| mt.json | `Mhux moqrija` |
| nb.json | `Uleste` |
| nl.json | `Ongelezen` |
| pl.json | `Nieprzeczytane` |
| pt.json | `Não lidas` |
| ro.json | `Necitite` |
| ru.json | `Непрочитанные` |
| sk.json | `Neprečítané` |
| sl.json | `Neprebrano` |
| sv.json | `Olästa` |
| uk.json | `Непрочитані` |
| zh-CN.json | `未读` |

- [ ] **Step 3: Write the failing test**

In `apps/fluux/src/components/CommandPalette.test.tsx`, first add the new key to the i18n mock's `translations` map (inside the `vi.mock('react-i18next', ...)` block, alongside the other `commandPalette.*` entries):

```ts
        'commandPalette.unread': 'Unread',
```

Then add this test inside `describe('CommandPalette', ...)` (the existing mock has `Alice Smith` with `unreadCount: 0` and `Bob Jones` with `unreadCount: 2`):

```ts
  describe('Unread section', () => {
    it('shows unread DMs under an Unread header, read DMs under Messages, no duplication', () => {
      render(<CommandPalette {...defaultProps} />)

      // The Unread section header is present
      expect(screen.getByText('Unread')).toBeInTheDocument()

      // Bob (unreadCount 2) appears exactly once, Alice (unreadCount 0) appears exactly once
      expect(screen.getAllByText('Bob Jones')).toHaveLength(1)
      expect(screen.getAllByText('Alice Smith')).toHaveLength(1)

      // Bob's row is above Alice's row (Unread section precedes Messages section)
      const bob = screen.getByText('Bob Jones')
      const alice = screen.getByText('Alice Smith')
      expect(bob.compareDocumentPosition(alice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Unread section"`
Expected: FAIL — `Unable to find an element with the text: Unread` (the section does not exist yet).

- [ ] **Step 5: Add the new fields to `CommandItem` and `ItemGroup`**

In `CommandPalette.tsx`, update the `CommandItem` interface — add these two lines before `action: () => void`:

```ts
  /** Unread message count for conversation/room rows (drives the Unread section + badge). */
  unreadCount?: number
  /** Mention count for room rows (ranks a mentioned room above merely-unread ones). */
  mentionsCount?: number
```

Update the `ItemGroup` interface to add a unique render key:

```ts
interface ItemGroup {
  key: string
  type: ItemType
  label: string
  items: CommandItem[]
}
```

- [ ] **Step 6: Set `key` in `groupItemsByType`**

In `groupItemsByType`, change the `groups.push` call to include `key`:

```ts
    if (typeItems.length > 0) {
      groups.push({ key: type, type, label: t(labelKey), items: typeItems })
    }
```

- [ ] **Step 7: Populate `unreadCount`/`mentionsCount` in the `allItems` builder**

In the conversations loop (`for (const conv of conversations)`), add to the pushed object (e.g. right after `lastMessageBody: conv.lastMessage?.body,`):

```ts
        unreadCount: conv.unreadCount,
```

In the joined-rooms loop (`for (const room of joinedRooms)`), add after `lastMessageBody: room.lastMessage?.body,`:

```ts
        unreadCount: room.unreadCount,
        mentionsCount: room.mentionsCount,
```

(Leave the bookmarked-rooms loop and contacts loop unchanged — they have no unread counts.)

- [ ] **Step 8: Add the `buildDefaultGroups` helper**

Add this function immediately after `groupItemsByType` (before the Component section). Rooms are sliced by recency here; Task 2 adds the unread-tier sort.

```ts
// =============================================================================
// Helper: Build groups for the empty-query default view (unread-first)
// =============================================================================

function buildDefaultGroups(items: CommandItem[], t: (key: string) => string): ItemGroup[] {
  const groups: ItemGroup[] = []

  const conversations = items.filter((i) => i.type === 'conversation')
  const unreadConvs = conversations.filter((i) => (i.unreadCount ?? 0) > 0).slice(0, 5)
  const readConvs = conversations.filter((i) => (i.unreadCount ?? 0) === 0).slice(0, 5)
  if (unreadConvs.length > 0) {
    groups.push({ key: 'unread', type: 'conversation', label: t('commandPalette.unread'), items: unreadConvs })
  }
  if (readConvs.length > 0) {
    groups.push({ key: 'conversation', type: 'conversation', label: t('sidebar.messages'), items: readConvs })
  }

  const rooms = items.filter((i) => i.type === 'room').slice(0, 4)
  if (rooms.length > 0) {
    groups.push({ key: 'room', type: 'room', label: t('sidebar.rooms'), items: rooms })
  }

  const contacts = items.filter((i) => i.type === 'contact').slice(0, 3)
  if (contacts.length > 0) {
    groups.push({ key: 'contact', type: 'contact', label: t('sidebar.connections'), items: contacts })
  }

  const views = items.filter((i) => i.type === 'view').slice(0, 3)
  if (views.length > 0) {
    groups.push({ key: 'view', type: 'view', label: t('commandPalette.views'), items: views })
  }

  const actions = items.filter((i) => i.type === 'action').slice(0, 3)
  if (actions.length > 0) {
    groups.push({ key: 'action', type: 'action', label: t('commandPalette.actions'), items: actions })
  }

  return groups
}
```

- [ ] **Step 9: Route the default view through `buildDefaultGroups`**

Replace the body of the filter/group IIFE. The current code is:

```ts
  const { flatItems, groupedItems, filterMode } = (() => {
    const { filterMode, searchQuery } = parseQuery(query)
    const allowedTypes = getTypesForMode(filterMode)

    let filtered: CommandItem[]

    if (!searchQuery && filterMode === 'all') {
      // Default view: show a balanced mix from each category
      const convs = allItems.filter((i) => i.type === 'conversation').slice(0, 5)
      const conts = allItems.filter((i) => i.type === 'contact').slice(0, 3)
      const rooms = allItems.filter((i) => i.type === 'room').slice(0, 4)
      const views = allItems.filter((i) => i.type === 'view').slice(0, 3)
      const actions = allItems.filter((i) => i.type === 'action').slice(0, 3)
      filtered = [...convs, ...conts, ...rooms, ...views, ...actions]
    } else if (!searchQuery) {
      // Filter mode without search: show all items of matching types
      filtered = allItems.filter((i) => allowedTypes.includes(i.type))
    } else {
      // Search mode: filter by type and query
      filtered = allItems
        .filter((i) => allowedTypes.includes(i.type))
        .filter((i) => itemMatchesQuery(i, searchQuery))
    }

    const grouped = groupItemsByType(filtered, t)
```

Replace everything from `const { flatItems, groupedItems, filterMode } = (() => {` down to `const grouped = groupItemsByType(filtered, t)` (inclusive) with:

```ts
  const { flatItems, groupedItems, filterMode, isDefaultView } = (() => {
    const { filterMode, searchQuery } = parseQuery(query)
    const allowedTypes = getTypesForMode(filterMode)
    const isDefaultView = !searchQuery && filterMode === 'all'

    let grouped: ItemGroup[]
    if (isDefaultView) {
      // Default view: unread-first grouping (Unread DMs on top, then the rest)
      grouped = buildDefaultGroups(allItems, t)
    } else if (!searchQuery) {
      // Filter mode without search: show all items of matching types
      grouped = groupItemsByType(allItems.filter((i) => allowedTypes.includes(i.type)), t)
    } else {
      // Search mode: filter by type and query
      grouped = groupItemsByType(
        allItems
          .filter((i) => allowedTypes.includes(i.type))
          .filter((i) => itemMatchesQuery(i, searchQuery)),
        t,
      )
    }
```

Then update the IIFE's return statement (a few lines below, after the gateway-append block) from:

```ts
    return { flatItems: flat, groupedItems: grouped, filterMode }
```

to:

```ts
    return { flatItems: flat, groupedItems: grouped, filterMode, isDefaultView }
```

- [ ] **Step 10: Add `key` to the search-gateway group literal**

The gateway-append block (a few lines below, runs only for typed search) constructs an `ItemGroup` without a key. Since `ItemGroup` now requires `key`, update that fallback `push`. Change:

```ts
        grouped.push({ type: 'action', label: t('commandPalette.actions'), items: [gatewayItem] })
```

to:

```ts
        grouped.push({ key: 'action', type: 'action', label: t('commandPalette.actions'), items: [gatewayItem] })
```

- [ ] **Step 11: Key groups by `group.key` in render**

In the render, change the group wrapper key from `group.type` to `group.key`:

```tsx
            groupedItems.map((group) => (
              <div key={group.key}>
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Unread section"`
Expected: PASS.

- [ ] **Step 13: Run the full palette test file + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`
Expected: PASS, no stderr.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 14: Commit**

```bash
git add apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/CommandPalette.test.tsx apps/fluux/src/i18n/locales
git commit -m "feat(cmdk): add Unread section for DMs in command palette"
```

---

## Task 2: Rooms unread-first ordering

Sort the Rooms group so mentioned rooms come first, then unread, then read — recency preserved within each tier.

**Files:**
- Modify: `apps/fluux/src/components/CommandPalette.tsx`
- Modify: `apps/fluux/src/components/CommandPalette.test.tsx`
- Test: `apps/fluux/src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `CommandItem.unreadCount`, `CommandItem.mentionsCount` (from Task 1).
- Produces: `roomTier(item: CommandItem): number` — `0` for mentions, `1` for unread, `2` otherwise.

- [ ] **Step 1: Extend the room mocks with unread/mention counts**

In `CommandPalette.test.tsx`, update the `mockRooms` declaration so ordering is testable. Replace:

```ts
const mockRooms: Array<{ jid: string; name: string; joined: boolean; lastMessage?: { body: string } }> = [
  { jid: 'dev@conference.example.com', name: 'Development', joined: true, lastMessage: { body: 'PR merged successfully' } },
  { jid: 'general@conference.example.com', name: 'General Chat', joined: true },
]
```

with (note: `Development` is listed first / more-recent but has no unread; `General Chat` has unread; a new `Announcements` room has a mention — so a correct tier sort must reorder them):

```ts
const mockRooms: Array<{ jid: string; name: string; joined: boolean; unreadCount?: number; mentionsCount?: number; lastMessage?: { body: string } }> = [
  { jid: 'dev@conference.example.com', name: 'Development', joined: true, unreadCount: 0, mentionsCount: 0, lastMessage: { body: 'PR merged successfully' } },
  { jid: 'general@conference.example.com', name: 'General Chat', joined: true, unreadCount: 3, mentionsCount: 0 },
  { jid: 'announce@conference.example.com', name: 'Announcements', joined: true, unreadCount: 1, mentionsCount: 1 },
]
```

- [ ] **Step 2: Write the failing test**

Add inside `describe('CommandPalette', ...)`:

```ts
  describe('Room ordering', () => {
    it('orders rooms mentions-first, then unread, then read', () => {
      render(<CommandPalette {...defaultProps} />)

      const announce = screen.getByText('Announcements') // mention (tier 0)
      const general = screen.getByText('General Chat')    // unread (tier 1)
      const dev = screen.getByText('Development')          // read (tier 2)

      // Announcements before General Chat
      expect(announce.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // General Chat before Development
      expect(general.compareDocumentPosition(dev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Room ordering"`
Expected: FAIL — rooms are still in mock/recency order (`Development` first), so the position assertions fail.

- [ ] **Step 4: Add the `roomTier` helper**

In `CommandPalette.tsx`, add above `buildDefaultGroups`:

```ts
// Unread ranking tier for a room row: mentions outrank plain unread, which outrank read.
function roomTier(item: CommandItem): number {
  if ((item.mentionsCount ?? 0) > 0) return 0
  if ((item.unreadCount ?? 0) > 0) return 1
  return 2
}
```

- [ ] **Step 5: Sort rooms by tier in `buildDefaultGroups`**

In `buildDefaultGroups`, replace:

```ts
  const rooms = items.filter((i) => i.type === 'room').slice(0, 4)
```

with (`.filter` returns a fresh array, so `.sort` does not mutate `allItems`; `Array.prototype.sort` is stable, preserving recency within a tier):

```ts
  const rooms = items
    .filter((i) => i.type === 'room')
    .sort((a, b) => roomTier(a) - roomTier(b))
    .slice(0, 4)
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Room ordering"`
Expected: PASS.

- [ ] **Step 7: Run the full palette test file + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`
Expected: PASS, no stderr.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/CommandPalette.test.tsx
git commit -m "feat(cmdk): order rooms unread-first in command palette default view"
```

---

## Task 3: Unread count badge

Render a count badge on unread items (default view only). Mentioned rooms get an accent-styled badge.

**Files:**
- Modify: `apps/fluux/src/components/CommandPalette.tsx`
- Modify: `apps/fluux/src/components/CommandPalette.test.tsx`
- Test: `apps/fluux/src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `CommandItem.unreadCount`, `CommandItem.mentionsCount`, and the `isDefaultView` flag from the filter/group IIFE (Task 1).
- Produces: no new exported symbols (render-only change).

- [ ] **Step 1: Write the failing test**

Add inside `describe('CommandPalette', ...)`:

```ts
  describe('Unread badge', () => {
    it('shows a count badge for unread DMs in the default view', () => {
      render(<CommandPalette {...defaultProps} />)
      // Bob Jones has unreadCount 2
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    it('does not show unread badges once the user types a query', () => {
      render(<CommandPalette {...defaultProps} />)
      fireEvent.change(screen.getByPlaceholderText('Go to...'), { target: { value: 'Bob' } })
      // Bob still listed, but no "2" badge in search results
      expect(screen.getByText('Bob Jones')).toBeInTheDocument()
      expect(screen.queryByText('2')).not.toBeInTheDocument()
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Unread badge"`
Expected: FAIL — first test cannot find text `2` (no badge rendered yet).

- [ ] **Step 3: Render the badge**

In `CommandPalette.tsx`, in the row `<button>`, insert the badge just before the existing selected-row `↵` kbd block:

```tsx
                      {isSelected && (
                        <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-xs text-fluux-muted bg-fluux-bg rounded border border-fluux-hover">
                          ↵
                        </kbd>
                      )}
```

Add, immediately BEFORE that block:

```tsx
                      {isDefaultView && (item.unreadCount ?? 0) > 0 && (
                        <span
                          className={`ms-2 flex-shrink-0 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-xs font-semibold ${
                            (item.mentionsCount ?? 0) > 0
                              ? 'bg-fluux-brand text-white'
                              : 'bg-fluux-hover text-fluux-text'
                          }`}
                        >
                          {item.unreadCount}
                        </span>
                      )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Unread badge"`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full palette test file + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`
Expected: PASS, no stderr.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/CommandPalette.test.tsx
git commit -m "feat(cmdk): show unread count badges in command palette default view"
```

---

## Final Verification

- [ ] Run the full app test suite for the affected area: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`
- [ ] `npm run typecheck` clean.
- [ ] Manual/demo check (optional but recommended): `npm run dev`, open `http://localhost:5173/demo.html`, press Cmd-K — confirm an "Unread" section appears on top when DMs have unread, rooms with unread/mentions sort first, and count badges show. Clearing the query returns to today's layout when nothing is unread.
