# Message-View Virtualization Implementation Plan

> **Status: implemented and enabled by default since Fluux 0.17.0 (2026-07-06).** This file is retained as a historical implementation plan; unchecked boxes below do not represent outstanding product work. The current implementation lives in `apps/fluux/src/components/conversation/MessageList.tsx`, `tanstackMessageVirtualizer.ts`, and `apps/fluux/src/utils/featureFlags.ts`.

> **Historical execution note:** This plan originally required `superpowers:subagent-driven-development` or `superpowers:executing-plans` and used checkbox (`- [ ]`) syntax for task tracking. It should not be executed again.

**Goal:** Render only the visible window of the message list so a large room mounts ≤ ~60 rows instead of up to 1000, eliminating the WebKitGTK switch freeze and sustained-scroll jank, with zero scroll-behavior regression.

**Architecture:** A small `MessageVirtualizer` interface hands the scroll hook the facts it reads from the DOM today (`getOffsetForMessageId`, `ensureMessageMounted`, `getTotalSize`, the visible window) for mounted *and* unmounted rows. It is implemented with `@tanstack/react-virtual` (validated on the occupant panel), gated by a spike that proves prepend-anchoring + jump-to-unmounted + stick-to-bottom on both engines; a red spike swaps only the adapter to a custom implementation behind the same interface. The content wrapper's height equals `getTotalSize()`, so the scroll container's native `scrollHeight` is unchanged and every `scrollHeight`-based behavior keeps working untouched.

**Tech Stack:** React + TypeScript, `@tanstack/react-virtual` (already a dependency), Vitest + happy-dom/jsdom, the demo perf harness (`perfHarness.ts`), Vite.

## Global Constraints

- **Feature flag (historical rollout):** `enableMessageVirtualization` started **default OFF** while both render paths coexisted. It is now **default ON**; static rendering and explicit opt-out still use the non-virtualized path.
- **Two-platform gate:** every phase verified on macOS (WKWebView) **and** Linux (WebKitGTK) before merge. macOS catches correctness/alignment regressions; Linux confirms the perf win.
- **Node-count target:** switching into a 1000-message room mounts **≤ ~60 `.message-row`** (count rows via `.message-row` — `data-message-id` appears ~2×/msg).
- **Zero regression** on the six scroll behaviors: stick-to-bottom, MAM prepend anchor, jump (reply/target/marker/find), bottom-anchor capture (1e), read marker, multi-message copy.
- **Alignment lives in `messageScrollAlignment.ts`** (pure, tested) — no scattered magic numbers; anchor on **measured** offsets, never estimated.
- **Commit hygiene (CLAUDE.md):** before each commit, unit tests pass with no stderr + typecheck + lint clean. Never include a Claude footer in commits or PRs.
- **Worktree note:** Phase 2 is app-only; if any SDK type changes, run `npm run build:sdk` then rsync `packages/fluux-sdk/dist/` to the main checkout before app typecheck.

---

## File Structure

- Create `apps/fluux/src/components/conversation/messageVirtualizer.ts` — the `MessageVirtualizer` interface + `MessageListItem` types.
- Create `apps/fluux/src/components/conversation/flattenMessageItems.ts` (+ `.test.ts`) — pure: groups → flat windowed index + id→index map.
- Create `apps/fluux/src/components/conversation/messageScrollAlignment.ts` (+ `.test.ts`) — pure scroll-position math.
- Create `apps/fluux/src/utils/featureFlags.ts` (+ `.test.ts`) — the `enableMessageVirtualization` flag.
- Create `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts` (+ `.test.tsx`) — the `@tanstack` adapter implementing the interface.
- Modify `apps/fluux/src/components/conversation/MessageList.tsx` — windowed render behind the flag.
- Modify `apps/fluux/src/components/conversation/useMessageListScroll.ts` — rebind the offset-dependent behaviors to the interface.
- Modify `apps/fluux/src/hooks/useViewportObserver.ts` — re-observe the mounted set on window change.
- Modify `apps/fluux/src/hooks/useMessageCopyFormatter.ts` — store-backed reconstruction for cross-window selections.
- Modify `apps/fluux/src/demo/perfHarness.ts` + `packages/fluux-sdk/src/stores/RENDER_PERF_TESTS.md` — node-count guard.

---

## Phase 2.0 — Foundations + spike gate (detailed below)

Tasks 1–5 are fully specified. They are impl-agnostic except Task 4 (the `@tanstack` adapter), which Task 5's gate validates.

