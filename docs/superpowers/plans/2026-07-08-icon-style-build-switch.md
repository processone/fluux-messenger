# Icon-style build switch (plain glass / hollow outline) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a build-chain switch (`VITE_FLUUX_ICON_STYLE`, default `hollow`) that selects the app's chat-bubble icon treatment — a white outline (`hollow`) or the current glass bubble (`plain`) — for the login mark, native/desktop icons, PWA icons, and favicon in one build.

**Architecture:** One env var drives two mechanisms. (1) `LoginScreen.tsx` reads `import.meta.env.VITE_FLUUX_ICON_STYLE` at render time and renders `HollowIconMark` or `AppIconMark`. (2) A pre-build Node hook copies a pre-generated variant asset tree over the live icon/favicon locations. Both icon variants are stored fully generated under `src-tauri/icons/icon-variants/{plain,hollow}/dist/`; the live locations are committed as the default (`hollow`).

**Tech Stack:** React + TypeScript, Vite (`import.meta.env`), Vitest + @testing-library/react, Bash + rsvg-convert/ImageMagick/iconutil (icon generation), Node ESM scripts.

## Global Constraints

- **Gradient is fixed:** every variant uses the aurora tile `#38E0C4 → #7C8CFF → #A78BFA` (diagonal, `userSpaceOnUse` 0,0→1024,1024). Do not alter it.
- **Icon canvas:** 1024×1024; squircle tile `rect x=61 y=61 w=902 h=902 rx=225`.
- **Hollow glyph is PINNED, not imported:** use the literal path `M7.9 20A9 9 0 1 0 4 16.1L2 22Z`. Do NOT `import { MessageCircle } from 'lucide-react'` — the installed lucide-react 1.16.0 ships a *different* redesigned MessageCircle.
- **Hollow glyph placement (verified):** `transform="translate(235.41 211.86) scale(24.0304)"`, `stroke="#FFFFFF"`, `stroke-width="2"`, round caps/joins.
- **Hollow glyph shadow (renderer-robust):** `feDropShadow dx=0 dy=10.8 stdDeviation=14.4 flood-color=#160E3A flood-opacity=0.22` in absolute 1024-space, on an **unscaled wrapper `<g>`** that wraps the scaled glyph `<g>`. Never put the filter on the scaled group (Cairo/Skia inconsistency).
- **Default variant:** `hollow`. `VITE_FLUUX_ICON_STYLE=plain` opts into the glass bubble. Unknown values fall back to `hollow` with a warning.
- **Commits:** SSH-signed (`ssh-add ~/.ssh/id_ed25519` first if signing prompts). Never include a Claude footer.
- **Per-workspace tests:** run Vitest from `apps/fluux` (`cd apps/fluux && npx vitest run …`), never bare root vitest.
- **Spec:** `docs/superpowers/specs/2026-07-08-icon-style-build-switch-design.md`.

---

### Task 1: Shared glyph module + `HollowIconMark` component

**Files:**
- Create: `apps/fluux/src/components/brand/messageBubbleGlyph.ts`
- Create: `apps/fluux/src/components/brand/HollowIconMark.tsx`
- Test: `apps/fluux/src/components/brand/HollowIconMark.test.tsx`

**Interfaces:**
- Produces: `MESSAGE_BUBBLE_PATH: string`, `GLYPH_TRANSFORM: string`, `GLYPH_STROKE_WIDTH: number`, `GLYPH_SHADOW: { dy: number; stdDeviation: number; color: string; opacity: number }` (from `messageBubbleGlyph.ts`); `HollowIconMark({ size?: number; className?: string })` rendering `<svg class="hollow-icon-mark">`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/brand/HollowIconMark.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { HollowIconMark } from './HollowIconMark'
import { MESSAGE_BUBBLE_PATH, GLYPH_TRANSFORM } from './messageBubbleGlyph'

