# `@fluux/omemo-plugin` — OMEMO E2EEPlugin Adapter (Milestone 2, sub-project M2a)

**Date:** 2026-07-15
**Status:** Approved (design) — pending implementation plan
**Branch:** `features/omemo`
**Depends on:** `@fluux/omemo` (milestone #1, library core — complete, crypto interop validated vs twomemo 2.1.0)

> Sensitive strategic context lives in `private/E2EE_PLUGIN_ARCHITECTURE.md`. Keep public
> artifacts free of strategy detail.

## Background

Milestone #1 delivered `@fluux/omemo`: a standalone, XMPP-agnostic OMEMO 2 crypto core (X3DH +
Double Ratchet + payload cipher), with full crypto-transport interop proven against the
`python-omemo`/`twomemo` 2.1.0 reference. It is wired to nothing.

The Fluux SDK already hosts a mature, protocol-agnostic E2EE plugin architecture, proven by a
real OpenPGP plugin (`OpenPGPPluginBase` + `SequoiaPgpPlugin`/`WebOpenPGPPlugin`, app-side):

- `E2EEManager` (`packages/fluux-sdk/src/core/e2ee/E2EEManager.ts`) hosts plugins, selects by
  `securityLevel`, caches capability, enforces send policy, dispatches inbound claim/decrypt.
- The `E2EEPlugin` trait + `PluginContext` (`packages/fluux-sdk/src/core/e2ee/types.ts`) give a
  plugin `PluginStorage` (namespaced opaque-bytes KV), `XMPPPrimitives` (full PEP:
  `publishPEP`/`queryPEP`/`subscribePEP`/`retractPEP`/`deletePEP` + `queryDisco` + `sendStanza`),
  a logger, account info, and the `reportSecurityContextUpdate`/`notifyKeyUnlocked` channels.
- The stanza pipeline calls `manager.encryptOutbound({kind:'direct', peer}, plaintextBytes)`
  (`Chat.ts`) and `claimInbound`/`decryptInbound`/`decryptArchive` (`stanzaDecrypt.ts`, shared by
  live + MAM). Deferred-decrypt, self-outgoing/archive contexts, and even a "peer sent OMEMO but
  we can't read it" EME notice already exist.
- `stanzaAdapter.ts` converts the trait's JSON-serializable `XMLElementData` ⇄ ltx `Element`.

So milestone #2 is **"write the second `E2EEPlugin`, the OMEMO one, analogous to the OpenPGP
plugin"** — the host, PEP primitives, pipeline, and deferred-decrypt are free.

Milestone #2 decomposes into sub-projects; **this spec is M2a**: the headless OMEMO plugin core,
unit-tested against a mock `PluginContext`, gated on body-level interop. Later sub-projects (own
specs): M2b app registration + platform storage/encryption-at-rest + UI generalization; M2c
verification UX + device management; M2d MAM/undecryptable refinements. The legacy `axolotl`
bridge is milestone #3.

## Locked-in decisions (from the brainstorming session)

1. **First sub-project = M2a**: the headless plugin core (crypto + SCE + PEP + store + BTBV
   trust), no app UI, no registration.
2. **Location = a new standalone package** `@fluux/omemo-plugin` (`packages/omemo-plugin/`), MIT.
   Depends on `@fluux/omemo` (crypto) + `@fluux/sdk` (trait types). Reusable, opt-in; keeps
   `@fluux/omemo` out of the base SDK's dependency graph.
3. **Success is gated on body-level interop** against twomemo (not just unit tests).
4. **Library-boundary refactor**: `@fluux/omemo` becomes content-agnostic (the adapter owns SCE).

## Package & boundary

- **`@fluux/omemo-plugin`**, `packages/omemo-plugin/`, MIT, ESM, `tsup` build, `vitest` tests,
  `tsc` typecheck, `eslint` — mirroring the `@fluux/omemo` package conventions so a future
  `@fluux/openpgp-plugin` can copy the shape.
- Dependencies: `@fluux/omemo` (crypto) + `@fluux/sdk` (import the `E2EEPlugin` trait and
  supporting types **only**). No app import, no `@xmpp/*` (all XML is `XMLElementData`).
