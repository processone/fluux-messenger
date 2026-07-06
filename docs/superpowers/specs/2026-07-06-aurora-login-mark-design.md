# Aurora login mark — design

**Date:** 2026-07-06
**Scope:** Login screen brand mark, two restrained in-app identity touches (aurora horizon hairline, glass send button — §5b), and the liquid-glass material upgrade for modals and the command palette (§5c). App icon, README logo, blog hero, and further identity moments are follow-ups (see §8).

**Organizing principle (decided during review):** *aurora is the light, glass is the material.* Glass surfaces never carry aurora color themselves — they transmit and refract aurora light placed behind them. This anchors the identity to the current platform material language (liquid glass) while keeping the aurora as the distinctive element.

## 1. Problem

The current login brand mark ([LoginScreen.tsx:433-446](../../../apps/fluux/src/components/LoginScreen.tsx)) is the most generic-looking element of the Aurora identity: a 135° tri-stop linear-gradient tile (`--fluux-grad`) behind a stock Lucide `MessageCircle`, with a `blur-xl` glow. Each piece is defensible; together they read as the 2024-era AI-template aesthetic. The "Aurora" name promises a natural light phenomenon that a straight linear gradient does not deliver.

## 2. Concept (decided in brainstorm)

**A liquid-glass bubble with an aurora rim.** A hand-drawn speech-bubble silhouette rendered as a translucent glass pane: aurora light glows behind it and bends through it (lensing), the silhouette is traced by an aurora-gradient rim with a thin white specular hairline, a faint night sky and stars sit inside the pane, and fine film grain rides the light. No container tile, no icon-inside-a-box.

Decisions made with the user, each after visual comparison of rendered candidates:

| Decision | Choice |
|---|---|
| Mark form | Custom bubble silhouette (over ribbon-in-tile and freestanding ribbon) |
| Mark finish | G2 — glass body with aurora rim (over pure aurora line and glass with white rim only) |
| Motion | Subtle backlight breathing, CSS-only, gated on `prefers-reduced-motion` |
| Light mode | Muted dawn (D2) — *aurora* is the goddess of dawn: champagne whisper at the tail, violet leads (the gold-heavy first cut was rejected as not subtle enough) |
| Header | Aurora horizon hairline (1px gradient line under the conversation header) — over a background wash |
| Send button | Liquid-glass round button lit by aurora glow, shown only when a message is ready to send |
| Material direction | Liquid glass throughout: modal/palette upgrade, glass send, OS-level icon glass |
| Scope | Login mark + chrome touches + glass material upgrade |

The layer recipes in §3 are the source of truth — they capture the validated prototype values exactly (the throwaway HTML mockups lived in a session scratchpad and are not retained).

## 3. Component design

For the mark itself, two new files and one edit (the chrome and glass work in §5b/§5c additionally touches `MessageComposer.tsx` and `index.css`):

- `apps/fluux/src/components/brand/auroraSeed.ts` — pure helpers: `mulberry32` PRNG and seeded star-field generation (positions, radii, opacities from a fixed seed). Deterministic: same output every launch, unit-testable in vitest. (No path sampling needed — the G2 finish has no rays.)
- `apps/fluux/src/components/brand/AuroraMark.tsx` — declarative SVG plus the seeded stars. Decorative: `aria-hidden="true"`, no text content. Accepts a `size` prop (default ~150×130 viewBox box).
- `apps/fluux/src/components/LoginScreen.tsx` — the existing glow div + gradient tile + `MessageCircle` block is replaced by `<AuroraMark />`. Header layout (title, subtitle spacing) unchanged.

The bubble path is a fixed constant (the hand-tuned silhouette from the prototype):

```
M 100 18 C 145 18 178 45 178 82 C 178 119 145 145 100 145
C 89 145 78.5 143 69.5 139.5 C 58 149 44 154.5 30 155
C 38.5 145.5 43.5 135.5 44.8 126.5 C 32 116 24 100 24 82
C 24 45 55 18 100 18 Z
```

### Layer stack (bottom → top)

1. **Backlight** — three blurred ellipses behind the pane (the aurora light source): stop-1 hue lower-left, stop-3 hue center, stop-4 hue upper-right (dark mode; light mode uses the dawn stops with stop-3 lavender uppermost), each ~0.38–0.42 opacity, gaussian blur ~16.
2. **Pane interior** (clipped to bubble): night fill `#0A1124` at ~0.42 (light mode: paper wash `#FDFEFF` ~50%); then the **lensing layer** — the same three backlight ellipses redrawn inside the clip, offset ~+7px and slightly less blurred (~11), so light visibly bends as it crosses the silhouette; ~8 seeded stars (`#C7D2FE`, r 0.5–1.3, dark mode only); a diagonal sheen (`linear-gradient` white 0.10 → transparent 40%).
3. **Film grain** — `feTurbulence` fractalNoise (baseFrequency 0.8, 2 octaves, stitch) → desaturate, rect at ~0.10 opacity, `mix-blend-mode: soft-light`, clipped to the pane.
4. **Aurora rim** — the silhouette stroked twice with the aurora gradient: a glow pass (width ~8, blur ~7, opacity ~0.4) and a crisp pass (width ~2.4, opacity ~0.95).
5. **Specular hairline** — the silhouette stroked once more with a vertical white gradient (0.55 top → 0.05 bottom), width ~1, opacity ~0.5 — the liquid-glass signature.

