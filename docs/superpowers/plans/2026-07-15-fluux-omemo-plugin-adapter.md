# `@fluux/omemo-plugin` (M2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **⚠ Security-critical E2EE code. Proceed carefully on every task.** The happy-path test in each step is a floor: add edge-case and adversarial tests (malformed/tampered XML and ciphertext must be rejected, never silently accepted or crashed), and after each task dispatch a **separate reviewer agent whose only job is to hunt for defects** (auth-before-decrypt, plaintext leakage, XML-injection/escaping, key/nonce reuse, wire/namespace drift, missing verification). Critical/Important findings block progress.

**Goal:** A standalone `@fluux/omemo-plugin` package exporting `OmemoPlugin` (implements the SDK's `E2EEPlugin` trait) on top of `@fluux/omemo`, producing real XEP-0420 SCE + XEP-0384 OMEMO-2 wire XML, gated on body-level interop with the `twomemo` reference.

**Architecture:** The headless plugin adapts `@fluux/omemo`'s content-agnostic `OmemoAccount` to the SDK `E2EEPlugin` trait. It owns XEP-0420 SCE (`<envelope xmlns='urn:xmpp:sce:1'>`) and OMEMO-2 (`<encrypted xmlns='urn:xmpp:omemo:2'>`) XML, OMEMO-2 PEP device-list/bundle management over the host's `XMPPPrimitives`, an `OmemoStore` over the host's `PluginStorage`, and BTBV trust. XML is built/parsed with `@xmpp/xml` (ltx) and crosses the trait boundary as `XMLElementData`.

**Tech Stack:** TypeScript (ESM), `@fluux/omemo`, `@fluux/sdk` (trait types + payload-envelope helpers), `@xmpp/xml` (ltx), `tsup`, `vitest`, `tsc`, `eslint`.

**Spec:** `docs/superpowers/specs/2026-07-15-fluux-omemo-plugin-adapter-design.md`

## Global Constraints

- **Package:** `@fluux/omemo-plugin` at `packages/omemo-plugin/`, MIT, `"type": "module"`. Mirror `@fluux/omemo`'s package.json conventions (tsup build, vitest, tsc, eslint).
- **Runtime deps:** `@fluux/omemo`, `@fluux/sdk` (workspace `*`), plus **`@xmpp/client` + `ltx` at the SDK's exact versions** (`@xmpp/client ^0.14.0`, `ltx ^3.1.2`). No app import, no `@tauri-apps/*`.
- **XML: use the ONE @xmpp lineage the project shares.** Import `{ xml }` and `type { Element }` from **`@xmpp/client`** (the same package `@fluux/sdk` uses — see `fluux-sdk/src/core/e2ee/stanzaAdapter.ts`) and `parse` from **`ltx`**. Do NOT add an independent `@xmpp/xml` dependency (it would be a second @xmpp version that can drift). `@xmpp/client`/`ltx` ship no types, so the package carries a local ambient shim at `src/xmpp.d.ts` (mirroring the SDK's `src/xmpp.d.ts` + `src/types/ltx.d.ts`); it already declares `Element` (with `append`), `xml`, and `ltx.parse`. Tasks 4/5/9/11 build/parse XML with `xml(...)` / `el.getChild(...)` / `parseXml(...)` from `./stanzaData` — NOT `@xmpp/xml`.
- **The core `@fluux/omemo` stays XML-free / `@noble`-only.** Only this plugin package takes the XML dependency.
- **Namespaces (exact):** OMEMO 2 = `urn:xmpp:omemo:2`; device list node `urn:xmpp:omemo:2:devices`; bundle node prefix `urn:xmpp:omemo:2:bundles`; SCE = `urn:xmpp:sce:1`.
- **`<encrypted>` shape (XEP-0384):** `<encrypted xmlns='urn:xmpp:omemo:2'><header sid='N'><keys jid='…'><key rid='N' [kex='true']>b64</key>…</keys>…</header><payload>b64</payload></encrypted>`. One `<keys>` group per recipient JID; `kex` attr present-and-`true` for a KeyExchange, omitted otherwise; `<payload>` omitted for empty/key-transport messages.
- **SCE shape (XEP-0420):** `<envelope xmlns='urn:xmpp:sce:1'><content>[protected stanza children]</content><rpad>…</rpad>[<from jid='…'/>][<time stamp='…'/>]</envelope>`. `<rpad>` is MANDATORY (random 0–200 bytes, base64 or raw-random text — use random bytes rendered as base64). `<content>` carries the actual `<body>`/extensions DIRECTLY (NOT wrapped in `<payload>`), so a strict XEP-0420 peer (Conversations) re-injects real `<body>`.
- **Auth-before-decrypt / no silent plaintext:** never surface unauthenticated content as trusted; malformed XML/ciphertext throws; the host handles could-not-decrypt.
- **Determinism:** inject randomness via `@fluux/omemo`'s `Rng` and an injected `rpad` RNG; no wall-clock in library-style code (timestamps come from the caller/host). Tests deterministic.
- **Commands (repo root):** Test a package: `npm run test:run -w <pkg>`. Typecheck: `npm run typecheck -w <pkg>`. Lint: `npm run lint -w <pkg>`. Build: `npm run build -w <pkg>`. Single test file: `npx vitest run <path>`.
- **Commit signing is broken in this environment** — commit with `git commit --no-gpg-sign -m "…"`. Do NOT retry signing.
- **Tests colocate** as `*.test.ts`.

---

## File Structure

```
packages/omemo/                              # MODIFIED (library refactor, Task 1)
  src/account/OmemoAccount.ts                #   content-agnostic + multi-recipient encrypt
  src/omemo2/codec.ts                        #   OmemoKey gains `jid`
  src/omemo2/sce.ts, sce.test.ts             #   DELETED
  src/interop/venv/emit_to_bob.mjs           #   updated to content-bytes shape

packages/omemo-plugin/                       # NEW package
  package.json  tsconfig.json  tsconfig.build.json  tsup.config.ts  vitest.config.ts  eslint.config.js
  src/
    index.ts                # exports OmemoPlugin + namespaces
    namespaces.ts           # NS constants + node-name helpers
    stanzaData.ts           # ltx Element ⇄ XMLElementData (+ serialize/parse string)
    sce.ts                  # XEP-0420 <envelope> build/parse
    encryptedElement.ts     # <encrypted> ⇄ OmemoMessage
    pep.ts                  # bundle/device-list publish/fetch/subscribe; Bundle⇄XML, DeviceList⇄XML
    store.ts                # PluginStorageOmemoStore
    trust.ts                # BTBV
    OmemoPlugin.ts          # implements E2EEPlugin
    testing/MockPluginContext.ts   # in-memory PEP + PluginStorage test host
    interop/plugin_interop.test.ts # body-level interop gate (Task 12)
```

---

### Task 1: Refactor `@fluux/omemo` — content-agnostic + multi-recipient encrypt

**Files:**
- Modify: `packages/omemo/src/omemo2/codec.ts` (add `jid` to `OmemoKey`)
- Modify: `packages/omemo/src/account/OmemoAccount.ts:125-208` (encrypt/decrypt)
- Delete: `packages/omemo/src/omemo2/sce.ts`, `packages/omemo/src/omemo2/sce.test.ts`
- Modify: `packages/omemo/src/account/OmemoAccount.test.ts` (assert content bytes; multi-recipient)
- Modify: `packages/omemo/src/interop/venv/emit_to_bob.mjs` (content bytes)

**Interfaces:**
- Produces:
  - `type OmemoKey = { jid: string; rid: number; kex: boolean; data: Uint8Array }`
  - `OmemoAccount.encrypt(recipients: Array<{ jid: string; deviceIds: number[] }>, content: Uint8Array): Promise<OmemoMessage>`
  - `OmemoAccount.decrypt(senderJid: string, sid: number, msg: OmemoMessage, opts?: { archive?: boolean }): Promise<Uint8Array>` (returns raw content bytes)

- [ ] **Step 1: Update the failing test** — encrypt is now content-agnostic + multi-recipient

Edit `packages/omemo/src/account/OmemoAccount.test.ts`. Replace the existing round-trip test body with a content-bytes, two-recipient shape (Alice sends to Bob + Alice's own 2nd device):

```ts
it('encrypts opaque content to multiple recipients and each decrypts it', async () => {
  const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
  const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
  const alice2 = await OmemoAccount.create(new MemoryStore(), counterRng(90))

  await alice.processBundle('bob@x', bob.publishableDeviceId(), await bob.publishableBundleAsync())
  await alice.processBundle('alice@x', alice2.publishableDeviceId(), await alice2.publishableBundleAsync())

  const content = new TextEncoder().encode('<envelope>opaque sce bytes</envelope>')
  const msg = await alice.encrypt(
    [
      { jid: 'bob@x', deviceIds: [bob.publishableDeviceId()] },
      { jid: 'alice@x', deviceIds: [alice2.publishableDeviceId()] },
    ],
    content,
  )
  // keys carry their recipient jid
  expect(new Set(msg.keys.map((k) => k.jid))).toEqual(new Set(['bob@x', 'alice@x']))
  // both recipients recover the exact content bytes (no envelope wrapping by the library)
  expect(await bob.decrypt('alice@x', msg.sid, msg)).toEqual(content)
  expect(await alice2.decrypt('alice@x', msg.sid, msg)).toEqual(content)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/omemo/src/account/OmemoAccount.test.ts`
Expected: FAIL (encrypt signature/`jid` mismatch).

- [ ] **Step 3: Add `jid` to `OmemoKey`**

In `packages/omemo/src/omemo2/codec.ts`:

```ts
export interface OmemoKey {
  jid: string // recipient bare JID this key is addressed to (for the <keys jid> grouping)
  rid: number
  kex: boolean
  data: Uint8Array
}
```

- [ ] **Step 4: Rewrite `OmemoAccount.encrypt` (content-agnostic, multi-recipient)**

Replace `encrypt` (`OmemoAccount.ts:125`). Generate ONE payload key, `payloadEncrypt(content)` once, wrap the 48-byte `k||tag` per device across all recipient JIDs; tag each key with its jid:

```ts
async encrypt(
  recipients: Array<{ jid: string; deviceIds: number[] }>,
  content: Uint8Array,
): Promise<OmemoMessage> {
  const k = this.rng(32)
  const { ciphertext, tag } = payloadEncrypt(k, content)
  const keyAndHmac = concatBytes(k, tag) // 48 bytes

  const keys: OmemoKey[] = []
  for (const { jid, deviceIds } of recipients) {
    for (const rid of deviceIds) {
      const stored = await this.store.loadSession(jid, rid)
      if (!stored) throw new Error(`no session for ${jid}/${rid}; call processBundle first`)
      const { meta, ratchet } = unpackSession(stored)
      const state = deserializeRatchet(ratchet)
      state.rng = this.rng
      const ad = Uint8Array.from(meta.ad)
      const step = ratchetEncrypt(state, keyAndHmac, ad)
      const authBytes = encodeAuthMessage(step.authMessage)
      const data = meta.kexPending
        ? encodeKeyExchange({ pkId: meta.pkId!, spkId: meta.spkId!, ik: this.id.edPub, ek: Uint8Array.from(meta.ek!), message: authBytes })
        : authBytes
      keys.push({ jid, rid, kex: meta.kexPending, data })
      await this.store.saveSession(jid, rid, packSession(meta, serializeRatchet(step.state)))
    }
  }
  return { sid: this.id.deviceId, keys, payload: ciphertext }
}
```

- [ ] **Step 5: Make `decrypt` content-agnostic + return raw bytes**

In `decrypt` (`OmemoAccount.ts:160`), rename the first param to `senderJid` (semantics unchanged — it is the session partner JID), keep matching our key by `rid`, and at the end return the recovered content bytes directly instead of parsing an envelope. Replace the tail:

```ts
  // (unchanged: kex vs established branch recovers keyAndHmac via ratchetDecrypt)
  const k = keyAndHmac.slice(0, 32)
  const tag = keyAndHmac.slice(32, 48)
  meta.kexPending = false
  if (!opts?.archive) await this.store.saveSession(senderJid, sid, packSession(meta, serializeRatchet(result.state)))
  if (!msg.payload) return new Uint8Array(0) // empty/key-transport message
  return payloadDecrypt(k, msg.payload, tag) // raw content bytes; SCE parsing is the adapter's job
```

Remove the `buildEnvelope`/`parseEnvelope` imports and the `import ... from '../omemo2/sce'` line.

- [ ] **Step 6: Delete the placeholder SCE module**

```bash
git rm packages/omemo/src/omemo2/sce.ts packages/omemo/src/omemo2/sce.test.ts
```

- [ ] **Step 7: Update the venv harness emitter**

In `packages/omemo/src/interop/venv/emit_to_bob.mjs`, change the encrypt call to the new signature and pass explicit content bytes (a stand-in SCE byte string is fine for the LIBRARY-level harness; the plugin-level interop in Task 12 uses real SCE):

```js
const content = new TextEncoder().encode('interop hello from @fluux/omemo')
const msg = await alice.encrypt([{ jid: 'bob@localhost', deviceIds: [bob.deviceId] }], content)
```

And in `interop_decrypt.py`, the recovered plaintext now equals `content` directly (no envelope field-walk) — update its final assertion to `assert plaintext == b'interop hello from @fluux/omemo'` (or `expected in plaintext` if trailing bytes) and drop the SCE-envelope commentary.

- [ ] **Step 8: Run the library gate**

Run: `npm run test:run -w @fluux/omemo` → Expected: PASS (sce tests gone; account tests updated).
Run: `npm run typecheck -w @fluux/omemo` and `npm run lint -w @fluux/omemo` → clean.
Run: `npm run build -w @fluux/omemo` → dist emitted.
(Optional, if venv present: `packages/omemo/src/interop/venv/run.sh` → still exit 0 with the content-bytes shape.)

- [ ] **Step 9: Commit**

```bash
git add packages/omemo
git commit --no-gpg-sign -m "refactor(omemo): content-agnostic + multi-recipient encrypt; drop placeholder SCE"
```

---

### Task 2: Scaffold `@fluux/omemo-plugin`

**Files:** Create `packages/omemo-plugin/{package.json,tsconfig.json,tsconfig.build.json,tsup.config.ts,vitest.config.ts,eslint.config.js}`, `src/namespaces.ts`, `src/index.ts`; Test `src/namespaces.test.ts`.

**Interfaces:**
- Produces: `NS_OMEMO='urn:xmpp:omemo:2'`, `NS_DEVICES`, `NS_SCE='urn:xmpp:sce:1'`, `devicesNode(): string`, `bundleNode(deviceId: number): string`.

- [ ] **Step 1: `packages/omemo-plugin/package.json`**

```json
{
  "name": "@fluux/omemo-plugin",
  "version": "0.0.0",
  "description": "OMEMO 2 E2EEPlugin adapter for the Fluux SDK, built on @fluux/omemo.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup", "dev": "tsup --watch",
    "test": "vitest", "test:run": "vitest run", "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit", "lint": "eslint src", "lint:fix": "eslint src --fix", "clean": "rm -rf dist"
  },
  "dependencies": { "@fluux/omemo": "*", "@fluux/sdk": "*", "@xmpp/xml": "^0.13.1" },
  "devDependencies": {
    "@eslint/js": "^9.17.0", "eslint": "^9.17.0", "tsup": "^8.3.5",
    "typescript": "^5.7.2", "typescript-eslint": "^8.18.1", "vitest": "^2.1.8"
  }
}
```

> Verify the installed `@xmpp/xml` version against `packages/fluux-sdk`'s `@xmpp/client` transitive (`node -e "console.log(require('@xmpp/xml/package.json').version)"`); pin to what's already resolvable to avoid a duplicate copy. Adjust the caret if needed.

- [ ] **Step 2: tsconfig.json / tsconfig.build.json / tsup.config.ts / vitest.config.ts / eslint.config.js**

Copy `packages/omemo/tsconfig.json`, `tsconfig.build.json` (exclude `src/**/*.test.ts` and `src/interop/**`), `tsup.config.ts` (entry `{ index: 'src/index.ts' }`), `vitest.config.ts` (`globals: true`, `environment: 'node'`, exclude `**/interop/**` unless `VITEST_INTEROP`), and `eslint.config.js` (the `@fluux/omemo` one incl. the `no-unused-vars` `^_` rule and `ignores: ['dist/**','src/interop/**']`) verbatim, adjusting only paths.

- [ ] **Step 3: Write the failing test** `src/namespaces.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { NS_OMEMO, NS_DEVICES, NS_SCE, devicesNode, bundleNode } from './namespaces'

describe('namespaces', () => {
  it('has the exact OMEMO 2 / SCE strings', () => {
    expect(NS_OMEMO).toBe('urn:xmpp:omemo:2')
    expect(NS_DEVICES).toBe('urn:xmpp:omemo:2:devices')
    expect(NS_SCE).toBe('urn:xmpp:sce:1')
    expect(devicesNode()).toBe('urn:xmpp:omemo:2:devices')
    expect(bundleNode(42)).toBe('urn:xmpp:omemo:2:bundles:42')
  })
})
```

- [ ] **Step 4: Run — fails; then create `src/namespaces.ts`**

```ts
export const NS_OMEMO = 'urn:xmpp:omemo:2'
export const NS_DEVICES = 'urn:xmpp:omemo:2:devices'
export const NS_BUNDLES = 'urn:xmpp:omemo:2:bundles'
export const NS_SCE = 'urn:xmpp:sce:1'
export const devicesNode = (): string => NS_DEVICES
export const bundleNode = (deviceId: number): string => `${NS_BUNDLES}:${deviceId}`
```

- [ ] **Step 5: `src/index.ts`** (grows per task)

```ts
export * from './namespaces'
```

- [ ] **Step 6: Install + verify + commit**

Run: `npm install` (root). Then `npm run test:run -w @fluux/omemo-plugin` (PASS), `npm run typecheck -w @fluux/omemo-plugin` (clean).

```bash
git add packages/omemo-plugin package-lock.json
git commit --no-gpg-sign -m "feat(omemo-plugin): scaffold @fluux/omemo-plugin package"
```

---

### Task 3: `stanzaData.ts` — ltx Element ⇄ XMLElementData ⇄ string

**Files:** Create `src/stanzaData.ts`; Test `src/stanzaData.test.ts`.

**Interfaces:**
- Consumes: `@xmpp/xml` (`xml`, `parse` from ltx), `XMLElementData` (from `@fluux/sdk`).
- Produces: `elementToData(el: Element): XMLElementData`, `dataToElement(d: XMLElementData): Element`, `parseXml(s: string): Element`, `serializeElement(el: Element): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/xml'
import { elementToData, dataToElement, parseXml, serializeElement } from './stanzaData'

describe('stanzaData', () => {
  it('round-trips Element ⇄ XMLElementData with attrs, text, nesting', () => {
    const el = xml('body', { xmlns: 'jabber:client' }, 'hél&<lo')
    const data = elementToData(el)
    expect(data).toEqual({ name: 'body', attrs: { xmlns: 'jabber:client' }, children: ['hél&<lo'] })
    expect(serializeElement(dataToElement(data))).toBe(serializeElement(el))
  })
  it('parseXml handles escaping (no injection)', () => {
    const el = parseXml('<content><body>a &amp; b &lt;c&gt;</body></content>')
    expect(el.getChild('body')!.text()).toBe('a & b <c>')
  })
})
```

- [ ] **Step 2: Run — fails; then create `src/stanzaData.ts`**

```ts
import { xml } from '@xmpp/xml'
import type { Element } from '@xmpp/xml'
// ltx ships a parser; @xmpp/xml re-exports it.
import { parse as ltxParse } from 'ltx'
import type { XMLElementData } from '@fluux/sdk'

export function elementToData(el: Element): XMLElementData {
  return {
    name: el.name,
    attrs: { ...el.attrs },
    children: el.children.map((c) => (typeof c === 'string' ? c : elementToData(c as Element))),
  }
}

export function dataToElement(d: XMLElementData): Element {
  const children = d.children.map((c) => (typeof c === 'string' ? c : dataToElement(c)))
  return xml(d.name, d.attrs, ...children)
}

export function parseXml(s: string): Element {
  return ltxParse(s) as unknown as Element
}

export function serializeElement(el: Element): string {
  return el.toString()
}
```

> If `ltx` is not directly resolvable, use `import { parse } from '@xmpp/xml'` (some versions re-export it) — verify with `node -e "console.log(Object.keys(require('@xmpp/xml')))"` and adjust the import. Do NOT hand-roll an XML parser (escaping bugs = security bugs).

- [ ] **Step 3: Run to verify PASS; commit**

```bash
git add packages/omemo-plugin/src/stanzaData.ts packages/omemo-plugin/src/stanzaData.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): Element/XMLElementData conversion + safe XML parse"
```

---

### Task 4: `sce.ts` — XEP-0420 envelope build/parse

**Files:** Create `src/sce.ts`; Test `src/sce.test.ts`.

**Interfaces:**
- Consumes: `@xmpp/xml` (`xml`, `Element`), `b64encode` (from `@fluux/omemo`), an injected `rpadRng: (n:number)=>Uint8Array`.
- Produces:
  - `buildEnvelope(content: Element[], opts: { from?: string; to?: string; timeIso?: string }, rpadRng: (n:number)=>Uint8Array): Element`
  - `parseEnvelope(envelope: Element): { content: Element[]; from?: string; to?: string; timeIso?: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/xml'
import { buildEnvelope, parseEnvelope } from './sce'

const rpad = (n: number) => new Uint8Array(n).fill(7)

describe('XEP-0420 SCE envelope', () => {
  it('wraps content directly under <content>, includes mandatory rpad, round-trips', () => {
    const body = xml('body', {}, 'interop hello')
    const env = buildEnvelope([body], { from: 'a@x', to: 'b@y', timeIso: '2026-07-15T00:00:00Z' }, rpad)
    expect(env.name).toBe('envelope')
    expect(env.attrs.xmlns).toBe('urn:xmpp:sce:1')
    expect(env.getChild('rpad')).toBeTruthy() // mandatory
    const contentEl = env.getChild('content')!
    expect(contentEl.getChild('body')!.text()).toBe('interop hello') // body DIRECTLY under content
    const parsed = parseEnvelope(env)
    expect(parsed.content[0].name).toBe('body')
    expect(parsed.content[0].text()).toBe('interop hello')
    expect(parsed.from).toBe('a@x')
    expect(parsed.to).toBe('b@y')
    expect(parsed.timeIso).toBe('2026-07-15T00:00:00Z')
  })
  it('rpad varies with the rng (length-hiding)', () => {
    const a = buildEnvelope([xml('body', {}, 'x')], {}, (n) => new Uint8Array(n).fill(1))
    const b = buildEnvelope([xml('body', {}, 'x')], {}, (n) => new Uint8Array(Math.max(1, n) + 5).fill(2))
    expect(a.getChild('rpad')!.text()).not.toBe(b.getChild('rpad')!.text())
  })
})
```

- [ ] **Step 2: Run — fails; then create `src/sce.ts`**

```ts
import { xml } from '@xmpp/xml'
import type { Element } from '@xmpp/xml'
import { b64encode } from '@fluux/omemo'
import { NS_SCE } from './namespaces'

/** Build a XEP-0420 <envelope>. `content` children are placed DIRECTLY under <content>. */
export function buildEnvelope(
  content: Element[],
  opts: { from?: string; to?: string; timeIso?: string },
  rpadRng: (n: number) => Uint8Array,
): Element {
  const rpadLen = (rpadRng(1)[0] % 200) + 1 // 1..200 bytes, per XEP-0420 guidance
  const env = xml('envelope', { xmlns: NS_SCE },
    xml('content', {}, ...content),
    xml('rpad', {}, b64encode(rpadRng(rpadLen))),
  )
  if (opts.from) env.append(xml('from', { jid: opts.from }))
  if (opts.to) env.append(xml('to', { jid: opts.to }))
  if (opts.timeIso) env.append(xml('time', { stamp: opts.timeIso }))
  return env
}

export function parseEnvelope(envelope: Element): {
  content: Element[]; from?: string; to?: string; timeIso?: string
} {
  if (envelope.name !== 'envelope' || envelope.attrs.xmlns !== NS_SCE) {
    throw new Error('not a urn:xmpp:sce:1 envelope')
  }
  const contentEl = envelope.getChild('content')
  if (!contentEl) throw new Error('SCE envelope missing <content>')
  const content = contentEl.children.filter((c): c is Element => typeof c !== 'string')
  return {
    content,
    from: envelope.getChild('from')?.attrs.jid,
    to: envelope.getChild('to')?.attrs.jid,
    timeIso: envelope.getChild('time')?.attrs.stamp,
  }
}
```

- [ ] **Step 3: Run PASS; add edge tests** — empty content children (no body, key-transport), multi-byte UTF-8 body, and a content element with attributes all round-trip. Then commit.

```bash
git add packages/omemo-plugin/src/sce.ts packages/omemo-plugin/src/sce.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): XEP-0420 SCE envelope build/parse"
```

---

### Task 5: `encryptedElement.ts` — `<encrypted>` ⇄ `OmemoMessage`

**Files:** Create `src/encryptedElement.ts`; Test `src/encryptedElement.test.ts`.

**Interfaces:**
- Consumes: `@xmpp/xml`, `b64encode`/`b64decode` (`@fluux/omemo`), `OmemoMessage`/`OmemoKey` (`@fluux/omemo`), `NS_OMEMO`.
- Produces: `buildEncrypted(msg: OmemoMessage): Element`, `parseEncrypted(el: Element): OmemoMessage`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { buildEncrypted, parseEncrypted } from './encryptedElement'
import type { OmemoMessage } from '@fluux/omemo'

describe('<encrypted> ⇄ OmemoMessage', () => {
  it('groups keys by jid and round-trips (kex + payload)', () => {
    const msg: OmemoMessage = {
      sid: 111,
      keys: [
        { jid: 'bob@x', rid: 5, kex: true, data: new Uint8Array([1, 2, 3]) },
        { jid: 'bob@x', rid: 6, kex: false, data: new Uint8Array([4, 5]) },
        { jid: 'alice@x', rid: 9, kex: false, data: new Uint8Array([6]) },
      ],
      payload: new Uint8Array([9, 9, 9]),
    }
    const el = buildEncrypted(msg)
    expect(el.name).toBe('encrypted')
    expect(el.attrs.xmlns).toBe('urn:xmpp:omemo:2')
    expect(el.getChild('header')!.attrs.sid).toBe('111')
    expect(el.getChild('header')!.getChildren('keys')).toHaveLength(2) // two jid groups
    const parsed = parseEncrypted(el)
    expect(parsed).toEqual(msg)
  })
  it('omits <payload> for an empty (key-transport) message', () => {
    const el = buildEncrypted({ sid: 1, keys: [{ jid: 'b@x', rid: 2, kex: false, data: new Uint8Array([0]) }] })
    expect(el.getChild('payload')).toBeNull()
    expect(parseEncrypted(el).payload).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run — fails; then create `src/encryptedElement.ts`**

```ts
import { xml } from '@xmpp/xml'
import type { Element } from '@xmpp/xml'
import { b64encode, b64decode } from '@fluux/omemo'
import type { OmemoMessage, OmemoKey } from '@fluux/omemo'
import { NS_OMEMO } from './namespaces'

export function buildEncrypted(msg: OmemoMessage): Element {
  const byJid = new Map<string, OmemoKey[]>()
  for (const k of msg.keys) (byJid.get(k.jid) ?? byJid.set(k.jid, []).get(k.jid)!).push(k)

  const header = xml('header', { sid: String(msg.sid) })
  for (const [jid, keys] of byJid) {
    const keysEl = xml('keys', { jid })
    for (const k of keys) {
      const attrs: Record<string, string> = { rid: String(k.rid) }
      if (k.kex) attrs.kex = 'true'
      keysEl.append(xml('key', attrs, b64encode(k.data)))
    }
    header.append(keysEl)
  }
  const enc = xml('encrypted', { xmlns: NS_OMEMO }, header)
  if (msg.payload) enc.append(xml('payload', {}, b64encode(msg.payload)))
  return enc
}

export function parseEncrypted(el: Element): OmemoMessage {
  if (el.name !== 'encrypted' || el.attrs.xmlns !== NS_OMEMO) throw new Error('not a urn:xmpp:omemo:2 element')
  const header = el.getChild('header')
  if (!header) throw new Error('<encrypted> missing <header>')
  const sid = Number(header.attrs.sid)
  if (!Number.isInteger(sid)) throw new Error('invalid header sid')
  const keys: OmemoKey[] = []
  for (const keysEl of header.getChildren('keys')) {
    const jid = keysEl.attrs.jid
    if (!jid) throw new Error('<keys> missing jid')
    for (const keyEl of keysEl.getChildren('key')) {
      const rid = Number(keyEl.attrs.rid)
      if (!Number.isInteger(rid)) throw new Error('invalid key rid')
      keys.push({ jid, rid, kex: keyEl.attrs.kex === 'true', data: b64decode(keyEl.text()) })
    }
  }
  const payloadEl = el.getChild('payload')
  const payload = payloadEl ? b64decode(payloadEl.text()) : undefined
  return { sid, keys, ...(payload ? { payload } : {}) }
}
```

- [ ] **Step 3: Run PASS; add adversarial tests** — malformed sid/rid throws (not NaN silently accepted); `<keys>` without `jid` throws; a `<key>` with garbage base64 either throws or is caught upstream (assert `parseEncrypted` throws on non-base64 if `b64decode` throws). Commit.

```bash
git add packages/omemo-plugin/src/encryptedElement.ts packages/omemo-plugin/src/encryptedElement.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): <encrypted> element <-> OmemoMessage mapping"
```

---

### Task 6: `store.ts` — `OmemoStore` over `PluginStorage`

**Files:** Create `src/store.ts`; Test `src/store.test.ts`.

**Interfaces:**
- Consumes: `OmemoStore` + record types (`@fluux/omemo`), `PluginStorage` (`@fluux/sdk`).
- Produces: `class PluginStorageOmemoStore implements OmemoStore` (ctor takes a `PluginStorage`).

- [ ] **Step 1: Write the failing test** (use an in-memory PluginStorage stub)

```ts
import { describe, it, expect } from 'vitest'
import { PluginStorageOmemoStore } from './store'
import type { PluginStorage } from '@fluux/sdk'

function memStorage(): PluginStorage {
  const m = new Map<string, Uint8Array>()
  return {
    async get(k) { return m.get(k) ?? null },
    async put(k, v) { m.set(k, v) },
    async delete(k) { m.delete(k) },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)) },
  }
}

describe('PluginStorageOmemoStore', () => {
  it('round-trips identity, prekeys (with consumption), sessions, trust', async () => {
    const s = new PluginStorageOmemoStore(memStorage())
    await s.saveIdentity({ edSeed: new Uint8Array(32).fill(1), edPub: new Uint8Array(32).fill(2), deviceId: 7 })
    expect((await s.loadIdentity())!.deviceId).toBe(7)
    await s.savePreKey(3, { id: 3, priv: new Uint8Array(32), pub: new Uint8Array(32) })
    expect(await s.loadPreKey(3)).not.toBeNull()
    await s.removePreKey(3)
    expect(await s.loadPreKey(3)).toBeNull()
    await s.saveSession('bob@x', 5, new Uint8Array([9, 9]))
    expect(await s.loadSession('bob@x', 5)).toEqual(new Uint8Array([9, 9]))
    await s.saveTrust('bob@x', 5, { state: 'undecided', identityKey: new Uint8Array(32).fill(3) })
    expect((await s.loadTrust('bob@x', 5))!.state).toBe('undecided')
  })
})
```

- [ ] **Step 2: Run — fails; then create `src/store.ts`**

Serialize each record to bytes with a small JSON+base64 codec (records hold `Uint8Array`s). Keys are stable strings; `Uint8Array` session records store verbatim.

```ts
import type { PluginStorage } from '@fluux/sdk'
import type {
  OmemoStore, IdentityRecord, SignedPreKeyRecord, PreKeyRecord, SessionRecord, TrustRecord,
} from '@fluux/omemo'
import { b64encode, b64decode } from '@fluux/omemo'

const enc = new TextEncoder(); const dec = new TextDecoder()
const toBytes = (o: unknown): Uint8Array => enc.encode(JSON.stringify(o, (_k, v) =>
  v instanceof Uint8Array ? { __u8: b64encode(v) } : v))
const fromBytes = <T>(b: Uint8Array): T => JSON.parse(dec.decode(b), (_k, v) =>
  v && typeof v === 'object' && typeof (v as { __u8?: string }).__u8 === 'string' ? b64decode((v as { __u8: string }).__u8) : v)

const sessKey = (peer: string, id: number) => `session/${peer}/${id}`
const trustKey = (peer: string, id: number) => `trust/${peer}/${id}`

export class PluginStorageOmemoStore implements OmemoStore {
  constructor(private s: PluginStorage) {}
  private async load<T>(k: string): Promise<T | null> { const b = await this.s.get(k); return b ? fromBytes<T>(b) : null }
  private async save(k: string, v: unknown): Promise<void> { await this.s.put(k, toBytes(v)) }

  loadIdentity() { return this.load<IdentityRecord>('identity') }
  saveIdentity(r: IdentityRecord) { return this.save('identity', r) }
  loadSignedPreKey(id: number) { return this.load<SignedPreKeyRecord>(`spk/${id}`) }
  saveSignedPreKey(id: number, r: SignedPreKeyRecord) { return this.save(`spk/${id}`, r) }
  loadPreKey(id: number) { return this.load<PreKeyRecord>(`pk/${id}`) }
  savePreKey(id: number, r: PreKeyRecord) { return this.save(`pk/${id}`, r) }
  async removePreKey(id: number) { await this.s.delete(`pk/${id}`) }
  async loadSession(peer: string, id: number): Promise<SessionRecord | null> { return (await this.s.get(sessKey(peer, id))) }
  async saveSession(peer: string, id: number, r: SessionRecord) { await this.s.put(sessKey(peer, id), r) }
  loadTrust(peer: string, id: number) { return this.load<TrustRecord>(trustKey(peer, id)) }
  saveTrust(peer: string, id: number, r: TrustRecord) { return this.save(trustKey(peer, id), r) }
}
```

> `SessionRecord` is already a `Uint8Array` in `@fluux/omemo`, so sessions are stored verbatim (no JSON wrapping) — confirm the type; if it changed, wrap it too.

- [ ] **Step 3: Run PASS; commit**

```bash
git add packages/omemo-plugin/src/store.ts packages/omemo-plugin/src/store.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): OmemoStore backed by PluginStorage"
```

---

### Task 7: `trust.ts` — BTBV

**Files:** Create `src/trust.ts`; Test `src/trust.test.ts`.

**Interfaces:**
- Consumes: `TrustState` (`@fluux/sdk`), `TrustRecord` (`@fluux/omemo`).
- Produces:
  - `type BtbvState = 'undecided' | 'trusted' | 'untrusted'` (persisted per device via `TrustRecord.state`)
  - `resolveInboundTrust(peerHasVerifiedDevice: boolean, existing: BtbvState | null): { store: BtbvState; surfaced: TrustState }` — decides the state to persist for a newly-seen device and the `TrustState` to surface.
  - `toTrustState(s: BtbvState): TrustState`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { resolveInboundTrust, toTrustState } from './trust'

describe('BTBV', () => {
  it('auto-trusts (tofu) new devices before any verification', () => {
    const r = resolveInboundTrust(false, null)
    expect(r.store).toBe('trusted')       // blind-trust before verification
    expect(r.surfaced).toBe('tofu')
  })
  it('distrusts a new device once the peer has a verified device', () => {
    const r = resolveInboundTrust(true, null)
    expect(r.store).toBe('untrusted')
    expect(r.surfaced).toBe('untrusted')
  })
  it('keeps an explicit prior decision', () => {
    expect(resolveInboundTrust(true, 'trusted').surfaced).toBe('tofu') // note: verified elsewhere; existing trusted stays
    expect(resolveInboundTrust(false, 'untrusted').store).toBe('untrusted')
  })
  it('maps store state to TrustState', () => {
    expect(toTrustState('trusted')).toBe('tofu')
    expect(toTrustState('untrusted')).toBe('untrusted')
    expect(toTrustState('undecided')).toBe('unknown')
  })
})
```

> Note: BTBV's "verified" (out-of-band fingerprint confirmed) is a *separate* persisted flag set by the verification method (Task 10), distinct from the blind `trusted`. `toTrustState('trusted')` surfaces `tofu`; a verified device surfaces `verified` — handled in Task 10 where the fingerprint match sets a `verified` marker.

- [ ] **Step 2: Run — fails; then create `src/trust.ts`**

```ts
import type { TrustState } from '@fluux/sdk'

export type BtbvState = 'undecided' | 'trusted' | 'untrusted'

/** Blind-Trust-Before-Verification decision for a newly-seen device. */
export function resolveInboundTrust(
  peerHasVerifiedDevice: boolean,
  existing: BtbvState | null,
): { store: BtbvState; surfaced: TrustState } {
  if (existing && existing !== 'undecided') {
    return { store: existing, surfaced: toTrustState(existing) }
  }
  const store: BtbvState = peerHasVerifiedDevice ? 'untrusted' : 'trusted'
  return { store, surfaced: toTrustState(store) }
}

export function toTrustState(s: BtbvState): TrustState {
  switch (s) {
    case 'trusted': return 'tofu'
    case 'untrusted': return 'untrusted'
    default: return 'unknown'
  }
}
```

- [ ] **Step 3: Run PASS; commit**

```bash
git add packages/omemo-plugin/src/trust.ts packages/omemo-plugin/src/trust.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): BTBV trust state machine"
```

---

### Task 8: `testing/MockPluginContext.ts` — in-memory host

**Files:** Create `src/testing/MockPluginContext.ts`; Test `src/testing/MockPluginContext.test.ts`.

**Interfaces:**
- Consumes: `PluginContext`, `PEPItem`, `XMLElementData`, `PluginStorage`, `Subscription`, `Logger` (`@fluux/sdk`).
- Produces: `createMockPluginContext(jid: string, shared?: MockNetwork): { ctx: PluginContext; net: MockNetwork }` where `MockNetwork` is a shared in-memory PEP so two contexts can exchange bundles/device-lists.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createMockPluginContext } from './MockPluginContext'
import { xml } from '@xmpp/xml'
import { elementToData } from '../stanzaData'

describe('MockPluginContext', () => {
  it('publishes to and queries a shared in-memory PEP', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    await a.ctx.xmpp.publishPEP('urn:xmpp:omemo:2:devices', { id: 'current', payload: elementToData(xml('devices', {}, xml('device', { id: '5' }))) })
    const items = await b.ctx.xmpp.queryPEP('a@x', 'urn:xmpp:omemo:2:devices')
    expect(items[0].payload.name).toBe('devices')
  })
})
```

- [ ] **Step 2: Run — fails; then create `src/testing/MockPluginContext.ts`**

Implement a shared `MockNetwork` (Map keyed by `jid\0node` → `PEPItem[]`) with pub/query/subscribe, an in-memory `PluginStorage`, a no-op logger, and the two report channels as recording spies. Full code:

```ts
import type { PluginContext, PEPItem, PluginStorage, Subscription, SecurityContextUpdate } from '@fluux/sdk'

export interface MockNetwork {
  nodes: Map<string, PEPItem[]>
  subs: Map<string, Array<(item: PEPItem) => void>>
}
export function newMockNetwork(): MockNetwork { return { nodes: new Map(), subs: new Map() } }

function memPluginStorage(): PluginStorage {
  const m = new Map<string, Uint8Array>()
  return {
    async get(k) { return m.get(k) ?? null },
    async put(k, v) { m.set(k, v) },
    async delete(k) { m.delete(k) },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)) },
  }
}

export function createMockPluginContext(jid: string, shared?: MockNetwork): {
  ctx: PluginContext; net: MockNetwork; updates: SecurityContextUpdate[]
} {
  const net = shared ?? newMockNetwork()
  const updates: SecurityContextUpdate[] = []
  const key = (j: string, node: string) => `${j} ${node}`
  const ctx: PluginContext = {
    storage: memPluginStorage(),
    account: { jid },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportSecurityContextUpdate(u) { updates.push(u) },
    notifyKeyUnlocked() {},
    xmpp: {
      async sendStanza() {},
      async queryDisco() { return { features: [], identities: [] } },
      async publishPEP(node, item) {
        net.nodes.set(key(jid, node), [item])
        for (const cb of net.subs.get(key(jid, node)) ?? []) cb(item)
      },
      async retractPEP(node) { net.nodes.delete(key(jid, node)) },
      async deletePEP(node) { net.nodes.delete(key(jid, node)) },
      async queryPEP(peer, node) { return net.nodes.get(key(peer, node)) ?? [] },
      subscribePEP(peer, node, cb): Subscription {
        const k = key(peer, node); const arr = net.subs.get(k) ?? []; arr.push(cb); net.subs.set(k, arr)
        return { unsubscribe() { const a = net.subs.get(k); if (a) a.splice(a.indexOf(cb), 1) } }
      },
    },
  }
  return { ctx, net, updates }
}
```

- [ ] **Step 3: Run PASS; commit**

```bash
git add packages/omemo-plugin/src/testing/MockPluginContext.ts packages/omemo-plugin/src/testing/MockPluginContext.test.ts
git commit --no-gpg-sign -m "test(omemo-plugin): in-memory MockPluginContext host"
```

---

### Task 9: `pep.ts` — device-list + bundle over `XMPPPrimitives`

**Files:** Create `src/pep.ts`; Test `src/pep.test.ts`.

**Interfaces:**
- Consumes: `XMPPPrimitives`, `PEPItem`, `XMLElementData` (`@fluux/sdk`); `Bundle`, `DeviceList` (`@fluux/omemo`); `stanzaData`, `namespaces`, `@xmpp/xml`.
- Produces:
  - `publishDeviceList(xmpp, deviceIds: number[]): Promise<void>` / `fetchDeviceList(xmpp, jid): Promise<number[]>` / `subscribeDeviceList(xmpp, jid, cb: (ids:number[])=>void): Subscription`
  - `publishBundle(xmpp, deviceId: number, bundle: Bundle): Promise<void>` / `fetchBundle(xmpp, jid, deviceId): Promise<Bundle | null>`
  - `bundleToXml(bundle): Element` / `bundleFromXml(el): Bundle`; `deviceListToXml(ids): Element` / `deviceListFromXml(el): number[]`

- [ ] **Step 1: Write the failing test** (against `MockPluginContext`, exercising the real XML mapping)

```ts
import { describe, it, expect } from 'vitest'
import { createMockPluginContext } from './testing/MockPluginContext'
import { publishDeviceList, fetchDeviceList, publishBundle, fetchBundle } from './pep'
import type { Bundle } from '@fluux/omemo'

const sampleBundle = (): Bundle => ({
  ik: new Uint8Array(32).fill(1), spkId: 1, spk: new Uint8Array(32).fill(2), spkSig: new Uint8Array(64).fill(3),
  preKeys: Array.from({ length: 25 }, (_v, i) => ({ id: i + 1, key: new Uint8Array(32).fill(i + 4) })),
})

describe('OMEMO 2 PEP', () => {
  it('device list publish/fetch round-trips', async () => {
    const a = createMockPluginContext('a@x'); const b = createMockPluginContext('b@x', a.net)
    await publishDeviceList(a.ctx.xmpp, [5, 6])
    expect((await fetchDeviceList(b.ctx.xmpp, 'a@x')).sort()).toEqual([5, 6])
  })
  it('bundle publish/fetch round-trips byte-exact', async () => {
    const a = createMockPluginContext('a@x'); const b = createMockPluginContext('b@x', a.net)
    const bundle = sampleBundle()
    await publishBundle(a.ctx.xmpp, 5, bundle)
    const got = await fetchBundle(b.ctx.xmpp, 'a@x', 5)
    expect(got).toEqual(bundle)
  })
})
```

- [ ] **Step 2: Run — fails; then create `src/pep.ts`**

Map to the XEP-0384 XML: `<devices xmlns='urn:xmpp:omemo:2'><device id='N'/>…</devices>`; `<bundle xmlns='urn:xmpp:omemo:2'><ik>b64</ik><spk id='N'>b64</spk><spks>b64</spks><prekeys><pk id='N'>b64</pk>…</prekeys></bundle>`. Convert Element ↔ `XMLElementData` via `stanzaData` at the `XMPPPrimitives` boundary (its `PEPItem.payload` is `XMLElementData`). Full code:

```ts
import { xml } from '@xmpp/xml'
import type { Element } from '@xmpp/xml'
import type { XMPPPrimitives, Subscription } from '@fluux/sdk'
import type { Bundle } from '@fluux/omemo'
import { b64encode, b64decode } from '@fluux/omemo'
import { elementToData, dataToElement } from './stanzaData'
import { NS_OMEMO, devicesNode, bundleNode } from './namespaces'

export function deviceListToXml(ids: number[]): Element {
  return xml('devices', { xmlns: NS_OMEMO }, ...ids.map((id) => xml('device', { id: String(id) })))
}
export function deviceListFromXml(el: Element): number[] {
  return el.getChildren('device').map((d) => Number(d.attrs.id)).filter((n) => Number.isInteger(n))
}
export function bundleToXml(b: Bundle): Element {
  return xml('bundle', { xmlns: NS_OMEMO },
    xml('ik', {}, b64encode(b.ik)),
    xml('spk', { id: String(b.spkId) }, b64encode(b.spk)),
    xml('spks', {}, b64encode(b.spkSig)),
    xml('prekeys', {}, ...b.preKeys.map((p) => xml('pk', { id: String(p.id) }, b64encode(p.key)))),
  )
}
export function bundleFromXml(el: Element): Bundle {
  const spk = el.getChild('spk')!
  return {
    ik: b64decode(el.getChild('ik')!.text()),
    spkId: Number(spk.attrs.id),
    spk: b64decode(spk.text()),
    spkSig: b64decode(el.getChild('spks')!.text()),
    preKeys: el.getChild('prekeys')!.getChildren('pk').map((p) => ({ id: Number(p.attrs.id), key: b64decode(p.text()) })),
  }
}

export async function publishDeviceList(xmpp: XMPPPrimitives, deviceIds: number[]): Promise<void> {
  await xmpp.publishPEP(devicesNode(),
    { id: 'current', payload: elementToData(deviceListToXml(deviceIds)) },
    { accessModel: 'open', maxItems: 1 })
}
export async function fetchDeviceList(xmpp: XMPPPrimitives, jid: string): Promise<number[]> {
  const items = await xmpp.queryPEP(jid, devicesNode(), 1)
  return items[0] ? deviceListFromXml(dataToElement(items[0].payload)) : []
}
export function subscribeDeviceList(xmpp: XMPPPrimitives, jid: string, cb: (ids: number[]) => void): Subscription {
  return xmpp.subscribePEP(jid, devicesNode(), (item) => cb(deviceListFromXml(dataToElement(item.payload))))
}
export async function publishBundle(xmpp: XMPPPrimitives, deviceId: number, bundle: Bundle): Promise<void> {
  await xmpp.publishPEP(bundleNode(deviceId),
    { id: 'current', payload: elementToData(bundleToXml(bundle)) },
    { accessModel: 'open', maxItems: 1 })
}
export async function fetchBundle(xmpp: XMPPPrimitives, jid: string, deviceId: number): Promise<Bundle | null> {
  const items = await xmpp.queryPEP(jid, bundleNode(deviceId), 1)
  return items[0] ? bundleFromXml(dataToElement(items[0].payload)) : null
}
```

- [ ] **Step 3: Run PASS; add adversarial tests** — a bundle with a malformed prekey id and a device element with a non-numeric id are filtered/rejected, not silently mis-parsed. Commit.

```bash
git add packages/omemo-plugin/src/pep.ts packages/omemo-plugin/src/pep.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): OMEMO 2 device-list + bundle PEP mapping"
```

---

### Task 10: `OmemoPlugin.ts` — identity, probe, trust, verification

**Files:** Create `src/OmemoPlugin.ts`; Test `src/OmemoPlugin.identity.test.ts`; Modify `src/index.ts`.

**Interfaces:**
- Consumes: everything above + `OmemoAccount`, `fingerprint` (`@fluux/omemo`); the `E2EEPlugin` trait (`@fluux/sdk`).
- Produces: `class OmemoPlugin implements E2EEPlugin` with `descriptor`, `init`, `shutdown`, `ensureIdentity`, `probePeer`, `getVerificationMethods`, `startVerification`, `getPeerTrust`, `getDeviceTrust` (encrypt/decrypt in Task 11).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext } from './testing/MockPluginContext'
import { fetchDeviceList, fetchBundle } from './pep'

describe('OmemoPlugin identity/probe', () => {
  it('ensureIdentity publishes our device-list + bundle and returns a fingerprint', async () => {
    const a = createMockPluginContext('a@x')
    const p = new OmemoPlugin()
    await p.init(a.ctx)
    const id = await p.ensureIdentity()
    expect(id.fingerprint).toMatch(/[0-9a-f]/i)
    const devs = await fetchDeviceList(a.ctx.xmpp, 'a@x')
    expect(devs).toHaveLength(1)
    expect(await fetchBundle(a.ctx.xmpp, 'a@x', devs[0])).not.toBeNull()
  })
  it('probePeer reports supported when the peer advertises a device', async () => {
    const a = createMockPluginContext('a@x'); const b = createMockPluginContext('b@x', a.net)
    const pa = new OmemoPlugin(); await pa.init(a.ctx); await pa.ensureIdentity()
    const pb = new OmemoPlugin(); await pb.init(b.ctx)
    expect((await pb.probePeer('a@x')).supported).toBe(true)
    expect((await pb.probePeer('nobody@x')).supported).toBe(false)
  })
})
```

- [ ] **Step 2: Run — fails; then create `src/OmemoPlugin.ts`** (identity/probe/trust half)

```ts
import type {
  E2EEPlugin, E2EEProtocolDescriptor, PluginContext, IdentityInfo, PeerSupport,
  BareJID, TrustState, VerificationMethod, VerificationFlow,
} from '@fluux/sdk'
import { OmemoAccount, fingerprint } from '@fluux/omemo'
import { PluginStorageOmemoStore } from './store'
import { publishDeviceList, fetchDeviceList, publishBundle } from './pep'
import { toTrustState, type BtbvState } from './trust'
import { NS_OMEMO } from './namespaces'

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

export class OmemoPlugin implements E2EEPlugin {
  readonly descriptor: E2EEProtocolDescriptor = {
    id: 'omemo:2', displayName: 'OMEMO', securityLevel: 80,
    features: { forwardSecrecy: true, postCompromiseSecurity: true, multiDevice: true, groupChat: false, asynchronous: true, deniability: true },
  }
  private ctx!: PluginContext
  private account: OmemoAccount | null = null
  private rng: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))

  async init(ctx: PluginContext): Promise<void> { this.ctx = ctx }
  async shutdown(): Promise<void> { this.account = null }

  private async ensureAccount(): Promise<OmemoAccount> {
    if (this.account) return this.account
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    this.account = await OmemoAccount.create(store, this.rng) // create() loads existing identity if present
    return this.account
  }

  async ensureIdentity(): Promise<IdentityInfo> {
    const acc = await this.ensureAccount()
    const myDev = acc.publishableDeviceId()
    await publishBundle(this.ctx.xmpp, myDev, await acc.publishableBundleAsync())
    const existing = await fetchDeviceList(this.ctx.xmpp, this.ctx.account.jid)
    if (!existing.includes(myDev)) await publishDeviceList(this.ctx.xmpp, [...existing, myDev])
    return { fingerprint: hex(acc.identityFingerprint()), devices: [{ jid: this.ctx.account.jid, deviceId: String(myDev) }] }
  }

  async probePeer(peer: BareJID): Promise<PeerSupport> {
    const ids = await fetchDeviceList(this.ctx.xmpp, peer)
    return { supported: ids.length > 0, ttl: 300, variant: NS_OMEMO }
  }

  getVerificationMethods(): VerificationMethod[] {
    return [{ id: 'fingerprint-compare', displayName: 'Compare fingerprints', description: 'Confirm the safety number out of band.' }]
  }
  async startVerification(_peer: BareJID, _method: VerificationMethod): Promise<VerificationFlow> {
    throw new Error('fingerprint-compare verification UI is a later sub-project')
  }
  async getPeerTrust(peer: BareJID): Promise<TrustState> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const ids = await fetchDeviceList(this.ctx.xmpp, peer)
    let best: TrustState = 'unknown'
    for (const id of ids) {
      const t = await store.loadTrust(peer, id)
      const s = toTrustState((t?.state as BtbvState) ?? 'undecided')
      if (s === 'tofu' && best === 'unknown') best = 'tofu'
    }
    return best
  }
  async getDeviceTrust(peer: BareJID, deviceId: string): Promise<TrustState> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const t = await store.loadTrust(peer, Number(deviceId))
    return toTrustState((t?.state as BtbvState) ?? 'undecided')
  }
}
```

> `crypto.getRandomValues` is a global in Node ≥ 20 and browsers. `OmemoAccount.create` already loads a pre-existing identity from the store, so it is idempotent across restarts.

- [ ] **Step 3: Run PASS; append to `src/index.ts`**

```ts
export { OmemoPlugin } from './OmemoPlugin'
```

- [ ] **Step 4: Commit**

```bash
git add packages/omemo-plugin/src/OmemoPlugin.ts packages/omemo-plugin/src/OmemoPlugin.identity.test.ts packages/omemo-plugin/src/index.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): OmemoPlugin identity/probe/trust"
```

---

### Task 11: `OmemoPlugin` — encrypt / claim / decrypt (the SCE seam)

**Files:** Modify `src/OmemoPlugin.ts`; Test `src/OmemoPlugin.crypto.test.ts`.

**Interfaces:**
- Consumes: `sce`, `encryptedElement`, `pep`, `stanzaData`, `serializePayloadEnvelope`/`parsePayloadEnvelope` (`@fluux/sdk`), `OmemoAccount`.
- Produces on `OmemoPlugin`: `openConversation`, `closeConversation`, `encrypt`, `tryClaimInbound`, `decrypt`, `decryptArchive`, `decryptArchiveBatch`, `repairSession`.

- [ ] **Step 1: Write the failing test** — two plugins exchange a real message over shared mock PEP

```ts
import { describe, it, expect } from 'vitest'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext } from './testing/MockPluginContext'
import { serializePayloadEnvelope } from '@fluux/sdk'
import { xml } from '@xmpp/xml'
import { elementToData } from './stanzaData'

