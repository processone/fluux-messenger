# E2EE — No Silent Plaintext Downgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the SDK from silently sending a chat message in cleartext when OpenPGP encryption was expected for the peer but failed (pin-mismatch, key-locked, own-key-conflict) or became unavailable for a peer we already hold a key for.

**Architecture:** Two SDK changes plus an app-UX change. (1) In `Chat.applyE2EEToOutboundChat`, a *selected-plugin* encryption failure must re-throw instead of falling back to `assertPlaintextPermitted` → plaintext — encryption was expected, so a failure is never a policy question. (2) `E2EEManager.assertPlaintextPermitted` blocks plaintext for any peer with *established* trust (`verified` / `introduced` / `tofu`), not only `verified` — closing the in-session downgrade window where a known-encrypted peer's capability probe transiently fails. (3) The composer maps the now-propagating `E2EEPluginError` / `E2EEEncryptionRequiredError` to a specific toast; the user's typed text is preserved (the composer only clears on success). New toast strings are translated into all 33 locales.

**Tech Stack:** TypeScript, Vitest, React, i18next (33 locale JSON files), `@fluux/sdk` monorepo package.

**Out of scope (documented follow-up, do NOT build here):**
- *Cross-session* anti-downgrade when a peer's published key is **stripped from the server before we probe in a fresh session**. In that case the in-memory key cache is cold and `getPeerTrust` returns `'unknown'`, so the sticky rule in Task 2 does not fire. Closing it properly requires surfacing the *persistent* TOFU pin (`getPinnedPrimaryFp`) as a trust signal, which changes `getPeerTrust` semantics app-wide (lock-icon UI ripple) and deserves its own brainstorm.
- A user-facing global **`strict`** policy toggle. The vulnerability is fully closed by Tasks 1–2; a global-strict setting is a separate preference/feature.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/fluux-sdk/src/core/modules/Chat.ts` | Outbound chat assembly + E2EE rewrite | Modify the `catch` in `applyE2EEToOutboundChat` (currently lines 579-588) to re-throw plugin failures. |
| `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts` | Chat E2EE behaviour | Add tests: selected-plugin `encrypt()` failure blocks the wire send (send, resend, correction paths). |
| `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts` | Plugin host + send policy | Add `hasEstablishedTrust(peer)`; use it in `assertPlaintextPermitted` in place of `isPeerVerified`. |
| `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts` | Manager policy behaviour | Add tests: `tofu`/`introduced` peer blocks plaintext in opportunistic mode; `unknown`/`untrusted` does not. |
| `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` | OpenPGP encrypt/decrypt | Convert the "no cached public key" plain `Error` (line 1419-1421) to a typed `E2EEPluginError` so the UI can message it. |
| `apps/fluux/src/e2ee/encryptionSendError.ts` | **New.** Pure mapping: send error → i18n key | Create. |
| `apps/fluux/src/e2ee/encryptionSendError.test.ts` | **New.** Unit tests for the mapping | Create. |
| `apps/fluux/src/components/MessageComposer.tsx` | Composer submit + error toast | Replace the single-branch `catch` (lines 412-417) with the mapping helper. |
| `apps/fluux/src/i18n/locales/*.json` (33 files) | UI strings | Add 5 keys under `chat.encryption`. |
| `apps/fluux/src/test-setup.ts` | App test mock of `@fluux/sdk` | Ensure the mock re-exports `E2EEEncryptionRequiredError` and `isE2EEPluginError`. |

---

## Task 1: SDK — block plaintext when a selected plugin's encryption fails

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts:579-588`
- Test: `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`

Context: `applyE2EEToOutboundChat` (Chat.ts:461) calls `manager.encryptOutbound(...)` (Chat.ts:504). `encryptOutbound` (E2EEManager.ts:437) returns `null` only when no plugin was selected; once a plugin is selected it calls `plugin.encrypt()`, whose throw propagates. The current `catch` (Chat.ts:579) routes that throw through `assertPlaintextPermitted`, which in `opportunistic` mode for an unverified peer returns without throwing → the message goes out in cleartext (Chat.ts:588 / call sites at 780, 887, 1153). The same helper is the single funnel for send (765), resend (876), and correction (1142).

- [ ] **Step 1: Write the failing test (send path)**

Add inside the `describe('outbound encryption', ...)` block in `Chat.e2ee.test.ts` (after the test ending at line 274). The `beforeEach` already builds `chat` + `manager` (via `makeManagerWithDummyPlugin`, so a plugin IS selected) and `captured` collects wire stanzas. Import `E2EEPluginError` from the SDK at the top of the file if not already imported.

```typescript
it('blocks the send (no plaintext) when a selected plugin throws pin-mismatch', async () => {
  // A plugin is registered (dummy), so encryptOutbound reaches encrypt().
  // Simulate the OpenPGP pin-mismatch failure: encryption was expected for
  // this peer, so the message must NOT fall back to cleartext.
  vi.spyOn(manager, 'encryptOutbound').mockRejectedValue(
    new E2EEPluginError('permanent', 'pin-mismatch', 'fingerprint changed'),
  )

  await expect(chat.sendMessage('bob@example.com', 'secret')).rejects.toBeInstanceOf(
    E2EEPluginError,
  )
  expect(captured).toHaveLength(0)
})

it('blocks the send when a selected plugin throws key-locked (transient)', async () => {
  vi.spyOn(manager, 'encryptOutbound').mockRejectedValue(
    new E2EEPluginError('transient', 'key-locked', 'key is locked'),
  )

  await expect(chat.sendMessage('bob@example.com', 'secret')).rejects.toBeInstanceOf(
    E2EEPluginError,
  )
  expect(captured).toHaveLength(0)
})
```

If `E2EEPluginError` is not yet imported in this file, add it to the existing `@fluux/sdk` core import line (the file already imports `E2EEEncryptionRequiredError`; check the top-of-file import and extend it, e.g. `import { E2EEEncryptionRequiredError, E2EEPluginError } from '../e2ee'`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "selected plugin"`
Expected: FAIL — the message is currently sent as plaintext, so `captured` has length 1 and `sendMessage` resolves instead of rejecting.

- [ ] **Step 3: Implement the re-throw in the catch**

In `Chat.ts`, replace the current catch + trailing return (lines 579-588):

```typescript
    } catch (err) {
      if (err instanceof E2EEEncryptionRequiredError) throw err
      // Plugin was selected but encrypt() threw mid-flight — same policy
      // check: block unless the user explicitly overrode to plaintext.
      await manager.assertPlaintextPermitted({ kind: 'direct', peer: recipient })
      logWarn(
        `E2EE encrypt failed for ${recipient}, sending plaintext: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return undefined
  }
```

with:

```typescript
    } catch (err) {
      if (err instanceof E2EEEncryptionRequiredError) throw err
      // A plugin was selected (encryptOutbound only reaches encrypt() after
      // selectStrategy picked one) and encryption failed mid-flight. This is
      // NOT a policy question: encryption was expected for this peer, so we
      // must never silently downgrade to plaintext — pin-mismatch, key-locked
      // and own-key-conflict all surface here, and leaking the body at the
      // exact moment tampering is suspected is the worst outcome. Re-throw so
      // the UI can prompt to unlock / verify / resolve. A forced-plaintext
      // conversation selects no plugin and never reaches this catch.
      logWarn(
        `E2EE encrypt failed for ${recipient}, blocking plaintext send: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
    return undefined
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts`
Expected: PASS — all existing tests still green (the no-plugin plaintext tests use an empty manager and never reach this catch), plus the two new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts
git commit -m "fix(e2ee): block plaintext fallback when a selected plugin fails to encrypt"
```

---

## Task 2: SDK — sticky encryption for peers with established trust

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts:255-290`
- Test: `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts`

Context: `assertPlaintextPermitted` (E2EEManager.ts:281) only blocks plaintext for a `verified` peer (via `isPeerVerified`, line 287). A TOFU-pinned peer reports `getPeerTrust → 'tofu'` (OpenPGP `evaluatePeerTrust`, OpenPGPPluginBase.ts:1604-1608). If that peer's capability probe transiently fails, `selectStrategy` returns `null` and the send falls through to plaintext in opportunistic mode. Trust states are `'verified' | 'introduced' | 'tofu' | 'untrusted' | 'unknown'` (types.ts:215). `isPeerVerified` (E2EEManager.ts:255) is only used at line 287 inside the SDK; the app's separate `isPeerVerified` (verifiedPeerKeysStore) is unrelated.

- [ ] **Step 1: Write the failing test**

`FakePlugin` (E2EEManager.test.ts:41) implements `E2EEPlugin` and is spy-able. Add a new `describe` block (place it near the other policy tests). Confirm `E2EEEncryptionRequiredError` and `E2EEManager` are imported at the top of the file (they are used elsewhere in the suite; add `E2EEEncryptionRequiredError` to the import if missing).

```typescript
describe('assertPlaintextPermitted — sticky established trust', () => {
  function makeManagerWithPlugin(): { mgr: E2EEManager; plugin: FakePlugin } {
    const mgr = new E2EEManager({
      storage: new InMemoryStorageBackend(),
      xmpp: stubXmppPrimitives(),
      account: { jid: 'me@example.com' },
    })
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    return { mgr, plugin }
  }

  it('blocks plaintext to a tofu-pinned peer in opportunistic mode', async () => {
    const { mgr, plugin } = makeManagerWithPlugin()
    await mgr.register(plugin)
    vi.spyOn(plugin, 'getPeerTrust').mockResolvedValue('tofu')

    await expect(
      mgr.assertPlaintextPermitted({ kind: 'direct', peer: 'bob@example.com' }),
    ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
  })

  it('blocks plaintext to an introduced peer in opportunistic mode', async () => {
    const { mgr, plugin } = makeManagerWithPlugin()
    await mgr.register(plugin)
    vi.spyOn(plugin, 'getPeerTrust').mockResolvedValue('introduced')

    await expect(
      mgr.assertPlaintextPermitted({ kind: 'direct', peer: 'bob@example.com' }),
    ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
  })

  it('permits plaintext to an unknown peer in opportunistic mode', async () => {
    const { mgr, plugin } = makeManagerWithPlugin()
    await mgr.register(plugin)
    vi.spyOn(plugin, 'getPeerTrust').mockResolvedValue('unknown')

    await expect(
      mgr.assertPlaintextPermitted({ kind: 'direct', peer: 'bob@example.com' }),
    ).resolves.toBeUndefined()
  })

  it('permits plaintext to an untrusted peer in opportunistic mode', async () => {
    const { mgr, plugin } = makeManagerWithPlugin()
    await mgr.register(plugin)
    vi.spyOn(plugin, 'getPeerTrust').mockResolvedValue('untrusted')

    await expect(
      mgr.assertPlaintextPermitted({ kind: 'direct', peer: 'bob@example.com' }),
    ).resolves.toBeUndefined()
  })
})
```

Note on helper signatures: match the file's existing usage. If `stubXmppPrimitives` in this file requires arguments, copy the form used by neighbouring tests; if `strongDescriptor` is not in scope at this position, reuse the descriptor constant the surrounding tests use (e.g. the one passed at lines 269/439).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "sticky established trust"`
Expected: FAIL — the `tofu` and `introduced` cases currently resolve (only `verified` blocks today).

- [ ] **Step 3: Implement `hasEstablishedTrust` and use it**

In `E2EEManager.ts`, add a method next to `isPeerVerified` (after line 265):

```typescript
  /**
   * True if any registered plugin reports an *established* trust state for
   * this peer — `verified`, `introduced`, or `tofu`. These all mean "we hold
   * a pinned key for this peer", so plaintext is an implicit per-peer downgrade
   * and must be blocked even under the opportunistic global policy. `untrusted`
   * and `unknown` are excluded: the former is a deliberate not-trusted marker,
   * the latter means we have never seen a key (legitimate first contact).
   *
   * Plugin trust-check errors are treated as not-established (fail-open) so a
   * transient plugin fault never permanently blocks the send path.
   */
  async hasEstablishedTrust(peer: BareJID): Promise<boolean> {
    for (const plugin of this.plugins.values()) {
      try {
        const trust = await plugin.getPeerTrust(peer)
        if (trust === 'verified' || trust === 'introduced' || trust === 'tofu') {
          return true
        }
      } catch {
        // Plugin trust check failed — cannot confirm, continue.
      }
    }
    return false
  }
