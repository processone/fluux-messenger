# `@fluux/omemo` — Library Core Design

**Date:** 2026-07-13
**Status:** Approved (design) — pending implementation plan
**Slice:** Milestone #1 of the OMEMO track (library core only)

> Sensitive strategic context lives in `private/E2EE_PLUGIN_ARCHITECTURE.md`. Keep public
> artifacts (branch names, commit messages, PR bodies) free of strategy detail.

## Background & motivation

An OMEMO-2-only client is E2EE-encrypted with essentially nobody: the installed base
(Conversations, Dino, Gajim, Monal, ChatSecure) speaks **legacy OMEMO**
(`eu.siacs.conversations.axolotl`, XEP-0384 ≤ 0.3.0), which is wire-incompatible with
**OMEMO 2** (`urn:xmpp:omemo:2`). The two share the cryptographic core (X3DH + Double
Ratchet) but differ in PEP nodes, bundle serialization, and stanza envelope, so a
legacy-only and an OMEMO-2-only client cannot even discover each other's device lists.

**Locked-in strategic decisions** (from the brainstorming session):

1. **Interop target:** OMEMO 2 primary + legacy bridge. Not OMEMO-2-only.
2. **Crypto core:** one X3DH/Double-Ratchet core with two envelope adapters (OMEMO 2 and,
   later, legacy `axolotl`) — not two independent crypto stacks.
3. **Language & licensing:** implement it ourselves in **TypeScript**. libsignal (AGPLv3)
   and the GPL-3.0 TS ports are ruled out — we cannot use GPL/AGPL code we do not own.
   Cleanroom from published specs.
4. **Milestone sequencing:** OMEMO 2 envelope first, legacy `axolotl` envelope second.
5. **Distribution:** a **standalone, permissively-licensed (MIT)** package — a reusable
   asset that also nudges the ecosystem toward OMEMO 2.
6. **API boundary:** **XMPP-agnostic** — pure crypto + typed data. All XML/PEP lives in the
   SDK adapter, not the library.

