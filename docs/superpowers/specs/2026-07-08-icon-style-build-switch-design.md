# Icon-style build switch (`plain` glass ⇄ `hollow` outline)

**Date:** 2026-07-08
**Status:** Design approved, pending implementation plan
**Related:** #910 (reuse the round chat-bubble mark), PR #926 (chat-bubble tail seam fix)

## Purpose

Fluux has two candidate app-icon treatments of the same round chat-bubble on the
same aurora gradient tile:

- **`plain`** — the current shipped glass bubble (`AppIconMark`): a solid
  white→pale-blue filled bubble with drop shadow + aurora-transmit glass layers.
- **`hollow`** — a restored/refined version of the outline mark that briefly
  appeared on the login screen during Aurora development (PR #756): Lucide's
  `MessageCircle` glyph, white stroke, on the same gradient. People reacted well
  to it, so we want to trial it as the default.

We want a **build-chain switch** — no runtime/Settings UI — that selects one
treatment for an entire build, swapping **everything**: the in-app login mark,
the native desktop/dock/taskbar/installer icons, the PWA icons, and the favicon.
For now the **default is `hollow`**; `plain` becomes the opt-in variant and
continues to carry PR #926's seam fix.

The gradient itself does not change — both variants use today's
`#38E0C4 → #7C8CFF → #A78BFA` aurora tile. Only the glyph on top differs.

## Non-goals (YAGNI)

- **No runtime toggle.** End users cannot flip this from Settings. It is a
  build-time decision only.
- **Not #910's "reuse the mark elsewhere in the app" work.** That (placing the
  mark in empty states, headers, etc.) is separate and unstarted.
- **No third variant**, no per-platform mixing, no theme-reactive icon.

## The switch: one env var, two mechanisms

A single environment variable selects the variant for a build:

```
VITE_FLUUX_ICON_STYLE = hollow   # default (unset ⇒ hollow)
VITE_FLUUX_ICON_STYLE = plain    # opt-in glass bubble
```

Usage:

```bash
npm run dev                              # hollow (default)
VITE_FLUUX_ICON_STYLE=plain npm run dev  # plain glass
VITE_FLUUX_ICON_STYLE=plain npm run tauri:build
```

It drives two independent mechanisms that must agree:

### 1. In-app login mark (bundle-time)

`LoginScreen.tsx` reads `import.meta.env.VITE_FLUUX_ICON_STYLE` — the exact
pattern already used for `VITE_SHOW_LOGO` in `Sidebar.tsx` — and renders one of:

- `HollowIconMark` (default), a new component, or
- `AppIconMark` (existing), the glass bubble.

Both expose the same `{ size, className }` API so they are drop-in
interchangeable. The surrounding aurora halo in `LoginScreen.tsx` (a blurred
`var(--fluux-grad)` div behind the mark) is unchanged and works for either mark.

### 2. Native / PWA / favicon assets (build-time file swap)

These are physical PNG/ICO/ICNS files referenced by fixed filename from
`tauri.conf.json`, `index.html`, and the Vite PWA manifest — so no config edits
are needed, only file replacement. A pre-build hook copies the selected
variant's pre-generated assets over the live locations before the bundler /
Tauri reads them.

## Glyph geometry (the `hollow` mark)

Determined empirically by rendering candidates on the real gradient tile (see
"Design exploration" below). All coordinates are in the **1024×1024 icon
canvas** shared by `AppIconMark`, `icon-source.svg`, and the new hollow sources.

- **Source path** (Lucide `MessageCircle`, v0.303.0):
  `M7.9 20A9 9 0 1 0 4 16.1L2 22Z` in a 24-unit space, `fill="none"`,
  `stroke-linecap="round"`, `stroke-linejoin="round"`.
- **Measured visual bounding box** (at stroke 2): 21.02 × 21.02 units, visual
  center `(11.51, 12.49)` — note this is *not* the nominal 24-box center; the
  tail biases it, so we center on the measured box.
- **Extent:** 56% of the 902px inner tile ⇒ scale `s = 0.56 × 902 / 21.02 ≈ 24.03`.
  Chosen to match the glass sibling's ~55% footprint so the two variants read as
  the same object at the same visual weight.
- **Transform:** `translate(235.41, 211.86) scale(24.03)`, centering the visual
  box at the tile center `(512, 512)`.
- **Stroke:** `stroke-width="2"` (Lucide default) in 24-space ⇒ ~48px on the
  1024 canvas (~5.3% of tile). Survives 32px favicon; thinner (1.75) vanishes at
  small sizes, thicker (2.5) closes the hollow counter.
- **Colour:** white `#FFFFFF`.
- **Subtle glass cue — drop shadow only:**
  `feDropShadow dx=0 dy=0.45 stdDeviation=0.6 flood-color="#160E3A" flood-opacity=0.22`,
  applied to the glyph group in its local 24-unit space (⇒ ~11px offset / ~14px
  blur on the 1024 canvas). Because the filter lives inside the scaled group it
  shrinks with the icon — visible depth at large sizes, gracefully fading to
  near-flat at 32–48px with no muddy halo. **No** fill gradient and **no**
  specular highlight: both were tried and rejected (the gradient dims the lower
  stroke into the background; the specular reads as a distracting double line).
  The drop shadow also rhymes with the glass sibling's own shadow, so the two
  variants feel like one family.

