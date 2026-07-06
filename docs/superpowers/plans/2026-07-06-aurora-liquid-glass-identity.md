# Aurora Liquid-Glass Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic login brand mark with the G2 liquid-glass aurora bubble, and apply the "aurora is the light, glass is the material" identity to the header hairline, the send button, and the modal glass tier.

**Architecture:** All-CSS/SVG, token-driven. New `--fluux-aurora-*` foundation tokens in `index.css` (dark = night palette, light = muted-dawn D2) feed a declarative `AuroraMark` SVG component, a header hairline pseudo-element, a state-dependent glass send button, and an upgraded `.fluux-glass` tier. No SDK changes; app workspace only. Deterministic visuals (seeded PRNG for stars); motion is CSS keyframes gated by the existing `[data-motion="reduced"]` attribute; glass gated by the existing `[data-transparency="reduced"]` attribute plus a new `data-platform` attribute (Linux keeps the current lighter frost).

**Tech Stack:** React 18 + TypeScript, Tailwind + raw CSS in `apps/fluux/src/index.css`, Vitest (happy-dom for components, node fs-parsing for CSS guards).

**Spec:** `docs/superpowers/specs/2026-07-06-aurora-login-mark-design.md` — layer recipes in spec §3 are the visual source of truth.

## Global Constraints

- Aurora tokens (dark): `--fluux-aurora-1..4` = `#2FE0C0 / #4FB6E8 / #7C8CFF / #A78BFA`; rim quartet equals these in dark mode.
- Aurora tokens (light, muted dawn D2): `#E8C29A / #DE94AE / #9D8CE8 / #6FA0DC`; rim quartet (light) = `#C08A52 / #C06A88 / #7862D8 / #4A82C6`.
- Ink token: `--fluux-aurora-ink: #08111F` (both modes).
- Bubble path constant (exact, do not retune):
  `M 100 18 C 145 18 178 45 178 82 C 178 119 145 145 100 145 C 89 145 78.5 143 69.5 139.5 C 58 149 44 154.5 30 155 C 38.5 145.5 43.5 135.5 44.8 126.5 C 32 116 24 100 24 82 C 24 45 55 18 100 18 Z`
- Gradient stop offsets: `0 / 0.45 / 0.72 / 1` (uneven — first hue dominates).
- Motion: opacity-only CSS keyframes, ~12s alternate cycle, staggered; disabled under `[data-motion="reduced"]`.
- Glass gates: `[data-transparency="reduced"]` → solid/opaque; `:root[data-platform="linux"]` keeps the existing (non-liquid) frost.
- No new i18n keys (mark is decorative; send button keeps `t('chat.send', 'Send')`).
- This worktree has no local `node_modules`; binaries resolve by directory walk-up to the main repo's `node_modules` — run all commands from inside the worktree as written and this just works.
- Run app tests per-workspace: `cd apps/fluux && npx vitest run <file>` (never bare `vitest` from root).
- Commits: use `git -c commit.gpgsign=false commit` (signing agent unavailable this session; maintainer approved unsigned commits). Never add a Claude footer.
- Before the final commit of the branch: full app test suite, `npm run typecheck`, `npm run lint` must pass.

---

### Task 1: Aurora identity tokens + contrast guard

**Files:**
- Modify: `apps/fluux/src/index.css` (dark `:root` "Aurora identity additions" block ~line 133; `.light` "Aurora identity (light)" block ~line 499)
- Test (create): `apps/fluux/src/themes/auroraTokens.test.ts`

**Interfaces:**
- Produces: CSS custom properties `--fluux-aurora-1..4`, `--fluux-aurora-rim-1..4`, `--fluux-aurora-ink` resolvable in both `:root` and `.light` scopes. All later tasks consume these via `var()`.

- [ ] **Step 1: Write the failing guard test**

