# Aurora Glass — Modals + Command Palette Design Spec

Date: 2026-06-27
Slice: #5 of the Aurora screen rollout (the glass treatment for modals + the command palette)
Branch: `claude/aurora-glass`

## Context

The Aurora identity defines a "glass" surface for floating overlays, but it is currently aspirational: `--fluux-glass-bg` / `--fluux-glass-blur` are defined in `index.css` and have **zero usages**; `backdrop-filter` is used nowhere in the app. So this slice applies glass for the first time.

Reconnaissance:
- **Modals**: `ModalShell.tsx` (used by ~15 modals) renders a `bg-black/50` scrim + a `bg-fluux-sidebar rounded-lg shadow-xl` panel (no border, no blur). Four modals roll their own equivalent (`ConfirmDialog`, `BackupPassphraseDialog`, `AvatarCropModal`, `ui/BottomSheet`). A parallel `--fluux-modal-bg/border/backdrop` token block exists but is unused.
- **Command palette**: `CommandPalette.tsx` — a `bg-black/50` overlay at `pt-[15vh]`, panel `bg-fluux-sidebar rounded-lg shadow-2xl border border-fluux-hover`.
- **`.fluux-popover`** (the shared elevated-surface class for ~26 dropdown menus): `bg-fluux-bg-float` + hairline border + `--fluux-shadow-overlay`. `--fluux-bg-float` is **theme-derived** (resolves through the ramp) — the correct pattern to follow. Out of scope for this slice.
- **Theme-robustness risk (the binding requirement)**: `--fluux-glass-bg` is a **hardcoded** Aurora navy (`rgba(20,27,48,0.74)`) / white (`rgba(255,255,255,0.72)`), and **no theme overrides it**. Applied as-is, every theme (gruvbox, dracula, rose-pine, ...) would get Aurora's navy glass — a clash.
- **Blur feasibility**: the app runs on macOS WKWebView + Linux WebKitGTK. The Aurora design direction already prescribes `@supports (backdrop-filter)` with a solid fallback (WebKitGTK blur is unproven); not yet implemented.
- **Guard infra**: `themeContrast.test.ts` + `surfaceHierarchy.test.ts` resolve theme tokens for all 13 themes × 2 modes — the pattern to extend for a glass guard.

## Goal

Give the command palette and modal panels a frosted-glass surface that looks great across **all 13 built-in themes** in both modes, degrades gracefully where blur is unsupported, and is guarded against per-theme regressions.

## Scope

**In scope:** the **command palette** (`CommandPalette.tsx`) and the **modal panels** — `ModalShell.tsx` + the four that roll their own (`ConfirmDialog`, `BackupPassphraseDialog`, `AvatarCropModal`, `ui/BottomSheet`); plus the **reduce-transparency accessibility preference** (setting + `useTransparency` hook + Appearance toggle) that gates the frost.

**Out of scope:** the ~26 `.fluux-popover` dropdown menus (stay solid, already theme-derived); the modals' internal content/layout (only the panel surface + scrim change); motion/transitions; any modalStore/host logic.

## Design

### 1. A shared `.fluux-glass` surface class

Add one class (mirroring `.fluux-popover`) that all the in-scope panels use, so the treatment is defined once and is theme-derived:

```css
@layer components {
  .fluux-glass {
    /* Solid fallback (no backdrop-filter support): a theme-derived elevated
       surface. Always present so the panel is never transparent-without-blur. */
    background-color: var(--fluux-bg-float);
    border: 1px solid var(--fluux-glass-border);
    box-shadow: var(--fluux-shadow-overlay);
  }
  /* Frosted variant: only when BOTH backdrop-filter and the translucent
     theme-derived background are supported AND transparency is enabled
     (data-transparency="full"), so we never get blur-with-opaque-bg, an invalid
     background, or frost when the user/OS asked to reduce transparency. */
  @supports (backdrop-filter: blur(1px)) and (background: color-mix(in srgb, red, blue)) {
    [data-transparency="full"] .fluux-glass {
      /* High opacity on purpose: readability first. ~88% opaque means only a
         hint of the blurred backdrop shows through; combined with the dimming
         scrim, panel content stays as legible as the solid surface. Tune via
         screenshots, but do not go below ~85% opacity (transparent 15%). */
      background-color: color-mix(in srgb, var(--fluux-bg-float), transparent 12%);
      backdrop-filter: blur(var(--fluux-glass-blur));
      -webkit-backdrop-filter: blur(var(--fluux-glass-blur));
    }
  }
}
```

- **Theme-derived**: both the solid (`--fluux-bg-float`) and the frosted (`color-mix` of `--fluux-bg-float` with transparent) backgrounds come from each theme's own elevated surface. No hardcoded navy. Each theme's glass tints to itself.
- **Readability first**: the frost is deliberately subtle (~88% opaque). The point is a refined elevated surface with a hint of depth, NOT a heavily see-through panel that fights legibility.
- **Graceful fallback**: where blur or `color-mix` is unsupported, OR transparency is reduced, the panel is a solid theme-derived elevated surface (still clean, just not frosted). macOS with transparency on gets the full frost.

### 2. Tokens (in `index.css`)

