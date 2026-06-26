# Aurora P0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip Fluux to the Aurora identity (deep-ink ramp, periwinkle accent, sender palette, display font) and distinguish people (circular avatars) from rooms (rounded-square icons) — with no structural/layout changes.

**Architecture:** This is a Foundation-tier token swap plus two contained component changes. The 14 built-in themes each override the full `--fluux-base-*` ramp and accent in their own definitions, so changing the `:root`/`.light` defaults only changes the default ("Fluux") theme — themes are unaffected. The avatar-shape change adds a `shape` prop to `Avatar` and flips `rounded-full → rounded-xl` on the room-icon renderers. No store subscriptions, hooks, or layout regions change.

**Tech Stack:** React + TypeScript, Tailwind CSS (tokens via CSS custom properties in `apps/fluux/src/index.css` + aliases in `apps/fluux/tailwind.config.js`), Vitest + Testing Library, self-hosted Inter (woff2 in `apps/fluux/public/fonts`).

**Spec:** `docs/superpowers/specs/2026-06-26-aurora-design-direction.md` (§3 design language, §5 token mapping, §7 P0).

## Global Constraints

- Keep all 14 built-in themes working — only edit `:root` (dark default) and `.light` in `index.css`; never edit `src/themes/builtins/*`.
- No new runtime dependencies. Inter Tight is self-hosted as woff2; any tooling dep used to fetch it must not remain in `package.json`/`package-lock.json`.
- No new store subscriptions in list/row/header components (render-perf constraint). `Avatar`/room-icon take props only.
- Maintain WCAG AA for text; keep i18n/RTL behavior unchanged.
- Room shape = `rounded-xl` (12px). People shape = `rounded-full`. Use these two classes consistently.
- Commit after each task. No Claude footer in commit messages.
- Default register is **Expressive** (gradients/glow live in later phases; P0 only lays tokens + shape + font).

---

### Task 1: Add a `shape` prop to `Avatar`

**Files:**
- Modify: `apps/fluux/src/components/Avatar.tsx`
- Test: `apps/fluux/src/components/Avatar.test.tsx`

**Interfaces:**
- Produces: `Avatar` accepts `shape?: 'circle' | 'square'` (default `'circle'`). `'square'` renders `rounded-xl`; `'circle'` renders `rounded-full`. Consumed by Task 2 (`RoomHeader`).

- [ ] **Step 1: Write the failing tests**

Add to `apps/fluux/src/components/Avatar.test.tsx`:

```tsx
import { render } from '@testing-library/react'
import { Avatar } from './Avatar'

test('Avatar defaults to a circle', () => {
  const { container } = render(<Avatar identifier="emma@fluux.chat" name="Emma" />)
  expect((container.firstChild as HTMLElement).className).toContain('rounded-full')
})

test('Avatar shape="square" renders a rounded square', () => {
  const { container } = render(<Avatar identifier="team@conference.fluux.chat" name="Team" shape="square" />)
  const root = container.firstChild as HTMLElement
  expect(root.className).toContain('rounded-xl')
  expect(root.className).not.toContain('rounded-full')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/Avatar.test.tsx`
Expected: the `square` test FAILS (root still has `rounded-full`).

- [ ] **Step 3: Implement the prop**

In `apps/fluux/src/components/Avatar.tsx`:

Add to `AvatarProps` (after `forceOffline`):

```tsx
  /**
   * Avatar shape. People are circular; rooms/groups are rounded squares.
   * @default 'circle'
   */
  shape?: 'circle' | 'square'
```

Add `shape = 'circle',` to the destructured props (after `forceOffline = false,`).

After the `sizeClasses` line, add:

```tsx
  const radiusClass = shape === 'square' ? 'rounded-xl' : 'rounded-full'
```

Replace the three hardcoded `rounded-full` (container, `<img>`, letter fallback `<div>`):

```tsx
  const containerClasses = [
    sizeClasses.container,
    `${radiusClass} relative flex-shrink-0`,
    isClickable ? 'cursor-pointer' : 'cursor-default',
    className,
  ].filter(Boolean).join(' ')
```

```tsx
          className={`w-full h-full ${radiusClass} object-cover`}
```

```tsx
        <div
          className={`w-full h-full ${radiusClass} flex items-center justify-center`}
          style={{ backgroundColor }}
        >
```

