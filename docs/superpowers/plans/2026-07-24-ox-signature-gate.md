# OX Signature Gate: Unverifiable vs Forged — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop discarding OX messages that decrypt cleanly but whose signature was made by a key we do not hold, and replace the one-size-fits-all "key not available" placeholder with a reason that is actually true.

**Architecture:** Both crypto backends gain one new boolean on `DecryptOutput` — `signerKeyKnown` — computed identically: *does any supplied verification cert hold a signing-capable, currently-valid key whose key ID matches this signature's issuer?* `OpenPGPPluginBase.decrypt()` then splits its single reject branch into two: unknown issuer means "we cannot judge" (deliver the message, mark the sender unverified, stash for deferred re-verification, reusing the existing Case C machinery), known issuer with a failed signature means forgery (keep the existing hard reject). Separately, peer signature verification widens from one cert to every cert the peer announces, and a `DecryptFailureReason` bucket is plumbed to the placeholder.

**Tech Stack:** TypeScript, React, Vitest, Rust (sequoia-openpgp 2.4.0), openpgp.js 6.3, i18next.

**Spec:** `docs/superpowers/specs/2026-07-24-ox-signature-gate-design.md`

## Global Constraints

- `signerKeyKnown` semantics are **identical in both backends**: true iff some supplied cert has a *signing-capable, policy-valid* key matching the signature's issuer key ID. Expired, revoked, or unbound issuer certs count as **not** known. A divergence here makes desktop and web disagree about what counts as forgery.
- The **encryption** path is out of scope. `peerKeys` stays one cert per peer and every `encryptToRecipient` call site is untouched. Widening encryption is Stage 2 of #1059.
- Never weaken the forgery reject: `!signatureVerified && signerKeyKnown` stays a permanent `signature-failed`.
- i18n changes cover **all 33 locales** in `apps/fluux/src/i18n/locales/`. Edit surgically: `JSON.parse` → mutate → `JSON.stringify(obj, null, 4) + "\n"`. No em-dash connectors in translated copy.
- Run the app test suite from inside the workspace (`cd apps/fluux && npx vitest run …`). Running vitest from the repo root skips `test-setup.ts` and produces spurious failures.
- Before any app typecheck, run `npm run build:sdk` from the repo root — the app compiles against `packages/fluux-sdk/dist`.

---

### Task 1: Sequoia backend reports `signerKeyKnown`

