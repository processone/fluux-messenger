# `@fluux/omemo` Library Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone, XMPP-agnostic `@fluux/omemo` TypeScript package: a cleanroom OMEMO 2 (`urn:xmpp:omemo:2`) crypto core (X3DH + Double Ratchet + SCE payload) exposing typed data structures, with an injected store and injected RNG.

**Architecture:** Layered bottom-up modules over `@noble/*` primitives. Pure functions below `session/`; the only stateful boundary is the injected `OmemoStore`. No XML, no PEP, no network — those live in the SDK adapter (a later milestone). Every public entry point is on `OmemoAccount`.

**Tech Stack:** TypeScript (ESM), `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `tsup` (build), `vitest` (test), `tsc` (typecheck), `eslint`.

**Spec:** `docs/superpowers/specs/2026-07-13-fluux-omemo-library-core-design.md`

## Global Constraints

- **Package name:** `@fluux/omemo`; path `packages/omemo/`; license MIT; `"type": "module"`.
- **Runtime dependencies:** `@noble/curves`, `@noble/hashes`, `@noble/ciphers` ONLY. No XML lib, no `@xmpp/*`, no `@fluux/sdk` import.
- **Cleanroom rule:** implement only from published specs (Signal X3DH & Double Ratchet docs, XEP-0384, XEP-0420) and interop wire bytes. NEVER read or port libsignal or any GPL/AGPL TS port.
- **No wall-clock / no ambient randomness in library code:** all randomness comes through an injected `Rng` (`(n: number) => Uint8Array`); any timestamps are passed in by the caller. Tests must be deterministic.
- **Namespace:** OMEMO 2 = `urn:xmpp:omemo:2`. (Legacy `axolotl` is OUT OF SCOPE — a later milestone.)
- **Verified OMEMO 2 constants (do not drift):** payload HKDF info `"OMEMO Payload"` → 80 bytes split `32|32|16`, AES-256-CBC/PKCS#7, HMAC-SHA256 truncated to 16 bytes; ratchet chain step `mk = HMAC(ck, 0x01)`, `ck' = HMAC(ck, 0x02)`; message keys `HKDF(mk, salt=32 zero bytes, "OMEMO Message Key Material", 80)` → `enc|auth|iv`; root info `"OMEMO Root Chain"`; X3DH info `"OMEMO X3DH"`; IK published Ed25519, fingerprint shown as Curve25519 bytes; SCE `<envelope>` always includes random `<rpad>`.
- **OMEMO 2 wire format (the external contract — built from Task 10 onward, NOT deferred):** per-device `<key>` carries a protobuf `OMEMOAuthenticatedMessage {mac=1, message=2}` (established session) or `OMEMOKeyExchange {pk_id=1, spk_id=2, ik=3, ek=4, message=5}` (new session), where `message` is a byte-serialized `OMEMOMessage {n=1, pn=2, dh_pub=3, ciphertext=4}`. Ratchet MAC = `HMAC(authKey, AD || OMEMOMessage_bytes)[:16]` with `AD = Ed25519(IK_initiator) || Ed25519(IK_responder)` (fixed per session, initiator IK first, RFC 8032 32-byte form). The Double Ratchet transports **48 bytes = payloadKey(32) || payloadHmac(16)** per device; `<payload>` holds ONLY the AES-CBC ciphertext of the SCE envelope and is omitted for empty messages (which ratchet-encrypt 32 zero-bytes).
- **Commands:** run from repo root. Test: `npm run test:run -w @fluux/omemo`. Typecheck: `npm run typecheck -w @fluux/omemo`. Lint: `npm run lint -w @fluux/omemo`. Single test file: `npx vitest run packages/omemo/src/<file>.test.ts`.
- **Tests colocate** with source as `*.test.ts` (matches `@fluux/sdk` convention).

---

## File Structure

```
packages/omemo/
  package.json
  tsconfig.json            # extends ../../tsconfig.base.json
  tsconfig.build.json      # excludes *.test.ts for dts emit
  tsup.config.ts
  eslint.config.js
  vitest.config.ts
  src/
    index.ts                       # public API barrel
    primitives/
      hash.ts        hash.test.ts   # sha256, hmac, hkdf wrappers
      curve.ts       curve.test.ts  # x25519 DH, ed25519, edwards<->montgomery
      xeddsa.ts      xeddsa.test.ts # sign/verify with Curve25519 keys
      aead.ts        aead.test.ts   # AES-256-CBC+HMAC OMEMO payload cipher
      bytes.ts       bytes.test.ts  # concat, equal, u32 helpers, constant-time eq
    store/
      types.ts                     # OmemoStore + record types
      MemoryStore.ts MemoryStore.test.ts  # in-memory test double
    identity/
      identity.ts    identity.test.ts     # IdentityKeyPair, fingerprint
    prekeys/
      prekeys.ts     prekeys.test.ts      # signed prekey + one-time prekeys
    x3dh/
      x3dh.ts        x3dh.test.ts         # initiator + responder agreement
    omemo2/
      wire.ts        wire.test.ts         # OMEMO 2 protobuf: OMEMOMessage/AuthenticatedMessage/KeyExchange
      codec.ts       codec.test.ts        # Bundle / DeviceList / OmemoMessage typed structs + base64
      sce.ts         sce.test.ts          # XEP-0420 envelope build/parse
    ratchet/
      ratchet.ts     ratchet.test.ts      # Double Ratchet (AES-256-CBC msg cipher, MAC over AD)
    account/
      OmemoAccount.ts  OmemoAccount.test.ts  # orchestration
    interop/
      interop.test.ts                     # tagged; round-trip vs python-omemo
      docker-compose.yml
      peer/                               # slixmpp-omemo test peer script
```

---

### Task 1: Scaffold the `@fluux/omemo` package

**Files:**
- Create: `packages/omemo/package.json`
- Create: `packages/omemo/tsconfig.json`
- Create: `packages/omemo/tsconfig.build.json`
- Create: `packages/omemo/tsup.config.ts`
- Create: `packages/omemo/vitest.config.ts`
- Create: `packages/omemo/eslint.config.js`
- Create: `packages/omemo/src/index.ts`
- Create: `packages/omemo/src/primitives/bytes.ts`
- Test: `packages/omemo/src/primitives/bytes.test.ts`

**Interfaces:**
- Produces: `concatBytes(...a: Uint8Array[]): Uint8Array`, `bytesEqual(a, b): boolean` (constant-time), `u32be(n: number): Uint8Array`, `type Rng = (n: number) => Uint8Array`.

- [ ] **Step 1: Create `packages/omemo/package.json`**

```json
{
  "name": "@fluux/omemo",
  "version": "0.0.0",
  "description": "Cleanroom OMEMO 2 (urn:xmpp:omemo:2) implementation in TypeScript. XMPP-agnostic crypto core.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "lint:fix": "eslint src --fix",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@noble/ciphers": "^1.2.1",
    "@noble/curves": "^1.8.1",
    "@noble/hashes": "^1.7.1"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "eslint": "^9.17.0",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "typescript-eslint": "^8.18.1",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `packages/omemo/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["vitest/globals", "node"],
    "strict": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/omemo/tsconfig.build.json`** (dts without tests)

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/interop/**"]
}
```

- [ ] **Step 4: Create `packages/omemo/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  tsconfig: './tsconfig.build.json',
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
})
```

- [ ] **Step 5: Create `packages/omemo/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Interop tests are heavy and require docker; opt-in via VITEST_INTEROP=1.
    exclude: process.env.VITEST_INTEROP ? [] : ['**/interop/**', '**/node_modules/**'],
  },
})
```

- [ ] **Step 6: Create `packages/omemo/eslint.config.js`**

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ['dist/**'] },
)
```

- [ ] **Step 7: Write the failing test** `packages/omemo/src/primitives/bytes.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { concatBytes, bytesEqual, u32be } from './bytes'

describe('bytes helpers', () => {
  it('concatBytes joins in order', () => {
    expect(concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]))).toEqual(new Uint8Array([1, 2, 3]))
  })
  it('bytesEqual is true for equal, false for different length or content', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
  })
  it('u32be encodes big-endian', () => {
    expect(u32be(0x01020304)).toEqual(new Uint8Array([1, 2, 3, 4]))
  })
})
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/primitives/bytes.test.ts`
Expected: FAIL — cannot resolve `./bytes`.

- [ ] **Step 9: Create `packages/omemo/src/primitives/bytes.ts`**

```ts
/** Injected randomness. Production passes a CSPRNG; tests pass a deterministic source. */
export type Rng = (n: number) => Uint8Array

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

/** Constant-time-ish equality. Length leak is acceptable (public-length data). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}
```

- [ ] **Step 10: Create `packages/omemo/src/index.ts`** (placeholder barrel; grows per task)

```ts
export type { Rng } from './primitives/bytes'
export { concatBytes, bytesEqual, u32be } from './primitives/bytes'
```

- [ ] **Step 11: Install and verify**

Run: `npm install`
Then: `npm run test:run -w @fluux/omemo` → Expected: PASS (3 tests).
Then: `npm run typecheck -w @fluux/omemo` → Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/omemo package-lock.json
git commit -m "feat(omemo): scaffold @fluux/omemo package with byte helpers"
```

---

### Task 2: Hash primitives (SHA-256, HMAC, HKDF)

**Files:**
- Create: `packages/omemo/src/primitives/hash.ts`
- Test: `packages/omemo/src/primitives/hash.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `sha256(data: Uint8Array): Uint8Array`, `hmacSha256(key, data): Uint8Array`, `hkdf(ikm, salt, info, length): Uint8Array` (HKDF-SHA256, RFC 5869).

- [ ] **Step 1: Write the failing test** with RFC 5869 (HKDF) + RFC 4231 (HMAC) vectors

```ts
import { describe, it, expect } from 'vitest'
import { hmacSha256, hkdf } from './hash'

const hex = (s: string) => Uint8Array.from(s.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('hash primitives', () => {
  it('HMAC-SHA256 RFC 4231 test case 1', () => {
    const key = hex('0b'.repeat(20))
    const data = new TextEncoder().encode('Hi There')
    expect(toHex(hmacSha256(key, data))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
  })
  it('HKDF-SHA256 RFC 5869 test case 1', () => {
    const ikm = hex('0b'.repeat(22))
    const salt = hex('000102030405060708090a0b0c')
    const info = hex('f0f1f2f3f4f5f6f7f8f9')
    expect(toHex(hkdf(ikm, salt, info, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/primitives/hash.test.ts`
Expected: FAIL — cannot resolve `./hash`.

- [ ] **Step 3: Create `packages/omemo/src/primitives/hash.ts`**

```ts
import { sha256 as nobleSha256 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf'

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data)
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, data)
}

/** HKDF-SHA256 (RFC 5869): extract-then-expand. */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return nobleHkdf(nobleSha256, ikm, salt, info, length)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/primitives/hash.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo/src/primitives/hash.ts packages/omemo/src/primitives/hash.test.ts
git commit -m "feat(omemo): sha256/hmac/hkdf primitives with RFC vectors"
```

---

### Task 3: Curve primitives (X25519 DH, Ed25519, Edwards↔Montgomery)

**Files:**
- Create: `packages/omemo/src/primitives/curve.ts`
- Test: `packages/omemo/src/primitives/curve.test.ts`

**Interfaces:**
- Produces:
  - `x25519 = { scalarMult(scalar, u): Uint8Array; getPublicKey(scalar): Uint8Array }`
  - `generateX25519(rng: Rng): { priv: Uint8Array; pub: Uint8Array }`
  - `generateEd25519(rng: Rng): { priv: Uint8Array; pub: Uint8Array }` (priv = 32-byte seed)
  - `ed25519PubToMontgomery(edPub: Uint8Array): Uint8Array` (32-byte Curve25519 u-coordinate)
  - `ed25519SeedToMontgomeryPriv(seed: Uint8Array): Uint8Array` (clamped scalar for DH)

- [ ] **Step 1: Write the failing test** with RFC 7748 X25519 vector + conversion round-trip

```ts
import { describe, it, expect } from 'vitest'
import { x25519, generateEd25519, ed25519PubToMontgomery } from './curve'

