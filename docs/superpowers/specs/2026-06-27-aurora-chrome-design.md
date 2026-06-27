# Aurora Chrome + Density — Design Spec

Date: 2026-06-27
Slice: #3 of the Aurora screen rollout (the chrome: icon rail, sidebar, lists) + a global density preference
Branch: `claude/aurora-chrome`

## Context

The two highest-traffic surfaces (message list, composer) are now fully Aurora. The "chrome" — the always-visible left frame — is the most prominent surface that still looks a notch older. Reconnaissance:

- **Layout** (`ChatLayout.tsx`): three flex columns — `<Sidebar>` (which itself contains the icon rail + list panel) + `<main>` + optional `<MemberList>`.
- **Icon rail** (inside `Sidebar.tsx` ~219-297): `w-14` strip, `bg-fluux-bg`, buttons via `IconRailNavLink` (`size-10 rounded-xl`, active `bg-fluux-brand`, icon `size-5`), a `size-3` red presence dot.
- **Sidebar** (`Sidebar.tsx`): resizable `<aside>` (`bg-fluux-sidebar`, default 288px), header `h-14 px-4 border-b` with an `<h1 font-semibold>` (already display font), rail-driven view switch, footer with the self avatar (`size-12`) + presence + menu.
- **List rows** — `ConversationList.tsx` (`ConversationItem`), `ContactList.tsx` (`ContactItem`), `RoomsList.tsx` are **identical** in anatomy: `px-2 py-1.5 rounded border` flex `gap-3`, `size-8` avatar, name `font-medium`, preview `text-xs opacity-75`, active = `bg-fluux-sidebar-item-active` + a `before:w-[3px]` left accent bar, hover = `bg-fluux-hover`. Unread shows only an avatar-overlay count badge.
- **No density mechanism exists.** The settings store (`settingsStore.ts`) is a Zustand + localStorage pattern; `ConversationList`/`RoomsList` already subscribe to it (`timeFormat`), so a `densityMode` slots in identically.

## Goal

Bring the chrome up to the polish of the message area, and introduce a **single global Display-density preference** (Comfortable / Compact) that flows through the sidebar lists, the icon rail, and the central message pane.

## Scope & phasing

One coherent feature, **implemented in two phases** (separate PRs for reviewability):

- **Phase 1 (this plan):** the density preference + Settings toggle; density applied to the **sidebar lists + icon rail**; the **chrome visual polish** (unread emphasis, active state, avatar warmth).
- **Phase 2 (fast-follow plan):** density applied to the **central message pane** (the virtualized message list). Designed here; implemented next.

**Out of scope:** the header/footer structure (already clean — they pick up density spacing only incidentally), the MemberList/occupant panel (its own slice), any change to the rail's navigation behavior.

## 1. Global density preference

Add to `settingsStore.ts`, mirroring `timeFormat`:

```ts
export type DensityMode = 'comfortable' | 'compact'
// densityMode: DensityMode (default 'comfortable')
// setDensityMode(mode); DENSITY_KEY = 'fluux-density'; getInitialDensity() reads localStorage
```

- **Default:** `comfortable`. Persisted to `localStorage`.
- **Settings UI:** a "Display density" control in Settings (Appearance section, near theme/time format) — a two-option segmented toggle (Comfortable / Compact) with a one-line description. Reuse existing settings-row components and i18n key patterns (new keys get real translations in every locale).

### Application mechanism (render-perf-critical)

Density is applied **primarily via a root `data-density` attribute + CSS**, not per-row React state:

- One top-level effect reads `densityMode` and sets `data-density="comfortable|compact"` on a stable root element (e.g. the app/layout root). Flipping the attribute re-applies CSS with **no React re-render of the rows**.
- Spacing/padding/gap/rail-width values are CSS rules keyed on `[data-density="compact"]` against semantic classes (e.g. `.sidebar-row`, `.icon-rail`).
- Values CSS cannot reach (the `<Avatar size>` prop) are selected from `densityMode` read via the existing settings subscription in the list component (changes only on toggle, so the consequent re-render is rare and acceptable). The avatar's rendered box may alternatively be CSS-sized; the plan picks whichever is cleaner per component.
- **Constraint:** reading density must not re-render rows on every render — only on a toggle. The per-row memoization (`messageRowMemo` for Phase 2; the sidebar list-item memo) must stay intact.

