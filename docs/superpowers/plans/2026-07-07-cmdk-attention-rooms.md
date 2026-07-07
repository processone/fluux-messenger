# Cmd+K "Needs attention" Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Cmd+K default view surface rooms with a mention or unread whisper in the top group, interleaved by recency with unread DMs, under a "Needs attention" label.

**Architecture:** Pure `apps/fluux` change in `CommandPalette.tsx`. Add a `sortTimestamp` to `CommandItem`, populate it from each entity's `lastMessage.timestamp`, and rewrite `buildDefaultGroups` so the top group merges unread DMs + rooms with `mentionsCount > 0` (this single predicate already covers whispers, which bump `mentionsCount` in the SDK). Rooms shown up top are excluded from the rooms group below. No SDK change.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react, react-i18next (33 locale JSON files).

## Global Constraints

- **App-only.** No changes under `packages/fluux-sdk/`.
- **i18n:** new key `commandPalette.attention` must be translated in ALL 33 locale files (`apps/fluux/src/i18n/locales/*.json`). No English placeholders in non-English files. No em-dash (`—`) connectors in any value.
- **Locale edits are surgical:** parse JSON → add the one key → write back with `JSON.stringify(obj, null, 4) + "\n"`. Do not reformat or reorder existing keys.
- **Attention group cap:** 6 items total (named constant).
- **Verify before completion:** `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx` passes with no stderr; `npm run typecheck` passes.

---

### Task 1: Add the `commandPalette.attention` i18n key to all 33 locales

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` (+ 32 sibling locale files)
- Modify: `apps/fluux/src/test-setup.ts` (i18n asserted-label subset, if `attention` is asserted by text)

**Interfaces:**
- Produces: i18n key `commandPalette.attention` resolving to "Needs attention" (English) and the localized equivalent per file.

- [ ] **Step 1: Write the translation script**

Create a throwaway script at `apps/fluux/scripts/add-attention-key.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = new URL('../src/i18n/locales/', import.meta.url).pathname

// "Needs attention" per locale. No em-dashes.
const T = {
  ar: 'تحتاج إلى انتباه', be: 'Патрабуе ўвагі', bg: 'Изисква внимание',
  ca: 'Requereix atenció', cs: 'Vyžaduje pozornost', da: 'Kræver opmærksomhed',
  de: 'Benötigt Aufmerksamkeit', el: 'Χρειάζεται προσοχή', en: 'Needs attention',
  es: 'Requiere atención', et: 'Vajab tähelepanu', fi: 'Vaatii huomiota',
  fr: 'À traiter', ga: 'Aird de dhíth', he: 'דורש תשומת לב',
  hr: 'Zahtijeva pažnju', hu: 'Figyelmet igényel', is: 'Þarfnast athygli',
  it: 'Richiede attenzione', lt: 'Reikia dėmesio', lv: 'Nepieciešama uzmanība',
  mt: 'Jeħtieġ attenzjoni', nb: 'Krever oppmerksomhet', nl: 'Vereist aandacht',
  pl: 'Wymaga uwagi', pt: 'Requer atenção', ro: 'Necesită atenție',
  ru: 'Требует внимания', sk: 'Vyžaduje pozornosť', sl: 'Zahteva pozornost',
  sv: 'Kräver uppmärksamhet', uk: 'Потребує уваги', 'zh-CN': '需要关注',
}

