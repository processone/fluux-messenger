# E2EE Device Identity — Web Backup & Trusted Identity Layer

**Date:** 2026-07-16
**Status:** Design note — not yet scheduled
**Scope:** (1) near-term: browser-device OMEMO identity backup; (2) longer-term: a
cross-signing / trusted identity layer spanning all encryption plugins.

Related docs: [ENCRYPTION.md](ENCRYPTION.md) (current E2EE behavior), `@fluux/omemo`
library core spec `docs/superpowers/specs/2026-07-13-fluux-omemo-library-core-design.md`
(features/omemo branch).

## Problem statement

On the web platform, OMEMO device identity lives in IndexedDB. IndexedDB is wiped by
"clear site data", private windows, switching browsers, and storage-pressure eviction.
Every wipe mints a new device id + identity key, which:

- pollutes the published XEP-0384 device list with dead devices,
- spams every contact with "new device" trust prompts,
- erodes the trust signal OMEMO relies on (users learn to blind-accept),
- exhausts prekey bundles for devices that will never come back.

This is the well-known Converse.js failure mode. Desktop (Tauri) does not have this
problem: durable storage + OS keychain, wipes are rare.

Matrix precedent: Element solves the *trust-churn* and *history* halves with server-side
Secure Secret Storage (cross-signing keys + megolm key backup, encrypted under a recovery
passphrase, uniformly on all platforms) — but every login is still a new device, so the
*device-bloat* half remains (users manually prune stale sessions). OMEMO has no
cross-signing layer, so we take the other route in the near term: restore the device
identity itself. Part 2 covers adding the cross-signing layer later.

---

## Part 1 — Browser-device identity backup (near-term)

### Principle

**Same identity, fresh sessions.** Back up the long-lived device identity so a returning
browser session presents the same fingerprint; never back up ratchet state. Contacts see
no new-device prompt; sessions rebuild transparently via prekey messages.

### Scope: browser devices only

- **Tauri desktop:** own identity per install, stored in OS keychain, never touches the
  backup node. Normal OMEMO multi-device. Desktop's stronger storage guarantees must not
  be weakened by a passphrase-derived server copy.
- **Web:** one logical **"Web device"** per account. First browser session creates the
  identity and writes the backup blob; later browser sessions restore it instead of
  minting a new device.

### What is backed up

| Included | Excluded — and why |
|---|---|
| Device id | Session / ratchet states — **never**. Double Ratchet FS/PCS depends on old chain keys being *deleted*; a server snapshot freezes keys that must be ephemeral, and restoring a stale ratchet that advanced elsewhere causes desync and potential key reuse. Signal forbids session restore for the same reason. |
| Identity key pair (Ed25519) | One-time prekey private halves — on restore we republish a fresh bundle; messages sent to consumed OTPKs fail and peers re-init via prekey message (handled path). |
| Own trust store (BTBV decisions) — optional, see below | Signed prekey — regenerate on restore, republish. |

The trust store is worth including (a restored session that forgot its verification
decisions silently downgrades to blind trust) but it changes security decisions on
restore, so the **whole blob must be AEAD-authenticated** — tampering with trust
decisions must be detectable, not just confidentiality-protected.

### Restore semantics

1. Restore **only into an empty local store** (recovery semantics, not sync semantics).
2. Rebuild nothing session-wise: generate fresh signed prekey + OTPKs, republish bundle,
   re-announce device id in the device list (it is likely still there).
3. Existing peers' sessions to this device id break once; they heal via prekey messages.

### Dual-active guard (the one real trap)

Two browsers restoring the same identity + device id **concurrently** would both ratchet
the same sessions independently → desync at best, key misuse at worst.

Guard: a monotonic **generation counter** inside the encrypted blob.

- On restore, a session adopts the blob's generation and increments it (writes back).
- A live session that observes a blob generation **newer than its own** retires itself:
  drops its OMEMO identity locally and either re-registers as a fresh device or goes
  encrypt-disabled with a UI notice.
- Degrades gracefully: the rare user running two browsers simultaneously ends up with two
  web devices (the pre-backup status quo); the common serial-session case stays at one.

Watch the blob via PEP notifications (`+notify` on the backup node) so the retire happens
promptly, not on next reconnect.

### Storage format & crypto

Reuse the XEP-0373 §5 pattern already shipped for OpenPGP:

- Private PEP node (whitelist access model, `#persist-items`, max_items=1).
- Blob AEAD-encrypted under the **same backup passphrase** as the OpenPGP secret-key
  backup — one passphrase for all of E2EE, consistent UX.
- Same KDF settings and the **verbatim passphrase contract** from #1024 (trim-only
  normalization, legacy fallback + heal-on-restore).
- Node name under our namespace, e.g. `urn:fluux:omemo:backup:0` (OMEMO 2 has no
  standard backup node; do not squat `urn:xmpp:omemo:2:*`).

### Threat model delta

- **Server compromise:** server already controls the device list and can attempt
  device-injection MITM (baseline OMEMO threat, mitigated by verification/BTBV). The
  backup adds one thing: an **offline brute-force target** on the passphrase. With a
  memory-hard KDF at real parameters this is the same risk class already accepted for
  the OpenPGP backup node.
- **Backup cracked:** attacker impersonates the web device *going forward* (identity
  key). Past traffic stays safe — forward secrecy holds precisely because ratchet states
  are not in the blob.
