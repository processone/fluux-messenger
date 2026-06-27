# Pretext-Driven Virtualizer Row Estimate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `estimateSize: () => 64` in the message virtualizer with a per-item height estimate driven by `@chenglou/pretext` line-count prediction, so unmounted/prepended/overscan rows are sized correctly and the estimate→measured "snap" that causes jumpy scroll-back disappears.

**Architecture:** Three pure layers feed one integration. (1) A shipping `predictMessageTextHeight` util wraps pretext to return `{lineCount, heightPx}` for a body string at a given width+font, with an optional per-line floor (WebKit renders integer line boxes). (2) A pure `estimateRowHeight(item, ctx)` maps each flattened `RenderItem` (date/header/footer/message) to a pixel height: text rows use pretext, code/media rows use a reserved-space estimate, structural rows use sampled constants. (3) `useRowMetrics` samples the live font spec, content width, and per-shape chrome deltas from already-mounted rows (self-calibrating, so density/scale/theme need no hardcoded tables) and invalidates on width/scale/density change. MessageList builds a per-index estimator from these and passes it to the adapter, which now accepts a function. A persistent measured-height cache seeds the virtualizer on remount so re-entering a conversation is accurate immediately.

**Tech Stack:** `@chenglou/pretext` (already a dependency), `@tanstack/react-virtual` (existing adapter `tanstackMessageVirtualizer.ts`), React 19, Vitest (jsdom), the existing `enableMessageVirtualization` feature flag.

## Global Constraints

- Gate ALL behavior changes behind the existing `enableMessageVirtualization` flag (read via `isFeatureEnabled('enableMessageVirtualization')` / the app's `featureFlags` util). Flag OFF must be byte-identical to today. The non-virtualized path is never touched.
- The estimate must be DETERMINISTIC per (item, width, font) — never a running average. A changing average destabilizes `getTotalSize` and broke scroll-to-bottom before (`tanstackMessageVirtualizer.ts:99-105`); do not reintroduce it.
- pretext needs Canvas 2D; its numeric calls do NOT work under jsdom (`measureText` width 0). Pure pretext-dependent tests gate on a real-canvas check and SKIP under jsdom; numeric validation is the in-browser spike oracle (`apps/fluux/scripts/pretext-spike-check.mjs`) + real-engine. Pure non-pretext logic (estimateRowHeight mapping, classifier, cache keys) is fully unit-tested in jsdom.
- Engine line-box rounding: WebKit floors each rendered line box (computed line-height 19.8px renders as a 19px box) while `getComputedStyle().lineHeight` reports the un-rounded value; Chromium keeps fractional. So the row height is `lineCount * lineBoxPx` where `lineBoxPx = Math.floor(lineHeightPx)` on WebKit. Detect once via a sampled real line box, not a UA sniff (see Task 5). Source: `docs/superpowers/spikes/2026-06-27-pretext-height-results.md`.
- The estimate only needs to be good enough to keep `getTotalSize`/offsets roughly correct; @tanstack measures each row exactly on mount via `measureElement`. Correct LINE COUNT is the property that removes the snap (spike: 100% line-count exact on both engines at all character scales).
- No user-facing strings added. Any dev-only log avoids em-dashes and en-dashes.
- Run app Vitest from `apps/fluux` (root config lacks the `@` alias). Run `npm run typecheck` and the linter before each commit; output pristine. If a stale `node_modules/.vite` resolve error appears, `rm -rf apps/fluux/node_modules/.vite`.
- rAF/ResizeObserver/layout-dependent behavior is NOT verifiable in the Claude preview (hidden 0x0 page) or Playwright momentum; Task 5-8 layout/scroll behavior is verified by unit contracts in jsdom + a real Tauri build (`npm run tauri:dev`), not the preview.

**Shared types (defined in Task 1 and Task 3, referenced throughout):**
- `FontSpec` = `{ fontFamily: string; fontSizePx: number; fontWeight: number; fontStyle: string; lineHeightPx: number; letterSpacingPx: number; whiteSpace: 'normal' | 'pre-wrap' }`
- `MessagePrediction` = `{ lineCount: number; heightPx: number }`
- `RowChrome` = `{ header: number; continuation: number; reactionsRow: number; newMarker: number; date: number; loadEarlierHeader: number; footer: number }`
- `RowEstimatorContext` = `{ fontSpec: FontSpec; contentWidthPx: number; lineBoxPx: number; chrome: RowChrome }`

---

### Task 1: Shipping pretext text-height util

**Files:**
- Create: `apps/fluux/src/utils/messageHeight/predictMessageTextHeight.ts`
- Create: `apps/fluux/src/utils/messageHeight/predictMessageTextHeight.test.ts`

**Interfaces:**
- Consumes: `@chenglou/pretext` (`prepare`, `layout` — confirmed API in `apps/fluux/src/spikes/pretext/NOTES.md`).
- Produces:
  - `export interface FontSpec { fontFamily: string; fontSizePx: number; fontWeight: number; fontStyle: string; lineHeightPx: number; letterSpacingPx: number; whiteSpace: 'normal' | 'pre-wrap' }`
  - `export interface MessagePrediction { lineCount: number; heightPx: number }`
  - `export function predictMessageTextHeight(body: string, contentWidthPx: number, font: FontSpec, lineBoxPx: number): MessagePrediction`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/messageHeight/predictMessageTextHeight.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { predictMessageTextHeight, type FontSpec } from './predictMessageTextHeight'

const FONT: FontSpec = {
  fontFamily: 'Inter, sans-serif', fontSizePx: 16, fontWeight: 400,
  fontStyle: 'normal', lineHeightPx: 22, letterSpacingPx: 0, whiteSpace: 'pre-wrap',
}

// pretext needs a real Canvas 2D; jsdom's measureText returns 0. Gate numeric cases.
function canvasMeasures(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const ctx = document.createElement('canvas').getContext('2d')
    return !!ctx && ctx.measureText('x').width > 0
  } catch { return false }
}
const canvasAvailable = canvasMeasures()