### Single source of truth for the glyph

The same path + transform + shadow parameters appear in two places that must
stay identical: the React `HollowIconMark` (login) and `icon-source-hollow.svg`
(rasterized icons). To prevent drift, the constants (path `d`, transform,
stroke, shadow) live in one small shared module (e.g.
`brand/messageBubbleGlyph.ts`) imported by `HollowIconMark`, and a guard test
asserts `icon-source-hollow.svg` embeds the same values.

## Asset layout & selection

Both variants are stored, fully generated, under a variants tree; the live
locations hold the committed **default** (hollow):

```
apps/fluux/src-tauri/icons/
  generate.sh                      # refactored: generate.sh [plain|hollow|all]
  icon-variants/
    plain/
      icon-source.svg              # glass squircle (seam-fixed, from #926)
      icon-source-maskable.svg     # glass maskable (seam-fixed)
      dist/
        icons/   …                 # full generated set, mirroring live layout
        public/  …
    hollow/
      icon-source.svg              # hollow MessageCircle squircle
      icon-source-maskable.svg     # hollow maskable (full-bleed tile, same glyph)
      dist/
        icons/   …
        public/  …
  32x32.png, icon.icns, icon.ico, ios/, android/, Square*Logo.png, …
                                   # LIVE active set — committed = default (hollow)
apps/fluux/public/
  favicon.png, apple-touch-icon.png, logo.png, icon-{192,512}{,-maskable}.png
                                   # LIVE active set — committed = default (hollow)
```

**`scripts/select-icon-variant.mjs`** (new):

1. `style = process.env.VITE_FLUUX_ICON_STYLE || 'hollow'`.
2. Copy `icon-variants/<style>/dist/icons/**` → `src-tauri/icons/` (live) and
   `icon-variants/<style>/dist/public/**` → `public/`.
3. Log a clear one-line banner naming the active variant.

Pure copy from committed files — **git-independent**, no rasterizer needed at
build time, works on fresh checkouts and source tarballs. Wired as a hook on
`predev`, `prebuild`, and inside the Tauri build/dev scripts
(`apps/fluux/scripts/tauri-{dev,build}.sh`).

**Trade-off accepted:** the live set duplicates `icon-variants/hollow/dist`
(~2 MB of binaries). Chosen over a `git checkout`-based restore (which avoids the
duplicate but needs a git working tree) for simplicity and portability. A guard
test (below) asserts the live set stays byte-identical to the default variant's
dist so it can never drift silently.

**`generate.sh`** is refactored to take a variant argument: it reads that
variant's two source SVGs and writes the full PNG/ICO/ICNS set into that
variant's `dist/` (same rsvg-convert / ImageMagick / iconutil pipeline as
today). `generate.sh all` regenerates both. A final step (or the selection
script) refreshes the live set from the default. This is a dev-time tool run
only when a source SVG changes; normal builds just copy committed dist files.

## Testing

- **Login mark selection:** `LoginScreen.test.tsx` — with the env var unset or
  `hollow`, `HollowIconMark` renders; with `plain`, `AppIconMark` renders
  (`vi.stubEnv('VITE_FLUUX_ICON_STYLE', …)`).
- **Glyph parity guard:** assert `icon-source-hollow.svg` embeds the same path /
  transform / shadow constants as the shared glyph module.
- **Live-vs-default guard:** assert the live `src-tauri/icons` + `public` icon
  files are byte-identical to `icon-variants/hollow/dist` (catches a stale live
  set after a hollow-source edit).
- **Existing seam-fix regeneration** (PR #926) is unaffected; the plain sources
  simply move under `icon-variants/plain/`.

## Branch / PR strategy

This work **stacks on the seam-fix commit** (current branch HEAD) so the `plain`
variant inherits PR #926's fix. It ships as a **separate PR** from #926 to keep
the pure bugfix reviewable on its own. Confirm the exact base at PR time.

## Design exploration (for the record)

Rendered on the real gradient tile and compared as montages:

- **Size sweep** (44 / 50 / 56 / 62% extent): 44–50% float with too much empty
  gradient; 62% crowds the corners; **56%** twins the glass sibling's footprint.
  (The accidental original login mark was ~44% — fine as a tiny login chip,
  under-filled as a dock icon.)
- **Stroke sweep** (1.75 / 2.0 / 2.25 / 2.5u): **2.0u** is the Lucide default —
  elegant yet legible at 32px; 1.75 thins out, 2.5 goes chunky.
- **Glass-effect spectrum** (flat / +shadow / +stroke-gradient / +specular):
  **flat + soft drop shadow** wins; gradient and specular were rejected.
- **Shadow intensity** (0.30 / 0.22 / 0.15): **0.22**; confirmed graceful
  degradation at 48px and 32px.
