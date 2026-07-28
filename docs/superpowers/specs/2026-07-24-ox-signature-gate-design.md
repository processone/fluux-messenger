# Distinguish an unverifiable OX signature from a forged one

**Date:** 2026-07-24
**Status:** Design — pending review
**Scope:** `apps/fluux` plugin layer (`OpenPGPPluginBase`, both backends), the
Rust Sequoia verifier, one new SDK type plus its mapping in `stanzaDecrypt`, and
three i18n strings. No change to the encryption path, no new cryptography, no
change to key storage or publication.
**Issue:** [#1059](https://github.com/processone/fluux-messenger/issues/1059)

## Problem

`OpenPGPPluginBase.decrypt()` throws a **permanent** `signature-failed` when a
message decrypts cleanly but its signature does not verify against the single
cert we cached for the sender (`OpenPGPPluginBase.ts:2078-2095`). The recovered
plaintext is discarded. `decrypt()` is defined only on the base class, so both
the Sequoia (desktop) and openpgp.js (web) backends behave identically.

The test at `WebOpenPGPPlugin.test.ts:2228` shows the intent: a server that
substitutes a peer's published key must not be able to put words in that peer's
mouth. That intent is right. The implementation over-reaches, because it treats
two different situations as one:

- **Forged** — we hold the cert the signature claims to come from, and the
  signature does not check out. Someone tampered with the message.
- **Unverifiable** — the signature was made by a key we simply do not hold. We
  have no evidence either way.

Only the first is an attack. The second is routine: the peer signed with a key
other than the one cert we cached — a second announced key, another client, a
rotation we have not caught up with. Gajim never drops these; `decrypt_message`
(`gajim/common/modules/openpgp.py:683-702`) retries `pys.decrypt` without
verification and renders the message as `Trust.UNTRUSTED`.

The code already knows how to handle "no evidence": Case C at
`OpenPGPPluginBase.ts:2096` renders the message and stashes it for deferred
re-verification when *no* cert at all was available. The bug is that having the
*wrong* cert is worse than having none.

### The second finding: the UI erases the reason

`chat.encryption.couldNotDecryptTooltip` — "Message encrypted to a key not
available on this device" — is a fixed string rendered by
`EncryptedPlaceholder.tsx` for **every** decrypt-path rejection: envelope
reflection, stale envelope, missing signature, failed signature, malformed
payload, and the genuine key-unavailable case. `EncryptedPlaceholder` has no
access to the failure reason at all.

This is not cosmetic. It is why #1059 spent three rounds on a multi-key
*decryption* theory: the reporter quoted the tooltip, and the tooltip asserted a
cause it had not established. Triage was reasoning from a string that carries no
information.

## Non-goals

- **Encryption fan-out.** `peerKeys` stays one cert per peer for encryption.
  Encrypting to every announced key is Stage 2 of #1059 and is deliberately out
  of scope here.
- **Key storage, publication, or the `public-keys-list` write path.**
- **Retiring the pin / own-key conflict machinery.**
- **Making unverified messages indistinguishable from verified ones.** The point
  is to deliver them *and* mark them.

## Design

### 1. One new fact from the crypto layer

`DecryptOutput` gains a single field:

```ts
/**
 * Did we hold a USABLE verification key for this signature's issuer?
 * False means we could not form a judgement; true means we could, and
 * the cryptography is what failed.
 */
signerKeyKnown: boolean
```

Everything else derives from it. The split is *absence of a usable key* versus
*cryptographic failure* — not merely *missing* versus *present*. This matters:
an expired, revoked, or unbound issuer cert is an availability problem, and
calling it forgery would resurrect the false-rejection class already recorded in
`project_gajim_rejects_expiring_keys` and `project_e2ee_clock_skew_sig_rejection`.

- **Sequoia** (`apps/fluux/src-tauri/src/openpgp.rs`, `DecryptHelper::check`).
  Variants confirmed present in sequoia-openpgp 2.4.0
  (`src/parse/stream.rs:250`):
  - `MissingKey`, `UnboundKey`, `BadKey` → `false`. We have no cert for the
    issuer, or none that is valid under policy at signature time. No judgement
    possible.
  - `BadSignature`, `MalformedSignature` → `true`. We had a usable key and the
    signature did not check out.

  `get_certs(&mut self, ids: &[KeyHandle])` is already handed the issuer
  handles; today it ignores them as `_ids`.

- **openpgp.js 6.3** (`WebOpenPGPPlugin.decryptWithOwnKey`). Compare
  `VerificationResult.keyID` against the union of `getKeyIDs()` over the
  supplied verification keys using `KeyID.equals()`; treat a match as usable
  only if that cert is neither expired at the signature's creation time
  (`getExpirationTime()`) nor revoked (`isRevoked()`). This reproduces Sequoia's
  `UnboundKey`/`BadKey` handling structurally, so the two backends agree without
  matching on error-message text.

When no sender cert was supplied at all, `signerKeyKnown` is `false` — which
makes the existing Case C a special case of the new rule rather than a separate
branch.

### 2. The gate becomes three-way

Replacing the `senderPublicArmored && !signatureVerified` branch:

| Condition | Outcome |
|---|---|
| `signatureNotYetValid` | transient `signature-not-yet-valid` — unchanged, checked first |
| `!signaturePresent` | permanent `signature-missing` — unchanged |
| `signatureVerified` | trusted — unchanged |
| `!verified && !signerKeyKnown` | **deliver**, `trust: 'untrusted'`, stash for deferred re-verification |
| `!verified && signerKeyKnown` | permanent `signature-failed` — unchanged; now genuine forgery only |

The fourth row reuses the Case C machinery verbatim, including
`stashPendingVerification`. A later `probePeer` that brings in the real issuer
cert drains the stash and either upgrades the message to verified or rejects it
through the existing Case D path (`OpenPGPPluginBase.ts:2278-2290`), which
already reports `trust: 'rejected'` and replaces the body.

### 3. Verify against every announced cert

`probePeer` already iterates the peer's whole `public-keys-list` and calls
`fetchAdvertisedKey` per fingerprint (~`OpenPGPPluginBase.ts:1738`), then keeps
one bundle and discards the rest. Retain them:

```ts
private readonly peerVerifyKeys = new Map<BareJID, KeyBundle[]>()
```

`decryptWithOwnKey`'s sender parameter widens from `string | null` to
`string[] | null`. Both backend APIs are natively multi-cert — Sequoia's
`get_certs` returns a `Vec<Cert>`, openpgp.js's `verificationKeys` takes an
array — so the backends absorb this without restructuring.

`peerKeys` and every encryption call site are untouched. This is the whole of
the widening: it makes `signerKeyKnown` accurate for multi-key peers, so
"unverifiable" stays rare and honest instead of becoming the common case.

### 4. The failure reason reaches the UI

New SDK type, exported from `@fluux/sdk`:

```ts
export type DecryptFailureReason =
  | 'key-unavailable'    // no session key for us — the only true "key not available"
  | 'signature-invalid'  // decrypted, signature forged
  | 'unreadable'         // malformed, reflected, stale envelope, needs repair
```

`stanzaDecrypt` maps `E2EEPluginError.code` onto a bucket and sets it on the
security context alongside the existing `notes`. `EncryptedPlaceholder` reads it
and selects its string; the fixed `couldNotDecryptTooltip` is replaced by three
keys under `chat.encryption.*`, translated across all 33 locales.

The *unverified sender* case is deliberately **not** a placeholder bucket: those
messages now render with their content and a yellow `ShieldAlert`, which
`MessageBubble.tsx:672-686` already draws for `trust: 'untrusted'`. No new
component and no new visual state.

The precise `E2EEPluginError.code` is always written to `e2eeDiagnosticLogger`,
whatever bucket the user sees. That is the part that makes the next
investigation start from a code instead of a guess.

## Security review

The substitution threat guarded by `WebOpenPGPPlugin.test.ts:2228` splits into
two cases, and the change is only defensible because the second stays closed:

1. **Attacker substitutes the published key; the victim's genuine signature
   arrives.** Issuer unknown → message delivered, explicitly marked unverified.
   *Changed behaviour.* Safe: no content is attributed to the victim, and the
   attacker has gained no ability to author messages.
2. **Attacker substitutes the key and signs with it.** Issuer known (it is the
   substituted cert), signature checks out against it — so the existing
   fingerprint/pin machinery, not this gate, is what flags it. Where the
   attacker signs with a key we hold and the math fails, the hard reject stands.

One consequence follows from mapping expired and revoked issuer certs to
"unverifiable": an attacker who can publish a *revoked* cert can force the
unverified path rather than the rejected one. That is not a downgrade — without
the substitution they would get the same unverified rendering by signing with
any unknown key — but it does mean revocation must not be read as an
authentication signal anywhere in this path.

Case 2 has no test today. It is the case that actually guards the threat, and
this design adds it.

Residual risk: a user who ignores the unverified badge sees content whose author
is unconfirmed. That is the same exposure Gajim ships, and strictly less than
the status quo's — today the message vanishes with a message claiming a cause
that is false, which teaches users to distrust the indicator entirely.

## Testing

**Interop (`apps/fluux/src/e2ee/gajimOxInterop.test.ts`, vectors already in
tree).** `signed_b_to_a_and_b` flips from asserting `rejects` to asserting
delivery with `trust: 'untrusted'`. A new vector corrupts a signature byte while
the issuer's cert *is* cached — that must still hard-reject, and it is the
control proving the flip did not simply disable the gate.

**Security pair (`WebOpenPGPPlugin.test.ts`).** Rewrite the substitution test
per the two cases above. Both must exist; the second is new.

**Backends.** Rust unit tests covering each `VerificationError` variant's mapping
in `DecryptHelper::check`, including an expired issuer cert reaching `false`
rather than `true`. Web-backend tests that `signerKeyKnown` is `false` both when
`signatures[0].keyID` matches none of the supplied verification keys and when it
matches an expired or revoked one — the two backends must agree on that second
case or the desktop and web builds will disagree about what counts as forgery.

**Multi-cert verify.** A test where the peer announces two keys, signs with the
second, and the message verifies — the widening's reason for existing.

**Placeholder.** One test per bucket asserting the mapping from
`E2EEPluginError.code` to the rendered string. Per
`project_tooltip_mock_drops_content`, assert through a path where the tooltip
mock does not drop `content`, or the assertions cannot fail.

## Files

- `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` — gate, `peerVerifyKeys`, widened
  `decryptWithOwnKey` signature
- `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` — `signerKeyKnown`, multi-cert verify
- `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts` — pass through the widened parameter
- `apps/fluux/src-tauri/src/openpgp.rs` — `DecryptHelper`, `DecryptOutput`
- `packages/fluux-sdk/src/core/e2ee/types.ts` — `DecryptFailureReason`
- `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` — code → bucket mapping
- `apps/fluux/src/components/conversation/EncryptedPlaceholder.tsx` — bucket → string
- `apps/fluux/src/i18n/locales/*.json` — three keys, 33 locales
