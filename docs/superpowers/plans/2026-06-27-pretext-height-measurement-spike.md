# Pretext Height-Measurement Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether the [`pretext`](https://github.com/chenglou/pretext) library can predict Fluux message-row text height accurately enough, across our three rendering engines, to become the message virtualizer's per-row size source.

**Architecture:** This is a measurement spike, not a feature. We build a disposable, additive harness (no production code paths touched): a corpus of representative message bodies, a pretext-based height predictor, a DOM measurement page that renders the *real* `MessageBody` component and reads actual rendered heights, and a pure comparison module that reports per-category error. We run it on Chromium (automated) plus the real Tauri engines (manual capture) and write a go / partial / no-go decision against a pre-stated accuracy threshold.

**Tech Stack:** `@chenglou/pretext` (the published npm name for Cheng Lou's text-measurement library; the bare `pretext` name on npm is an unrelated Markdown project — do not install it), Vite (standalone HTML entry, mirrors `apps/fluux/demo.html`), React 19, Tailwind, bundled `Inter` font, Playwright (Chromium automation, same dependency `npm run screenshots` already uses), Vitest (pure-module unit tests).

## Global Constraints

- Spike is **additive and disposable**: all new code lives under `apps/fluux/src/spikes/pretext/`, plus one root HTML entry `apps/fluux/pretext-spike.html` and one script `apps/fluux/scripts/`. **No edits to any production scroll/virtualization/message file.**
- Work happens on the current worktree branch (`claude/fervent-nightingale-b3aee1`); never commit to `main`.
- Run app Vitest from `apps/fluux` (the repo-root config lacks the `@` alias).
- Derive the font spec **live** from `getComputedStyle` of a rendered `MessageBody`, never hardcode font-size/line-height — pretext must measure with the exact spec the DOM uses.
- We use the bundled `Inter` / `Inter Tight` font, **not** `system-ui` — pretext's documented `system-ui`-on-macOS unreliability does not apply, but every measurement must wait for `document.fonts.ready` first.
- No user-facing strings are added; the harness reuses existing i18n (it renders real `MessageBody`, which calls `useTranslation`). If any label is shown in the harness UI, it is dev-only and must avoid em-dashes and en-dashes.
- Before each commit: relevant Vitest passes with no stderr, `npm run typecheck` passes, linter passes.

**Success criterion (the decision gate — adjustable by the maintainer before execution):**
Pretext predicts the **correct wrapped line count** for **≥ 98%** of non-code, non-media text messages, at all tested widths, **at every tested character scale** (root font-size %), **on every engine** (Chromium + macOS WKWebView + Linux WebKitGTK). Residual per-row height error from line-height rounding must be **≤ ±2px**. Code blocks, attachments/media, and emoji-heavy lines are measured and reported separately as explicitly out-of-pretext-scope; they do not count against this threshold but inform the "partial" verdict.

**Character scaling and density (decided 2026-06-27, from maintainer feedback):** The app has a character-scaling setting (`fontSize` %, applied as `document.documentElement.style.fontSize`) and a density setting (`data-density` = `comfortable` | `compact`). Character scaling changes the message text font-size/line-height AND rem-based chrome; density changes only chrome spacing/avatar, never text wrapping. Therefore: the measurement page validates text-height accuracy across a set of character scales (the predictor auto-adapts because it reads `getComputedStyle` live); density is NOT a text-axis. The message-row chrome delta is consequently a small matrix over (density × character-scale), captured manually in Task 7 — not a single constant.

---

### Task 1: Scaffold the spike and pin pretext's real API

**Files:**
- Modify: `apps/fluux/package.json` (add `@chenglou/pretext` dependency)
- Create: `apps/fluux/src/spikes/pretext/NOTES.md`
- Create: `apps/fluux/src/spikes/pretext/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a confirmed, written-down record of pretext's actual exported function names and parameter/return shapes in `NOTES.md`, referenced by Task 3.

- [ ] **Step 1: Install pretext into the app workspace**

Run:
```bash
cd apps/fluux && npm install @chenglou/pretext
```
Expected: `@chenglou/pretext` appears under `dependencies` in `apps/fluux/package.json`; root lockfile updates. (Do not install the bare `pretext` package — it is an unrelated Markdown library.)

- [ ] **Step 2: Record pretext's real API in NOTES.md**

Inspect the installed package's types and read its exports, then write the actual signatures down. The package is ESM-only (`"type": "module"`), main entry `./dist/layout.js` (types `./dist/layout.d.ts`), with a `@chenglou/pretext/rich-inline` subpath export. Run:
```bash
cd apps/fluux && cat node_modules/@chenglou/pretext/package.json | grep -E '"(main|module|types|exports)"' && find node_modules/@chenglou/pretext -name '*.d.ts' | head
```
Open the `.d.ts` file(s) and copy the exact signatures of `prepare` / `prepareWithSegments` / `layout` / `layoutWithLines` (names per the README) into `apps/fluux/src/spikes/pretext/NOTES.md` under a heading `## Confirmed pretext API`. Note in particular: how font (family/size/weight/style), `letter-spacing`, `line-height`, `white-space` mode (`normal` vs `pre-wrap`), and `tab-size` are passed; and whether `layout()` returns pixel height, line count, or both.

- [ ] **Step 3: Write a smoke test that proves pretext loads and measures**

Create `apps/fluux/src/spikes/pretext/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import * as pretext from '@chenglou/pretext'

describe('pretext smoke', () => {
  it('exposes a prepare and a layout function', () => {
    expect(typeof (pretext as Record<string, unknown>).prepare).toBe('function')
    expect(typeof (pretext as Record<string, unknown>).layout).toBe('function')
  })
})
```

- [ ] **Step 4: Run the smoke test**

Run:
```bash
cd apps/fluux && npx vitest run src/spikes/pretext/smoke.test.ts
```
Expected: PASS. If the export names differ from `prepare`/`layout`, update both the test and `NOTES.md` to the real names from Step 2 (this is the single point of adaptation for the new library), then re-run to green.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/package.json ../../package-lock.json apps/fluux/src/spikes/pretext/NOTES.md apps/fluux/src/spikes/pretext/smoke.test.ts
git commit -m "spike(pretext): scaffold + pin confirmed pretext API"
```

---

### Task 2: Build the representative message corpus

**Files:**
- Create: `apps/fluux/src/spikes/pretext/corpus.ts`
- Create: `apps/fluux/src/spikes/pretext/corpus.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type CorpusCategory = 'short' | 'wrap' | 'mention' | 'link' | 'emoji' | 'rtl' | 'me' | 'longtoken' | 'code' | 'mixed'` and `export interface CorpusItem { id: string; category: CorpusCategory; body: string }` and `export const CORPUS: readonly CorpusItem[]`.

- [ ] **Step 1: Write the failing corpus test**

Create `apps/fluux/src/spikes/pretext/corpus.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { CORPUS } from './corpus'

describe('pretext corpus', () => {
  it('covers every category with stable unique ids', () => {
    const cats = new Set(CORPUS.map((c) => c.category))
    for (const c of ['short', 'wrap', 'mention', 'link', 'emoji', 'rtl', 'me', 'longtoken', 'code', 'mixed']) {
      expect(cats.has(c as never)).toBe(true)
    }
    const ids = CORPUS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(CORPUS.length).toBeGreaterThanOrEqual(30)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/spikes/pretext/corpus.test.ts
```
Expected: FAIL with "Cannot find module './corpus'".

- [ ] **Step 3: Implement the corpus**

Create `apps/fluux/src/spikes/pretext/corpus.ts`. Include several items per category — single-word, exactly-one-line, just-over-one-line (the off-by-one-line boundary that drives the snap), multi-paragraph (`\n\n`), an in-line link, an `@mention`, ZWJ-emoji runs, an RTL Arabic/Hebrew sentence, a `/me` action, a 90-char unbreakable URL (`break-words` path), a fenced ` ```code``` ` block, and a mixed text+link+emoji item:
```ts
export type CorpusCategory =
  | 'short' | 'wrap' | 'mention' | 'link' | 'emoji' | 'rtl' | 'me' | 'longtoken' | 'code' | 'mixed'

export interface CorpusItem {
  id: string
  category: CorpusCategory
  body: string
}

export const CORPUS: readonly CorpusItem[] = [
  { id: 'short-1', category: 'short', body: 'ok' },
  { id: 'short-2', category: 'short', body: 'Sounds good, thanks!' },
  { id: 'short-3', category: 'short', body: 'See you at 3.' },
  { id: 'wrap-1', category: 'wrap', body: 'This is a fairly ordinary message that should wrap onto two lines at the medium content width we test against in this harness.' },
  { id: 'wrap-2', category: 'wrap', body: 'A longer paragraph used to exercise multi-line wrapping. '.repeat(6).trim() },
  { id: 'wrap-3', category: 'wrap', body: 'First paragraph.\n\nSecond paragraph after a blank line.\n\nThird one.' },
  { id: 'wrap-edge-1', category: 'wrap', body: 'Exactly enough characters to sit right on the one to two line boundary at medium width here now.' },
  { id: 'mention-1', category: 'mention', body: '@alice can you review the deploy when you get a sec?' },
  { id: 'mention-2', category: 'mention', body: 'cc @bob @carol this is the thread we discussed earlier in standup today.' },
  { id: 'link-1', category: 'link', body: 'Docs are here https://example.com/docs/getting-started take a look.' },
  { id: 'link-2', category: 'link', body: 'https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/even/further' },
  { id: 'emoji-1', category: 'emoji', body: 'nice work 🎉🚀✅' },
  { id: 'emoji-2', category: 'emoji', body: 'family 👨‍👩‍👧‍👦 flags 🇫🇷🇯🇵 and skin tones 👍🏽👋🏿' },
  { id: 'emoji-3', category: 'emoji', body: 'a longer emoji-heavy line 😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘 wrapping across lines' },
  { id: 'rtl-1', category: 'rtl', body: 'مرحبا، هذه رسالة عربية لاختبار قياس الارتفاع' },
  { id: 'rtl-2', category: 'rtl', body: 'שלום, זו הודעה בעברית לבדיקת מדידת הגובה של השורות' },
  { id: 'me-1', category: 'me', body: '/me waves hello to the room' },
  { id: 'me-2', category: 'me', body: '/me is reviewing a very long pull request that touches the scroll machinery again and again' },
  { id: 'longtoken-1', category: 'longtoken', body: 'see supercalifragilisticexpialidocioussupercalifragilisticexpialidocious now' },
  { id: 'longtoken-2', category: 'longtoken', body: 'https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { id: 'code-1', category: 'code', body: '```\nconst x = 1\nconst y = 2\n```' },
  { id: 'code-2', category: 'code', body: 'inline `code` in a sentence' },
  { id: 'code-3', category: 'code', body: '```ts\nfunction wide() { return "a very long single code line that may overflow horizontally inside the block" }\n```' },
  { id: 'mixed-1', category: 'mixed', body: '@dave check https://example.com 🎉 it works now after the fix' },
  { id: 'mixed-2', category: 'mixed', body: 'Multi-line with a link https://example.com/docs\nand a second line with @eve and emoji 🚀' },
  { id: 'short-4', category: 'short', body: 'yep' },
  { id: 'short-5', category: 'short', body: 'no problem at all' },
  { id: 'wrap-4', category: 'wrap', body: 'Another medium length message that lands somewhere around two or three lines depending on the column width being tested.' },
  { id: 'wrap-5', category: 'wrap', body: 'Padding message to grow the corpus past the minimum. '.repeat(4).trim() },
  { id: 'mention-3', category: 'mention', body: '@frank the build is green, merging now' },
  { id: 'link-3', category: 'link', body: 'two links https://a.example.com and https://b.example.com in one message' },
] as const
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/spikes/pretext/corpus.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/spikes/pretext/corpus.ts apps/fluux/src/spikes/pretext/corpus.test.ts
git commit -m "spike(pretext): representative message corpus"
```

---

### Task 3: Pretext text-height predictor

**Files:**
- Create: `apps/fluux/src/spikes/pretext/predictTextHeight.ts`
- Create: `apps/fluux/src/spikes/pretext/predictTextHeight.test.ts`

**Interfaces:**
- Consumes: pretext's confirmed API (`NOTES.md` from Task 1).
- Produces:
  - `export interface FontSpec { fontFamily: string; fontSizePx: number; fontWeight: number; fontStyle: string; lineHeightPx: number; letterSpacingPx: number; whiteSpace: 'normal' | 'pre-wrap' }`
  - `export interface Prediction { heightPx: number; lineCount: number }`
  - `export function predictTextHeight(body: string, contentWidthPx: number, font: FontSpec): Prediction`

- [ ] **Step 1: Write the failing predictor test**

Create `apps/fluux/src/spikes/pretext/predictTextHeight.test.ts`. These assert *properties* (pretext needs canvas, unavailable in jsdom, so guard with `typeof document` and skip the canvas-dependent body in Node — the real numeric validation happens in the browser harness, Task 5):
```ts
import { describe, it, expect } from 'vitest'
import { predictTextHeight, type FontSpec } from './predictTextHeight'

const FONT: FontSpec = {
  fontFamily: 'Inter, sans-serif',
  fontSizePx: 14,
  fontWeight: 400,
  fontStyle: 'normal',
  lineHeightPx: 14 * 1.375,
  letterSpacingPx: 0,
  whiteSpace: 'pre-wrap',
}

// pretext uses Canvas 2D measureText. jsdom exposes `document` but its canvas
// returns width 0, so gate on whether measureText actually returns a width.
// In the app's jsdom vitest these numeric cases SKIP; real numeric validation
// happens in the browser harness (Tasks 5 and 6).
function canvasMeasures(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const ctx = document.createElement('canvas').getContext('2d')
    return !!ctx && ctx.measureText('x').width > 0
  } catch {
    return false
  }
}
const canvasAvailable = canvasMeasures()

describe('predictTextHeight', () => {
  it.runIf(canvasAvailable)('returns >0 height and >=1 line for non-empty text', () => {
    const p = predictTextHeight('hello world', 560, FONT)
    expect(p.heightPx).toBeGreaterThan(0)
    expect(p.lineCount).toBeGreaterThanOrEqual(1)
  })

  it.runIf(canvasAvailable)('wraps to more lines at a narrower width', () => {
    const wide = predictTextHeight('the quick brown fox jumps over the lazy dog repeatedly', 700, FONT)
    const narrow = predictTextHeight('the quick brown fox jumps over the lazy dog repeatedly', 160, FONT)
    expect(narrow.lineCount).toBeGreaterThanOrEqual(wide.lineCount)
  })

  it('exports a callable predictor', () => {
    expect(typeof predictTextHeight).toBe('function')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/spikes/pretext/predictTextHeight.test.ts
```
Expected: FAIL with "Cannot find module './predictTextHeight'".

- [ ] **Step 3: Implement the predictor**

Create `apps/fluux/src/spikes/pretext/predictTextHeight.ts`. Uses the confirmed `@chenglou/pretext` API recorded in `NOTES.md`: `prepare(text, fontShorthand, { whiteSpace, letterSpacing })` then `layout(prepared, maxWidth, lineHeightPx)` which returns `{ lineCount, height }`. Pretext's `'pre-wrap'` mode preserves explicit newlines, so the whole body is measured in one call. Height is taken as `lineCount * lineHeightPx` so it matches the CSS `leading-[1.375]` line-box model exactly:
```ts
import { prepare, layout } from '@chenglou/pretext'

export interface FontSpec {
  fontFamily: string
  fontSizePx: number
  fontWeight: number
  fontStyle: string
  lineHeightPx: number
  letterSpacingPx: number
  whiteSpace: 'normal' | 'pre-wrap'
}

export interface Prediction {
  heightPx: number
  lineCount: number
}

/** Build a CSS `font` shorthand for pretext: "style weight size family". */
function toFontShorthand(font: FontSpec): string {
  return `${font.fontStyle} ${font.fontWeight} ${font.fontSizePx}px ${font.fontFamily}`
}

/**
 * Predict the wrapped height of a message body's TEXT, with no DOM reflow,
 * using @chenglou/pretext. 'pre-wrap' preserves explicit newlines so the whole
 * body is measured at once. Height = lineCount * lineHeightPx, mirroring the
 * CSS line-box model the real MessageBody renders with.
 *
 * Requires a working Canvas 2D (browser or jsdom-with-canvas). In a plain Node
 * run prepare() throws / measures 0; callers gate on canvas availability.
 */
export function predictTextHeight(body: string, contentWidthPx: number, font: FontSpec): Prediction {
  const prepared = prepare(body, toFontShorthand(font), {
    whiteSpace: font.whiteSpace,
    letterSpacing: font.letterSpacingPx,
  })
  const result = layout(prepared, contentWidthPx, font.lineHeightPx)
  const lineCount = Math.max(1, result.lineCount)
  return { heightPx: lineCount * font.lineHeightPx, lineCount }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/spikes/pretext/predictTextHeight.test.ts
```
Expected: PASS (the canvas-dependent cases auto-skip under Node via `it.runIf`; the export check passes). If pretext's return object uses different keys than `lineCount`/`height`, adapt per `NOTES.md` and re-run.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/spikes/pretext/predictTextHeight.ts apps/fluux/src/spikes/pretext/predictTextHeight.test.ts
git commit -m "spike(pretext): text-height predictor"
```

---

### Task 4: Pure comparison and reporting module

**Files:**
- Create: `apps/fluux/src/spikes/pretext/compareHeights.ts`
- Create: `apps/fluux/src/spikes/pretext/compareHeights.test.ts`

**Interfaces:**
- Consumes: `CorpusCategory` (Task 2).
- Produces:
  - `export interface Sample { id: string; category: CorpusCategory; widthPx: number; predicted: Prediction; measuredHeightPx: number; measuredLineCount: number }`
  - `export interface CategoryStat { count: number; lineExactPct: number; p95AbsErrPx: number; maxAbsErrPx: number; worstId: string }`
  - `export interface Report { generatedNote: string; byCategory: Record<string, CategoryStat>; overall: { textLineExactPct: number; passesThreshold: boolean }; worstOffenders: Sample[] }`
  - `export function buildReport(samples: Sample[], opts: { lineExactThresholdPct: number; heightTolPx: number; textCategories: CorpusCategory[] }): Report`

- [ ] **Step 1: Write the failing comparison test**

Create `apps/fluux/src/spikes/pretext/compareHeights.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildReport, type Sample } from './compareHeights'
import type { Prediction } from './predictTextHeight'

const pred = (h: number, lines: number): Prediction => ({ heightPx: h, lineCount: lines })

const samples: Sample[] = [
  { id: 'a', category: 'short', widthPx: 560, predicted: pred(20, 1), measuredHeightPx: 20, measuredLineCount: 1 },
  { id: 'b', category: 'wrap', widthPx: 560, predicted: pred(40, 2), measuredHeightPx: 41, measuredLineCount: 2 },
  { id: 'c', category: 'wrap', widthPx: 560, predicted: pred(40, 2), measuredHeightPx: 60, measuredLineCount: 3 }, // off by one line
  { id: 'd', category: 'code', widthPx: 560, predicted: pred(60, 3), measuredHeightPx: 120, measuredLineCount: 3 }, // out of scope
]

describe('buildReport', () => {
  it('computes per-category line-exactness and excludes non-text categories from the overall pass', () => {
    const r = buildReport(samples, { lineExactThresholdPct: 98, heightTolPx: 2, textCategories: ['short', 'wrap'] })
    expect(r.byCategory.short.lineExactPct).toBe(100)
    expect(r.byCategory.wrap.lineExactPct).toBe(50) // b exact, c off-by-line
    // overall text line-exact = 2 of 3 text samples = 66.7% -> below 98 -> fails
    expect(r.overall.textLineExactPct).toBeCloseTo(66.67, 1)
    expect(r.overall.passesThreshold).toBe(false)
    expect(r.byCategory.code).toBeDefined() // still reported, just not counted
  })

  it('passes when all text samples are line-exact within height tolerance', () => {
    const good: Sample[] = [
      { id: 'a', category: 'short', widthPx: 560, predicted: pred(20, 1), measuredHeightPx: 21, measuredLineCount: 1 },
      { id: 'b', category: 'wrap', widthPx: 560, predicted: pred(40, 2), measuredHeightPx: 40, measuredLineCount: 2 },
    ]
    const r = buildReport(good, { lineExactThresholdPct: 98, heightTolPx: 2, textCategories: ['short', 'wrap'] })
    expect(r.overall.passesThreshold).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/spikes/pretext/compareHeights.test.ts
```
Expected: FAIL with "Cannot find module './compareHeights'".

- [ ] **Step 3: Implement the comparison module**

Create `apps/fluux/src/spikes/pretext/compareHeights.ts`:
```ts
import type { CorpusCategory } from './corpus'
import type { Prediction } from './predictTextHeight'

export interface Sample {
  id: string
  category: CorpusCategory
  widthPx: number
  predicted: Prediction
  measuredHeightPx: number
  measuredLineCount: number
}

export interface CategoryStat {
  count: number
  lineExactPct: number
  p95AbsErrPx: number
  maxAbsErrPx: number
  worstId: string
}

export interface Report {
  generatedNote: string
  byCategory: Record<string, CategoryStat>
  overall: { textLineExactPct: number; passesThreshold: boolean }
  worstOffenders: Sample[]
}

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[idx]
}

export function buildReport(
  samples: Sample[],
  opts: { lineExactThresholdPct: number; heightTolPx: number; textCategories: CorpusCategory[] },
): Report {
  const byCategory: Record<string, CategoryStat> = {}
  const categories = [...new Set(samples.map((s) => s.category))]

  for (const cat of categories) {
    const inCat = samples.filter((s) => s.category === cat)
    const exact = inCat.filter((s) => s.predicted.lineCount === s.measuredLineCount)
    const absErrs = inCat.map((s) => Math.abs(s.predicted.heightPx - s.measuredHeightPx))
    let worstId = inCat[0]?.id ?? ''
    let worstErr = -1
    for (const s of inCat) {
      const e = Math.abs(s.predicted.heightPx - s.measuredHeightPx)
      if (e > worstErr) { worstErr = e; worstId = s.id }
    }
    byCategory[cat] = {
      count: inCat.length,
      lineExactPct: inCat.length ? (exact.length / inCat.length) * 100 : 0,
      p95AbsErrPx: p95(absErrs),
      maxAbsErrPx: Math.max(0, ...absErrs),
      worstId,
    }
  }

  const textSamples = samples.filter((s) => opts.textCategories.includes(s.category))
  const textExact = textSamples.filter(
    (s) => s.predicted.lineCount === s.measuredLineCount &&
      Math.abs(s.predicted.heightPx - s.measuredHeightPx) <= opts.heightTolPx,
  )
  const textLineExactPct = textSamples.length ? (textExact.length / textSamples.length) * 100 : 0

  const worstOffenders = [...samples]
    .sort((a, b) => Math.abs(b.predicted.heightPx - b.measuredHeightPx) - Math.abs(a.predicted.heightPx - a.measuredHeightPx))
    .slice(0, 10)

  return {
    generatedNote: 'pretext height spike report',
    byCategory,
    overall: { textLineExactPct, passesThreshold: textLineExactPct >= opts.lineExactThresholdPct },
    worstOffenders,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/spikes/pretext/compareHeights.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/spikes/pretext/compareHeights.ts apps/fluux/src/spikes/pretext/compareHeights.test.ts
git commit -m "spike(pretext): pure comparison and reporting module"
```

---

### Task 5: DOM measurement page (renders real MessageBody, emits report JSON)

**Files:**
- Create: `apps/fluux/pretext-spike.html` (root entry, mirrors `apps/fluux/demo.html`)
- Create: `apps/fluux/src/spikes/pretext/pretextSpike.tsx`

**Interfaces:**
- Consumes: `CORPUS` (Task 2), `predictTextHeight` + `FontSpec` (Task 3), `buildReport` + `Sample` (Task 4), the production `MessageBody` and the app's global CSS / i18n.
- Produces: a page that renders every corpus item at each test width, measures real DOM heights after `document.fonts.ready`, builds the report, and writes it as JSON into `<pre id="report">` for copy-paste capture on any engine.

> **Scope note (decided 2026-06-27):** this task measures TEXT-body height only — pretext's actual scope. The fixed message-row "chrome" (avatar/sender/timestamp/reactions/date-separator) is text-independent and is captured as a one-time manual measurement in Task 7's decision doc, NOT emitted by this page. There is intentionally no `measureChrome` module.

- [ ] **Step 1: Create the HTML entry**

Create `apps/fluux/pretext-spike.html` by copying `apps/fluux/demo.html` and changing only the title and the script source:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" href="favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Fluux — Pretext Height Spike</title>
  </head>
  <body>
    <script>globalThis.process=globalThis.process||{};process.nextTick=process.nextTick||(function(cb){var a=Array.prototype.slice.call(arguments,1);queueMicrotask(function(){cb.apply(null,a)})});</script>
    <div id="root"></div>
    <script type="module" src="src/spikes/pretext/pretextSpike.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement the measurement page**

Create `apps/fluux/src/spikes/pretext/pretextSpike.tsx`. It imports the app's global stylesheet and i18n so Inter and the real `MessageBody` styles apply, renders each corpus item inside fixed-width containers, then after `document.fonts.ready` measures each body, derives the live `FontSpec` from a rendered body's computed style, predicts via pretext, builds the report, and dumps JSON:
```tsx
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import '@/index.css'
import { MessageBody } from '@/components/conversation/MessageBody'
import { CORPUS } from './corpus'
import { predictTextHeight, type FontSpec, type Prediction } from './predictTextHeight'
import { buildReport, type Sample } from './compareHeights'

const WIDTHS = [320, 560, 760] // narrow / medium / wide content-column widths (px)
const SCALES = [90, 100, 125, 150] // character scaling = document.documentElement root font-size %
const SENDER_COLOR = '#3b82f6'

function fontSpecFrom(el: HTMLElement): FontSpec {
  const cs = getComputedStyle(el)
  const fontSizePx = parseFloat(cs.fontSize)
  const lh = cs.lineHeight === 'normal' ? fontSizePx * 1.375 : parseFloat(cs.lineHeight)
  const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0
  return {
    fontFamily: cs.fontFamily,
    fontSizePx,
    fontWeight: Number(cs.fontWeight) || 400,
    fontStyle: cs.fontStyle || 'normal',
    lineHeightPx: lh,
    letterSpacingPx: ls,
    whiteSpace: 'pre-wrap',
  }
}

function countLineBoxes(el: HTMLElement, lineHeightPx: number): number {
  // robust line count = rendered height / line-height, rounded
  return Math.max(1, Math.round(el.getBoundingClientRect().height / lineHeightPx))
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [json, setJson] = useState('measuring...')

  useEffect(() => {
    let cancelled = false
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

    async function run() {
      await document.fonts.ready
      await nextFrame() // settle after font swap
      if (cancelled || !containerRef.current) return
      const root = containerRef.current
      const runs: Array<{ fontScalePct: number; report: ReturnType<typeof buildReport>; samples: Sample[] }> = []

      // Character scaling = root font-size %. The SAME DOM is re-measured at each
      // scale (changing root font-size reflows the rem-based message text); the
      // font spec is read live from getComputedStyle, so the predictor tracks the
      // scaled font. Density is intentionally NOT varied here: it changes only
      // chrome spacing/avatar, never the text wrapping (see plan Scope note).
      for (const pct of SCALES) {
        document.documentElement.style.fontSize = `${pct}%`
        await nextFrame() // reflow at the new scale
        if (cancelled) return
        const samples: Sample[] = []
        for (const width of WIDTHS) {
          for (const item of CORPUS) {
            const bodyEl = root.querySelector<HTMLElement>(
              `[data-spike-body="${item.id}"][data-spike-width="${width}"] [dir="auto"]`,
            )
            if (!bodyEl) continue
            const font = fontSpecFrom(bodyEl)
            const measuredHeightPx = bodyEl.getBoundingClientRect().height
            const measuredLineCount = countLineBoxes(bodyEl, font.lineHeightPx)
            const predicted: Prediction = predictTextHeight(item.body, width, font)
            samples.push({ id: item.id, category: item.category, widthPx: width, predicted, measuredHeightPx, measuredLineCount })
          }
        }
        const report = buildReport(samples, {
          lineExactThresholdPct: 98,
          heightTolPx: 2,
          textCategories: ['short', 'wrap', 'mention', 'link', 'me', 'mixed'],
        })
        runs.push({ fontScalePct: pct, report, samples })
      }

      document.documentElement.style.fontSize = '' // restore default scale
      const out = { engine: navigator.userAgent, widths: WIDTHS, scales: SCALES, runs }
      if (!cancelled) setJson(JSON.stringify(out, null, 2))
    }

    void run()
    return () => { cancelled = true; document.documentElement.style.fontSize = '' }
  }, [])

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 16 }}>Pretext height spike</h1>
      <pre id="report" data-spike-report style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto', border: '1px solid #ccc', padding: 8 }}>{json}</pre>
      <div ref={containerRef}>
        {WIDTHS.map((width) => (
          <div key={width}>
            {CORPUS.map((item) => (
              <div
                key={`${width}-${item.id}`}
                data-spike-body={item.id}
                data-spike-width={width}
                style={{ width, outline: '1px dashed rgba(0,0,0,0.1)', margin: '4px 0' }}
              >
                <MessageBody body={item.body} senderName="Tester" senderColor={SENDER_COLOR} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={i18n}>
    <App />
  </I18nextProvider>,
)
```
Note: the container width here is the *content column* width; it must match the real bubble content width. The three `WIDTHS` are an initial bracket; the decision doc (Task 7) records which width best matches the real layout. If `@/i18n` is not the actual init module path, use the same import the app entry (`apps/fluux/src/main.tsx` or `apps/fluux/src/demo.tsx`) uses.

- [ ] **Step 3: Run the page and confirm it produces a report**

Run the dev server, then open the entry:
```bash
cd apps/fluux && npm run dev
```
Open `http://localhost:5173/pretext-spike.html`. Expected: the `#report` block fills with JSON containing a `runs` array (one entry per character scale in `SCALES`), each with `report.overall.textLineExactPct` and per-category stats; no console errors. (If pretext throws on canvas/font, that is a real finding — record it.)

- [ ] **Step 4: Typecheck and commit**

Run:
```bash
cd apps/fluux && npm run typecheck
```
Expected: PASS. Then:
```bash
git add apps/fluux/pretext-spike.html apps/fluux/src/spikes/pretext/pretextSpike.tsx
git commit -m "spike(pretext): DOM measurement page emitting report JSON"
```

---

### Task 6: Automated Chromium accuracy check

**Files:**
- Create: `apps/fluux/scripts/pretext-spike-check.mjs`

**Interfaces:**
- Consumes: a running dev server serving `pretext-spike.html`, and the `#report` JSON (Task 5).
- Produces: a Playwright Chromium script that loads the page, parses the report, prints a per-scale, per-category table, and exits non-zero if ANY character scale's `report.overall.passesThreshold` is false — the regression guard if we proceed, and the break-verifiable accuracy oracle for Chromium.

- [ ] **Step 1: Implement the Playwright check script**

Create `apps/fluux/scripts/pretext-spike-check.mjs`:
```js
import { chromium } from 'playwright'

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/pretext-spike.html'

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'networkidle' })

// wait until the report stops saying "measuring..." (multiple scale passes can
// take a few seconds, so allow a generous timeout)
await page.waitForFunction(() => {
  const el = document.getElementById('report')
  return el && el.textContent && !el.textContent.startsWith('measuring')
}, { timeout: 30000 })

const raw = await page.$eval('#report', (el) => el.textContent ?? '')
await browser.close()

const out = JSON.parse(raw)
console.log('engine:', out.engine)
console.log('widths:', out.widths, 'scales:', out.scales)

let anyFail = false
for (const run of out.runs) {
  console.log(`\n--- character scale ${run.fontScalePct}% ---`)
  console.table(run.report.byCategory)
  console.log('text line-exact %:', run.report.overall.textLineExactPct.toFixed(2))
  if (!run.report.overall.passesThreshold) anyFail = true
}

const worst = out.runs.flatMap((r) =>
  r.report.worstOffenders.map((s) => `${r.fontScalePct}% ${s.id}@${s.widthPx} pred=${s.predicted.heightPx} meas=${s.measuredHeightPx}`),
)
console.log('\nworst offenders (across scales):', worst.slice(0, 15))

if (anyFail) {
  console.error('FAIL: pretext below accuracy threshold on Chromium at one or more character scales')
  process.exit(1)
}
console.log('PASS: pretext meets accuracy threshold on Chromium across all character scales')
```

- [ ] **Step 2: Run the check against the dev server**

With `npm run dev` running (Task 5), run:
```bash
cd apps/fluux && node scripts/pretext-spike-check.mjs
```
Expected: a per-scale, per-category table plus PASS or FAIL. Either outcome is a valid spike result; record the printed numbers for every scale.

- [ ] **Step 3: Break-verify the oracle**

Temporarily edit `predictTextHeight.ts` to multiply the returned `lineCount` by 2, re-run the check. Expected: it now prints FAIL and exits non-zero (confirms the harness actually detects inaccuracy). Revert the edit and re-run to restore the true result.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/scripts/pretext-spike-check.mjs
git commit -m "spike(pretext): automated Chromium accuracy check"
```

---

### Task 7: Run on all engines and write the decision

**Files:**
- Create: `docs/superpowers/spikes/2026-06-27-pretext-height-results.md`
- Create: `apps/fluux/src/spikes/pretext/results/` (capture folder for raw per-engine JSON)

**Interfaces:**
- Consumes: the Chromium check (Task 6) and the page (Task 5) loaded in the real Tauri engines.
- Produces: per-engine raw JSON captures and a written go / partial / no-go recommendation against the success criterion.

- [ ] **Step 1: Capture Chromium numbers**

With the dev server running, run `node scripts/pretext-spike-check.mjs` and save the printed report by copying the `#report` JSON from the page into `apps/fluux/src/spikes/pretext/results/chromium.json`.

- [ ] **Step 2: Capture macOS WKWebView numbers**

Run the desktop app in dev:
```bash
npm run tauri:dev
```
Navigate the in-app webview to `http://localhost:5173/pretext-spike.html` (or temporarily point the Tauri dev URL at it). Copy the `#report` JSON into `apps/fluux/src/spikes/pretext/results/wkwebview-macos.json`. (Manual capture: per the preview/momentum lessons in project memory, automated drivers cannot stand in for the real engine — but this is deterministic measurement, so copying the emitted JSON is reliable.)

- [ ] **Step 3: Capture Linux WebKitGTK numbers (if a Linux build is available)**

Repeat Step 2 on a Linux/WebKitGTK build; save to `apps/fluux/src/spikes/pretext/results/webkitgtk-linux.json`. If no Linux environment is available, note that explicitly in the decision doc as an outstanding risk rather than skipping silently.

- [ ] **Step 4: Write the decision document**

Create `docs/superpowers/spikes/2026-06-27-pretext-height-results.md` containing:
  - The success criterion verbatim (line-exact ≥ 98% for text categories, height error ≤ ±2px, at every tested character scale, on every engine).
  - A per-engine, per-scale, per-category table (count, lineExactPct, p95AbsErrPx, maxAbsErrPx) pulled from the captured JSON `runs` array. Call out any scale where accuracy degrades.
  - The chrome-delta MATRIX, captured here as a MANUAL measurement (the page emits text height only): for each density (`comfortable`, `compact`) and a few character scales, open a real conversation/room in the running app and with devtools read the fixed text-independent vertical cost of a row — avatar/sender-header block, timestamp, reactions row, date separator, row vertical padding. Record the matrix, and whether `predictedRow = predictTextHeight + chromeDelta(density, scale)` is stable enough that the chrome term is a small lookup (per density × scale) rather than needing per-message measurement.
  - Explicit out-of-scope findings: code blocks, attachments/media, emoji error magnitudes.
  - A verdict: **GO** (adopt pretext as the virtualizer size source for all text rows; media/code keep a reserved-space estimate), **PARTIAL** (use pretext only for the categories that passed; document which), or **NO-GO** (error too large or engine-divergent; fall back to the tactical per-message-type static estimates instead), with one paragraph of justification tied to the numbers.
  - A "next step if GO" pointer: a follow-up plan to wire `predictTextHeight + chromeDelta` into `tanstackMessageVirtualizer.ts`'s `estimateSize`, behind the existing `enableMessageVirtualization` flag, plus the persistent-height-cache and reserve-media-space follow-ons.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/spikes/2026-06-27-pretext-height-results.md apps/fluux/src/spikes/pretext/results
git commit -m "spike(pretext): per-engine results + go/no-go decision"
```

---

## Self-Review

**Spec coverage:**
- Pretext accuracy vs real DOM, across engines → Tasks 3, 5, 6, 7.
- Representative corpus incl. edge cases (emoji, RTL, long tokens, code, multi-paragraph) → Task 2.
- Faithful rendering with real font/styles (Inter, `leading-[1.375]`, `pre-wrap`) → Task 5 (renders real `MessageBody`, derives `FontSpec` live).
- Chrome modeling (text height to full row height) → one-time manual measurement in Task 7 decision (the page emits text height only; decided 2026-06-27).
- Out-of-scope handling (media/code) measured and reported, not silently dropped → Tasks 4, 7.
- Automatable accuracy oracle (the verifiability win the prior scroll fixes lacked) → Task 6, break-verified.
- Real-engine capture given preview/Playwright cannot reproduce engine behavior → Task 7 manual procedure.
- Pre-stated decision gate → Global Constraints + Task 7 verdict.
- No production scroll/virtualization code touched → Global Constraints (additive dirs + one HTML entry + one script only).

**Placeholder scan:** Each code step contains complete code. The one genuine unknown — pretext's exact parameter names — is handled by Task 1 pinning the real API into `NOTES.md` and Task 3 marking the single adaptation point, rather than by a "TODO".

**Type consistency:** `FontSpec`/`Prediction` defined in Task 3 are consumed unchanged in Tasks 4 and 5; `Sample`/`Report`/`buildReport` defined in Task 4 are consumed unchanged in Tasks 5 and 6; `CorpusCategory`/`CorpusItem`/`CORPUS` defined in Task 2 are consumed in Tasks 4 and 5. `predictTextHeight` signature is identical across definition (Task 3) and call sites (Task 5).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-pretext-height-measurement-spike.md`.