```

Then in `assertPlaintextPermitted` (lines 286-289) replace:

```typescript
    if (target.kind === 'direct') {
      const verified = await this.isPeerVerified(target.peer).catch(() => false)
      if (verified) throw new E2EEEncryptionRequiredError(target)
    }
```

with:

```typescript
    if (target.kind === 'direct') {
      const established = await this.hasEstablishedTrust(target.peer).catch(() => false)
      if (established) throw new E2EEEncryptionRequiredError(target)
    }
```

Leave `isPeerVerified` in place — it remains a meaningful public predicate even though `assertPlaintextPermitted` no longer calls it. Also update the doc comment on `assertPlaintextPermitted` (lines 275-280): change priority item 3 from "A verified direct peer blocks plaintext" to "A direct peer with established trust (verified / introduced / tofu) blocks plaintext (implicit per-peer strict)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts`
Expected: PASS — new block green; existing tests unaffected (the dummy plugin reports `'untrusted'`, which stays permissive).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/E2EEManager.ts packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts
git commit -m "fix(e2ee): block plaintext to peers with established trust (tofu/introduced), not only verified"
```

---

## Task 3: SDK plugin — type the "no cached public key" failure

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts:1417-1421`
- Test: `apps/fluux/src/e2ee/OpenPGPPluginBase.test.ts` (add to the existing `encrypt` describe; if no such test file exists, skip the test step and rely on typecheck — note this in the commit).

