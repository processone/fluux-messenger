# SAS Identity Verification

How Fluux verifies a contact's encryption key with a short code, how another XMPP
client can interoperate, and how to fall back to fingerprint comparison. For the
end-user encryption guide, see [ENCRYPTION.md](ENCRYPTION.md).

## Verification roadmap

People skip verification when it means comparing 40 to 64 hex characters. Fluux
makes the first step trivial and layers stronger checks on top:

1. **Short code (SAS)** (shipped, specified below): an 8-digit code derived from
   both fingerprints; seconds to read out.
2. **Full fingerprint comparison** (shipped): the precise check, behind a toggle
   in the same dialog. See [Fingerprint-only fallback](#fingerprint-only-fallback).
3. **Commitment-based SAS, Pasini-Vaudenay** (planned): same short-code UX, but
   strong against a targeted man-in-the-middle. See
   [Appendix A](#appendix-a-planned-commitment-based-upgrade).

Step 1 catches accidents and casual or passive attackers and gets people
verifying. On its own it is not a defence against an attacker who controls your
key lookups; steps 2 and 3 close that gap (see [Security](#security)).

## Background

Fluux uses OpenPGP for XMPP ([XEP-0373](https://xmpp.org/extensions/xep-0373.html)).
Public keys are published to PEP and discovered automatically. A contact's keys
are used without asking until you verify one of them (blind trust before
verification). Verification lets two humans confirm out-of-band (phone, in
person) that they hold the expected public key, lifting that key's trust from
`tofu` to `verified`.

Trust states (`packages/fluux-sdk/src/core/e2ee/types.ts`, `TrustState`):
`unknown` < `tofu` < `introduced` < `verified`, plus `untrusted` for a new,
changed, or failed key.

## How the SAS is computed

A pure, symmetric function of the two fingerprints, so both sides get the same
digits. Reference: `packages/fluux-sdk/src/core/e2ee/sas.ts`.

1. Normalise each fingerprint: `fp.replace(/[\s:_-]/g, '').toLowerCase()`.
2. Sort the two normalised strings into `low <= high`.
3. `input = low + ":" + high`.
4. `digest = SHA-256(UTF-8(input))`.
5. Read the first 8 bytes of `digest` as a big-endian uint64.
6. `code = digest_int mod 100000000`, left-padded to 8 digits.
7. Split: `firstHalf = code[0..4)`, `secondHalf = code[4..8)`.

**Test vector** (to confirm an implementation byte-for-byte):

```
fingerprint A: AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111
fingerprint B: BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222
input: aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111:bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222
code = 47334307   (firstHalf 4733, secondHalf 4307)
```

**Half assignment** (`splitSas`): for the cross-spoken UX, lower-case both bare
JIDs (strip any resource); the lexicographically smaller JID owns `firstHalf`,
the other owns `secondHalf`. Each side reads its own half aloud and types the
peer's. A client that just shows all 8 digits still interoperates.

## Verification flow

`apps/fluux/src/components/VerifyPeerDialog.tsx`:

1. Both sides have exchanged a message, so each holds the other's PEP key.
2. The dialog shows "your code" (read aloud) and an input for "their code".
3. The typed half is checked against the expected half; a match enables confirm.
4. On confirm, that key is recorded as verified. Each key of a contact is
   verified on its own: verifying one key says nothing about another.

## Trust storage and lifecycle

The OpenPGP plugin keeps one decision per key of each contact
(`packages/openpgp-plugin/src/trustRecords.ts`), in its own plugin storage under
`trust-records`, sealed against tampering
(`packages/openpgp-plugin/src/trustStateIntegrity.ts`). A decision is bound to the
canonical fingerprint, never to the JID:

| Decision    | Shown as    | Receives messages |
| ----------- | ----------- | ----------------- |
| `verified`  | verified    | yes               |
| `tofu`      | trusted     | yes               |
| `untrusted` | not trusted | no                |
| none        | see below   | see below         |

How a key with no decision stands depends on the contact (`keyStanding`):

- **Contact never verified:** the key is used at once and shown as `tofu`.
- **Contact verified** (any of its keys has a `verified` decision, retired keys
  included): the key is held. It is shown as `unknown`, receives no messages and
  waits for you to verify, trust or refuse it. The conversation explains why and
  offers a way to review the keys.

While some keys are held, messages go to the keys that are used. When no key of
the contact can be used, because every key is held or refused, nothing is sent:
no message, no unencrypted fallback and no plain file upload.

Comparisons go through `fingerprintsEqual`, which ignores case and whitespace.

### Upgrading from earlier versions

Earlier versions kept one verified fingerprint per contact in the app's own
storage. On the first sign-in after an upgrade, the plugin reads those records
once (`packages/openpgp-plugin/src/legacyTrustMigration.ts`) and writes per-key
decisions to plugin storage:

- each verified fingerprint becomes a `verified` decision for that key;
- a pending key-change alert's previous key was verified, so it becomes
  `verified` too, and the contact's newer key is held;
- certificate rejections and the sync version carry over; pinned fingerprints
  are dropped, since per-key decisions replace them.

The earlier records are read without being changed, so an older version still
finds them, and are never written again.

## Cross-device sync (optional)

`packages/openpgp-plugin/src/verificationSync.ts` publishes every contact's
verified keys to a private PEP node `urn:xmpp:fluux:verifications:1`
(whitelist), signed and encrypted to the account's own key. The decrypted payload
is a set per contact:

```json
{ "v": 1, "ts": 1763460000000, "version": 7, "verified": { "bob@example.com": ["<fingerprint>", "<fingerprint>"] } }
```

`ts` is the publish time in milliseconds since the epoch. A fetched snapshot is
applied only if it is signed by the own key (authorship)
and carries a strictly higher `version` (replay defence). Applying it makes each
listed key verified; a key verified locally but absent from the snapshot loses
its verification and stays trusted (`tofu`).

Only verifications sync. A key you trusted or refused without verifying keeps
that decision on the device where you made it, so a key held on one device is
held on each device until you decide there.

Earlier versions published one fingerprint per contact to
`urn:xmpp:fluux:verifications:0`. A device reads that node once, only when the
`:1` node does not exist yet, and never writes it. A third-party client can
verify locally without either node.

## Implementing in another client

1. Get the full canonical fingerprint of your own and the peer's key from their
   XEP-0373 PEP key (40 hex for v4, 64 for v6; do not truncate).
2. Implement the algorithm above; confirm against the test vector.
3. Optionally implement the half assignment, or just show all 8 digits.
4. Compare out-of-band; on a match, store that fingerprint as verified. Keep
   the decision per key: a key the contact adds later is not verified.

Nothing here is bound to Fluux internals: the SAS is two fingerprints plus SHA-256.

## Fingerprint-only fallback

Many clients (Gajim, Dino, Conversations) show the raw fingerprint but not this
SAS. Fall back to comparing the **full fingerprint** out-of-band. In Fluux this is
the "show full fingerprints" toggle in the verify dialog; it records the same
verified fingerprint, so trust behaves identically.

Compare the **entire** fingerprint, ignoring case and whitespace: the native
(Sequoia) backend emits upper-case, openpgp.js lower-case, and clients may insert
spaces. Fluux uses `fingerprintsEqual` for this. Never compare only a prefix.

## Security

What the short SAS is for, and what it is not:

- **Catches** accidental key confusion, a passive or honest-but-curious server,
  and an opportunistic MitM who substitutes an arbitrary key (it matches the 8
  digits only about 1 in 10^8). A quick check people actually run is the point.
- **Does not stop** a prepared, targeted MitM who controls both substituted keys.
  Since the digits come from the fingerprints and the attacker picks both keys,
  finding a colliding code is a birthday search of about `sqrt(10^8)`, on the
  order of 10^4 cheap hashes (the fingerprint's creation-time field can be varied
  without real key generation). That is roughly 13 effective bits, feasible
  against a specific pair.

For a high-value contact, use the full fingerprint (a preimage on 160+ bits, not
a birthday), especially if you do not control your own server: the attacker able
to mount the collision is essentially whoever runs your XMPP service or its
federation path, so a third-party provider is exactly that party. The planned
[PV-SAS-MCA upgrade](#appendix-a-planned-commitment-based-upgrade) removes the
birthday shortcut so a short code is sufficient on its own.

Either way: the comparison must use an out-of-band channel the attacker does not
control, and verified state is per fingerprint.

## Source map

| Concern                        | File                                                          |
| ------------------------------ | ------------------------------------------------------------ |
| SAS derivation and split       | `packages/fluux-sdk/src/core/e2ee/sas.ts`                    |
| Trust state type               | `packages/fluux-sdk/src/core/e2ee/types.ts` (`TrustState`)   |
| Verify dialog (SAS + fallback) | `apps/fluux/src/components/VerifyPeerDialog.tsx`             |
| Per-key trust decisions        | `packages/openpgp-plugin/src/trustRecords.ts`                 |
| Upgrade from earlier versions  | `packages/openpgp-plugin/src/legacyTrustMigration.ts`         |
| Fingerprint normalisation      | `packages/openpgp-plugin/src/fingerprintCompare.ts`                  |
| Key standing and holding       | `packages/openpgp-plugin/src/trustRecords.ts` (`keyStanding`) |
| Cross-device sync (PEP)        | `packages/openpgp-plugin/src/verificationSync.ts`                    |
| Web plugin (openpgp.js), loaded on demand | `packages/openpgp-plugin/src/WebOpenPGPPlugin.ts` (entry `@fluux/openpgp-plugin/web`) |

## Appendix A: planned commitment-based upgrade

Not implemented today; recorded so the design is captured.

The shipped SAS derives its digits from the fingerprints, so an attacker who
controls both keys can search offline for a colliding code (see [Security](#security)).
A commitment-based SAS removes that freedom: each side commits to a fresh random
value before the peer's is revealed, so neither side nor a relay can adapt, and
the only attack left is a blind 1-in-10^8 guess with no retries.

The recommended construction is **Pasini-Vaudenay (PV-SAS-MCA)**, the protocol
Olvid uses, which has a published security proof:

1. A to B: Alice sends her identity plus a commitment to `(identity_A, N_A)`.
2. B to A: Bob sends his identity plus a nonce `N_B` in the clear.
3. A to B: Alice opens the commitment, revealing `N_A`.

Both compute `SAS = N_A XOR N_B` and compare it out-of-band; one short SAS
authenticates both identities. Only one side needs to commit (Alice is locked in
before she sees `N_B`; Bob reveals `N_B` before `N_A` is known), so it is one
commitment in three moves, fewer than a symmetric both-sides-commit design, with
the same security. Prefer it over a hand-rolled ceremony: it is studied, proven,
and shorter.

References:

- Abdalla, *Security Analysis of Olvid's SAS-based Trust Establishment Protocol*,
  IACR ePrint 2020/808: <https://eprint.iacr.org/2020/808> (also on
  [Inria HAL](https://inria.hal.science/hal-03003687/)).
- Pasini and Vaudenay, *SAS-based Authenticated Key Agreement*, PKC 2006.
- Laur and Pasini, *SAS-based group authentication and key agreement protocols*:
  <https://kodu.ut.ee/~swen/publications/articles/laur-pasini-2009.pdf>.
