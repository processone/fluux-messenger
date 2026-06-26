# Aurora Message Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the Aurora identity to the message list — luminous per-person sender colors, an own-message accent edge, and an accent new-messages divider — without touching the (already-unified) grouping or the render-perf hot path.

**Architecture:** A pure `auroraSenderColor(identifier, isDarkMode)` helper (continuous XEP-0392 hue, Aurora-tuned saturation/lightness, AA-corrected in light) replaces the `senderColor` computation at the 3 sites that feed `MessageBubble`; the tuned color flows automatically to the avatar, reply chip, mentions, and occupant panel. A `.message-own-edge` CSS class is applied to outgoing message bodies. `NewMessageMarker` moves from red to accent.

**Tech Stack:** React + TypeScript, Tailwind, Vitest + Testing Library, CSS custom properties in `apps/fluux/src/index.css`.

**Spec:** `docs/superpowers/specs/2026-06-26-aurora-message-identity-design.md`.

## Global Constraints

- No SDK changes; no new dependencies.
- Render-perf: add NO new props to `MessageBubble` and NO new store subscriptions. `senderColor` and `message.isOutgoing` are already compared in `arePropsEqual`. `messageRowMemo.test.tsx` (appending / typing must not re-render existing rows) MUST stay green.
- Sender name colors clear WCAG AA (≥4.5:1) on both the resting (`--fluux-chat-bg`) and hover (`--fluux-bg-hover`) message rows, in both modes. Dark is AA by construction; light is AA-corrected against a representative light row luminance of `0.80` (covers white chat bg + the slightly darker hover row).
- Sender colors are deterministic per `identifier` and theme-independent (same across all 14 themes, only dark/light differ) — consistent with today's `getConsistentTextColor`.
- Tuned params (verbatim): dark `{ saturation: 75, lightness: 72 }`; light `{ saturation: 65, lightness: 45 }` then AA-correct.
- Commit after each task. No "Claude" footer / co-author trailer. (GPG signing is unavailable in this worktree — if `git commit` fails to sign, use `git -c commit.gpgsign=false commit`.)

---

### Task 1: Shared contrast util (`utils/contrastColor.ts`)

**Files:**
- Create: `apps/fluux/src/utils/contrastColor.ts`
- Create: `apps/fluux/src/utils/contrastColor.test.ts`
- Modify: `apps/fluux/src/components/Avatar.tsx` (import the moved helpers; delete the local copies)

**Interfaces:**
- Produces: `hexToRgb`, `getLuminance(r,g,b)`, `contrastRatio(l1,l2)`, `ensureContrast(hex, bgLuminance, ratio=4.5)`, `ensureContrastWithWhite(hex)`. Consumed by Task 2 and by `Avatar.tsx`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/contrastColor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getLuminance, contrastRatio, ensureContrast, ensureContrastWithWhite, hexToRgb } from './contrastColor'

