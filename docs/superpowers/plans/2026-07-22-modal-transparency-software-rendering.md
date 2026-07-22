# Modal Transparency on Machines That Cannot Blur — Implementation Plan

> **Outcome (added post-merge-review, 2026-07-22):** Tasks 1-3 below (the
> renderer classifier, the WebGL probe, and its wiring into
> `resolveTransparency`) were implemented and then **reverted before merge** —
> the probe was empirically disproven. See the "Outcome" section at the top
> of the [spec](../specs/2026-07-22-modal-transparency-software-rendering-design.md#outcome-added-post-merge-review-2026-07-22)
> for the full reasoning. Task 4 (the backdrop-root restructure) and Task 5's
> non-probe verification shipped as planned. Task bodies below are left
> unmodified as historical record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop modal panels from being see-through on machines whose compositor silently refuses to paint `backdrop-filter`, and repair the backdrop-root nesting that has prevented the glass panel's own frost from ever painting on any platform.

**Architecture:** A pure renderer-string classifier plus a memoized WebGL probe detect software rasterisation. The verdict feeds the existing `resolveTransparency` seam in the same slot as the OS `prefers-reduced-transparency` query, so the existing `[data-transparency="reduced"]` CSS flattens glass with no new selectors. Separately, `ModalOverlay` and `BottomSheet` split their scrim element away from their layout element so the `.fluux-glass` panel is no longer a descendant of a Backdrop Root.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest + @testing-library/react (jsdom), Tailwind, Tauri.

**Spec:** [docs/superpowers/specs/2026-07-22-modal-transparency-software-rendering-design.md](../specs/2026-07-22-modal-transparency-software-rendering-design.md) (commit `9c273349`)

## Global Constraints

- **No CSS changes.** `apps/fluux/src/index.css` must not be modified by any task. The `[data-transparency="reduced"]` rules and the `.fluux-glass` tiers already do everything needed.
- **The liquid tier keeps its current values:** 40% dark / 34% light. macOS must look unchanged.
- **Linux behaviour is unchanged.** The `:root[data-platform="linux"]` gate from #884 stays exactly as it is. Linux is a tracked follow-up, not part of this work.
- **An unknown renderer counts as hardware.** No WebGL context, a missing `WEBGL_debug_renderer_info` extension, or a masked string must never flatten glass.
- **The probe decides in `'system'` mode only.** An explicit `'full'` in Accessibility must still yield `'full'` even when the probe reports software.
- Commit messages: conventional-commit style, **no Claude footer**.
- Commits are SSH-signed. If signing fails, run `ssh-add` first; do not silently skip signing.
- Before each commit: the task's tests pass with no stderr noise, and `npm run typecheck` and `npm run lint` are clean.

---

### Task 1: Pure renderer classifier

Classifies a WebGL renderer string as software / hardware / unknown. Pure and table-driven so it is testable in CI with no GPU.

**Files:**
- Create: `apps/fluux/src/themes/softwareRendering.ts`
- Test: `apps/fluux/src/themes/softwareRendering.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type RendererClass = 'software' | 'hardware' | 'unknown'` and `export function classifyRenderer(renderer: string | null | undefined): RendererClass`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/themes/softwareRendering.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyRenderer } from './softwareRendering'