for (const [lang, value] of Object.entries(T)) {
  const path = join(dir, `${lang}.json`)
  const obj = JSON.parse(readFileSync(path, 'utf8'))
  if (!obj.commandPalette) throw new Error(`no commandPalette block in ${lang}.json`)
  obj.commandPalette.attention = value
  writeFileSync(path, JSON.stringify(obj, null, 4) + '\n')
}
console.log(`Added commandPalette.attention to ${Object.keys(T).length} locales`)
```

- [ ] **Step 2: Run the script**

Run: `cd apps/fluux && node scripts/add-attention-key.mjs`
Expected: `Added commandPalette.attention to 33 locales`

- [ ] **Step 3: Verify the key landed and no file was reformatted**

Run: `cd apps/fluux && git diff --stat src/i18n/locales/ | tail -3`
Expected: 33 files changed, each `+1` insertion (one added line). If any file shows a large diff, the round-trip reformatted it — investigate before continuing.

Run: `grep -c '"attention"' src/i18n/locales/*.json | grep -v ':1' || echo "all locales have exactly one"`
Expected: `all locales have exactly one`

- [ ] **Step 4: Delete the throwaway script**

Run: `cd apps/fluux && rm scripts/add-attention-key.mjs`

- [ ] **Step 5: Add the key to the test i18n subset (only if asserted by text)**

Open `apps/fluux/src/test-setup.ts`, find the block that lists `commandPalette.*` label keys used in assertions (search for `commandPalette.unread` or `'Unread'`). If present, add alongside it:

```ts
'commandPalette.attention': 'Needs attention',
```

If `test-setup.ts` has no such literal map for commandPalette labels, skip this step — the CommandPalette test file mocks `react-i18next` locally (Task 2 handles that mock).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/i18n/locales apps/fluux/src/test-setup.ts
git commit -m "i18n(cmdk): add commandPalette.attention key for all locales"
```

---

### Task 2: Rewrite `buildDefaultGroups` to merge attention-rooms into the top group

**Files:**
- Modify: `apps/fluux/src/components/CommandPalette.tsx` (interface `CommandItem` ~L32-52; item construction ~L305-375; `buildDefaultGroups` ~L167-204)
- Test: `apps/fluux/src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `CommandItem` (`type`, `unreadCount`, `mentionsCount`), `roomTier(item)` (existing, unchanged), i18n key `commandPalette.attention` (Task 1).
- Produces: updated `buildDefaultGroups(items, t)` returning the "Needs attention" group first (key `'attention'`), then read-DM group, then rooms group (excluding promoted rooms), then contacts/views/actions unchanged. New `CommandItem.sortTimestamp?: number`.

- [ ] **Step 1: Extend the test mocks with timestamps and the new label**

In `apps/fluux/src/components/CommandPalette.test.tsx`:

Add `timestamp` to the mock `lastMessage` shapes and mention data. Update the type annotations and the mock arrays (around L12-20) so entities carry a comparable recency. Example — set the two mention/unread entities so a mention-room is MORE recent than an unread DM:

```ts
const mockConversations: Array<{ id: string; name: string; unreadCount: number; type: 'chat'; lastMessage?: { body: string; timestamp: Date } }> = [
  { id: 'alice@example.com', name: 'Alice Smith', unreadCount: 0, type: 'chat', lastMessage: { body: 'Can we discuss the deployment?', timestamp: new Date('2026-07-07T09:00:00Z') } },
  { id: 'bob@example.com', name: 'Bob Jones', unreadCount: 2, type: 'chat', lastMessage: { body: 'The exponential backoff is working now', timestamp: new Date('2026-07-07T10:00:00Z') } },
]

const mockRooms: Array<{ jid: string; name: string; joined: boolean; unreadCount?: number; mentionsCount?: number; lastMessage?: { body: string; timestamp?: Date } }> = [
  { jid: 'dev@conference.example.com', name: 'Development', joined: true, unreadCount: 0, mentionsCount: 0, lastMessage: { body: 'PR merged successfully', timestamp: new Date('2026-07-07T08:00:00Z') } },
  { jid: 'general@conference.example.com', name: 'General Chat', joined: true, unreadCount: 3, mentionsCount: 0 },
  { jid: 'announce@conference.example.com', name: 'Announcements', joined: true, unreadCount: 1, mentionsCount: 1, lastMessage: { body: 'Release is out', timestamp: new Date('2026-07-07T11:00:00Z') } },
]
```

In the local `react-i18next` mock's translation map (search for `'commandPalette.unread': 'Unread'`), add:

```ts
'commandPalette.attention': 'Needs attention',
```

- [ ] **Step 2: Write the failing tests**

Add a `describe('Needs attention group', ...)` block. These assert against the rendered default view (empty query):

```ts
describe('Needs attention group', () => {
  it('promotes a room with a mention into the attention group', () => {
    render(<CommandPalette {...defaultProps} />)
    const attention = screen.getByText('Needs attention').closest('[role="group"], div')!
    // Announcements has mentionsCount 1 -> belongs to attention group
    expect(within(attention as HTMLElement).getByText('Announcements')).toBeInTheDocument()
  })

  it('does not promote an unread room without a mention', () => {
    render(<CommandPalette {...defaultProps} />)
    const attention = screen.getByText('Needs attention').closest('[role="group"], div')!
    // General Chat has unreadCount 3 but mentionsCount 0 -> stays in rooms group
    expect(within(attention as HTMLElement).queryByText('General Chat')).not.toBeInTheDocument()
  })

  it('does not duplicate a promoted room in the rooms group', () => {
    render(<CommandPalette {...defaultProps} />)
    // Announcements appears exactly once across the whole default view
    expect(screen.getAllByText('Announcements')).toHaveLength(1)
  })

  it('orders the attention group by most-recent activity', () => {
    render(<CommandPalette {...defaultProps} />)
    const labels = screen.getAllByText(/Announcements|Bob Jones/).map((n) => n.textContent)
    // Announcements (11:00) is newer than Bob Jones DM (10:00) -> appears first
    expect(labels.indexOf('Announcements')).toBeLessThan(labels.indexOf('Bob Jones'))
  })
})
```

> Note on the group selector: adapt `.closest(...)` to how groups are actually rendered in this file (check an existing group-scoped assertion in the test for the real selector/`data-*` attribute). The intent is "assert within the Needs-attention group's subtree."

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Needs attention"`
Expected: FAIL — no element with text "Needs attention" (group not built yet).

- [ ] **Step 4: Add `sortTimestamp` to the `CommandItem` interface**

In `CommandPalette.tsx`, in the `CommandItem` interface (after `mentionsCount`):

```ts
  /** Last-message time (ms) for recency ordering in the attention group. */
  sortTimestamp?: number
