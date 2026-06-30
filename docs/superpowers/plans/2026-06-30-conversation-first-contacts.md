# Conversation-first navigation — relocate Contacts, redistribute roster (Decision 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the conversation list the single spine of the app by moving Contacts from a top-of-rail browsing destination into the bottom utility cluster, surfacing roster management through a `+` "New message" picker, and routing subscription requests into the Contacts destination.

**Architecture:** All changes are app-side (`apps/fluux`); the SDK (`packages/fluux-sdk`) is untouched — the events store already exposes `subscriptionRequests` and `useEvents()` already exposes `acceptSubscription`/`rejectSubscription`. We extend the existing reusable pieces (`IconRailNavLink`, `ContactSelector`, `ContactList`) rather than building parallel ones, and add one new modal (`NewMessageModal`). The master-detail mechanism, routing, and the internal `'directory'` view id are reused as-is.

**Tech Stack:** React 18 + TypeScript, Zustand (vanilla stores via `@fluux/sdk`), React Router v7, react-i18next, Vitest + @testing-library/react, Tailwind (Fluux design tokens).

## Global Constraints

- **Do NOT rename the `SidebarView` value `'directory'`.** It is consumed by ~8 source files plus 5 test files, and `useSessionPersistence.ts:124` persists it — renaming would invalidate persisted session state and is explicitly permitted to stay per the spec's open item. The route is already `/contacts`; only the user-facing **label** changes to "Contacts". (Spec §1 "keeping the old value is acceptable if the rename is costly".)
- **No SDK changes.** Everything reuses existing `@fluux/sdk` exports (`useEvents`, `useEventsStore`, `eventsStore`, `rosterStore`). Do not run `npm run build:sdk` — it is not needed.
- **i18n: every new key must be added to all 33 locale files with a real translation** (no English placeholders) AND to the test-setup i18n subset (`apps/fluux/src/test-setup.ts`). Never use an em-dash (`—`/`–`) as a clause connector in copy. (Project rules.)
- **Component tests** default to the `happy-dom` environment; add `// @vitest-environment jsdom` as the first line only for inline-style/DOM-serialization tests (not needed here). Tests resolve i18n either via the test-setup subset or a local `vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))` that returns the key verbatim.
- **Commands** (run from repo root unless noted):
  - Single app test: `cd apps/fluux && npx vitest run <relative-path>`
  - Single SDK test: `cd packages/fluux-sdk && npx vitest run <relative-path>`
  - Typecheck (all workspaces): `npm run typecheck`
  - Lint: `npm run lint`
  - Affected tests: `./scripts/test-affected.sh`
- **Commits:** never include a Claude footer. Conventional-commit style (`feat:`, `refactor:`, `test:`).

---

## File Structure

**New files**
- `apps/fluux/src/components/NewMessageModal.tsx` — the `+` "New message" picker (modal shell + single-pick `ContactSelector` + "Add contact"/"Manage contacts" rows).
- `apps/fluux/src/components/NewMessageModal.test.tsx` — its tests.
- `apps/fluux/src/components/sidebar-components/SubscriptionRequestItem.tsx` — extracted from `EventsView.tsx` so both the Contacts list and (transitionally) `EventsView` can share one accept/reject/block row.
- `apps/fluux/src/components/sidebar-components/ContactList.requests.test.tsx` — tests for the new Requests section.

**Modified files**
- `apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx` — add numeric `badgeCount` + `badgeLabel` (aria) support, preserving the existing boolean `showBadge` dot.
- `apps/fluux/src/components/sidebar-components/IconRailNavLink.test.tsx` — cover the count badge.
- `apps/fluux/src/components/ContactSelector.tsx` — add an optional single-pick mode (`onPick`).
- `apps/fluux/src/components/ContactSelector.test.tsx` — (create if absent) cover single-pick mode.
- `apps/fluux/src/components/Sidebar.tsx` — move the `Users` link to the bottom cluster, relabel to "Contacts", drive its badge from subscription-request count, drop subscription requests from the Events `pendingCount`, add the `+` to the Messages header, render `NewMessageModal`, and add an `onStartChatWithJid` prop.
- `apps/fluux/src/components/Sidebar.test.tsx` — (create) cover the contacts badge + Events badge change.
- `apps/fluux/src/components/ChatLayout.tsx` — pass `handleStartChatWithJid` to `Sidebar` as `onStartChatWithJid`.
- `apps/fluux/src/components/sidebar-components/ContactList.tsx` — add a top "Requests" section sourced from `useEvents()`.
- `apps/fluux/src/components/sidebar-components/EventsView.tsx` — stop rendering subscription requests; import the extracted `SubscriptionRequestItem`.
- `apps/fluux/src/components/sidebar-components/EventsView.test.tsx` — assert requests no longer render there.
- `apps/fluux/src/components/CommandPalette.tsx` — relabel the directory entry to `sidebar.contacts`.
- `apps/fluux/src/stores/modalStore.ts` — add `'newMessage'` to `ModalName` and state.
- `apps/fluux/src/stores/modalStore.test.ts` — cover the new modal name.
- `apps/fluux/src/i18n/locales/*.json` (33 files) + `apps/fluux/src/test-setup.ts` — new i18n keys.

---

## Task 1: i18n keys for the relocation

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` (+ all 32 other locale files in `apps/fluux/src/i18n/locales/`)
- Modify: `apps/fluux/src/test-setup.ts` (i18n subset, ~lines 29–94)

**Interfaces:**
- Produces (translation keys consumed by later tasks):
  - `sidebar.contacts` → rail label + sidebar title + command palette
  - `newMessage.title`, `newMessage.searchPlaceholder`, `newMessage.manageContacts` → NewMessageModal
  - `contacts.requestsHeading` → ContactList Requests section
  - Reused existing keys (do not recreate): `contacts.addContact`, `common.accept`, `common.reject`, `common.block`, `events.subscriptionRequests`.

- [ ] **Step 1: Add the new keys to `en.json`**

In `apps/fluux/src/i18n/locales/en.json`, under the existing `"sidebar"` object add `"contacts": "Contacts"` (keep the existing `"connections"` key untouched — it may still be referenced elsewhere). Under a `"newMessage"` object (create it) add the picker keys, and under the existing `"contacts"` object add `"requestsHeading"`:

```jsonc
// inside "sidebar": { ... }
"contacts": "Contacts",

