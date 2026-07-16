# OMEMO Per-Device Verification (M2c-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Blind-Trust-Before-Verification (BTBV) per-device verification to OMEMO — verify/revoke a peer's devices, exclude untrusted devices from encryption — and unify all consumer-facing trust onto the shared SDK `TrustState`.

**Architecture:** The crypto core `@fluux/omemo` is untouched. A new plugin-owned "verified" marker store in `@fluux/omemo-plugin` (over `PluginStorage`, fingerprint-bound) adds the `verified` trust level that `@fluux/omemo`'s `TrustRecord` cannot express. Two optional `E2EEPlugin` trait methods (`listPeerIdentities`, `setIdentityTrust`) expose a protocol-agnostic per-identity list. The app migrates its divergent conversation-level trust union onto `TrustState` with one shared `TrustState → visual/label` mapping, then builds the contact-profile per-device UI on that foundation.

**Tech Stack:** TypeScript, Zustand (vanilla stores), React + react-i18next, Vitest, `@fluux/omemo` (@noble/* cleanroom crypto), `@fluux/omemo-plugin`, `@fluux/sdk`.

## Global Constraints

- Single trust vocabulary: the SDK `TrustState = 'verified' | 'introduced' | 'tofu' | 'untrusted' | 'unknown'` (packages/fluux-sdk/src/core/e2ee/types.ts:310, exported from the SDK index) is THE consumer-facing trust vocabulary. No new/parallel trust union.
- The `verified` marker is plugin-owned (in `@fluux/omemo-plugin` over `PluginStorage`), keyed by `(peer, deviceId, fingerprintHex)`. The crypto core `@fluux/omemo` is NOT modified (its `TrustRecord.state` stays `undecided|trusted|untrusted`).
- Fingerprint derivation: `import { fingerprint } from '@fluux/omemo'` — `fingerprint(edPub: Uint8Array): Uint8Array`. Own = `acc.identityFingerprint()` (= `fingerprint(ownEdPub)`); a peer device = `fingerprint(bundle.ik)` (bundle.ik is the remote Ed25519 IK). Format both to hex via the plugin's existing `hex()` helper so they are comparable.
- `deviceId` crosses the SDK trait boundary as a STRING (matching existing `getDeviceTrust(peer, deviceId: string)`); the plugin store keys by `Number(deviceId)`.
- OpenPGP trust rendering MUST remain visually equivalent after the migration — pinned by regression tests written BEFORE the refactor.
- Desktop-first; OMEMO UI branches are unreachable on web (no OMEMO plugin registered there).
- All 33 locales (`apps/fluux/src/i18n/locales/*.json`) updated for any new i18n key; no em-dash connectors; parse→mutate→write JSON with 4-space indent, `ensure_ascii=False`, trailing newline; "OMEMO" stays literal.
- Every commit uses `git commit --no-gpg-sign` (sandbox ssh-agent broken — expected). Never push.
- Test commands: SDK `cd packages/fluux-sdk && npx vitest run <file>`; plugin `cd packages/omemo-plugin && npx vitest run <file>`; app `cd apps/fluux && npx vitest run <file>`; typecheck `npm run typecheck` from root. After any `@fluux/omemo`/`@fluux/omemo-plugin` source change consumed by another package, `npm run build -w @fluux/omemo` / `-w @fluux/omemo-plugin` before dependent typecheck (their dist is what dependents typecheck against — gitignored).

The 33 locale codes (used by every i18n step): `ar be bg ca cs da de el en es et fi fr ga he hr hu is it lt lv mt nb nl pl pt ro ru sk sl sv uk zh-CN`.

---

## File Structure

**Created:**
- `packages/omemo-plugin/src/verifiedDevices.ts` — verified-marker persistence over `PluginStorage` (Task 6).
- `packages/omemo-plugin/src/verifiedDevices.test.ts` — its unit tests (Task 6).
- `apps/fluux/src/e2ee/trustVisual.trustState.test.ts` — unit tests for the shared `TrustState` mapping (Task 2).
- `apps/fluux/src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx` — OMEMO per-identity list tests (Task 12).

**Modified:**
- `packages/fluux-sdk/src/core/e2ee/types.ts` — add `PeerIdentity` + optional trait methods (Task 5).
- `packages/fluux-sdk/src/index.ts` — export `PeerIdentity` (Task 5).
- `packages/omemo-plugin/src/OmemoPlugin.ts` — `getOwnFingerprint`, `listPeerIdentities`, `setIdentityTrust`, wire `peerHasVerifiedDevice`, verified-aware `getDeviceTrust`/`getPeerTrust`, encrypt exclusion (Tasks 7-11).
- `apps/fluux/src/e2ee/trustVisual.ts` — add `trustStateVisual` + `trustLabel` (Task 2).
- `apps/fluux/src/hooks/useConversationEncryptionState.ts` — `encrypted.trust: TrustState` + `firstSeen`, drop `mapOmemoTrust`/`omemoTrust`; add `needsDeviceVerification` (Tasks 3, 15).
- Consumers: `ChatHeader.tsx`, `contact-profile/tabs/SecurityTab.tsx`, `contact-profile/cards/SecurityGlanceCard.tsx`, `MessageComposer.tsx`, `ContactProfileView.tsx`, `contact-profile/ContactProfileGrid.tsx` (via SecurityGlanceCard), `contact-profile/ContactSecurityDetail.tsx`, per-message lock in `conversation/MessageBubble.tsx` (Tasks 4, 12, 13, 14, 15).
- `VerifyPeerDialog.tsx` — device-scoped confirm target (Task 14).
- `apps/fluux/src/i18n/locales/*.json` — new keys (Tasks 2, 12, 15).
- Test files updated in place where their assertions change (Tasks 1, 3, 4).

---

## Phase A — Unified trust vocabulary (regression-first)

### Task 1: OpenPGP trust-rendering regression tests (characterization)

Pin TODAY's OpenPGP rendering across the three trust surfaces so the Component-0 refactor (Tasks 2-4) can't silently change it. These tests must PASS against the current, unmodified code. They assert on stable Lucide icon classes (`.lucide-shield-check`, `.lucide-shield`, `.lucide-lock`) and `trustVisual` color tokens, NOT translated text (the app test i18n returns keys for un-subset strings; see `apps/fluux/src/test-setup.ts`).

**Files:**
- Create: `apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx`

**Interfaces:**
- Consumes: `SecurityTab` (`apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`), `getGlance` (`apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.tsx`), and the current `ConversationEncryptionState.encrypted` shape `{ kind:'encrypted'; fingerprint:string; trust:'verified'|'unverified'|'tofu-new' }`.
- Produces: nothing importable; a guard suite.

- [ ] **Step 1: Write the characterization test**

```tsx
// apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ShieldCheck, Lock } from 'lucide-react'
import { SecurityTab } from '@/components/contact-profile/tabs/SecurityTab'
import { getGlance } from '@/components/contact-profile/cards/SecurityGlanceCard'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

const noop = () => {}
const identity = (k: string) => k

function renderTab(state: ConversationEncryptionState) {
  return render(
    <SecurityTab
      state={state}
      onVerify={noop}
      onRequestRevoke={noop}
      onDisableEncryption={noop}
      onEnableEncryption={noop}
    />,
  )
}

describe('OpenPGP trust rendering (characterization — must not change under Component-0)', () => {
  it('SecurityTab: verified → ShieldCheck teal + Remove-verification button, no Verify button', () => {
    const { container } = renderTab({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'verified' })
    const shieldCheck = container.querySelector('.lucide-shield-check')
    expect(shieldCheck).not.toBeNull()
    expect(shieldCheck!.getAttribute('class')).toContain('text-fluux-encryption')
    // verified shows Remove-verification (onRequestRevoke) but NOT Verify (onVerify)
    expect(container.textContent).toContain('contacts.encryption.removeVerification')
    expect(container.textContent).not.toContain('contacts.encryption.verifyButton')
  })

  it('SecurityTab: unverified → gray Shield + Verify button', () => {
    const { container } = renderTab({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'unverified' })
    // The heading icon is a plain Shield (not ShieldCheck), gray.
    const plainShield = container.querySelector('.lucide-shield')
    expect(plainShield).not.toBeNull()
    expect(plainShield!.getAttribute('class')).toContain('text-fluux-muted')
    expect(container.textContent).toContain('contacts.encryption.verifyButton')
    expect(container.textContent).not.toContain('contacts.encryption.removeVerification')
  })

  it('SecurityTab: tofu-new → gray Shield, neither Verify nor Remove button (current quirk)', () => {
    const { container } = renderTab({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'tofu-new' })
    expect(container.querySelector('.lucide-shield')).not.toBeNull()
    expect(container.textContent).not.toContain('contacts.encryption.verifyButton')
    expect(container.textContent).not.toContain('contacts.encryption.removeVerification')
  })

  it('getGlance: verified → ShieldCheck/glanceVerified/success', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'verified' }, identity)
    expect(g).toEqual({ icon: ShieldCheck, label: 'contacts.encryption.glanceVerified', tone: 'success' })
  })

  it('getGlance: unverified → Lock/glanceEncrypted/neutral', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'unverified' }, identity)
    expect(g).toEqual({ icon: Lock, label: 'contacts.encryption.glanceEncrypted', tone: 'neutral' })
  })

  it('getGlance: tofu-new → Lock/glanceEncrypted/neutral (not verified)', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'tofu-new' }, identity)
    expect(g).toEqual({ icon: Lock, label: 'contacts.encryption.glanceEncrypted', tone: 'neutral' })
  })
})
```

- [ ] **Step 2: Run the test — it must PASS against current code**

Run: `cd apps/fluux && npx vitest run src/e2ee/openpgpTrustRendering.regression.test.tsx`
Expected: PASS (6 passing). If any FAIL, the characterization is wrong — fix the assertion to match current behavior, do NOT change product code.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx
git commit --no-gpg-sign -m "test(e2ee): pin OpenPGP trust rendering before TrustState migration"
```

---

### Task 2: Shared `TrustState` → visual + label mapping

Add `trustStateVisual(t: TrustState)` and `trustLabel(t: TrustState)` to `trustVisual.ts` (the existing `trustVisual(TrustVisualState)` for message-lock/cert presentation states stays untouched — they are NOT trust levels). Add `contacts.encryption.trust.*` i18n keys across 33 locales.

**Files:**
- Modify: `apps/fluux/src/e2ee/trustVisual.ts`
- Create: `apps/fluux/src/e2ee/trustVisual.trustState.test.ts`
- Modify: all 33 `apps/fluux/src/i18n/locales/*.json`

**Interfaces:**
- Consumes: `TrustState` from `@fluux/sdk`; `TrustVisual`/`TrustTone` from this file.
- Produces:
  - `export function trustStateVisual(t: TrustState): TrustVisual` — `{ colorClass: string; tone: TrustTone }`.
  - `export function trustLabel(t: TrustState): string` — returns i18n key `contacts.encryption.trust.<t>`.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/fluux/src/e2ee/trustVisual.trustState.test.ts
import { describe, it, expect } from 'vitest'
import { trustStateVisual, trustLabel } from './trustVisual'
import type { TrustState } from '@fluux/sdk'

describe('trustStateVisual', () => {
  it('verified → teal encryption brand', () => {
    expect(trustStateVisual('verified')).toEqual({ colorClass: 'text-fluux-encryption', tone: 'verified' })
  })
  it('tofu → calm gray', () => {
    expect(trustStateVisual('tofu')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('introduced → calm gray', () => {
    expect(trustStateVisual('introduced')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('unknown → calm gray', () => {
    expect(trustStateVisual('unknown')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('untrusted → danger error token', () => {
    expect(trustStateVisual('untrusted')).toEqual({ colorClass: 'text-fluux-error', tone: 'danger' })
  })
})

describe('trustLabel', () => {
  it('returns the namespaced i18n key for each TrustState', () => {
    const states: TrustState[] = ['verified', 'introduced', 'tofu', 'untrusted', 'unknown']
    for (const s of states) {
      expect(trustLabel(s)).toBe(`contacts.encryption.trust.${s}`)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/trustVisual.trustState.test.ts`
Expected: FAIL with "trustStateVisual is not a function" / "trustLabel is not a function".

- [ ] **Step 3: Implement the shared mapping**

Append to `apps/fluux/src/e2ee/trustVisual.ts` (after the existing `trustVisual` function, at end of file, before nothing — it is the last export):

```ts
import type { TrustState } from '@fluux/sdk'

/**
 * The single source of truth for the COLOR + TONE of a consumer-facing
 * {@link TrustState} (peer/device/aggregate trust). Distinct from
 * {@link trustVisual}, which keys on the message-lock / cert PRESENTATION
 * states (`decryptFailed`, `keyChanged`, `rejected`, …) — those are not trust
 * levels. "Calm by default": only `untrusted` (a new/changed/failed key) is a
 * danger signal; `verified` is the teal brand; everything else is neutral.
 */
export function trustStateVisual(t: TrustState): TrustVisual {
  switch (t) {
    case 'verified':
      return { colorClass: 'text-fluux-encryption', tone: 'verified' }
    case 'untrusted':
      return { colorClass: 'text-fluux-error', tone: 'danger' }
    case 'tofu':
    case 'introduced':
    case 'unknown':
      return { colorClass: 'text-fluux-muted', tone: 'calm' }
  }
}

/** i18n key for a {@link TrustState}'s human label. Caller wraps in `t(...)`. */
export function trustLabel(t: TrustState): string {
  return `contacts.encryption.trust.${t}`
}
```

Note: `import type { TrustState } from '@fluux/sdk'` goes at the TOP of the file with the other imports if the file grows one; since the current file has no imports, add the import line as the first line of the file.

- [ ] **Step 4: Run the test — it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/trustVisual.trustState.test.ts`
Expected: PASS (2 describes, 7 assertions).

- [ ] **Step 5: Verify the pre-existing trustVisual test still passes (no regression)**

Run: `cd apps/fluux && npx vitest run src/e2ee/trustVisual.test.ts`
Expected: PASS.

- [ ] **Step 6: Add `contacts.encryption.trust.*` keys to all 33 locales**

English source strings (translate the VALUE into each locale's language; "OMEMO" and technical terms stay as appropriate; no em-dash connectors):

| key | en value |
|---|---|
| `contacts.encryption.trust.verified` | `Verified` |
| `contacts.encryption.trust.introduced` | `Introduced` |
| `contacts.encryption.trust.tofu` | `Not verified` |
| `contacts.encryption.trust.untrusted` | `Untrusted` |
| `contacts.encryption.trust.unknown` | `Unknown` |

Apply with this script (run once, then translate non-en values in-place per the i18n workflow). It preserves 4-space indent, `ensure_ascii=False`, trailing newline:

```bash
cd apps/fluux/src/i18n/locales
python3 - <<'PY'
import json, glob, os
# English baseline; translate the non-en files afterwards.
EN = {
    "verified": "Verified",
    "introduced": "Introduced",
    "tofu": "Not verified",
    "untrusted": "Untrusted",
    "unknown": "Unknown",
}
for path in sorted(glob.glob("*.json")):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    enc = d.setdefault("contacts", {}).setdefault("encryption", {})
    enc["trust"] = dict(EN)  # en baseline; translate below
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=4)
        f.write("\n")
print("seeded contacts.encryption.trust into", len(glob.glob('*.json')), "locales")
PY
```

Then translate the five values in each non-`en.json` locale to that locale's language (e.g. `fr.json` → `Vérifié`, `Présenté`, `Non vérifié`, `Non fiable`, `Inconnu`). Edit each file surgically (parse→mutate→`json.dump(..., ensure_ascii=False, indent=4)` + trailing `\n`). This is a required per-locale translation, not a placeholder.

- [ ] **Step 7: 33-locale parity check**

Run:
```bash
cd apps/fluux/src/i18n/locales
python3 - <<'PY'
import json, glob
keys = ["verified","introduced","tofu","untrusted","unknown"]
bad = []
for p in sorted(glob.glob("*.json")):
    d = json.load(open(p, encoding="utf-8"))
    t = d.get("contacts",{}).get("encryption",{}).get("trust",{})
    missing = [k for k in keys if k not in t]
    if missing: bad.append((p, missing))
print("OK" if not bad else bad)
PY
```
Expected: `OK`.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/e2ee/trustVisual.ts apps/fluux/src/e2ee/trustVisual.trustState.test.ts apps/fluux/src/i18n/locales
git commit --no-gpg-sign -m "feat(e2ee): shared TrustState visual + label mapping (+ trust i18n)"
```

---

### Task 3: Migrate the hook's `encrypted.trust` to `TrustState`

Change `ConversationEncryptionState.encrypted` to `{ kind:'encrypted'; protocolId?; fingerprint; trust: TrustState; firstSeen?: boolean }`. Drop `omemoTrust` and `mapOmemoTrust`. OpenPGP maps verified→`verified`, previously-`tofu-new`→`tofu` with `firstSeen:true`, previously-`unverified`→`tofu`. OMEMO passes the plugin `TrustState` through unchanged. Update both hook test files.

**Files:**
- Modify: `apps/fluux/src/hooks/useConversationEncryptionState.ts`
- Modify: `apps/fluux/src/hooks/useConversationEncryptionState.test.tsx`
- Modify: `apps/fluux/src/hooks/useConversationEncryptionState.omemo.test.tsx`

**Interfaces:**
- Consumes: `TrustState` from `@fluux/sdk`.
- Produces: `ConversationEncryptionState` `encrypted` variant = `{ kind:'encrypted'; protocolId?: 'openpgp'|'omemo:2'; fingerprint: string; trust: TrustState; firstSeen?: boolean }`. (`needsDeviceVerification` is added later in Task 15.)

- [ ] **Step 1: Update the OMEMO hook tests to the new shape (write failing tests first)**

In `apps/fluux/src/hooks/useConversationEncryptionState.omemo.test.tsx`, replace the two positive assertions and the peer-switch/negative assertions that reference `trust: 'tofu-new'` / `omemoTrust`.

Replace the first test body (currently lines ~92-105) so the expectation becomes:
```tsx
  it("reports 'encrypted' with TrustState passed through when OMEMO is selected (tofu)", async () => {
    wireMocks({ omemoPlugin: makeOmemoPlugin('tofu') })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    expect(result.current).toEqual({
      kind: 'encrypted',
      protocolId: 'omemo:2',
      fingerprint: '',
      trust: 'tofu',
    })
  })
```

Replace the second test body (currently lines ~107-120) so the expectation becomes:
```tsx
  it("passes OMEMO 'verified' trust through unchanged", async () => {
    wireMocks({ omemoPlugin: makeOmemoPlugin('verified') })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    expect(result.current).toEqual({
      kind: 'encrypted',
      protocolId: 'omemo:2',
      fingerprint: '',
      trust: 'verified',
    })
  })
```

In the peer-switch test (currently ~122-172): change the first `expect(result.current).toEqual({...})` block (the alice assertion, ~148-154) to:
```tsx
    expect(result.current).toEqual({
      kind: 'encrypted',
      protocolId: 'omemo:2',
      fingerprint: '',
      trust: 'verified',
    })
```
and change the stale-flash negative assertion (~164-166) to:
```tsx
    expect(result.current).not.toEqual(
      expect.objectContaining({ protocolId: 'omemo:2', trust: 'verified' }),
    )
```

- [ ] **Step 2: Update the OpenPGP hook tests to the new shape**

In `apps/fluux/src/hooks/useConversationEncryptionState.test.tsx`, every assertion that currently reads `trust: 'unverified'` on an `encrypted` result must become `trust: 'tofu'` (OpenPGP cached-but-not-verified now maps to `tofu`). The `trust: 'verified'` assertions stay `trust: 'verified'`. Apply globally:

```bash
cd apps/fluux
# Only the encrypted-state 'unverified' literals appear in this file; replace them.
python3 - <<'PY'
import re
p = "src/hooks/useConversationEncryptionState.test.tsx"
s = open(p, encoding="utf-8").read()
s = s.replace("trust: 'unverified'", "trust: 'tofu'")
open(p, "w", encoding="utf-8").write(s)
print("replaced", s.count("trust: 'tofu'"), "tofu occurrences")
PY
```

Then, for any test that asserted the OpenPGP `tofu-new` path (search for `tofu-new` in this file and in setup that pins `isTofuNew`), update its expectation to `{ ..., trust: 'tofu', firstSeen: true }`. Search:
```bash
cd apps/fluux && grep -n "tofu-new\|isTofuNew\|firstSeen" src/hooks/useConversationEncryptionState.test.tsx
```
For each `tofu-new` assertion found, change `trust: 'tofu-new'` to `trust: 'tofu', firstSeen: true` (add `firstSeen: true` as a sibling key). If none are found, no change needed here.

- [ ] **Step 3: Run both test files — they must FAIL (implementation not yet changed)**

Run:
```bash
cd apps/fluux && npx vitest run src/hooks/useConversationEncryptionState.omemo.test.tsx src/hooks/useConversationEncryptionState.test.tsx
```
Expected: FAIL — current impl still returns `'tofu-new'`/`'unverified'`/`omemoTrust`.

- [ ] **Step 4: Migrate the hook type + logic**

In `apps/fluux/src/hooks/useConversationEncryptionState.ts`:

(a) The `encrypted` variant in the `ConversationEncryptionState` union (currently lines ~57-87) becomes:
```ts
  | {
      kind: 'encrypted'
      fingerprint: string
      /**
       * Consumer-facing trust for the conversation, on the shared SDK
       * `TrustState`. OMEMO passes its per-peer aggregate through unchanged
       * (so `untrusted` stays `untrusted`); OpenPGP maps an explicitly
       * verified key to `verified` and everything else to `tofu`.
       */
      trust: TrustState
      /**
       * Which E2EE protocol drives this conversation. Absent means OpenPGP
       * (the historical default) so existing consumers keep working; only the
       * OMEMO branch sets `'omemo:2'`.
       */
      protocolId?: 'openpgp' | 'omemo:2'
      /**
       * First-contact nudge for OpenPGP ("new contact — verify fingerprint").
       * "New" is not a trust LEVEL, so it is a separate flag rather than a
       * `trust` value. OMEMO leaves it unset.
       */
      firstSeen?: boolean
    }
```

(b) Delete the `mapOmemoTrust` function entirely (currently lines ~115-127).

(c) In the OMEMO effect, replace the `setOmemoResult({...})` call (currently ~353-359) with:
```ts
          setOmemoResult({
            kind: 'encrypted',
            protocolId: 'omemo:2',
            fingerprint: '',
            trust: t,
          })
```
(`t` is the plugin `TrustState` from `selected.getPeerTrust(peerJid)`; passed through unchanged.)

(d) In the OpenPGP `memoResult` (currently ~416-419), replace the trust derivation + return with:
```ts
    // OpenPGP → TrustState: an explicitly-verified key is `verified`; anything
    // else (cached-but-unverified, or a first-contact TOFU pin) is `tofu`. The
    // "new contact" nudge is a separate `firstSeen` flag, not a trust level.
    const isVerified =
      !!verifiedFingerprint && fingerprintsEqual(verifiedFingerprint, base.fingerprint)
    const firstSeen = !isVerified && !!peerJid && isTofuNew(peerJid)
    return {
      kind: 'encrypted',
      fingerprint: base.fingerprint,
      trust: isVerified ? 'verified' : 'tofu',
      ...(firstSeen ? { firstSeen: true } : {}),
    }
```

- [ ] **Step 5: Run both hook test files — they pass**

Run:
```bash
cd apps/fluux && npx vitest run src/hooks/useConversationEncryptionState.omemo.test.tsx src/hooks/useConversationEncryptionState.test.tsx
```
Expected: PASS. (Consumers still referencing `'tofu-new'`/`'unverified'`/`omemoTrust` will now fail typecheck — fixed in Task 4. Do NOT typecheck yet.)

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useConversationEncryptionState.ts apps/fluux/src/hooks/useConversationEncryptionState.test.tsx apps/fluux/src/hooks/useConversationEncryptionState.omemo.test.tsx
git commit --no-gpg-sign -m "refactor(e2ee): hook encrypted.trust is TrustState + firstSeen (drop mapOmemoTrust)"
```

---

### Task 4a: Migrate SecurityTab + SecurityGlanceCard + ChatHeader to `TrustState`

Update the three OpenPGP trust surfaces to read `encrypted.trust: TrustState` (`verified`/`tofu`/…) instead of the old 3-value union. Render must stay equivalent (Task 1 regression tests are the gate).

**Files:**
- Modify: `apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`
- Modify: `apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.tsx`
- Modify: `apps/fluux/src/components/ChatHeader.tsx`

**Interfaces:**
- Consumes: `encrypted.trust: TrustState` (Task 3); `trustStateVisual`/`trustLabel` (Task 2) available but the OpenPGP branches only need the `verified` vs not distinction here.
- Produces: no new exports; `getGlance` signature unchanged.

- [ ] **Step 1: SecurityTab — replace `trust` comparisons**

In `SecurityTab.tsx`, the `encrypted` branch currently keys on `'verified'`/`'unverified'`. With `TrustState`, "not verified" is now `'tofu'` (and the Verify button previously shown only for `'unverified'` must now show for the non-verified case). Apply:

- Line ~106: `state.trust === 'verified' ? (` — unchanged (still `'verified'`).
- Line ~113-117: unchanged (`state.trust === 'verified'`).
- Line ~131 `{state.trust === 'unverified' && (` → change to `{state.trust !== 'verified' && (`.
- Line ~142 `{state.trust === 'verified' && (` — unchanged.

Concretely, edit the Verify-button guard:
```tsx
            {state.trust !== 'verified' && (
              <button
                type="button"
                onClick={onVerify}
```

Note: this deliberately now shows the Verify button for the old `tofu-new` case too (previously it did not). That is an intended improvement — a first-contact OpenPGP peer should be verifiable from the tab. The Task-1 regression test for `tofu-new` asserted the OLD quirk; update that ONE assertion in Step 4 below.

- [ ] **Step 2: SecurityGlanceCard — replace `trust` comparison**

In `getGlance` (SecurityGlanceCard.tsx line ~24), `state.trust === 'verified'` is already correct for `TrustState`. No change needed — verify by reading: the ternary `state.trust === 'verified' ? {glanceVerified} : {glanceEncrypted}` works unchanged because `verified` is a valid `TrustState`. Leave this file unmodified (documented no-op).

- [ ] **Step 3: ChatHeader — replace `verified`/`tofuNew` derivation**

In `ChatHeader.tsx` (lines ~366-367):
```tsx
  const verified = state.kind === 'encrypted' && state.trust === 'verified'
  const tofuNew = state.kind === 'encrypted' && state.firstSeen === true
```
(`verified` unchanged; `tofuNew` now reads the new `firstSeen` flag instead of the retired `'tofu-new'` trust value.) The two tooltip blocks (~383-388 and ~412-417) already branch on `verified`/`tofuNew` and need no further change in this task; G-1 (protocolId-aware OMEMO tooltip) is Task 13.

- [ ] **Step 4: Update the Task-1 regression assertion for the SecurityTab tofu-new quirk**

In `apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx`, the `'tofu-new → …neither Verify nor Remove button'` test asserted the OLD quirk. Since `tofu-new` no longer exists as a trust value, replace that test with the `firstSeen` equivalent:
```tsx
  it('SecurityTab: tofu (firstSeen) → gray Shield + Verify button, no Remove button', () => {
    const { container } = renderTab({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'tofu', firstSeen: true })
    expect(container.querySelector('.lucide-shield')).not.toBeNull()
    expect(container.textContent).toContain('contacts.encryption.verifyButton')
    expect(container.textContent).not.toContain('contacts.encryption.removeVerification')
  })
```
Also update the `'unverified'` test (which used the now-removed value) to use `trust: 'tofu'`:
```tsx
  it('SecurityTab: tofu (not verified) → gray Shield + Verify button', () => {
    const { container } = renderTab({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'tofu' })
    const plainShield = container.querySelector('.lucide-shield')
    expect(plainShield).not.toBeNull()
    expect(plainShield!.getAttribute('class')).toContain('text-fluux-muted')
    expect(container.textContent).toContain('contacts.encryption.verifyButton')
    expect(container.textContent).not.toContain('contacts.encryption.removeVerification')
  })
```
And update the two `getGlance` tests that used `trust: 'unverified'`/`'tofu-new'` to `trust: 'tofu'` (both still expect `Lock/glanceEncrypted/neutral`).

- [ ] **Step 5: Run the affected suites**

Run:
```bash
cd apps/fluux && npx vitest run src/e2ee/openpgpTrustRendering.regression.test.tsx src/components/ChatHeader.test.tsx src/components/contact-profile/cards/SecurityGlanceCard.test.tsx
```
Expected: PASS. If `ChatHeader.test.tsx` or `SecurityGlanceCard.test.tsx` assert old trust literals, update those literals (`'unverified'`→`'tofu'`, `'tofu-new'`→`'tofu'` + `firstSeen:true`) to match Task 3's shape, then re-run.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx apps/fluux/src/components/ChatHeader.tsx apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx apps/fluux/src/components/ChatHeader.test.tsx apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.test.tsx
git commit --no-gpg-sign -m "refactor(e2ee): SecurityTab/ChatHeader read TrustState-based trust"
```

---

### Task 4b: Migrate MessageComposer + ContactProfileView + per-message lock; full typecheck

Finish the consumer migration (`MessageComposer` lock, `ContactProfileView`/`ContactProfileGrid` pass-through, `ContactSecurityDetail` pass-through, per-message lock in `MessageBubble`), then land a clean root typecheck.

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx`
- Modify: `apps/fluux/src/components/ContactProfileView.tsx`
- Read/verify: `apps/fluux/src/components/conversation/MessageBubble.tsx`, `apps/fluux/src/components/contact-profile/ContactProfileGrid.tsx`, `apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx`

**Interfaces:**
- Consumes: `encrypted.trust: TrustState`, `firstSeen` (Task 3); `trustVisual` (unchanged presentation states).
- Produces: no new exports.

- [ ] **Step 1: MessageComposer — the lock derivation**

In `MessageComposer.tsx` (lines ~721-730) the `lockInfo` derivation reads `enc.trust === 'verified'`. `verified` is a valid `TrustState`, so the existing ternary is correct as-is:
```tsx
  const enc = encryptionState
  const lockInfo: { Icon: typeof Shield; colorClass: string; label: string } | null =
    enc?.kind === 'encrypted'
      ? enc.trust === 'verified'
        ? { Icon: ShieldCheck, colorClass: trustVisual('verified').colorClass, label: t('chat.encryption.verifiedTooltip') }
        : { Icon: Shield, colorClass: trustVisual('trusted').colorClass, label: t('chat.encryption.openpgpTooltip') }
      : enc?.kind === 'blocked'
        ? { Icon: ShieldAlert, colorClass: trustVisual('keyChanged').colorClass, label: t('chat.encryption.blockedTooltip') }
        : null
```
This is a documented no-op for Task 4b (it already only distinguishes `verified` vs not). Leave unmodified. (Task 15 adds the `needsDeviceVerification` branch here.)

- [ ] **Step 2: ContactProfileView / ChatView — the `alreadyVerified` derivation**

`ChatView.tsx:460` reads `encryptionState.trust === 'verified'` — `verified` is valid `TrustState`; no change. Confirm with:
```bash
cd apps/fluux && grep -n "trust === 'verified'\|trust === 'unverified'\|trust === 'tofu-new'" src/components/ChatView.tsx src/components/ContactProfileView.tsx
```
Expected: only `=== 'verified'` matches remain (no `unverified`/`tofu-new`). If any `unverified`/`tofu-new` remain, replace `=== 'unverified'` with `!== 'verified'` and remove `tofu-new` branches.

- [ ] **Step 3: Per-message lock (MessageBubble) — confirm unchanged**

The per-message lock (`MessageBubble.tsx` ~651-674) reads `message.securityContext.trust` (SDK `MessageSecurityContext['trust']` = `verified|introduced|tofu|untrusted|rejected`) and routes through `trustVisual(...)` presentation states. This is the message-lock presentation concern, NOT the conversation-level `TrustState` migration, and stays as-is (guarded by the static `trustVisual.test.ts` "no bare palette" suite). No edit. Confirm it does not reference the hook's `ConversationEncryptionState`:
```bash
cd apps/fluux && grep -n "ConversationEncryptionState\|tofu-new\|omemoTrust" src/components/conversation/MessageBubble.tsx
```
Expected: no matches.

- [ ] **Step 4: Grep for any remaining stale references app-wide**

Run:
```bash
cd apps/fluux && grep -rn "tofu-new\|omemoTrust\|trust === 'unverified'\|trust: 'unverified'\|mapOmemoTrust" src/ | grep -v node_modules
```
Expected: no matches (all migrated). Fix any stragglers by the same rules (`'unverified'`→`'tofu'`, `'tofu-new'`→`firstSeen`).

- [ ] **Step 5: Full root typecheck**

Run: `npm run typecheck`
Expected: PASS (0 errors). Fix any type error surfaced by the union change.

- [ ] **Step 6: Run the full app encryption-surface test set**

Run:
```bash
cd apps/fluux && npx vitest run src/hooks/useConversationEncryptionState.test.tsx src/hooks/useConversationEncryptionState.omemo.test.tsx src/e2ee/ src/components/ChatHeader.test.tsx src/components/MessageComposer.test.tsx src/components/contact-profile/
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src
git commit --no-gpg-sign -m "refactor(e2ee): finish TrustState consumer migration + clean typecheck"
```

---

## Phase B — Plugin trust API + BTBV

### Task 5: SDK — `PeerIdentity` + optional trait methods

Add `PeerIdentity` and the two optional `E2EEPlugin` methods to the SDK; export `PeerIdentity`.

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/types.ts`
- Modify: `packages/fluux-sdk/src/index.ts`

**Interfaces:**
- Produces:
  - `export interface PeerIdentity { id: string; fingerprint: string; trust: TrustState }`
  - `E2EEPlugin.listPeerIdentities?(peer: BareJID): Promise<PeerIdentity[]>`
  - `E2EEPlugin.setIdentityTrust?(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void>`

- [ ] **Step 1: Add `PeerIdentity` next to `TrustState`**

In `packages/fluux-sdk/src/core/e2ee/types.ts`, immediately AFTER the `TrustState` type (line 310) insert:
```ts

/**
 * One trustable identity of a peer, protocol-agnostic. OMEMO maps each of a
 * peer's DEVICES to a `PeerIdentity` (`id` = device id string); a future
 * OpenPGP plugin maps its single key to a length-1 list. The host renders a
 * uniform per-identity list from `listPeerIdentities`, feature-detecting the
 * optional trait methods below.
 */
export interface PeerIdentity {
  /** Stable identity id within the protocol (OMEMO: the device id, as a string). */
  id: string
  /** Hex fingerprint/safety-number for out-of-band comparison; `''` if no key is known yet. */
  fingerprint: string
  /** Resolved trust for this identity. */
  trust: TrustState
}
```

- [ ] **Step 2: Add the two optional methods to `E2EEPlugin`**

In the `E2EEPlugin` interface, after `getDeviceTrust(peer: BareJID, deviceId: string): Promise<TrustState>` (line 582) insert:
```ts

  /**
   * Optional: enumerate a peer's trustable identities (OMEMO: one per device)
   * for the per-identity verification UI. Returns `[]` if the peer has none.
   * The host feature-detects (`if (plugin.listPeerIdentities) …`); a plugin
   * that omits it keeps the aggregate-only trust surface.
   */
  listPeerIdentities?(peer: BareJID): Promise<PeerIdentity[]>

  /**
   * Optional: record an explicit trust decision for one identity. `id` is the
   * `PeerIdentity.id` (OMEMO: the device id string). `'verified'` pins the
   * current fingerprint out-of-band; `'untrusted'` revokes/marks it. Both
   * operations are idempotent.
   */
  setIdentityTrust?(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void>
```

- [ ] **Step 3: Export `PeerIdentity` from the SDK index**

In `packages/fluux-sdk/src/index.ts`, add `PeerIdentity,` to the `export type { … } from './core/e2ee'` block (alphabetically, after `PeerSupport` at line 405 — insert `PeerIdentity,` before `PeerSupport,`). Verify `./core/e2ee/index.ts` re-exports `PeerIdentity` from `types.ts`; if it uses an explicit re-export list, add `PeerIdentity` there too:
```bash
cd packages/fluux-sdk && grep -n "PeerSupport\|TrustState\|export \*" src/core/e2ee/index.ts
```
If `index.ts` uses `export type { … } from './types'`, add `PeerIdentity` to that list next to `TrustState`. If it uses `export * from './types'`, no change needed.

- [ ] **Step 4: Build the SDK and typecheck**

Run:
```bash
npm run build -w @fluux/sdk
npm run typecheck
```
Expected: PASS. (Optional methods are additive; no existing plugin breaks.)

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/types.ts packages/fluux-sdk/src/index.ts packages/fluux-sdk/src/core/e2ee/index.ts
git commit --no-gpg-sign -m "feat(sdk): PeerIdentity + optional listPeerIdentities/setIdentityTrust trait methods"
```

---

### Task 6: Plugin `verifiedDevices.ts` — verified-marker persistence

New module over `PluginStorage`, key `verified/<peer>` → JSON `{ [deviceId:string]: fingerprintHex }`. Fingerprint-bound `isVerified`.

**Files:**
- Create: `packages/omemo-plugin/src/verifiedDevices.ts`
- Create: `packages/omemo-plugin/src/verifiedDevices.test.ts`

**Interfaces:**
- Consumes: `PluginStorage` from `@fluux/sdk` (`get/put/delete/list`).
- Produces:
  - `loadVerified(storage: PluginStorage, peer: string): Promise<Record<string, string>>`
  - `isVerified(storage: PluginStorage, peer: string, deviceId: number, fpHex: string): Promise<boolean>`
  - `setVerified(storage: PluginStorage, peer: string, deviceId: number, fpHex: string): Promise<void>`
  - `clearVerified(storage: PluginStorage, peer: string, deviceId: number): Promise<void>`
  - `hasAnyVerified(storage: PluginStorage, peer: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/omemo-plugin/src/verifiedDevices.test.ts
import { describe, it, expect } from 'vitest'
import type { PluginStorage } from '@fluux/sdk'
import { loadVerified, isVerified, setVerified, clearVerified, hasAnyVerified } from './verifiedDevices'

function memStorage(): PluginStorage {
  const m = new Map<string, Uint8Array>()
  return {
    async get(k) { return m.get(k) ?? null },
    async put(k, v) { m.set(k, v) },
    async delete(k) { m.delete(k) },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)) },
  }
}

describe('verifiedDevices', () => {
  it('loadVerified returns {} when nothing stored', async () => {
    const s = memStorage()
    expect(await loadVerified(s, 'bob@x')).toEqual({})
  })

  it('setVerified round-trips through loadVerified', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    expect(await loadVerified(s, 'bob@x')).toEqual({ '5': 'aabb' })
  })

  it('isVerified is fingerprint-bound: matches only the exact stored fp', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    expect(await isVerified(s, 'bob@x', 5, 'aabb')).toBe(true)
    // Same device, DIFFERENT fingerprint (key changed) → not verified.
    expect(await isVerified(s, 'bob@x', 5, 'ccdd')).toBe(false)
    // Different device → not verified.
    expect(await isVerified(s, 'bob@x', 6, 'aabb')).toBe(false)
  })

  it('setVerified for a second device keeps the first', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    await setVerified(s, 'bob@x', 6, ' eeff'.trim())
    expect(await loadVerified(s, 'bob@x')).toEqual({ '5': 'aabb', '6': 'eeff' })
  })

  it('clearVerified removes only that device', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    await setVerified(s, 'bob@x', 6, 'eeff')
    await clearVerified(s, 'bob@x', 5)
    expect(await loadVerified(s, 'bob@x')).toEqual({ '6': 'eeff' })
  })

  it('clearVerified on an absent device is a no-op', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 6, 'eeff')
    await clearVerified(s, 'bob@x', 99)
    expect(await loadVerified(s, 'bob@x')).toEqual({ '6': 'eeff' })
  })

  it('hasAnyVerified reflects presence of ≥1 marker', async () => {
    const s = memStorage()
    expect(await hasAnyVerified(s, 'bob@x')).toBe(false)
    await setVerified(s, 'bob@x', 5, 'aabb')
    expect(await hasAnyVerified(s, 'bob@x')).toBe(true)
    await clearVerified(s, 'bob@x', 5)
    expect(await hasAnyVerified(s, 'bob@x')).toBe(false)
  })

  it('peers are isolated by key', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    expect(await loadVerified(s, 'alice@x')).toEqual({})
    expect(await hasAnyVerified(s, 'alice@x')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — fails (module missing)**

Run: `cd packages/omemo-plugin && npx vitest run src/verifiedDevices.test.ts`
Expected: FAIL — cannot resolve `./verifiedDevices`.

- [ ] **Step 3: Implement the module**

```ts
// packages/omemo-plugin/src/verifiedDevices.ts
import type { PluginStorage } from '@fluux/sdk'

// Plugin-owned "verified" marker store. `@fluux/omemo`'s TrustRecord.state is
// only undecided|trusted|untrusted, so the out-of-band-VERIFIED decision lives
// here, in the adapter layer, keyed by (peer, deviceId, fingerprintHex). A
// verified marker is bound to the exact fingerprint: when a device's identity
// key (hence fingerprint) changes, the stored hex no longer matches and the
// device reverts to unverified — the same key-binding property OpenPGP's
// verifiedPeerKeysStore provides.

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Storage key holding the whole per-peer verified map. */
const verifiedKey = (peer: string) => `verified/${peer}`

/** The persisted shape: deviceId (string) → fingerprint hex. */
type VerifiedMap = Record<string, string>

export async function loadVerified(storage: PluginStorage, peer: string): Promise<VerifiedMap> {
  const bytes = await storage.get(verifiedKey(peer))
  if (!bytes) return {}
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as unknown
    // Defensive: tolerate a corrupt/legacy blob rather than throwing on read.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: VerifiedMap = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    }
  } catch {
    /* corrupt blob — treat as no verified markers */
  }
  return {}
}

async function saveVerified(storage: PluginStorage, peer: string, map: VerifiedMap): Promise<void> {
  await storage.put(verifiedKey(peer), enc.encode(JSON.stringify(map)))
}

/**
 * A device counts as verified only when a marker exists AND its stored
 * fingerprint hex equals `fpHex` (fingerprint-bound). An empty `fpHex`
 * (no key known) can never be verified.
 */
export async function isVerified(
  storage: PluginStorage,
  peer: string,
  deviceId: number,
  fpHex: string,
): Promise<boolean> {
  if (!fpHex) return false
  const map = await loadVerified(storage, peer)
  return map[String(deviceId)] === fpHex
}

export async function setVerified(
  storage: PluginStorage,
  peer: string,
  deviceId: number,
  fpHex: string,
): Promise<void> {
  const map = await loadVerified(storage, peer)
  map[String(deviceId)] = fpHex
  await saveVerified(storage, peer, map)
}

export async function clearVerified(storage: PluginStorage, peer: string, deviceId: number): Promise<void> {
  const map = await loadVerified(storage, peer)
  if (!(String(deviceId) in map)) return
  delete map[String(deviceId)]
  await saveVerified(storage, peer, map)
}

export async function hasAnyVerified(storage: PluginStorage, peer: string): Promise<boolean> {
  const map = await loadVerified(storage, peer)
  return Object.keys(map).length > 0
}
```

- [ ] **Step 4: Run — passes**

Run: `cd packages/omemo-plugin && npx vitest run src/verifiedDevices.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo-plugin/src/verifiedDevices.ts packages/omemo-plugin/src/verifiedDevices.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): fingerprint-bound verified-device marker store"
```

---

### Task 7: Plugin `getOwnFingerprint()` (read-only)

**Files:**
- Modify: `packages/omemo-plugin/src/OmemoPlugin.ts`
- Modify: `packages/omemo-plugin/src/OmemoPlugin.identity.test.ts`

**Interfaces:**
- Consumes: `OmemoAccount.identityFingerprint()`, module-private `hex()`.
- Produces: `OmemoPlugin.getOwnFingerprint(): Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/omemo-plugin/src/OmemoPlugin.identity.test.ts` inside the existing `describe('OmemoPlugin identity/probe', …)` block:
```ts
  it('getOwnFingerprint returns the hex identity fingerprint without publishing', async () => {
    const a = createMockPluginContext('a@x')
    const p = new OmemoPlugin()
    await p.init(a.ctx)
    const fp = await p.getOwnFingerprint()
    expect(fp).toMatch(/^[0-9a-f]+$/)
    // Read-only: it must NOT have published a device-list/bundle (unlike ensureIdentity).
    expect(a.publishes).toHaveLength(0)
    // Stable across calls and equal to ensureIdentity's fingerprint.
    const id = await p.ensureIdentity()
    expect(await p.getOwnFingerprint()).toBe(id.fingerprint)
  })
```

- [ ] **Step 2: Run — fails**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.identity.test.ts`
Expected: FAIL — `p.getOwnFingerprint is not a function`.

- [ ] **Step 3: Implement**

In `packages/omemo-plugin/src/OmemoPlugin.ts`, add the method right after `ensureIdentity()` (after line 102):
```ts

  /**
   * Read-only OMEMO identity fingerprint (hex), for the verify dialog's
   * own-fingerprint display. Loads/creates the local account but NEVER
   * publishes — unlike {@link ensureIdentity}, which has PEP side effects and
   * must not run on the dialog hot path. Returns `null` only if the account
   * cannot be loaded.
   */
  async getOwnFingerprint(): Promise<string | null> {
    try {
      const acc = await this.ensureAccount()
      return hex(acc.identityFingerprint())
    } catch {
      return null
    }
  }
```

- [ ] **Step 4: Run — passes**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/omemo-plugin/src/OmemoPlugin.ts packages/omemo-plugin/src/OmemoPlugin.identity.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): read-only getOwnFingerprint()"
```

---

### Task 8: Plugin `listPeerIdentities(peer)` + shared per-device resolver

Assemble `{id, fingerprint, trust}` per device from device-list + stored IK / fetched bundle + verified store. Introduce a private `resolvePeerIdentity` helper reused by later tasks.

**Files:**
- Modify: `packages/omemo-plugin/src/OmemoPlugin.ts`
- Create: `packages/omemo-plugin/src/OmemoPlugin.trust.test.ts`

**Interfaces:**
- Consumes: `fetchDeviceList`, `fetchBundle` (`./pep`); `fingerprint` (`@fluux/omemo`); `isVerified` (`./verifiedDevices`); `toTrustState`, `BtbvState` (`./trust`); `PluginStorageOmemoStore.loadTrust`.
- Produces:
  - `OmemoPlugin.listPeerIdentities(peer: BareJID): Promise<PeerIdentity[]>`
  - private `resolvePeerIdentity(peer: string, deviceId: number): Promise<PeerIdentity>`

- [ ] **Step 1: Add imports to OmemoPlugin.ts**

In `packages/omemo-plugin/src/OmemoPlugin.ts`:
- Add `PeerIdentity` to the `import type { … } from '@fluux/sdk'` list (after `IdentityInfo,`).
- Change `import { OmemoAccount } from '@fluux/omemo'` to `import { OmemoAccount, fingerprint } from '@fluux/omemo'`.
- Add `import { isVerified, hasAnyVerified, setVerified, clearVerified } from './verifiedDevices'` after the `./trust` import (line 34). (Later tasks use `hasAnyVerified`/`setVerified`/`clearVerified`; import them now to avoid churn.)

- [ ] **Step 2: Write the failing tests**

```ts
// packages/omemo-plugin/src/OmemoPlugin.trust.test.ts
import { describe, it, expect } from 'vitest'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext } from './testing/MockPluginContext'
import { PluginStorageOmemoStore } from './store'
import { fetchBundle } from './pep'
import { fingerprint } from '@fluux/omemo'

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Stand up Alice + Bob on a shared net; Bob publishes identity so Alice can see his device. */
async function twoParty() {
  const alice = createMockPluginContext('alice@x')
  const bob = createMockPluginContext('bob@x', alice.net)
  const pa = new OmemoPlugin()
  await pa.init(alice.ctx)
  await pa.ensureIdentity()
  const pb = new OmemoPlugin()
  await pb.init(bob.ctx)
  const bobId = await pb.ensureIdentity()
  const bobDeviceId = Number(bobId.devices![0].deviceId)
  return { alice, bob, pa, pb, bobDeviceId }
}

