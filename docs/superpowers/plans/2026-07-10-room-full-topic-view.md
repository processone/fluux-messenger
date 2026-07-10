# Room Info Modal — View Full Room Topic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any room member read a MUC room's full topic/description via a Room Info modal opened from the header, with a hover tooltip for a quick peek (#922).

**Architecture:** A new self-contained `RoomInfoModal` (built on the existing `ModalShell` primitive) renders the room avatar, JID, and the full subject with a local Show more/less collapse for long text. `RoomHeader`'s name+subject block becomes a keyboard-accessible button that opens the modal and carries a tooltip of the full subject. No SDK, store, or i18n changes.

**Tech Stack:** React + TypeScript, Tailwind, `react-i18next`, Vitest + Testing Library (jsdom).

## Global Constraints

- No SDK changes — the topic value is `room.subject`, already on the `Room` object.
- No new i18n keys — reuse `rooms.topic`, `chat.showMore`, `chat.showLess`; the modal title is the room **name** (not a translated string).
- App unit tests run per-workspace: `cd apps/fluux && npx vitest run <file>`.
- DOM tests pin jsdom via a `@vitest-environment jsdom` docblock at the top of the test file.
- No em-dash connectors in any user-facing copy (none added here, but keep it true).
- Follow existing modal patterns: `ModalShell` for chrome, conditional render alongside the other header modals.

---

### Task 1: `RoomInfoModal` component

**Files:**
- Create: `apps/fluux/src/components/RoomInfoModal.tsx`
- Test: `apps/fluux/src/components/RoomInfoModal.test.tsx`

**Interfaces:**
- Consumes: `ModalShell` (`{ title, onClose, width?, children }`), `RoomAvatar` (`{ identifier, name?, avatarUrl?, size? }`), `renderTextWithLinks(text: string)`, `Room` type (`@fluux/sdk`).
- Produces: `export function RoomInfoModal(props: RoomInfoModalProps)` where `interface RoomInfoModalProps { room: Room; onClose: () => void }`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/RoomInfoModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RoomInfoModal } from './RoomInfoModal'
import type { Room } from '@fluux/sdk'

// Surface i18n keys verbatim so assertions target keys, not translated copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    jid: 'general@conference.example.com',
    name: 'General',
    subject: 'Welcome to the general room',
    ...overrides,
  } as Room
}

// Helper to force the topic element to report overflow in jsdom (which
// otherwise reports scrollHeight === clientHeight === 0).
function forceOverflow(scrollHeight: number, clientHeight: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get() { return scrollHeight },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true, get() { return clientHeight },
  })
}

afterEach(() => {
  // Restore jsdom defaults so overflow overrides don't leak between tests.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
})

