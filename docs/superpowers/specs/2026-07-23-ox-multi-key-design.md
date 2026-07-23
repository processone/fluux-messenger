# OX multi-key per peer (BTBV) — design

**Issue:** [#1059](https://github.com/processone/fluux-messenger/issues/1059) — "unable to decrypt my own open-pgp messages"
**Milestone:** 0.17.3
**Status:** approved (fourth review + wording pass); implementation plan to follow

## Problem

Fluux's XEP-0373 ("OX") implementation assumes **one OpenPGP key per peer JID**. XEP-0373
permits an account to announce **multiple** public keys on
`urn:xmpp:openpgp:0:public-keys`, and clients MUST expect and use all of them (XEP-0374
§2.3.1). These are **announced keys**, not device identities: the XEP binds a fingerprint to
no physical client, defines secret-key *synchronization* across an account's clients, and even
expects a single shared key to be common in practice. So "the peer has three keys" and "the
peer has three devices" are not the same statement, and Fluux must not claim to know which
client owns a fingerprint. There is no cross-client "primary" key and no signing chain linking
an account's announced keys.

Three consequences, in the #1059 setup where the user runs Gajim and Fluux on one account:

1. **Publish clobber** (fixed separately, PR-A / `oxPublicKeysList.ts`): republishing our
   single entry deleted sibling clients' entries from the shared list; a spec-compliant peer
   (Gajim) then marked the missing fingerprint inactive and stopped encrypting to it.
2. **Single recipient**: [`encrypt`](../../../apps/fluux/src/e2ee/OpenPGPPluginBase.ts) sends
   to one cached peer cert, so a multi-key contact only receives on one client. Compounding
   this, the Rust encrypt-to-self block adds only the *local* cert's own subkeys, not the
   account's other announced keys — so a Gajim sibling on the same account can't read a
   Fluux→third-party message from carbons or MAM.
3. **Single verifier + hard pin**: [`decrypt`] verifies against one cached cert, so a signature
   from a second announced key bakes `untrusted`; and
   [`cachePeerKey`](../../../apps/fluux/src/e2ee/OpenPGPPluginBase.ts) treats any second
   fingerprint as a rotation → `keyChangeAlert` → [`encrypt`] hard-blocks with `pin-mismatch`.
   A normal additional key is misread as a compromise.

This spec covers (2) and (3): making encryption, decryption, and trust **multi-key correct**
under a **BTBV** posture.

### Relationship to #1059's root cause

Multi-key correctness is necessary for OX/Gajim interoperability, but it is **not assumed to be
the complete root cause of #1059**. The reporter's steps ("import key from server → add the key
to Fluux") describe XEP-0373 secret-key sync — Fluux and Gajim may hold the **same** cert (one
shared fingerprint). If so, #1059 is not a multi-key bug for that reporter at all; it is the
publish-clobber (PR-A) plus, possibly, a self-outgoing / reflection / sender-key-selection
issue on the same-bare-JID path. #1059 is closed only when the **exact same-bare-JID fixture**
below passes (see Testing) — not on generic multi-key tests.

## Policy note: BTBV is a Fluux choice

XEP-0373/0374 deliberately leave trust establishment unspecified. **BTBV** (Blind Trust Before
Verification) is Fluux's product/security choice, not a spec requirement, and is described as
such throughout. What the XEPs *do* require is that all announced keys be used for encryption;
we honor that for all **valid** announced keys, intentionally excluding definitively-malformed
entries (a key with no usable encryption subkey, or a fp/UID mismatch, is not a usable
recipient). That safe deviation is honored independently of BTBV.

## Decisions

1. **Security posture — BTBV (Fluux choice).** Before the user has verified any of a peer's
   keys, blindly trust every valid announced key (encrypt to all valid, render `tofu`). After
   they verify, a still-unverified announced key is still encrypted to (never blocked) but
   surfaced as an "unverified keyset". An additional fingerprint is a notice, never a
   refuse-to-send.
