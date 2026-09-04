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

**Tech Stack:** TypeScript, **Vite 8 (Rolldown)**, Vitest (happy-dom), React 19,
`@tauri-apps/plugin-fs` ^2.2.0, `@tauri-apps/plugin-os` ^2.3.2, WebCrypto (HMAC-SHA-256).

> Rolldown, not Rollup: the `generateBundle` hook and `chunk.modules` used by the build audit
> (Task 11) exist in both, but do not assume Rollup-only plugin APIs elsewhere.

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
| `apps/fluux/src/anomaly/values.ts` | Opaque values, closed registries, tokenizer, local refs |
| `apps/fluux/src/anomaly/identity.ts` | Domain helpers (bare-JID narrowing, message/query refs) |
| `apps/fluux/src/anomaly/serializer.ts` | Provenance validation and JSONL line construction |
| `apps/fluux/src/anomaly/recorder.ts` | Ring, counters, cooldown, ceiling, envelope, digest |
| `apps/fluux/src/anomaly/sinks/memory.ts` | `window.__fluuxAnomalies` sink |
| `apps/fluux/src/anomaly/sinks/tauri.ts` | Single-flight append sink |
| `apps/fluux/src/anomaly/install.ts` | Runtime singleton; attach/detach returning cleanup |
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

### Task 4: The value layer — one module, no escape hatches

**Files:**
- Create: `apps/fluux/src/anomaly/values.ts`
- Test: `apps/fluux/src/anomaly/values.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Opaque { readonly s: string }`, `isOpaque(v): v is Opaque`
  - `TAG`, `ID`, `CTX`, `COUNTER` — frozen registries of pre-built `Opaque` constants
  - `initTokenizer(): Promise<void>`, `warmToken(ns, value): Promise<void>`,
    `tokenSync(ns, value): Opaque`, `tokenKeyId(): string`, `tokenUnresolvedCount(): number`
  - `localRef(ns, value): Opaque | null`, `retainRef`/`releaseRef`, `retainOpaque`/`releaseOpaque`,
    `localRefOverflowCount(): number`
  - `resetValuesForTesting(): void`

**Why one module.** The privacy guarantee is exactly as strong as the narrowest exported entry
point. Splitting the WeakSet from the constructors that use it forces `schema.ts` to export a
minting function, and ES modules have no friend visibility — so any minter reachable by `token.ts`
is equally reachable by a detector. Two concrete leaks in the previous plan revision came from
precisely that: `mintToken(new TextEncoder().encode(body).buffer)` emitted the body's first eight
bytes as hex, and `mintLocalRef(body as any, 1)` re-emitted the body verbatim.

Collapsing the WeakSet, the registries, the HMAC tokenizer and the ref map into one file means
**no exported function turns caller data into an `Opaque`.** The derivation functions are module
private; only their safe wrappers are exported.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/values.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COUNTER,
  CTX,
  ID,
  initTokenizer,
  isKind,
  isOpaque,
  isRecordValue,
  isReservedCounter,
  METRIC,
  localRef,
  localRefOverflowCount,
  releaseRef,
  resetValuesForTesting,
  retainRef,
  TAG,
  tokenKeyId,
  tokenSync,
  tokenUnresolvedCount,
  warmToken,
} from './values'

beforeEach(async () => {
  localStorage.clear()
  resetValuesForTesting()
  await initTokenizer()
})

describe('registries', () => {
  it('recognises constants from every registry', () => {
    for (const value of [TAG.focus, ID.sessionStart, CTX.conv, COUNTER.rejectedValue]) {
      expect(isOpaque(value)).toBe(true)
    }
  })

  it('rejects primitives and forgeries that match a constant', () => {
    expect(isOpaque('focus')).toBe(false)
    expect(isOpaque({ s: 'focus' })).toBe(false)
    expect(isOpaque(Object.freeze({ s: 'recorder/session-start' }))).toBe(false)
  })

  it('freezes every registry', () => {
    for (const registry of [TAG, ID, CTX, COUNTER, METRIC]) {
      expect(Object.isFrozen(registry)).toBe(true)
    }
  })

  it('separates categories, so constants are not interchangeable', () => {
    expect(isKind(ID.sessionStart, 'id')).toBe(true)
    expect(isKind(TAG.focus, 'id')).toBe(false)
    expect(isKind(CTX.conv, 'ctx')).toBe(true)
    expect(isKind(CTX.conv, 'counter')).toBe(false)
    expect(isKind(COUNTER.rejectedValue, 'counter')).toBe(true)
    expect(isRecordValue(TAG.focus)).toBe(true)
    expect(isRecordValue(ID.sessionStart)).toBe(false)
    expect(isRecordValue(CTX.conv)).toBe(false)
  })
})

describe('ID registry and the invariant registry document agree', () => {
  it('has one docs entry per ID constant and vice versa', async () => {
    // Parity is NOT "by construction": ID and docs/ANOMALY_INVARIANTS.md are two
    // independent files. An earlier draft of this plan already shipped
    // ID.sessionStart with no matching row in the document. Only a test closes it.
    const fs = await import('node:fs/promises')
    const doc = await fs.readFile(
      new URL('../../../../docs/ANOMALY_INVARIANTS.md', import.meta.url),
      'utf-8',
    )
    const documented = new Set(doc.match(/`(recorder\/[a-z-]+|[a-z-]+\/[a-z-]+)`/g)?.map((m) => m.slice(1, -1)) ?? [])
    const declared = new Set(Object.values(ID).map((c) => c.s))

    for (const id of declared) expect(documented, `${id} is not in the registry doc`).toContain(id)
    for (const id of documented) expect(declared, `${id} has no ID constant`).toContain(id)
  })
})

describe('no export can turn caller data into an Opaque', () => {
  // The adversarial suite. Each case is a leak that existed in an earlier draft of
  // this design, so these are regression tests, not hypotheticals.
  const BODY = 'SECRET-BODY-abcdefghijklmnop'

  it('resists a targeted call of every dynamic constructor with a real body', async () => {
    // The generic sweep below cannot supply a VALID companion argument, so it never
    // actually reaches `tokenSync('jid', BODY)` or `localRef('m', BODY)` — the two
    // calls that matter most. Those are enumerated explicitly, and the async ones
    // are awaited so the assertion runs after the value exists.
    await warmToken('jid', BODY)
    await warmToken('room', BODY)
    await warmToken('device', BODY)

    const produced: string[] = [
      tokenSync('jid', BODY).s,
      tokenSync('room', BODY).s,
      tokenSync('device', BODY).s,
      localRef('m', BODY)!.s,
      localRef('q', BODY)!.s,
      localRef('x', BODY)!.s,
    ]

    const hex = Array.from(new TextEncoder().encode(BODY))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')

    for (const s of produced) {
      for (let i = 0; i + 6 <= BODY.length; i++) {
        expect(s.includes(BODY.slice(i, i + 6)), `leaked body: ${s}`).toBe(false)
      }
      expect(s.includes(hex.slice(0, 12)), `leaked hex body: ${s}`).toBe(false)
    }
  })

  it('resists a generic sweep of every export, awaiting any promise it returns', async () => {
    // Breadth to catch an export added later without a targeted case. Single-argument
    // calls only — a second argument cannot be guessed validly — and every returned
    // promise is awaited so a rejection is not mistaken for a pass.
    const mod = (await import('./values')) as Record<string, unknown>
    const encoded = new TextEncoder().encode(BODY)
    const candidates: unknown[] = [BODY, encoded, encoded.buffer, { s: BODY }, [BODY]]

    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue
      if (name === 'initTokenizer') continue // stateful; exercised in its own suite
      for (const arg of candidates) {
        let out: unknown
        try {
          out = (fn as (a: unknown) => unknown)(arg)
          if (out instanceof Promise) out = await out
        } catch {
          continue // Rejecting is the correct behaviour.
        }
        if (!isOpaque(out)) continue
        const s = (out as { s: string }).s
        for (let i = 0; i + 6 <= BODY.length; i++) {
          expect(s.includes(BODY.slice(i, i + 6)), `${name}() leaked body: ${s}`).toBe(false)
        }
      }
    }
  })

  it('rejects an invalid local-ref namespace instead of echoing it', () => {
    // `localRef(body, x)` must not produce `s:<body>1`.
    expect(() => localRef(BODY as never, 'x')).toThrow()
  })
})

describe('tokens', () => {
  it('produces a 64-bit opaque token after warming', async () => {
    await warmToken('jid', 'someone@example.com')
    expect(tokenSync('jid', 'someone@example.com').s).toMatch(/^c:[0-9a-f]{16}$/)
  })

  it('returns the sentinel on a cold lookup, never the raw value', () => {
    const t = tokenSync('jid', 'cold@example.com')
    expect(t.s).toBe('c:unresolved')
    expect(tokenUnresolvedCount()).toBe(1)
  })

  it('namespaces the preimage so one string in two roles differs', async () => {
    await warmToken('jid', 'shared')
    await warmToken('room', 'shared')
    expect(tokenSync('jid', 'shared').s).not.toBe(tokenSync('room', 'shared').s)
  })

  it('exposes a non-secret key id that changes with the key', async () => {
    const first = tokenKeyId()
    expect(first).toMatch(/^[0-9a-f]{8}$/)
    localStorage.clear()
    resetValuesForTesting()
    await initTokenizer()
    expect(tokenKeyId()).not.toBe(first)
  })
})

