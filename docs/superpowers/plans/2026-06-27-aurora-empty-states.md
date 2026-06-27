# Aurora Empty States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every empty state in the app into a calm Aurora composition via 2-3 shared building blocks: a redesigned hero `EmptyState` (faint accent mark + display title + one-line prompt + primary action where actionable), a shared `ListEmpty` primitive for the scattered list placeholders, and a gentle message-empty.

**Architecture:** A new presentational `ui/ListEmpty` component unifies the inline/list empties. The existing `EmptyState`/`AdminEmptyState` in `ChatLayout.tsx` get an accent mark + display-font title; two of the seven states gain a primary action wired to in-scope handlers (`messages` -> navigate to directory; `rooms` -> open create-room, lifted into `ChatLayout` exactly as `RoomsList` does). The chat/room message-empty adopts the same calm composition. All marks use the theme accent (theme-aware), never the Aurora-only gradient.

**Tech Stack:** React + TypeScript, Tailwind + CSS custom properties, lucide-react, i18next (33 locales), Vitest + Testing Library.

## Global Constraints

- **Theme-aware accent mark (binding):** the decorative mark uses the theme's accent (`fluux-brand` tints + `text-fluux-brand` icon), so it tints per theme. NEVER `--fluux-grad` (Aurora-only; no theme overrides it).
- **Text readable across themes:** empty-state titles use `text-fluux-text`, prompts use `text-fluux-muted` — both must clear WCAG AA on the surface they render on in all 13 themes x 2 modes (the main `EmptyState` renders on the conversation/main surface; guarded by `themeContrast.test.ts`'s text-on-`--fluux-chat-bg` coverage). Confirm/extend in the guard task.
- **Primary action button:** accent fill `bg-fluux-brand hover:bg-fluux-brand-hover` + `text-fluux-text-on-accent` (the existing white-on-accent AA invariant; not re-tuned).
- **Copy / i18n:** KEEP all existing titles/descriptions/hints/list strings. Only NEW keys are `emptyState.messages.action` + `emptyState.rooms.action`, added to ALL 33 locale files (`apps/fluux/src/i18n/locales/*.json`) with genuine translations (the `i18n.test.ts` parity test enforces presence; the project rule is real translations). Search empties keep their i18next inline-default keys (`t('search.noResults', 'No messages found')`) — do NOT promote `search.*` into JSON.
- **No em-dashes / en-dashes** in any new string.
- **Reuse existing handlers, no new flows.** No SDK changes. The contacts view's `SidebarView` value is `'directory'` (never `'contacts'`).
- **`EventsView` stays `return null` when empty** — the main `EmptyState sidebarView="events"` already covers it; do NOT add a ListEmpty there (would double up).

## File Structure

- Create: `apps/fluux/src/components/ui/ListEmpty.tsx` (+ test) — the shared list/inline empty primitive.
- Modify: `apps/fluux/src/components/ChatLayout.tsx` — `EmptyState` + `AdminEmptyState` redesign; lift create-room state; pass primary actions.
- Modify: the list-empty sites (`ConversationList.tsx`, `ContactList.tsx`, `RoomsList.tsx`, `EntityListView.tsx`, `SearchView.tsx`) to use `ListEmpty`.
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` + `RoomView.tsx` — message-empty composition.
- Modify: all 33 `apps/fluux/src/i18n/locales/*.json` — 2 new action keys.
- Create: `apps/fluux/src/themes/emptyStateContrast.test.ts` — cross-theme text guard.
- Modify: `scripts/screenshots.ts` — empty-state scenes.

---

### Task 1: `ListEmpty` shared primitive

**Files:**
- Create: `apps/fluux/src/components/ui/ListEmpty.tsx`
- Test: `apps/fluux/src/components/ui/ListEmpty.test.tsx`

**Interfaces:**
- Produces: `ListEmpty(props: { icon?: LucideIcon; title: string; description?: string; action?: { label: string; icon?: LucideIcon; onClick: () => void }; className?: string })`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Users } from 'lucide-react'
import { ListEmpty } from './ListEmpty'

describe('ListEmpty', () => {
  it('renders the title (and optional icon + description)', () => {
    render(<ListEmpty icon={Users} title="No contacts yet" description="Add someone to get started" />)
    expect(screen.getByText('No contacts yet')).toBeInTheDocument()
    expect(screen.getByText('Add someone to get started')).toBeInTheDocument()
  })
  it('renders an action button that fires onClick', () => {
    const onClick = vi.fn()
    render(<ListEmpty title="No rooms yet" action={{ label: 'Create a room', onClick }} />)
    fireEvent.click(screen.getByText('Create a room'))
    expect(onClick).toHaveBeenCalledOnce()
  })
  it('renders no action button when action is omitted', () => {
    render(<ListEmpty title="Nothing here" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/ui/ListEmpty.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ListEmpty`**

```tsx
import type { LucideIcon } from 'lucide-react'

interface ListEmptyProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: { label: string; icon?: LucideIcon; onClick: () => void }
  className?: string
}

/**
 * Shared empty-state for in-list / in-panel surfaces (conversation list, contacts,
 * search results, admin lists). Restrained composition: a muted icon, a one-line
 * title, an optional sub-line, and an optional accent action. The full-pane hero
 * empty state (no conversation/room selected) is the separate EmptyState in
 * ChatLayout; this is its compact sibling.
 */
export function ListEmpty({ icon: Icon, title, description, action, className = '' }: ListEmptyProps) {
  const ActionIcon = action?.icon
  return (
    <div className={`flex flex-col items-center justify-center text-center text-fluux-muted px-4 py-8 ${className}`}>
      {Icon && <Icon className="size-10 mb-3 opacity-60" />}
      <p className="text-sm">{title}</p>
      {description && <p className="text-xs opacity-75 mt-1 max-w-xs">{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 text-xs text-fluux-brand bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-lg transition-colors"
        >
          {ActionIcon && <ActionIcon className="size-3" />}
          {action.label}
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/ui/ListEmpty.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ui/ListEmpty.tsx apps/fluux/src/components/ui/ListEmpty.test.tsx
git -c commit.gpgsign=false commit -m "feat(empty): shared ListEmpty primitive for list/inline empties"
```

---

### Task 2: Hero `EmptyState` + `AdminEmptyState` visual redesign

**Files:**
- Modify: `apps/fluux/src/components/ChatLayout.tsx` (`EmptyState` ~930-1008, `AdminEmptyState` ~1015-1047)
- Test: `apps/fluux/src/components/ChatLayout.test.tsx`

**Interfaces:**
- Produces: the redesigned `EmptyState` (still `{ sidebarView }` — actions come in Task 3).

- [ ] **Step 1: Write the failing test**

Add to `ChatLayout.test.tsx` (the harness drives `sidebarView` via the initial route):

```tsx
it('renders the empty-state with an accent mark and a display-font title', () => {
  render(<ChatLayoutWithRouter initialRoute="/messages" />)
  // title carries the display font utility
  const title = screen.getByRole('heading', { level: 2 })
  expect(title.className).toMatch(/font-display/)
  // the mark uses the accent, not the flat sidebar gray
  const mark = title.parentElement?.querySelector('.rounded-full')
  expect(mark?.className).toMatch(/fluux-brand/)
  expect(mark?.className).not.toMatch(/bg-fluux-sidebar/)
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/ChatLayout.test.tsx -t "accent mark"`
Expected: FAIL — the mark is `bg-fluux-sidebar`, the title has no `font-display`.

- [ ] **Step 3: Redesign the `EmptyState` JSX**

Replace the `return (...)` block of `EmptyState` (lines ~995-1007) with:

```tsx
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted px-6 text-center">
      <div className="size-24 rounded-full bg-fluux-brand/10 border border-fluux-brand/30 flex items-center justify-center mb-5">
        <Icon className="size-11 text-fluux-brand" />
      </div>
      <h2 className="text-2xl font-semibold font-display text-fluux-text mb-2">{title}</h2>
      <p className="max-w-sm">{description}</p>
      {hint && <p className="max-w-sm mt-2 text-sm opacity-80">{hint}</p>}
    </div>
  )
```

- [ ] **Step 4: Apply the same mark + type to `AdminEmptyState`**

In `AdminEmptyState` (lines ~1015-1047), give the two icon blocks the accent-mark treatment and the heading the display font. Replace the content `<div>` body (the `isAdmin ? ... : ...`) so each branch wraps its icon in the same accent mark:

```tsx
        {isAdmin ? (
          <>
            <div className="size-20 rounded-full bg-fluux-brand/10 border border-fluux-brand/30 flex items-center justify-center mb-4">
              <Server className="size-9 text-fluux-brand" />
            </div>
            <p>{t('admin.selectCommand')}</p>
          </>
        ) : (
          <>
            <div className="size-20 rounded-full bg-fluux-brand/10 border border-fluux-brand/30 flex items-center justify-center mb-4">
              <ShieldOff className="size-9 text-fluux-brand" />
            </div>
            <p className="font-medium text-fluux-text mb-1">{t('admin.noAccess.title')}</p>
            <p className="text-center max-w-md">{t('admin.noAccess.description')}</p>
          </>
        )}
```

(Keep the `AdminEmptyState` header bar unchanged. Its `<h2>{t('admin.title')}</h2>` already inherits the display font via the base `h1-h6` rule.)

- [ ] **Step 5: Run it, verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/ChatLayout.test.tsx`
Expected: PASS (the new test + the existing suite).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/ChatLayout.tsx apps/fluux/src/components/ChatLayout.test.tsx
git -c commit.gpgsign=false commit -m "feat(empty): Aurora accent mark + display-font title on the hero empty states"
```

---

### Task 3: `EmptyState` primary actions (messages + rooms)

**Files:**
- Modify: `apps/fluux/src/components/ChatLayout.tsx`
- Modify: all 33 `apps/fluux/src/i18n/locales/*.json`
- Test: `apps/fluux/src/components/ChatLayout.test.tsx`

**Interfaces:**
- Consumes: `handleSidebarViewChange` (ChatLayout ~543), `CreateRoomModal` (`./CreateRoomModal`).
- Produces: `EmptyState` gains `primaryAction?: { label: string; onClick: () => void }`.

- [ ] **Step 1: Add the i18n action keys**

In `apps/fluux/src/i18n/locales/en.json`, under `emptyState.messages` add `"action": "Start a conversation"` and under `emptyState.rooms` add `"action": "Create a room"`. Then add the same two keys with a genuine translation to EVERY other locale file in `apps/fluux/src/i18n/locales/` (32 more: ar, be, bg, ca, cs, da, de, el, es, et, fi, fr, ga, he, hr, hu, is, it, lt, lv, mt, nb, nl, pl, pt, ro, ru, sk, sl, sv, uk, zh-CN). Real translations, no English placeholders, no em-dashes.

- [ ] **Step 2: Write the failing test**

```tsx
it('shows a primary action on the messages empty-state and not on archive', () => {
  const { rerender } = render(<ChatLayoutWithRouter initialRoute="/messages" />)
  expect(screen.getByText('Start a conversation')).toBeInTheDocument()
  rerender(<ChatLayoutWithRouter initialRoute="/archive" />)
  expect(screen.queryByText('Start a conversation')).toBeNull()
  expect(screen.queryByRole('button', { name: /create a room/i })).toBeNull()
})
```

(If the harness's i18next subset in `test-setup.ts` does not include the new keys, add `emptyState.messages.action`/`emptyState.rooms.action` to that inline subset so the strings render in tests.)

- [ ] **Step 3: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/ChatLayout.test.tsx -t "primary action"`
Expected: FAIL — no action button rendered.

- [ ] **Step 4: Add the `primaryAction` prop + render the button**

In `EmptyState`, change the signature to `{ sidebarView, primaryAction }: { sidebarView: SidebarView; primaryAction?: { label: string; onClick: () => void } }` and add the button after the prompt/hint (import `Plus` from `lucide-react` if not already imported):

```tsx
      {hint && <p className="max-w-sm mt-2 text-sm opacity-80">{hint}</p>}
      {primaryAction && (
        <button
          onClick={primaryAction.onClick}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2 bg-fluux-brand hover:bg-fluux-brand-hover text-fluux-text-on-accent text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="size-4" />
          {primaryAction.label}
        </button>
      )}
```

- [ ] **Step 5: Lift create-room state + wire the actions in `ChatLayout`**

In the `ChatLayout` component body, add state (mirroring `RoomsList`): `const [showCreateRoom, setShowCreateRoom] = useState(false)` (ensure `useState` + `import { CreateRoomModal } from './CreateRoomModal'` are present). At the `<EmptyState sidebarView={sidebarView} />` render site (~line 860), compute + pass the action:

```tsx
            <EmptyState
              sidebarView={sidebarView}
              primaryAction={
                sidebarView === 'messages'
                  ? { label: t('emptyState.messages.action'), onClick: () => handleSidebarViewChange('directory') }
                  : sidebarView === 'rooms'
                  ? { label: t('emptyState.rooms.action'), onClick: () => setShowCreateRoom(true) }
                  : undefined
              }
            />
```

Render the modal near ChatLayout's other modals (e.g. alongside the existing modal renders): `{showCreateRoom && <CreateRoomModal onClose={() => setShowCreateRoom(false)} />}`. Ensure `t` from `useTranslation()` is in scope in `ChatLayout` (add `const { t } = useTranslation()` if the component body does not already have it).

- [ ] **Step 6: Run it, verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/ChatLayout.test.tsx` ; then from repo root `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: both PASS (action shows for messages, hidden for archive; i18n parity green across 33 locales).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/ChatLayout.tsx apps/fluux/src/i18n/locales apps/fluux/src/test-setup.ts apps/fluux/src/components/ChatLayout.test.tsx
git -c commit.gpgsign=false commit -m "feat(empty): primary actions on no-conversation + no-room empty states (33-locale i18n)"
```

---

### Task 4: Apply `ListEmpty` to the list/inline empties

**Files:**
- Modify: `ConversationList.tsx`, `ContactList.tsx`, `RoomsList.tsx`, `EntityListView.tsx`, `SearchView.tsx`
- Test: the existing list-component tests (assert the i18n key still renders)

**Interfaces:**
- Consumes: `ListEmpty` (Task 1). Import `import { ListEmpty } from '@/components/ui/ListEmpty'` (adjust relative path; from `sidebar-components/` it is `../ui/ListEmpty`).

- [ ] **Step 1: Write/extend a failing test**

In `ConversationList`'s test area (or a small new `ConversationList.empty.test.tsx`), assert the empty renders via ListEmpty and still shows the key/string:

```tsx
// rendering ConversationList with zero conversations still shows the empty copy
expect(screen.getByText('conversations.noConversations')).toBeInTheDocument()
```

(Reuse the file's existing mock style where `t` returns the key.)

- [ ] **Step 2: Run it, verify it fails or passes-trivially**

Run the relevant test; it should still pass on the OLD markup (the text is unchanged). The real change is structural — verify after migration the text remains.

- [ ] **Step 3: Migrate each site to `ListEmpty`** (text unchanged; reuse existing keys)

`ConversationList.tsx:88-94` ->
```tsx
  if (conversationIds.length === 0) {
    return <ListEmpty icon={MessageCircle} title={t('conversations.noConversations')} />
  }
```
(import `MessageCircle` from lucide-react.)

`ConversationList.tsx:160-166` (ArchiveList) ->
```tsx
  if (archivedIds.length === 0) {
    return <ListEmpty className="h-full" icon={Archive} title={t('archive.noArchivedConversations')} />
  }
```

`ContactList.tsx:145-152` -> replace the two plain-text branches:
```tsx
        {entries.length === 0 ? (
          <ListEmpty icon={Users} title={t('contacts.noContacts')} />
        ) : flatJids.length === 0 ? (
          <ListEmpty icon={Search} title={t('contacts.noContactsFound')} />
        ) : (
```
(import `Users`, `Search`.)

`RoomsList.tsx:177-198` -> replace the bespoke block with the primitive carrying its action (keep the `showCreateRoom` modal render):
```tsx
  if (sidebarEntries.length === 0) {
    return (
      <>
        <ListEmpty
          icon={Hash}
          title={t('rooms.noRooms')}
          description={t('rooms.noRoomsHint')}
          action={{ label: t('rooms.createRoom'), icon: Plus, onClick: () => setShowCreateRoom(true) }}
        />
        {showCreateRoom && <CreateRoomModal onClose={() => setShowCreateRoom(false)} />}
      </>
    )
  }
```

`EntityListView.tsx:87-90` ->
```tsx
        {items.length === 0 && !isLoading ? (
          <ListEmpty title={emptyMessage} />
        ) : (
```

`SearchView.tsx:212-216` (no-results) -> keep the inline-default key:
```tsx
        {!isSearching && !isInPrefixActive && query && results.length === 0 && mamResults.length === 0 && !isSearchingMAM && (
          <ListEmpty icon={SearchX} title={t('search.noResults', 'No messages found')} />
        )}
```
`SearchView.tsx:315-319` (initial hint) ->
```tsx
        {!query && (
          <ListEmpty icon={Search} title={t('search.hint', 'Type to search across all messages')} />
        )}
```
(import `Search`/`SearchX` as needed.) Do NOT touch `EventsView` (stays `return null`).

- [ ] **Step 4: Run the affected tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components` ; then repo root `npm run typecheck`.
Expected: PASS (text/keys unchanged, structure migrated, no type errors).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components
git -c commit.gpgsign=false commit -m "feat(empty): unify list/inline empties on the ListEmpty primitive"
```

---

### Task 5: Message-empty composition

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` (~420-426), `apps/fluux/src/components/RoomView.tsx` (~957-967)
- Test: a small render test (or extend an existing MessageList/RoomView test)

**Interfaces:**
- Consumes: lucide `MessageCircle`.

- [ ] **Step 1: Improve the 1:1 default empty in `MessageList`**

Replace the internal default (lines ~420-426) so the fallthrough (1:1 chat) gets the calm mark:

```tsx
        {showEmpty && (
          emptyState || (
            <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted h-full gap-3">
              <div className="size-16 rounded-full bg-fluux-brand/10 border border-fluux-brand/25 flex items-center justify-center">
                <MessageCircle className="size-7 text-fluux-brand" />
              </div>
              <p className="text-sm">{t('chat.noMessages')}</p>
            </div>
          )
        )}
```
(import `MessageCircle`.)

- [ ] **Step 2: Match the room empty in `RoomView`**

Update the `emptyState` const (lines ~957-967) to the same composition, keeping the not-joined warning:

```tsx
  const emptyState = (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted gap-3">
      {!isJoined && (
        <div className="flex items-center gap-2 text-fluux-yellow mb-1">
          <AlertCircle className="size-4" />
          <span className="text-sm">{t('rooms.notJoinedNoHistory')}</span>
        </div>
      )}
      <div className="size-16 rounded-full bg-fluux-brand/10 border border-fluux-brand/25 flex items-center justify-center">
        <Hash className="size-7 text-fluux-brand" />
      </div>
      <p className="text-sm">{isJoined ? t('chat.noMessages') : t('rooms.joinToLoadHistory')}</p>
    </div>
  )
```
(import `Hash` if not present. NOTE: the off-brand `text-amber-600 dark:text-amber-400` is replaced with the Aurora `text-fluux-yellow` token for the not-joined warning.)

- [ ] **Step 3: Run tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/conversation src/components/RoomView* 2>/dev/null` ; then repo root `npm run typecheck`.
Expected: PASS / clean (or no matching tests — then rely on typecheck + the screenshot in Task 6).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/components/RoomView.tsx
git -c commit.gpgsign=false commit -m "feat(empty): calm message-empty composition (1:1 + room), tokenize amber warning"
```

---

### Task 6: Cross-theme guard + screenshots + verification

**Files:**
- Create: `apps/fluux/src/themes/emptyStateContrast.test.ts`
- Modify: `scripts/screenshots.ts`
- Verify: typecheck, lint, full suite

**Interfaces:**
- Consumes: `builtinThemes` + the `themeTokens`/contrast helpers mirrored from `themeContrast.test.ts`.

- [ ] **Step 1: Write the empty-state text guard**

Create `apps/fluux/src/themes/emptyStateContrast.test.ts`, mirroring `themeContrast.test.ts`'s per-theme resolution. The hero `EmptyState` renders on the main/conversation surface; assert BOTH `--fluux-text-normal` (title) AND `--fluux-text-muted` (the prompt — the load-bearing new check, since the prompt is the dimmer tier and may not be guarded on chat-bg elsewhere) clear WCAG AA (>= 4.5) on `--fluux-chat-bg` for every builtin theme x mode. Reuse `themeTokens`, `resolve_`, `contrast`, `builtinThemes` from `themeContrast.test.ts` (copying the helpers is the established pattern in the sibling guards).

```ts
import { describe, it, expect } from 'vitest'
import { builtinThemes } from './builtins'
// + block/expand/resolve_/hslToRgb/contrast helpers copied from themeContrast.test.ts
describe('empty-state text contrast on the main surface', () => {
  for (const theme of builtinThemes) {
    for (const mode of ['dark', 'light'] as const) {
      it(`${theme.id}/${mode}: title + prompt clear AA on chat-bg`, () => {
        const vars = themeTokens(theme, mode)
        const bg = resolve_('var(--fluux-chat-bg)', vars)
        expect(contrast(resolve_('var(--fluux-text-normal)', vars), bg)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(resolve_('var(--fluux-text-muted)', vars), bg)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
```

- [ ] **Step 2: Run it**

Run: `cd apps/fluux && npx vitest run src/themes/emptyStateContrast.test.ts`
Expected: PASS for all themes x modes. If `text-muted` fails AA on chat-bg in some theme, STOP and report it (a real readability gap needing a token decision, like #700 / the occupant-panel slice) — do not loosen the threshold.

- [ ] **Step 3: Add empty-state screenshot scenes**

In `scripts/screenshots.ts`, add scenes that capture: the no-conversation empty (messages view, nothing selected — shows the action), the contact-directory empty (directory view, nothing selected), and a list empty, in Aurora dark + light + gruvbox + dracula (use `setTheme`). In demo mode, reach a no-selection state by navigating to a view without selecting an item (mirror how existing scenes navigate; e.g. `navigateTo(page, 'messages')` without `selectItem`, or a fresh demo). Name them `6x-empty-<state>-<theme>`. No em-dashes in labels.

- [ ] **Step 4: Regenerate + eyeball**

Run: `npm run screenshots`. Confirm: the accent mark tints per theme (periwinkle on Aurora, theme accent elsewhere), the title is in the display font, the primary action shows on messages/rooms, list empties are consistent, everything readable in light + dark + accent themes.

- [ ] **Step 5: Full verification**

Run from repo root: `npm run typecheck` (clean), `npm run lint` (0 errors), `npm test` (all pass, no stderr; incl. the new guard + i18n parity + ChatLayout + ListEmpty).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/themes/emptyStateContrast.test.ts scripts/screenshots.ts screenshots/
git -c commit.gpgsign=false commit -m "test(empty): cross-theme empty-state text guard + screenshot scenes"
```

---

## Self-Review notes

- **Spec coverage:** hero EmptyState redesign + actions (Tasks 2-3) · ListEmpty primitive + application to all list/inline empties (Tasks 1, 4) · message-empty (Task 5) · theme-aware accent mark + text guard (all tasks + Task 6) · i18n (2 keys x 33, Task 3) · events stays null + search keeps inline-defaults (Task 4 notes). All covered. Full sweep = the 7 hero states (Task 2) + ~8 list/inline sites (Task 4) + 2 message-empties (Task 5) = 13 surfaces via 2 shared components.
- **Type consistency:** `ListEmpty` props, `EmptyState` `primaryAction?: { label; onClick }`, `SidebarView` value `'directory'` — consistent across tasks.
- **No new SDK** -> no `build:sdk` before typecheck.
- **Known risk flagged:** if `text-muted` is sub-AA on `chat-bg` in some theme (Task 6 Step 2), that is a real gap to surface, not silently patch.