async function ready(jid: string, net?: never) {
  const c = createMockPluginContext(jid, net as never)
  const p = new OmemoPlugin(); await p.init(c.ctx); await p.ensureIdentity()
  return { p, c }
}

describe('OmemoPlugin encrypt/decrypt', () => {
  it('encrypts a body and the peer plugin decrypts it back', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net as never) // share the PEP
    // host hands the plugin a serialized <payload> fragment
    const payloadBytes = new TextEncoder().encode(serializePayloadEnvelope([xml('body', { xmlns: 'jabber:client' }, 'hi bob')]))

    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(handle, payloadBytes)
    expect(enc.stanzaElement.name).toBe('encrypted')

    // bob claims + decrypts
    const claimed = bob.p.tryClaimInbound(enc.stanzaElement)
    expect(claimed).not.toBeNull()
    const bobHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const res = await bob.p.decrypt(bobHandle, claimed!, { messageId: 'm1' })
    const body = new TextDecoder().decode(res.plaintext!)
    expect(body).toContain('hi bob')
    expect(res.status ?? 'ok').toBe('ok')
  })
})
```

- [ ] **Step 2: Run — fails; then implement the methods on `OmemoPlugin`**

Add imports and methods. `encrypt`: parse the host `<payload>` → children; SCE-wrap; resolve recipient devices (peer list + our own other devices), `processBundle` for missing sessions; `OmemoAccount.encrypt(recipients, sceBytes)`; build `<encrypted>`. `decrypt`: parse `<encrypted>` → `OmemoAccount.decrypt(senderJid, sid, msg, opts)` → SCE-unwrap → re-serialize as `<payload>` → `DecryptResult`.

```ts
// add to imports
import { xml } from '@xmpp/xml'
import type { Element } from '@xmpp/xml'
import {
  serializePayloadEnvelope, parsePayloadEnvelope,
  type ConversationHandle, type ConversationTarget, type EncryptedPayload,
  type DecryptResult, type InboundDecryptContext, type XMLElementData, type SecurityContext,
} from '@fluux/sdk'
import { buildEnvelope, parseEnvelope } from './sce'
import { buildEncrypted, parseEncrypted } from './encryptedElement'
import { fetchBundle, fetchDeviceList } from './pep'
import { elementToData, dataToElement } from './stanzaData'
import { toTrustState } from './trust'