describe('classifyRenderer', () => {
  it('identifies Chromium/WebView2 software GL (SwiftShader)', () => {
    expect(
      classifyRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'),
    ).toBe('software')
  })

  it('identifies the Microsoft Basic Render Driver', () => {
    expect(
      classifyRenderer('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    ).toBe('software')
  })

  it('identifies Mesa software rasterisers', () => {
    expect(classifyRenderer('llvmpipe (LLVM 15.0.6, 256 bits)')).toBe('software')
    expect(classifyRenderer('softpipe')).toBe('software')
    expect(classifyRenderer('lavapipe (LLVM 15.0.6)')).toBe('software')
    expect(classifyRenderer('Mesa swrast')).toBe('software')
  })

  it('identifies Direct3D WARP', () => {
    expect(classifyRenderer('Microsoft Direct3D WARP device')).toBe('software')
  })

  it('is case-insensitive', () => {
    expect(classifyRenderer('LLVMPIPE (LLVM 15.0.6)')).toBe('software')
  })

  it('treats a real GPU as hardware', () => {
    expect(classifyRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)')).toBe('hardware')
    expect(
      classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    ).toBe('hardware')
    expect(classifyRenderer('Mesa Intel(R) UHD Graphics 620 (KBL GT2)')).toBe('hardware')
  })

  it('treats an absent or empty string as unknown, never as software', () => {
    expect(classifyRenderer(null)).toBe('unknown')
    expect(classifyRenderer(undefined)).toBe('unknown')
    expect(classifyRenderer('')).toBe('unknown')
  })

  it('does not match "warp" inside an unrelated word', () => {
    expect(classifyRenderer('Warpdrive Graphics Accelerator 9000')).toBe('hardware')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/themes/softwareRendering.test.ts`
Expected: FAIL — `Failed to resolve import "./softwareRendering"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/fluux/src/themes/softwareRendering.ts`:

```ts
/**
 * Software-rendering probe.
 *
 * Why this exists: `@supports (backdrop-filter: blur(1px))` reports a
 * CAPABILITY, never a rendering guarantee. WebKitGTK (#884) and WebView2 on a
 * software-rendered Windows box both advertise backdrop-filter and then paint it
 * as a no-op. The translucency still lands, so a glass panel degrades into a
 * plain see-through hole and modal text becomes unreadable.
 *
 * There is no way to ask the page whether a backdrop-filter actually painted —
 * composited output cannot be read back from the document. The GPU renderer
 * string is a proxy: software rasterisers identify themselves by name, and when
 * one is active backdrop-filter will not composite usefully.
 */

export type RendererClass = 'software' | 'hardware' | 'unknown'

/**
 * Markers that identify a software rasteriser. Matched case-insensitively
 * against the unmasked WebGL renderer string. `warp` is word-anchored because it
 * is short enough to appear inside unrelated product names.
 */
const SOFTWARE_PATTERNS: readonly RegExp[] = [
  /swiftshader/, // Chromium / WebView2 software GL
  /llvmpipe/, // Mesa software rasteriser
  /softpipe/, // Mesa, older
  /lavapipe/, // Mesa software Vulkan
  /swrast/, // Mesa software raster
  /\bwarp\b/, // Direct3D WARP
  /basic render driver/, // "Microsoft Basic Render Driver"
  /apple software renderer/,
  /software rasterizer/,
]

/**
 * Classify a WebGL `UNMASKED_RENDERER_WEBGL` string.
 *
 * Returns 'unknown' for an absent or empty string — the caller MUST treat that
 * as hardware. Browsers legitimately mask the renderer for fingerprinting
 * reasons, and flattening glass for all of them would be a far worse regression
 * than leaving it on for a rare software-rendered machine.
 */
export function classifyRenderer(renderer: string | null | undefined): RendererClass {
  if (!renderer) return 'unknown'
  const value = renderer.toLowerCase()
  return SOFTWARE_PATTERNS.some((pattern) => pattern.test(value)) ? 'software' : 'hardware'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/themes/softwareRendering.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Deliberate-break check**

Hollow tests are this codebase's recurring defect, and only a deliberate break catches them.

1. In `softwareRendering.ts`, change `if (!renderer) return 'unknown'` to `if (!renderer) return 'software'`.
2. Run: `cd apps/fluux && npx vitest run src/themes/softwareRendering.test.ts`
3. Expected: **FAIL** on "treats an absent or empty string as unknown".
4. Revert the change.
5. Re-run. Expected: PASS.

Repeat with `/\bwarp\b/` → `/warp/`; expected FAIL on the "Warpdrive" case, then revert and confirm green.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/themes/softwareRendering.ts apps/fluux/src/themes/softwareRendering.test.ts
git commit -m "feat(glass): classify WebGL renderer strings as software or hardware"
```

---

### Task 2: The WebGL probe

Reads the renderer string from a throwaway WebGL context and memoizes the verdict.

**Files:**
- Modify: `apps/fluux/src/themes/softwareRendering.ts` (append)
- Test: `apps/fluux/src/themes/softwareRendering.test.ts` (append)

**Interfaces:**
- Consumes: `classifyRenderer` from Task 1.
- Produces: `export function readRendererString(): string | null`, `export function detectSoftwareRendering(): boolean`, `export function resetSoftwareRenderingProbe(): void`.

jsdom has no WebGL, so `getContext` returns `null` there — the tests stub `HTMLCanvasElement.prototype.getContext`. `readRendererString` is exported unmemoized precisely so it can be tested without cache interference; `detectSoftwareRendering` wraps it with the memo.

- [ ] **Step 1: Write the failing test**

Append to `apps/fluux/src/themes/softwareRendering.test.ts` (and extend the import on line 2 to `import { classifyRenderer, detectSoftwareRendering, readRendererString, resetSoftwareRenderingProbe } from './softwareRendering'`):

```ts
// --- probe ---------------------------------------------------------------
// jsdom has no WebGL; these tests stub the canvas context entirely.

const UNMASKED_RENDERER = 0x9246

function stubWebGL(renderer: string | null, opts: { extension?: boolean } = {}) {
  const lose = { loseContext: vi.fn() }
  const gl = {
    getExtension: vi.fn((name: string) => {
      if (name === 'WEBGL_lose_context') return lose
      if (name === 'WEBGL_debug_renderer_info') {
        return opts.extension === false ? null : { UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }
      }
      return null
    }),
    getParameter: vi.fn((p: number) => (p === UNMASKED_RENDERER ? renderer : null)),
  }
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(gl as unknown as RenderingContext)
  return { gl, lose, spy }
}

describe('readRendererString', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetSoftwareRenderingProbe()
  })

  it('returns the unmasked renderer string', () => {
    stubWebGL('llvmpipe (LLVM 15.0.6, 256 bits)')
    expect(readRendererString()).toBe('llvmpipe (LLVM 15.0.6, 256 bits)')
  })

  it('returns null when the debug-renderer extension is unavailable', () => {
    stubWebGL('llvmpipe', { extension: false })
    expect(readRendererString()).toBeNull()
  })

  it('returns null when no WebGL context can be created', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(readRendererString()).toBeNull()
  })

  it('releases the throwaway context instead of leaking it', () => {
    const { lose } = stubWebGL('llvmpipe')
    readRendererString()
    expect(lose.loseContext).toHaveBeenCalledTimes(1)
  })

  it('survives a throwing getContext', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('context creation blocked')
    })
    expect(readRendererString()).toBeNull()
  })
})