describe('OmemoPlugin.listPeerIdentities', () => {
  it('lists one identity per device with its fingerprint (from the published bundle)', async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    const list = await pa.listPeerIdentities('bob@x')
    expect(list).toHaveLength(1)
    const bundle = await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDeviceId)
    expect(list[0]).toEqual({
      id: String(bobDeviceId),
      fingerprint: hex(fingerprint(bundle!.ik)),
      trust: 'unknown', // no trust record yet, not verified
    })
  })

  it('a device advertised with no fetchable bundle → fingerprint "" and trust "unknown"', async () => {
    const alice = createMockPluginContext('alice@x')
    const pa = new OmemoPlugin()
    await pa.init(alice.ctx)
    // Seed ONLY a device list for a peer with no bundle node.
    const { deviceListToXml } = await import('./pep')
    const { elementToData } = await import('./stanzaData')
    const { devicesNode } = await import('./namespaces')
    const { seedPeer } = await import('./testing/MockPluginContext')
    seedPeer(alice.net, 'ghost@x', devicesNode(), elementToData(deviceListToXml([777])))
    const list = await pa.listPeerIdentities('ghost@x')
    expect(list).toEqual([{ id: '777', fingerprint: '', trust: 'unknown' }])
  })

  it('reflects a stored blind-trusted (tofu) device', async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    const bundle = await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDeviceId)
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    await store.saveTrust('bob@x', bobDeviceId, { state: 'trusted', identityKey: bundle!.ik })
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('tofu')
  })
})
```

- [ ] **Step 3: Run — fails**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.trust.test.ts`
Expected: FAIL — `pa.listPeerIdentities is not a function`.