const DEVICE_CAP = 50

// --- inside the class ---

async openConversation(target: ConversationTarget): Promise<ConversationHandle> {
  if (target.kind !== 'direct') throw new Error('OMEMO M2a supports 1:1 only')
  return { protocolId: this.descriptor.id, state: { peer: target.peer } }
}
async closeConversation(_h: ConversationHandle): Promise<void> {}

private peerOf(h: ConversationHandle): string { return (h.state as { peer: string }).peer }

/** Ensure sessions exist for every device in `recipients`, fetching+processing bundles as needed. */
private async ensureSessions(acc: OmemoAccount, jid: string, deviceIds: number[]): Promise<void> {
  for (const rid of deviceIds) {
    const bundle = await fetchBundle(this.ctx.xmpp, jid, rid)
    if (bundle) { try { await acc.processBundle(jid, rid, bundle) } catch { /* session may already exist */ } }
  }
}

async encrypt(handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
  const acc = await this.ensureAccount()
  const peer = this.peerOf(handle)
  const children = parsePayloadEnvelope(new TextDecoder().decode(plaintext)) ?? []
  const sce = buildEnvelope(children, { to: peer, from: this.ctx.account.jid }, this.rng)
  const sceBytes = new TextEncoder().encode(sce.toString())

  const myDev = acc.publishableDeviceId()
  const peerDevs = (await fetchDeviceList(this.ctx.xmpp, peer)).slice(0, DEVICE_CAP)
  const ownDevs = (await fetchDeviceList(this.ctx.xmpp, this.ctx.account.jid)).filter((d) => d !== myDev)
  await this.ensureSessions(acc, peer, peerDevs)
  await this.ensureSessions(acc, this.ctx.account.jid, ownDevs)

  const recipients = [
    { jid: peer, deviceIds: peerDevs },
    ...(ownDevs.length ? [{ jid: this.ctx.account.jid, deviceIds: ownDevs }] : []),
  ].filter((r) => r.deviceIds.length)
  if (recipients.every((r) => !r.deviceIds.length)) throw new Error('no OMEMO devices to encrypt to')

  const msg = await acc.encrypt(recipients, sceBytes)
  return { protocolId: this.descriptor.id, stanzaElement: elementToData(buildEncrypted(msg)), fallbackBody: '[This message is OMEMO-encrypted.]' }
}