2. **Scope — minimal-correct for 0.17.3.** Ship what fixes the interop breakage and makes BTBV
   correct. The verified store becomes a *set* per JID. No per-key management UI, no individual
   key verify/revoke, no QR — those defer to the 0.18.0 OMEMO convergence.
3. **Verification authenticates only fingerprints the user actually confirmed** (revised —
   see below). Single/shared key → SAS as today. Multi-key → **manual full-set fingerprint
   compare**, each displayed fingerprint independently confirmed against what the peer states.
   No multi-key set-SAS: with both sides deriving the set from the same server-controlled PEP
   view, a set-SAS would silently authenticate an injected key.
4. **Verified peer + new announced key.** The conversation shield downgrades from `verified` to
   a neutral **"unverified keyset — re-verify"** state, reusing the existing `KeyChangeBanner`
   surface reworded from "key changed / blocked". Re-verify re-authenticates the current
   announced set and restores the check. No send is ever blocked by this.
5. **Terminology.** Internally `announcedKeys`, never `deviceKeys`; UI copy says
   "unverified keyset" / "key", never "device". Fluux does not imply it knows which client owns
   a fingerprint.

## Model

A peer JID owns a set of announced keys. Three sets per peer drive all behaviour, modelled
**separately** (announced ≠ known validated certs ≠ refresh-completeness):

- **Announced** — fingerprints currently in the peer's `public-keys-list` per the authoritative
  metadata snapshot.
- **Known validated certificates** — certs whose data node we fetched and that passed
  validation, **partitioned** by an **active** flag: *active* = still announced (an encryption
  recipient) — the **active partition is the subset of announced** we can use; *inactive* =
  validated earlier but no longer announced (stamped `inactiveAt`, retained for **verification
  only**, never an encryption recipient — see Retained certs). Only the active partition is a
  subset of the announced set.
- **Verified** — fingerprints the user authenticated out-of-band. Persisted, cross-device
  synced.

### Key validation and rejection reasons

`fetchAdvertisedKey` classifies each announced fingerprint into one of:

- **valid** — data node fetched; cert fingerprint matches the advertised one; a `xmpp:<bare
  jid>` UID is present; **and at least one usable encryption subkey exists**.
- **definitively invalid** — data node **fetched successfully** but the cert has a fingerprint
  mismatch, a UID mismatch, or **no usable encryption subkey**. Such an entry is provably *not
  a valid recipient key for this peer*.
- **transient/unknown** — the data node fetch **failed** (timeout, server error). The key may
  be legitimate and merely unavailable.

The "no usable encryption subkey" case is a **new** definitive-rejection reason added to
`fetchAdvertisedKey`.

### Trust derivation

Two pure derivations, unit-tested in isolation. They answer different questions — per-message
"who signed *this* one", per-conversation "is the whole announced set accounted for" — so they
take different inputs and cannot collapse into one call.

- **Per message** — new pure `resolvePeerTrust(verifiedSet, validatedSet, signerFp)`, consumed
  by [`buildInboundSecurityContext`] (bake time) and [`resolveDisplayTrust`] (render time):

  ```
  resolvePeerTrust(verifiedSet, validatedSet, signerFp) -> 'verified' | 'tofu' | 'untrusted'
  ```

  `signerFp ∈ verifiedSet → 'verified'`; else `signerFp ∈ validatedSet → 'tofu'`; else
  `'untrusted'`. Here `validatedSet` is the **eligible verifier set for this message** — the
  active partition always, plus any inactive certs eligible under the archive-time policy (see
  Retained certs) — so a live message signed only by an inactive key falls through to
  `untrusted`. The message bakes `signerFingerprint`, so the rendered lock stays live against the
  verified store (unchanged mechanism). This enum is unchanged from today — no new message trust
  value.