Context: `encrypt()` (OpenPGPPluginBase.ts:1408) throws a plain `Error` when the peer key is missing from the in-memory cache (line 1419-1421). After Task 1 this now *blocks* the send (good — no leak), but a plain `Error` is not an `E2EEPluginError`, so the composer (Task 4) cannot give the user a specific message. Typing it closes that UX gap.

- [ ] **Step 1: Write the failing test**

Check whether `apps/fluux/src/e2ee/OpenPGPPluginBase.test.ts` exists (`ls apps/fluux/src/e2ee/*.test.ts`). If it does and exercises `encrypt()`, add:

```typescript
it('throws a typed peer-key-missing error when no public key is cached', async () => {
  // plugin initialised, own key present, but peer key never probed/cached.
  const handle = await plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
  await expect(
    plugin.encrypt(handle, new TextEncoder().encode('<payload/>')),
  ).rejects.toMatchObject({ name: 'E2EEPluginError', code: 'peer-key-missing' })
})
```

If no encrypt-level test harness exists for this plugin, **skip this step** and proceed to Step 3 (the change is type-only and covered by typecheck).

- [ ] **Step 2: Run the test to verify it fails** (only if Step 1 was written)

Run: `cd apps/fluux && npx vitest run src/e2ee/OpenPGPPluginBase.test.ts -t "peer-key-missing"`
Expected: FAIL — currently a plain `Error` with `name === 'Error'`.

