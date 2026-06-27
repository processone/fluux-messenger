# Aurora Chrome + Density — Phase 2 (Message Pane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the global Display-density preference to the central message pane: in Compact, message avatars and inter-group spacing tighten so more conversation fits, while Comfortable keeps today's look unchanged.

**Architecture:** Reuses Phase 1's infrastructure (`densityMode` in `settingsStore`, the `data-density` attribute on the document root via `useDensity`). Inter-group spacing is a CSS rule keyed on `[data-density="compact"]` against a new stable class — no React work. The avatar `size` (which CSS can't drive cleanly because of the presence dot) is read from the store via a narrow `useSettingsStore((s) => s.densityMode)` selector inside `MessageBubble`, exactly as the sidebar rows do. The `@tanstack/react-virtual` virtualizer already measures each row dynamically (`measureElement`), so density-changed heights re-measure with no new mechanism.

**Tech Stack:** React + TypeScript, `@tanstack/react-virtual`, Tailwind + CSS custom properties (`index.css`), Vitest + Testing Library.

## Global Constraints

- **Comfortable = today's look, unchanged.** Only Compact tightens. (The spec's Phase 2 table gave approximate numbers; this plan keeps Comfortable at the current values so default users see no regression, and uses real Avatar presets / Tailwind steps.) Final values:
  - Message avatar: **`md` (40px) comfortable / `sm` (32px) compact** (current is `md`).
  - Avatar left-column width: comfortable `w-10` (24h) / `w-12` (12h) as today; compact `w-8` (24h) / `w-10` (12h) so the smaller avatar has no gap.
  - Inter-group top spacing (group-start row): **`pt-4` (16px) comfortable / `pt-2` (8px) compact**.
  - **Body text size is NOT varied** by density (it has no size class, inherits the root font-size which the existing `fontSize` setting already scales; a 0.5px delta is not worth a new class).
- **Render-perf (binding):** `MessageBubble` reads `densityMode` via the NARROW selector `useSettingsStore((s) => s.densityMode)` only. This is a row-internal subscription, NOT a new compared prop — so `messageRowMemo.test.tsx` stays green (the subscription does not fire on message append or `isComposing` toggle, only on a density change). Do NOT add `densityMode` to `arePropsEqual` or thread it as a prop. CSS handles the spacing with zero re-render.
- **Virtualizer:** a density toggle changes row heights; the existing `measureElement` re-measures. As a defensive measure against the render-loop detector during the one-time re-measure burst, arm the interaction grace (`notifyUserInput()`) when `densityMode` changes. Scroll position near the bottom is preserved by the existing `pinVirtualizedBottom`.
- No em-dashes/en-dashes. No new dependencies.

## File Structure

- `apps/fluux/src/index.css` — `.message-group-start` density CSS (MODIFY).
- `apps/fluux/src/components/conversation/MessageBubble.tsx` — read `densityMode`; density avatar `size` + column width; swap inline `pt-4` for the named class (MODIFY).
- `apps/fluux/src/components/conversation/MessageList.tsx` — arm `notifyUserInput()` on `densityMode` change (MODIFY).
- `scripts/screenshots.ts` — message-pane compact scene (MODIFY).

---

### Task 1: Inter-group spacing density (CSS)

**Files:**
- Modify: `apps/fluux/src/index.css`
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx` (`outerRowClass`, ~line 404-406)
- Test: `apps/fluux/src/components/conversation/MessageBubble.test.tsx` (extend)

**Interfaces:**
- Produces: a `.message-group-start` class on group-start rows whose top padding is `pt-4`-equivalent comfortable / `pt-2`-equivalent compact.

- [ ] **Step 1: Write the failing test**

```tsx
// Group-start rows (showAvatar) carry the .message-group-start class; continuation rows do not.
it('marks group-start rows with the density spacing class', () => {
  // render a MessageBubble with showAvatar=true (group start) and one with showAvatar=false
  // (use the test file's existing MessageBubble render harness/props)
  // assert the group-start row's container className contains 'message-group-start'
  // assert the continuation row's does NOT
})
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx -t "group-start"`

- [ ] **Step 3: Add the CSS**

In `index.css` (near the other density rules / the message styles):

```css
/* Message group-start spacing. The vertical gap before a new sender group;
 * tightens in compact. Comfortable keeps the current 16px. */