- [ ] **Step 4: Implement `resolvePeerIdentity` + `listPeerIdentities`**

In `packages/omemo-plugin/src/OmemoPlugin.ts`, replace the hardcoded `peerHasVerifiedDevice` method (lines 366-376) region by inserting the new methods just BEFORE `getPeerTrust` (line 123). Add:
```ts
  /**
   * Resolve one peer device to a {@link PeerIdentity}. Identity key comes from
   * the persisted `TrustRecord.identityKey` (bound on first session) when
   * present, else a best-effort bundle fetch. No key → `fingerprint:''`,
   * `trust:'unknown'`. Trust precedence: a fingerprint-bound verified marker
   * wins (`'verified'`), else the library BTBV state (`toTrustState`).
   */
  private async resolvePeerIdentity(peer: string, deviceId: number): Promise<PeerIdentity> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const existing = await store.loadTrust(peer, deviceId)
    let ik: Uint8Array | null =
      existing?.identityKey && existing.identityKey.length > 0 ? existing.identityKey : null
    if (!ik) {
      try {
        ik = (await fetchBundle(this.ctx.xmpp, peer, deviceId))?.ik ?? null
      } catch {
        ik = null
      }
    }
    const fpHex = ik ? hex(fingerprint(ik)) : ''
    let trust: TrustState
    if (fpHex && (await isVerified(this.ctx.storage, peer, deviceId, fpHex))) {
      trust = 'verified'
    } else if (!fpHex) {
      trust = 'unknown'
    } else {
      trust = toTrustState((existing?.state as BtbvState | undefined) ?? 'undecided')
    }
    return { id: String(deviceId), fingerprint: fpHex, trust }
  }

  async listPeerIdentities(peer: BareJID): Promise<PeerIdentity[]> {
    const ids = await fetchDeviceList(this.ctx.xmpp, peer)
    const out: PeerIdentity[] = []
    for (const id of ids) out.push(await this.resolvePeerIdentity(peer, id))
    return out
  }
```