---

### Task 1: `MessageVirtualizer` interface + `flattenMessageItems`

**Files:**
- Create: `apps/fluux/src/components/conversation/messageVirtualizer.ts`
- Create: `apps/fluux/src/components/conversation/flattenMessageItems.ts`
- Test: `apps/fluux/src/components/conversation/flattenMessageItems.test.ts`

**Interfaces:**
- Consumes: `MessageGroup<T>` = `{ date: string; messages: T[] }` from `messageGrouping.ts`; `shouldShowAvatar` from the same file.
- Produces: `MessageVirtualizer` interface; `MessageListItem<T>` union; `flattenMessageItems(groups, opts) → { items: MessageListItem<T>[]; indexById: Map<string, number> }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/components/conversation/flattenMessageItems.test.ts
import { describe, it, expect } from 'vitest'
import { flattenMessageItems } from './flattenMessageItems'

const groups = [
  { date: '2026-06-22', messages: [{ id: 'a' }, { id: 'b' }] },
  { date: '2026-06-23', messages: [{ id: 'c' }] },
]

describe('flattenMessageItems', () => {
  it('emits a date item before each group, then one message item per message, in order', () => {
    const { items } = flattenMessageItems(groups, { showAvatar: () => true })
    expect(items.map(i => i.kind)).toEqual(['date', 'message', 'message', 'date', 'message'])
    expect(items.filter(i => i.kind === 'message').map(i => (i as any).message.id)).toEqual(['a', 'b', 'c'])
  })

  it('gives every item a unique stable key (message keys are the message id)', () => {
    const { items } = flattenMessageItems(groups, { showAvatar: () => true })
    const keys = items.map(i => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(items.find(i => i.kind === 'message' && (i as any).message.id === 'b')!.key).toBe('b')
  })

  it('maps message id → flat index for offset lookups', () => {
    const { indexById } = flattenMessageItems(groups, { showAvatar: () => true })
    expect(indexById.get('a')).toBe(1) // index 0 is the first date item
    expect(indexById.get('c')).toBe(4)
  })

  it('flags the first-new-message row only', () => {
    const { items } = flattenMessageItems(groups, { showAvatar: () => true, firstNewMessageId: 'b' })
    const flagged = items.filter(i => i.kind === 'message' && (i as any).isFirstNew)
    expect(flagged).toHaveLength(1)
    expect((flagged[0] as any).message.id).toBe('b')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/flattenMessageItems.test.ts`
Expected: FAIL — "Cannot find module './flattenMessageItems'".

- [ ] **Step 3: Write the interface**

```ts
// apps/fluux/src/components/conversation/messageVirtualizer.ts
export type MessageListItem<T extends { id: string }> =
  | { kind: 'date'; key: string; date: string }
  | { kind: 'message'; key: string; message: T; showAvatar: boolean; isFirstNew: boolean }

export interface VirtualWindowItem {
  index: number
  start: number
  size: number
  key: string
}

/** The facts the scroll hook needs about messages — for mounted AND unmounted rows. */
export interface MessageVirtualizer {
  getVirtualItems(): VirtualWindowItem[]
  /** Stable estimated total height (== the scroll container's scrollHeight). */
  getTotalSize(): number
  /** Offset (px from content top) of a message by id, mounted or not. null if unknown. */
  getOffsetForMessageId(id: string): number | null
  /** Expand the rendered window so the row for `id` is mounted on the next commit. */
  ensureMessageMounted(id: string): Promise<void>
  /** measureElement ref for each mounted row (measures + caches real height). */
  measureElement: (el: Element | null) => void
}
```

- [ ] **Step 4: Write the flatten implementation**

