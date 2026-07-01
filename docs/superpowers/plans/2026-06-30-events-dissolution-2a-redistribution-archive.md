# Events dissolution 2A — redistribute invitations/strangers/system, Archive toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three remaining actionable Event categories to their natural homes (room invitations → top of Rooms, stranger messages → top of Messages, system notifications → toast + status line), delete the now-empty `EventsView`, and turn Archive into a header toggle in the Messages view (removing the Archive rail destination).

**Architecture:** App-side (`apps/fluux`) only. Reuses the existing `useEvents()` actions and `useRoomJoinWarning` guard rather than rewriting them; extracts the two shared event-item rows (`MucInvitationItem`, `StrangerMessageItem`) out of `EventsView` so the new homes and the (still-present until 2B) `ActivityLogView` host do not duplicate them. The Events rail icon and the `'events'` `SidebarView` value REMAIN after 2A (they host only `ActivityLogView` until plan 2B deletes the activity log).

**Tech Stack:** React 18 + TypeScript, Zustand (via `@fluux/sdk`), React Router v7, react-i18next, Vitest + @testing-library/react, Tailwind (Fluux tokens).

## Global Constraints

- **Depends on Decision 1** (`2026-06-30-conversation-first-contacts.md`): subscription requests already live in Contacts and were removed from the Events `pendingCount`. The `+` in the Messages header already exists (the Archive toggle goes to its **left**).
- **No SDK changes in 2A.** All reuse existing `@fluux/sdk` exports. Do not run `build:sdk`.
- **Preserve the `useRoomJoinWarning` guard (issue #37).** Accepting a room invitation MUST call `confirmJoin(roomJid)` and bail if it returns false, BEFORE `acceptInvitation`. The guard's dialog (`warningDialog`) must be rendered wherever invitations are accepted.
- **Keep `'events'` in `SidebarView` and the Events rail icon** — 2A only empties and removes `EventsView`; the `'events'` destination then renders only `<ActivityLogView />`. Removing `'events'` is plan 2B.
- **i18n:** every new key → all 33 locale files (real translations, no English placeholders, no em-dash connectors) + the test-setup subset (`apps/fluux/src/test-setup.ts`). French values given explicitly.
- **Persisted-view fallback:** removing `'archive'` from `SidebarView` must degrade a persisted/bookmarked `'archive'` (or a `/archive` URL) to `'messages'`, never throw.
- **Commands:** app test `cd apps/fluux && npx vitest run <path>`; `npm run typecheck`; `npm run lint`; affected `./scripts/test-affected.sh`. Never include a Claude footer in commits.

---

## File Structure

**New files**
- `apps/fluux/src/components/sidebar-components/MucInvitationItem.tsx` — extracted invitation row (from `EventsView`).
- `apps/fluux/src/components/sidebar-components/StrangerMessageItem.tsx` — extracted stranger row (from `EventsView`).
- `apps/fluux/src/components/sidebar-components/RoomInvitationsBanner.tsx` — pinned "Invitations" section for the top of `RoomsList` (owns the `useRoomJoinWarning` guard + accept/decline).
- `apps/fluux/src/components/sidebar-components/MessageRequestsBanner.tsx` — pinned "Message requests" section for the top of `ConversationList`.
- `apps/fluux/src/components/sidebar-components/RoomInvitationsBanner.test.tsx`, `MessageRequestsBanner.test.tsx`.
- `apps/fluux/src/effects/systemNotificationEffect.ts` — side-effect routing `systemNotifications` to toasts (transient) and the status line (persistent).
- `apps/fluux/src/effects/systemNotificationEffect.test.ts`.

**Modified files**
- `apps/fluux/src/components/sidebar-components/EventsView.tsx` — delete (its render site changes to render nothing; see Task 7). The two extracted rows leave it.
- `apps/fluux/src/components/sidebar-components/RoomsList.tsx` — mount `RoomInvitationsBanner` at the top; extend the Rooms rail badge data (count) is in `Sidebar.tsx`.
- `apps/fluux/src/components/sidebar-components/ConversationList.tsx` — mount `MessageRequestsBanner` at the top of `ConversationList`; make `ConversationList` accept an `archived?: boolean` mode (absorbing `ArchiveList`'s data) OR keep `ArchiveList` and toggle between them (this plan keeps both components and toggles — see Task 8).
- `apps/fluux/src/components/Sidebar.tsx` — Rooms badge includes invitation count; render the Archive toggle in the Messages header; switch Messages content between active/archived list; drop the Events `pendingCount`/badge; remove the Archive rail icon; render `<ActivityLogView />` alone in the events branch.
- `apps/fluux/src/components/sidebar-components/PresenceSelector.tsx` (`StatusDisplay`) — show the latest persistent system alert.
- Routing: `apps/fluux/src/components/sidebar-components/types.tsx` (`SidebarView`, `VIEW_PATHS`), `apps/fluux/src/hooks/useRouteSync.ts`, `apps/fluux/src/hooks/useViewNavigation.ts`, `apps/fluux/src/hooks/useKeyboardShortcuts.ts`, `apps/fluux/src/hooks/useSessionPersistence.ts` — remove `'archive'`.
- `apps/fluux/src/App.tsx` (or wherever effects mount) — mount `systemNotificationEffect`.
- i18n locales + test-setup.

---

## Task 1: i18n keys

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` (+ 32 others)
- Modify: `apps/fluux/src/test-setup.ts`

**Interfaces — Produces keys:**
- `rooms.invitationsHeading` = "Invitations"
- `conversations.messageRequestsHeading` = "Message requests"
- `messages.showArchived` = "Show archived conversations"
- `messages.showActive` = "Show active conversations"
- `messages.archivedTitle` = "Archived"
- Reused (do not recreate): `events.join`, `events.decline`, `common.accept`, `common.ignore`, `common.block`.

- [ ] **Step 1: Add keys to `en.json`**

```jsonc
// inside "rooms": { ... }
"invitationsHeading": "Invitations",
// inside "conversations": { ... }
"messageRequestsHeading": "Message requests",
// new or existing "messages": { ... }
"messages": {
  "showArchived": "Show archived conversations",
  "showActive": "Show active conversations",
  "archivedTitle": "Archived"
}
```

- [ ] **Step 2: Translate into all 32 other locales** (real translations; no em-dash). French: `rooms.invitationsHeading` = "Invitations"; `conversations.messageRequestsHeading` = "Demandes de message"; `messages.showArchived` = "Afficher les conversations archivées"; `messages.showActive` = "Afficher les conversations actives"; `messages.archivedTitle` = "Archivées".

- [ ] **Step 3: Add to the test-setup subset** (`apps/fluux/src/test-setup.ts`, `resources.en.translation`):

```ts
rooms: { invitationsHeading: 'Invitations', /* keep existing keys in this block */ },
conversations: { messageRequestsHeading: 'Message requests', /* keep existing */ },
messages: { showArchived: 'Show archived conversations', showActive: 'Show active conversations', archivedTitle: 'Archived' },
```

- [ ] **Step 4: Verify**

```bash
cd apps/fluux && node -e "const fs=require('fs');const d='src/i18n/locales';let ok=true;for(const f of fs.readdirSync(d)){const j=JSON.parse(fs.readFileSync(d+'/'+f));if(!j.rooms?.invitationsHeading||!j.conversations?.messageRequestsHeading||!j.messages?.showArchived||!j.messages?.showActive||!j.messages?.archivedTitle){console.log('MISSING in',f);ok=false}}console.log(ok?'ALL OK':'FAIL')"
```
Expected: `ALL OK`

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales apps/fluux/src/test-setup.ts
git commit -m "i18n: add room invitations, message requests, archive toggle keys"
```

---

## Task 2: Extract `MucInvitationItem` and `StrangerMessageItem` into shared modules

**Files:**
- Create: `apps/fluux/src/components/sidebar-components/MucInvitationItem.tsx`
- Create: `apps/fluux/src/components/sidebar-components/StrangerMessageItem.tsx`
- Modify: `apps/fluux/src/components/sidebar-components/EventsView.tsx` (import the extracted components; delete the local definitions)

**Interfaces — Produces:**
```ts
// MucInvitationItem.tsx
interface MucInvitationItemProps { invitation: MucInvitation; onAccept: () => void; onDecline: () => void }
export function MucInvitationItem(props: MucInvitationItemProps): JSX.Element
// StrangerMessageItem.tsx
interface StrangerMessageItemProps {
  jid: string
  messages: { id: string; from: string; body: string; timestamp: Date }[]
  onAccept: () => void; onIgnore: () => void; onBlock: () => void
}
export function StrangerMessageItem(props: StrangerMessageItemProps): JSX.Element
```

- [ ] **Step 1: Create `MucInvitationItem.tsx`** by moving the component verbatim from `EventsView.tsx` (lines 259–311), with its own imports:

```tsx
import { useTranslation } from 'react-i18next'
import { type MucInvitation } from '@fluux/sdk'
import { Check, X, DoorOpen } from 'lucide-react'

interface MucInvitationItemProps {
  invitation: MucInvitation
  onAccept: () => void
  onDecline: () => void
}

export function MucInvitationItem({ invitation, onAccept, onDecline }: MucInvitationItemProps) {
  const { t } = useTranslation()
  const roomName = invitation.roomJid.split('@')[0]
  const inviterName = invitation.from.split('@')[0]

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-lg bg-fluux-brand/15 flex items-center justify-center flex-shrink-0">
          <DoorOpen className="size-5 text-fluux-brand" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-fluux-text truncate">{roomName}</p>
          <p className="text-xs text-fluux-muted truncate">{t('events.invitedBy', { name: inviterName })}</p>
          {invitation.reason && <p className="text-xs text-fluux-muted truncate italic">{invitation.reason}</p>}
        </div>
      </div>
      <div className="flex gap-2 mt-2 ms-13">
        <button
          onClick={onAccept}
          className="flex-1 px-3 py-1.5 bg-fluux-green text-white text-sm font-medium rounded hover:bg-fluux-green/80 transition-colors flex items-center justify-center gap-1"
        >
          <Check className="size-4" />
          {t('events.join')}
        </button>
        <button
          onClick={onDecline}
          className="flex-1 px-3 py-1.5 bg-fluux-red text-white text-sm font-medium rounded hover:bg-fluux-red/80 transition-colors flex items-center justify-center gap-1"
        >
          <X className="size-4" />
          {t('events.decline')}
        </button>
      </div>
    </div>
  )
}
```

> Verify against the current `EventsView.tsx` `MucInvitationItem` body (lines 265–311) and copy its exact inner JSX (icon, `invitedBy` key, reason). The block above mirrors it; reconcile any differences (e.g. the exact translation key for "invited by") by copying from the source — do not invent keys.

- [ ] **Step 2: Create `StrangerMessageItem.tsx`** by moving the component verbatim from `EventsView.tsx` (lines 313–379):

```tsx
import { useTranslation } from 'react-i18next'
import { Check, X, Ban } from 'lucide-react'
import { Avatar } from '../Avatar'
import { Tooltip } from '../Tooltip'

interface StrangerMessageItemProps {
  jid: string
  messages: { id: string; from: string; body: string; timestamp: Date }[]
  onAccept: () => void
  onIgnore: () => void
  onBlock: () => void
}

export function StrangerMessageItem({ jid, messages, onAccept, onIgnore, onBlock }: StrangerMessageItemProps) {
  const { t } = useTranslation()
  const displayName = jid.split('@')[0]
  const latestMessage = messages[messages.length - 1]
  const messageCount = messages.length

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      <div className="flex items-center gap-3">
        <Avatar identifier={jid} name={displayName} size="md" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-fluux-text truncate">{displayName}</p>
            {messageCount > 1 && (
              <span className="text-xs bg-fluux-brand/20 text-fluux-brand px-1.5 py-0.5 rounded">{messageCount}</span>
            )}
          </div>
          <p className="text-xs text-fluux-muted truncate">{latestMessage?.body}</p>
        </div>
      </div>
      <div className="flex gap-2 mt-2 ms-13">
        <button
          onClick={onAccept}
          className="flex-1 px-3 py-1.5 bg-fluux-brand text-fluux-text-on-accent text-sm font-medium rounded hover:bg-fluux-brand-hover transition-colors flex items-center justify-center gap-1"
        >
          <Check className="size-4" />
          {t('common.accept')}
        </button>
        <button
          onClick={onIgnore}
          className="flex-1 px-3 py-1.5 bg-fluux-muted/20 text-fluux-text text-sm font-medium rounded hover:bg-fluux-muted/30 transition-colors flex items-center justify-center gap-1"
        >
          <X className="size-4" />
          {t('common.ignore')}
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

- [ ] **Step 3: Update `EventsView.tsx`** to import both from their new modules and delete the local definitions. (EventsView still renders them for now; it is removed in Task 7.)

```tsx
import { MucInvitationItem } from './MucInvitationItem'
import { StrangerMessageItem } from './StrangerMessageItem'
```

- [ ] **Step 4: Run the existing EventsView test (behavior-neutral check)**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/EventsView.test.tsx`
Expected: PASS (pure extraction).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/MucInvitationItem.tsx apps/fluux/src/components/sidebar-components/StrangerMessageItem.tsx apps/fluux/src/components/sidebar-components/EventsView.tsx
git commit -m "refactor(events): extract MucInvitationItem and StrangerMessageItem"
```

---

## Task 3: Room invitations → pinned banner at top of `RoomsList`

**Files:**
- Create: `apps/fluux/src/components/sidebar-components/RoomInvitationsBanner.tsx`
- Create: `apps/fluux/src/components/sidebar-components/RoomInvitationsBanner.test.tsx`
- Modify: `apps/fluux/src/components/sidebar-components/RoomsList.tsx`

**Interfaces:**
- Produces: `RoomInvitationsBanner` — self-contained; reads `useEvents()` (`mucInvitations`, `acceptInvitation`, `declineInvitation`), owns `useRoomJoinWarning()` (`confirmJoin` + `warningDialog`), sets active room + navigates on accept. Renders nothing when there are no invitations.
- Consumes: `MucInvitationItem` (Task 2), `useRoomJoinWarning` (`apps/fluux/src/hooks/useRoomJoinWarning.tsx`), `rooms.invitationsHeading` (Task 1).

- [ ] **Step 1: Write the failing test** — preserve the #37 guard contract.

Create `apps/fluux/src/components/sidebar-components/RoomInvitationsBanner.test.tsx` (model the mocks on `EventsView.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

const acceptInvitation = vi.fn().mockResolvedValue(undefined)
const declineInvitation = vi.fn()
const setActiveRoom = vi.fn()
const setActiveConversation = vi.fn()
const getRoomInfo = vi.fn()
const acknowledgeNonAnon = vi.fn()
const isNonAnonAck = vi.fn(() => false)
let mucInvitations: Array<{ id: string; roomJid: string; from: string; password?: string }> = []

vi.mock('@fluux/sdk', () => ({
  useEvents: () => ({ mucInvitations, acceptInvitation, declineInvitation }),
  useRoomActions: () => ({ getRoomInfo, acknowledgeNonAnonymousRoom: acknowledgeNonAnon, isNonAnonymousRoomAcknowledged: isNonAnonAck }),
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (sel: (s: { setActiveConversation: typeof setActiveConversation }) => unknown) => sel({ setActiveConversation }),
  useRoomStore: (sel: (s: { setActiveRoom: typeof setActiveRoom }) => unknown) => sel({ setActiveRoom }),
}))
const navigateToRooms = vi.fn()
vi.mock('@/hooks', () => ({ useRouteSync: () => ({ navigateToRooms }) }))

import { RoomInvitationsBanner } from './RoomInvitationsBanner'

describe('RoomInvitationsBanner', () => {
  beforeEach(() => { vi.clearAllMocks(); mucInvitations = [] })

  it('renders nothing when there are no invitations', () => {
    const { container } = render(<RoomInvitationsBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('warns (issue #37) before joining a non-anonymous public room; joins only on confirm', async () => {
    mucInvitations = [{ id: 'i1', roomJid: 'room@conf.example.com', from: 'friend@example.com' }]
    getRoomInfo.mockResolvedValue({ isNonAnonymous: true, isPrivate: false })
    render(<RoomInvitationsBanner />)
    fireEvent.click(screen.getByText('events.join'))
    await waitFor(() => expect(screen.getByText('rooms.nonAnonWarningConfirm')).toBeInTheDocument())
    expect(acceptInvitation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('rooms.nonAnonWarningConfirm'))
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith('room@conf.example.com', undefined))
    expect(setActiveRoom).toHaveBeenCalledWith('room@conf.example.com')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/RoomInvitationsBanner.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `RoomInvitationsBanner.tsx`** (the accept flow is copied from `EventsView.handleAcceptInvitation`, lines 65–74, preserving the guard):

```tsx
import { useTranslation } from 'react-i18next'
import { useEvents } from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { useRouteSync } from '@/hooks'
import { useRoomJoinWarning } from '@/hooks/useRoomJoinWarning'
import { MucInvitationItem } from './MucInvitationItem'

export function RoomInvitationsBanner() {
  const { t } = useTranslation()
  const { mucInvitations, acceptInvitation, declineInvitation } = useEvents()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const { navigateToRooms } = useRouteSync()
  const { confirmJoin, warningDialog } = useRoomJoinWarning()

  if (mucInvitations.length === 0) return null

  // Issue #37: the join happens inside acceptInvitation; warn before joining a
  // room that would expose the user's real JID.
  const handleAccept = async (roomJid: string, password?: string) => {
    if (!(await confirmJoin(roomJid))) return
    await acceptInvitation(roomJid, password)
    void setActiveConversation(null)
    void setActiveRoom(roomJid)
    navigateToRooms(roomJid)
  }

  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2">
        {t('rooms.invitationsHeading')} · {mucInvitations.length}
      </h3>
      <div className="space-y-0.5">
        {mucInvitations.map((invitation) => (
          <MucInvitationItem
            key={invitation.id}
            invitation={invitation}
            onAccept={() => handleAccept(invitation.roomJid, invitation.password)}
            onDecline={() => declineInvitation(invitation.roomJid)}
          />
        ))}
      </div>
      {warningDialog}
    </div>
  )
}
```

> Confirm `navigateToRooms` accepts a `roomJid` argument (it does — `useRouteSync` exposes `navigateToRooms: (jid?, options?)`). Confirm the `@fluux/sdk` `useRoomJoinWarning` import path: it is `apps/fluux/src/hooks/useRoomJoinWarning.tsx`, re-exported via `@/hooks/useRoomJoinWarning`.

- [ ] **Step 4: Mount it at the top of `RoomsList`**

In `apps/fluux/src/components/sidebar-components/RoomsList.tsx`, import and render `<RoomInvitationsBanner />` as the first child of the list container (`<div ref={listRef} className="px-2 py-2" ...>`, the `return (` at ~line 217), before the Quick Chats block:

```tsx
import { RoomInvitationsBanner } from './RoomInvitationsBanner'
// ...
return (
  <div ref={listRef} className="px-2 py-2" {...getContainerProps()}>
    <RoomInvitationsBanner />
    {/* Quick Chats ... existing content unchanged ... */}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/RoomInvitationsBanner.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/RoomInvitationsBanner.tsx apps/fluux/src/components/sidebar-components/RoomInvitationsBanner.test.tsx apps/fluux/src/components/sidebar-components/RoomsList.tsx
git commit -m "feat(rooms): pin room invitations to the top of the rooms list"
```

---

## Task 4: Stranger messages → "Message requests" banner at top of `ConversationList`

**Files:**
- Create: `apps/fluux/src/components/sidebar-components/MessageRequestsBanner.tsx`
- Create: `apps/fluux/src/components/sidebar-components/MessageRequestsBanner.test.tsx`
- Modify: `apps/fluux/src/components/sidebar-components/ConversationList.tsx`

**Interfaces:**
- Produces: `MessageRequestsBanner` — reads `useEvents()` (`strangerConversations`, `acceptStranger`, `ignoreStranger`) + `useBlocking()` (`blockJid`); accept navigates into the new conversation (copied from `EventsView.handleAcceptStranger`, lines 57–63). Renders nothing when empty.
- Consumes: `StrangerMessageItem` (Task 2), `conversations.messageRequestsHeading` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/sidebar-components/MessageRequestsBanner.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

const acceptStranger = vi.fn().mockResolvedValue(undefined)
const ignoreStranger = vi.fn()
const blockJid = vi.fn().mockResolvedValue(undefined)
const setActiveConversation = vi.fn()
const navigateToMessages = vi.fn()
let strangerConversations: Record<string, Array<{ id: string; from: string; body: string; timestamp: Date }>> = {}

vi.mock('@fluux/sdk', () => ({
  useEvents: () => ({ strangerConversations, acceptStranger, ignoreStranger }),
  useBlocking: () => ({ blockJid }),
  getBareJid: (jid: string) => jid.split('/')[0],
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (sel: (s: { setActiveConversation: typeof setActiveConversation }) => unknown) => sel({ setActiveConversation }),
}))
vi.mock('@/hooks', () => ({ useRouteSync: () => ({ navigateToMessages }) }))

import { MessageRequestsBanner } from './MessageRequestsBanner'

describe('MessageRequestsBanner', () => {
  beforeEach(() => { vi.clearAllMocks(); strangerConversations = {} })

  it('renders nothing when there are no stranger conversations', () => {
    const { container } = render(<MessageRequestsBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('accepts a stranger and navigates into the conversation', async () => {
    strangerConversations = { 'x@example.com': [{ id: 'm1', from: 'x@example.com', body: 'hi', timestamp: new Date() }] }
    render(<MessageRequestsBanner />)
    fireEvent.click(screen.getByText('common.accept'))
    await waitFor(() => expect(acceptStranger).toHaveBeenCalledWith('x@example.com'))
    expect(navigateToMessages).toHaveBeenCalledWith('x@example.com')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/MessageRequestsBanner.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `MessageRequestsBanner.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { useEvents, useBlocking, getBareJid } from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'
import { useRouteSync } from '@/hooks'
import { StrangerMessageItem } from './StrangerMessageItem'

export function MessageRequestsBanner() {
  const { t } = useTranslation()
  const { strangerConversations, acceptStranger, ignoreStranger } = useEvents()
  const { blockJid } = useBlocking()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const { navigateToMessages } = useRouteSync()

  const jids = Object.keys(strangerConversations)
  if (jids.length === 0) return null

  const handleAccept = async (jid: string) => {
    await acceptStranger(jid)
    const bareJid = getBareJid(jid)
    void setActiveConversation(bareJid)
    navigateToMessages(bareJid)
  }
  const handleBlock = async (jid: string) => {
    await ignoreStranger(jid)
    await blockJid(jid)
  }

  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2">
        {t('conversations.messageRequestsHeading')} · {jids.length}
      </h3>
      <div className="space-y-0.5">
        {jids.map((jid) => (
          <StrangerMessageItem
            key={jid}
            jid={jid}
            messages={strangerConversations[jid]}
            onAccept={() => handleAccept(jid)}
            onIgnore={() => ignoreStranger(jid)}
            onBlock={() => handleBlock(jid)}
          />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Mount it at the top of `ConversationList`**

In `apps/fluux/src/components/sidebar-components/ConversationList.tsx`, import `MessageRequestsBanner`. The current early return for the empty list (line 89–91) must NOT hide the banner — restructure so the banner shows even with zero conversations:

```tsx
import { MessageRequestsBanner } from './MessageRequestsBanner'
// ...
return (
  <SidebarListMenuProvider<Conversation>>
    <MessageRequestsBanner />
    {conversationIds.length === 0 ? (
      <ListEmpty icon={MessageCircle} title={t('conversations.noConversations')} />
    ) : (
      <div ref={listRef} className="px-2 space-y-0.5" {...getContainerProps()}>
        {conversationIds.map((id, index) => (
          <ConversationItem
            key={id}
            conversationId={id}
            isActive={id === activeConversationId}
            isSelected={index === selectedIndex}
            isKeyboardNav={isKeyboardNav}
            onClick={handleConversationClick}
            {...getItemAttribute(index)}
            {...getItemProps(index)}
          />
        ))}
      </div>
    )}
    <ConversationContextMenu isArchived={false} onArchive={archiveConversation} onUnarchive={() => {}} onDelete={deleteConversation} />
  </SidebarListMenuProvider>
)
```

(Move the `if (conversationIds.length === 0) return <ListEmpty .../>` early-return into the ternary as above so the banner is always evaluated.)

- [ ] **Step 5: Run the test + the existing ConversationList tests**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/MessageRequestsBanner.test.tsx src/components/sidebar-components/ConversationList.empty.test.tsx`
Expected: PASS (the empty test renders with no strangers, so the banner returns null and the empty state still shows).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/MessageRequestsBanner.tsx apps/fluux/src/components/sidebar-components/MessageRequestsBanner.test.tsx apps/fluux/src/components/sidebar-components/ConversationList.tsx
git commit -m "feat(messages): pin message requests to the top of the conversation list"
```

---

## Task 5: System notifications → toast (transient) + status line (persistent)

**Files:**
- Create: `apps/fluux/src/effects/systemNotificationEffect.ts`
- Create: `apps/fluux/src/effects/systemNotificationEffect.test.ts`
- Modify: `apps/fluux/src/components/sidebar-components/PresenceSelector.tsx` (`StatusDisplay`)
- Modify: the app root that mounts effects (e.g. `apps/fluux/src/App.tsx` or `ChatLayout.tsx`) to start the effect.

**Interfaces:**
- Produces: `startSystemNotificationEffect(): () => void` — subscribes to `eventsStore.systemNotifications`; for each newly-added notification, pushes a toast (`useToastStore.getState().addToast`) for transient types and removes it from the store; persistent types (`auth-error`, `resource-conflict`) are surfaced by `StatusDisplay`.
- Consumes: `eventsStore` (`@fluux/sdk`), `useToastStore` (`apps/fluux/src/stores/toastStore.ts`, `addToast(type, message, duration?)`), `SystemNotification` type.

> **Design decision (flag for reviewer):** "Transient vs persistent" split — treat `auth-error` and `resource-conflict` as **persistent** (kept in the store, shown by `StatusDisplay` as a single latest-alert line), everything else as **transient** (toast + immediate removal). This matches the spec §5. If you prefer ALL system notifications as toasts with none persisted, simplify accordingly.

- [ ] **Step 1: Write the failing effect test**

Create `apps/fluux/src/effects/systemNotificationEffect.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const addToast = vi.fn()
vi.mock('@/stores/toastStore', () => ({ useToastStore: { getState: () => ({ addToast }) } }))

// Minimal fake eventsStore with subscribe semantics.
let listeners: Array<() => void> = []
let state = { systemNotifications: [] as Array<{ id: string; type: string; title: string; message: string }>, removeSystemNotification: vi.fn() }
vi.mock('@fluux/sdk', () => ({
  eventsStore: {
    getState: () => state,
    subscribe: (fn: () => void) => { listeners.push(fn); return () => { listeners = listeners.filter((l) => l !== fn) } },
  },
}))

import { startSystemNotificationEffect } from './systemNotificationEffect'

function emit(next: typeof state.systemNotifications) {
  state = { ...state, systemNotifications: next }
  listeners.forEach((l) => l())
}

describe('systemNotificationEffect', () => {
  beforeEach(() => { vi.clearAllMocks(); listeners = []; state.systemNotifications = [] })

  it('toasts a transient notification and removes it from the store', () => {
    const stop = startSystemNotificationEffect()
    emit([{ id: 'n1', type: 'info', title: 'Hi', message: 'Synced' }])
    expect(addToast).toHaveBeenCalledWith('info', 'Synced', expect.any(Number))
    expect(state.removeSystemNotification).toHaveBeenCalledWith('n1')
    stop()
  })

  it('does NOT toast or remove a persistent auth-error (left for the status line)', () => {
    const stop = startSystemNotificationEffect()
    emit([{ id: 'n2', type: 'auth-error', title: 'Auth', message: 'Replaced' }])
    expect(addToast).not.toHaveBeenCalled()
    expect(state.removeSystemNotification).not.toHaveBeenCalledWith('n2')
    stop()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/effects/systemNotificationEffect.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the effect**

```ts
import { eventsStore } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'

const PERSISTENT_TYPES = new Set(['auth-error', 'resource-conflict'])
const TOAST_DURATION_MS = 6000

/** Routes eventsStore.systemNotifications to toasts (transient) / status line (persistent). */
export function startSystemNotificationEffect(): () => void {
  const seen = new Set<string>()
  const handle = () => {
    const { systemNotifications, removeSystemNotification } = eventsStore.getState()
    for (const n of systemNotifications) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      if (PERSISTENT_TYPES.has(n.type)) continue // shown by StatusDisplay
      const toastType = n.type === 'auth-error' ? 'error' : 'info'
      useToastStore.getState().addToast(toastType, n.message, TOAST_DURATION_MS)
      removeSystemNotification(n.id)
    }
  }
  handle() // process any already-present notifications
  return eventsStore.subscribe(handle)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/fluux && npx vitest run src/effects/systemNotificationEffect.test.ts`
Expected: PASS

- [ ] **Step 5: Surface persistent alerts in `StatusDisplay`**

In `apps/fluux/src/components/sidebar-components/PresenceSelector.tsx`, in `StatusDisplay` (line ~226), read the latest persistent system notification and render it as a one-line alert when present (above/below the connection state). Use a focused selector:

```tsx
import { useEventsStore } from '@fluux/sdk/react'
// inside StatusDisplay:
const persistentAlert = useEventsStore((s) =>
  s.systemNotifications.find((n: { type: string }) => n.type === 'auth-error' || n.type === 'resource-conflict') ?? null
)
// render, when persistentAlert:
{persistentAlert && (
  <p className="text-xs text-fluux-error truncate px-2" title={persistentAlert.message}>
    {persistentAlert.title}
  </p>
)}
```

> Confirm `useEventsStore` is exported from `@fluux/sdk/react` (it is — Decision 1 used it). Place the alert line where it reads naturally in the bottom user panel; keep it a single non-interactive line (no standing list).

- [ ] **Step 6: Mount the effect at app start**

In the app root (where other one-time effects/subscriptions start — e.g. `App.tsx` `useEffect`, or `ChatLayout`), start and stop the effect:

```tsx
import { startSystemNotificationEffect } from '@/effects/systemNotificationEffect'
// inside a top-level useEffect that runs once:
useEffect(() => startSystemNotificationEffect(), [])
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/effects/systemNotificationEffect.ts apps/fluux/src/effects/systemNotificationEffect.test.ts apps/fluux/src/components/sidebar-components/PresenceSelector.tsx apps/fluux/src/App.tsx
git commit -m "feat(system): route system notifications to toasts and the status line"
```

---

## Task 6: Remove `EventsView` (now empty) from the Events branch

**Files:**
- Modify: `apps/fluux/src/components/Sidebar.tsx`
- Delete: `apps/fluux/src/components/sidebar-components/EventsView.tsx`, `apps/fluux/src/components/sidebar-components/EventsView.test.tsx`

**Interfaces:**
- Consumes: nothing new. After Decision 1 (subscription requests gone) + Tasks 3–5 (invitations, strangers, system rehomed), `EventsView` renders nothing actionable.
- Produces: the `'events'` destination renders only `<ActivityLogView />`; the Events rail icon shows no badge.

- [ ] **Step 1: Update `Sidebar.tsx` events branch + drop the Events badge**

In `apps/fluux/src/components/Sidebar.tsx`:
1. Replace the default (events) content branch (the `<><EventsView /><ActivityLogView /></>` at ~line 442) with just:
   ```tsx
   ) : (
     <ActivityLogView />
   )}
   ```
2. Remove the `pendingCount` computation (it was reduced in Decision 1 and is now unused) and set the Events rail link to never badge:
   ```tsx
   <IconRailNavLink icon={Bell} label={t('sidebar.events')} view="events" pathPrefix="/events" onNavigate={onViewChange} />
   ```
   (Drop `showBadge={pendingCount > 0}` and delete the `pendingCount` selector lines.)
3. Remove the `EventsView` import.

- [ ] **Step 2: Delete the `EventsView` files**

```bash
git rm apps/fluux/src/components/sidebar-components/EventsView.tsx apps/fluux/src/components/sidebar-components/EventsView.test.tsx
```

- [ ] **Step 3: Typecheck + lint (catch dangling imports/symbols)**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Fix any now-unused imports in `Sidebar.tsx` (e.g. icons only used by the events badge).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(events): remove the now-empty EventsView; Events hosts only the activity log"
```

---

## Task 7: Archive → header toggle in the Messages view

**Files:**
- Modify: `apps/fluux/src/components/Sidebar.tsx`
- Modify: `apps/fluux/src/components/sidebar-components/ConversationList.tsx` (`ArchiveList` navigates to messages, not archive)
- Create: `apps/fluux/src/components/Sidebar.archiveToggle.test.tsx`

**Interfaces:**
- Produces: a `showArchived` boolean local to `Sidebar`; the Messages header renders an archive toggle button to the **left** of the `+`; the Messages content switches between `<ConversationList />` (active) and `<ArchiveList />` (archived); the header title shows `messages.archivedTitle` when archived. `ArchiveList`'s row click navigates via `navigateToMessages` (the `/archive` route is removed in Task 8).
- Consumes: `messages.showArchived` / `messages.showActive` / `messages.archivedTitle` (Task 1); the existing `<ArchiveList />` export.

- [ ] **Step 1: Point `ArchiveList` clicks at the messages route**

In `apps/fluux/src/components/sidebar-components/ConversationList.tsx` `ArchiveList` (lines 121–185), replace `navigateToArchive` usage with `navigateToMessages` (archived conversations open in the Messages pane; archived-ness is just a list filter):

```tsx
const { navigateToMessages } = useRouteSync()
// ...
const latestNavRef = useRef({ navigateToMessages })
latestNavRef.current = { navigateToMessages }
// in clickRef.current:
L.navigateToMessages(convId, { replace: hasActive })
```

- [ ] **Step 2: Write the failing toggle test**

Create `apps/fluux/src/components/Sidebar.archiveToggle.test.tsx`. Mock `ConversationList`/`ArchiveList` to assert which one renders based on the toggle:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('./sidebar-components/ConversationList', () => ({
  ConversationList: () => <div data-testid="active-list" />,
  ArchiveList: () => <div data-testid="archived-list" />,
}))
// ... mock the remaining heavy Sidebar deps minimally (see test-setup global mock).

import { Sidebar } from './Sidebar'

it('toggles between active and archived conversation lists from the Messages header', () => {
  render(<MemoryRouter initialEntries={['/messages']}><Sidebar onViewChange={vi.fn()} /></MemoryRouter>)
  expect(screen.getByTestId('active-list')).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('messages.showArchived'))
  expect(screen.getByTestId('archived-list')).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('messages.showActive'))
  expect(screen.getByTestId('active-list')).toBeInTheDocument()
})
```

> If rendering the full `Sidebar` is impractical, fall back to extracting the Messages-content selection (`showArchived ? <ArchiveList/> : <ConversationList/>`) and the header toggle into a small `MessagesPanelHeader`/`MessagesList` wrapper and test that wrapper instead. Prefer the integration test.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/Sidebar.archiveToggle.test.tsx`
Expected: FAIL (no toggle yet).

- [ ] **Step 4: Implement the toggle in `Sidebar.tsx`**

1. Add state: `const [showArchived, setShowArchived] = useState(false)`.
2. In the Messages header (after the title `<h1>`, before the `+` button added in Decision 1), add the toggle to the left of `+`:
   ```tsx
   {sidebarView === 'messages' && (
     <Tooltip content={showArchived ? t('messages.showActive') : t('messages.showArchived')} position="bottom">
       <button
         onClick={() => setShowArchived((v) => !v)}
         aria-label={showArchived ? t('messages.showActive') : t('messages.showArchived')}
         className={`p-1 flex items-center ${showArchived ? 'text-fluux-brand' : 'text-fluux-muted hover:text-fluux-text'}`}
       >
         <Archive className="size-5" />
       </button>
     </Tooltip>
   )}
   ```
   (Ensure the `+` button keeps `ms-auto` so the two sit at the right; put the archive toggle just before it. Import `Archive` from `lucide-react`.)
3. Title: when `sidebarView === 'messages' && showArchived`, show `t('messages.archivedTitle')` instead of `t('sidebar.messages')`.
4. Messages content branch: `sidebarView === 'messages' ? (showArchived ? <ArchiveList /> : <ConversationList />)`. Import `ArchiveList` alongside `ConversationList`.
5. Reset `showArchived` to false when leaving the messages view (so re-entering shows active). Add an effect: `useEffect(() => { if (sidebarView !== 'messages') setShowArchived(false) }, [sidebarView])`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/Sidebar.archiveToggle.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/Sidebar.tsx apps/fluux/src/components/sidebar-components/ConversationList.tsx apps/fluux/src/components/Sidebar.archiveToggle.test.tsx
git commit -m "feat(messages): add an archive toggle to the Messages header"
```

---

## Task 8: Remove the Archive rail destination and its routing

**Files:**
- Modify: `apps/fluux/src/components/Sidebar.tsx` (remove the Archive `IconRailNavLink` + the `archive` branches of the content/title switch)
- Modify: `apps/fluux/src/components/sidebar-components/types.tsx` (`SidebarView`, `VIEW_PATHS`)
- Modify: `apps/fluux/src/hooks/useRouteSync.ts` (`parseRoute`, drop `navigateToArchive` or alias it to messages)
- Modify: `apps/fluux/src/hooks/useViewNavigation.ts`, `apps/fluux/src/hooks/useKeyboardShortcuts.ts`, `apps/fluux/src/hooks/useSessionPersistence.ts`
- Tests: update `apps/fluux/src/hooks/useRouteSync.test.tsx`, `useViewNavigation.test.tsx`, `useSessionPersistence.test.ts`, `ChatLayout.test.tsx` as needed.

**Interfaces:**
- Produces: `SidebarView` no longer includes `'archive'`; a `/archive` or `/archive/:jid` URL resolves to `'messages'` (degraded, not thrown); a persisted `'archive'` view degrades to `'messages'`.
- Consumes: the header toggle (Task 7) is the only way to view archived conversations.

- [ ] **Step 1: Write the failing routing test**

In `apps/fluux/src/hooks/useRouteSync.test.tsx`, add:

```tsx
it('resolves a legacy /archive path to the messages view', () => {
  // render the hook under a MemoryRouter at /archive and assert sidebarView === 'messages'
  // (follow the file's existing render/assert helper)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useRouteSync.test.tsx`
Expected: FAIL (`parseRoute('/archive')` still returns `'archive'`).

- [ ] **Step 3: Remove `'archive'` everywhere**

1. `types.tsx`: remove `'archive'` from the `SidebarView` union (line 7) and the `archive` entry from `VIEW_PATHS` (line 90).
2. `useRouteSync.ts`: delete the `if (pathname.startsWith('/archive')) return 'archive'` line in `parseRoute` (so `/archive` falls through to `'messages'`); remove `navigateToArchive` from `RouteActions` and its implementation, OR keep the name as a thin alias to `navigateToMessages` if call sites remain. Update the `view === 'directory' ? '/contacts' : ...` base logic if it special-cased archive.
3. `useViewNavigation.ts`: remove the `case 'archive':` branches (lines ~117, 215) and the archive selected-contact handling.
4. `useKeyboardShortcuts.ts`: remove the `'archive'` from its local `SidebarView` type and any archive shortcut.
5. `useSessionPersistence.ts`: remove `'archive'` from the persisted `sidebarView` union (line 124) and add a normalization on read: if the persisted value is `'archive'` (or `'events'` — handled in 2B), coerce to `'messages'`.
6. `Sidebar.tsx`: remove the `Archive` `IconRailNavLink` (top cluster) and the `archive` branches of the content switch and title switch.

- [ ] **Step 4: Run the routing + persistence tests**

Run: `cd apps/fluux && npx vitest run src/hooks/useRouteSync.test.tsx src/hooks/useViewNavigation.test.tsx src/hooks/useSessionPersistence.test.ts`
Expected: PASS (update any test that asserted an `'archive'` view to the new behavior).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS (the removed `'archive'` literal must not remain anywhere; the compiler enumerates the union).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(nav): remove the Archive rail destination and its routing"
```

---

## Task 9: Full verification (2A)

- [ ] **Step 1: Typecheck** — Run: `npm run typecheck` — Expected: PASS
- [ ] **Step 2: Lint** — Run: `npm run lint` — Expected: PASS
- [ ] **Step 3: Affected tests** — Run: `./scripts/test-affected.sh main` — Expected: PASS, no stderr.
- [ ] **Step 4: Demo smoke (manual)** — `npm run dev` → `demo.html`:
  - Rooms list shows a pinned "Invitations · N" entry; accepting a non-anonymous public-room invite raises the #37 warning before joining.
  - Messages list shows a pinned "Message requests · N" entry; accept opens the conversation.
  - A simulated system notification appears as a toast (transient) or as a one-line status alert (auth-error/resource-conflict).
  - The Messages header has an archive toggle left of the `+`; toggling shows archived conversations and the "Archived" title; selecting one opens it in the main pane.
  - No Archive rail icon. The Events (Bell) rail icon now opens only the activity log and shows no badge. Visiting `/archive` lands on Messages.
- [ ] **Step 5: Commit any fixups** — `git commit -am "chore: 2A verification fixups"`

---

## Self-review notes (decisions for the reviewer)

1. **`'events'` and the Bell icon stay after 2A** — the Events destination temporarily hosts only `<ActivityLogView />`. Plan 2B deletes the activity log and removes the Events rail icon + the `'events'` `SidebarView` value. This interim state is intentional so each plan ships independently.
2. **Archive `showArchived` is local `Sidebar` state, reset on leaving Messages.** Not persisted, not in the URL. If you want archived view to survive navigation or be deep-linkable, promote it to a query param or small UI store — flagged, not built.
3. **System-notification persistence split** (Task 5) treats `auth-error`/`resource-conflict` as persistent (status line) and the rest as transient (toast). Confirm this matches the SDK's `SystemNotificationType` set; adjust the `PERSISTENT_TYPES` set if there are other severe types.
4. **`navigateToArchive` removal vs alias** — Task 8 removes it; if too many call sites remain, alias it to `navigateToMessages` instead. The compiler/tests will show the call sites.
