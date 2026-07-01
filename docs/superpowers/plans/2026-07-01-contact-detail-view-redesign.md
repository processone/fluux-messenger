# Contact detail view redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the single-contact detail view (`ContactProfileView`) as a person-forward hero over a responsive card grid, with encryption status shown as a glance card that opens a focused, mobile-full-screen Security detail.

**Architecture:** Presentation-layer only — no SDK, store, or protocol changes. `ContactProfileView` stops using the `Profile`/`Security` tab bar and instead renders a restructured hero, a new `ContactProfileGrid` (About / Devices / Shared / Security-glance cards), and an on-demand `ContactSecurityDetail` overlay that reuses the existing `SecurityTab` and `VerifyPeerDialog`. All data already exists on `Contact` / vCard / `useConversationEncryptionState`.

**Tech Stack:** React 18, TypeScript, Tailwind, Vitest + @testing-library/react, react-i18next.

## Global Constraints

- Worktree path (edit here, not the main checkout): `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/eloquent-mcclintock-6bb18a`. Run all commands from `apps/fluux/`.
- All new/changed i18n keys must exist in **all 33 locales** under `apps/fluux/src/i18n/locales/*.json` — no English placeholders in non-English files.
- No em-dash (`—`/`–`) as a clause connector in i18n values.
- Asserted i18n label keys used in component tests must be added to the hardcoded subset in `apps/fluux/src/test-setup.ts`.
- Before completion: `npm test`, `npm run typecheck`, and `npm run lint` must pass with no errors or stderr (run from repo root).
- Commits are SSH-signed. Never include a Claude footer in commit messages.
- No new npm dependencies.

---

## File structure

**Create:**
- `apps/fluux/src/components/contact-profile/cards/AboutCard.tsx` — vCard fields card
- `apps/fluux/src/components/contact-profile/cards/AboutCard.test.tsx`
- `apps/fluux/src/components/contact-profile/cards/DevicesCard.tsx` — per-resource presence card
- `apps/fluux/src/components/contact-profile/cards/DevicesCard.test.tsx`
- `apps/fluux/src/components/contact-profile/cards/SharedCard.tsx` — group pills card
- `apps/fluux/src/components/contact-profile/cards/SharedCard.test.tsx`
- `apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.tsx` — encryption status glance
- `apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.test.tsx`
- `apps/fluux/src/components/contact-profile/ContactProfileGrid.tsx` — composes the four cards
- `apps/fluux/src/components/contact-profile/ContactProfileGrid.test.tsx`
- `apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx` — overlay wrapping SecurityTab
- `apps/fluux/src/components/contact-profile/ContactSecurityDetail.test.tsx`
- `apps/fluux/src/components/ContactProfileView.test.tsx` — new integration test

**Modify:**
- `apps/fluux/src/components/contact-profile/ContactProfileHero.tsx` — horizontal hero, actions moved right, groups removed
- `apps/fluux/src/components/ContactProfileView.tsx` — remove tabs, render grid + security overlay
- `apps/fluux/src/components/VerifyPeerDialog.tsx` — full-screen on mobile
- `apps/fluux/src/i18n/locales/*.json` (33 files) — new keys
- `apps/fluux/src/test-setup.ts` — asserted keys

**Delete:**
- `apps/fluux/src/components/contact-profile/ContactProfileTabs.tsx`
- `apps/fluux/src/components/contact-profile/ContactProfileTabs.test.tsx`
- `apps/fluux/src/components/contact-profile/tabs/ProfileTab.tsx`

`SecurityTab.tsx` is **kept** (rendered inside `ContactSecurityDetail`).

---

## Task 1: i18n keys (English) + test-setup subset

Adds the new copy first so every later task can consume and assert it.

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json`
- Modify: `apps/fluux/src/test-setup.ts`

**Interfaces:**
- Produces (i18n keys): `contacts.about` = "About", `contacts.shared` = "Shared", `contacts.securityDetailsTitle` = "Security details", `contacts.encryption.glanceVerified` = "Verified and encrypted", `contacts.encryption.glanceEncrypted` = "Encrypted, not verified", `contacts.encryption.glanceNotEncrypted` = "Not encrypted", `contacts.encryption.glanceDisabled` = "Encryption off", `contacts.encryption.glanceLocked` = "Encrypted, locked".

- [ ] **Step 1: Add keys to `en.json`**

In `apps/fluux/src/i18n/locales/en.json`, inside `"contacts"`, add after `"connectedDevices"`:

```json
        "about": "About",
        "shared": "Shared",
        "securityDetailsTitle": "Security details",
```

And inside `"contacts"."encryption"`, add after `"rejectedDescription"`:

```json
            "glanceVerified": "Verified and encrypted",
            "glanceEncrypted": "Encrypted, not verified",
            "glanceNotEncrypted": "Not encrypted",
            "glanceDisabled": "Encryption off",
            "glanceLocked": "Encrypted, locked"
```

(Add a comma after `"rejectedDescription": "..."` so the JSON stays valid.)

- [ ] **Step 2: Add asserted keys to `test-setup.ts`**

In `apps/fluux/src/test-setup.ts`, replace the existing `contacts: { addContact, requestsHeading }` block with:

```ts
        contacts: {
          addContact: 'Add contact',
          requestsHeading: 'Requests',
          contact: 'Contact',
          startConversation: 'Start conversation',
          rename: 'Rename',
          about: 'About',
          shared: 'Shared',
          connectedDevices: 'Connected devices',
          securityDetailsTitle: 'Security details',
          encryption: {
            glanceVerified: 'Verified and encrypted',
            glanceEncrypted: 'Encrypted, not verified',
            glanceNotEncrypted: 'Not encrypted',
            glanceDisabled: 'Encryption off',
            glanceLocked: 'Encrypted, locked',
            verified: 'Verified',
            tofu: 'Encrypted (not verified)',
            fingerprintLabel: 'OpenPGP fingerprint',
            verifyButton: 'Verify fingerprint',
          },
        },