```ts
// apps/fluux/src/components/conversation/flattenMessageItems.ts
import type { MessageListItem } from './messageVirtualizer'
import type { MessageGroup } from './messageGrouping'

interface FlattenOpts<T> {
  firstNewMessageId?: string
  showAvatar: (groupMessages: T[], index: number) => boolean
}

export function flattenMessageItems<T extends { id: string }>(
  groups: MessageGroup<T>[],
  opts: FlattenOpts<T>,
): { items: MessageListItem<T>[]; indexById: Map<string, number> } {
  const items: MessageListItem<T>[] = []
  const indexById = new Map<string, number>()
  for (const group of groups) {
    items.push({ kind: 'date', key: `date:${group.date}`, date: group.date })
    group.messages.forEach((message, i) => {
      indexById.set(message.id, items.length)
      items.push({
        kind: 'message',
        key: message.id,
        message,
        showAvatar: opts.showAvatar(group.messages, i),
        isFirstNew: message.id === opts.firstNewMessageId,
      })
    })
  }
  return { items, indexById }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/flattenMessageItems.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd apps/fluux && npx tsc --noEmit && npx eslint src/components/conversation/flattenMessageItems.ts src/components/conversation/flattenMessageItems.test.ts src/components/conversation/messageVirtualizer.ts
cd ../.. && git add apps/fluux/src/components/conversation/messageVirtualizer.ts apps/fluux/src/components/conversation/flattenMessageItems.ts apps/fluux/src/components/conversation/flattenMessageItems.test.ts
git commit -m "feat(perf): MessageVirtualizer interface + flattenMessageItems"
```

---

### Task 2: `messageScrollAlignment` (pure scroll math)

**Files:**
- Create: `apps/fluux/src/components/conversation/messageScrollAlignment.ts`
- Test: `apps/fluux/src/components/conversation/messageScrollAlignment.test.ts`

**Interfaces:**
- Produces: `anchorBottomScrollTop(offset, size, bottomGap, clientHeight)`, `markerScrollTop(offset, clientHeight)`, `prependAnchorScrollTop(newOffset, savedOffsetFromTop)` — all `=> number`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/components/conversation/messageScrollAlignment.test.ts
import { describe, it, expect } from 'vitest'
import { anchorBottomScrollTop, markerScrollTop, prependAnchorScrollTop } from './messageScrollAlignment'

