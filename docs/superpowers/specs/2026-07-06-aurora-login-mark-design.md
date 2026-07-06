# Aurora login mark — design

**Date:** 2026-07-06
**Scope:** Login screen brand mark, plus two restrained in-app identity touches decided during review: the aurora horizon hairline under the conversation header and the aurora send button (§5b). App icon, README logo, blog hero, and further identity moments are follow-ups (see §8).

## 1. Problem

The current login brand mark ([LoginScreen.tsx:433-446](../../../apps/fluux/src/components/LoginScreen.tsx)) is the most generic-looking element of the Aurora identity: a 135° tri-stop linear-gradient tile (`--fluux-grad`) behind a stock Lucide `MessageCircle`, with a `blur-xl` glow. Each piece is defensible; together they read as the 2024-era AI-template aesthetic. The "Aurora" name promises a natural light phenomenon that a straight linear gradient does not deliver.

## 2. Concept (decided in brainstorm)

**The aurora draws the bubble.** A hand-drawn speech-bubble silhouette is traced by a luminous aurora line — teal at the tail rising to violet at the top — with shimmer rays rising from the upper rim, a faint night sky and stars inside, soft halos behind, and fine film grain over the light. No container tile, no icon-inside-a-box.

Decisions made with the user, each after visual comparison of rendered candidates:

| Decision | Choice |
|---|---|
| Mark form | B1 — aurora line draws the bubble (over ribbon-in-tile and freestanding ribbon) |
| Outline treatment | Aurora line only; no second aurora scene inside the bubble |
| Motion | Subtle shimmer, CSS-only, gated on `prefers-reduced-motion` |
| Light mode | D1 dawn palette — *aurora* is the goddess of dawn: gold → rose → lavender → sky |
| Header | Aurora horizon hairline (1px gradient line under the conversation header) — over a background wash |
| Send button | Aurora-filled round button only when a message is ready to send — over an always-gradient icon |
| Scope | Login mark + the two chrome touches above |

The layer recipes in §3 are the source of truth — they capture the validated prototype values exactly (the throwaway HTML mockups lived in a session scratchpad and are not retained).

## 3. Component design

Two new files, one edit:

- `apps/fluux/src/components/brand/auroraGeometry.ts` — pure geometry: cubic-bezier evaluation of the bubble path (points + tangents at parameter t, analytically — no DOM measurement), outward-normal computation, and seeded ray generation (`mulberry32` PRNG, fixed seed). Deterministic: same output every launch, unit-testable in vitest.
- `apps/fluux/src/components/brand/AuroraMark.tsx` — renders the SVG from the generated geometry. Decorative: `aria-hidden="true"`, no text content. Accepts a `size` prop (default ~150×130 viewBox box).
- `apps/fluux/src/components/LoginScreen.tsx` — the existing glow div + gradient tile + `MessageCircle` block is replaced by `<AuroraMark />`. Header layout (title, subtitle spacing) unchanged.

The bubble path is a fixed constant (the hand-tuned silhouette from the prototype):

```
M 100 18 C 145 18 178 45 178 82 C 178 119 145 145 100 145
C 89 145 78.5 143 69.5 139.5 C 58 149 44 154.5 30 155
C 38.5 145.5 43.5 135.5 44.8 126.5 C 32 116 24 100 24 82
C 24 45 55 18 100 18 Z
```

### Layer stack (bottom → top)