// new top-level object "newMessage"
"newMessage": {
  "title": "New message",
  "searchPlaceholder": "Search a person or enter a JID",
  "manageContacts": "Manage contacts"
},

// inside the existing "contacts": { ... } object
"requestsHeading": "Requests"
```

- [ ] **Step 2: Translate the keys into all 32 other locales**

For every other file in `apps/fluux/src/i18n/locales/` (`ar, be, bg, ca, cs, da, de, el, es, et, fi, fr, ga, he, hr, hu, is, it, lt, lv, mt, nb, nl, pl, pt, ro, ru, sk, sl, sv, uk, zh-CN`), add the same keys with a real translation (no English placeholders, no em-dash connectors). Use this table for `sidebar.contacts`:

| locale | value | locale | value | locale | value |
| --- | --- | --- | --- | --- | --- |
| ar | جهات الاتصال | et | Kontaktid | nb | Kontakter |
| be | Кантакты | fi | Yhteystiedot | nl | Contacten |
| bg | Контакти | fr | Contacts | pl | Kontakty |
| ca | Contactes | ga | Teagmhálacha | pt | Contactos |
| cs | Kontakty | he | אנשי קשר | ro | Contacte |
| da | Kontakter | hr | Kontakti | ru | Контакты |
| de | Kontakte | hu | Névjegyek | sk | Kontakty |
| el | Επαφές | is | Tengiliðir | sl | Stiki |
| es | Contactos | it | Contatti | sv | Kontakter |
| | | lt | Kontaktai | uk | Контакти |
| | | lv | Kontakti | zh-CN | 联系人 |
| | | mt | Kuntatti | | |

For `newMessage.title` / `newMessage.searchPlaceholder` / `newMessage.manageContacts` / `contacts.requestsHeading`, translate following the existing tone of each locale file. French values (the maintainer's language — get these exactly right): `newMessage.title` = "Nouveau message", `newMessage.searchPlaceholder` = "Rechercher une personne ou saisir un JID", `newMessage.manageContacts` = "Gérer les contacts", `contacts.requestsHeading` = "Demandes".

- [ ] **Step 3: Add the keys to the test-setup i18n subset**

In `apps/fluux/src/test-setup.ts`, inside `resources.en.translation`, extend the `sidebar` block and add `newMessage` + `contacts.requestsHeading` so component tests that resolve through the subset find them:

```ts
sidebar: {
  search: 'Search',
  settings: 'Settings',
  contacts: 'Contacts',
},
newMessage: {
  title: 'New message',
  searchPlaceholder: 'Search a person or enter a JID',
  manageContacts: 'Manage contacts',
},
contacts: {
  addContact: 'Add contact',
  requestsHeading: 'Requests',
},
```

- [ ] **Step 4: Verify JSON validity and key presence**

Run:
```bash
cd apps/fluux && node -e "const fs=require('fs');const d='src/i18n/locales';let ok=true;for(const f of fs.readdirSync(d)){const j=JSON.parse(fs.readFileSync(d+'/'+f));if(!j.sidebar?.contacts||!j.newMessage?.title||!j.newMessage?.searchPlaceholder||!j.newMessage?.manageContacts||!j.contacts?.requestsHeading){console.log('MISSING in',f);ok=false}}console.log(ok?'ALL OK':'FAILURES')"
```
Expected: `ALL OK`

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales apps/fluux/src/test-setup.ts
git commit -m "i18n: add contacts relocation + new-message picker keys"
```

---

