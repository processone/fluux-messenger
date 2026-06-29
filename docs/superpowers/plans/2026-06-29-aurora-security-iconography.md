# Aurora Security Iconography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the E2EE trust-lock iconography behind one tokenized resolver, unify the `verified` color on teal, calm one over-alarming non-threat, and tokenize the remaining bare palette colors in the E2EE banners and key dialogs.

**Architecture:** A small pure resolver (`trustVisual`) maps a normalized trust-visual state to a color token plus a tone; the three trust-lock surfaces consume it. The E2EE banners and key dialogs are correctly alarming and only get their bare palette TEXT and solid-fill colors swapped onto the existing tokens (alpha tints and hover-shade buttons stay bare, because Tailwind opacity modifiers do not apply to `var()` colors).

**Tech Stack:** React + TypeScript, Tailwind + CSS custom properties, Vitest + Testing Library, lucide-react. No SDK changes.

## Global Constraints

- **Tokens only, no new color values.** Use the existing Aurora tokens: `text-fluux-encryption` (teal verified), `text-fluux-muted` (gray), `text-fluux-yellow` (= `--fluux-status-warning`), `text-fluux-error` (red text), `bg-fluux-red`/`bg-fluux-yellow`/`bg-fluux-green` (solid fills), `text-fluux-green` (= `--fluux-status-success`).
- **Two visible changes ONLY:** Security-tab `verified` green to teal; chat-header `keyLocked` yellow to gray. Every other change is a token swap with no visible difference.
- **Preserve:** per-message `untrusted` stays yellow (real decrypt-failure); VerifyPeerDialog SAS code-match green (`Check` at `VerifyPeerDialog.tsx:180` and the input border) stays green (input-validation success, not a trust state); all icons unchanged; all genuinely-alarming states (`blocked`/`keyChanged` yellow, `rejected` red, compromise red, destructive buttons red) unchanged. No SDK change.
- **Tailwind opacity constraint:** `bg-fluux-*`/`border-fluux-*` tokens are `var()` colors; Tailwind opacity modifiers (`/10`, `/30`) do NOT apply to them. So alpha-tinted card backgrounds/borders (`bg-yellow-500/10`, `border-red-500/30`, `bg-red-50 dark:bg-red-950/30`) MUST stay bare. Only solid fills (no `/NN`) and text colors tokenize.
- **Danger buttons with a hover shade** (`bg-red-500 hover:bg-red-600`, `bg-red-600 hover:bg-red-700`) stay bare: there is no `bg-fluux-red` hover token, and these are conventional destructive-action buttons (assessed intentional in the theme audit's Batch D).
- **No em-dashes or en-dashes** in user-facing strings. Run app tests from `apps/fluux` (the repo-root vitest config lacks the `@` alias). Commit with `git -c commit.gpgsign=false`; no Claude footer.

## File Structure

- Create: `apps/fluux/src/e2ee/trustVisual.ts` (the resolver), `apps/fluux/src/e2ee/trustVisual.test.ts` (guard).
- Modify (lock surfaces, Task 2): `apps/fluux/src/components/conversation/MessageBubble.tsx`, `apps/fluux/src/components/ChatHeader.tsx`, `apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`.
- Modify (tokenization, Task 3): `apps/fluux/src/components/KeyChangeBanner.tsx`, `OwnKeyConflictBanner.tsx`, `TrustStateCompromisedBanner.tsx`, `DeleteOpenpgpKeyDialog.tsx`, `IdentityChoiceDialog.tsx`, `BackupPassphraseDialog.tsx`, `RestorePassphraseDialog.tsx`, `VerifyPeerDialog.tsx`, `UnlockEncryptionDialog.tsx`.

---

### Task 1: The `trustVisual` resolver

**Files:**
- Create: `apps/fluux/src/e2ee/trustVisual.ts`
- Test: `apps/fluux/src/e2ee/trustVisual.test.ts`

**Interfaces:**
- Produces: `trustVisual(state: TrustVisualState): { colorClass: string; tone: TrustTone }`; the `TrustVisualState` and `TrustTone` unions.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/e2ee/trustVisual.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { trustVisual } from './trustVisual'

describe('trustVisual', () => {
  it('maps verified to the teal encryption token', () => {
    expect(trustVisual('verified')).toEqual({ colorClass: 'text-fluux-encryption', tone: 'verified' })
  })
  it('maps trusted (tofu) to calm gray', () => {
    expect(trustVisual('trusted')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('CALMS keyLocked to gray (own un-entered passphrase is not a threat)', () => {
    expect(trustVisual('keyLocked')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('maps decryptFailed and keyChanged to the warning token', () => {
    expect(trustVisual('decryptFailed').colorClass).toBe('text-fluux-yellow')
    expect(trustVisual('decryptFailed').tone).toBe('warning')
    expect(trustVisual('keyChanged')).toEqual({ colorClass: 'text-fluux-yellow', tone: 'warning' })
  })
  it('maps rejected to the error token', () => {
    expect(trustVisual('rejected')).toEqual({ colorClass: 'text-fluux-error', tone: 'danger' })
  })
  it('maps plaintext and checking to calm gray', () => {
    expect(trustVisual('plaintext')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
    expect(trustVisual('checking')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/trustVisual.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the resolver**

Create `apps/fluux/src/e2ee/trustVisual.ts`:

```ts
/**
 * The single source of truth for the COLOR of an E2EE trust indicator.
 *
 * "Calm by default": routine states (TOFU, your own un-entered passphrase,
 * plaintext, an in-flight probe) are neutral gray; verified is the teal
 * encryption brand color; only a genuine anomaly (a message that could not be
 * decrypted, a rotated peer key, a forged signature) is yellow or red.
 *
 * Returns COLOR and tone only. The icon stays the responsibility of each
 * surface, because the inline per-message lock (compact Lock) and the header
 * affordance (prominent Shield) are deliberately different glyphs.
 */
export type TrustTone = 'verified' | 'calm' | 'warning' | 'danger'

export type TrustVisualState =
  | 'verified'      // out-of-band-confirmed peer key
  | 'trusted'       // tofu / tofu-new / introduced / encrypted-unverified
  | 'decryptFailed' // per-message untrusted: could not decrypt this message
  | 'rejected'      // forged or absent signature
  | 'keyChanged'    // peer key rotated, encryption blocked pending acceptance
  | 'keyLocked'     // the user's own key passphrase is not entered (friction, not a threat)
  | 'plaintext'     // not encrypted / unsupported / user-forced cleartext
  | 'checking'      // encryption probe in flight

export interface TrustVisual {
  colorClass: string
  tone: TrustTone
}

export function trustVisual(state: TrustVisualState): TrustVisual {
  switch (state) {
    case 'verified':
      return { colorClass: 'text-fluux-encryption', tone: 'verified' }
    case 'decryptFailed':
    case 'keyChanged':
      return { colorClass: 'text-fluux-yellow', tone: 'warning' }
    case 'rejected':
      return { colorClass: 'text-fluux-error', tone: 'danger' }
    case 'trusted':
    case 'keyLocked':
    case 'plaintext':
    case 'checking':
      return { colorClass: 'text-fluux-muted', tone: 'calm' }
  }
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd apps/fluux && npx vitest run src/e2ee/trustVisual.test.ts` (expect PASS), then `npm run typecheck` from repo root (expect clean; if phantom `loadMessagesAround` errors appear, they are a stale SDK dist, run `npm run build:sdk` once).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/e2ee/trustVisual.ts apps/fluux/src/e2ee/trustVisual.test.ts
git -c commit.gpgsign=false commit -m "feat(e2ee): trustVisual resolver (calm-by-default trust colors)"
```

---

### Task 2: Apply the resolver to the three lock surfaces

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx`, `apps/fluux/src/components/ChatHeader.tsx`, `apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`

**Interfaces:**
- Consumes: `trustVisual` / `TrustVisualState` from `@/e2ee/trustVisual` (Task 1).

This task carries the two visible changes (SecurityTab verified green to teal; ChatHeader keyLocked yellow to gray) and routes the lock-icon colors through the resolver.

- [ ] **Step 1: MessageBubble per-message lock**

In `apps/fluux/src/components/conversation/MessageBubble.tsx`, add the import near the other `@/` imports:
```tsx
import { trustVisual, type TrustVisualState } from '@/e2ee/trustVisual'
```
Replace the color ternary on the lock span (lines ~602-610). Current:
```tsx
                  className={`flex items-center ${
                    displayTrust === 'verified'
                      ? 'text-fluux-encryption'
                      : displayTrust === 'rejected'
                      ? 'text-red-500'
                      : displayTrust === 'untrusted'
                      ? 'text-yellow-500'
                      : 'text-fluux-muted'
                  }`}
```
New (map the display trust to a visual state, then read the token):
```tsx
                  className={`flex items-center ${trustVisual(
                    displayTrust === 'verified'
                      ? 'verified'
                      : displayTrust === 'rejected'
                      ? 'rejected'
                      : displayTrust === 'untrusted'
                      ? 'decryptFailed'
                      : 'trusted'
                  ).colorClass}`}
```
The icon ternary just below (rejected => `ShieldAlert`, else `Lock`) is unchanged.

- [ ] **Step 2: ChatHeader keyLocked (the calm change) + rejected**

In `apps/fluux/src/components/ChatHeader.tsx`, add the import:
```tsx
import { trustVisual } from '@/e2ee/trustVisual'
```
KeyLocked icon (line ~221) is the calm change. Current:
```tsx
        className={`${btnClass} text-yellow-500 hover:text-yellow-600 cursor-pointer`}
```
New (gray, calm; it is your own passphrase prompt, not a peer threat):
```tsx
        className={`${btnClass} ${trustVisual('keyLocked').colorClass} hover:text-fluux-text cursor-pointer`}
```
Rejected icon (line ~314). Current:
```tsx
            className={`${btnClass} text-red-500 hover:text-red-600 cursor-pointer`}
```
New:
```tsx
            className={`${btnClass} ${trustVisual('rejected').colorClass} cursor-pointer`}
```
Rejected popover title (line ~326). Current:
```tsx
            <div className="text-sm font-medium text-red-600 dark:text-red-400 mb-1.5">
```
New:
```tsx
            <div className="text-sm font-medium text-fluux-error mb-1.5">
```

- [ ] **Step 3: ChatHeader blocked + verified/tofu (route through resolver, no visible change)**

Blocked icon uses an inline style `style={{ color: 'var(--fluux-status-warning)' }}` at lines ~284 and ~295. Replace BOTH inline styles with the resolver token class. At line ~283-284 (the interactive button) change:
```tsx
            className={`${btnClass} cursor-pointer`}
            style={{ color: 'var(--fluux-status-warning)' }}
```
to:
```tsx
            className={`${btnClass} ${trustVisual('keyChanged').colorClass} cursor-pointer`}
```
And at line ~295 (the non-interactive div) change:
```tsx
        <div className={`${btnClass}`} style={{ color: 'var(--fluux-status-warning)' }} role="status">
```
to:
```tsx
        <div className={`${btnClass} ${trustVisual('keyChanged').colorClass}`} role="status">
```
The encrypted verified/tofu `colorClass` (lines ~396-398) already uses the right tokens; route it through the resolver for consistency. Current:
```tsx
  const colorClass = verified
    ? 'text-fluux-encryption'
    : 'text-fluux-muted hover:text-fluux-text'
```
New:
```tsx
  const colorClass = verified
    ? trustVisual('verified').colorClass
    : `${trustVisual('trusted').colorClass} hover:text-fluux-text`
```

- [ ] **Step 4: SecurityTab verified (green to teal) + tokenize**

In `apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`, add the import:
```tsx
import { trustVisual } from '@/e2ee/trustVisual'
```
Verified icon (line ~106) is the green-to-teal change. Current:
```tsx
                  <ShieldCheck className="size-5 text-green-600 dark:text-green-400 flex-shrink-0" />
```
New:
```tsx
                  <ShieldCheck className={`size-5 ${trustVisual('verified').colorClass} flex-shrink-0`} />
```
Blocked icon (line ~35). Current:
```tsx
            icon={<ShieldAlert className="size-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />}
```
New:
```tsx
            icon={<ShieldAlert className={`size-5 ${trustVisual('keyChanged').colorClass} flex-shrink-0`} />}
```
Rejected icon (line ~44). Current:
```tsx
              icon={<ShieldX className="size-5 text-red-600 dark:text-red-400 flex-shrink-0" />}
```
New:
```tsx
              icon={<ShieldX className={`size-5 ${trustVisual('rejected').colorClass} flex-shrink-0`} />}
```

- [ ] **Step 5: SecurityTab ExplanationPanel title text (tokenize; leave the alpha bg tints)**

Still in `SecurityTab.tsx`, the `ExplanationPanel` `titleColor` (lines ~183-188) uses bare text colors. Current:
```tsx
  const titleColor =
    tone === 'danger'
      ? 'text-red-700 dark:text-red-400'
      : tone === 'warning'
        ? 'text-yellow-700 dark:text-yellow-400'
        : 'text-fluux-text'
```
New (text tokens):
```tsx
  const titleColor =
    tone === 'danger'
      ? 'text-fluux-error'
      : tone === 'warning'
        ? 'text-fluux-yellow'
        : 'text-fluux-text'
```
LEAVE the `bg` ternary (lines ~175-182: `bg-green-500/10`, `bg-red-500/10`, `bg-yellow-500/10`) unchanged: those are alpha tints and the opacity modifier does not work on `var()` tokens.

- [ ] **Step 6: Run the affected tests + typecheck + lint**

Run from `apps/fluux`: `npx vitest run src/components/conversation/MessageBubble.test.tsx src/components/ChatHeader.test.tsx src/components/contact-profile 2>/dev/null` (keep green; update any snapshot/assertion that pinned the old SecurityTab green or keyLocked yellow). Then from repo root `npm run typecheck` (clean) and `npm run lint` (0 errors). Confirm `messageRowMemo.test.tsx` stays green (MessageBubble change is render-equivalent: a className string swap, no new prop/subscription).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/ChatHeader.tsx apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx
git -c commit.gpgsign=false commit -m "feat(e2ee): route trust-lock colors through trustVisual; verified=teal, keyLocked calm"
```

---

### Task 3: Tokenize the E2EE banners and key dialogs

**Files:**
- Modify: `KeyChangeBanner.tsx`, `OwnKeyConflictBanner.tsx`, `TrustStateCompromisedBanner.tsx`, `DeleteOpenpgpKeyDialog.tsx`, `IdentityChoiceDialog.tsx`, `BackupPassphraseDialog.tsx`, `RestorePassphraseDialog.tsx`, `VerifyPeerDialog.tsx`, `UnlockEncryptionDialog.tsx` (all under `apps/fluux/src/components/`)

No resolver, no semantic change: these are correctly alarming / destructive-action UI. Apply ONE mechanical rule to the bare palette classes, then verify by grep.

**The rule (apply per occurrence):**
- TEXT color, no alpha: `text-red-{500,600,700} [dark:text-red-{200,300,400,500}]` => `text-fluux-error`. `text-yellow-{500,600,700} [dark:text-yellow-{400,500}]` => `text-fluux-yellow`. `text-green-{500,600} [dark:text-green-400]` => `text-fluux-green`.
- SOLID fill, no alpha modifier and no `hover:` shade pair: `bg-green-500` => `bg-fluux-green`; `bg-red-500` (standalone) => `bg-fluux-red`; `bg-yellow-500` (standalone) => `bg-fluux-yellow`.
- LEAVE bare (do NOT change): any class with an alpha modifier (`bg-yellow-500/10`, `border-red-500/30`, `bg-red-50`, `dark:bg-red-950/30`, etc.), and any destructive button with a hover shade (`bg-red-500 hover:bg-red-600`, `bg-red-600 hover:bg-red-700`).
- EXCEPTION (do NOT change): `VerifyPeerDialog.tsx` lines ~125-126 and ~173/180 are the SAS code-match success indicators (a green `Check` and the matched-input border): input-validation success, not a trust state. Leave the green there as-is.

**Per-file targets** (from the bare-palette grep; apply the rule above):
- `KeyChangeBanner.tsx`: line 102 `border-yellow-500/30 bg-yellow-500/10` LEAVE (alpha); line 104 `text-yellow-600 dark:text-yellow-400` => `text-fluux-yellow`; line 112 `text-yellow-700 dark:text-yellow-500` => `text-fluux-yellow`.
- `OwnKeyConflictBanner.tsx`: line 89 `border-red-500/30 bg-red-500/10` LEAVE (alpha); line 91 `text-red-600 dark:text-red-400` => `text-fluux-error`; line 133 `text-red-600 dark:text-red-400` => `text-fluux-error`.
- `TrustStateCompromisedBanner.tsx`: line 33 `border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30` LEAVE (light/dark card tints); line 35 `text-red-600 dark:text-red-400` => `text-fluux-error`; line 37 `text-red-800 dark:text-red-200` => `text-fluux-error`; line 40 `text-red-700 dark:text-red-300` => `text-fluux-error`; line 51 `text-red-600 dark:text-red-400` => `text-fluux-error`; line 57 `text-red-600 dark:text-red-400` => `text-fluux-error`; line 69 `bg-red-600 hover:bg-red-700` LEAVE (destructive button hover pair).
- `DeleteOpenpgpKeyDialog.tsx`: line 102 `bg-yellow-500/10` LEAVE (alpha); line 103 `text-yellow-600 dark:text-yellow-400` => `text-fluux-yellow`; line 128 `text-red-500 dark:text-red-400` => `text-fluux-error`; line 145 `bg-red-500 hover:bg-red-600` LEAVE (destructive button).
- `IdentityChoiceDialog.tsx`: line 195 `text-yellow-600 dark:text-yellow-400` => `text-fluux-yellow`; line 229 `bg-yellow-500/10` LEAVE (alpha); line 230 `text-yellow-600 dark:text-yellow-400` => `text-fluux-yellow`; line 247 `text-red-500 dark:text-red-400` => `text-fluux-error`; line 299 `bg-red-600 hover:bg-red-700` LEAVE (destructive button); line 328 `border-yellow-500/30 bg-yellow-500/10` LEAVE (alpha).
- `BackupPassphraseDialog.tsx`: line 183 `bg-yellow-500/10` LEAVE (alpha); line 184 `text-yellow-600 dark:text-yellow-400` => `text-fluux-yellow`; line 221 `text-green-500` => `text-fluux-green`; line 261 `text-red-500 dark:text-red-400` => `text-fluux-error`.
- `RestorePassphraseDialog.tsx`: line 212 `bg-yellow-500/10` LEAVE (alpha); line 213 `text-yellow-600 dark:text-yellow-400` => `text-fluux-yellow`; line 278 `text-red-500 dark:text-red-400` => `text-fluux-error`.
- `VerifyPeerDialog.tsx`: lines 125-126 (`bg-green-500/...`, `text-green-600 dark:text-green-400`) and 173/180 (`border-green-500`, `text-green-600 dark:text-green-400`) are SAS code-match success, LEAVE green per the exception above; line 133 `bg-yellow-500/10` LEAVE (alpha); line 134 `text-yellow-600 dark:text-yellow-400` => `text-fluux-yellow` (the "verify in person" caution text, a real caution, tokenized).
- `UnlockEncryptionDialog.tsx`: line 303 `text-green-600 dark:text-green-400` => `text-fluux-green` (restore-success message); line 325 `text-red-500 dark:text-red-400` => `text-fluux-error`.

Note: line numbers are from the grep at plan time; the implementer should match on the exact class string in each file (open the file, find the listed class, apply the rule), not trust the line number blindly.

- [ ] **Step 1: Apply the rule to all nine files**

Open each file, apply the per-file targets above. Only text colors and standalone solid fills change; alpha tints and hover-pair buttons stay.

- [ ] **Step 2: Verify by grep that only the intended classes remain**

Run from `apps/fluux/src/components`:
```bash
grep -nE "text-(red|yellow|green)-[0-9]{3}" KeyChangeBanner.tsx OwnKeyConflictBanner.tsx TrustStateCompromisedBanner.tsx DeleteOpenpgpKeyDialog.tsx IdentityChoiceDialog.tsx BackupPassphraseDialog.tsx RestorePassphraseDialog.tsx VerifyPeerDialog.tsx UnlockEncryptionDialog.tsx
```
Expected: the ONLY remaining `text-{red,yellow,green}-NNN` matches are the VerifyPeerDialog SAS green (lines ~126, ~180). Every other bare TEXT color is gone. (Bare `bg-`/`border-` with alpha or hover pairs are expected to remain and are correct.)

- [ ] **Step 3: Typecheck + lint + affected tests**

Run from repo root: `npm run typecheck` (clean), `npm run lint` (0 errors). From `apps/fluux`: `npx vitest run src/components/VerifyPeerDialog.test.tsx src/components/IdentityChoiceDialog.test.tsx 2>/dev/null` if those tests exist; keep them green (update any assertion that pinned an old bare class).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/KeyChangeBanner.tsx apps/fluux/src/components/OwnKeyConflictBanner.tsx apps/fluux/src/components/TrustStateCompromisedBanner.tsx apps/fluux/src/components/DeleteOpenpgpKeyDialog.tsx apps/fluux/src/components/IdentityChoiceDialog.tsx apps/fluux/src/components/BackupPassphraseDialog.tsx apps/fluux/src/components/RestorePassphraseDialog.tsx apps/fluux/src/components/VerifyPeerDialog.tsx apps/fluux/src/components/UnlockEncryptionDialog.tsx
git -c commit.gpgsign=false commit -m "refactor(e2ee): tokenize bare trust palette in banners + key dialogs"
```

---

### Task 4: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run from repo root: `npm run typecheck` (clean), `npm run lint` (0 errors), `npm test` (all pass, no new failures). Confirm `trustVisual.test.ts` is green and the lock-surface + dialog tests pass.

- [ ] **Step 2: Static no-bare-palette guard for the lock surfaces**

Confirm the three lock surfaces no longer hardcode bare trust palette classes:
```bash
grep -nE "text-(red|yellow|green)-[0-9]{3}" apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/ChatHeader.tsx apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx
```
Expected: zero matches (all routed through `trustVisual`). If a match remains, route it through the resolver. (Optionally add this as a vitest static assertion in `trustVisual.test.ts` reading the three files via `process.cwd()`, mirroring `motionTokens.test.ts`.)

- [ ] **Step 3: Screenshots (best-effort, likely skip)**

Trust states are hard to drive in the demo harness. Do NOT force them; the `trustVisual` unit guard + the static grep carry the proof. Note in the report whether any trust-state screenshot was reachable.

- [ ] **Step 4: Commit (only if Step 2's optional static guard was added)**

```bash
git add apps/fluux/src/e2ee/trustVisual.test.ts 2>/dev/null
git -c commit.gpgsign=false commit -m "test(e2ee): static guard that lock surfaces use trustVisual tokens" || echo "nothing to commit"
```

---

## Self-Review notes

- **Spec coverage:** trustVisual resolver + guard (Task 1) · the two visible changes verified=teal + keyLocked=gray (Task 2 Steps 4 + 2) · route the 3 lock surfaces through the resolver (Task 2) · tokenize banners + dialogs with the text-vs-fill / alpha / hover rule (Task 3) · preserve per-message untrusted-yellow (unchanged; MessageBubble maps it to `decryptFailed` which is still yellow) · preserve VerifyPeerDialog SAS green (Task 3 exception) · unit-test proof + no-bare-palette guard (Task 4). All spec sections covered.
- **Type consistency:** `trustVisual(state: TrustVisualState): { colorClass, tone }` and the `TrustVisualState` literals (`verified`/`trusted`/`decryptFailed`/`rejected`/`keyChanged`/`keyLocked`/`plaintext`/`checking`) are used identically in Tasks 1 and 2.
- **Token reality:** `text-fluux-encryption`/`-muted`/`-yellow`/`-error`/`-green` and `bg-fluux-red`/`-yellow`/`-green` all exist in `tailwind.config.js` (verified).
- **Tailwind opacity constraint** is encoded as a Global Constraint and applied per-occurrence in Task 3 (alpha tints stay bare).
- **No SDK change** so no `build:sdk` (except the stale-dist workaround note).