describe('detectSoftwareRendering', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetSoftwareRenderingProbe()
  })

  it('is true for a software rasteriser', () => {
    stubWebGL('llvmpipe (LLVM 15.0.6, 256 bits)')
    expect(detectSoftwareRendering()).toBe(true)
  })

  it('is false for a real GPU', () => {
    stubWebGL('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)')
    expect(detectSoftwareRendering()).toBe(false)
  })

  it('is false when the renderer cannot be determined', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(detectSoftwareRendering()).toBe(false)
  })

  it('probes the GPU only once per session', () => {
    const { spy } = stubWebGL('llvmpipe')
    detectSoftwareRendering()
    detectSoftwareRendering()
    detectSoftwareRendering()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
```

Also extend the vitest import on line 1 to `import { describe, it, expect, afterEach, vi } from 'vitest'`, and add `// @vitest-environment jsdom` as the very first line of the file (the probe needs `document` and `HTMLCanvasElement`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/themes/softwareRendering.test.ts`
Expected: FAIL — `readRendererString is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/fluux/src/themes/softwareRendering.ts`:

```ts
/**
 * Read the unmasked WebGL renderer string, or null when it cannot be
 * determined. Creates a throwaway context and releases it immediately — this
 * context is never drawn to and must not hold GPU resources.
 *
 * Unmemoized on purpose: `detectSoftwareRendering` owns the cache, and keeping
 * the read separate is what makes it testable without cache interference.
 */
export function readRendererString(): string | null {
  if (typeof document === 'undefined') return null
  let gl: WebGLRenderingContext | null = null
  try {
    const canvas = document.createElement('canvas')
    gl = (canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl) return null
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) return null
    const value = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    return typeof value === 'string' ? value : null
  } catch {
    // A blocked or unavailable WebGL implementation is a legitimate outcome, not
    // an error worth surfacing: it resolves to 'unknown' and glass stays on.
    return null
  } finally {
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      // Best effort — the context is garbage either way.
    }
  }
}

let cachedVerdict: boolean | undefined

/**
 * True when the compositor rasterises in software, meaning backdrop-filter will
 * not paint. Probes the GPU once per session and memoizes; the answer cannot
 * change while the page is alive.
 */
export function detectSoftwareRendering(): boolean {
  if (cachedVerdict === undefined) {
    cachedVerdict = classifyRenderer(readRendererString()) === 'software'
  }
  return cachedVerdict
}

/** Test-only: clear the memoized verdict so each test probes afresh. */
export function resetSoftwareRenderingProbe(): void {
  cachedVerdict = undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/themes/softwareRendering.test.ts`
Expected: PASS — 17 tests, no stderr output.

- [ ] **Step 5: Deliberate-break check**

1. Change `return typeof value === 'string' ? value : null` to `return value as string`.
   Run the file. Expected: **FAIL** on "returns null when the debug-renderer extension is unavailable" or a related null case. Revert; confirm green.
2. Remove the `if (cachedVerdict === undefined)` guard so it probes every call.
   Run. Expected: **FAIL** on "probes the GPU only once per session". Revert; confirm green.
3. Change the `catch` in `readRendererString` to rethrow.
   Run. Expected: **FAIL** on "survives a throwing getContext". Revert; confirm green.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/themes/softwareRendering.ts apps/fluux/src/themes/softwareRendering.test.ts
git commit -m "feat(glass): probe the GPU renderer for software rasterisation"
```

---

### Task 3: Wire the probe into transparency resolution

Adds the probe verdict to `resolveTransparency` and passes it from `useTheme`. Done as one task because the new parameter is required — splitting it would leave the tree failing typecheck between commits.

**Files:**
- Modify: `apps/fluux/src/themes/transparency.ts:11-21`
- Modify: `apps/fluux/src/themes/transparency.test.ts` (all 4 existing cases need the new field)
- Modify: `apps/fluux/src/hooks/useTheme.ts:349-357`
- Test: `apps/fluux/src/hooks/useTheme.transparency.test.tsx` (create)

**Interfaces:**
- Consumes: `detectSoftwareRendering` from Task 2.
- Produces: `resolveTransparency` gains a required `compositorCannotBlur: boolean` field in its options object. Signature becomes:
  `resolveTransparency(opts: { themeWantsReduced: boolean; transparencyMode: TransparencyMode; systemReducedMatches: boolean; compositorCannotBlur: boolean }): ResolvedTransparency`

- [ ] **Step 1: Write the failing tests**

Append to `apps/fluux/src/themes/transparency.test.ts`:

```ts
describe('resolveTransparency (software-rendering probe)', () => {
  it('flattens glass in system mode when the compositor cannot blur', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'system',
        systemReducedMatches: false,
        compositorCannotBlur: true,
      }),
    ).toBe('reduced')
  })

  it('leaves glass on in system mode when the compositor can blur', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'system',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('full')
  })

  it('lets an explicit full override the probe (escape hatch for false positives)', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'full',
        systemReducedMatches: false,
        compositorCannotBlur: true,
      }),
    ).toBe('full')
  })

  it('still flattens on an explicit reduced regardless of the probe', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'reduced',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('reduced')
  })

  it('a theme forcing reduced still wins over everything', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: true,
        transparencyMode: 'full',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('reduced')
  })
})
```

Then add `compositorCannotBlur: false` to each of the **four** existing `resolveTransparency({ … })` calls in that file (lines 7, 13, 16, 22, 25, 31 — six call sites across four tests).

Create `apps/fluux/src/hooks/useTheme.transparency.test.tsx` to prove the hook is actually wired to the probe:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'

vi.mock('@/themes/softwareRendering', () => ({
  detectSoftwareRendering: vi.fn(() => true),
}))

import { useTheme } from './useTheme'
import { detectSoftwareRendering } from '@/themes/softwareRendering'
import { useSettingsStore } from '@/stores/settingsStore'

afterEach(cleanup)

beforeEach(() => {
  useSettingsStore.getState().setTransparencyMode('system')
  vi.mocked(detectSoftwareRendering).mockReturnValue(true)
})

describe('useTheme transparency wiring', () => {
  it('flattens glass when the probe reports software rendering', () => {
    renderHook(() => useTheme())
    expect(document.documentElement.getAttribute('data-transparency')).toBe('reduced')
  })

  it('leaves glass on when the probe reports a real GPU', () => {
    vi.mocked(detectSoftwareRendering).mockReturnValue(false)
    renderHook(() => useTheme())
    expect(document.documentElement.getAttribute('data-transparency')).toBe('full')
  })

  it('honours an explicit full preference over the probe', () => {
    useSettingsStore.getState().setTransparencyMode('full')
    renderHook(() => useTheme())
    expect(document.documentElement.getAttribute('data-transparency')).toBe('full')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/themes/transparency.test.ts src/hooks/useTheme.transparency.test.tsx`