```

- [ ] **Step 3: Verify `en.json` parses**

Run: `cd apps/fluux && node -e "require('./src/i18n/locales/en.json'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/i18n/locales/en.json apps/fluux/src/test-setup.ts
git commit -m "i18n(contacts): add profile-redesign keys (en) + test subset"
```

---

## Task 2: AboutCard

**Files:**
- Create: `apps/fluux/src/components/contact-profile/cards/AboutCard.tsx`
- Test: `apps/fluux/src/components/contact-profile/cards/AboutCard.test.tsx`

**Interfaces:**
- Consumes: `VCardInfo` from `@fluux/sdk`; `InfoRow` from `@/components/profile-shared/InfoRow`; `contacts.about` (Task 1).
- Produces: `export function AboutCard({ vcard }: { vcard: VCardInfo | null }): JSX.Element | null` — returns `null` when the vCard has no `fullName`/`org`/`email`/`country`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AboutCard } from './AboutCard'

describe('AboutCard', () => {
  it('renders vCard fields under the About heading', () => {
    render(<AboutCard vcard={{ fullName: 'Sofia Almeida', org: 'ProcessOne', email: 'sofia@process-one.net', country: 'Portugal' }} />)
    expect(screen.getByText('About')).toBeInTheDocument()
    expect(screen.getByText('ProcessOne')).toBeInTheDocument()
    expect(screen.getByText('sofia@process-one.net')).toBeInTheDocument()
  })

  it('returns null when the vCard is empty', () => {
    const { container } = render(<AboutCard vcard={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/cards/AboutCard.test.tsx`
Expected: FAIL — cannot find module `./AboutCard`.

- [ ] **Step 3: Write the implementation**

```tsx
import { useTranslation } from 'react-i18next'
import { Building2, Mail, MapPin, User } from 'lucide-react'
import { type VCardInfo } from '@fluux/sdk'
import { InfoRow } from '@/components/profile-shared/InfoRow'

interface AboutCardProps {
  vcard: VCardInfo | null
}

export function AboutCard({ vcard }: AboutCardProps) {
  const { t } = useTranslation()
  const hasVcard = vcard && (vcard.fullName || vcard.org || vcard.email || vcard.country)
  if (!hasVcard || !vcard) return null

  return (
    <section className="rounded-xl border border-fluux-hover bg-fluux-bg/40 p-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-1 px-1">
        {t('contacts.about')}
      </h3>
      {vcard.fullName && <InfoRow icon={User} label={vcard.fullName} />}
      {vcard.org && <InfoRow icon={Building2} label={vcard.org} />}
      {vcard.email && <InfoRow icon={Mail} label={vcard.email} />}
      {vcard.country && <InfoRow icon={MapPin} label={vcard.country} />}
    </section>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/cards/AboutCard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/contact-profile/cards/AboutCard.tsx apps/fluux/src/components/contact-profile/cards/AboutCard.test.tsx
git commit -m "feat(contact-profile): AboutCard for vCard fields"
```

---

## Task 3: DevicesCard

**Files:**
- Create: `apps/fluux/src/components/contact-profile/cards/DevicesCard.tsx`
- Test: `apps/fluux/src/components/contact-profile/cards/DevicesCard.test.tsx`

**Interfaces:**
- Consumes: `Contact` from `@fluux/sdk`; `DeviceListItem` from `@/components/profile-shared/DeviceListItem`; `contacts.connectedDevices` (existing key).
- Produces: `export function DevicesCard({ contact, forceOffline }: { contact: Contact; forceOffline: boolean }): JSX.Element | null` — returns `null` when `contact.resources` is empty/undefined.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { DevicesCard } from './DevicesCard'

const base: Contact = {
  jid: 'sofia@process-one.net', name: 'Sofia', presence: 'online', subscription: 'both',
} as Contact