describe('messageScrollAlignment', () => {
  it('anchorBottomScrollTop puts the anchor bottom at its saved gap from the viewport bottom', () => {
    // anchor at offset 1000, height 40, was 12px above the viewport bottom, viewport 800 tall
    expect(anchorBottomScrollTop(1000, 40, 12, 800)).toBe(1000 + 40 + 12 - 800) // 252
  })

  it('markerScrollTop places the target ~1/3 from the top, clamped at 0', () => {
    expect(markerScrollTop(900, 600)).toBe(900 - 200) // 700
    expect(markerScrollTop(50, 600)).toBe(0)          // clamped
  })

  it('prependAnchorScrollTop keeps the anchor at the same offset-from-top after prepend', () => {
    expect(prependAnchorScrollTop(1500, 120)).toBe(1380)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/messageScrollAlignment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/fluux/src/components/conversation/messageScrollAlignment.ts
/** Scroll-position math for the message list. Pure (no DOM) so it is unit-testable
 *  and tunable without a live build. All inputs are pixels; offsets must come from
 *  MEASURED row positions (never estimated) to avoid micro-jumps. */

/** scrollTop that puts the anchor message's bottom at `bottomGap` px above the viewport bottom. */
export function anchorBottomScrollTop(offset: number, size: number, bottomGap: number, clientHeight: number): number {
  return offset + size + bottomGap - clientHeight
}

/** scrollTop that shows the target ~1/3 down from the viewport top, clamped at 0. */
export function markerScrollTop(offset: number, clientHeight: number): number {
  return Math.max(0, offset - clientHeight / 3)
}

/** scrollTop that keeps a prepend anchor at the same offset-from-top it had before the prepend. */
export function prependAnchorScrollTop(newOffset: number, savedOffsetFromTop: number): number {
  return newOffset - savedOffsetFromTop
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/messageScrollAlignment.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/fluux && npx tsc --noEmit && npx eslint src/components/conversation/messageScrollAlignment.ts src/components/conversation/messageScrollAlignment.test.ts
cd ../.. && git add apps/fluux/src/components/conversation/messageScrollAlignment.ts apps/fluux/src/components/conversation/messageScrollAlignment.test.ts
git commit -m "feat(perf): pure scroll-alignment math module"
```

---

### Task 3: `enableMessageVirtualization` feature flag

**Files:**
- Create: `apps/fluux/src/utils/featureFlags.ts`
- Test: `apps/fluux/src/utils/featureFlags.test.ts`

**Interfaces:**
- Produces: `isFeatureEnabled(flag: 'enableMessageVirtualization'): boolean`. Reads `localStorage['fluux:flags:<flag>'] === 'true'`; defaults to `false`. Safe when `localStorage` is unavailable.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/utils/featureFlags.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { isFeatureEnabled } from './featureFlags'

describe('isFeatureEnabled', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to false when the flag is unset', () => {
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(false)
  })

  it('is true only when the stored value is exactly "true"', () => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(true)
    localStorage.setItem('fluux:flags:enableMessageVirtualization', '1')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/featureFlags.test.ts` — FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// apps/fluux/src/utils/featureFlags.ts
export type FeatureFlag = 'enableMessageVirtualization'

/** Dev/bake feature flags, persisted in localStorage (`fluux:flags:<flag>`).
 *  Default OFF. Flip on for a session with:
 *    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true') */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  try {
    return localStorage.getItem(`fluux:flags:${flag}`) === 'true'
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/utils/featureFlags.test.ts` → PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/fluux && npx tsc --noEmit && npx eslint src/utils/featureFlags.ts src/utils/featureFlags.test.ts
cd ../.. && git add apps/fluux/src/utils/featureFlags.ts apps/fluux/src/utils/featureFlags.test.ts
git commit -m "feat(perf): enableMessageVirtualization feature flag (default off)"
```

---

### Task 4: `@tanstack` adapter implementing `MessageVirtualizer`

**Files:**
- Create: `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts`
- Test: `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.test.tsx`

**Interfaces:**
- Consumes: `MessageVirtualizer`, `MessageListItem` (Task 1); `useVirtualizer` from `@tanstack/react-virtual`.
- Produces: `useTanstackMessageVirtualizer<T>(args) → MessageVirtualizer`, where `args = { items: MessageListItem<T>[]; indexById: Map<string, number>; scrollRef: React.RefObject<HTMLElement | null>; estimateSize?: number }`.

**Key design notes for the implementer:**
- `getOffsetForMessageId` reads `virtualizer.measurements[index].start` — this exists for **all** items (measured rows use their real size, unmeasured use `estimateSize`), so offsets are available **without mounting** the row. This is why the interface can serve unmounted rows.
- `ensureMessageMounted` uses `virtualizer.scrollToIndex(index, { align: 'center' })` to bring a far row into the rendered range, then resolves after a `requestAnimationFrame` (the commit that mounts it). Callers that only need the offset should call `getOffsetForMessageId` directly and skip this.
- `getItemKey: (i) => items[i].key` keeps the measurement cache bound to the message id, surviving prepend index-shift. This is the property Task 5's spike stresses.

- [ ] **Step 1: Write the failing test (structure, with a render-all mock)**

```tsx
// apps/fluux/src/components/conversation/tanstackMessageVirtualizer.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import type { MessageListItem } from './messageVirtualizer'

// Render-all mock (jsdom has no layout): expose offsets from a fixed row height.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey: (i: number) => string }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({ index, key: opts.getItemKey(index), start: index * 40, size: 40 })),
    getTotalSize: () => opts.count * 40,
    measurements: Array.from({ length: opts.count }, (_, index) => ({ index, start: index * 40, size: 40, key: opts.getItemKey(index) })),
    measureElement: () => {},
    scrollToIndex: vi.fn(),
  }),
}))

function makeItems(ids: string[]): { items: MessageListItem<{ id: string }>[]; indexById: Map<string, number> } {
  const items: MessageListItem<{ id: string }>[] = ids.map(id => ({ kind: 'message', key: id, message: { id }, showAvatar: true, isFirstNew: false }))
  return { items, indexById: new Map(ids.map((id, i) => [id, i])) }
}

describe('useTanstackMessageVirtualizer', () => {
  it('exposes the window, total size, and per-id offsets (mounted or not)', () => {
    const { items, indexById } = makeItems(['a', 'b', 'c'])
    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLElement | null>(null)
      return useTanstackMessageVirtualizer({ items, indexById, scrollRef })
    })
    expect(result.current.getTotalSize()).toBe(120)
    expect(result.current.getVirtualItems().map(v => v.key)).toEqual(['a', 'b', 'c'])
    expect(result.current.getOffsetForMessageId('c')).toBe(80)
    expect(result.current.getOffsetForMessageId('missing')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Write the adapter**

```ts
// apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts
import { useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MessageListItem, MessageVirtualizer } from './messageVirtualizer'

interface Args<T extends { id: string }> {
  items: MessageListItem<T>[]
  indexById: Map<string, number>
  scrollRef: React.RefObject<HTMLElement | null>
  estimateSize?: number
}

export function useTanstackMessageVirtualizer<T extends { id: string }>({
  items, indexById, scrollRef, estimateSize = 64,
}: Args<T>): MessageVirtualizer {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => items[index].key,
    overscan: 12,
  })

  const getOffsetForMessageId = useCallback((id: string): number | null => {
    const index = indexById.get(id)
    if (index == null) return null
    return virtualizer.measurements[index]?.start ?? null
  }, [indexById, virtualizer])

  const ensureMessageMounted = useCallback((id: string): Promise<void> => {
    const index = indexById.get(id)
    if (index == null) return Promise.resolve()
    virtualizer.scrollToIndex(index, { align: 'center' })
    return new Promise(resolve => requestAnimationFrame(() => resolve()))
  }, [indexById, virtualizer])

  return {
    getVirtualItems: () => virtualizer.getVirtualItems().map(v => ({ index: v.index, start: v.start, size: v.size, key: String(v.key) })),
    getTotalSize: () => virtualizer.getTotalSize(),
    getOffsetForMessageId,
    ensureMessageMounted,
    measureElement: virtualizer.measureElement,
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/components/conversation/tanstackMessageVirtualizer.test.tsx` → PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/fluux && npx tsc --noEmit && npx eslint src/components/conversation/tanstackMessageVirtualizer.ts src/components/conversation/tanstackMessageVirtualizer.test.tsx
cd ../.. && git add apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts apps/fluux/src/components/conversation/tanstackMessageVirtualizer.test.tsx
git commit -m "feat(perf): @tanstack adapter implementing MessageVirtualizer"
```

---

### Task 5: Spike — prove the hard cases on both engines (DECISION GATE)

This is a measured experiment, not a unit-tested deliverable. It validates that the Task 4 adapter survives the cases that killed react-virtuoso, **before** any integration. It is throwaway: the spike route is removed at the end.

**Files:**
- Create (throwaway): a spike entry behind the demo, e.g. `apps/fluux/src/demo/virtualizationSpike.tsx`, mounting a windowed list of N=1000 seeded messages using `useTanstackMessageVirtualizer` + the render block from the spec, with buttons to: prepend 100 older, jump to message #5, and toggle a tall media row.

- [ ] **Step 1: Build the spike harness**

Render the windowed list (spacer = `getTotalSize()`, absolute rows at `translateY(start)`, `ref={measureElement}`, `data-message-id`) over 1000 fake messages of varied heights. Wire three controls: `prependOlder()` (unshift 100 items, keep `getItemKey`), `jumpTo('msg-5')` (`await ensureMessageMounted` → set `scrollTop = markerScrollTop(getOffsetForMessageId('msg-5'), clientHeight)`), `toggleTallRow()` (flip one row's height to simulate image load).

- [ ] **Step 2: Run the acceptance checks on macOS (WKWebView via `npm run tauri:dev`, and web)**

Record for each: PASS/FAIL + pixel delta.
1. **Prepend anchor:** scroll up to msg ~200, `prependOlder()` ×5. The row you were viewing must not move (delta ≤ 2px), including after the new rows measure (watch one extra frame).
2. **Jump to unmounted:** from the bottom (msg 1000), `jumpTo('msg-5')` lands msg-5 ~1/3 from top, aligned (delta ≤ 2px).
3. **Stick-to-bottom coexistence:** at bottom, append a message (set `scrollTop = scrollHeight`); it must stay pinned and not fight the virtualizer's scroll observation.
4. **Variable height:** `toggleTallRow()` on a visible row → no drift of rows above the viewport anchor.
5. **Node count:** mounted `.message-row` ≤ ~60 with 1000 items.

- [ ] **Step 3: Repeat Step 2 on Linux/WebKitGTK** (the freeze target). Additionally confirm the switch-mount no longer stalls (node count bounded).

- [ ] **Step 4: DECISION GATE**

- **All green on both engines** → keep the `@tanstack` adapter; proceed to Phase 2.1 (Tasks 6–11).
- **Any red** → the adapter is swapped for a **custom implementation behind the same `MessageVirtualizer` interface** (custom height-map + window + spacer + `measurements`-equivalent). Tasks 6–11 are unchanged (they consume the interface). Record which case failed and why in this plan before swapping.

- [ ] **Step 5: Remove the spike harness, commit the findings note**

```bash
git rm apps/fluux/src/demo/virtualizationSpike.tsx
# append a "## Spike results (2026-..)" section to the design spec with the gate outcome
git add docs/superpowers/specs/2026-06-23-message-view-virtualization-design.md
git commit -m "chore(perf): record virtualization spike results + remove harness"
```

---

## Phase 2.1+ — Integration (rooms-first, behind the flag)

> **Spike outcome (2026-06-23):** the `@tanstack` mechanism is validated (windowing + scroll tracking + anchor convergence; see the spec's "Spike results"). **Foundations landed** (commit `02881872`): the adapter is decoupled from item kinds (accepts `{ key }[]`), and `buildMessageListItems` produces the full `header/date/message/footer` item list + shifted `indexById`.
>
> **Verification reality:** the headless preview **cannot** faithfully exercise virtualized scroll (throttled rAF, no auto `scroll` on programmatic `scrollTop`). So Tasks 6–9 are structurally unit-testable (render-all mock + pure helpers), but their **real behavior must be verified on a real engine** — open `/spike.html`-style flows or the flagged build in macOS `tauri:dev` and the Linux/WebKitGTK build. Land behind the OFF flag; flip only after the real-engine pass (Task 11).

### Task 6: Windowed render in `MessageList` behind the flag

- [x] **6a — Adapter decouple + `buildMessageListItems`** (done, `02881872`).
- [ ] **6b — Carry group context on the message item.** `renderMessage(msg, idx, groupMessages, showNewMarker, onMediaLoad)` needs the per-group index + array, which flattening drops. Extend `MessageListItem`'s `message` kind in `messageVirtualizer.ts` with `indexInGroup: number; groupMessages: T[]`, and set them in `flattenMessageItems.ts` (the `forEach` already has `i` and `group.messages`). Extend `flattenMessageItems.test.ts` to assert both. (TDD; pure.)
- [ ] **6c — Precompute the gap-marker id.** The current per-group `showGapMarker` (MessageList ~300–307) reduces to "the first chronological message with `timestamp > forwardGapTimestamp`". In `MessageList`, `const gapMarkerMessageId = useMemo(...)` scanning `groupedMessages` in order; `undefined` when `!forwardGapTimestamp || !onCatchUpHistory`.
- [ ] **6d — `renderItem(item: RenderItem<T>)` in `MessageList`.** Faithful extraction of the current JSX by kind: `header` → the `HistoryStartMarker`/load-earlier block (~264–286); `date` → `<div data-date-separator><DateSeparator/></div>`; `message` → the `message-row` (`data-message-id/stanza-id/origin-id`, `lastSentMessageId` animation) with `HistoryGapMarker` when `item.message.id === gapMarkerMessageId`, `NewMessageMarker` when `item.isFirstNew`, then `renderMessage(item.message, item.indexInGroup, item.groupMessages, item.isFirstNew, handleMediaLoad)`; `footer` → `extraContent` + the typing-indicator div.
- [ ] **6e — Flag-gated render.** `const virtualized = isFeatureEnabled('enableMessageVirtualization') && !staticMode`. Build items + call `useTanstackMessageVirtualizer` **unconditionally** (hooks rule), feeding `items: []` when not virtualized (inert). When virtualized, the content wrapper becomes the spacer (`height: getTotalSize()`, relative) and renders `getVirtualItems().map(v => <div key data-index ref={measureElement} style={absolute, translateY(start)}>{renderItem(items[v.index])}</div>)`; else the current full-mount path (now also routed through `renderItem` for DRY).
- [ ] **6f — Verify.** Flag OFF (default): the existing `MessageList` tests pass unchanged. Flag ON with `vi.mock('@tanstack/react-virtual')` render-all: a structural test asserts header + dated rows + footer render with correct `data-message-id`s. **Real scroll behavior → real-engine pass (Task 11), behind the flag.**

### Task 7: Rebind `useMessageListScroll` to the interface

- [ ] **7a — Optional `virtualizer?: MessageVirtualizer` option.** When absent (flag OFF), every site below keeps its current DOM-reading branch — zero behavior change. When present, use the interface.
- [ ] **7b — Prepend restore** (`useLayoutEffect`, ~1032–1208): `virtualizer.getOffsetForMessageId(saved.anchorMessageId)` → `prependAnchorScrollTop(...)` for the immediate restore, then the **post-measure correction** in the existing 15-frame re-assert (the spike showed it converges in ~1 step; re-read the offset each frame until stable).
- [ ] **7c — Jump sites** — marker scroll (~825–862), target scroll (~932–968), `scrollToBottom` two-step (~434–447), and find-on-page scroll-to-match: `await virtualizer.ensureMessageMounted(id)` → `markerScrollTop(virtualizer.getOffsetForMessageId(id), clientHeight)`.
- [ ] **7d — Anchor capture** — `findBottomAnchor` (~55–78) and `findAnchorElement` (~462–518): read offsets from `virtualizer.getVirtualItems()` start offsets (the visible rows are mounted) instead of a full `querySelectorAll`.
- [ ] **7e — Verify.** Adapt `MessageList.scroll.test.tsx` to inject a fake `MessageVirtualizer`; assert computed `scrollTop` values come from `messageScrollAlignment`. **Real prepend/jump/switch pixel-accuracy → real-engine pass.**

### Task 8: Read-marker re-observe in `useViewportObserver`

- [ ] **8a** Read `useViewportObserver.ts`; make it re-run `observe()` over the currently-mounted `.message-row` set whenever the window changes (add the mounted set / a window-version as a dependency). Bottom-most-visible already runs over mounted rows; unmounted rows are off-viewport so they are correctly never "seen".
- [ ] **8b — Verify.** Existing read-marker tests pass. Real-engine: `lastSeenMessageId` advances while scrolling a virtualized big room; the unread marker clears.

### Task 9: Store-backed copy in `useMessageCopyFormatter`

- [ ] **9a — Pure helper `buildCopyText({ startId, endId, messages, format })`** (new, TDD): `messages.slice(indexOf(startId), indexOf(endId)+1)` joined via the existing per-message formatter. Unit test: ids + array → expected text.
- [ ] **9b** In `useMessageCopyFormatter` (resolves `startMessage`/`endMessage` via `.closest('[data-message-id]')`, ~50–154): when the span covers message ids whose intermediate rows are absent from the DOM, build the output via `buildCopyText` from the in-memory array; single-message / within-window selections keep the existing DOM path.
- [ ] **9c — Verify.** Helper unit test green. Real-engine: select top→bottom across an unmounted middle, copy, paste → full range present.

### Task 10: Node-count guard + perf-harness assertion

- [ ] **10a** Extend `apps/fluux/src/demo/perfHarness.ts` `measureSwitch` to report mounted `.message-row` count.
- [ ] **10b** Document the guard in `packages/fluux-sdk/src/stores/RENDER_PERF_TESTS.md`: "with the flag ON, switching into a 1000-msg room mounts ≤ ~60 `.message-row`".
- [ ] **10c — Verify** (real engine, flag ON): `await __perf.measureSwitch('stress-0@conference.fluux.chat')` → `messageRows ≤ ~60` (vs ~1000) — the measurement style that proved the occupant panel (32 / 501).

### Task 11: Two-platform real-engine pass, flip the flag, remove the old path

- [ ] **11a** With the flag ON, run all six behaviors on **macOS (WKWebView/`tauri:dev`)** and **Linux/WebKitGTK**: stick-to-bottom, prepend-anchor (no jump), jump/reply/marker, read marker, multi-message copy, switch-restore — plus confirm the **3 s switch freeze is gone** on Linux and node count is bounded.
- [ ] **11b** Flip `enableMessageVirtualization` default ON.
- [ ] **11c** After a bake period, delete the non-virtualized branch in `MessageList`, the flag, and the `/spike.html` harness; full app suite green.

---

## Self-Review

- **Spec coverage:** interface → Task 1; alignment module → Task 2; flag → Task 3; `@tanstack` impl → Task 4; spike gate + custom fallback → Task 5; windowed render → Task 6; six rebind points → Tasks 7 (prepend/jump/marker/anchor), 8 (read marker), 9 (copy); find-on-page scroll-to-match → folded into Task 7's jump rebind; node-count guard → Task 10; two-platform de-risking + flag flip → Tasks 5 & 11. All spec sections map to a task.
- **Placeholder scan:** Tasks 1–5 contain complete code + exact commands. Tasks 6–11 are intentionally outline-level pending the Task 5 gate (stated explicitly, with files/interfaces/verification), not vague TODOs.
- **Type consistency:** `MessageVirtualizer` methods (`getVirtualItems`/`getTotalSize`/`getOffsetForMessageId`/`ensureMessageMounted`/`measureElement`) are used identically in Tasks 4, 6, 7. `MessageListItem` kinds (`date`/`message`) match between Tasks 1 and 6. Alignment function names match between Tasks 2 and 7.