Expected: FAIL — the transparency cases fail on the unknown `compositorCannotBlur` property being ignored (`'full'` returned where `'reduced'` expected), and the useTheme cases fail because nothing passes the probe verdict in.

- [ ] **Step 3: Write the implementation**

In `apps/fluux/src/themes/transparency.ts`, replace the `resolveTransparency` function with:

```ts
/**
 * Resolve the effective transparency for the current theme + user setting.
 *
 * Reduced-wins: a theme may FORCE reduced transparency (the "Pure" theme does,
 * so its glass surfaces render solid), but a theme can never force `full` over a
 * user or OS `reduced` preference. When the theme is neutral, the user's own
 * setting decides ('system' consults the OS query and the GPU probe).
 */
export function resolveTransparency(opts: {
  themeWantsReduced: boolean
  transparencyMode: TransparencyMode
  systemReducedMatches: boolean
  /**
   * True when the GPU probe found a software rasteriser, so backdrop-filter will
   * not paint and glass would degrade into a bare see-through hole.
   *
   * Deliberately weighted exactly like the OS prefers-reduced-transparency
   * signal rather than like a theme's forced-reduced: it decides in 'system'
   * mode only. The probe reads a renderer STRING, which is a proxy and can be
   * wrong — an explicit 'full' must stay available as an escape hatch.
   */
  compositorCannotBlur: boolean
}): ResolvedTransparency {
  if (opts.themeWantsReduced) return 'reduced'
  if (opts.transparencyMode === 'reduced') return 'reduced'
  if (opts.transparencyMode === 'full') return 'full'
  return opts.systemReducedMatches || opts.compositorCannotBlur ? 'reduced' : 'full'
}
```