describe('DevicesCard', () => {
  it('renders one row per resource', () => {
    const contact = {
      ...base,
      resources: new Map([
        ['desktop', { show: null, status: '', priority: 1, client: 'Fluux Desktop' }],
      ]),
    } as Contact
    render(<DevicesCard contact={contact} forceOffline={false} />)
    expect(screen.getByText('Connected devices')).toBeInTheDocument()
    expect(screen.getByText('Fluux Desktop')).toBeInTheDocument()
  })

  it('returns null when there are no resources', () => {
    const { container } = render(<DevicesCard contact={base} forceOffline={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/cards/DevicesCard.test.tsx`
Expected: FAIL — cannot find module `./DevicesCard`.

- [ ] **Step 3: Write the implementation**

```tsx
import { useTranslation } from 'react-i18next'
import { type Contact } from '@fluux/sdk'
import { DeviceListItem } from '@/components/profile-shared/DeviceListItem'

interface DevicesCardProps {
  contact: Contact
  forceOffline: boolean
}

export function DevicesCard({ contact, forceOffline }: DevicesCardProps) {
  const { t } = useTranslation()
  const hasResources = contact.resources && contact.resources.size > 0
  if (!hasResources || !contact.resources) return null

  return (
    <section className="rounded-xl border border-fluux-hover bg-fluux-bg/40 p-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2 px-1">
        {t('contacts.connectedDevices')}
      </h3>
      <ul className="space-y-2">
        {Array.from(contact.resources.entries()).map(([resource, presence]) => (
          <DeviceListItem
            key={resource}
            resource={resource}
            presence={presence}
            forceOffline={forceOffline}
          />
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/cards/DevicesCard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/contact-profile/cards/DevicesCard.tsx apps/fluux/src/components/contact-profile/cards/DevicesCard.test.tsx
git commit -m "feat(contact-profile): DevicesCard for per-resource presence"
```

---

## Task 4: SharedCard

**Files:**
- Create: `apps/fluux/src/components/contact-profile/cards/SharedCard.tsx`
- Test: `apps/fluux/src/components/contact-profile/cards/SharedCard.test.tsx`

**Interfaces:**
- Consumes: `contacts.shared` (Task 1).
- Produces: `export function SharedCard({ groups, isInRoster }: { groups: string[] | undefined; isInRoster: boolean }): JSX.Element | null` — returns `null` for non-roster contacts or when `groups` is empty.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SharedCard } from './SharedCard'

describe('SharedCard', () => {
  it('renders a pill per group', () => {
    render(<SharedCard groups={['Team', 'XMPP']} isInRoster={true} />)
    expect(screen.getByText('Shared')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.getByText('XMPP')).toBeInTheDocument()
  })

  it('returns null for a non-roster contact', () => {
    const { container } = render(<SharedCard groups={['Team']} isInRoster={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('returns null when there are no groups', () => {
    const { container } = render(<SharedCard groups={[]} isInRoster={true} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/cards/SharedCard.test.tsx`
Expected: FAIL — cannot find module `./SharedCard`.

- [ ] **Step 3: Write the implementation**

```tsx
import { useTranslation } from 'react-i18next'

interface SharedCardProps {
  groups: string[] | undefined
  isInRoster: boolean
}

export function SharedCard({ groups, isInRoster }: SharedCardProps) {
  const { t } = useTranslation()
  if (!isInRoster || !groups || groups.length === 0) return null

  return (
    <section className="rounded-xl border border-fluux-hover bg-fluux-bg/40 p-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2 px-1">
        {t('contacts.shared')}
      </h3>
      <div className="flex flex-wrap gap-2">
        {groups.map((group) => (
          <span
            key={group}
            className="px-2 py-0.5 text-xs rounded-full bg-fluux-bg text-fluux-text border border-fluux-hover"
          >
            {group}
          </span>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/cards/SharedCard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/contact-profile/cards/SharedCard.tsx apps/fluux/src/components/contact-profile/cards/SharedCard.test.tsx
git commit -m "feat(contact-profile): SharedCard for roster groups"
```

---

## Task 5: SecurityGlanceCard

**Files:**
- Create: `apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.tsx`
- Test: `apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.test.tsx`

**Interfaces:**
- Consumes: `ConversationEncryptionState` from `@/hooks/useConversationEncryptionState`; glance keys (Task 1); existing `chat.encryption.blocked` / `chat.encryption.checking` / `contacts.encryption.rejectedTitle`.
- Produces:
  - `export function SecurityGlanceCard({ state, onOpen }: { state: ConversationEncryptionState; onOpen: () => void }): JSX.Element | null` — returns `null` for `kind: 'disabled'`; otherwise a full-width button that calls `onOpen`.
  - `export function getGlance(state, t): { icon; label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' } | null`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SecurityGlanceCard } from './SecurityGlanceCard'

describe('SecurityGlanceCard', () => {
  it('shows verified label and calls onOpen when clicked', () => {
    const onOpen = vi.fn()
    render(<SecurityGlanceCard state={{ kind: 'encrypted', fingerprint: 'AB', trust: 'verified' }} onOpen={onOpen} />)
    const btn = screen.getByRole('button', { name: 'Verified and encrypted' })
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('shows unverified label for an unverified encrypted state', () => {
    render(<SecurityGlanceCard state={{ kind: 'encrypted', fingerprint: 'AB', trust: 'unverified' }} onOpen={() => {}} />)
    expect(screen.getByText('Encrypted, not verified')).toBeInTheDocument()
  })

  it('renders nothing for the disabled state', () => {
    const { container } = render(<SecurityGlanceCard state={{ kind: 'disabled' }} onOpen={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/cards/SecurityGlanceCard.test.tsx`
Expected: FAIL — cannot find module `./SecurityGlanceCard`.

- [ ] **Step 3: Write the implementation**

```tsx
import { useTranslation } from 'react-i18next'
import {
  ChevronRight, Loader2, Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldX,
} from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

interface SecurityGlanceCardProps {
  state: ConversationEncryptionState
  onOpen: () => void
}

interface Glance {
  icon: typeof ShieldCheck
  label: string
  tone: 'success' | 'neutral' | 'warning' | 'danger'
}

export function getGlance(
  state: ConversationEncryptionState,
  t: (key: string) => string,
): Glance | null {
  switch (state.kind) {
    case 'encrypted':
      return state.trust === 'verified'
        ? { icon: ShieldCheck, label: t('contacts.encryption.glanceVerified'), tone: 'success' }
        : { icon: Lock, label: t('contacts.encryption.glanceEncrypted'), tone: 'neutral' }
    case 'keyLocked':
      return { icon: Lock, label: t('contacts.encryption.glanceLocked'), tone: 'neutral' }
    case 'plaintextForced':
      return { icon: LockOpen, label: t('contacts.encryption.glanceDisabled'), tone: 'neutral' }
    case 'unsupported':
      return { icon: LockOpen, label: t('contacts.encryption.glanceNotEncrypted'), tone: 'neutral' }
    case 'rejected':
      return { icon: ShieldX, label: t('contacts.encryption.rejectedTitle'), tone: 'danger' }
    case 'blocked':
      return { icon: ShieldAlert, label: t('chat.encryption.blocked'), tone: 'warning' }
    case 'checking':
      return { icon: Loader2, label: t('chat.encryption.checking'), tone: 'neutral' }
    default:
      return null
  }
}

const TONE_CLASS: Record<Glance['tone'], string> = {
  success: 'text-fluux-encryption',
  danger: 'text-fluux-error',
  warning: 'text-fluux-yellow',
  neutral: 'text-fluux-muted',
}

export function SecurityGlanceCard({ state, onOpen }: SecurityGlanceCardProps) {
  const { t } = useTranslation()
  const glance = getGlance(state, t)
  if (!glance) return null
  const Icon = glance.icon
  const spin = state.kind === 'checking'

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-2 rounded-xl border border-fluux-hover bg-fluux-bg/40 p-3 text-start hover:bg-fluux-hover/50 transition-colors min-h-[44px]"
    >
      <Icon className={`size-5 flex-shrink-0 ${TONE_CLASS[glance.tone]} ${spin ? 'animate-spin' : ''}`} aria-hidden />
      <span className="text-sm text-fluux-text flex-1 min-w-0">{glance.label}</span>
      <ChevronRight className="size-4 text-fluux-muted flex-shrink-0 rtl-mirror" aria-hidden />
    </button>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/cards/SecurityGlanceCard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.tsx apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.test.tsx
git commit -m "feat(contact-profile): SecurityGlanceCard encryption status"
```

---

## Task 6: ContactProfileGrid

**Files:**
- Create: `apps/fluux/src/components/contact-profile/ContactProfileGrid.tsx`
- Test: `apps/fluux/src/components/contact-profile/ContactProfileGrid.test.tsx`

**Interfaces:**
- Consumes: `AboutCard`, `DevicesCard`, `SharedCard`, `SecurityGlanceCard` (Tasks 2-5); `Contact`, `VCardInfo` from `@fluux/sdk`; `ConversationEncryptionState`.
- Produces: `export function ContactProfileGrid(props: { contact: Contact; vcard: VCardInfo | null; isInRoster: boolean; forceOffline: boolean; encryptionState: ConversationEncryptionState; onOpenSecurity: () => void }): JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { ContactProfileGrid } from './ContactProfileGrid'

const contact = {
  jid: 'sofia@process-one.net', name: 'Sofia', presence: 'online', subscription: 'both',
  groups: ['Team'],
} as Contact

describe('ContactProfileGrid', () => {
  it('renders the shared group and the security glance, and opens security on click', () => {
    const onOpenSecurity = vi.fn()
    render(
      <ContactProfileGrid
        contact={contact}
        vcard={{ org: 'ProcessOne' }}
        isInRoster={true}
        forceOffline={false}
        encryptionState={{ kind: 'encrypted', fingerprint: 'AB', trust: 'verified' }}
        onOpenSecurity={onOpenSecurity}
      />,
    )
    expect(screen.getByText('ProcessOne')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Verified and encrypted' }))
    expect(onOpenSecurity).toHaveBeenCalledOnce()
  })

  it('hides the shared card for a non-roster contact', () => {
    render(
      <ContactProfileGrid
        contact={contact}
        vcard={null}
        isInRoster={false}
        forceOffline={false}
        encryptionState={{ kind: 'disabled' }}
        onOpenSecurity={() => {}}
      />,
    )
    expect(screen.queryByText('Shared')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/ContactProfileGrid.test.tsx`
Expected: FAIL — cannot find module `./ContactProfileGrid`.

- [ ] **Step 3: Write the implementation**

```tsx
import { type Contact, type VCardInfo } from '@fluux/sdk'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { AboutCard } from './cards/AboutCard'
import { DevicesCard } from './cards/DevicesCard'
import { SharedCard } from './cards/SharedCard'
import { SecurityGlanceCard } from './cards/SecurityGlanceCard'

interface ContactProfileGridProps {
  contact: Contact
  vcard: VCardInfo | null
  isInRoster: boolean
  forceOffline: boolean
  encryptionState: ConversationEncryptionState
  onOpenSecurity: () => void
}

export function ContactProfileGrid({
  contact,
  vcard,
  isInRoster,
  forceOffline,
  encryptionState,
  onOpenSecurity,
}: ContactProfileGridProps) {
  return (
    <div className="px-4 py-4 md:px-6 md:py-5 grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
      <AboutCard vcard={vcard} />
      <DevicesCard contact={contact} forceOffline={forceOffline} />
      <SharedCard groups={contact.groups} isInRoster={isInRoster} />
      <SecurityGlanceCard state={encryptionState} onOpen={onOpenSecurity} />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/ContactProfileGrid.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/contact-profile/ContactProfileGrid.tsx apps/fluux/src/components/contact-profile/ContactProfileGrid.test.tsx
git commit -m "feat(contact-profile): ContactProfileGrid card layout"
```

---

## Task 7: ContactSecurityDetail overlay

**Files:**
- Create: `apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx`
- Test: `apps/fluux/src/components/contact-profile/ContactSecurityDetail.test.tsx`

**Interfaces:**
- Consumes: `ModalOverlay` from `../ModalOverlay`; `SecurityTab` from `./tabs/SecurityTab`; `ConversationEncryptionState`; `contacts.securityDetailsTitle` (Task 1); existing `common.back`.
- Produces: `export function ContactSecurityDetail(props: { state: ConversationEncryptionState; onVerify: () => void; onRequestRevoke: () => void; onDisableEncryption: () => void; onEnableEncryption: () => void; onClose: () => void }): JSX.Element`

Full-screen on small screens via `max-md:` overrides of `ModalOverlay`'s base panel classes (`rounded-lg w-full max-w-md mx-4`).

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ContactSecurityDetail } from './ContactSecurityDetail'

const noop = () => {}

describe('ContactSecurityDetail', () => {
  it('renders the security details header and the fingerprint from SecurityTab', () => {
    render(
      <ContactSecurityDetail
        state={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'verified' }}
        onVerify={noop} onRequestRevoke={noop} onDisableEncryption={noop}
        onEnableEncryption={noop} onClose={noop}
      />,
    )
    expect(screen.getByText('Security details')).toBeInTheDocument()
    expect(screen.getByText(/ABCD 1234/)).toBeInTheDocument()
  })

  it('calls onClose when the back button is pressed', () => {
    const onClose = vi.fn()
    render(
      <ContactSecurityDetail
        state={{ kind: 'unsupported' }}
        onVerify={noop} onRequestRevoke={noop} onDisableEncryption={noop}
        onEnableEncryption={noop} onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/ContactSecurityDetail.test.tsx`
Expected: FAIL — cannot find module `./ContactSecurityDetail`.

- [ ] **Step 3: Write the implementation**

```tsx
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { ModalOverlay } from '../ModalOverlay'
import { SecurityTab } from './tabs/SecurityTab'

interface ContactSecurityDetailProps {
  state: ConversationEncryptionState
  onVerify: () => void
  onRequestRevoke: () => void
  onDisableEncryption: () => void
  onEnableEncryption: () => void
  onClose: () => void
}

export function ContactSecurityDetail({
  state,
  onVerify,
  onRequestRevoke,
  onDisableEncryption,
  onEnableEncryption,
  onClose,
}: ContactSecurityDetailProps) {
  const { t } = useTranslation()

  return (
    <ModalOverlay
      onClose={onClose}
      width="max-w-md"
      panelClassName="flex flex-col overflow-hidden md:max-h-[calc(100vh-2rem)] max-md:mx-0 max-md:max-w-none max-md:h-[100dvh] max-md:rounded-none"
    >
      <div className="h-14 px-4 flex items-center gap-2 border-b border-fluux-bg flex-shrink-0">
        <button
          onClick={onClose}
          className="p-1 -ms-1 rounded hover:bg-fluux-hover tap-target"
          aria-label={t('common.back')}
        >
          <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
        </button>
        <h2 className="font-semibold text-fluux-text">{t('contacts.securityDetailsTitle')}</h2>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <SecurityTab
          state={state}
          onVerify={onVerify}
          onRequestRevoke={onRequestRevoke}
          onDisableEncryption={onDisableEncryption}
          onEnableEncryption={onEnableEncryption}
        />
      </div>
    </ModalOverlay>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/ContactSecurityDetail.test.tsx`
Expected: PASS (2 tests).

Note: `common.back` = "Back" and the `chat.encryption`/`contacts.encryption` keys SecurityTab reads must resolve in the test i18n subset. If a test assertion fails because a label renders as its key, add that key to the `test-setup.ts` subset (do not weaken the assertion).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx apps/fluux/src/components/contact-profile/ContactSecurityDetail.test.tsx
git commit -m "feat(contact-profile): ContactSecurityDetail overlay, full-screen on mobile"
```

---

## Task 8: Full-screen VerifyPeerDialog on mobile

**Files:**
- Modify: `apps/fluux/src/components/VerifyPeerDialog.tsx:96-99`
- Test: `apps/fluux/src/components/VerifyPeerDialog.test.tsx`

**Interfaces:**
- No prop changes. Only the `ModalOverlay` `panelClassName` gains `max-md:` full-screen overrides.

- [ ] **Step 1: Write the failing test**

Append to `apps/fluux/src/components/VerifyPeerDialog.test.tsx` (inside the top-level `describe`):

```tsx
  it('makes the panel full-screen on small screens', () => {
    const { container } = render(
      <VerifyPeerDialog
        peerName="Sofia" peerJid="sofia@process-one.net" peerFingerprint="ABCD"
        ownJid="me@process-one.net" ownFingerprint="EF01"
        onConfirm={() => {}} onCancel={() => {}}
      />,
    )
    const panel = container.querySelector('.fluux-glass') as HTMLElement
    expect(panel.className).toContain('max-md:h-[100dvh]')
    expect(panel.className).toContain('max-md:rounded-none')
  })
```

If the existing test file imports/mocks differ, mirror its existing `render(<VerifyPeerDialog .../>)` setup rather than the props above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/VerifyPeerDialog.test.tsx`
Expected: FAIL — className does not contain `max-md:h-[100dvh]`.

- [ ] **Step 3: Edit the panelClassName**

In `apps/fluux/src/components/VerifyPeerDialog.tsx`, replace:

```tsx
      panelClassName="max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden"
```

with:

```tsx
      panelClassName="flex flex-col overflow-hidden md:max-h-[calc(100vh-2rem)] max-md:mx-0 max-md:max-w-none max-md:h-[100dvh] max-md:rounded-none"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/VerifyPeerDialog.test.tsx`
Expected: PASS (all, including the new case).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/VerifyPeerDialog.tsx apps/fluux/src/components/VerifyPeerDialog.test.tsx
git commit -m "feat(verify-peer): full-screen dialog on mobile"
```

---

## Task 9: Restructure ContactProfileHero (horizontal, no groups)

**Files:**
- Modify: `apps/fluux/src/components/contact-profile/ContactProfileHero.tsx`

**Interfaces:**
- No prop changes (`ContactProfileHeroProps` unchanged). Groups block removed (groups now live in `SharedCard`); the `Message` CTA + actions move to the end of the hero row so they sit on the right on desktop and full-width below on mobile.

- [ ] **Step 1: Add a hero structure test**

Create `apps/fluux/src/components/contact-profile/ContactProfileHero.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { ContactProfileHero } from './ContactProfileHero'

const contact = {
  jid: 'sofia@process-one.net', name: 'Sofia', presence: 'online', subscription: 'both',
  groups: ['Team'],
} as Contact

const noop = () => {}

function renderHero() {
  return render(
    <ContactProfileHero
      contact={contact} isInRoster={true} forceOffline={false}
      presenceColor="bg-green-500" statusText="Online" pepNickname={null}
      isEditing={false} editName="Sofia" saving={false} error={null}
      onEditNameChange={noop} onStartEdit={noop} onSaveEdit={noop}
      onCancelEdit={noop} onStartConversation={noop}
    />,
  )
}

describe('ContactProfileHero', () => {
  it('renders the name and the message CTA', () => {
    renderHero()
    expect(screen.getByRole('heading', { name: 'Sofia' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Start conversation/i })).toBeInTheDocument()
  })

  it('does not render group pills in the hero (they live in the Shared card)', () => {
    renderHero()
    expect(screen.queryByText('Team')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify the groups case fails**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/ContactProfileHero.test.tsx`
Expected: FAIL — "Team" is still rendered by the current hero.

- [ ] **Step 3: Restructure the hero JSX**

In `apps/fluux/src/components/contact-profile/ContactProfileHero.tsx`, replace the entire returned JSX (the outer `<div className="px-4 py-5 ...">`) with:

```tsx
  return (
    <div className="px-4 py-5 md:px-6 md:py-6 border-b border-fluux-bg">
      <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-5">
        {/* Avatar */}
        <div className="flex-shrink-0">
          <Avatar
            identifier={contact.jid}
            name={contact.name}
            avatarUrl={contact.avatar}
            size="lg"
            presence={forceOffline ? 'offline' : contact.presence}
            presenceBorderColor="border-fluux-chat"
            forceOffline={forceOffline}
          />
        </div>

        {/* Identity column */}
        <div className="flex-1 min-w-0 flex flex-col items-center sm:items-start text-center sm:text-start w-full">
          {isInRoster && isEditing ? (
            <div className="flex flex-col items-center sm:items-start gap-1 w-full max-w-sm">
              <TextInput
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => { void onSaveEdit() }}
                disabled={saving}
                className="text-xl font-bold text-fluux-text bg-fluux-bg rounded px-3 py-1 w-full border border-fluux-brand focus:outline-none disabled:opacity-50"
              />
              {error && <p className="text-xs text-fluux-error">{error}</p>}
              {saving && <p className="text-xs text-fluux-muted">{t('common.saving')}</p>}
            </div>
          ) : (
            <div className="group relative flex items-center justify-center sm:justify-start gap-1">
              <h1 className="text-xl font-bold text-fluux-text break-all">{contact.name}</h1>
              {isInRoster && (
                <Tooltip content={t('contacts.rename')} position="top">
                  <button
                    type="button"
                    onClick={onStartEdit}
                    aria-label={t('contacts.rename')}
                    className="p-1 ms-1 text-fluux-muted hover:text-fluux-text rounded opacity-0 group-hover:opacity-100 focus:opacity-100 touch:opacity-100 transition-opacity tap-target"
                  >
                    <Pencil className="size-4" />
                  </button>
                </Tooltip>
              )}
            </div>
          )}

          <p className="text-fluux-muted text-sm mt-1 break-all">{contact.jid}</p>

          {pepNickname && (
            <p className="text-fluux-muted text-xs mt-1 italic">"{pepNickname}"</p>
          )}

          <div className="flex items-center gap-2 mt-2">
            <span className={`size-2 rounded-full ${presenceColor}`} />
            <span className="text-fluux-text text-sm">{statusText}</span>
          </div>

          {contact.statusMessage && (
            <p className="text-fluux-muted text-sm mt-1 italic break-words">"{contact.statusMessage}"</p>
          )}
        </div>

        {/* Primary CTA + actions menu — right on desktop, full-width below on mobile */}
        <div className="w-full sm:w-auto sm:self-center flex items-center gap-2">
          <button
            type="button"
            onClick={onStartConversation}
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-brand hover:bg-fluux-brand-hover text-fluux-text-on-accent rounded-lg transition-colors min-h-[44px]"
          >
            <MessageCircle className="size-5" />
            {t('contacts.startConversation')}
          </button>
          {actionsSlot}
        </div>
      </div>
    </div>
  )
```

The `groups` block is intentionally dropped. No import changes are needed (Avatar, Tooltip, TextInput, MessageCircle, Pencil are already imported).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/ContactProfileHero.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/contact-profile/ContactProfileHero.tsx apps/fluux/src/components/contact-profile/ContactProfileHero.test.tsx
git commit -m "feat(contact-profile): horizontal hero, groups move to Shared card"
```

---

## Task 10: Rewire ContactProfileView (remove tabs, add grid + security overlay)

**Files:**
- Modify: `apps/fluux/src/components/ContactProfileView.tsx`
- Test: `apps/fluux/src/components/ContactProfileView.test.tsx` (create)

**Interfaces:**
- Consumes: `ContactProfileGrid` (Task 6), `ContactSecurityDetail` (Task 7).
- `ContactProfileViewProps` unchanged. Internally: replace `activeTab` state with `securityOpen`; drop `ContactProfileTabs`, `ProfileTab`, and the direct `SecurityTab` import/usage.

- [ ] **Step 1: Write the failing integration test**

Create `apps/fluux/src/components/ContactProfileView.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { ContactProfileView } from './ContactProfileView'

vi.mock('@/hooks/useConversationEncryptionState', () => ({
  useConversationEncryptionState: () => ({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'verified' }),
}))

const contact = {
  jid: 'sofia@process-one.net', name: 'Sofia', presence: 'online', subscription: 'both',
  groups: ['Team'],
} as Contact

const props = {
  contact,
  onStartConversation: vi.fn(),
  onRemoveContact: vi.fn(),
  onRenameContact: vi.fn(async () => {}),
  onFetchNickname: vi.fn(async () => null),
  onFetchVCard: vi.fn(async () => ({ org: 'ProcessOne' })),
}

describe('ContactProfileView', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the card grid and no tab bar', () => {
    render(<ContactProfileView {...props} />)
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('opens the security detail when the glance card is clicked', () => {
    render(<ContactProfileView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Verified and encrypted' }))
    expect(screen.getByText('Security details')).toBeInTheDocument()
  })
})
```

If the SDK/store hooks used by `ContactProfileView` aren't already covered by the global `@fluux/sdk` mock in `test-setup.ts`, extend the mock (spread `importOriginal()`) rather than deleting assertions. Mirror the mocking style already used in `ChatLayout.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/ContactProfileView.test.tsx`
Expected: FAIL — a tab bar is present / "Security details" not reachable.

- [ ] **Step 3: Update imports**

In `apps/fluux/src/components/ContactProfileView.tsx`, remove these imports:

```tsx
import { ContactProfileHero } from './contact-profile/ContactProfileHero'
import { ContactProfileTabs, type ContactProfileTab } from './contact-profile/ContactProfileTabs'
import { ProfileTab } from './contact-profile/tabs/ProfileTab'
import { SecurityTab } from './contact-profile/tabs/SecurityTab'
```

and replace with:

```tsx
import { ContactProfileHero } from './contact-profile/ContactProfileHero'
import { ContactProfileGrid } from './contact-profile/ContactProfileGrid'
import { ContactSecurityDetail } from './contact-profile/ContactSecurityDetail'
```

- [ ] **Step 4: Swap the tab state for securityOpen**

Replace:

```tsx
  const [activeTab, setActiveTab] = useState<ContactProfileTab>('profile')
```

with:

```tsx
  const [securityOpen, setSecurityOpen] = useState(false)
```

In the `useEffect` that resets transient state on contact change, replace `setActiveTab('profile')` with `setSecurityOpen(false)`.

- [ ] **Step 5: Replace the tabs + tabpanel render block**

Replace the block from `<ContactProfileTabs ... />` through the closing `</div>` of the `role="tabpanel"` container (currently lines ~252-275) with:

```tsx
            <ContactProfileGrid
              contact={contact}
              vcard={vcard}
              isInRoster={isInRoster}
              forceOffline={forceOffline}
              encryptionState={encryptionState}
              onOpenSecurity={() => setSecurityOpen(true)}
            />
```

Then, immediately after the closing `</div>` of `<div className="flex-1 overflow-y-auto">` (before the closing `</div>` of the `bg-fluux-chat` container), add the overlay:

```tsx
        {securityOpen && (
          <ContactSecurityDetail
            state={encryptionState}
            onVerify={() => setShowVerifyDialog(true)}
            onRequestRevoke={() => setPendingConfirm('revokeVerify')}
            onDisableEncryption={handleDisableEncryption}
            onEnableEncryption={handleEnableEncryption}
            onClose={() => setSecurityOpen(false)}
          />
        )}
```

The existing `ConfirmDialog` and `VerifyPeerDialog` render blocks at the bottom stay unchanged — `onVerify` still routes through `setShowVerifyDialog(true)`, so `VerifyPeerDialog` opens above the security overlay.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/ContactProfileView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/ContactProfileView.tsx apps/fluux/src/components/ContactProfileView.test.tsx
git commit -m "feat(contact-profile): single-scroll profile with security overlay"
```

---

## Task 11: Delete dead files (ProfileTab, ContactProfileTabs)

**Files:**
- Delete: `apps/fluux/src/components/contact-profile/tabs/ProfileTab.tsx`
- Delete: `apps/fluux/src/components/contact-profile/ContactProfileTabs.tsx`
- Delete: `apps/fluux/src/components/contact-profile/ContactProfileTabs.test.tsx`

**Interfaces:**
- No remaining importers after Task 10. `InfoRow` and `DeviceListItem` are still used (by AboutCard/DevicesCard), so `profile-shared/` stays.

- [ ] **Step 1: Confirm there are no remaining importers**

Run: `cd apps/fluux && grep -rn "ProfileTab\|ContactProfileTabs" src --include="*.tsx" --include="*.ts" | grep -v "SecurityTab"`
Expected: no matches (empty output).

- [ ] **Step 2: Delete the files**

```bash
git rm apps/fluux/src/components/contact-profile/tabs/ProfileTab.tsx \
       apps/fluux/src/components/contact-profile/ContactProfileTabs.tsx \
       apps/fluux/src/components/contact-profile/ContactProfileTabs.test.tsx
```

- [ ] **Step 3: Run the contact-profile test suite**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile src/components/ContactProfileView.test.tsx src/components/VerifyPeerDialog.test.tsx`
Expected: PASS, no missing-module errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(contact-profile): remove tab bar and ProfileTab"
```

---

## Task 12: Translate new keys into the other 32 locales

**Files:**
- Modify: `apps/fluux/src/i18n/locales/*.json` (all except `en.json`)

**Interfaces:**
- Same 8 keys from Task 1, translated per locale following each file's existing tone. Keys: `contacts.about`, `contacts.shared`, `contacts.securityDetailsTitle`, `contacts.encryption.glanceVerified`, `contacts.encryption.glanceEncrypted`, `contacts.encryption.glanceNotEncrypted`, `contacts.encryption.glanceDisabled`, `contacts.encryption.glanceLocked`.

- [ ] **Step 1: Add translated keys to every non-English locale**

For each `apps/fluux/src/i18n/locales/<lang>.json`, add the same keys in the same nesting positions as Task 1, translated into `<lang>`. No em-dash connectors. Reference translations (use these verbatim for the languages shown; translate the remaining locales in the same spirit, matching sibling-key style already in each file):

**fr.json** — `about`: "À propos", `shared`: "En commun", `securityDetailsTitle`: "Détails de sécurité", `glanceVerified`: "Vérifié et chiffré", `glanceEncrypted`: "Chiffré, non vérifié", `glanceNotEncrypted`: "Non chiffré", `glanceDisabled`: "Chiffrement désactivé", `glanceLocked`: "Chiffré, verrouillé".

**de.json** — `about`: "Info", `shared`: "Gemeinsam", `securityDetailsTitle`: "Sicherheitsdetails", `glanceVerified`: "Verifiziert und verschlüsselt", `glanceEncrypted`: "Verschlüsselt, nicht verifiziert", `glanceNotEncrypted`: "Nicht verschlüsselt", `glanceDisabled`: "Verschlüsselung aus", `glanceLocked`: "Verschlüsselt, gesperrt".

**es.json** — `about`: "Información", `shared`: "En común", `securityDetailsTitle`: "Detalles de seguridad", `glanceVerified`: "Verificado y cifrado", `glanceEncrypted`: "Cifrado, sin verificar", `glanceNotEncrypted`: "Sin cifrar", `glanceDisabled`: "Cifrado desactivado", `glanceLocked`: "Cifrado, bloqueado".

**pt.json** — `about`: "Sobre", `shared`: "Em comum", `securityDetailsTitle`: "Detalhes de segurança", `glanceVerified`: "Verificado e cifrado", `glanceEncrypted`: "Cifrado, não verificado", `glanceNotEncrypted`: "Não cifrado", `glanceDisabled`: "Cifragem desativada", `glanceLocked`: "Cifrado, bloqueado".

Remaining locales to translate: `ar, be, bg, ca, cs, da, el, et, fi, ga, he, hr, hu, is, it, lt, lv, mt, nb, nl, pl, ro, ru, sk, sl, sv, uk, zh-CN`.

- [ ] **Step 2: Verify every locale parses and has all 8 keys**

Run:

```bash
cd apps/fluux && node -e '
const fs=require("fs"),d="src/i18n/locales";
const keys=[["about"],["shared"],["securityDetailsTitle"],["encryption","glanceVerified"],["encryption","glanceEncrypted"],["encryption","glanceNotEncrypted"],["encryption","glanceDisabled"],["encryption","glanceLocked"]];
let bad=0;
for(const f of fs.readdirSync(d).filter(f=>f.endsWith(".json"))){
  const j=JSON.parse(fs.readFileSync(d+"/"+f));const c=j.contacts||{};
  for(const k of keys){let o=c;for(const p of k)o=o&&o[p];if(o==null){console.log("MISSING",f,k.join("."));bad++}}
}
console.log(bad?("FAIL "+bad):"ok");
'
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/i18n/locales/
git commit -m "i18n(contacts): translate profile-redesign keys into all locales"
```

---

## Task 13: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: all pass, no stderr.

- [ ] **Step 2: Typecheck**

Run (from repo root): `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run (from repo root): `npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual demo smoke check (optional but recommended)**

Run `npm run dev`, open `http://localhost:5173/demo.html`, open a contact profile. Verify: horizontal hero with Message on the right, About/Devices/Shared/Security cards, Security glance opens the detail overlay; narrow the window to confirm the grid collapses to one column and the security detail fills the screen.

- [ ] **Step 5: Final commit if any verification fixes were needed**

```bash
git add -A
git commit -m "chore(contact-profile): verification fixes"
```

(Skip if steps 1-3 were already green.)

---

## Self-review notes

- **Spec coverage:** hero (Task 9), card grid + About/Devices/Shared/Security-glance (Tasks 2-6), security detail panel + mobile full-screen (Task 7), verify dialog mobile full-screen (Task 8), tabs retired + ProfileTab split (Tasks 10-11), non-roster handling (SharedCard null + ContactProfileGrid test, Tasks 4/6), i18n all locales (Tasks 1/12), testing + typecheck + lint (Task 13). "Shared rooms in common" and Call/Video are out of scope per the spec — no task, by design.
- **Type consistency:** `getGlance` and `SecurityGlanceCard` props match across Tasks 5-6; `ContactSecurityDetail` props match the handlers wired in Task 10; `ContactProfileGrid` prop names (`onOpenSecurity`, `encryptionState`) are identical in Tasks 6 and 10.
- **Risk flagged:** the `max-md:` full-screen overrides (Tasks 7-8) depend on Tailwind emitting `max-md:` after the base `rounded-lg`/`max-w-md` rules so they win the cascade. Verified conceptually (max-width variants are emitted later in the stylesheet); Task 13 step 4 confirms visually. If an override doesn't take, add `!` important (e.g. `max-md:!rounded-none`).
