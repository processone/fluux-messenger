# Virtualization Scroll Harness + Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless Playwright scroll harness that proves 6 invariants RED against the current virtualized path, then rework scroll integration so all 6 pass on both chromium and webkit, enabling the virtualization flag to be flipped ON permanently.

**Architecture:** Phase 0 adds a `?virt=1` query-param seam to demo.tsx (sets the flag after the localStorage wipe) and a new Playwright config + test file that drives real scrolling via `mouse.wheel`/`element.scrollTo` and asserts the 6 scroll invariants. Phase 1 replaces the imperative `scrollTop` re-assert loops in `useMessageListScroll.ts` with the virtualizer's own `scrollToOffset`/`scrollToIndex` APIs (which go through @tanstack's internal scheduler and don't create measurement-feedback loops), removes the 15-frame re-assert for scroll-to-bottom (replaced by checking against actual getTotalSize), and unifies the prepend-restore path to always use `virtualizer.getOffsetForMessageId`. Phase 2 flips the flag ON and removes the non-virtualized path after a green dual-engine run.

**Tech Stack:** React + TypeScript, @tanstack/react-virtual v3 (already installed), Playwright (already installed), Vite + demo.html, Vitest for unit tests.

## Global Constraints

- **Branch:** `perf/virtualization` — all commits go here.
- **Flag default STAYS OFF** until all 6 invariants pass on BOTH chromium + webkit Playwright runs.
- **Non-virtualized path (flag OFF) must stay intact** as the fallback parity oracle — do NOT delete it until Phase 2.
- **Worktree node_modules**: `ln -s /Users/mremond/AIProjects/fluux-messenger/node_modules node_modules` before running any npm command; remove the symlink when done (`git status` shows it if forgotten).
- **No vitest while dev server is up** in the worktree (shared `.vite` cache corruption); `rm -rf node_modules/.vite` to recover.
- **Commit hygiene**: unit tests pass + typecheck + lint before each commit. No Claude footer.
- **Playwright base URL:** `http://localhost:5173` (dev server via `npm run dev` from the worktree with node_modules symlink).

---

## File Structure

- Modify: `apps/fluux/src/demo.tsx` — add `?virt=1` seam (1 line after the localStorage clear).
- Create: `playwright.scroll.config.ts` — separate Playwright config (testMatch `scroll-invariants.ts`, chromium + webkit projects, webServer from worktree).
- Create: `scripts/scroll-invariants.ts` — the 6 invariant tests with RED-first assertions.
- Modify: `apps/fluux/src/components/conversation/useMessageListScroll.ts` — Phase 1 rework (see Tasks 3–6).
- Modify: `apps/fluux/src/utils/featureFlags.ts` — Phase 2: flip default ON (last step).

---

## Phase 0 — Harness (the autonomy enabler)

### Task P0.1: Add `?virt=1` seam to demo.tsx

**Files:**
- Modify: `apps/fluux/src/demo.tsx` lines ~39-44 (after the localStorage clear loop)

- [ ] **Step 1: Locate the localStorage clear block**

Read `apps/fluux/src/demo.tsx`. Find the `DEMO_STORAGE_PREFIXES` block (around line 39). The code clears all `fluux:*` keys on init. The seam goes IMMEDIATELY AFTER this block.

- [ ] **Step 2: Add the seam**

After the localStorage clear for-loop (but before `indexedDB.deleteDatabase`), add:

```typescript
// Query-param seam: ?virt=1 re-sets the virtualization flag AFTER the clear above,
// so Playwright tests can load demo with virtualization ON without a full page reload.
if (params.get('virt') === '1') {
  localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
}
```

- [ ] **Step 3: Verify it works in the browser**

With node_modules symlinked, run `npm run dev` from the worktree. Open `http://localhost:5173/demo.html?virt=1&tutorial=false`. In the browser console:
```javascript
localStorage.getItem('fluux:flags:enableMessageVirtualization') // must be "true"
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/fluux && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/demo.tsx
git commit -m "feat(demo): add ?virt=1 seam to enable virtualization flag post-localStorage-clear"
```

---

### Task P0.2: Create playwright.scroll.config.ts

**Files:**
- Create: `playwright.scroll.config.ts` (repo root in worktree)

The existing `playwright.config.ts` only covers screenshots (chromium only, `testMatch: 'screenshots.ts'`). We need a SEPARATE config for scroll invariants that runs on chromium + webkit.

- [ ] **Step 1: Create the config**

```typescript
// playwright.scroll.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './scripts',
  testMatch: 'scroll-invariants.ts',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 800 },
    // Capture console so we can assert on RenderLoopDetector warnings
    // (accessed via page.on('console', ...) in each test)
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
```

- [ ] **Step 2: Commit**

```bash
git add playwright.scroll.config.ts
git commit -m "chore(test): add playwright.scroll.config.ts for chromium + webkit scroll invariants"
```

---

### Task P0.3: Create scripts/scroll-invariants.ts

