# Decrypt Failure Reasons: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single fixed "Message encrypted to a key not available on this device" placeholder — shown today for *every* decrypt-path rejection — with a typed reason that says what actually happened, and put the precise error code in the diagnostic log.

**Architecture:** A new `DecryptFailureReason` union on `SecurityContext` and `MessageSecurityContext`, bucketed from the `E2EEPluginError.code` that `stanzaDecrypt` already catches. `EncryptedPlaceholder` selects its copy from that reason instead of a constant. No crypto, no gate logic, no key handling.

**Tech Stack:** TypeScript, React, Vitest, i18next.

**Spec:** `docs/superpowers/specs/2026-07-24-ox-signature-gate-design.md` (section 4 only — see Out of scope).

## Out of scope — owned by PR #1115

The spec this plan derives from also covers splitting an *unverifiable* signature
from a *forged* one, and widening signature verification to every announced peer
cert. **Both already ship in PR #1115** (branch `mr/github-issue-1059-b3781e`),
by an equivalent mechanism: a `signatureStatus: 'none' | 'verified' | 'bad' |
'missing-key'` field on `DecryptOutput` in both backends, where `missing-key`
is the unjudgeable case and `bad` is the forgery case. That PR already delivers
unjudgeable messages as untrusted with a deferred re-verification stash, already
keeps the permanent `signature-failed` reject for a known issuer, and already
passes `senderPublics: string[]`.

Re-implementing any of that here would mean two competing implementations of the
same security decision in the most sensitive code in the repo, in the files that
PR rewrote most heavily.

**Do not modify these files. If a step appears to require it, stop and report why
rather than editing:**

```
apps/fluux/src-tauri/src/openpgp.rs
apps/fluux/src/e2ee/OpenPGPPluginBase.ts
apps/fluux/src/e2ee/WebOpenPGPPlugin.ts               (+ .test.ts)
apps/fluux/src/e2ee/SequoiaPgpPlugin.ts               (+ .test.ts)
apps/fluux/src/e2ee/gajimOxInterop.test.ts
apps/fluux/src/hooks/useConversationEncryptionState.ts (+ .test.tsx)
apps/fluux/src/components/ChatView.tsx
apps/fluux/src/stores/certRejectionStore.ts
```

This work is genuinely independent of that PR: every code it buckets
(`signature-failed`, `signature-missing`, `malformed-data`, `no-session-key`,
`key-locked`, `peer-key-missing`) already exists on `main` today. Nothing here
reads `signerKeyKnown` or `signatureStatus`.

## Global Constraints

- Touch none of the files listed above.
- i18n changes cover **all 33 locales** in `apps/fluux/src/i18n/locales/`. Edit surgically: `JSON.parse` → mutate → `JSON.stringify(obj, null, 4) + "\n"`. Write natural copy per language rather than transliterating the English, and use no em-dash connectors.
- Run app tests from inside the workspace (`cd apps/fluux && npx vitest run …`). Running vitest from the repo root skips `test-setup.ts` and produces spurious failures.
- Run `npm run build:sdk` from the repo root before any app typecheck — the app compiles against `packages/fluux-sdk/dist`.
- Commits are SSH-signed. No "Claude" footer and no co-author line.

---