- [ ] **Step 5: Run — passes**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.trust.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/omemo-plugin/src/OmemoPlugin.ts packages/omemo-plugin/src/OmemoPlugin.trust.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): listPeerIdentities + per-device trust resolver"
```

---

### Task 9: Plugin `setIdentityTrust(peer, id, decision)`

**Files:**
- Modify: `packages/omemo-plugin/src/OmemoPlugin.ts`
- Modify: `packages/omemo-plugin/src/OmemoPlugin.trust.test.ts`

**Interfaces:**
- Consumes: `resolvePeerIdentity` (Task 8), `fetchBundle`, `fingerprint`, `setVerified`/`clearVerified` (Task 6/8 imports), `PluginStorageOmemoStore.loadTrust/saveTrust`.
- Produces: `OmemoPlugin.setIdentityTrust(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void>`.

- [ ] **Step 1: Write failing tests**

Append to `packages/omemo-plugin/src/OmemoPlugin.trust.test.ts` a new describe:
```ts
describe('OmemoPlugin.setIdentityTrust', () => {
  it("'verified' pins the current fingerprint and flips listed trust to verified", async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('verified')
    // Fingerprint-bound: getPeerTrust also reflects it.
    expect(await pa.getPeerTrust('bob@x')).toBe('verified')
  })

  it("'verified' then a fingerprint change invalidates the marker (back to unverified)", async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    // Simulate a key change: overwrite the stored TrustRecord's identityKey.
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    const rec = await store.loadTrust('bob@x', bobDeviceId)
    await store.saveTrust('bob@x', bobDeviceId, {
      state: rec?.state ?? 'trusted',
      identityKey: new Uint8Array(32).fill(0xaa), // different key → different fp
    })
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).not.toBe('verified')
  })

  it("'untrusted' writes library untrusted state and removes any verified marker", async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    expect((await store.loadTrust('bob@x', bobDeviceId))!.state).toBe('untrusted')
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('untrusted')
  })

  it('is idempotent for repeated verified calls', async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('verified')
  })
})
```

- [ ] **Step 2: Run — fails**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.trust.test.ts`
Expected: FAIL — `pa.setIdentityTrust is not a function`.