- **Per conversation** — a set derivation in [`useConversationEncryptionState`]. Two tiers,
  **keyset-health first, trust second**:

  Keyset-health (the `PeerKeysetHealth` struct; outranks the trust tier — never present an
  unusable/anomalous keyset as ready). The two conditions are **independent booleans and can
  coexist**:
  - `incomplete: true` (transient) iff a still-announced fingerprint has no validated cert and
    its last fetch failed transiently. **Fail-closed: blocks encrypted sending**, shown as
    checking/incomplete.
  - `rejections: [...]` (definitive) iff any announced fingerprint is definitively invalid.
    **Does not block sending** (the bad key was never a recipient), but is a persistent
    non-green state listing the rejected fingerprints + reasons.
  - Both outrank the trust tier in presentation. When both hold, incomplete's send-block governs
    behaviour and both are surfaced together.

  Trust tier (only when the keyset is complete and clean):
  - `'verified'` iff `verifiedSet` non-empty **and** `announcedSet ⊆ verifiedSet` (every
    currently-announced key verified — a previously-verified key the peer has since retired
    does not block the check, since `verifiedSet` is then a superset).
  - `'unverified-keyset'` (re-verify nudge) iff `verifiedSet` non-empty **and** some announced
    fp `∉ verifiedSet`.
  - `'tofu'` iff `verifiedSet` empty (blind-trusted).

  A conversation is **never** called fully verified while a rejection stands, and Fluux never
  silently falls back to plaintext for a rejected/incomplete keyset. The derivation reads
  `announcedSet` (authoritative metadata), so a newly-announced key downgrades the shield even
  before its data node is fetched.

### "Verify" action (revised)

The verify dialog presents the peer's **announced keyset** and authenticates **only the
fingerprints the user actually confirmed**:

- **Single announced key** (incl. the shared/local-identity case) → SAS as today.
- **Multiple announced keys** → **manual full-set fingerprint compare**: every displayed
  fingerprint must be independently confirmed against what the peer states their own keyset to
  be. **No set-SAS** — deriving one SAS from both sides' PEP view is circular (the server
  controls that view), so it would silently authenticate an injected key. Manual compare is
  sound because the human peer authoritatively states their keyset.

Confirming **unions** the authenticated fingerprints into the JID's verified set (see below).
`VerifyPeerDialog` gains a set mode that renders the announced fingerprints and yields the
confirmed fingerprint **array**.

## Store changes

| Store | Today | After |
|---|---|---|
| peer key cache (`peerKeys`) | `Map<JID, KeyBundle>` | `Map<JID, KeyBundle[]>`, deduped by fp |
| `verifiedPeerKeysStore` | `Record<JID, string>` | `Record<JID, string[]>` |
| `keyChangeAlertsStore` | one alert/JID, blocks encrypt | **retired for OX** — re-verify state is *derived*, not stored |
| `pinnedPrimaryFingerprintsStore` | one pinned fp/JID, gates encrypt | **retired for OX** — BTBV blind-trusts announced keys, so the gate has no job |

Verified-set mutation is **union-in / explicit-remove / snapshot-replace**, never
replace-on-verify:

- `addVerifiedFingerprints(jid, fps[])` — the **verify** action; unions the authenticated
  fingerprints in. Never removes, so a retired-but-previously-verified key stays verified for
  historical messages signed by it.
- `removeVerifiedFingerprint(jid, fp)` / `clearPeerVerified(jid)` — **explicit revoke**.
- `applyVerifiedSnapshot(map)` — used **only** when applying an authoritative remote sync
  snapshot; may shrink a set (that is how a remote revoke propagates — see Migration).
- `isPeerVerified(jid, fp)` becomes set membership; `getVerifiedFingerprints(jid): string[]`.

**Deliberate trade-off:** retiring the pin drops the cosmetic "recently trusted" (tofu-new,
< 7 days) indicator, which was keyed off `pinnedAt`. Accepted. If it must stay, derive it from
the cache's earliest-seen timestamp instead — noted, not planned.

### Reactive announced-keyset surface (required)

Today [`useConversationEncryptionState`] re-renders on a new key partly because `cachePeerKey`
writes the pin *store* (a reactive Zustand store). Once the pin retires and only the plugin's
private `Map<JID, KeyBundle[]>` changes, React would not re-render — the derived state would go
stale until conversation re-entry.

The plugin exposes a **narrow reactive keyset surface**, mirroring the existing plugin-owned
verified store pattern (`useSyncExternalStore`):