1. **Halos** — two soft radial-gradient ellipses, ~0.16–0.20 peak opacity: lower-left uses stop 1; upper-right uses stop 4 in dark mode (violet) but stop 3 in light mode (lavender — dawn's stop 4 sky-blue is too cool for the warm upper halo).
2. **Interior** (clipped to bubble): dark mode — night fill `#0A1124` + ~15 seeded stars (`#C7D2FE`, r 0.5–1.3, opacity 0.25–0.75); light mode — paper wash (`#FDFEFF` at ~50%), no stars.
3. **Outline glow** — bubble path stroked with the aurora gradient, width ~14, gaussian blur ~7, opacity ~0.55 (light mode: width ~12, opacity ~0.35).
4. **Shimmer rays** — ~90 samples along the path, kept only where the outward normal points up (`ny < -0.3`) and passing a 75% random keep-rate, yielding ~25 rays; length 8–30px scaled by `-ny`; per-ray color sampled from the gradient ramp with jitter; width 1.8–4.4; opacity 0.06–0.22; blur ~2.3.
5. **Main line** — gradient stroke, width ~4, blur ~1.1, opacity ~0.97.
6. **Bright core** (dark mode only) — `#EAFFF8`, width ~1.5, opacity ~0.6.
7. **Film grain** — `feTurbulence` fractalNoise (baseFrequency 0.8, 2 octaves, stitch) → desaturate, drawn as a rect at opacity 0.13–0.20 with `mix-blend-mode: soft-light`, masked to a blurred wide stroke of the bubble path so grain rides the light only.

Gradient runs along the silhouette diagonal (tail → top-right), `gradientUnits="userSpaceOnUse"`, uneven stops so the first hue dominates: 0 / 0.45 / 0.72 / 1.

## 4. Theming

Four new foundation tokens in `index.css`, consumed by the SVG gradient stops and halos:

| Token | Dark (night) | Light (dawn) |
|---|---|---|
| `--fluux-aurora-1` | `#2FE0C0` | `#D98A40` |
| `--fluux-aurora-2` | `#4FB6E8` | `#D66F8E` |
| `--fluux-aurora-3` | `#7C8CFF` | `#8F7BE8` |
| `--fluux-aurora-4` | `#A78BFA` | `#4E8FD9` |

- Halo hues derive from stops 1 and 3; the glow keeps scaling with the existing `--fluux-brand-glow-opacity` (0.35 dark / 0.6 light).
- Other builtin themes inherit these Aurora defaults, exactly as they inherit `--fluux-grad` today. Theme authors may override; documented in THEMES.md as optional identity tokens.
- `--fluux-grad` and `--fluux-accent-2` remain untouched (still used conceptually by marketing/logo assets).

Note: in dark mode the mark is pure decoration on a near-black backdrop; no WCAG text-contrast obligations apply. The login title/subtitle are unchanged.

## 5. Motion

CSS-only, in the Aurora motion-language section of `index.css`:

- Rays are split into two groups (alternating index) with `opacity` keyframes drifting between ~0.55× and 1× over a ~10s `ease-in-out` alternate cycle, second group delayed ~5s.
- The outline-glow layer breathes ±10% opacity on the same period.
- `@media (prefers-reduced-motion: reduce)` disables all of it; the static mark is the complete design, not a degraded one.
- No JS timers, no React re-renders, no layout/paint-heavy properties (opacity only).

## 5b. In-app identity touches

Two chrome-level applications of the aurora tokens, both validated against flat references in mockups:

**Aurora horizon hairline.** A 1px overlay on the conversation/room header divider: `linear-gradient(90deg, transparent, aurora-1 12%, aurora-2 40%, aurora-3 70%, transparent)` at ~0.65 opacity, drawn via a pseudo-element on top of the existing divider — the standard `--fluux-chat-header-border` hairline stays underneath, so the seam-visibility guarantees from the contrast audit are unaffected. Fades at both ends; light mode uses the dawn stops.

**Aurora send button.** The composer send control becomes state-dependent: while the input is empty it stays the current muted icon; once there is content to send it becomes a ~34px circular button filled with `linear-gradient(130deg, aurora-1, aurora-2 45%, aurora-3 75%, aurora-4)` and a dark-ink plane icon (new token `--fluux-aurora-ink: #08111F`, both modes). The aurora appears exactly when the user is about to speak — identity tied to the brand action, not permanent decoration. Existing aria-label and keyboard behavior unchanged.

Both consume the §4 tokens; other builtin themes inherit them (same precedent as the login mark), and THEMES.md documents how theme authors override or disable them.

## 6. Testing

- `auroraGeometry.test.ts`: bezier point/tangent correctness against hand-computed values; determinism (fixed seed → identical ray list); all emitted rays satisfy the upward-normal filter; ray count in expected range.
- `AuroraMark.test.tsx`: renders with `aria-hidden`, expected layer groups and ray count for the default seed.
- `LoginScreen.test.tsx`: update for the removed `MessageCircle` (verify no assertions reference it; login form behavior untouched).
- `MessageComposer.test.tsx`: send control renders muted when the input is empty and switches to the aurora-ready state when content is present; aria-label preserved.
- `themeContrast.test.ts`: guard that `--fluux-aurora-ink` clears 3:1 (WCAG AA for UI components) against the worst-case stop of the send-button gradient in both modes, per theme.
- Visual: demo mode check in both modes; regenerate `8x-login-aurora-dark/light` via the screenshots script.
- Pre-commit gates per project rules: full app tests, `npm run typecheck`, linter.

## 7. Performance

~120 static SVG nodes rendered once at mount on a screen with no other load; shimmer is compositor-only opacity animation on two groups. No measurable impact expected, including WebKitGTK (no filters animate; blur filters are static).

## 8. Out of scope / follow-ups

1. **App icon** — decision: the current 0.17 icon composition stays (owner's taste call after reviewing atmospheric replacements — they read as less refined than the existing icon). Only a slight material enhancement is planned: same geometry and glyph, with a barely-perceptible light falloff on the gradient (anti-banding), ~5% film grain at large sizes, and a hint of depth in the lower corner. Validated side-by-side on light and dark dock backgrounds.
2. **Empty states** — small freestanding aurora ribbon (concept C).
3. **Typing indicator** — dots shimmering through the aurora hues.
4. **Aurora accent presets** — curated `accentPresets` for the Aurora theme incl. an Aurora Teal preset built from `--fluux-accent-2`.
5. **Glass modals** — progressive blur + faint aurora tint (light-as-material direction).
6. **README logo / blog hero** — migrate the lockup once the mark ships.