.message-group-start { padding-top: 16px; }
[data-density="compact"] .message-group-start { padding-top: 8px; }
```

- [ ] **Step 4: Swap the inline `pt-4` for the class**

In `MessageBubble.tsx` `outerRowClass` (~line 404-406): replace the `${showAvatar ? 'pt-4' : ''}` (non-thread branch) and the thread-start `pt-3` handling with the named class. Concretely, in the non-thread branch change `${showAvatar ? 'pt-4' : ''}` to `${showAvatar ? 'message-group-start' : ''}`. (Leave the thread branch's `pt-3`/`pb-1.5` as-is — threads are a distinct layout; density spacing here targets the main timeline's group breaks. If the thread branch also uses a group-start gap worth tightening, note it as a follow-up rather than expanding scope.)

- [ ] **Step 5: Run the test — expect PASS.**

- [ ] **Step 6: Run the message tests + the perf guard**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx src/components/messageRowMemo.test.tsx`
Expected: PASS (perf guard green; the CSS change is class-only, no prop change).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/conversation/MessageBubble.test.tsx
git -c commit.gpgsign=false commit -m "feat(messages): density-aware inter-group spacing"
```

---

### Task 2: Message avatar size + column width by density

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx` (avatar ~472, column ~450)
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` (arm render-loop grace on density change)
- Test: `apps/fluux/src/components/conversation/MessageBubble.test.tsx`, `apps/fluux/src/components/messageRowMemo.test.tsx`

**Interfaces:**
- Consumes: `densityMode` from the store; `Avatar` `size` presets (`md`=40px, `sm`=32px).
- Produces: the message avatar is `md` comfortable / `sm` compact; the left column narrows to match in compact.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders a compact (sm) message avatar when density is compact', () => {
  useSettingsStore.getState().setDensityMode('compact')
  // render MessageBubble (showAvatar=true); the Avatar should receive size="sm"
  // (assert via the Avatar's rendered size class, e.g. the container has size-8, or
  //  via a test seam mirroring how the sidebar density test asserts avatar size)
})
it('keeps the md avatar in comfortable', () => {
  useSettingsStore.getState().setDensityMode('comfortable')
  // ... Avatar size="md" (size-10)
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Read density + size the avatar + column**

In `MessageBubble.tsx`, inside the component, add the narrow read (mirror the sidebar):

```tsx
const densityMode = useSettingsStore((s) => s.densityMode)
const avatarSize = densityMode === 'compact' ? 'sm' : 'md'
```

- Avatar (~line 472): change `size="md"` to `size={avatarSize}`.
- Left column (~line 450): the width currently `${timeFormat === '12h' ? 'w-12' : 'w-10'}`. Make it density-aware:

```tsx
const avatarColWidth = densityMode === 'compact'
  ? (timeFormat === '12h' ? 'w-10' : 'w-8')
  : (timeFormat === '12h' ? 'w-12' : 'w-10')