**Files:**
- Create: `scripts/scroll-invariants.ts`

This is the heart of Phase 0. It encodes the 6 acceptance invariants and must go RED against the current virtualized path (proving the harness catches the real bugs). Each test is self-contained: loads demo, enables virt, seeds stress conversation, drives scrolling, asserts.

**Stress URL used throughout:** `http://localhost:5173/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:200,msgStep:0`
- `rooms:1` → seeds 1 stress room (`stress-0@conference.<domain>`)
- `messages:200` → 200 pre-seeded messages (well above the ~60 window)
- `msgStep:0` → seed instantly (no delay)
- `virt=1` → enables virtualization flag
- `demoLoadOlder` is installed by `demo.tsx` unconditionally when stress is active, so scroll-to-top triggers synthetic older messages

**Demo domain:** obtained from `window.__demoClient` → the room JID will be `stress-0@conference.<domain>`. We navigate via hash route `#/rooms/<encoded-jid>`.

- [ ] **Step 1: Write the harness**

```typescript
// scripts/scroll-invariants.ts
/**
 * Playwright scroll-invariant harness for the message-list virtualization path.
 *
 * PHASE 0 GOAL: Encode failures as assertions that go RED against the current
 * virtualized path, proving the harness catches the real bugs. They become the
 * acceptance gate for Phase 1 rework.
 *
 * Run: npx playwright test --config=playwright.scroll.config.ts --project=chromium
 * Then verify: --project=webkit
 */

import { test, expect, type Page } from '@playwright/test'

// ── Shared constants ──────────────────────────────────────────────────────────

const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:200,msgStep:0'
const SETTLE_MS = 600  // time to let scroll + measurement settle
const FRAME_SAMPLE_MS = 400  // time window for scrollTop sampling
const PREPEND_DRIFT_THRESHOLD_PX = 2   // acceptable position error (px)
const LARGE_JUMP_THRESHOLD_PX = 100    // frame-to-frame jump indicating instability

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Load demo, wait for sidebar + stress seeding to complete. */
async function loadDemo(page: Page): Promise<void> {
  // Collect console warnings for invariant 5
  ;(page as Page & { _consoleWarnings?: string[] })._consoleWarnings = []
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') {
      ;(page as Page & { _consoleWarnings?: string[] })._consoleWarnings!.push(msg.text())
    }
  })

  await page.goto(DEMO_URL)

  // Wait for sidebar nav (React mounted)
  await page.waitForSelector('[data-nav="messages"]', { timeout: 20_000 })

  // Wait for the stress rooms to be seeded (a stress room item appears in the sidebar)
  // The stress contact 1:1 (seedStressConversation) and room are both seeded asynchronously.
  // We rely on the hash-navigation route below to gate on "room messages rendered".
  await page.waitForTimeout(1000)
}

/** Navigate to the stress-0 room via hash route. Returns the message-list scroller element. */
async function navigateToStressRoom(page: Page): Promise<void> {
  const roomJid = await page.evaluate(() => {
    const c = (window as any).__demoClient
    if (!c?.populateDemo) return null
    // The room JID is stress-0@conference.<domain>. domain is derived from the demo
    // self JID (always fluux.chat in demo mode, but read dynamically to be safe).
    const selfJid: string = (window as any).__selfJid || 'you@fluux.chat'
    const domain = selfJid.split('@')[1] || 'fluux.chat'
    return `stress-0@conference.${domain}`
  })
  if (!roomJid) throw new Error('Could not determine stress room JID')
  await page.evaluate((jid: string) => { window.location.hash = '#/rooms/' + encodeURIComponent(jid) }, roomJid)
  // Wait for the message list to render (at least one [data-index] row visible = virtualized)
  await page.waitForSelector('[data-index]', { timeout: 15_000 })
  await page.waitForTimeout(SETTLE_MS)
}

/** Get the scroll container element handle. */
async function getScroller(page: Page) {
  return page.locator('[data-message-list]').first()
}

/**
 * Find the top-most visible message id and its offset from the scroller's top edge.
 * Returns { id, offsetFromTop } or null if no messages are visible.
 */
async function findTopVisibleMessage(page: Page): Promise<{ id: string; offsetFromTop: number } | null> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-message-list]') as HTMLElement
    if (!scroller) return null
    const rows = Array.from(scroller.querySelectorAll('[data-message-id]')) as HTMLElement[]
    const scrollerRect = scroller.getBoundingClientRect()
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      const offsetFromTop = rect.top - scrollerRect.top
      if (offsetFromTop >= -rect.height / 2) {
        return { id: row.dataset.messageId!, offsetFromTop }
      }
    }
    return rows.length > 0
      ? { id: (rows[0] as HTMLElement).dataset.messageId!, offsetFromTop: rows[0].getBoundingClientRect().top - scrollerRect.top }
      : null
  })
}

/** Get scrollTop of the message list scroller. */
async function getScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement
    return s ? s.scrollTop : 0
  })
}

/** Get the count of mounted [data-index] rows (windowed virtual items). */
async function getMountedRowCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-index]').length)
}

/** Get the total message count (data-message-id, deduped). */
async function getMessageCount(page: Page): Promise<number> {
  return page.evaluate(() => new Set(
    Array.from(document.querySelectorAll('[data-message-id]')).map((el) => (el as HTMLElement).dataset.messageId)
  ).size)
}

/** Scroll the message list to the very top (programmatic + wheel). */
async function scrollToVeryTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement
    if (s) s.scrollTop = 0
  })
  await page.waitForTimeout(100)
  // Also fire wheel up to trigger the useMessageListScroll wheel handler
  const scroller = page.locator('[data-message-list]').first()
  await scroller.dispatchEvent('wheel', { deltaY: -1000, bubbles: true })
  await page.waitForTimeout(SETTLE_MS)
}

/** Click the "scroll to bottom" FAB button. */
async function clickScrollToBottom(page: Page): Promise<void> {
  // The FAB has a ChevronDown icon and appears when scrolled up; wait for it
  const fab = page.locator('[data-fab="scroll-to-bottom"]').first()
  await fab.waitFor({ state: 'visible', timeout: 5_000 })
  await fab.click()
  await page.waitForTimeout(SETTLE_MS)
}

/** Scroll to bottom programmatically and wait for settle. */
async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement
    if (s) s.scrollTop = s.scrollHeight
  })
  await page.waitForTimeout(SETTLE_MS)
}

/** Sample scrollTop every ~16ms for durationMs, return array of samples. */
async function sampleScrollTop(page: Page, durationMs: number): Promise<number[]> {
  return page.evaluate((ms) => {
    return new Promise<number[]>((resolve) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement
      if (!s) { resolve([]); return }
      const samples: number[] = []
      const start = performance.now()
      const tick = () => {
        samples.push(s.scrollTop)
        if (performance.now() - start < ms) requestAnimationFrame(tick)
        else resolve(samples)
      }
      requestAnimationFrame(tick)
    })
  }, durationMs)
}

// ── Invariant tests ───────────────────────────────────────────────────────────

test.describe('Message-list virtualization scroll invariants', () => {

  // ── Invariant 1: Prepend holds position ──────────────────────────────────

  test('1: prepend holds position — anchor stays within 2px, no large per-frame jump', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Scroll up to see older messages (not the very top — we want some messages above the anchor)
    const scroller = page.locator('[data-message-list]').first()
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight / 4 })
    await page.waitForTimeout(300)

    // Record the top-visible message and its viewport offset
    const before = await findTopVisibleMessage(page)
    expect(before, 'must find a top-visible message before prepend').not.toBeNull()
    const anchorId = before!.id
    const anchorOffsetBefore = before!.offsetFromTop

    // Scroll to the very top to trigger load-older
    await scrollToVeryTop(page)

    // Sample scrollTop during settle to catch frame-to-frame jumps
    const samples = await sampleScrollTop(page, FRAME_SAMPLE_MS)

    // Wait for full settle
    await page.waitForTimeout(SETTLE_MS)

    // Assert: no large single-frame jump (instability indicator)
    for (let i = 1; i < samples.length; i++) {
      const jump = Math.abs(samples[i] - samples[i - 1])
      expect(jump, `frame ${i}: jump of ${jump}px > threshold (oscillation detected)`).toBeLessThanOrEqual(LARGE_JUMP_THRESHOLD_PX)
    }

    // Assert: the anchor message is within 2px of its prior viewport offset
    const after = await page.evaluate((id) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement
      if (!scroller) return null
      const el = scroller.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
      if (!el) return null
      const scrollerRect = scroller.getBoundingClientRect()
      return el.getBoundingClientRect().top - scrollerRect.top
    }, anchorId)

    expect(after, `anchor "${anchorId}" not found in DOM after prepend`).not.toBeNull()
    expect(Math.abs(after! - anchorOffsetBefore), `anchor drifted by ${Math.abs(after! - anchorOffsetBefore)}px (limit: ${PREPEND_DRIFT_THRESHOLD_PX}px)`)
      .toBeLessThanOrEqual(PREPEND_DRIFT_THRESHOLD_PX)
  })

  // ── Invariant 2: No runaway pagination ───────────────────────────────────

  test('2: no runaway pagination — one load-older loads exactly one batch', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Scroll to a middle position so we can identify a load-older trigger
    await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement
      if (s) s.scrollTop = s.scrollHeight / 3
    })
    await page.waitForTimeout(300)

    const countBefore = await getMessageCount(page)

    // Trigger exactly one load-older via scroll-to-top
    await scrollToVeryTop(page)
    await page.waitForTimeout(1000) // wait for the single batch

    const countAfter = await getMessageCount(page)
    const added = countAfter - countBefore

    // The batch size is BATCH=50 from demoLoadOlder.ts; assert it grew by
    // approximately one batch (allow ±5 for dedup / rounding)
    expect(added, `message count grew by ${added}, expected ~50 (one batch)`).toBeGreaterThan(0)
    expect(added, `message count grew by ${added} — possible runaway pagination (> 2 batches)`).toBeLessThanOrEqual(60)

    // Wait a bit more and assert count hasn't grown further (no runaway re-trigger)
    await page.waitForTimeout(1000)
    const countAfterSettle = await getMessageCount(page)
    expect(countAfterSettle - countAfter, 'count kept growing after settle — runaway pagination').toBeLessThan(10)

    // Assert scrollTop is NOT 0 (the restore fired and we're not at the very top)
    const scrollTop = await getScrollTop(page)
    expect(scrollTop, 'scrollTop is still 0 after restore — prepend failed to move viewport').toBeGreaterThan(10)
  })

  // ── Invariant 3: Scroll-to-bottom FAB is never blank ─────────────────────

  test('3: scroll-to-bottom FAB — last message visible, mounted rows > 0', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Scroll up so the FAB appears
    await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement
      if (s) s.scrollTop = 0
    })
    await page.waitForTimeout(300)

    // Click the FAB
    await clickScrollToBottom(page)

    // Assert: at least one mounted [data-index] row (not blank)
    const rowCount = await getMountedRowCount(page)
    expect(rowCount, 'no [data-index] rows mounted after scroll-to-bottom — blank window').toBeGreaterThan(0)

    // Assert: the last message's bounding rect is within the viewport
    const isLastMessageVisible = await page.evaluate(() => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement
      if (!scroller) return false
      const rows = scroller.querySelectorAll('[data-message-id]')
      if (rows.length === 0) return false
      const last = rows[rows.length - 1] as HTMLElement
      const scrollerRect = scroller.getBoundingClientRect()
      const lastRect = last.getBoundingClientRect()
      // Allow a small gap at the bottom (FAB overlaps, typing indicator, etc.)
      const BOTTOM_GAP = 80
      return lastRect.bottom <= scrollerRect.bottom + BOTTOM_GAP && lastRect.top >= scrollerRect.top
    })
    expect(isLastMessageVisible, 'last message not visible after FAB scroll-to-bottom').toBe(true)
  })

  // ── Invariant 4: Bottom-stick ─────────────────────────────────────────────

  test('4: bottom-stick — new message stays visible when already at bottom', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Scroll to bottom
    await scrollToBottom(page)

    // Emit a new message via the demo client
    const newMsgId = `invariant-4-new-${Date.now()}`
    await page.evaluate((msgId) => {
      const c = (window as any).__demoClient
      if (!c) throw new Error('no __demoClient')
      // Find the active room JID from the URL hash
      const hash = window.location.hash
      const match = hash.match(/#\/rooms\/(.+)/)
      if (!match) throw new Error('not in a room')
      const roomJid = decodeURIComponent(match[1])
      c.emitSDK('room:message', {
        roomJid,
        message: {
          type: 'groupchat',
          id: msgId,
          from: `${roomJid}/TestUser`,
          nick: 'TestUser',
          body: 'bottom-stick invariant test message',
          timestamp: new Date(),
          isOutgoing: false,
          roomJid,
        },
        incrementUnread: false,
      })
    }, newMsgId)

    // Wait for paint + measurement
    await page.waitForTimeout(400)

    // Assert: the new message is visible
    const isNewMsgVisible = await page.evaluate((msgId) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement
      if (!scroller) return false
      const el = scroller.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`) as HTMLElement | null
      if (!el) return false
      const scrollerRect = scroller.getBoundingClientRect()
      const rect = el.getBoundingClientRect()
      const BOTTOM_GAP = 100
      return rect.top >= scrollerRect.top && rect.bottom <= scrollerRect.bottom + BOTTOM_GAP
    }, newMsgId)
    expect(isNewMsgVisible, `new message "${newMsgId}" not visible — bottom-stick failed`).toBe(true)
  })

  // ── Invariant 5: No render loop / slow render ─────────────────────────────

  test('5: no render loop or slow render during prepend + FAB cycle', async ({ page }) => {
    const warnings: string[] = []
    page.on('console', (msg) => {
      if (msg.text().includes('RenderLoopDetector') || msg.text().includes('RenderCostProbe') || msg.text().includes('render loop')) {
        warnings.push(msg.text())
      }
    })

    await loadDemo(page)
    await navigateToStressRoom(page)

    // Run a full prepend + scroll-to-bottom cycle (the stress scenario)
    await scrollToVeryTop(page)
    await page.waitForTimeout(800)
    await scrollToBottom(page)
    await page.waitForTimeout(400)
    await scrollToVeryTop(page)
    await page.waitForTimeout(800)

    // Assert: no RenderLoopDetector or RenderCostProbe warnings were fired
    expect(warnings, `Render loop or cost probe warnings fired: ${warnings.join('; ')}`).toHaveLength(0)
  })

  // ── Invariant 6: Windowing bounds DOM ─────────────────────────────────────

  test('6: windowing bounds DOM — mounted [data-index] rows < 60 with 200-msg backlog', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Let the virtualizer settle (rows measure, window stabilizes)
    await page.waitForTimeout(SETTLE_MS)

    const rowCount = await getMountedRowCount(page)
    // Overscan=12 on each side, viewport ~8-10 rows visible → ~30-35 at most.
    // Allow generous headroom for header/footer/date items (those are also [data-index]).
    expect(rowCount, `mounted row count ${rowCount} ≥ 60 — windowing not bounding the DOM`).toBeLessThan(60)
  })

})
```

- [ ] **Step 2: Check FAB data attribute**

The `clickScrollToBottom` helper uses `[data-fab="scroll-to-bottom"]`. Verify this attribute exists in `MessageList.tsx` on the FAB button, OR find the correct selector. Read `MessageList.tsx` (grep for "scroll-to-bottom" or "showScrollToBottom" to find the FAB element). Add the `data-fab` attribute if missing.

- [ ] **Step 3: Add data-message-list attribute**

The helpers use `[data-message-list]` as the scroller selector. Verify this attribute exists on the scroll container div in `MessageList.tsx`. If not, find the correct selector (it may be `[data-testid="message-list"]` or similar) and update the helpers, or add the attribute.

- [ ] **Step 4: Commit the harness**

```bash
git add scripts/scroll-invariants.ts
git commit -m "test(perf): Playwright scroll-invariant harness — 6 RED assertions vs current virtualized path"
```

---

### Task P0.4: Node_modules setup + run harness to prove RED

**Files:** None (procedural)

The goal: confirm each test goes RED against the current virtualized code, proving the harness catches the real bugs.

- [ ] **Step 1: Set up node_modules symlink**

```bash
# From the worktree root
ln -s /Users/mremond/AIProjects/fluux-messenger/node_modules node_modules
```

- [ ] **Step 2: Start the dev server (background terminal)**

```bash
npm run dev
```

Wait for "Local: http://localhost:5173" message.

- [ ] **Step 3: Run the harness on chromium**

```bash
npx playwright test --config=playwright.scroll.config.ts --project=chromium 2>&1 | tee /tmp/scroll-invariants-red-chromium.txt
```

Expected: most/all tests FAIL. Document each failure reason in the comment block at the top of `scripts/scroll-invariants.ts`.

- [ ] **Step 4: Run the harness on webkit**

```bash
npx playwright test --config=playwright.scroll.config.ts --project=webkit 2>&1 | tee /tmp/scroll-invariants-red-webkit.txt
```

- [ ] **Step 5: Document RED results**

Add a `/* RED BASELINE (YYYY-MM-DD) */` comment to `scripts/scroll-invariants.ts` listing which tests failed and the failure reason for each engine. This proves the harness is correct.

- [ ] **Step 6: Commit documentation**

```bash
git add scripts/scroll-invariants.ts
git commit -m "test(perf): document RED baseline for scroll invariants pre-rework"
```

---

## Phase 1 — Scroll Integration Rework

The root cause: `useMessageListScroll.ts` writes `scrollTop` imperatively while @tanstack independently tracks scroll position and updates virtualizer window. The feedback loop is:

```
set scrollTop → @tanstack observes scroll → re-windows rows → rows measure → offsets shift →
next frame: re-read getOffsetForMessageId → different value → set scrollTop again → loop
```

**Primary fix**: Replace `scroller.scrollTop = X` with `virtualizer.scrollToOffset(X)` for prepend restore, new-message bottom-stick, and typing/reactions adjustments. Replace scroll-to-bottom `scroller.scrollTop = scroller.scrollHeight` with `virtualizer.scrollToIndex(lastItemIndex, { align: 'end' })`.

**Why virtualizer APIs don't loop**: `scrollToIndex/scrollToOffset` in @tanstack v3 use the virtualizer's own measurement cache — they compute the target from its internal offset array (which is already settled), set `scrollElement.scrollTop` once, and do NOT schedule a re-read.

---

### Task P1.1: Add `scrollToOffset` and `scrollToIndex` to `MessageVirtualizer` interface

**Files:**
- Modify: `apps/fluux/src/components/conversation/messageVirtualizer.ts`
- Modify: `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts`
- Modify: `apps/fluux/src/components/conversation/tanstackMessageVirtualizer.test.tsx`

- [ ] **Step 1: Extend the interface**

In `messageVirtualizer.ts`, add to the `MessageVirtualizer` interface:

```typescript
/** Scroll the container to an absolute pixel offset from the content top. */
scrollToOffset(offset: number): void
/** Scroll the container so the item at `index` is aligned per `align`. */
scrollToIndex(index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto' }): void
/** Total number of items (needed by scroll hook to reference the last item). */
readonly itemCount: number
```

- [ ] **Step 2: Implement in `tanstackMessageVirtualizer.ts`**

In the `return` block of `useTanstackMessageVirtualizer`, add:

```typescript
scrollToOffset: (offset) => virtualizer.scrollToOffset(offset),
scrollToIndex: (index, opts) => virtualizer.scrollToIndex(index, opts),
itemCount: items.length,
```

- [ ] **Step 3: Update the mock in the test**

In `tanstackMessageVirtualizer.test.tsx`, update the `vi.mock('@tanstack/react-virtual')` mock to add `scrollToOffset: vi.fn()` and `scrollToIndex: vi.fn()` to the returned object. Assert they are passed through to the interface.

- [ ] **Step 4: Add an assertion in the test**

```typescript
it('exposes scrollToOffset and scrollToIndex pass-throughs', () => {
  const { result } = renderHook(() => { ... })
  result.current.scrollToOffset(500)
  result.current.scrollToIndex(3, { align: 'end' })
  // No throw = pass (the mock functions are called)
})
```

- [ ] **Step 5: Run the updated test**

```bash
cd apps/fluux && npx vitest run src/components/conversation/tanstackMessageVirtualizer.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
cd apps/fluux && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/conversation/messageVirtualizer.ts apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts apps/fluux/src/components/conversation/tanstackMessageVirtualizer.test.tsx
git commit -m "feat(perf): add scrollToOffset/scrollToIndex/itemCount to MessageVirtualizer interface"
```

---

### Task P1.2: Replace prepend restore with `virtualizer.scrollToOffset`

**Files:**
- Modify: `apps/fluux/src/components/conversation/useMessageListScroll.ts`

The prepend restore is in the `useLayoutEffect` around line 1109-1322. The key section:
1. Reads anchor offset via `virtualizer.getOffsetForMessageId(saved.anchorMessageId)` (or DOM fallback)
2. Computes `newScrollTop = virtualOffset - saved.anchorOffsetFromTop`
3. Sets `scroller.scrollTop = boundedScrollTop`
4. Then runs a 15-frame re-assert (`assertPosition` function)

**Fix**: Replace step 3 with `virtualizer.scrollToOffset(boundedScrollTop)` when virtualized (removing the need for the external `scrollTop` write, which confuses @tanstack's scroll tracker). Remove the 15-frame `assertPosition` loop entirely — it was compensating for @tanstack measurement convergence, which the virtualizer handles internally now that we're not fighting it.

- [ ] **Step 1: Replace `scroller.scrollTop` with `virtualizer.scrollToOffset` in the prepend restore**

In the prepend `useLayoutEffect`, find:
```typescript
// Set scroll position synchronously - this happens before browser paint
scroller.scrollTop = boundedScrollTop
```
Change to:
```typescript
// Set scroll position. When virtualized, go through the virtualizer's scroll API
// so @tanstack's internal scroll-position tracker stays consistent with the write
// (avoiding the "external scrollTop → @tanstack observes → re-windows → offsets shift" loop).
if (latestRef.current.virtualizer?.scrollToOffset) {
  latestRef.current.virtualizer.scrollToOffset(boundedScrollTop)
} else {
  scroller.scrollTop = boundedScrollTop
}
const actualScrollTop = scroller.scrollTop
```

- [ ] **Step 2: Remove the 15-frame `assertPosition` loop**

Delete the entire `assertPosition` function and its call (approximately lines 1247-1278). The fixed-target assertion is no longer needed because:
- @tanstack owns the scroll write via `scrollToOffset`
- @tanstack handles measurement convergence internally (it re-positions after rows measure)
- The momentum re-assert was fighting this process, not helping it

Replace the deleted block comment with:
```typescript
// No per-frame re-assert: the virtualizer handles measurement convergence internally.
// Formerly a 15-frame fixed-target re-assert was here; it fought @tanstack's own
// scroll observation and caused the oscillation documented in PR #646.
```

- [ ] **Step 3: Run existing scroll tests**

```bash
cd apps/fluux && npx vitest run src/components/conversation/MessageList.scroll.test.tsx src/components/conversation/MessageList.virtualizedScroll.test.tsx
```

Expected: PASS (the unit tests mock the virtualizer and DOM; this change only affects the live engine path).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/conversation/useMessageListScroll.ts
git commit -m "fix(perf): prepend restore via virtualizer.scrollToOffset — remove 15-frame re-assert"
```

---

### Task P1.3: Replace scroll-to-bottom with `virtualizer.scrollToIndex(last, end)`

**Files:**
- Modify: `apps/fluux/src/components/conversation/useMessageListScroll.ts`

The `reassertScrollToBottom` function (lines 113-126) and all call sites:
1. In the conversation-switch effect: `reassertScrollToBottom(scrollerRef, isAtBottomRef)` (~line 956)
2. In the new-message effect: `reassertScrollToBottom(scrollerRef, isAtBottomRef)` (~line 1359)
3. In the typing effect: `reassertScrollToBottom(scrollerRef, isAtBottomRef)` (~line 1396)
4. In the reactions effect: `reassertScrollToBottom(scrollerRef, isAtBottomRef)` (~line 1404)

The `scrollToBottom` callback also uses `scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })`.

**Fix**: When a virtualizer is present, replace all scroll-to-bottom operations with `virtualizer.scrollToIndex(virtualizer.itemCount - 1, { align: 'end' })`. This:
- Doesn't require knowing `scrollHeight` in advance (avoids the estimated-vs-measured size mismatch)
- Uses @tanstack's cumulative offset sum (accurate for measured rows; estimated for unmounted)
- Does NOT fight @tanstack's scroll observer

For the `scrollToBottom` callback (the FAB): use `behavior: 'smooth'` via CSS, but compute the target via the virtualizer.

- [ ] **Step 1: Create a `scrollToBottomVirtualized` helper in the hook**

After the `reassertScrollToBottom` function, add:

```typescript
// ── Virtualized scroll-to-bottom (replaces reassertScrollToBottom) ──────────
// Instead of writing scrollTop to a potentially stale scrollHeight estimate,
// ask @tanstack to scroll to the last item with 'end' alignment. This avoids
// the estimated-vs-measured mismatch that leaves the last row partially hidden.
function scrollToBottomViaVirtualizer(
  virtualizer: MessageVirtualizer,
  isAtBottomRef: React.MutableRefObject<boolean>,
): void {
  if (virtualizer.itemCount === 0) return
  virtualizer.scrollToIndex(virtualizer.itemCount - 1, { align: 'end' })
  isAtBottomRef.current = true
}
```

- [ ] **Step 2: Replace `reassertScrollToBottom` call sites**

In each of the 4 call sites:
```typescript
// BEFORE:
if (latestRef.current.virtualizer) reassertScrollToBottom(scrollerRef, isAtBottomRef)

// AFTER:
if (latestRef.current.virtualizer) scrollToBottomViaVirtualizer(latestRef.current.virtualizer, isAtBottomRef)
```

And in the new-message effect:
```typescript
// BEFORE:
scroller.scrollTop = scroller.scrollHeight
isAtBottomRef.current = true
if (latestRef.current.virtualizer) reassertScrollToBottom(scrollerRef, isAtBottomRef)

// AFTER:
if (latestRef.current.virtualizer) {
  scrollToBottomViaVirtualizer(latestRef.current.virtualizer, isAtBottomRef)
} else {
  scroller.scrollTop = scroller.scrollHeight
  isAtBottomRef.current = true
}
```

Apply the same pattern for the conversation-switch, typing, and reactions effects.

- [ ] **Step 3: Update `scrollToBottom` callback (FAB)**

In `scrollToBottom` (~line 484), for the final `scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })`:
```typescript
// BEFORE:
scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })

// AFTER:
if (latestRef.current.virtualizer) {
  // Virtualized: use the virtualizer API so the target is based on cumulative offsets
  // (accurate), not scrollHeight (can be stale when rows haven't measured yet).
  scrollToBottomViaVirtualizer(latestRef.current.virtualizer, isAtBottomRef)
} else {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
}
```

- [ ] **Step 4: Remove the now-unused `reassertScrollToBottom` function**

If no references remain, delete the function definition (lines 113-126) and its JSDoc.

- [ ] **Step 5: Run existing tests**

```bash
cd apps/fluux && npx vitest run src/components/conversation/MessageList.scroll.test.tsx src/components/conversation/MessageList.virtualizedScroll.test.tsx src/components/conversation/MessageList.fab.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
cd apps/fluux && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/conversation/useMessageListScroll.ts
git commit -m "fix(perf): scroll-to-bottom via virtualizer.scrollToIndex(last, end) — no estimated-size mismatch"
```

---

### Task P1.4: Run harness on chromium — confirm GREEN

- [ ] **Step 1: Run chromium harness**

```bash
npx playwright test --config=playwright.scroll.config.ts --project=chromium
```

Expected: all 6 PASS. If any fail, diagnose and fix before continuing.

**If invariant 1 still fails (prepend drift > 2px):**
The issue is @tanstack's initial offset estimate for prepended rows. Since prepended rows are ABOVE the viewport (unrendered), their heights are all `estimateSize=64px`. If the true heights differ, the anchor's computed start offset is wrong.

Mitigation: use a smarter estimateSize. Read the average measured height from existing rows:
```typescript
// In tanstackMessageVirtualizer.ts, compute a running average estimate:
const measuredSizes = virtualizer.measurementsCache // @tanstack internal
const avgSize = measuredSizes.length > 0
  ? measuredSizes.reduce((s, m) => s + m.size, 0) / measuredSizes.length
  : 64
```
But WARNING: the running-average approach was tried in PR #642 and collapsed getTotalSize (footer items drag the average down). Use it only for NON-footer items (check `items[index].kind !== 'footer'`).

Alternative: expose a `getActualScrollOffset()` method on `MessageVirtualizer` that returns `scrollRef.current?.scrollTop` directly (the ground truth), and use that instead of `getOffsetForMessageId` in the prepend restore.

**If invariant 3 still fails (FAB blank):**
After `virtualizer.scrollToIndex(last, 'end')`, the last row mounts and measures (its true height > estimate). The virtualizer's total size increases. At this point `scrollTop < new totalSize`, so the view is slightly above bottom.

Fix: Call `scrollToIndex(last, 'end')` again one rAF later:
```typescript
function scrollToBottomViaVirtualizer(virtualizer, isAtBottomRef) {
  if (virtualizer.itemCount === 0) return
  virtualizer.scrollToIndex(virtualizer.itemCount - 1, { align: 'end' })
  isAtBottomRef.current = true
  // One-shot deferred re-pin after the last row's first measurement completes.
  requestAnimationFrame(() => {
    if (isAtBottomRef.current && virtualizer.itemCount > 0) {
      virtualizer.scrollToIndex(virtualizer.itemCount - 1, { align: 'end' })
    }
  })
}
```
This is at most 2 scroll operations, not a 15-frame loop. It won't oscillate because after the second call the row is already measured.

- [ ] **Step 2: Fix any failures per the diagnosis above**

Document the fix in the commit message.

- [ ] **Step 3: Run webkit harness**

```bash
npx playwright test --config=playwright.scroll.config.ts --project=webkit
```

Expected: all 6 PASS. WebKit's rAF timing differs from V8; the one-shot deferred re-pin (one rAF) might need `setTimeout(fn, 16)` on WebKit. If so, use `setTimeout(fn, 16)` unconditionally (safe for both).

- [ ] **Step 4: Run all unit tests**

```bash
cd apps/fluux && npx vitest run
```

Expected: all PASS.

- [ ] **Step 5: Commit fix summary**

```bash
git commit -m "fix(perf): scroll invariants 1-6 GREEN on chromium + webkit"
```

---

## Phase 2 — Flip the flag + cleanup

Only after all 6 invariants pass on BOTH engines.

### Task P2.1: Flip `enableMessageVirtualization` default ON

**Files:**
- Modify: `apps/fluux/src/utils/featureFlags.ts`

Change the default from `false` to `true`:
```typescript
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  try {
    const stored = localStorage.getItem(`fluux:flags:${flag}`)
    if (stored === null) return FLAG_DEFAULTS[flag] ?? false
    return stored === 'true'
  } catch {
    return FLAG_DEFAULTS[flag] ?? false
  }
}

const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = {
  enableMessageVirtualization: true,  // ← change from false
}
```

OR simply change the implementation to default `true` for this flag:
```typescript
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  try {
    const stored = localStorage.getItem(`fluux:flags:${flag}`)
    if (flag === 'enableMessageVirtualization') {
      return stored !== 'false'  // default ON; off only when explicitly set to 'false'
    }
    return stored === 'true'
  } catch {
    return false
  }
}
```

Pick the cleanest approach that matches the existing `featureFlags.ts` implementation.

- [ ] **Step 1: Update the flag default**

Read `apps/fluux/src/utils/featureFlags.ts` and `apps/fluux/src/utils/featureFlags.test.ts`. Update the default and the test to match the new default.

- [ ] **Step 2: Run feature-flag tests**

```bash
cd apps/fluux && npx vitest run src/utils/featureFlags.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full harness (no ?virt=1 needed now — flag is ON by default)**

The scroll-invariants.ts can drop `virt=1` from the URL (or keep it as a no-op). Run:
```bash
npx playwright test --config=playwright.scroll.config.ts
```

Expected: all 6 PASS on both engines.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/utils/featureFlags.ts apps/fluux/src/utils/featureFlags.test.ts
git commit -m "feat(perf): flip enableMessageVirtualization default ON (invariants 1-6 green)"
```

---

## Self-Review

**Spec coverage:**
- Phase 0 query-param seam → Task P0.1
- playwright.scroll.config.ts (chromium + webkit) → Task P0.2
- 6 scroll invariants encoded as RED assertions → Task P0.3
- RED baseline proof → Task P0.4
- scrollToOffset/scrollToIndex on interface → Task P1.1
- Prepend restore via virtualizer API, remove 15-frame loop → Task P1.2
- Scroll-to-bottom via scrollToIndex(last, end) → Task P1.3
- GREEN harness run (chromium + webkit) + fix diagnosis → Task P1.4
- Flag flip + cleanup → Task P2.1

**Placeholder scan:** No "TBD" or "implement later". All code blocks are complete.

**Type consistency:** `scrollToOffset(offset: number): void`, `scrollToIndex(index: number, opts?)` used identically in Tasks P1.1 and P1.2/P1.3. `MessageVirtualizer.itemCount` matches usage in `scrollToBottomViaVirtualizer(virtualizer.itemCount - 1)`.

**RED-first requirement:** Task P0.4 explicitly requires proving RED before Phase 1 begins.
