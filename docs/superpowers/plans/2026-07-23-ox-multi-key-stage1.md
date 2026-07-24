# OX multi-key — Stage 1 (crypto / interop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OX encryption and decryption multi-key correct — cache every valid announced key, encrypt to all of them plus the account's own announced keyset, verify a signature from any of them — so a multi-client peer (and the reporter's Gajim/Fluux same-account setup, #1059) works. Retire the `pin-mismatch` encrypt block. No trust-set UI (that is Stage 2).

**Architecture:** The peer key cache becomes `Map<BareJID, CachedPeerCert[]>` partitioned into active (announced) and inactive (`inactiveAt`-stamped, verify-only) certs. Encryption fans out over the active peer keyset ∪ the account's own announced keyset (deduped), with fail-closed / degraded rules for incomplete keysets. Decryption/verification accepts a signature from the message's eligible verifier set. The Rust Sequoia layer and the openpgp.js web layer both take arrays of certs.

**Tech Stack:** TypeScript (SDK + app plugin), Rust + Sequoia-PGP (`apps/fluux/src-tauri`), openpgp.js (web plugin), Vitest, `cargo test`, Tauri IPC.

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-07-23-ox-multi-key-design.md`. Every task implements part of it; re-read the referenced section before starting a task.
- **BTBV is a Fluux choice**, not a spec requirement; XEP-0374 §2.3.1 requires using all *valid* announced keys for encryption. Definitively-invalid entries (fp mismatch, UID mismatch, **no usable encryption subkey**) are excluded — never a recipient.
- **Terminology:** `announcedKeys`, never `deviceKeys`; "key"/"keyset", never "device", in any user-facing string.
- **Never** silently fall back to plaintext for an incomplete/rejected keyset.
- **TDD, control-checked.** Break checks are necessary but insufficient (a hollow test survived one in #1064). For each new test, after it passes, neuter the exact production line it targets, confirm the test fails, then revert. This is a required step, not optional.
- **Tests must be pristine** — no stderr, no unhandled-rejection noise. `npm run typecheck` and `npm run lint` clean before every commit.
- **Commit signing:** SSH-signed; run `ssh-add` first. If signing is broken this session, use `--no-gpg-sign` (pre-approved) and push over HTTPS.
- **Worktree:** work happens in this worktree (`.claude/worktrees/hopeful-mendel-cd5eb5`). If `@fluux/sdk` doesn't resolve, run `npm install` **in the worktree**, then `npm run build:sdk`.
- **SDK type change → `npm run build:sdk` before app typecheck.**
- **Already landed on this branch (PR-A):** `oxPublicKeysList.ts` + merge-on-publish. Do not redo it.

---

## File structure

| File | Responsibility (Stage 1) |
|---|---|
| `apps/fluux/src/e2ee/peerCertCache.ts` *(new)* | Pure `CachedPeerCert` model + serialize/deserialize/migrate + partition/eligibility helpers. No plugin state. |
| `apps/fluux/src/e2ee/peerCertCache.test.ts` *(new)* | Unit tests for the above. |
| `apps/fluux/src-tauri/src/openpgp.rs` | `encrypt_and_sign` / `decrypt_and_verify` take cert **arrays**; Tauri commands take `Vec<String>`. |
| `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` | Cache → `CachedPeerCert[]`; refresh classification + metadata freshness; encrypt fan-out; decrypt verifier set; abstract `encryptToRecipients`/array-`decryptWithOwnKey`; retire pin gate; minimal trust-bake adaptation. |
| `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts` | Array-shaped invoke wrappers. |
| `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` | openpgp.js array-shaped encrypt/verify (web parity). |
| `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts` | Mock `invoke` array shapes; multi-key + signature-status + #1059 fixtures. |
| `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts` | Web multi-key parity (real openpgp.js keys). |
| `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts` | Integration: a transient encrypt failure propagates (no silent plaintext downgrade). |

### Shared interfaces introduced in Stage 1 (used across tasks)

```ts
// peerCertCache.ts — self-contained; does NOT import from OpenPGPPluginBase (no layering cycle).
export interface PeerBundleInput {          // the fields upsert needs from a validated fetch
  fingerprint: string
  publicArmored: string
  keychainBacked: boolean
  createdAt?: string
}
export interface CachedPeerCert extends PeerBundleInput {
  active: boolean          // true = still announced (an encryption recipient)
  inactiveAt?: string      // ISO 8601; set when the key left the announced set
}
```

`KeyBundle` in `OpenPGPPluginBase.ts` is structurally a `PeerBundleInput`, so plugin code passes a `KeyBundle` wherever a `PeerBundleInput` is expected — no import from the plugin into the pure module.

Plugin cache field: `private readonly peerKeys = new Map<BareJID, CachedPeerCert[]>()`.

**Signature status (blocking #1).** The crypto layer must distinguish "we hold the signer's cert but the signature is bad" (a real forgery → permanent) from "we don't hold the signer's cert" (uncached device → refresh + defer). Rust `DecryptOutput` gains a `signature_status` field; the TS `DecryptOutput` gains:

```ts
// added to the existing DecryptOutput interface (OpenPGPPluginBase.ts)
signatureStatus: 'none' | 'verified' | 'bad' | 'missing-key'
// 'none'        no signature packet present
// 'verified'    signature verified against a supplied cert
// 'bad'         a supplied cert matches the signer but the signature is invalid → permanent
// 'missing-key' a signature is present but no supplied cert is its signer → refresh + defer
```

`signaturePresent`/`signatureVerified`/`signerFingerprint` are retained (backward compatible: `signaturePresent = status !== 'none'`, `signatureVerified = status === 'verified'`). **`signerFingerprint` is set ONLY for a `'verified'` signature, and is the signing key's cert PRIMARY fingerprint** (what trust comparison needs). For `'missing-key'`/`'bad'`/`'none'` it is `null` — a `'missing-key'` result refetches the whole announced keyset, so no issuer hint is needed (and an OpenPGP issuer key ID is not a primary fingerprint anyway).

Rust:
- `fn encrypt_and_sign(recipient_public_armored: &[String], sender_secret_armored: &str, plaintext: &str) -> Result<String>` — a malformed recipient armored key is a **hard error** (never silently dropped; dropping = a recipient silently can't read).
- `fn decrypt_and_verify(ciphertext: &[u8], secret_armored: &str, senders: Vec<Cert>, policy: &StandardPolicy) -> Result<DecryptOutput>` — a malformed **sender** cert is logged and skipped (do NOT abort: the other supplied certs may still verify the message).
- Tauri: `openpgp_encrypt(recipient_public_armored: Vec<String>, …)`, `openpgp_decrypt(sender_public_armored: Vec<String>, …)`

Plugin abstract crypto:
- `encryptToRecipients(accountJid: string, recipientPublics: string[], plaintext: string): Promise<string>`
- `decryptWithOwnKey(accountJid: string, ciphertext: string, senderPublics: string[]): Promise<DecryptOutput>`

`PendingVerification` (OpenPGPPluginBase.ts ~238) gains `receivedAt: string` (ISO 8601) so a deferred re-verify can apply the receipt-time eligibility rule (blocking #4).

**Capability on transient failure (blocking #2).** `probePeer`/`refetchAndCachePeerKey` return `supported: true` on a transient metadata failure **when there is prior evidence the peer supports OX** (any cached cert, active or inactive, or a prior successful probe), so `E2EEManager.selectStrategy` still picks OX and `encrypt()` runs and throws `peer-keyset-incomplete` — which `encryptOutbound` re-throws (never a silent plaintext downgrade). Only with *no* prior evidence is `supported: false` returned.

New transient error code (thrown as `E2EEPluginError('transient', code, msg)`): `peer-keyset-incomplete`. (An incomplete *own* keyset never throws its own code — for a normal peer it sends degraded, and for self-chat `peer === ownBareJid` so it surfaces as `peer-keyset-incomplete`.)

---

## Task 1: `CachedPeerCert` model + cache serialization/migration (pure)

Re-read spec §Model, §"Known validated certificates", §"Retained certs".

**Files:**
- Create: `apps/fluux/src/e2ee/peerCertCache.ts`
- Test: `apps/fluux/src/e2ee/peerCertCache.test.ts`

**Interfaces:**
- Produces: `PeerBundleInput`, `CachedPeerCert` (above); `serializePeerCache(map): string`; `deserializePeerCache(json): Map<string, CachedPeerCert[]>` (migrates legacy `[jid, KeyBundle]` pairs → `[jid, [active cert]]`, **normalizes fingerprints and discards malformed entries**); `activePublics(certs): string[]`; `activeFingerprints(certs): string[]`; `eligibleVerifierPublics(certs, msg: { messageTime?: Date }, toleranceMs: number): string[]` — `messageTime` is the archive timestamp for a MAM message or the original `receivedAt` for a deferred one; absent (live) ⇒ active only; `upsertActive(certs, bundle: PeerBundleInput): CachedPeerCert[]`; `markDepartedInactive(certs, stillAnnouncedFps: Set<string>, nowIso: string): CachedPeerCert[]`; `capUnverifiedInactive(certs, isVerified: (fp: string) => boolean, cap: number): CachedPeerCert[]`.
- Fingerprints are stored canonicalized via `toXep0373Fingerprint` (upper, matches the advertised form) and compared via `fingerprintsEqual`, both from `./fingerprintCompare` (pure module, no cycle).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fluux/src/e2ee/peerCertCache.test.ts
import { describe, it, expect } from 'vitest'
import {
  type CachedPeerCert,
  serializePeerCache,
  deserializePeerCache,
  activePublics,
  activeFingerprints,
  eligibleVerifierPublics,
  upsertActive,
  markDepartedInactive,
  capUnverifiedInactive,
} from './peerCertCache'

const cert = (fp: string, over: Partial<CachedPeerCert> = {}): CachedPeerCert => ({
  fingerprint: fp,
  publicArmored: `ARMOR:${fp}`,
  keychainBacked: false,
  active: true,
  ...over,
})

describe('peerCertCache', () => {
  it('round-trips an array-shaped cache', () => {
    const map = new Map([['bob@x', [cert('A'), cert('B', { active: false, inactiveAt: '2026-01-01T00:00:00.000Z' })]]])
    expect(deserializePeerCache(serializePeerCache(map))).toEqual(map)
  })

  it('migrates a legacy [jid, KeyBundle] pair cache to one active cert', () => {
    const legacy = JSON.stringify([['bob@x', { fingerprint: 'A', publicArmored: 'ARMOR:A', keychainBacked: false }]])
    const out = deserializePeerCache(legacy)
    expect(out.get('bob@x')).toEqual([cert('A')])
  })

  it('exposes only active certs to encryption', () => {
    const certs = [cert('A'), cert('B', { active: false, inactiveAt: '2026-01-01T00:00:00.000Z' })]
    expect(activePublics(certs)).toEqual(['ARMOR:A'])
    expect(activeFingerprints(certs)).toEqual(['A'])
  })

  it('adds an inactive cert to the verifier set only for a message-time before inactiveAt', () => {
    const inactiveAt = '2026-03-01T00:00:00.000Z'
    const certs = [cert('A'), cert('B', { active: false, inactiveAt })]
    // Live message (no messageTime): active only.
    expect(eligibleVerifierPublics(certs, {}, 0)).toEqual(['ARMOR:A'])
    // Message-time BEFORE inactiveAt (archive OR deferred-receipt): inactive B eligible.
    expect(
      eligibleVerifierPublics(certs, { messageTime: new Date('2026-02-01T00:00:00Z') }, 0),
    ).toEqual(['ARMOR:A', 'ARMOR:B'])
    // Message-time AFTER inactiveAt: B not eligible.
    expect(
      eligibleVerifierPublics(certs, { messageTime: new Date('2026-04-01T00:00:00Z') }, 0),
    ).toEqual(['ARMOR:A'])
  })

  it('normalizes fingerprints and discards malformed entries on deserialize', () => {
    const json = JSON.stringify([
      ['bob@x', [{ fingerprint: 'aabb', publicArmored: 'ARMOR:aabb', keychainBacked: false, active: true }]],
      ['evil@x', [{ publicArmored: 'no-fingerprint', keychainBacked: false, active: true }]], // dropped
      ['nul@x', 'not-an-array'], // dropped
    ])
    const out = deserializePeerCache(json)
    expect(out.get('bob@x')![0].fingerprint).toBe('AABB') // normalized to canonical upper
    expect(out.has('evil@x')).toBe(false)
    expect(out.has('nul@x')).toBe(false)
  })

  it('upsert replaces an existing fingerprint and reactivates it', () => {
    const certs = [cert('A', { active: false, inactiveAt: '2026-01-01T00:00:00.000Z' })]
    const out = upsertActive(certs, { fingerprint: 'A', publicArmored: 'ARMOR:A2', keychainBacked: false })
    expect(out).toEqual([cert('A', { publicArmored: 'ARMOR:A2' })])
  })

  it('marks a departed fingerprint inactive without deleting it', () => {
    const certs = [cert('A'), cert('B')]
    const out = markDepartedInactive(certs, new Set(['A']), '2026-05-01T00:00:00.000Z')
    expect(out).toEqual([cert('A'), cert('B', { active: false, inactiveAt: '2026-05-01T00:00:00.000Z' })])
  })

  it('LRU-caps unverified inactive certs but keeps verified ones', () => {
    const inactive = (fp: string, at: string) => cert(fp, { active: false, inactiveAt: at })
    const certs = [
      cert('ACT'),
      inactive('V', '2026-01-01T00:00:00.000Z'),   // verified — always kept
      inactive('U1', '2026-02-01T00:00:00.000Z'),
      inactive('U2', '2026-03-01T00:00:00.000Z'),
      inactive('U3', '2026-04-01T00:00:00.000Z'),
    ]
    const out = capUnverifiedInactive(certs, (fp) => fp === 'V', 1)
    // Active + verified-inactive kept; only the newest unverified inactive (U3) survives the cap of 1.
    expect(out.map((c) => c.fingerprint)).toEqual(['ACT', 'V', 'U3'])
  })
})
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd apps/fluux && npx vitest run src/e2ee/peerCertCache.test.ts`
Expected: FAIL — `Cannot find module './peerCertCache'`.