In `apps/fluux/src/hooks/useTheme.ts`, add the import next to the existing transparency import (line 5):

```ts
import { detectSoftwareRendering } from '@/themes/softwareRendering'
```

and replace the body of the transparency effect (lines 349-357) so it reads:

```ts
  useEffect(() => {
    const themeWantsReduced = getActiveTheme()?.transparency === 'reduced'
    // Memoized after the first call; the GPU cannot change under a live page.
    const compositorCannotBlur = detectSoftwareRendering()
    const resolve = () =>
      resolveTransparency({
        themeWantsReduced,
        transparencyMode,
        systemReducedMatches: window.matchMedia('(prefers-reduced-transparency: reduce)').matches,
        compositorCannotBlur,
      })
    document.documentElement.setAttribute('data-transparency', resolve())
```

Leave the rest of the effect (the `matchMedia` subscription and cleanup) untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/themes/transparency.test.ts src/hooks/useTheme.transparency.test.tsx`
Expected: PASS — 9 transparency cases, 3 useTheme cases.

- [ ] **Step 5: Deliberate-break check**

1. In `useTheme.ts`, change `compositorCannotBlur` to the literal `false`.
   Run: `cd apps/fluux && npx vitest run src/hooks/useTheme.transparency.test.tsx`
   Expected: **FAIL** on "flattens glass when the probe reports software rendering". This is the check that matters most — it proves the hook test is not hollow and really exercises the wiring. Revert; confirm green.
2. In `transparency.ts`, move `compositorCannotBlur` above the `transparencyMode === 'full'` check so the probe wins absolutely.
   Run: `cd apps/fluux && npx vitest run src/themes/transparency.test.ts`
   Expected: **FAIL** on "lets an explicit full override the probe". Revert; confirm green.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/themes/transparency.ts apps/fluux/src/themes/transparency.test.ts apps/fluux/src/hooks/useTheme.ts apps/fluux/src/hooks/useTheme.transparency.test.tsx
git commit -m "feat(glass): flatten glass when the compositor rasterises in software"
```

---

### Task 4: Escape the scrim's backdrop root

Splits layout from frost in both modal primitives so the `.fluux-glass` panel stops being a descendant of an element carrying `backdrop-filter`.

**Files:**
- Modify: `apps/fluux/src/components/ModalOverlay.tsx:126-149`
- Modify: `apps/fluux/src/components/ui/BottomSheet.tsx:55-73`
- Test: `apps/fluux/src/components/ModalOverlay.backdroproot.test.tsx` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks — independent of Tasks 1-3.
- Produces: no API change. Both components keep their exact props and public behaviour; only the DOM nesting changes.