- **Replace the hardcoded `--fluux-glass-bg`** navy/white literals: they are superseded by the `color-mix` derivation above. Remove `--fluux-glass-bg` (dark + light), or repurpose to the color-mix expression. `--fluux-glass-blur` (12px) stays.
- **Add `--fluux-glass-border`**: a subtle highlight edge (theme-safe alpha): `:root` (dark) `rgba(255,255,255,0.12)`, `.light` `rgba(0,0,0,0.10)`. Reads on any theme surface.
- **Scrim token**: use/define `--fluux-modal-backdrop` for the overlay dim (a black alpha, theme-safe), replacing the inline `bg-black/50`. Keep ~0.5 (the AvatarCrop modal's `/70` may stay if its content needs more contrast — note per modal).
- `--fluux-shadow-overlay` (already theme-tuned dark/light) stays as the glass shadow.

### 3. Apply to the in-scope surfaces

- **`ModalShell` panel**: replace `bg-fluux-sidebar ... shadow-xl` with `fluux-glass` (keeps `rounded-lg`, width, etc.). Scrim: `bg-black/50` to the `--fluux-modal-backdrop` token.
- **`CommandPalette` panel**: replace `bg-fluux-sidebar shadow-2xl border border-fluux-hover` with `fluux-glass`. Its input row + result rows keep their structure; ensure the selected-row tint (`bg-fluux-brand/50`) and text read on the (now translucent) surface.
- **The four roller modals** (`ConfirmDialog`, `BackupPassphraseDialog`, `AvatarCropModal`, `BottomSheet`): swap their panel `bg-fluux-sidebar ... shadow-xl` for `fluux-glass` and their scrim for `--fluux-modal-backdrop` (BottomSheet keeps its `rounded-t-2xl`; AvatarCrop may keep its darker scrim).

### 4. Readability on glass

Content on a translucent panel must stay legible over whatever is behind it. The frosted background is `--fluux-bg-float` at ~88% opacity — very close to the solid surface — and the scrim dims the backdrop, so contrast stays near the solid case. Verify the palette's muted placeholder + result text and the modal body text read in both modes across themes. **Readability beats frost intensity**: if a value looks too see-through in any theme, raise the opacity.

### 5. Accessibility — reduce transparency

Translucency + blur can hurt some users (low vision, vestibular sensitivity, focus). Provide an explicit opt-out that mirrors the existing Motion preference:

- **Setting**: `transparencyMode: 'system' | 'full' | 'reduced'` in `settingsStore` (default `'system'`), exactly mirroring `motionPreference` (type, `getInitial...`, persist key `'fluux-transparency'`, setter).
- **Resolution** (`useTransparency` hook, mirroring `useDensity`/the motion resolution): `'system'` resolves via `window.matchMedia('(prefers-reduced-transparency: reduce)')` (so macOS "Reduce transparency" and the OS setting are honored automatically); `'full'` / `'reduced'` are explicit. The hook sets `data-transparency="full" | "reduced"` on `document.documentElement` and updates on the media-query change + the setting change. Called once at the app root (next to `useDensity`).
- **Effect**: the frosted CSS is gated on `[data-transparency="full"]` (see the class above), so `reduced` (explicit, or `system` + OS-reduce) yields the **solid** theme-derived panel — no blur, no translucency. The solid panel is already the readable, theme-correct baseline.
- **Settings UI**: a "Transparency" control in Appearance (System / Full / Reduced), mirroring the Motion block; new i18n keys translated in all 33 locales.

## Theme robustness (binding)

- **No hardcoded surface colors**: the glass background derives from `--fluux-bg-float` (theme-derived) in both the solid and frosted paths. No navy literal.
- **`--fluux-glass-border` / `--fluux-modal-backdrop`** are alpha overlays (white/black), correct on any theme surface (like the surface-divider from the chrome slice).
- **Cross-theme guard** (`glass.test.ts` or extend `themeContrast.test.ts`): for each of the 13 themes × 2 modes, resolve the glass panel's effective **solid-fallback** background (`--fluux-bg-float`) and assert it keeps `--fluux-text-normal` at WCAG AA (so panel content is readable in the no-blur case, which is the worst case for contrast). Also assert `--fluux-glass-border` is perceptible against `--fluux-bg-float` (≥1.3:1, like the hairline guard). The frosted (translucent) look is verified by screenshots across themes.

## backdrop-filter feasibility

- Gated by `@supports` (backdrop-filter + color-mix). macOS WKWebView (the maintainer's platform) supports both → full frost. Older WebKitGTK falls back to the solid theme-derived panel.
- **Verify on the running app** (not just the screenshot harness): confirm the frost renders acceptably where applied and the fallback is clean. If WebKitGTK blur is janky, the `@supports` gate already excludes it — but spot-check.

## Testing

- **Glass cross-theme guard** (as above): solid-fallback bg readability + glass-border perceptibility, all 13 themes × 2 modes.
- **Component tests**: `ModalShell` / `CommandPalette` panels carry the `fluux-glass` class (render assertion); the scrim uses the backdrop token, not `bg-black/50`.
- **Transparency preference**: `settingsStore` defaults `transparencyMode` to `'system'` + persists; `useTransparency` sets `data-transparency` to `full`/`reduced` from the mode (+ the media query for `system`); the Appearance toggle switches it; i18n keys present in all 33 locales. (The frost-off effect itself is CSS gated on `[data-transparency="full"]`, verified by the screenshot pass with the attribute toggled.)
- **Screenshots**: the command palette + a representative modal (e.g. About or Create Room), captured in Aurora dark, Aurora light, and 2-3 other themes (gruvbox, dracula, rose-pine) to confirm the glass tints per theme and the fallback path looks clean. (Existing scene `10-command-palette-dark` covers the palette; add a couple theme variants.)
- Typecheck, lint, full suite green.

## Deferred / follow-ups

- Glass on the `.fluux-popover` dropdown menus (a later, optional pass).
- Entry/exit motion for the glass overlays (the motion-language slice).
- A subtle scrim blur (blurring the whole app behind the modal) — heavier; not now.