## Task 2: `IconRailNavLink` — numeric count badge + aria label

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx`
- Test: `apps/fluux/src/components/sidebar-components/IconRailNavLink.test.tsx`

**Interfaces:**
- Produces: `IconRailNavLinkProps` gains two optional props:
  - `badgeCount?: number` — when `> 0`, render a red numeric pill (clamped to `99+`); takes precedence over the boolean `showBadge` dot.
  - `badgeLabel?: string` — overrides the button `aria-label` (the tooltip keeps `label`).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `apps/fluux/src/components/sidebar-components/IconRailNavLink.test.tsx`:

```tsx
it('renders a numeric badge with the count when badgeCount > 0', () => {
  const Wrapper = createWrapper('/messages')
  render(
    <IconRailNavLink
      icon={Hash}
      label="Contacts"
      view="directory"
      pathPrefix="/contacts"
      onNavigate={vi.fn()}
      badgeCount={2}
      badgeLabel="Contacts (2)"
    />,
    { wrapper: Wrapper }
  )
  expect(screen.getByText('2')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Contacts (2)' })).toBeInTheDocument()
})

it('clamps a large badge count to 99+', () => {
  const Wrapper = createWrapper('/messages')
  render(
    <IconRailNavLink icon={Hash} label="Contacts" view="directory" pathPrefix="/contacts" onNavigate={vi.fn()} badgeCount={150} />,
    { wrapper: Wrapper }
  )
  expect(screen.getByText('99+')).toBeInTheDocument()
})

it('renders no badge when badgeCount is 0 and showBadge is false', () => {
  const Wrapper = createWrapper('/messages')
  const { container } = render(
    <IconRailNavLink icon={Hash} label="Contacts" view="directory" pathPrefix="/contacts" onNavigate={vi.fn()} badgeCount={0} />,
    { wrapper: Wrapper }
  )
  expect(container.querySelector('span.bg-fluux-red')).toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/IconRailNavLink.test.tsx`
Expected: FAIL (the `badgeCount`/`badgeLabel` props do not exist yet; `2` / `99+` not found).

- [ ] **Step 3: Implement the count badge**

In `apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx`, extend the interface and rendering:

```tsx
interface IconRailNavLinkProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  /** The view this button navigates to */
  view: SidebarView
  /** Path prefix to match for active state (e.g., '/messages', '/rooms') */
  pathPrefix: string
  showBadge?: boolean
  /** When > 0, renders a red numeric badge (clamped to 99+). Takes precedence over showBadge. */
  badgeCount?: number
  /** Overrides the button aria-label (the tooltip still shows `label`). */
  badgeLabel?: string
  /** Handler called when clicked - should handle navigation */
  onNavigate: (view: SidebarView) => void
}

export function IconRailNavLink({
  icon: Icon,
  label,
  view,
  pathPrefix,
  showBadge,
  badgeCount,
  badgeLabel,
  onNavigate,
}: IconRailNavLinkProps) {
  const location = useLocation()
  const isActive = location.pathname === pathPrefix || location.pathname.startsWith(pathPrefix + '/')
  const hasCount = typeof badgeCount === 'number' && badgeCount > 0

  return (
    <Tooltip content={label} position="right" delay={500}>
      <button
        onClick={() => onNavigate(view)}
        aria-label={badgeLabel ?? label}
        data-nav={view}
        className={`
          icon-rail-btn relative rounded-xl flex items-center justify-center transition-colors
          focus-visible:ring-2 focus-visible:ring-fluux-brand focus-visible:ring-offset-2 focus-visible:ring-offset-fluux-sidebar
          ${isActive
            ? 'bg-fluux-brand text-fluux-text-on-accent'
            : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'
          }
        `}
      >
        <Icon className="size-5" />
        {hasCount ? (
          <span className="absolute -top-0.5 -end-0.5 min-w-4 h-4 px-1 flex items-center justify-center bg-fluux-red text-white text-[10px] leading-none font-semibold rounded-full border-2 border-fluux-sidebar">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        ) : showBadge ? (
          <span className="absolute top-0 end-0 size-3 bg-fluux-red rounded-full border-2 border-fluux-sidebar" />
        ) : null}
      </button>
    </Tooltip>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/IconRailNavLink.test.tsx`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx apps/fluux/src/components/sidebar-components/IconRailNavLink.test.tsx
git commit -m "feat(sidebar): add numeric count badge to IconRailNavLink"
```

---

## Task 3: `ContactSelector` — single-pick mode

**Files:**
- Modify: `apps/fluux/src/components/ContactSelector.tsx`
- Test: `apps/fluux/src/components/ContactSelector.test.tsx` (create if it does not exist)

**Interfaces:**
- Produces: `ContactSelectorProps` gains `onPick?: (jid: string) => void`. When provided, the component operates in single-pick mode: choosing a roster row, or pressing Enter on a valid typed JID, calls `onPick(jid)` exactly once and does **not** mutate `selectedContacts` (no chips). Existing multi-select behavior (used by `CreateQuickChatModal`) is unchanged when `onPick` is omitted.
- Consumes: existing `selectContact` choke point (called by both click and the Enter handler at `ContactSelector.tsx:227`/`:230`), and the existing `canAddAsJid`/`searchJidNormalized` raw-JID logic.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/components/ContactSelector.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContactSelector } from './ContactSelector'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// Roster provided via extraSuggestions so the test does not depend on the SDK roster store.
function renderPicker(onPick: (jid: string) => void) {
  return render(
    <ContactSelector
      selectedContacts={[]}
      onSelectionChange={vi.fn()}
      onPick={onPick}
      extraSuggestions={[{ jid: 'alice@example.com', name: 'Alice' }]}
    />
  )
}

describe('ContactSelector single-pick mode', () => {
  it('calls onPick once with a typed valid JID on Enter and does not add a chip', () => {
    const onPick = vi.fn()
    const onSelectionChange = vi.fn()
    render(
      <ContactSelector selectedContacts={[]} onSelectionChange={onSelectionChange} onPick={onPick} />
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'bob@example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('bob@example.com')
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('calls onPick when a roster suggestion is clicked', () => {
    const onPick = vi.fn()
    renderPicker(onPick)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Alice' } })
    fireEvent.click(screen.getByText('Alice'))
    expect(onPick).toHaveBeenCalledWith('alice@example.com')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/ContactSelector.test.tsx`
Expected: FAIL (`onPick` prop not yet honored; `onSelectionChange` is called instead).

- [ ] **Step 3: Implement single-pick mode**

In `apps/fluux/src/components/ContactSelector.tsx`, add `onPick` to the props interface (after `extraSuggestions`):

```tsx
export interface ContactSelectorProps {
  selectedContacts: string[]
  onSelectionChange: (jids: string[]) => void
  placeholder?: string
  addMorePlaceholder?: string
  disabled?: boolean
  excludeJids?: string[]
  extraSuggestions?: Array<{ jid: string; name?: string }>
  /** Single-pick mode: when set, selecting a contact or typing a JID + Enter calls this once and skips chip selection. */
  onPick?: (jid: string) => void
}
```

Destructure it in the component signature (add `onPick,` to the parameter list), and short-circuit `selectContact`:

```tsx
const selectContact = (jid: string) => {
  if (onPick) {
    onPick(jid)
    setSearch('')
    setHighlightedIndex(0)
    return
  }
  if (!selectedContacts.includes(jid)) {
    onSelectionChange([...selectedContacts, jid])
  }
  setSearch('')
  setHighlightedIndex(0)
  inputRef.current?.focus()
}
```

(No other change is required: both the click handler on dropdown rows and the Enter handler at lines 225–231 already route through `selectContact`, so roster picks and the `canAddAsJid` raw-JID path both flow to `onPick`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/ContactSelector.test.tsx`
Expected: PASS

Then confirm no regression in the existing consumer test:
Run: `cd apps/fluux && npx vitest run src/components/CreateQuickChatModal` (skip if no such test file exists)
Expected: PASS or "no test files" — multi-select path untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ContactSelector.tsx apps/fluux/src/components/ContactSelector.test.tsx
git commit -m "feat(contacts): add single-pick mode to ContactSelector"
```

---

## Task 4: `NewMessageModal` + `modalStore` entry

**Files:**
- Modify: `apps/fluux/src/stores/modalStore.ts`
- Modify: `apps/fluux/src/stores/modalStore.test.ts`
- Create: `apps/fluux/src/components/NewMessageModal.tsx`
- Create: `apps/fluux/src/components/NewMessageModal.test.tsx`

**Interfaces:**
- Produces:
  - `ModalName` gains `'newMessage'`; `ModalStoreState` gains a `newMessage: boolean` field.
  - `NewMessageModal` component with props:
    ```ts
    interface NewMessageModalProps {
      onClose: () => void
      onPick: (jid: string) => void          // open/start the 1:1 conversation for this JID
      onAddContact: () => void               // open the Add-contact modal
      onManageContacts: () => void           // navigate to the Contacts destination
    }
    ```
- Consumes: `ModalShell` (`title`, `onClose`, `width`, `panelClassName`), `ContactSelector` (`onPick`), keys from Task 1.

- [ ] **Step 1: Write the failing modalStore test**

Append to `apps/fluux/src/stores/modalStore.test.ts`:

```ts
it('opens and closes the newMessage modal', () => {
  useModalStore.getState().open('newMessage')
  expect(useModalStore.getState().newMessage).toBe(true)
  useModalStore.getState().close('newMessage')
  expect(useModalStore.getState().newMessage).toBe(false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/stores/modalStore.test.ts`
Expected: FAIL (`'newMessage'` is not a valid `ModalName`; `newMessage` field undefined).

- [ ] **Step 3: Add `'newMessage'` to the modal store**

In `apps/fluux/src/stores/modalStore.ts`, add `'newMessage'` to the `ModalName` union, add `newMessage: boolean` to `ModalStoreState`, and initialize it to `false` in the store's initial state (mirror the existing `addContact` entry in each place — the union, the state interface, and the `create(...)` initial object).

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/stores/modalStore.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing NewMessageModal test**

Create `apps/fluux/src/components/NewMessageModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewMessageModal } from './NewMessageModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

function setup() {
  const onClose = vi.fn()
  const onPick = vi.fn()
  const onAddContact = vi.fn()
  const onManageContacts = vi.fn()
  render(
    <NewMessageModal onClose={onClose} onPick={onPick} onAddContact={onAddContact} onManageContacts={onManageContacts} />
  )
  return { onClose, onPick, onAddContact, onManageContacts }
}

describe('NewMessageModal', () => {
  it('renders the picker title and action rows', () => {
    setup()
    expect(screen.getByText('newMessage.title')).toBeInTheDocument()
    expect(screen.getByText('contacts.addContact')).toBeInTheDocument()
    expect(screen.getByText('newMessage.manageContacts')).toBeInTheDocument()
  })

  it('picks a typed JID and closes', () => {
    const { onPick, onClose } = setup()
    const input = screen.getByPlaceholderText('newMessage.searchPlaceholder')
    fireEvent.change(input, { target: { value: 'carol@example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('carol@example.com')
    expect(onClose).toHaveBeenCalled()
  })

  it('invokes onAddContact and onManageContacts from the rows', () => {
    const { onAddContact, onManageContacts } = setup()
    fireEvent.click(screen.getByText('contacts.addContact'))
    expect(onAddContact).toHaveBeenCalled()
    fireEvent.click(screen.getByText('newMessage.manageContacts'))
    expect(onManageContacts).toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/NewMessageModal.test.tsx`
Expected: FAIL (module does not exist).

- [ ] **Step 7: Implement `NewMessageModal`**

Create `apps/fluux/src/components/NewMessageModal.tsx`:

```tsx
import { useTranslation } from 'react-i18next'
import { UserPlus, Users } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { ContactSelector } from './ContactSelector'

interface NewMessageModalProps {
  onClose: () => void
  onPick: (jid: string) => void
  onAddContact: () => void
  onManageContacts: () => void
}

export function NewMessageModal({ onClose, onPick, onAddContact, onManageContacts }: NewMessageModalProps) {
  const { t } = useTranslation()

  return (
    <ModalShell title={t('newMessage.title')} onClose={onClose} width="max-w-md" panelClassName="max-h-[90vh] flex flex-col">
      <div className="p-4 space-y-3 overflow-y-auto flex-1">
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={() => {}}
          onPick={(jid) => { onPick(jid); onClose() }}
          placeholder={t('newMessage.searchPlaceholder')}
        />

        <div className="border-t border-fluux-hover pt-2 space-y-1">
          <button
            type="button"
            onClick={() => { onAddContact() }}
            className="w-full px-3 py-2 text-start text-sm rounded hover:bg-fluux-hover flex items-center gap-2"
          >
            <UserPlus className="size-4 text-fluux-muted" />
            <span>{t('contacts.addContact')}</span>
          </button>
          <button
            type="button"
            onClick={() => { onManageContacts(); onClose() }}
            className="w-full px-3 py-2 text-start text-sm rounded hover:bg-fluux-hover flex items-center gap-2"
          >
            <Users className="size-4 text-fluux-muted" />
            <span>{t('newMessage.manageContacts')}</span>
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
```

> Note: the `ContactSelector` placeholder uses the modal's `placeholder` prop. Confirm `TextInput` inside `ContactSelector` renders that placeholder; if `ContactSelector` falls back to `t('contacts.searchContacts')` when `placeholder` is set, pass the placeholder through (it already accepts a `placeholder` prop). The test asserts the placeholder text, so this wiring is verified by Step 8.

- [ ] **Step 8: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/NewMessageModal.test.tsx`
Expected: PASS. If the placeholder assertion fails because `ContactSelector` ignores `placeholder` in single-pick mode, adjust `ContactSelector` to prefer the passed `placeholder` over the default, then re-run.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/stores/modalStore.ts apps/fluux/src/stores/modalStore.test.ts apps/fluux/src/components/NewMessageModal.tsx apps/fluux/src/components/NewMessageModal.test.tsx
git commit -m "feat(messages): add New message picker modal"
```

---

## Task 5: Wire the `+` in the Messages header + `onStartChatWithJid`

**Files:**
- Modify: `apps/fluux/src/components/Sidebar.tsx`
- Modify: `apps/fluux/src/components/ChatLayout.tsx`

**Interfaces:**
- Produces: `Sidebar` gains an optional prop `onStartChatWithJid?: (jid: string) => void`. The Messages header renders a `Plus` button (no chevron) that opens the `newMessage` modal; the modal's `onPick` calls `onStartChatWithJid`.
- Consumes: `NewMessageModal` (Task 4), `modalStore` `'newMessage'` (Task 4), `navigateToContacts` (existing, from `useRouteSync`), `modalOpen('addContact')` (existing), and `ChatLayout.handleStartChatWithJid` (`ChatLayout.tsx:745`).

- [ ] **Step 1: Add the `onStartChatWithJid` prop and modal wiring to `Sidebar.tsx`**

In `apps/fluux/src/components/Sidebar.tsx`:

1. Import the modal near the other modal imports (after line 19):
   ```tsx
   import { NewMessageModal } from './NewMessageModal'
   ```
2. Add `onStartChatWithJid?: (jid: string) => void` to `SidebarProps` (alongside `onStartChat?`), and destructure it in the `Sidebar({ ... })` signature.
3. Add a store subscription near the other `useModalStore` lines (~124):
   ```tsx
   const showNewMessage = useModalStore((s) => s.newMessage)
   ```
4. In the header (`apps/fluux/src/components/Sidebar.tsx`, the `<h1>…</h1>` block ends at line 314), add a Messages-only `+` button right after the `{sidebarView === 'directory' && (…)}` block and before `{sidebarView === 'rooms' && (…)}`:
   ```tsx
   {sidebarView === 'messages' && (
     <Tooltip content={t('newMessage.title')} position="bottom">
       <button
         onClick={() => modalOpen('newMessage')}
         aria-label={t('newMessage.title')}
         className="ms-auto p-1 text-fluux-muted hover:text-fluux-text flex items-center"
       >
         <Plus className="size-5" />
       </button>
     </Tooltip>
   )}
   ```
   (`Plus` and `Tooltip` are already imported — `Plus` is used by the rooms dropdown at line 354.)
5. Render the modal next to the other modals (after the Add Contact modal block ~line 514):
   ```tsx
   {showNewMessage && (
     <NewMessageModal
       onClose={() => modalClose('newMessage')}
       onPick={(jid) => onStartChatWithJid?.(jid)}
       onAddContact={() => { modalClose('newMessage'); modalOpen('addContact') }}
       onManageContacts={() => navigateToContacts()}
     />
   )}
   ```
   Confirm `navigateToContacts` is already destructured from `useRouteSync()` in `Sidebar.tsx`; if not, add it to that destructure.

- [ ] **Step 2: Pass `handleStartChatWithJid` from `ChatLayout.tsx`**

In `apps/fluux/src/components/ChatLayout.tsx`, find where `<Sidebar … />` is rendered (it receives `onStartChat`, `onSelectContact`, `onManageUser`, etc.) and add:
```tsx
onStartChatWithJid={handleStartChatWithJid}
```
`handleStartChatWithJid` is already defined at `ChatLayout.tsx:745`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors from the new prop or modal usage).

- [ ] **Step 4: Manual smoke (optional but recommended)**

In demo mode (`npm run dev` → `http://localhost:5173/demo.html`), open Messages, click `+`, type a JID, press Enter → a conversation opens. Click `+` → "Manage contacts" → lands on the Contacts destination. Click `+` → "Add contact" → Add-contact modal opens.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/Sidebar.tsx apps/fluux/src/components/ChatLayout.tsx
git commit -m "feat(messages): open New message picker from a + in the Messages header"
```

---

## Task 6: Relocate Contacts to the bottom cluster + badge + drop requests from Events count

**Files:**
- Modify: `apps/fluux/src/components/Sidebar.tsx`
- Modify: `apps/fluux/src/components/CommandPalette.tsx`
- Create: `apps/fluux/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `IconRailNavLink` `badgeCount`/`badgeLabel` (Task 2); `useEventsStore` `subscriptionRequests` (existing SDK); `sidebar.contacts` key (Task 1).
- Produces: the rail's bottom cluster now contains, in order, **Contacts**, Admin (if admin), Settings, avatar. The Contacts icon shows a red numeric badge equal to the pending subscription-request count. The Events (`Bell`) `pendingCount` no longer includes subscription requests.

- [ ] **Step 1: Write the failing Sidebar test**

Create `apps/fluux/src/components/Sidebar.test.tsx`. This renders the real `Sidebar` against the global `@fluux/sdk` mock from `test-setup.ts`; we override `useEventsStore` locally so we can feed subscription requests.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

// Override the events store hook to control subscriptionRequests for the badge.
const eventsState = {
  subscriptionRequests: [{ id: 'r1', from: 'a@x', timestamp: new Date() }, { id: 'r2', from: 'b@x', timestamp: new Date() }],
  strangerMessages: [],
  mucInvitations: [],
  systemNotifications: [],
}
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useEventsStore: (selector: (s: typeof eventsState) => unknown) => selector(eventsState),
  }
})

function wrap(node: ReactNode) {
  return render(<MemoryRouter initialEntries={['/messages']}>{node}</MemoryRouter>)
}

describe('Sidebar — Contacts relocation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the Contacts rail button with a pending-request badge', async () => {
    const { Sidebar } = await import('./Sidebar')
    wrap(<Sidebar onViewChange={vi.fn()} />)
    const contactsBtn = document.querySelector('[data-nav="directory"]')
    expect(contactsBtn).not.toBeNull()
    expect(contactsBtn?.textContent).toContain('2')
  })

  it('the Events rail button badge ignores subscription requests', async () => {
    const { Sidebar } = await import('./Sidebar')
    wrap(<Sidebar onViewChange={vi.fn()} />)
    const eventsBtn = document.querySelector('[data-nav="events"]')
    // Only subscription requests are present, so the events badge must be absent.
    expect(eventsBtn?.querySelector('span.bg-fluux-red')).toBeNull()
  })
})
```

> If `Sidebar` requires additional props to render without throwing (it is invoked in `ChatLayout` with several callbacks), add the minimal `vi.fn()` props the type requires. Keep the assertions above. If full-`Sidebar` rendering proves impractical under the mock, fall back to asserting the same two behaviors by extracting the contacts-badge count and the `pendingCount` expression into a tiny pure helper in `Sidebar.tsx` (e.g. `eventsPendingCount(state)` excluding requests, and using `subscriptionRequests.length` for the contacts badge) and unit-testing that helper instead — but prefer the render test.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/Sidebar.test.tsx`
Expected: FAIL (Contacts link has no badge yet; it is still in the top cluster with no count).

- [ ] **Step 3: Move the Contacts link, add the badge, drop requests from `pendingCount`**

In `apps/fluux/src/components/Sidebar.tsx`:

1. Add a focused selector for the pending request count near the other store hooks (~line 100):
   ```tsx
   const pendingRequestCount = useEventsStore((s) => s.subscriptionRequests.length)
   ```
2. Change `pendingCount` (lines 100–105) to exclude subscription requests:
   ```tsx
   const pendingCount = useEventsStore((s) =>
     new Set(s.strangerMessages.map((m) => m.from)).size +
     s.mucInvitations.length +
     s.systemNotifications.length
   )
   ```
3. **Remove** the `Users` link from the top cluster (delete the line at ~259):
   ```tsx
   <IconRailNavLink icon={Users} label={t('sidebar.connections')} view="directory" pathPrefix="/contacts" onNavigate={onViewChange} />
   ```
4. **Insert** the relocated Contacts link in the bottom cluster, immediately after the `<div className="flex-1" />` spacer and before the Admin link (~line 282):
   ```tsx
   <IconRailNavLink
     icon={Users}
     label={t('sidebar.contacts')}
     view="directory"
     pathPrefix="/contacts"
     onNavigate={onViewChange}
     badgeCount={pendingRequestCount}
     badgeLabel={pendingRequestCount > 0 ? `${t('sidebar.contacts')} (${pendingRequestCount})` : undefined}
   />
   ```
5. Update the title switch (line 308) to use the new label:
   ```tsx
   : sidebarView === 'directory' ? t('sidebar.contacts')
   ```

- [ ] **Step 4: Relabel the command-palette entry**

In `apps/fluux/src/components/CommandPalette.tsx:333`, change `label: t('sidebar.connections')` to `label: t('sidebar.contacts')` for the `view-connections` entry.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/Sidebar.test.tsx`
Expected: PASS

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/Sidebar.tsx apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/Sidebar.test.tsx
git commit -m "feat(sidebar): move Contacts to the bottom cluster with a request badge"
```

---

## Task 7: Contacts destination — Requests section atop `ContactList`

**Files:**
- Create: `apps/fluux/src/components/sidebar-components/SubscriptionRequestItem.tsx`
- Modify: `apps/fluux/src/components/sidebar-components/ContactList.tsx`
- Modify: `apps/fluux/src/components/sidebar-components/EventsView.tsx`
- Create: `apps/fluux/src/components/sidebar-components/ContactList.requests.test.tsx`

**Interfaces:**
- Produces:
  - `SubscriptionRequestItem` component (extracted verbatim from `EventsView.tsx:201–257`) exported from its own module:
    ```ts
    interface SubscriptionRequestItemProps {
      request: SubscriptionRequest
      onAccept: () => void
      onReject: () => void
      onBlock: () => void
    }
    export function SubscriptionRequestItem(props: SubscriptionRequestItemProps): JSX.Element
    ```
  - `ContactList` renders a "Requests" section at the very top (above the Online/Offline groups) when `subscriptionRequests.length > 0`, wired to `useEvents()` `acceptSubscription`/`rejectSubscription` + `useBlocking().blockJid`.
- Consumes: `useEvents()` (`subscriptionRequests`, `acceptSubscription`, `rejectSubscription`), `useBlocking()` (`blockJid`), `contacts.requestsHeading` key (Task 1).

- [ ] **Step 1: Extract `SubscriptionRequestItem` into its own module**

Create `apps/fluux/src/components/sidebar-components/SubscriptionRequestItem.tsx` by moving the component (and only it) out of `EventsView.tsx`:

```tsx
import { useTranslation } from 'react-i18next'
import { type SubscriptionRequest } from '@fluux/sdk'
import { Check, X, Ban } from 'lucide-react'
import { Avatar } from '../Avatar'
import { Tooltip } from '../Tooltip'

interface SubscriptionRequestItemProps {
  request: SubscriptionRequest
  onAccept: () => void
  onReject: () => void
  onBlock: () => void
}

export function SubscriptionRequestItem({ request, onAccept, onReject, onBlock }: SubscriptionRequestItemProps) {
  const { t } = useTranslation()
  const displayName = request.from.split('@')[0]

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      <div className="flex items-center gap-3">
        <Avatar identifier={request.from} name={displayName} size="md" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-fluux-text truncate">{displayName}</p>
          <p className="text-xs text-fluux-muted truncate">{request.from}</p>
        </div>
      </div>
      <div className="flex gap-2 mt-2 ms-13">
        <button
          onClick={onAccept}
          className="flex-1 px-3 py-1.5 bg-fluux-green text-white text-sm font-medium rounded hover:bg-fluux-green/80 transition-colors flex items-center justify-center gap-1"
        >
          <Check className="size-4" />
          {t('common.accept')}
        </button>
        <button
          onClick={onReject}
          className="flex-1 px-3 py-1.5 bg-fluux-muted/20 text-fluux-text text-sm font-medium rounded hover:bg-fluux-muted/30 transition-colors flex items-center justify-center gap-1"
        >
          <X className="size-4" />
          {t('common.reject')}
        </button>
        <Tooltip content={t('common.block')} position="top">
          <button
            onClick={onBlock}
            className="px-3 py-1.5 bg-fluux-red text-white text-sm font-medium rounded hover:bg-fluux-red/80 transition-colors flex items-center justify-center gap-1"
            aria-label={t('common.block')}
          >
            <Ban className="size-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
```

In `EventsView.tsx`, delete the local `SubscriptionRequestItem` definition (lines 201–257) and its now-unused imports if they become unused (do **not** remove imports still used elsewhere in the file, e.g. `Check`, `X`, `Ban`, `Avatar`, `Tooltip`, `SubscriptionRequest` may still be referenced by other items — only remove a symbol if `grep` shows no other use). Import the extracted component at the top:
```tsx
import { SubscriptionRequestItem } from './SubscriptionRequestItem'
```
(EventsView still renders it for now; Task 8 removes that block.)

- [ ] **Step 2: Run the existing EventsView test to verify the extraction is behavior-neutral**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/EventsView.test.tsx`
Expected: PASS (no behavior change yet).

- [ ] **Step 3: Write the failing ContactList Requests test**

Create `apps/fluux/src/components/sidebar-components/ContactList.requests.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContactList } from './ContactList'

const acceptSubscription = vi.fn()
const rejectSubscription = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useEvents: () => ({
      subscriptionRequests: [{ id: 'r1', from: 'alice@example.com', timestamp: new Date() }],
      acceptSubscription,
      rejectSubscription,
    }),
    useBlocking: () => ({ blockJid: vi.fn() }),
    // Roster empty so only the Requests section renders.
    useRosterStore: (selector: (s: { contactSidebarEntries: () => string[] }) => unknown) =>
      selector({ contactSidebarEntries: () => [] }),
  }
})

describe('ContactList — Requests section', () => {
  it('renders pending subscription requests with Accept/Reject', () => {
    render(<ContactList />)
    expect(screen.getByText('contacts.requestsHeading')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    fireEvent.click(screen.getByText('common.accept'))
    expect(acceptSubscription).toHaveBeenCalledWith('alice@example.com')
  })
})
```

> The exact `vi.mock('@fluux/sdk', …)` surface may need to mirror more of the `test-setup.ts` mock (e.g. `useRosterStore` shape) depending on what `ContactList` calls. Start from the global mock and add only what `ContactList` reads. If `ContactList` reads roster via `useRosterStore(useShallow(...))`, keep the selector returning `{ contactSidebarEntries: () => [] }`.

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/ContactList.requests.test.tsx`
Expected: FAIL (no Requests section rendered yet).

- [ ] **Step 5: Add the Requests section to `ContactList`**

In `apps/fluux/src/components/sidebar-components/ContactList.tsx`:

1. Add imports:
   ```tsx
   import { useEvents, useBlocking } from '@fluux/sdk'
   import { SubscriptionRequestItem } from './SubscriptionRequestItem'
   ```
2. Inside the `ContactList` component body, read events + blocking:
   ```tsx
   const { subscriptionRequests, acceptSubscription, rejectSubscription } = useEvents()
   const { blockJid } = useBlocking()
   const handleBlockRequest = async (jid: string) => {
     await rejectSubscription(jid)
     await blockJid(jid)
   }
   ```
3. Render the Requests block at the very top of the scrollable list (above the search-filtered groups), mirroring the existing group-header styling:
   ```tsx
   {subscriptionRequests.length > 0 && (
     <div className="mb-2">
       <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 mt-2">
         {t('contacts.requestsHeading')} — {subscriptionRequests.length}
       </h3>
       {subscriptionRequests.map((request) => (
         <SubscriptionRequestItem
           key={request.id}
           request={request}
           onAccept={() => acceptSubscription(request.from)}
           onReject={() => rejectSubscription(request.from)}
           onBlock={() => handleBlockRequest(request.from)}
         />
       ))}
     </div>
   )}
   ```
   Place this just inside the list container, before the Online/Offline/Errored group rendering. **Do not use an em-dash**: the ` — ` above is a hyphen-style separator matching the existing `EventsView` headers (`events.subscriptionRequests` uses the same glyph at `EventsView.tsx:119`); keep it identical to the established pattern so it is consistent. If lint/style flags it, switch to `{t('contacts.requestsHeading')} · {subscriptionRequests.length}` using a middot.

   > Reuse note: the Online/Offline presence grouping already exists in `ContactList` (`contactSidebarEntries()` encodes `online`/`offline`/`errored`), and the search box already satisfies the spec's "Filter" affordance. No new grouping or filter UI is needed.

- [ ] **Step 6: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/ContactList.requests.test.tsx`
Expected: PASS

Also re-run the memo test to ensure no render regression:
Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/ContactList.memo.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/SubscriptionRequestItem.tsx apps/fluux/src/components/sidebar-components/ContactList.tsx apps/fluux/src/components/sidebar-components/EventsView.tsx apps/fluux/src/components/sidebar-components/ContactList.requests.test.tsx
git commit -m "feat(contacts): surface subscription requests in the Contacts list"
```

---

## Task 8: Remove subscription requests from `EventsView`

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/EventsView.tsx`
- Modify: `apps/fluux/src/components/sidebar-components/EventsView.test.tsx`

**Interfaces:**
- Produces: `EventsView` no longer renders the subscription-requests section; it keeps room invitations, stranger messages, and system notifications. `subscriptionRequests` is no longer read in `EventsView`.
- Consumes: nothing new.

- [ ] **Step 1: Update the EventsView test to assert requests are gone**

In `apps/fluux/src/components/sidebar-components/EventsView.test.tsx`, the `useEvents` mock (~line 46) provides `subscriptionRequests`. Add/adjust a test asserting the subscription-request heading is NOT rendered even when `subscriptionRequests` is non-empty, while another category still renders. For example:

```tsx
it('does not render subscription requests (they live in Contacts now)', () => {
  // useEvents mock returns subscriptionRequests with one entry and one mucInvitation
  render(<EventsView />)
  expect(screen.queryByText('events.subscriptionRequests')).toBeNull()
})
```

Ensure the mock for this test includes at least one `subscriptionRequests` entry (so the assertion is meaningful) and one other category present.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/EventsView.test.tsx`
Expected: FAIL (requests heading still rendered).

- [ ] **Step 3: Remove the subscription-requests block from `EventsView`**

In `apps/fluux/src/components/sidebar-components/EventsView.tsx`:
1. Delete the `subscriptionRequests` rendering block (lines 116–131).
2. Remove `subscriptionRequests`, `acceptSubscription`, `rejectSubscription` from the `useEvents()` destructure (lines 32, 36, 37) and delete the now-unused `handleBlockSubscription` helper (lines 46–49).
3. Remove the now-unused `SubscriptionRequestItem` import added in Task 7 if nothing else uses it, and any import (`Check`?) that becomes unused — verify with `grep` before deleting each symbol.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/EventsView.test.tsx`
Expected: PASS

- [ ] **Step 5: Typecheck + lint (catch unused imports)**

Run: `npm run typecheck && npm run lint`
Expected: PASS (no unused-symbol errors).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/EventsView.tsx apps/fluux/src/components/sidebar-components/EventsView.test.tsx
git commit -m "refactor(events): drop subscription requests from Events (now in Contacts)"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole monorepo**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS (no errors; no new warnings on changed files)

- [ ] **Step 3: Run the affected test suites**

Run: `./scripts/test-affected.sh main`
Expected: PASS, no stderr. (Covers IconRailNavLink, ContactSelector, NewMessageModal, modalStore, Sidebar, ContactList, EventsView, and any reverse-dependents.)

- [ ] **Step 4: Demo smoke check (manual)**

`npm run dev` → `http://localhost:5173/demo.html`. Verify, against the spec:
- Rail: top cluster = Messages, Rooms, Archive, Events, Search; bottom cluster = Contacts (with Admin/Settings/avatar). Contacts shows a red count badge only when there are pending subscription requests; aria-label reads "Contacts (N)".
- Messages header `+` opens the New message picker; pick a person or type a JID → conversation opens; "Manage contacts" → Contacts destination; "Add contact" → Add-contact modal.
- Contacts destination shows a "Requests" section above Online/Offline groups with Accept/Reject/Block; the detail pane is the contact profile; `✕`/back collapses to list (desktop) / navigation stack (mobile, narrow viewport).
- Events no longer lists subscription requests; its badge no longer counts them.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for conversation-first contacts"
```

---

## Self-review notes (deviations & decisions for the reviewer)

These choices deviate from or sharpen the spec; flag them if you disagree:

1. **`'directory'` kept (not renamed to `'contacts'`).** Spec §1 desired the rename but its open item permits keeping it; persistence (`useSessionPersistence.ts:124`) and ~13 call sites make the rename a separate, riskier change. Only the **label** becomes "Contacts". Decision 2's plan does not depend on the rename.
2. **New message picker reuses `ContactSelector` via a new `onPick` mode** rather than the spec's literal "ContactSelector core". The picker shows the existing recent-activity-sorted roster with presence dots and supports raw-JID entry (already built into `ContactSelector` via `canAddAsJid`). **Explicit Online/Offline section headers and a separate "Recents" block inside the picker are NOT built** — that richer grouping lives in the Contacts destination itself (which already groups by presence). If you want the picker to also show Online/Offline headers, that is an added sub-task.
3. **The Contacts list-header "Add"/"Filter" affordances are satisfied by what already exists** (the directory header dropdown provides Add contact + Blocked users; `ContactList`'s search box is the filter). No new header controls are added, preserving Blocked-users access. Flag if you want the dropdown reshaped into an explicit `user-plus` + filter per spec §5 wording.
4. **`Sidebar.test.tsx` is new and renders the full `Sidebar`.** If that proves brittle under the shared mock, Step 1 of Task 6 offers a pure-helper fallback. Prefer the render test.
5. **i18n bulk translation is a step, not inlined for all 165 cells.** The most-visible key (`sidebar.contacts`) has a full 33-locale table; the four picker/requests keys give en+fr explicitly and delegate the remaining 31 locales to the executor per the project i18n rule, with a JSON verification gate.