## 2. Density values

**Sidebar list rows (conversation / contact / room — one shared abstraction):**

| | Comfortable (default) | Compact |
|---|---|---|
| Avatar | 40px (`size-10`) | 32px (`size-8`) |
| Row padding-block | 8px (`py-2`) | 4px (`py-1`) |
| Avatar/text gap | 12px (`gap-3`) | 8px (`gap-2`) |

**Icon rail:**

| | Comfortable | Compact |
|---|---|---|
| Rail width | 56px (`w-14`) | 48px (`w-12`) |
| Button | 40px (`size-10`) | 36px (`size-9`) |
| Icon | 20px (`size-5`) | 18px |
| Button gap | 8px (`gap-2`) | 6px (`gap-1.5`) |

**Central message pane (Phase 2 — designed, implemented next):**

| | Comfortable | Compact |
|---|---|---|
| Avatar | 36px | 28px |
| Inter-group spacing | ~12px | ~6px |
| Body text | 14px | 13.5px |

## 3. Chrome visual polish (Phase 1, density-independent)

Applied to the shared list-row treatment (conversation / contact / room):

- **Unread emphasis.** Unread rows get a **brighter, semibold name** (read rows stay `font-medium` with a faint preview), and the unread **count badge moves to the row's trailing edge** as an Aurora **accent pill** (`bg-fluux-brand` / `--fluux-badge`), replacing the avatar-overlay badge. This makes unread threads "pull" — today only a small avatar badge signals them. (A trailing **accent dot** is the variant when there is unread activity without a surfaced count.)
- **Active state.** Keep the accent-tinted row (`bg-fluux-sidebar-item-active`) + the 3px left accent bar; ensure the tint uses the Aurora accent consistently in both themes.
- **Avatar warmth.** The larger comfortable avatar (40px) + the existing colorful gradient fallback carry the per-person identity from the message list into the sidebar.
- **Hover.** Unchanged (`bg-fluux-hover`).

Icon rail polish: keep the active `bg-fluux-brand` fill; the only rail change in Phase 1 is the density sizing above. (No new active-indicator shape — the brand fill reads well.)

## Render-perf constraints (binding)

- Density change is a rare event; it must **not** add a per-render subscription that re-renders rows on unrelated updates. Prefer the root `data-density` + CSS path; where a component must read `densityMode`, use the existing narrow settings selector (like `timeFormat`).
- The sidebar list-item memoization and (Phase 2) `messageRowMemo` must stay green.
- Phase 2: changing message density changes measured row heights; the `@tanstack/react-virtual` virtualizer re-measures — verify scroll position is preserved on toggle and no measurement loop is introduced.

## Accessibility

- Unread name emphasis (brighter + semibold) must clear WCAG AA on the sidebar background in both themes.
- The trailing unread badge (white/on-accent text on the accent pill) clears AA (the AA-tuned accent already does).
- The Settings density toggle is keyboard-operable with clear selected state and labels (real i18n).
- Compact must not push any tap target below the existing touch-target minimum on touch builds (verify the compact rail button + row remain tappable).

## Testing

**Phase 1:**
- `settingsStore`: `densityMode` defaults to `comfortable`, persists, and `setDensityMode` updates + writes localStorage (unit test mirroring the `timeFormat` tests).
- A density helper/hook (whatever sets `data-density`) maps the mode to the attribute; unit-test the mapping.
- The shared row treatment: unit-assert unread rows render the semibold name + the trailing accent badge, read rows do not (render assertions on `ConversationItem`).
- Render-perf: the sidebar list-item memo stays intact (no re-render of sibling rows on an unrelated row's update); density toggle re-renders rows at most once.
- Screenshots: regenerate; add comfortable vs compact sidebar scenes (the existing chat scenes already exercise the rows).
- Typecheck, lint, full suite green; i18n test (new density keys present in every locale).

**Phase 2 (next plan):** message-pane density values; virtualizer re-measure + scroll-preservation test; `messageRowMemo` green.

## Deferred / follow-ups

- Phase 2: central message-pane density (separate plan/PR).
- Auto/system density (e.g. denser on small viewports) — not now; explicit toggle only.
- Density for the MemberList/occupant panel — folded into that panel's own slice.