- [ ] **Step 3: Implement `peerCertCache.ts`**

```ts
// apps/fluux/src/e2ee/peerCertCache.ts
/**
 * Pure model + helpers for the per-peer set of known validated certificates.
 *
 * A peer JID owns a *set* of announced OX keys (XEP-0373). We keep every cert
 * we have fetched and validated, partitioned by an `active` flag: active certs
 * are still announced (encryption recipients); inactive certs left the announced
 * set (stamped `inactiveAt`) and are retained for verification of *eligible
 * archived* messages only — never for encryption, never for new live traffic.
 * See docs/superpowers/specs/2026-07-23-ox-multi-key-design.md.
 */
import { toXep0373Fingerprint } from './fingerprintCompare'

export interface PeerBundleInput {
  fingerprint: string
  publicArmored: string
  keychainBacked: boolean
  createdAt?: string
}
export interface CachedPeerCert extends PeerBundleInput {
  active: boolean
  inactiveAt?: string
}

export function serializePeerCache(map: Map<string, CachedPeerCert[]>): string {
  return JSON.stringify([...map.entries()])
}

/** True when a value is a usable cert record (has a non-empty fp + armored key). */
function sanitizeCert(raw: unknown, active: boolean): CachedPeerCert | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.fingerprint !== 'string' || r.fingerprint.trim() === '') return null
  if (typeof r.publicArmored !== 'string' || r.publicArmored.trim() === '') return null
  return {
    fingerprint: toXep0373Fingerprint(r.fingerprint), // canonicalize (upper, no whitespace)
    publicArmored: r.publicArmored,
    keychainBacked: r.keychainBacked === true,
    ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
    active: typeof r.active === 'boolean' ? r.active : active,
    ...(typeof r.inactiveAt === 'string' ? { inactiveAt: r.inactiveAt } : {}),
  }
}

/**
 * Parse the cache, migrating the pre-Stage-1 `[jid, KeyBundle]` shape, and
 * treating localStorage as untrusted: normalize fingerprints, discard any
 * entry that is not a well-formed cert record or JID pair.
 */
export function deserializePeerCache(json: string): Map<string, CachedPeerCert[]> {
  const out = new Map<string, CachedPeerCert[]>()
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
    const [jid, value] = entry
    let certs: CachedPeerCert[] | null = null
    if (Array.isArray(value)) {
      certs = value.map((c) => sanitizeCert(c, true)).filter((c): c is CachedPeerCert => c !== null)
    } else {
      const migrated = sanitizeCert(value, true) // legacy single KeyBundle
      certs = migrated ? [migrated] : null
    }
    if (certs && certs.length > 0) out.set(jid, certs)
  }
  return out
}

export function activePublics(certs: CachedPeerCert[]): string[] {
  return certs.filter((c) => c.active).map((c) => c.publicArmored)
}

export function activeFingerprints(certs: CachedPeerCert[]): string[] {
  return certs.filter((c) => c.active).map((c) => c.fingerprint)
}

/**
 * The verifier set for a message: active certs always, plus any inactive cert
 * eligible under the archive-time policy — a message whose `messageTime`
 * predates the cert's `inactiveAt` (± tolerance). `messageTime` is the MAM
 * archive timestamp for an archived message or the original `receivedAt` for a
 * deferred one. A live message (no `messageTime`) gets active certs only, so a
 * retired key never authenticates fresh traffic. Note this eligibility is not
 * cryptographic proof of age — a server-provided/backdatable timestamp — so it
 * narrows, not eliminates, the window (see spec §Retained certs).
 */
export function eligibleVerifierPublics(
  certs: CachedPeerCert[],
  msg: { messageTime?: Date },
  toleranceMs: number,
): string[] {
  const out: string[] = []
  for (const c of certs) {
    if (c.active) {
      out.push(c.publicArmored)
      continue
    }
    if (!msg.messageTime || !c.inactiveAt) continue
    if (msg.messageTime.getTime() < new Date(c.inactiveAt).getTime() + toleranceMs) {
      out.push(c.publicArmored)
    }
  }
  return out
}

/** Upsert a freshly-validated announced cert: replace by fingerprint, mark active. */
export function upsertActive(certs: CachedPeerCert[], bundle: PeerBundleInput): CachedPeerCert[] {
  const fp = toXep0373Fingerprint(bundle.fingerprint)
  const next = certs.filter((c) => c.fingerprint !== fp)
  next.push({ ...bundle, fingerprint: fp, active: true })
  return next
}

/** Mark every cert whose fingerprint is no longer announced inactive (retain it). */
export function markDepartedInactive(
  certs: CachedPeerCert[],
  stillAnnouncedFps: Set<string>,
  nowIso: string,
): CachedPeerCert[] {
  return certs.map((c) =>
    c.active && !stillAnnouncedFps.has(c.fingerprint)
      ? { ...c, active: false, inactiveAt: nowIso }
      : c,
  )
}

/** Keep all active + verified certs; LRU-cap unverified inactive certs by `inactiveAt`. */
export function capUnverifiedInactive(
  certs: CachedPeerCert[],
  isVerified: (fp: string) => boolean,
  cap: number,
): CachedPeerCert[] {
  const keep: CachedPeerCert[] = []
  const unverifiedInactive: CachedPeerCert[] = []
  for (const c of certs) {
    if (c.active || isVerified(c.fingerprint)) keep.push(c)
    else unverifiedInactive.push(c)
  }
  unverifiedInactive.sort((a, b) => (a.inactiveAt ?? '').localeCompare(b.inactiveAt ?? ''))
  const survivors = unverifiedInactive.slice(-cap)
  // Preserve original order.
  const survivorSet = new Set(survivors)
  return certs.filter((c) => keep.includes(c) || survivorSet.has(c))
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd apps/fluux && npx vitest run src/e2ee/peerCertCache.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Control-check the eligibility gate + the sanitizer**

In `eligibleVerifierPublics`, temporarily replace the `if (!msg.messageTime || !c.inactiveAt) continue` line with nothing plus an unconditional `out.push(c.publicArmored)` for inactive certs. Run the test: the live-message and message-after cases must FAIL. Revert. Then, in `sanitizeCert`, temporarily `return raw as CachedPeerCert` (skip validation): the "discards malformed entries" test must FAIL. Revert.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/e2ee/peerCertCache.ts apps/fluux/src/e2ee/peerCertCache.test.ts
git commit -m "feat(e2ee): add CachedPeerCert model + active/inactive keyset helpers"
```

---

## Task 2: Rust `encrypt_and_sign` takes a recipient list

Re-read spec §"Rust (openpgp.rs)" and §Encrypt.

**Files:**
- Modify: `apps/fluux/src-tauri/src/openpgp.rs` (`encrypt_and_sign` ~1153; `openpgp_encrypt` command ~734; `OpenpgpState::encrypt` ~305)
- Test: `apps/fluux/src-tauri/src/openpgp.rs` (`#[cfg(test)]` module)

**Interfaces:**
- Produces: `fn encrypt_and_sign(recipient_public_armored: &[String], sender_secret_armored: &str, plaintext: &str) -> Result<String>`; command `openpgp_encrypt(recipient_public_armored: Vec<String>, …)`.

- [ ] **Step 1: Write the failing Rust test**