```

and use `${avatarColWidth}` in that `div`'s className.

(Import `useSettingsStore` if not already imported in the file. Confirm `arePropsEqual` is NOT changed — density reaches the row via this subscription, not a prop.)

- [ ] **Step 4: Arm the render-loop grace on density change**

In `MessageList.tsx`, add a defensive effect so the one-time re-measure burst after a density toggle does not trip the render-loop detector:

```tsx
const densityMode = useSettingsStore((s) => s.densityMode)
useEffect(() => {
  // A density change re-measures every visible row once; arm the interaction
  // grace window so the virtualizer's re-window burst is not flagged as a loop.
  notifyUserInput()
}, [densityMode])
```

(Use the same `notifyUserInput` import the scroll handling already uses; if it lives in `useMessageListScroll`, expose/import it or place this effect where `notifyUserInput` is in scope.)

- [ ] **Step 5: Run the tests + the perf guard — expect PASS**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx src/components/messageRowMemo.test.tsx`
Expected: PASS. **`messageRowMemo` MUST be green** — the density subscription must not cause rows to re-render on append (it only fires on a density change). If it fails, the implementation widened the subscription or added a compared prop — fix that.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/components/conversation/MessageBubble.test.tsx
git -c commit.gpgsign=false commit -m "feat(messages): density-aware message avatar + render-loop grace on toggle"
```

---

### Task 3: Screenshot scene + full verification

**Files:**
- Modify: `scripts/screenshots.ts`
- Verify: whole suite, typecheck, lint, screenshots

- [ ] **Step 1: Add a compact message-pane scene**

In `scripts/screenshots.ts`, mirror the Phase 1 compact pattern: there is already a `?density=compact` URL seam (`demo.tsx`) that drives the store. Add a scene that loads the demo with `&density=compact`, opens a conversation (reuse how an existing chat scene like `01-chat-dark` navigates into a thread), and captures the message pane. Name it e.g. `3y-chat-compact-dark`. The existing `01-chat-dark` is the comfortable comparison.

- [ ] **Step 2: Typecheck + lint**

Run from repo root: `npm run typecheck && npm run lint`
Expected: clean, 0 errors.

- [ ] **Step 3: Full suite**

Run from repo root: `npm test`
Expected: all pass, no stderr. Confirm `messageRowMemo` is green.

- [ ] **Step 4: Screenshots**

Run from repo root: `npm run screenshots`
Expected: completes; compare `01-chat-dark.png` (comfortable) vs `3y-chat-compact-dark.png` (compact) — the compact message pane should show smaller avatars and tighter group spacing (more messages per screen). If they do NOT visibly differ, the density is not reaching the pane — investigate (is `MessageBubble` reading `densityMode`? is `.message-group-start` present?) before claiming success.

- [ ] **Step 5: Commit**

```bash
git add scripts/screenshots.ts screenshots/
git -c commit.gpgsign=false commit -m "feat(messages): compact message-pane screenshot scene + regen"
```

---

## Self-Review

**Spec coverage (chrome spec Phase 2 section):**
- Message avatar density → Task 2 (40/32 via `md`/`sm`; refined from the spec's approximate 36/28 — see Global Constraints). ✓
- Inter-group spacing density → Task 1 (16/8; refined from the spec's approximate ~12/6). ✓
- Body text density → intentionally dropped (negligible; the `fontSize` setting covers text scaling). Documented in Global Constraints. ✓
- Virtualizer re-measure + scroll preservation → relies on the existing `measureElement` + `pinVirtualizedBottom`; the defensive `notifyUserInput` arm (Task 2) covers the detector. ✓
- `messageRowMemo` green → Global Constraints + Tasks 1-2 (CSS + row-internal narrow subscription, no compared prop). ✓

**Placeholder scan:** no TBD/TODO; each code step shows real code. The test-harness references ("use the file's existing MessageBubble render harness", "how the sidebar density test asserts avatar size") point at concrete existing patterns.

**Type consistency:** `densityMode`/`useSettingsStore` from Phase 1; Avatar `size` values (`md`/`sm`) match the presets; `.message-group-start` / `[data-density="compact"]` selectors consistent across Task 1.

## Open flags for the controller / human

- **Value refinements from the spec's approximate Phase 2 numbers:** Comfortable is kept at today's values (avatar 40px, group spacing 16px) so default users see no change; only Compact tightens (avatar 32px, spacing 8px). The spec's literal 36/28 and ~12/6 are not used because they would shrink the default and don't map to clean Avatar presets. Body-text density is dropped. Flag if you want the literal spec numbers or a comfortable that also shrinks.
- **Thread layout** (the `inThread` branch) keeps its current spacing; only the main timeline's group-start gap is density-aware. Flag if threads should tighten too.