describe('local refs', () => {
  it('is stable per namespace and value, and namespaces the key', () => {
    expect(localRef('m', 'abc')).toBe(localRef('m', 'abc'))
    expect(localRef('m', 'shared')!.s).not.toBe(localRef('q', 'shared')!.s)
    expect(localRef('m', 'first')!.s).toMatch(/^s:m[0-9]+$/)
  })

  it('only becomes evictable after every holder releases', () => {
    localRef('q', 'live')
    retainRef('q', 'live')
    retainRef('q', 'live')
    const original = localRef('q', 'live')!.s
    releaseRef('q', 'live')
    for (let i = 0; i < 2100; i++) localRef('m', `filler-${i}`)
    expect(localRef('q', 'live')!.s).toBe(original)
  })

  it('refuses new allocations rather than growing when everything is pinned', () => {
    for (let i = 0; i < 2000; i++) {
      localRef('m', `pinned-${i}`)
      retainRef('m', `pinned-${i}`)
    }
    expect(localRef('m', 'one-too-many')).toBeNull()
    expect(localRefOverflowCount()).toBe(1)
    expect(localRef('m', 'pinned-0')!.s).toBe('s:m1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/values.test.ts
```

Expected: FAIL — `Failed to resolve import "./values"`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/anomaly/values.ts`:

```ts
/**
 * The value layer: everything that may legally appear inside a record.
 *
 * Privacy is enforced by PROVENANCE. A value is admissible because THIS MODULE
 * built it, not because it looks like something this module builds — a shape check
 * would accept a message body equal to `focus`, or one matching the token format.
 *
 * Everything lives in one file because ES modules have no friend visibility: any
 * minting function exported for a sibling module is equally callable by a detector.
 * The derivation helpers below are therefore module private, and only safe wrappers
 * are exported. There is NO exported path from caller data to an `Opaque`.
 */

// ---------------------------------------------------------------------------
// Opaque values
// ---------------------------------------------------------------------------

/**
 * Provenance carries a CATEGORY, not just membership.
 *
 * A single WeakSet would make every constant interchangeable: `TAG.focus` could be
 * used as an invariant id, a token as a ctx key, a LocalRef as a counter name. That
 * leaks nothing, but it dissolves the registries' meaning and the parity between
 * `ID` and docs/ANOMALY_INVARIANTS.md — so the serializer must be able to ask
 * "is this an id?", not merely "did we make this?".
 */
export type Kind = 'tag' | 'id' | 'ctx' | 'counter' | 'token' | 'ref'

const KIND = new WeakMap<object, Kind>()

export interface Opaque {
  readonly s: string
}

/** Module private. Never exported, directly or via a wrapper taking free text. */
function mint(s: string, kind: Kind): Opaque {
  const value = Object.freeze({ s })
  KIND.set(value, kind)
  return value
}

/** True only for a value this module constructed. Not structural. */
export function isOpaque(v: unknown): v is Opaque {
  return typeof v === 'object' && v !== null && KIND.has(v as object)
}

/** True only for a value this module constructed WITH one of `kinds`. */
export function isKind(v: unknown, ...kinds: Kind[]): v is Opaque {
  if (typeof v !== 'object' || v === null) return false
  const kind = KIND.get(v as object)
  return kind !== undefined && kinds.includes(kind)
}

/** Private: an exported array is mutable whatever its declared type. */
const VALUE_KINDS: readonly Kind[] = Object.freeze(['tag', 'token', 'ref'] as const)

/** True for a value admissible in a record VALUE position. */
export function isRecordValue(v: unknown): v is Opaque {
  return isKind(v, ...VALUE_KINDS)
}

// ---------------------------------------------------------------------------
// Closed registries
//
// ids, ctx keys and counter names are ALSO opaque constants, not validated
// strings. A regex such as /^[a-z][a-zA-Z0-9]{0,15}$/ accepts a short body like
// "hello", so form validation cannot close these positions; a closed set can.
// Adding an entry here is the deliberate act of adding a loggable name, and it
// keeps `docs/ANOMALY_INVARIANTS.md` in parity with the code by construction.
// ---------------------------------------------------------------------------

/** Breadcrumb and field tags. */
export const TAG = Object.freeze({
  focus: mint('focus', 'tag'),
  blur: mint('blur', 'tag'),
  msgIn: mint('msg:in', 'tag'),
  msgOut: mint('msg:out', 'tag'),
  ptrAdvance: mint('ptr:advance', 'tag'),
  activate: mint('activate', 'tag'),
  deactivate: mint('deactivate', 'tag'),
  scrollWrite: mint('scroll:write', 'tag'),
  mamQuery: mint('mam:query', 'tag'),
  mamResult: mint('mam:result', 'tag'),
  ahead: mint('ahead', 'tag'),
  behind: mint('behind', 'tag'),
})

/** Invariant ids. One entry per registry entry in docs/ANOMALY_INVARIANTS.md. */
export const ID = Object.freeze({
  sessionStart: mint('recorder/session-start', 'id'),
  ceilingReached: mint('recorder/ceiling-reached', 'id'),
})

/** Permitted `ctx` keys. */
export const CTX = Object.freeze({
  conv: mint('conv', 'ctx'),
  room: mint('room', 'ctx'),
  route: mint('route', 'ctx'),
  msg: mint('msg', 'ctx'),
  query: mint('query', 'ctx'),
})

/**
 * Counter names reserved for the recorder's own health. `count()` REFUSES these:
 * the digest adds them itself, and an application counter sharing a key would be
 * silently overwritten by the health delta when the pairs are folded into an object.
 */
export const COUNTER = Object.freeze({
  rejectedValue: mint('recorder/rejected-value', 'counter'),
  localRefOverflow: mint('recorder/localref-overflow', 'counter'),
  tokenUnresolved: mint('recorder/token-unresolved', 'counter'),
  sinkWriteFailed: mint('recorder/sink-write-failed', 'counter'),
})

/** Counter names available to application code and detectors. */
export const METRIC = Object.freeze({
  mamQueries: mint('mam.queries', 'counter'),
  mamRowsRetained: mint('mam.rowsRetained', 'counter'),
  roomJoins: mint('room.joins', 'counter'),
  scrollWrites: mint('scroll.writes', 'counter'),
  probe: mint('probe.metric', 'counter'),
})

/** The reserved set, kept PRIVATE — a `ReadonlySet` type erases at runtime, so an
 * exported Set can be cleared and the reservation silently stops applying. */
const RESERVED_COUNTERS: ReadonlySet<string> = new Set(Object.values(COUNTER).map((c) => c.s))

/** True for a counter name reserved for recorder health. */
export function isReservedCounter(name: string): boolean {
  return RESERVED_COUNTERS.has(name)
}

// ---------------------------------------------------------------------------
// Entity tokens — cross-session identity for JIDs, rooms, devices
// ---------------------------------------------------------------------------

export type TokenNs = 'jid' | 'room' | 'device'
const TOKEN_NS: ReadonlySet<string> = new Set(['jid', 'room', 'device'])

const KEY_STORAGE = 'fluux:anomaly-token-key'
const TOKEN_CACHE_LIMIT = 500
const UNRESOLVED = mint('c:unresolved', 'token')

const tokens = new Map<string, Opaque>()
let hmacKey: CryptoKey | null = null
let keyId = 'unknown'
let unresolved = 0

function nsKey(ns: string, value: string): string {
  return `${ns}\u0000${value}` // NUL separator: cannot occur in a JID or stanza id
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
    // Fall through: a lost key only restarts token identity, which tokenKeyId marks.
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

/** Load or mint the per-install key. Await before the first record. */
export async function initTokenizer(): Promise<void> {
  const bytes = loadOrCreateKeyBytes()
  hmacKey = await crypto.subtle.importKey(
    'raw',
    bytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  keyId = toHex(digest, 4)
}

/**
 * Compute and cache an entity token ahead of any breadcrumb using it.
 *
 * Safe despite taking caller text: the output is an HMAC digest under a key the
 * caller does not hold, so it cannot echo the input. This is the ONLY reason a
 * dynamic constructor is acceptable here — contrast the registries above.
 */
export async function warmToken(ns: TokenNs, value: string): Promise<void> {
  if (!hmacKey || !TOKEN_NS.has(ns) || typeof value !== 'string') return
  const key = nsKey(ns, value)
  if (tokens.has(key)) return

  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(key) as unknown as BufferSource,
  )
  if (tokens.size >= TOKEN_CACHE_LIMIT) {
    const oldest = tokens.keys().next()
    if (!oldest.done) tokens.delete(oldest.value)
  }
  tokens.set(key, mint(`c:${toHex(signature, 8)}`, 'token'))
}

/** Synchronous lookup. A miss returns the sentinel — never the raw value. */
export function tokenSync(ns: TokenNs, value: string): Opaque {
  if (!TOKEN_NS.has(ns)) throw new TypeError('unknown token namespace')
  const hit = tokens.get(nsKey(ns, value))
  if (hit) return hit
  unresolved++
  void warmToken(ns, value)
  return UNRESOLVED
}

/** Non-secret; goes in every record envelope. */
export function tokenKeyId(): string {
  return keyId
}

export function tokenUnresolvedCount(): number {
  return unresolved
}

// ---------------------------------------------------------------------------
// Local refs — session-local identity for ephemeral ids
// ---------------------------------------------------------------------------

/** m = message, q = MAM query, x = stanza. */
export type LocalNs = 'm' | 'q' | 'x'
const LOCAL_NS: ReadonlySet<string> = new Set(['m', 'q', 'x'])

const REF_CAP = 2000

interface RefEntry {
  ref: Opaque
  /** Ref-counted: one ref can be held by several crumbs AND an open request. */
  count: number
  seq: number
}

const refs = new Map<string, RefEntry>()
const keyByRef = new WeakMap<Opaque, string>()
let nextSeq = 0
let overflow = 0

function makeRoom(): boolean {
  if (refs.size < REF_CAP) return true
  let oldest: { key: string; seq: number } | null = null
  for (const [key, entry] of refs) {
    if (entry.count > 0) continue
    if (!oldest || entry.seq < oldest.seq) oldest = { key, seq: entry.seq }
  }
  if (!oldest) return false
  refs.delete(oldest.key)
  return true
}

/**
 * Get or assign the ref for `value` in `ns`.
 *
 * The namespace is validated at RUNTIME, not merely by its type: `localRef(body,
 * 'x')` with a cast would otherwise render as `s:<body>1` and re-emit the body.
 *
 * @returns the ref, or `null` when the map is full and everything is pinned. The
 * caller must then omit the crumb — growing without limit, or reassigning a live
 * ref, are both worse than losing one breadcrumb.
 */
export function localRef(ns: LocalNs, value: string): Opaque | null {
  if (!LOCAL_NS.has(ns)) throw new TypeError('unknown local-ref namespace')
  const key = nsKey(ns, value)
  const existing = refs.get(key)
  if (existing) return existing.ref

  if (!makeRoom()) {
    overflow++
    return null
  }
  const seq = ++nextSeq
  const ref = mint(`s:${ns}${seq}`, 'ref')
  refs.set(key, { ref, count: 0, seq })
  keyByRef.set(ref, key)
  return ref
}

export function retainRef(ns: LocalNs, value: string): void {
  const entry = refs.get(nsKey(ns, value))
  if (entry) entry.count++
}

export function releaseRef(ns: LocalNs, value: string): void {
  const entry = refs.get(nsKey(ns, value))
  if (entry && entry.count > 0) entry.count--
}

function holdFor(value: unknown): RefEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const key = keyByRef.get(value as Opaque)
  return key ? refs.get(key) : undefined
}

/** Pin by value, for holders that only have the `Opaque` — the breadcrumb ring. */
export function retainOpaque(value: unknown): void {
  const entry = holdFor(value)
  if (entry) entry.count++
}

export function releaseOpaque(value: unknown): void {
  const entry = holdFor(value)
  if (entry && entry.count > 0) entry.count--
}

export function localRefOverflowCount(): number {
  return overflow
}

/** @internal Test-only. */
export function resetValuesForTesting(): void {
  tokens.clear()
  refs.clear()
  hmacKey = null
  keyId = 'unknown'
  unresolved = 0
  nextSeq = 0
  overflow = 0
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/values.test.ts
```

Expected: PASS, 20 tests. Two of them carry the weight: the **targeted** case calls every dynamic
constructor with a real body and a valid companion argument (`tokenSync('jid', BODY)`,
`localRef('m', BODY)`, each `warmToken` awaited), and the **generic sweep** covers any export added
later, awaiting anything that returns a promise. A parity test compares the `ID` registry against
`docs/ANOMALY_INVARIANTS.md` in both directions — an earlier draft shipped `ID.sessionStart` with
no matching row, which is exactly the drift a "by construction" claim cannot prevent.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/values.ts apps/fluux/src/anomaly/values.test.ts
git commit -m "feat: add the anomaly value layer with closed registries and no minting escape hatch"
```

---

### Task 5: Wire the value layer's namespaces into the app's domain

**Files:**
- Create: `apps/fluux/src/anomaly/identity.ts`
- Test: `apps/fluux/src/anomaly/identity.test.ts`

**Interfaces:**
- Consumes: `tokenSync`, `warmToken`, `localRef`, `CTX` from Task 4.
- Produces:
  - `convToken(bareJid: string): Opaque`
  - `messageRef(id: string): Opaque | null`
  - `queryRef(id: string): Opaque | null`
  - `warmConversation(bareJid: string): Promise<void>`

A thin domain layer so detectors never call `tokenSync('jid', …)` with a hand-written namespace —
one place to get the namespace right, and the place where a full JID is narrowed to a bare one
before it reaches the value layer.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/identity.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { initTokenizer, isOpaque, resetValuesForTesting } from './values'
import { convToken, messageRef, queryRef, warmConversation } from './identity'

beforeEach(async () => {
  localStorage.clear()
  resetValuesForTesting()
  await initTokenizer()
})

describe('identity helpers', () => {
  it('strips the resource before tokenising, so one contact is one token', async () => {
    await warmConversation('someone@example.com/phone')
    await warmConversation('someone@example.com/desktop')
    expect(convToken('someone@example.com/phone').s).toBe(
      convToken('someone@example.com/desktop').s,
    )
  })

  it('never emits the local part or the domain', async () => {
    await warmConversation('alice@example.com')
    const s = convToken('alice@example.com').s
    expect(s).not.toContain('alice')
    expect(s).not.toContain('example')
    expect(s).toMatch(/^c:[0-9a-f]{16}$/)
  })

  it('gives messages and queries distinct ref spaces', () => {
    expect(isOpaque(messageRef('shared-id')!)).toBe(true)
    expect(messageRef('shared-id')!.s).not.toBe(queryRef('shared-id')!.s)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/identity.test.ts
```

Expected: FAIL — `Failed to resolve import "./identity"`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/anomaly/identity.ts`:

```ts
/**
 * Domain helpers over the value layer.
 *
 * Detectors call these rather than `tokenSync('jid', …)`, so the namespace is
 * chosen in one place and a full JID is narrowed to a bare one before it reaches
 * the tokenizer — otherwise the same contact on two devices would produce two
 * tokens and read as two entities.
 */
import { localRef, tokenSync, warmToken, type Opaque } from './values'

function bare(jid: string): string {
  const slash = jid.indexOf('/')
  return slash === -1 ? jid : jid.slice(0, slash)
}

/** Stable cross-session identity for a 1:1 conversation. */
export function convToken(jid: string): Opaque {
  return tokenSync('jid', bare(jid))
}

/** Warm a conversation's token ahead of any breadcrumb that will reference it. */
export function warmConversation(jid: string): Promise<void> {
  return warmToken('jid', bare(jid))
}

/** Session-local identity for a message. `null` under ref pressure. */
export function messageRef(id: string): Opaque | null {
  return localRef('m', id)
}

/** Session-local identity for a MAM query. `null` under ref pressure. */
export function queryRef(id: string): Opaque | null {
  return localRef('q', id)
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/identity.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/identity.ts apps/fluux/src/anomaly/identity.test.ts
git commit -m "feat: add domain identity helpers over the anomaly value layer"
```

---

### Task 6: Expose the build sentinel in the runtime

**Files:**
- Modify: `apps/fluux/src/anomaly/gate.ts`
- Test: `apps/fluux/src/anomaly/gate.test.ts`

**Interfaces:**
- Consumes: `ANOMALY_BUILD_SENTINEL` from Task 1.
- Produces: the sentinel string is reachable from app code, therefore present in the emitted
  Dev bundle and absent from the production one.

`gate.ts` exports the sentinel, but the only importer is `vite.config.ts`, which runs in **Node at
build time** — that import puts nothing in the browser bundle. So the Dev-side CI assertion in
Task 11 would look for a string that was never going to be there, and the production-side check
would pass vacuously. The sentinel has to be referenced by code that actually ships.

- [ ] **Step 1: Add the failing assertion**

Append to `apps/fluux/src/anomaly/gate.test.ts`:

```ts
import { ANOMALY_BUILD_SENTINEL, markAnomalyBuild } from './gate'

describe('build sentinel', () => {
  it('is published on window so it lands in the emitted bundle', () => {
    markAnomalyBuild()
    expect(
      (window as unknown as Record<string, unknown>).__fluuxAnomalyBuild,
    ).toBe(ANOMALY_BUILD_SENTINEL)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/fluux && npx vitest run src/anomaly/gate.test.ts
```

Expected: FAIL — `markAnomalyBuild is not a function`.

- [ ] **Step 3: Add the runtime marker**

Append to `apps/fluux/src/anomaly/gate.ts`:

```ts
/**
 * Publish the sentinel at runtime.
 *
 * Called from the gated install path, so the string is reachable from app code and
 * therefore emitted into a Dev bundle and eliminated from a production one. Without
 * this the sentinel lives only in `vite.config.ts`, which runs in Node at build
 * time — the production check would pass vacuously and the Dev check could never
 * pass at all.
 */
export function markAnomalyBuild(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>).__fluuxAnomalyBuild = ANOMALY_BUILD_SENTINEL
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/gate.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/gate.ts apps/fluux/src/anomaly/gate.test.ts
git commit -m "feat: publish the anomaly build sentinel at runtime so CI can observe it"
```

---

### Task 7: The serializer — provenance rejection and line construction

**Files:**
- Create: `apps/fluux/src/anomaly/serializer.ts`
- Test: `apps/fluux/src/anomaly/serializer.test.ts`

**Interfaces:**
- Consumes: `isOpaque`, `Opaque`, `TAG`, `ID`, `CTX`, `COUNTER` from Task 4.
- Produces:
  - `type Scalar = Opaque | number | boolean | null`
  - `interface AnomalyRecord` — envelope (`v`, `t`, `sid`, `build`, `tokenKeyId`) plus
    `kind: 'anomaly'`, `id: Opaque`, `sev`, optional `expected`/`observed: Scalar`,
    `ctx: Array<[Opaque, Scalar]>`, `crumbs: Scalar[][]`, optional `trunc: boolean`
  - `interface DigestRecord` — the same envelope plus `kind: 'digest'`, `windowMs: number`,
    `counters: Array<[Opaque, number]>`, `suppressed: Array<[Opaque, number]>`

  **Keys are opaque too.** `id`, every `ctx` key and every counter name is a registry constant, not
  a validated string — a regex such as `/^[a-z][a-zA-Z0-9]{0,15}$/` accepts a short body like
  `"hello"`, so form validation cannot close those positions.
  - `serialize(record: AnomalyRecord | DigestRecord): string | null` — `null` means rejected
  - `rejectedValueCount(): number`
  - `resetSerializerCountersForTesting(): void`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/serializer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CTX, ID, TAG } from './values'
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
    id: ID.sessionStart,
    sev: 'bug',
    ctx: [],
    crumbs: [],
    ...overrides,
  }
}

describe('serialize', () => {
  it('emits a single JSON line for a valid record', () => {
    const line = serialize(baseRecord({ ctx: [[CTX.route, TAG.focus]], crumbs: [[TAG.msgIn, 3]] }))
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
    expect(serialize(baseRecord({ ctx: [['focus' as never, TAG.focus]] }))).toBeNull()
    expect(rejectedValueCount()).toBe(1)
  })

  it('rejects a primitive string shaped like a token', () => {
    expect(serialize(baseRecord({ ctx: [[CTX.conv, 'c:0123456789abcdef' as never]] }))).toBeNull()
  })

  it('rejects a primitive string shaped like a local ref', () => {
    expect(serialize(baseRecord({ ctx: [[CTX.msg, 's:m41' as never]] }))).toBeNull()
  })

  it('rejects the unresolved sentinel arriving as a primitive', () => {
    expect(serialize(baseRecord({ ctx: [[CTX.conv, 'c:unresolved' as never]] }))).toBeNull()
  })

  it('rejects a structural forgery', () => {
    expect(serialize(baseRecord({ ctx: [[CTX.conv, { s: 'c:0123456789abcdef' } as never]] }))).toBeNull()
  })

  it('rejects a primitive string in a crumb', () => {
    expect(serialize(baseRecord({ crumbs: [['msg:in' as never, 1]] }))).toBeNull()
  })

  it('rejects a primitive string in expected/observed', () => {
    expect(serialize(baseRecord({ expected: 'ahead' as never }))).toBeNull()
  })

  it('never emits a prefix of a rejected value', () => {
    const body = 'SECRET-BODY-CONTENT-THAT-MUST-NOT-LEAK'
    expect(serialize(baseRecord({ ctx: [[CTX.conv, body as never]] }))).toBeNull()
  })

  // --- Bounds ---

  it('accepts numbers and booleans without wrapping', () => {
    const line = serialize(baseRecord({ ctx: [[CTX.msg, 3], [CTX.query, true]] }))
    expect(JSON.parse(line!).ctx).toEqual({ msg: 3, query: true })
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
    const ctx: Array<[unknown, unknown]> = []
    for (let i = 0; i < 600; i++) ctx.push([CTX.conv, TAG.focus])
    expect(serialize(baseRecord({ ctx: ctx as never }))).toBeNull()
  })

  // --- ctx keys are developer-chosen, but validated so they cannot carry data ---

  it('rejects a ctx key that is not a short identifier', () => {
    expect(
      serialize(baseRecord({ ctx: [['a message body with spaces' as never, TAG.focus]] })),
    ).toBeNull()
  })

  it('accepts a conventional ctx key', () => {
    expect(serialize(baseRecord({ ctx: [[CTX.conv, TAG.focus]] }))).not.toBeNull()
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
import { isKind, isOpaque, isRecordValue, type Kind, type Opaque } from './values'

const MAX_LINE_BYTES = 8192
const MAX_ARRAY = 50

export type Scalar = Opaque | number | boolean | null

export interface AnomalyRecord {
  v: 1
  t: string
  sid: string
  build: string
  tokenKeyId: string
  kind: 'anomaly'
  /** An ID registry constant, never a free string — see values.ts. */
  id: Opaque
  sev: 'bug' | 'suspect' | 'drift'
  expected?: Scalar
  observed?: Scalar
  /** [CTX constant, value] pairs. Keys are opaque too. */
  ctx: Array<[Opaque, Scalar]>
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
  /** [COUNTER or ID constant, value] pairs. */
  counters: Array<[Opaque, number]>
  suppressed: Array<[Opaque, number]>
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

/**
 * Convert one constrained value, or throw to reject the whole record.
 *
 * `kinds` is the set of categories admissible IN THIS POSITION. Passing an `id`
 * where a ctx key belongs, or a tag where an id belongs, is rejected — membership
 * alone would make every constant interchangeable and dissolve the registries.
 */
type Position = 'value' | Kind

function unwrap(value: unknown, position: Position): string | number | boolean | null {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    if (position !== 'value') throw new Error('scalar in a key position')
    return value as number | boolean | null
  }
  const ok = position === 'value' ? isRecordValue(value) : isKind(value, position)
  if (ok) {
    const s = (value as Opaque).s
    // A newline would forge a second JSONL record. Constructors cannot produce one,
    // so this is a belt-and-braces check rather than the primary defence.
    if (s.includes('\n') || s.includes('\r')) throw new Error('newline in opaque value')
    return s
  }
  throw new Error('value has the wrong provenance or category for this position')
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
      // Subject to the same line cap as an anomaly record: a digest with a runaway
      // number of counter keys would otherwise write an unbounded line. Counter
      // names are developer-chosen, so validate them like ctx keys.
      const digestLine = JSON.stringify({
        ...record,
        // Counter names must be counter constants; `suppressed` is keyed by
        // INVARIANT ID, so it takes the id category instead.
        counters: Object.fromEntries(record.counters.map(([k, v]) => [unwrap(k, 'counter'), v])),
        suppressed: Object.fromEntries(record.suppressed.map(([k, v]) => [unwrap(k, 'id'), v])),
      })
      return byteLength(digestLine) <= MAX_LINE_BYTES ? digestLine : null
    }

    // Keys go through `unwrap` exactly like values, so a key must ALSO be a
    // registry constant. A regex would have accepted a short body such as "hello"
    // as a key name; provenance does not.
    const ctx: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of record.ctx) {
      ctx[String(unwrap(key, 'ctx'))] = unwrap(value, 'value')
    }

    const crumbs = record.crumbs
      .slice(0, MAX_ARRAY)
      .map((crumb) => crumb.slice(0, MAX_ARRAY).map((v) => unwrap(v, 'value')))

    const out: Record<string, unknown> = {
      v: record.v,
      t: record.t,
      sid: record.sid,
      build: record.build,
      tokenKeyId: record.tokenKeyId,
      kind: record.kind,
      id: unwrap(record.id, 'id'),
      sev: record.sev,
      ctx,
      crumbs,
    }
    if (record.expected !== undefined) out.expected = unwrap(record.expected, 'value')
    if (record.observed !== undefined) out.observed = unwrap(record.observed, 'value')

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

Expected: PASS, 16 tests.

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

- [ ] **Step 4: Write the real plugin-fs adapter**

`createTauriSink` takes an injected writer so the queue semantics are testable; this is the writer
production passes it. Without it the sink is an abstraction with no implementation, and stage 1
would ship nothing that actually reaches disk.

Append to `apps/fluux/src/anomaly/sinks/tauri.ts`:

```ts
import { writeFile } from '@tauri-apps/plugin-fs'
import { homeDir, localDataDir } from '@tauri-apps/api/path'
import { platform } from '@tauri-apps/plugin-os'

/**
 * Resolve the sidecar directory, mirroring the Rust log-dir logic in
 * `src-tauri/src/main.rs:1444` so the JSONL lands beside `fluux.log` — the
 * directory already reachable from the app menu and the tray.
 *
 * Note the Rust side hardcodes `com.processone.fluux` regardless of bundle
 * identifier, so the Dev build writes here too. That is intentional: the sidecar is
 * Dev-only, so it is unambiguous even though `fluux.log` itself interleaves builds.
 */
async function sidecarDir(): Promise<string> {
  const os = await platform()
  if (os === 'macos') return `${await homeDir()}/Library/Logs/com.processone.fluux`
  // Everywhere else the Rust side uses `dirs::data_local_dir()`. `localDataDir()`
  // is its exact JS counterpart: LOCAL AppData on Windows (not Roaming) and
  // $XDG_DATA_HOME on Linux (not a hardcoded ~/.local/share). Hand-building those
  // paths would diverge from `fluux.log` on both platforms.
  return `${await localDataDir()}/com.processone.fluux/logs`
}

/** `anomalies.YYYY-MM-DD.jsonl`, daily-rotated to match `fluux.log`. */
function fileNameFor(date: Date): string {
  return `anomalies.${date.toISOString().slice(0, 10)}.jsonl`
}

/**
 * Production writer: append one newline-terminated line.
 *
 * `writeFile`, NOT `writeTextFile` — they are different Tauri commands with
 * different permissions (`plugin:fs|write_file` vs `plugin:fs|write_text_file`),
 * and only the former is granted by the existing `fs:allow-write-file` entry. Using
 * `writeTextFile` would require widening `capabilities/default.json`, which applies
 * to the production app.
 */
export function createPluginFsWriter(now: () => Date = () => new Date()) {
  return async (line: string): Promise<void> => {
    const path = `${await sidecarDir()}/${fileNameFor(now())}`
    await writeFile(path, new TextEncoder().encode(`${line}\n`), { append: true })
  }
}
```

- [ ] **Step 5: Write the adapter's integration test**

Create `apps/fluux/src/anomaly/sinks/pluginFsWriter.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock` factories are hoisted above every import and above plain `const`
// declarations, so a factory closing over an outer `const writeFile` throws
// "Cannot access before initialization" before the suite even loads.
// `vi.hoisted` is the supported way to share a mock with a hoisted factory.
const { writeFile, platformName } = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  platformName: { value: 'macos' },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile }))
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/Users/test',
  localDataDir: async () => '/Users/test/.local/share',
}))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: async () => platformName.value }))

import { createPluginFsWriter } from './tauri'

beforeEach(() => {
  writeFile.mockClear()
  platformName.value = 'macos'
})

describe('createPluginFsWriter', () => {
  it('appends to the daily sidecar beside fluux.log', async () => {
    const write = createPluginFsWriter(() => new Date('2026-07-29T11:47:02Z'))
    await write('{"kind":"anomaly"}')

    expect(writeFile).toHaveBeenCalledTimes(1)
    const [path, bytes, options] = writeFile.mock.calls[0]
    expect(path).toBe('/Users/test/Library/Logs/com.processone.fluux/anomalies.2026-07-29.jsonl')
    expect(options).toEqual({ append: true })
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('{"kind":"anomaly"}\n')
  })

  it('terminates every line so records cannot be concatenated', async () => {
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await write('a')
    await write('b')
    const written = writeFile.mock.calls.map((c) =>
      new TextDecoder().decode(c[1] as Uint8Array),
    )
    expect(written).toEqual(['a\n', 'b\n'])
  })

  it('rolls the filename over at the day boundary', async () => {
    let clock = new Date('2026-07-29T23:59:59Z')
    const write = createPluginFsWriter(() => clock)
    await write('before')
    clock = new Date('2026-07-30T00:00:01Z')
    await write('after')

    expect(writeFile.mock.calls[0][0]).toContain('anomalies.2026-07-29.jsonl')
    expect(writeFile.mock.calls[1][0]).toContain('anomalies.2026-07-30.jsonl')
  })

  it('uses localDataDir off macOS, matching dirs::data_local_dir on the Rust side', async () => {
    platformName.value = 'linux'
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await write('x')
    expect(writeFile.mock.calls[0][0]).toBe(
      '/Users/test/.local/share/com.processone.fluux/logs/anomalies.2026-07-29.jsonl',
    )
  })
})
```

- [ ] **Step 6: Run the adapter test**

```bash
cd apps/fluux && npx vitest run src/anomaly/sinks/pluginFsWriter.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Write the memory sink**

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

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd apps/fluux && npx vitest run src/anomaly/sinks/
```

Expected: PASS, 9 tests (5 queue + 4 adapter).

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/anomaly/sinks/
git commit -m "feat: add anomaly sinks with a non-poisoning single-flight write queue

Includes the plugin-fs adapter that writes the daily JSONL sidecar with
writeFile (not writeTextFile — a different Tauri command that the existing
capability does not grant)."
```

---

### Task 9: The recorder — ring, cooldown, ceiling, digest

**Files:**
- Create: `apps/fluux/src/anomaly/recorder.ts`
- Test: `apps/fluux/src/anomaly/recorder.test.ts`

**Interfaces:**
- Consumes: the value layer from Task 4 (`TAG`, `ID`, `COUNTER`, `retainOpaque`/`releaseOpaque`,
  `localRefOverflowCount`, `tokenKeyId`, `tokenUnresolvedCount`), `serialize`/`rejectedValueCount`
  (Task 7), `Sink` (Task 8).
- Produces:
  - `createRecorder(opts: { sink: Sink; now: () => number; build: string; sid: string }): Recorder`
  - `interface Recorder { crumb(parts: Scalar[]): void; record(input: { id: string; sev: 'bug'|'suspect'|'drift'; expected?: Scalar; observed?: Scalar; ctx?: Record<string, Scalar> }): void; count(key: string, by?: number): void; flushDigest(windowMs: number): void }`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/anomaly/recorder.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { createRecorder } from './recorder'
import { COUNTER, CTX, ID, METRIC, TAG } from './values'
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
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    const parsed = JSON.parse(sink.lines[0])
    expect(parsed.id).toBe('recorder/session-start')
    expect(parsed.crumbs).toEqual([['msg:in', 1], ['focus']])
    expect(parsed.tokenKeyId).toBeDefined()
  })

  it('bounds the crumb ring at 100 entries', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 150; i++) rec.crumb([TAG.msgIn, i])
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    const crumbs = JSON.parse(sink.lines[0]).crumbs
    expect(crumbs.length).toBe(50)
    // The 50 most recent, so the last one is i = 149.
    expect(crumbs[49]).toEqual(['msg:in', 149])
  })

  it('coalesces repeats of one id inside the cooldown', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    clock = 30_000
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    clock = 59_999
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    expect(sink.lines.length).toBe(1)
  })

  it('reports suppressed counts in the digest so coalescing hides no frequency', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 48; i++) rec.record({ id: ID.sessionStart, sev: 'bug' })
    rec.flushDigest(300_000)

    const digest = JSON.parse(sink.lines[sink.lines.length - 1])
    expect(digest.kind).toBe('digest')
    expect(digest.suppressed['recorder/session-start']).toBe(47)
  })

  it('writes again once the cooldown expires', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    clock = 60_001
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(sink.lines.length).toBe(2)
  })

  it('stops at the ceiling and says so instead of going quiet', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 600; i++) {
      clock += 60_001
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }

    const last = JSON.parse(sink.lines[sink.lines.length - 1])
    expect(last.id).toBe('recorder/ceiling-reached')
    expect(sink.lines.length).toBe(501)
  })

  it('carries recorder health counters in the digest', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.count(METRIC.mamQueries, 3)
    rec.count(METRIC.mamQueries)
    rec.flushDigest(300_000)

    const digest = JSON.parse(sink.lines[0])
    expect(digest.counters['mam.queries']).toBe(4)
    expect(digest.counters['recorder/rejected-value']).toBeDefined()
    expect(digest.counters['recorder/localref-overflow']).toBeDefined()
    expect(digest.counters['recorder/token-unresolved']).toBeDefined()
  })

  it('announces the ceiling when a prospective refusal blocks a record', () => {
    // emit() now returns false BEFORE writing, so bytesWritten does not move and
    // atCeiling() stays false. Without an explicit announce the recorder would go
    // quiet with no record explaining why.
    const sink = fakeSink()
    let budget = 1
    const rec = createRecorder({ sink, now, build: 'b', sid: 's', maxBytes: () => budget })
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    const ids = sink.lines.map((l) => JSON.parse(l).id)
    expect(ids).toContain('recorder/ceiling-reached')
  })

  it('refuses a reserved counter name instead of silently losing the value', () => {
    // The digest appends the health counters under these names; an application
    // counter sharing one would be overwritten by the health delta on fold.
    const rec = make(fakeSink())
    expect(() => rec.count(COUNTER.tokenUnresolved, 5)).toThrow(/reserved/)
  })

  it('does not write a rejected record but still counts it', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw-string' as never]] })
    expect(sink.lines.length).toBe(0)
  })

  it('reports health counters as per-window deltas, not running totals', () => {
    const sink = fakeSink()
    const rec = make(sink)

    // Two rejections in window one.
    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.record({ id: ID.ceilingReached, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.flushDigest(300_000)

    // One more in window two. Cumulative would report 3; the window saw 1.
    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.flushDigest(300_000)

    const first = JSON.parse(sink.lines[0]).counters['recorder/rejected-value']
    const second = JSON.parse(sink.lines[1]).counters['recorder/rejected-value']
    expect(first).toBe(2)
    expect(second).toBe(1)
  })

  it('applies the ceiling to digests too', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 600; i++) {
      clock += 60_001
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }
    const afterRecords = sink.lines.length

    rec.flushDigest(300_000)
    rec.flushDigest(300_000)

    // A digest is a record. Past the ceiling it must not keep appending.
    expect(sink.lines.length).toBe(afterRecords)
  })

  it('never writes past the byte ceiling, counting the line about to be written', () => {
    // Two defects at once: `line.length` counts UTF-16 code units rather than
    // bytes, and a retrospective check lets the LAST line cross the cap. Assert the
    // property that matters — total bytes on the sink never exceed the budget.
    const sink = fakeSink()
    const rec = createRecorder({
      sink,
      now,
      build: '0.17.2+abc',
      sid: 'sid-1',
      maxBytes: () => 4096, // small budget so the boundary is reachable in a test
    })

    for (let i = 0; i < 400; i++) {
      clock += 60_001
      rec.crumb([TAG.msgIn, i])
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }

    const encoder = new TextEncoder()
    const total = sink.lines.reduce((n, l) => n + encoder.encode(l).length, 0)
    // The ceiling notice is force-written, so allow exactly one line of headroom.
    const largest = Math.max(...sink.lines.map((l) => encoder.encode(l).length))
    expect(total).toBeLessThanOrEqual(4096 + largest)
    expect(sink.lines.length).toBeGreaterThan(1)
  })

  it('preserves the SAME window when a digest could not be written', () => {
    // The limit is raised on the SAME recorder. Building a second recorder would
    // prove nothing about the first one's state, which is exactly what is at stake:
    // if the baselines advanced and the counters cleared on a failed emit, the
    // window's data would be gone AND the next delta would be measured from a
    // report that never existed.
    const sink = fakeSink()
    let budget = 1
    const rec = createRecorder({ sink, now, build: 'b', sid: 's', maxBytes: () => budget })

    rec.count(METRIC.mamQueries, 9)
    rec.flushDigest(300_000)
    const afterFailure = sink.lines.filter((l) => JSON.parse(l).kind === 'digest')
    expect(afterFailure).toHaveLength(0)

    budget = 1024 * 1024
    rec.flushDigest(300_000)

    const digest = JSON.parse(
      sink.lines.filter((l) => JSON.parse(l).kind === 'digest').pop()!,
    )
    // The 9 events from the FIRST window survived the failed flush.
    expect(digest.counters['mam.queries']).toBe(9)
  })
})

describe('recorder ring pins local refs', () => {
  it('keeps a ref alive while it sits in the ring, and frees it on eviction', async () => {
    const { localRef, resetValuesForTesting, retainRef, releaseRef } = await import('./values')
    resetValuesForTesting()

    const sink = fakeSink()
    const rec = make(sink)

    // One ref held by TWO crumbs and one in-flight request.
    const ref = localRef('q', 'query-1')!
    retainRef('q', 'query-1') // the "request is open" hold
    rec.crumb([TAG.mamQuery, ref])
    rec.crumb([TAG.mamResult, ref])

    // Push the two crumbs out of the ring, releasing two of the three holds.
    for (let i = 0; i < RING_OVERFLOW; i++) rec.crumb([TAG.msgIn, i])

    // Still pinned by the open request, so pressure cannot reassign its identity.
    for (let i = 0; i < 2100; i++) localRef('m', `filler-${i}`)
    expect(localRef('q', 'query-1')!.s).toBe(ref.s)

    // Request completes: last hold gone, now evictable.
    releaseRef('q', 'query-1')
    for (let i = 0; i < 2100; i++) localRef('m', `more-${i}`)
    expect(localRef('q', 'query-1')!.s).not.toBe(ref.s)
  })
})

const RING_OVERFLOW = 120
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
import {
  COUNTER,
  ID,
  isReservedCounter,
  localRefOverflowCount,
  releaseOpaque,
  retainOpaque,
  tokenKeyId,
  tokenUnresolvedCount,
  type Opaque,
} from './values'
import type { Scalar } from './serializer'
import { rejectedValueCount, serialize } from './serializer'
import type { Sink } from './sinks/tauri'

const RING_SIZE = 100
const CRUMBS_PER_RECORD = 50
const COOLDOWN_MS = 60_000
const MAX_RECORDS = 500
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export interface RecordInput {
  /** An ID registry constant from values.ts. */
  id: Opaque
  sev: 'bug' | 'suspect' | 'drift'
  expected?: Scalar
  observed?: Scalar
  /** [CTX constant, value] pairs. */
  ctx?: Array<[Opaque, Scalar]>
}

export interface Recorder {
  crumb(parts: Scalar[]): void
  record(input: RecordInput): void
  /** `key` is a COUNTER registry constant. */
  count(key: Opaque, by?: number): void
  flushDigest(windowMs: number): void
}

export interface RecorderOptions {
  sink: Sink
  /** Injected for determinism in tests. */
  now: () => number
  build: string
  sid: string
  /**
   * Byte budget. A function, not a number, so a test can raise the limit and retry
   * on the SAME recorder instance — which is the only way to assert that a failed
   * flush preserved its window.
   */
  maxBytes?: () => number
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const { sink, now, build, sid } = opts
  const maxBytes = opts.maxBytes ?? (() => DEFAULT_MAX_BYTES)

  const ring: Scalar[][] = []
  // Keyed by the constant's string for lookup; the constant itself is kept so the
  // serializer still receives an Opaque rather than a rebuilt string.
  const counters = new Map<string, [Opaque, number]>()
  const suppressed = new Map<string, [Opaque, number]>()
  const lastEmittedAt = new Map<string, number>()

  let recordsWritten = 0
  let bytesWritten = 0
  let ceilingAnnounced = false

  // Health counters are CUMULATIVE totals at their source, but each digest describes
  // one window. Reporting the totals would double-count every window after the
  // first. Store the last reported value and emit the delta.
  const lastHealth = new Map<string, number>()

  const encoder = new TextEncoder()

  function atCeiling(): boolean {
    return recordsWritten >= MAX_RECORDS || bytesWritten >= maxBytes()
  }

  /**
   * The ONLY path to the sink. Every record — anomaly, digest, ceiling notice —
   * goes through here, so the ceiling and the byte accounting cannot be bypassed by
   * adding a new record kind later.
   *
   * `line.length` counts UTF-16 code units, not bytes; a multi-byte character would
   * undercount and let the 2 MB ceiling drift.
   */
  function emit(line: string, force = false): boolean {
    const size = encoder.encode(line).length
    // PROSPECTIVE: checking only what is already written lets the last line cross
    // the cap, so a 2 MB budget could end up writing 2 MB + 8 KB. Ask whether THIS
    // line fits before writing it.
    if (!force && (recordsWritten + 1 > MAX_RECORDS || bytesWritten + size > maxBytes())) {
      return false
    }
    sink.write(line)
    recordsWritten++
    bytesWritten += size
    return true
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
      id: ID.ceilingReached,
      sev: 'drift',
      ctx: [],
      crumbs: [],
    })
    // Forced: this is the record that explains the silence, so it must land even
    // though the ceiling has been reached.
    if (line) emit(line, true)
  }

  return {
    crumb(parts: Scalar[]): void {
      // Pin every LocalRef this crumb carries, so the ref cannot be evicted and
      // reassigned while the ring can still surface it. `retainOpaque` is a no-op
      // for tags and entity tokens. Without this the localRef module's own tests
      // pass while the SYSTEM property — a ref stays stable as long as anything can
      // refer to it — does not exist.
      for (const part of parts) retainOpaque(part)

      ring.push(parts)

      if (ring.length > RING_SIZE) {
        const evicted = ring.shift()
        if (evicted) for (const part of evicted) releaseOpaque(part)
      }
    },

    record(input: RecordInput): void {
      if (atCeiling()) {
        announceCeiling()
        return
      }

      const idKey = input.id.s
      const last = lastEmittedAt.get(idKey)
      if (last !== undefined && now() - last < COOLDOWN_MS) {
        const [, n] = suppressed.get(idKey) ?? [input.id, 0]
        suppressed.set(idKey, [input.id, n + 1])
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
        ctx: input.ctx ?? [],
        crumbs: ring.slice(-CRUMBS_PER_RECORD),
      })

      // A rejected record is a detector bug, surfaced via the digest counter rather
      // than by writing something unsafe.
      if (!line) return

      // A prospective refusal means nothing was written, so `atCeiling()` would
      // stay false and the explanatory record would never appear. Announce here,
      // and only advance the cooldown clock on a real write — otherwise a refused
      // record would suppress its own retry.
      if (!emit(line)) {
        announceCeiling()
        return
      }
      lastEmittedAt.set(idKey, now())
    },

    count(key: Opaque, by = 1): void {
      // The digest appends the recorder's own health counters under these names. An
      // application counter sharing one would be silently overwritten by the health
      // delta when the pairs are folded into an object — a wrong number rather than
      // a visible error.
      if (isReservedCounter(key.s)) {
        throw new Error(`${key.s} is reserved for recorder health; use a METRIC constant`)
      }
      const [, n] = counters.get(key.s) ?? [key, 0]
      counters.set(key.s, [key, n + by])
    },

    flushDigest(windowMs: number): void {
      if (atCeiling()) {
        announceCeiling()
        return
      }

      // Health totals are read but NOT committed yet: if the digest fails to
      // serialize or does not fit, advancing the baselines here would lose the
      // whole window — the counters would be cleared and the next digest would
      // report a delta measured from a report that was never written.
      const health: Array<[Opaque, number]> = [
        [COUNTER.rejectedValue, rejectedValueCount()],
        [COUNTER.localRefOverflow, localRefOverflowCount()],
        [COUNTER.tokenUnresolved, tokenUnresolvedCount()],
        [COUNTER.sinkWriteFailed, sink.failureCount()],
      ]

      const all: Array<[Opaque, number]> = [...counters.values()]
      for (const [constant, total] of health) {
        all.push([constant, total - (lastHealth.get(constant.s) ?? 0)])
      }

      const envelope = {
        v: 1 as const,
        t: new Date(now()).toISOString(),
        sid,
        build,
        tokenKeyId: tokenKeyId(),
        kind: 'digest' as const,
        windowMs,
        suppressed: [...suppressed.values()],
      }

      // Shed WHOLE counter entries — smallest first, so the largest signals
      // survive — until the line fits. A digest that simply vanished would look
      // like a quiet window rather than a dropped one.
      let entries = [...all].sort((a, b) => b[1] - a[1])
      let line: string | null = null
      while (entries.length > 0) {
        line = serialize({ ...envelope, counters: entries })
        if (line) break
        entries = entries.slice(0, entries.length - 1)
      }
      if (!line) line = serialize({ ...envelope, counters: [] })

      // A digest is subject to the ceiling like any other record: it is a record,
      // and an unbounded digest stream is an unbounded file.
      const written = line ? emit(line) : false
      if (!written) announceCeiling()

      // Commit the window ONLY on a successful write.
      if (written) {
        health.forEach(([constant, total]) => lastHealth.set(constant.s, total))
        counters.clear()
        suppressed.clear()
      }
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/anomaly/recorder.test.ts
```

Expected: PASS, 16 tests (15 recorder + 1 ring-pin integration). The last one — `recorder ring pins local refs` — is the integration
assertion: the `localRef` unit tests in Task 5 can pass while the recorder never calls
`retainOpaque`, so the system property would not exist despite green module tests.

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
- Consumes: `createRecorder` (Task 9), the sinks (Task 8), `initTokenizer`/`ID` (Task 4),
  `markAnomalyBuild` (Task 6).
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
import {
  getRecorder,
  install,
  installCount,
  resetInstallForTesting,
  whenReady,
} from './install'
import { METRIC } from './values'

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

  it('preserves recorder STATE across a StrictMode cycle, not just the session id', async () => {
    // A stable sessionId proves only that the id lives at module scope. If cleanup
    // destroyed the recorder, counters, cooldowns and the ring would silently reset
    // on remount — so assert continuity of something the runtime actually holds.
    await whenReady()
    const cleanup1 = install()
    getRecorder()!.count(METRIC.probe, 7)
    cleanup1()

    const cleanup2 = install()
    getRecorder()!.count(METRIC.probe, 5)
    getRecorder()!.flushDigest(1000)
    cleanup2()

    const lines = (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
    const digest = JSON.parse(lines.filter((l) => JSON.parse(l).kind === 'digest').pop()!)
    expect(digest.counters['probe.metric']).toBe(12)
  })

  it('announces the session exactly once across a StrictMode cycle', async () => {
    // The emission belongs to the runtime, not to an attachment. If each install()
    // attached its own `.then`, the cooldown would hide the second RECORD but still
    // count a phantom `suppressed['recorder/session-start']`.
    const cleanup1 = install()
    cleanup1()
    const cleanup2 = install()
    await whenReady()
    await Promise.resolve()

    getRecorder()!.flushDigest(1000)
    cleanup2()

    const lines = (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
    const records = lines.map((l) => JSON.parse(l))
    expect(records.filter((r) => r.id === 'recorder/session-start')).toHaveLength(1)

    const digest = records.filter((r) => r.kind === 'digest').pop()
    expect(digest.suppressed['recorder/session-start']).toBeUndefined()
  })

  it('does not write a record before the tokenizer holds its key', async () => {
    install()
    await whenReady()
    const lines = (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
    const start = lines.map((l) => JSON.parse(l)).find((r) => r.id === 'recorder/session-start')
    expect(start).toBeDefined()
    // tokenKeyId is the correlation boundary; "unknown" makes the record
    // unattributable to a token space.
    expect(start.tokenKeyId).not.toBe('unknown')
    expect(start.tokenKeyId).toMatch(/^[0-9a-f]{8}$/)
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

  it('keeps the runtime alive after cleanup, detaching only subscriptions', () => {
    const cleanup = install()
    const before = getRecorder()
    cleanup()
    // Deliberately NOT null: destroying it is what would reset the bounds.
    expect(getRecorder()).toBe(before)
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
import { isTauri } from '../utils/tauri'
import { createRecorder, type Recorder } from './recorder'
import { createMemorySink } from './sinks/memory'
import { createPluginFsWriter, createTauriSink } from './sinks/tauri'
import { markAnomalyBuild } from './gate'
import { ID, initTokenizer } from './values'

const DIGEST_INTERVAL_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// The RUNTIME is a module-level singleton, created once and NEVER torn down.
//
// React.StrictMode runs effects install -> cleanup -> install on mount. If cleanup
// destroyed the recorder, the second install would rebuild the counters, cooldown
// map and breadcrumb ring — so a remount would silently reset every bound the
// design relies on, and the session would keep its id while losing its state. Only
// SUBSCRIPTIONS are attached and detached; the runtime outlives them.
// ---------------------------------------------------------------------------

const sessionId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sid-${Date.now()}`

let recorder: Recorder | null = null
let ready: Promise<void> | null = null
let attachments = 0
let sessionAnnounced = false
let digestTimer: ReturnType<typeof setInterval> | null = null

function runtime(): Recorder {
  if (!recorder) {
    recorder = createRecorder({
      sink: isTauri()
        ? createTauriSink(createPluginFsWriter())
        : createMemorySink(),
      now: () => Date.now(),
      build: `${__APP_VERSION__}+${__GIT_COMMIT__}`,
      sid: sessionId,
    })
  }
  return recorder
}

export function getRecorder(): Recorder | null {
  return recorder
}

/**
 * Resolves once the tokenizer holds its key.
 *
 * Awaited before the first record, because a record written earlier would carry
 * `tokenKeyId: "unknown"` — and `tokenKeyId` is the correlation boundary, so an
 * unattributable record is worse than a late one.
 */
export function whenReady(): Promise<void> {
  if (!ready) ready = initTokenizer()
  return ready
}

/**
 * Emit the one session-start record, at most once per process.
 *
 * This belongs to the RUNTIME, not to an attachment. Attaching the `.then` inside
 * `install()` fires it once per StrictMode attach; the per-id cooldown would hide
 * the duplicate record but still increment
 * `suppressed['recorder/session-start']`, so every Dev session would open with a
 * phantom suppression that means nothing.
 */
function announceSessionOnce(rec: Recorder): void {
  if (sessionAnnounced) return
  sessionAnnounced = true
  void whenReady().then(() => rec.record({ id: ID.sessionStart, sev: 'drift' }))
}

/**
 * Attach subscriptions and timers. Idempotent: a second call while already
 * attached is a no-op returning a cleanup for THIS caller only.
 *
 * @returns cleanup that detaches everything this call attached. It does NOT
 * destroy the runtime — see the block comment above.
 */
export function install(): () => void {
  if (digestTimer) return () => {}

  attachments++
  const rec = runtime()
  markAnomalyBuild()
  announceSessionOnce(rec)

  digestTimer = setInterval(() => rec.flushDigest(DIGEST_INTERVAL_MS), DIGEST_INTERVAL_MS)

  const onHide = () => {
    // Best effort: the WebView gives no guarantee that async I/O completes during
    // teardown, so a missing trailing digest is normal and never a signal.
    if (document.visibilityState === 'hidden') rec.flushDigest(DIGEST_INTERVAL_MS)
  }
  document.addEventListener('visibilitychange', onHide)

  return () => {
    document.removeEventListener('visibilitychange', onHide)
    if (digestTimer) clearInterval(digestTimer)
    digestTimer = null
  }
}

/** @internal Test-only: tears down the runtime as well as the subscriptions. */
export function resetInstallForTesting(): void {
  if (digestTimer) clearInterval(digestTimer)
  digestTimer = null
  recorder = null
  ready = null
  attachments = 0
  sessionAnnounced = false
}

/** @internal Diagnostic: how many times install() actually attached. */
export function installCount(): number {
  return attachments
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

Expected: PASS, 8 tests.

- [ ] **Step 8: Verify the app boots in demo mode**

```bash
npm run build:sdk && npm run dev
```

Open `http://localhost:5173/demo.html`, then in the browser console:

```js
window.__fluuxAnomalies.map(JSON.parse).filter(r => r.id === 'recorder/session-start')
```

Expected: **exactly one** record, with a `tokenKeyId` matching `/^[0-9a-f]{8}$/` — not `unknown`.
An empty array means the installer did not mount or the tokenizer was not awaited; either way the
Dev-side CI assertion in Task 11 would fail.

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
- Modify: `.github/workflows/ci.yml` (the `test` job, after `Lint App`)
- Modify: root `package.json` (`scripts`)
- Test: `apps/fluux/scripts/anomalyBuildAudit.test.ts`

**Interfaces:**
- Consumes: `resolveAnomalyGate`, `ANOMALY_BUILD_SENTINEL` (Task 1).
- Produces: `anomalyBuildAudit(enabled: boolean): Plugin` — throws during `generateBundle` when
  the expectation is violated in either direction.

**Why this task is what makes the gate a guarantee rather than a convention.** The shared
`resolveAnomalyGate` landed in #1167 stops `vite.config.ts` and `vitest.config.ts` disagreeing about
the matrix — but that is all it does. `tauri-build.sh` and `build-e2e.mjs` each opt in
*independently* by exporting `FLUUX_ANOMALY=1`, and nothing verifies that either still does. A
refactor dropping the export from `tauri-build.sh` would silently return the packaged Dev bundle to
the pre-#1167 state, where the probes never installed and no test noticed. `build-e2e.mjs`
self-checks its own output; the Dev bundle has no equivalent until this task lands. Until then the
elimination evidence recorded in #1167 is a manual measurement, not an enforced property.

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

const carriers = walk(DIST).filter(
  (file) => /\.(js|css|html)$/.test(file) && readFileSync(file, 'utf-8').includes(SENTINEL),
)

// Branch on the EXPECTED direction first. Checking "absent" unconditionally and
// exiting would abort a Dev run before it ever reached the presence check — the
// Dev build is supposed to contain the sentinel.
const expectPresent = process.env.FLUUX_ANOMALY === '1'

if (expectPresent) {
  if (carriers.length === 0) {
    console.error(
      'FAIL: the anomaly gate sentinel is ABSENT from a Dev build. The tree was ' +
        'eliminated where it was supposed to run — check that FLUUX_ANOMALY reaches ' +
        'vite (see apps/fluux/src/anomaly/gate.ts).',
    )
    process.exit(1)
  }
  console.log(`OK: anomaly instrumentation present in the Dev bundle (${carriers.length} asset(s)).`)
} else {
  if (carriers.length > 0) {
    console.error(
      `FAIL: the anomaly gate sentinel survived into a production build:\n  ${carriers.join('\n  ')}`,
    )
    process.exit(1)
  }
  console.log('OK: no anomaly instrumentation in the production bundle.')
}
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

- [ ] **Step 8: Add the Playwright smoke test the spec requires**

The bundle checks prove the code is present. They do not prove it **runs** — spec §7.2 requires
the Dev build to produce a real record.

Create `scripts/e2e/anomaly-smoke.spec.ts`:

```ts
import { expect, test } from '@playwright/test'

test('the Dev build emits exactly one session-start record', async ({ page }) => {
  await page.goto('/demo.html?tutorial=false')

  // The record is written after the tokenizer resolves its key, so poll rather
  // than sampling once.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const lines = (window as unknown as { __fluuxAnomalies?: string[] }).__fluuxAnomalies
          if (!lines) return null
          return lines
            .map((l) => JSON.parse(l))
            .filter((r) => r.id === 'recorder/session-start')
        }),
      { timeout: 10_000 },
    )
    .toHaveLength(1)

  const record = await page.evaluate(() =>
    (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
      .map((l) => JSON.parse(l))
      .find((r) => r.id === 'recorder/session-start'),
  )

  // tokenKeyId is the correlation boundary: "unknown" means the record was written
  // before the tokenizer was ready and cannot be attributed to a token space.
  expect(record.tokenKeyId).toMatch(/^[0-9a-f]{8}$/)
  expect(record.sid).toBeTruthy()
  expect(record.v).toBe(1)

  // And the runtime sentinel, which is what the bundle check greps for.
  expect(await page.evaluate(() => (window as never as Record<string, unknown>).__fluuxAnomalyBuild))
    .toBe('fluux-anomaly-instrumentation-present')
})
```

Register it in `playwright.e2e.config.ts` as a project named **`anomaly-chromium`**, alongside
`scroll-chromium`, matching `scripts/e2e/anomaly-smoke.spec.ts` and reusing the existing demo build
fixture. Add it to whatever project list `npm run test:e2e` runs.

**It belongs to the `e2e-scroll` job, not `test`.** The `test` job installs neither Playwright
browsers nor their system dependencies; `e2e-scroll` already caches and installs both. Add to that
job, after its existing Playwright step:

```yaml
      - name: Anomaly smoke (the Dev build actually emits a record)
        run: npx playwright test --config playwright.e2e.config.ts --project=anomaly-chromium
```

`--project=anomaly-chromium` rather than `--grep anomaly`: a project is a declared, deterministic
selection, whereas a grep silently matches nothing if a title changes and reports success.

- [ ] **Step 9: Run the smoke test**

```bash
npm run build:e2e && npx playwright test --config playwright.e2e.config.ts --project=anomaly-chromium
```

Expected: PASS. A failure here means the installer did not mount, or the tokenizer was not awaited.

- [ ] **Step 10: Add both checks to package.json**

In the root `package.json` `scripts`, after `"build:app"`, add:

```json
    "check:anomaly:prod": "npm run build:app && node scripts/check-anomaly-elimination.mjs",
    "check:anomaly:dev": "FLUUX_ANOMALY=1 npm run build:app && FLUUX_ANOMALY=1 node scripts/check-anomaly-elimination.mjs",
```

- [ ] **Step 11: Install the assertions in CI**

A script nobody runs proves nothing. The `test` job in `.github/workflows/ci.yml` currently ends
at lint plus the Zustand selector check. Add a step after `Lint App`:

```yaml
      - name: Anomaly instrumentation is eliminated in production and present in Dev
        run: |
          # Two builds, two directions. The production direction protects users; the
          # Dev direction catches a silent regression to "eliminated everywhere,
          # including where it was supposed to run" — which is exactly what the
          # import.meta.env.DEV gate did before this work.
          npm run check:anomaly:prod
          npm run check:anomaly:dev

```

- [ ] **Step 12: Verify the CI step locally**

```bash
npm run check:anomaly:prod && npm run check:anomaly:dev
```

Expected: the first prints `OK: no anomaly instrumentation in the production bundle.`, the second
prints `OK: anomaly instrumentation present in the Dev bundle.` Both must pass; if the second
fails, the gate is not reaching Vite.

- [ ] **Step 13: Commit**

```bash
git add apps/fluux/scripts/anomalyBuildAudit.ts apps/fluux/scripts/anomalyBuildAudit.test.ts apps/fluux/vite.config.ts apps/fluux/vitest.config.ts scripts/check-anomaly-elimination.mjs scripts/e2e/anomaly-smoke.spec.ts playwright.e2e.config.ts package.json .github/workflows/ci.yml
git commit -m "test: assert the anomaly tree is eliminated in production and present in Dev"
```

---

### Task 12: The invariant registry skeleton

**Files:**
- Create: `docs/ANOMALY_INVARIANTS.md`

**Interfaces:**
- Consumes: the `ID` registry from Task 4 — every entry here has a constant there, and vice versa.
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
| `recorder/session-start` | One per session, written once the tokenizer holds its key | Its absence means the runtime never installed. Its `tokenKeyId` opens the session's token space |
| `recorder/ceiling-reached` | 500 records or 2 MB in one session; recording stopped | Something fired in a loop. Find the last repeated `id` before it |
| `recorder/rejected-value` | A detector passed a non-opaque value; the record was dropped | A detector bug. The value never reached disk, but the evidence is lost |
| `recorder/localref-overflow` | The 2 000-ref map was full and all refs pinned; a crumb was omitted | Usually a leak: something is retaining refs without releasing |
| `recorder/token-unresolved` | A token was requested before it was warmed | Rare is fine. Sustained means the pre-warm is missing a lifecycle event |
| `recorder/sink-write-failed` | A sidecar append failed | Check `fluux.log` — failures mirror there, because a broken sink cannot report itself |

## Detector families

No detectors ship in stage 1. Each entry below is added by the stage that
introduces it.

### `read-state/`

_(stage 3: `unread-survives-focus`; stage 5: `pointer-regression`; `badge-vs-pointer`
is not shipped after its equal-count premise also proved unsound. See the design's
§5.1 and `docs/ANOMALY_INVARIANTS.md` for the current record.)_

### `xmpp-traffic/`

_(stage 5: `redundant-query`, `iq-unanswered`, plus MAM merge yield as a rate.)_

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
| Elimination | `npm run check:anomaly:prod` | Task 11, production direction |
| Dev presence | `npm run check:anomaly:dev` | Task 11, Dev direction |
| CI | both of the above, wired into the `test` job | Task 11 Step 10 |
| Standard | `npm test && npm run typecheck && npm run lint` | Everything |

No Cargo work and no capability entry: stages 0–1 add no native code, and the sidecar uses
`writeFile` under the `fs:allow-write-file` grant that already exists.

## What stage 1 deliberately does NOT include

- **Detectors.** No invariant is evaluated. The only record produced is
  `recorder/session-start`, which exists so the Dev-side CI assertion has a real artifact.
- **Retention.** Pruning lives in `/fluux-anomaly-review` (stage 4), because a startup sweep
  would need `fs:allow-read-dir` and `fs:allow-remove` — both of which would widen the production
  capability surface.
- **Any SDK change.** The four seams are stage 5.
