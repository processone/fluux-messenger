# Floating Date Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While scrolling a conversation, show a centered floating "date pill" displaying the date of the topmost visible message, suppressed when the topmost element is itself a date separator, fading out shortly after scrolling stops.

**Architecture:** A pure function (`getTopVisibleDate`) derives the date from the virtualizer's current window + `scrollTop`. A self-contained `FloatingDateHeader` component owns its own passive scroll listener and `{ date, visible }` state, so `MessageList` never re-renders on scroll. `MessageList` renders the pill as an absolute overlay (same layer as the scroll-to-bottom FAB) only on the virtualized path.

**Tech Stack:** React, TypeScript, `@tanstack/react-virtual` (via the existing `MessageVirtualizer` adapter), Vitest (jsdom), Tailwind (`fluux-*` design tokens), i18n via `react-i18next` + existing `formatDateHeader`.

## Global Constraints

- Reuse `formatDateHeader(dateStr, t, lang)` from `apps/fluux/src/utils/dateFormat.ts` for the pill label — no new i18n keys. `lang = i18n.language.split('-')[0]`.
- No SDK changes. All work is under `apps/fluux/src/components/conversation/`.
- Pill styling reuses the FAB's tokens: `bg-fluux-float border border-fluux-border shadow-lg text-fluux-muted` (see `MessageList.tsx:691`).
- Render isolation is mandatory: scroll-driven state lives only inside `FloatingDateHeader`. `MessageList` must not call `setState` on scroll for this feature. The `getTopDate` callback passed to the component must have a stable identity (ref-backed) so the component's effect does not re-subscribe each render.
- Feature applies to the virtualized live view only. Not rendered when `staticMode` is true or on the non-virtualized legacy path.
- DOM/visibility tests MUST pin `// @vitest-environment jsdom` (the app default is happy-dom).
- Date strings are `yyyy-MM-dd` (the `date` field on `kind: 'date'` items).

---

### Task 1: Pure `getTopVisibleDate` function

**Files:**
- Create: `apps/fluux/src/components/conversation/getTopVisibleDate.ts`
- Test: `apps/fluux/src/components/conversation/getTopVisibleDate.test.ts`

**Interfaces:**
- Consumes: `RenderItem<T>` from `./messageListItems` (union with `{ kind: 'date'; date: string }`, `{ kind: 'message'; ... }`, `{ kind: 'header' }`, `{ kind: 'footer' }`); `VirtualWindowItem` from `./messageVirtualizer` (`{ index: number; start: number; size: number; key: string }`).
- Produces: `getTopVisibleDate<T extends { id: string }>(windowItems: VirtualWindowItem[], allItems: RenderItem<T>[], scrollTop: number): string | null`.

- [ ] **Step 1: Write the failing test**

