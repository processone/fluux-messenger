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
| `held`      | unknown     | no                |
| none        | see below   | see below         |

How a key with no decision stands depends on the contact (`keyStanding`):

- **Contact never verified:** the key is used at once and shown as `tofu`.
- **Contact verified** (any of its keys has a `verified` decision, retired keys
  included): the key is held. It is shown as `unknown`, receives no messages and
  waits for you to verify, trust or refuse it. The conversation explains why and
  offers a way to review the keys.

A held key stays held until you decide about it. Each key waiting for a
decision is recorded as `held` when the plugin reads the contact's keys,
including a key the contact withdraws but may announce again, so its hold does
not depend on the cache of the contact's keys. That includes a hold recorded
while the trust state cannot be sealed yet, for instance while its check waits
for your key: the check accepts a hold recorded since the last seal, for a key
the seal has no decision about, and seals it at once. A hold that replaced a
sealed decision, and a sealed hold that is gone, are still reported as changes
made behind the plugin's back. When the contact then loses its last verified
key (you refuse it, remove its verification or forget it, or another device
removes it), the key stays held, and a later verification of another key does
not approve it. A key held on one of the account's devices is held on each of
them, including a device that joins later and one where the contact's
verification was removed before it saw the key (see
[Cross-device sync](#cross-device-sync-optional)).

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
finds them, and are never written again. Records the oldest versions kept before
scoping them per account go to the first account that reads them, as those
versions moved them, once that account's claim on them is confirmed; no account
uses them without one. Under a lock the app's windows share, the claim is saved
and read in one step. Where that lock is missing or refused (an older system
web view, or a page served without HTTPS), the claim is saved, then read back
a second later: of two windows that claimed at the same moment, both read the
claim saved last, so one account owns the records. When another account holds
the claim, an account moves only its own records.

When the claim cannot be saved or read, nothing is moved or sealed yet: the
session uses only the account's own earlier records and still checks their
seal. It tries the upgrade again every 30 seconds, and before each trust
decision or reseal you make; while the upgrade still waits, those are refused,
with the reason. Whether you verified a contact the unclaimed records name is
not known meanwhile, so each of its keys without a decision waits for the
upgrade (`trust-pending`), and nothing is sent to it; the conversation and the
contact's Security details say that the keys wait for the earlier version's
trust data, not that the contact added a key. The keys that session holds are
kept apart from its unsaved records; once the upgrade runs, during the session
or at the next start, each stays held if the contact turns out verified and
the upgrade has no decision about the key.

An upgrade that runs during the session is checked as at a start. Two
decisions made while it waited meet records you have not seen, so they are
refused for you to look again: a decision about a key that waited for the
upgrade, where the upgrade gives that key an earlier decision, and a reseal
whose moved records the check still reports.

Earlier versions sealed their records too. That seal is checked against the
earlier records as those versions checked it, once the account's key is usable.
Those versions compared a key-change alert by contact only; the upgrade also
requires the previous key of each alert, which it keeps verified, to be the
sealed one. The new records are then checked against what the upgrade made of
the earlier ones. Until both checks pass, nothing is sealed, published or
applied from the server; a failed check is reported for you to review and
reseal.

Each check compares the records as they were stored when the app started. A
decision you make while a check runs, or waits for your key, is not part of what
it checks: it is sealed once the check passes.

## Cross-device sync (optional)

`packages/openpgp-plugin/src/verificationSync.ts` publishes every contact's
verified keys to a private PEP node `urn:xmpp:fluux:verifications:1`
(whitelist), signed and encrypted to the account's own key. The decrypted payload
is a set per contact:

```json
{
  "v": 1,
  "ts": 1763460000000,
  "version": 7,
  "verified": { "bob@example.com": ["<fingerprint>", "<fingerprint>"] },
  "held": { "bob@example.com": ["<fingerprint>"] }
}
```

`ts` is the publish time in milliseconds since the epoch. A fetched snapshot is
applied only if it is signed by the own key (authorship)
and carries a strictly higher `version` (replay defence); the held keys of one
with the same `version` are applied as described below. Applying it makes each
listed key verified; a key verified locally but absent from the snapshot loses
its verification and stays trusted (`tofu`).

Verifications and holds sync; trusting or refusing a key does not. `held`
lists the keys held on the account's devices. Each publication carries the list
it last read, adds the keys held on the publishing device and leaves out the
keys it verifies. A device that reads the list holds each listed key it has no
decision about, before it approves the keys of a contact verified there for the
first time. A device that joins later therefore holds what another device
holds, and so does a device where the contact's verification was removed
before it saw the key. A device that holds a key the list lacks publishes the
list again. A snapshot of the version already applied, such as one another
device published at the same time, adds its held keys only, since a hold only
stops messages; an older one changes nothing. The list is part of the sealed
trust records.

A key you trusted or refused without verifying keeps that decision on the
device where you made it, so a held key stays held on each device until you
decide there.

Earlier versions published one fingerprint per contact to
`urn:xmpp:fluux:verifications:0`. A device reads that node only while the `:1`
node does not exist yet, and never writes it. Once the device has read or
written the `:1` node, it records that in its sealed trust records and never
reads `:0` again, even when `:1` later goes missing: it publishes its own
verified keys to `:1` instead, as an empty list when it has none. A third-party client can verify locally without
either node.

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