This spec covers **only the library core** (`@fluux/omemo`). The SDK plugin adapter
(milestone #2) and the legacy envelope (milestone #3) get their own specs.

## Package & boundaries

- **Package:** `@fluux/omemo`, at `packages/omemo/` in the monorepo.
- **License:** MIT.
- **Runtime dependencies:** `@noble/curves`, `@noble/hashes`, `@noble/ciphers` — nothing
  else. No XML library, no `@xmpp/*`, no import from `@fluux/sdk`.
- **In scope:** X3DH key agreement, Double Ratchet, OMEMO 2 (`urn:xmpp:omemo:2`) message /
  bundle / device-list serialization **to and from typed data structures**, XEdDSA
  signatures, identity fingerprints, SCE (XEP-0420) envelope build/parse.
- **Explicitly NOT in scope:** touching the socket, building or parsing XMPP stanzas,
  persisting any state, deciding trust *policy*, timers/rotation scheduling, MUC, MAM,
  key backup/sync, hardware tokens, and the legacy `axolotl` envelope.

The rule that keeps the crypto pure: **the library never persists anything itself** and
**never emits or parses XML**. Consumers inject an `OmemoStore` for persistence and map the
library's typed structures to/from their own stanza model.

## Layered module architecture (bottom-up)

```
primitives/   thin wrappers over @noble: x25519, ed25519, xeddsa, hkdf, hmac,
              aead (aes-256-cbc + hmac-sha256)
identity/     IdentityKeyPair (Ed25519), edwards↔montgomery conversion,
              fingerprint derivation (Curve25519 bytes)
prekeys/      signed-prekey + one-time-prekey generation and rotation bookkeeping
              (pure functions; no timers, no wall-clock)
x3dh/         initiator + responder key agreement (info label "OMEMO X3DH")
ratchet/      Double Ratchet: root chain "OMEMO Root Chain",
              message-key "OMEMO Message Key Material",
              chain-key HMAC constants 0x01 / 0x02
session/      per-(peer, deviceId) session object bound to the injected OmemoStore
sce/          XEP-0420 envelope build/parse: <rpad> (mandatory), <from>, <to> (MUC),
              <time> (optional)
omemo2/       payload cipher + bundle & device-list codecs (typed ⇄ bytes)
index.ts      public API surface
```

Each layer has one purpose, a typed interface, and is independently unit-testable. Layers
below `session/` are pure functions of their inputs; `session/` is the only layer that
touches the store.

## Public API (typed, no XML)

```ts
class OmemoAccount {
  static create(store: OmemoStore, rng?: Rng): Promise<OmemoAccount>  // generate identity + initial prekeys
  static load(store: OmemoStore, rng?: Rng): Promise<OmemoAccount>

  deviceId(): number
  identityFingerprint(): Uint8Array          // Curve25519 bytes; display formatting is the adapter's job
  publishableBundle(): Bundle                // typed; adapter serializes to XML
  publishableDeviceId(): number

  // session lifecycle keyed by peer bare-jid + remote device id
  processBundle(peer: string, rid: number, bundle: Bundle): Promise<void>            // X3DH initiator
  encrypt(peer: string, deviceIds: number[], plaintext: Uint8Array): Promise<OmemoMessage>
  decrypt(peer: string, sid: number, msg: OmemoMessage, opts?: { archive?: boolean }): Promise<Uint8Array>
}

// typed structures the adapter maps to/from its own stanza elements:
type Bundle = {
  ik: Uint8Array                              // Ed25519 identity public key
  spkId: number
  spk: Uint8Array
  spkSig: Uint8Array                          // XEdDSA signature over spk
  preKeys: { id: number; key: Uint8Array }[]  // ~100, min 25
}

type OmemoMessage = {
  sid: number                                 // sender device id
  keys: { rid: number; kex: boolean; data: Uint8Array }[]  // per recipient device
  payload?: Uint8Array                        // encrypted SCE envelope; absent for empty/keytransport
}

type Rng = (n: number) => Uint8Array          // injected randomness for reproducible tests
```

- `decrypt(..., { archive: true })` routes to a **non-ratchet-advancing** decrypt path, so
  the SDK adapter can satisfy the `E2EEPlugin.decryptArchive` invariant: MAM replay must not
  consume forward-only key material that a concurrent live message still needs.
- `encrypt` takes explicit `deviceIds` (the caller resolved the peer's device list); the
  library does not fetch device lists.
- **Responder / new inbound session:** `decrypt` transparently handles the responder side of
  X3DH. When the message's key for our `rid` carries `kex: true`, `decrypt` runs the X3DH
  responder handshake (consuming the referenced one-time prekey via `removePreKey`) and
  establishes the session before decrypting — there is no separate public method for it.

## Store interface (injected — persistence is the consumer's job)

```ts
interface OmemoStore {
  loadIdentity(): Promise<IdentityRecord | null>
  saveIdentity(r: IdentityRecord): Promise<void>

  loadSignedPreKey(id: number): Promise<SignedPreKeyRecord | null>
  saveSignedPreKey(id: number, r: SignedPreKeyRecord): Promise<void>

  loadPreKey(id: number): Promise<PreKeyRecord | null>
  savePreKey(id: number, r: PreKeyRecord): Promise<void>
  removePreKey(id: number): Promise<void>        // one-time prekeys are consumed on use

  loadSession(peer: string, deviceId: number): Promise<SessionRecord | null>
  saveSession(peer: string, deviceId: number, s: SessionRecord): Promise<void>

  loadTrust(peer: string, deviceId: number): Promise<TrustRecord | null>
  saveTrust(peer: string, deviceId: number, t: TrustRecord): Promise<void>
}
```

The library holds no at-rest state. The SDK adapter (milestone #2) supplies an
implementation that **encrypts records before persisting** — encryption-at-rest is that
milestone's concern, not the library's. The library treats records as opaque
serializable values.

## Interop-critical crypto constants

Verified against the current XEP-0384 (`urn:xmpp:omemo:2`) and XEP-0420 on 2026-07-13.
These are load-bearing for byte-level interop and must not drift without re-verification.

- **Identity key:** published in **Ed25519** form in the bundle (`<ik>`); the **fingerprint**
  is derived and displayed in **Curve25519** byte form (Edwards→Montgomery birational map).
- **Signed prekey:** signed with **XEdDSA**; bundle carries the signature (`spks`). Bundle
  SHOULD carry ~100 prekeys, MUST carry at least 25.
- **Payload cipher:** `HKDF-SHA256(info = "OMEMO Payload")` → **80 bytes**, split
  `32 (enc) | 32 (auth) | 16 (IV)`; **AES-256-CBC with PKCS#7 padding**; authenticated with
  **HMAC-SHA256 truncated to 16 bytes (128 bits)**.
- **Double Ratchet:** root chain KDF info `"OMEMO Root Chain"`; message-key KDF info
  `"OMEMO Message Key Material"`; chain-key derivation via HMAC-SHA256 with constants
  `0x01` (message key) and `0x02` (next chain key).
- **X3DH:** associated-data / info label `"OMEMO X3DH"`; Curve25519 / Ed25519 keys.
- **SCE (XEP-0420):** the `<envelope>` always includes a random `<rpad>`; `<to>` is mandatory
  for MUC (out of scope this slice but the codec must support it), `<from>` recommended,
  `<time>` optional.
- **PEP node names** (for the adapter's reference, not used by the library):
  `urn:xmpp:omemo:2:devices`, `urn:xmpp:omemo:2:bundles`, both with `open` access model.

## Testing & interop harness

1. **Known-answer unit tests** per layer: XEdDSA sign/verify vectors, HKDF/HMAC/AEAD
   vectors, ratchet chain progression, X3DH agreement. Pure and fast — run on every unit
   pass.
2. **Live interop harness (tagged CI job):** a containerized `slixmpp-omemo` /
   `python-omemo` peer. Round-trip encrypt→decrypt in **both** directions over OMEMO 2. This
   is the authoritative proof that our cleanroom bytes match a reference implementation.
   Heavy; runs as a separate tagged job, not on every unit run.
3. **Determinism:** all randomness is injected via the `Rng` parameter so tests are
   reproducible and the repo's `Date.now` / `Math.random` prohibition holds. Production
   callers pass a CSPRNG-backed `Rng`.

## Cleanroom discipline (hard constraint)

The implementation is derived **only** from published specifications — Signal's *X3DH* and
*Double Ratchet* documents, XEP-0384, XEP-0420 — and from observed wire bytes during interop
testing. **No reading or porting of libsignal source or any GPL/AGPL TypeScript port.** This
provenance rule is part of the spec so the MIT license is defensible.

## Known limitations (documented, accepted)

- **No constant-time or secure key-zeroization guarantees in JS.** `@noble` mitigates timing
  on the X25519 hot path, but JIT + GC mean private key material cannot be reliably wiped
  from memory. This is inherent to every JS Signal-family implementation. We gain
  memory-safety over a C library (`libomemo-c`) in exchange.
- **Delivery-channel trust boundary is unchanged by the language choice.** The TS core is
  fine on desktop (a trusted local Tauri bundle may generate and hold identity keys). The
  web invariant still holds: a network-delivered browser bundle must not generate or persist
  OMEMO identity keys, so OMEMO stays desktop-first. Enforcing that is the adapter's job, not
  the library's.

## Out of scope for this slice (YAGNI)

- Legacy `axolotl` envelope adapter → milestone #3.
- The `OmemoPlugin` implementing `E2EEPlugin`, PEP publish/fetch, XML serialization,
  encryption-at-rest, trust UX, per-message indicators, undecryptable-history rendering →
  milestone #2.
- MUC OMEMO, MAM UI handling, key backup/sync (XEP-0373 §5-style), hardware tokens.

## How it plugs in later (context, not this slice)

The SDK adapter `OmemoPlugin implements E2EEPlugin` will wrap an `OmemoAccount`:
`ensureIdentity` → `OmemoAccount.create/load` + PEP publish of `publishableBundle()`;
`encrypt`/`decrypt`/`decryptArchive` → the account methods; `tryClaimInbound` and
`EncryptedPayload` (de)serialization → the adapter's XML mapping of `OmemoMessage`;
`getPeerTrust`/`getDeviceTrust`/verification → adapter policy over `OmemoStore` trust
records. The host (`E2EEManager`) already selects by `securityLevel`, so OMEMO 2 and the
later legacy adapter compose as separate plugins with OMEMO 2 preferred when mutual.
