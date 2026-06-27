# Aurora Settings and Admin — Design Spec

- Status: Approved (design + scope), pending spec review
- Date: 2026-06-27
- Screen: #7 in `2026-06-26-aurora-screen-inventory.md` ("Settings & admin")
- Scope: `apps/fluux` — a shared settings-primitive kit applied across all settings panes, plus a LIGHT admin visual pass. The deeper admin restyle stays with the separate admin-friendliness track (which reuses these primitives).

## Goal

Make the settings (and, lightly, admin) screens read as one consistent Aurora surface. Today every pane hand-rolls its section headers, row padding/borders/backgrounds, and toggles, so spacing and controls drift pane-to-pane. Introduce a small shared primitive kit and apply it everywhere, so settings have one rhythm, one toggle, one row, one section.

## Background — the inconsistencies (recon-confirmed)

11 settings category panes + 3 profile subsections + 5 admin panels, evolved independently. Concrete gaps:
- **No shared layout primitives** (`components/ui/` has only `TextInput`, `BottomSheet`, `ListEmpty`). Each pane hand-rolls section + row markup.
- **3 hand-rolled toggles** (`EncryptionSettings`, `AppearanceSettings` CSS-snippets, etc.) — no shared `Toggle`.
- **Row drift:** padding (`p-3` vs `p-4`), borders (`border` vs `border-2`), background opacity (`bg-fluux-bg/40` vs `/60` vs solid) vary pane to pane.
- **Spacing drift:** some panes wrap sections in `space-y-6`, others `space-y-3`, `StorageSettings` uses two inline blocks.
- **Ad-hoc `<select>`** styling (`LanguageSettings` inline classString + chevron).
- **Admin:** headers use `text-lg` plain (settings use `text-xs` uppercase) — no shared header; **hardcoded colors** (`bg-red-500/10 text-red-500`) instead of tokens; no shared admin row/card.
- **Display font** is applied to pane titles (via the base `h1-h6` rule) but NOT to section labels or admin panel headers consistently.

## Design

### Shared primitive kit (new, in `components/ui/`)

1. **`SettingsSection`** — `{ title: string; description?: string; children; className? }`. Renders the consistent section label (the existing `text-xs font-semibold uppercase tracking-wide text-fluux-muted` style, standardized) + optional description, and a content slot with one spacing rhythm. Replaces every pane's hand-rolled `<h3>` + outer wrapper. Content is flexible (a grouped row-card OR free-form content like the theme grid).
2. **`SettingsGroup`** — `{ children; className? }`. The grouped card: a rounded container with a hairline border (`--fluux-surface-divider`) and `divide-y` dividers between its `SettingsRow` children (the iOS-style grouped list in the mock). Used when a section is a list of rows.
3. **`SettingsRow`** — `{ label: string; description?: string; htmlFor?: string; children }`. One row: label + optional description on the start, the control (`children` — a `Toggle`, `Select`, button, value) on the end, with uniform padding + `gap`. `htmlFor` associates the label with the control for a11y.
4. **`Toggle`** — `{ checked: boolean; onChange: (next: boolean) => void; disabled?; id?; 'aria-label'? }`. The single accent switch (accent track when on, neutral when off, white knob). Replaces all hand-rolled toggles. Reuses the existing on/off token treatment (`bg-fluux-brand` on).
5. **`Select`** — a thin styled wrapper over the native `<select>` `{ value; onChange; id?; children (options); className? }` with the chevron + consistent border/padding/background. Replaces the ad-hoc select styling.

All five are presentational + token-based (callers own state + i18n), mirroring the existing `ui/TextInput` convention.

### Apply across ALL settings panes

Migrate the 11 category panes + 3 profile subsections to the kit: sections -> `SettingsSection`, row-lists -> `SettingsGroup` + `SettingsRow`, toggles -> `Toggle`, selects -> `Select`. **Keep every pane's actual controls, logic, and copy keys** — this is a layout/consistency migration, not a feature or copy change. Free-form sections (theme picker grid, accent swatches) keep their custom content inside a `SettingsSection`.

### Admin — LIGHT visual pass only

- **Back-to-admin-home affordance (the one navigation gap to close).** Today the admin back button (`AdminRoomView`/`AdminUserView` `onBack` + `adminBackTarget.ts`) steps detail -> list only; from inside a category there is no clear route back to the admin root. Add an **Aurora breadcrumb in the admin header**: `Administration › <Category> › <detail>`, where `Administration` (and the category crumb) are clickable to navigate up — so admin home is always one click away. `Administration` wires to the existing admin-root navigation (clear the category / `navigateToAdmin()` with no category); the category crumb reuses the existing `adminBackTarget` step. The current `ArrowLeft` back button can stay (steps one level) or be folded into the breadcrumb; the breadcrumb is the durable affordance. The crumb separator is a chevron icon, NOT an em-dash or slash glyph that reads as text.
- **Tokenize hardcoded colors:** `bg-red-500/10 text-red-500` (and any other literals) -> the Aurora danger treatment (`--fluux-status-error` / `--fluux-color-red` tokens; a shared danger-button style).
- **Align headers:** admin panel/section headers adopt the display font + the settings type scale (so admin and settings read as one system).
- **Apply the primitives where they drop in cleanly:** the admin action lists (`AdminUserView` / `AdminRoomView` action buttons, `EntityListView`) can use `SettingsRow`/the shared button + the grouped card without re-architecting.
- **NOT in scope:** re-laying-out admin functionally, the server-overview dashboard redesign, or anything the admin-friendliness track owns. This pass is chrome + type + tokens + the breadcrumb affordance only.

### Type + token pass (cross-cutting)

- Section labels: one standardized small-caps style (via `SettingsSection`).
- Titles (settings panes + admin panels): display font (`font-display`), consistent size.
- Every hardcoded color -> a semantic token.

## Theme-robustness + guard

- The kit is token-based: `Toggle` on = `--fluux-bg-accent` (white knob — the existing white-on-accent AA invariant); dividers = `--fluux-surface-divider` (theme-safe white/black alpha); danger = `--fluux-status-error`; labels = `--fluux-text-normal`, descriptions = `--fluux-text-muted`.
- The descriptions (`text-muted`) must clear WCAG AA on the settings surface in all 13 themes x 2 modes. The empty-states slice already made `--fluux-text-muted` AA on `--fluux-chat-bg` + `--fluux-sidebar-bg`. During implementation, confirm which surface the settings panes render on; if it is one of those, coverage holds; if a different surface (e.g. `--fluux-bg-tertiary`), extend the cross-theme guard to assert `text-normal` + `text-muted` AA on the settings surface too (same pattern as `emptyStateContrast.test.ts`).

## Testing

- Unit: `Toggle` flips `checked` + fires `onChange` on click/keyboard; `SettingsRow` renders label + description + control and associates `htmlFor`; `SettingsGroup` renders dividers; `Select` renders options + fires change.
- Migration regression: a spot-check that 2-3 migrated panes still render their controls + existing copy keys (reuse the panes' existing test style).
- Cross-theme: `text-normal` + `text-muted` AA on the settings surface across all 13 themes x 2 modes (reuse/extend the contrast guard).
- Screenshots: 2-3 settings panes (e.g. Notifications, Appearance, Accessibility) + one admin panel, in Aurora dark + light + 1-2 accent themes, to confirm consistent rows/toggles + readable text.

## Out of scope

- The admin-friendliness redesign (functional restyle, server-overview dashboard) — its own track, reusing these primitives.
- No copy rewrites, no new settings or controls, no behavior changes. No SDK changes.