Add to the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn encrypts_to_two_recipients_each_can_decrypt() {
    let policy = StandardPolicy::new();
    let a = generate_cert("xmpp:a@example.com").unwrap();
    let b = generate_cert("xmpp:b@example.com").unwrap();
    let signer = generate_cert("xmpp:me@example.com").unwrap();

    let a_pub = armored_string(&published_cert(&a), KeyExport::Public).unwrap();
    let b_pub = armored_string(&published_cert(&b), KeyExport::Public).unwrap();
    let signer_secret = armored_string(&signer, KeyExport::Secret).unwrap();

    let ct = encrypt_and_sign(&[a_pub, b_pub], &signer_secret, "hello").unwrap();

    // Each recipient decrypts independently, verifying against the signer.
    for recipient in [&a, &b] {
        let secret = armored_string(recipient, KeyExport::Secret).unwrap();
        let out = decrypt_and_verify(
            ct.as_bytes(),
            &secret,
            vec![published_cert(&signer)],
            &policy,
        )
        .unwrap();
        assert_eq!(String::from_utf8(out.plaintext).unwrap(), "hello");
        assert!(out.signature_verified);
    }
}
```

- [ ] **Step 2: Run it, verify it fails to compile / fail**

Run: `cd apps/fluux/src-tauri && cargo test encrypts_to_two_recipients -- --nocapture`
Expected: FAIL — `encrypt_and_sign` expects `&str`, not `&[String]` (type error), and `decrypt_and_verify` signature differs (Task 3 aligns it; for now expect a compile error naming these).

- [ ] **Step 3: Change `encrypt_and_sign` to take a slice**

Replace the signature and the recipient-collection preamble:

```rust
fn encrypt_and_sign(
    recipient_public_armored: &[String],
    sender_secret_armored: &str,
    plaintext: &str,
) -> Result<String> {
    let policy = StandardPolicy::new();
    let sender_cert =
        Cert::from_bytes(sender_secret_armored.as_bytes()).context("parse sender secret key")?;

    let mut recipients: Vec<Recipient> = Vec::new();
    for armored in recipient_public_armored {
        // Hard error on a malformed recipient — silently dropping one means that
        // recipient can never read the message (a silent security downgrade).
        let cert = Cert::from_bytes(armored.as_bytes())
            .context("parse recipient public key (multi-recipient encrypt)")?;
        recipients.extend(
            cert.keys()
                .with_policy(&policy, None)
                .supported()
                .alive()
                .revoked(false)
                .for_transport_encryption()
                .map(Recipient::from),
        );
    }

    // Encrypt-to-self: the sender's own encryption subkeys, so this device (and
    // MAM replay) can read outgoing messages. (Sibling own-account keys are
    // added by the caller as additional recipients — see OpenPGPPluginBase.)
    recipients.extend(
        sender_cert
            .keys()
            .with_policy(&policy, None)
            .supported()
            .alive()
            .revoked(false)
            .for_transport_encryption()
            .map(Recipient::from),
    );

    // Dedup by key handle IN RUST — TS-side string dedup cannot remove the local
    // cert, which we re-append above for encrypt-to-self and which is also present
    // in the own-announced keyset the caller passes when peer JID == account JID.
    // Verify this Sequoia version exposes `Recipient::key_id()`; if it does:
    let mut seen = std::collections::HashSet::new();
    recipients.retain(|r| seen.insert(r.key_id()));
    // If `Recipient` does NOT expose a key id/handle in this version, dedup the
    // encryption-capable KEYS by fingerprint BEFORE mapping to `Recipient` instead
    // (collect the `ValidKeyAmalgamation`s into a fingerprint-keyed set, then
    // `.map(Recipient::from)`), so the `recipients` vec is unique by construction.

    if recipients.is_empty() {
        return Err(anyhow!("no usable encryption-capable recipient key"));
    }
    // ... signer_keypair selection + streaming encryption unchanged below ...
```

Keep the rest of the function body (signer keypair, `Encryptor`, `LiteralWriter`, streaming) unchanged.

- [ ] **Step 4: Update `OpenpgpState::encrypt` and the `openpgp_encrypt` command to pass `Vec<String>`**

In `OpenpgpState::encrypt` (~305), change the recipient parameter to `recipient_public_armored: &[String]` and forward it. In the command:

```rust
#[tauri::command]
pub fn openpgp_encrypt(
    state: tauri::State<'_, Arc<OpenpgpState>>,
    account_jid: String,
    recipient_public_armored: Vec<String>,
    plaintext: String,
) -> Result<String, String> {
    state.encrypt(&account_jid, &recipient_public_armored, &plaintext)
}
```

- [ ] **Step 5: Run the test**

Run: `cd apps/fluux/src-tauri && cargo test encrypts_to_two_recipients`
Expected: PASS (after Task 3's `decrypt_and_verify` signature is in place; if Task 3 is not yet done, do Steps 1–4 of Task 3 first — they are one compile unit. Commit them together in Task 3 Step 6.)

- [ ] **Step 6: Control-check**

Change `for armored in recipient_public_armored` to iterate only `.first()` (single recipient). The two-recipient test must FAIL (the second recipient can't decrypt). Revert.

*(Commit is combined with Task 3 — same compile unit.)*

---

## Task 3: Rust `decrypt_and_verify` accepts a sender list

Re-read spec §"Rust (openpgp.rs)" and §Decrypt.

**Files:**
- Modify: `apps/fluux/src-tauri/src/openpgp.rs` (`decrypt_and_verify` ~1234; `VerifyHelper::get_certs` ~1301; `OpenpgpState::decrypt` ~319; `openpgp_decrypt` command ~744)
- Test: same file's test module.

**Interfaces:**
- Consumes: Task 2's `encrypt_and_sign(&[String], …)`.
- Produces: `fn decrypt_and_verify(ciphertext: &[u8], secret_armored: &str, senders: Vec<Cert>, policy: &StandardPolicy) -> Result<DecryptOutput>`; command `openpgp_decrypt(sender_public_armored: Vec<String>, …)`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn verifies_signature_from_any_of_several_sender_certs() {
    let policy = StandardPolicy::new();
    let recipient = generate_cert("xmpp:me@example.com").unwrap();
    let signer = generate_cert("xmpp:peer@example.com").unwrap();
    let decoy = generate_cert("xmpp:decoy@example.com").unwrap();

    let recipient_pub = armored_string(&published_cert(&recipient), KeyExport::Public).unwrap();
    let signer_secret = armored_string(&signer, KeyExport::Secret).unwrap();
    let recipient_secret = armored_string(&recipient, KeyExport::Secret).unwrap();

    let ct = encrypt_and_sign(&[recipient_pub], &signer_secret, "hi").unwrap();

    // Sender list contains the real signer among decoys, in any order.
    let out = decrypt_and_verify(
        ct.as_bytes(),
        &recipient_secret,
        vec![published_cert(&decoy), published_cert(&signer)],
        &policy,
    )
    .unwrap();
    assert_eq!(String::from_utf8(out.plaintext).unwrap(), "hi");
    assert_eq!(out.signature_status, "verified");
    assert_eq!(out.signer_fingerprint.unwrap(), signer.fingerprint().to_hex());
}

#[test]
fn signer_key_not_supplied_reports_missing_key() {
    // The real signer's cert is NOT among the supplied senders → 'missing-key'
    // (an uncached device, must refresh + defer), NOT 'bad'. No fingerprint is
    // returned — only a verified signature yields one.
    let policy = StandardPolicy::new();
    let recipient = generate_cert("xmpp:me@example.com").unwrap();
    let signer = generate_cert("xmpp:peer@example.com").unwrap();
    let decoy = generate_cert("xmpp:decoy@example.com").unwrap();
    let recipient_pub = armored_string(&published_cert(&recipient), KeyExport::Public).unwrap();
    let signer_secret = armored_string(&signer, KeyExport::Secret).unwrap();
    let recipient_secret = armored_string(&recipient, KeyExport::Secret).unwrap();
    let ct = encrypt_and_sign(&[recipient_pub], &signer_secret, "hi").unwrap();

    let out = decrypt_and_verify(ct.as_bytes(), &recipient_secret, vec![published_cert(&decoy)], &policy).unwrap();
    assert_eq!(out.signature_status, "missing-key");
    assert!(out.signer_fingerprint.is_none());
}

#[test]
fn expired_signature_from_a_supplied_signer_reports_bad() {
    // A ciphertext's integrity protection (SEIPD/MDC) catches any byte-tampering
    // before signature check, so tampering can't reliably produce a 'bad' (it
    // errors the decrypt). Instead produce a signature that is cryptographically
    // well-formed but policy-INVALID at verify time: sign at time T with a short
    // signature expiration, then verify after it has expired. The signer's cert
    // IS supplied, so Sequoia reports an Err (not MissingKey) → status 'bad'.
    //
    // Extend the existing `sign_encrypt_at(recipient_public_armored: &str,
    // sender_secret_armored: &str, plaintext: &str, signed_at: SystemTime)` helper
    // with a `sig_validity: Option<Duration>` param that calls
    // `SignatureBuilder::set_signature_validity_period(..)`. Keep its armored-string
    // interface. (Or add a sibling `sign_encrypt_with_validity` alongside it.)
    let policy = StandardPolicy::new();
    let recipient = generate_cert("xmpp:me@example.com").unwrap();
    let signer = generate_cert("xmpp:peer@example.com").unwrap();
    let recipient_pub = armored_string(&published_cert(&recipient), KeyExport::Public).unwrap();
    let signer_secret = armored_string(&signer, KeyExport::Secret).unwrap();
    let recipient_secret = armored_string(&recipient, KeyExport::Secret).unwrap();

    // Signed one hour ago with a 1-second validity → expired at verify time (now).
    let signed_at = SystemTime::now() - Duration::from_secs(3600);
    let ct = sign_encrypt_at(&recipient_pub, &signer_secret, "payload", signed_at, Some(Duration::from_secs(1))).unwrap();
    let out = decrypt_and_verify(ct.as_bytes(), &recipient_secret, vec![published_cert(&signer)], &policy).unwrap();
    // Cert supplied + signature invalid at verify time ⇒ Err(_) (not MissingKey) ⇒ 'bad'.
    assert_eq!(out.signature_status, "bad");
}
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/fluux/src-tauri && cargo test verifies_signature_from_any -- --nocapture`
Expected: FAIL — `decrypt_and_verify` takes `Option<Cert>`, not `Vec<Cert>`.

- [ ] **Step 3: Widen `decrypt_and_verify` + `VerifyHelper` + add `signature_status`**

Add `signature_status: String` to the `DecryptOutput` struct (serde-renamed to `signatureStatus`), and to the helper a `signature_status: Arc<Mutex<&'static str>>` (default `"none"`). **Do not** add a claimed-issuer field: an OpenPGP signature carries only an issuer *key ID* (or a subkey fingerprint), not the primary cert fingerprint that `signerFingerprint` must hold for `fingerprintsEqual`/trust lookup — and a `missing-key` result refetches the *whole* announced keyset anyway, so no targeting hint is needed.

```rust
fn decrypt_and_verify(
    ciphertext: &[u8],
    secret_armored: &str,
    senders: Vec<Cert>,
    policy: &StandardPolicy,
) -> Result<DecryptOutput> {
    // ... existing secret-cert parse ...
    let helper = Helper {
        policy,
        secret: &secret_cert,
        senders,                       // was: sender: Option<Cert>
        signature_present: Arc::new(Mutex::new(false)),
        signature_status: Arc::new(Mutex::new("none")),
        verified_fingerprint: Arc::new(Mutex::new(None)),
        // ... unchanged ...
    };
    // ... existing DecryptorBuilder / stream read unchanged ...
    // After the stream read, assemble the output:
    let status = *helper.signature_status.lock().unwrap();
    let verified_fp = helper.verified_fingerprint.lock().unwrap().clone();
    Ok(DecryptOutput {
        plaintext,
        signature_present: status != "none",
        signature_verified: status == "verified",
        // Only a VERIFIED signature yields a fingerprint — and it is the signing
        // key's cert PRIMARY fingerprint (`verification.ka.cert().fingerprint()`),
        // which is what trust comparison expects. 'missing-key' → None.
        signer_fingerprint: verified_fp.map(|fp| fp.to_hex()),
        signature_status: status.to_string(),
    })
}
```

In `get_certs`, return all supplied senders:

```rust
fn get_certs(&mut self, _ids: &[KeyHandle]) -> openpgp::Result<Vec<Cert>> {
    Ok(self.senders.clone())
}
```

Rewrite `check` to record the status even on failure. Sequoia's `VerificationError` distinguishes `MissingKey` (we hold no cert for this signer) from `BadSignature`/`BadKey`/`MalformedSignature` (we hold the signer's cert but the signature is invalid):