- [ ] **Step 3: Implement**

In `OmemoPlugin.ts`, add after `listPeerIdentities` (Task 8):
```ts
  async setIdentityTrust(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void> {
    const deviceId = Number(id)
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const existing = await store.loadTrust(peer, deviceId)
    // Resolve the device's current identity key (persisted first, else bundle).
    let ik: Uint8Array | null =
      existing?.identityKey && existing.identityKey.length > 0 ? existing.identityKey : null
    if (!ik) {
      try {
        ik = (await fetchBundle(this.ctx.xmpp, peer, deviceId))?.ik ?? null
      } catch {
        ik = null
      }
    }
    if (decision === 'verified') {
      // A verify has nothing to pin without a key; ignore the no-key case
      // (the UI disables verify when fingerprint is '').
      if (!ik) return
      await setVerified(this.ctx.storage, peer, deviceId, hex(fingerprint(ik)))
      // Clear any prior library `untrusted` verdict so the two stores agree.
      if (existing && existing.state === 'untrusted') {
        await store.saveTrust(peer, deviceId, { ...existing, state: 'undecided' })
      }
    } else {
      // untrusted: persist the library verdict (bound to the key when we have
      // it) and drop any verified marker.
      await store.saveTrust(peer, deviceId, { state: 'untrusted', identityKey: ik ?? new Uint8Array(0) })
      await clearVerified(this.ctx.storage, peer, deviceId)
    }
  }
```

- [ ] **Step 4: Run — passes**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.trust.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/omemo-plugin/src/OmemoPlugin.ts packages/omemo-plugin/src/OmemoPlugin.trust.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): setIdentityTrust (verify/revoke, fingerprint-bound)"
```

---

### Task 10: Wire `peerHasVerifiedDevice` + verified-aware `getDeviceTrust`/`getPeerTrust`

Make `peerHasVerifiedDevice` consult the verified store (activating BTBV `resolveInboundTrust`), and make `getDeviceTrust`/`getPeerTrust` route through `resolvePeerIdentity` so `'verified'` is producible.

**Files:**
- Modify: `packages/omemo-plugin/src/OmemoPlugin.ts`
- Modify: `packages/omemo-plugin/src/OmemoPlugin.trust.test.ts`

**Interfaces:**
- Consumes: `hasAnyVerified` (Task 6), `resolvePeerIdentity` (Task 8).
- Produces: unchanged public signatures `getPeerTrust`, `getDeviceTrust`; `peerHasVerifiedDevice(store, peer)` now returns real data.

- [ ] **Step 1: Write failing tests**

Append to `packages/omemo-plugin/src/OmemoPlugin.trust.test.ts`:
```ts
describe('OmemoPlugin BTBV wiring', () => {
  it('getDeviceTrust surfaces verified after setIdentityTrust', async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    expect(await pa.getDeviceTrust('bob@x', String(bobDeviceId))).toBe('verified')
  })

  it('once a peer has a verified device, a newly-seen device resolves to untrusted (BTBV)', async () => {
    const { alice, bob, pa, pb, bobDeviceId } = await twoParty()
    // Verify bob's first device.
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    // Bob adds a SECOND device on the shared net.
    const bob2 = createMockPluginContext('bob@x', alice.net)
    const pb2 = new OmemoPlugin()
    await pb2.init(bob2.ctx)
    // Re-create identity for a distinct device id by seeding a fresh account:
    const secondId = await pb2.ensureIdentity()
    const secondDeviceId = Number(secondId.devices![0].deviceId)
    // The second device, never verified, with a peer that HAS a verified device,
    // must resolve untrusted via resolveInboundTrust (peerHasVerifiedDevice=true).
    const store = new (await import('./store')).PluginStorageOmemoStore(alice.ctx.storage)
    const { resolveInboundTrust } = await import('./trust')
    const peerHasVerified = await (pa as unknown as {
      peerHasVerifiedDevice(s: unknown, p: string): Promise<boolean>
    }).peerHasVerifiedDevice(store, 'bob@x')
    expect(peerHasVerified).toBe(true)
    expect(resolveInboundTrust(peerHasVerified, null).store).toBe('untrusted')
    expect(secondDeviceId).not.toBe(bobDeviceId)
  })

  it('getPeerTrust returns verified for a peer with a verified and no untrusted device', async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    expect(await pa.getPeerTrust('bob@x')).toBe('verified')
  })
})
```

- [ ] **Step 2: Run — fails**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.trust.test.ts`
Expected: FAIL — `getDeviceTrust`/`getPeerTrust`/`peerHasVerifiedDevice` do not yet surface `verified`.

- [ ] **Step 3: Rewrite `getPeerTrust`, `getDeviceTrust`, `peerHasVerifiedDevice`**

In `OmemoPlugin.ts`:

(a) Replace the body of `getPeerTrust` (lines 123-144) with an aggregate over `resolvePeerIdentity`:
```ts
  async getPeerTrust(peer: BareJID): Promise<TrustState> {
    const ids = await fetchDeviceList(this.ctx.xmpp, peer)
    // Surface the STRONGEST concern with priority: any untrusted device
    // dominates, then any verified, then blind-trusted (tofu), else unknown.
    let sawUntrusted = false
    let sawVerified = false
    let sawTofu = false
    for (const id of ids) {
      const { trust } = await this.resolvePeerIdentity(peer, id)
      if (trust === 'untrusted') sawUntrusted = true
      else if (trust === 'verified') sawVerified = true
      else if (trust === 'tofu') sawTofu = true
    }
    if (sawUntrusted) return 'untrusted'
    if (sawVerified) return 'verified'
    if (sawTofu) return 'tofu'
    return 'unknown'
  }
```

(b) Replace `getDeviceTrust` (lines 146-150) with:
```ts
  async getDeviceTrust(peer: BareJID, deviceId: string): Promise<TrustState> {
    return (await this.resolvePeerIdentity(peer, Number(deviceId))).trust
  }
```

(c) Replace the hardcoded `peerHasVerifiedDevice` (lines 366-376) with:
```ts
  /**
   * BTBV gate: does the peer have any EXPLICITLY verified device (fingerprint-
   * bound marker present)? When true, `resolveInboundTrust` forces newly-seen
   * unverified devices to `untrusted` rather than blind-trusting them.
   */
  private async peerHasVerifiedDevice(_store: PluginStorageOmemoStore, peer: string): Promise<boolean> {
    return hasAnyVerified(this.ctx.storage, peer)
  }
```
(The `_store` param is kept for call-site compatibility with `resolveInboundSecurity`.)

- [ ] **Step 4: Run the plugin trust suite + the existing identity suite**

Run:
```bash
cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.trust.test.ts src/OmemoPlugin.identity.test.ts
```
Expected: PASS. (The identity suite's `getPeerTrust`/`getDeviceTrust` "unknown" cases still hold: no trust record + no bundle → `unknown`; a peer with a fetchable bundle but no trust record now resolves via `resolvePeerIdentity` to `unknown` as well.)

- [ ] **Step 5: Commit**

```bash
git add packages/omemo-plugin/src/OmemoPlugin.ts packages/omemo-plugin/src/OmemoPlugin.trust.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): BTBV — verified-aware trust + peerHasVerifiedDevice"
```

---

### Task 11: Encrypt excludes `untrusted` peer devices

Filter untrusted peer devices out BEFORE `ensureSessions`; the existing zero-usable-devices throw then covers the all-untrusted case.

**Files:**
- Modify: `packages/omemo-plugin/src/OmemoPlugin.ts`
- Modify: `packages/omemo-plugin/src/OmemoPlugin.crypto.test.ts`

**Interfaces:**
- Consumes: `resolvePeerIdentity` (Task 8).
- Produces: `encrypt` drops `untrusted` peer devices; all-untrusted throws the existing loud error.

- [ ] **Step 1: Inspect the current crypto test harness for encrypt**

Run: `cd packages/omemo-plugin && grep -n "encrypt\|reachablePeerDevs\|no usable OMEMO\|openConversation" src/OmemoPlugin.crypto.test.ts | head -30`
Read the surrounding helpers so the new test reuses the existing two-party encrypt setup (Alice encrypts to Bob). Note the helper that opens a conversation and the assertion style.

- [ ] **Step 2: Write the failing test**

Append to `packages/omemo-plugin/src/OmemoPlugin.crypto.test.ts` a describe (adapt the two-party setup to the file's existing helper names discovered in Step 1; the version below stands up its own contexts so it is self-contained):
```ts
import { parseEncrypted } from './encryptedElement'
import { dataToElement } from './stanzaData'

describe('OmemoPlugin.encrypt — untrusted exclusion', () => {
  async function pair() {
    const alice = createMockPluginContext('alice@x')
    const bob = createMockPluginContext('bob@x', alice.net)
    const pa = new OmemoPlugin(); await pa.init(alice.ctx); await pa.ensureIdentity()
    const pb = new OmemoPlugin(); await pb.init(bob.ctx)
    const bobId = await pb.ensureIdentity()
    const bobDeviceId = Number(bobId.devices![0].deviceId)
    return { alice, bob, pa, pb, bobDeviceId }
  }
  const payload = new TextEncoder().encode('<payload xmlns="jabber:client"><body>hi</body></payload>')

  it('excludes an untrusted peer device from recipients', async () => {
    const { alice, pa, pb, bobDeviceId } = await pair()
    // Bob adds a second device so exactly one can be untrusted while a send still works.
    const bob2 = createMockPluginContext('bob@x', alice.net)
    const pb2 = new OmemoPlugin(); await pb2.init(bob2.ctx)
    const secondId = await pb2.ensureIdentity()
    const secondDeviceId = Number(secondId.devices![0].deviceId)
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')

    const handle = await pa.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await pa.encrypt(handle, payload)
    const msg = parseEncrypted(dataToElement(enc.stanzaElement))
    const recipientDeviceIds = msg.keys.map((k) => k.rid)
    expect(recipientDeviceIds).not.toContain(bobDeviceId)
    expect(recipientDeviceIds).toContain(secondDeviceId)
  })

  it('throws the loud no-usable-devices error when EVERY peer device is untrusted', async () => {
    const { pa, bobDeviceId } = await pair()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')
    const handle = await pa.openConversation({ kind: 'direct', peer: 'bob@x' })
    await expect(pa.encrypt(handle, payload)).rejects.toThrow(/no usable OMEMO devices/)
  })

  it('pre-verification blind trust: nothing excluded (current behavior preserved)', async () => {
    const { pa, bobDeviceId } = await pair()
    const handle = await pa.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await pa.encrypt(handle, payload)
    const msg = parseEncrypted(dataToElement(enc.stanzaElement))
    expect(msg.keys.map((k) => k.rid)).toContain(bobDeviceId)
  })
})
```
Note: confirm the `OmemoMessage`/`parseEncrypted` shape exposes recipient key ids as `keys[].rid` — check with `grep -n "rid\|interface OmemoMessage\|keys" packages/omemo/src/omemo2/codec.ts`. If the field name differs (e.g. `keys[].deviceId`), adjust the two `.rid` reads accordingly.

- [ ] **Step 3: Run — fails**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.crypto.test.ts`
Expected: FAIL — untrusted device still included; all-untrusted does not throw.

- [ ] **Step 4: Implement the exclusion in `encrypt`**

In `OmemoPlugin.ts` `encrypt` (lines 204-265), after computing `peerDevs` and the existing empty-guard (line 229-231), insert a trust filter BEFORE `ensureSessions`:
```ts
    // BTBV encrypt exclusion: drop peer devices whose resolved trust is
    // `untrusted`. Own devices are unaffected (own-device trust is M2c-3).
    // Before any verification exists all devices are tofu/unknown, so nothing
    // is dropped (M2b blind-trust behavior preserved). If this empties the
    // peer set (every device untrusted), the existing zero-usable-devices
    // guard below fails LOUD rather than silently sending to self only.
    const trustedPeerDevs: number[] = []
    for (const rid of peerDevs) {
      const { trust } = await this.resolvePeerIdentity(peer, rid)
      if (trust !== 'untrusted') trustedPeerDevs.push(rid)
    }
    if (trustedPeerDevs.length === 0) {
      throw new Error(`OMEMO: peer ${peer} has no usable OMEMO devices`)
    }
```
Then change the subsequent `ensureSessions` and `reachableDevices` calls to use `trustedPeerDevs` instead of `peerDevs`:
- Line 236 `await this.ensureSessions(acc, peer, peerDevs)` → `await this.ensureSessions(acc, peer, trustedPeerDevs)`
- Line 244 `const reachablePeerDevs = await this.reachableDevices(peer, peerDevs)` → `const reachablePeerDevs = await this.reachableDevices(peer, trustedPeerDevs)`

The existing `reachablePeerDevs.length === 0` guard (line 250-252) stays as the second loud-fail.

- [ ] **Step 5: Run — passes**

Run: `cd packages/omemo-plugin && npx vitest run src/OmemoPlugin.crypto.test.ts`
Expected: PASS.

- [ ] **Step 6: Build the plugin, run its whole suite, and typecheck**

Run:
```bash
npm run build -w @fluux/omemo-plugin
cd packages/omemo-plugin && npx vitest run
cd ../.. && npm run typecheck
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/omemo-plugin/src/OmemoPlugin.ts packages/omemo-plugin/src/OmemoPlugin.crypto.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): exclude untrusted peer devices from encryption"
```

---

## Phase C — UI

### Task 12: SecurityTab OMEMO per-identity list (+ protocolId-aware branch)

Make `SecurityTab` render a per-identity device list for OMEMO conversations (`state.protocolId === 'omemo:2'`) with per-device badges (shared `trustStateVisual`/`trustLabel`) and Verify/Revoke actions, plus loading/error states. OpenPGP branch unchanged. The OMEMO plugin surface is passed in as a prop so the tab stays testable without the E2EEManager.

**Files:**
- Modify: `apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`
- Modify: `apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx` (thread the new props)
- Create: `apps/fluux/src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx`
- Modify: all 33 locales (OMEMO device-list copy)

**Interfaces:**
- Consumes: `PeerIdentity` from `@fluux/sdk`; `trustStateVisual`, `trustLabel` from `@/e2ee/trustVisual`.
- Produces: new optional `SecurityTab` props:
  ```ts
  peerJid?: string
  omemo?: {
    listPeerIdentities: (peer: string) => Promise<PeerIdentity[]>
    onVerifyDevice: (identity: PeerIdentity) => void
    onRevokeDevice: (identity: PeerIdentity) => Promise<void>
    reloadKey?: number  // bump to force a reload after verify/revoke
  } | null
  ```

- [ ] **Step 1: Add OMEMO device-list i18n keys to all 33 locales**

English source strings:

| key | en value |
|---|---|
| `contacts.encryption.omemo.title` | `Devices` |
| `contacts.encryption.omemo.summary` | `{{count}} devices, {{verified}} verified` |
| `contacts.encryption.omemo.deviceLabel` | `Device {{id}}` |
| `contacts.encryption.omemo.noKeyYet` | `No key published yet` |
| `contacts.encryption.omemo.verify` | `Verify` |
| `contacts.encryption.omemo.revoke` | `Revoke` |
| `contacts.encryption.omemo.loading` | `Loading devices...` |
| `contacts.encryption.omemo.loadError` | `Could not load devices` |
| `contacts.encryption.omemo.retry` | `Retry` |

Apply (then translate non-en values per the i18n workflow):
```bash
cd apps/fluux/src/i18n/locales
python3 - <<'PY'
import json, glob
EN = {
    "title": "Devices",
    "summary": "{{count}} devices, {{verified}} verified",
    "deviceLabel": "Device {{id}}",
    "noKeyYet": "No key published yet",
    "verify": "Verify",
    "revoke": "Revoke",
    "loading": "Loading devices...",
    "loadError": "Could not load devices",
    "retry": "Retry",
}
for path in sorted(glob.glob("*.json")):
    d = json.load(open(path, encoding="utf-8"))
    d.setdefault("contacts", {}).setdefault("encryption", {})["omemo"] = dict(EN)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=4); f.write("\n")