### Task 1: Typed failure reason on the security context

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/types.ts` (above `SecurityContext` at line 119; new optional field on it)
- Modify: `packages/fluux-sdk/src/core/types/message-base.ts:215-230` (`MessageSecurityContext`)
- Modify: `packages/fluux-sdk/src/index.ts` (export the type)
- Modify: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` (locals at ~197-207, catch at ~254-264, diagnostic log at ~274, failure context at ~328)
- Test: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type DecryptFailureReason = 'key-unavailable' | 'signature-invalid' | 'unreadable'`, exported from `@fluux/sdk`; `export function decryptFailureReasonFor(code: string | undefined): DecryptFailureReason` from `stanzaDecrypt.ts`; optional `failureReason` on `SecurityContext` and `MessageSecurityContext`.

- [ ] **Step 1: Write the failing test**

Append to `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts`, adding `decryptFailureReasonFor` to the existing import from `./stanzaDecrypt`:

```ts
describe('decryptFailureReasonFor', () => {
  it.each([
    ['signature-failed', 'signature-invalid'],
    ['signature-missing', 'signature-invalid'],
    ['no-session-key', 'key-unavailable'],
    ['key-locked', 'key-unavailable'],
    ['peer-key-missing', 'key-unavailable'],
    ['malformed-data', 'unreadable'],
    ['envelope-reflection', 'unreadable'],
    ['envelope-stale', 'unreadable'],
  ])('buckets %s as %s', (code, expected) => {
    expect(decryptFailureReasonFor(code)).toBe(expected)
  })

  it('buckets an unrecognised code as unreadable rather than guessing at a key problem', () => {
    expect(decryptFailureReasonFor('something-new')).toBe('unreadable')
    expect(decryptFailureReasonFor(undefined)).toBe('unreadable')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts -t decryptFailureReasonFor 2>&1 | tail -15
```

Expected: FAIL — `decryptFailureReasonFor is not a function`.

- [ ] **Step 3: Add the type**

In `packages/fluux-sdk/src/core/e2ee/types.ts`, immediately above `export interface SecurityContext`:

```ts
/**
 * Why a message could not be shown, bucketed for display.
 *
 * Deliberately coarse: the user needs to know whether this is about a key they
 * do not have, a message that failed authentication, or a message that could
 * not be parsed. The precise `E2EEPluginError.code` always goes to the
 * diagnostic log instead.
 *
 * See #1059, where a single fixed "encrypted to a key not available on this
 * device" string was rendered for every rejection and sent triage down the
 * wrong path for three rounds by asserting a cause it had not established.
 */
export type DecryptFailureReason =
  /** No session key for us. The only case that is really about a missing key. */
  | 'key-unavailable'
  /** Decrypted, but the signature was absent or did not hold up. */
  | 'signature-invalid'
  /** Malformed, reflected, stale envelope, or a session needing repair. */
  | 'unreadable'
```

Add to `SecurityContext`, after `notes`:

```ts
  /**
   * Set only when the message could not be shown. Lets the host render a
   * reason that is true rather than one fixed string. See
   * {@link DecryptFailureReason}.
   */
  failureReason?: DecryptFailureReason
```

- [ ] **Step 4: Mirror the field onto the message type**

In `packages/fluux-sdk/src/core/types/message-base.ts`, add to `MessageSecurityContext` after `notes`, importing the type from `../e2ee/types`:

```ts
  /**
   * Set only when the message could not be shown. Lets the host render a
   * reason that is true rather than one fixed string. See
   * {@link DecryptFailureReason}.
   */
  failureReason?: DecryptFailureReason
```

- [ ] **Step 5: Export from the SDK barrel**

In `packages/fluux-sdk/src/index.ts`, add `DecryptFailureReason` to the same type-export block that already lists `SecurityContext` (line ~415).

- [ ] **Step 6: Implement the bucketing**

In `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts`, add near the other exported helpers:

```ts
/**
 * Bucket an `E2EEPluginError.code` for display.
 *
 * Unknown codes read as 'unreadable' rather than 'key-unavailable': claiming a
 * cause we have not established is exactly the bug this replaces, so the
 * fallback must be the one that asserts least.
 */
export function decryptFailureReasonFor(code: string | undefined): DecryptFailureReason {
  switch (code) {
    case 'signature-failed':
    case 'signature-missing':
      return 'signature-invalid'
    case 'no-session-key':
    case 'key-locked':
    case 'peer-key-missing':
      return 'key-unavailable'
    default:
      return 'unreadable'
  }
}
```

- [ ] **Step 7: Set it on BOTH failure-path security contexts**

There are two, and only wiring the second would leave `signature-invalid`
unreachable. Note the file already has a local `failureReason` holding the error
*message* — the new local is `failureCode`, so there is no collision.

Declare it beside the other locals (~line 199):

```ts
  let failureCode: string | undefined
```

In the `catch` block, capture it beside the existing assignment:

```ts
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err)
    failureCode = isE2EEPluginError(err) ? err.code : undefined
```

Branch 1 — signature rejection (~line 256). This is the only producer of
`signature-invalid`:

```ts
      securityContext = {
        protocolId: claim.plugin.descriptor.id,
        trust: 'rejected',
        failureReason: decryptFailureReasonFor(failureCode),
        notes: [failureReason],
      }
```

Branch 2 — decrypt failure (~line 328), leaving `notes` exactly as it is:

```ts
      securityContext = {
        protocolId: claim.plugin.descriptor.id,
        trust: 'untrusted',
        failureReason: decryptFailureReasonFor(failureCode),
        notes: [ /* unchanged */ ],
      }
```

- [ ] **Step 8: Put the raw code in the diagnostic log**

The `getDiagnosticLogger().warn(…)` call at ~line 274 already logs the error
*message* on every failure, but not the code — and the code is what triage greps
for. Change the tail of that template literal from `}): ${failureReason}` to:

```ts
        }): [${failureCode ?? 'no-code'}] ${failureReason}`,
```

- [ ] **Step 9: Run tests to verify they pass**