- `getPeerFingerprints(jid): string[]` — the **active** validated-cache fingerprints for a peer.
- `getAnnouncedFingerprints(jid): string[]` — the authoritative announced set (drives the
  shield downgrade before a data-node fetch completes).
- `getPeerKeysetHealth(jid): PeerKeysetHealth` where
  `PeerKeysetHealth = { incomplete: boolean; rejections: CertRejection[] }` — **incomplete and
  rejected can coexist**, so health is a struct, not a single enum.
- `subscribePeerKeys(jid, listener)` — **per-JID** (not a global listener), fires on any change
  to that peer's announced/validated sets or health.

Snapshots returned to `useSyncExternalStore` are **normalized, sorted, deduplicated, and
referentially stable** (same array reference until the underlying set actually changes) — a
fresh array every render would loop the store.

## Crypto layer, cache & Rust

### Metadata freshness (persisted "active" is tentative)

`probePeer` short-circuits on a warm persisted cache without refreshing PEP. So after an offline
period the cached active flags are stale: a key **revoked** while offline still reads active, and
a **newly-announced** key is missing. The existing incomplete model covers a data-node fetch
failing *after* we have metadata — not a failure to obtain a **current metadata snapshot** at
all. Freshness rules:

- Persisted active flags are **tentative** after startup/reconnect.
- The **first send to a peer this session requires a definitive metadata refresh** (a successful
  fetch of the authoritative announced set). Until then the keyset is treated as not-yet-fresh.
- A **metadata-fetch failure** yields `keyset-incomplete` for a peer (fail-closed, blocks the
  send, retries) and, for the **own** keyset, the already-chosen degraded-send policy (degraded +
  permanent-loss warning for a normal peer; deferred for self-chat).
- **PEP notifications** refresh this state during the session (they already drive
  `onPeerKeysChanged`), so a mid-session revoke/add is picked up without another blocking probe.

### Atomic refresh (partial-failure policy)

A refresh must never silently encrypt to a *subset* of the announced keys (XEP-0374 §2.3.1).
Announced / validated-cache / completeness are modelled separately and reconciled only on a
**definitive** refresh:

1. Fetch the authoritative **announced** fingerprint set from the metadata snapshot. A failure
   here is itself `keyset-incomplete` (see Metadata freshness) — not an empty announced set.
2. For each announced fingerprint, fetch + validate its data node → valid / definitively
   invalid / transient (per the classification above).
3. **Definitively-invalid** announced keys are recorded as rejections and **excluded** from the
   validated cache — they are not valid recipients. Their presence sets keyset-health
   `rejected` (surfaced, non-blocking).
4. A **still-announced** fingerprint with a **transient** failure and no previously-validated
   cert makes the refresh **incomplete** → keyset-health `incomplete` (fail-closed). If we hold
   a prior validated cert for it, retain that cert across the blip.
5. Commit a replacement validated cache only on a definitive refresh (every announced
   fingerprint resolved to valid-or-definitively-invalid). A fingerprint that **left** the
   announced set is **marked inactive, not deleted** (see Retained certs), and only on a
   definitive refresh — so a transient blip never drops or deactivates a valid key.

### Retained certs (verification survives retirement, but not for new traffic)

Pruning a retired certificate outright would break the "a retired-but-verified key stays
verified for its history" promise for **newly-retrieved** MAM: a message signed by that key
needs its cert to verify the signature at decrypt time. So a departed announced key is marked
**inactive** (stamped with `inactiveAt`) rather than deleted, and its validated cert is retained
for **verification only** — but strictly for messages **eligible under the archive-time policy**:

- **Encrypt** uses only **active** validated certs (we stop encrypting to retired keys).
- **Decrypt/verify** always uses **active** certs. An **inactive** cert is added to the verifier
  set **only** for a message eligible under the archive-time policy:
  - decrypting **MAM** whose `archiveTimestamp < inactiveAt` (with a small clock tolerance), or
  - completing **deferred verification** for a message received before `inactiveAt`.