```typescript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getTopVisibleDate } from './getTopVisibleDate'
import type { RenderItem } from './messageListItems'
import type { VirtualWindowItem } from './messageVirtualizer'

type Msg = { id: string }

// Build a flat item list: each entry is either a date or a message row.
function items(spec: Array<{ date: string } | { msg: string }>): RenderItem<Msg>[] {
  return spec.map((s) =>
    'date' in s
      ? ({ kind: 'date', key: `date:${s.date}`, date: s.date } as RenderItem<Msg>)
      : ({
          kind: 'message',
          key: s.msg,
          message: { id: s.msg },
          showAvatar: false,
          isFirstNew: false,
          indexInGroup: 0,
          groupMessages: [{ id: s.msg }],
        } as RenderItem<Msg>),
  )
}

// Window items with uniform 100px rows starting at 0.
function windowOf(all: RenderItem<Msg>[]): VirtualWindowItem[] {
  return all.map((it, index) => ({ index, start: index * 100, size: 100, key: it.key }))
}

describe('getTopVisibleDate', () => {
  it('returns the date of the topmost visible message', () => {
    const all = items([{ date: '2026-06-28' }, { msg: 'a' }, { msg: 'b' }, { msg: 'c' }])
    // scrollTop 250 → rows 0,1 fully above; topmost visible is index 2 (msg 'b')
    expect(getTopVisibleDate(windowOf(all), all, 250)).toBe('2026-06-28')
  })

  it('returns null when the topmost visible row is a date separator', () => {
    const all = items([{ date: '2026-06-28' }, { msg: 'a' }, { msg: 'b' }])
    // scrollTop 0 → topmost visible is the date item itself → suppress
    expect(getTopVisibleDate(windowOf(all), all, 0)).toBeNull()
  })

  it('uses the nearest preceding date across a day boundary', () => {
    const all = items([
      { date: '2026-06-28' },
      { msg: 'a' },
      { date: '2026-06-29' },
      { msg: 'b' },
      { msg: 'c' },
    ])
    // scrollTop 350 → topmost visible is index 3 (msg 'b'), under 2026-06-29
    expect(getTopVisibleDate(windowOf(all), all, 350)).toBe('2026-06-29')
  })

  it('returns null when there is no date above the topmost row', () => {
    const all: RenderItem<Msg>[] = [
      { kind: 'header', key: '__header' },
      ...items([{ msg: 'a' }]),
    ]
    // scrollTop 0 → topmost visible is the header → no date above
    expect(getTopVisibleDate(windowOf(all), all, 0)).toBeNull()
  })

  it('returns null when the window is empty', () => {
    expect(getTopVisibleDate([], [], 0)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/getTopVisibleDate.test.ts`
Expected: FAIL — `getTopVisibleDate is not a function` / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { RenderItem } from './messageListItems'
import type { VirtualWindowItem } from './messageVirtualizer'

/**
 * Derive the date label to show in the floating header, given the virtualizer's
 * current window (visual order, ascending index), the full flat item list, and the
 * scroll container's scrollTop.
 *
 * Returns the `yyyy-MM-dd` date of the topmost VISIBLE message, or null when:
 *  - the topmost visible row is itself a date separator (the inline separator already
 *    shows the date — no duplicate), or
 *  - there is no date item above the topmost visible row (e.g. the load-earlier header
 *    is at the top), or
 *  - the window is empty.
 *
 * Pure: no DOM access, so the geometry logic is fully unit-testable.
 */
