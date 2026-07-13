# OMEMO 2 interop harness (vs `python-omemo`)

A **tagged, opt-in** harness that validates `@fluux/omemo`'s OMEMO 2 wire output against the
Syndace reference stack (`python-omemo`, MIT). It is **excluded from the default unit run**:
the package `vitest.config.ts` only includes `interop/**` when `VITEST_INTEROP=1`.

> **This harness was NOT executed in the authoring session.** No docker daemon was available
> in that environment, so the interop test has never been run here. The files below are the
> harness scaffolding + contract; the numbers they would print are unverified. Treat a first
> real run as the actual gate. The default unit suite (99 tests, interop excluded), typecheck,
> and lint *were* verified.

## What it validates (and what it does not)

The peer and test exercise the **crypto-transport layers** end to end:

- **X3DH** session establishment on the reference from *our* published bundle;
- the **Double Ratchet** (root/chain KDFs, `mk = HMAC(ck, 0x01)`, DH ratchet);
- the **protobuf wire format** — `OMEMOKeyExchange` / `OMEMOAuthenticatedMessage` /
  `OMEMOMessage`, field numbers and wire types (verified identical to `twomemo_pb2`);
- the **payload-key transport** — the 48-byte `key(32) || auth_tag(16)` carried as the ratchet
  plaintext (matches twomemo's `PlainKeyMaterialImpl.key + .auth_tag`);
- the **AES-256-CBC payload cipher** — HKDF-SHA-256 over the 32-byte key with salt = 32 zero
  bytes and info `"OMEMO Payload"` → `encKey(32) || authKey(32) || iv(16)`, PKCS#7 padding,
  16-byte truncated HMAC tag (byte-for-byte identical to twomemo's `encrypt_plaintext`).

If the reference `decrypt` succeeds without throwing, all of the above interoperate; a failure
localises to a single constant/layout mismatch — first suspects: the HKDF label/salt, the
associated-data ordering (`AD = IK_initiator || IK_responder`, both Ed25519 RFC 8032 form), a
protobuf field number, or the ratchet KDF labels.

### Envelope-format scope limitation (important)

This library's `sce.ts` produces a **placeholder length-prefixed byte envelope**, *not* real
XEP-0420 `<envelope>` XML. Emitting real SCE XML is the future **SDK adapter's** job, not this
crypto core's. Consequence: a full **body-level** round-trip against a *strict XEP-0420*
reference is **not** achievable from this library alone — the reference would recover our custom
envelope bytes, which are not parseable SCE XML.

The harness handles this honestly:

- `python-omemo`'s `Backend.decrypt_plaintext` returns the recovered payload plaintext as
  **opaque bytes** (it does not itself parse SCE), so the peer writes **those raw bytes**
  (base64) to `/shared/plaintext.b64`.
- The TS test then does a small **Fluux-format field-walk** (mirroring `parseEnvelope`, which is
  deliberately not part of the public API) to pull the `body` field out of the recovered bytes
  and assert it equals `interop hello`.

So the reference proves it recovered our exact payload **bytes**; the envelope **XML semantics**
are explicitly out of scope. A body-level test against a strict XEP-0420 reference is a **known
follow-up** for the adapter layer.

## Dependency pin

- **`OMEMO==1.*`** — PyPI package name of `python-omemo` (the 1.x line implements OMEMO 2).
- **`twomemo[xml]`** — the `urn:xmpp:omemo:2` backend, with the `[xml]` extra for the
  `twomemo.etree` XEP-0384 (de)serializers the peer bridges our JSON through.

Both are MIT — reading their public API docs to write the peer is expected and allowed (this is
not libsignal and not GPL/AGPL).

## How to run

```bash
# 1. start the reference peer container (installs OMEMO + twomemo[xml])
cd packages/omemo/src/interop
rm -f shared/peer_storage.json   # gen-bundle wants a fresh identity
docker compose up -d

# 2. run only the tagged interop test
cd -
VITEST_INTEROP=1 npx vitest run packages/omemo/src/interop/interop.test.ts

# 3. tear down
cd packages/omemo/src/interop && docker compose down
```

Expected on a green run: the reference establishes a session from our bundle, decrypts our
message, and the recovered envelope's `body` field is `interop hello`. A failure means a wire
constant diverges from the reference — fix it in the owning task (see suspects above) and re-run.

## File contract

- **`bundle.json`** (peer → us): `{ deviceId, ik, spkId, spk, spkSig, preKeys: [{ id, key }] }`,
  all byte fields base64. Maps to our `Bundle` in `processBundle`.
- **`msg.json`** (us → peer): `{ sid, payload | null, keys: [{ rid, kex, data }] }`, `payload`
  and each `data` base64. `data` is the byte-serialized `OMEMOKeyExchange` (when `kex`) or
  `OMEMOAuthenticatedMessage`. Mirrors our `OmemoMessage`.
- **`plaintext.b64`** (peer → us): base64 of the raw recovered payload bytes (our SCE envelope).
- **`msg_from_peer.json`** (peer → us): same shape as `msg.json`, for the reverse direction.

## Peer script integration points

`peer/omemo_peer.py` is written against the documented `python-omemo` 1.x public API
(`SessionManager` + `twomemo` + `twomemo.etree`). Because the harness could not be executed here,
two spots are marked as integration points whose exact behaviour depends on the installed
version and can only be confirmed on a real run:

1. Which network callbacks `SessionManager.decrypt()` invokes for the **sender** during a
   first-contact key exchange (device-list vs bundle download). The stubs advertise the sender
   device and raise on bundle download, which suffices when the sender IK travels inside the
   `OMEMOKeyExchange`; a stricter build may want alice's bundle cross-checked.
2. Registering **our** bundle with the manager for the reverse (`encrypt`) direction.

Both are commented in the script with the exact expected wiring.
