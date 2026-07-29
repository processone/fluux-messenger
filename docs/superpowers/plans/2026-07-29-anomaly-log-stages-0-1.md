# Anomaly log — stages 0 and 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the build-time gate (stage 0) and the anomaly recording spine (stage 1) from
`docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md`, with **no detectors** —
so the elimination and privacy guarantees are proven before anything is built on them.

**Architecture:** A `__FLUUX_ANOMALY__` build-time constant gates a self-contained
`apps/fluux/src/anomaly/` tree. Values entering a record are opaque objects validated by `WeakSet`
membership; records are bounded by a per-id cooldown and a session ceiling; writes go through a
single-flight queue to a JSONL sidecar via `plugin-fs` `writeFile`. A Rollup build-audit plugin
fails the production build if any module under `src/anomaly/` survives.

**Tech Stack:** TypeScript, Vite 7 (Rollup), Vitest (happy-dom), React 19, `@tauri-apps/plugin-fs`
2.5.1, WebCrypto (HMAC-SHA-256).

## Global Constraints

- **No new Tauri permission.** `capabilities/default.json` must not gain an entry. Use `writeFile`
  (`plugin:fs|write_file`, granted by `fs:allow-write-file` for `$HOME/**`), never `writeTextFile`.
- **No new native command.** No change to `generate_handler!` in `src-tauri/src/main.rs`.
- **No SDK change.** Stages 0–1 touch `apps/fluux/` and root config only.
- **No primitive string may reach a record field.** `ctx` values, crumb values, `expected` and
  `observed` accept opaque objects only.
- **No public constructor producing a `Tag` from a runtime string.**
- Sidecar path: `~/Library/Logs/com.processone.fluux/anomalies.YYYY-MM-DD.jsonl` (macOS);
  `dirs::data_local_dir()/com.processone.fluux/logs/` equivalent elsewhere.
- Ring size 100 crumbs; 50 attached per record; cooldown 60 000 ms; ceiling 500 records or
  2 MB; max line 8 192 bytes; `LocalRef` cap 2 000; token cache 500.
- Commit messages in English. No AI attribution or generated-by footers.
- Verification gates: `npm test`, `npm run typecheck`, `npm run lint` must pass.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/fluux/vite.config.ts` | Declares `__FLUUX_ANOMALY__`; registers the build-audit plugin |
| `apps/fluux/vitest.config.ts` | Declares `__FLUUX_ANOMALY__` for tests |
| `apps/fluux/src/vite-env.d.ts` | Ambient type for the constant |
| `apps/fluux/scripts/tauri-build.sh` | Sets `FLUUX_ANOMALY=1` for the Dev identity build |
| `scripts/build-e2e.mjs` | Sets `FLUUX_ANOMALY=1` for the Playwright build |
| `apps/fluux/scripts/anomalyBuildAudit.ts` | Rollup plugin asserting the module graph |
| `apps/fluux/src/anomaly/schema.ts` | Opaque values, `TAG`, `Token`, `LocalRef` |
| `apps/fluux/src/anomaly/serializer.ts` | Provenance validation and JSONL line construction |
| `apps/fluux/src/anomaly/recorder.ts` | Ring, counters, cooldown, ceiling, envelope, digest |
| `apps/fluux/src/anomaly/sinks/memory.ts` | `window.__fluuxAnomalies` sink |
| `apps/fluux/src/anomaly/sinks/tauri.ts` | Single-flight append sink |
| `apps/fluux/src/anomaly/install.ts` | Idempotent install returning cleanup |
| `apps/fluux/src/anomaly/AnomalyInstaller.tsx` | Mounts inside `XMPPProvider` |
| `docs/ANOMALY_INVARIANTS.md` | Registry keyed by invariant id |

---

# Stage 0 — the gate

### Task 1: Declare `__FLUUX_ANOMALY__` and its gate matrix

**Files:**
- Modify: `apps/fluux/vite.config.ts:51` (export form) and `:139-152` (`define`)
- Modify: `apps/fluux/vitest.config.ts:5-30`
- Modify: `apps/fluux/src/vite-env.d.ts:5`
- Test: `apps/fluux/src/anomaly/gate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: global `declare const __FLUUX_ANOMALY__: boolean`, true in dev/test/E2E builds and when
  `FLUUX_ANOMALY=1`, false in a production build without the variable.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

/**
 * The gate matrix from the design spec, §7.2.1. `resolveAnomalyGate` is the single
 * function both vite.config.ts and vitest.config.ts call, so this test asserts the
 * matrix directly instead of trusting the two configs to agree with each other.
 */
import { resolveAnomalyGate } from './gate'