```rust
fn check(&mut self, structure: MessageStructure) -> openpgp::Result<()> {
    use openpgp::parse::stream::VerificationError;
    for layer in structure.iter() {
        if let MessageLayer::SignatureGroup { results } = layer {
            for result in results {
                *self.signature_present.lock().unwrap() = true;
                match result {
                    Ok(verification) => {
                        let fp = verification.ka.cert().fingerprint();
                        *self.verified_fingerprint.lock().unwrap() = Some(fp);
                        *self.signature_status.lock().unwrap() = "verified";
                        return Ok(());
                    }
                    Err(VerificationError::MissingKey { .. }) => {
                        // We hold no cert for this signer (an uncached device).
                        // Do not downgrade a prior 'bad' to 'missing-key'.
                        let mut s = self.signature_status.lock().unwrap();
                        if *s == "none" { *s = "missing-key"; }
                    }
                    Err(_) => {
                        // BadSignature / BadKey / MalformedSignature: we hold the
                        // signer's cert but the signature is invalid → forgery.
                        *self.signature_status.lock().unwrap() = "bad";
                    }
                }
            }
        }
    }
    Ok(())
}
```

(Only the verified branch reads a fingerprint — `verification.ka.cert().fingerprint()`, the signing key's cert primary fingerprint. The failure branches record only the status, so no issuer/key-ID extraction is needed.)

- [ ] **Step 4: Update `OpenpgpState::decrypt` + command to build the sender `Vec<Cert>`**

`OpenpgpState::decrypt` takes `sender_public_armored: &[String]`, parses each into a `Cert`. A malformed **sender** cert is **logged and skipped** — NOT a hard error, because the other supplied certs may still verify the message (aborting would fail a verifiable message). (With Task 1's deserialize sanitizer, malformed certs should not reach here; this is defense in depth.)

```rust
let mut senders: Vec<Cert> = Vec::new();
for a in sender_public_armored {
    match Cert::from_bytes(a.as_bytes()) {
        Ok(cert) => senders.push(cert),
        Err(e) => log::warn!("skipping malformed sender cert during decrypt: {e}"),
    }
}
```

Command:

```rust
#[tauri::command]
pub fn openpgp_decrypt(
    state: tauri::State<'_, Arc<OpenpgpState>>,
    account_jid: String,
    ciphertext: String,
    sender_public_armored: Vec<String>,
) -> Result<DecryptOutput, String> {
    state.decrypt(&account_jid, &ciphertext, &sender_public_armored)
}
```

- [ ] **Step 5: Run both new tests + the Task 2 test + the existing suite**

Run: `cd apps/fluux/src-tauri && cargo test openpgp`
Expected: PASS, including `encrypts_to_two_recipients_each_can_decrypt`, `verifies_signature_from_any_of_several_sender_certs`, `signer_key_not_supplied_reports_missing_key`, `expired_signature_from_a_supplied_signer_reports_bad`, and all pre-existing openpgp tests.

- [ ] **Step 6: Control-check all three status paths, then commit**

In `get_certs`, temporarily return `Ok(vec![])`: `verifies_signature_from_any…` must FAIL (and note `signer_key_not_supplied…` still passes — its senders were decoys anyway). Revert. In the `check` callback, temporarily map `MissingKey` to `"bad"`: `signer_key_not_supplied_reports_missing_key…` must FAIL. Revert. In `encrypt_and_sign`, temporarily `.first()`-only the recipients: `encrypts_to_two_recipients…` must FAIL. Revert.

```bash
git add apps/fluux/src-tauri/src/openpgp.rs
git commit -m "feat(e2ee): Rust encrypt/decrypt take cert arrays (multi-recipient, multi-signer)"
```

---

## Task 4: Array-shaped plugin crypto wrappers (Sequoia + Web + base)

Re-read spec §"Rust", §"Web parity".

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` (abstract decls ~432/442; the four internal call sites at ~651/666/698 and ~1419/1454 which pass single strings)
- Modify: `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts` (~93/105)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` (~187/205)
- Test: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts` (mock `invoke`), `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`

**Interfaces:**
- Consumes: Task 3 command shapes.
- Produces: `encryptToRecipients(accountJid, recipientPublics: string[], plaintext): Promise<string>`; `decryptWithOwnKey(accountJid, ciphertext, senderPublics: string[]): Promise<DecryptOutput>`.

- [ ] **Step 1: Update the mock `invoke` in `SequoiaPgpPlugin.test.ts` to expect arrays (failing)**

In `makeFakeRust`, change the `openpgp_encrypt` / `openpgp_decrypt` cases to read `args.recipientPublicArmored as string[]` / `args.senderPublicArmored as string[]`. The encrypt stub encodes **every** recipient fingerprint into the stub ciphertext; the decrypt stub sets `signatureStatus`: `'verified'` when a supplied sender fp matches the stub's signer fp, `'missing-key'` when the signer fp is present in the stub but not among the supplied senders, `'bad'` when a supplied sender matches but the stub marks the content tampered, else `'none'`. Add:

```ts
it('encrypts to every recipient public and verifies a signature from any', async () => {
  // (uses the existing two-account harness; asserts the ciphertext stub lists
  //  all recipient fingerprints and that decrypt with the signer among several
  //  sender keys reports signatureStatus === 'verified')
})
it('reports signatureStatus missing-key when the signer fp is not among supplied senders', async () => {
  // decrypt with only a decoy sender → signatureStatus === 'missing-key', signerFingerprint === null
})
```

*(Use the existing `makeFakeRust` stub conventions in this file — encode the recipient fingerprints and the signer fp into the stub ciphertext so the assertions are real.)*

Also add **real** `WebOpenPGPPlugin.test.ts` cases exercising openpgp.js directly (not a stub — generate keys with `openpgp.generateKey`), since web parity is otherwise unverified:

```ts
it('encrypts to two recipients and each decrypts', async () => {
  // generate keyA, keyB, signer; encryptToRecipients([pubA, pubB]); assert both privA and privB decrypt.
})
it('verifies a signature from any of several sender keys and returns the PRIMARY fingerprint', async () => {
  // decryptWithOwnKey(..., [decoyPub, signerPub]) → signatureStatus 'verified' AND
  // signerFingerprint === signerKey.getFingerprint().toUpperCase() (NOT a key id).
})
it('reports missing-key with null fingerprint when the signing key is absent', async () => {
  // decryptWithOwnKey(..., [decoyPub]) → signatureStatus 'missing-key', signerFingerprint === null
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "every recipient"`
Expected: FAIL — wrappers still pass a single string; mock sees `undefined` array.

- [ ] **Step 3: Change the abstract decls + Sequoia + Web wrappers**

`OpenPGPPluginBase.ts` abstract:

```ts
protected abstract encryptToRecipients(
  accountJid: string,
  recipientPublics: string[],
  plaintext: string,
): Promise<string>

protected abstract decryptWithOwnKey(
  accountJid: string,
  ciphertext: string,
  senderPublics: string[],
): Promise<DecryptOutput>
```

`SequoiaPgpPlugin.ts`:

```ts
protected async encryptToRecipients(
  accountJid: string,
  recipientPublics: string[],
  plaintext: string,
): Promise<string> {
  return this.invoke<string>('openpgp_encrypt', {
    accountJid,
    recipientPublicArmored: recipientPublics,
    plaintext,
  })
}

protected async decryptWithOwnKey(
  accountJid: string,
  ciphertext: string,
  senderPublics: string[],
): Promise<DecryptOutput> {
  return this.invoke<DecryptOutput>('openpgp_decrypt', {
    accountJid,
    ciphertext,
    senderPublicArmored: senderPublics,
  })
}
```

Also add `signatureStatus: 'none' | 'verified' | 'bad' | 'missing-key'` to the TS `DecryptOutput` interface in `OpenPGPPluginBase.ts` (Rust already emits `signatureStatus` via serde).

`WebOpenPGPPlugin.ts`:
- `encryptToRecipients` reads **all** recipient armored keys (`readKey` each; a malformed one throws — parity with Rust's hard error) and passes the array to `openpgp.encrypt({ encryptionKeys })`.
- `decryptWithOwnKey` builds a `verificationKeys` array from `senderPublics` and derives `signatureStatus`: for each signature in the result, `await sig.verified` — `true` ⇒ `'verified'`; if it rejects because the signing key isn't among `verificationKeys` (openpgp.js "Could not find signing key" / no matching key id) ⇒ `'missing-key'`; any other rejection (bad signature) ⇒ `'bad'`; no signatures ⇒ `'none'`. Keep the existing `Date.now()+1h` skew + `signatureNotYetValid` logic. Set `signatureVerified = signatureStatus === 'verified'`, `signaturePresent = signatureStatus !== 'none'`.
- **`signerFingerprint` must be a full PRIMARY certificate fingerprint** (a signature's key ID is NOT the primary fingerprint, so returning it would break `fingerprintsEqual`/trust lookup). For a **verified** signature, find the `verificationKey` whose signing key matches `sig.keyID` and return that certificate's primary fingerprint: `verificationKey.getFingerprint()` (upper-cased to match `toXep0373Fingerprint`). For **`missing-key`** (or `none`/`bad`), return `signerFingerprint: null` — the missing-key path refetches the whole announced keyset, so no key-ID hint is needed.

- [ ] **Step 4: Update the four internal single-string call sites in base**

At ~651/698 (backup self-encrypt), ~666/1419 (backup decrypt), ~1454 (rotate re-encrypt): wrap the single arg in an array — e.g. `this.encryptToRecipients(jid, [recipientKey], plaintext)` and `this.decryptWithOwnKey(jid, ciphertext, senderPub ? [senderPub] : [])`. These are internal backup/rotate paths, semantics unchanged.

- [ ] **Step 5: Build SDK if needed, run both plugin test files**

Run:
```bash
cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts src/e2ee/WebOpenPGPPlugin.test.ts
```
Expected: PASS, including the new "every recipient" test. Then `npm run typecheck` clean.

- [ ] **Step 6: Control-check + commit**

In `encryptToRecipients` (Sequoia), temporarily send `[recipientPublics[0]]`. The "every recipient" test must FAIL. Revert.

```bash
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.ts apps/fluux/src/e2ee/WebOpenPGPPlugin.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts
git commit -m "feat(e2ee): array-shaped encryptToRecipients/decryptWithOwnKey (multi-key crypto)"
```

---

## Task 5: Keyset cache → `CachedPeerCert[]` + classification, freshness, own keyset

Re-read spec §"Atomic refresh", §"Metadata freshness", §"Retained certs", §"Key validation and rejection reasons".

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` — cache field ~374; `loadPeerKeyCache`/`savePeerKeyCache` ~152–178; `init` rehydrate ~545; `probePeer` ~1686; `refetchAndCachePeerKey` ~1698; `cachePeerKey` ~1834; `fetchAdvertisedKey` ~1754 (add "no usable encryption subkey"); add freshness state + `getActivePeerPublics`/`getEligibleVerifierPublics`/`getPeerFingerprints`/`getOwnAnnouncedPublics`.
- Test: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers (`deserializePeerCache`, `activePublics`, `eligibleVerifierPublics`, `upsertActive`, `markDepartedInactive`, `capUnverifiedInactive`).
- Produces on the plugin (used by Tasks 6–7): `private getActivePeerPublics(peer): string[]`; `private getEligibleVerifierPublics(peer, messageTime?: Date): string[]`; `getPeerFingerprints(peer): string[]`; `private getOwnAnnouncedPublics(): string[]`; `private async ensureFreshKeyset(jid): Promise<'ok' | 'incomplete'>` (definitive metadata refresh; sets `freshThisSession`); `private getKeysetHealth(peer): { incomplete: boolean; rejections: CertRejection[] }`; the `everSupported`/`keysetIncomplete`/`freshThisSession` session sets; and `everSupported`-based `supported:true`-on-evidence in `refetchAndCachePeerKey`. New error code `peer-keyset-incomplete`.

- [ ] **Step 1: Write failing tests (classification, freshness, retention)**

Add to `SequoiaPgpPlugin.test.ts`:

```ts
it('caches every announced key that validates, not just the first', async () => {
  // peer publishes two valid keys; after probe, getPeerFingerprints has both.
})

it('excludes a key with no usable encryption subkey and records a rejection', async () => {
  // peer announces a key whose cert has no encryption subkey → not cached, rejection recorded.
})

it('marks a departed key inactive (retained), not deleted, on a definitive refresh', async () => {
  // probe with {A,B}; re-probe with {A}; B is inactive but still present for verification.
})

it('a metadata-fetch failure yields keyset-incomplete (not an empty announced set)', async () => {
  // queryPEP(metadata) throws transiently → probePeer reports incomplete; encrypt (Task 6) blocks.
})

it('a metadata-fetch failure keeps supported:true when there is prior evidence of OX', async () => {
  // probe once (success) → then queryPEP(metadata) throws → probePeer returns supported:true + incomplete,
  // so E2EEManager still selects OX and encrypt() can throw the transient (verified in Task 6).
})

it('a transient data-node failure on a fp we already hold does NOT mark incomplete', async () => {
  // cache {A,B}; re-probe where B's DATA node fetch fails transiently but B is still announced →
  // NOT incomplete (retain prior B); {A,B} still usable.
})

it('a transient data-node failure on a NEW fp with no prior cert marks incomplete', async () => {
  // cache {A}; announced {A,B}; B's data node fails transiently and no prior B cert → incomplete.
})

it('an empty metadata result is definitive: clears rejections + marks fresh', async () => {
  // announce {A} with a rejected sibling → rejection recorded; then announce [] →
  // health.rejections cleared, freshThisSession set, A retired to inactive.
})

it('an incomplete keyset recovers mid-session without a restart (retry after backoff)', async () => {
  // 1. first metadata/data fetch fails transiently (no prior cert) → incomplete;
  // 2. first send throws peer-keyset-incomplete;
  // 3. advance the plugin clock past PROBE_TRANSIENT_TTL and let the service recover;
  // 4. ensureFreshKeyset re-probes → 'ok'; the send now succeeds. (Use the test
  //    clock hook the file already uses for `this.now()`.)
})

it('reactivates a re-announced inactive key across a transient data-node blip', async () => {
  // cache {A,B}; B departs (inactive); B is re-announced but its data node fails
  // transiently → NOT incomplete, B is reactivated from the retained cert and usable.
})
```

*(Use the file's `publishKeyAsXep0373` / `makeContext` helpers; for "no encryption subkey" extend `makeFakeRust` so a marked armored blob validates but reports no encryption-capable key. Encode `active`/departed state via the metadata node contents the mock serves.)*

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "announced key"`
Expected: FAIL — cache is single-bundle; only first key cached; no inactive retention; no incomplete state.

- [ ] **Step 3: Convert the cache + load/save + rehydrate**

- Field: `private readonly peerKeys = new Map<BareJID, CachedPeerCert[]>()`.
- `loadPeerKeyCache`/`savePeerKeyCache` delegate to `deserializePeerCache`/`serializePeerCache` (Task 1).
- `init` rehydrate loop stores arrays.
- `import { deserializePeerCache, serializePeerCache, activePublics, activeFingerprints, eligibleVerifierPublics, upsertActive, markDepartedInactive, capUnverifiedInactive, type CachedPeerCert } from './peerCertCache'`.

- [ ] **Step 4: Rework `refetchAndCachePeerKey` into the atomic-refresh classification**

```ts
private async refetchAndCachePeerKey(peer: BareJID): Promise<PeerSupport> {
  const ctx = this.requireCtx()
  const existing = this.peerKeys.get(peer) ?? []
  // ANY prior validated cert (active OR inactive) for a still-announced fp lets
  // us ride out a transient data-node failure — an inactive cert that is
  // authoritatively re-announced is reactivated and reused (smaller-correction).
  const hasPriorCert = (fp: string) => existing.some((c) => fingerprintsEqual(c.fingerprint, fp))
  // "Prior evidence" the peer supports OX: any cached cert or a prior success.
  const priorEvidence = existing.length > 0 || this.everSupported.has(peer)

  let announced: string[]
  try {
    const meta = await ctx.xmpp.queryPEP(peer, PUBLIC_KEYS_METADATA_NODE, 1)
    announced = parseAdvertisedFingerprints(meta)
  } catch (err) {
    // Metadata snapshot unavailable → keyset NOT fresh. If we have prior
    // evidence OX is supported, keep supported:true so encrypt() runs and throws
    // peer-keyset-incomplete (a transient the send path retries) — never a silent
    // plaintext downgrade. Only with no evidence do we report unsupported.
    this.markKeysetIncomplete(peer)
    const { kind } = classifyBoundaryError(err)
    return { supported: priorEvidence, ttl: kind === 'transient' ? PROBE_TRANSIENT_TTL_SECONDS : PROBE_NEGATIVE_TTL_SECONDS }
  }

  const nowIso = new Date().toISOString()

  if (announced.length === 0) {
    // Definitive: the account announces no keys. Retire every cert, clear stale
    // health/rejections, mark the snapshot fresh (not incomplete).
    this.setPeerCerts(peer, markDepartedInactive(existing, new Set(), nowIso))
    this.recordKeysetHealth(peer, { incomplete: false, rejections: [] })
    this.markKeysetFresh(peer)
    return { supported: false, ttl: PROBE_NEGATIVE_TTL_SECONDS }
  }

  const rejections: CertRejection[] = []
  const validated: KeyBundle[] = []
  const retainedReannounced: string[] = [] // canonical fps kept across a transient blip
  let unresolvedTransient = false
  for (const fp of announced) {
    const result = await this.fetchAdvertisedKeyClassified(peer, fp, rejections)
    if (result.kind === 'valid') validated.push(result.bundle)
    else if (result.kind === 'transient') {
      if (hasPriorCert(fp)) retainedReannounced.push(toXep0373Fingerprint(fp))
      // Transient AND no retained cert for this re-announced fp → genuinely
      // incomplete. A transient blip on an fp we already hold is fine — reuse it.
      else unresolvedTransient = true
    }
    // 'definitively-invalid' → recorded in rejections, excluded (not a recipient).
  }

  if (unresolvedTransient) {
    // Retain prior certs across the blip; do not commit a pruned set.
    this.markKeysetIncomplete(peer)
    return { supported: true, ttl: PROBE_TRANSIENT_TTL_SECONDS }
  }

  // Definitive refresh: commit. Upsert validated (active); reactivate any
  // re-announced fp we retained across a transient blip; mark departed inactive; cap.
  let next = existing
  for (const b of validated) next = upsertActive(next, b)
  next = next.map((c) =>
    retainedReannounced.some((fp) => fingerprintsEqual(fp, c.fingerprint))
      ? { ...c, active: true, inactiveAt: undefined }
      : c,
  )
  // Build the still-announced set in CANONICAL form so markDepartedInactive's
  // Set.has() matches the canonical stored fingerprints (smaller-correction).
  const stillAnnounced = new Set<string>([
    ...validated.map((b) => toXep0373Fingerprint(b.fingerprint)),
    ...retainedReannounced,
  ])
  next = markDepartedInactive(next, stillAnnounced, nowIso)
  next = capUnverifiedInactive(next, (fp) => isPeerVerified(peer, fp), UNVERIFIED_INACTIVE_CAP)
  this.setPeerCerts(peer, next)
  this.recordKeysetHealth(peer, { incomplete: false, rejections })
  this.markKeysetFresh(peer)
  if (activeFingerprints(next).length > 0) this.everSupported.add(peer)
  return { supported: activeFingerprints(next).length > 0, ttl: PROBE_NEGATIVE_TTL_SECONDS, fingerprint: activeFingerprints(next)[0] }
}
```

Add:
- `fetchAdvertisedKeyClassified(peer, fp, rejections): Promise<{ kind: 'valid'; bundle: KeyBundle } | { kind: 'definitively-invalid' } | { kind: 'transient' }>` — wraps the existing `fetchAdvertisedKey` validation. A fp/UID mismatch or **no usable encryption subkey** → `'definitively-invalid'` (recorded in `rejections`); a fetch failure classified transient by `classifyBoundaryError` → `'transient'`; success → `'valid'`. Add the no-encryption-subkey check by extending Rust `validate_cert`/`CertValidation` with `hasEncryptionSubkey: boolean` and checking it here.
- `setPeerCerts(peer, certs)` — writes the map + `persistPeerKeyCache()` + notifies the reactive surface (Stage 2 adds `subscribePeerKeys`; in Stage 1 just persist).
- Session-scoped `private readonly freshThisSession = new Set<BareJID>()`, `keysetIncomplete = new Set<BareJID>()`, `everSupported = new Set<BareJID>()`, `keysetRetryAfter = new Map<BareJID, number>()`. `markKeysetIncomplete(peer)` adds to `keysetIncomplete`, sets `keysetRetryAfter[peer] = this.now() + PROBE_TRANSIENT_TTL_SECONDS * 1000`, and **does NOT add to `freshThisSession`** (so `ensureFreshKeyset` re-probes after the backoff — blocking #1). `markKeysetFresh(peer)` adds to `freshThisSession` and deletes the JID from `keysetIncomplete` + `keysetRetryAfter`. All four collections cleared alongside `peerKeys` on shutdown/reset.
- `recordKeysetHealth(peer, { incomplete, rejections })` — stores `{ incomplete, rejections }` per JID (used by encrypt + Stage 2's shield).
- `const UNVERIFIED_INACTIVE_CAP = 5`.

- [ ] **Step 5: Add the read helpers + `ensureFreshKeyset` + own-keyset probe**

```ts
private getActivePeerPublics(peer: BareJID): string[] {
  return activePublics(this.peerKeys.get(peer) ?? [])
}
getPeerFingerprints(peer: BareJID): string[] {
  return activeFingerprints(this.peerKeys.get(peer) ?? [])
}
private getEligibleVerifierPublics(peer: BareJID, messageTime?: Date): string[] {
  return eligibleVerifierPublics(
    this.peerKeys.get(peer) ?? [],
    { messageTime },
    INACTIVE_ARCHIVE_TOLERANCE_MS,
  )
}
/**
 * Ensure a fresh, complete keyset before the first send. A definitively-fresh
 * JID short-circuits. An INCOMPLETE keyset is NOT marked fresh — it stays
 * retry-able: we re-probe once the transient backoff (`keysetRetryAfter`)
 * elapses, so a service that recovers mid-session heals without a restart.
 */
private async ensureFreshKeyset(jid: BareJID): Promise<'ok' | 'incomplete'> {
  if (this.freshThisSession.has(jid)) return 'ok'
  const retryAfter = this.keysetRetryAfter.get(jid)
  if (retryAfter !== undefined && this.now() < retryAfter) return 'incomplete' // backoff: still blocked, retry later
  await this.refetchAndCachePeerKey(jid)
  return this.keysetIncomplete.has(jid) ? 'incomplete' : 'ok'
}
private getOwnAnnouncedPublics(): string[] {
  return this.getActivePeerPublics(getBareJid(this.requireCtx().account.jid))
}
```

Add `INACTIVE_ARCHIVE_TOLERANCE_MS = 5 * 60 * 1000`. (The session collections — `freshThisSession`, `keysetIncomplete`, `everSupported`, `keysetRetryAfter` — are declared in the helpers bullet above and all cleared on shutdown/reset alongside `peerKeys`.) `probePeer` calls `refetchAndCachePeerKey` when not fresh.

- [ ] **Step 6: Run the tests + typecheck**

Run: `cd apps/fluux && npm run build:sdk && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Control-check + commit**

Temporarily make `refetchAndCachePeerKey` `break` after the first validated key: "caches every announced key" must FAIL. Revert. Temporarily treat a metadata-fetch throw as `announced = []`: "metadata-fetch failure yields keyset-incomplete" must FAIL. Revert.

```bash
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts
git commit -m "feat(e2ee): multi-key peer cache with classification, freshness, inactive retention"
```

---

## Task 6: `encrypt()` fan-out + fail-closed/degraded + retire pin gate

Re-read spec §Encrypt (fan-out + fail-closed rules) and §"Suggested implementation staging" (leave pin data intact).

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` — `encrypt` ~1904–1952.
- Test: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts`
- Test (integration, SDK): `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts`

**Interfaces:**
- Consumes: Task 5 (`ensureFreshKeyset`, `getActivePeerPublics`, `getOwnAnnouncedPublics`, `keysetIncomplete`), Task 4 (`encryptToRecipients`).
- Produces: multi-recipient ciphertext; throws `peer-keyset-incomplete` (transient). A degraded own-keyset send does NOT throw; a self-chat incomplete own keyset surfaces as `peer-keyset-incomplete` (since `peer === ownBareJid`).
- **Note (hardening a):** Stage 1 does NOT build a persistent account-level "own keyset degraded" warning — `reportSecurityContextUpdate` is message-oriented and a store-backed banner belongs with Stage 2's trust surface. Stage 1 does the degraded send and emits a `ctx.logger.warn` diagnostic only; the user-facing persistent warning is an explicit Stage 2 item.

- [ ] **Step 1: Failing tests**

```ts
it('encrypts to every valid peer key AND every own-announced sibling key, deduped', async () => {
  // peer has {P1,P2}; own account announces {SELF, SIB}; recipients seen by the
  // Rust stub == {P1,P2,SIB} (+ local self). No pin-mismatch throw for a 2nd key.
})
it('self-chat dedupes: peer JID == own JID → recipients are the own keyset once', async () => {})
it('peer keyset incomplete → encrypt throws transient peer-keyset-incomplete', async () => {})
it('own keyset incomplete, normal peer → sends degraded and logs the degraded-send diagnostic', async () => {
  // spy on ctx.logger.warn; assert the send resolves (degraded) AND logger.warn was
  // called with the "own keyset incomplete … some sibling clients may not decrypt" message.
  // (The persistent user-facing warning is Stage 2 — Stage 1 asserts only the log.)
})
it('own keyset incomplete, self-chat → defers (peer-keyset-incomplete)', async () => {})
it('a cached second peer key no longer throws pin-mismatch', async () => {})
```

Add the **integration** test in `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts` (blocking #2 — the plugin throw must reach the send path, not become a silent plaintext downgrade). Use a stub plugin whose `probePeer` returns `{ supported: true }` and whose `encrypt` throws `new E2EEPluginError('transient', 'peer-keyset-incomplete', …)`:

```ts
it('propagates a transient encrypt failure instead of returning null (no silent downgrade)', async () => {
  // manager with a stub plugin: selectStrategy picks it (supported:true), encrypt throws transient.
  await expect(manager.encryptOutbound(target, bytes)).rejects.toMatchObject({ code: 'peer-keyset-incomplete', kind: 'transient' })
  // and NOT resolve to null (which would let plaintext policy take over).
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "own-announced sibling"`
Expected: FAIL — single-recipient encrypt; pin gate still throws on a second key.

- [ ] **Step 3: Rewrite `encrypt`**

```ts
async encrypt(handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
  const ctx = this.requireCtx()
  if (getOwnKeyConflict()) {
    throw new E2EEPluginError('permanent', 'own-key-conflict',
      `${this.pluginName()}: own key conflict (${getOwnKeyConflict()!.kind}) must be resolved before encrypting`)
  }
  const peer = extractPeer(handle)
  const ownBareJid = getBareJid(ctx.account.jid)
  const isSelfChat = peer === ownBareJid

  // Definitive metadata refresh before the first send this session.
  if ((await this.ensureFreshKeyset(peer)) === 'incomplete') {
    throw new E2EEPluginError('transient', 'peer-keyset-incomplete',
      `${this.pluginName()}: ${peer}'s keyset is not fully available yet — will retry`)
  }
  const peerPublics = this.getActivePeerPublics(peer)
  if (peerPublics.length === 0) {
    throw new E2EEPluginError('transient', 'peer-key-missing',
      `${this.pluginName()}: no usable public key for ${peer} — probe first`)
  }

  // Own announced keyset (siblings). Self-chat: peer IS the own keyset.
  let recipients = [...peerPublics]
  if (!isSelfChat) {
    const ownFresh = await this.ensureFreshKeyset(ownBareJid)
    recipients.push(...this.getOwnAnnouncedPublics())
    if (ownFresh === 'incomplete') {
      // Degraded send: the local cert is always a recipient (appended in Rust),
      // so this device + author always decrypt; a sibling omitted here can never
      // decrypt THIS archived message (future messages recover after refresh).
      // Stage 1: diagnostic only. Stage 2 adds a persistent account-level warning.
      ctx.logger.warn(
        `${this.pluginName()}: own keyset incomplete — message sent degraded; some sibling clients may not decrypt it`,
      )
    }
  }
  recipients = [...new Set(recipients)]  // dedup (matters when peer JID == own JID)

  const envelope = wrapForSigncrypt({ payloadXml: new TextDecoder().decode(plaintext), peerJid: getBareJid(peer), timestamp: new Date(this.now()) })
  const ciphertext = await this.encryptToRecipients(ctx.account.jid, recipients, envelope)

  const stanzaElement: XMLElementData = { name: 'openpgp', attrs: { xmlns: OX_NAMESPACE }, children: [base64EncodeOpenPgpBlock(ciphertext)] }
  return { protocolId: OPENPGP_DESCRIPTOR.id, stanzaElement, fallbackBody: '[OpenPGP-encrypted message]' }
}
```

The self-chat deferral is covered for free: `ensureFreshKeyset(peer)` with `peer === ownBareJid` returns `incomplete` when the own keyset can't be fetched → the first guard throws `peer-keyset-incomplete`, so a self-chat send defers rather than sending degraded. **Delete** the `getKeyChangeAlert(peer)` pin-mismatch throw entirely (the minimal BTBV block-removal). Do **not** touch `keyChangeAlertsStore` / `pinnedPrimaryFingerprintsStore` persistence — Stage 2's ordered seal migration verifies the old seal against that data before dropping it.

- [ ] **Step 4: Run tests + typecheck**

Run:
```bash
cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts && npm run typecheck
cd ../../packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts
```
Expected: PASS (including the no-silent-downgrade integration test).

- [ ] **Step 5: Control-check + commit**

Re-add the `getKeyChangeAlert` throw: "a cached second peer key no longer throws pin-mismatch" must FAIL. Revert. Temporarily drop `getOwnAnnouncedPublics()` from `recipients`: "own-announced sibling key" must FAIL. Revert. In `encryptOutbound`'s stub test, temporarily make `probePeer` return `{ supported: false }`: the integration test must change from "rejects transient" to "resolves null" — confirming the supported-flag is what routes the throw. Revert.

```bash
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts
git commit -m "feat(e2ee): encrypt fans out to peer + own announced keyset; retire pin-mismatch gate"
```

---

## Task 7: `decrypt()` verifier set + minimal trust-bake adaptation

Re-read spec §Decrypt and §"Retained certs" (live inactive-only → untrusted).

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` — `decrypt` sender selection + Case A/B/C classification ~1977–2068; `PendingVerification` interface ~238; `stashPendingVerification` ~2205; `drainPendingVerifications` ~2216; `buildInboundSecurityContext` ~2294; `buildSelfOutgoingSecurityContext` ~2328.
- Test: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts`

**Interfaces:**
- Consumes: Task 5 (`getEligibleVerifierPublics`, `getOwnAnnouncedPublics`, `getPeerFingerprints`), Task 4 (`decryptWithOwnKey(…, senderPublics[])` returning `signatureStatus`).
- Produces: a message signed by any active peer key bakes `tofu`; a live message signed only by an inactive key bakes `untrusted`; a `missing-key` result **refreshes + defers** (never a permanent `signature-failed`); `PendingVerification.receivedAt` threaded through the deferred path.

- [ ] **Step 1: Failing tests**

```ts
it('decrypts and bakes tofu for a message signed by the peer\'s SECOND active key', async () => {
  // today this bakes untrusted; after fix → tofu (signer ∈ active cached fingerprints)
})
it('verifies an eligible archived message signed by a now-inactive key', async () => {
  // MAM message, archiveTimestamp < inactiveAt → signature verifies (eligible verifier set)
})
it('bakes untrusted for a NEW LIVE message signed only by an inactive key', async () => {
  // retired key signs a live message → untrusted even though historically cached
})
it('a signature from an UNCACHED device (missing-key) refreshes + defers, not permanent-rejects', async () => {
  // announced {A,B}; only A cached; message signed by B → signatureStatus 'missing-key' →
  // stashed for deferred verification + a refetch of B triggered (NOT signature-failed).
})
it('a deferred message received while B was active becomes TRUSTED after B goes inactive', async () => {
  // receive live signed by B (B not yet cached) → defer with receivedAt; B fetched then retired;
  // drain re-verifies using B via receivedAt eligibility. ASSERT the reported securityContext.trust
  // is 'tofu' (or 'verified'), NOT merely that the signature passed — this is the bug-1(f) guard:
  // verifier selection AND trust bake must share the receivedAt eligibility time. Also assert a NEW
  // live message signed by B → 'untrusted'.
})
it('a genuinely BAD signature from a cached signer is permanently rejected', async () => {
  // signer cached, signatureStatus 'bad' → permanent signature-failed (trust 'rejected')
})
it('self-outgoing signed by a SIBLING own key bakes tofu, not untrusted (distinct-key)', async () => {
  // own account announces {local, sibling}; a self-outgoing message signed by the
  // sibling → buildSelfOutgoingSecurityContext returns 'tofu' (was 'untrusted').
})
it('drain: verified → upgrade + remove; missing-key → retain; bad → reject + remove', async () => {
  // stash three pending entries; make the re-decrypt return each status in turn;
  // assert reportSecurityContextUpdate for verified (upgraded) and bad (rejected),
  // and that the missing-key entry remains pending.
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "SECOND active key"`
Expected: FAIL — `senderPublicArmored` is a single key; second-key signatures don't verify.

- [ ] **Step 3: Rework the sender selection + trust bake**

First, the eligible-message-time helper — archive uses `archiveTimestamp`, a live message has none:

```ts
// One eligibility time for BOTH verifier selection and the trust bake below.
const eligibilityTime = context?.fromArchive ? context.archiveTimestamp : undefined
const senderPublics = isSelfOutgoing
  ? this.getEligibleVerifierPublics(ownBareJid, eligibilityTime) // own keyset
  : this.getEligibleVerifierPublics(peer, eligibilityTime)
// ownBundle is always available locally for self verification, even if own-PEP is incomplete.
if (isSelfOutgoing && this.ownBundle) senderPublics.push(this.ownBundle.publicArmored)
const output = await this.decryptWithOwnKey(ctx.account.jid, ciphertext, [...new Set(senderPublics)])
```

Then **reclassify by `signatureStatus`** (blocking #1). Replace the Case A/B block. The rule: a `'bad'` signature from a cached signer is a forgery (permanent); a `'missing-key'` (the signer's cert isn't in our verifier set — an uncached device) must refresh + defer, never permanent-reject:

```ts
if (output.signatureStatus === 'none') {
  // Case B: signcrypt requires a signature.
  throw new E2EEPluginError('permanent', 'signature-missing',
    `${this.pluginName()}: signcrypt message contains no signature`)
}
if (output.signatureStatus === 'bad') {
  if (output.signatureNotYetValid) {
    throw new E2EEPluginError('transient', 'signature-not-yet-valid',
      `${this.pluginName()}: signature creation time ahead of our clock — will retry`)
  }
  // A cert we hold matches the signer but the signature is invalid → forgery.
  throw new E2EEPluginError('permanent', 'signature-failed',
    `${this.pluginName()}: signature did not verify against the signer's available cert`)
}
if (output.signatureStatus === 'missing-key') {
  // The signer's cert is not among the keys we supplied — an uncached device,
  // INCLUDING (under distinct-key multi-client) an uncached OWN sibling on a
  // self-outgoing carbon (blocker #3: the old "self-outgoing never defers"
  // assumption is invalid now). Refresh the relevant JID and stash for deferred
  // re-verification EXPLICITLY — the old Case-C `!senderPublicArmored` predicate
  // no longer holds now that we pass keys. Do NOT throw and do NOT permanently
  // reject: the plaintext is delivered untrusted; trust upgrades on drain.
  const refreshJid = isSelfOutgoing ? ownBareJid : peer
  void this.refetchAndCachePeerKey(refreshJid).catch(() => {})
  if (context?.messageId) {
    this.stashPendingVerification(refreshJid, {
      messageId: context.messageId,
      ciphertext,
      plaintext: output.plaintext,
      expiresAt: this.now() + SIGNATURE_BUFFER_TTL_MS,
      receivedAt: (context.archiveTimestamp ?? new Date(this.now())).toISOString(),
      isSelfOutgoing,
    })
  }
  // fall through: the security-context bake below returns 'untrusted' because the
  // signer fp is not in the eligible cached set.
}
// output.signatureStatus === 'verified' → proceed to the verified bake.
```

**Delete the pre-existing Case-C stash block** (~2080–2093, the `if (!isSelfOutgoing && context?.messageId && !output.signatureVerified && output.signaturePresent && !senderPublicArmored)` block): the `missing-key` branch above now owns all deferred stashing, and its `!senderPublicArmored` predicate is obsolete now that we always pass a keyset.

Keep the existing envelope reflection + ±7-day skew checks unchanged. Extend the `PendingVerification` interface (~238) — which today is `{ messageId, ciphertext, plaintext, expiresAt }` — with **`receivedAt: string`** (ISO 8601, the eligibility time) and **`isSelfOutgoing: boolean`**.

**Modify `drainPendingVerifications` in place — do NOT replace it.** Preserve every existing safeguard (the `expiresAt <= now` discard, the `output.plaintext !== entry.plaintext` equality guard, the transient-vs-permanent catch that retains only transient errors, and the `ctx.reportSecurityContextUpdate({ peer, messageId, securityContext, body? })` API). Make exactly these three changes:

1. **Verifier certs** — replace the single `peerBundle.publicArmored` argument with the message's eligible verifier set, keyed on the entry's own eligibility time:
   ```ts
   const eligibilityTime = new Date(entry.receivedAt)
   const output = await this.decryptWithOwnKey(ctx.account.jid, entry.ciphertext, this.getEligibleVerifierPublics(peer, eligibilityTime))
   ```
2. **State machine** — between the `signatureVerified` (upgrade) branch and the reject (Case D) branch, insert a `missing-key` **retain** case so an entry whose signer is still uncached is kept, not rejected:
   ```ts
   if (output.signatureStatus === 'missing-key') { remaining.push(entry); continue }
   // else: 'verified' → upgrade (below); 'bad' | 'none' → reject (Case D, below).
   ```
   Replace the `if (output.signatureVerified)` test with `if (output.signatureStatus === 'verified')`.
3. **Same eligibility time for trust, and self-outgoing awareness** — the upgrade branch must bake trust with the SAME `eligibilityTime` used for verifier selection (blocker #1(f): otherwise a deferred live message verified via `receivedAt < inactiveAt` re-bakes as a live context and stays `untrusted`), and use the self-outgoing builder for a self-outgoing entry:
   ```ts
   const securityContext = entry.isSelfOutgoing
     ? this.buildSelfOutgoingSecurityContext(output, eligibilityTime)
     : this.buildInboundSecurityContext(peer, output, eligibilityTime)
   ctx.reportSecurityContextUpdate({ peer, messageId: entry.messageId, securityContext })
   ```

The early `if (!peerBundle) { … }` guard becomes "no eligible verifier certs" — keep it, but base it on `this.getEligibleVerifierPublics(peer, …).length === 0` (or simply proceed; an empty verifier set yields `missing-key` → retained by the state machine, which is also correct).

`buildInboundSecurityContext` (minimal Stage-1 adaptation — full verified-SET is Stage 2). It takes an explicit **`eligibilityTime?: Date`** — the SAME value used to pick verifier certs — so verification and trust never disagree (blocker #1(f)). Archive → `archiveTimestamp`; deferred → the entry's `receivedAt`; live → `undefined`:

```ts
private buildInboundSecurityContext(
  peer: BareJID,
  output: DecryptOutput,
  eligibilityTime?: Date,
): SecurityContext {
  // Fingerprints eligible to grant trust for THIS message: active always, plus
  // inactive certs eligible at eligibilityTime. Live (undefined) ⇒ active only,
  // so a retired key never grants trust to fresh traffic.
  const eligiblePublics = this.getEligibleVerifierPublics(peer, eligibilityTime)
  const eligibleFps = (this.peerKeys.get(peer) ?? [])
    .filter((c) => eligiblePublics.includes(c.publicArmored))
    .map((c) => c.fingerprint)
  const signerEligible = !!output.signerFingerprint &&
    eligibleFps.some((fp) => fingerprintsEqual(fp, output.signerFingerprint!))
  let trust: TrustLevel = 'untrusted'
  if (output.signatureVerified && signerEligible) {
    // Verified-SET arrives in Stage 2; for now signer-in-eligible-keyset ⇒ tofu.
    trust = isPeerVerified(peer, output.signerFingerprint!) ? 'verified' : 'tofu'
  }
  return {
    protocolId: OPENPGP_DESCRIPTOR.id,
    trust,
    ...(output.signerFingerprint && { fingerprint: output.signerFingerprint }),
  }
}
```

At the initial-decrypt call sites, compute `const eligibilityTime = context?.fromArchive ? context.archiveTimestamp : undefined` ONCE and pass it to **both** `getEligibleVerifierPublics` (verifier selection, above) and the builder. The live-inactive-only → `untrusted` behaviour falls out: for a live message `eligibilityTime` is undefined, so `eligibleFps` excludes inactive certs → `signerEligible` false → `untrusted`.

**Self-outgoing trust must also be keyset-aware (blocker #3).** `buildSelfOutgoingSecurityContext` today trusts only the local `ownBundle` fingerprint, so a self-outgoing message signed by a *sibling* own key (distinct-key multi-client — the Gajim-alongside-Fluux case) bakes `untrusted`. Adapt it: the local this-device key is always trusted when its signature verifies; any other own-announced key is trusted via the same eligible-keyset rule as inbound (verified iff authenticated, else `tofu`; unknown or inactive-for-live → `untrusted`):

```ts
private buildSelfOutgoingSecurityContext(output: DecryptOutput, eligibilityTime?: Date): SecurityContext {
  const ownJid = getBareJid(this.requireCtx().account.jid)
  // The local (this-device) key is authoritative for our own outgoing messages.
  if (
    output.signatureVerified &&
    output.signerFingerprint &&
    this.ownBundle &&
    fingerprintsEqual(this.ownBundle.fingerprint, output.signerFingerprint)
  ) {
    return { protocolId: OPENPGP_DESCRIPTOR.id, trust: 'verified', fingerprint: output.signerFingerprint }
  }
  // A sibling own-announced key: treat like an inbound message from our own JID
  // keyset (BTBV — tofu unless the user has verified that sibling key; inactive
  // for a live message → untrusted). Same eligibilityTime as verifier selection.
  return this.buildInboundSecurityContext(ownJid, output, eligibilityTime)
}
```

The self-outgoing `missing-key` case (an uncached sibling signer on a carbon) is already handled above: it refreshes `ownBareJid` and stashes for deferred verification, so the message upgrades once the sibling key is fetched.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Control-check + commit**

Temporarily pass only `[senderPublics[0]]` to `decryptWithOwnKey`: "SECOND active key" must FAIL. Revert. Temporarily include inactive certs for live messages (make `getEligibleVerifierPublics` ignore `messageTime`): "untrusted for a NEW LIVE message signed only by an inactive key" must FAIL. Revert. Temporarily map `signatureStatus === 'missing-key'` to the `'bad'` permanent branch: "missing-key refreshes + defers, not permanent-rejects" must FAIL. Revert.

```bash
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts
git commit -m "feat(e2ee): decrypt verifies against the message's eligible keyset; retired key can't sign live"
```

---

## Task 8: #1059 exact same-bare-JID fixture (the closing gate)

Re-read spec §"Relationship to #1059's root cause" and §Testing (#1059 fixture).

**Files:**
- Test: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts` (new `describe('#1059 same-bare-JID', …)`)

**Interfaces:**
- Consumes: everything above. No production change expected — if a case fails, the fix belongs in the relevant earlier task (self-outgoing derivation, reflection, sender selection), not here.

- [ ] **Step 1: Write the fixture, both key modes — concretely (this is the release gate)**

```ts
describe('#1059 same-bare-JID interop', () => {
  const SELF = 'me@example.com'
  for (const mode of ['shared-key', 'distinct-key'] as const) {
    describe(mode, () => {
      // Helper: stand up the Fluux plugin for SELF, and a "sibling" key also
      // announced under SELF. shared-key: sibling fp === Fluux own fp (secret
      // sync). distinct-key: sibling is a separately-generated cert.
      async function setup() {
        const fake = makeFakeRust()
        const plugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
        const { ctx } = makeContext(SELF)
        await plugin.init(ctx)
        const ownFp = plugin.getOwnFingerprint()!
        const siblingFp = mode === 'shared-key' ? ownFp : fake.generateCert(`xmpp:${SELF}`)
        // Announce BOTH keys under SELF's public-keys list + data nodes.
        publishBothKeysAsXep0373(ctx, SELF, [ownFp, siblingFp], fake)
        await plugin.probePeer(SELF) // caches the own-account keyset (both fps)
        return { fake, plugin, ctx, ownFp, siblingFp }
      }

      it('(a) a live self-addressed message from the other resource decrypts', async () => {
        const { fake, plugin, siblingFp } = await setup()
        const payload = fake.buildSigncrypt({ from: SELF, to: SELF, signerFp: siblingFp, body: 'hi self' })
        const res = await plugin.decrypt(handleFor(SELF), payload, { isSelfOutgoing: true })
        expect(new TextDecoder().decode(res.plaintext!)).toContain('hi self')
        expect(res.securityContext?.trust).not.toBe('rejected')
      })

      it('(b) a sent carbon (isSentCarbon) decrypts and is outgoing', async () => {
        const { fake, plugin, siblingFp } = await setup()
        const payload = fake.buildSigncrypt({ from: SELF, to: SELF, signerFp: siblingFp, body: 'carbon' })
        const res = await plugin.decrypt(handleFor(SELF), payload, { isSelfOutgoing: true })
        expect(new TextDecoder().decode(res.plaintext!)).toContain('carbon')
      })

      it('(c) a MAM self-entry replays and decrypts', async () => {
        const { fake, plugin, siblingFp } = await setup()
        const payload = fake.buildSigncrypt({ from: SELF, to: SELF, signerFp: siblingFp, body: 'archived' })
        const res = await plugin.decrypt(handleFor(SELF), payload, {
          isSelfOutgoing: true,
          fromArchive: true,
          archiveTimestamp: new Date('2026-07-01T00:00:00Z'),
        })
        expect(new TextDecoder().decode(res.plaintext!)).toContain('archived')
      })

      it('(d) the sibling signer key is verifiable (bakes tofu, not rejected)', async () => {
        const { fake, plugin, siblingFp } = await setup()
        const payload = fake.buildSigncrypt({ from: SELF, to: SELF, signerFp: siblingFp, body: 'x' })
        const res = await plugin.decrypt(handleFor(SELF), payload, { isSelfOutgoing: true })
        expect(['tofu', 'verified']).toContain(res.securityContext?.trust)
      })

      it('(e) a message Fluux sends is decryptable by the SIBLING key, not only the local private key', async () => {
        const { fake, plugin, siblingFp, ownFp } = await setup()
        const enc = await plugin.encrypt(handleFor(SELF), encodeBodyAsPayload('to my other client'))
        const recipients = fake.recipientsOf(enc) // fps the stub ciphertext is encrypted to
        expect(recipients).toContain(siblingFp)
        if (mode === 'distinct-key') expect(siblingFp).not.toBe(ownFp)
      })
    })
  }
})
```

Add the small harness helpers to the file if absent: `handleFor(jid)` (a `ConversationHandle` for a bare JID — the file already opens conversations via the ctx; reuse that path), `publishBothKeysAsXep0373(ctx, jid, fps, fake)` (extends the existing `publishKeyAsXep0373` to write a two-entry `public-keys-list` + a data node per fp), and on `makeFakeRust`: `generateCert(uid)` (returns a fresh fp), `buildSigncrypt({from,to,signerFp,body})` (a stub `<openpgp>` payload whose decrypt reports that `signerFp` signed), and `recipientsOf(payload)` (the fps a stub ciphertext was encrypted to). These mirror conventions already in the file.

- [ ] **Step 2: Run**

Run: `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "same-bare-JID"`
Expected: initially some cases FAIL. Diagnose each failure to its owning task (e.g. sender-key selection → Task 7; own-keyset recipient → Task 6) and fix there; re-run until all pass in both modes. Do **not** encode the fix in the test.

- [ ] **Step 3: Full suite + typecheck + lint**

Run:
```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hopeful-mendel-cd5eb5
npm run build:sdk && npm test && npm run typecheck && npm run lint
cd apps/fluux/src-tauri && cargo test openpgp
```
Expected: all green, no stderr.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts
git commit -m "test(e2ee): #1059 same-bare-JID interop fixture (shared-key + distinct-key)"
```

---

## Stage 1 self-review checklist (run before handing off)

- [ ] **Spec coverage.** multi-key cache + migration + fingerprint sanitization (T1/T5), local bundle type / no layering cycle (T1), Rust arrays + recipient-hard-error/sender-log-skip (T2/T3), signature-status `verified`/`bad`/`missing-key`/`none` (T3), plugin wrappers + web parity tests (T4), atomic refresh + classification + no-encryption-subkey rejection + retain-prior-cert-on-transient + clear-on-empty (T5), metadata freshness + `supported:true`-on-evidence (T5), own-announced fan-out + dedup + fail-closed/degraded (T6), no-silent-downgrade integration test (T6), pin-gate retirement leaving stores intact (T6), eligible verifier set + live-inactive-untrusted + missing-key-defers-not-rejects + `receivedAt` deferred eligibility (T7), #1059 fixture both modes concretely (T8).
- [ ] **First-review blockers:** #1 signature-status (T3/T7), #2 capability-on-evidence + E2EEManager test (T5/T6), #3 retain-prior-cert + clear-on-empty (T5), #4 `receivedAt` (T7).
- [ ] **Second-review blockers:** incomplete-keyset retries mid-session via `keysetRetryAfter` backoff, not stuck-fresh (T5); explicit `missing-key` stash + `drainPendingVerifications` status state machine verified/missing-key/bad/none/transient (T7); self-outgoing distinct-key trust via keyset-aware `buildSelfOutgoingSecurityContext` + self-outgoing `missing-key` refresh+defer (T7). Smaller: reactivate re-announced inactive cert across a transient blip (T5); own-keyset test asserts the logger not a phantom warning (T6); spec staging amended so the persistent warning is a documented Stage-2 item (spec); reliable `bad` via expired-signature fixture (T3); canonical `stillAnnounced` set for `markDepartedInactive` (T5).
- [ ] **Third-review fixes:** `drainPendingVerifications` MODIFIED in place (keeps `expiresAt` discard, plaintext-equality guard, transient-only-retain catch, real `ctx.reportSecurityContextUpdate({peer,messageId,securityContext,body?})` API), plus the `missing-key`-retain case and ONE `eligibilityTime` shared by verifier selection AND trust bake (blocker #1(f)); `PendingVerification` gains `receivedAt`+`isSelfOutgoing`; old Case-C stash deleted; both builders take explicit `eligibilityTime`; self-outgoing entries use the self-outgoing builder in drain (T7). Rust `signerFingerprint` = verified PRIMARY cert fp or `null` (claimed-issuer plumbing dropped); web maps key-ID → `verificationKey.getFingerprint()` for verified, `null` for missing-key, with a fingerprint-equality test (T3/T4). Rust recipient dedup by key handle (T2); expired-signature `bad` fixture extends `sign_encrypt_at` with a validity period (T3); `own-keyset-incomplete` code removed (T6); session-collections wording fixed (T5).
- [ ] **Hardening (first review):** fingerprint normalize/discard (T1), no `KeyBundle` import cycle (T1), Rust recipient-hard-error/sender-log-skip (T2/T3), real web tests (T4), concrete #1059 fixture (T8).
- [ ] **Not in Stage 1 (Stage 2):** verified SETs, `resolvePeerTrust`, conversation health/trust tiers + reactive surface, `VerifyPeerDialog` set mode, `verificationSync` `:1` migration, ordered seal migration, `KeyChangeBanner` reword, the persistent own-keyset-degraded account warning. The Stage-1 `buildInboundSecurityContext` keeps the existing single-fp `isPeerVerified` check — intentional.
- [ ] **Type consistency.** `PeerBundleInput`/`CachedPeerCert`, `signatureStatus: 'none'|'verified'|'bad'|'missing-key'`, `encryptToRecipients(accountJid, string[], plaintext)`, `decryptWithOwnKey(accountJid, ciphertext, string[])`, `encrypt_and_sign(&[String], …)`, `decrypt_and_verify(…, Vec<Cert>, …)`, `eligibleVerifierPublics(certs, { messageTime? }, tol)` used identically across tasks.
- [ ] **Control checks done** for every new test (neuter → red → revert).

---

## Handoff

Stage 2 (trust surface) gets its own plan, authored against the real Stage-1 code once it lands — its `resolvePeerTrust`, verified-set store, reactive surface, and `verificationSync` `:1` migration depend on the exact shapes committed here, so writing it now would invite type-drift.