describe('predictMessageTextHeight', () => {
  it('exports a callable predictor', () => {
    expect(typeof predictMessageTextHeight).toBe('function')
  })

  it.runIf(canvasAvailable)('height = lineCount * lineBoxPx (uses the floored line box, not raw line-height)', () => {
    const p = predictMessageTextHeight('hello world', 560, FONT, 19)
    expect(p.lineCount).toBeGreaterThanOrEqual(1)
    expect(p.heightPx).toBe(p.lineCount * 19) // lineBoxPx, not FONT.lineHeightPx (22)
  })

  it.runIf(canvasAvailable)('wraps to more lines at a narrower width', () => {
    const wide = predictMessageTextHeight('the quick brown fox jumps over the lazy dog repeatedly', 700, FONT, 22)
    const narrow = predictMessageTextHeight('the quick brown fox jumps over the lazy dog repeatedly', 160, FONT, 22)
    expect(narrow.lineCount).toBeGreaterThanOrEqual(wide.lineCount)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/utils/messageHeight/predictMessageTextHeight.test.ts
```
Expected: FAIL with "Cannot find module './predictMessageTextHeight'".

- [ ] **Step 3: Implement the util**

Create `apps/fluux/src/utils/messageHeight/predictMessageTextHeight.ts`:
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

export interface MessagePrediction {
  lineCount: number
  heightPx: number
}

/** CSS `font` shorthand for pretext: "style weight size family". */
function toFontShorthand(font: FontSpec): string {
  return `${font.fontStyle} ${font.fontWeight} ${font.fontSizePx}px ${font.fontFamily}`
}

/**
 * Predict a message body's wrapped TEXT height with no DOM reflow, using @chenglou/pretext.
 * Returns the exact wrapped line count and a height of `lineCount * lineBoxPx`, where
 * `lineBoxPx` is the engine's RENDERED per-line box height (Math.floor(lineHeight) on WebKit,
 * which floors line boxes; ~= lineHeight on Chromium). Passing lineBoxPx explicitly keeps this
 * util pure and engine-agnostic; the caller measures the real line box once (Task 5).
 *
 * Requires a working Canvas 2D (browser); under plain Node/jsdom prepare() measures 0.
 */
export function predictMessageTextHeight(
  body: string, contentWidthPx: number, font: FontSpec, lineBoxPx: number,
): MessagePrediction {
  const prepared = prepare(body, toFontShorthand(font), {
    whiteSpace: font.whiteSpace,
    letterSpacing: font.letterSpacingPx,
  })
  const result = layout(prepared, contentWidthPx, font.lineHeightPx)
  const lineCount = Math.max(1, result.lineCount)
  return { lineCount, heightPx: lineCount * lineBoxPx }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/utils/messageHeight/predictMessageTextHeight.test.ts
```
Expected: PASS (the two canvas cases auto-skip under jsdom; the export check passes).

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/fluux && npm run typecheck
git add apps/fluux/src/utils/messageHeight/predictMessageTextHeight.ts apps/fluux/src/utils/messageHeight/predictMessageTextHeight.test.ts
git commit -m "feat(virtualizer): shipping pretext text-height predictor util"
```

---

### Task 2: Message body classifier (text vs code vs media)

**Files:**
- Create: `apps/fluux/src/utils/messageHeight/classifyMessageBody.ts`
- Create: `apps/fluux/src/utils/messageHeight/classifyMessageBody.test.ts`

**Interfaces:**
- Consumes: `BaseMessage` from `@fluux/sdk` (fields: `body: string`, `attachment?`, `linkPreview?`, `poll?`, `isRetracted?`).
- Produces:
  - `export type BodyClass = 'text' | 'code' | 'media' | 'empty'`
  - `export function classifyMessageBody(m: { body: string; attachment?: unknown; linkPreview?: unknown; poll?: unknown; isRetracted?: boolean }): BodyClass`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/messageHeight/classifyMessageBody.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { classifyMessageBody } from './classifyMessageBody'

describe('classifyMessageBody', () => {
  it('classifies a plain text message as text', () => {
    expect(classifyMessageBody({ body: 'hello there' })).toBe('text')
  })
  it('classifies a fenced code block as code', () => {
    expect(classifyMessageBody({ body: '```\nconst x = 1\n```' })).toBe('code')
  })
  it('does NOT classify inline code as code', () => {
    expect(classifyMessageBody({ body: 'use `npm run dev` to start' })).toBe('text')
  })
  it('classifies an attachment as media regardless of body', () => {
    expect(classifyMessageBody({ body: '', attachment: { url: 'x' } })).toBe('media')
  })
  it('classifies a link preview as media', () => {
    expect(classifyMessageBody({ body: 'see https://x', linkPreview: { title: 'X' } })).toBe('media')
  })
  it('classifies a poll as media', () => {
    expect(classifyMessageBody({ body: '', poll: { question: 'Q' } })).toBe('media')
  })
  it('classifies an empty/retracted body as empty', () => {
    expect(classifyMessageBody({ body: '' })).toBe('empty')
    expect(classifyMessageBody({ body: 'gone', isRetracted: true })).toBe('empty')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/utils/messageHeight/classifyMessageBody.test.ts
```
Expected: FAIL with "Cannot find module './classifyMessageBody'".

- [ ] **Step 3: Implement the classifier**

Create `apps/fluux/src/utils/messageHeight/classifyMessageBody.ts`:
```ts
export type BodyClass = 'text' | 'code' | 'media' | 'empty'

/** A fenced code block opens a line with ``` (after optional leading whitespace). */
function hasFencedCodeBlock(body: string): boolean {
  return /(^|\n)\s*```/.test(body)
}

/**
 * Coarse render-shape classifier for height estimation. `media` (attachment / link preview /
 * poll) and `code` (fenced block, rendered in a monospace font pretext cannot model with the
 * prose font) get a reserved-space estimate; `text` uses pretext; `empty`/retracted gets the
 * minimal row height.
 */
export function classifyMessageBody(m: {
  body: string
  attachment?: unknown
  linkPreview?: unknown
  poll?: unknown
  isRetracted?: boolean
}): BodyClass {
  if (m.attachment != null || m.linkPreview != null || m.poll != null) return 'media'
  if (m.isRetracted || m.body.trim() === '') return 'empty'
  if (hasFencedCodeBlock(m.body)) return 'code'
  return 'text'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/utils/messageHeight/classifyMessageBody.test.ts
```
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/fluux && npm run typecheck
git add apps/fluux/src/utils/messageHeight/classifyMessageBody.ts apps/fluux/src/utils/messageHeight/classifyMessageBody.test.ts
git commit -m "feat(virtualizer): message body shape classifier for height estimation"
```

---

### Task 3: Pure per-item row-height estimator

**Files:**
- Create: `apps/fluux/src/components/conversation/rowHeightEstimator.ts`
- Create: `apps/fluux/src/components/conversation/rowHeightEstimator.test.ts`

**Interfaces:**
- Consumes: `RenderItem<T>` (`messageListItems.ts`), `MessageListItem` (`messageVirtualizer.ts`), `FontSpec`/`predictMessageTextHeight` (Task 1), `classifyMessageBody`/`BodyClass` (Task 2).
- Produces:
  - `export interface RowChrome { header: number; continuation: number; reactionsRow: number; newMarker: number; date: number; loadEarlierHeader: number; footer: number }`
  - `export interface RowEstimatorContext { fontSpec: FontSpec; contentWidthPx: number; lineBoxPx: number; chrome: RowChrome }`
  - `export const RESERVED_MEDIA_PX = 260`  and  `export const RESERVED_CODE_LINE_PX = 19`
  - `export function estimateRowHeight<T extends { id: string; body: string; reactions?: Record<string, string[]>; attachment?: unknown; linkPreview?: unknown; poll?: unknown; isRetracted?: boolean }>(item: import('./messageListItems').RenderItem<T>, ctx: RowEstimatorContext): number`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/rowHeightEstimator.test.ts`. These are PURE (no pretext/canvas) by injecting a context whose `contentWidthPx`/`fontSpec` make line counts predictable through the real util only when canvas exists; for deterministic jsdom tests we assert the STRUCTURAL rows and the chrome additions, and assert text rows are at least one line of chrome+text:
```ts
import { describe, it, expect } from 'vitest'
import { estimateRowHeight, type RowEstimatorContext } from './rowHeightEstimator'
import type { RenderItem } from './messageListItems'

interface Msg { id: string; body: string; reactions?: Record<string, string[]>; attachment?: unknown; isRetracted?: boolean }

const CTX: RowEstimatorContext = {
  fontSpec: { fontFamily: 'Inter', fontSizePx: 16, fontWeight: 400, fontStyle: 'normal', lineHeightPx: 22, letterSpacingPx: 0, whiteSpace: 'pre-wrap' },
  contentWidthPx: 560,
  lineBoxPx: 22,
  chrome: { header: 40, continuation: 6, reactionsRow: 28, newMarker: 48, date: 48, loadEarlierHeader: 52, footer: 40 },
}

const msgItem = (m: Msg, over: Partial<Extract<RenderItem<Msg>, { kind: 'message' }>> = {}): RenderItem<Msg> => ({
  kind: 'message', key: m.id, message: m, showAvatar: true, isFirstNew: false, indexInGroup: 0, groupMessages: [m], ...over,
})

describe('estimateRowHeight (structural rows + chrome, no canvas needed)', () => {
  it('date row = chrome.date', () => {
    expect(estimateRowHeight<Msg>({ kind: 'date', key: 'd', date: '2026-06-27' }, CTX)).toBe(48)
  })
  it('header row = chrome.loadEarlierHeader', () => {
    expect(estimateRowHeight<Msg>({ kind: 'header', key: '__header' }, CTX)).toBe(52)
  })
  it('footer row = chrome.footer', () => {
    expect(estimateRowHeight<Msg>({ kind: 'footer', key: '__footer' }, CTX)).toBe(40)
  })
  it('media message uses reserved media space + header chrome', () => {
    const h = estimateRowHeight<Msg>(msgItem({ id: '1', body: '', attachment: { url: 'x' } }), CTX)
    expect(h).toBe(260 + 40) // RESERVED_MEDIA_PX + chrome.header
  })
  it('empty/retracted message = one line box + continuation chrome when not first in group', () => {
    const h = estimateRowHeight<Msg>(msgItem({ id: '1', body: '', isRetracted: true }, { showAvatar: false }), CTX)
    expect(h).toBe(22 + 6) // one lineBox + chrome.continuation
  })
  it('a first-new text message adds the new-message marker', () => {
    const withMarker = estimateRowHeight<Msg>(msgItem({ id: '1', body: '' }, { isFirstNew: true, showAvatar: false }), CTX)
    const without = estimateRowHeight<Msg>(msgItem({ id: '1', body: '' }, { isFirstNew: false, showAvatar: false }), CTX)
    expect(withMarker - without).toBe(48) // chrome.newMarker
  })
  it('reactions add a reactions row', () => {
    const withR = estimateRowHeight<Msg>(msgItem({ id: '1', body: '', reactions: { 'a': ['x'] } }, { showAvatar: false }), CTX)
    const withoutR = estimateRowHeight<Msg>(msgItem({ id: '1', body: '' }, { showAvatar: false }), CTX)
    expect(withR - withoutR).toBe(28) // chrome.reactionsRow
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/rowHeightEstimator.test.ts
```
Expected: FAIL with "Cannot find module './rowHeightEstimator'".

- [ ] **Step 3: Implement the estimator**

Create `apps/fluux/src/components/conversation/rowHeightEstimator.ts`:
```ts
import type { RenderItem } from './messageListItems'
import { predictMessageTextHeight, type FontSpec } from '@/utils/messageHeight/predictMessageTextHeight'
import { classifyMessageBody } from '@/utils/messageHeight/classifyMessageBody'

export interface RowChrome {
  header: number          // sender header block (avatar row + nick + timestamp) above the text
  continuation: number    // vertical padding of a continuation row (no header)
  reactionsRow: number    // a single reactions strip under a message
  newMarker: number       // the "New messages" divider rendered above a first-new row
  date: number            // a date separator row
  loadEarlierHeader: number // the load-earlier / history-start header row
  footer: number          // the footer (typing indicator + bottom padding)
}

export interface RowEstimatorContext {
  fontSpec: FontSpec
  contentWidthPx: number
  lineBoxPx: number
  chrome: RowChrome
}

/** Reserved height for a media row (image/file/link-preview/poll) before its real DOM is measured. */
export const RESERVED_MEDIA_PX = 260
/** Per-line height used to reserve space for a fenced code block (monospace; pretext cannot model it). */
export const RESERVED_CODE_LINE_PX = 19

/** Reserve space for a code block by counting its physical newlines (a safe over-estimate;
 *  the real highlighted block is measured on mount). */
function reservedCodeHeight(body: string, lineBoxPx: number): number {
  const lines = body.split('\n').length
  return lines * Math.max(lineBoxPx, RESERVED_CODE_LINE_PX)
}

/**
 * Deterministic per-item height estimate for the virtualizer. Pure: same (item, ctx) -> same px.
 * Text rows use pretext line-count; code/media rows use reserved space; structural rows use the
 * sampled chrome constants. The virtualizer measures the real row on mount, so this only needs to
 * be close enough to stop the estimate-snap.
 */
export function estimateRowHeight<T extends {
  id: string; body: string; reactions?: Record<string, string[]>
  attachment?: unknown; linkPreview?: unknown; poll?: unknown; isRetracted?: boolean
}>(item: RenderItem<T>, ctx: RowEstimatorContext): number {
  if (item.kind === 'date') return ctx.chrome.date
  if (item.kind === 'header') return ctx.chrome.loadEarlierHeader
  if (item.kind === 'footer') return ctx.chrome.footer

  // message
  const m = item.message
  const chromeBase = item.showAvatar ? ctx.chrome.header : ctx.chrome.continuation
  const marker = item.isFirstNew ? ctx.chrome.newMarker : 0
  const reactions = m.reactions && Object.keys(m.reactions).length > 0 ? ctx.chrome.reactionsRow : 0

  const cls = classifyMessageBody(m)
  let contentPx: number
  if (cls === 'media') {
    contentPx = RESERVED_MEDIA_PX
  } else if (cls === 'code') {
    contentPx = reservedCodeHeight(m.body, ctx.lineBoxPx)
  } else if (cls === 'empty') {
    contentPx = ctx.lineBoxPx
  } else {
    contentPx = predictMessageTextHeight(m.body, ctx.contentWidthPx, ctx.fontSpec, ctx.lineBoxPx).heightPx
  }
  return contentPx + chromeBase + marker + reactions
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/rowHeightEstimator.test.ts
```
Expected: PASS (the structural/media/empty/marker/reactions cases run without canvas; text-only prediction is exercised in the browser via the spike oracle + Task 8).

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/fluux && npm run typecheck
git add apps/fluux/src/components/conversation/rowHeightEstimator.ts apps/fluux/src/components/conversation/rowHeightEstimator.test.ts
git commit -m "feat(virtualizer): pure per-item row-height estimator"
```

---

### Task 4: Adapter accepts a per-index estimate function

**Files:**
- Modify: `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts:79-134`
- Modify: `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `useTanstackMessageVirtualizer` now accepts `estimateSize?: number | ((index: number) => number)` and feeds @tanstack a stable per-index function. Default unchanged (`64`). The `MessageVirtualizer` return type is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.test.tsx` a case that a per-index `estimateSize` function drives `getTotalSize` (mock @tanstack the same way the file already does; assert the size function is consulted per index). Mirror the existing test's mock shape. Concretely, add:
```tsx
it('uses a per-index estimateSize function for getTotalSize', () => {
  // The existing @tanstack mock in this file captures the config passed to useVirtualizer.
  // Render the hook with a function estimate and assert the captured config.estimateSize
  // returns per-index values (index 0 -> 100, others -> 20).
  const estimate = (index: number) => (index === 0 ? 100 : 20)
  const { capturedConfig } = renderAdapter({ items: [{ key: 'a' }, { key: 'b' }], estimateSize: estimate })
  expect(capturedConfig.estimateSize(0)).toBe(100)
  expect(capturedConfig.estimateSize(1)).toBe(20)
})
```
If the existing test file does not already expose a `renderAdapter`/`capturedConfig` helper, add a minimal one next to the existing `vi.mock('@tanstack/react-virtual', ...)`: capture the `config` argument of `useVirtualizer` into a module variable and return it, mirroring how the current tests assert on `scrollToOffset`/`getTotalSize`.

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/tanstackMessageVirtualizer.test.tsx
```
Expected: FAIL — the current `estimateSize: () => estimateSize` ignores the index, so `capturedConfig.estimateSize(0)` returns the same value for every index.

- [ ] **Step 3: Implement the per-index estimate**

In `tanstackMessageVirtualizer.ts`, change the `Args` interface and the config. Replace the `estimateSize?: number` field (line 85) with:
```ts
  estimateSize?: number | ((index: number) => number)
```
Replace the destructure default (line 97) `estimateSize = 64,` with `estimateSize = 64,` (unchanged) and replace the config line (128) `estimateSize: () => estimateSize,` with:
```ts
    estimateSize: typeof estimateSize === 'function' ? estimateSize : () => estimateSize,
```
Add, just above the `useVirtualizer` call, a stable ref so a new closure each render does not thrash @tanstack (it reads estimateSize by reference):
```ts
  // Keep a stable estimateSize callback identity; @tanstack re-reads it, and a fresh closure each
  // render would invalidate its size cache. The ref always points at the latest caller function.
  const estimateRef = useRef(estimateSize)
  estimateRef.current = estimateSize
  const estimateFn = useCallback(
    (index: number) => {
      const e = estimateRef.current
      return typeof e === 'function' ? e(index) : e
    },
    [],
  )
```
and use `estimateSize: estimateFn,` in the config. Ensure `useRef` is imported (it already is, line 1; add `useCallback` is already imported).

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/tanstackMessageVirtualizer.test.tsx
```
Expected: PASS (the new per-index case plus the existing scrollToOffset/getTotalSize cases).

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/fluux && npm run typecheck
git add apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts apps/fluux/src/components/conversation/tanstackMessageVirtualizer.test.tsx
git commit -m "feat(virtualizer): adapter accepts a per-index estimateSize function"
```

---

### Task 5: useRowMetrics — sample live font, width, and chrome from mounted rows

**Files:**
- Create: `apps/fluux/src/components/conversation/useRowMetrics.ts`
- Create: `apps/fluux/src/components/conversation/useRowMetrics.test.tsx`
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx` (add chrome-shape data attributes for sampling)

**Interfaces:**
- Consumes: `RowEstimatorContext`/`RowChrome` (Task 3), `FontSpec` (Task 1), `predictMessageTextHeight` (Task 1), `useRemeasureOnWidthChange` (`messageWidthContext.tsx`), `useSettingsStore` (`fontSize`, `densityMode`).
- Produces:
  - `export function useRowMetrics(scrollRef: React.RefObject<HTMLElement | null>): React.RefObject<RowEstimatorContext>` — a ref whose `.current` is the latest sampled context (never causes re-render). Returns sane fallbacks before the first sample.
  - Sampling reads: the body font from a mounted `[data-msg-text]` node; the content width from that node's `clientWidth`; the line box from the same node (a known single-line row, or `Math.floor(getComputedStyle.lineHeight)`); chrome deltas from mounted rows tagged `data-msg-chrome="header"|"cont"` and the structural rows (`[data-row-kind]`).

- [ ] **Step 1: Add sampling hooks to the row DOM**

In `MessageBubble.tsx`, on the row content wrapper (the `flex-1 min-w-0` container, ~line 500) add `data-msg-chrome={showAvatar ? 'header' : 'cont'}`, and on the message text node rendered by `MessageBody` ensure a stable hook: in `MessageBody.tsx` add `data-msg-text` to the regular-message `<div dir="auto" ...>` (line 125) and the `/me` `<div dir="auto" ...>` (line 106). These are inert attributes (no behavior change). Verify the app still renders:
```bash
cd apps/fluux && npm run typecheck
```
Expected: PASS.

- [ ] **Step 2: Write the failing test for fallback + invalidation contract**

Create `apps/fluux/src/components/conversation/useRowMetrics.test.tsx`. jsdom has no layout, so this asserts the CONTRACT: before any sample, the ref returns the documented fallback context; and the hook re-samples (clears the cached sample) when the settings `fontSize`/`densityMode` change. Use a thin harness component and the real `useSettingsStore`:
```tsx
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'
import { useRowMetrics, ROW_METRICS_FALLBACK } from './useRowMetrics'
import { useSettingsStore } from '@/stores/settingsStore'

describe('useRowMetrics', () => {
  it('returns the documented fallback context before any DOM sample', () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null)
      return useRowMetrics(ref)
    })
    expect(result.current.current).toEqual(ROW_METRICS_FALLBACK)
  })

  it('marks the sample stale when character scale changes (re-sample on next read)', () => {
    // Contract: changing settings invalidates so the next sample re-reads the DOM. We assert the
    // hook re-runs its sample effect by observing it does not throw and still returns a context.
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null)
      return useRowMetrics(ref)
    })
    act(() => { useSettingsStore.getState().setFontSize(125) })
    expect(result.current.current).toBeTruthy()
    act(() => { useSettingsStore.getState().setFontSize(100) })
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/useRowMetrics.test.tsx
```
Expected: FAIL with "Cannot find module './useRowMetrics'".

- [ ] **Step 4: Implement the hook**

Create `apps/fluux/src/components/conversation/useRowMetrics.ts`:
```ts
import { useCallback, useEffect, useRef } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useRemeasureOnWidthChange } from './messageWidthContext'
import { predictMessageTextHeight, type FontSpec } from '@/utils/messageHeight/predictMessageTextHeight'
import type { RowEstimatorContext, RowChrome } from './rowHeightEstimator'

const FALLBACK_FONT: FontSpec = {
  fontFamily: 'Inter, sans-serif', fontSizePx: 16, fontWeight: 400, fontStyle: 'normal',
  lineHeightPx: 22, letterSpacingPx: 0, whiteSpace: 'pre-wrap',
}
const FALLBACK_CHROME: RowChrome = {
  header: 40, continuation: 6, reactionsRow: 28, newMarker: 48, date: 48, loadEarlierHeader: 52, footer: 40,
}
export const ROW_METRICS_FALLBACK: RowEstimatorContext = {
  fontSpec: FALLBACK_FONT, contentWidthPx: 560, lineBoxPx: 22, chrome: FALLBACK_CHROME,
}

function fontSpecFrom(el: HTMLElement): FontSpec {
  const cs = getComputedStyle(el)
  const fontSizePx = parseFloat(cs.fontSize) || 16
  const lh = cs.lineHeight === 'normal' ? fontSizePx * 1.375 : parseFloat(cs.lineHeight) || fontSizePx * 1.375
  const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0
  return {
    fontFamily: cs.fontFamily || 'Inter, sans-serif',
    fontSizePx, fontWeight: Number(cs.fontWeight) || 400, fontStyle: cs.fontStyle || 'normal',
    lineHeightPx: lh, letterSpacingPx: ls, whiteSpace: 'pre-wrap',
  }
}

/**
 * Samples the live row metrics needed to estimate unmounted rows: the body FontSpec, the text
 * content width, the rendered line box (WebKit floors line boxes; we read the real box), and the
 * per-shape chrome deltas (chrome = a mounted row's outer height minus its predicted text height).
 * Self-calibrating: density / character-scale / theme need no hardcoded tables. Returns a ref
 * (no re-render). Re-samples when the width signal fires or settings (fontSize / densityMode) change.
 */
export function useRowMetrics(scrollRef: React.RefObject<HTMLElement | null>): React.RefObject<RowEstimatorContext> {
  const ctxRef = useRef<RowEstimatorContext>(ROW_METRICS_FALLBACK)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const densityMode = useSettingsStore((s) => s.densityMode)

  const sample = useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    const textEl = root.querySelector<HTMLElement>('[data-msg-text]')
    if (!textEl) return // nothing mounted yet; keep current/fallback
    const fontSpec = fontSpecFrom(textEl)
    const contentWidthPx = textEl.clientWidth || ctxRef.current.contentWidthPx

    // Real rendered line box: a one-line text node's height, else floor(lineHeight).
    const oneLine = root.querySelector<HTMLElement>('[data-msg-text]')
    const measuredBox = oneLine ? Math.round(oneLine.getBoundingClientRect().height) : 0
    const lineBoxPx = measuredBox > 0 && measuredBox <= Math.ceil(fontSpec.lineHeightPx)
      ? measuredBox
      : Math.floor(fontSpec.lineHeightPx)

    // Chrome deltas: outer row height minus predicted text height for a header and a continuation row.
    const chrome: RowChrome = { ...ctxRef.current.chrome }
    const measureChromeFor = (shape: 'header' | 'cont'): number | null => {
      const rowEl = root.querySelector<HTMLElement>(`[data-msg-chrome="${shape}"]`)
      const t = rowEl?.querySelector<HTMLElement>('[data-msg-text]')
      if (!rowEl || !t) return null
      const outer = rowEl.getBoundingClientRect().height
      const predicted = predictMessageTextHeight(t.textContent ?? '', contentWidthPx, fontSpec, lineBoxPx).heightPx
      return Math.max(0, Math.round(outer - predicted))
    }
    const h = measureChromeFor('header'); if (h != null) chrome.header = h
    const c = measureChromeFor('cont'); if (c != null) chrome.continuation = c
    const dateEl = root.querySelector<HTMLElement>('[data-row-kind="date"]')
    if (dateEl) chrome.date = Math.round(dateEl.getBoundingClientRect().height)
    const footEl = root.querySelector<HTMLElement>('[data-row-kind="footer"]')
    if (footEl) chrome.footer = Math.round(footEl.getBoundingClientRect().height)

    ctxRef.current = { fontSpec, contentWidthPx, lineBoxPx, chrome }
  }, [scrollRef])

  // Re-sample after layout settles on width changes (debounced signal) and on settings changes.
  useRemeasureOnWidthChange(sample)
  useEffect(() => {
    const id = requestAnimationFrame(() => sample())
    return () => cancelAnimationFrame(id)
  }, [sample, fontSize, densityMode])

  return ctxRef
}
```
Notes for the implementer: this hook reads the DOM and is exercised for real only in a browser; jsdom returns 0 widths so it keeps the fallback context (which is exactly the tested contract). `data-row-kind` on date/header/footer rows is added in Task 6 when the estimator is wired (the date separator wrapper, the load-earlier/history header wrapper, and the footer wrapper). Until then `chrome.date`/`chrome.footer` use the fallback.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/useRowMetrics.test.tsx
```
Expected: PASS (fallback returned under jsdom; settings changes do not throw).

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/fluux && npm run typecheck
git add apps/fluux/src/components/conversation/useRowMetrics.ts apps/fluux/src/components/conversation/useRowMetrics.test.tsx apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/conversation/MessageBody.tsx
git commit -m "feat(virtualizer): useRowMetrics live sampler (font/width/line-box/chrome)"
```

---

### Task 6: Wire the estimator into MessageList behind the flag

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` (the `useTanstackMessageVirtualizer` call ~line 229; add `data-row-kind` to the date/header/footer wrappers in the windowed render path)
- Modify: `apps/fluux/src/components/conversation/MessageList.virtualized.test.tsx`