- **Metadata:** blob update timestamps leak activity patterns. Minor; PEP already leaks
  similar signals.
- **Verdict:** no major new risk *if and only if* the ratchet-state exclusion and the
  dual-active guard hold.

### Complementary measure: stale-device pruning

Backup reduces churn; pruning cleans up whatever churn remains. On login, drop own
devices from the published device list that have not been seen for N days (label devices
at creation to make "seen" meaningful). Server-side assistance is also plausible for
deployments we control (ejabberd module pruning dead PEP device-list entries) — keep as
a deployment option, not a protocol dependency.

---

## Part 2 — Resolving device churn with a cross-signing layer (longer-term)

The Part 1 backup keeps *one* device stable. The general fix for device churn — the one
Matrix chose — is one level up: stop making peers trust devices, make them trust the
**account**, and have the account vouch for devices.

### Model (Matrix-style, mapped to XMPP)

- **Master identity key** per account — the single long-lived trust anchor. This is the
  only thing peers ever verify (QR / fingerprint / second channel — once).
- **Self-signing key** (signed by master) signs the account's own device identity keys.
- New device flow: device generates its OMEMO identity → gets signed by the self-signing
  key (via an existing device, or by unlocking the master key from the encrypted backup)
  → peers who trust the master key **auto-trust the new device**. Zero prompts.
- Device churn becomes a cosmetic problem (list hygiene) instead of a trust problem.

### XMPP mapping

No XEP exists for this today. Sketch:

- Master + self-signing public keys published in a PEP node; signatures over device
  identity keys published alongside the device list (or in a parallel node keyed by
  device id).
- Private halves stored in the same passphrase-encrypted backup node family as Part 1 —
  the recovery passphrase becomes the root of the whole identity, exactly like Matrix's
  SSSS recovery key.
- Trust rule replacing raw BTBV: *trust any device carrying a valid self-signing
  signature from a master key you verified*. BTBV remains the fallback for peers without
  cross-signing.

This is a candidate XEP / community contribution — same ecosystem-nudging rationale as
publishing `@fluux/omemo` under MIT.

### Relationship to Part 1

Part 1 is not throwaway: even with cross-signing, a web session still needs *a* signed
identity, and restoring one beats minting + signing a new one on every visit (list
hygiene, prekey waste). Cross-signing removes the *trust prompt* cost of churn; Part 1
removes the *churn* itself for browsers. They compose. Ship Part 1 first; it requires no
peer cooperation.

---

## Part 3 — Trusted identity layer across all encryption mechanisms

The cross-signing idea generalizes: nothing about a master identity key is
OMEMO-specific. Under the plugin architecture, identity should be a **host-level
concern**, not a per-plugin one.

```
                    Account master identity key
                    (verified once, out of band)
                              │ signs
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  OpenPGP primary key   OMEMO device identity   MLS credential
  (Sequoia plugin)      keys (per device)       (future plugin)
```

- **Host owns:** master key lifecycle, the encrypted backup family (one passphrase),
  verification UX (one fingerprint/QR per contact, ever), signature publication,
  the trust store.
- **Plugins own:** their protocol identity material, and expose it to the host for
  signing (extends the `E2EEPlugin` trait: `getIdentityAnchors() -> bytes[]`,
  `onPeerAnchorVerified(...)`).
- **Payoff:** verify a contact once and the verification applies to OpenPGP mail-style
  messages, OMEMO chats, and future MLS rooms alike. Protocol migration (OMEMO → MLS)
  carries trust over instead of restarting it. This also subsumes the existing
  server-tampering defenses (primary-key pin + second channel) — those become properties
  of the master key rather than per-protocol mechanisms.
- **`trustVisual()` stays the single source of truth** for lock/shield semantics; it
  would read from the host trust store instead of per-plugin state.

This is the piece that turns "N encryption plugins" into "one identity, N transports" —
strategically the strongest differentiator in this doc, and the right long-term answer
to device churn. But it depends on Part 2's signing scheme and has ecosystem interop
questions (peers that only understand raw OMEMO fingerprints must keep working), so it
stays a direction, not a commitment.

## Sequencing

1. **Part 1** — web OMEMO identity backup. Small, self-contained, no peer cooperation,
   reuses shipped backup-passphrase machinery. Natural follow-up to the OMEMO plugin
   integration milestone.
2. **Stale-device pruning** — independent, can land any time.
3. **Part 2** — cross-signing. Needs a spec pass (candidate XEP) and multi-device signing
   flows.
4. **Part 3** — host-level identity layer. Fold Part 2's keys into the `E2EEManager`
   when a second protocol (MLS) makes the abstraction pay for itself.

## Open questions

- Backup node write concurrency: PEP max_items=1 last-writer-wins is our conflict
  resolution — is publish-options `#item-id` CAS worth it for the generation counter, or
  is notification-driven retire enough?
- Should the web device id be *reserved* (marked in the blob) so desktop clients never
  garbage-collect it during pruning?
- Trust-store backup scope: own decisions only, or also peer fingerprints seen (helps
  detect server-side device-list rewrites after restore)?
- Part 2 signature format: reuse XEdDSA (already in `@fluux/omemo` primitives) or plain
  Ed25519 over a canonical encoding?