Gradient runs along the silhouette diagonal (tail → top-right), `gradientUnits="userSpaceOnUse"`, uneven stops so the first hue dominates: 0 / 0.45 / 0.72 / 1.

### Light-mode adaptations (validated naive-vs-adapted in mockups)

Light mode is never a palette swap — the same structural lesson as the contrast audit's light-mode findings. On pale backgrounds, additive glow doesn't read and white speculars vanish, so:

1. **Rim** uses deeper light-tuned dawn stops (`--fluux-aurora-rim-*`, see §4) so the silhouette holds on the pale login background; the white specular hairline is replaced by an ink hairline (`rgba(30,42,70,0.30)`, ~0.8px). White highlights survive only *inside* the pane as the diagonal sheen.
2. **Depth comes from shadow, not glow** — a soft drop shadow under the pane (navy ~14%, blurred) grounds the glass object.
3. **Backlight** blobs must carry pigment rather than light on white — but weighted so the violet leads (~0.5 opacity) while champagne and rose stay at ~0.42: the warm note is a whisper at the tail, never a wash (the gold-dominant first cut failed review).
4. **Pane** is a white gradient fill (0.72 → 0.42 top-to-bottom); no stars.

## 4. Theming

Four new foundation tokens in `index.css`, consumed by the SVG gradient stops and halos:

| Token | Dark (night) | Light (muted dawn) |
|---|---|---|
| `--fluux-aurora-1` | `#2FE0C0` | `#E8C29A` |
| `--fluux-aurora-2` | `#4FB6E8` | `#DE94AE` |
| `--fluux-aurora-3` | `#7C8CFF` | `#9D8CE8` |
| `--fluux-aurora-4` | `#A78BFA` | `#6FA0DC` |

Plus a rim quartet, `--fluux-aurora-rim-1..4`: in dark mode these equal the aurora stops; light mode overrides them with deeper values (`#C08A52 / #C06A88 / #7862D8 / #4A82C6`) so strokes hold contrast on pale surfaces while the softer base stops keep serving the backlight. Same one-hue-two-jobs pattern as the `--fluux-status-error` / `--fluux-text-error` split.

- Backlight hues derive from stops 1, 3 and 4 (dark) and the dawn stops in light mode; overall backlight intensity keeps scaling with the existing `--fluux-brand-glow-opacity` (0.35 dark / 0.6 light).
- Other builtin themes inherit these Aurora defaults, exactly as they inherit `--fluux-grad` today. Theme authors may override; documented in THEMES.md as optional identity tokens.
- `--fluux-grad` and `--fluux-accent-2` remain untouched (still used conceptually by marketing/logo assets).

Note: in dark mode the mark is pure decoration on a near-black backdrop; no WCAG text-contrast obligations apply. The login title/subtitle are unchanged.

## 5. Motion

CSS-only, in the Aurora motion-language section of `index.css`:

- The three backlight ellipses breathe: each drifts between ~0.7× and 1× opacity over a ~12s `ease-in-out` alternate cycle, staggered ~4s apart — the aurora slowly shifting behind the glass.
- The rim-glow pass breathes ±10% opacity on the same period.
- `@media (prefers-reduced-motion: reduce)` disables all of it; the static mark is the complete design, not a degraded one.
- No JS timers, no React re-renders, no layout/paint-heavy properties (opacity only).

## 5b. In-app identity touches

Two chrome-level applications of the aurora tokens, both validated against flat references in mockups:

**Aurora horizon hairline.** A 1px overlay on the conversation/room header divider: `linear-gradient(90deg, transparent, aurora-1 12%, aurora-2 40%, aurora-3 70%, transparent)` at ~0.65 opacity, drawn via a pseudo-element on top of the existing divider — the standard `--fluux-chat-header-border` hairline stays underneath, so the seam-visibility guarantees from the contrast audit are unaffected. Fades at both ends; light mode uses the dawn stops.