**Interfaces:**
- Consumes: `useRowMetrics` (Task 5), `estimateRowHeight` (Task 3), the per-index `estimateSize` arg (Task 4), `isFeatureEnabled('enableMessageVirtualization')`.
- Produces: when virtualization is on, the virtualizer is constructed with an `estimateSize` function that calls `estimateRowHeight(virtualItems[index], rowMetricsRef.current)`.

- [ ] **Step 1: Write the failing test**

In `MessageList.virtualized.test.tsx`, add a test that the virtualized MessageList passes a FUNCTION `estimateSize` to the adapter (not the default constant). Mock `useTanstackMessageVirtualizer` (the test already mocks @tanstack; mock the adapter module here) to capture its args and assert `typeof args.estimateSize === 'function'`, and that calling it for a date item index returns the date chrome fallback (48) under jsdom:
```tsx
it('passes a per-index estimateSize function when virtualized', () => {
  const captured = renderVirtualizedMessageListAndCaptureAdapterArgs(/* helper below */)
  expect(typeof captured.estimateSize).toBe('function')
})
```
Add `renderVirtualizedMessageListAndCaptureAdapterArgs` next to the file's existing mocks: `vi.mock('./tanstackMessageVirtualizer', ...)` capturing the args object into a module variable, returning a minimal stub `MessageVirtualizer` (getVirtualItems: () => [], getTotalSize: () => 0, itemCount: 0, getOffsetForMessageId: () => null, ensureMessageMounted: async () => {}, measureElement: () => {}, scrollToOffset: () => {}, scrollToIndex: () => {}).

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/MessageList.virtualized.test.tsx
```
Expected: FAIL — the current call passes no `estimateSize`, so the captured value is `undefined`, not a function.

- [ ] **Step 3: Wire the estimator**

In `MessageList.tsx`, near the other hooks, add:
```ts
import { useRowMetrics } from './useRowMetrics'
import { estimateRowHeight } from './rowHeightEstimator'
// ...
const rowMetricsRef = useRowMetrics(scrollContainerRef)
const estimateSize = useCallback(
  (index: number) => estimateRowHeight(virtualItems[index], rowMetricsRef.current),
  [virtualItems, rowMetricsRef],
)
```
Change the adapter call (line 229) to:
```ts
const virtualizer = useTanstackMessageVirtualizer({ items: virtualItems, indexById, scrollRef: scrollContainerRef, estimateSize })
```
In the windowed render path, add `data-row-kind="date"` to the date-separator wrapper, `data-row-kind="header"` to the load-earlier/history-start header wrapper, and `data-row-kind="footer"` to the footer wrapper, so `useRowMetrics` can sample their heights. (These are inert attributes.)

Guard: `estimateRowHeight` and `useRowMetrics` must only run on the virtualized path. They are cheap and safe to call unconditionally (the ref-based hook returns the fallback when nothing is mounted), but pass the `estimateSize` to the adapter only when `virtualized` is true; when not virtualized the adapter is not used. Since the adapter is always constructed in this component, always pass `estimateSize` — it is ignored by the non-virtualized render path.

- [ ] **Step 4: Run the test to verify it passes; then the broader scroll suites**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/MessageList.virtualized.test.tsx
cd apps/fluux && npx vitest run src/components/conversation/MessageList.virtualizedScroll.test.tsx src/components/conversation/MessageList.scroll.test.tsx src/components/conversation/tanstackMessageVirtualizer.test.tsx
```
Expected: PASS — the new estimate is a function; the existing scroll/offset suites still pass (they assert offset stability and restoration, which the better estimate does not regress; under jsdom the estimator returns fallback chrome so getTotalSize stays finite and stable).

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
cd apps/fluux && npm run typecheck && npm run lint
git add apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/components/conversation/MessageList.virtualized.test.tsx
git commit -m "feat(virtualizer): drive estimateSize from pretext per-item estimator (flag-gated)"
```

---

### Task 7: Persistent measured-height cache across remounts

**Files:**
- Create: `apps/fluux/src/components/conversation/messageHeightCache.ts`
- Create: `apps/fluux/src/components/conversation/messageHeightCache.test.ts`
- Modify: `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts` (seed `initialMeasurementsCache`; write measured sizes back to the cache)
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` (pass a cache scoped to the active conversation + width bucket + scale)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function heightCacheKey(messageId: string, widthBucketPx: number, scalePct: number): string`
  - `export function getCachedHeights(conversationId: string): Map<string, number>`  (module-level LRU per conversation)
  - `export function recordMeasuredHeight(conversationId: string, key: string, px: number): void`
  - Adapter gains optional `initialMeasurements?: { index: number; size: number }[]` and an `onMeasured?: (key: string, size: number) => void` passthrough.

Rationale: @tanstack caches measured heights by item key for the SESSION, but the cache is lost when `MessageList` unmounts (conversation switch) and on a fresh windowing. Re-entering a conversation then re-snaps from estimates, which is exactly the "jumpy when scrolling back in a room you just opened" symptom. A module-level cache keyed by `messageId + widthBucket + scale` survives the remount and seeds @tanstack so resident rows start at their real height (no snap).

- [ ] **Step 1: Write the failing test (pure cache)**

Create `apps/fluux/src/components/conversation/messageHeightCache.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { heightCacheKey, getCachedHeights, recordMeasuredHeight, __clearHeightCache } from './messageHeightCache'