- [ ] **Step 3: Type the error**

Replace lines 1419-1421:

```typescript
    if (!peerBundle) {
      throw new Error(`${this.pluginName()}: no cached public key for ${peer} — probe first`)
    }
```

with:

```typescript
    if (!peerBundle) {
      throw new E2EEPluginError(
        'transient',
        'peer-key-missing',
        `${this.pluginName()}: no cached public key for ${peer} — probe first`,
      )
    }
```

`E2EEPluginError` is already imported in this file (line 61).

- [ ] **Step 4: Run the test (or typecheck)**

If Step 1 was written: `cd apps/fluux && npx vitest run src/e2ee/OpenPGPPluginBase.test.ts -t "peer-key-missing"` → PASS.
Otherwise: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts
git commit -m "fix(e2ee): raise typed peer-key-missing error so the UI can surface it"
```

---

## Task 4: App — map send errors to a specific toast

**Files:**
- Create: `apps/fluux/src/e2ee/encryptionSendError.ts`
- Create (test): `apps/fluux/src/e2ee/encryptionSendError.test.ts`
- Modify: `apps/fluux/src/components/MessageComposer.tsx:412-417`
- Verify: `apps/fluux/src/test-setup.ts` (mock must export `E2EEEncryptionRequiredError`, `isE2EEPluginError`)

Context: `MessageComposer.handleSubmit` (line 385) wraps `onSend` in try/catch; text is cleared only on success (lines 406-410), so a thrown error preserves the user's message. The current catch (412-417) only special-cases `E2EEEncryptionRequiredError` (attachment-specific string) and otherwise `console.error`s with no user feedback. `addToast` is `useToastStore((s) => s.addToast)` with signature `addToast('error', message)` (lines 15, 177). `MessageComposer` is shared by `ChatView` and `RoomView`.

- [ ] **Step 1: Write the failing test for the pure mapping helper**

Create `apps/fluux/src/e2ee/encryptionSendError.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { E2EEEncryptionRequiredError, E2EEPluginError } from '@fluux/sdk'
import { encryptionSendErrorKey } from './encryptionSendError'

