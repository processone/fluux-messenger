# Settings sidebar grouping and reorder

Date: 2026-06-27
Status: Approved, ready for implementation

## Problem

The settings sidebar is a flat list of 11 entries in an order that buries
related concerns:

- Encryption sits at position 9 (after Storage), far from the other
  privacy and security entries, even though end-to-end encryption is the
  app's headline security feature.
- Storage (a device/maintenance panel) is wedged between Blocked Users and
  Encryption, splitting the natural privacy cluster.
- No grouping at all: 11 flat items are hard to scan.

## Goal

Reorder the entries into four conceptual groups and add small-caps section
headers, so related settings sit together and the list scans quickly.

## Final order and grouping

```
Profile                          (bare, no header)

GENERAL
  Appearance
  Accessibility
  Language & Region
  Notifications

PRIVACY & SECURITY
  Encryption
  Privacy
  Blocked Users

SYSTEM
  Storage        (tauriOnly)
  Updates        (updaterOnly)
  Advanced
```

Rationale for the moves relative to today's order:

- Encryption moves up to lead the Privacy & Security group, next to its
  conceptual siblings (Privacy = what data is shared, Blocked = who is shut
  out). Within the group the order reads crypto identity -> data handling ->
  contact management.
- Storage drops into the System group beside Updates; both are
  device/maintenance concerns and both are the platform-gated entries.
- Advanced stays last, the conventional place for the expert escape hatch.
- The top is nearly unchanged: Profile, then personalization. Notifications
  folds to the end of General as a behavior preference.

The first group (Profile) renders with no header so it sits bare at the top;
section headers begin at General.

## Data model (`types.ts`)

- Add an optional `group` field to `SettingsCategoryConfig`:
  `'account' | 'general' | 'privacy' | 'system'`.
- Reorder `SETTINGS_CATEGORIES` to the order above and tag each entry's
  group. Profile is `account`, which has no header label.
- Add a pure helper `getGroupedVisibleCategories()` that takes the
  platform-filtered list (`getVisibleCategories()`) and returns the groups in
  order, each with its `labelKey` (null for `account`) and its items,
  skipping any group that has no visible items.
  - This makes platform filtering safe: on web, Storage and Updates drop out,
    so System renders with just Advanced; if a group ever empties entirely,
    its header never appears.
- `DEFAULT_SETTINGS_CATEGORY` stays `profile`. Routing is keyed by category
  id, so the reorder does not affect route sync.

## Rendering (`SettingsSidebar.tsx`)

- Replace the single flat `<ul>` with one section per group: an optional
  small-caps `<h3>` heading followed by that group's `<ul>` of buttons.
- Heading style: `text-fluux-muted`, `text-xs`, `font-semibold`,
  `uppercase`, `tracking-wide`, with top spacing between groups. The
  `account` group renders its list with no heading, so Profile sits bare.
- Each group being its own labeled list is more accessible than header rows
  inside a single list.
- Fix the stale comment (current lines 12-13) that claims
  `getVisibleCategories` filters by advanced mode; it does not. This is in
  code being rewritten anyway.

## i18n

Three new keys under `settings.groups`:

- `settings.groups.general` = "General"
- `settings.groups.privacy` = "Privacy & Security"
- `settings.groups.system` = "System"

Values stay normal-case; CSS applies the uppercase transform. Real
translations are required in all 33 locale files; `i18n.test.ts` enforces key
presence. No em-dashes or en-dashes in any value.

## Tests

Unit-test `getGroupedVisibleCategories()`:

- groups appear in the defined order;
- each category lands in its expected group;
- a group with no visible items is omitted;
- the `account` group carries no header label (Profile renders bare).

## Out of scope

- No change to any settings panel content.
- No change to advanced-mode visibility behavior.
- No new platform gating.