- Export surface: a single `OmemoPlugin` class implementing `E2EEPlugin` (analogous to a future
  `OpenPgpPlugin`), plus the OMEMO namespace constants for the app registrar's convenience.
- **Headless**: no `apps/fluux` changes in M2a. All behavior is exercised against a mock
  `PluginContext` (in-memory PEP + `PluginStorage`) that the package ships as a test util —
  structured so `@fluux/openpgp-plugin` can reuse it later (no premature shared base extracted
  now; YAGNI).

## Library-boundary refactor (`@fluux/omemo`)

`OmemoAccount.encrypt`/`decrypt` currently wrap the body in the library's placeholder SCE
envelope (`omemo2/sce.ts`). For real XEP-0420 interop the adapter must own SCE, so:

- `OmemoAccount.encrypt(peer, deviceIds, content: Uint8Array)` — `content` is opaque plaintext
  (the adapter passes serialized SCE `<envelope>` bytes). Internally: `payloadEncrypt(content)`
  directly; **remove the internal `buildEnvelope` call**.
- `OmemoAccount.decrypt(...)` returns the raw recovered `content` bytes (no `parseEnvelope`).
- **Delete `packages/omemo/src/omemo2/sce.ts` and `sce.test.ts`** — the placeholder is superseded
  by the adapter's real SCE. Update `OmemoAccount.test.ts` (assert on content bytes) and the venv
  interop harness (`emit_to_bob.mjs` passes content bytes; the reference recovers them).

**Multi-recipient encryption (encrypt-to-self).** OMEMO wraps *one* payload key across the peer's
devices **and** the sender's own other devices, so sibling clients and MAM self-outgoing replay
can read sent messages. A single-`peer` signature cannot do this (it would generate a separate
payload key per JID). So `OmemoAccount.encrypt` is extended:

- `encrypt(recipients: Array<{ jid: string; deviceIds: number[] }>, content: Uint8Array): OmemoMessage`
  — generate one payload key, `payloadEncrypt(content)` once, then ratchet-wrap that key material
  for every device across **all** recipient JIDs.
- The returned `OmemoMessage.keys` entries each carry their recipient **`jid`**
  (`{ jid, rid, kex, data }`) so the adapter can build the per-JID `<keys jid='…'>` groups the
  `<encrypted>` element requires. `decrypt(senderJid, sid, msg, opts?)` is unchanged in shape
  (our device finds its own `rid`); it just ignores the new `jid` tag on keys not addressed to us.

This is the milestone-#1 library change set for M2a: content-agnostic payload + multi-recipient
fan-out. Small, and it removes ~2 modules of dead placeholder while making `@fluux/omemo` match
what its own spec always intended.

## Package modules

```
packages/omemo-plugin/
  package.json  tsconfig.json  tsconfig.build.json  tsup.config.ts  vitest.config.ts  eslint.config.js
  src/
    index.ts              # exports OmemoPlugin + namespace constants
    OmemoPlugin.ts        # implements E2EEPlugin
    namespaces.ts         # urn:xmpp:omemo:2, :devices, :bundles; urn:xmpp:sce:1
    sce.ts                # real XEP-0420 <envelope xmlns='urn:xmpp:sce:1'> build/parse (XMLElementData)
    encryptedElement.ts   # <encrypted xmlns='urn:xmpp:omemo:2'> ⇄ OmemoMessage (header/keys/payload)
    pep.ts                # device-list + bundle node names; publish/fetch/subscribe over XMPPPrimitives;
                          #   Bundle ⇄ <bundle> XML, DeviceList ⇄ <devices> XML
    store.ts              # PluginStorageOmemoStore: OmemoStore backed by PluginStorage (record ⇄ bytes)
    trust.ts              # BTBV state machine → TrustState
    testing/
      MockPluginContext.ts  # in-memory PEP + PluginStorage; reusable test host
```

Each file has one responsibility and a typed interface; all XML crosses the boundary as
`XMLElementData`.

## The SCE seam (interop-critical)

The host hands the plugin a protocol-neutral `<payload xmlns='jabber:client'>[body, …]</payload>`
fragment as the `plaintext: Uint8Array` argument to `encrypt` (built by the host's
`payloadEnvelope.serialize`). The plugin transforms **both directions** so the wire carries real
XEP-0420 SCE while the host stays protocol-neutral:

- **encrypt**: parse the host `<payload>` fragment → move its child elements directly into
  `<content>` → build `<envelope xmlns='urn:xmpp:sce:1'><content>[body…]</content><rpad/>…</envelope>`
  → serialize to bytes → `OmemoAccount.encrypt`.
- **decrypt**: `OmemoAccount.decrypt` → SCE bytes → parse `<envelope>` → take `<content>`'s
  children → re-wrap as the host `<payload xmlns='jabber:client'>` fragment → return as
  `plaintext`.

SCE affixes: `<rpad>` is **mandatory** (random length-hiding padding); `<from>` and `<time>` are
included per the OMEMO SCE profile (`<time>` feeds the trait's `DecryptResult.authoredAt`).

## `E2EEPlugin` method mapping

| trait method | OMEMO behavior |
|---|---|
| `descriptor` | `id: 'omemo:2'`, `securityLevel: 80`, features: forwardSecrecy+PCS+multiDevice+asynchronous true, groupChat false (M2a is 1:1), deniability true |
| `init(ctx)` | stash `ctx`; construct `OmemoStore` over `ctx.storage`; lazily load/create `OmemoAccount` |
| `ensureIdentity` | `OmemoAccount.create/load`; publish our **bundle** to `urn:xmpp:omemo:2:bundles` (node open) and add our device id to `urn:xmpp:omemo:2:devices`; return the Curve25519 fingerprint |
| `probePeer` | `queryPEP(peer, :devices)`; `supported` if the peer advertises ≥1 device; also `subscribePEP` for updates; cache with `ttl` |
| `openConversation` | resolve target device set = peer's device-list ∪ our own **other** devices (encrypt-to-self); for any device without a session, `queryPEP` its bundle and `processBundle` |
| `encrypt(handle, plaintext)` | SCE-wrap (§ SCE seam) → `OmemoAccount.encrypt(recipients, sceBytes)` where `recipients` = `[{peer, peerDeviceIds}, {ourJid, ourOtherDeviceIds}]` (total fan-out capped ~50) → `encryptedElement.build` groups the jid-tagged keys into `<keys jid>` → `EncryptedPayload{ stanzaElement, fallbackBody }` |
| `tryClaimInbound(child)` | claim iff `child.name==='encrypted' && xmlns==='urn:xmpp:omemo:2'`; extract into `EncryptedPayload` |
| `decrypt` / `decryptArchive` | `encryptedElement.parse` → find our device's `<key>`; `OmemoAccount.decrypt` (`{archive:true}` for MAM, honoring `isSelfOutgoing`) → SCE-unwrap → `DecryptResult`. Map: empty/keytransport → `status:'control-message'`; unrecoverable ratchet → `status:'broken-session'`; recovered-but-untrusted-device → `status:'unverifiable'` with reduced trust |
| `decryptArchiveBatch` | loop `decryptArchive` over the page (freeze once), aligned by index |
| `repairSession(handle, peer)` | discard the broken session for that device + send an empty keytransport `<encrypted>` (via `ctx.xmpp.sendStanza`) to re-handshake; idempotent |
| `getVerificationMethods` | one method: `fingerprint-compare` (out-of-band fingerprint match) |
| `getPeerTrust`/`getDeviceTrust` | read BTBV trust records (§ Trust) → `TrustState` |
| `configure?` | accept `{ deviceCap?, prekeyLowWater? }`; validate + ignore unknown keys |

The `<encrypted>` element shape (XEP-0384 OMEMO 2): `<encrypted xmlns='urn:xmpp:omemo:2'>
<header sid='N'><keys jid='…'><key rid='N' kex='true|false'>b64</key>…</keys>…</header>
<payload>b64</payload></encrypted>` — one `<keys>` group per recipient JID (peer + self).
`encryptedElement.build` groups `OmemoMessage.keys` (each `{ jid, rid, kex, data }`) by `jid`;
`encryptedElement.parse` flattens them back, tagging each with its group's `jid`, via
`codec.b64encode/decode`.

## Trust — BTBV (Blind Trust Before Verification)

- Before the user verifies **any** device of a peer: new devices are auto-accepted as `tofu` so
  messaging works without friction (Conversations' default).
- Once the user verifies one fingerprint for a peer, that peer flips to **verified mode**:
  already-trusted devices stay, but subsequently-unseen devices are `untrusted` until explicitly
  verified.
- Stored per-`(peer, deviceId)` in the `OmemoStore` trust records (`{ state, identityKey }`).
- M2a implements the trust **logic** + the `fingerprint-compare` verification method (compute +
  compare fingerprints); the verification **UI** and device-management screens are a later
  sub-project.

## Storage

`store.ts` implements `@fluux/omemo`'s `OmemoStore` interface over the host's `PluginStorage`
(namespaced opaque bytes): each record (identity, signed prekey, prekeys, per-device session,
trust) is serialized to bytes under a stable key and read back. Prekey consumption and session
updates map to `put`/`delete`.

**Encryption-at-rest is out of scope for M2a** — it is the injected `StorageBackend`'s
responsibility (web: IndexedDB; desktop: a keychain-wrapped backend the app provides in M2b). The
headless plugin stores via `PluginStorage` as-is; the at-rest posture is chosen where the backend
is injected.

## Error handling

- Missing/failed peer bundle or empty device-list → `probePeer` reports unsupported; the host's
  existing plaintext-policy path handles it (never silent plaintext).
- Malformed inbound `<encrypted>` / SCE / protobuf → throw (the host records a could-not-decrypt
  placeholder); never silently accept.
- Auth failures inside `OmemoAccount.decrypt` propagate; `broken-session` triggers
  `repairSession`.
- PEP publish `precondition-not-met` (node persists with an incompatible access model) →
  `deletePEP` then retry once, per the trait's documented self-heal.

## Testing — gated on body-level interop

**Unit (mock `PluginContext`):**
- SCE round-trip: host `<payload>` fragment → SCE `<envelope>` → back, `<rpad>` present, `<body>`
  preserved, multi-byte UTF-8 intact.
- `<encrypted>` XML ⇄ `OmemoMessage` round-trip (sid, per-device keys, kex flag, payload).
- PEP: `ensureIdentity` publishes bundle + device-list to the mock; `probePeer` reads them.
- End-to-end between two `OmemoPlugin` instances over a shared mock PEP: encrypt → claim → decrypt
  recovers the body; then an established follow-up both directions.
- BTBV transitions (tofu → verified-mode → untrusted-new-device).
- `control-message` (empty) and `broken-session` (dropped ratchet) → `repairSession` paths.

**Interop (the M2a gate):** extend the venv harness (`packages/omemo/src/interop/venv/`) with a
plugin-level scenario: the `OmemoPlugin` builds a full real-SCE `<encrypted>` stanza to a
twomemo-generated bundle, and `twomemo` **decrypts it and parses the XEP-0420 `<envelope>` to
recover the exact body text** — true Conversations-grade body-level interop. Exit 0 = done.

## Out of scope for M2a (YAGNI)

App registration (`registerPlugins.ts`) + platform `StorageBackend` + encryption-at-rest (M2b);
the composer/lock/trust **UI** generalization (currently OpenPGP-shaped) and verification screens
(M2c); MUC/group OMEMO (host models it but `Chat.ts` is 1:1-only); the legacy `axolotl` bridge
(milestone #3).

## Future work (recorded, not this spec)

- **M2b**: register `OmemoPlugin` in `apps/fluux/src/e2ee/registerPlugins.ts` (parallel to the
  OpenPGP guard); provide the platform `StorageBackend` with encryption-at-rest (web IndexedDB;
  desktop keychain-wrapped); generalize the composer/lock UI beyond OpenPGP.
- **`@fluux/openpgp-plugin`** (follow-up): extract the existing app-side `OpenPGPPluginBase` /
  `SequoiaPgpPlugin` / `WebOpenPGPPlugin` into a standalone package adopting the *same* pattern
  this package establishes. It carries a native/Tauri vs web platform seam that
  `@fluux/omemo-plugin` (portable TS) does not — its own spec. This spec's package conventions and
  the `MockPluginContext` test util are the reusable template.