**Glass send button.** The composer send control becomes state-dependent: while the input is empty it stays the current muted icon; once there is content to send it becomes a ~34px circular liquid-glass button — translucent fill (`rgba(255,255,255,0.10)`), `backdrop-filter: blur(9px) saturate(1.6)`, 1px `rgba(255,255,255,0.28)` border, inset top specular, white plane icon — with a small blurred aurora glow element (stop-1 + stop-4 radials) positioned behind it inside the composer, shining through the glass. In light mode the button flips its physics: dark-alpha border (`rgba(30,42,70,0.18)`), higher-opacity white fill (~0.5), ink icon (`--fluux-aurora-ink`) instead of white, dawn glow behind. The aurora appears exactly when the user is about to speak — identity tied to the brand action, not permanent decoration. Fallback: under `data-transparency="reduced"` (and on platforms where the glass tier is disabled, see §5c) the button falls back to a solid aurora-gradient fill with dark-ink icon (`--fluux-aurora-ink: #08111F`) — the validated solid variant. Existing aria-label and keyboard behavior unchanged.

Both consume the §4 tokens; other builtin themes inherit them (same precedent as the login mark), and THEMES.md documents how theme authors override or disable them.

## 5c. Liquid-glass material upgrade

The existing `.fluux-glass` surface (modals + command palette; tokens, `data-transparency="reduced"` path, and `glass.test.ts` guard already in place) gains a liquid-glass tier:

- **Specular edges** — inset highlights on the panel: `inset 0 1px 0 rgba(255,255,255,0.22)` top, ~0.07 left, ~0.04 bottom, plus a diagonal sheen overlay (`linear-gradient(115deg, rgba(255,255,255,0.055), transparent 42%)`).
- **Deeper translucency** — panel alpha drops (~0.86 → ~0.60) while blur/saturation rise (`blur(22px) saturate(1.65)`), new tokens `--fluux-glass-blur-strong` and `--fluux-glass-specular`.
- **Aurora backlight in the scrim** — a soft aurora glow rendered in the modal scrim behind the panel, so the glass has real light to refract (this is what separates the effect from generic glassmorphism).
- **Primary buttons on glass** — translucent accent fill with inset specular (as validated in the mockup).

**Light mode:** panel opacity stays higher than dark (~0.66 vs ~0.60 — legibility over light content), the border stays dark-alpha (the light glass pattern already established after the audit), the inset white specular reads well and stays, the outer shadow deepens, and the scrim backlight uses the dawn stops.

**Gating:** the liquid tier applies on macOS/Windows/web; Linux (WebKitGTK) keeps the current lighter frost — heavy `backdrop-filter` is the known compositing weak point there. `data-transparency="reduced"` keeps returning fully opaque panels. Both gates reuse the existing mechanism in `index.css:542-560`.

## 6. Testing

- `auroraSeed.test.ts`: determinism (fixed seed → identical star field); star values within spec ranges.
- `AuroraMark.test.tsx`: renders with `aria-hidden`, expected layer groups (backlight, pane, rim, specular) and star count for the default seed.
- `LoginScreen.test.tsx`: update for the removed `MessageCircle` (verify no assertions reference it; login form behavior untouched).
- `MessageComposer.test.tsx`: send control renders muted when the input is empty and switches to the glass-ready state when content is present; aria-label preserved; reduced-transparency fallback renders the solid variant.
- `themeContrast.test.ts`: guard that `--fluux-aurora-ink` clears 3:1 (WCAG AA for UI components) against the worst-case stop of the fallback solid gradient in both modes, per theme; white icon ≥3:1 against the glass button's worst-case composite (glow at full strength over the composer surface).
- `glass.test.ts`: extend for the liquid tier (specular/blur-strong tokens present, Linux + reduced-transparency gates hold).
- Visual: demo mode check in both modes; regenerate `8x-login-aurora-dark/light` and the glass-modal screenshots (`43-glass-modal-*`) via the screenshots script.
- Pre-commit gates per project rules: full app tests, `npm run typecheck`, linter.

## 7. Performance

The mark is ~40 static SVG nodes rendered once at mount on a screen with no other load; motion is compositor-only opacity animation on four elements (three backlight ellipses + rim glow). The glass send button adds one small `backdrop-filter` element (34px — negligible). The modal liquid tier raises blur radius only on macOS/Windows/web; Linux keeps the current frost (§5c gating), so the WebKitGTK compositing path is unchanged there.

## 8. Out of scope / follow-ups

1. **App icon** — decision: the current 0.17 icon composition stays (owner's taste call after reviewing atmospheric replacements — they read as less refined than the existing icon). Two-part slight enhancement: (a) barely-perceptible light falloff on the gradient (anti-banding), ~5% film grain at large sizes, a hint of depth in the lower corner — validated side-by-side on light and dark dock backgrounds; (b) export the icon as layers (gradient tile + glyph, Icon Composer format) so macOS Tahoe / iOS 26 apply their native liquid-glass treatment — the most trend-anchored enhancement, with zero change to the composition itself.
2. **Empty states** — small freestanding aurora ribbon (concept C).
3. **Typing indicator** — dots shimmering through the aurora hues.
4. **Aurora accent presets** — curated `accentPresets` for the Aurora theme incl. an Aurora Teal preset built from `--fluux-accent-2`.
5. **README logo / blog hero** — migrate the lockup once the mark ships.