describe('encryptionSendErrorKey', () => {
  it('maps E2EEEncryptionRequiredError to the generic encryption-required key', () => {
    const err = new E2EEEncryptionRequiredError({ kind: 'direct', peer: 'bob@example.com' })
    expect(encryptionSendErrorKey(err)).toBe('chat.encryption.sendBlockedEncryptionRequired')
  })

  it('maps pin-mismatch to the key-changed message', () => {
    const err = new E2EEPluginError('permanent', 'pin-mismatch', 'changed')
    expect(encryptionSendErrorKey(err)).toBe('chat.encryption.sendBlockedKeyChanged')
  })

  it('maps key-locked to the unlock message', () => {
    const err = new E2EEPluginError('transient', 'key-locked', 'locked')
    expect(encryptionSendErrorKey(err)).toBe('chat.encryption.sendBlockedKeyLocked')
  })

  it('maps own-key-conflict to the conflict message', () => {
    const err = new E2EEPluginError('permanent', 'own-key-conflict', 'conflict')
    expect(encryptionSendErrorKey(err)).toBe('chat.encryption.sendBlockedKeyConflict')
  })

  it('maps any other plugin error to the generic encryption-failed message', () => {
    const err = new E2EEPluginError('transient', 'peer-key-missing', 'probe first')
    expect(encryptionSendErrorKey(err)).toBe('chat.encryption.sendBlockedGeneric')
  })

  it('returns null for a non-encryption error (caller logs instead)', () => {
    expect(encryptionSendErrorKey(new Error('network down'))).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/encryptionSendError.test.ts`
Expected: FAIL — `encryptionSendError` module does not exist.

- [ ] **Step 3: Create the helper**

Create `apps/fluux/src/e2ee/encryptionSendError.ts`:

```typescript
import { E2EEEncryptionRequiredError, isE2EEPluginError } from '@fluux/sdk'

/**
 * Map a thrown send error to an i18n key for a user-facing toast, or `null`
 * when the error is unrelated to encryption (the caller should log it).
 *
 * After the SDK stopped silently downgrading to plaintext, an outbound send
 * can reject with either `E2EEEncryptionRequiredError` (no usable encryption
 * for a peer that requires it) or a plugin `E2EEPluginError` (encryption was
 * attempted and failed). The user's typed message is preserved by the
 * composer, so the toast tells them why it did not send and what to do.
 */
export function encryptionSendErrorKey(err: unknown): string | null {
  if (err instanceof E2EEEncryptionRequiredError) {
    return 'chat.encryption.sendBlockedEncryptionRequired'
  }
  if (isE2EEPluginError(err)) {
    switch (err.code) {
      case 'pin-mismatch':
        return 'chat.encryption.sendBlockedKeyChanged'
      case 'key-locked':
        return 'chat.encryption.sendBlockedKeyLocked'
      case 'own-key-conflict':
        return 'chat.encryption.sendBlockedKeyConflict'
      default:
        return 'chat.encryption.sendBlockedGeneric'
    }
  }
  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/encryptionSendError.test.ts`
Expected: PASS.
If it fails because the test's `@fluux/sdk` import resolves to the global mock, ensure `apps/fluux/src/test-setup.ts`'s `vi.mock('@fluux/sdk', ...)` spreads `await importOriginal()` and includes `E2EEEncryptionRequiredError` and `isE2EEPluginError` (per the project's "new SDK exports must be in the mock" rule). Re-run.

- [ ] **Step 5: Wire the helper into the composer**

In `MessageComposer.tsx`, replace the catch (lines 412-417):

```typescript
    } catch (err) {
      if (err instanceof E2EEEncryptionRequiredError) {
        addToast('error', t('chat.encryption.attachmentKeyWouldLeak'))
      } else {
        console.error('Failed to send message:', err)
      }
    } finally {
```

with:

```typescript
    } catch (err) {
      const toastKey = encryptionSendErrorKey(err)
      if (toastKey) {
        addToast('error', t(toastKey))
      } else {
        console.error('Failed to send message:', err)
      }
    } finally {
```

Update the imports at the top of `MessageComposer.tsx`: remove the now-unused `E2EEEncryptionRequiredError` import (line 12) **only if** it is not referenced elsewhere in the file (grep first); add `import { encryptionSendErrorKey } from '@/e2ee/encryptionSendError'` (match the file's existing path-alias style — it uses `@/stores/...` at line 15).

Note: the old `attachmentKeyWouldLeak` string is replaced by the more general `sendBlockedEncryptionRequired` for the encryption-required case. Keep the `attachmentKeyWouldLeak` key in the locale files (it may be referenced elsewhere — grep before removing); the new keys are additive.

- [ ] **Step 6: Run typecheck + composer-related tests**

Run: `npm run typecheck`
Expected: no errors.
Run: `cd apps/fluux && npx vitest run src/e2ee/encryptionSendError.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/e2ee/encryptionSendError.ts apps/fluux/src/e2ee/encryptionSendError.test.ts apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/test-setup.ts
git commit -m "feat(e2ee): surface encryption send failures with a specific toast instead of silent log"
```

---

## Task 5: i18n — add the five toast keys to all 33 locales

**Files:**
- Modify: all 33 files in `apps/fluux/src/i18n/locales/*.json`

Context: toast strings live under `chat.encryption` (e.g. `en.json` around line 475-500, alongside `attachmentKeyWouldLeak`). The project rule (auto-memory) is that new/changed keys are translated into every locale, not left as English placeholders.

- [ ] **Step 1: Add the English source strings**

In `apps/fluux/src/i18n/locales/en.json`, inside the `chat.encryption` object (next to `attachmentKeyWouldLeak`, line 500), add:

```json
"sendBlockedEncryptionRequired": "Message not sent — encryption is required for this conversation but isn't available right now.",
"sendBlockedKeyChanged": "Message not sent — this contact's encryption key changed. Review the key change before sending.",
"sendBlockedKeyLocked": "Message not sent — unlock your encryption key to send this message.",
"sendBlockedKeyConflict": "Message not sent — resolve your encryption key conflict before sending.",
"sendBlockedGeneric": "Message not sent — encryption failed."
```

(Ensure valid JSON: add a comma after the preceding key.)

- [ ] **Step 2: Translate into the other 32 locales**

For each of the remaining files (`ar bg be ca cs da de el es et fi fr ga he hr hu is it lt lv mt nb nl pl pt ro ru sk sl sv uk zh-CN`), add the same five keys under `chat.encryption`, translated. Match the key the file uses for `attachmentKeyWouldLeak` as the placement anchor and the locale's existing tone/terminology for "encryption", "key", "unlock". Do the translations yourself — do not leave English values.

- [ ] **Step 3: Verify JSON validity and key parity**

Run:
```bash
cd apps/fluux/src/i18n/locales
for f in *.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "INVALID: $f"; done
echo "--- key presence across locales ---"
for f in *.json; do c=$(grep -c "sendBlockedKeyChanged" "$f"); echo "$f: $c"; done
```
Expected: no `INVALID` lines; every file reports `1` for `sendBlockedKeyChanged`.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n: add encryption send-blocked toast strings across all locales"
```

---

## Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Rebuild the SDK** (app typecheck consumes the built SDK types)

Run: `npm run build:sdk`
Expected: build completes with no errors.

- [ ] **Step 2: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, **no stderr output** (the project gate per CLAUDE.md is "tests pass without errors or stderr").

- [ ] **Step 4: Lint**

Run: `npm run lint` (or the project's configured lint command)
Expected: clean.

- [ ] **Step 5: Targeted manual reasoning check (no app run — needs a real OpenPGP peer)**

Confirm by re-reading, not by running (demo mode has no real OpenPGP plugin, so this path can't be exercised in the browser):
- `Chat.applyE2EEToOutboundChat` catch re-throws (Task 1).
- All three call sites (send 765, resend 876, correction 1142) let the throw propagate (none wrap the helper in try/catch — verified in this plan's research).
- `MessageComposer` catch shows a toast for the mapped keys and preserves the typed text (text only clears on success).

Document in the final summary that the UI failure path was verified by code inspection, not by a live OpenPGP exchange.

---

## Self-Review

**1. Spec coverage**
- "Fail every send on pin-mismatch / key-locked / own-key-conflict" → Task 1 (re-throw; those are the `E2EEPluginError`s raised by `encrypt()` at OpenPGPPluginBase.ts:1410-1428) + Task 4 (per-code toast).
- "Don't silently downgrade for a peer we hold a key for" → Task 2 (sticky established trust).
- "User can still override to plaintext" → preserved: a forced-plaintext conversation selects no plugin (`selectStrategy` returns `null` at E2EEManager.ts:315) and never reaches the Task 1 catch; `assertPlaintextPermitted` still returns early for `isForcedPlaintext` (line 282).
- "Surface failures in the UI" → Tasks 3-5.
- Codex's "global strict on enable" → deliberately deferred (see Out of scope) with rationale.

**2. Placeholder scan** — no TBD/TODO; every code step shows complete code; commands have expected output. The only conditional is Task 3 Step 1 (test only if a plugin encrypt-test harness exists), with an explicit fallback to typecheck.

**3. Type/name consistency**
- i18n keys identical across Task 4 helper, Task 4 tests, and Task 5 JSON: `sendBlockedEncryptionRequired`, `sendBlockedKeyChanged`, `sendBlockedKeyLocked`, `sendBlockedKeyConflict`, `sendBlockedGeneric`.
- Error codes match the source: `pin-mismatch`, `own-key-conflict` (OpenPGPPluginBase.ts:1413,1425), `key-locked` (classifier at line 226), `peer-key-missing` (introduced in Task 3).
- New method `hasEstablishedTrust` named identically in Task 2 Steps 3 and the `assertPlaintextPermitted` call site.
- Helper `encryptionSendErrorKey` named identically in module, test, and composer import.