This test file is a `.test.tsx`, which `modalGlass.test.ts` excludes from its source-literal walk, so referencing `modal-scrim` / `fluux-glass` here does not trip that guard.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/ModalOverlay.backdroproot.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ModalOverlay } from './ModalOverlay'
import { BottomSheet } from './ui/BottomSheet'

afterEach(cleanup)

/**
 * An element with `backdrop-filter` forms a Backdrop Root: a descendant's own
 * backdrop-filter then samples only content inside that root, so the
 * descendant's frost is silently discarded. `.modal-scrim` carries a
 * backdrop-filter, so the `.fluux-glass` panel must never be nested inside it.
 *
 * This failure mode is invisible — nothing throws, no style is dropped, the
 * frost simply stops painting — which is exactly why it survived unnoticed and
 * why it needs a structural guard rather than a visual review.
 */
function expectPanelOutsideScrim(root: ParentNode) {
  const scrim = root.querySelector('.modal-scrim')
  const panel = root.querySelector('.fluux-glass')
  expect(scrim, 'no .modal-scrim element rendered').not.toBeNull()
  expect(panel, 'no .fluux-glass panel rendered').not.toBeNull()
  expect(
    scrim!.contains(panel!),
    'the .fluux-glass panel is nested inside .modal-scrim, so its backdrop-filter will be discarded',
  ).toBe(false)
}