(Leave the presence-dot `rounded-full` as-is — the dot stays round.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/Avatar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/Avatar.tsx apps/fluux/src/components/Avatar.test.tsx
git commit -m "feat(avatar): add shape prop (circle for people, square for rooms)"
```

---

### Task 2: Make all room icons rounded squares

**Files:**
- Modify: `apps/fluux/src/components/RoomHeader.tsx` (Avatar at ~:114, Hash `<div>` at ~:123)
- Modify: `apps/fluux/src/components/ChatHeader.tsx` (group `<div>` at ~:109)
- Modify: `apps/fluux/src/components/sidebar-components/ConversationList.tsx` (img ~:295, Hash ~:302)
- Modify: `apps/fluux/src/components/sidebar-components/RoomsList.tsx` (img ~:412, Zap ~:416, Hash ~:419)
- Modify: `apps/fluux/src/components/RoomListItem.tsx` (icon `<div>` ~:20)

**Interfaces:**
- Consumes: `Avatar` `shape` prop from Task 1.

- [ ] **Step 1: RoomHeader — square the room Avatar and the Hash fallback**

In `RoomHeader.tsx`, add `shape="square"` to the room `<Avatar>`:

```tsx
        <Avatar
          identifier={room.jid}
          name={room.name}
          avatarUrl={room.avatar}
          size="header"
          shape="square"
        />
```

And change the Hash fallback `<div>` class `size-9 rounded-full flex items-center justify-center flex-shrink-0` → replace `rounded-full` with `rounded-xl`.

- [ ] **Step 2: ChatHeader — square the group icon**

In `ChatHeader.tsx`, change `size-9 bg-fluux-bg rounded-full flex items-center justify-center flex-shrink-0` → replace `rounded-full` with `rounded-xl`.

- [ ] **Step 3: ConversationList — square the room avatar/icon**

In `ConversationList.tsx`, in the `isGroupChat` branch:
- img: `size-8 rounded-full object-cover` → replace `rounded-full` with `rounded-xl`.
- Hash: `size-8 p-1.5 rounded-full text-white` → replace `rounded-full` with `rounded-xl`.

- [ ] **Step 4: RoomsList — square the three room-icon variants**

In `RoomsList.tsx`:
- img: `size-8 rounded-full object-cover` → `rounded-xl`.
- Zap: `size-8 p-1.5 bg-amber-500/20 rounded-full text-amber-500` → `rounded-xl`.
- Hash: `size-8 p-1.5 rounded-full text-white` → `rounded-xl`.

- [ ] **Step 5: RoomListItem — align radius**

In `RoomListItem.tsx`, change `flex-shrink-0 size-8 rounded-lg bg-fluux-bg ...` → replace `rounded-lg` with `rounded-xl`.

- [ ] **Step 6: Verify type + suite**

Run: `npm run typecheck`
Expected: passes, no errors.
Run: `cd apps/fluux && npx vitest run src/components/RoomHeader.test.tsx src/components/ChatHeader.test.tsx`
Expected: PASS (existing tests still green).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/RoomHeader.tsx apps/fluux/src/components/ChatHeader.tsx apps/fluux/src/components/sidebar-components/ConversationList.tsx apps/fluux/src/components/sidebar-components/RoomsList.tsx apps/fluux/src/components/RoomListItem.tsx
git commit -m "feat(avatars): render room icons as rounded squares (people stay circular)"
```

---

### Task 3: Aurora dark Foundation (`:root`)

**Files:**
- Modify: `apps/fluux/src/index.css` (`:root` ramp ~:70-86, `--fluux-text-self` ~:143)

- [ ] **Step 1: Replace the dark neutral ramp + accent**

In `index.css` `:root`, replace the neutral ramp values and accent triplet:

```css
  /* Neutral ramp (00 = darkest, 100 = lightest) */
  --fluux-base-00: #090D18;
  --fluux-base-05: #0A0F1E;
  --fluux-base-10: #0B1020;
  --fluux-base-20: #0E1326;
  --fluux-base-30: #0F1528;
  --fluux-base-40: #141B30;
  --fluux-base-50: #1A2238;
  --fluux-base-60: #2A3553;
  --fluux-base-70: #5E6B8A;
  --fluux-base-80: #97A4C4;
  --fluux-base-90: #E9EDF7;
  --fluux-base-100: #F4F6FC;

  /* Accent (HSL components for composability) */
  --fluux-accent-h: 231;
  --fluux-accent-s: 100%;
  --fluux-accent-l: 71%;
```

- [ ] **Step 2: Update own-message name color**

Replace `--fluux-text-self: #a5b4fc;` with `--fluux-text-self: #A9B4FF;`.

- [ ] **Step 3: Verify in the browser (dark)**

Run: `npm run dev`, open `http://localhost:5173/demo.html`.
Expected: the app is now deep ink-navy with a periwinkle accent; nothing is unreadable; layout unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/index.css
git commit -m "feat(theme): Aurora dark foundation — deep ink ramp + periwinkle accent"
```

---

### Task 4: Aurora light Foundation (`.light`)

**Files:**
- Modify: `apps/fluux/src/index.css` (`.light` ramp ~:299-310, `--fluux-text-self` ~:320; add light accent override)

- [ ] **Step 1: Replace the light neutral ramp**

In `index.css` `.light`, replace the neutral ramp values:

```css
  /* Foundation overrides (light ramp — 00 = lightest, 100 = darkest) */
  --fluux-base-00: #FFFFFF;
  --fluux-base-05: #F4F6FC;
  --fluux-base-10: #E7EAF4;
  --fluux-base-20: #EEF0F8;
  --fluux-base-30: #FFFFFF;
  --fluux-base-40: #E4E8F3;
  --fluux-base-50: #DDE2F0;
  --fluux-base-60: #C2C9DC;
  --fluux-base-70: #8A93AD;
  --fluux-base-80: #5C6685;
  --fluux-base-90: #1B2233;
  --fluux-base-100: #0E1426;
```

- [ ] **Step 2: Darken the accent for white-on-accent AA + update own-name**

In the `.light` block, add an accent-lightness override (so white text on accent buttons clears AA on light):

```css
  /* Accent darkened for AA on light surfaces (white text on accent fills) */
  --fluux-accent-l: 60%;
```

Replace `--fluux-text-self: #4f46e5;` with `--fluux-text-self: #4F5BD8;`.

- [ ] **Step 3: Verify in the browser (light)**

Run: `npm run dev`, open `http://localhost:5173/demo.html`, switch to Light in Settings → Appearance.
Expected: cool-white surfaces, chrome reads as light cool-grey, accent buttons have legible white text, sender names/body clear on white. Check a primary button (e.g. "Start Conversation") — white label must be readable; if not, lower `--fluux-accent-l` to `58%`.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/index.css
git commit -m "feat(theme): Aurora light foundation — cool-white ramp + AA accent"
```

---

### Task 5: Aurora identity tokens (accent-2, gradient, sender palette, glass, overlay shadow)

**Files:**
- Modify: `apps/fluux/src/index.css` (`:root` add block; `.light` add block)
- Modify: `apps/fluux/tailwind.config.js` (`colors.fluux` aliases; `fontFamily`)

**Interfaces:**
- Produces tokens used by later phases: `--fluux-accent-2`, `--fluux-grad`, `--fluux-sender-1..6`, `--fluux-glass-bg`, `--fluux-glass-blur`, `--fluux-shadow-overlay`. Tailwind aliases: `fluux.accent-2`, `fluux.sender-1..6`.

- [ ] **Step 1: Add the dark identity tokens to `:root`**

In `index.css` `:root`, after the accent triplet, add:

```css
  /* ── Aurora identity additions ── */
  --fluux-accent-2: #38E0C4;
  --fluux-grad: linear-gradient(135deg, #38E0C4, #7C8CFF, #A78BFA);
  --fluux-sender-1: #9FD4FF;
  --fluux-sender-2: #6FE3B0;
  --fluux-sender-3: #FFCB73;
  --fluux-sender-4: #FF9DB0;
  --fluux-sender-5: #C2ABFF;
  --fluux-sender-6: #67D4D0;
  --fluux-glass-bg: rgba(20, 27, 48, 0.74);
  --fluux-glass-blur: 12px;
  --fluux-shadow-overlay: 0 24px 70px rgba(0, 0, 0, 0.55);
```

- [ ] **Step 2: Add the light overrides to `.light`**

In `index.css` `.light`, add:

```css
  /* ── Aurora identity (light) ── */
  --fluux-accent-2: #11A88C;
  --fluux-grad: linear-gradient(135deg, #11A88C, #5B6CF0, #7C6CF0);
  --fluux-sender-1: #1E84D8;
  --fluux-sender-2: #119E73;
  --fluux-sender-3: #B5790E;
  --fluux-sender-4: #D8527A;
  --fluux-sender-5: #6E54D8;
  --fluux-sender-6: #128C86;
  --fluux-glass-bg: rgba(255, 255, 255, 0.72);
  --fluux-shadow-overlay: 0 20px 50px rgba(20, 27, 48, 0.18);
```

- [ ] **Step 3: Add Tailwind aliases**

In `tailwind.config.js`, inside `colors.fluux`, add:

```js
          'accent-2': 'var(--fluux-accent-2)',
          'sender-1': 'var(--fluux-sender-1)',
          'sender-2': 'var(--fluux-sender-2)',
          'sender-3': 'var(--fluux-sender-3)',
          'sender-4': 'var(--fluux-sender-4)',
          'sender-5': 'var(--fluux-sender-5)',
          'sender-6': 'var(--fluux-sender-6)',
```

- [ ] **Step 4: Verify build**

Run: `npm run typecheck`
Expected: passes (Tailwind config + CSS are not type-checked, but this confirms nothing else broke).
Run: `npm run dev` and confirm the app still loads with no console errors.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/tailwind.config.js
git commit -m "feat(theme): add Aurora identity tokens (accent-2, gradient, sender palette, glass, overlay)"
```

---

### Task 6: Unread badge in accent (not alarm-red)

**Files:**
- Modify: `apps/fluux/src/index.css` (`--fluux-badge-bg` ~:243)
- Modify: `apps/fluux/tailwind.config.js` (`colors.fluux` badge aliases)
- Modify: `apps/fluux/src/components/sidebar-components/ConversationList.tsx` (~:318)
- Modify: `apps/fluux/src/components/sidebar-components/RoomsList.tsx` (~:441)
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` (~:511)

- [ ] **Step 1: Point the badge token at the accent**

In `index.css`, change:

```css
  --fluux-badge-bg: var(--fluux-bg-accent);
  --fluux-badge-text: #ffffff;
```

- [ ] **Step 2: Add Tailwind badge aliases**

In `tailwind.config.js`, inside `colors.fluux`, add:

```js
          'badge': 'var(--fluux-badge-bg)',
          'badge-text': 'var(--fluux-badge-text)',
```

- [ ] **Step 3: Swap the three unread-count badges**

In each file, in the unread-count `<span>`, replace `bg-fluux-red text-white` with `bg-fluux-badge text-fluux-badge-text`:
- `ConversationList.tsx` (the `conversation.unreadCount > 0` span).
- `RoomsList.tsx` (the `room.unreadCount > 0 && room.mentionsCount === 0` span).
- `MessageList.tsx` (the scroll-to-bottom unread `<span>`).

Leave every other `bg-fluux-red` (error buttons, panels, mention badges) untouched.

- [ ] **Step 4: Verify**

Run: `npm run typecheck` → passes.
Run: `npm run dev`, open demo; conversations/rooms with unread counts show the periwinkle accent badge, not red. Error buttons remain red.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/tailwind.config.js apps/fluux/src/components/sidebar-components/ConversationList.tsx apps/fluux/src/components/sidebar-components/RoomsList.tsx apps/fluux/src/components/conversation/MessageList.tsx
git commit -m "feat(theme): unread badges use the accent token instead of alarm-red"
```

---

### Task 7: Register the Inter Tight display font

**Files:**
- Create: `apps/fluux/public/fonts/InterTight-Medium.woff2`, `apps/fluux/public/fonts/InterTight-SemiBold.woff2`
- Modify: `apps/fluux/src/index.css` (add `@font-face` blocks ~after :49; add `--fluux-font-display` ~:112)
- Modify: `apps/fluux/tailwind.config.js` (`fontFamily.display`)

**Interfaces:**
- Produces: `--fluux-font-display` and Tailwind `font-display`. Falls back to Inter, so registering it changes nothing visually until later phases apply it. (Applying it to headers/titles is P2.)

- [ ] **Step 1: Obtain the self-hosted woff2 (no lasting dependency)**

```bash
npm i -D @fontsource/inter-tight
cp node_modules/@fontsource/inter-tight/files/inter-tight-latin-500-normal.woff2 apps/fluux/public/fonts/InterTight-Medium.woff2
cp node_modules/@fontsource/inter-tight/files/inter-tight-latin-600-normal.woff2 apps/fluux/public/fonts/InterTight-SemiBold.woff2
npm uninstall @fontsource/inter-tight
git checkout package.json package-lock.json
```

Verify both files exist and are non-empty: `ls -l apps/fluux/public/fonts/InterTight-*.woff2`.

- [ ] **Step 2: Add the `@font-face` blocks**

In `index.css`, after the last Inter `@font-face` (the Bold block), add:

```css
@font-face {
  font-family: 'Inter Tight';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/InterTight-Medium.woff2') format('woff2');
}

@font-face {
  font-family: 'Inter Tight';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/InterTight-SemiBold.woff2') format('woff2');
}
```

- [ ] **Step 3: Add the display-font token**

In `index.css` `:root`, after `--fluux-font-ui: ...;`, add:

```css
  --fluux-font-display: 'Inter Tight', 'Inter', system-ui, sans-serif;
```

- [ ] **Step 4: Add the Tailwind family**

In `tailwind.config.js`, in `fontFamily`, add:

```js
        display: ['var(--fluux-font-display)'],
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → passes.
Run: `npm run dev`; in DevTools confirm `InterTight-*.woff2` load with 200 (Network), no 404s. Confirm `git status` shows only the two woff2 + index.css + tailwind.config.js staged-worthy changes (no package.json/lock drift).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/public/fonts/InterTight-Medium.woff2 apps/fluux/public/fonts/InterTight-SemiBold.woff2 apps/fluux/src/index.css apps/fluux/tailwind.config.js
git commit -m "feat(type): self-host Inter Tight as the display font token"
```

---

### Task 8: Full verification + refreshed screenshots

**Files:**
- Modify: `screenshots/*.png`, `screenshots/OVERVIEW.md` (regenerated)

- [ ] **Step 1: Build the SDK (so app type/build is clean)**

Run: `npm run build:sdk`
Expected: completes without error.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck`
Expected: no errors.
Run the repo lint script (see `package.json` `scripts`, e.g. `npm run lint`).
Expected: no new errors.

- [ ] **Step 3: Full test suite (no stderr)**

Run: `npm test`
Expected: all pass, no stderr. (App tests live under `apps/fluux`; `Avatar.test.tsx` includes the new shape tests.)

- [ ] **Step 4: Regenerate screenshots and eyeball**

Run: `npm run screenshots`
Open and confirm:
- `screenshots/01-chat-dark.png` — deep ink-navy, periwinkle accent, circular people avatars.
- `screenshots/03-conversation-list-dark.png` — rooms show rounded-square icons; people show circles; unread badges are accent (not red).
- `screenshots/02-group-chat-dark.png` — room header icon is a rounded square.
- `screenshots/11-chat-light.png` — light mode readable; accent legible on white.
- Spot-check a built-in theme (Settings → Appearance → Dracula) still renders correctly (proves the ramp swap didn't touch themes).

- [ ] **Step 5: Commit**

```bash
git add screenshots
git commit -m "docs(screenshots): regenerate for Aurora P0 foundations"
```

---

## Self-Review

**Spec coverage (§7 P0 = ramp, accent, sender palette, elevation tokens, Inter Tight, badge):**
- Dark ramp + accent → Task 3. Light ramp + accent → Task 4. ✓
- Sender palette + accent-2 + gradient + glass + overlay shadow → Task 5. ✓
- Unread badge → accent → Task 6. ✓
- Inter Tight → Task 7. ✓
- Avatar shape (people vs rooms, user-requested first step) → Tasks 1–2. ✓
- Verification + screenshots → Task 8. ✓
- Themes untouched (Global Constraints; only `:root`/`.light` edited) ✓. Render-perf (props-only changes) ✓.

**Deferred (correctly out of P0):** applying `font-display` to headers, the gradient brand mark / glass command palette / message-grammar grouping (P1–P3); a shared `RoomIcon` component to DRY the room-icon renderers (P2 chrome cleanup — P0 keeps surgical class flips to stay low-risk).

**Placeholder scan:** none — every step has exact files, strings, and commands.

**Type/name consistency:** `shape: 'circle' | 'square'` and `rounded-xl` used consistently across Tasks 1–2; token names match between `index.css` additions (Task 5) and the Tailwind aliases; `--fluux-badge-bg`/`--fluux-badge-text` match the `bg-fluux-badge`/`text-fluux-badge-text` aliases (Task 6).

**Open items (from spec §9, tune during build, not blockers):** light chrome cool-grey warmth; final accent saturation light vs dark (Task 4 Step 3 gives the AA fallback `58%`).