Create `apps/fluux/src/themes/auroraTokens.test.ts`. It follows the same fs-parsing pattern as `glass.test.ts` (same directory — read that file's helpers for reference, but this test is self-contained):

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

/**
 * Aurora identity token guard.
 *
 * The aurora quartet feeds the login mark, the horizon hairline, and the send
 * button. Two invariants:
 *  a. all aurora tokens exist in both modes (dark :root + .light overrides for
 *     the base and rim quartets; ink is mode-stable),
 *  b. the ink icon clears WCAG 3:1 (UI component floor) on EVERY stop of the
 *     reduced-transparency send-button fallback gradient, in both modes,
 *  c. a white icon clears 3:1 on the dark-mode glass send button worst case
 *     (stop at 50% strength over the composer surface, under 10% white glass).
 */

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../index.css')
const css = readFileSync(cssPath, 'utf8')

function block(selector: string): Record<string, string> {
  const re = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`)
  const body = css.match(re)?.[1] ?? ''
  const map: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map[m[1]] = m[2].trim()
  return map
}
const dark = block(':root')
const light = { ...dark, ...block('.light') }

type RGB = [number, number, number]
function hex(v: string): RGB {
  const h = v.trim().slice(1)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function lum([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))) as RGB
}

const QUARTET = [1, 2, 3, 4].map((i) => `--fluux-aurora-${i}`)
const RIM = [1, 2, 3, 4].map((i) => `--fluux-aurora-rim-${i}`)

describe('aurora identity tokens', () => {
  it('base + rim quartets and ink exist in both modes', () => {
    for (const t of [...QUARTET, ...RIM, '--fluux-aurora-ink']) {
      expect(dark[t], `${t} missing in :root`).toBeDefined()
      expect(light[t], `${t} missing in light resolution`).toBeDefined()
    }
    // light mode overrides the palette (muted dawn), so values must differ
    expect(light['--fluux-aurora-1']).not.toBe(dark['--fluux-aurora-1'])
    expect(light['--fluux-aurora-rim-1']).not.toBe(dark['--fluux-aurora-rim-1'])
  })

  it('ink clears 3:1 on every solid-fallback gradient stop, both modes', () => {
    for (const [name, vars] of [['dark', dark], ['light', light]] as const) {
      const ink = hex(vars['--fluux-aurora-ink'])
      for (const t of QUARTET) {
        const ratio = contrast(ink, hex(vars[t]))
        expect(ratio, `${name} ink on ${t} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('white icon clears 3:1 on the dark glass send-button worst case', () => {
    const composer = hex('#0D1428') // dark composer surface (--fluux-base-05 family)
    const white: RGB = [255, 255, 255]
    for (const t of QUARTET) {
      // glow stop at 50% strength over the composer, then 10% white glass on top
      const backdrop = over(white, 0.1, over(hex(dark[t]), 0.5, composer))
      const ratio = contrast(white, backdrop)
      expect(ratio, `white on glass over ${t} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/themes/auroraTokens.test.ts`
Expected: FAIL — `--fluux-aurora-1 missing in :root`

- [ ] **Step 3: Add the tokens**

In `apps/fluux/src/index.css`, inside the dark `:root` block, directly under the line `--fluux-brand-glow-opacity: 0.35;` (~line 139), add:

```css
  /* Aurora light quartet — the identity light source (login mark backlight,
     horizon hairline, send-button glow). Dark = night aurora. The rim quartet
     equals the base in dark mode; light mode overrides it deeper so strokes
     hold contrast on pale surfaces (same one-hue-two-jobs split as
     --fluux-status-error / --fluux-text-error). */
  --fluux-aurora-1: #2FE0C0;
  --fluux-aurora-2: #4FB6E8;
  --fluux-aurora-3: #7C8CFF;
  --fluux-aurora-4: #A78BFA;
  --fluux-aurora-rim-1: #2FE0C0;
  --fluux-aurora-rim-2: #4FB6E8;
  --fluux-aurora-rim-3: #7C8CFF;
  --fluux-aurora-rim-4: #A78BFA;
  /* Ink for icons sitting on aurora-gradient fills (send-button fallback). */
  --fluux-aurora-ink: #08111F;
```

In the `.light` block, directly under `--fluux-brand-glow-opacity: 0.6;` (~line 507), add:

```css
  /* Aurora light quartet (light) — muted dawn (D2): champagne whisper at the
     tail, violet leads. The gold-heavy dawn was rejected as not subtle enough. */
  --fluux-aurora-1: #E8C29A;
  --fluux-aurora-2: #DE94AE;
  --fluux-aurora-3: #9D8CE8;
  --fluux-aurora-4: #6FA0DC;
  --fluux-aurora-rim-1: #C08A52;
  --fluux-aurora-rim-2: #C06A88;
  --fluux-aurora-rim-3: #7862D8;
  --fluux-aurora-rim-4: #4A82C6;
```

(`--fluux-aurora-ink` is mode-stable — dark ink works on both the night and dawn gradients — so it is NOT overridden in `.light`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/themes/auroraTokens.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/themes/auroraTokens.test.ts
git -c commit.gpgsign=false commit -m "feat(theme): aurora identity token quartets (night / muted-dawn) with contrast guard"
```

---

### Task 2: Seeded star-field helper

**Files:**
- Create: `apps/fluux/src/components/brand/auroraSeed.ts`
- Test (create): `apps/fluux/src/components/brand/auroraSeed.test.ts`

**Interfaces:**
- Produces:
  - `mulberry32(seed: number): () => number` — deterministic PRNG in [0,1)
  - `starField(seed: number, count: number, region: { x: number; y: number; w: number; h: number }): Star[]` where `Star = { cx: number; cy: number; r: number; opacity: number }`
- Task 3 consumes `starField(31, 8, { x: 56, y: 44, w: 150, h: 110 })`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/brand/auroraSeed.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mulberry32, starField } from './auroraSeed'

describe('mulberry32', () => {
  it('is deterministic for a fixed seed', () => {
    const a = mulberry32(31)
    const b = mulberry32(31)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('yields values in [0, 1)', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 100; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('starField', () => {
  const region = { x: 56, y: 44, w: 150, h: 110 }

  it('is deterministic for a fixed seed', () => {
    expect(starField(31, 8, region)).toEqual(starField(31, 8, region))
  })

  it('produces count stars within the region and spec ranges', () => {
    const stars = starField(31, 8, region)
    expect(stars).toHaveLength(8)
    for (const s of stars) {
      expect(s.cx).toBeGreaterThanOrEqual(region.x)
      expect(s.cx).toBeLessThanOrEqual(region.x + region.w)
      expect(s.cy).toBeGreaterThanOrEqual(region.y)
      // stars sit in the upper 75% of the region (below feels like floor dust)
      expect(s.cy).toBeLessThanOrEqual(region.y + region.h * 0.75)
      expect(s.r).toBeGreaterThanOrEqual(0.5)
      expect(s.r).toBeLessThanOrEqual(1.3)
      expect(s.opacity).toBeGreaterThanOrEqual(0.2)
      expect(s.opacity).toBeLessThanOrEqual(0.75)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/brand/auroraSeed.test.ts`
Expected: FAIL — cannot resolve `./auroraSeed`

- [ ] **Step 3: Implement**

Create `apps/fluux/src/components/brand/auroraSeed.ts`:

```typescript
/**
 * Deterministic pseudo-randomness for the Aurora brand mark.
 *
 * The mark must render identically on every launch (brand consistency, stable
 * tests, stable screenshots), so its "organic" star placement comes from a
 * seeded PRNG instead of Math.random().
 */

/** Mulberry32 — tiny, fast, good-enough distribution for visual seeding. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Star {
  cx: number
  cy: number
  r: number
  opacity: number
}

/**
 * Seeded star field inside `region` (SVG user units). Stars stay in the upper
 * 75% of the region and within the radius/opacity ranges from the mark spec.
 */
export function starField(
  seed: number,
  count: number,
  region: { x: number; y: number; w: number; h: number },
): Star[] {
  const rand = mulberry32(seed)
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    stars.push({
      cx: Math.round((region.x + rand() * region.w) * 10) / 10,
      cy: Math.round((region.y + rand() * region.h * 0.75) * 10) / 10,
      r: Math.round((0.5 + rand() * 0.8) * 100) / 100,
      opacity: Math.round((0.2 + rand() * 0.55) * 100) / 100,
    })
  }
  return stars
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/brand/auroraSeed.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/brand/auroraSeed.ts apps/fluux/src/components/brand/auroraSeed.test.ts
git -c commit.gpgsign=false commit -m "feat(brand): seeded deterministic star field for the aurora mark"
```

---

### Task 3: AuroraMark component + mark CSS (mode toggling, motion)

**Files:**
- Create: `apps/fluux/src/components/brand/AuroraMark.tsx`
- Modify: `apps/fluux/src/index.css` (append a new "Aurora brand mark" section after the modal-motion keyframes block, i.e. after the `.scrim-out` rule ~line 1320)
- Test (create): `apps/fluux/src/components/brand/AuroraMark.test.tsx`

**Interfaces:**
- Consumes: `starField` from Task 2; `--fluux-aurora-*` tokens from Task 1.
- Produces: `<AuroraMark size?: number className?: string />` — decorative SVG, `aria-hidden="true"`, root class `aurora-mark`. Task 4 consumes it in `LoginScreen`.

- [ ] **Step 1: Write the failing component test**

Create `apps/fluux/src/components/brand/AuroraMark.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AuroraMark } from './AuroraMark'

describe('AuroraMark', () => {
  it('renders a decorative aria-hidden svg with the aurora-mark class', () => {
    const { container } = render(<AuroraMark />)
    const svg = container.querySelector('svg.aurora-mark')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders all five layers of the G2 recipe', () => {
    const { container } = render(<AuroraMark />)
    expect(container.querySelectorAll('.aurora-mark-backlight ellipse')).toHaveLength(3)
    expect(container.querySelector('.aurora-mark-pane')).not.toBeNull()
    expect(container.querySelectorAll('.aurora-mark-lens ellipse')).toHaveLength(3)
    expect(container.querySelector('.aurora-mark-rim-glow')).not.toBeNull()
    expect(container.querySelector('.aurora-mark-rim')).not.toBeNull()
    expect(container.querySelector('.aurora-mark-hairline-dark')).not.toBeNull()
    expect(container.querySelector('.aurora-mark-hairline-light')).not.toBeNull()
  })

  it('renders the deterministic 8-star field (dark-mode layer)', () => {
    const { container } = render(<AuroraMark />)
    expect(container.querySelectorAll('.aurora-mark-stars circle')).toHaveLength(8)
    // determinism: two renders agree on the first star position
    const { container: c2 } = render(<AuroraMark />)
    expect(container.querySelector('.aurora-mark-stars circle')!.getAttribute('cx')).toBe(
      c2.querySelector('.aurora-mark-stars circle')!.getAttribute('cx'),
    )
  })

  it('respects the size prop', () => {
    const { container } = render(<AuroraMark size={100} />)
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('100')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/brand/AuroraMark.test.tsx`
Expected: FAIL — cannot resolve `./AuroraMark`

- [ ] **Step 3: Implement the component**

Create `apps/fluux/src/components/brand/AuroraMark.tsx`. The geometry constants are the validated prototype values (spec §3) — do not retune them:

```tsx
import { useId } from 'react'
import { starField } from './auroraSeed'

/**
 * Aurora brand mark (login screen): a hand-drawn speech-bubble silhouette
 * rendered as a liquid-glass pane, backlit by the aurora (G2 finish).
 * Spec: docs/superpowers/specs/2026-07-06-aurora-login-mark-design.md §3.
 *
 * Layer stack (bottom → top): backlight blobs → pane (fill + lensing copies +
 * stars + sheen + grain) → aurora rim (glow + crisp) → specular hairline.
 * Colors come from the --fluux-aurora-* tokens, so the night/dawn split and
 * any theme overrides apply without touching this file. Mode-specific layers
 * (stars, night fill vs paper wash, white vs ink hairline, drop shadow) are
 * all rendered and toggled via CSS under `.light` — the component itself is
 * mode-agnostic. Motion is pure CSS (see "Aurora brand mark" in index.css).
 */

const BUBBLE =
  'M 100 18 C 145 18 178 45 178 82 C 178 119 145 145 100 145 ' +
  'C 89 145 78.5 143 69.5 139.5 C 58 149 44 154.5 30 155 ' +
  'C 38.5 145.5 43.5 135.5 44.8 126.5 C 32 116 24 100 24 82 ' +
  'C 24 45 55 18 100 18 Z'
const TX = 'translate(32,30)'

/** Backlight blob geometry (viewBox space) — stop 1 low-left, 3 mid, 4 upper-right. */
const BLOBS = [
  { cx: 95, cy: 165, rx: 55, ry: 42, token: 1, opacity: 0.42 },
  { cx: 150, cy: 115, rx: 50, ry: 42, token: 3, opacity: 0.38 },
  { cx: 185, cy: 65, rx: 48, ry: 40, token: 4, opacity: 0.4 },
] as const

const STARS = starField(31, 8, { x: 56, y: 44, w: 150, h: 110 })

const RIM_STOPS = [
  { offset: 0, token: 1 },
  { offset: 0.45, token: 2 },
  { offset: 0.72, token: 3 },
  { offset: 1, token: 4 },
] as const

interface AuroraMarkProps {
  /** Rendered width in px (viewBox is 264×240; height scales proportionally). */
  size?: number
  className?: string
}

export function AuroraMark({ size = 150, className }: AuroraMarkProps) {
  const uid = useId().replace(/:/g, '')
  const id = (s: string) => `am-${uid}-${s}`
  const height = Math.round((size * 240) / 264)

  return (
    <svg
      className={`aurora-mark ${className ?? ''}`}
      width={size}
      height={height}
      viewBox="0 0 264 240"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id('rim')} gradientUnits="userSpaceOnUse" x1="76" y1="185" x2="210" y2="48">
          {RIM_STOPS.map((s) => (
            <stop key={s.offset} offset={s.offset} style={{ stopColor: `var(--fluux-aurora-rim-${s.token})` }} />
          ))}
        </linearGradient>
        <linearGradient id={id('sheen')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.1" />
          <stop offset="0.4" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id('spec')} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.05" />
        </linearGradient>
        <linearGradient id={id('pane-light')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.72" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.42" />
        </linearGradient>
        <clipPath id={id('clip')}>
          <path d={BUBBLE} transform={TX} />
        </clipPath>
        <filter id={id('blur-big')} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
        <filter id={id('blur-lens')} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="11" />
        </filter>
        <filter id={id('blur-glow')} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter id={id('blur-shadow')} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <filter id={id('grain')}>
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>

      {/* light-mode drop shadow — depth comes from shadow, not glow, on pale bg */}
      <ellipse
        className="aurora-mark-shadow aurora-light-only"
        cx="132" cy="196" rx="78" ry="14"
        fill="#2A3554" opacity="0.14" filter={`url(#${id('blur-shadow')})`}
      />

      <g className="aurora-mark-backlight">
        {BLOBS.map((b, i) => (
          <ellipse
            key={b.token}
            className={`aurora-breathe-${i + 1}`}
            cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry}
            style={{ fill: `var(--fluux-aurora-${b.token})` }}
            opacity={b.opacity}
            filter={`url(#${id('blur-big')})`}
          />
        ))}
      </g>

      <g clipPath={`url(#${id('clip')})`}>
        <rect className="aurora-mark-pane aurora-dark-only" x="40" y="30" width="200" height="185" fill="#0A1124" opacity="0.42" />
        <path className="aurora-mark-pane aurora-light-only" d={BUBBLE} transform={TX} fill={`url(#${id('pane-light')})`} />
        <g className="aurora-mark-lens">
          {BLOBS.map((b) => (
            <ellipse
              key={b.token}
              cx={b.cx + 7} cy={b.cy + 4} rx={b.rx} ry={b.ry}
              style={{ fill: `var(--fluux-aurora-${b.token})` }}
              opacity={b.opacity * 0.9}
              filter={`url(#${id('blur-lens')})`}
            />
          ))}
        </g>
        <g className="aurora-mark-stars aurora-dark-only">
          {STARS.map((s, i) => (
            <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill="#C7D2FE" opacity={s.opacity} />
          ))}
        </g>
        <path d={BUBBLE} transform={TX} fill={`url(#${id('sheen')})`} />
        <rect
          x="40" y="30" width="200" height="185"
          filter={`url(#${id('grain')})`} opacity="0.1"
          style={{ mixBlendMode: 'soft-light' }}
        />
      </g>

      <path
        className="aurora-mark-rim-glow"
        d={BUBBLE} transform={TX} fill="none"
        stroke={`url(#${id('rim')})`} strokeWidth="8" strokeLinejoin="round"
        filter={`url(#${id('blur-glow')})`}
      />
      <path
        className="aurora-mark-rim"
        d={BUBBLE} transform={TX} fill="none"
        stroke={`url(#${id('rim')})`} strokeWidth="2.4" strokeLinejoin="round" opacity="0.95"
      />
      <path
        className="aurora-mark-hairline-dark aurora-dark-only"
        d={BUBBLE} transform={TX} fill="none"
        stroke={`url(#${id('spec')})`} strokeWidth="1" strokeLinejoin="round" opacity="0.5"
      />
      <path
        className="aurora-mark-hairline-light aurora-light-only"
        d={BUBBLE} transform={TX} fill="none"
        stroke="rgba(30,42,70,0.30)" strokeWidth="0.8" strokeLinejoin="round"
      />
    </svg>
  )
}
```

- [ ] **Step 4: Add the mark CSS (mode toggling + motion)**

In `apps/fluux/src/index.css`, append after the `.scrim-out` rule (end of the modal-motion block, ~line 1320):

```css
/* ── Aurora brand mark (login) ─────────────────────────────────────────────
   Mode-specific layers are all rendered by AuroraMark.tsx and toggled here,
   so the component stays mode-agnostic. Motion is compositor-only opacity on
   the three backlight blobs + rim glow ("the aurora slowly shifting behind
   the glass"); [data-motion="reduced"] stills it — the static mark is the
   complete design, not a degraded one. */
.aurora-mark .aurora-light-only { display: none; }
.light .aurora-mark .aurora-light-only { display: initial; }
.light .aurora-mark .aurora-dark-only { display: none; }

@keyframes aurora-backlight-breathe { from { opacity: 1; } to { opacity: 0.7; } }
@keyframes aurora-rim-breathe { from { opacity: 0.35; } to { opacity: 0.28; } }

.aurora-mark .aurora-breathe-1,
.aurora-mark .aurora-breathe-2,
.aurora-mark .aurora-breathe-3 {
  animation: aurora-backlight-breathe 12s ease-in-out infinite alternate;
}
.aurora-mark .aurora-breathe-2 { animation-delay: -4s; }
.aurora-mark .aurora-breathe-3 { animation-delay: -8s; }
.aurora-mark .aurora-mark-rim-glow {
  opacity: 0.35;
  animation: aurora-rim-breathe 12s ease-in-out infinite alternate;
}
[data-motion="reduced"] .aurora-mark .aurora-breathe-1,
[data-motion="reduced"] .aurora-mark .aurora-breathe-2,
[data-motion="reduced"] .aurora-mark .aurora-breathe-3,
[data-motion="reduced"] .aurora-mark .aurora-mark-rim-glow {
  animation: none;
}
```

(Negative `animation-delay` values start each blob mid-cycle so the three phases are staggered from the first frame.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/brand/AuroraMark.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/brand/AuroraMark.tsx apps/fluux/src/components/brand/AuroraMark.test.tsx apps/fluux/src/index.css
git -c commit.gpgsign=false commit -m "feat(brand): AuroraMark liquid-glass bubble with aurora rim and CSS breathing motion"
```

---

### Task 4: Login screen integration

**Files:**
- Modify: `apps/fluux/src/components/LoginScreen.tsx` (brand-mark block, lines 433–446; imports line ~1-20)
- Modify: `apps/fluux/src/components/LoginScreen.test.tsx` ("Aurora branding" describe, ~line 501)

**Interfaces:**
- Consumes: `AuroraMark` from Task 3.

- [ ] **Step 1: Extend the branding test (failing first)**

In `apps/fluux/src/components/LoginScreen.test.tsx`, replace the body of the test `'renders the Aurora gradient mark + display-font heading (no flat logo img)'` (~line 507) with:

```tsx
  it('renders the aurora glass mark + display-font heading (no flat logo img)', () => {
    render(<LoginScreen />)
    // display-font heading
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.className).toMatch(/font-display/)
    // the brand mark is the AuroraMark svg — no <img>, no legacy gradient tile
    expect(screen.queryByRole('img')).toBeNull()
    expect(document.querySelector('svg.aurora-mark')).not.toBeNull()
    expect(document.querySelector('[style*="--fluux-grad"]')).toBeNull()
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx -t "aurora glass mark"`
Expected: FAIL — `svg.aurora-mark` is null

- [ ] **Step 3: Swap the mark in LoginScreen**

In `apps/fluux/src/components/LoginScreen.tsx`, replace the brand-mark block (lines 433–446):

```tsx
          {/* Aurora gradient brand mark: the --fluux-grad tile + a soft glow */}
          <div className="relative size-16 mx-auto mb-4">
            <div
              className="absolute -inset-1.5 rounded-2xl blur-xl"
              style={{ background: 'var(--fluux-grad)', opacity: 'var(--fluux-brand-glow-opacity)' }}
              aria-hidden="true"
            />
            <div
              className="absolute inset-0 rounded-2xl flex items-center justify-center"
              style={{ background: 'var(--fluux-grad)' }}
            >
              <MessageCircle className="size-8 text-white" aria-hidden="true" />
            </div>
          </div>
```

with:

```tsx
          {/* Aurora brand mark: liquid-glass bubble backlit by the aurora (G2).
              The svg's own glow bleeds beyond the layout box; -my compensates
              so the heading keeps its previous optical distance. */}
          <AuroraMark size={150} className="mx-auto -my-3" />
```

Add the import at the top of the file alongside the other component imports:

```tsx
import { AuroraMark } from './brand/AuroraMark'
```

Then check whether `MessageCircle` is still used elsewhere in the file (`grep -n "MessageCircle" apps/fluux/src/components/LoginScreen.tsx`). If this was the only use, remove `MessageCircle` from the lucide-react import list.

- [ ] **Step 4: Run the full LoginScreen suite**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx`
Expected: PASS (all tests — the swap must not break form/kebab/advanced-mode tests)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/LoginScreen.tsx apps/fluux/src/components/LoginScreen.test.tsx
git -c commit.gpgsign=false commit -m "feat(login): replace gradient tile + stock icon with the AuroraMark glass bubble"
```

---

### Task 5: Aurora horizon hairline under the conversation header

**Files:**
- Modify: `apps/fluux/src/components/ChatHeader.tsx:96` (header element className)
- Modify: `apps/fluux/src/index.css` (append to the "Aurora brand mark" section from Task 3)
- Modify: `apps/fluux/src/components/ChatHeader.test.tsx` (add one assertion)

**Interfaces:**
- Consumes: `--fluux-aurora-1..3` tokens from Task 1.

- [ ] **Step 1: Write the failing test**

In `apps/fluux/src/components/ChatHeader.test.tsx`, add inside the top-level describe (match the file's existing render helper usage — read the first test in the file and mirror its setup):

```tsx
  it('carries the aurora horizon hairline', () => {
    renderHeader() // use the file's existing render helper / default props
    const header = document.querySelector('header')
    expect(header).not.toBeNull()
    expect(header!.className).toContain('aurora-horizon')
    expect(header!.className).toContain('relative')
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/ChatHeader.test.tsx -t "aurora horizon"`
Expected: FAIL — className does not contain `aurora-horizon`

- [ ] **Step 3: Add the class and the CSS**

In `apps/fluux/src/components/ChatHeader.tsx:96`, change:

```tsx
    <header className="@container h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3" {...dragRegionProps}>
```

to:

```tsx
    <header className="@container relative aurora-horizon h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3" {...dragRegionProps}>
```

In `apps/fluux/src/index.css`, append to the Aurora section (after the `[data-motion="reduced"]` block from Task 3):

```css
/* Aurora horizon: a 1px identity hairline riding ON TOP of the header's
   standard divider (which stays underneath — the audit's seam-visibility
   guarantees are untouched). Fades at both ends; the tokens flip to the
   muted-dawn stops in light mode automatically. */
.aurora-horizon::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    transparent,
    var(--fluux-aurora-1) 12%,
    var(--fluux-aurora-2) 40%,
    var(--fluux-aurora-3) 70%,
    transparent
  );
  opacity: 0.65;
}
```

- [ ] **Step 4: Run the full ChatHeader suite**

Run: `cd apps/fluux && npx vitest run src/components/ChatHeader.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ChatHeader.tsx apps/fluux/src/components/ChatHeader.test.tsx apps/fluux/src/index.css
git -c commit.gpgsign=false commit -m "feat(chrome): aurora horizon hairline under the conversation header"
```

---

### Task 6: Glass send button (ready-state)

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx` (send button block, lines 999–1011)
- Modify: `apps/fluux/src/index.css` (append to the Aurora section)
- Modify: `apps/fluux/src/components/MessageComposer.test.tsx` (add a describe)

**Interfaces:**
- Consumes: `--fluux-aurora-1..4`, `--fluux-aurora-ink` tokens from Task 1.
- Produces: CSS classes `send-aurora` (button) and `send-aurora-glow` (glow element), used only here.

- [ ] **Step 1: Write the failing tests**

In `apps/fluux/src/components/MessageComposer.test.tsx`, add a describe (mirror the file's existing default-props render helper — read the first passing test for the exact setup, and reuse it):

```tsx
describe('MessageComposer — aurora send button', () => {
  it('is muted (no glass, no glow) while the input is empty', () => {
    renderComposer() // the file's existing render helper with default props
    const send = screen.getByRole('button', { name: 'chat.send' })
    expect(send).toBeDisabled()
    expect(send.className).toContain('send-aurora')
    expect(document.querySelector('.send-aurora-glow')).toBeNull()
  })

  it('lights up in aurora glass once there is content to send', async () => {
    renderComposer()
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    const send = screen.getByRole('button', { name: 'chat.send' })
    expect(send).not.toBeDisabled()
    expect(send.className).toContain('send-aurora')
    expect(document.querySelector('.send-aurora-glow')).not.toBeNull()
  })

  it('keeps the accessible name', () => {
    renderComposer()
    expect(screen.getByRole('button', { name: 'chat.send' })).toBeInTheDocument()
  })
})
```

Note: the mocked i18n in `test-setup.ts` returns keys verbatim, so the accessible name is the key `chat.send` (this is the file's existing convention — verify against how other tests in this file query the send button and match it).

Additionally, append a CSS guard to `apps/fluux/src/themes/auroraTokens.test.ts` (the reduced-transparency fallback is pure CSS — same markup — so it is guarded textually, like the glass gates):

```typescript
describe('send-button fallback CSS', () => {
  it('reduced transparency reverts the glass send button to the solid aurora fill', () => {
    expect(css).toMatch(/\[data-transparency="reduced"\]\s+\.send-aurora:not\(:disabled\)/)
    expect(css).toMatch(/\[data-transparency="reduced"\]\s+\.send-aurora-glow/)
  })
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "aurora send" && npx vitest run src/themes/auroraTokens.test.ts -t "fallback"`
Expected: FAIL — className does not contain `send-aurora`; fallback selector not found in css

- [ ] **Step 3: Rework the send button JSX**

In `apps/fluux/src/components/MessageComposer.tsx`, the send-ready condition is the negation of the existing disabled expression. Just above the button (inside the same JSX scope), the values `text`, `pendingAttachment`, `sending`, `disabled`, `sendDisabled` are already in scope. Replace lines 999–1011:

```tsx
        {/* Send button — filled accent. Encryption state is shown by the leading lock (not here). */}
        <button
          type="submit"
          disabled={(!text.trim() && !pendingAttachment) || sending || disabled || sendDisabled}
          aria-label={t('chat.send', 'Send')}
          className="group/send relative m-1 p-2.5 rounded-xl tap-target flex items-center justify-center
                     bg-fluux-brand text-white hover:bg-fluux-brand-hover
                     disabled:bg-transparent disabled:text-fluux-muted disabled:cursor-not-allowed
                     transition-colors [grid-area:send]"
        >
          <Send className="rtl-mirror icon-optical-send size-5" />
          {sendBadge}
        </button>
```

with:

```tsx
        {/* Send button — liquid glass lit by the aurora when a message is ready
            to send (identity tied to the brand action); muted while empty.
            Encryption state is shown by the leading lock (not here). */}
        <div className="relative m-1 flex [grid-area:send]">
          {!((!text.trim() && !pendingAttachment) || sending || disabled || sendDisabled) && (
            <span className="send-aurora-glow" aria-hidden="true" />
          )}
          <button
            type="submit"
            disabled={(!text.trim() && !pendingAttachment) || sending || disabled || sendDisabled}
            aria-label={t('chat.send', 'Send')}
            className="group/send send-aurora relative z-10 p-2.5 rounded-xl tap-target flex items-center justify-center
                       disabled:cursor-not-allowed transition-colors"
          >
            <Send className="rtl-mirror icon-optical-send size-5" />
            {sendBadge}
          </button>
        </div>
```

- [ ] **Step 4: Add the send-button CSS**

In `apps/fluux/src/index.css`, append to the Aurora section:

```css
/* Aurora send button: liquid glass over an aurora glow, only when a message is
   ready to send. Disabled = the previous muted icon. Reduced transparency (and
   thereby also the platforms where glass is off) falls back to the validated
   solid aurora fill with ink icon. */
.send-aurora {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
  -webkit-backdrop-filter: blur(9px) saturate(1.6);
  backdrop-filter: blur(9px) saturate(1.6);
  color: #ffffff;
}
.send-aurora:not(:disabled):hover {
  border-color: rgba(255, 255, 255, 0.45);
}
.light .send-aurora {
  background: rgba(255, 255, 255, 0.5);
  border-color: rgba(30, 42, 70, 0.18);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 2px 6px rgba(30, 42, 70, 0.1);
  color: var(--fluux-aurora-ink);
}
.light .send-aurora:not(:disabled):hover {
  border-color: rgba(30, 42, 70, 0.32);
}
.send-aurora:disabled {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  color: var(--fluux-text-muted);
}
.send-aurora-glow {
  position: absolute;
  inset: -12px;
  z-index: 0;
  border-radius: 9999px;
  pointer-events: none;
  filter: blur(10px);
  background:
    radial-gradient(50% 50% at 35% 65%, color-mix(in srgb, var(--fluux-aurora-1), transparent 25%), transparent 70%),
    radial-gradient(50% 50% at 70% 30%, color-mix(in srgb, var(--fluux-aurora-4), transparent 25%), transparent 70%);
}
[data-transparency="reduced"] .send-aurora:not(:disabled) {
  background: linear-gradient(130deg, var(--fluux-aurora-1), var(--fluux-aurora-2) 45%, var(--fluux-aurora-3) 75%, var(--fluux-aurora-4));
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  border-color: transparent;
  color: var(--fluux-aurora-ink);
}
[data-transparency="reduced"] .send-aurora-glow {
  display: none;
}
```

- [ ] **Step 5: Run the composer suite + fallback guard**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx src/themes/auroraTokens.test.ts`
Expected: PASS (all tests — existing send-button tests must survive; if any assert the old `bg-fluux-brand` class, update them to `send-aurora` with a comment referencing the spec)

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.test.tsx apps/fluux/src/index.css
git -c commit.gpgsign=false commit -m "feat(composer): liquid-glass aurora send button in the ready state"
```

---

### Task 7: Liquid-glass tier for modals + command palette

**Files:**
- Modify: `apps/fluux/src/hooks/useTheme.ts` (transparency effect area, ~line 327)
- Modify: `apps/fluux/src/index.css` (glass tokens ~line 140/510 and the `.fluux-glass` block ~lines 542–565)
- Modify: `apps/fluux/src/components/ModalOverlay.tsx` (scrim div, ~line 117)
- Modify: `apps/fluux/src/themes/glass.test.ts` (extend guard)

**Interfaces:**
- Consumes: `--fluux-aurora-1/3` from Task 1; `isLinux()` from `apps/fluux/src/utils/tauri.ts:16`.
- Produces: tokens `--fluux-glass-blur-strong`, `--fluux-glass-specular`, `--fluux-glass-specular-sheen`; `<html data-platform="linux"|"default">`; CSS class `modal-scrim-aurora`.

- [ ] **Step 1: Extend the glass guard (failing first)**

In `apps/fluux/src/themes/glass.test.ts`, add at the end of the file (it already has `css`, `cssRoot`, `cssLight` in scope):

```typescript
describe('liquid-glass tier', () => {
  it('defines the liquid tokens in both modes', () => {
    for (const t of ['--fluux-glass-blur-strong', '--fluux-glass-specular', '--fluux-glass-specular-sheen']) {
      expect(cssRoot[t], `${t} missing in :root`).toBeDefined()
      expect(cssLight[t], `${t} missing in light resolution`).toBeDefined()
    }
  })

  it('gates the liquid tier off on Linux and fully reverts under reduced transparency', () => {
    // Linux keeps the base frost: the liquid override must be scoped away from data-platform="linux"
    expect(css).toMatch(/:root:not\(\[data-platform="linux"\]\)\s+\.fluux-glass/)
    // the reduced-transparency revert must also clear the liquid additions
    const reduced = css.match(/\[data-transparency="reduced"\]\s+\.fluux-glass\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    expect(reduced).toContain('background-image: none')
    expect(reduced).toContain('backdrop-filter: none')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/fluux && npx vitest run src/themes/glass.test.ts -t "liquid"`
Expected: FAIL — `--fluux-glass-blur-strong missing in :root`

- [ ] **Step 3: Add tokens + platform attribute + CSS tier**

**Tokens.** In `apps/fluux/src/index.css` `:root`, directly under `--fluux-glass-blur: 12px;` (~line 140), add:

```css
  /* Liquid-glass tier (macOS/Windows/web only — Linux keeps the base frost). */
  --fluux-glass-blur-strong: 22px;
  --fluux-glass-specular: inset 0 1px 0 rgba(255, 255, 255, 0.22), inset 1px 0 0 rgba(255, 255, 255, 0.07), inset 0 -1px 0 rgba(255, 255, 255, 0.04);
  --fluux-glass-specular-sheen: linear-gradient(115deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0) 42%);
```

In the `.light` block, directly under `--fluux-glass-border: rgba(0, 0, 0, 0.12);` (~line 510), add:

```css
  --fluux-glass-specular: inset 0 1px 0 rgba(255, 255, 255, 0.9);
  --fluux-glass-specular-sheen: linear-gradient(115deg, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.1) 42%);
```

**Platform attribute.** In `apps/fluux/src/hooks/useTheme.ts`, next to the effect that applies `data-transparency` (~line 327), add a one-time effect (import `isLinux` from `@/utils/tauri`):

```typescript
  // Platform attribute for CSS gating: the liquid-glass tier is disabled on
  // Linux (WebKitGTK compositing is the known weak point — heavy
  // backdrop-filter caused the historical freeze class), which keeps the
  // lighter base frost there.
  useEffect(() => {
    document.documentElement.dataset.platform = isLinux() ? 'linux' : 'default'
  }, [])
```

**CSS tier.** In `apps/fluux/src/index.css`, inside the existing `@supports ((backdrop-filter: ...))` block that frosts `.fluux-glass` (~line 553), add after the existing `.fluux-glass` rule:

```css
    /* Liquid tier: deeper translucency + specular edges + diagonal sheen.
       Scoped away from Linux; reduced-transparency reverts below. */
    :root:not([data-platform="linux"]) .fluux-glass {
      background-color: color-mix(in srgb, var(--fluux-chat-bg), transparent 40%);
      background-image: var(--fluux-glass-specular-sheen);
      backdrop-filter: blur(var(--fluux-glass-blur-strong)) saturate(1.65);
      -webkit-backdrop-filter: blur(var(--fluux-glass-blur-strong)) saturate(1.65);
      box-shadow: var(--fluux-glass-specular), var(--fluux-shadow-overlay);
    }
    :root:not([data-platform="linux"]).light .fluux-glass {
      background-color: color-mix(in srgb, var(--fluux-chat-bg), transparent 34%);
    }
```

Extend the existing reduced-transparency revert (~line 560) — it currently resets `background-color` and the backdrop filters; it must now also clear the liquid additions. Replace:

```css
  [data-transparency="reduced"] .fluux-glass {
    background-color: var(--fluux-chat-bg);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
```

with:

```css
  [data-transparency="reduced"] .fluux-glass {
    background-color: var(--fluux-chat-bg);
    background-image: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    box-shadow: var(--fluux-shadow-overlay);
  }
```

**Scrim backlight.** In `apps/fluux/src/components/ModalOverlay.tsx`, inside the scrim div (line ~117, the element with `modal-scrim` in its className), add as its first child:

```tsx
      <div aria-hidden="true" className="modal-scrim-aurora" />
```

And append the CSS to the Aurora section of `index.css`:

```css
/* Aurora backlight in the modal scrim: gives the liquid glass something real
   to refract (this is what separates it from generic glassmorphism). Sits
   behind the opaque-ish panel, so panel text contrast is untouched. */
.modal-scrim-aurora {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(42% 38% at 68% 22%, color-mix(in srgb, var(--fluux-aurora-3), transparent 72%), transparent 70%),
    radial-gradient(40% 36% at 30% 78%, color-mix(in srgb, var(--fluux-aurora-1), transparent 74%), transparent 70%);
}
[data-transparency="reduced"] .modal-scrim-aurora {
  display: none;
}
```

- [ ] **Step 4: Run the glass + modal suites**

Run: `cd apps/fluux && npx vitest run src/themes/glass.test.ts src/components/modalGlass.test.ts src/components/ModalShell.test.tsx`
Expected: PASS (the `modalGlass.test.ts` literal-location guard still holds — `.modal-scrim-aurora` is a new literal, only in `ModalOverlay.tsx`)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/hooks/useTheme.ts apps/fluux/src/components/ModalOverlay.tsx apps/fluux/src/themes/glass.test.ts
git -c commit.gpgsign=false commit -m "feat(glass): liquid-glass tier with specular edges and aurora scrim backlight"
```

---

### Task 8: Full verification + visual check + screenshots

**Files:**
- No new source files. Regenerates: `screenshots/8x-login-aurora-dark.png`, `screenshots/8x-login-aurora-light.png`, `screenshots/43-glass-modal-aurora-dark.png`, `screenshots/43b-glass-modal-aurora-light.png` (and siblings the script rebuilds).

- [ ] **Step 1: Full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, zero stderr. Fix any straggler (most likely: an existing test asserting the old send-button classes or the old login mark markup — update it to the new classes with a spec reference).

- [ ] **Step 2: Typecheck + lint from the workspace root**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0. (Root typecheck is required — the dts build can pass while `tsc` fails.)

- [ ] **Step 3: Visual verification in demo mode**

Start the dev server and open the demo (`npm run dev`, then `http://localhost:5173/demo.html?tutorial=false`) via the preview tools. Verify and screenshot:
1. Log out / open `http://localhost:5173/` (login screen), dark mode: glass bubble mark with aurora rim, stars inside, breathing backlight (check `[data-motion="reduced"]` stills it via devtools attribute toggle).
2. Toggle light mode: muted-dawn palette (champagne whisper at the tail — NOT gold-dominant), ink hairline, drop shadow.
3. Demo chat: aurora horizon hairline under the conversation header (both modes).
4. Composer: type a message → send button lights up as glass over aurora glow; delete text → back to muted icon. Set `data-transparency="reduced"` on `<html>` → solid aurora fill with ink icon.
5. Open a modal (e.g. Settings → any modal): liquid glass with specular edge and the aurora tint in the scrim; with `data-transparency="reduced"` → opaque panel, no tint.
Clear `xmpp-chat-storage` + `fluux:activity-log` in localStorage first if the demo needs re-seeding.

- [ ] **Step 4: Regenerate screenshots**

Run: `npm run screenshots` (requires Playwright chromium — if missing: `npx playwright install chromium`)
Expected: script completes; `git status` shows updated login + glass-modal PNGs. Visually inspect `screenshots/8x-login-aurora-dark.png` and `8x-login-aurora-light.png` against the approved renders before committing.

- [ ] **Step 5: Final commit**

```bash
git add screenshots/
git -c commit.gpgsign=false commit -m "chore(screenshots): regenerate login and glass-modal shots for the aurora glass identity"
```

---

## Self-Review Notes

- **Spec coverage:** §3 mark layers → Task 3; §3 light adaptations → Tasks 1+3 (tokens + CSS-toggled layers); §4 tokens → Task 1; §5 motion → Task 3; §5b hairline → Task 5; §5b send button (incl. light physics flip + reduced fallback) → Task 6; §5c liquid tier + scrim backlight + gating → Task 7; §6 testing → each task + Task 8; §7 performance constraints → Tasks 3 (opacity-only animation) and 7 (Linux gate). §8 follow-ups intentionally unplanned.
- **Out of scope:** app icon (spec §8.1); THEMES.md authoring docs for the new tokens; spec §5c's "primary buttons on glass" bullet — the app has no shared primary-button class to scope that rule to (buttons compose Tailwind utilities inline), so styling them per-component would scatter one-off rules. Do it in a follow-up that first extracts a shared primary-button class, then applies the glass treatment in one place. All three noted for the follow-up PR.
- **Type consistency:** `starField` signature identical in Tasks 2 and 3; class names `aurora-mark*`, `send-aurora*`, `aurora-horizon`, `modal-scrim-aurora` used consistently between JSX tasks and CSS blocks.