**Files:**
- Modify: `apps/fluux/src-tauri/src/openpgp.rs` (`DecryptOutput` struct ~line 120, `DecryptHelper` ~line 1411, `decrypt_and_verify` ~line 1358)
- Test: `apps/fluux/src-tauri/src/openpgp.rs` (`mod tests`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DecryptOutput.signer_key_known: bool`, serialized to JSON as `signerKeyKnown` (the struct already carries `#[serde(rename_all = "camelCase")]`).

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `apps/fluux/src-tauri/src/openpgp.rs`:

```rust
#[test]
fn signer_key_known_is_true_when_the_signing_cert_is_supplied() {
    let (state, alice, bob) = setup_two_accounts();
    let ct = state
        .encrypt("bob@example.com", &alice.public_armored, "hi")
        .unwrap();
    let out = state
        .decrypt("alice@example.com", &ct, Some(&bob.public_armored))
        .unwrap();
    assert!(out.signature_verified);
    assert!(out.signer_key_known);
}

#[test]
fn signer_key_known_is_false_when_a_different_cert_is_supplied() {
    let (state, alice, _bob) = setup_two_accounts();
    let ct = state
        .encrypt("bob@example.com", &alice.public_armored, "hi")
        .unwrap();
    // Verify bob's signature against ALICE's cert: the issuer is absent.
    let out = state
        .decrypt("alice@example.com", &ct, Some(&alice.public_armored))
        .unwrap();
    assert!(!out.signature_verified);
    assert!(
        !out.signer_key_known,
        "a cert that does not contain the issuer must not count as known"
    );
}

#[test]
fn signer_key_known_is_false_when_no_cert_is_supplied() {
    let (state, alice, _bob) = setup_two_accounts();
    let ct = state
        .encrypt("bob@example.com", &alice.public_armored, "hi")
        .unwrap();
    let out = state.decrypt("alice@example.com", &ct, None).unwrap();
    assert!(out.signature_present);
    assert!(!out.signer_key_known);
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/fluux/src-tauri && cargo test signer_key_known 2>&1 | tail -20
```

Expected: FAIL — `no field 'signer_key_known' on type 'DecryptOutput'`.

- [ ] **Step 3: Add the struct field**

In `apps/fluux/src-tauri/src/openpgp.rs`, append to `pub struct DecryptOutput` (after `signature_present`):

```rust
    /// `true` iff one of the supplied sender certs holds a signing-capable
    /// key, valid under our policy, whose key ID matches this signature's
    /// issuer. Distinguishes "we cannot judge this signature" (false — the
    /// signer used a key we do not have, or one that is expired/revoked)
    /// from "we could judge it and it failed" (true — genuine forgery).
    /// The TS gate renders the first as unverified and rejects the second.
    pub signer_key_known: bool,
```

- [ ] **Step 4: Compute it in `DecryptHelper`**

Add the import alongside the existing `parse::stream` imports:

```rust
use openpgp::KeyHandle;
```

Add the field to `struct DecryptHelper<'a>`:

```rust
    /// Set by [`get_certs`], which receives the issuer key handles before
    /// verification runs. See [`DecryptOutput::signer_key_known`].
    signer_key_known: Arc<Mutex<bool>>,
```

Replace `VerificationHelper::get_certs` with:

```rust
    fn get_certs(&mut self, ids: &[KeyHandle]) -> openpgp::Result<Vec<Cert>> {
        // `ids` names the issuers of the signatures in this message. Record
        // whether we actually hold a usable key for any of them BEFORE
        // verification runs — that is what tells an unjudgeable signature
        // apart from a forged one. "Usable" means signing-capable and valid
        // under the policy at this moment: an expired or revoked issuer cert
        // is an availability problem, not evidence of forgery.
        let certs: Vec<Cert> = self.sender.map(|c| vec![c.clone()]).unwrap_or_default();
        let known = certs.iter().any(|cert| {
            cert.keys()
                .with_policy(self.policy, None)
                .alive()
                .revoked(false)
                .for_signing()
                .any(|ka| ids.iter().any(|id| ka.key().key_handle().aliases(id)))
        });
        if let Ok(mut slot) = self.signer_key_known.lock() {
            *slot = known;
        }
        Ok(certs)
    }
```

- [ ] **Step 5: Thread it through `decrypt_and_verify`**

In `decrypt_and_verify`, beside the existing shared state:

```rust
    let signer_key_known: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
```

Add `signer_key_known: signer_key_known.clone(),` to the `DecryptHelper { … }` literal, then read it back beside `had_signature`:

```rust
    let key_known = *signer_key_known
        .lock()
        .map_err(|e| anyhow!("signer key state poisoned: {e}"))?;
```

and add `signer_key_known: key_known,` to the returned `DecryptOutput { … }`.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/fluux/src-tauri && cargo test signer_key_known 2>&1 | tail -20
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full Rust suite**

```bash
cd apps/fluux/src-tauri && cargo test 2>&1 | tail -15
```

Expected: all pass. Other tests construct `DecryptOutput` only via `decrypt_and_verify`, so the new field needs no updates elsewhere.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src-tauri/src/openpgp.rs
git commit -m "feat(e2ee): report whether the signature issuer's key is known (Sequoia)"
```

---

### Task 2: TypeScript type + web backend report `signerKeyKnown`

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts:220-233` (`DecryptOutput`)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts:209-280` (`decryptWithOwnKey`)
- Modify: `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts:105-121` (inline IPC return type)
- Test: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`

**Interfaces:**
- Consumes: Task 1's `signerKeyKnown` on the Tauri IPC payload.
- Produces: `DecryptOutput.signerKeyKnown: boolean` — required, non-optional, supplied by both backends.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe('WebOpenPGPPlugin', …)` in `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`:

```ts
describe('signerKeyKnown', () => {
  async function makeSignedCiphertext() {
    const { alice, bob } = await buildCrossPublishedPair()
    await alice.plugin.probePeer('bob@example.com')
    const bobBundle = await bob.plugin.callEnsureKeyMaterial('bob@example.com')
    const aliceBundle = await alice.plugin.callEnsureKeyMaterial('alice@example.com')
    // Alice signs, encrypts to bob.
    const ciphertext = await alice.plugin.callEncryptToRecipient(
      'alice@example.com',
      bobBundle.publicArmored,
      'hello',
    )
    return { alice, bob, ciphertext, aliceBundle, bobBundle }
  }

  it('is true when the supplied cert contains the signing key', async () => {
    const { bob, ciphertext, aliceBundle } = await makeSignedCiphertext()
    clearSessionPassphrase()
    setSessionPassphrase('bob-strong-pp')
    const out = await bob.plugin.callDecryptWithOwnKey(
      'bob@example.com',
      ciphertext,
      aliceBundle.publicArmored,
    )
    expect(out.signatureVerified).toBe(true)
    expect(out.signerKeyKnown).toBe(true)
  })

  it('is false when a cert that does not contain the issuer is supplied', async () => {
    const { bob, ciphertext, bobBundle } = await makeSignedCiphertext()
    clearSessionPassphrase()
    setSessionPassphrase('bob-strong-pp')
    // Verify alice's signature against BOB's own cert: issuer absent.
    const out = await bob.plugin.callDecryptWithOwnKey(
      'bob@example.com',
      ciphertext,
      bobBundle.publicArmored,
    )
    expect(out.signaturePresent).toBe(true)
    expect(out.signatureVerified).toBe(false)
    expect(out.signerKeyKnown).toBe(false)
  })

  it('is false when no cert is supplied', async () => {
    const { bob, ciphertext } = await makeSignedCiphertext()
    clearSessionPassphrase()
    setSessionPassphrase('bob-strong-pp')
    const out = await bob.plugin.callDecryptWithOwnKey('bob@example.com', ciphertext, null)
    expect(out.signaturePresent).toBe(true)
    expect(out.signerKeyKnown).toBe(false)
  })
})
```


- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t signerKeyKnown 2>&1 | tail -20
```

Expected: FAIL — `signerKeyKnown` is `undefined`.

- [ ] **Step 3: Add the field to the shared type**

In `apps/fluux/src/e2ee/OpenPGPPluginBase.ts`, add to `export interface DecryptOutput` after `signaturePresent`:

```ts
  /**
   * `true` iff one of the supplied sender certs holds a signing-capable key,
   * valid right now, whose key ID matches this signature's issuer.
   *
   * This is the difference between "we cannot judge this signature" (false —
   * the signer used a key we do not hold, or one that is expired or revoked)
   * and "we could judge it and it failed" (true — genuine forgery). The two
   * must not be collapsed: the first is routine on a multi-key or multi-client
   * peer, the second is an attack. See #1059.
   */
  signerKeyKnown: boolean
```

- [ ] **Step 4: Compute it in the web backend**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts`, replace the block from `let signatureVerified = false` down to the start of `if (signaturePresent && senderPublicArmored) {` with:

```ts
    let signatureVerified = false
    let signerFingerprint: string | null = null
    let signatureNotYetValid = false
    const signaturePresent = signatures.length > 0

    // Does any supplied cert hold a signing-capable, currently-valid key
    // matching this signature's issuer? Mirrors the Sequoia backend's
    // `get_certs` check exactly — an expired or revoked issuer cert is an
    // availability problem, not evidence of forgery, so it reads as unknown.
    let signerKeyKnown = false
    if (signaturePresent) {
      const issuer = signatures[0].keyID
      for (const key of verificationKeys) {
        if (!key.getSigningKeyIDs().some((id) => id.equals(issuer))) continue
        if (await key.isRevoked()) continue
        const expiry = await key.getExpirationTime()
        if (expiry instanceof Date && expiry.getTime() <= Date.now()) continue
        signerKeyKnown = true
        break
      }
    }

    if (signaturePresent && senderPublicArmored) {
```

Then add `signerKeyKnown,` to the returned object, after `signaturePresent,`.

- [ ] **Step 5: Widen the Sequoia IPC return type**

In `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts`, add `signerKeyKnown: boolean` to the inline generic on `this.invoke<…>('openpgp_decrypt', …)`:

```ts
    const rust = await this.invoke<{
      plaintext: string
      signatureVerified: boolean
      signerFingerprint: string | null
      signaturePresent: boolean
      signerKeyKnown: boolean
    }>('openpgp_decrypt', {
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t signerKeyKnown 2>&1 | tail -20
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Fix every other construction of `DecryptOutput`**

`signerKeyKnown` is required, so test doubles and the demo plugin will not compile. Find them:

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && npm run build:sdk >/dev/null 2>&1 && npm run typecheck 2>&1 | grep -i "signerKeyKnown" | head -20
```

For each reported site, add `signerKeyKnown: false` unless the double is specifically exercising a verified signature, in which case use `true`. Re-run until the typecheck is clean.

- [ ] **Step 8: Run the whole e2ee suite and commit**

```bash
cd apps/fluux && npx vitest run src/e2ee/ 2>&1 | tail -8
```

Expected: all pass (428 + 3 new).

```bash
git add apps/fluux/src/e2ee/ apps/fluux/src/demo/
git commit -m "feat(e2ee): report whether the signature issuer's key is known (web)"
```

---

### Task 3: Split the gate into unverifiable vs forged

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts:2077-2095`
- Test: `apps/fluux/src/e2ee/gajimOxInterop.test.ts` (existing assertion flips)
- Test: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts:2228` (substitution test becomes a pair)

**Interfaces:**
- Consumes: `DecryptOutput.signerKeyKnown` from Tasks 1-2.
- Produces: no new exports. Behavioural contract: `decrypt()` resolves (rather than throwing) when `signaturePresent && !signatureVerified && !signerKeyKnown`, returning a security context with `trust: 'untrusted'`.

- [ ] **Step 1: Flip the interop assertion to the intended behaviour**

In `apps/fluux/src/e2ee/gajimOxInterop.test.ts`, replace the test named `is nonetheless discarded by the post-decrypt signature gate (#1059)` with:

```ts
    it('is delivered and marked unverified rather than discarded (#1059)', async () => {
      // The signature was made by key B; we hold key A as the sender cert, so
      // we cannot judge it. Gajim renders this as Trust.UNTRUSTED; we deliver
      // it with trust 'untrusted' and stash it for deferred re-verification.
      const vector = meta.vectors[vectorName]
      const plugin = await makeFluux(
        meta,
        readFixture('gajim_key_a_public.asc'),
        meta.keyAFingerprint,
      )
      const handle = await plugin.openConversation({ kind: 'direct', peer: meta.accountJid })
      const claim = plugin.tryClaimInbound(openpgpElement(vector.ciphertextBase64))!

      const result = await plugin.decrypt(handle, claim, { messageId: 'm-unverifiable' })

      expect(new TextDecoder().decode(result.plaintext)).toContain(vector.body)
      expect(result.securityContext?.trust).toBe('untrusted')
    })
```

Also rename the enclosing `describe` from `a decryptable message signed by the account's other announced key` to the same string (unchanged) — no edit needed there.

- [ ] **Step 2: Rewrite the substitution test as a pair**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`, replace the whole test at line 2228 (`rejects when the signature does not match the cached sender cert (Case A)`) with:

```ts
    it('delivers as unverified when the cached cert does not contain the signer (substituted key, genuine signature)', async () => {
      // Server substitution: eve's key is published as alice's, but the
      // message carries ALICE's real signature. We hold no cert for that
      // issuer, so we cannot judge it — deliver it, marked unverified.
      // Nothing is attributed to alice, and the attacker has gained no
      // ability to author messages.
      const { shared, alice, bob } = await buildCrossPublishedPair()

      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBody('hi'))

      clearSessionPassphrase()
      setSessionPassphrase('eve-strong-pp')
      const eve = new TestableWebOpenPGPPlugin()
      await eve.init(makeCtx('alice@example.com').ctx)
      const eveBundle = await eve.callEnsureKeyMaterial('alice@example.com')
      publishKeyToSharedPep(shared, 'alice@example.com', eveBundle)

      clearSessionPassphrase()
      setSessionPassphrase('bob-strong-pp')
      await bob.plugin.probePeer('alice@example.com')
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!

      const result = await bob.plugin.decrypt(bobHandle, claim, { messageId: 'm-substituted' })

      expect(result.securityContext?.trust).toBe('untrusted')
      expect(result.securityContext?.trust).not.toBe('verified')
    })

    it('still hard-rejects when the signature fails against a cert we DO hold (forgery)', async () => {
      // The branch that actually guards the threat: we have a usable key for
      // the issuer and the signature does not check out. This must never
      // become a soft "unverified" rendering.
      const { alice, bob } = await buildCrossPublishedPair()

      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBody('hi'))

      clearSessionPassphrase()
      setSessionPassphrase('bob-strong-pp')
      await bob.plugin.probePeer('alice@example.com')
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!

      // Force the "we could judge it and it failed" combination directly.
      // Producing a genuinely forged OpenPGP signature that still survives
      // AEAD/MDC integrity is not constructible in a unit test, so stub the
      // crypto layer at its seam and assert the GATE, which is what this
      // test is about.
      const original = bob.plugin.callDecryptWithOwnKey.bind(bob.plugin)
      vi.spyOn(
        bob.plugin as unknown as {
          decryptWithOwnKey: (j: string, c: string, s: string | null) => Promise<DecryptOutput>
        },
        'decryptWithOwnKey',
      ).mockImplementation(async (j, c, s) => ({
        ...(await original(j, c, s)),
        signatureVerified: false,
        signerKeyKnown: true,
      }))

      await expect(bob.plugin.decrypt(bobHandle, claim)).rejects.toMatchObject({
        code: 'signature-failed',
        kind: 'permanent',
      })
    })
```

Add `import type { DecryptOutput } from './OpenPGPPluginBase'` to the file's imports if it is not already present (`KeyBundle` is imported from there at line 28 — extend that import).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/fluux && npx vitest run src/e2ee/gajimOxInterop.test.ts src/e2ee/WebOpenPGPPlugin.test.ts 2>&1 | tail -25
```

Expected: FAIL — the interop test still rejects with `signature-failed`; the substitution test still rejects instead of delivering.

- [ ] **Step 4: Split the gate**

In `apps/fluux/src/e2ee/OpenPGPPluginBase.ts`, replace the block starting `// Case A: sender key available but signature did not verify.` (line 2077) through the closing brace at line 2095 with:

```ts
    // Signature present but not verified. Two very different situations hide
    // here, and collapsing them was #1059:
    //
    //   - We hold no usable key for the issuer → we cannot judge. Routine on
    //     a peer with several announced keys or several clients. Fall through
    //     to the deferred-verification path below, which delivers the message
    //     and marks the sender unverified. This is what Gajim does
    //     (decrypt_message retries without verification, renders UNTRUSTED).
    //   - We DO hold a usable key for the issuer and it still failed → the
    //     message was tampered with. Reject permanently.
    if (!output.signatureVerified) {
      // A clock-skew "not yet valid" failure is transient — the signature may
      // verify once clocks converge. Throw a distinct transient code so the
      // decrypt pipeline stashes it for retry (retryPendingDecrypts) instead
      // of issuing a permanent, sticky rejection.
      if (output.signatureNotYetValid) {
        throw new E2EEPluginError(
          'transient',
          'signature-not-yet-valid',
          `${this.pluginName()}: signcrypt signature creation time is ahead of our clock beyond tolerance — will retry`,
        )
      }
      if (output.signerKeyKnown) {
        throw new E2EEPluginError(
          'permanent',
          'signature-failed',
          `${this.pluginName()}: signcrypt signature did not verify against a key we hold for its issuer`,
        )
      }
      ctx.logger.warn(
        `${this.pluginName()}: signature issuer is not among the certs we hold for ${peer} — ` +
          `delivering as unverified, pending re-verification`,
      )
    }
    // Falls through — the deferred-verification stash below handles the
    // unjudgeable case, for both "no cert at all" and "wrong cert".
```

- [ ] **Step 5: Widen the deferred stash condition**

Still in `decrypt()`, the stash currently requires `!senderPublicArmored`. It must now also stash when a cert was supplied but did not contain the issuer. Replace that condition:

```ts
    if (
      !isSelfOutgoing &&
      context?.messageId &&
      !output.signatureVerified &&
      output.signaturePresent &&
      !output.signerKeyKnown
    ) {
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/fluux && npx vitest run src/e2ee/ 2>&1 | tail -12
```

Expected: all pass. If a test asserting `/signature did not verify/` fails on the reworded message, update it to match the new string — the wording change is intentional.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/e2ee/
git commit -m "fix(e2ee): deliver messages whose signature issuer we cannot judge (#1059)"
```

---

### Task 4: Verify against every announced peer cert

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` (`peerVerifyKeys` map, `refetchAndCachePeerKey` ~1726, abstract `decryptWithOwnKey` ~454, its 4 call sites at 678 / 1424 / 2011 / 2263)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts:209`
- Modify: `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts:105`
- Modify: `apps/fluux/src-tauri/src/openpgp.rs` (`openpgp_decrypt` command, `OpenpgpState::decrypt`, `decrypt_and_verify`, `DecryptHelper.sender`)
- Test: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `decryptWithOwnKey(accountJid: string, ciphertext: string, senderPublicArmored: string[] | null)`. Tauri command `openpgp_decrypt` takes `senderPublicArmored: Option<Vec<String>>`.

- [ ] **Step 1: Write the failing test**

Append to the `signerKeyKnown` describe in `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`:

```ts
  it('verifies against a second announced cert when the first does not match', async () => {
    const { bob, ciphertext, aliceBundle, bobBundle } = await makeSignedCiphertext()
    clearSessionPassphrase()
    setSessionPassphrase('bob-strong-pp')
    // Bob holds two certs for the peer; only the second signed this message.
    const out = await bob.plugin.callDecryptWithOwnKey('bob@example.com', ciphertext, [
      bobBundle.publicArmored,
      aliceBundle.publicArmored,
    ])
    expect(out.signerKeyKnown).toBe(true)
    expect(out.signatureVerified).toBe(true)
  })
```

Tasks 2 and the Gajim interop suite call this wrapper with a **single armored
string**. Rather than rewriting every one of those call sites, make the wrapper
normalize — in `WebOpenPGPPlugin.test.ts`, `consumeSequoiaVectors.test.ts` and
`gajimOxInterop.test.ts`, change each `TestablePlugin`/`TestableWebOpenPGPPlugin`
wrapper to:

```ts
  callDecryptWithOwnKey(jid: string, ct: string, senderPub: string[] | string | null) {
    return this.decryptWithOwnKey(jid, ct, typeof senderPub === 'string' ? [senderPub] : senderPub)
  }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t "second announced cert" 2>&1 | tail -20
```

Expected: FAIL — a type error, or `readKey` throwing on an array.

- [ ] **Step 3: Widen the abstract signature and both backends**

`OpenPGPPluginBase.ts`, abstract declaration:

```ts
  /**
   * Decrypt `ciphertext` encrypted to our own key. `senderPublicArmored` lists
   * every cert we hold for the sender; signature verification succeeds if ANY
   * of them signed the message. Gajim does the same (`get_public_keys(…,
   * only_active=False)`), and a peer with more than one announced key would
   * otherwise always read as unverified. `null` when we hold none.
   */
  protected abstract decryptWithOwnKey(
    accountJid: string,
    ciphertext: string,
    senderPublicArmored: string[] | null,
  ): Promise<DecryptOutput>
```

`WebOpenPGPPlugin.ts`, replace the `verificationKeys` construction:

```ts
    const senderCerts = senderPublicArmored ?? []
    const verificationKeys = await Promise.all(
      senderCerts.map((armoredKey) => readKey({ armoredKey })),
    )
```

and change `signerFingerprint = verificationKeys[0].getFingerprint()` to resolve the cert that actually matched:

```ts
        signerFingerprint =
          verificationKeys
            .find((k) => k.getSigningKeyIDs().some((id) => id.equals(signatures[0].keyID)))
            ?.getFingerprint() ?? null
```

Replace the `if (signaturePresent && senderPublicArmored)` guard with `if (signaturePresent && verificationKeys.length > 0)`, and the diagnostic log's `verificationKeys[0]?.getFingerprint?.()` with `signatures[0].keyID.toHex()`.

`SequoiaPgpPlugin.ts`: change the parameter type to `string[] | null`; the IPC body is unchanged.

- [ ] **Step 4: Widen the Rust side**

In `apps/fluux/src-tauri/src/openpgp.rs`:

```rust
#[tauri::command]
pub fn openpgp_decrypt(
    account_jid: String,
    ciphertext: String,
    sender_public_armored: Option<Vec<String>>,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<DecryptOutput, String> {
    state.decrypt(&account_jid, &ciphertext, sender_public_armored.as_deref())
}
```

`OpenpgpState::decrypt` takes `sender_public_armored: Option<&[String]>` and forwards it. In `decrypt_and_verify`, replace the single-cert parse:

```rust
    let sender_certs: Vec<Cert> = match sender_public_armored {
        Some(armored) => armored
            .iter()
            .map(|a| Cert::from_bytes(a.as_bytes()).context("parse sender public key"))
            .collect::<Result<Vec<_>>>()?,
        None => Vec::new(),
    };
```

Change `DecryptHelper.sender` to `senders: &'a [Cert]`, and in `get_certs` replace `self.sender.map(|c| vec![c.clone()]).unwrap_or_default()` with `self.senders.to_vec()`; the `.any(…)` predicate already iterates certs.

- [ ] **Step 5: Update the 4 base call sites**

Wrap each existing single value in an array, preserving null:

- Line ~678: `(ciphertext, senderPub) => this.decryptWithOwnKey(jid, ciphertext, senderPub ? [senderPub] : null)`
- Line ~1424: `this.decryptWithOwnKey(ctx.account.jid, ciphertext, senderKey ? [senderKey] : null)`
- Line ~2263 (deferred re-verify): `peerBundle.publicArmored` → `[peerBundle.publicArmored]`
- Line ~2011 is replaced wholesale in Step 7.

- [ ] **Step 6: Retain every advertised cert**

Add the field beside `peerKeys`:

```ts
  /**
   * Every cert advertised for a peer, used for signature verification only.
   * `peerKeys` still holds the ONE cert we encrypt to — widening encryption
   * is Stage 2 of #1059 and deliberately not done here.
   */
  private readonly peerVerifyKeys = new Map<BareJID, KeyBundle[]>()
```

In `refetchAndCachePeerKey`, the loop currently returns on the first successful fetch. Collect them all, keeping the first as the encryption key so existing behaviour is untouched:

```ts
      const rejections: CertRejection[] = []
      const verified: KeyBundle[] = []
      let primary: KeyBundle | null = null
      for (const fingerprint of fingerprints) {
        const bundle = await this.fetchAdvertisedKey(peer, fingerprint, rejections)
        if (!bundle) continue
        verified.push(bundle)
        if (!primary) primary = bundle
      }
      if (primary) {
        clearCertRejections(peer)
        this.peerVerifyKeys.set(peer, verified)
        this.cachePeerKey(peer, primary)
        return {
          supported: true,
          ttl: PROBE_NEGATIVE_TTL_SECONDS,
          fingerprint: primary.fingerprint,
        }
      }
```

- [ ] **Step 7: Feed them to the gate**

In `decrypt()`, replace the `senderPublicArmored` computation:

```ts
    const senderPublicArmored: string[] | null = isSelfOutgoing
      ? this.ownBundle
        ? [this.ownBundle.publicArmored]
        : null
      : this.certsForVerification(peer)
```

and add the helper beside `cachePeerKey`:

```ts
  /**
   * Every cert we can verify a signature from `peer` against: all advertised
   * certs when a probe has retained them, else the single cached encryption
   * cert. Returns null when we hold none.
   */
  private certsForVerification(peer: BareJID): string[] | null {
    const all = this.peerVerifyKeys.get(peer)
    if (all && all.length > 0) return all.map((b) => b.publicArmored)
    const one = this.peerKeys.get(peer)
    return one ? [one.publicArmored] : null
  }
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd apps/fluux/src-tauri && cargo test 2>&1 | tail -8
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && npm run build:sdk >/dev/null && npm run typecheck 2>&1 | tail -5
cd apps/fluux && npx vitest run src/e2ee/ 2>&1 | tail -8
```

Expected: Rust passes, typecheck clean, all vitest e2ee tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src apps/fluux/src-tauri/src
git commit -m "feat(e2ee): verify signatures against every announced peer cert"
```

---

### Task 5: Carry a typed failure reason to the host

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/types.ts:119-140` (`SecurityContext`)
- Modify: `packages/fluux-sdk/src/core/types/message-base.ts:215-230` (`MessageSecurityContext`)
- Modify: `packages/fluux-sdk/src/index.ts` (export the new type)
- Modify: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` (~line 328-340)
- Test: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts`

**Interfaces:**
- Consumes: the `E2EEPluginError.code` values thrown by Task 3's gate.
- Produces: `export type DecryptFailureReason = 'key-unavailable' | 'signature-invalid' | 'unreadable'`, exported from `@fluux/sdk`, present as optional `failureReason` on both `SecurityContext` and `MessageSecurityContext`.

- [ ] **Step 1: Write the failing test**

Append to `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts`:

```ts
describe('failureReason bucketing', () => {
  it.each([
    ['signature-failed', 'signature-invalid'],
    ['malformed-data', 'unreadable'],
    ['envelope-reflection', 'unreadable'],
    ['envelope-stale', 'unreadable'],
    ['no-session-key', 'key-unavailable'],
  ])('maps %s to %s', (code, expected) => {
    expect(decryptFailureReasonFor(code)).toBe(expected)
  })

  it('falls back to unreadable for an unrecognised code', () => {
    expect(decryptFailureReasonFor('something-new')).toBe('unreadable')
  })
})
```

Add `decryptFailureReasonFor` to the file's import from `./stanzaDecrypt`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts -t failureReason 2>&1 | tail -15
```

Expected: FAIL — `decryptFailureReasonFor is not a function`.

- [ ] **Step 3: Add the type**

In `packages/fluux-sdk/src/core/e2ee/types.ts`, above `SecurityContext`:

```ts
/**
 * Why a message could not be shown, bucketed for display.
 *
 * Deliberately coarse: the user needs to know whether this is about a key
 * they do not have, a message that failed authentication, or a message that
 * could not be parsed. The precise `E2EEPluginError.code` always goes to the
 * diagnostic log — see #1059, where a single fixed "encrypted to a key not
 * available on this device" string sent triage down the wrong path for three
 * rounds by asserting a cause it had not established.
 */
export type DecryptFailureReason =
  /** No session key for us. The only case that is really about a missing key. */
  | 'key-unavailable'
  /** Decrypted, but the signature is forged. */
  | 'signature-invalid'
  /** Malformed, reflected, stale envelope, or a session needing repair. */
  | 'unreadable'
```

Add to `SecurityContext`:

```ts
  /** Set only when the message could not be shown. See {@link DecryptFailureReason}. */
  failureReason?: DecryptFailureReason
```

Mirror the same optional field, with the same doc comment, on `MessageSecurityContext` in `packages/fluux-sdk/src/core/types/message-base.ts` (import the type from `../e2ee/types`).

Export from `packages/fluux-sdk/src/index.ts` alongside the other e2ee types:

```ts
export type { DecryptFailureReason } from './core/e2ee/types'
```

- [ ] **Step 4: Implement the mapping**

In `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts`:

```ts
/**
 * Bucket an `E2EEPluginError.code` for display. Unknown codes read as
 * 'unreadable' rather than guessing at a key problem — claiming a cause we
 * have not established is exactly the bug this replaces.
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

There are **two** security contexts built on the failure path, and both need the
field. Note the file already has a local named `failureReason` holding the error
*message*; the new local is `failureCode`, so there is no collision.

In the `catch` block (~line 253), capture the code once, beside the existing
`failureReason = …` assignment:

```ts
    failureReason = err instanceof Error ? err.message : String(err)
    const failureCode = isE2EEPluginError(err) ? err.code : undefined
```

Hoist `failureCode` to the same scope as `failureReason` so the later block can
read it.

**Branch 1 — signature rejection** (~line 256, `trust: 'rejected'`). This is the
only place `signature-invalid` is produced:

```ts
      securityContext = {
        protocolId: claim.plugin.descriptor.id,
        trust: 'rejected',
        failureReason: decryptFailureReasonFor(failureCode),
        notes: [failureReason],
      }
```

**Branch 2 — decrypt failure** (~line 328, `trust: 'untrusted'`):

```ts
      securityContext = {
        protocolId: claim.plugin.descriptor.id,
        trust: 'untrusted',
        failureReason: decryptFailureReasonFor(failureCode),
        notes: [ /* unchanged */ ],
      }
```

- [ ] **Step 4b: Put the exact code in the diagnostic log**

The `getDiagnosticLogger().warn(…)` call at ~line 274 already logs the error
*message* on every failure, but not the code — and the code is what triage needs
to grep for. Append it to that template literal:

```ts
        }): [${failureCode ?? 'no-code'}] ${failureReason}`,
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts 2>&1 | tail -8
```

Expected: PASS.

- [ ] **Step 6: Add the new export to the app's SDK mock**

Per the repo's testing pattern, a new SDK export used by the app must be added to `apps/fluux/src/test-setup.ts`'s `vi.mock('@fluux/sdk', …)` via the `importOriginal` spread. Confirm `DecryptFailureReason` is type-only — if so, no mock change is needed. Verify:

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && npm run build:sdk >/dev/null && npm run typecheck 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "feat(sdk): carry a typed decrypt failure reason on the security context"
```

---

### Task 6: Placeholder renders the real reason (English)

**Files:**
- Modify: `apps/fluux/src/components/conversation/EncryptedPlaceholder.tsx`
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx:725`
- Modify: `apps/fluux/src/i18n/locales/en.json:528-531`
- Test: `apps/fluux/src/components/conversation/EncryptedPlaceholder.test.tsx` (create)

**Interfaces:**
- Consumes: `MessageSecurityContext.failureReason` from Task 5.
- Produces: `EncryptedPlaceholder` accepts `reason?: DecryptFailureReason`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/EncryptedPlaceholder.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EncryptedPlaceholder } from './EncryptedPlaceholder'