- A **live** message (no archive timestamp, or later than `inactiveAt`) signed *only* by an
  inactive key bakes **`untrusted`**, even if that fingerprint is historically verified. This is
  the security point: a key is retired precisely because it may be compromised, so it must not
  authenticate fresh traffic.

  Note this eligibility is **not cryptographic proof** of age: a MAM `archiveTimestamp` is
  server-provided and a compromised key can backdate its signed envelope `<time/>`. Archived
  pre-retirement acceptance therefore rests on the **existing MAM / envelope-timestamp policy**
  (the same ±7-day skew and archive-delay checks the decrypt path already applies), not on a
  guarantee — it narrows, but does not eliminate, a backdating window for a stolen retired key.
- Already-decrypted messages are unaffected regardless — they re-derive from the baked
  `signerFingerprint` against the verified set, no cert needed.

**Storage bound (a hostile peer can rotate indefinitely):** retain **verified** inactive certs
**indefinitely** (few, meaningful). Cap **unverified** inactive certs **per peer with an LRU**,
so an adversary spamming key rotations cannot grow storage without bound.

### Encrypt — fan out to the peer's keyset AND the account's own announced keyset

[`encrypt`] builds its recipient set from **every validated announced key** (definitively-
invalid keys are already excluded; a transient-incomplete peer keyset fails closed — see
below). It fans out to:

- the peer's validated announced keys, **plus**
- the **account's own announced keyset** (the validated set for our own bare JID, probed the
  same way we probe a peer) — Gajim's `encrypt_message` encrypts to the recipient's keys **plus
  every announced key of the sender account plus the local signing key**; without matching
  this, a Gajim sibling can't read a Fluux→third-party message from carbons/MAM, **plus**
- the local cert's own encryption subkeys (always, appended in Rust, no fetch needed).

Recipient certs/subkeys are **deduplicated**, which matters when `peer JID == account JID`
(self-chat) since the peer keyset and own keyset then coincide.

Fail-closed / degraded rules:

- **Peer keyset transient-incomplete** → `peer-keyset-incomplete`: defer the send, retry after
  the next probe (the missing key may be a legitimate peer client).
- **Own keyset transient-incomplete, normal peer** (`peer JID != account JID`) → **send
  degraded**: encrypt to what we have (always incl. the local cert and any cached siblings) and
  surface a **persistent account-level warning** that the loss is *permanent* for that archived
  message — a sibling omitted from the ciphertext can never later decrypt it, though future
  messages recover after refresh. Never silent plaintext. **Staging note:** the degraded *send*
  is Stage 1; the *persistent account-level warning surface* is a **Stage 2** item (it needs a
  store-backed host banner, which belongs with the trust surface). Stage 1 performs the degraded
  send and emits a diagnostic log only — it does not fake a persistent warning it cannot yet
  render.
