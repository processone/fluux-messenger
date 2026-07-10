# "Pure" theme — design

**Issue:** [#952 — Add "Pure" themes optimized for OLED and e-ink displays](https://github.com/processone/fluux-messenger/issues/952)
**Date:** 2026-07-10
**Status:** Approved design, pending implementation plan

## Summary

Add a single builtin theme, **Pure**, whose two modes are each tuned for a
display technology:

- **Dark mode → pure black (OLED).** True `#000000` background so OLED panels
  power down black pixels (battery + no light bleed).
- **Light mode → pure white (e-ink).** Flat `#ffffff` everywhere with crisp
  black structure, tuned for the shallow grayscale depth and slow refresh of
  e-ink.

It is one `ThemeDefinition` because Fluux themes already carry both a dark and a
light variant, and the existing dark/light/**system** mode toggle selects
between them. `system` mode then yields a genuinely useful behaviour: OLED-black
at night, e-ink-white by day.

## Goals / non-goals

**Goals**
- A "Pure" entry in the theme picker, selectable like any builtin.
- OLED variant: true-black surfaces, hierarchy carried by hairline borders, a
  restrained vivid accent that pops on black.
- E-ink variant: flat pure-white surfaces, near-black "ink" accent, strong
  structure, high contrast that survives grayscale rendering.
- Glass/blur neutralised so panels render solid — on OLED so true black is not
  broken by translucency behind modals, on e-ink because blur does not render.

**Non-goals**
- No theme→motion coupling. Reduced motion stays the user's global setting.
  (E-ink users can enable it themselves; we do not force it.)
- No new store fields, no changes to the mode toggle, no new settings UI.
- No new i18n key (a theme's display name renders directly from its definition).

## Architecture fit

The theme system has three independent, separately-persisted axes: **mode**
(`light`/`dark`/`system`, in `settingsStore`), **theme identity** (builtins +
custom, in `themeStore`), and **accent preset**. Colors are 3-tier CSS custom
properties (`--fluux-*`) declared in `apps/fluux/src/index.css` (`:root` = dark,
`.light` = light); a theme supplies inline overrides on `document.documentElement`
that win over those defaults. Theme authors normally override only the ~15–20
Tier‑1 foundation vars; semantic/component vars cascade.

Pure is therefore a normal builtin `ThemeDefinition` and inherits the picker,
swatches, persistence, mode-switching, and accent presets for free. The **only**
work outside the theme file is a small extension so the theme can request glass
be flattened (below).

## Components / changes

### 1. `apps/fluux/src/themes/builtins/pure.ts` (new)

A `ThemeDefinition` (`id: 'pure'`, `name: 'Pure'`, `author: 'Fluux'`) modeled on
`nord.ts`, plus the new `transparency: 'reduced'` field (see §3).

**Dark / OLED (`variables.dark`) — design intent + anchors:**
- Neutral ramp anchored at `--fluux-base-00: #000000` (the deepest background /
  chat surface), ramping up through very-near-black elevated surfaces
  (`~#0a0a0a`–`#141414` for sidebar/float/modal) to `--fluux-base-100` ≈ `#fafafa`
  for text (a hair below pure white to soften OLED halation).
- Hierarchy is carried by **hairline borders** (`rgba(255,255,255,0.10–0.14)`),
  not by shadows or large surface-luminance steps.
- Accent = **Aurora's Teal preset** (`h 174, s 70%, l 52%`, i.e. `#38E0C4`
  family) — restrained but vivid, brand-coherent, pops on black.
- Muted text kept legible on near-black (`~#8a8a8a`, verified against AA).

**Light / e-ink (`variables.light`) — design intent + anchors:**
- Background **and all elevated surfaces** = `#ffffff`, flat. No subtle gray
  elevation (e-ink cannot render it cleanly); hierarchy comes from borders.
- Text = `#000000` normal; muted kept **dark** (`~#3a3a3a`), not light gray, for
  e-ink's shallow grayscale depth.
- Accent = near-black **ink** (`h 0, s 0%, l ~10%`). `--fluux-text-on-accent`
  computes to white automatically (existing WCAG logic in `useTheme.ts`), so
  buttons/links read as high-contrast bold and survive grayscale.
- Borders = strong dark hairlines (`rgba(0,0,0,~0.8)`) for crisp structure.

**Both modes:** keep `--fluux-chat-bg` as the contrast-guaranteed surface
(`#000`/`#fff`) against `--fluux-text-normal` (`#fafafa`/`#000`) so the glass
surface's text stays AAA. Keep the **divider** tokens as alpha-on-surface
(white-alpha on dark, black-alpha on light) so the surface-hierarchy divider
check passes.

Exact hex values for the full ramp are finalised during implementation against
the contrast tests (§4); the anchors above define the intent.

`swatches`: `{ dark: ['#000000', '#0a0a0a', '#38E0C4', '#fafafa'], light:
['#ffffff', '#111111', '#000000'] }` for the picker card.

Accent presets: omit (inherit the default list), or optionally ship a tiny
curated pair (teal for OLED, ink for e-ink). Default is fine for v1.

### 2. `apps/fluux/src/themes/builtins/index.ts`

Import `pureTheme` and append it to `builtinThemes[]`.

### 3. Glass flattening — a theme transparency preference

`.fluux-glass` translucency (`color-mix(... transparent 15/40%)` +
`backdrop-filter: blur(var(--fluux-glass-blur))`) is applied by **selector
rules** in `index.css`, not by a single token, so a variables-only theme cannot
flatten it. The codebase already has a complete set of solid-fallback rules gated
on `[data-transparency="reduced"]` covering every glass surface (`.fluux-glass`,
`.modal-scrim`, `.send-aurora`, `.modal-scrim-aurora`, …). We reuse that path:

- Add optional `transparency?: 'reduced'` to `ThemeDefinition`
  (`apps/fluux/src/themes/types.ts`).
- In `useTheme`'s transparency effect (`apps/fluux/src/hooks/useTheme.ts:346`),
  fold the active theme's preference into `resolve()` with **reduced-wins**
  semantics — a leading `if (theme?.transparency === 'reduced') return 'reduced'`
  — and add `theme?.transparency` to the effect's dependency array. A theme can
  force flat, but can never force glass back on over a user who chose reduced.
- `pure.ts` sets `transparency: 'reduced'`.

**Why this over parallel `[data-theme="pure"]` selectors:** it is derived, not
persisted (switching away from Pure restores the user's real transparency
setting); it reuses every already-validated flatten rule so the send-button and
scrim flatten too; and any future glass surface stays in sync for free with **zero
new CSS selectors**. The mechanism is reusable by future themes.

Popovers (`.fluux-popover`) are already solid — they read `--fluux-bg-float`, so
the palette handles them with no extra work.

## Data flow

1. User selects "Pure" in AppearanceSettings → `themeStore.activeThemeId = 'pure'`.
2. `useTheme` resolves the theme, sets `data-theme="pure"`, applies
   `variables.dark` or `variables.light` (per resolved mode) as inline vars on
   `<html>`, and — via the §3 change — resolves `data-transparency="reduced"`
   because the theme requests it.
3. CSS cascade produces true-black/pure-white surfaces; the existing
   reduced-transparency rules render all glass surfaces solid.
4. Switching mode (or `system` flipping) swaps dark↔light variant. Switching away
   from Pure clears the inline vars and restores the user's own transparency.

## Testing / validation gates

These builtin-theme test suites iterate `builtinThemes`, so Pure must pass them:

- **`themeContrast.test.ts`** — borders must read as hairlines (Pattern A); body/
  muted text must clear WCAG AA (Pattern B). Flat pure + alpha hairline borders +
  dark-enough muted text satisfies this; tune muted/border alphas until green.
- **`surfaceHierarchy.test.ts`** — asserts `luminance(rail) <= luminance(sidebar)
  <= luminance(main)` (non-strict `<=`, so flat equal surfaces pass) and that the
  divider composite is lighter than a dark surface / darker than a light surface.
  Keep divider tokens as alpha-on-surface (do not override opaque).
- **`glass.test.ts`**, **`builtins/index.test.ts`** — run and satisfy whatever
  invariants they assert for a new builtin (id uniqueness, swatch shape, glass
  token integrity).
- **`npm run typecheck`** — the new `transparency?` field and `pure.ts` typecheck.
- **Manual (demo mode):** verify both modes; open a modal and the command palette
  (`.fluux-glass`) and confirm they render solid; confirm switching away from
  Pure restores the prior transparency behaviour.

## Risks

- **Flat surfaces vs. surface-hierarchy test:** mitigated — the test uses `<=`.
  If a strict-inequality assertion exists elsewhere, introduce a 1–2 point
  luminance step on elevated surfaces (still reads as "pure").
- **Muted text on near-black / dark-gray on white:** must clear AA; finalise
  exact values against `themeContrast.test.ts` rather than by eye.
- **Reduced-wins transparency merge:** a user on `transparency: full` who selects
  Pure will see glass disappear. This is intended ("Pure" = flat) and reversible
  by switching themes.

## Out of scope (future)

- Motion coupling (could later reuse the same theme-preference mechanism for a
  `motion?: 'reduced'` field, but explicitly excluded here).
- A curated accent-preset list specific to Pure.