```

- [ ] **Step 5: Populate `sortTimestamp` when building conversation and room items**

In the conversation loop (the `items.push({ id: `conv-...` })` call), add:

```ts
        sortTimestamp: conv.lastMessage?.timestamp?.getTime(),
```

In the joined-rooms loop (the `items.push({ id: `room-...` })` call), add:

```ts
        sortTimestamp: room.lastMessage?.timestamp?.getTime(),
```

(Bookmarked-not-joined rooms, contacts, views, actions do not set it — they never enter the attention group.)

- [ ] **Step 6: Rewrite `buildDefaultGroups`**

Replace the current body (the DM-unread / DM-read / rooms section, lines ~170-186) with:

```ts
  const ATTENTION_CAP = 6

  const byRecency = (a: CommandItem, b: CommandItem) =>
    (b.sortTimestamp ?? 0) - (a.sortTimestamp ?? 0)

  const conversations = items.filter((i) => i.type === 'conversation')
  const roomItems = items.filter((i) => i.type === 'room')

  // Top group: unread DMs + rooms with a mention/whisper, interleaved by recency, capped.
  const unreadConvs = conversations.filter((i) => (i.unreadCount ?? 0) > 0)
  const mentionRooms = roomItems.filter((i) => (i.mentionsCount ?? 0) > 0)
  const attention = [...unreadConvs, ...mentionRooms].sort(byRecency).slice(0, ATTENTION_CAP)
  if (attention.length > 0) {
    groups.push({ key: 'attention', type: 'conversation', label: t('commandPalette.attention'), items: attention })
  }
  const promotedIds = new Set(attention.map((i) => i.id))

  // Read DMs stay in their own group below.
  const readConvs = conversations.filter((i) => (i.unreadCount ?? 0) === 0).slice(0, 5)
  if (readConvs.length > 0) {
    groups.push({ key: 'conversation', type: 'conversation', label: t('sidebar.messages'), items: readConvs })
  }

  // Rooms group: everything not already promoted, tier-sorted (mention overflow lands at tier 0).
  const rooms = roomItems
    .filter((i) => !promotedIds.has(i.id))
    .sort((a, b) => roomTier(a) - roomTier(b))
    .slice(0, 4)
  if (rooms.length > 0) {
    groups.push({ key: 'room', type: 'room', label: t('sidebar.rooms'), items: rooms })
  }
```

Leave the contacts / views / actions sections that follow unchanged.

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx -t "Needs attention"`
Expected: PASS (4 tests).

- [ ] **Step 8: Run the full palette test file for regressions**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx`
Expected: PASS, no stderr. If a pre-existing test asserted the old "Unread" DM label, update it to "Needs attention" (the label moved; the group still leads with unread DMs).

- [ ] **Step 9: Typecheck**

Run: `cd apps/fluux && npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/CommandPalette.test.tsx
git commit -m "feat(cmdk): surface mention/whisper rooms in top Needs attention group"
```

---

## Self-Review

**Spec coverage:**
- Top group = unread DMs + `mentionsCount > 0` rooms → Task 2 Step 6. ✓
- Whispers covered by `mentionsCount` predicate (no SDK change) → design; no task needed. ✓
- Interleave by recency → `sortTimestamp` (Steps 4-5) + `byRecency` (Step 6). ✓
- Cap at 6, overflow rooms fall to rooms group at tier 0 → `ATTENTION_CAP` + `promotedIds` filter (Step 6); test covers no-duplicate. ✓
- Rooms group excludes promoted rooms → `promotedIds` filter (Step 6) + duplicate test (Step 2). ✓
- Read DMs unchanged → Step 6 read-DM block. ✓
- Label `commandPalette.attention` "Needs attention", all 33 locales, no em-dash → Task 1. ✓
- Ties/missing timestamp → `?? 0` default in `byRecency` (Step 6); documented in spec Edge cases. ✓

**Placeholder scan:** No TBD/TODO. The one soft spot is the test group-selector (`.closest(...)`), flagged with an instruction to match the file's real group markup — acceptable because the exact selector is file-specific and the reviewer verifies via passing tests.

**Type consistency:** `sortTimestamp?: number` defined in Task 2 Step 4, consumed in Steps 5-6. `timestamp: Date` (`.getTime()` → number) matches `message-base.ts`. `roomTier` reused unchanged. Group `key: 'attention'` is new; no collision with existing keys (`unread` key is retired).