```bash
cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts 2>&1 | tail -8
```

Expected: PASS.

- [ ] **Step 10: Break it on purpose**

Temporarily change the `default:` arm to `return 'key-unavailable'`. Re-run Step 9
and confirm the unrecognised-code test FAILS. Revert.

- [ ] **Step 11: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "feat(sdk): carry a typed decrypt failure reason on the security context"
```

---

### Task 2: The placeholder says what actually happened

**Files:**
- Modify: `apps/fluux/src/components/conversation/EncryptedPlaceholder.tsx`
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx:725`
- Modify: `apps/fluux/src/i18n/locales/en.json` (under `chat.encryption`, ~line 528-531)
- Test: create `apps/fluux/src/components/conversation/EncryptedPlaceholder.test.tsx`

**Interfaces:**
- Consumes: `MessageSecurityContext.failureReason` from Task 1.
- Produces: `EncryptedPlaceholder` accepts `reason?: DecryptFailureReason`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/EncryptedPlaceholder.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EncryptedPlaceholder } from './EncryptedPlaceholder'

// The defect being fixed is that ONE fixed string was shown for every failure.
// A positive assertion alone would still pass against that old string, so each
// case also asserts the absence of the copy that does not belong to it. Without
// those negative controls these tests cannot fail.
describe('EncryptedPlaceholder', () => {
  it('names a missing key only when the key really is missing', () => {
    render(<EncryptedPlaceholder reason="key-unavailable" />)
    expect(screen.getByText(/doesn't have/i)).toBeInTheDocument()
  })

  it('blames the signature, not a missing key, for a rejected signature', () => {
    render(<EncryptedPlaceholder reason="signature-invalid" />)
    expect(screen.getByText(/signature/i)).toBeInTheDocument()
    expect(screen.queryByText(/doesn't have/i)).not.toBeInTheDocument()
  })

  it('stays neutral for an unreadable payload', () => {
    render(<EncryptedPlaceholder reason="unreadable" />)
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    expect(screen.queryByText(/doesn't have/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/signature/i)).not.toBeInTheDocument()
  })

  it('falls back to the neutral copy when no reason was recorded', () => {
    // Messages stored before this change carry no reason. They must not
    // inherit a claim about keys.
    render(<EncryptedPlaceholder />)
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    expect(screen.queryByText(/doesn't have/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/components/conversation/EncryptedPlaceholder.test.tsx 2>&1 | tail -20
```

Expected: FAIL — the component renders one fixed string, so the negative controls fail.

- [ ] **Step 3: Add the English strings**

In `apps/fluux/src/i18n/locales/en.json` under `chat.encryption`, remove
`couldNotDecryptTooltip` and add:

```json
"couldNotDecryptKeyUnavailable": "Encrypted to a key this device doesn't have",
"couldNotDecryptSignature": "This message wasn't shown because its signature could not be trusted",
"couldNotDecryptUnreadable": "This message could not be read"
```

- [ ] **Step 4: Render per reason**

In `EncryptedPlaceholder.tsx`: add `import type { DecryptFailureReason } from '@fluux/sdk'`,
replace the props interface, rename the component parameter from `_props` to
`props`, and replace the final `return` block.

```tsx
export interface EncryptedPlaceholderProps {
  /**
   * Why the message could not be shown. Absent for messages stored before the
   * reason was recorded — those fall back to the neutral string rather than
   * asserting a cause we do not know.
   */
  reason?: DecryptFailureReason
}
```

```tsx
  const reasonKey =
    props.reason === 'key-unavailable'
      ? 'chat.encryption.couldNotDecryptKeyUnavailable'
      : props.reason === 'signature-invalid'
        ? 'chat.encryption.couldNotDecryptSignature'
        : 'chat.encryption.couldNotDecryptUnreadable'

  return (
    <Tooltip
      content={t(reasonKey)}
      position="top"
      className="flex items-center gap-2 text-fluux-muted italic"
    >
      <LockOpen className="size-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{t(reasonKey)}</span>
    </Tooltip>
  )
```

The reason is rendered in the visible `<span>` as well as the tooltip because the
`Tooltip` mock in `test-setup.ts` drops `content` — assertions against the
tooltip prop alone would be unfalsifiable.

- [ ] **Step 5: Pass the reason from the bubble**

`apps/fluux/src/components/conversation/MessageBubble.tsx:725`:

```tsx
            <EncryptedPlaceholder reason={message.securityContext?.failureReason} />
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && npm run build:sdk >/dev/null 2>&1
cd apps/fluux && npx vitest run src/components/conversation/EncryptedPlaceholder.test.tsx 2>&1 | tail -10
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Break it on purpose**

Temporarily hard-code `reasonKey` to the key-unavailable string. Re-run Step 6
and confirm three of the four tests FAIL. Revert.

- [ ] **Step 8: Check for orphaned references**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && grep -rn "couldNotDecryptTooltip\|encryptedCouldNotDecrypt" apps/fluux/src --include=*.ts --include=*.tsx
```

Any hit outside the locale files must be resolved before committing. Locale files
are handled in Task 3.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/components apps/fluux/src/i18n/locales/en.json
git commit -m "fix(e2ee): tell the user why a message could not be shown (#1059)"
```

---

### Task 3: Translate into the remaining 32 locales

**Files:**
- Modify: `apps/fluux/src/i18n/locales/*.json` (every file except `en.json`)

**Interfaces:**
- Consumes: the three keys added to `en.json` in Task 2.
- Produces: nothing.

- [ ] **Step 1: Confirm the target set**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && ls apps/fluux/src/i18n/locales/*.json | wc -l
```

Expected: `33`.

- [ ] **Step 2: Translate each locale**

For every locale except `en.json`: remove `chat.encryption.couldNotDecryptTooltip`
and add the three new keys with natural copy for that language. Do not
transliterate the English, and use no em-dash connectors. Edit surgically so
unrelated formatting survives — shape of the edit, per file:

```python
import json, pathlib
p = pathlib.Path("apps/fluux/src/i18n/locales/fr.json")
d = json.loads(p.read_text())
enc = d["chat"]["encryption"]
enc.pop("couldNotDecryptTooltip", None)
enc["couldNotDecryptKeyUnavailable"] = "Chiffré avec une clé que cet appareil ne possède pas"
enc["couldNotDecryptSignature"] = "Ce message n'a pas été affiché car sa signature n'a pas pu être validée"
enc["couldNotDecryptUnreadable"] = "Ce message n'a pas pu être lu"
p.write_text(json.dumps(d, ensure_ascii=False, indent=4) + "\n")
```

- [ ] **Step 3: Verify every locale**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && python3 - <<'EOF'
import json, pathlib
bad = []
for p in sorted(pathlib.Path("apps/fluux/src/i18n/locales").glob("*.json")):
    enc = json.loads(p.read_text()).get("chat", {}).get("encryption", {})
    missing = [k for k in (
        "couldNotDecryptKeyUnavailable",
        "couldNotDecryptSignature",
        "couldNotDecryptUnreadable",
    ) if k not in enc]
    stale = "couldNotDecryptTooltip" in enc
    if missing or stale:
        bad.append((p.name, missing, stale))
print("OK" if not bad else bad)
EOF
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n: translate the decrypt-failure reasons into all locales"
```

---

### Task 4: Full verification

**Files:** none, unless a failure surfaces.

- [ ] **Step 1: Build, typecheck, lint**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && npm run build:sdk 2>&1 | tail -3 && npm run typecheck 2>&1 | tail -5 && npx eslint apps/fluux/src packages/fluux-sdk/src 2>&1 | tail -10
```

Expected: build succeeds, typecheck silent, eslint clean.

- [ ] **Step 2: Both test suites, watching stderr**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96/packages/fluux-sdk && npx vitest run 2>&1 | tail -8
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96/apps/fluux && npx vitest run 2>&1 | tail -8
```

Expected: all green, no stderr output. Per CLAUDE.md a suite that passes while
printing stderr is not a pass.

- [ ] **Step 3: Confirm no forbidden file was touched**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && git diff --name-only main...HEAD | grep -E "src-tauri/src/openpgp\.rs|e2ee/OpenPGPPluginBase|e2ee/WebOpenPGPPlugin|e2ee/SequoiaPgpPlugin|e2ee/gajimOxInterop|useConversationEncryptionState|components/ChatView\.tsx|stores/certRejectionStore" && echo "VIOLATION" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "test: fix fallout from the failure-reason plumbing"
```

---

## Notes for the implementer

**The fallback must be the least-assertive bucket.** An unknown code maps to
`unreadable`, never `key-unavailable`. The whole point of this change is that the
UI stopped asserting a cause it had not established; a permissive default would
reintroduce the bug for every future error code.

**Hollow tests are this repo's recurring defect.** Every placeholder test here
carries a negative control, because the positive assertion alone still passes
against the old fixed string. Steps 10 (Task 1) and 7 (Task 2) exist to prove the
tests can fail — do not skip them.

**Both failure branches.** `stanzaDecrypt` builds a security context in two
places on the failure path. Wiring only the `trust: 'untrusted'` one leaves
`signature-invalid` permanently unreachable and one of the three new strings dead.