const hex = (s: string) => Uint8Array.from(s.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('curve primitives', () => {
  it('X25519 RFC 7748 scalar mult vector', () => {
    const k = hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')
    const u = hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
    expect(toHex(x25519.scalarMult(k, u))).toBe(
      'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
    )
  })
  it('ed25519 public converts to a 32-byte montgomery u-coordinate', () => {
    let seed = 1
    const rng = (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0xff))
    const kp = generateEd25519(rng)
    const mont = ed25519PubToMontgomery(kp.pub)
    expect(mont.length).toBe(32)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/primitives/curve.test.ts`
Expected: FAIL — cannot resolve `./curve`.

- [ ] **Step 3: Create `packages/omemo/src/primitives/curve.ts`**

```ts
import { x25519 as nobleX } from '@noble/curves/ed25519'
import { ed25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519'
import type { Rng } from './bytes'

export const x25519 = {
  scalarMult(scalar: Uint8Array, u: Uint8Array): Uint8Array {
    return nobleX.scalarMult(scalar, u)
  },
  getPublicKey(scalar: Uint8Array): Uint8Array {
    return nobleX.getPublicKey(scalar)
  },
}

export function generateX25519(rng: Rng): { priv: Uint8Array; pub: Uint8Array } {
  const priv = nobleX.utils.randomSecretKey ? rng(32) : rng(32)
  return { priv, pub: nobleX.getPublicKey(priv) }
}

export function generateEd25519(rng: Rng): { priv: Uint8Array; pub: Uint8Array } {
  const seed = rng(32)
  return { priv: seed, pub: ed25519.getPublicKey(seed) }
}

/** Convert an Ed25519 public key to its Curve25519 (Montgomery) u-coordinate. */
export function ed25519PubToMontgomery(edPub: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPub(edPub)
}

/** Convert an Ed25519 seed to the clamped Montgomery scalar usable for X25519 DH. */
export function ed25519SeedToMontgomeryPriv(seed: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPriv(seed)
}
```

> Implementation note: `@noble/curves` exposes `edwardsToMontgomeryPub` / `edwardsToMontgomeryPriv` from `@noble/curves/ed25519`. If the installed noble version names them differently, verify the exact export in `node_modules/@noble/curves/esm/ed25519.js` and adjust the import — do not hand-roll the birational map.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/primitives/curve.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo/src/primitives/curve.ts packages/omemo/src/primitives/curve.test.ts
git commit -m "feat(omemo): x25519 + ed25519 + edwards/montgomery conversion"
```

---

### Task 4: XEdDSA sign/verify

**Files:**
- Create: `packages/omemo/src/primitives/xeddsa.ts`
- Test: `packages/omemo/src/primitives/xeddsa.test.ts`

**Interfaces:**
- Consumes: `generateEd25519` (curve.ts).
- Produces: `xeddsaSign(edSeed: Uint8Array, message: Uint8Array, rng: Rng): Uint8Array` (64-byte sig), `xeddsaVerify(edPub: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean`.

> OMEMO signs the SignedPreKey with the identity key. Since our identity key is an Ed25519 key (published as-is in the bundle), signing/verification uses standard Ed25519 over the message — the "XEdDSA" concern (signing with a Montgomery key) does not arise on the OMEMO-2 identity path because the IK is already Ed25519. Keep the function name `xeddsa*` for spec alignment but implement with Ed25519.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { generateEd25519 } from './curve'
import { xeddsaSign, xeddsaVerify } from './xeddsa'

const rng = (n: number) => new Uint8Array(n).fill(7)

describe('xeddsa', () => {
  it('signs and verifies', () => {
    const kp = generateEd25519(rng)
    const msg = new TextEncoder().encode('signed prekey bytes')
    const sig = xeddsaSign(kp.priv, msg, rng)
    expect(sig.length).toBe(64)
    expect(xeddsaVerify(kp.pub, msg, sig)).toBe(true)
  })
  it('rejects a tampered message', () => {
    const kp = generateEd25519(rng)
    const sig = xeddsaSign(kp.priv, new TextEncoder().encode('a'), rng)
    expect(xeddsaVerify(kp.pub, new TextEncoder().encode('b'), sig)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/primitives/xeddsa.test.ts`
Expected: FAIL — cannot resolve `./xeddsa`.

- [ ] **Step 3: Create `packages/omemo/src/primitives/xeddsa.ts`**

```ts
import { ed25519 } from '@noble/curves/ed25519'
import type { Rng } from './bytes'

/**
 * OMEMO-2 signs the SignedPreKey with the Ed25519 identity key. `rng` is accepted
 * for signature interface symmetry with true XEdDSA (which needs 64 random bytes);
 * Ed25519 is deterministic so it is unused here.
 */
export function xeddsaSign(edSeed: Uint8Array, message: Uint8Array, _rng: Rng): Uint8Array {
  return ed25519.sign(message, edSeed)
}

export function xeddsaVerify(edPub: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, edPub)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/primitives/xeddsa.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo/src/primitives/xeddsa.ts packages/omemo/src/primitives/xeddsa.test.ts
git commit -m "feat(omemo): signed-prekey sign/verify"
```

---

### Task 5: OMEMO payload AEAD (AES-256-CBC + HMAC-SHA256)

**Files:**
- Create: `packages/omemo/src/primitives/aead.ts`
- Test: `packages/omemo/src/primitives/aead.test.ts`

**Interfaces:**
- Consumes: `hkdf`, `hmacSha256` (hash.ts), `bytesEqual`, `concatBytes` (bytes.ts).
- Produces:
  - `derivePayloadKeys(masterKey: Uint8Array): { encKey: Uint8Array; authKey: Uint8Array; iv: Uint8Array }` — HKDF info `"OMEMO Payload"`, 80 bytes split 32|32|16.
  - `payloadEncrypt(masterKey, plaintext): { ciphertext: Uint8Array; tag: Uint8Array }`
  - `payloadDecrypt(masterKey, ciphertext, tag): Uint8Array` (throws on auth failure)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { derivePayloadKeys, payloadEncrypt, payloadDecrypt } from './aead'

describe('OMEMO payload AEAD', () => {
  const master = new Uint8Array(32).fill(9)
  it('derives 32|32|16 keys from "OMEMO Payload"', () => {
    const k = derivePayloadKeys(master)
    expect(k.encKey.length).toBe(32)
    expect(k.authKey.length).toBe(32)
    expect(k.iv.length).toBe(16)
  })
  it('encrypt then decrypt round-trips', () => {
    const pt = new TextEncoder().encode('hello omemo')
    const { ciphertext, tag } = payloadEncrypt(master, pt)
    expect(tag.length).toBe(16)
    expect(payloadDecrypt(master, ciphertext, tag)).toEqual(pt)
  })
  it('rejects a tampered tag', () => {
    const { ciphertext, tag } = payloadEncrypt(master, new Uint8Array([1, 2, 3]))
    tag[0] ^= 0xff
    expect(() => payloadDecrypt(master, ciphertext, tag)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/primitives/aead.test.ts`
Expected: FAIL — cannot resolve `./aead`.

- [ ] **Step 3: Create `packages/omemo/src/primitives/aead.ts`**

```ts
import { cbc } from '@noble/ciphers/aes'
import { hkdf, hmacSha256 } from './hash'
import { bytesEqual } from './bytes'

const EMPTY = new Uint8Array(0)
const PAYLOAD_INFO = new TextEncoder().encode('OMEMO Payload')

export function derivePayloadKeys(masterKey: Uint8Array): {
  encKey: Uint8Array
  authKey: Uint8Array
  iv: Uint8Array
} {
  const okm = hkdf(masterKey, new Uint8Array(32), PAYLOAD_INFO, 80)
  return { encKey: okm.slice(0, 32), authKey: okm.slice(32, 64), iv: okm.slice(64, 80) }
}

export function payloadEncrypt(
  masterKey: Uint8Array,
  plaintext: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const { encKey, authKey, iv } = derivePayloadKeys(masterKey)
  const ciphertext = cbc(encKey, iv).encrypt(plaintext) // PKCS#7 padding by default
  const tag = hmacSha256(authKey, ciphertext).slice(0, 16)
  return { ciphertext, tag }
}

export function payloadDecrypt(masterKey: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): Uint8Array {
  const { encKey, authKey, iv } = derivePayloadKeys(masterKey)
  const expected = hmacSha256(authKey, ciphertext).slice(0, 16)
  if (!bytesEqual(expected, tag)) throw new Error('OMEMO payload authentication failed')
  return cbc(encKey, iv).decrypt(ciphertext)
}

void EMPTY
```

> Note: `@noble/ciphers` `cbc(key, iv)` applies PKCS#7 padding. Confirm the salt argument to `hkdf` matches OMEMO's expectation during interop (Task 14); OMEMO uses a zero-filled salt for the payload HKDF.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/primitives/aead.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo/src/primitives/aead.ts packages/omemo/src/primitives/aead.test.ts
git commit -m "feat(omemo): AES-256-CBC + HMAC payload AEAD"
```

---

### Task 6: Store interface + in-memory test double

**Files:**
- Create: `packages/omemo/src/store/types.ts`
- Create: `packages/omemo/src/store/MemoryStore.ts`
- Test: `packages/omemo/src/store/MemoryStore.test.ts`

**Interfaces:**
- Produces: `OmemoStore` interface and records (`IdentityRecord`, `SignedPreKeyRecord`, `PreKeyRecord`, `SessionRecord`, `TrustRecord`), plus `MemoryStore implements OmemoStore`.
- Consumed by: Tasks 7–13.

- [ ] **Step 1: Create `packages/omemo/src/store/types.ts`** (no test yet — pure types)

```ts
export interface IdentityRecord {
  edSeed: Uint8Array // 32-byte Ed25519 seed (private)
  edPub: Uint8Array // 32-byte Ed25519 public
  deviceId: number
}
export interface SignedPreKeyRecord {
  id: number
  priv: Uint8Array // X25519 private
  pub: Uint8Array // X25519 public
  signature: Uint8Array // Ed25519 signature over pub
}
export interface PreKeyRecord {
  id: number
  priv: Uint8Array
  pub: Uint8Array
}
/** Opaque serialized Double-Ratchet session state (produced/consumed by ratchet.ts). */
export type SessionRecord = Uint8Array
export interface TrustRecord {
  state: 'untrusted' | 'trusted' | 'undecided'
  identityKey: Uint8Array // remote Ed25519 IK bound to this device
}

export interface OmemoStore {
  loadIdentity(): Promise<IdentityRecord | null>
  saveIdentity(r: IdentityRecord): Promise<void>

  loadSignedPreKey(id: number): Promise<SignedPreKeyRecord | null>
  saveSignedPreKey(id: number, r: SignedPreKeyRecord): Promise<void>

  loadPreKey(id: number): Promise<PreKeyRecord | null>
  savePreKey(id: number, r: PreKeyRecord): Promise<void>
  removePreKey(id: number): Promise<void>

  loadSession(peer: string, deviceId: number): Promise<SessionRecord | null>
  saveSession(peer: string, deviceId: number, s: SessionRecord): Promise<void>

  loadTrust(peer: string, deviceId: number): Promise<TrustRecord | null>
  saveTrust(peer: string, deviceId: number, t: TrustRecord): Promise<void>
}
```

- [ ] **Step 2: Write the failing test** `packages/omemo/src/store/MemoryStore.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { MemoryStore } from './MemoryStore'

describe('MemoryStore', () => {
  it('round-trips a session and consumes a prekey', async () => {
    const s = new MemoryStore()
    await s.saveSession('bob@x', 5, new Uint8Array([1, 2, 3]))
    expect(await s.loadSession('bob@x', 5)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await s.loadSession('bob@x', 6)).toBeNull()

    await s.savePreKey(1, { id: 1, priv: new Uint8Array(32), pub: new Uint8Array(32) })
    expect(await s.loadPreKey(1)).not.toBeNull()
    await s.removePreKey(1)
    expect(await s.loadPreKey(1)).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/store/MemoryStore.test.ts`
Expected: FAIL — cannot resolve `./MemoryStore`.

- [ ] **Step 4: Create `packages/omemo/src/store/MemoryStore.ts`**

```ts
import type {
  OmemoStore,
  IdentityRecord,
  SignedPreKeyRecord,
  PreKeyRecord,
  SessionRecord,
  TrustRecord,
} from './types'

export class MemoryStore implements OmemoStore {
  private identity: IdentityRecord | null = null
  private signedPreKeys = new Map<number, SignedPreKeyRecord>()
  private preKeys = new Map<number, PreKeyRecord>()
  private sessions = new Map<string, SessionRecord>()
  private trust = new Map<string, TrustRecord>()
  private key(peer: string, deviceId: number) {
    return `${peer}::${deviceId}`
  }

  async loadIdentity() {
    return this.identity
  }
  async saveIdentity(r: IdentityRecord) {
    this.identity = r
  }
  async loadSignedPreKey(id: number) {
    return this.signedPreKeys.get(id) ?? null
  }
  async saveSignedPreKey(id: number, r: SignedPreKeyRecord) {
    this.signedPreKeys.set(id, r)
  }
  async loadPreKey(id: number) {
    return this.preKeys.get(id) ?? null
  }
  async savePreKey(id: number, r: PreKeyRecord) {
    this.preKeys.set(id, r)
  }
  async removePreKey(id: number) {
    this.preKeys.delete(id)
  }
  async loadSession(peer: string, deviceId: number) {
    return this.sessions.get(this.key(peer, deviceId)) ?? null
  }
  async saveSession(peer: string, deviceId: number, s: SessionRecord) {
    this.sessions.set(this.key(peer, deviceId), s)
  }
  async loadTrust(peer: string, deviceId: number) {
    return this.trust.get(this.key(peer, deviceId)) ?? null
  }
  async saveTrust(peer: string, deviceId: number, t: TrustRecord) {
    this.trust.set(this.key(peer, deviceId), t)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/store/MemoryStore.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/omemo/src/store
git commit -m "feat(omemo): OmemoStore interface + in-memory test store"
```

---

### Task 7: Identity keypair + fingerprint

**Files:**
- Create: `packages/omemo/src/identity/identity.ts`
- Test: `packages/omemo/src/identity/identity.test.ts`

**Interfaces:**
- Consumes: `generateEd25519`, `ed25519PubToMontgomery` (curve.ts); `Rng` (bytes.ts).
- Produces:
  - `createIdentity(rng: Rng, deviceId: number): IdentityRecord`
  - `fingerprint(edPub: Uint8Array): Uint8Array` — Curve25519 bytes (32).
  - `randomDeviceId(rng: Rng): number` — 31-bit positive int.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createIdentity, fingerprint, randomDeviceId } from './identity'

const rng = (n: number) => new Uint8Array(n).fill(3)

describe('identity', () => {
  it('creates an identity with a stable curve fingerprint', () => {
    const id = createIdentity(rng, 42)
    expect(id.deviceId).toBe(42)
    expect(id.edPub.length).toBe(32)
    const fp = fingerprint(id.edPub)
    expect(fp.length).toBe(32)
    expect(fingerprint(id.edPub)).toEqual(fp) // deterministic
  })
  it('randomDeviceId is a positive 31-bit int', () => {
    const d = randomDeviceId((n) => new Uint8Array(n).fill(0xff))
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThanOrEqual(0x7fffffff)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/identity/identity.test.ts`
Expected: FAIL — cannot resolve `./identity`.

- [ ] **Step 3: Create `packages/omemo/src/identity/identity.ts`**

```ts
import { generateEd25519, ed25519PubToMontgomery } from '../primitives/curve'
import type { Rng } from '../primitives/bytes'
import type { IdentityRecord } from '../store/types'

export function createIdentity(rng: Rng, deviceId: number): IdentityRecord {
  const kp = generateEd25519(rng)
  return { edSeed: kp.priv, edPub: kp.pub, deviceId }
}

/** OMEMO fingerprint is the identity key in Curve25519 (Montgomery) byte form. */
export function fingerprint(edPub: Uint8Array): Uint8Array {
  return ed25519PubToMontgomery(edPub)
}

export function randomDeviceId(rng: Rng): number {
  const b = rng(4)
  const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) & 0x7fffffff
  return n === 0 ? 1 : n
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/identity/identity.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo/src/identity
git commit -m "feat(omemo): identity keypair + curve fingerprint"
```

---

### Task 8: PreKeys (signed prekey + one-time prekeys)

**Files:**
- Create: `packages/omemo/src/prekeys/prekeys.ts`
- Test: `packages/omemo/src/prekeys/prekeys.test.ts`

**Interfaces:**
- Consumes: `generateX25519` (curve.ts), `xeddsaSign`/`xeddsaVerify` (xeddsa.ts), `Rng`.
- Produces:
  - `generateSignedPreKey(rng, idSeed, edSeed, id): SignedPreKeyRecord`
  - `generatePreKeys(rng, startId, count): PreKeyRecord[]`
  - `verifySignedPreKey(edPub, spk): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createIdentity } from '../identity/identity'
import { generateSignedPreKey, generatePreKeys, verifySignedPreKey } from './prekeys'

const rng = (n: number) => new Uint8Array(n).fill(5)

describe('prekeys', () => {
  it('signed prekey verifies against the identity key', () => {
    const id = createIdentity(rng, 1)
    const spk = generateSignedPreKey(rng, 0, id.edSeed, 1)
    expect(spk.id).toBe(1)
    expect(spk.pub.length).toBe(32)
    expect(verifySignedPreKey(id.edPub, spk)).toBe(true)
  })
  it('generates the requested number of prekeys with sequential ids', () => {
    const pks = generatePreKeys(rng, 100, 25)
    expect(pks).toHaveLength(25)
    expect(pks[0].id).toBe(100)
    expect(pks[24].id).toBe(124)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/prekeys/prekeys.test.ts`
Expected: FAIL — cannot resolve `./prekeys`.

- [ ] **Step 3: Create `packages/omemo/src/prekeys/prekeys.ts`**

```ts
import { generateX25519 } from '../primitives/curve'
import { xeddsaSign, xeddsaVerify } from '../primitives/xeddsa'
import type { Rng } from '../primitives/bytes'
import type { SignedPreKeyRecord, PreKeyRecord } from '../store/types'

export function generateSignedPreKey(rng: Rng, _idSeed: number, edSeed: Uint8Array, id: number): SignedPreKeyRecord {
  const kp = generateX25519(rng)
  const signature = xeddsaSign(edSeed, kp.pub, rng)
  return { id, priv: kp.priv, pub: kp.pub, signature }
}

export function generatePreKeys(rng: Rng, startId: number, count: number): PreKeyRecord[] {
  const out: PreKeyRecord[] = []
  for (let i = 0; i < count; i++) {
    const kp = generateX25519(rng)
    out.push({ id: startId + i, priv: kp.priv, pub: kp.pub })
  }
  return out
}

export function verifySignedPreKey(edPub: Uint8Array, spk: SignedPreKeyRecord): boolean {
  return xeddsaVerify(edPub, spk.pub, spk.signature)
}
```

> Note: with a constant test `rng` all generated keys are identical; that's fine for structural tests. Real callers pass a CSPRNG so keys differ. The X3DH/ratchet tests (Tasks 9–10) use a counter-based rng to get distinct keys.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/prekeys/prekeys.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo/src/prekeys
git commit -m "feat(omemo): signed prekey + one-time prekey generation"
```

---

### Task 9: X3DH key agreement

**Files:**
- Create: `packages/omemo/src/x3dh/x3dh.ts`
- Test: `packages/omemo/src/x3dh/x3dh.test.ts`

**Interfaces:**
- Consumes: `x25519`, `ed25519SeedToMontgomeryPriv`, `ed25519PubToMontgomery` (curve.ts); `hkdf` (hash.ts); `concatBytes` (bytes.ts).
- Produces:
  - `x3dhInitiator(params): { sharedSecret: Uint8Array; ephemeralPub: Uint8Array }`
  - `x3dhResponder(params): { sharedSecret: Uint8Array }`
  - Param shapes documented in code below. Shared secret is 32 bytes, HKDF info `"OMEMO X3DH"`.

- [ ] **Step 1: Write the failing test** — initiator and responder derive the same secret

```ts
import { describe, it, expect } from 'vitest'
import { createIdentity } from '../identity/identity'
import { generateSignedPreKey, generatePreKeys } from '../prekeys/prekeys'
import { x3dhInitiator, x3dhResponder } from './x3dh'

// Counter-based rng so each 32-byte draw differs.
function counterRng() {
  let c = 0
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}

describe('x3dh', () => {
  it('initiator and responder agree on the shared secret', () => {
    const rng = counterRng()
    const alice = createIdentity(rng, 1)
    const bob = createIdentity(rng, 2)
    const bobSpk = generateSignedPreKey(rng, 0, bob.edSeed, 1)
    const bobOtk = generatePreKeys(rng, 1, 1)[0]

    const init = x3dhInitiator({
      identitySeed: alice.edSeed,
      rng,
      remoteIdentityEd: bob.edPub,
      remoteSignedPreKey: bobSpk.pub,
      remoteOneTimePreKey: bobOtk.pub,
    })
    const resp = x3dhResponder({
      identitySeed: bob.edSeed,
      signedPreKeyPriv: bobSpk.priv,
      oneTimePreKeyPriv: bobOtk.priv,
      remoteIdentityEd: alice.edPub,
      remoteEphemeral: init.ephemeralPub,
    })
    expect(resp.sharedSecret).toEqual(init.sharedSecret)
    expect(init.sharedSecret.length).toBe(32)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/x3dh/x3dh.test.ts`
Expected: FAIL — cannot resolve `./x3dh`.

- [ ] **Step 3: Create `packages/omemo/src/x3dh/x3dh.ts`**

```ts
import { x25519, generateX25519, ed25519SeedToMontgomeryPriv, ed25519PubToMontgomery } from '../primitives/curve'
import { hkdf } from '../primitives/hash'
import { concatBytes } from '../primitives/bytes'
import type { Rng } from '../primitives/bytes'

const X3DH_INFO = new TextEncoder().encode('OMEMO X3DH')
// X3DH prepends 32 0xFF bytes (curve identifier) before the DH concatenation.
const F = new Uint8Array(32).fill(0xff)

function kdf(dhConcat: Uint8Array): Uint8Array {
  return hkdf(concatBytes(F, dhConcat), new Uint8Array(32), X3DH_INFO, 32)
}

export interface X3DHInitiatorParams {
  identitySeed: Uint8Array // our Ed25519 seed
  rng: Rng
  remoteIdentityEd: Uint8Array // peer Ed25519 IK
  remoteSignedPreKey: Uint8Array // peer X25519 SPK pub
  remoteOneTimePreKey?: Uint8Array // peer X25519 OTK pub (optional)
}

export function x3dhInitiator(p: X3DHInitiatorParams): { sharedSecret: Uint8Array; ephemeralPub: Uint8Array } {
  const ikPriv = ed25519SeedToMontgomeryPriv(p.identitySeed)
  const spkPub = p.remoteSignedPreKey
  const remoteIkMont = ed25519PubToMontgomery(p.remoteIdentityEd)
  const eph = generateX25519(p.rng)

  const dh1 = x25519.scalarMult(ikPriv, spkPub) // IK_a * SPK_b
  const dh2 = x25519.scalarMult(eph.priv, remoteIkMont) // EK_a * IK_b
  const dh3 = x25519.scalarMult(eph.priv, spkPub) // EK_a * SPK_b
  let concat = concatBytes(dh1, dh2, dh3)
  if (p.remoteOneTimePreKey) {
    const dh4 = x25519.scalarMult(eph.priv, p.remoteOneTimePreKey) // EK_a * OTK_b
    concat = concatBytes(concat, dh4)
  }
  return { sharedSecret: kdf(concat), ephemeralPub: eph.pub }
}

export interface X3DHResponderParams {
  identitySeed: Uint8Array // our Ed25519 seed
  signedPreKeyPriv: Uint8Array // our X25519 SPK priv
  oneTimePreKeyPriv?: Uint8Array // our X25519 OTK priv (if the initiator used one)
  remoteIdentityEd: Uint8Array // peer Ed25519 IK
  remoteEphemeral: Uint8Array // peer ephemeral X25519 pub
}

export function x3dhResponder(p: X3DHResponderParams): { sharedSecret: Uint8Array } {
  const ikPriv = ed25519SeedToMontgomeryPriv(p.identitySeed)
  const remoteIkMont = ed25519PubToMontgomery(p.remoteIdentityEd)

  const dh1 = x25519.scalarMult(p.signedPreKeyPriv, remoteIkMont) // SPK_b * IK_a
  const dh2 = x25519.scalarMult(ikPriv, p.remoteEphemeral) // IK_b * EK_a
  const dh3 = x25519.scalarMult(p.signedPreKeyPriv, p.remoteEphemeral) // SPK_b * EK_a
  let concat = concatBytes(dh1, dh2, dh3)
  if (p.oneTimePreKeyPriv) {
    const dh4 = x25519.scalarMult(p.oneTimePreKeyPriv, p.remoteEphemeral) // OTK_b * EK_a
    concat = concatBytes(concat, dh4)
  }
  return { sharedSecret: kdf(concat) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/x3dh/x3dh.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo/src/x3dh
git commit -m "feat(omemo): X3DH initiator/responder key agreement"
```

---

### Task 10: OMEMO 2 wire codec + bundle/device-list codecs

**Files:**
- Create: `packages/omemo/src/omemo2/wire.ts`
- Test: `packages/omemo/src/omemo2/wire.test.ts`
- Create: `packages/omemo/src/omemo2/codec.ts`
- Test: `packages/omemo/src/omemo2/codec.test.ts`

**Interfaces:**
- Consumes: `concatBytes` (bytes.ts).
- Produces (wire.ts — a minimal hand-rolled protobuf, NO external protobuf dependency):
  - `encodeOmemoMessage(m: { n: number; pn: number; dhPub: Uint8Array; ciphertext?: Uint8Array }): Uint8Array`
  - `decodeOmemoMessage(b: Uint8Array): { n: number; pn: number; dhPub: Uint8Array; ciphertext?: Uint8Array }`
  - `encodeAuthMessage(m: { mac: Uint8Array; message: Uint8Array }): Uint8Array`
  - `decodeAuthMessage(b: Uint8Array): { mac: Uint8Array; message: Uint8Array }`
  - `encodeKeyExchange(m: { pkId: number; spkId: number; ik: Uint8Array; ek: Uint8Array; message: Uint8Array }): Uint8Array`
  - `decodeKeyExchange(b: Uint8Array): { pkId: number; spkId: number; ik: Uint8Array; ek: Uint8Array; message: Uint8Array }`
- Produces (codec.ts): `type Bundle`, `type DeviceList`, `type OmemoMessage`, `type OmemoKey`, `b64encode`, `b64decode`, `assertValidBundle`.

> The three protobuf schemas are fixed by XEP-0384 §4.2:
> `OMEMOMessage { uint32 n=1; uint32 pn=2; bytes dh_pub=3; bytes ciphertext=4 (optional) }`,
> `OMEMOAuthenticatedMessage { bytes mac=1; bytes message=2 }`,
> `OMEMOKeyExchange { uint32 pk_id=1; uint32 spk_id=2; bytes ik=3; bytes ek=4; bytes message=5 }`
> (`message` field 5 carries the byte-serialized OMEMOAuthenticatedMessage). Only two wire
> types are needed: varint (0) for the uint32 ids, length-delimited (2) for the byte fields.

- [ ] **Step 1: Write the failing test** `packages/omemo/src/omemo2/wire.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import {
  encodeOmemoMessage,
  decodeOmemoMessage,
  encodeAuthMessage,
  decodeAuthMessage,
  encodeKeyExchange,
  decodeKeyExchange,
} from './wire'

describe('omemo2 wire protobuf', () => {
  it('OMEMOMessage round-trips (with and without ciphertext)', () => {
    const m = { n: 5, pn: 3, dhPub: new Uint8Array(32).fill(7), ciphertext: new Uint8Array([1, 2, 3]) }
    expect(decodeOmemoMessage(encodeOmemoMessage(m))).toEqual(m)
    const empty = { n: 0, pn: 0, dhPub: new Uint8Array(32).fill(1) }
    expect(decodeOmemoMessage(encodeOmemoMessage(empty))).toEqual(empty)
  })
  it('OMEMOAuthenticatedMessage round-trips', () => {
    const m = { mac: new Uint8Array(16).fill(9), message: new Uint8Array([4, 5, 6]) }
    expect(decodeAuthMessage(encodeAuthMessage(m))).toEqual(m)
  })
  it('OMEMOKeyExchange round-trips', () => {
    const m = {
      pkId: 42,
      spkId: 1,
      ik: new Uint8Array(32).fill(2),
      ek: new Uint8Array(32).fill(3),
      message: new Uint8Array([7, 8, 9]),
    }
    expect(decodeKeyExchange(encodeKeyExchange(m))).toEqual(m)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/omemo2/wire.test.ts`
Expected: FAIL — cannot resolve `./wire`.

- [ ] **Step 3: Create `packages/omemo/src/omemo2/wire.ts`**

```ts
import { concatBytes } from '../primitives/bytes'

// --- minimal protobuf primitives (wire types 0 = varint, 2 = length-delimited) ---
function encodeVarint(n: number): Uint8Array {
  const out: number[] = []
  let v = n >>> 0
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return Uint8Array.from(out)
}
function tag(fieldNo: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNo << 3) | wireType)
}
function varintField(fieldNo: number, value: number): Uint8Array {
  return concatBytes(tag(fieldNo, 0), encodeVarint(value))
}
function bytesField(fieldNo: number, value: Uint8Array): Uint8Array {
  return concatBytes(tag(fieldNo, 2), encodeVarint(value.length), value)
}

interface Reader {
  buf: Uint8Array
  off: number
}
function readVarint(r: Reader): number {
  let shift = 0
  let result = 0
  for (;;) {
    const byte = r.buf[r.off++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return result >>> 0
}
function readBytes(r: Reader): Uint8Array {
  const len = readVarint(r)
  const out = r.buf.slice(r.off, r.off + len)
  r.off += len
  return out
}

// --- OMEMOMessage { n=1, pn=2, dh_pub=3, ciphertext=4? } ---
export function encodeOmemoMessage(m: {
  n: number
  pn: number
  dhPub: Uint8Array
  ciphertext?: Uint8Array
}): Uint8Array {
  const parts = [varintField(1, m.n), varintField(2, m.pn), bytesField(3, m.dhPub)]
  if (m.ciphertext !== undefined) parts.push(bytesField(4, m.ciphertext))
  return concatBytes(...parts)
}
export function decodeOmemoMessage(b: Uint8Array): {
  n: number
  pn: number
  dhPub: Uint8Array
  ciphertext?: Uint8Array
} {
  const r: Reader = { buf: b, off: 0 }
  const out: { n: number; pn: number; dhPub: Uint8Array; ciphertext?: Uint8Array } = {
    n: 0,
    pn: 0,
    dhPub: new Uint8Array(0),
  }
  while (r.off < b.length) {
    const t = readVarint(r)
    const field = t >> 3
    if (field === 1) out.n = readVarint(r)
    else if (field === 2) out.pn = readVarint(r)
    else if (field === 3) out.dhPub = readBytes(r)
    else if (field === 4) out.ciphertext = readBytes(r)
    else readBytes(r)
  }
  return out
}

// --- OMEMOAuthenticatedMessage { mac=1, message=2 } ---
export function encodeAuthMessage(m: { mac: Uint8Array; message: Uint8Array }): Uint8Array {
  return concatBytes(bytesField(1, m.mac), bytesField(2, m.message))
}
export function decodeAuthMessage(b: Uint8Array): { mac: Uint8Array; message: Uint8Array } {
  const r: Reader = { buf: b, off: 0 }
  const out = { mac: new Uint8Array(0), message: new Uint8Array(0) }
  while (r.off < b.length) {
    const field = readVarint(r) >> 3
    if (field === 1) out.mac = readBytes(r)
    else if (field === 2) out.message = readBytes(r)
    else readBytes(r)
  }
  return out
}

// --- OMEMOKeyExchange { pk_id=1, spk_id=2, ik=3, ek=4, message=5 } ---
export function encodeKeyExchange(m: {
  pkId: number
  spkId: number
  ik: Uint8Array
  ek: Uint8Array
  message: Uint8Array
}): Uint8Array {
  return concatBytes(
    varintField(1, m.pkId),
    varintField(2, m.spkId),
    bytesField(3, m.ik),
    bytesField(4, m.ek),
    bytesField(5, m.message),
  )
}
export function decodeKeyExchange(b: Uint8Array): {
  pkId: number
  spkId: number
  ik: Uint8Array
  ek: Uint8Array
  message: Uint8Array
} {
  const r: Reader = { buf: b, off: 0 }
  const out = { pkId: 0, spkId: 0, ik: new Uint8Array(0), ek: new Uint8Array(0), message: new Uint8Array(0) }
  while (r.off < b.length) {
    const field = readVarint(r) >> 3
    if (field === 1) out.pkId = readVarint(r)
    else if (field === 2) out.spkId = readVarint(r)
    else if (field === 3) out.ik = readBytes(r)
    else if (field === 4) out.ek = readBytes(r)
    else if (field === 5) out.message = readBytes(r)
    else readBytes(r)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/omemo2/wire.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test** `packages/omemo/src/omemo2/codec.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { b64encode, b64decode, assertValidBundle, type Bundle } from './codec'

describe('omemo2 codec', () => {
  it('base64 round-trips', () => {
    const u = new Uint8Array([0, 1, 2, 250, 255])
    expect(b64decode(b64encode(u))).toEqual(u)
  })
  it('rejects a bundle with fewer than 25 prekeys', () => {
    const bundle: Bundle = {
      ik: new Uint8Array(32),
      spkId: 1,
      spk: new Uint8Array(32),
      spkSig: new Uint8Array(64),
      preKeys: [{ id: 1, key: new Uint8Array(32) }],
    }
    expect(() => assertValidBundle(bundle)).toThrow(/at least 25/)
  })
})
```

- [ ] **Step 6: Run — verify it fails, then create `packages/omemo/src/omemo2/codec.ts`**

Run: `npx vitest run packages/omemo/src/omemo2/codec.test.ts` → FAIL (cannot resolve `./codec`).

```ts
export interface Bundle {
  ik: Uint8Array // Ed25519 identity public key
  spkId: number
  spk: Uint8Array // X25519 signed prekey public
  spkSig: Uint8Array // Ed25519 signature over spk
  preKeys: { id: number; key: Uint8Array }[]
}
export type DeviceList = number[]
export interface OmemoKey {
  rid: number
  kex: boolean // true => data is an OMEMOKeyExchange, false => an OMEMOAuthenticatedMessage
  data: Uint8Array
}
export interface OmemoMessage {
  sid: number
  keys: OmemoKey[]
  payload?: Uint8Array // AES-256-CBC ciphertext of the SCE envelope; omitted for empty messages
}

export function b64encode(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}
export function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function assertValidBundle(b: Bundle): void {
  if (b.ik.length !== 32) throw new Error('bundle ik must be 32 bytes')
  if (b.spk.length !== 32) throw new Error('bundle spk must be 32 bytes')
  if (b.spkSig.length !== 64) throw new Error('bundle spkSig must be 64 bytes')
  if (b.preKeys.length < 25) throw new Error('bundle must contain at least 25 prekeys')
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run packages/omemo/src/omemo2/wire.test.ts packages/omemo/src/omemo2/codec.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 8: Commit**

```bash
git add packages/omemo/src/omemo2/wire.ts packages/omemo/src/omemo2/wire.test.ts packages/omemo/src/omemo2/codec.ts packages/omemo/src/omemo2/codec.test.ts
git commit -m "feat(omemo): OMEMO 2 wire protobuf + bundle/message codecs"
```

---

### Task 11: Double Ratchet (OMEMO 2 message cipher)

**Files:**
- Create: `packages/omemo/src/ratchet/ratchet.ts`
- Test: `packages/omemo/src/ratchet/ratchet.test.ts`

**Interfaces:**
- Consumes: `x25519`, `generateX25519` (curve.ts); `hkdf`, `hmacSha256` (hash.ts); `concatBytes`, `bytesEqual` (bytes.ts); `encodeOmemoMessage`, `decodeOmemoMessage` (wire.ts); `cbc` from `@noble/ciphers/aes`.
- Produces:
  - `initRatchetInitiator(sharedSecret, remoteSpkPub, rng): RatchetState`
  - `initRatchetResponder(sharedSecret, spkPriv, spkPub): RatchetState`
  - `ratchetEncrypt(state, plaintext, ad): { state, authMessage: { mac: Uint8Array; message: Uint8Array } }`
  - `ratchetDecrypt(state, authMessage, ad): { state, plaintext }`
  - `serializeRatchet(state): Uint8Array` / `deserializeRatchet(bytes): RatchetState`
  - `type RatchetState`

> Real OMEMO 2 message cipher (XEP-0384 §4.3): chain-key step `mk = HMAC(ck, 0x01)`,
> `ck' = HMAC(ck, 0x02)`; message keys `HKDF(mk, salt=32 zero bytes, "OMEMO Message Key Material", 80)`
> → `enc(32)|auth(32)|iv(16)`; `ciphertext = AES-256-CBC(enc, iv, plaintext)`; the ratchet emits an
> OMEMOAuthenticatedMessage `{ mac, message }` where `message = OMEMOMessage.proto(n, pn, dh_pub, ciphertext)`
> and `mac = HMAC(auth, ad || message)[:16]`. `ad` is the session associated data (see Task 13).

- [ ] **Step 1: Write the failing test** — alternating + out-of-order, with a fixed AD

```ts
import { describe, it, expect } from 'vitest'
import { generateX25519 } from '../primitives/curve'
import { initRatchetInitiator, initRatchetResponder, ratchetEncrypt, ratchetDecrypt } from './ratchet'

function counterRng() {
  let c = 100
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)
const AD = new Uint8Array(64).fill(0xab) // stand-in for IK_a || IK_b

describe('double ratchet (OMEMO 2 message cipher)', () => {
  it('exchanges messages both directions, including out of order', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(1)
    const bobSpk = generateX25519(rng)
    let alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    let bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)

    const a1 = ratchetEncrypt(alice, enc('hello'), AD)
    alice = a1.state
    const b1 = ratchetDecrypt(bob, a1.authMessage, AD)
    bob = b1.state
    expect(dec(b1.plaintext)).toBe('hello')

    const b2 = ratchetEncrypt(bob, enc('hi back'), AD)
    bob = b2.state
    const a2 = ratchetDecrypt(alice, b2.authMessage, AD)
    alice = a2.state
    expect(dec(a2.plaintext)).toBe('hi back')

    const m1 = ratchetEncrypt(alice, enc('one'), AD)
    alice = m1.state
    const m2 = ratchetEncrypt(alice, enc('two'), AD)
    alice = m2.state
    const r2 = ratchetDecrypt(bob, m2.authMessage, AD)
    bob = r2.state
    const r1 = ratchetDecrypt(bob, m1.authMessage, AD)
    bob = r1.state
    expect(dec(r2.plaintext)).toBe('two')
    expect(dec(r1.plaintext)).toBe('one')
  })

  it('rejects a message whose MAC does not match the AD', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(1)
    const bobSpk = generateX25519(rng)
    const alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    const bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    const a1 = ratchetEncrypt(alice, enc('secret'), AD)
    const wrongAd = new Uint8Array(64).fill(0xcd)
    expect(() => ratchetDecrypt(bob, a1.authMessage, wrongAd)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/ratchet/ratchet.test.ts`
Expected: FAIL — cannot resolve `./ratchet`.

- [ ] **Step 3: Create `packages/omemo/src/ratchet/ratchet.ts`**

```ts
import { cbc } from '@noble/ciphers/aes'
import { x25519, generateX25519 } from '../primitives/curve'
import { hkdf, hmacSha256 } from '../primitives/hash'
import { concatBytes, bytesEqual } from '../primitives/bytes'
import type { Rng } from '../primitives/bytes'
import { encodeOmemoMessage, decodeOmemoMessage } from '../omemo2/wire'

const ROOT_INFO = new TextEncoder().encode('OMEMO Root Chain')
const MSG_INFO = new TextEncoder().encode('OMEMO Message Key Material')
const ZERO32 = new Uint8Array(32)
const MAX_SKIP = 1000

interface Header {
  dhPub: Uint8Array
  pn: number
  n: number
}

export interface RatchetState {
  rng: Rng
  dhSelfPriv: Uint8Array
  dhSelfPub: Uint8Array
  dhRemote: Uint8Array | null
  rootKey: Uint8Array
  sendChain: Uint8Array | null
  recvChain: Uint8Array | null
  ns: number
  nr: number
  pn: number
  skipped: Map<string, Uint8Array> // `${dhPubHex}:${n}` -> messageKey
}

function kdfRoot(rootKey: Uint8Array, dhOut: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const okm = hkdf(dhOut, rootKey, ROOT_INFO, 64)
  return { rootKey: okm.slice(0, 32), chainKey: okm.slice(32, 64) }
}
function kdfChain(chainKey: Uint8Array): { chainKey: Uint8Array; messageKey: Uint8Array } {
  const messageKey = hmacSha256(chainKey, new Uint8Array([0x01]))
  const nextChain = hmacSha256(chainKey, new Uint8Array([0x02]))
  return { chainKey: nextChain, messageKey }
}
function deriveMsgKeys(mk: Uint8Array): { enc: Uint8Array; auth: Uint8Array; iv: Uint8Array } {
  const okm = hkdf(mk, ZERO32, MSG_INFO, 80)
  return { enc: okm.slice(0, 32), auth: okm.slice(32, 64), iv: okm.slice(64, 80) }
}
function hexKey(dhPub: Uint8Array, n: number): string {
  return [...dhPub].map((b) => b.toString(16).padStart(2, '0')).join('') + ':' + n
}

function sealMessage(mk: Uint8Array, ad: Uint8Array, header: Header, plaintext: Uint8Array): { mac: Uint8Array; message: Uint8Array } {
  const { enc, auth, iv } = deriveMsgKeys(mk)
  const ciphertext = cbc(enc, iv).encrypt(plaintext)
  const message = encodeOmemoMessage({ n: header.n, pn: header.pn, dhPub: header.dhPub, ciphertext })
  const mac = hmacSha256(auth, concatBytes(ad, message)).slice(0, 16)
  return { mac, message }
}
function openMessage(mk: Uint8Array, ad: Uint8Array, authMessage: { mac: Uint8Array; message: Uint8Array }): Uint8Array {
  const { enc, auth, iv } = deriveMsgKeys(mk)
  if (!bytesEqual(hmacSha256(auth, concatBytes(ad, authMessage.message)).slice(0, 16), authMessage.mac)) {
    throw new Error('ratchet message authentication failed')
  }
  const parsed = decodeOmemoMessage(authMessage.message)
  return cbc(enc, iv).decrypt(parsed.ciphertext!)
}

export function initRatchetInitiator(sharedSecret: Uint8Array, remoteSpkPub: Uint8Array, rng: Rng): RatchetState {
  const dh = generateX25519(rng)
  const first = kdfRoot(sharedSecret, x25519.scalarMult(dh.priv, remoteSpkPub))
  return {
    rng,
    dhSelfPriv: dh.priv,
    dhSelfPub: dh.pub,
    dhRemote: remoteSpkPub,
    rootKey: first.rootKey,
    sendChain: first.chainKey,
    recvChain: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: new Map(),
  }
}

export function initRatchetResponder(sharedSecret: Uint8Array, spkPriv: Uint8Array, spkPub: Uint8Array): RatchetState {
  return {
    rng: () => new Uint8Array(0),
    dhSelfPriv: spkPriv,
    dhSelfPub: spkPub,
    dhRemote: null,
    rootKey: sharedSecret,
    sendChain: null,
    recvChain: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: new Map(),
  }
}

export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
  ad: Uint8Array,
): { state: RatchetState; authMessage: { mac: Uint8Array; message: Uint8Array } } {
  const s = { ...state, skipped: new Map(state.skipped) }
  const step = kdfChain(s.sendChain!)
  s.sendChain = step.chainKey
  const header: Header = { dhPub: s.dhSelfPub, pn: s.pn, n: s.ns }
  s.ns += 1
  return { state: s, authMessage: sealMessage(step.messageKey, ad, header, plaintext) }
}

export function ratchetDecrypt(
  state: RatchetState,
  authMessage: { mac: Uint8Array; message: Uint8Array },
  ad: Uint8Array,
): { state: RatchetState; plaintext: Uint8Array } {
  const header = decodeOmemoMessage(authMessage.message)
  let s: RatchetState = { ...state, skipped: new Map(state.skipped) }

  const skipId = hexKey(header.dhPub, header.n)
  const skippedKey = s.skipped.get(skipId)
  if (skippedKey) {
    s.skipped.delete(skipId)
    return { state: s, plaintext: openMessage(skippedKey, ad, authMessage) }
  }

  const isNewRemote = !s.dhRemote || !bytesEqual(s.dhRemote, header.dhPub)
  if (isNewRemote) {
    s = skipMessageKeys(s, header.pn)
    s = dhRatchet(s, header.dhPub)
  }
  s = skipMessageKeys(s, header.n)

  const step = kdfChain(s.recvChain!)
  s.recvChain = step.chainKey
  s.nr += 1
  return { state: s, plaintext: openMessage(step.messageKey, ad, authMessage) }
}

function skipMessageKeys(state: RatchetState, until: number): RatchetState {
  if (state.recvChain === null) return state
  if (state.nr + MAX_SKIP < until) throw new Error('too many skipped messages')
  const s = { ...state, skipped: new Map(state.skipped) }
  while (s.nr < until) {
    const step = kdfChain(s.recvChain!)
    s.recvChain = step.chainKey
    s.skipped.set(hexKey(s.dhRemote!, s.nr), step.messageKey)
    s.nr += 1
  }
  return s
}

function dhRatchet(state: RatchetState, remoteDhPub: Uint8Array): RatchetState {
  const s = { ...state }
  s.pn = s.ns
  s.ns = 0
  s.nr = 0
  s.dhRemote = remoteDhPub
  const recv = kdfRoot(s.rootKey, x25519.scalarMult(s.dhSelfPriv, remoteDhPub))
  s.rootKey = recv.rootKey
  s.recvChain = recv.chainKey
  const dh = generateX25519(s.rng)
  s.dhSelfPriv = dh.priv
  s.dhSelfPub = dh.pub
  const send = kdfRoot(s.rootKey, x25519.scalarMult(s.dhSelfPriv, remoteDhPub))
  s.rootKey = send.rootKey
  s.sendChain = send.chainKey
  return s
}

interface SerializableState {
  dhSelfPriv: number[]; dhSelfPub: number[]; dhRemote: number[] | null
  rootKey: number[]; sendChain: number[] | null; recvChain: number[] | null
  ns: number; nr: number; pn: number; skipped: [string, number[]][]
}
export function serializeRatchet(s: RatchetState): Uint8Array {
  const obj: SerializableState = {
    dhSelfPriv: [...s.dhSelfPriv], dhSelfPub: [...s.dhSelfPub],
    dhRemote: s.dhRemote ? [...s.dhRemote] : null,
    rootKey: [...s.rootKey],
    sendChain: s.sendChain ? [...s.sendChain] : null,
    recvChain: s.recvChain ? [...s.recvChain] : null,
    ns: s.ns, nr: s.nr, pn: s.pn,
    skipped: [...s.skipped.entries()].map(([k, v]) => [k, [...v]]),
  }
  return new TextEncoder().encode(JSON.stringify(obj))
}
export function deserializeRatchet(bytes: Uint8Array): RatchetState {
  const o: SerializableState = JSON.parse(new TextDecoder().decode(bytes))
  return {
    rng: (n: number) => new Uint8Array(n), // account layer re-injects the real rng before sending
    dhSelfPriv: Uint8Array.from(o.dhSelfPriv), dhSelfPub: Uint8Array.from(o.dhSelfPub),
    dhRemote: o.dhRemote ? Uint8Array.from(o.dhRemote) : null,
    rootKey: Uint8Array.from(o.rootKey),
    sendChain: o.sendChain ? Uint8Array.from(o.sendChain) : null,
    recvChain: o.recvChain ? Uint8Array.from(o.recvChain) : null,
    ns: o.ns, nr: o.nr, pn: o.pn,
    skipped: new Map(o.skipped.map(([k, v]) => [k, Uint8Array.from(v)])),
  }
}
```

> Responder-first-send note: the responder's `rng` is a no-op stub because it must not generate its
> own ratchet DH key until it has received the initiator's first message and run `dhRatchet` (which
> installs a real send chain). In the account layer the responder is always constructed from a
> received KeyExchange, so its first outbound message happens after ≥1 inbound `dhRatchet`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/omemo/src/ratchet/ratchet.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add serialize/deserialize test**

```ts
// append to ratchet.test.ts
import { serializeRatchet, deserializeRatchet } from './ratchet'

it('serializes and restores ratchet state', () => {
  const rng = counterRng()
  const ss = new Uint8Array(32).fill(2)
  const spk = generateX25519(rng)
  const a = initRatchetInitiator(ss, spk.pub, rng)
  const restored = deserializeRatchet(serializeRatchet(a))
  restored.rng = rng
  const m = ratchetEncrypt(restored, new TextEncoder().encode('x'), AD)
  expect(m.authMessage.mac.length).toBe(16)
})
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/omemo/src/ratchet/ratchet.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/omemo/src/ratchet
git commit -m "feat(omemo): Double Ratchet with OMEMO 2 message cipher + AD MAC"
```

---

### Task 12: SCE envelope (XEP-0420)

**Files:**
- Create: `packages/omemo/src/omemo2/sce.ts`
- Test: `packages/omemo/src/omemo2/sce.test.ts`

**Interfaces:**
- Consumes: `Rng`, `concatBytes`, `u32be` (bytes.ts).
- Produces:
  - `type SceContent = { body?: string; from?: string; to?: string; timeIso?: string }`
  - `buildEnvelope(content: SceContent, rng: Rng): Uint8Array` (always includes random rpad)
  - `parseEnvelope(bytes: Uint8Array): SceContent`

> Rationale: the crypto boundary encrypts the SCE envelope *bytes*. The exact XEP-0420 XML shape is
> the adapter's responsibility; the library needs a stable, reversible byte serialization that carries
> the mandatory `rpad` (length-hiding) and optional `from`/`to`/`time`. We use a length-prefixed field
> encoding.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { buildEnvelope, parseEnvelope } from './sce'

const rng = (n: number) => new Uint8Array(n).fill(4)

describe('sce envelope', () => {
  it('round-trips content and includes rpad', () => {
    const env = buildEnvelope({ body: 'hi', from: 'a@x', to: 'b@y', timeIso: '2026-07-13T00:00:00Z' }, rng)
    const parsed = parseEnvelope(env)
    expect(parsed.body).toBe('hi')
    expect(parsed.from).toBe('a@x')
    expect(parsed.to).toBe('b@y')
    expect(parsed.timeIso).toBe('2026-07-13T00:00:00Z')
  })
  it('two envelopes of the same content still parse back to the body', () => {
    const a = buildEnvelope({ body: 'hi' }, (n) => new Uint8Array(n).fill(1))
    const b = buildEnvelope({ body: 'hi' }, (n) => new Uint8Array(Math.max(1, n)).fill(2))
    expect(parseEnvelope(a).body).toBe('hi')
    expect(parseEnvelope(b).body).toBe('hi')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/omemo2/sce.test.ts`
Expected: FAIL — cannot resolve `./sce`.

- [ ] **Step 3: Create `packages/omemo/src/omemo2/sce.ts`**

```ts
import { concatBytes, u32be } from '../primitives/bytes'
import type { Rng } from '../primitives/bytes'

export interface SceContent {
  body?: string
  from?: string
  to?: string
  timeIso?: string
}

const FIELDS = ['body', 'from', 'to', 'timeIso', 'rpad'] as const
type Field = (typeof FIELDS)[number]

function field(tag: Field, value: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(tag)
  return concatBytes(u32be(t.length), t, u32be(value.length), value)
}

/** Builds the SCE envelope bytes with a mandatory random rpad (1..32 bytes). */
export function buildEnvelope(content: SceContent, rng: Rng): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  if (content.body !== undefined) parts.push(field('body', enc.encode(content.body)))
  if (content.from !== undefined) parts.push(field('from', enc.encode(content.from)))
  if (content.to !== undefined) parts.push(field('to', enc.encode(content.to)))
  if (content.timeIso !== undefined) parts.push(field('timeIso', enc.encode(content.timeIso)))
  const rpadLen = (rng(1)[0] % 32) + 1
  parts.push(field('rpad', rng(rpadLen)))
  return concatBytes(...parts)
}

export function parseEnvelope(bytes: Uint8Array): SceContent {
  const dec = new TextDecoder()
  const out: SceContent = {}
  let off = 0
  const readU32 = () => {
    const v = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]
    off += 4
    return v >>> 0
  }
  while (off < bytes.length) {
    const tagLen = readU32()
    const tag = dec.decode(bytes.slice(off, off + tagLen))
    off += tagLen
    const valLen = readU32()
    const val = bytes.slice(off, off + valLen)
    off += valLen
    if (tag === 'body') out.body = dec.decode(val)
    else if (tag === 'from') out.from = dec.decode(val)
    else if (tag === 'to') out.to = dec.decode(val)
    else if (tag === 'timeIso') out.timeIso = dec.decode(val)
    // rpad is intentionally discarded
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/omemo2/sce.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omemo/src/omemo2/sce.ts packages/omemo/src/omemo2/sce.test.ts
git commit -m "feat(omemo): SCE envelope build/parse with mandatory rpad"
```

---

### Task 13: `OmemoAccount` orchestration

**Files:**
- Create: `packages/omemo/src/account/OmemoAccount.ts`
- Test: `packages/omemo/src/account/OmemoAccount.test.ts`
- Modify: `packages/omemo/src/index.ts` (export public API)

**Interfaces:**
- Consumes: everything above.
- Produces the public API from the spec:
  - `class OmemoAccount` with `create`, `load`, `deviceId`, `identityFingerprint`, `publishableBundleAsync`, `publishableDeviceId`, `processBundle`, `encrypt`, `decrypt`.
  - re-exports `type Bundle`, `type OmemoMessage`.

> **Session associated data (AD).** OMEMO 2 authenticates every ratchet message under
> `AD = Ed25519(IK_initiator) || Ed25519(IK_responder)`, fixed for the life of the session regardless
> of direction. The account persists both IKs in the session meta at session creation:
> - as **initiator** (`processBundle`): `initiatorIk = ourEdPub`, `responderIk = bundle.ik`.
> - as **responder** (first `decrypt` of a KeyExchange): `initiatorIk = keyExchange.ik`, `responderIk = ourEdPub`.
>
> **Wire mapping.** `encrypt` builds the SCE envelope, picks a random 32-byte payload key `k`,
> `payloadEncrypt(k, envelope)` → `{ ciphertext, tag }`. `<payload>` carries `ciphertext`; the ratchet
> transports the **48-byte `k || tag`** per device. A fresh (kex-pending) session wraps the ratchet's
> OMEMOAuthenticatedMessage in an OMEMOKeyExchange (`pk_id`, `spk_id`, `ik = ourEdPub`, `ek = ephemeral`);
> an established session sends the OMEMOAuthenticatedMessage bytes directly. `decrypt` reverses it,
> recovering `k || tag`, verifying `tag` against the payload, and returning the body. `archive: true`
> decrypts without persisting the advanced session and without consuming a one-time prekey.

- [ ] **Step 1: Write the failing test** — initial PreKey message + a follow-up established message

```ts
import { describe, it, expect } from 'vitest'
import { MemoryStore } from '../store/MemoryStore'
import { OmemoAccount } from './OmemoAccount'

function counterRng(start: number) {
  let c = start
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)

describe('OmemoAccount', () => {
  it('round-trips an initial PreKey message then an established message', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))

    const bobBundle = await bob.publishableBundleAsync()
    await alice.processBundle('bob@x', bob.publishableDeviceId(), bobBundle)

    // 1) Initial message is a KeyExchange
    const m1 = await alice.encrypt('bob@x', [bob.publishableDeviceId()], enc('secret hi'))
    expect(m1.keys[0].kex).toBe(true)
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1))).toBe('secret hi')

    // 2) Bob replies (establishes his send chain); Alice decrypts
    const m2 = await bob.encrypt('alice@x', [alice.publishableDeviceId()], enc('got it'))
    expect(m2.keys[0].kex).toBe(false)
    expect(dec(await alice.decrypt('bob@x', m2.sid, m2))).toBe('got it')
  })

  it('fingerprint is 32 curve bytes and identity persists via load', async () => {
    const store = new MemoryStore()
    const a = await OmemoAccount.create(store, counterRng(9))
    const fp = a.identityFingerprint()
    expect(fp.length).toBe(32)
    const reloaded = await OmemoAccount.load(store, counterRng(9))
    expect(reloaded.identityFingerprint()).toEqual(fp)
    expect(reloaded.deviceId()).toBe(a.deviceId())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/omemo/src/account/OmemoAccount.test.ts`
Expected: FAIL — cannot resolve `./OmemoAccount`.

- [ ] **Step 3: Create `packages/omemo/src/account/OmemoAccount.ts`**

```ts
import type { Rng } from '../primitives/bytes'
import type { OmemoStore } from '../store/types'
import { createIdentity, fingerprint, randomDeviceId } from '../identity/identity'
import { generateSignedPreKey, generatePreKeys } from '../prekeys/prekeys'
import { x3dhInitiator, x3dhResponder } from '../x3dh/x3dh'
import {
  initRatchetInitiator,
  initRatchetResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchet,
  deserializeRatchet,
  type RatchetState,
} from '../ratchet/ratchet'
import { payloadEncrypt, payloadDecrypt } from '../primitives/aead'
import { buildEnvelope, parseEnvelope } from '../omemo2/sce'
import { concatBytes } from '../primitives/bytes'
import {
  encodeAuthMessage,
  decodeAuthMessage,
  encodeKeyExchange,
  decodeKeyExchange,
} from '../omemo2/wire'
import { assertValidBundle, type Bundle, type OmemoMessage, type OmemoKey } from '../omemo2/codec'

const SPK_ID = 1
const PREKEY_START = 1
const PREKEY_COUNT = 100

interface SessionMeta {
  ad: number[] // Ed25519(IK_initiator) || Ed25519(IK_responder)
  kexPending: boolean
  pkId?: number
  spkId?: number
  ek?: number[] // ephemeral pub, initiator side, while kexPending
}
/** Session record = [u32 metaLen][meta JSON][ratchet blob]. */
function packSession(meta: SessionMeta, ratchet: Uint8Array): Uint8Array {
  const m = new TextEncoder().encode(JSON.stringify(meta))
  const len = new Uint8Array([(m.length >>> 24) & 0xff, (m.length >>> 16) & 0xff, (m.length >>> 8) & 0xff, m.length & 0xff])
  return concatBytes(len, m, ratchet)
}
function unpackSession(blob: Uint8Array): { meta: SessionMeta; ratchet: Uint8Array } {
  const len = ((blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]) >>> 0
  const meta: SessionMeta = JSON.parse(new TextDecoder().decode(blob.slice(4, 4 + len)))
  return { meta, ratchet: blob.slice(4 + len) }
}

export class OmemoAccount {
  private constructor(
    private store: OmemoStore,
    private rng: Rng,
    private id: { edSeed: Uint8Array; edPub: Uint8Array; deviceId: number },
  ) {}

  static async create(store: OmemoStore, rng: Rng): Promise<OmemoAccount> {
    const existing = await store.loadIdentity()
    if (existing) return new OmemoAccount(store, rng, existing)
    const deviceId = randomDeviceId(rng)
    const identity = createIdentity(rng, deviceId)
    await store.saveIdentity(identity)
    const spk = generateSignedPreKey(rng, 0, identity.edSeed, SPK_ID)
    await store.saveSignedPreKey(SPK_ID, spk)
    for (const pk of generatePreKeys(rng, PREKEY_START, PREKEY_COUNT)) await store.savePreKey(pk.id, pk)
    return new OmemoAccount(store, rng, identity)
  }

  static async load(store: OmemoStore, rng: Rng): Promise<OmemoAccount> {
    const identity = await store.loadIdentity()
    if (!identity) throw new Error('no identity in store; call create() first')
    return new OmemoAccount(store, rng, identity)
  }

  deviceId(): number {
    return this.id.deviceId
  }
  publishableDeviceId(): number {
    return this.id.deviceId
  }
  identityFingerprint(): Uint8Array {
    return fingerprint(this.id.edPub)
  }

  async publishableBundleAsync(): Promise<Bundle> {
    const spk = await this.store.loadSignedPreKey(SPK_ID)
    if (!spk) throw new Error('signed prekey missing')
    const preKeys: Bundle['preKeys'] = []
    for (let i = PREKEY_START; i < PREKEY_START + PREKEY_COUNT; i++) {
      const pk = await this.store.loadPreKey(i)
      if (pk) preKeys.push({ id: pk.id, key: pk.pub })
    }
    const bundle: Bundle = { ik: this.id.edPub, spkId: spk.id, spk: spk.pub, spkSig: spk.signature, preKeys }
    assertValidBundle(bundle)
    return bundle
  }

  async processBundle(peer: string, rid: number, bundle: Bundle): Promise<void> {
    assertValidBundle(bundle)
    const otk = bundle.preKeys[0]
    const init = x3dhInitiator({
      identitySeed: this.id.edSeed,
      rng: this.rng,
      remoteIdentityEd: bundle.ik,
      remoteSignedPreKey: bundle.spk,
      remoteOneTimePreKey: otk.key,
    })
    const ratchet = initRatchetInitiator(init.sharedSecret, bundle.spk, this.rng)
    const meta: SessionMeta = {
      ad: [...this.id.edPub, ...bundle.ik], // initiator=us, responder=them
      kexPending: true,
      pkId: otk.id,
      spkId: bundle.spkId,
      ek: [...init.ephemeralPub],
    }
    await this.store.saveSession(peer, rid, packSession(meta, serializeRatchet(ratchet)))
    await this.store.saveTrust(peer, rid, { state: 'undecided', identityKey: bundle.ik })
  }

  async encrypt(peer: string, deviceIds: number[], plaintext: Uint8Array): Promise<OmemoMessage> {
    const envelope = buildEnvelope({ body: new TextDecoder().decode(plaintext) }, this.rng)
    const k = this.rng(32)
    const { ciphertext, tag } = payloadEncrypt(k, envelope)
    const keyAndHmac = concatBytes(k, tag) // 48 bytes

    const keys: OmemoKey[] = []
    for (const rid of deviceIds) {
      const stored = await this.store.loadSession(peer, rid)
      if (!stored) throw new Error(`no session for ${peer}/${rid}; call processBundle first`)
      const { meta, ratchet } = unpackSession(stored)
      const state = deserializeRatchet(ratchet)
      state.rng = this.rng
      const ad = Uint8Array.from(meta.ad)
      const step = ratchetEncrypt(state, keyAndHmac, ad)
      const authBytes = encodeAuthMessage(step.authMessage)

      let data: Uint8Array
      if (meta.kexPending) {
        data = encodeKeyExchange({
          pkId: meta.pkId!,
          spkId: meta.spkId!,
          ik: this.id.edPub,
          ek: Uint8Array.from(meta.ek!),
          message: authBytes,
        })
      } else {
        data = authBytes
      }
      keys.push({ rid, kex: meta.kexPending, data })
      await this.store.saveSession(peer, rid, packSession(meta, serializeRatchet(step.state)))
    }
    return { sid: this.id.deviceId, keys, payload: ciphertext }
  }

  async decrypt(peer: string, sid: number, msg: OmemoMessage, opts?: { archive?: boolean }): Promise<Uint8Array> {
    const mine = msg.keys.find((k) => k.rid === this.id.deviceId)
    if (!mine) throw new Error('message has no key for this device')

    let state: RatchetState
    let ad: Uint8Array
    let meta: SessionMeta
    let authMessage: { mac: Uint8Array; message: Uint8Array }

    if (mine.kex) {
      const kex = decodeKeyExchange(mine.data)
      authMessage = decodeAuthMessage(kex.message)
      const spk = await this.store.loadSignedPreKey(kex.spkId)
      if (!spk) throw new Error('signed prekey missing for kex')
      const otk = await this.store.loadPreKey(kex.pkId)
      const resp = x3dhResponder({
        identitySeed: this.id.edSeed,
        signedPreKeyPriv: spk.priv,
        oneTimePreKeyPriv: otk?.priv,
        remoteIdentityEd: kex.ik,
        remoteEphemeral: kex.ek,
      })
      state = initRatchetResponder(resp.sharedSecret, spk.priv, spk.pub)
      ad = concatBytes(kex.ik, this.id.edPub) // initiator=them, responder=us
      meta = { ad: [...ad], kexPending: false }
      if (otk && !opts?.archive) await this.store.removePreKey(kex.pkId) // consume OTK once
      await this.store.saveTrust(peer, sid, { state: 'undecided', identityKey: kex.ik })
    } else {
      const stored = await this.store.loadSession(peer, sid)
      if (!stored) throw new Error(`no session for ${peer}/${sid}`)
      const unpacked = unpackSession(stored)
      meta = unpacked.meta
      state = deserializeRatchet(unpacked.ratchet)
      ad = Uint8Array.from(meta.ad)
      authMessage = decodeAuthMessage(mine.data)
    }

    const result = ratchetDecrypt(state, authMessage, ad)
    const keyAndHmac = result.plaintext
    const k = keyAndHmac.slice(0, 32)
    const tag = keyAndHmac.slice(32, 48)

    // Receiving any message clears our kex-pending flag (peer has our session now).
    meta.kexPending = false
    if (!opts?.archive) await this.store.saveSession(peer, sid, packSession(meta, serializeRatchet(result.state)))

    if (!msg.payload) return new Uint8Array(0) // empty/key-transport message
    const envelopeBytes = payloadDecrypt(k, msg.payload, tag)
    return new TextEncoder().encode(parseEnvelope(envelopeBytes).body ?? '')
  }
}

export type { Bundle, OmemoMessage } from '../omemo2/codec'
```

> **Spec deviation to note in the PR:** the spec listed a synchronous `publishableBundle()`; the store
> is async, so the real method is `publishableBundleAsync()`. This is the only public-surface deviation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/omemo/src/account/OmemoAccount.test.ts`
Expected: PASS (2 tests). If the established-message (m2) path fails, verify the responder's first
`encrypt` runs after its `decrypt` installed a send chain via `dhRatchet`, and that both sides compute
the identical `ad` byte order (initiator IK first).

- [ ] **Step 5: Update `packages/omemo/src/index.ts`**

```ts
export type { Rng } from './primitives/bytes'
export { concatBytes, bytesEqual, u32be } from './primitives/bytes'
export { OmemoAccount } from './account/OmemoAccount'
export type { Bundle, OmemoMessage, OmemoKey, DeviceList } from './omemo2/codec'
export { b64encode, b64decode, assertValidBundle } from './omemo2/codec'
export type {
  OmemoStore,
  IdentityRecord,
  SignedPreKeyRecord,
  PreKeyRecord,
  SessionRecord,
  TrustRecord,
} from './store/types'
export { MemoryStore } from './store/MemoryStore'
export { fingerprint } from './identity/identity'
```

- [ ] **Step 6: Full package gate**

Run: `npm run test:run -w @fluux/omemo` → Expected: PASS (all tasks).
Run: `npm run typecheck -w @fluux/omemo` → Expected: no errors.
Run: `npm run lint -w @fluux/omemo` → Expected: no errors.
Run: `npm run build -w @fluux/omemo` → Expected: dist emitted with `index.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/omemo/src/account packages/omemo/src/index.ts
git commit -m "feat(omemo): OmemoAccount orchestration + public API"
```

---

### Task 14: Interop harness vs `python-omemo` / `slixmpp-omemo` (tagged)

**Files:**
- Create: `packages/omemo/src/interop/interop.test.ts`
- Create: `packages/omemo/src/interop/docker-compose.yml`
- Create: `packages/omemo/src/interop/peer/omemo_peer.py`
- Create: `packages/omemo/src/interop/README.md`

**Interfaces:**
- Consumes: `OmemoAccount`, `b64encode`, `b64decode`.
- Produces: a CI-taggable test proving byte-level OMEMO 2 interop with a reference implementation. Because
  Tasks 10–13 already emit the real wire format, this task is a **validation** of the constants (KDF labels,
  AD ordering, protobuf field numbers), not a rework.

> Runs only when `VITEST_INTEROP=1` (vitest config excludes `interop/**` otherwise). The reference peer is a
> small Python script using `python-omemo` (the Syndace reference stack, MIT). Bundle + message blobs are
> exchanged as JSON files carrying base64 of the real protobuf `key` bytes and the `payload` ciphertext — no
> live XMPP server is needed for the crypto round-trip.

- [ ] **Step 1: Write `packages/omemo/src/interop/peer/omemo_peer.py`**

A script that: (a) `gen-bundle` — generates an OMEMO 2 identity + bundle via `python-omemo`, writes it as JSON (base64 fields incl. `deviceId`, `ik`, `spkId`, `spk`, `spkSig`, `preKeys[]`) to `/shared/bundle.json`; (b) `decrypt <msg.json>` — reads an `OmemoMessage` JSON (our format: `sid`, `payload` b64, `keys[]` with `rid`,`kex`,`data` b64), decrypts, writes plaintext to `/shared/plaintext.txt`; (c) `encrypt <ourbundle.json> <text>` — encrypts to our bundle, writes an `OmemoMessage` JSON to `/shared/msg_from_peer.json`. Skeleton:

```python
# packages/omemo/src/interop/peer/omemo_peer.py
# Reference OMEMO 2 peer using python-omemo (MIT). Crypto round-trip over files.
# Usage: python omemo_peer.py (gen-bundle | decrypt <msg.json> | encrypt <ourbundle.json> <text>)
import sys, json, base64, asyncio
# Implementer completes the concrete python-omemo 1.x calls (SessionManager / Bundle /
# encrypt_message / decrypt_message) per the API pinned in README.md. The JSON field
# layout above is the fixed contract with interop.test.ts.
```

> This is the one task where reading the *reference implementation's public API docs* (python-omemo, MIT)
> is expected and correct — it is not libsignal and not GPL/AGPL.

- [ ] **Step 2: Write `packages/omemo/src/interop/docker-compose.yml`**

```yaml
services:
  omemo-peer:
    image: python:3.12-slim
    working_dir: /peer
    volumes:
      - ./peer:/peer
      - ./shared:/shared
    command: sh -c "pip install --quiet 'python-omemo==1.*' && sleep infinity"
```

- [ ] **Step 3: Write the interop test** `packages/omemo/src/interop/interop.test.ts`

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { OmemoAccount, MemoryStore, b64decode, b64encode } from '../index'

const HERE = new URL('.', import.meta.url).pathname
const SHARED = HERE + 'shared/'
const run = (...args: string[]) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'omemo-peer', 'python', '/peer/omemo_peer.py', ...args], { cwd: HERE })

describe.runIf(process.env.VITEST_INTEROP)('OMEMO 2 interop with python-omemo', () => {
  beforeAll(() => mkdirSync(SHARED, { recursive: true }))

  it('our ciphertext decrypts on the reference peer', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), (n) => crypto.getRandomValues(new Uint8Array(n)))
    run('gen-bundle')
    const pb = JSON.parse(readFileSync(SHARED + 'bundle.json', 'utf8'))
    await alice.processBundle('peer@local', pb.deviceId, {
      ik: b64decode(pb.ik),
      spkId: pb.spkId,
      spk: b64decode(pb.spk),
      spkSig: b64decode(pb.spkSig),
      preKeys: pb.preKeys.map((p: { id: number; key: string }) => ({ id: p.id, key: b64decode(p.key) })),
    })
    const msg = await alice.encrypt('peer@local', [pb.deviceId], new TextEncoder().encode('interop hello'))
    writeFileSync(
      SHARED + 'msg.json',
      JSON.stringify({
        sid: msg.sid,
        payload: msg.payload ? b64encode(msg.payload) : null,
        keys: msg.keys.map((k) => ({ rid: k.rid, kex: k.kex, data: b64encode(k.data) })),
      }),
    )
    run('decrypt', '/shared/msg.json')
    expect(readFileSync(SHARED + 'plaintext.txt', 'utf8').trim()).toBe('interop hello')
  })
})
```

- [ ] **Step 4: Write `packages/omemo/src/interop/README.md`** documenting: `docker compose up -d`, then
  `VITEST_INTEROP=1 npx vitest run packages/omemo/src/interop/interop.test.ts`, the `python-omemo==1.*` pin,
  and that a failure here localizes to a constant/layout mismatch (KDF label, AD ordering, protobuf field
  number, HKDF salt) — the Global Constraints values are the first suspects.

- [ ] **Step 5: Run the interop test locally (manual gate — not in the default unit run)**

```bash
cd packages/omemo/src/interop && docker compose up -d
VITEST_INTEROP=1 npx vitest run packages/omemo/src/interop/interop.test.ts
```
Expected: PASS. A failure means a wire constant diverges from the reference; fix it in the owning task and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/omemo/src/interop
git commit -m "test(omemo): tagged interop harness vs python-omemo reference"
```

---

## Self-Review

**Spec coverage:**
- Package/boundaries/deps → Task 1 (enforced by `package.json` deps + eslint). ✓
- Layered modules → Tasks 2–13 (wire+codec now Task 10, ratchet Task 11). ✓
- Public API (`OmemoAccount`, `Bundle`, `OmemoMessage`, `Rng`) → Task 13. Deviation: `publishableBundleAsync()` (store is async) — flagged in Task 13. ✓
- `OmemoStore` injected persistence → Task 6; session meta packed into `SessionRecord` bytes (Task 13). ✓
- Real OMEMO 2 wire format (protobuf key structures + AES-256-CBC ratchet + AD-MAC) → Tasks 10, 11, 13; validated by Task 14. ✓
- Interop-critical constants → Task 2 (HKDF), Task 5 (payload), Task 11 (ratchet labels/consts + `mk=HMAC(ck,0x01)`), Task 13 (`AD = IK_init||IK_resp`, 48-byte `k||hmac`, payload = ciphertext only). ✓
- Cleanroom discipline → Global Constraints + Task 14 note (reference *API docs* only). ✓
- Determinism (injected RNG) → every generator takes `rng`; tests use counter RNG. ✓
- Out-of-scope (legacy envelope, adapter, MUC/MAM) → absent. ✓

**Placeholder scan:** The only intentionally-incomplete item is the Python reference peer's `python-omemo`
calls (Task 14 Step 1), explicitly the one place the implementer wires against external API docs; its JSON
contract with the TS test is fully specified. No other TODO/TBD.

**Type consistency:** `RatchetState` and the `{ mac, message }` OMEMOAuthenticatedMessage shape are consistent
across Tasks 11 and 13; `Bundle`/`OmemoMessage`/`OmemoKey` consistent across Tasks 10 and 13; wire
encode/decode signatures consistent across Tasks 10, 11, 13; `OmemoStore` records consistent across Tasks 6, 7,
8, 13; `Rng` signature `(n:number)=>Uint8Array` throughout.

**Known implementation risks (call out during execution):**
1. `@noble/curves` export names for `edwardsToMontgomeryPub/Priv` — verify against the installed version (Task 3 note).
2. `@noble/ciphers` `cbc(key, iv)` applies PKCS#7 by default — confirm padding matches the reference at Task 14.
3. AD byte order (`IK_initiator || IK_responder`, both Ed25519 RFC 8032 form) must be identical on both peers;
   an AD mismatch surfaces as a MAC failure in Task 11's negative test and again at Task 14.
4. The initiator keeps `kexPending` until it *receives* a message back (Task 13 clears it on `decrypt`); the
   test exercises exactly that hand-off (m1 kex → m2 established).
