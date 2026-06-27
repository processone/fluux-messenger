# Advanced Mode Toggle Placement — Design

Date: 2026-06-27
Status: Approved (pending implementation plan)

## Problem

`advancedMode` is a persisted boolean ([advancedModeStore.ts](../../../apps/fluux/src/stores/advancedModeStore.ts), localStorage key `fluux-advanced-mode`) that unlocks expert surfaces in the app. Today its UI is asymmetric and self-trapping:

- **Enable**: only via a checkbox on the login screen ([LoginScreen.tsx:622](../../../apps/fluux/src/components/LoginScreen.tsx)).
- **Disable**: only inside Settings -> Advanced category, which is itself gated by the flag (`advancedOnly: true` in [types.ts `getVisibleCategories`](../../../apps/fluux/src/components/settings-components/types.ts)).

This creates two concrete problems:

1. **Reachability (the autoconnect trap).** With autoconnect enabled (Remember me + keychain), the login screen is never shown. A user who autoconnects with advanced mode **off** has no in-app way to turn it on, because the only in-app control lives behind the very flag it controls.
2. **Login clutter.** The login form carries two separate "advanced-ish" affordances: the advanced-mode checkbox (which reveals nothing on the form itself, only flips the global flag) and an independent collapsible "SERVER" disclosure ([LoginScreen.tsx:518](../../../apps/fluux/src/components/LoginScreen.tsx)) for a custom server.

A third intent: server info (currently buried in the XMPP console) should also "ride" this toggle, making advanced mode the single expert-surface switch.

## Concept

Advanced mode is a **power-user preference**: discoverable but quiet, flippable anytime from Settings. It is the single switch that unlocks expert surfaces (custom server on login, the Advanced settings category, the XMPP console / server info). The store itself is unchanged; the key `fluux-advanced-mode` persists, so existing users keep their setting and no migration is required.

## Design

### 1. Canonical in-app home — Settings -> Advanced, always visible

The in-app home is the real fix for the autoconnect trap.

- In [types.ts](../../../apps/fluux/src/components/settings-components/types.ts), drop `advancedOnly: true` from the `advanced` category entry so the category is **always** present in the settings sidebar (sitting quietly at the bottom). The flag no longer gates the container of its own control. The `advancedOnly` field stays on the `SettingsCategoryConfig` type and in `getVisibleCategories()` for potential future use, but no category uses it after this change.
- [AdvancedSettings.tsx](../../../apps/fluux/src/components/settings-components/AdvancedSettings.tsx) becomes flag-aware (reads `advancedMode` reactively via `useAdvancedModeStore`):
  - **OFF state:** a short explanation of what advanced mode unlocks, plus an **Enable advanced mode** control that calls `setAdvancedMode(true)`.
  - **ON state:** today's content unchanged — warning banner, options placeholder, and a **Disable advanced mode** control that calls `setAdvancedMode(false)`.
- Use the same toggle/button styling already used by the existing disable control (or an existing settings switch component if one is in use); do not introduce a new visual pattern.

### 2. Login screen — kebab consolidates, form declutters

- Remove the inline advanced-mode checkbox ([LoginScreen.tsx:620-635](../../../apps/fluux/src/components/LoginScreen.tsx)).
- Remove the separate "SERVER" disclosure chevron and its `showServerField` local state ([LoginScreen.tsx:518-560](../../../apps/fluux/src/components/LoginScreen.tsx)).
- Add an `OverflowMenu` kebab in the login card corner with a single checkable item: **Advanced mode**. Selecting it toggles `advancedMode`.
- The custom-server field is shown when `advancedMode` is on, hidden when off. One flag now governs all expert login options. The default login form is clean (JID, password, remember me, connect).
- **Deep-link edge case:** when a deep link prefills a custom server host (`linkServerHost`), enable advanced mode (or otherwise force the server field visible) so the prefilled value is shown to the user rather than hidden.

### 3. OverflowMenu enhancement (toggle items)

`OverflowMenu` / `OverflowMenuItem` ([OverflowMenu.tsx](../../../apps/fluux/src/components/OverflowMenu.tsx)) currently supports plain action items only. Add an optional `active?: boolean` to `OverflowMenuItem`. When `active` is true, render a trailing check mark on the item to convey toggle state. This is a small, reusable enhancement (the idiomatic "toggle inside a menu" pattern) consumed by the login kebab; existing call sites are unaffected.

### 4. Server info — gate the console

- In [UserMenu.tsx](../../../apps/fluux/src/components/sidebar-components/UserMenu.tsx), show the "Show console" item only when `advancedMode` is on (keep the existing desktop-only condition). The console already contains server info and raw stanza debugging, so server info rides the toggle with zero new UI; casual users get a cleaner menu.
- If advanced mode is turned off while the console is open, close the console (call the existing toggle/close) so no orphaned console view remains.

### 5. i18n and guards

- New i18n keys: `settings.advanced.enable`, `settings.advanced.enableDescription`, and a login kebab aria-label (reuse `common.options` if suitable, otherwise add `login.options`). The existing `settings.advanced.disable` / `settings.advanced.disableDescription` keys are reused for the ON state.
- Every new key requires a genuine translation in all 33 locale files (no placeholders); `i18n.test.ts` enforces presence.
- No em-dashes or en-dashes in any user-facing string (project rule).

### Tests

- `getVisibleCategories()` includes the `advanced` category regardless of the flag value.
- `AdvancedSettings` renders the Enable control when off and the Disable control when on.
- `UserMenu` hides the "Show console" item when advanced mode is off and shows it when on (desktop).
- `LoginScreen` renders the kebab (no inline checkbox), and the custom-server field is visible only when advanced mode is on.
- `OverflowMenu` renders the trailing check for an `active` item.

## Out of scope (deferred)

- A dedicated, non-developer "Server info" view separate from the raw console.
- Populating the Advanced settings category with actual expert options (custom resource, insecure-TLS opt-in, connection tuning). The category remains a foundation with the toggle plus placeholder.

## Affected files

- `apps/fluux/src/components/settings-components/types.ts` — drop `advancedOnly` from the advanced category.
- `apps/fluux/src/components/settings-components/AdvancedSettings.tsx` — flag-aware enable/disable.
- `apps/fluux/src/components/LoginScreen.tsx` — remove checkbox + SERVER chevron; add kebab; gate server field on flag.
- `apps/fluux/src/components/OverflowMenu.tsx` — optional `active` toggle item.
- `apps/fluux/src/components/sidebar-components/UserMenu.tsx` — gate console behind the flag; close console on disable.
- `apps/fluux/src/i18n/locales/*` — new keys in all 33 locales.
- Corresponding test files for the above.