tryClaimInbound(child: XMLElementData): EncryptedPayload | null {
  if (child.name !== 'encrypted' || child.attrs?.xmlns !== NS_OMEMO) return null
  return { protocolId: this.descriptor.id, stanzaElement: child }
}

async decrypt(handle: ConversationHandle, payload: EncryptedPayload, context?: InboundDecryptContext): Promise<DecryptResult> {
  return this.decryptWith(handle, payload, context, false)
}
async decryptArchive(handle: ConversationHandle, payload: EncryptedPayload, context?: InboundDecryptContext): Promise<DecryptResult> {
  return this.decryptWith(handle, payload, context, true)
}
async decryptArchiveBatch(handle: ConversationHandle, items: Array<{ payload: EncryptedPayload; context?: InboundDecryptContext }>): Promise<DecryptResult[]> {
  const out: DecryptResult[] = []
  for (const it of items) { try { out.push(await this.decryptWith(handle, it.payload, it.context, true)) } catch { out.push(this.brokenResult(handle)) } }
  return out
}

private brokenResult(handle: ConversationHandle): DecryptResult {
  return { status: 'broken-session', senderDevice: { jid: this.peerOf(handle), deviceId: '0' },
    securityContext: { protocolId: this.descriptor.id, trust: 'untrusted', notes: ['session could not be established'] } }
}