describe('resolveAnomalyGate', () => {
  it('is off for a production build with no override', () => {
    expect(resolveAnomalyGate('production', {})).toBe(false)
  })

  it('is on for the dev server', () => {
    expect(resolveAnomalyGate('development', {})).toBe(true)
  })

  it('is on for a production build with FLUUX_ANOMALY=1 (the Dev bundle)', () => {
    expect(resolveAnomalyGate('production', { FLUUX_ANOMALY: '1' })).toBe(true)
  })

  it('is off when explicitly disabled, even in development', () => {
    expect(resolveAnomalyGate('development', { FLUUX_ANOMALY: '0' })).toBe(false)
  })

  it('treats the constant as available at runtime', () => {
    expect(typeof __FLUUX_ANOMALY__).toBe('boolean')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/gate.test.ts
```

Expected: FAIL — `Failed to resolve import "./gate"`, and `__FLUUX_ANOMALY__ is not defined`.

- [ ] **Step 3: Create the gate module**

Create `apps/fluux/src/anomaly/gate.ts`:

```ts
/**
 * Build-time gate for the anomaly instrumentation tree.
 *
 * `__FLUUX_ANOMALY__` is substituted as a literal by Vite so every
 * `if (__FLUUX_ANOMALY__)` branch is dead-code eliminated in a release build.
 * It is NOT `import.meta.env.DEV`: `Fluux Messenger Dev` is produced by
 * `tauri build`, which runs the PRODUCTION vite build, so `DEV` is false in the
 * one build whose usage we most want to observe.
 *
 * ANOMALY_BUILD_SENTINEL is grepped by CI: its presence in a production asset
 * means dead-code elimination regressed.
 */
export const ANOMALY_BUILD_SENTINEL = 'fluux-anomaly-instrumentation-present'

/**
 * Resolve the gate for a build. Shared by vite.config.ts and vitest.config.ts so
 * the matrix has exactly one definition.
 *
 * @param mode - Vite mode ('development' | 'production' | ...)
 * @param env - process.env, or a subset for testing
 */
export function resolveAnomalyGate(
  mode: string,
  env: { FLUUX_ANOMALY?: string },
): boolean {
  if (env.FLUUX_ANOMALY === '1') return true
  if (env.FLUUX_ANOMALY === '0') return false
  return mode !== 'production'
}
```

- [ ] **Step 4: Declare the ambient type**

In `apps/fluux/src/vite-env.d.ts`, after line 5 (`declare const __GIT_COMMIT__: string`), add:

```ts
/** Anomaly instrumentation gate — see src/anomaly/gate.ts. */
declare const __FLUUX_ANOMALY__: boolean
```

- [ ] **Step 5: Wire the define into the app build**

In `apps/fluux/vite.config.ts`, add to the imports at the top:

```ts
import { resolveAnomalyGate } from './src/anomaly/gate'
```

Change line 51 from:

```ts
export default defineConfig({
```

to:

```ts
export default defineConfig(({ mode }) => ({
```

Change the final two lines of the file from:

```ts
  },
})
```

to:

```ts
  },
}))
```

In the `define` block, after `__GIT_COMMIT__: JSON.stringify(gitCommit),` add:

```ts
    __FLUUX_ANOMALY__: JSON.stringify(resolveAnomalyGate(mode, process.env)),
```

- [ ] **Step 6: Wire the define into tests**

In `apps/fluux/vitest.config.ts`, add the import:

```ts
import { resolveAnomalyGate } from './src/anomaly/gate'
```

and add a top-level `define` key next to `resolve`:

```ts
  define: {
    __FLUUX_ANOMALY__: JSON.stringify(resolveAnomalyGate('development', process.env)),
  },
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/fluux && npx vitest run src/anomaly/gate.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 8: Verify the app still builds and type-checks**

```bash
npm run typecheck && npm run build:app
```

Expected: both succeed. The `defineConfig` function form must not break the PWA plugin.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/vite.config.ts apps/fluux/vitest.config.ts apps/fluux/src/vite-env.d.ts apps/fluux/src/anomaly/gate.ts apps/fluux/src/anomaly/gate.test.ts
git commit -m "feat: add the __FLUUX_ANOMALY__ build-time gate"
```

---

### Task 2: Turn the gate on for the Dev bundle and the E2E build

**Files:**
- Modify: `apps/fluux/scripts/tauri-build.sh:72-73`
- Modify: `scripts/build-e2e.mjs:42-45` and its assertion message near `:75`

**Interfaces:**
- Consumes: `resolveAnomalyGate` from Task 1 (via the `FLUUX_ANOMALY` variable it reads).
- Produces: `Fluux Messenger Dev` and the Playwright build both compile with the gate on.

- [ ] **Step 1: Export the variable in the Dev bundle build**

In `apps/fluux/scripts/tauri-build.sh`, immediately before the line
`EXTRA_ARGS+=(--config "$DEV_CONF")`, add:

```bash
# Local builds carry the anomaly instrumentation (see
# docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md).
# `tauri build` runs the PRODUCTION vite build via beforeBuildCommand, so
# import.meta.env.DEV is false here — this variable is what turns the tree on.
export FLUUX_ANOMALY=1
```

- [ ] **Step 2: Export the variable in the E2E build**

In `scripts/build-e2e.mjs`, change the `env` on the `vite build` spawn from:

```js
  env: { ...process.env, FLUUX_E2E_BUILD: '1', NODE_ENV: 'development' },
```

to:

```js
  env: { ...process.env, FLUUX_E2E_BUILD: '1', NODE_ENV: 'development', FLUUX_ANOMALY: '1' },
```

- [ ] **Step 3: Update the E2E build's seam assertion message**

In `scripts/build-e2e.mjs`, the failure message near line 75 currently blames
`import.meta.env.DEV`. Replace that message string with:

```js
      'This means the Playwright seams were stripped — check that both NODE_ENV=development ' +
      'and FLUUX_ANOMALY=1 reach vite (see apps/fluux/src/anomaly/gate.ts).\n' +
```

- [ ] **Step 4: Verify the E2E build still produces the seams**

```bash
npm run build:e2e
```

Expected: completes without hitting the `fail(...)` path, and `dist/demo.html` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/scripts/tauri-build.sh scripts/build-e2e.mjs
git commit -m "build: enable the anomaly gate for the Dev bundle and E2E build"
```

---

### Task 3: Move the MessageList probes onto the gate

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx:497` and `:652`

**Interfaces:**
- Consumes: `__FLUUX_ANOMALY__` from Task 1.
- Produces: `window.__fluuxGetVirtOffset`, `window.__fluuxTriggerLoadOlder` and
  `window.__fluuxTriggerMediaLoad` now exist in `Fluux Messenger Dev`, where they never have.

This is the pre-existing bug from spec §2.1: these probes are gated on `import.meta.env.DEV`, which
is **false** in the Dev bundle, so they have never run in the daily-driver build.

- [ ] **Step 1: Replace the first gate**

At `apps/fluux/src/components/conversation/MessageList.tsx:497`, change:

```ts
    if (!import.meta.env.DEV || !activeVirtualizer || typeof window === 'undefined') return
```

to:

```ts
    if (!__FLUUX_ANOMALY__ || !activeVirtualizer || typeof window === 'undefined') return
```

- [ ] **Step 2: Replace the second gate**

At `apps/fluux/src/components/conversation/MessageList.tsx:652`, change:

```ts
    if (!import.meta.env.DEV || typeof window === 'undefined') return
```

to:

```ts
    if (!__FLUUX_ANOMALY__ || typeof window === 'undefined') return
```

- [ ] **Step 3: Update the comment above each probe**

Change both `// Dev-only:` comment prefixes to:

```ts
  // Gated on __FLUUX_ANOMALY__ (not import.meta.env.DEV, which is false in the
  // packaged Dev bundle — see src/anomaly/gate.ts).
```

- [ ] **Step 4: Verify the scroll suite still passes**

```bash
npm run test:scroll
```

Expected: PASS. These probes are what `invariant-1` and the load-earlier tests use, so a
regression here fails loudly rather than silently.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageList.tsx
git commit -m "fix: gate the MessageList test probes on __FLUUX_ANOMALY__

They were gated on import.meta.env.DEV, which is false in the packaged
Fluux Messenger Dev bundle, so they never installed in the build used
daily."
```

---

# Stage 1 — the spine

### Task 4: Opaque values and the `TAG` constants

**Files:**
- Create: `apps/fluux/src/anomaly/schema.ts`
- Test: `apps/fluux/src/anomaly/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Opaque` (`{ readonly s: string }`), `isOpaque(v): v is Opaque`, and
  `TAG` — a frozen record of pre-built `Opaque` constants. No exported function produces an
  `Opaque` from a caller-supplied string.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isOpaque, TAG } from './schema'

describe('opaque values', () => {
  it('recognises a TAG constant', () => {
    expect(isOpaque(TAG.focus)).toBe(true)
  })

  it('rejects a primitive string that equals a tag', () => {
    expect(isOpaque('focus')).toBe(false)
  })

  it('rejects a structurally identical forgery', () => {
    expect(isOpaque({ s: 'focus' })).toBe(false)
  })

  it('rejects a frozen forgery', () => {
    expect(isOpaque(Object.freeze({ s: 'focus' }))).toBe(false)
  })

  it('exposes no function that builds a tag from a runtime string', async () => {
    const mod = await import('./schema')
    const suspects = Object.entries(mod).filter(
      ([name, value]) => typeof value === 'function' && /^tag$/i.test(name),
    )
    expect(suspects).toEqual([])
  })

  it('freezes the TAG record', () => {
    expect(Object.isFrozen(TAG)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/schema.test.ts
```

Expected: FAIL — `Failed to resolve import "./schema"`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/anomaly/schema.ts`:

```ts
/**
 * Opaque record values.
 *
 * Privacy here is enforced by PROVENANCE, not by shape. A pattern check ("does
 * this look like a tag or a token?") would accept a message body that happens to
 * equal `focus` or to match the token format. Instead every value admissible in a
 * record is an object this module built and registered in a module-private
 * WeakSet, and the serializer rejects primitive strings outright.
 *
 * `TAG` has no dynamic constructor on purpose: a `tag(value: string)` helper would
 * let `tag(message.body as any)` emit a body through a check it passed honestly.
 * `Token` and `LocalRef` (below, later tasks) may take runtime input because
 * neither ever re-emits it — one returns an HMAC digest, the other a sequence
 * number.
 */

const OPAQUE = new WeakSet<object>()

/** A value cleared for inclusion in a record. Construct only via this module. */
export interface Opaque {
  readonly s: string
}

/** @internal Build and register an opaque value. Never exported. */
function makeOpaque(s: string): Opaque {
  const value = Object.freeze({ s })
  OPAQUE.add(value)
  return value
}

/** True only for a value this module constructed. Not structural. */
export function isOpaque(v: unknown): v is Opaque {
  return typeof v === 'object' && v !== null && OPAQUE.has(v as object)
}

/**
 * The closed set of breadcrumb and field tags. Add a constant here to add a tag;
 * there is deliberately no way to mint one at runtime.
 */
export const TAG = Object.freeze({
  focus: makeOpaque('focus'),
  blur: makeOpaque('blur'),
  msgIn: makeOpaque('msg:in'),
  msgOut: makeOpaque('msg:out'),
  ptrAdvance: makeOpaque('ptr:advance'),
  activate: makeOpaque('activate'),
  deactivate: makeOpaque('deactivate'),
  scrollWrite: makeOpaque('scroll:write'),
  mamQuery: makeOpaque('mam:query'),
  mamResult: makeOpaque('mam:result'),
  ahead: makeOpaque('ahead'),
  behind: makeOpaque('behind'),
})

export type Tag = (typeof TAG)[keyof typeof TAG]
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/schema.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/schema.ts apps/fluux/src/anomaly/schema.test.ts
git commit -m "feat: add opaque anomaly record values with WeakSet provenance"
```

---

### Task 5: `LocalRef` with namespaced keys, ref-counted pins and a hard cap

**Files:**
- Create: `apps/fluux/src/anomaly/localRef.ts`
- Test: `apps/fluux/src/anomaly/localRef.test.ts`

**Interfaces:**
- Consumes: `Opaque`, `isOpaque` from Task 4 (via a new internal export `makeOpaqueInternal`).
- Produces:
  - `type LocalNs = 'm' | 'q' | 'x'` (message, MAM query, stanza)
  - `localRef(ns: LocalNs, value: string): Opaque | null` — `null` means overflow
  - `retainRef(ns: LocalNs, value: string): void`
  - `releaseRef(ns: LocalNs, value: string): void`
  - `localRefOverflowCount(): number`
  - `resetLocalRefsForTesting(): void`

- [ ] **Step 1: Export the internal constructor from `schema.ts`**

Add to `apps/fluux/src/anomaly/schema.ts`, below `isOpaque`:

```ts
/**
 * @internal Construct an opaque value from a DERIVED string (an HMAC digest or a
 * sequence number). Never call this with caller data — see the module comment.
 * Exported only for `token.ts` and `localRef.ts`, which live behind the same gate.
 */
export function makeDerivedOpaque(s: string): Opaque {
  return makeOpaque(s)
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/fluux/src/anomaly/localRef.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { isOpaque } from './schema'
import {
  localRef,
  localRefOverflowCount,
  releaseRef,
  resetLocalRefsForTesting,
  retainRef,
} from './localRef'

beforeEach(() => resetLocalRefsForTesting())

describe('localRef', () => {
  it('returns a stable opaque ref for the same namespace and value', () => {
    const a = localRef('m', 'abc')
    const b = localRef('m', 'abc')
    expect(isOpaque(a!)).toBe(true)
    expect(a).toBe(b)
  })

  it('namespaces the key so the same string in two roles is two refs', () => {
    const asMessage = localRef('m', 'shared-id')
    const asQuery = localRef('q', 'shared-id')
    expect(asMessage!.s).not.toBe(asQuery!.s)
  })

  it('renders as s:<ns><n>', () => {
    expect(localRef('m', 'first')!.s).toMatch(/^s:m[0-9]+$/)
  })

  it('only becomes evictable after every holder releases', () => {
    localRef('q', 'live')
    retainRef('q', 'live')
    retainRef('q', 'live')
    retainRef('q', 'live')
    const original = localRef('q', 'live')!.s

    releaseRef('q', 'live')
    releaseRef('q', 'live')
    // Two of three holders gone: still pinned, so pressure cannot evict it.
    for (let i = 0; i < 2100; i++) localRef('m', `filler-${i}`)
    expect(localRef('q', 'live')!.s).toBe(original)
  })

  it('evicts zero-count entries under pressure', () => {
    localRef('m', 'unpinned')
    for (let i = 0; i < 2100; i++) localRef('m', `filler-${i}`)
    // Re-requesting an evicted value yields a NEW ref, which is safe because
    // nothing referenced it any more.
    expect(localRef('m', 'unpinned')!.s).toMatch(/^s:m[0-9]+$/)
  })

  it('refuses new allocations rather than growing when everything is pinned', () => {
    for (let i = 0; i < 2000; i++) {
      localRef('m', `pinned-${i}`)
      retainRef('m', `pinned-${i}`)
    }
    expect(localRef('m', 'one-too-many')).toBeNull()
    expect(localRefOverflowCount()).toBe(1)
    // Existing identities are preserved, never reassigned.
    expect(localRef('m', 'pinned-0')!.s).toBe('s:m1')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/localRef.test.ts
```

Expected: FAIL — `Failed to resolve import "./localRef"`.

- [ ] **Step 4: Write the implementation**

Create `apps/fluux/src/anomaly/localRef.ts`:

```ts
/**
 * Session-local opaque references for EPHEMERAL identifiers (message ids, stanza
 * ids, MAM query ids).
 *
 * These cannot use the async HMAC token path: an id seen for the first time at the
 * moment a breadcrumb is recorded has no prior event to pre-warm from, so every
 * such crumb would serialize as the same unresolved sentinel and become mutually
 * indistinguishable. A synchronous sequence number has no such problem.
 *
 * Cost accepted: a LocalRef does not correlate across sessions. For the identity of
 * a single stanza or query that is the correct scope.
 */
import { makeDerivedOpaque, type Opaque } from './schema'

/** m = message, q = MAM query, x = stanza. */
export type LocalNs = 'm' | 'q' | 'x'

const CAP = 2000

interface Entry {
  ref: Opaque
  /** Ref-counted: one ref can be held by several crumbs AND an open request. */
  count: number
  /** Insertion order, for oldest-first eviction. */
  seq: number
}

const entries = new Map<string, Entry>()
let nextSeq = 0
let overflow = 0

function keyOf(ns: LocalNs, value: string): string {
  // Namespaced: a stanza id and a MAM query id can be the same string, and a
  // shared key would hand them one ref, asserting an identity that does not exist.
  return `${ns} ${value}`
}

/** Evict the oldest zero-count entries until below cap. Returns true if room exists. */
function makeRoom(): boolean {
  if (entries.size < CAP) return true

  let oldest: { key: string; seq: number } | null = null
  for (const [key, entry] of entries) {
    if (entry.count > 0) continue
    if (!oldest || entry.seq < oldest.seq) oldest = { key, seq: entry.seq }
  }
  if (!oldest) return false
  entries.delete(oldest.key)
  return true
}

/**
 * Get or assign the ref for `value` in `ns`.
 *
 * @returns the opaque ref, or `null` when the map is full and everything is still
 * referenced. The caller must then OMIT the crumb — growing without limit, or
 * reassigning a live ref, are both worse than losing one breadcrumb.
 */
export function localRef(ns: LocalNs, value: string): Opaque | null {
  const key = keyOf(ns, value)
  const existing = entries.get(key)
  if (existing) return existing.ref

  if (!makeRoom()) {
    overflow++
    return null
  }

  const seq = ++nextSeq
  const ref = makeDerivedOpaque(`s:${ns}${seq}`)
  entries.set(key, { ref, count: 0, seq })
  return ref
}

/** Pin a ref while a crumb or an in-flight request refers to it. */
export function retainRef(ns: LocalNs, value: string): void {
  const entry = entries.get(keyOf(ns, value))
  if (entry) entry.count++
}

/** Release one hold. At zero the entry becomes evictable under pressure. */
export function releaseRef(ns: LocalNs, value: string): void {
  const entry = entries.get(keyOf(ns, value))
  if (entry && entry.count > 0) entry.count--
}

/** Surfaced in the digest as `recorder/localref-overflow`. */
export function localRefOverflowCount(): number {
  return overflow
}

/** @internal Test-only. */
export function resetLocalRefsForTesting(): void {
  entries.clear()
  nextSeq = 0
  overflow = 0
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/localRef.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/anomaly/localRef.ts apps/fluux/src/anomaly/localRef.test.ts apps/fluux/src/anomaly/schema.ts
git commit -m "feat: add session-local opaque refs with ref-counted pins and a hard cap"
```

---

### Task 6: `Token` — namespaced HMAC identity for long-lived entities

**Files:**
- Create: `apps/fluux/src/anomaly/token.ts`
- Test: `apps/fluux/src/anomaly/token.test.ts`

**Interfaces:**
- Consumes: `makeDerivedOpaque`, `Opaque` from Task 4.
- Produces:
  - `type TokenNs = 'jid' | 'room' | 'device'`
  - `initTokenizer(): Promise<void>`
  - `tokenSync(ns: TokenNs, value: string): Opaque` — cache hit, or `UNRESOLVED` plus a scheduled warm
  - `warmToken(ns: TokenNs, value: string): Promise<void>`
  - `tokenKeyId(): string`
  - `tokenUnresolvedCount(): number`
  - `resetTokensForTesting(): void`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/token.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { isOpaque } from './schema'
import {
  initTokenizer,
  resetTokensForTesting,
  tokenKeyId,
  tokenSync,
  tokenUnresolvedCount,
  warmToken,
} from './token'

beforeEach(async () => {
  localStorage.clear()
  resetTokensForTesting()
  await initTokenizer()
})

describe('token', () => {
  it('produces a 64-bit opaque token after warming', async () => {
    await warmToken('jid', 'someone@example.com')
    const t = tokenSync('jid', 'someone@example.com')
    expect(isOpaque(t)).toBe(true)
    expect(t.s).toMatch(/^c:[0-9a-f]{16}$/)
  })

  it('returns the unresolved sentinel on a cold lookup, never the raw value', () => {
    const t = tokenSync('jid', 'cold@example.com')
    expect(t.s).toBe('c:unresolved')
    expect(t.s).not.toContain('cold')
    expect(tokenUnresolvedCount()).toBe(1)
  })

  it('namespaces the preimage so one string in two roles differs', async () => {
    await warmToken('jid', 'shared')
    await warmToken('room', 'shared')
    expect(tokenSync('jid', 'shared').s).not.toBe(tokenSync('room', 'shared').s)
  })

  it('is stable across calls', async () => {
    await warmToken('jid', 'stable@example.com')
    expect(tokenSync('jid', 'stable@example.com').s).toBe(
      tokenSync('jid', 'stable@example.com').s,
    )
  })

  it('never echoes its input', async () => {
    const body = 'the quick brown fox jumps over the lazy dog'
    await warmToken('jid', body)
    const out = tokenSync('jid', body).s
    for (let i = 0; i + 8 <= body.length; i++) {
      expect(out).not.toContain(body.slice(i, i + 8))
    }
  })

  it('exposes a non-secret key id that changes with the key', async () => {
    const first = tokenKeyId()
    expect(first).toMatch(/^[0-9a-f]{8}$/)

    localStorage.clear()
    resetTokensForTesting()
    await initTokenizer()
    expect(tokenKeyId()).not.toBe(first)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/token.test.ts
```

Expected: FAIL — `Failed to resolve import "./token"`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/anomaly/token.ts`:

```ts
/**
 * Cross-session opaque identity for LONG-LIVED entities (bare JIDs, rooms, devices).
 *
 * HMAC-SHA-256 under a per-install key, 64 bits of output. 64 bits rather than 24
 * because 24 collides at roughly 4 000 entities by the birthday bound, and a
 * collision silently merges two conversations' evidence.
 *
 * WebCrypto is async but detector paths are synchronous, so entities are warmed
 * ahead of use from lifecycle events and looked up synchronously. Ephemeral ids do
 * NOT use this path — see localRef.ts.
 */
import { makeDerivedOpaque, type Opaque } from './schema'

export type TokenNs = 'jid' | 'room' | 'device'

const KEY_STORAGE = 'fluux:anomaly-token-key'
const CACHE_LIMIT = 500

const UNRESOLVED = makeDerivedOpaque('c:unresolved')

const cache = new Map<string, Opaque>()
let hmacKey: CryptoKey | null = null
let keyId = 'unknown'
let unresolved = 0

function keyOf(ns: TokenNs, value: string): string {
  return `${ns} ${value}`
}

function toHex(buffer: ArrayBuffer, bytes: number): string {
  return Array.from(new Uint8Array(buffer).slice(0, bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function loadOrCreateKeyBytes(): Uint8Array {
  try {
    const stored = localStorage.getItem(KEY_STORAGE)
    if (stored) {
      const bytes = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0))
      if (bytes.length === 32) return bytes
    }
  } catch {
    // Fall through and mint a fresh key; a lost key only restarts token identity.
  }

  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  try {
    localStorage.setItem(KEY_STORAGE, btoa(String.fromCharCode(...bytes)))
  } catch {
    // Non-persistent key: tokens stay valid for this session only.
  }
  return bytes
}

/** Load or mint the per-install key. Must be awaited before `warmToken`. */
export async function initTokenizer(): Promise<void> {
  const bytes = loadOrCreateKeyBytes()
  hmacKey = await crypto.subtle.importKey(
    'raw',
    bytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  // A one-way digest of the key: discloses nothing, but changes when the key does,
  // which is what lets the review skill refuse to correlate across two key spaces.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  keyId = toHex(digest, 4)
}

/** Compute and cache the token for an entity, ahead of any breadcrumb using it. */
export async function warmToken(ns: TokenNs, value: string): Promise<void> {
  if (!hmacKey) return
  const key = keyOf(ns, value)
  if (cache.has(key)) return

  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(key) as unknown as BufferSource,
  )

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, makeDerivedOpaque(`c:${toHex(signature, 8)}`))
}

/**
 * Synchronous lookup for the record path.
 *
 * A miss returns the sentinel and schedules a warm — it never returns the raw
 * value. Two `c:unresolved` values are explicitly NOT an identity; the review skill
 * must not correlate them.
 */
export function tokenSync(ns: TokenNs, value: string): Opaque {
  const hit = cache.get(keyOf(ns, value))
  if (hit) return hit
  unresolved++
  void warmToken(ns, value)
  return UNRESOLVED
}

/** Non-secret; goes in every record envelope. */
export function tokenKeyId(): string {
  return keyId
}

/** Surfaced in the digest as `recorder/token-unresolved`. */
export function tokenUnresolvedCount(): number {
  return unresolved
}

/** @internal Test-only. */
export function resetTokensForTesting(): void {
  cache.clear()
  hmacKey = null
  keyId = 'unknown'
  unresolved = 0
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/token.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/token.ts apps/fluux/src/anomaly/token.test.ts
git commit -m "feat: add namespaced HMAC entity tokens with a non-secret key id"
```

---

### Task 7: The serializer — provenance rejection and line construction

**Files:**
- Create: `apps/fluux/src/anomaly/serializer.ts`
- Test: `apps/fluux/src/anomaly/serializer.test.ts`

**Interfaces:**
- Consumes: `isOpaque`, `Opaque`, `TAG` from Task 4.
- Produces:
  - `interface AnomalyRecord { v: 1; t: string; sid: string; build: string; tokenKeyId: string; kind: 'anomaly'; id: string; sev: 'bug' | 'suspect' | 'drift'; expected?: Opaque | number | boolean | null; observed?: Opaque | number | boolean | null; ctx: Record<string, Opaque | number | boolean>; crumbs: Array<Array<Opaque | number | boolean>> }`
  - `interface DigestRecord { v: 1; t: string; sid: string; build: string; tokenKeyId: string; kind: 'digest'; windowMs: number; counters: Record<string, number>; suppressed: Record<string, number> }`
  - `type Scalar = Opaque | number | boolean | null`
  - `serialize(record: AnomalyRecord | DigestRecord): string | null` — `null` means rejected
  - `rejectedValueCount(): number`
  - `resetSerializerCountersForTesting(): void`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/serializer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TAG } from './schema'
import { rejectedValueCount, resetSerializerCountersForTesting, serialize } from './serializer'
import type { AnomalyRecord } from './serializer'

function baseRecord(overrides: Partial<AnomalyRecord> = {}): AnomalyRecord {
  return {
    v: 1,
    t: '2026-07-29T11:47:02.000Z',
    sid: 'sid-1',
    build: '0.17.2+abc1234',
    tokenKeyId: '3b91cc07',
    kind: 'anomaly',
    id: 'test/example',
    sev: 'bug',
    ctx: {},
    crumbs: [],
    ...overrides,
  }
}

describe('serialize', () => {
  it('emits a single JSON line for a valid record', () => {
    const line = serialize(baseRecord({ ctx: { route: TAG.focus }, crumbs: [[TAG.msgIn, 3]] }))
    expect(line).not.toBeNull()
    expect(line).not.toContain('\n')
    expect(JSON.parse(line!).ctx.route).toBe('focus')
    expect(JSON.parse(line!).crumbs[0]).toEqual(['msg:in', 3])
  })

  it('carries tokenKeyId on an anomaly record, not only on digests', () => {
    expect(JSON.parse(serialize(baseRecord())!).tokenKeyId).toBe('3b91cc07')
  })

  // --- Provenance: the whole point. A shape check would pass all of these. ---

  it('rejects a primitive string in ctx even when it equals a tag', () => {
    resetSerializerCountersForTesting()
    expect(serialize(baseRecord({ ctx: { route: 'focus' } as never }))).toBeNull()
    expect(rejectedValueCount()).toBe(1)
  })

  it('rejects a primitive string shaped like a token', () => {
    expect(serialize(baseRecord({ ctx: { conv: 'c:0123456789abcdef' } as never }))).toBeNull()
  })

  it('rejects a primitive string shaped like a local ref', () => {
    expect(serialize(baseRecord({ ctx: { msg: 's:m41' } as never }))).toBeNull()
  })

  it('rejects the unresolved sentinel arriving as a primitive', () => {
    expect(serialize(baseRecord({ ctx: { conv: 'c:unresolved' } as never }))).toBeNull()
  })

  it('rejects a structural forgery', () => {
    expect(serialize(baseRecord({ ctx: { conv: { s: 'c:0123456789abcdef' } } as never }))).toBeNull()
  })

  it('rejects a primitive string in a crumb', () => {
    expect(serialize(baseRecord({ crumbs: [['msg:in' as never, 1]] }))).toBeNull()
  })

  it('rejects a primitive string in expected/observed', () => {
    expect(serialize(baseRecord({ expected: 'ahead' as never }))).toBeNull()
  })

  it('never emits a prefix of a rejected value', () => {
    const body = 'SECRET-BODY-CONTENT-THAT-MUST-NOT-LEAK'
    expect(serialize(baseRecord({ ctx: { conv: body } as never }))).toBeNull()
  })

  // --- Bounds ---

  it('accepts numbers and booleans without wrapping', () => {
    const line = serialize(baseRecord({ ctx: { count: 3, ok: true } }))
    expect(JSON.parse(line!).ctx).toEqual({ count: 3, ok: true })
  })

  it('caps crumbs at 50 per record', () => {
    const crumbs = Array.from({ length: 400 }, () => [TAG.msgIn, 123456789])
    const parsed = JSON.parse(serialize(baseRecord({ crumbs: crumbs as never }))!)
    expect(parsed.crumbs.length).toBe(50)
  })

  it('rejects a record that cannot be made to fit the line cap', () => {
    // The 8 KB cap is a backstop: crumbs are capped at 50 and opaque values are
    // short, so only a pathological ctx can reach it. Reaching it must reject, not
    // emit a partial record.
    const ctx: Record<string, unknown> = {}
    for (let i = 0; i < 600; i++) ctx[`k${i}`] = TAG.focus
    expect(serialize(baseRecord({ ctx: ctx as never }))).toBeNull()
  })

  // --- ctx keys are developer-chosen, but validated so they cannot carry data ---

  it('rejects a ctx key that is not a short identifier', () => {
    expect(
      serialize(baseRecord({ ctx: { 'a message body with spaces': TAG.focus } as never })),
    ).toBeNull()
  })

  it('accepts a conventional ctx key', () => {
    expect(serialize(baseRecord({ ctx: { conv: TAG.focus } }))).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/serializer.test.ts
```

Expected: FAIL — `Failed to resolve import "./serializer"`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/anomaly/serializer.ts`:

```ts
/**
 * Record serialization and the privacy gate.
 *
 * The rule is PROVENANCE, not shape: a primitive string is rejected wherever a
 * record can carry caller data, regardless of what it contains. A body equal to
 * `focus`, or matching the token format, is rejected exactly like any other body,
 * because it did not come from this module's constructors.
 *
 * Rejection is total — the record is dropped. It is never truncated to fit, because
 * a truncated body still discloses its prefix. A rejected record is a visible bug in
 * a detector; a truncated one is a silent leak.
 */
import { isOpaque, type Opaque } from './schema'

const MAX_LINE_BYTES = 8192
const MAX_ARRAY = 50
/** ctx keys must be short identifiers — see the loop in `serialize`. */
const CTX_KEY = /^[a-z][a-zA-Z0-9]{0,15}$/

export type Scalar = Opaque | number | boolean | null

export interface AnomalyRecord {
  v: 1
  t: string
  sid: string
  build: string
  tokenKeyId: string
  kind: 'anomaly'
  id: string
  sev: 'bug' | 'suspect' | 'drift'
  expected?: Scalar
  observed?: Scalar
  ctx: Record<string, Scalar>
  crumbs: Scalar[][]
  trunc?: boolean
}

export interface DigestRecord {
  v: 1
  t: string
  sid: string
  build: string
  tokenKeyId: string
  kind: 'digest'
  windowMs: number
  counters: Record<string, number>
  suppressed: Record<string, number>
}

let rejected = 0

/** Surfaced in the digest as `recorder/rejected-value`. */
export function rejectedValueCount(): number {
  return rejected
}

/** @internal Test-only. */
export function resetSerializerCountersForTesting(): void {
  rejected = 0
}

/** Convert one constrained value, or throw to reject the whole record. */
function unwrap(value: unknown): string | number | boolean | null {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value as number | boolean | null
  }
  if (isOpaque(value)) {
    const s = (value as Opaque).s
    // A newline would forge a second JSONL record. Constructors cannot produce one,
    // so this is a belt-and-braces check rather than the primary defence.
    if (s.includes('\n') || s.includes('\r')) throw new Error('newline in opaque value')
    return s
  }
  throw new Error('non-opaque value in a constrained field')
}

/**
 * Serialize a record to one JSONL line.
 *
 * @returns the line without its trailing newline, or `null` if the record was
 * rejected (a disallowed value, or unserializable).
 */
export function serialize(record: AnomalyRecord | DigestRecord): string | null {
  try {
    if (record.kind === 'digest') {
      return JSON.stringify(record)
    }

    const ctx: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(record.ctx)) {
      // Keys are developer-chosen, not caller data — but nothing structurally stops
      // a detector writing `{ [message.body]: ... }`, so constrain them to short
      // identifiers. A body with spaces, punctuation or length cannot pass.
      if (!CTX_KEY.test(key)) throw new Error('invalid ctx key')
      ctx[key] = unwrap(value)
    }

    const crumbs = record.crumbs
      .slice(0, MAX_ARRAY)
      .map((crumb) => crumb.slice(0, MAX_ARRAY).map(unwrap))

    const out: Record<string, unknown> = {
      v: record.v,
      t: record.t,
      sid: record.sid,
      build: record.build,
      tokenKeyId: record.tokenKeyId,
      kind: record.kind,
      id: record.id,
      sev: record.sev,
      ctx,
      crumbs,
    }
    if (record.expected !== undefined) out.expected = unwrap(record.expected)
    if (record.observed !== undefined) out.observed = unwrap(record.observed)

    let line = JSON.stringify(out)
    if (byteLength(line) <= MAX_LINE_BYTES) return line

    // Over cap: drop WHOLE crumbs, oldest first, then whole optional fields.
    // Strings are never shortened — see the module comment.
    out.trunc = true
    let kept = crumbs.length
    while (kept > 0) {
      kept = Math.floor(kept / 2)
      out.crumbs = crumbs.slice(crumbs.length - kept)
      line = JSON.stringify(out)
      if (byteLength(line) <= MAX_LINE_BYTES) return line
    }

    delete out.expected
    delete out.observed
    line = JSON.stringify(out)
    return byteLength(line) <= MAX_LINE_BYTES ? line : null
  } catch {
    rejected++
    return null
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/serializer.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/serializer.ts apps/fluux/src/anomaly/serializer.test.ts
git commit -m "feat: add the anomaly serializer with provenance-based value rejection"
```

---

### Task 8: The sinks — memory and single-flight Tauri append

**Files:**
- Create: `apps/fluux/src/anomaly/sinks/memory.ts`
- Create: `apps/fluux/src/anomaly/sinks/tauri.ts`
- Test: `apps/fluux/src/anomaly/sinks/tauri.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (sinks take pre-serialized lines).
- Produces:
  - `interface Sink { write(line: string): void; failureCount(): number; disabled(): boolean }`
  - `createMemorySink(): Sink` — also mirrors to `window.__fluuxAnomalies`
  - `createTauriSink(writeLine: (line: string) => Promise<void>): Sink`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/sinks/tauri.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createTauriSink } from './tauri'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createTauriSink', () => {
  it('writes lines in order', async () => {
    const seen: string[] = []
    const sink = createTauriSink(async (line) => {
      seen.push(line)
    })
    sink.write('a')
    sink.write('b')
    sink.write('c')
    await flush()
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('does not let one failed write poison the chain', async () => {
    const seen: string[] = []
    let calls = 0
    const sink = createTauriSink(async (line) => {
      calls++
      if (calls === 1) throw new Error('EIO')
      seen.push(line)
    })

    sink.write('first')
    sink.write('second')
    sink.write('third')
    await flush()

    expect(seen).toEqual(['second', 'third'])
    expect(sink.failureCount()).toBe(1)
  })

  it('mirrors failures to console.warn, since a broken sink cannot report itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sink = createTauriSink(async () => {
      throw new Error('EIO')
    })
    sink.write('x')
    await flush()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('disables itself after ten consecutive failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let attempts = 0
    const sink = createTauriSink(async () => {
      attempts++
      throw new Error('ENOSPC')
    })

    for (let i = 0; i < 20; i++) {
      sink.write(`line-${i}`)
      await flush()
    }

    expect(sink.disabled()).toBe(true)
    expect(attempts).toBe(10)
    vi.restoreAllMocks()
  })

  it('resets the consecutive-failure run on a success', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const sink = createTauriSink(async () => {
      calls++
      // Fail 9, succeed, then fail 9 more: never ten in a row.
      if (calls === 10) return
      throw new Error('EIO')
    })

    for (let i = 0; i < 19; i++) {
      sink.write(`line-${i}`)
      await flush()
    }

    expect(sink.disabled()).toBe(false)
    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/sinks/tauri.test.ts
```

Expected: FAIL — `Failed to resolve import "./tauri"`.

- [ ] **Step 3: Write the Tauri sink**

Create `apps/fluux/src/anomaly/sinks/tauri.ts`:

```ts
/**
 * JSONL sidecar sink.
 *
 * Writes go through a single-flight promise chain so appends cannot interleave.
 * Every link absorbs its OWN failure: `q = q.then(write)` would propagate one
 * rejection to every subsequent link, silently ending logging for the rest of the
 * session while the file still looked like a healthy quiet day.
 *
 * Failures are also mirrored to console.warn, because the digest that would report
 * a broken sink cannot be written by that same broken sink. This is the one place
 * the structured log and the prose log deliberately overlap.
 */
const MAX_CONSECUTIVE_FAILURES = 10

export interface Sink {
  write(line: string): void
  failureCount(): number
  disabled(): boolean
}

/**
 * @param writeLine - performs one durable append. Injected so the queue semantics
 * are testable without Tauri; production passes the plugin-fs writer.
 */
export function createTauriSink(writeLine: (line: string) => Promise<void>): Sink {
  let chain: Promise<void> = Promise.resolve()
  let failures = 0
  let consecutive = 0
  let off = false

  return {
    write(line: string): void {
      if (off) return
      chain = chain.then(async () => {
        if (off) return
        try {
          await writeLine(line)
          consecutive = 0
        } catch (err) {
          failures++
          consecutive++
          console.warn(
            `[AnomalySink] write failed (${consecutive} consecutive): ${String(err)}`,
          )
          if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
            off = true
            console.warn(
              '[AnomalySink] disabled for this session after ' +
                `${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
            )
          }
        }
      })
    },
    failureCount: () => failures,
    disabled: () => off,
  }
}
```

- [ ] **Step 4: Write the memory sink**

Create `apps/fluux/src/anomaly/sinks/memory.ts`:

```ts
/**
 * In-memory sink for demo mode, the web build and Playwright.
 *
 * Exposing the lines on `window.__fluuxAnomalies` is what lets the same detectors
 * later serve as CI oracles.
 */
import type { Sink } from './tauri'

const MAX_RETAINED = 1000

export function createMemorySink(): Sink {
  const lines: string[] = []
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__fluuxAnomalies = lines
  }

  return {
    write(line: string): void {
      lines.push(line)
      if (lines.length > MAX_RETAINED) lines.shift()
    },
    failureCount: () => 0,
    disabled: () => false,
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/fluux && npx vitest run src/anomaly/sinks/tauri.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/anomaly/sinks/
git commit -m "feat: add anomaly sinks with a non-poisoning single-flight write queue"
```

---

### Task 9: The recorder — ring, cooldown, ceiling, digest

**Files:**
- Create: `apps/fluux/src/anomaly/recorder.ts`
- Test: `apps/fluux/src/anomaly/recorder.test.ts`

**Interfaces:**
- Consumes: `Opaque`/`TAG` (Task 4), `localRefOverflowCount` (Task 5),
  `tokenKeyId`/`tokenUnresolvedCount` (Task 6), `serialize`/`rejectedValueCount` (Task 7),
  `Sink` (Task 8).
- Produces:
  - `createRecorder(opts: { sink: Sink; now: () => number; build: string; sid: string }): Recorder`
  - `interface Recorder { crumb(parts: Scalar[]): void; record(input: { id: string; sev: 'bug'|'suspect'|'drift'; expected?: Scalar; observed?: Scalar; ctx?: Record<string, Scalar> }): void; count(key: string, by?: number): void; flushDigest(windowMs: number): void }`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/recorder.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { createRecorder } from './recorder'
import { TAG } from './schema'
import type { Sink } from './sinks/tauri'

function fakeSink(): Sink & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    write: (line) => lines.push(line),
    failureCount: () => 0,
    disabled: () => false,
  }
}

let clock = 0
const now = () => clock
beforeEach(() => {
  clock = 0
})

function make(sink: Sink) {
  return createRecorder({ sink, now, build: '0.17.2+abc', sid: 'sid-1' })
}

describe('recorder', () => {
  it('writes an anomaly record with the last crumbs attached', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.crumb([TAG.msgIn, 1])
    rec.crumb([TAG.focus])
    rec.record({ id: 'test/one', sev: 'bug' })

    const parsed = JSON.parse(sink.lines[0])
    expect(parsed.id).toBe('test/one')
    expect(parsed.crumbs).toEqual([['msg:in', 1], ['focus']])
    expect(parsed.tokenKeyId).toBeDefined()
  })

  it('bounds the crumb ring at 100 entries', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 150; i++) rec.crumb([TAG.msgIn, i])
    rec.record({ id: 'test/ring', sev: 'bug' })

    const crumbs = JSON.parse(sink.lines[0]).crumbs
    expect(crumbs.length).toBe(50)
    // The 50 most recent, so the last one is i = 149.
    expect(crumbs[49]).toEqual(['msg:in', 149])
  })

  it('coalesces repeats of one id inside the cooldown', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: 'test/noisy', sev: 'bug' })
    clock = 30_000
    rec.record({ id: 'test/noisy', sev: 'bug' })
    clock = 59_999
    rec.record({ id: 'test/noisy', sev: 'bug' })

    expect(sink.lines.length).toBe(1)
  })

  it('reports suppressed counts in the digest so coalescing hides no frequency', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 48; i++) rec.record({ id: 'test/noisy', sev: 'bug' })
    rec.flushDigest(300_000)

    const digest = JSON.parse(sink.lines[sink.lines.length - 1])
    expect(digest.kind).toBe('digest')
    expect(digest.suppressed['test/noisy']).toBe(47)
  })

  it('writes again once the cooldown expires', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: 'test/noisy', sev: 'bug' })
    clock = 60_001
    rec.record({ id: 'test/noisy', sev: 'bug' })
    expect(sink.lines.length).toBe(2)
  })

  it('stops at the ceiling and says so instead of going quiet', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 600; i++) {
      clock += 60_001
      rec.record({ id: `test/id-${i % 3}`, sev: 'bug' })
    }

    const last = JSON.parse(sink.lines[sink.lines.length - 1])
    expect(last.id).toBe('recorder/ceiling-reached')
    expect(sink.lines.length).toBe(501)
  })

  it('carries recorder health counters in the digest', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.count('mam.queries', 3)
    rec.count('mam.queries')
    rec.flushDigest(300_000)

    const digest = JSON.parse(sink.lines[0])
    expect(digest.counters['mam.queries']).toBe(4)
    expect(digest.counters['recorder/rejected-value']).toBeDefined()
    expect(digest.counters['recorder/localref-overflow']).toBeDefined()
    expect(digest.counters['recorder/token-unresolved']).toBeDefined()
  })

  it('does not write a rejected record but still counts it', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: 'test/bad', sev: 'bug', ctx: { conv: 'raw-string' as never } })
    expect(sink.lines.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/recorder.test.ts
```

Expected: FAIL — `Failed to resolve import "./recorder"`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/anomaly/recorder.ts`:

```ts
/**
 * Breadcrumb ring, counters, and the two bounding mechanisms.
 *
 * The ring is bounded by construction; the RECORD STREAM is not, unless made so. A
 * repeatedly failing invariant would otherwise append without limit, each record
 * duplicating 50 crumbs. Hence a per-id cooldown (with the suppressed count
 * surfaced in the digest, so coalescing never hides frequency) and a session
 * ceiling that announces itself — a silent stop would read as a healthy day.
 */
import { localRefOverflowCount } from './localRef'
import type { Scalar } from './serializer'
import { rejectedValueCount, serialize } from './serializer'
import type { Sink } from './sinks/tauri'
import { tokenKeyId, tokenUnresolvedCount } from './token'

const RING_SIZE = 100
const CRUMBS_PER_RECORD = 50
const COOLDOWN_MS = 60_000
const MAX_RECORDS = 500
const MAX_BYTES = 2 * 1024 * 1024

export interface RecordInput {
  id: string
  sev: 'bug' | 'suspect' | 'drift'
  expected?: Scalar
  observed?: Scalar
  ctx?: Record<string, Scalar>
}

export interface Recorder {
  crumb(parts: Scalar[]): void
  record(input: RecordInput): void
  count(key: string, by?: number): void
  flushDigest(windowMs: number): void
}

export interface RecorderOptions {
  sink: Sink
  /** Injected for determinism in tests. */
  now: () => number
  build: string
  sid: string
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const { sink, now, build, sid } = opts

  const ring: Scalar[][] = []
  const counters = new Map<string, number>()
  const suppressed = new Map<string, number>()
  const lastEmittedAt = new Map<string, number>()

  let recordsWritten = 0
  let bytesWritten = 0
  let ceilingAnnounced = false

  function atCeiling(): boolean {
    return recordsWritten >= MAX_RECORDS || bytesWritten >= MAX_BYTES
  }

  function emit(line: string): void {
    sink.write(line)
    recordsWritten++
    bytesWritten += line.length
  }

  function announceCeiling(): void {
    if (ceilingAnnounced) return
    ceilingAnnounced = true
    const line = serialize({
      v: 1,
      t: new Date(now()).toISOString(),
      sid,
      build,
      tokenKeyId: tokenKeyId(),
      kind: 'anomaly',
      id: 'recorder/ceiling-reached',
      sev: 'drift',
      ctx: {},
      crumbs: [],
    })
    if (line) {
      sink.write(line)
      recordsWritten++
    }
  }

  return {
    crumb(parts: Scalar[]): void {
      ring.push(parts)
      if (ring.length > RING_SIZE) ring.shift()
    },

    record(input: RecordInput): void {
      if (atCeiling()) {
        announceCeiling()
        return
      }

      const last = lastEmittedAt.get(input.id)
      if (last !== undefined && now() - last < COOLDOWN_MS) {
        suppressed.set(input.id, (suppressed.get(input.id) ?? 0) + 1)
        return
      }

      const line = serialize({
        v: 1,
        t: new Date(now()).toISOString(),
        sid,
        build,
        tokenKeyId: tokenKeyId(),
        kind: 'anomaly',
        id: input.id,
        sev: input.sev,
        ...(input.expected !== undefined ? { expected: input.expected } : {}),
        ...(input.observed !== undefined ? { observed: input.observed } : {}),
        ctx: input.ctx ?? {},
        crumbs: ring.slice(-CRUMBS_PER_RECORD),
      })

      // A rejected record is a detector bug, surfaced via the digest counter rather
      // than by writing something unsafe.
      if (!line) return

      lastEmittedAt.set(input.id, now())
      emit(line)
    },

    count(key: string, by = 1): void {
      counters.set(key, (counters.get(key) ?? 0) + by)
    },

    flushDigest(windowMs: number): void {
      const all: Record<string, number> = Object.fromEntries(counters)
      all['recorder/rejected-value'] = rejectedValueCount()
      all['recorder/localref-overflow'] = localRefOverflowCount()
      all['recorder/token-unresolved'] = tokenUnresolvedCount()
      all['recorder/sink-write-failed'] = sink.failureCount()

      const line = serialize({
        v: 1,
        t: new Date(now()).toISOString(),
        sid,
        build,
        tokenKeyId: tokenKeyId(),
        kind: 'digest',
        windowMs,
        counters: all,
        suppressed: Object.fromEntries(suppressed),
      })
      if (line) emit(line)

      counters.clear()
      suppressed.clear()
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/recorder.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/recorder.ts apps/fluux/src/anomaly/recorder.test.ts
git commit -m "feat: add the anomaly recorder with cooldown, ceiling and digest"
```

---

### Task 10: `install()` and the `AnomalyInstaller` component

**Files:**
- Create: `apps/fluux/src/anomaly/install.ts`
- Create: `apps/fluux/src/anomaly/AnomalyInstaller.tsx`
- Modify: `apps/fluux/src/main.tsx:141-158`
- Test: `apps/fluux/src/anomaly/install.test.ts`

**Interfaces:**
- Consumes: `createRecorder` (Task 9), `createMemorySink`/`createTauriSink` (Task 8),
  `initTokenizer` (Task 6).
- Produces: `install(): () => void` — idempotent, returns full cleanup; `getRecorder(): Recorder | null`.

`main.tsx` cannot host this: at `apps/fluux/src/main.tsx:141` there is no `client` — `XMPPProvider`
constructs it internally. Stage 1 mounts the component but registers **no detectors**, so the
client is not needed yet; the component exists to establish the lifecycle contract that stage 3
depends on.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/install.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { getRecorder, install, installCount, resetInstallForTesting } from './install'

beforeEach(() => {
  localStorage.clear()
  resetInstallForTesting()
})

describe('install', () => {
  it('installs once and exposes a recorder', () => {
    const cleanup = install()
    expect(getRecorder()).not.toBeNull()
    cleanup()
  })

  it('survives the StrictMode install/cleanup/install cycle with one session id', () => {
    const cleanup1 = install()
    const sid1 = getRecorder()!.sessionId()
    cleanup1()
    const cleanup2 = install()
    const sid2 = getRecorder()!.sessionId()

    expect(sid2).toBe(sid1)
    cleanup2()
  })

  it('is idempotent — a second install without cleanup does not double-register', () => {
    const cleanup1 = install()
    const cleanup2 = install()
    // Read the module-level counter, NOT a method on the recorder: a recorder
    // method would be created by the first install and could only ever report its
    // own existence, making the assertion unfalsifiable.
    expect(installCount()).toBe(1)
    cleanup1()
    cleanup2()
  })

  it('control: two installs SEPARATED by cleanup do register twice', () => {
    // Proves the previous assertion can fail. Without this, `installCount() === 1`
    // would also pass against an implementation that never incremented at all.
    const cleanup1 = install()
    cleanup1()
    const cleanup2 = install()
    expect(installCount()).toBe(2)
    cleanup2()
  })

  it('clears the recorder after cleanup', () => {
    const cleanup = install()
    cleanup()
    expect(getRecorder()).toBeNull()
  })
})
```

- [ ] **Step 2: Extend the Recorder interface with the session id**

In `apps/fluux/src/anomaly/recorder.ts`, add to the `Recorder` interface:

```ts
  /** Stable for the process, so a StrictMode remount cannot fork the session. */
  sessionId(): string
```

and to the returned object in `createRecorder`, before the closing brace:

```ts
    sessionId: () => sid,
```

`installCount` deliberately does **not** live on the recorder: a method created by
`install()` could only ever report its own existence, so the idempotency assertion
would be unfalsifiable. It stays a module-level counter in `install.ts`.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/install.test.ts
```

Expected: FAIL — `Failed to resolve import "./install"`.

- [ ] **Step 4: Write the installer**

Create `apps/fluux/src/anomaly/install.ts`:

```ts
/**
 * Lifecycle for the anomaly system.
 *
 * The tree renders inside React.StrictMode, so effects run
 * install -> cleanup -> install on mount. Session identity therefore lives in a
 * MODULE-level singleton rather than effect scope: a remount that forked the
 * session id or reset the counters would make every count read at 2x, which is
 * indistinguishable from a real regression.
 *
 * Stage 1 registers NO detectors. This establishes the contract they will attach to.
 */
import { createRecorder, type Recorder } from './recorder'
import { createMemorySink } from './sinks/memory'
import { initTokenizer } from './token'

const DIGEST_INTERVAL_MS = 5 * 60 * 1000

// Module-level: survives the StrictMode remount by construction.
const sessionId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sid-${Date.now()}`

let recorder: Recorder | null = null
let installs = 0
let digestTimer: ReturnType<typeof setInterval> | null = null

export function getRecorder(): Recorder | null {
  return recorder
}

/**
 * Register the anomaly system. Idempotent: a second call while already installed
 * is a no-op that returns a cleanup for THIS caller only.
 *
 * @returns cleanup that fully unsubscribes every listener and timer.
 */
export function install(): () => void {
  if (recorder) return () => {}

  installs++
  void initTokenizer()

  // Stage 1 uses the memory sink everywhere. The Tauri sidecar sink is wired in
  // the stage that first produces records worth persisting.
  recorder = createRecorder({
    sink: createMemorySink(),
    now: () => Date.now(),
    build: `${__APP_VERSION__}+${__GIT_COMMIT__}`,
    sid: sessionId,
  })

  const active = recorder
  digestTimer = setInterval(() => active.flushDigest(DIGEST_INTERVAL_MS), DIGEST_INTERVAL_MS)

  const onHide = () => {
    // Best effort: the WebView gives no guarantee that async I/O completes during
    // teardown, so a missing trailing digest is normal and never a signal.
    if (document.visibilityState === 'hidden') active.flushDigest(DIGEST_INTERVAL_MS)
  }
  document.addEventListener('visibilitychange', onHide)

  return () => {
    document.removeEventListener('visibilitychange', onHide)
    if (digestTimer) clearInterval(digestTimer)
    digestTimer = null
    recorder = null
  }
}

/** @internal Test-only. */
export function resetInstallForTesting(): void {
  if (digestTimer) clearInterval(digestTimer)
  digestTimer = null
  recorder = null
  installs = 0
}

/** @internal Diagnostic for the StrictMode test. */
export function installCount(): number {
  return installs
}
```

- [ ] **Step 5: Write the component**

Create `apps/fluux/src/anomaly/AnomalyInstaller.tsx`:

```tsx
/**
 * Mounts inside XMPPProvider so later stages can read the client from context.
 * Renders nothing.
 */
import { useEffect } from 'react'
import { install } from './install'

export default function AnomalyInstaller(): null {
  useEffect(() => install(), [])
  return null
}
```

- [ ] **Step 6: Mount it in `main.tsx`**

In `apps/fluux/src/main.tsx`, add to the imports:

```ts
import { lazy, Suspense } from 'react'
```

and after the other imports:

```ts
// Lazy import inside a statically-false branch: Rollup does not merely skip the
// code, it never emits the chunk. See src/anomaly/gate.ts.
const AnomalyInstaller = __FLUUX_ANOMALY__
  ? lazy(() => import('./anomaly/AnomalyInstaller'))
  : null
```

Then inside `<XMPPProvider ...>`, immediately before `<ThemeProvider>`, add:

```tsx
        {AnomalyInstaller && (
          <Suspense fallback={null}>
            <AnomalyInstaller />
          </Suspense>
        )}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/fluux && npx vitest run src/anomaly/install.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 8: Verify the app boots in demo mode**

```bash
npm run build:sdk && npm run dev
```

Open `http://localhost:5173/demo.html`, then in the browser console:

```js
window.__fluuxAnomalies
```

Expected: an array (empty — stage 1 has no detectors). Its existence proves the installer mounted.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/anomaly/install.ts apps/fluux/src/anomaly/install.test.ts apps/fluux/src/anomaly/AnomalyInstaller.tsx apps/fluux/src/anomaly/recorder.ts apps/fluux/src/main.tsx
git commit -m "feat: mount the anomaly installer inside XMPPProvider"
```

---

### Task 11: The build-audit plugin and paired CI assertions

**Files:**
- Create: `apps/fluux/scripts/anomalyBuildAudit.ts`
- Modify: `apps/fluux/vite.config.ts` (plugins array)
- Create: `scripts/check-anomaly-elimination.mjs`
- Test: `apps/fluux/scripts/anomalyBuildAudit.test.ts`

**Interfaces:**
- Consumes: `resolveAnomalyGate`, `ANOMALY_BUILD_SENTINEL` (Task 1).
- Produces: `anomalyBuildAudit(enabled: boolean): Plugin` — throws during `generateBundle` when
  the expectation is violated in either direction.

Vite emits no bundler manifest here — the `manifest` at `apps/fluux/vite.config.ts:79` is the
**PWA web-app manifest** inside `VitePWA({...})`, unrelated to the module graph. The audit
therefore inspects `chunk.modules`, which is strictly stronger than matching chunk filenames: a
module inlined into an existing chunk has no distinguishing filename at all.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/scripts/anomalyBuildAudit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { auditBundle } from './anomalyBuildAudit'

const withAnomaly = {
  'assets/index-abc.js': { modules: { '/repo/apps/fluux/src/anomaly/recorder.ts': {} } },
  'assets/other-def.js': { modules: { '/repo/apps/fluux/src/App.tsx': {} } },
}
const withoutAnomaly = {
  'assets/other-def.js': { modules: { '/repo/apps/fluux/src/App.tsx': {} } },
}

describe('auditBundle', () => {
  it('passes a production bundle with no anomaly modules', () => {
    expect(() => auditBundle(withoutAnomaly as never, false)).not.toThrow()
  })

  it('fails a production bundle that still contains anomaly modules', () => {
    expect(() => auditBundle(withAnomaly as never, false)).toThrow(/anomaly/i)
  })

  it('fails a Dev bundle that is MISSING the anomaly modules', () => {
    // The direction that would silently regress to "eliminated everywhere,
    // including where it was supposed to run".
    expect(() => auditBundle(withoutAnomaly as never, true)).toThrow(/expected/i)
  })

  it('passes a Dev bundle containing the anomaly modules', () => {
    expect(() => auditBundle(withAnomaly as never, true)).not.toThrow()
  })

  it('names the offending modules so the failure is actionable', () => {
    expect(() => auditBundle(withAnomaly as never, false)).toThrow(/recorder\.ts/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run scripts/anomalyBuildAudit.test.ts
```

Expected: FAIL — `Failed to resolve import "./anomalyBuildAudit"`.

Note: `vitest.config.ts` includes only `src/**/*.test.ts`. Add `scripts/**/*.test.ts` to the
`include` array in `apps/fluux/vitest.config.ts`:

```ts
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
```

- [ ] **Step 3: Write the plugin**

Create `apps/fluux/scripts/anomalyBuildAudit.ts`:

```ts
/**
 * Build-time assertion that the anomaly tree is present exactly where it should be.
 *
 * Inspects each emitted chunk's `modules` collection rather than chunk filenames:
 * a module inlined into an existing chunk has no distinguishing filename, so a
 * filename check would pass while the code shipped.
 *
 * Asserts in BOTH directions. The negative direction protects production; the
 * positive direction protects against a silent regression to "eliminated
 * everywhere, including where it was supposed to run" — which is exactly what
 * happened with import.meta.env.DEV in the packaged Dev bundle.
 */
import type { Plugin } from 'vite'

const ANOMALY_PATH = /[\\/]src[\\/]anomaly[\\/]/

interface BundleLike {
  [fileName: string]: { modules?: Record<string, unknown> }
}

/** @internal Exported for testing. */
export function auditBundle(bundle: BundleLike, expectPresent: boolean): void {
  const found: string[] = []
  for (const chunk of Object.values(bundle)) {
    for (const moduleId of Object.keys(chunk.modules ?? {})) {
      if (ANOMALY_PATH.test(moduleId)) found.push(moduleId)
    }
  }

  if (!expectPresent && found.length > 0) {
    throw new Error(
      `[anomaly-build-audit] ${found.length} anomaly module(s) survived into a ` +
        `production bundle — dead-code elimination regressed:\n  ${found.join('\n  ')}\n` +
        'Check that every call site is guarded by `if (__FLUUX_ANOMALY__)` and that ' +
        'no module imports src/anomaly/ unconditionally.',
    )
  }

  if (expectPresent && found.length === 0) {
    throw new Error(
      '[anomaly-build-audit] expected the anomaly modules in this build, but none ' +
        'were emitted. The gate is off where it should be on — check FLUUX_ANOMALY ' +
        'reaches vite (see src/anomaly/gate.ts).',
    )
  }
}

export function anomalyBuildAudit(enabled: boolean): Plugin {
  return {
    name: 'anomaly-build-audit',
    apply: 'build',
    generateBundle(_options, bundle) {
      auditBundle(bundle as unknown as BundleLike, enabled)
    },
  }
}
```

- [ ] **Step 4: Register the plugin**

In `apps/fluux/vite.config.ts`, add the import:

```ts
import { anomalyBuildAudit } from './scripts/anomalyBuildAudit'
```

and append to the `plugins` array (after `VitePWA({...})`):

```ts
    anomalyBuildAudit(resolveAnomalyGate(mode, process.env)),
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/fluux && npx vitest run scripts/anomalyBuildAudit.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Write the CI sentinel check**

Create `scripts/check-anomaly-elimination.mjs`:

```js
#!/usr/bin/env node
/**
 * CI gate: a production build must contain no trace of the anomaly instrumentation.
 *
 * The build-audit vite plugin already asserts the module graph; this is the second,
 * independent check — a grep over the EMITTED assets for the gate sentinel. Two
 * mechanisms because they fail differently: the plugin catches a module that
 * survived, this catches a string that leaked into a chunk some other way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SENTINEL = 'fluux-anomaly-instrumentation-present'
const DIST = 'apps/fluux/dist'

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const offenders = walk(DIST).filter(
  (file) => /\.(js|css|html)$/.test(file) && readFileSync(file, 'utf-8').includes(SENTINEL),
)

if (offenders.length > 0) {
  console.error(
    `FAIL: the anomaly gate sentinel survived into a production build:\n  ${offenders.join('\n  ')}`,
  )
  process.exit(1)
}

console.log('OK: no anomaly instrumentation in the production bundle.')
```

- [ ] **Step 7: Verify both directions against real builds**

```bash
npm run build:app && node scripts/check-anomaly-elimination.mjs
```

Expected: build succeeds (the audit plugin runs with `expectPresent = false` and finds nothing),
and the script prints `OK:`.

```bash
FLUUX_ANOMALY=1 npm run build:app
```

Expected: build succeeds with the audit running in `expectPresent = true` mode and finding the
modules. If it throws `expected the anomaly modules in this build`, the gate is not reaching Vite.

- [ ] **Step 8: Add the check to package.json**

In the root `package.json` `scripts`, after `"build:app"`, add:

```json
    "check:anomaly": "npm run build:app && node scripts/check-anomaly-elimination.mjs",
```

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/scripts/anomalyBuildAudit.ts apps/fluux/scripts/anomalyBuildAudit.test.ts apps/fluux/vite.config.ts apps/fluux/vitest.config.ts scripts/check-anomaly-elimination.mjs package.json
git commit -m "test: assert the anomaly tree is eliminated in production and present in Dev"
```

---

### Task 12: The invariant registry skeleton

**Files:**
- Create: `docs/ANOMALY_INVARIANTS.md`

**Interfaces:**
- Consumes: the `id` convention from Task 9 (`family/name`).
- Produces: the file the review skill loads instead of the codebase.

- [ ] **Step 1: Write the registry**

Create `docs/ANOMALY_INVARIANTS.md`:

````markdown
# Anomaly invariant registry

Every `id` emitted into `anomalies.YYYY-MM-DD.jsonl` has an entry here. A review loads
**this file plus the log** — not the codebase. That is what makes a recurring review
affordable rather than a re-derivation of "normal" every time.

Design: `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md`.

## Reading a record

```jsonc
{ "v":1, "t":"...", "sid":"...", "build":"0.17.2+abc1234", "tokenKeyId":"3b91cc07",
  "kind":"anomaly", "id":"family/name", "sev":"bug",
  "expected":..., "observed":..., "ctx":{...}, "crumbs":[...] }
```

- `sev` — `bug` (an invariant broke), `suspect` (probably wrong, needs a look),
  `drift` (a rate moved; not a failure).
- `tokenKeyId` — **a hard correlation boundary.** Never join records across two
  different values: they are disjoint token spaces, so the same `c:` token in each
  refers to different entities.
- `c:unresolved` — **not an identity.** Never correlate two of them with each other.
- `s:` refs are session-local. Never correlate them across `sid` values.

## Recorder health

These describe the recorder itself, not the app.

| id / counter | Meaning | What to do |
|---|---|---|
| `recorder/ceiling-reached` | 500 records or 2 MB in one session; recording stopped | Something fired in a loop. Find the last repeated `id` before it |
| `recorder/rejected-value` | A detector passed a non-opaque value; the record was dropped | A detector bug. The value never reached disk, but the evidence is lost |
| `recorder/localref-overflow` | The 2 000-ref map was full and all refs pinned; a crumb was omitted | Usually a leak: something is retaining refs without releasing |
| `recorder/token-unresolved` | A token was requested before it was warmed | Rare is fine. Sustained means the pre-warm is missing a lifecycle event |
| `recorder/sink-write-failed` | A sidecar append failed | Check `fluux.log` — failures mirror there, because a broken sink cannot report itself |

## Detector families

No detectors ship in stage 1. Each entry below is added by the stage that
introduces it.

### `read-state/`

_(stage 3: `unread-survives-focus`; stage 5: `badge-vs-pointer`, `pointer-regression`)_

### `xmpp-traffic/`

_(stage 5: `mam-page-yield`, `redundant-query`, `iq-unanswered`)_

### `scroll/`

_(stage 2: existing sentinels; stage 3: `fab-at-live-edge`, `jump-target-miss`)_

### `resource/`

_(stage 4: rates with denominators; no pass/fail)_
````

- [ ] **Step 2: Verify the whole suite still passes**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all three pass with no new errors. Report any pre-existing warnings separately.

- [ ] **Step 3: Commit**

```bash
git add docs/ANOMALY_INVARIANTS.md
git commit -m "docs: add the anomaly invariant registry"
```

---

## Verification summary

| Gate | Command | Covers |
|---|---|---|
| Unit | `cd apps/fluux && npx vitest run src/anomaly scripts/anomalyBuildAudit.test.ts` | Tasks 4–11 |
| Scroll | `npm run test:scroll` | Task 3 (the migrated probes) |
| E2E build | `npm run build:e2e` | Task 2 |
| Elimination | `npm run check:anomaly` | Task 11, production direction |
| Dev presence | `FLUUX_ANOMALY=1 npm run build:app` | Task 11, Dev direction |
| Standard | `npm test && npm run typecheck && npm run lint` | Everything |

No Cargo work: stages 0–1 add no native code and no capability entry.