beforeEach(() => __clearHeightCache())

describe('messageHeightCache', () => {
  it('keys by message id + width bucket + scale', () => {
    expect(heightCacheKey('m1', 560, 100)).toBe('m1@560@100')
    expect(heightCacheKey('m1', 560, 125)).not.toBe(heightCacheKey('m1', 560, 100))
  })
  it('records and reads back a measured height per conversation', () => {
    recordMeasuredHeight('conv1', heightCacheKey('m1', 560, 100), 84)
    expect(getCachedHeights('conv1').get('m1@560@100')).toBe(84)
    expect(getCachedHeights('conv2').get('m1@560@100')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/messageHeightCache.test.ts
```
Expected: FAIL with "Cannot find module './messageHeightCache'".

- [ ] **Step 3: Implement the cache**

Create `apps/fluux/src/components/conversation/messageHeightCache.ts`:
```ts
const MAX_CONVERSATIONS = 8
const MAX_ENTRIES_PER_CONVERSATION = 6000

const cache = new Map<string, Map<string, number>>() // conversationId -> (key -> px)

export function heightCacheKey(messageId: string, widthBucketPx: number, scalePct: number): string {
  return `${messageId}@${widthBucketPx}@${scalePct}`
}

export function getCachedHeights(conversationId: string): Map<string, number> {
  let m = cache.get(conversationId)
  if (!m) { m = new Map(); cache.set(conversationId, m) }
  // simple LRU: re-insert to mark most-recently-used
  cache.delete(conversationId); cache.set(conversationId, m)
  while (cache.size > MAX_CONVERSATIONS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return m
}

export function recordMeasuredHeight(conversationId: string, key: string, px: number): void {
  if (!(px > 0)) return
  const m = getCachedHeights(conversationId)
  if (m.size >= MAX_ENTRIES_PER_CONVERSATION && !m.has(key)) {
    const oldest = m.keys().next().value
    if (oldest !== undefined) m.delete(oldest)
  }
  m.set(key, px)
}

/** Test-only reset. */
export function __clearHeightCache(): void { cache.clear() }
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/components/conversation/messageHeightCache.test.ts
```
Expected: PASS.

- [ ] **Step 5: Seed + write-through in the adapter and MessageList**

In `tanstackMessageVirtualizer.ts`, extend `Args` with `initialMeasurements?: ReadonlyMap<string, number>` (keyed by item key = message id) and pass @tanstack `initialMeasurementsCache` built from it (map each known key to a `{ key, index, size, start, end }` measurement, or use @tanstack's documented `initialMeasurementsCache` shape for v3 — an array of `VirtualItem`-like entries; build it from `items` + the map). Wrap `measureElement` so each measured size is reported via a new optional `onMeasured?: (key: string, size: number) => void` arg.

In `MessageList.tsx`, compute `widthBucketPx = Math.round(rowMetricsRef.current.contentWidthPx / 20) * 20` and `scalePct = useSettingsStore(s => s.fontSize)`, build `initialMeasurements` from `getCachedHeights(activeConversationId)` filtered to current item keys (translating `messageId@bucket@scale` -> messageId), and pass `onMeasured={(key, size) => recordMeasuredHeight(activeConversationId, heightCacheKey(key, widthBucketPx, scalePct), size)}`. Gate all of this on the virtualization flag.

Verify the adapter unit tests + scroll suites still pass:
```bash
cd apps/fluux && npx vitest run src/components/conversation/tanstackMessageVirtualizer.test.tsx src/components/conversation/MessageList.virtualizedScroll.test.tsx
```
Expected: PASS. (Cache seeding is additive; with an empty cache behavior is unchanged.)

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
cd apps/fluux && npm run typecheck && npm run lint
git add apps/fluux/src/components/conversation/messageHeightCache.ts apps/fluux/src/components/conversation/messageHeightCache.test.ts apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts apps/fluux/src/components/conversation/MessageList.tsx
git commit -m "feat(virtualizer): persistent measured-height cache seeds the virtualizer on remount"
```

---

### Task 8: Verification on real engines

**Files:**
- Modify: `docs/superpowers/spikes/2026-06-27-pretext-height-results.md` (append an "Implementation verification" section)

**Interfaces:** none (verification only).

- [ ] **Step 1: Full unit suite + typecheck + lint clean**

Run:
```bash
cd apps/fluux && npm run typecheck && npm run lint && npx vitest run src/components/conversation src/utils/messageHeight
```
Expected: all green, output pristine. Record the counts.

- [ ] **Step 2: Re-run the spike accuracy oracle (Chromium) against the shipping util**

The spike oracle measures pretext accuracy independent of the integration; confirm the promoted util did not regress it. With the dev server running:
```bash
cd apps/fluux && npm run dev   # background
cd apps/fluux && node scripts/pretext-spike-check.mjs
```
Expected: PASS across all 4 scales (in-scope categories), matching `results/chromium.json`.

- [ ] **Step 3: Real Tauri build (macOS WebKit) — confirm the jitter is gone and getTotalSize is realistic**

Enable the flag (`localStorage 'fluux:enableMessageVirtualization' = 'true'` or the app's flag toggle), `npm run tauri:dev`, open a long conversation/room, and:
- Scroll back (load older) at speed and confirm the view no longer jumps/bounces on prepend (compare against the flag-off path).
- Switch away and re-enter the conversation; confirm scroll-back is smooth immediately (cache seeding — no re-snap).
- Toggle density (comfortable/compact) and character scale (Appearance settings) and confirm rows are still correctly sized (self-calibrating chrome + live font sample).
- Grep `~/Library/Logs/com.processone.fluux/` for `[ScrollReassertLoop]` overlap/non-converging warnings during fast scroll-back; expect none (the estimate no longer drives the chase loop).

- [ ] **Step 4: Record results and decide**

Append an "Implementation verification" section to the decision doc with: unit counts, the Chromium oracle result, and the real-engine observations (jitter gone? cache re-entry smooth? density/scale correct? reassert-loop warnings?). If a real-engine issue appears (e.g. WebKit line-box assumption off, chrome sampling mis-bucketed), file it as a follow-up rather than reverting the flag-gated work.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/spikes/2026-06-27-pretext-height-results.md
git commit -m "docs(virtualizer): record pretext-estimate implementation verification"
```

---

## Self-Review

**Spec coverage:**
- Replace flat estimate with pretext per-item estimate → Tasks 1, 3, 4, 6.
- Engine line-box rounding (WebKit floor) → Task 1 (`lineBoxPx` param) + Task 5 (sample real box).
- Character-scale + density robustness (predictor reads live metrics) → Task 5 (`useRowMetrics` invalidates on `fontSize`/`densityMode`); self-calibrating chrome avoids the manual matrix.
- Reserved space for code/media → Task 2 (classifier) + Task 3 (`RESERVED_*`).
- Grouping-aware chrome (header vs continuation, new-marker, reactions) → Task 3 + Task 5 sampling by `data-msg-chrome`.
- Persistent height cache (re-entry without re-snap) → Task 7.
- Flag-gated, flag-off byte-identical → Global Constraints + Tasks 4/6/7 gating.
- Verification incl. real engine + spike oracle + reassert-loop check → Task 8.
- Cap removal is explicitly OUT of this plan (a follow-on once the estimate is trusted; noted in project memory `project_message_virtualization_flip`).

**Placeholder scan:** Pure modules (Tasks 1-4, 7-cache) carry complete code and real tests. The integration tasks (5, 6, 7-seed) carry concrete code with real selectors/refs; their layout-dependent behavior is verified by the jsdom contract tests + the Task 8 real-engine pass, which is called out honestly rather than faked, because jsdom has no layout and the preview cannot run rAF.

**Type consistency:** `FontSpec`/`MessagePrediction` (Task 1) are consumed unchanged in Tasks 3 and 5. `RowChrome`/`RowEstimatorContext` (Task 3) are produced by Task 5 and consumed by Task 6. `estimateRowHeight` signature is identical at definition (Task 3) and call site (Task 6). The adapter's `estimateSize` function form (Task 4) is what Task 6 passes. `heightCacheKey`/`getCachedHeights`/`recordMeasuredHeight` (Task 7) are used consistently in the same task's MessageList wiring.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-pretext-virtualizer-estimate.md`.