private async decryptWith(handle: ConversationHandle, payload: EncryptedPayload, context: InboundDecryptContext | undefined, archive: boolean): Promise<DecryptResult> {
  const acc = await this.ensureAccount()
  const msg = parseEncrypted(dataToElement(payload.stanzaElement))
  const senderJid = context?.isSelfOutgoing ? this.ctx.account.jid : this.peerOf(handle)
  let content: Uint8Array
  try { content = await acc.decrypt(senderJid, msg.sid, msg, { archive }) }
  catch { return this.brokenResult(handle) }

  const store = new PluginStorageOmemoStore(this.ctx.storage)
  const trust = await store.loadTrust(senderJid, msg.sid)
  const securityContext: SecurityContext = { protocolId: this.descriptor.id, trust: toTrustState((trust?.state as BtbvState) ?? 'undecided') }
  const senderDevice = { jid: senderJid, deviceId: String(msg.sid) }

  if (content.length === 0) return { status: 'control-message', senderDevice, securityContext } // empty/key-transport
  const env = parseEnvelope(this.parseString(new TextDecoder().decode(content)))
  const plaintext = new TextEncoder().encode(serializePayloadEnvelope(env.content))
  const authoredAt = env.timeIso ? new Date(env.timeIso) : undefined
  return { plaintext, status: 'ok', senderDevice, securityContext, ...(authoredAt ? { authoredAt } : {}) }
}