print("seeded contacts.encryption.omemo into all locales")
PY
```
Then translate each non-`en.json` locale's nine values (keep `{{count}}`/`{{verified}}`/`{{id}}` placeholders and "OMEMO" literal). Add asserted keys to the app test i18n subset if the OMEMO test below asserts on translated text — the test below asserts on the KEY strings (test i18n returns keys), so no `test-setup.ts` change is required.

- [ ] **Step 2: Write the failing OMEMO SecurityTab test**

```tsx
// apps/fluux/src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { PeerIdentity } from '@fluux/sdk'
import { SecurityTab } from './SecurityTab'

const noop = () => {}

function omemoState() {
  return { kind: 'encrypted' as const, protocolId: 'omemo:2' as const, fingerprint: '', trust: 'tofu' as const }
}

function makeOmemo(identities: PeerIdentity[]) {
  return {
    listPeerIdentities: vi.fn().mockResolvedValue(identities),
    onVerifyDevice: vi.fn(),
    onRevokeDevice: vi.fn().mockResolvedValue(undefined),
  }
}

describe('SecurityTab — OMEMO per-identity list', () => {
  it('renders one row per device with fingerprint and a trust badge', async () => {
    const omemo = makeOmemo([
      { id: '111', fingerprint: 'aabbccdd', trust: 'verified' },
      { id: '222', fingerprint: 'eeff0011', trust: 'tofu' },
    ])
    render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(omemo.listPeerIdentities).toHaveBeenCalledWith('bob@x'))
    // Device labels rendered (i18n returns the key in tests).
    expect(await screen.findByText(/Device.*111|contacts\.encryption\.omemo\.deviceLabel/)).toBeTruthy()
    // Verified badge label key present.
    expect(screen.getByText('contacts.encryption.trust.verified')).toBeTruthy()
    expect(screen.getByText('contacts.encryption.trust.tofu')).toBeTruthy()
  })

  it('a device with no key shows the verify action disabled', async () => {
    const omemo = makeOmemo([{ id: '333', fingerprint: '', trust: 'unknown' }])
    const { container } = render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(omemo.listPeerIdentities).toHaveBeenCalled())
    const verifyBtn = container.querySelector('button[data-testid="omemo-verify-333"]') as HTMLButtonElement | null
    expect(verifyBtn).not.toBeNull()
    expect(verifyBtn!.disabled).toBe(true)
  })

  it('clicking Verify on a keyed device calls onVerifyDevice with the identity', async () => {
    const identity: PeerIdentity = { id: '111', fingerprint: 'aabbccdd', trust: 'tofu' }
    const omemo = makeOmemo([identity])
    const { container } = render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(omemo.listPeerIdentities).toHaveBeenCalled())
    const btn = container.querySelector('button[data-testid="omemo-verify-111"]') as HTMLButtonElement
    btn.click()
    expect(omemo.onVerifyDevice).toHaveBeenCalledWith(identity)
  })

  it('shows an error + retry when listPeerIdentities rejects', async () => {
    const omemo = {
      listPeerIdentities: vi.fn().mockRejectedValue(new Error('net')),
      onVerifyDevice: vi.fn(),
      onRevokeDevice: vi.fn(),
    }
    render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    expect(await screen.findByText('contacts.encryption.omemo.loadError')).toBeTruthy()
    expect(screen.getByText('contacts.encryption.omemo.retry')).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run — fails**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx`
Expected: FAIL — SecurityTab has no `omemo` prop / renders nothing for the OMEMO branch.

- [ ] **Step 4: Implement the OMEMO branch in SecurityTab**

In `SecurityTab.tsx`:

(a) Update imports (top of file):
```tsx
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Shield, ShieldAlert, ShieldCheck, ShieldOff, ShieldX } from 'lucide-react'
import type { PeerIdentity } from '@fluux/sdk'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { trustVisual, trustStateVisual, trustLabel } from '@/e2ee/trustVisual'
```

(b) Extend `SecurityTabProps`:
```tsx
interface SecurityTabProps {
  state: ConversationEncryptionState
  onVerify: () => void
  onRequestRevoke: () => void
  onDisableEncryption: () => void
  onEnableEncryption: () => void
  /** Present for OMEMO conversations; drives the per-identity device list. */
  peerJid?: string
  omemo?: {
    listPeerIdentities: (peer: string) => Promise<PeerIdentity[]>
    onVerifyDevice: (identity: PeerIdentity) => void
    onRevokeDevice: (identity: PeerIdentity) => Promise<void>
    reloadKey?: number
  } | null
}
```

(c) In the component, add OMEMO detection and render the list INSIDE the `state.kind === 'encrypted'` block, replacing the single-fingerprint body when OMEMO is active. Change the `encrypted` block opening to branch:
```tsx
        {state.kind === 'encrypted' && state.protocolId === 'omemo:2' && omemo && peerJid && (
          <OmemoDeviceList peerJid={peerJid} omemo={omemo} />
        )}

        {state.kind === 'encrypted' && !(state.protocolId === 'omemo:2' && omemo && peerJid) && (
          <>
            {/* existing OpenPGP single-fingerprint body — unchanged */}
```
(keep the existing OpenPGP `<>…</>` body verbatim, just gated so OMEMO does not also render it).

(d) Add the `OmemoDeviceList` sub-component at the bottom of the file (before `formatFingerprint`):
```tsx
function OmemoDeviceList({
  peerJid,
  omemo,
}: {
  peerJid: string
  omemo: NonNullable<SecurityTabProps['omemo']>
}) {
  const { t } = useTranslation()
  const [identities, setIdentities] = useState<PeerIdentity[] | null>(null)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setIdentities(null)
    setError(false)
    void omemo
      .listPeerIdentities(peerJid)
      .then((list) => {
        if (!cancelled) setIdentities(list)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
    // reload (local) + omemo.reloadKey (parent) both force a refetch.
  }, [peerJid, omemo, reload, omemo.reloadKey])

  if (error) {
    return (
      <div className="space-y-2">
        <ExplanationPanel
          icon={<ShieldX className={`size-5 ${trustVisual('rejected').colorClass} flex-shrink-0`} />}
          title={t('contacts.encryption.omemo.loadError')}
          tone="danger"
        />
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-border rounded-lg transition-colors text-sm min-h-[44px]"
        >
          {t('contacts.encryption.omemo.retry')}
        </button>
      </div>
    )
  }

  if (identities === null) {
    return (
      <ExplanationPanel
        icon={<Loader2 className="size-5 text-fluux-muted animate-spin flex-shrink-0" />}
        title={t('contacts.encryption.omemo.loading')}
        tone="neutral"
      />
    )
  }

  const verifiedCount = identities.filter((i) => i.trust === 'verified').length

  return (
    <div className="space-y-2">
      <div className="text-xs text-fluux-muted px-1">
        {t('contacts.encryption.omemo.summary', { count: identities.length, verified: verifiedCount })}
      </div>
      {identities.map((id) => {
        const visual = trustStateVisual(id.trust)
        const hasKey = id.fingerprint !== ''
        return (
          <div key={id.id} className="rounded-lg bg-fluux-bg/40 px-3 py-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-fluux-text">
                {t('contacts.encryption.omemo.deviceLabel', { id: id.id })}
              </span>
              <span className={`inline-flex items-center gap-1 text-xs ${visual.colorClass}`}>
                {id.trust === 'verified' ? <ShieldCheck className="size-3.5" /> : <Shield className="size-3.5" />}
                {t(trustLabel(id.trust))}
              </span>
            </div>
            <code className="block text-[11px] font-mono text-fluux-muted break-all leading-relaxed">
              {hasKey ? formatFingerprint(id.fingerprint) : t('contacts.encryption.omemo.noKeyYet')}
            </code>
            <div className="flex gap-2">
              {id.trust === 'verified' ? (
                <button
                  type="button"
                  data-testid={`omemo-revoke-${id.id}`}
                  onClick={() => void omemo.onRevokeDevice(id).then(() => setReload((n) => n + 1))}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-error border border-fluux-red rounded-lg transition-colors text-xs min-h-[36px]"
                >
                  <ShieldOff className="size-3.5" />
                  {t('contacts.encryption.omemo.revoke')}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`omemo-verify-${id.id}`}
                  disabled={!hasKey}
                  onClick={() => omemo.onVerifyDevice(id)}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-border rounded-lg transition-colors text-xs min-h-[36px] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ShieldCheck className="size-3.5" />
                  {t('contacts.encryption.omemo.verify')}
                </button>
              )}
              {id.trust === 'untrusted' && (
                <span className={`flex items-center gap-1 text-xs ${trustStateVisual('untrusted').colorClass}`}>
                  <ShieldAlert className="size-3.5" />
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 5: Thread the props through ContactSecurityDetail**

In `ContactSecurityDetail.tsx`, add `peerJid?` and `omemo?` to its props and forward them to `<SecurityTab>`:
```tsx
interface ContactSecurityDetailProps {
  state: ConversationEncryptionState
  onVerify: () => void
  onRequestRevoke: () => void
  onDisableEncryption: () => void
  onEnableEncryption: () => void
  onClose: () => void
  peerJid?: string
  omemo?: React.ComponentProps<typeof SecurityTab>['omemo']
}
```
Destructure `peerJid, omemo` and pass `peerJid={peerJid} omemo={omemo}` to `<SecurityTab ... />`. Add `import type React from 'react'` if not already importable (or type `omemo` via importing `SecurityTab`'s props). ContactProfileView wiring is Task 14.

- [ ] **Step 6: Run the OMEMO SecurityTab test + the Task-1 regression (OpenPGP still intact)**

Run:
```bash
cd apps/fluux && npx vitest run src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx src/e2ee/openpgpTrustRendering.regression.test.tsx
```
Expected: PASS.

- [ ] **Step 7: 33-locale parity check for the omemo keys**

Run:
```bash
cd apps/fluux/src/i18n/locales
python3 - <<'PY'
import json, glob
keys = ["title","summary","deviceLabel","noKeyYet","verify","revoke","loading","loadError","retry"]
bad=[]
for p in sorted(glob.glob("*.json")):
    o=json.load(open(p,encoding="utf-8")).get("contacts",{}).get("encryption",{}).get("omemo",{})
    m=[k for k in keys if k not in o]
    if m: bad.append((p,m))
print("OK" if not bad else bad)
PY
```
Expected: `OK`.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx apps/fluux/src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx apps/fluux/src/i18n/locales
git commit --no-gpg-sign -m "feat(e2ee): OMEMO per-identity device list in SecurityTab"
```

---

### Task 13: ChatHeader G-1 — protocolId-aware OMEMO label

Make the header tooltip say "OMEMO" + aggregate trust for OMEMO conversations, and suppress the empty single-fingerprint block (OMEMO has no single fingerprint).

**Files:**
- Modify: `apps/fluux/src/components/ChatHeader.tsx`
- Modify: `apps/fluux/src/components/ChatHeader.test.tsx`

**Interfaces:**
- Consumes: `encrypted.protocolId`, `encrypted.trust: TrustState`; `trustLabel` from `@/e2ee/trustVisual`; existing i18n `chat.encryption.tooltip.protocol."omemo:2"` (= "OMEMO") and `contacts.encryption.trust.*` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write failing header test**

Append to `apps/fluux/src/components/ChatHeader.test.tsx` (reuse the file's existing render helper; the snippet assumes a `renderHeader(state)` style — adapt to the file's actual harness discovered by reading its top):
```tsx
  it('OMEMO encrypted state: tooltip reads OMEMO + trust and shows no empty fingerprint', async () => {
    // Render the encryption chip for an OMEMO state with an empty fingerprint.
    const state = { kind: 'encrypted', protocolId: 'omemo:2', fingerprint: '', trust: 'tofu' } as const
    const { container } = renderEncryptionChip(state) // see harness note below
    // The empty single-fingerprint block must NOT render (no 4-char groups of nothing).
    expect(container.querySelector('.font-mono')).toBeNull()
  })
```
Harness note: if `ChatHeader.test.tsx` renders the whole header, assert instead that for an OMEMO state the tooltip text contains the OMEMO protocol key and no `.font-mono` fingerprint node appears. Read the existing tests in the file first and mirror their setup exactly; keep the assertion to "no `.font-mono` block for empty OMEMO fingerprint" which is stable.

- [ ] **Step 2: Run — fails**

Run: `cd apps/fluux && npx vitest run src/components/ChatHeader.test.tsx`
Expected: FAIL — current code renders `formatFingerprint('')` (an empty `.font-mono` block) and uses the OpenPGP tooltip.

- [ ] **Step 3: Implement protocolId-aware tooltips**

In `ChatHeader.tsx`, add a derived OMEMO flag and tooltip text near the `verified`/`tofuNew` derivation (after line 367):
```tsx
  const isOmemo = state.kind === 'encrypted' && state.protocolId === 'omemo:2'
  const omemoTooltipText =
    state.kind === 'encrypted'
      ? `${t('chat.encryption.tooltip.protocol.omemo:2')} — ${t(trustLabel(state.trust))}`
      : ''
```
Add `import { trustVisual, trustLabel } from '@/e2ee/trustVisual'` (extend the existing `trustVisual` import).

Then, in BOTH tooltip blocks, branch on `isOmemo`:

First block (no-actions, lines ~381-392) becomes:
```tsx
    const tooltip = (
      <div>
        <div>{isOmemo
          ? omemoTooltipText
          : verified
            ? t('chat.encryption.verifiedTooltip')
            : tofuNew
              ? t('chat.encryption.tofuNewTooltip', 'New contact — verify fingerprint for full trust')
              : t('chat.encryption.openpgpTooltip')
        }</div>
        {state.kind === 'encrypted' && !isOmemo && state.fingerprint && (
          <div className="font-mono text-xs mt-0.5 opacity-75">{formatFingerprint(state.fingerprint)}</div>
        )}
      </div>
    )
```

Second block (with-actions, lines ~410-420) becomes:
```tsx
        content={state.kind === 'encrypted' ? (
          <div>
            <div>{isOmemo
              ? omemoTooltipText
              : verified
                ? t('chat.encryption.verifiedTooltip')
                : tofuNew
                  ? t('chat.encryption.tofuNewTooltip', 'New contact — verify fingerprint for full trust')
                  : t('chat.encryption.openpgpTooltip')
            }</div>
            {!isOmemo && state.fingerprint && (
              <div className="font-mono text-xs mt-0.5 opacity-75">{formatFingerprint(state.fingerprint)}</div>
            )}
          </div>
        ) : null}
```
Also update the header ICON color: OMEMO trust should use `trustStateVisual`. For minimal change, leave the icon as the existing `verified ? ShieldCheck : Shield` (OMEMO `verified` sets `verified===true` because `state.trust === 'verified'`). No icon-logic change needed.

- [ ] **Step 4: Run — passes**

Run: `cd apps/fluux && npx vitest run src/components/ChatHeader.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ChatHeader.tsx apps/fluux/src/components/ChatHeader.test.tsx
git commit --no-gpg-sign -m "fix(e2ee): ChatHeader labels OMEMO (G-1) and hides empty fingerprint"
```

---

### Task 14: VerifyPeerDialog device-scoped reuse + ContactProfileView wiring

Let `VerifyPeerDialog` confirm against a caller-chosen target (not only the OpenPGP JID contract), and wire ContactProfileView so verifying an OMEMO device calls `setIdentityTrust(peer, deviceId, 'verified')` with the own fingerprint from `getOwnFingerprint()`.

**Files:**
- Modify: `apps/fluux/src/components/VerifyPeerDialog.tsx`
- Modify: `apps/fluux/src/components/ContactProfileView.tsx`
- Modify: `apps/fluux/src/components/VerifyPeerDialog.test.tsx`

**Interfaces:**
- Consumes: OMEMO plugin surface `{ listPeerIdentities, getOwnFingerprint, setIdentityTrust }` off `client.e2ee.getPlugin('omemo:2')`.
- Produces: `VerifyPeerDialog` confirm callback stays `onConfirm(fingerprint: string)` but the caller decides what to do (write store OR call `setIdentityTrust`). No signature change needed — the device-scoping happens in ContactProfileView, which passes the device fingerprint as `peerFingerprint` and an OMEMO-aware `onConfirm`.

- [ ] **Step 1: Confirm VerifyPeerDialog needs no signature change (it already reports `peerFingerprint`)**

`VerifyPeerDialog.onConfirm` already fires with `peerFingerprint`. Device-scoping is achieved by the CALLER passing the selected device's fingerprint as `peerFingerprint` and an `onConfirm` that targets that device. So VerifyPeerDialog itself is unchanged except: it currently hard-references "verifiedPeerKeysStore" only in a doc comment. Update the JSDoc (lines ~50-53) to remove the store-specific claim:
```tsx
 * Either path reports the compared `peerFingerprint` via `onConfirm`; the
 * caller decides how to persist it (OpenPGP verified-key store, or an OMEMO
 * per-device `setIdentityTrust`). A key rotation changes the fingerprint, so a
 * stored verification silently lapses until the user re-verifies.
```
No code change to the component body.

- [ ] **Step 2: Write failing ContactProfileView OMEMO-verify test**

Add to `apps/fluux/src/components/ContactProfileView.test.tsx` (reuse its existing render helper + mocks; read the file top first). The essential assertion:
```tsx
  it('verifying an OMEMO device calls setIdentityTrust(peer, deviceId, "verified")', async () => {
    const setIdentityTrust = vi.fn().mockResolvedValue(undefined)
    const omemoPlugin = {
      listPeerIdentities: vi.fn().mockResolvedValue([{ id: '111', fingerprint: 'aabb', trust: 'tofu' }]),
      getOwnFingerprint: vi.fn().mockResolvedValue('ccdd'),
      setIdentityTrust,
    }
    // Render ContactProfileView with an e2ee client whose getPlugin('omemo:2')
    // returns omemoPlugin and whose encryption state is omemo:2. Open Security,
    // click Verify on device 111, confirm via fingerprint path.
    // (Wire mocks per the file's existing harness.)
    // ... open security detail, trigger onVerifyDevice({id:'111',...}) ...
    // ... confirm dialog ...
    await waitFor(() => expect(setIdentityTrust).toHaveBeenCalledWith('bob@x', '111', 'verified'))
  })
```
Keep this test focused: if the file's harness makes full-render verification heavy, instead unit-test the new handler by extracting it (Step 3 exposes `handleVerifyOmemoDevice` behavior through the rendered dialog). The load-bearing assertion is `setIdentityTrust('bob@x', '111', 'verified')`.

- [ ] **Step 3: Wire ContactProfileView**

In `ContactProfileView.tsx`:

(a) Resolve the OMEMO plugin surface alongside the existing OpenPGP one (after line 72):
```tsx
  const omemoPlugin = client.e2ee?.getPlugin('omemo:2') as
    | {
        listPeerIdentities: (peer: string) => Promise<import('@fluux/sdk').PeerIdentity[]>
        getOwnFingerprint: () => Promise<string | null>
        setIdentityTrust: (peer: string, id: string, decision: 'verified' | 'untrusted') => Promise<void>
      }
    | null
    | undefined
  const isOmemoConversation = encryptionState.kind === 'encrypted' && encryptionState.protocolId === 'omemo:2'
```

(b) Add device-scoped verify state:
```tsx
  const [verifyDevice, setVerifyDevice] = useState<import('@fluux/sdk').PeerIdentity | null>(null)
  const [omemoOwnFp, setOmemoOwnFp] = useState<string | null>(null)
  const [omemoReloadKey, setOmemoReloadKey] = useState(0)
```

(c) Pass OMEMO wiring into `ContactSecurityDetail` (replace the existing `<ContactSecurityDetail … />` at line 263-270):
```tsx
          <ContactSecurityDetail
            state={encryptionState}
            peerJid={contact.jid}
            omemo={
              isOmemoConversation && omemoPlugin
                ? {
                    listPeerIdentities: omemoPlugin.listPeerIdentities,
                    onVerifyDevice: (identity) => {
                      void omemoPlugin.getOwnFingerprint().then((fp) => {
                        setOmemoOwnFp(fp)
                        setVerifyDevice(identity)
                      })
                    },
                    onRevokeDevice: async (identity) => {
                      await omemoPlugin.setIdentityTrust(contact.jid, identity.id, 'untrusted')
                      setOmemoReloadKey((n) => n + 1)
                    },
                    reloadKey: omemoReloadKey,
                  }
                : null
            }
            onVerify={() => setShowVerifyDialog(true)}
            onRequestRevoke={() => setPendingConfirm('revokeVerify')}
            onDisableEncryption={handleDisableEncryption}
            onEnableEncryption={handleEnableEncryption}
            onClose={() => setSecurityOpen(false)}
          />
```

(d) Render a device-scoped VerifyPeerDialog for OMEMO (add after the existing OpenPGP `{showVerifyDialog && …}` block, ~298):
```tsx
      {verifyDevice && omemoPlugin && ownJid && (
        <VerifyPeerDialog
          peerName={contact.name}
          peerJid={contact.jid}
          peerFingerprint={verifyDevice.fingerprint}
          ownJid={ownJid}
          ownFingerprint={omemoOwnFp}
          alreadyVerified={verifyDevice.trust === 'verified'}
          onConfirm={() => {
            void omemoPlugin.setIdentityTrust(contact.jid, verifyDevice.id, 'verified').then(() => {
              setVerifyDevice(null)
              setOmemoReloadKey((n) => n + 1)
            })
          }}
          onCancel={() => setVerifyDevice(null)}
        />
      )}
```
Ensure `useState` is imported (it is, line 1). The OMEMO dialog uses `verifyDevice.fingerprint` (a hex string), so the SAS + fingerprint paths work with the OMEMO device key.

- [ ] **Step 4: Run the affected tests + typecheck**

Run:
```bash
cd apps/fluux && npx vitest run src/components/ContactProfileView.test.tsx src/components/VerifyPeerDialog.test.tsx
cd ../.. && npm run typecheck
```
Expected: PASS. (If ContactProfileView.test.tsx's harness lacks `getPlugin('omemo:2')`, extend its mock client to return `null` for omemo:2 by default so existing OpenPGP tests are unaffected, and return `omemoPlugin` only in the new OMEMO test.)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/VerifyPeerDialog.tsx apps/fluux/src/components/ContactProfileView.tsx apps/fluux/src/components/ContactProfileView.test.tsx
git commit --no-gpg-sign -m "feat(e2ee): device-scoped OMEMO verification via VerifyPeerDialog"
```

---

### Task 15: "Verify a device to send" state end-to-end

Add the `needsDeviceVerification` conversation state (surfaced when an OMEMO peer has devices but ALL are untrusted, i.e. zero encryptable), thread it through the hook, and render it near the composer lock and in the SecurityGlanceCard. Add i18n across 33 locales.

**Files:**
- Modify: `apps/fluux/src/hooks/useConversationEncryptionState.ts`
- Modify: `apps/fluux/src/hooks/useConversationEncryptionState.omemo.test.tsx`
- Modify: `apps/fluux/src/components/MessageComposer.tsx`
- Modify: `apps/fluux/src/components/contact-profile/cards/SecurityGlanceCard.tsx`
- Modify: all 33 locales

**Interfaces:**
- Consumes: `listPeerIdentities` off the selected OMEMO plugin (feature-detected).
- Produces: `ConversationEncryptionState` gains `| { kind: 'needsDeviceVerification'; peerJid: string }`.

- [ ] **Step 1: Add i18n keys to all 33 locales**

English source:

| key | en value |
|---|---|
| `contacts.encryption.needsVerification.title` | `Verify a device to send` |
| `contacts.encryption.needsVerification.description` | `Every device for this contact is untrusted. Verify at least one device to send encrypted messages.` |
| `contacts.encryption.needsVerification.glance` | `Verify a device to send` |
| `chat.encryption.needsVerificationTooltip` | `Verify a device to send encrypted messages` |

Apply:
```bash
cd apps/fluux/src/i18n/locales
python3 - <<'PY'
import json, glob
NV = {
    "title": "Verify a device to send",
    "description": "Every device for this contact is untrusted. Verify at least one device to send encrypted messages.",
    "glance": "Verify a device to send",
}
for path in sorted(glob.glob("*.json")):
    d = json.load(open(path, encoding="utf-8"))
    d.setdefault("contacts", {}).setdefault("encryption", {})["needsVerification"] = dict(NV)
    d.setdefault("chat", {}).setdefault("encryption", {})["needsVerificationTooltip"] = "Verify a device to send encrypted messages"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=4); f.write("\n")
print("seeded needsVerification into all locales")
PY
```
Then translate non-`en` values per the i18n workflow.

- [ ] **Step 2: Write the failing hook test**

Append to `apps/fluux/src/hooks/useConversationEncryptionState.omemo.test.tsx`:
```tsx
  it("reports 'needsDeviceVerification' when OMEMO peer has devices but all are untrusted", async () => {
    const plugin = makeOmemoPlugin('untrusted')
    ;(plugin as unknown as { listPeerIdentities: ReturnType<typeof vi.fn> }).listPeerIdentities = vi
      .fn()
      .mockResolvedValue([
        { id: '1', fingerprint: 'aa', trust: 'untrusted' },
        { id: '2', fingerprint: 'bb', trust: 'untrusted' },
      ])
    wireMocks({ omemoPlugin: plugin })
    const { result } = renderHook(() => useConversationEncryptionState('bob@example.com', 'chat'))
    await waitFor(() => expect(result.current.kind).toBe('needsDeviceVerification'))
    expect(result.current).toEqual({ kind: 'needsDeviceVerification', peerJid: 'bob@example.com' })
  })

  it('stays encrypted when at least one device is trusted', async () => {
    const plugin = makeOmemoPlugin('tofu')
    ;(plugin as unknown as { listPeerIdentities: ReturnType<typeof vi.fn> }).listPeerIdentities = vi
      .fn()
      .mockResolvedValue([
        { id: '1', fingerprint: 'aa', trust: 'untrusted' },
        { id: '2', fingerprint: 'bb', trust: 'tofu' },
      ])
    wireMocks({ omemoPlugin: plugin })
    const { result } = renderHook(() => useConversationEncryptionState('bob@example.com', 'chat'))
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
  })
```

- [ ] **Step 3: Run — fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useConversationEncryptionState.omemo.test.tsx`
Expected: FAIL — hook never returns `needsDeviceVerification`.

- [ ] **Step 4: Implement in the hook**

In `useConversationEncryptionState.ts`:

(a) Add the variant to the union (after the `encrypted` variant):
```ts
  | { kind: 'needsDeviceVerification'; peerJid: string }
```

(b) Extend `SelectedPluginShape` (lines ~110-113) to optionally expose `listPeerIdentities`:
```ts
interface SelectedPluginShape {
  descriptor: { id: string }
  getPeerTrust: (peer: string) => Promise<TrustState>
  listPeerIdentities?: (peer: string) => Promise<Array<{ id: string; fingerprint: string; trust: TrustState }>>
}
```

(c) In the OMEMO effect success branch, after computing `t` and BEFORE setting the encrypted result (replace the `if (id === 'omemo:2' && selected) { … }` inner body from Task 3 Step 4c):
```ts
        if (id === 'omemo:2' && selected) {
          const t = await selected.getPeerTrust(peerJid)
          if (cancelled) return
          // Zero-encryptable detection: if the peer HAS devices but every one
          // is untrusted, encryption cannot proceed — surface the actionable
          // "verify a device to send" state instead of a silent failure.
          if (selected.listPeerIdentities) {
            try {
              const identities = await selected.listPeerIdentities(peerJid)
              if (cancelled) return
              if (identities.length > 0 && identities.every((d) => d.trust === 'untrusted')) {
                setOmemoResult({ kind: 'needsDeviceVerification', peerJid })
                return
              }
            } catch {
              /* identity fetch failed — fall through to the encrypted state */
            }
          }
          setOmemoResult({
            kind: 'encrypted',
            protocolId: 'omemo:2',
            fingerprint: '',
            trust: t,
          })
        } else {
          setOmemoResult(null)
        }
```

- [ ] **Step 5: Run — passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useConversationEncryptionState.omemo.test.tsx`
Expected: PASS.

- [ ] **Step 6: Render the state in MessageComposer + SecurityGlanceCard**

(a) In `MessageComposer.tsx` `lockInfo` derivation (lines ~721-729), add a `needsDeviceVerification` branch that surfaces a danger lock:
```tsx
  const enc = encryptionState
  const lockInfo: { Icon: typeof Shield; colorClass: string; label: string } | null =
    enc?.kind === 'encrypted'
      ? enc.trust === 'verified'
        ? { Icon: ShieldCheck, colorClass: trustVisual('verified').colorClass, label: t('chat.encryption.verifiedTooltip') }
        : { Icon: Shield, colorClass: trustVisual('trusted').colorClass, label: t('chat.encryption.openpgpTooltip') }
      : enc?.kind === 'needsDeviceVerification'
        ? { Icon: ShieldAlert, colorClass: 'text-fluux-error', label: t('chat.encryption.needsVerificationTooltip') }
        : enc?.kind === 'blocked'
          ? { Icon: ShieldAlert, colorClass: trustVisual('keyChanged').colorClass, label: t('chat.encryption.blockedTooltip') }
          : null
```

(b) In `SecurityGlanceCard.tsx` `getGlance`, add a case before `default`:
```tsx
    case 'needsDeviceVerification':
      return { icon: ShieldAlert, label: t('contacts.encryption.needsVerification.glance'), tone: 'warning' }
```
`ShieldAlert` is already imported in SecurityGlanceCard.

(c) In `SecurityTab.tsx`, add a top-level branch (alongside the other `state.kind` blocks) so the security detail explains it:
```tsx
        {state.kind === 'needsDeviceVerification' && (
          <ExplanationPanel
            icon={<ShieldAlert className={`size-5 ${trustStateVisual('untrusted').colorClass} flex-shrink-0`} />}
            title={t('contacts.encryption.needsVerification.title')}
            description={t('contacts.encryption.needsVerification.description')}
            tone="danger"
          />
        )}
```
Ensure `ShieldAlert` is imported in SecurityTab (it is, line 2).

Note: `ContactProfileGrid.hasSecurity` gates on `encryptionState.kind !== 'disabled'`, so `needsDeviceVerification` correctly renders the SecurityGlanceCard. No ContactProfileGrid change needed.

- [ ] **Step 7: Typecheck + run the affected suites**

Run:
```bash
npm run typecheck
cd apps/fluux && npx vitest run src/hooks/useConversationEncryptionState.omemo.test.tsx src/components/MessageComposer.test.tsx src/components/contact-profile/cards/SecurityGlanceCard.test.tsx src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx
```
Expected: PASS. Fix any exhaustiveness/type error introduced by the new union member (e.g. a `switch` that must handle the new kind).

- [ ] **Step 8: 33-locale parity check**

Run:
```bash
cd apps/fluux/src/i18n/locales
python3 - <<'PY'
import json, glob
bad=[]
for p in sorted(glob.glob("*.json")):
    d=json.load(open(p,encoding="utf-8"))
    nv=d.get("contacts",{}).get("encryption",{}).get("needsVerification",{})
    ok = all(k in nv for k in ("title","description","glance")) and "needsVerificationTooltip" in d.get("chat",{}).get("encryption",{})
    if not ok: bad.append(p)
print("OK" if not bad else bad)
PY
```
Expected: `OK`.

- [ ] **Step 9: Full verification + commit**

Run:
```bash
npm run typecheck
npm run build -w @fluux/omemo && npm run build -w @fluux/omemo-plugin && npm run build -w @fluux/sdk
cd packages/omemo-plugin && npx vitest run
cd ../fluux-sdk && npx vitest run
cd ../.. && cd apps/fluux && npx vitest run src/hooks src/e2ee src/components/contact-profile src/components/ChatHeader.test.tsx src/components/MessageComposer.test.tsx
```
Expected: all PASS, no stderr.

```bash
git add apps/fluux/src packages/omemo-plugin apps/fluux/src/i18n/locales
git commit --no-gpg-sign -m "feat(e2ee): verify-a-device-to-send state for all-untrusted OMEMO peers"
```

---

## Self-Review (completed by the plan author)

**1. Spec coverage.**
- Component 0 (unified trust vocabulary) → Tasks 1-4b (regression pin, shared mapping, hook migration, consumer migration). ✅
- Component 1 (verified-trust store, fingerprint-bound) → Task 6. ✅
- Component 2 (`listPeerIdentities`/`setIdentityTrust`, optional SDK trait, `PeerIdentity` exported) → Tasks 5, 8, 9. ✅
- Component 3 (BTBV resolution: `peerHasVerifiedDevice`, verified-aware `getDeviceTrust`/`getPeerTrust`, encrypt exclusion, all-untrusted loud fail) → Tasks 10, 11. ✅
- Component 4 (SecurityTab per-identity list, VerifyPeerDialog reuse, G-1 ChatHeader/SecurityTab labels, "verify a device to send") → Tasks 12, 13, 14, 15. ✅
- `getOwnFingerprint` read-only accessor → Task 7. ✅
- Error/edge cases: no-key device (Task 8 test + Task 12 disabled verify), fingerprint change invalidation (Task 9 test), all-untrusted send-block (Task 11 + Task 15), list network failure (Task 12 error+retry). ✅
- i18n across 33 locales with parity checks → Tasks 2, 12, 15. ✅

**2. Placeholder scan.** No "TBD/similar to Task N/add error handling" left; every code step carries complete code. The i18n steps carry exact English source + the mechanical script + an explicit per-locale translation instruction (the repo's established workflow), which is a real instruction, not a placeholder.

**3. Type consistency.** `PeerIdentity { id; fingerprint; trust }` is defined once (Task 5) and consumed identically in Tasks 8, 9, 12, 14. `TrustState` is the single trust union throughout. `trustStateVisual`/`trustLabel` names are stable across Tasks 2, 12, 13, 15. Plugin helpers (`loadVerified`/`isVerified`/`setVerified`/`clearVerified`/`hasAnyVerified`) named identically in Tasks 6, 9, 10. Hook `encrypted` shape `{ kind; protocolId?; fingerprint; trust; firstSeen? }` consistent across Tasks 3, 12, 13, 15; `needsDeviceVerification { kind; peerJid }` consistent across Tasks 15 consumers.

**Known implementer caveats (verify while executing, not gaps):**
- Task 11 assumes `OmemoMessage` exposes recipient ids as `keys[].rid` — the step includes a grep to confirm/adjust.
- Tasks 13/14 reuse existing `ChatHeader.test.tsx` / `ContactProfileView.test.tsx` harnesses — the steps instruct reading the file's harness first and mirroring it, since those files' exact render helpers were not reproduced here.