describe('contrastColor', () => {
  it('parses hex to rgb', () => {
    expect(hexToRgb('#ff8800')).toEqual({ r: 255, g: 136, b: 0 })
  })

  it('ensureContrastWithWhite darkens a light color until AA on white', () => {
    const out = ensureContrastWithWhite('#FFE066') // light yellow, fails on white
    const rgb = hexToRgb(out)!
    expect(contrastRatio(getLuminance(rgb.r, rgb.g, rgb.b), 1.0)).toBeGreaterThanOrEqual(4.5)
  })

  it('ensureContrast leaves an already-dark color unchanged', () => {
    expect(ensureContrast('#103060', 0.8)).toBe('#103060')
  })

  it('ensureContrast darkens until AA on the given background', () => {
    const out = ensureContrast('#66D08A', 0.8) // light green on a light bg
    const rgb = hexToRgb(out)!
    expect(contrastRatio(getLuminance(rgb.r, rgb.g, rgb.b), 0.8)).toBeGreaterThanOrEqual(4.5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/contrastColor.test.ts`
Expected: FAIL — `Cannot find module './contrastColor'`.

- [ ] **Step 3: Implement the util**

Create `apps/fluux/src/utils/contrastColor.ts`:

```ts
/** Color contrast helpers (WCAG). Shared by Avatar and sender-color generation. */

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : null
}

/** Relative luminance (0-1) per WCAG. */
export function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function toHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/**
 * Darken `hex` until it reaches `ratio` contrast against a background of
 * luminance `bgLuminance`. Returns the original if it already passes.
 */
export function ensureContrast(hex: string, bgLuminance: number, ratio = 4.5): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  let factor = 0
  let r = rgb.r, g = rgb.g, b = rgb.b
  while (contrastRatio(getLuminance(r, g, b), bgLuminance) < ratio && factor < 0.92) {
    factor += 0.08
    r = Math.round(rgb.r * (1 - factor))
    g = Math.round(rgb.g * (1 - factor))
    b = Math.round(rgb.b * (1 - factor))
  }
  return toHex(r, g, b)
}

/** Convenience: AA (4.5:1) against pure white. */
export function ensureContrastWithWhite(hex: string): string {
  return ensureContrast(hex, 1.0, 4.5)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/contrastColor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: De-duplicate `Avatar.tsx`**

In `apps/fluux/src/components/Avatar.tsx`: add `import { ensureContrastWithWhite } from '@/utils/contrastColor'` near the top imports, then DELETE the now-duplicate module-private functions `hexToRgb`, `getLuminance`, `darkenColor`, and `ensureContrastWithWhite` (they live around lines 115-182). Keep `getConsistentTextColor` and everything else. The call site (the avatar fallback color, ~line 247) keeps using `ensureContrastWithWhite` — now the imported one.

- [ ] **Step 6: Verify Avatar still works**

Run: `npm run typecheck`
Expected: clean.
Run: `cd apps/fluux && npx vitest run src/components/Avatar.test.tsx`
Expected: PASS (unchanged behavior — `ensureContrastWithWhite` is identical, just relocated).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/utils/contrastColor.ts apps/fluux/src/utils/contrastColor.test.ts apps/fluux/src/components/Avatar.tsx
git commit -m "refactor(color): extract shared WCAG contrast helpers to utils/contrastColor"
```

---

### Task 2: `auroraSenderColor` helper

**Files:**
- Create: `apps/fluux/src/utils/senderColor.ts`
- Create: `apps/fluux/src/utils/senderColor.test.ts`

**Interfaces:**
- Consumes: `ensureContrast` from `utils/contrastColor` (Task 1); `generateConsistentColorHexSync` from `@fluux/sdk`.
- Produces: `auroraSenderColor(identifier: string, isDarkMode: boolean): string` (hex). Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/senderColor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { auroraSenderColor } from './senderColor'
import { getLuminance, contrastRatio, hexToRgb } from './contrastColor'

// Chat-row + hover-row luminances for AA assertions.
const DARK_HOVER_LUM = 0.02   // ~ --fluux-bg-hover (dark)
const LIGHT_HOVER_LUM = 0.80  // representative light row (white chat + slightly darker hover)

function lum(hex: string) {
  const c = hexToRgb(hex)!
  return getLuminance(c.r, c.g, c.b)
}

describe('auroraSenderColor', () => {
  it('is deterministic per identifier + mode', () => {
    expect(auroraSenderColor('alice@x', true)).toBe(auroraSenderColor('alice@x', true))
    expect(auroraSenderColor('alice@x', false)).toBe(auroraSenderColor('alice@x', false))
  })

  it('generally differs for different identifiers', () => {
    const a = auroraSenderColor('alice@x', true)
    const b = auroraSenderColor('bob@x', true)
    expect(a).not.toBe(b)
  })

  it('clears AA on the dark hover row (dark mode)', () => {
    for (const id of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi']) {
      expect(contrastRatio(lum(auroraSenderColor(id, true)), DARK_HOVER_LUM)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('clears AA on the light hover row (light mode)', () => {
    for (const id of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi']) {
      expect(contrastRatio(lum(auroraSenderColor(id, false)), LIGHT_HOVER_LUM)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/senderColor.test.ts`
Expected: FAIL — `Cannot find module './senderColor'`.

- [ ] **Step 3: Implement the helper**

Create `apps/fluux/src/utils/senderColor.ts`:

```ts
import { generateConsistentColorHexSync } from '@fluux/sdk'
import { ensureContrast } from './contrastColor'

/**
 * Representative light message-row luminance to AA-correct against. Covers the
 * white chat surface and the slightly darker hover row (the harder case).
 */
const LIGHT_ROW_LUMINANCE = 0.80

/**
 * Aurora-tuned per-person sender color. Continuous XEP-0392 hue (deterministic
 * from `identifier`, theme-independent), tuned to luminous jewel tones on the
 * deep base in dark mode, and AA-corrected for the light message rows in light
 * mode. Replaces the raw getConsistentTextColor for sender names so everyone
 * stays distinct in large rooms while harmonizing with Aurora.
 */
export function auroraSenderColor(identifier: string, isDarkMode: boolean): string {
  if (isDarkMode) {
    // Luminous on near-black; AA on resting + hover rows by construction.
    return generateConsistentColorHexSync(identifier, { saturation: 75, lightness: 72 })
  }
  // Vibrant base, then darken intrinsically-light hues until AA on the light rows.
  const base = generateConsistentColorHexSync(identifier, { saturation: 65, lightness: 45 })
  return ensureContrast(base, LIGHT_ROW_LUMINANCE, 4.5)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/senderColor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/senderColor.ts apps/fluux/src/utils/senderColor.test.ts
git commit -m "feat(color): add auroraSenderColor (continuous, Aurora-tuned, AA-corrected)"
```

---

### Task 3: Wire `auroraSenderColor` into the message views

**Files:**
- Modify: `apps/fluux/src/components/conversation/roomSenderResolution.ts` (`resolveSenderColor`, ~:102-109)
- Modify: `apps/fluux/src/components/ChatView.tsx` (senderColor block, ~:806-817)
- Modify: `apps/fluux/src/components/conversation/roomSenderResolution.test.ts` (if it asserts contact-color precedence)

**Interfaces:**
- Consumes: `auroraSenderColor` (Task 2).
- Note: `RoomView.tsx` needs no change — it calls `resolveSenderColor`, which we update here.

- [ ] **Step 1: Update `resolveSenderColor`**

In `roomSenderResolution.ts`, replace the body of `resolveSenderColor` so the tuned color is used for everyone (drop the roster `contactColor` precedence — intentional, for one consistent system). Add `import { auroraSenderColor } from '@/utils/senderColor'`. New function:

```ts
export function resolveSenderColor(
  identifier: string,
  _contact: Pick<ContactIdentity, 'colorLight' | 'colorDark'> | undefined,
  isDarkMode: boolean,
): string {
  // Aurora: one consistent, AA-tuned per-person color for all senders — the
  // roster's precomputed contact color is intentionally not used for names.
  return auroraSenderColor(identifier, isDarkMode)
}
```

(Keep the `_contact` param so `resolveNickColor` and `RoomView` call sites are unchanged.)

- [ ] **Step 2: Update `ChatView.tsx`**

Replace the senderColor block (~:813-817) so the non-outgoing branch uses `auroraSenderColor` (drop the `senderContact` color path). Add `import { auroraSenderColor } from '@/utils/senderColor'`. New block:

```ts
  // Get sender color: dedicated AA-safe self color for own messages, else the
  // Aurora-tuned per-person color (consistent for known + unknown senders).
  const senderColor = message.isOutgoing
    ? 'var(--fluux-text-self)'
    : auroraSenderColor(message.from.split('/')[0], isDarkMode)
```

- [ ] **Step 3: Fix any test that asserted contact-color precedence**

Run: `cd apps/fluux && npx vitest run src/components/conversation/roomSenderResolution.test.ts`
If a test asserts that a known contact's `colorDark`/`colorLight` is returned, update it: `resolveSenderColor` now returns `auroraSenderColor(identifier, isDarkMode)` regardless of contact. Assert it equals `auroraSenderColor(identifier, isDarkMode)` (import it in the test). If no such assertion exists, no change.

- [ ] **Step 4: Verify type + perf guard + view tests**

Run: `npm run typecheck` → clean.
Run: `cd apps/fluux && npx vitest run src/components/messageRowMemo.test.tsx src/components/conversation/roomSenderResolution.test.ts src/components/conversation/MessageBubble.test.tsx`
Expected: PASS (the memo guard stays green — no new props were added; only the value `senderColor` is computed differently).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/roomSenderResolution.ts apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/conversation/roomSenderResolution.test.ts
git commit -m "feat(messages): use auroraSenderColor for sender names (1:1 + rooms)"
```

---

### Task 4: Own-message luminous edge

**Files:**
- Modify: `apps/fluux/src/index.css` (add `.message-own-edge`)
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx` (content div, ~:486)
- Modify: `apps/fluux/src/components/conversation/MessageBubble.test.tsx` (add a test)

- [ ] **Step 1: Write the failing test**

Add to `apps/fluux/src/components/conversation/MessageBubble.test.tsx` (inside the top-level `describe('MessageBubble', ...)`):

```ts
  describe('Own-message edge', () => {
    it('applies the own-edge class to outgoing messages', () => {
      const props = createDefaultProps({ message: createTestMessage({ isOutgoing: true }) })
      const { container } = render(<MessageBubble {...props} />)
      expect(container.querySelector('.message-own-edge')).toBeInTheDocument()
    })

    it('does not apply the own-edge class to incoming messages', () => {
      const props = createDefaultProps({ message: createTestMessage({ isOutgoing: false }) })
      const { container } = render(<MessageBubble {...props} />)
      expect(container.querySelector('.message-own-edge')).not.toBeInTheDocument()
    })
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx -t "Own-message edge"`
Expected: FAIL — `.message-own-edge` not found on the outgoing render.

- [ ] **Step 3: Add the CSS class**

In `apps/fluux/src/index.css`, after the `.message-highlight` rule (~:771), add:

```css
/* Own-message accent edge — a quiet luminous spine on outgoing messages
   (Aurora). Decorative; the own-name color (--fluux-text-self) carries identity,
   so this isn't contrast-bound. Tint kept subtle so body text AA holds. */
.message-own-edge {
  border-inline-start: 2px solid var(--fluux-bg-accent);
  background: hsla(var(--fluux-accent-h), var(--fluux-accent-s), var(--fluux-accent-l), 0.08);
  border-radius: 0 var(--fluux-radius-m) var(--fluux-radius-m) 0;
  padding-inline: 0.5rem;
  margin-inline-start: -0.5rem;
}
```

- [ ] **Step 4: Apply the class in `MessageBubble.tsx`**

In the content `<div>` (the `className` template literal at ~:486 — the one that already toggles selection + `inThread` classes), append a third conditional `${message.isOutgoing ? 'message-own-edge' : ''}` to the end of the template string (inside the same backtick expression, before the closing backtick). Do not add any new prop — `message.isOutgoing` is already in scope and already memo-compared.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx`
Expected: PASS (existing + the 2 new own-edge tests).

- [ ] **Step 6: Verify perf guard unaffected**

Run: `cd apps/fluux && npx vitest run src/components/messageRowMemo.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/conversation/MessageBubble.test.tsx
git commit -m "feat(messages): luminous accent edge on own messages"
```

---

### Task 5: New-messages divider → accent

**Files:**
- Modify: `apps/fluux/src/components/conversation/NewMessageMarker.tsx`
- Create: `apps/fluux/src/components/conversation/NewMessageMarker.test.tsx`

**Interfaces:**
- Note: the label uses `var(--fluux-text-self)` — the AA-tuned accent-family color already used for own-name on the message rows (clears AA on the rows in both modes). The raw accent (`bg-fluux-brand`) is too dark as small text on the dark rows (~3.8:1), so we reuse the AA-safe accent value here too.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/NewMessageMarker.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { NewMessageMarker } from './NewMessageMarker'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

describe('NewMessageMarker', () => {
  it('uses the accent color, not alarm-red', () => {
    const { container } = render(<NewMessageMarker />)
    expect(container.querySelector('.bg-fluux-red')).not.toBeInTheDocument()
    expect(container.querySelector('.text-fluux-error')).not.toBeInTheDocument()
    // lines + label carry the AA-safe accent-family color via inline style
    const styled = container.querySelectorAll('[style*="--fluux-text-self"]')
    expect(styled.length).toBe(3)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/NewMessageMarker.test.tsx`
Expected: FAIL — the current markup still has `bg-fluux-red` / `text-fluux-error` and no inline accent style.

- [ ] **Step 3: Update the marker**

Replace the body of `NewMessageMarker` in `apps/fluux/src/components/conversation/NewMessageMarker.tsx`:

```tsx
  return (
    <div className="flex items-center gap-4 h-12">
      <div className="flex-1 h-px" style={{ backgroundColor: 'var(--fluux-text-self)' }} />
      <span className="text-xs font-semibold" style={{ color: 'var(--fluux-text-self)' }}>
        {t('chat.newMessages')}
      </span>
      <div className="flex-1 h-px" style={{ backgroundColor: 'var(--fluux-text-self)' }} />
    </div>
  )
```

Also update the JSDoc comment above the component from "red horizontal line" to "accent horizontal line".

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/NewMessageMarker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/NewMessageMarker.tsx apps/fluux/src/components/conversation/NewMessageMarker.test.tsx
git commit -m "feat(messages): accent new-messages divider (was alarm-red)"
```

---

### Task 6: Remove the dead `--fluux-sender-*` tokens

**Files:**
- Modify: `apps/fluux/src/index.css` (remove dark `:root` block ~:124-129 and `.light` block ~:445-450)
- Modify: `apps/fluux/tailwind.config.js` (remove aliases ~:48-53)

- [ ] **Step 1: Confirm they are unused**

Run: `grep -rn "fluux-sender" apps/fluux/src --include="*.tsx" --include="*.ts" | grep -v ".test."`
Expected: no output (the continuous approach in Tasks 2-3 does not use them).

- [ ] **Step 2: Delete the tokens**

In `apps/fluux/src/index.css`, delete the six `--fluux-sender-1..6` lines in `:root` (~:124-129) and the six in `.light` (~:445-450). In `apps/fluux/tailwind.config.js`, delete the six `'sender-1'..'sender-6'` alias lines (~:48-53).

- [ ] **Step 3: Verify**

Run: `npm run typecheck` → clean.
Run: `grep -rn "fluux-sender" apps/fluux` → no output anywhere (CSS, TS, config all clean).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/tailwind.config.js
git commit -m "chore(theme): remove superseded discrete sender-palette tokens"
```

---

### Task 7: Screenshot scene + full verification

**Files:**
- Modify: `scripts/screenshots.ts` (add a message-list scene)
- Modify: `screenshots/*.png`, `screenshots/OVERVIEW.md` (regenerated)

- [ ] **Step 1: Add a message-list screenshot scene**

In `scripts/screenshots.ts`, add a scene (follow the existing scene pattern in that file — `test('NN — …', …)`) that opens a room with several distinct senders, includes one own (outgoing) message, and shows the new-messages divider, then captures `screenshots/NN-message-identity-dark.png` (and a `-light` variant). Use the next free scene number. This locks the rendered sender colors / own-edge / divider for visual regression (the colors are not unit-testable as CSS values).

- [ ] **Step 2: Full automated verification**

Run: `npm run build:sdk` → completes.
Run: `npm run typecheck` → clean.
Run: `npm test` → all pass, no stderr (includes `contrastColor`, `senderColor`, `MessageBubble`, `NewMessageMarker`, `messageRowMemo`, `roomSenderResolution`).
Run the repo lint (see `package.json` scripts) → no new errors.

- [ ] **Step 3: Regenerate screenshots and eyeball**

Run: `npm run screenshots`
Confirm in the regenerated set:
- A busy room: every sender name a distinct luminous hue (dark) / distinct AA-safe hue (light); avatar fallback matches the name; reply chips + @mentions + occupant panel match per person.
- Own messages show the subtle accent left-edge.
- The new-messages divider is accent, not red.
- Spot-check a built-in theme still renders.

- [ ] **Step 4: Commit**

```bash
git add scripts/screenshots.ts screenshots
git commit -m "feat(messages): message-identity screenshot scene + regen"
```

---

## Self-Review

**Spec coverage:**
- Sender colors (continuous, Aurora-tuned, AA-corrected, wired at 3 sites, flows everywhere) → Tasks 2-3 (+ util Task 1). ✓
- Own-message luminous edge → Task 4. ✓
- New-messages divider → accent → Task 5. ✓
- Remove dead `--fluux-sender-*` → Task 6. ✓
- Render-perf (no new props/subscriptions; memo guard green) → asserted in Tasks 3, 4 (run `messageRowMemo.test.tsx`). ✓
- AA on resting + hover, both modes → encoded in `auroraSenderColor` + tested in Task 2. ✓
- Screenshot scene → Task 7. ✓
- Out of scope (density, grouping, bubbles) → not in any task. ✓

**Placeholder scan:** none — every step has exact files, code, and commands.

**Type consistency:** `auroraSenderColor(identifier: string, isDarkMode: boolean): string` and `ensureContrast(hex, bgLuminance, ratio)` are defined in Tasks 1-2 and used with matching signatures in Tasks 2-3. `resolveSenderColor` keeps its existing 3-arg signature (the `_contact` arg retained), so `resolveNickColor` and `RoomView` callers are unaffected.

**Open item (verify during build):** the `MessageBubble` content-div edit (Task 4 Step 4) appends to an existing template literal — the implementer must read the exact current `className` string at that line and append `${message.isOutgoing ? 'message-own-edge' : ''}` without disturbing the selection / `inThread` conditionals.
