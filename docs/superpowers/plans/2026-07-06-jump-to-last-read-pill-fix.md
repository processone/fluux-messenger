# Jump-to-Last-Read Pill Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the jump-to-last-read pill (#870) durably appear after a jump-to-present, by stopping the message-list scroll layer from clearing the per-visit divider anchor on non-read events.

**Architecture:** `firstNewMessageId` is already a purely-visual, decoupled per-visit divider anchor at the store level (`firstNewMessageMarkers` Map; clearing it has no read-state side effects). The fix is a net *removal* of three over-aggressive clear branches in `useMessageListScroll.ts` (scrolled-past, DOM-trimmed, FAB-explicit), keeping only the genuine read-through clear (manual reach-bottom). No new state, no store changes. The pill's visibility, count, action, and the rendered divider row all continue to ride the one persisted anchor and stay in sync by construction.

**Tech Stack:** React + Zustand (SDK), Vitest (unit), Playwright (`scripts/scroll-invariants.ts`, driven by `npm run test:scroll`).

## Global Constraints

- This is the codebase's most fragile area. `npm run test:scroll` (46 invariants, ~3 min) MUST be green **before and after** the change.
- Chosen clear semantics — "skipped vs read-through": manual scroll *down* through the divider to the bottom clears it (read-through); a FAB / programmatic jump-to-present keeps the anchor and shows the pill (skip). Esc, mark-all-read, leave-tab/deactivation, and message-sent still clear it — those paths are unchanged and out of scope.
- No em-dashes / en-dashes in any user-facing text (none are added here; the pill copy already exists).
- Fraction/pixel anchors are not verifiable in jsdom — the pill behavior MUST be pinned by a real Playwright test in `scripts/scroll-invariants.ts`, not a unit test.
- Run app vitest from `apps/fluux` (root config lacks the `@` alias). Root typecheck is `npm run typecheck` from the repo root.
- No Claude footer in commit messages.

## File Structure

- Modify: `apps/fluux/src/components/conversation/useMessageListScroll.ts` — remove the two non-read clear branches in the scroll handler and the explicit clear in the FAB `scrollToBottom`.
- Modify (test): `scripts/scroll-invariants.ts` — add one Playwright test that FAB-jumps past a divider, asserts the pill appears, clicks it, and asserts the divider is returned to view.
- Unchanged (kept as-is): `apps/fluux/src/components/conversation/JumpToLastReadPill.tsx`, `JumpToLastReadPill.test.tsx`, `MessageList.tsx`, both stores.

---

### Task 1: Fix the clear conditions, pinned by a new scroll-invariant e2e

**Files:**
- Modify: `apps/fluux/src/components/conversation/useMessageListScroll.ts` (scroll handler ~1801-1822; `scrollToBottom` ~1338-1340 and its dep array ~1350)
- Test: `scripts/scroll-invariants.ts` (append one `test.describe` block near the end of the file)

**Interfaces:**
- Consumes (existing, unchanged): the store anchor `firstNewMessageId` and `clearFirstNewMessageId()` passed into `useMessageListScroll`; `markerAboveViewport` (returned) drives the pill; `scrollToMarker` (returned) is the pill's `onJump`.
- Produces: no new exported symbols. Behavior change only.
- Existing DOM contracts used by the test: scroller `[data-message-list]`, divider row `[data-new-message-marker]`, pill `[data-jump-to-last-read]`, FAB button `[data-fab="scroll-to-bottom"]`. Stress room JID constant already in the test file: `STRESS_ROOM_JID = 'stress-0@conference.fluux.chat'`. Helpers already in the file: `loadDemo`, `navigateToStressRoom`, `scrollToBottom`.

- [ ] **Step 1: Confirm the baseline is green**

Run from the repo root:

```bash
npm run test:scroll
```

Expected: all existing invariants PASS (green). Record this — it is the mandated before-gate. Do not proceed if red; investigate environment first (see the worktree preview note: `dev-wt` needs `--strictPort`).

- [ ] **Step 2: Write the failing e2e**

Append this block to the end of `scripts/scroll-invariants.ts`:

```ts
// ── Jump-to-last-read pill: survives a jump-to-present and returns to the divider (#870) ──
//
// Reproduces the "dead pill": read a room to the bottom, leave, receive MANY new messages
// while away, return (opens at the divider). Jump to present via the FAB. The per-visit
// anchor must SURVIVE the jump so the pill shows "N new · Jump to last read", and clicking
// it must return the divider to view. With the pre-fix clear branches this pill never
// durably appears, so this test goes RED against the bug.
test.describe('Jump-to-last-read pill', () => {
  test('pill appears after FAB jump-to-present and returns to the divider', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Read the room the real way, then pin lastSeen to the true last message.
    await scrollToBottom(page)
    await page.waitForTimeout(400)
    await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      const msgs = rs.roomRuntime.get(jid)?.messages ?? rs.rooms.get(jid)?.messages ?? []
      const last = msgs[msgs.length - 1]
      if (last) rs.updateLastSeenMessageId(jid, last.id)
    }, STRESS_ROOM_JID)

    // Leave the room (genuinely at the bottom, so no restore-position is saved).
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (window as any).__roomStore.getState().activateRoom(null)
    })
    await page.waitForTimeout(300)

    // Many new messages arrive while away, so the divider sits well above the live edge
    // (and its row is trimmed from the DOM once we jump — exercising the trim-survival path).
    const baseTs = Date.now()
    await page.evaluate(([jid, count, base]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      for (let i = 0; i < (count as number); i++) {
        c.emitSDK('room:message', {
          roomJid: jid,
          message: {
            type: 'groupchat', id: `pill-new-${base}-${i}`, from: `${jid}/AwayBot`, nick: 'AwayBot',
            body: `away message ${i} — the divider must survive a jump to present`,
            timestamp: new Date((base as number) + i), isOutgoing: false, roomJid: jid,
          },
          incrementUnread: true,
        })
      }
    }, [STRESS_ROOM_JID, 30, baseTs])
    await page.waitForTimeout(200)

    // Re-enter: opens at the divider, so the pill is hidden (divider visible).
    await navigateToStressRoom(page)
    await page.waitForTimeout(1500) // let the marker re-assert loop settle
    await expect(page.locator('[data-new-message-marker]'), 'divider row should exist on re-entry').toBeVisible()
    await expect(page.locator('[data-jump-to-last-read]'), 'pill is hidden while the divider is visible').toHaveCount(0)

    // Jump to present via the FAB (two-step: to marker, then to bottom). Click until at bottom.
    const fab = page.locator('[data-fab="scroll-to-bottom"]')
    for (let i = 0; i < 3; i++) {
      if (await fab.isVisible().catch(() => false)) {
        await fab.click()
        await page.waitForTimeout(600)
      }
      const dist = await page.evaluate(() => {
        const s = document.querySelector('[data-message-list]') as HTMLElement | null
        return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : 99999
      })
      if (dist < 8) break
    }

    // The anchor survived the jump: the pill now shows and offers the return.
    await expect(page.locator('[data-jump-to-last-read]'), 'pill must appear after a jump-to-present').toBeVisible({ timeout: 4000 })

    // Click the pill: the divider returns to view.
    await page.locator('[data-jump-to-last-read] button').click()
    await page.waitForTimeout(1200)
    const dividerVisible = await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const m = document.querySelector('[data-new-message-marker]') as HTMLElement | null
      if (!s || !m) return false
      const sr = s.getBoundingClientRect()
      const mr = m.getBoundingClientRect()
      return mr.bottom > sr.top && mr.top < sr.bottom
    })
    expect(dividerVisible, 'clicking the pill must return the divider to view').toBe(true)
  })
})
```

- [ ] **Step 3: Run the new e2e and verify it FAILS**

Run:

```bash
npx playwright test --config playwright.scroll.config.ts -g "pill appears after FAB"
```

Expected: FAIL at the "pill must appear after a jump-to-present" assertion (timeout) — the pre-fix clear branches kill the anchor, so the pill never shows.

- [ ] **Step 4: Remove the two non-read clear branches in the scroll handler**

In `apps/fluux/src/components/conversation/useMessageListScroll.ts`, find the marker-clear block (starts `if (firstNewMessageId && clearFirstNewMessageId && !programmaticScroll) {`). Replace the reached-bottom `else if` and its trailing `else` so ONLY the reached-bottom clear remains.

Replace this:

```ts
      } else if (distFromBottom < AT_BOTTOM_THRESHOLD) {
        // User reached the bottom — all new messages are visible
        debugLog('MARKER CLEAR (reached bottom)', { firstNewMessageId, distFromBottom })
        clearFirstNewMessageId()
      } else {
        const escapedId = CSS.escape(firstNewMessageId)
        const markerEl = el.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null
        if (markerEl) {
          const scrollerRect = el.getBoundingClientRect()
          const markerRect = markerEl.getBoundingClientRect()
          // Marker is "scrolled past" when its bottom edge is above the viewport
          if (markerRect.bottom < scrollerRect.top) {
            debugLog('MARKER CLEAR (scrolled past)', { firstNewMessageId })
            clearFirstNewMessageId()
          }
        } else {
          // Marker element not in DOM (trimmed) — clear it
          debugLog('MARKER CLEAR (not in DOM/trimmed)', { firstNewMessageId, distFromBottom })
          clearFirstNewMessageId()
        }
      }
```

With this:

```ts
      } else if (distFromBottom < AT_BOTTOM_THRESHOLD) {
        // User genuinely read through to the bottom — the "skipped vs read-through" clear.
        // NOTE: gated by `!programmaticScroll` above, so a FAB jump-to-present (which drives a
        // reassert loop) does NOT clear the anchor — the jump-to-last-read pill (#870) needs the
        // per-visit divider anchor to survive a skip. Scrolled-past / DOM-trimmed no longer clear:
        // those are exactly the states where the pill must show (moved toward the present without
        // reading). The anchor now clears only on read-through, Esc, mark-all-read, or deactivation.
        debugLog('MARKER CLEAR (reached bottom)', { firstNewMessageId, distFromBottom })
        clearFirstNewMessageId()
      }
```

- [ ] **Step 5: Remove the explicit clear in the FAB `scrollToBottom`**

In the same file, in the `scrollToBottom` callback, delete the explicit clear that runs on the jump-to-present step:

```ts
    if (firstNewMessageId) {
      clearFirstNewMessageId?.()
    }

```

(Delete those four lines. The lines immediately after — `const virtFab = latestRef.current.virtualizer` etc. — stay. The two-step marker check earlier in the callback that reads `firstNewMessageId` stays unchanged.)

- [ ] **Step 6: Drop the now-unused dep from `scrollToBottom`**

`scrollToBottom` no longer references `clearFirstNewMessageId`. Update its dependency array. Change:

```ts
  }, [firstNewMessageId, clearFirstNewMessageId, reassertBottom, rememberBottomIntent])
```

to:

```ts
  }, [firstNewMessageId, reassertBottom, rememberBottomIntent])
```

- [ ] **Step 7: Run the new e2e and verify it PASSES**

Run:

```bash
npx playwright test --config playwright.scroll.config.ts -g "pill appears after FAB"
```

Expected: PASS — the pill appears after the FAB jump and clicking it returns the divider to view.

- [ ] **Step 8: Run the full scroll suite and verify no regressions**

Run:

```bash
npm run test:scroll
```

Expected: all invariants PASS (green), including the new test. This is the mandated after-gate. Pay attention to invariant-3/4/5 (FAB + new-message-at-bottom) — if the reached-bottom clear now fires on a settling FAB scroll, harden its gate by replacing the `!programmaticScroll` guard on the clear block with the windowed `isProgrammaticScroll(programmaticScroll, Date.now(), lastProgrammaticScrollAtRef.current)` (already imported and used for the save-gate a few lines above), then re-run.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/components/conversation/useMessageListScroll.ts scripts/scroll-invariants.ts
git commit -m "fix(rooms): keep jump-to-last-read divider anchor through a jump-to-present (#870)"
```

---

### Task 2: Full-suite verification

**Files:** none (verification only; touch code only if a suite goes red).

**Interfaces:** none.

- [ ] **Step 1: Run the app unit suite**

Run from `apps/fluux`:

```bash
cd apps/fluux && npx vitest run
```

Expected: PASS, no stderr. In particular `JumpToLastReadPill.test.tsx` (props-driven, unchanged) and `NewMessageMarker.test.tsx` stay green. If a mock or snapshot broke, fix it in the test (the runtime contract did not change — the pill/divider components were not modified), then re-run.

- [ ] **Step 2: Run the root typecheck**

Run from the repo root:

```bash
npm run typecheck
```

Expected: PASS with no errors. (No SDK types changed, so no `build:sdk` is required first.)

- [ ] **Step 3: Commit any incidental fixes**

Only if Step 1 or 2 required an edit:

```bash
git add -A
git commit -m "test: keep suite green after jump-to-last-read pill fix (#870)"
```

If nothing changed, skip this commit.