export function getTopVisibleDate<T extends { id: string }>(
  windowItems: VirtualWindowItem[],
  allItems: RenderItem<T>[],
  scrollTop: number,
): string | null {
  // Topmost visible row = first (lowest index) row whose bottom edge is below the
  // viewport top. Overscan rows fully above the viewport are skipped.
  let topIndex: number | null = null
  for (const vi of windowItems) {
    if (vi.start + vi.size > scrollTop) {
      topIndex = vi.index
      break
    }
  }
  if (topIndex === null) return null

  const topItem = allItems[topIndex]
  if (!topItem || topItem.kind === 'date') return null // suppress under a separator

  // Walk backward to the nearest preceding date item.
  for (let i = topIndex - 1; i >= 0; i--) {
    const it = allItems[i]
    if (it.kind === 'date') return it.date
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/getTopVisibleDate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/getTopVisibleDate.ts apps/fluux/src/components/conversation/getTopVisibleDate.test.ts
git commit -m "feat(conversation): pure getTopVisibleDate for floating date header"
```

---

### Task 2: `FloatingDateHeader` component

**Files:**
- Create: `apps/fluux/src/components/conversation/FloatingDateHeader.tsx`
- Test: `apps/fluux/src/components/conversation/FloatingDateHeader.test.tsx`

**Interfaces:**
- Consumes: `formatDateHeader` from `@/utils/dateFormat`.
- Produces: `FloatingDateHeader` React component with props
  `{ scrollerRef: React.RefObject<HTMLElement | null>; getTopDate: () => string | null; fadeDelayMs?: number }`.
  Renders an overlay container marked `data-floating-date`; the pill `<span>` carries `data-floating-date-pill`.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { useRef, useEffect } from 'react'
import { FloatingDateHeader } from './FloatingDateHeader'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'dates.today' ? 'Today' : key === 'dates.yesterday' ? 'Yesterday' : key),
    i18n: { language: 'en' },
  }),
}))

// Test host: gives the component a real scroll element + a controllable getTopDate.
function Host({ getTopDate, fadeDelayMs }: { getTopDate: () => string | null; fadeDelayMs?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // expose the scroller so the test can dispatch scroll events
    ;(window as unknown as Record<string, unknown>).__scroller = ref.current
  }, [])
  return (
    <div style={{ position: 'relative' }}>
      <div ref={ref} data-scroller style={{ overflow: 'auto' }} />
      <FloatingDateHeader scrollerRef={ref} getTopDate={getTopDate} fadeDelayMs={fadeDelayMs} />
    </div>
  )
}

describe('FloatingDateHeader', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  function scroll(container: HTMLElement) {
    const scroller = container.querySelector('[data-scroller]') as HTMLElement
    fireEvent.scroll(scroller)
    // flush the rAF-coalesced compute (vitest fake timers shim rAF as a ~16ms macrotask)
    act(() => {
      vi.advanceTimersByTime(20)
    })
  }

  it('shows the date pill on scroll with a non-null date', () => {
    const { container } = render(<Host getTopDate={() => '2026-06-28'} />)
    const overlay = container.querySelector('[data-floating-date]') as HTMLElement
    expect(overlay.className).toContain('opacity-0') // hidden at rest

    scroll(container)

    expect(overlay.className).toContain('opacity-100')
    expect(container.querySelector('[data-floating-date-pill]')?.textContent).toContain('Jun')
  })

  it('fades out after the fade delay once scrolling stops', () => {
    const { container } = render(<Host getTopDate={() => '2026-06-28'} fadeDelayMs={1200} />)
    scroll(container)
    const overlay = container.querySelector('[data-floating-date]') as HTMLElement
    expect(overlay.className).toContain('opacity-100')

    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(overlay.className).toContain('opacity-0')
  })

  it('stays hidden when getTopDate returns null (topmost is a separator)', () => {
    const { container } = render(<Host getTopDate={() => null} />)
    scroll(container)
    const overlay = container.querySelector('[data-floating-date]') as HTMLElement
    expect(overlay.className).toContain('opacity-0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/FloatingDateHeader.test.tsx`
Expected: FAIL — cannot resolve `./FloatingDateHeader`.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDateHeader } from '@/utils/dateFormat'

export interface FloatingDateHeaderProps {
  /** The scroll container to observe. */
  scrollerRef: React.RefObject<HTMLElement | null>
  /**
   * Returns the `yyyy-MM-dd` date of the topmost visible message, or null when the
   * topmost element is a date separator / there is no date above. MUST be ref-stable
   * (the effect subscribes once); the caller wraps the live computation in a stable
   * callback.
   */
  getTopDate: () => string | null
  /** ms to keep the pill visible after the last scroll event. Default 1200. */
  fadeDelayMs?: number
}

/**
 * Floating "date pill" centered at the top of the message area. Appears while
 * scrolling, showing the date of the topmost visible message, and fades out shortly
 * after scrolling stops. Owns its own scroll listener and visibility state so the
 * parent MessageList never re-renders on scroll. Informational only.
 */
export function FloatingDateHeader({ scrollerRef, getTopDate, fadeDelayMs = 1200 }: FloatingDateHeaderProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language.split('-')[0]
  const [date, setDate] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const compute = () => {
      rafRef.current = null
      const d = getTopDate()
      if (d == null) {
        setVisible(false)
        return
      }
      setDate(d)
      setVisible(true)
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      fadeTimer.current = setTimeout(() => setVisible(false), fadeDelayMs)
    }

    // Coalesce bursts of scroll events into one compute per frame.
    const onScroll = () => {
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(compute)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
    }
  }, [scrollerRef, getTopDate, fadeDelayMs])

  return (
    <div
      data-floating-date
      className={`absolute top-3 inset-x-0 z-30 flex justify-center pointer-events-none transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!visible}
    >
      {date && (
        <span
          data-floating-date-pill
          className="px-3 py-1 rounded-full bg-fluux-float border border-fluux-border shadow-lg text-xs font-medium text-fluux-muted whitespace-nowrap"
        >
          {formatDateHeader(date, t, lang)}
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/FloatingDateHeader.test.tsx`
Expected: PASS (3 tests).

Note: the test asserts the pill text contains `Jun` because `2026-06-28` is neither today nor yesterday at execution time, so `formatDateHeader` returns the locale `PPP` form (e.g. `June 28th, 2026`). If you run this plan on a date where that assertion is brittle, assert `textContent` is truthy instead.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/FloatingDateHeader.tsx apps/fluux/src/components/conversation/FloatingDateHeader.test.tsx
git commit -m "feat(conversation): FloatingDateHeader scroll-triggered date pill"
```

---

### Task 3: Wire `FloatingDateHeader` into `MessageList`

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx`
- Test: `apps/fluux/src/components/conversation/MessageList.floatingDate.test.tsx` (create)

**Interfaces:**
- Consumes: `getTopVisibleDate` (Task 1), `FloatingDateHeader` (Task 2), the existing `activeVirtualizer` (`MessageVirtualizer | undefined`), `virtualItems` (`RenderItem<T>[]`), and `scrollContainerRef` already present in `MessageList`.
- Produces: the pill overlay rendered inside the existing `relative` wrapper, on the virtualized path only.

- [ ] **Step 1: Add imports**

In `MessageList.tsx`, add to the existing imports near the other `./` imports (e.g. after the `buildMessageListItems` import on line 32):

```tsx
import { FloatingDateHeader } from './FloatingDateHeader'
import { getTopVisibleDate } from './getTopVisibleDate'
```

- [ ] **Step 2: Add the ref-stable `getTopDate` callback**

In `MessageList.tsx`, after `activeVirtualizer` is defined (line ~352) and after `useCallback` is already imported (it is, line 14), add:

```tsx
  // Ref-backed so FloatingDateHeader subscribes once. Reads the live virtualizer
  // window + scrollTop each call; returns null to suppress (separator at top / no
  // date above). MessageList itself does not re-render on scroll.
  const getTopVisibleDateRef = useRef<() => string | null>(() => null)
  getTopVisibleDateRef.current = () => {
    const v = activeVirtualizer
    const scroller = scrollContainerRef.current
    if (!v || !scroller) return null
    return getTopVisibleDate(v.getVirtualItems(), virtualItems, scroller.scrollTop)
  }
  const getTopDate = useCallback(() => getTopVisibleDateRef.current(), [])
```

- [ ] **Step 3: Render the overlay**

In `MessageList.tsx`, inside the outer `<div className="relative flex-1 flex flex-col min-h-0">` (line 548), immediately after the closing `</div>` of the scroll container (the `</div>` on line 676, before the scroll-to-bottom FAB block on line 678), add:

```tsx
      {/* Floating date pill — appears while scrolling the virtualized list */}
      {virtualized && hasContent && (
        <FloatingDateHeader scrollerRef={scrollContainerRef} getTopDate={getTopDate} />
      )}
```

- [ ] **Step 4: Write the wiring test**

Create `apps/fluux/src/components/conversation/MessageList.floatingDate.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MessageList } from './MessageList'
import { createTestMessages } from './MessageList.test-utils'
import { scrollStateManager } from '@/utils/scrollStateManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: vi.fn(() => ({
    copySelectedIds: new Set<string>(),
    selectionCount: 0,
    isSelecting: false,
    selectAll: vi.fn(),
    extendTo: vi.fn(),
    clearSelection: vi.fn(),
    copySelected: vi.fn(),
  })),
}))

describe('MessageList floating date header wiring', () => {
  beforeEach(() => scrollStateManager.clearAll?.())
  afterEach(() => vi.clearAllMocks())

  const messages = createTestMessages(5)
  const renderMessage = (m: { id: string }) => <div>{m.id}</div>

  it('renders the floating date overlay on the virtualized path', () => {
    const { container } = render(
      <MessageList messages={messages} conversationId="c1" renderMessage={renderMessage} />,
    )
    expect(container.querySelector('[data-floating-date]')).not.toBeNull()
  })

  it('does not render the overlay in staticMode', () => {
    const { container } = render(
      <MessageList messages={messages} conversationId="c2" renderMessage={renderMessage} staticMode />,
    )
    expect(container.querySelector('[data-floating-date]')).toBeNull()
  })
})
```

Note: this mirrors the mock block in `MessageList.fab.test.tsx`. If `MessageList` gains a newly-required mock there, copy it here too. If `scrollStateManager.clearAll` does not exist, drop the `beforeEach` line (it is only hygiene).

- [ ] **Step 5: Run the wiring test**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageList.floatingDate.test.tsx`
Expected: PASS (2 tests). If the first assertion fails because the virtualization feature flag is OFF in the test env, confirm `isFeatureEnabled('enableMessageVirtualization')` defaults ON (it does in app code); otherwise the existing `MessageList.fab.test.tsx` (which exercises the virtualized path) documents how the flag is set in tests — match it.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/components/conversation/MessageList.floatingDate.test.tsx
git commit -m "feat(conversation): wire FloatingDateHeader into the virtualized MessageList"
```

---

### Task 4: Verify, lint, and demo-check

**Files:** none (verification only).

- [ ] **Step 1: Run the affected test suite**

Run: `cd apps/fluux && npx vitest run src/components/conversation`
Expected: all conversation tests PASS, no stderr.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 3: Demo-mode manual verification**

```bash
npm run dev
# open http://localhost:5173/demo.html?tutorial=false
```

Open a conversation with multiple days of history and scroll up. Confirm:
- The centered date pill appears while scrolling, showing the day of the topmost visible message.
- When an inline date separator reaches the top of the viewport, the pill disappears (no duplicate date).
- The pill fades out ~1.2s after scrolling stops.
- The pill does not appear in the search-context / activity-context preview panes (static mode).

- [ ] **Step 4: Commit (if any lint autofixes applied)**

```bash
git add -A
git commit -m "chore(conversation): lint pass for floating date header" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- "Show topmost visible message's date" → Task 1 (`getTopVisibleDate`) + Task 2/3 (render).
- "Suppress when topmost element is a date separator" → Task 1 (returns null on `kind === 'date'`), tested.
- "Scroll-then-fade (~1.2s)" → Task 2 (`fadeDelayMs = 1200`), tested.
- "Centered solid pill, FAB token styling" → Task 2 className.
- "Render isolation, no MessageList re-render on scroll" → Task 3 ref-backed `getTopDate` + Task 2 self-contained state.
- "Virtualized only; not staticMode / legacy" → Task 3 `{virtualized && hasContent && ...}`, tested (staticMode absence).
- "DMs + rooms" → automatic (both use `MessageList`); no extra task.
- "Reuse `formatDateHeader`, no new i18n keys" → Task 2.
- "No SDK changes" → all tasks under `apps/fluux`.
- Testing strategy (pure unit + component fake-timers + manual demo; geometry not exercised in jsdom) → Tasks 1, 2, 4.

**Placeholder scan:** none — every code step shows complete code; the only conditional notes (i18n flag location, `clearAll` hygiene) point to a concrete existing file to mirror.

**Type consistency:** `getTopVisibleDate(windowItems, allItems, scrollTop)` signature is identical across Task 1's definition and Task 3's call. `FloatingDateHeader` prop names (`scrollerRef`, `getTopDate`, `fadeDelayMs`) match between Task 2's definition and Task 3's usage. `RenderItem<T>` / `VirtualWindowItem` import paths are consistent.