describe('glass panel escapes the scrim backdrop root', () => {
  it('ModalOverlay renders the panel as a sibling of the scrim', () => {
    const { container } = render(
      <ModalOverlay onClose={vi.fn()}>
        <button>ok</button>
      </ModalOverlay>,
    )
    expectPanelOutsideScrim(container)
  })

  it('BottomSheet renders the panel as a sibling of the scrim', () => {
    render(
      <BottomSheet open onClose={vi.fn()} ariaLabel="actions">
        <button>ok</button>
      </BottomSheet>,
    )
    // BottomSheet portals to document.body, so query from there.
    expectPanelOutsideScrim(document.body)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/ModalOverlay.backdroproot.test.tsx`
Expected: **FAIL** — both cases, with "the .fluux-glass panel is nested inside .modal-scrim…". This failure is the bug being reproduced; confirm you see it before fixing.

- [ ] **Step 3: Fix ModalOverlay**

In `apps/fluux/src/components/ModalOverlay.tsx`, replace the returned JSX (lines 126-149) with:

```tsx
  return (
    <div
      data-modal="true"
      className={`fixed inset-0 flex ${ALIGN_CLASS[align]} justify-center z-50`}
    >
      {/* The scrim is a SIBLING of the panel, never its ancestor. An element
          with backdrop-filter forms a Backdrop Root, and a panel nested inside
          one has its own backdrop-filter silently discarded — the frost simply
          never paints. Keeping layout on the wrapper and frost on this layer is
          what lets the panel's blur sample the real app. The scrim also owns the
          fade now, so its transient opacity < 1 cannot form a backdrop root over
          the panel either. Guarded by ModalOverlay.backdroproot.test.tsx. */}
      <div aria-hidden="true" className={`absolute inset-0 modal-scrim ${scrimClass}`}>
        <div className="modal-scrim-aurora" />
      </div>
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        disabled={!dismissable}
        onClick={close}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={panelRef}
        {...panelProps}
        onKeyDown={onPanelKeyDown ? (e) => onPanelKeyDown(e, { close }) : undefined}
        className={`relative z-10 fluux-glass rounded-lg w-full ${width} mx-4 ${panelClass} ${panelClassName ?? ''}`}
      >
        {typeof children === 'function' ? children({ close }) : children}
      </div>
    </div>
  )
```

Also update the component's doc comment (line 71) from:

```
 * - the `.modal-scrim` backdrop (frost + scrim behind the panel),
```

to:

```
 * - the `.modal-scrim` backdrop (frost + scrim), rendered as a SIBLING layer so
 *   the panel escapes its backdrop root,
```

- [ ] **Step 4: Fix BottomSheet**

In `apps/fluux/src/components/ui/BottomSheet.tsx`, replace the opening of the portal (lines 55-59) so the scrim becomes its own layer:

```tsx
  return createPortal(
    <div data-modal="true" className="fixed inset-0 flex items-end justify-center z-50">
      {/* Sibling scrim — see ModalOverlay: a panel nested inside a
          backdrop-filter element loses its own frost. */}
      <div aria-hidden="true" className="absolute inset-0 modal-scrim" />
      <button
```

The rest of the component (the dismiss button, the panel, the grab handle, the title) is unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/ModalOverlay.backdroproot.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 6: Run the neighbouring modal tests for regressions**

The restructure moves the fade class and changes DOM nesting, so re-run everything that touches modal chrome:

Run: `cd apps/fluux && npx vitest run src/components/ModalOverlay.focustrap.test.tsx src/components/ModalShell.test.tsx src/components/modalGlass.test.ts src/components/VerifyPeerDialog.test.tsx`
Expected: PASS, all four files. The focus trap in particular must still work — the panel is still `panelRef`, but it now has a different parent.

- [ ] **Step 7: Deliberate-break check**

1. In `ModalOverlay.tsx`, move the panel `<div>` back inside the scrim `<div>`.
   Run: `cd apps/fluux && npx vitest run src/components/ModalOverlay.backdroproot.test.tsx`
   Expected: **FAIL** on the ModalOverlay case. Revert; confirm green.
2. Do the same in `BottomSheet.tsx`.
   Expected: **FAIL** on the BottomSheet case. Revert; confirm green.

Without this check the assertion could be passing merely because a selector found nothing — the `not.toBeNull()` guards exist for that reason, but only the break proves it.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/ModalOverlay.tsx apps/fluux/src/components/ui/BottomSheet.tsx apps/fluux/src/components/ModalOverlay.backdroproot.test.tsx
git commit -m "fix(glass): render the modal panel outside the scrim's backdrop root"
```

---

### Task 5: Full verification and the Windows gate

**Files:** none modified — this task only runs and reports.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a go/no-go on merging.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS across all workspaces, with no stderr noise. Per project convention stderr output is treated as a failure, not cosmetic.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. No SDK rebuild is needed — no SDK types changed.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Confirm no CSS drifted in**

Run: `git diff main --stat -- apps/fluux/src/index.css`
Expected: **empty output.** A non-empty diff means a global constraint was violated; stop and investigate.

- [ ] **Step 5: Verify macOS looks unchanged**

Run the app and open any modal (e.g. the quick-chat dialog), comparing against `main`:

```bash
npm run dev
```

Open `http://localhost:5173/demo.html`, open a modal, and confirm the panel reads the same weight as before the change. The spec's measurement predicted no perceptible difference, because the scrim's blur already destroys the backdrop before the panel samples it. A visibly heavier panel is not a failure, but it IS a finding to report back rather than wave through.

Also toggle Accessibility → transparency between Auto / Full / Reduced and confirm all three still behave.

- [ ] **Step 6: THE GATE — verify the probe fires on the Windows machine**

**This is the one step that decides whether the work actually solves the reported problem.** It cannot be run from macOS, and it must not be skipped or assumed.

On the Windows box that produced the original screenshots, run the built app and check the resolved renderer and attribute:

```js
document.documentElement.getAttribute('data-transparency')
```

Expected: `"reduced"`, and modals render opaque.

If it reports `"full"`, the probe did not fire — WebView2 is reporting a plausible hardware renderer while still refusing to composite `backdrop-filter`. In that case:

- **Do not merge as-is.** The Windows complaint is unfixed.
- Capture the actual renderer string and report it — it may simply need adding to `SOFTWARE_PATTERNS`. `readRendererString` is a module-scoped export and is not reachable from a production console, so read it directly with this self-contained snippet:

```js
(() => {
  const gl = document.createElement('canvas').getContext('webgl')
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable'
})()
```

- If the string names a genuine GPU, fall back to the spec's documented alternative: gate Windows onto the flat tier the way Linux is gated, and revise the spec.

- [ ] **Step 7: Report**

Summarise for the maintainer: which tests were added, the deliberate-break results, the macOS visual comparison, and — explicitly — the Windows gate outcome with the renderer string observed. Do not describe the work as complete before Step 6 has an answer.

---

## Follow-ups (not in this plan)

- Verify on a current Linux build whether modals still read as too transparent; the #884 revert should already make them solid.
- Once there is evidence about what WebKitGTK reports as its renderer, consider whether the probe can replace the hardcoded `data-platform="linux"` CSS gate.