describe('EncryptedPlaceholder', () => {
  it('names a missing key only when the key really is missing', () => {
    render(<EncryptedPlaceholder reason="key-unavailable" />)
    expect(screen.getByText(/key/i)).toBeInTheDocument()
  })

  it('says the signature failed, not that a key is missing', () => {
    render(<EncryptedPlaceholder reason="signature-invalid" />)
    // The control that matters: the old copy claimed a missing key for EVERY
    // failure. If this assertion passes while the component still renders one
    // fixed string, the test is worthless — so assert the absence too.
    expect(screen.getByText(/signature/i)).toBeInTheDocument()
    expect(screen.queryByText(/not available on this device/i)).not.toBeInTheDocument()
  })

  it('falls back to a neutral message for unreadable payloads', () => {
    render(<EncryptedPlaceholder reason="unreadable" />)
    expect(screen.queryByText(/not available on this device/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/components/conversation/EncryptedPlaceholder.test.tsx 2>&1 | tail -20
```

Expected: FAIL — the component renders the same fixed string in all three cases, so the two `queryByText(...).not` assertions fail.

- [ ] **Step 3: Add the English strings**

In `apps/fluux/src/i18n/locales/en.json`, under `chat.encryption`, **remove** `couldNotDecryptTooltip` and add:

```json
"couldNotDecryptKeyUnavailableTooltip": "Encrypted to a key this device doesn't have",
"couldNotDecryptSignatureTooltip": "The sender's signature could not be trusted, so this message was not shown",
"couldNotDecryptUnreadableTooltip": "This message could not be read"
```

- [ ] **Step 4: Render per reason**

In `EncryptedPlaceholder.tsx`, replace the `EncryptedPlaceholderProps` interface and the final `return` block:

```tsx
export interface EncryptedPlaceholderProps {
  /**
   * Why the message could not be shown. Absent for older stored messages
   * that predate the typed reason — those fall back to the neutral string
   * rather than asserting a cause we do not know.
   */
  reason?: DecryptFailureReason
}
```

```tsx
  const tooltipKey =
    _props.reason === 'key-unavailable'
      ? 'chat.encryption.couldNotDecryptKeyUnavailableTooltip'
      : _props.reason === 'signature-invalid'
        ? 'chat.encryption.couldNotDecryptSignatureTooltip'
        : 'chat.encryption.couldNotDecryptUnreadableTooltip'

  return (
    <Tooltip
      content={t(tooltipKey)}
      position="top"
      className="flex items-center gap-2 text-fluux-muted italic"
    >
      <LockOpen className="size-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{t(tooltipKey)}</span>
    </Tooltip>
  )
```

Rename the parameter from `_props` to `props` throughout, add `import type { DecryptFailureReason } from '@fluux/sdk'`, and drop the now-unused `encryptedCouldNotDecrypt` usage only if nothing else references it (check with `grep -rn encryptedCouldNotDecrypt apps/fluux/src`).

Note: the tooltip mock in `test-setup.ts` drops `content`, so the visible `<span>` — not the tooltip prop — is what the assertions can see. That is why the string is rendered in both places.

- [ ] **Step 5: Pass the reason from the bubble**

`MessageBubble.tsx:725`:

```tsx
            <EncryptedPlaceholder reason={message.securityContext?.failureReason} />
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/fluux && npx vitest run src/components/conversation/EncryptedPlaceholder.test.tsx 2>&1 | tail -10
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Verify no locale key is left dangling**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && grep -rn "couldNotDecryptTooltip" apps/fluux/src | head
```

Expected: no matches outside the 32 not-yet-updated locale files (Task 7).

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components apps/fluux/src/i18n/locales/en.json
git commit -m "fix(e2ee): tell the user why a message could not be shown (#1059)"
```

---

### Task 7: Translate the three strings into the remaining 32 locales

**Files:**
- Modify: `apps/fluux/src/i18n/locales/*.json` (all except `en.json`)

**Interfaces:**
- Consumes: the three keys added to `en.json` in Task 6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Confirm the target list**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && ls apps/fluux/src/i18n/locales/*.json | wc -l
```

Expected: `33`.

- [ ] **Step 2: Translate each locale**

For every locale file except `en.json`: remove `chat.encryption.couldNotDecryptTooltip` and add the three new keys, translated into that language. Do not machine-transliterate the English — write natural copy for each locale, and do not use em-dash connectors.

Edit surgically so unrelated formatting is preserved:

```python
import json, pathlib
p = pathlib.Path("apps/fluux/src/i18n/locales/fr.json")
d = json.loads(p.read_text())
enc = d["chat"]["encryption"]
enc.pop("couldNotDecryptTooltip", None)
enc["couldNotDecryptKeyUnavailableTooltip"] = "Chiffré avec une clé absente de cet appareil"
enc["couldNotDecryptSignatureTooltip"] = "La signature de l'expéditeur n'a pas pu être validée, ce message n'a donc pas été affiché"
enc["couldNotDecryptUnreadableTooltip"] = "Ce message n'a pas pu être lu"
p.write_text(json.dumps(d, ensure_ascii=False, indent=4) + "\n")
```

- [ ] **Step 3: Verify every locale has all three keys and none has the old one**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && python3 - <<'EOF'
import json, pathlib
bad = []
for p in sorted(pathlib.Path("apps/fluux/src/i18n/locales").glob("*.json")):
    enc = json.loads(p.read_text()).get("chat", {}).get("encryption", {})
    missing = [k for k in (
        "couldNotDecryptKeyUnavailableTooltip",
        "couldNotDecryptSignatureTooltip",
        "couldNotDecryptUnreadableTooltip",
    ) if k not in enc]
    if missing or "couldNotDecryptTooltip" in enc:
        bad.append((p.name, missing, "couldNotDecryptTooltip" in enc))
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

### Task 8: Full verification

**Files:** none modified unless a failure surfaces.

- [ ] **Step 1: Regenerate the Gajim vectors and confirm they still pass**

```bash
/private/tmp/claude-501/-Users-mremond-AIProjects-fluux-messenger--claude-worktrees-keen-merkle-225c96/98a041a8-d53a-4f3a-a4e6-14c2a7f5cbcb/scratchpad/gajimenv/bin/python apps/fluux/src/e2ee/fixtures/generate_gajim_ox_vectors.py
cd apps/fluux && npx vitest run src/e2ee/gajimOxInterop.test.ts 2>&1 | tail -10
```

Expected: 5 pass. Regenerating proves the tests pin behaviour and not one frozen ciphertext.

- [ ] **Step 2: Full suite, typecheck, lint, Rust**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && npm run build:sdk >/dev/null && npm run typecheck 2>&1 | tail -5
cd apps/fluux && npx vitest run 2>&1 | tail -8
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96/packages/fluux-sdk && npx vitest run 2>&1 | tail -8
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96/apps/fluux/src-tauri && cargo test 2>&1 | tail -8
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/keen-merkle-225c96 && npx eslint apps/fluux/src packages/fluux-sdk/src 2>&1 | tail -10
```

Expected: typecheck silent, all suites green, eslint clean. Per CLAUDE.md, tests must pass with no stderr before commit.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "test: fix fallout from the signature gate split"
```

---

## Notes for the implementer

**The one thing not to soften.** Task 3 makes an unjudgeable signature render the message. The reason that is safe is that the *forgery* branch stays closed: `!signatureVerified && signerKeyKnown` must keep throwing `signature-failed`. If a test ever needs that branch relaxed to pass, the change is wrong — stop and raise it rather than widening the condition.

**Hollow tests are this repo's recurring defect.** Several assertions in this plan are written as controls — `expect(...).not.toBeInTheDocument()` in Task 6, the `signature-failed` reject in Task 3 — precisely because the positive assertion alone would still pass against the old behaviour. Before marking a step done, break the implementation on purpose and confirm the test actually fails.

**One deliberate deviation from the spec.** The spec's Testing section calls for
a Gajim fixture with a corrupted signature byte as the forgery control. That is
not constructible: modifying the ciphertext trips the AEAD/MDC integrity check
and fails decryption before verification runs, so it would test the wrong thing.
Task 3 Step 2 substitutes a stub at the `decryptWithOwnKey` seam, which pins the
gate — the actual subject — directly. If a later change makes packet-level
splicing available in the vector generator, promote it to a real fixture.

**Backend symmetry.** Tasks 1 and 2 compute the same predicate in two languages. If you change one, change the other in the same commit, and check both test suites. Desktop and web disagreeing about what counts as forgery is the worst outcome this plan can produce.