private parseString(s: string): Element { // local to avoid importing parseXml twice
  return dataToElement(elementToData(xml('x'))) as unknown as Element // replaced in Step 3
}

async repairSession(handle: ConversationHandle, peer: BareJID): Promise<void> {
  // discard broken sessions for the peer's devices and send an empty key-transport to re-handshake
  const acc = await this.ensureAccount()
  const devs = await fetchDeviceList(this.ctx.xmpp, peer)
  await this.ensureSessions(acc, peer, devs)
  const msg = await acc.encrypt([{ jid: peer, deviceIds: devs }], new Uint8Array(0)) // empty content
  await this.ctx.xmpp.sendStanza(this.wrapMessage(peer, elementToData(buildEncrypted(msg))))
}

private wrapMessage(to: string, encrypted: XMLElementData): XMLElementData {
  return { name: 'message', attrs: { to, type: 'chat' }, children: [encrypted] }
}
```

> The `parseString` placeholder above is wrong on purpose — replace it in the next step with the real XML parser from `stanzaData` (`parseXml`). It is separated so the reviewer catches an unreplaced stub.

- [ ] **Step 3: Fix `parseString` to use the real parser**

Replace the `parseString` method with a direct import:

```ts
// at top, add: import { parseXml } from './stanzaData'
// remove the parseString method and change the call site to:
const env = parseEnvelope(parseXml(new TextDecoder().decode(content)))
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run packages/omemo-plugin/src/OmemoPlugin.crypto.test.ts`
Expected: PASS. Add edge tests: tampered `<payload>` byte → decrypt returns `broken-session` (not a throw to the host); an empty message → `control-message`; a message with no `<keys>` for our device → `broken-session`/throws cleanly.

- [ ] **Step 5: Full package gate + commit**

Run: `npm run test:run -w @fluux/omemo-plugin`, `npm run typecheck -w @fluux/omemo-plugin`, `npm run lint -w @fluux/omemo-plugin`, `npm run build -w @fluux/omemo-plugin` — all clean.

```bash
git add packages/omemo-plugin/src/OmemoPlugin.ts packages/omemo-plugin/src/OmemoPlugin.crypto.test.ts
git commit --no-gpg-sign -m "feat(omemo-plugin): encrypt/claim/decrypt with real XEP-0420 SCE"
```

---

### Task 12: Body-level interop gate vs `twomemo`

**Files:** Create `packages/omemo-plugin/src/interop/plugin_interop.test.ts`, `packages/omemo-plugin/src/interop/emit_plugin_message.mjs`; reuse `packages/omemo/src/interop/venv/` runner + reference driver (extend it).

**Interfaces:** Consumes the built `@fluux/omemo-plugin` + a `MockPluginContext`; the reference `interop_decrypt.py` (extended to accept a plugin-produced `<encrypted>` and assert the recovered SCE body).

- [ ] **Step 1: Write `emit_plugin_message.mjs`** — drive the PLUGIN (not just the core) to produce a full `<encrypted>` stanza to a twomemo-generated bundle

The script: build a `MockPluginContext` for Alice; seed Bob's reference bundle (read from `bob_bundle.json` the reference wrote) into Alice's mock PEP under `bob@localhost`'s device-list + bundle node (so the plugin's `fetchDeviceList`/`fetchBundle` find them); `alice.encrypt` a `<body>interop hello from plugin</body>`; write the serialized `<encrypted>` XML string + Alice's bundle to `plugin_msg.json`. Full code:

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { OmemoPlugin } from '../../dist/index.js'
import { createMockPluginContext } from '../../dist/testing/MockPluginContext.js' // ensure tsup emits this (see Step 2)
import { serializePayloadEnvelope } from '@fluux/sdk'
import { xml } from '@xmpp/xml'
import { dataToElement, deviceListToXml, bundleToXml } from '../../dist/index.js'
// NOTE: adjust imports to whatever the built package actually exports; see Step 2.
```

