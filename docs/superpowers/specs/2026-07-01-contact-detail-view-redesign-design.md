# Contact detail view redesign — design

**Date:** 2026-07-01
**Status:** Approved, ready for implementation plan
**Scope:** Single-contact detail view only (`ContactProfileView`). No changes to the contacts list/roster.

## Goal

Make the single-contact detail view feel more engaging and professional. The
data model is already rich (presence, status, groups, per-device resources,
vCard org/email/country, E2EE fingerprints) but today's view is flat: a plain
hero followed by two tabs (`Profile`, `Security`) that hide most of it.

The redesign ("Option C — blend") keeps a warm, person-forward hero and
surfaces the professional signals — org/role, devices, shared groups, and
encryption status — on one scrollable screen, with deep crypto controls moved
to a focused, mobile-friendly detail surface.

## Chosen direction

Person-forward hero over an information-rich card grid. The `Profile`/`Security`
tab bar is removed. Encryption *status* stays visible on the main screen as a
glance card; fingerprint verification and enable/disable controls open on demand
as a focused panel (desktop) / full-screen view (mobile).

## Layout

`ContactProfileView` becomes a single scroll:

1. **Hero** (horizontal on desktop, stacked on mobile)
2. **Card grid** (2-column desktop → 1-column mobile)
3. **Security detail overlay** (opened on demand from the glance card)

### Hero — `ContactProfileHero` (restructured)

- Desktop: avatar with presence ring · name + inline presence dot/text + status
  message · `Message` primary button · actions kebab.
- Mobile: avatar + name row, then a full-width `Message` button.
- Inline rename (pencil → `TextInput`, save on blur/Enter, Escape to cancel)
  is preserved unchanged.
- Actions kebab is the existing `ContactActionsMenu`
  (rename / remove / block / unblock / add) — unchanged.

### Card grid (new)

Responsive grid, `minmax(0, 1fr)` columns, collapses to one column on mobile.

- **About** — org + role, email, location. Sourced from the vCard already
  fetched by `ContactProfileView` (`fullName` / `org` / `email` / `country`).
  Renders only the fields that are present; if the vCard is empty the card is
  omitted.
- **Devices** — per-resource presence derived from `contact.resources` (the
  same data `ProfileTab` renders today: client name, presence, last activity).
- **Shared** — roster `groups` as pills. Hidden entirely for non-roster
  contacts (they have no groups).
- **Security glance** — teal one-line status derived from `encryptionState`:
  - `encrypted` + verified → "Verified & encrypted"
  - `encrypted` + unverified → "Encrypted, not verified"
  - not encrypted → "Not encrypted"
  Tapping the card opens the Security detail overlay.

### Security detail — `ContactSecurityDetail` (new wrapper)

Reuses the existing `SecurityTab` content (both fingerprints, Verify button,
enable/disable encryption) and `VerifyPeerDialog`. No crypto logic is rewritten
— this is a presentation wrapper plus open/close state.

- **Desktop:** focused panel over the profile.
- **Mobile:** full-screen view with a back arrow, matching the profile's own
  mobile full-screen + back pattern (`md:hidden` back button in
  `ContactProfileView`'s header).
- **`VerifyPeerDialog`:** on small screens it also goes full-screen (full
  width/height) so the two-column fingerprint comparison isn't cramped. This is
  the specific mobile requirement called out during design.

Open/close state (`securityOpen`) lives in `ContactProfileView`, alongside the
existing `showVerifyDialog` / `pendingConfirm` state.

## Components

| Component | Change |
|-----------|--------|
| `ContactProfileView.tsx` | Remove tabs + tab-panel switching. Render hero → card grid → security overlay. Add `securityOpen` state. Keeps existing vCard/nickname/last-activity fetches, encryption state, verify/block/remove handlers. |
| `contact-profile/ContactProfileHero.tsx` | Restructure to horizontal desktop hero (name + presence/status inline, `Message` + kebab on the right). Mobile stacks. Rename UI unchanged. |
| `contact-profile/ContactProfileGrid.tsx` (new) | Card grid container; renders About / Devices / Shared / Security-glance cards, omitting cards with no data and Shared for non-roster. |
| `contact-profile/cards/AboutCard.tsx` (new) | vCard fields (org/role, email, location). |
| `contact-profile/cards/DevicesCard.tsx` (new) | Per-resource presence from `contact.resources`. |
| `contact-profile/cards/SharedCard.tsx` (new) | Group pills. |
| `contact-profile/cards/SecurityGlanceCard.tsx` (new) | Encryption status one-liner; `onOpen` callback. |
| `contact-profile/ContactSecurityDetail.tsx` (new) | Overlay wrapper around `SecurityTab`; panel on desktop, full-screen on mobile. |
| `contact-profile/tabs/SecurityTab.tsx` | Kept; rendered inside `ContactSecurityDetail` instead of a tab. |
| `contact-profile/tabs/ProfileTab.tsx` | Retired; its content is split into `AboutCard` + `DevicesCard`. |
| `contact-profile/ContactProfileTabs.tsx` | Retired (tab bar removed). |

## Data flow

No SDK or store changes. All fields already exist on `Contact`
(`packages/fluux-sdk/src/core/types/roster.ts`) or are already fetched by
`ContactProfileView` (vCard via `onFetchVCard`, encryption via
`useConversationEncryptionState`). The redesign is a presentation-layer change.

## Non-roster (stranger) contacts

The view already serves non-roster contacts (`isInRoster={false}`, route
`/contacts/:jid`). Behavior:

- Shared card hidden (no groups).
- About card shows whatever the vCard returns (may be sparse/omitted).
- Actions kebab shows `Add contact`.
- Everything else identical.

## Responsive behavior

- Card grid: 2 columns on desktop, 1 column on mobile.
- Hero: horizontal on desktop, stacked with full-width `Message` on mobile.
- Security detail: focused panel on desktop, full-screen with back arrow on
  mobile.
- `VerifyPeerDialog`: full-screen on small screens.

## Testing

- Component tests: card rendering with full data and with sparse/empty vCard;
  glance → open → close of the security overlay; non-roster variant (no Shared
  card, Add contact action); mobile full-screen security surface.
- New asserted label keys added to the hardcoded i18n subset in
  `apps/fluux/src/test-setup.ts`.
- `npm test`, `npm run typecheck`, and lint must pass with no errors or stderr
  before commit.

## i18n

New keys (About, Devices, Shared, Location, the three security-glance strings,
"Security details", and any card labels) translated into all 33 locales — no
English placeholders, no em-dash clause connectors in values.

## Out of scope

- Call / Video actions (no SFU/LiveKit integration yet).
- "Shared rooms in common" — not computed anywhere today; groups only.
- Any contacts list / roster / navigation changes.
- SDK, store, or protocol changes.