- **Own keyset transient-incomplete, self-chat** (`peer JID == account JID`) → the own keys
  *are* the intended recipients, so this is a `peer-keyset-incomplete` condition → **defer the
  send** (otherwise we'd strand the very sibling being addressed).

`encryptToRecipient` → `encryptToRecipients(accountJid, recipientPublics: string[], envelope)`.

### Decrypt/verify — accept a signature from any announced key

[`decrypt`] passes the verifier set for the peer: **active** validated publics always, plus any
**inactive** publics eligible under the archive-time policy (MAM `archiveTimestamp <
inactiveAt`, or a deferred-verify message received before `inactiveAt`) — so a retired key
verifies *eligible archived* messages but never a new live one (see Retained certs). For
self-outgoing replay
(the #1059 own-account path) it passes the own-announced validated set. **`ownBundle` (the local
cert) is always included in the self-signature verifier set even if the own-PEP refresh is
incomplete** — it is known locally without a fetch. The Rust verifier reports which
key signed via `output.signerFingerprint`; baked trust uses that to place the signer in
verified/validated/neither, so "accept from any" weakens nothing — an unknown signer still
bakes `untrusted`.

### Rust (`src-tauri/src/openpgp.rs`)

- [`decrypt_and_verify`]: `sender: Option<Cert>` → `senders: Vec<Cert>`; `get_certs` returns
  them all so Sequoia matches the signature against whichever key made it. The `check` callback
  recording the verified fp is unchanged.
- [`encrypt_and_sign`]: `recipient_public_armored: &str` → `&[String]`; build the recipient
  list by flat-mapping each cert's alive encryption subkeys (deduped), then append the existing
  encrypt-to-self block verbatim. Signer selection unchanged.
- Tauri command args (`openpgp_decrypt`, `openpgp_encrypt`) change
  `senderPublicArmored`/`recipientPublicArmored: String` → `String[]`. `SequoiaPgpPlugin` and
  its test mock follow.

### Web parity

`WebOpenPGPPlugin` (openpgp.js) gets the same array-shaped `encryptToRecipients` and multi-
verification-key decrypt, keeping web and desktop at parity.

### Untouched

The signcrypt envelope, reflection check, ±7-day skew, the `signatureNotYetValid` retry path,
and the deferred-decrypt stash all operate on the single resulting plaintext + signer fp.

## Migration & cross-version compatibility

### verificationSync — one own identity only (0.17.3 scope)

`verificationSync` encrypts each snapshot **to a single `ownPublicArmored`** and accepts a
snapshot **only when its signer is exactly `ownFingerprint`**. That single-own-key assumption is
**retained deliberately**: verification sync (both `:0` and the new `:1`) works only between
Fluux clients that **share the same OX identity** (same fingerprint — the secret-key-sync case).

Independently-keyed Fluux siblings (a distinct OX key per client) cannot decrypt or authenticate
each other's snapshots, and we **must not** "fix" this by encrypting to / accepting any
own-announced key: a malicious server could inject an own key and then sign forged verification
state with it, handing the server control of trust. Secure sync between independently-keyed
siblings requires an **authorized-own-key mechanism** and is **deferred** (0.18.0). The spec
states this limitation explicitly rather than papering over it.

### verificationSync — new versioned node `:1`, driven by existing LWW (not union)

`verificationSync` already uses a **monotonic `version`, last-writer-wins, replay/rollback
defense** (`remote.version <= lastAppliedVersion → skip`), and `planVerificationUpdate` already
expresses revocation via `toClear` (a key absent from a newer authoritative snapshot is
cleared). The set format `Record<JID, string[]>` is published to a **new node
`urn:xmpp:fluux:verifications:1`** so an old client can never roll back the new set. **Union is
not used** — it would resurrect revoked keys and two migrators with different local state would
not converge.

On 0.17.3 startup:

1. Read `:1`. **If it exists → use it and never consult `:0`.** Its existence is the migration
   marker.
2. **If `:1` is absent** → authenticate `:0` (legacy scalar decodes to version 0), then apply
   the **existing monotonic-version / LWW rule** between the authenticated `:0` snapshot and the
   locally-applied version to choose the authoritative snapshot. Normalize that snapshot to
   arrays and publish it to `:1`.
3. After a concurrent migration, **refetch `:1`** and apply the winner via the same version
   gate.

An old 0.17.2 client may keep writing `:0`, but cannot alter or shrink `:1`. Concurrent
migration resolves by the existing last-writer-wins; the loser's candidate may be dropped —
documented as the **existing under-trust fail-safe** (a lost verification is re-established by
re-verifying), not claimed as union convergence.

### trustStateIntegrity seal — ordered migration, before any store loader

The set shapes change the canonical form (verified as sorted `string[]`; pinned dropped since
OX retires it). Migration is **ordered and gated**, and must run **before any array-aware store
loader rehydrates (and rewrites) old scalar storage** — otherwise automatic rehydration mutates
storage and the old seal appears compromised:

1. Behind an explicit schema/migration gate, **verify the old seal against the raw old-shape
   storage** — detect tampering *before* trusting anything, and before any loader runs.
2. **Migrate all coupled state** together (verified scalar→set, drop pinned, drop OX alerts).
3. **Write the new seal** over the migrated state.

`isTofuBlockedByCompromise` retires with the pin.

### KeyChangeBanner

Kept as a component, driven by the derived `unverified-keyset` state, reworded from "key
changed / blocked" to "new key — re-verify". "Accept without verifying" is no longer needed
(nothing is blocked by a new key); the primary action re-authenticates the announced set. A
separate presentation surfaces `keyset-rejected` (definitive) with fingerprints + reasons.

### DemoOpenPGPPlugin

Seeds a multi-key peer so demo mode and screenshots exercise the fan-out, the
`unverified-keyset` shield state, and a `keyset-rejected` example.

## Testing (TDD, control-checked)

Every assertion is proven to fail against the unfixed code before the fix lands — deliberate
break checks are insufficient on their own (see `project_hollow_test_control_test_technique`),
so each new test is control-checked by neutering the specific production line it targets.

- **Pure** — `mergePublicKeysList` (already landed, PR-A). `resolvePeerTrust` matrix.
  Conversation derivation — keyset-health tier (incomplete blocks; rejected surfaces
  non-blocking; both outrank trust) and trust tier (verified / unverified-keyset / tofu,
  including the retired-verified-key superset case).
- **Rust** — `encrypt_and_sign` to two recipient certs → both decrypt; **a sibling own-account
  key (not the local private key) decrypts a message Fluux sent to a third party**;
  `decrypt_and_verify` with a 2-cert sender list → a signature from either verifies and reports
  the right `signerFingerprint`; unknown signer → present-but-unverified.
- **#1059 exact same-bare-JID fixture** (the gate for closing the issue) — a peer resource of
  the *same bare JID*: (a) live self-addressed message from the other resource; (b) sent carbon;
  (c) MAM replay; (d) sibling-signer verification; (e) sibling-own-key decryption. Confirms
  `isSelfOutgoing`, the reflection check, sender-key selection, and keyset handling agree. Run
  for **both a shared-key and a distinct-key account**.
- **Plugin** (`SequoiaPgpPlugin.test.ts`) — probe caches all announced keys (classified); encrypt
  fans out to every **valid** peer public **and every valid own-announced public**, **deduped
  when peer JID == account JID**; a message signed by a peer's second key decrypts and bakes
  `tofu` (today: `untrusted`); a message signed by a **retired (inactive)** key still verifies;
  after verifying the announced set, a newly-announced key → `unverified-keyset`, re-verify
  restores `verified`; verifying a shown set never blesses a fingerprint absent from it;
  **verify unions (a retired-but-verified key stays verified for its historical messages)**; no
  `pin-mismatch` throw survives (the Stage-1 block-removal).
- **Keyset health** — a **definitively-invalid** announced key (fp/UID mismatch, or no usable
  encryption subkey) is excluded, `keyset-rejected` is surfaced, and encryption still proceeds
  to the valid keys; a **transient** failure on a still-announced key → `peer-keyset-incomplete`
  blocks the send and retries; a previously-validated cert is retained across a transient blip;
  a definitive prune drops a departed key only on a definitive refresh; conversation is never
  "fully verified" while a rejection stands; no silent plaintext fallback.
- **Own keyset** — normal peer with incomplete own keyset → send degraded (local cert always a
  recipient) + persistent account-level warning; **self-chat (peer == own JID) with incomplete
  own keyset → send deferred** (`peer-keyset-incomplete`); `ownBundle` is in the self-sig
  verifier set even when own-PEP is incomplete.
- **Inactive-cert lifecycle** — **an eligible archived message** (under the archive-time policy)
  signed by an inactive key verifies; **a new live message signed only by an inactive key bakes
  `untrusted`** even though its fingerprint is historically verified; unverified inactive certs
  are LRU-capped per peer while verified inactive certs are retained.
- **Metadata freshness** — a warm persisted cache is treated as tentative on reconnect; the first
  peer send triggers a definitive metadata refresh before encrypting; a **metadata-fetch failure**
  (not just a data-node failure) yields `keyset-incomplete` (peer, blocks) / degraded (own); a
  PEP notify refreshes mid-session without a blocking probe.
- **Sync migration** — `:1` present → `:0` ignored; `:1` absent → authenticate `:0`, choose by
  monotonic-version/LWW, publish `:1`; two 0.17.3 clients migrating concurrently resolve by LWW
  and **refetch `:1`** to converge on the winner; **writes to `:0` after migration cannot alter
  or shrink `:1`**; a remote revoke (key absent from a newer snapshot) propagates via `toClear`
  (not resurrected by union). The seal migration **verifies the old seal before any store loader
  runs**.
- **Store/migration** — verified store set semantics; old scalar localStorage migrates to a
  one-element set; reactive `subscribePeerKeys(jid, …)` fires per-JID and returns a
  referentially-stable snapshot.
- **Web parity** — `WebOpenPGPPlugin.test.ts` mirrors the plugin-level multi-key cases.

## Scope boundary

**Explicitly NOT in 0.17.3**, deferred to the 0.18.0 OMEMO convergence:

- Per-key management UI; verify/revoke of an individual key; QR verification.
- Folding these stores onto OMEMO's shared `TrustState`.

When `features/omemo` merges it already rebuilds trust; these set-shaped stores are the
reconciliation point. The spec flags this so the merge does not silently regress OX to
single-key.

## Files touched

`OpenPGPPluginBase.ts`, `SequoiaPgpPlugin.ts` + `.test.ts`, `WebOpenPGPPlugin.ts` + `.test.ts`,
`DemoOpenPGPPlugin.ts`, `src-tauri/src/openpgp.rs`, `verifiedPeerKeysStore.ts`,
`keyChangeAlertsStore.ts` (retire OX writes), `pinnedPrimaryFingerprintsStore.ts` (retire OX
use), `messageTrust.ts`, `useConversationEncryptionState.ts`, `ChatHeader.tsx` (new
`unverified-keyset` + `keyset-rejected`/`keyset-incomplete` states), `KeyChangeBanner.tsx`
(reword) and a rejected-keyset presentation, `VerifyPeerDialog.tsx` (set mode, manual full-set
compare — no set-SAS), `verificationSync.ts` (new `:1` node + migration), `trustStateIntegrity.ts`
(ordered, gated migration), verify call sites (`ChatView.tsx`, `ContactProfileView.tsx`), plus
new `resolvePeerTrust.ts` (+ `.test.ts`) and the reactive keyset surface on the plugin.

Already landed on this branch (PR-A, the publish-clobber half of the interop breakage):
`oxPublicKeysList.ts` + `.test.ts`, and the merge-on-publish wiring in `OpenPGPPluginBase.ts`.

## Suggested implementation staging

The plan should stage this (each stage independently shippable and testable):

- **Stage 1 — crypto/interop.** `Map<JID, KeyBundle[]>` cache (active/inactive) + migration,
  atomic refresh with the valid/definitively-invalid/transient classification, own-announced
  keyset, encrypt fan-out over **valid** announced keys (+ dedup, degraded/deferred rules),
  multi-cert decrypt/verify (active + inactive), Rust `encrypt_and_sign`/`decrypt_and_verify`
  signatures, and the **metadata-freshness** rules (tentative-on-reconnect, definitive refresh
  before first send). **Must also stop reading/writing the single-fingerprint pin as the
  `pin-mismatch` encrypt gate** — otherwise a cached second key still throws and Stage 1 breaks
  encryption. This is the minimal BTBV shim: stop blocking on an additional key, but **leave the
  pin's persisted data intact** — Stage 2's ordered seal migration must verify the *old* seal
  against the old-shape storage, so Stage 1 must not delete or rewrite the pin/alert stores. (The
  verified-set UI and derived `unverified-keyset` presentation also stay in Stage 2; only the
  gate-removal is required here.) Closes the interop breakage and the #1059 fixture.
- **Stage 2 — trust surface.** Verified sets (union/remove/snapshot), `resolvePeerTrust`,
  conversation health+trust tiers, reactive keyset surface, `VerifyPeerDialog` set mode,
  `KeyChangeBanner`/rejected presentation, `verificationSync` `:1` migration, and the ordered
  seal migration that verifies the old seal and then drops the now-unused pin/alert stores.