> This step has an integration point: the interop emitter needs the plugin package to export (or the test to construct) the mock context and the PEP XML helpers. Decide in Step 2 whether to (a) add `MockPluginContext` + `deviceListToXml`/`bundleToXml` to the package's public exports for interop use, or (b) run the emitter as a `vitest` test inside the package (preferred — it can import from `src/` directly, no dist juggling). Prefer (b): make `plugin_interop.test.ts` a `describe.runIf(process.env.VITEST_INTEROP)` test that spawns the reference and does the whole flow in-process.

- [ ] **Step 2: Write `plugin_interop.test.ts`** (the real gate; in-process, imports from `src/`)

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { OmemoPlugin } from '../OmemoPlugin'
import { createMockPluginContext } from '../testing/MockPluginContext'
import { deviceListToXml, bundleToXml } from '../pep'
import { elementToData } from '../stanzaData'
import { serializePayloadEnvelope } from '@fluux/sdk'
import { xml } from '@xmpp/xml'

const HERE = new URL('.', import.meta.url).pathname
const VENV = /* path to packages/omemo/src/interop/venv */ new URL('../../../omemo/src/interop/venv/', import.meta.url).pathname

describe.runIf(process.env.VITEST_INTEROP)('plugin body-level interop vs twomemo', () => {
  beforeAll(() => mkdirSync(HERE + '_run', { recursive: true }))
  it('twomemo decrypts a plugin <encrypted> and recovers the body via SCE', () => {
    // 1) reference generates Bob's bundle (reuse venv/interop_decrypt.py gen-bundle mode, or a small python entry)
    execFileSync(VENV + '_run/venv/bin/python', [VENV + 'interop_gen_bundle.py', HERE + '_run/bob_bundle.json'])
    const bob = JSON.parse(readFileSync(HERE + '_run/bob_bundle.json', 'utf8'))

    // 2) plugin (Alice) encrypts to Bob, with Bob's device-list + bundle seeded into Alice's mock PEP
    return (async () => {
      const a = createMockPluginContext('alice@localhost')
      // seed bob@localhost devices + bundle
      await a.ctx.xmpp.publishPEP('urn:xmpp:omemo:2:devices', { id: 'current', payload: elementToData(deviceListToXml([bob.deviceId])) }) // NOTE: mock stores under alice; extend mock to allow seeding a foreign jid — see Step 3
      const p = new OmemoPlugin(); await p.init(a.ctx); await p.ensureIdentity()
      const h = await p.openConversation({ kind: 'direct', peer: 'bob@localhost' })
      const payload = new TextEncoder().encode(serializePayloadEnvelope([xml('body', { xmlns: 'jabber:client' }, 'interop hello from plugin')]))
      const enc = await p.encrypt(h, payload)
      writeFileSync(HERE + '_run/plugin_msg.json', JSON.stringify({ sid: /* from enc */ 0, xml: JSON.stringify(enc.stanzaElement) }))

      // 3) reference decrypts the plugin <encrypted> and parses the XEP-0420 envelope
      const out = execFileSync(VENV + '_run/venv/bin/python', [VENV + 'interop_decrypt_plugin.py', HERE + '_run/plugin_msg.json'], { encoding: 'utf8' })
      expect(out).toContain('interop hello from plugin')
    })()
  })
})
```

> This test has real integration points (seeding a foreign JID's PEP into the mock; extracting the `<encrypted>` in a form the reference reads; a reference-side `interop_decrypt_plugin.py` that reconstructs the stanza and, after `decrypt`, parses the recovered bytes as a `urn:xmpp:sce:1` `<envelope>` and prints the `<body>` text). These are the expected iteration points of the interop gate — wire them against the actual APIs during execution. The load-bearing assertions are: (a) `twomemo.decrypt` succeeds with no MAC error, and (b) the recovered content parses as SCE and yields exactly `interop hello from plugin`.

- [ ] **Step 3: Extend the mock to seed a foreign JID + add the reference python helpers**

Add a `seedPeer(net, jid, node, payload)` helper to `MockPluginContext.ts` (write directly into `net.nodes`), and add `interop_gen_bundle.py` (Bob-bundle-only export, factored from `interop_decrypt.py` main) and `interop_decrypt_plugin.py` (takes the plugin `<encrypted>` JSON, rebuilds the XEP-0384 stanza, `bob.decrypt(...)`, then `twomemo`-independently parses the recovered bytes as `<envelope xmlns='urn:xmpp:sce:1'>` and prints `<content>/<body>` text) under `packages/omemo/src/interop/venv/`.

- [ ] **Step 4: Run the gate**

```bash
packages/omemo/src/interop/venv/run.sh   # ensure venv exists
VITEST_INTEROP=1 npx vitest run packages/omemo-plugin/src/interop/plugin_interop.test.ts
```
Expected: PASS — the reference recovers `interop hello from plugin`. A failure localizes to the SCE XML shape (`<content>` must hold `<body>` directly), the `<encrypted>` mapping, or a wire constant.

- [ ] **Step 5: Commit**

```bash
git add packages/omemo-plugin/src/interop packages/omemo/src/interop/venv
git commit --no-gpg-sign -m "test(omemo-plugin): body-level interop gate vs twomemo"
```

---

## Self-Review

**Spec coverage:**
- Package & boundary (`@fluux/omemo-plugin`, deps) → Task 2. ✓
- Library-boundary refactor (content-agnostic + multi-recipient + jid-tagged keys + delete sce) → Task 1. ✓
- SCE seam (host `<payload>` ↔ XEP-0420 `<envelope>`, rpad mandatory, body directly in content) → Tasks 4, 11. ✓
- `<encrypted>` XML ⇄ OmemoMessage (jid grouping) → Task 5. ✓
- PEP device-list/bundle → Task 9. ✓
- OmemoStore over PluginStorage → Task 6. ✓
- BTBV trust → Task 7 + Task 10 (`getPeerTrust`/`getDeviceTrust`). ✓
- E2EEPlugin method mapping → Tasks 10 (identity/probe/trust) + 11 (encrypt/decrypt/claim/archive/repair). ✓
- Mock PluginContext test host → Task 8. ✓
- Body-level interop gate → Task 12. ✓
- Encryption-at-rest OUT of scope → not present (correct). ✓

**Placeholder scan:** The `parseString` stub in Task 11 Step 2 is *intentional* (replaced in Step 3, flagged for the reviewer). Task 12 has explicit, labeled integration points (foreign-JID PEP seeding; the reference-side `interop_decrypt_plugin.py`) — the interop gate is the one place iteration against an external API is expected; the load-bearing assertions are stated. No other TODO/TBD.

**Type consistency:** `OmemoKey` gains `jid` in Task 1 and is used with `jid` in Tasks 5/11; `OmemoAccount.encrypt(recipients, content)` / `decrypt(senderJid, sid, msg, opts)` consistent across Tasks 1 and 11; `PluginStorageOmemoStore` consistent across Tasks 6/10/11; `buildEnvelope`/`parseEnvelope` (SCE) and `buildEncrypted`/`parseEncrypted` consistent across Tasks 4/5/11; `elementToData`/`dataToElement`/`parseXml` consistent across Tasks 3/9/11.

**Known execution risks:**
1. `@xmpp/xml` parse export name (`ltx.parse` vs `@xmpp/xml` re-export) — Task 3 flags verifying against the installed version.
2. `serializePayloadEnvelope`/`parsePayloadEnvelope` operate on ltx `Element[]` and a `string`; the plugin's `encrypt` receives a `Uint8Array` — the plan decodes to string first. Confirm the host actually hands a `<payload>`-wrapped fragment (per Chat.ts) at execution.
3. Own-device fan-out depends on our own device-list being published (Task 10) before encrypt; a single-device account has an empty `ownDevs` (handled — filtered out).
4. Task 12 interop is the iteration-heavy gate; treat a decrypt/MAC failure there as a real interop bug (SCE shape or wire constant), not a test-wiring issue, once the wiring is confirmed.