describe('HollowIconMark', () => {
  it('renders a decorative 1024 viewBox svg with the hollow-icon-mark class', () => {
    const { container } = render(<HollowIconMark size={72} />)
    const svg = container.querySelector('svg.hollow-icon-mark')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('viewBox')).toBe('0 0 1024 1024')
    expect(svg!.getAttribute('aria-hidden')).toBe('true')
    expect(svg!.getAttribute('width')).toBe('72')
  })

  it('draws the pinned MessageCircle glyph at the agreed transform', () => {
    const { container } = render(<HollowIconMark />)
    const path = container.querySelector('path[d="' + MESSAGE_BUBBLE_PATH + '"]')
    expect(path).not.toBeNull()
    expect(path!.getAttribute('stroke')).toBe('#FFFFFF')
    expect(path!.getAttribute('fill')).toBe('none')
    // the glyph sits inside a group carrying the agreed transform
    const group = container.querySelector(`g[transform="${GLYPH_TRANSFORM}"]`)
    expect(group).not.toBeNull()
  })

  it('forwards an extra className alongside the base class', () => {
    const { container } = render(<HollowIconMark className="relative" />)
    const svg = container.querySelector('svg.hollow-icon-mark.relative')
    expect(svg).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/brand/HollowIconMark.test.tsx`
Expected: FAIL — cannot resolve `./HollowIconMark` / `./messageBubbleGlyph`.

- [ ] **Step 3: Create the shared glyph module**

Create `apps/fluux/src/components/brand/messageBubbleGlyph.ts`:

```ts
/**
 * Single source of truth for the hollow chat-bubble glyph as placed on the
 * 1024×1024 app-icon canvas. Shared by HollowIconMark (login screen) and
 * asserted against src-tauri/icons/icon-variants/hollow/*.svg by
 * messageBubbleGlyph.test.ts, so the React mark and the rasterized icons cannot
 * drift. Geometry derived in
 * docs/superpowers/specs/2026-07-08-icon-style-build-switch-design.md.
 *
 * PINNED, not imported: this is the historical Lucide MessageCircle (v0.x era) —
 * the exact glyph in the approved login mark. Do NOT import MessageCircle from
 * lucide-react: the installed 1.16.0 ships a redesigned, different-shaped
 * MessageCircle, and a brand icon must not mutate when the library is bumped.
 */
export const MESSAGE_BUBBLE_PATH = 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z'

/** Centers the glyph's measured visual box at the tile center, 56% extent. */
export const GLYPH_TRANSFORM = 'translate(235.41 211.86) scale(24.0304)'

/** Lucide default stroke weight (24-unit space). */
export const GLYPH_STROKE_WIDTH = 2

/**
 * Drop shadow in ABSOLUTE 1024-canvas units. Applied to an unscaled wrapper <g>
 * (never the scaled glyph group) so Cairo (rsvg) and Skia (browser) render it
 * identically — the same renderer-consistency lesson as the seam fix (#926).
 */
export const GLYPH_SHADOW = {
  dy: 10.8,
  stdDeviation: 14.4,
  color: '#160E3A',
  opacity: 0.22,
} as const
```

- [ ] **Step 4: Create the component**

Create `apps/fluux/src/components/brand/HollowIconMark.tsx`:

```tsx
import { useId } from 'react'
import {
  MESSAGE_BUBBLE_PATH,
  GLYPH_TRANSFORM,
  GLYPH_STROKE_WIDTH,
  GLYPH_SHADOW,
} from './messageBubbleGlyph'

/**
 * Hollow variant of the Fluux app icon for the login screen: the same aurora
 * gradient squircle as AppIconMark, but with the chat bubble drawn as a white
 * outline (drop shadow only, no glass fill). Mirrors
 * src-tauri/icons/icon-variants/hollow/icon-source.svg so the login mark and the
 * installed hollow app icon are the same object. Decorative (aria-hidden).
 */

const TILE = { x: 61, y: 61, w: 902, h: 902, rx: 225 }

interface HollowIconMarkProps {
  /** Rendered square size in px (viewBox is 1024×1024). */
  size?: number
  className?: string
}

export function HollowIconMark({ size = 72, className }: HollowIconMarkProps) {
  const uid = useId().replace(/:/g, '')
  const id = (s: string) => `hi-${uid}-${s}`

  return (
    <svg
      className={`hollow-icon-mark ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id('aurora')} x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#38E0C4" />
          <stop offset="0.52" stopColor="#7C8CFF" />
          <stop offset="1" stopColor="#A78BFA" />
        </linearGradient>
        <radialGradient id={id('bloomTeal')} cx="0.16" cy="0.9" r="0.57">
          <stop offset="0" stopColor="#3FF0D6" stopOpacity="0.25" />
          <stop offset="1" stopColor="#3FF0D6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('bloomViolet')} cx="0.9" cy="0.1" r="0.57">
          <stop offset="0" stopColor="#B79CFF" stopOpacity="0.22" />
          <stop offset="1" stopColor="#B79CFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('sheen')} x1="512" y1="61" x2="512" y2="963" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.22" />
          <stop offset="0.19" stopColor="#FFFFFF" stopOpacity="0.04" />
          <stop offset="0.34" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <clipPath id={id('tile')}>
          <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} rx={TILE.rx} />
        </clipPath>
        <filter id={id('glyphShadow')} x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow
            dx="0"
            dy={GLYPH_SHADOW.dy}
            stdDeviation={GLYPH_SHADOW.stdDeviation}
            floodColor={GLYPH_SHADOW.color}
            floodOpacity={GLYPH_SHADOW.opacity}
          />
        </filter>
      </defs>

      <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} rx={TILE.rx} fill={`url(#${id('aurora')})`} />
      <g clipPath={`url(#${id('tile')})`}>
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('bloomTeal')})`} />
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('bloomViolet')})`} />
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('sheen')})`} />
      </g>
      <rect x="63.5" y="63.5" width="897" height="897" rx="222.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.15" strokeWidth="3" />

      {/* Shadow on the unscaled wrapper (absolute 1024-space); transform on the
          inner group. See messageBubbleGlyph.ts GLYPH_SHADOW note. */}
      <g filter={`url(#${id('glyphShadow')})`}>
        <g transform={GLYPH_TRANSFORM}>
          <path
            d={MESSAGE_BUBBLE_PATH}
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={GLYPH_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </g>
    </svg>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/brand/HollowIconMark.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/brand/messageBubbleGlyph.ts \
        apps/fluux/src/components/brand/HollowIconMark.tsx \
        apps/fluux/src/components/brand/HollowIconMark.test.tsx
git commit -m "feat(brand): HollowIconMark + shared pinned chat-bubble glyph"
```

---

### Task 2: `LoginScreen` selects the mark by `VITE_FLUUX_ICON_STYLE`

**Files:**
- Modify: `apps/fluux/src/components/LoginScreen.tsx` (import + mark render at line ~444)
- Test: `apps/fluux/src/components/LoginScreen.test.tsx` (update existing brand-mark test at ~506; add a variant describe block)

**Interfaces:**
- Consumes: `HollowIconMark` (Task 1), `AppIconMark` (existing).
- Produces: login renders `svg.hollow-icon-mark` by default, `svg.app-icon-mark` when `VITE_FLUUX_ICON_STYLE=plain`.

- [ ] **Step 1: Update/extend the failing tests**

In `apps/fluux/src/components/LoginScreen.test.tsx`, add `afterEach` to the imports line (it already imports from vitest) and **replace** the existing brand-mark test (the `it('renders the app-icon brand mark …')` block, ~line 506) with:

```tsx
  it('renders a brand mark svg + display-font heading (no flat logo img)', () => {
    render(<LoginScreen />)
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.className).toMatch(/font-display/)
    expect(screen.queryByRole('img')).toBeNull()
    // brand mark is an inline svg of whichever variant is active
    expect(document.querySelector('svg.hollow-icon-mark, svg.app-icon-mark')).not.toBeNull()
  })
```

Then append a new describe block at the end of the file:

```tsx
describe('LoginScreen — icon-style variant', () => {
  beforeEach(() => {
    useAdvancedModeStore.setState({ advancedMode: false })
    mockUseConnection.mockReturnValue({ status: 'offline', error: null, connect: mockConnect })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to the hollow mark when the flag is unset', () => {
    render(<LoginScreen />)
    expect(document.querySelector('svg.hollow-icon-mark')).not.toBeNull()
    expect(document.querySelector('svg.app-icon-mark')).toBeNull()
  })

  it('renders the plain glass mark when VITE_FLUUX_ICON_STYLE=plain', () => {
    vi.stubEnv('VITE_FLUUX_ICON_STYLE', 'plain')
    render(<LoginScreen />)
    expect(document.querySelector('svg.app-icon-mark')).not.toBeNull()
    expect(document.querySelector('svg.hollow-icon-mark')).toBeNull()
  })

  it('falls back to the hollow mark for an unknown flag value', () => {
    vi.stubEnv('VITE_FLUUX_ICON_STYLE', 'sparkly')
    render(<LoginScreen />)
    expect(document.querySelector('svg.hollow-icon-mark')).not.toBeNull()
  })
})
```

Ensure `afterEach` is in the top `import { … } from 'vitest'` line (add it if missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx`
Expected: FAIL — the default test finds no `svg.hollow-icon-mark` (LoginScreen still renders `AppIconMark`).

- [ ] **Step 3: Wire the selection into LoginScreen**

In `apps/fluux/src/components/LoginScreen.tsx`, add the import next to the existing AppIconMark import (line 4):

```tsx
import { AppIconMark } from './brand/AppIconMark'
import { HollowIconMark } from './brand/HollowIconMark'
```

Replace the `<AppIconMark size={72} className="…" />` usage (~line 444) with a variant-selected mark. The mark element:

```tsx
            {(import.meta.env.VITE_FLUUX_ICON_STYLE === 'plain'
              ? AppIconMark
              : HollowIconMark)({
              size: 72,
              className:
                'relative [filter:drop-shadow(0_6px_16px_rgba(26,32,64,0.22))]',
            })}
```

If the surrounding JSX makes a call form awkward, use an explicit element instead:

```tsx
            {import.meta.env.VITE_FLUUX_ICON_STYLE === 'plain' ? (
              <AppIconMark size={72} className="relative [filter:drop-shadow(0_6px_16px_rgba(26,32,64,0.22))]" />
            ) : (
              <HollowIconMark size={72} className="relative [filter:drop-shadow(0_6px_16px_rgba(26,32,64,0.22))]" />
            )}
```

(Read at render time so `vi.stubEnv` works — do not hoist to a module constant.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx`
Expected: PASS (all existing LoginScreen tests + 3 new variant tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/LoginScreen.tsx apps/fluux/src/components/LoginScreen.test.tsx
git commit -m "feat(login): select icon mark via VITE_FLUUX_ICON_STYLE (default hollow)"
```

---

### Task 3: Hollow SVG icon sources + glyph-parity guard

**Files:**
- Create: `apps/fluux/src-tauri/icons/icon-variants/hollow/icon-source.svg`
- Create: `apps/fluux/src-tauri/icons/icon-variants/hollow/icon-source-maskable.svg`
- Test: `apps/fluux/src/components/brand/messageBubbleGlyph.test.ts`

**Interfaces:**
- Consumes: constants from `messageBubbleGlyph.ts` (Task 1).
- Produces: the two hollow source SVGs used by `generate.sh hollow` (Task 4).

- [ ] **Step 1: Write the failing parity test**

Create `apps/fluux/src/components/brand/messageBubbleGlyph.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MESSAGE_BUBBLE_PATH, GLYPH_TRANSFORM } from './messageBubbleGlyph'

// process.cwd() is apps/fluux when vitest runs in this workspace.
const HOLLOW = resolve(process.cwd(), 'src-tauri/icons/icon-variants/hollow')

describe('hollow icon sources embed the shared glyph constants', () => {
  for (const file of ['icon-source.svg', 'icon-source-maskable.svg']) {
    it(`${file} uses the pinned path and transform`, () => {
      const svg = readFileSync(resolve(HOLLOW, file), 'utf8')
      expect(svg).toContain(MESSAGE_BUBBLE_PATH)
      expect(svg).toContain(GLYPH_TRANSFORM)
      // shadow must live on an unscaled wrapper, not the scaled glyph group
      expect(svg).toMatch(/stdDeviation="14\.4"/)
    })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/brand/messageBubbleGlyph.test.ts`
Expected: FAIL — the hollow source files do not exist yet.

- [ ] **Step 3: Create the squircle hollow source**

Create `apps/fluux/src-tauri/icons/icon-variants/hollow/icon-source.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="aurora" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#38E0C4"/>
      <stop offset="0.52" stop-color="#7C8CFF"/>
      <stop offset="1" stop-color="#A78BFA"/>
    </linearGradient>
    <radialGradient id="bloomTeal" cx="0.16" cy="0.9" r="0.57">
      <stop offset="0" stop-color="#3FF0D6" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#3FF0D6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bloomViolet" cx="0.9" cy="0.1" r="0.57">
      <stop offset="0" stop-color="#B79CFF" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#B79CFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sheen" x1="512" y1="61" x2="512" y2="963" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/>
      <stop offset="0.19" stop-color="#FFFFFF" stop-opacity="0.04"/>
      <stop offset="0.34" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="tileClip"><rect x="61" y="61" width="902" height="902" rx="225"/></clipPath>
    <filter id="glyphShadow" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="10.8" stdDeviation="14.4" flood-color="#160E3A" flood-opacity="0.22"/>
    </filter>
  </defs>

  <rect x="61" y="61" width="902" height="902" rx="225" fill="url(#aurora)"/>
  <g clip-path="url(#tileClip)">
    <rect x="61" y="61" width="902" height="902" fill="url(#bloomTeal)"/>
    <rect x="61" y="61" width="902" height="902" fill="url(#bloomViolet)"/>
    <rect x="61" y="61" width="902" height="902" fill="url(#sheen)"/>
  </g>
  <rect x="63.5" y="63.5" width="897" height="897" rx="222.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.15" stroke-width="3"/>

  <!-- Hollow glyph: shadow in absolute 1024-space (renderer-robust); transform on inner group. -->
  <g filter="url(#glyphShadow)">
    <g transform="translate(235.41 211.86) scale(24.0304)">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </g>
</svg>
```

- [ ] **Step 4: Create the maskable (full-bleed) hollow source**

Create `apps/fluux/src-tauri/icons/icon-variants/hollow/icon-source-maskable.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="aurora" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#38E0C4"/>
      <stop offset="0.52" stop-color="#7C8CFF"/>
      <stop offset="1" stop-color="#A78BFA"/>
    </linearGradient>
    <radialGradient id="bloomTeal" cx="0.16" cy="0.9" r="0.6">
      <stop offset="0" stop-color="#3FF0D6" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#3FF0D6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bloomViolet" cx="0.9" cy="0.1" r="0.6">
      <stop offset="0" stop-color="#B79CFF" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#B79CFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sheen" x1="512" y1="0" x2="512" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/>
      <stop offset="0.19" stop-color="#FFFFFF" stop-opacity="0.04"/>
      <stop offset="0.34" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="glyphShadow" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="10.8" stdDeviation="14.4" flood-color="#160E3A" flood-opacity="0.22"/>
    </filter>
  </defs>

  <rect x="0" y="0" width="1024" height="1024" fill="url(#aurora)"/>
  <rect x="0" y="0" width="1024" height="1024" fill="url(#bloomTeal)"/>
  <rect x="0" y="0" width="1024" height="1024" fill="url(#bloomViolet)"/>
  <rect x="0" y="0" width="1024" height="1024" fill="url(#sheen)"/>

  <g filter="url(#glyphShadow)">
    <g transform="translate(235.41 211.86) scale(24.0304)">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </g>
</svg>
```

- [ ] **Step 5: Run the parity test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/brand/messageBubbleGlyph.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Visually verify the rendered source (rsvg)**

Run:
```bash
cd apps/fluux/src-tauri/icons/icon-variants/hollow
rsvg-convert -w 512 -h 512 icon-source.svg -o /tmp/hollow-check-512.png
rsvg-convert -w 32 -h 32 icon-source.svg -o /tmp/hollow-check-32.png
```
Expected: both succeed (exit 0). Open `/tmp/hollow-check-512.png` — a teal→violet squircle with a clean white outline chat bubble, subtle shadow, no seam/artifact; `/tmp/hollow-check-32.png` stays legible.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src-tauri/icons/icon-variants/hollow/icon-source.svg \
        apps/fluux/src-tauri/icons/icon-variants/hollow/icon-source-maskable.svg \
        apps/fluux/src/components/brand/messageBubbleGlyph.test.ts
git commit -m "feat(icons): hollow variant SVG sources + glyph-parity guard"
```

---

### Task 4: Restructure into variant trees + refactor `generate.sh` + generate both dists

**Files:**
- Move: `apps/fluux/src-tauri/icons/icon-source.svg` → `apps/fluux/src-tauri/icons/icon-variants/plain/icon-source.svg`
- Move: `apps/fluux/src-tauri/icons/icon-source-maskable.svg` → `apps/fluux/src-tauri/icons/icon-variants/plain/icon-source-maskable.svg`
- Rewrite: `apps/fluux/src-tauri/icons/generate.sh`
- Modify: `apps/fluux/src/components/brand/AppIconMark.tsx` (doc comment path, line ~6)
- Modify: `assets/README.md` (lines 17–18, source paths)
- Generates: `apps/fluux/src-tauri/icons/icon-variants/{plain,hollow}/dist/**`

**Interfaces:**
- Consumes: hollow sources (Task 3); the relocated plain sources.
- Produces: `icon-variants/<variant>/dist/{icons,public}/**` — the full committed asset set per variant, mirroring the live layout.

- [ ] **Step 1: Relocate the plain sources**

```bash
cd apps/fluux/src-tauri/icons
mkdir -p icon-variants/plain
git mv icon-source.svg icon-variants/plain/icon-source.svg
git mv icon-source-maskable.svg icon-variants/plain/icon-source-maskable.svg
```

- [ ] **Step 2: Rewrite `generate.sh` to be variant-parametrized**

Replace `apps/fluux/src-tauri/icons/generate.sh` entirely with:

```bash
#!/usr/bin/env bash
#
# Regenerate a variant's platform icons from its two SVG sources.
#
#   icon-variants/<variant>/icon-source.svg           squircle, transparent corners
#   icon-variants/<variant>/icon-source-maskable.svg  full-bleed (PWA maskable / apple-touch)
#
# Outputs the full PNG/ICO/ICNS set into icon-variants/<variant>/dist/{icons,public}.
# The live app icons are populated FROM a variant's dist by
# ../../../scripts/select-icon-variant.mjs (runs on predev/prebuild/pretauri:*).
#
# Usage:  ./generate.sh [plain|hollow|all]   (default: all)
# Requires: rsvg-convert, ImageMagick (magick), iconutil (macOS).
set -euo pipefail

ICONS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for bin in rsvg-convert magick iconutil; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done

gen_variant() {
  local VARIANT="$1"
  local VDIR="$ICONS/icon-variants/$VARIANT"
  local SQ="$VDIR/icon-source.svg"
  local MK="$VDIR/icon-source-maskable.svg"
  [ -f "$SQ" ] || { echo "missing source: $SQ" >&2; exit 1; }
  [ -f "$MK" ] || { echo "missing source: $MK" >&2; exit 1; }

  local OUT_I="$VDIR/dist/icons"
  local OUT_P="$VDIR/dist/public"
  local TMP; TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' RETURN

  rm -rf "$OUT_I" "$OUT_P"
  mkdir -p "$OUT_I/ios" "$OUT_P"
  for dpi in mdpi hdpi xhdpi xxhdpi xxxhdpi; do mkdir -p "$OUT_I/android/mipmap-$dpi"; done

  # squircle / transparent corners
  sq()  { rsvg-convert -w "$1" -h "$1" "$SQ" -o "$2"; }
  # full-bleed maskable (iOS apple-touch: iOS applies its own rounded mask)
  mk()  { rsvg-convert -w "$1" -h "$1" "$MK" -o "$2"; }
  # rounded maskable for Android/PWA: the squircle flattened on the manifest bg
  mkr() { rsvg-convert -w "$1" -h "$1" "$SQ" -o "$TMP/_mkr.png"; magick "$TMP/_mkr.png" -background '#1a1b1e' -flatten "$2"; }
  # squircle flattened on white (iOS — no alpha allowed)
  sqw() { rsvg-convert -w "$1" -h "$1" "$SQ" -o "$TMP/_w.png"; magick "$TMP/_w.png" -background white -flatten "$2"; }
  # squircle masked to a circle (android round)
  sqr() { rsvg-convert -w "$1" -h "$1" "$SQ" -o "$TMP/_r.png"; \
          magick -size "${1}x${1}" xc:none -fill white -draw "circle $(( $1/2 )),$(( $1/2 )) $(( $1/2 )),0" "$TMP/_mask.png"; \
          magick "$TMP/_r.png" "$TMP/_mask.png" -alpha off -compose CopyOpacity -composite "$2"; }

  echo "== [$VARIANT] src-tauri/icons (squircle) =="
  sq 512 "$OUT_I/icon.png"
  sq 256 "$OUT_I/256x256.png"
  sq 256 "$OUT_I/128x128@2x.png"
  sq 128 "$OUT_I/128x128.png"
  sq 64  "$OUT_I/64x64.png"
  sq 32  "$OUT_I/32x32.png"

  echo "== [$VARIANT] Windows Square logos (squircle) =="
  for s in 30 44 71 89 107 142 150 284 310; do sq "$s" "$OUT_I/Square${s}x${s}Logo.png"; done
  sq 50 "$OUT_I/StoreLogo.png"

  echo "== [$VARIANT] public PWA standard (squircle) =="
  sq 512 "$OUT_P/icon-512.png"
  sq 192 "$OUT_P/icon-192.png"
  sq 512 "$OUT_P/logo.png"
  sq 32  "$OUT_P/favicon.png"

  echo "== [$VARIANT] public PWA maskable (rounded on bg) + apple-touch (full bleed) =="
  mkr 512 "$OUT_P/icon-512-maskable.png"
  mkr 192 "$OUT_P/icon-192-maskable.png"
  mk  180 "$OUT_P/apple-touch-icon.png"

  echo "== [$VARIANT] iOS (squircle on white, no alpha) =="
  declare -A IOS=(
    [AppIcon-20x20@1x]=20 [AppIcon-20x20@2x]=40 [AppIcon-20x20@2x-1]=40 [AppIcon-20x20@3x]=60
    [AppIcon-29x29@1x]=29 [AppIcon-29x29@2x]=58 [AppIcon-29x29@2x-1]=58 [AppIcon-29x29@3x]=87
    [AppIcon-40x40@1x]=40 [AppIcon-40x40@2x]=80 [AppIcon-40x40@2x-1]=80 [AppIcon-40x40@3x]=120
    [AppIcon-60x60@2x]=120 [AppIcon-60x60@3x]=180
    [AppIcon-76x76@1x]=76 [AppIcon-76x76@2x]=152 [AppIcon-83.5x83.5@2x]=167
    [AppIcon-512@2x]=1024
  )
  for name in "${!IOS[@]}"; do sqw "${IOS[$name]}" "$OUT_I/ios/${name}.png"; done

  echo "== [$VARIANT] Android adaptive =="
  declare -A DPI=( [mdpi]=48 [hdpi]=49 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
  declare -A FG=(  [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432 )
  for dpi in "${!DPI[@]}"; do
    d="$OUT_I/android/mipmap-$dpi"
    sq  "${DPI[$dpi]}" "$d/ic_launcher.png"
    sqr "${DPI[$dpi]}" "$d/ic_launcher_round.png"
    sq  "${FG[$dpi]}"  "$d/ic_launcher_foreground.png"
  done

  echo "== [$VARIANT] Windows ICO (multi-size, squircle) =="
  ICO_TMP=()
  for s in 16 24 32 48 64 256; do sq "$s" "$TMP/ico_$s.png"; ICO_TMP+=("$TMP/ico_$s.png"); done
  magick "${ICO_TMP[@]}" "$OUT_I/icon.ico"

  echo "== [$VARIANT] macOS ICNS (squircle, transparent) =="
  ISET="$TMP/icon.iconset"; mkdir -p "$ISET"
  sq 16   "$ISET/icon_16x16.png";      sq 32   "$ISET/icon_16x16@2x.png"
  sq 32   "$ISET/icon_32x32.png";      sq 64   "$ISET/icon_32x32@2x.png"
  sq 128  "$ISET/icon_128x128.png";    sq 256  "$ISET/icon_128x128@2x.png"
  sq 256  "$ISET/icon_256x256.png";    sq 512  "$ISET/icon_256x256@2x.png"
  sq 512  "$ISET/icon_512x512.png";    sq 1024 "$ISET/icon_512x512@2x.png"
  iconutil -c icns "$ISET" -o "$OUT_I/icon.icns"

  echo "[$VARIANT] DONE"
}

TARGET="${1:-all}"
case "$TARGET" in
  plain|hollow) gen_variant "$TARGET" ;;
  all)          gen_variant plain; gen_variant hollow ;;
  *) echo "usage: ./generate.sh [plain|hollow|all]" >&2; exit 1 ;;
esac
```

- [ ] **Step 3: Generate both variant dists**

```bash
cd apps/fluux/src-tauri/icons
./generate.sh all
```
Expected: prints `[plain] DONE` then `[hollow] DONE`, exit 0.

- [ ] **Step 4: Verify the dist trees exist and are complete**

```bash
ls icon-variants/plain/dist/icons icon-variants/plain/dist/public
ls icon-variants/hollow/dist/icons icon-variants/hollow/dist/public
# spot-check the hollow dock icon has no seam and reads as an outline:
magick icon-variants/hollow/dist/icons/icon.png -crop 260x120+120+300 /tmp/hollow-dock-junction.png
```
Expected: each `dist/icons` has `icon.png icon.ico icon.icns 32x32.png … ios/ android/ Square*Logo.png`; each `dist/public` has `favicon.png apple-touch-icon.png logo.png icon-192.png icon-512.png icon-192-maskable.png icon-512-maskable.png`. Open `/tmp/hollow-dock-junction.png` — white outline, no seam.

- [ ] **Step 5: Update stale source-path references**

In `apps/fluux/src/components/brand/AppIconMark.tsx` (~line 6), change the doc comment reference `src-tauri/icons/icon-source.svg` to `src-tauri/icons/icon-variants/plain/icon-source.svg`.

In `assets/README.md` (lines 17–18), update:

```markdown
- `apps/fluux/src-tauri/icons/icon-variants/plain/icon-source.svg` - Glass (plain) vector source.
- `apps/fluux/src-tauri/icons/icon-variants/hollow/icon-source.svg` - Hollow-outline vector source. Maskable variants sit beside each. Run `./generate.sh all` in `src-tauri/icons` to re-derive; `scripts/select-icon-variant.mjs` copies a variant's `dist/` onto the live icons.
```

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src-tauri/icons apps/fluux/src/components/brand/AppIconMark.tsx assets/README.md
git commit -m "refactor(icons): variant trees + variant-parametrized generate.sh; build both dists"
```

---

### Task 5: Selection script + build-hook wiring + swap live default to hollow

**Files:**
- Create: `scripts/select-icon-variant.mjs`
- Modify: `package.json` (root) — `predev`, `prebuild`, add `pretauri:dev`, `pretauri:build`
- Overwrites (live): `apps/fluux/src-tauri/icons/*` and `apps/fluux/public/*` icon files (plain → hollow)

**Interfaces:**
- Consumes: `icon-variants/<style>/dist/**` (Task 4).
- Produces: live icon/favicon files matching the selected variant; `node scripts/select-icon-variant.mjs` is the reusable entry point.

- [ ] **Step 1: Create the selection script**

Create `scripts/select-icon-variant.mjs`:

```js
#!/usr/bin/env node
/**
 * Copy a built icon variant's assets over the live app-icon locations.
 * Variant is chosen by VITE_FLUUX_ICON_STYLE (default 'hollow'); 'plain' opts
 * into the glass bubble. Runs on predev / prebuild / pretauri:* so a build's
 * native + PWA + favicon icons match the login mark's variant.
 *
 * Pure file copy from committed dist trees — no rasterizer or git needed.
 */
import { cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const appRoot = resolve(repoRoot, 'apps/fluux')

const raw = process.env.VITE_FLUUX_ICON_STYLE
const style = raw === 'plain' ? 'plain' : 'hollow'
if (raw && raw !== 'plain' && raw !== 'hollow') {
  console.warn(`[icon-variant] unknown VITE_FLUUX_ICON_STYLE="${raw}"; using hollow`)
}

const dist = resolve(appRoot, 'src-tauri/icons/icon-variants', style, 'dist')
if (!existsSync(dist)) {
  console.error(
    `[icon-variant] missing generated assets for "${style}": ${dist}\n` +
    `Run: (cd apps/fluux/src-tauri/icons && ./generate.sh ${style})`,
  )
  process.exit(1)
}

// Merge dist/icons over the live icons dir (leaves generate.sh + icon-variants/
// intact) and dist/public over the live public dir.
cpSync(resolve(dist, 'icons'), resolve(appRoot, 'src-tauri/icons'), { recursive: true })
cpSync(resolve(dist, 'public'), resolve(appRoot, 'public'), { recursive: true })
console.log(`[icon-variant] applied "${style}" icon set (native + PWA + favicon)`)
```

- [ ] **Step 2: Wire the hook into root `package.json`**

In the root `package.json` `scripts`, extend the two existing pre-hooks and add two Tauri ones:

```json
    "predev": "npm run guard:sdk-link && node scripts/select-icon-variant.mjs",
    "prebuild": "npm run guard:sdk-link && node scripts/select-icon-variant.mjs",
    "pretauri:dev": "node scripts/select-icon-variant.mjs",
    "pretauri:build": "node scripts/select-icon-variant.mjs",
```

(Keep the rest of `predev`/`prebuild` as-is; only append the `&& node …` part. Add the two `pretauri:*` keys next to the existing `tauri:dev`/`tauri:build`.)

- [ ] **Step 3: Apply the default (hollow) to the live locations**

```bash
node scripts/select-icon-variant.mjs
```
Expected: prints `[icon-variant] applied "hollow" icon set …`.

- [ ] **Step 4: Verify the live icons are now the hollow set**

```bash
git status --short apps/fluux/src-tauri/icons apps/fluux/public | grep -c '^ M'
magick apps/fluux/public/icon-512.png -crop 260x120+120+300 /tmp/live-junction.png
```
Expected: many modified PNG/ICO/ICNS files (live swapped plain → hollow). Open `/tmp/live-junction.png` — a white outline bubble, no glass fill.

- [ ] **Step 5: Sanity-check `plain` still selectable, then restore hollow**

```bash
VITE_FLUUX_ICON_STYLE=plain node scripts/select-icon-variant.mjs
magick apps/fluux/public/icon-512.png -crop 260x120+120+300 /tmp/live-plain.png   # glass bubble, no seam
node scripts/select-icon-variant.mjs                                              # back to hollow default
```
Expected: `/tmp/live-plain.png` shows the seam-free glass bubble; the final command restores hollow. Leave the tree on hollow.

- [ ] **Step 6: Commit**

```bash
git add scripts/select-icon-variant.mjs package.json apps/fluux/src-tauri/icons apps/fluux/public
git commit -m "feat(build): icon-variant selection hook; default the live icons to hollow"
```

---

### Task 6: Live-vs-default drift guard + full verification

**Files:**
- Test: `apps/fluux/src/components/brand/iconVariantLiveDefault.test.ts`

**Interfaces:**
- Consumes: committed live icons (git HEAD) + `icon-variants/hollow/dist` (Task 5).

- [ ] **Step 1: Write the drift-guard test**

Create `apps/fluux/src/components/brand/iconVariantLiveDefault.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

// The committed live icons (git HEAD) must equal the hollow variant's dist, so
// the shipped default can't silently drift from its source. Reads live bytes
// from git HEAD (not the working tree), so a local `plain` build does not trip
// this. hollow/dist is read from disk (it equals HEAD when committed).
const APP = process.cwd() // apps/fluux
const REPO = resolve(APP, '../..')
const HOLLOW_DIST = resolve(APP, 'src-tauri/icons/icon-variants/hollow/dist')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('committed live icon default matches hollow/dist', () => {
  for (const kind of ['icons', 'public'] as const) {
    const base = join(HOLLOW_DIST, kind)
    for (const abs of walk(base)) {
      const rel = relative(base, abs)
      const repoRel =
        kind === 'icons'
          ? join('apps/fluux/src-tauri/icons', rel)
          : join('apps/fluux/public', rel)
      it(`live ${repoRel} == hollow/dist`, () => {
        const committed = execFileSync('git', ['show', `HEAD:${repoRel.split('\\').join('/')}`], {
          cwd: REPO,
          maxBuffer: 200 * 1024 * 1024,
        })
        expect(committed.equals(readFileSync(abs))).toBe(true)
      })
    }
  }
})
```

- [ ] **Step 2: Run the guard test**

Run: `cd apps/fluux && npx vitest run src/components/brand/iconVariantLiveDefault.test.ts`
Expected: PASS — every live icon matches the committed hollow dist.

- [ ] **Step 3: Commit the guard**

```bash
git add apps/fluux/src/components/brand/iconVariantLiveDefault.test.ts
git commit -m "test(icons): guard committed live default == hollow dist"
```

- [ ] **Step 4: Full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: all pass, no stderr.

- [ ] **Step 5: Typecheck + lint**

Run: `cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/dazzling-murdock-782b10 && npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Verify live in demo — hollow default, then plain**

```bash
# hollow (default)
npm run dev   # predev runs the selection hook
```
Open `http://localhost:5173/` (the app shows the login screen while disconnected) — the login mark is the hollow outline bubble; the browser-tab favicon is the outline. Stop, then:

```bash
VITE_FLUUX_ICON_STYLE=plain npm run dev
```
Login mark + favicon are the glass bubble. Stop and re-run `node scripts/select-icon-variant.mjs` to leave the tree on hollow.

(Use the preview tooling for screenshots; confirm no console errors.)

---

## Self-Review

**Spec coverage:**
- Env var + two mechanisms → Tasks 2 (login), 5 (assets). ✅
- `HollowIconMark` + shared glyph SoT (pinned path) → Task 1. ✅
- Hollow SVG sources (squircle + maskable, bloom/sheen tile, robust shadow) → Task 3. ✅
- Variant tree layout + `generate.sh` refactor → Task 4. ✅
- Selection script + hook wiring + hollow default → Task 5. ✅
- Glyph-parity guard + live-vs-default guard + login-selection tests → Tasks 3, 6, 2. ✅
- Branch/PR (stacks on seam fix, separate PR) → handled at execution handoff. ✅
- Gradient unchanged, canvas constants, pinned path, robust shadow → Global Constraints. ✅

**Placeholder scan:** none — every step has exact paths, full code, and commands.

**Type consistency:** `MESSAGE_BUBBLE_PATH` / `GLYPH_TRANSFORM` / `GLYPH_STROKE_WIDTH` / `GLYPH_SHADOW` defined in Task 1 and consumed identically in Tasks 1/3/6; class names `hollow-icon-mark` / `app-icon-mark` consistent across Tasks 1, 2; `VITE_FLUUX_ICON_STYLE` value set `{plain, hollow}` consistent across Tasks 2, 5.