describe('RoomInfoModal', () => {
  it('renders the room name (title), JID and full topic', () => {
    render(<RoomInfoModal room={makeRoom()} onClose={() => {}} />)
    expect(screen.getByText('General')).toBeTruthy()
    expect(screen.getByText('general@conference.example.com')).toBeTruthy()
    expect(screen.getByText('Welcome to the general room')).toBeTruthy()
    expect(screen.getByText('rooms.topic')).toBeTruthy()
  })

  it('omits the topic section when the room has no subject', () => {
    render(<RoomInfoModal room={makeRoom({ subject: undefined })} onClose={() => {}} />)
    expect(screen.queryByText('rooms.topic')).toBeNull()
    // Identity still renders.
    expect(screen.getByText('General')).toBeTruthy()
  })

  it('shows no Show more toggle when the topic fits', () => {
    forceOverflow(50, 50)
    render(<RoomInfoModal room={makeRoom()} onClose={() => {}} />)
    expect(screen.queryByText('chat.showMore')).toBeNull()
    expect(screen.queryByText('chat.showLess')).toBeNull()
  })

  it('shows a Show more toggle when the topic overflows, and toggles to Show less', () => {
    forceOverflow(300, 120)
    render(<RoomInfoModal room={makeRoom({ subject: 'x'.repeat(2000) })} onClose={() => {}} />)
    const moreBtn = screen.getByText('chat.showMore')
    expect(moreBtn).toBeTruthy()
    fireEvent.click(moreBtn)
    expect(screen.getByText('chat.showLess')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/RoomInfoModal.test.tsx`
Expected: FAIL — cannot resolve `./RoomInfoModal` (module not found).

- [ ] **Step 3: Write the component**

Create `apps/fluux/src/components/RoomInfoModal.tsx`:

```tsx
import { useState, useRef, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { Room } from '@fluux/sdk'
import { ModalShell } from './ModalShell'
import { RoomAvatar } from './RoomAvatar'
import { renderTextWithLinks } from '@/utils/messageStyles'

interface RoomInfoModalProps {
  room: Room
  onClose: () => void
}

/**
 * Read-only room details for any member: avatar, name (modal title), JID, and
 * the full topic/description (`room.subject`). Long topics collapse to six lines
 * behind a Show more / Show less toggle. Kept independent of the message-list
 * collapse machinery (which needs a messageId + width context) so it stays
 * self-contained and testable.
 */
export function RoomInfoModal({ room, onClose }: RoomInfoModalProps) {
  return (
    <ModalShell title={room.name} onClose={onClose} width="max-w-md" panelClassName="max-h-[80vh]">
      <div className="p-4 flex flex-col gap-4 overflow-y-auto">
        {/* Identity row */}
        <div className="flex items-center gap-3 min-w-0">
          <RoomAvatar identifier={room.jid} name={room.name} avatarUrl={room.avatar} size="xl" />
          <p className="text-sm text-fluux-muted break-all select-text">{room.jid}</p>
        </div>

        {/* Topic — only when set */}
        {room.subject && <RoomTopic subject={room.subject} />}
      </div>
    </ModalShell>
  )
}

function RoomTopic({ subject }: { subject: string }) {
  const { t } = useTranslation()
  const topicRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  // Measure only while collapsed; when expanded the clamp is off so scrollHeight
  // would equal clientHeight. Keeping `overflowing` sticky preserves the toggle.
  useLayoutEffect(() => {
    const el = topicRef.current
    if (!el || expanded) return
    setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [subject, expanded])

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-fluux-muted">
        {t('rooms.topic')}
      </span>
      <div
        ref={topicRef}
        className={`text-sm text-fluux-text whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-6'}`}
      >
        {renderTextWithLinks(subject)}
      </div>
      {overflowing && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 mt-1 text-sm text-fluux-muted hover:text-fluux-text transition-colors select-none self-start"
        >
          {expanded ? (
            <><ChevronUp className="size-4" />{t('chat.showLess')}</>
          ) : (
            <><ChevronDown className="size-4" />{t('chat.showMore')}</>
          )}
        </button>
      )}
    </div>
  )
}
```

Note: `useTranslation` is imported once and used only inside `RoomTopic` (the modal title is `room.name`, not a translated string). That is intentional — do not add a `useTranslation()` call to `RoomInfoModal`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/RoomInfoModal.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/RoomInfoModal.tsx apps/fluux/src/components/RoomInfoModal.test.tsx
git commit -m "feat(rooms): add RoomInfoModal to view full room topic (#922)"
```

---

### Task 2: Wire the modal into `RoomHeader`

**Files:**
- Modify: `apps/fluux/src/components/RoomHeader.tsx`

**Interfaces:**
- Consumes: `RoomInfoModal` from Task 1 (`{ room, onClose }`), existing `Tooltip`, `useState`.
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Add the import and modal state**

In `apps/fluux/src/components/RoomHeader.tsx`, add to the modal imports (near line 17-21):

```tsx
import { RoomInfoModal } from './RoomInfoModal'
```

Add state alongside the existing modal flags (near line 68-70):

```tsx
const [showInfoModal, setShowInfoModal] = useState(false)
```

- [ ] **Step 2: Make the name+subject block open the modal, with a tooltip**

Replace the name+info block (currently lines 124-130):

```tsx
      {/* Name and info */}
      <div className="flex-1 min-w-0">
        <h2 className="font-semibold text-fluux-text truncate leading-tight">{room.name}</h2>
        <p className="text-xs text-fluux-muted truncate">
          {room.subject ? renderTextWithLinks(room.subject) : room.jid}
        </p>
      </div>
```

with:

```tsx
      {/* Name and info — opens Room Info modal; tooltip peeks the full topic */}
      <Tooltip content={room.subject || room.jid} position="bottom">
        <button
          type="button"
          onClick={() => setShowInfoModal(true)}
          aria-label={t('rooms.showRoomInfo', 'Room info')}
          className="flex-1 min-w-0 text-start rounded-md px-1 -mx-1 py-0.5 hover:bg-fluux-hover transition-colors"
        >
          <h2 className="font-semibold text-fluux-text truncate leading-tight">{room.name}</h2>
          <p className="text-xs text-fluux-muted truncate">
            {room.subject ? renderTextWithLinks(room.subject) : room.jid}
          </p>
        </button>
      </Tooltip>
```

Note: the `t('rooms.showRoomInfo', 'Room info')` call uses an inline i18n default so no locale edit is required; if the project lint forbids inline defaults, replace with `aria-label="Room info"` (English `aria-label` is acceptable for a non-visual label here, but prefer the inline-default form to match `t('rooms.roomActions', 'Room actions')` already used at line 188).

- [ ] **Step 3: Conditionally render the modal**

Add near the other conditionally-rendered modals (after the `showHatsModal` block, ~line 274-278):

```tsx
      {showInfoModal && (
        <RoomInfoModal
          room={room}
          onClose={() => setShowInfoModal(false)}
        />
      )}
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck`
Expected: no errors.

Run: `cd apps/fluux && npx eslint src/components/RoomHeader.tsx src/components/RoomInfoModal.tsx`
Expected: no errors.

- [ ] **Step 5: Run the room-header-adjacent tests**

Run: `cd apps/fluux && npx vitest run src/components/RoomInfoModal.test.tsx`
Expected: PASS.

If a `RoomHeader.test.tsx` exists, run it too and update any snapshot/label assertions the new button introduces:
Run: `cd apps/fluux && npx vitest run src/components/RoomHeader.test.tsx`
Expected: PASS (or updated assertions).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/RoomHeader.tsx
git commit -m "feat(rooms): open Room Info modal from room header title (#922)"
```

---

### Task 3: Manual verification in demo mode

**Files:** none (verification only).

- [ ] **Step 1: Seed a long topic**

In demo mode, pick a room and give it a long, multi-line subject. Either edit `apps/fluux/src/demo/DemoClient.ts` where room subjects are seeded, or set it at runtime. A quick runtime option (browser devtools console on the demo page) is to use the room config, but the reliable path is to set a long `subject` on a demo room in the seed data, e.g.:

```ts
subject: 'This is a deliberately very long room topic that wraps across many lines. '.repeat(8),
```

- [ ] **Step 2: Run the demo and verify**

Run: `npm run dev` then open `http://localhost:5173/demo.html?tutorial=false`.

Verify:
- Hovering the room title in the header shows a tooltip with the full subject.
- Clicking the room title opens the Room Info modal.
- The modal shows the room name (title), JID, and the full topic.
- The topic collapses to six lines with a "Show more" button; clicking expands it and shows "Show less".
- Links inside the topic are clickable in the modal.
- A room with no subject opens the modal showing name + JID and no topic section.

- [ ] **Step 3: Final full-suite sanity + finish**

Run: `cd apps/fluux && npx vitest run src/components/RoomInfoModal.test.tsx`
Run: `npm run typecheck`
Expected: PASS / no errors.

No commit (verification task). Proceed to open a PR against `main`.

---

## Notes / decisions locked from the spec

- The members panel (`OccupantPanel`) is intentionally **not** touched — the topic there read as out of place.
- `CollapsibleContent` is intentionally **not** reused — it requires a `messageId`, `expandedMessagesStore`, and `messageWidthContext`, none of which exist outside the message list.
- No-subject rooms omit the topic block rather than showing a placeholder, avoiding a new i18n key across 33 locales.
