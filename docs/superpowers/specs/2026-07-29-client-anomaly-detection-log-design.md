# Client anomaly detection log — design

A dev-build-only instrumentation layer that records **invariant violations** and **bounded usage
digests** to a machine-readable sidecar log, so a coding agent can sweep real daily usage on a
recurring cadence and surface bugs and inefficiency without a human first noticing something is
wrong.

Production builds ship **no anomaly JavaScript and no new native command**, and CI asserts both the
absence in production and the presence in Dev, rather than assuming either.

---

## 1. Motivation

The app already emits a lot of diagnostic signal. `fluux.log` for 2026-07-29 held **1285 lines**,
and the signal in it is real:

| Observation | Count | Why it matters |
|---|---|---|
| `stashed encrypted payload ... deferred decrypt` | 297 | Half the log is three E2EE lines |
| `unsupported encryption (OMEMO)` | 197 | Is this the expected steady state? |
| `dropped empty OMEMO message` | 120 | Known phantom-bubble path |
| Room joined, per room | 10 | Reconnect churn, or 10 normal sessions? |
| MAM queries | 108 | With repeated `complete=false` pages |
| `Reaction for message not in memory` | 20 | Cache-miss path taken often |

**48% of the file is three repeating lines.** The information needed to spot an anomaly is present,
but the format makes finding it cost more than it is worth. Three properties are missing:

1. **No assertion.** The log records what happened, never what *should* have happened. Every review
   re-derives "normal" from scratch.
2. **No bounded summary.** Volume scales with session length, so inefficiency drift — the class that
   has no single violating event — is invisible.
3. **No stable identity.** Lines are prose. Grouping, trending, and cross-day comparison all require
   ad-hoc parsing that changes whenever a message string changes.

This design adds those three properties **alongside** the existing prose log, which remains the
right tool for human troubleshooting and is not modified or reduced anywhere (see §5.3).

---

## 2. Constraints

| Constraint | Source | Consequence |
|---|---|---|
| Local only, no transport | Decided | No consent flow, no collector, no retention policy |
| Dev builds only | Decided | Corpus comes from `Fluux Messenger Dev`, demo mode, and Playwright |
| Zero production JS, no new native surface | Decided | Build-time constant + guarded call sites + paired CI assertions (§7.2) |
| SDK `dist` is built without defines | `packages/fluux-sdk/tsup.config.ts` | Detectors must not live in SDK source — see §3.1 |
| Privacy contract of `logger.ts` | Existing | Enforced by construction, not by convention — see §4.4 |

### 2.1 Two facts established while designing

**`import.meta.env.DEV` is the wrong gate.** `npm run tauri:install` runs `tauri-build.sh`, which
invokes `tauri build --config tauri.dev.conf.json`. That runs the **production** Vite build. So in
`Fluux Messenger Dev`, `import.meta.env.DEV === false`.

Consequence beyond this design: the existing dev-only probes at
`apps/fluux/src/components/conversation/MessageList.tsx:497` and `:652` have never run in the daily
driver build. Fixing the gate is in scope here.

**The log directory ignores the bundle identifier.** `apps/fluux/src-tauri/src/main.rs:1444`
hardcodes `com.processone.fluux`, so `Fluux Messenger Dev` and any production run interleave in one
`fluux.YYYY-MM-DD.log`. The sidecar is Dev-only and therefore unambiguous, but the interleaving is
worth knowing when reading the prose log.

---

## 3. Architecture

### 3.1 Placement: app-side, for distribution reasons

`apps/fluux/vite.config.ts:126` aliases `@fluux/sdk` to SDK **source**, unconditionally. So Vite
does compile SDK source in the app build, and a define *would* reach it — SDK placement is not
blocked by the app's build.

It is blocked by **SDK distribution**. `packages/fluux-sdk` publishes a `dist/` built by tsup with
no defines and `minify: false`. Instrumentation in SDK source would therefore ship to every external
SDK consumer, who neither asked for it nor has a way to gate it. The SDK is a product surface in its
own right; a diagnostic system for the Fluux app does not belong inside it.

So the system lives in `apps/fluux/src/anomaly/` and consumes SDK surfaces that already exist:

- `client.onStanza()` — public, `packages/fluux-sdk/src/core/XMPPClient.ts:948` (**inbound only**)
- typed SDK events via the existing subscription API
- direct Zustand `store.subscribe`

**Zero SDK changes in stages 1–4.** Stage 5 adds two read-only SDK seams (§5.5).

### 3.2 Layout

```
apps/fluux/src/anomaly/
  gate.ts          __FLUUX_ANOMALY__ re-export + sentinel string for the CI check
  recorder.ts      breadcrumb ring, counters, cooldown, ceiling, record(), flushDigest()
  schema.ts        record types + constrained value constructors (§4.4)
  sinks/tauri.ts   single-flight append via plugin-fs
  sinks/memory.ts  window.__fluuxAnomalies for demo / web / Playwright
  detectors/
    readState.ts
    xmppTraffic.ts
    scroll.ts
    resource.ts
  install.ts       returns a cleanup function; StrictMode-safe (§3.4)
  AnomalyInstaller.tsx   mounted inside XMPPProvider; reads client from context
```

### 3.3 The gate

A new build-time define alongside the existing `__APP_VERSION__` / `__GIT_COMMIT__` pattern in
`apps/fluux/vite.config.ts:140`:

```ts
__FLUUX_ANOMALY__: JSON.stringify(process.env.FLUUX_ANOMALY === '1')
```

`tauri-build.sh` sets `FLUUX_ANOMALY=1` when it applies the dev identity. Release CI does not.

Three rules make elimination real rather than theoretical:

1. **Build-time constant, never a runtime flag.** A `localStorage` read costs at runtime *and*
   defeats elimination, because the bundler cannot prove the branch dead.
2. **Guard the call sites, not the module internals.** If the check lives inside `record()`, the
   import survives, the module ships, and every stanza and every frame pays a call plus a branch.
   Corollary: **no anomaly state may live in unguarded code** — a counter incremented in a shared
   path costs production even when only the reader is gated. Detectors own their state entirely.
3. **Assert it in CI, in both directions.** §7.2.

### 3.4 Ignition and lifecycle

`main.tsx` cannot host this: at `apps/fluux/src/main.tsx:141` there is no `client`, because
`XMPPProvider` constructs it internally (`packages/fluux-sdk/src/provider/XMPPProvider.tsx:145`).

Instead, a lazily-loaded component mounted **inside** `XMPPProvider`, where the client is reachable
from context:

```tsx
const AnomalyInstaller = __FLUUX_ANOMALY__
  ? lazy(() => import('./anomaly/AnomalyInstaller'))
  : null
...
<XMPPProvider ...>
  {AnomalyInstaller && <Suspense fallback={null}><AnomalyInstaller /></Suspense>}
  ...
</XMPPProvider>
```

A `lazy` import inside a statically-false branch means Rollup does not merely skip the code — it
never emits the chunk.

**StrictMode contract.** The tree renders inside `React.StrictMode`, so effects run
install → cleanup → install on mount. `install(client)` must therefore:

- return a cleanup function that fully unsubscribes every listener, timer, and rAF loop;
- be idempotent — a second install after cleanup must not double-subscribe, double-count, or emit a
  duplicate session record;
- carry session identity in a module-level singleton, not in effect scope, so the remount does not
  fork the session id or reset counters mid-session.

This is a tested requirement (§7.1), not a note: a double-subscribed detector reports every anomaly
twice and every counter at 2×, which would be indistinguishable from a real regression.

### 3.5 Transport: no new native command

The sidecar is written from JavaScript via `@tauri-apps/plugin-fs` 2.5.1
`writeTextFile(path, line, { append: true })`. The plugin is already registered
(`apps/fluux/src-tauri/src/main.rs:1576`) and `fs:allow-write-file` is already scoped to `$HOME/**`
(`apps/fluux/src-tauri/capabilities/default.json`), which covers the log directory.

**This is a deliberate choice over a native `append_anomaly_line` command.** A native command
registered in `generate_handler!` (`apps/fluux/src-tauri/src/main.rs:1591`) ships in production
regardless of the JavaScript gate, and `Cargo.toml` has no `[features]` section, so excluding it
would mean introducing a feature matrix, conditional registration, and a third CI assertion over the
production binary. Writing from JS removes the native question entirely instead of answering it, and
keeps the guarantee inside the one layer CI can cheaply prove.

Cost of this choice: append ordering must be enforced in JS. All sink writes go through a
**single-flight promise queue** (§4.3); no write is issued until the previous one resolves.

**Path:** `~/Library/Logs/com.processone.fluux/anomalies.YYYY-MM-DD.jsonl`, daily-rotated to match
`fluux.log`, in the directory already reachable from the app menu and tray.

**Web / demo / Playwright:** memory sink on `window.__fluuxAnomalies`. This is what later allows the
same detectors to run as CI oracles.

**Retention:** a startup sweep deletes sidecar files older than 30 days.

### 3.6 Data flow

```
detector subscribes (client event / store / rAF)
        │
        ├─ every observation ──▶ breadcrumb ring (fixed 100 entries)
        │
        └─ invariant fails ───▶ record()
                                  │ cooldown + ceiling checks (§4.3)
                                  │ attaches last 50 crumbs, session id, build stamp
                                  ▼
                             single-flight queue ──▶ sink ──▶ JSONL
counters (in recorder) ── every 5 min + visibilitychange/exit ──▶ flushDigest() ──▶ queue
```

---

## 4. Record schema

One envelope, two kinds. Short flat keys, so a day's file stays small enough to read whole.

```jsonc
{ "v":1, "t":"2026-07-29T11:47:02Z", "sid":"9f2c1a04-...", "build":"0.17.2+5abd37a",
  "kind":"anomaly", "id":"read-state/pointer-regression", "sev":"bug",
  "expected":"ahead", "observed":"behind",
  "ctx":{ "conv":"c:7f3a2b", "route":"#/chat" },
  "crumbs":[ ["msg:in","c:7f3a2b"], ["ptr:advance",42], ["focus",1] ] }
```

```jsonc
{ "v":1, "t":"2026-07-29T11:50:00Z", "sid":"9f2c1a04-...", "build":"0.17.2+5abd37a",
  "kind":"digest", "windowMs":300000,
  "counters":{ "mam.queries":108, "mam.rowsRetained":340, "mam.pagesEmpty":4,
               "room.joins":10, "render.MessageList":1840, "scroll.writes":96 },
  "suppressed":{ "scroll/reassert-nonconverging":47 } }
```

### 4.1 Field rules

1. **`v` is a schema version.** The review skill refuses to parse an unknown major version rather
   than silently misreading it.
2. **`sid` is a `crypto.randomUUID()`** generated once per process in a module-level singleton, so
   it survives the StrictMode remount (§3.4) and cannot collide across days or concurrent Dev runs.
3. **`id` is a registry key** (`family/name`), not prose. Meaning resolves from
   `docs/ANOMALY_INVARIANTS.md`, so a review loads the log plus one registry file rather than the
   codebase. This is the property that makes a *recurring* review affordable.
4. **`sev` is `bug` | `suspect` | `drift`**, so triage is mechanical instead of a judgement call.
5. **Crumbs are tuples, not objects** — roughly 4× smaller, and a day stays readable.

### 4.2 Breadcrumbs

The single highest-value element. Without them a record is not actionable. With a bounded ring of
preceding domain events, each record is a self-contained mini-repro. Ring size is fixed, so ring
cost is constant in session length — but see §4.3, because the *records* are what actually grow.

### 4.3 Boundedness

The breadcrumb ring is bounded; the record stream is not, unless made so. A repeatedly failing
invariant would otherwise append without limit, each record duplicating 50 crumbs. Four mechanisms:

| Mechanism | Rule |
|---|---|
| **Per-id cooldown** | 60s per `id`. A repeat inside the window increments a suppressed counter instead of writing a record |
| **Suppression reporting** | Digests carry `suppressed: { id: count }`, so coalescing never hides frequency — a detector firing 47 times is visibly different from one firing twice |
| **Session ceiling** | 500 records or 2 MB, whichever comes first. On hit, write one final `recorder/ceiling-reached` record and stop. A silent stop would read as a healthy day |
| **Write discipline** | Single-flight queue; max 8 KB per line; over-limit records shed crumbs first, then optional fields, and set `"trunc":true`; newlines rejected in every string value (a newline would forge a second JSONL record) |

### 4.4 Privacy by construction

A sample-based redaction test cannot stop a future detector from logging a body — it only tests the
samples someone thought to write. Privacy is therefore enforced by the type system and by runtime
constructors, so a detector that tries to log content **cannot compile, and cannot serialize**:

- **Constrained value types.** `expected`, `observed`, and crumb values accept only
  `number | boolean | null | Token | Tag`, where `Tag` is a string literal union declared in
  `schema.ts`. Arbitrary `string` is not assignable. Free-form text has no path into a record.
- **Opaque entity tokens.** `Token` is produced solely by `token(bareJid)`, an HMAC of the bare JID
  with a per-install random salt, rendered as `c:` + 6 hex chars. Stable within an install, so
  records correlate across a session and across days; carries no local part, no domain, and does not
  survive being pasted into an issue as identity.
- **Recursive serialization limits.** Max depth 2, max 50 array entries, max 64 chars per string,
  enforced in the serializer — not only in the constructors — so a bypass still cannot emit a body.
- **Adversarial tests.** Property-based: feed detectors messages whose bodies are random
  high-entropy strings, then assert no substring of any body length ≥ 8 appears anywhere in the sink
  output. This tests the mechanism rather than a sample.

---

## 5. Detector catalogue

### 5.1 `read-state/`

| id | check | sev | stage |
|---|---|---|---|
| `pointer-regression` | every pointer write must satisfy `isAhead` (`stores/shared/readPointer.ts:89`) | bug | 3 |
| `unread-survives-focus` | active + focused + at live edge for >2s, yet `unreadCount > 0` | bug | 3 |
| `badge-vs-pointer` | archive-derived recount vs displayed count | bug | **5 — blocked** |

**Why `badge-vs-pointer` is deferred.** The original design proposed
`recomputeCountsFromPointer` (`stores/shared/notificationState.ts:637`) as an oracle. That is not
implementable:

- it is **not exported** from `index.ts`, `stores/index.ts`, or `core/index.ts`;
- it operates on a **supplied message slice**, not the durable archive;
- its counts are **explicitly not trusted** — `chatStore.ts:2484` discards them as "provisional".

The real recount checks MAM coverage (`isCaughtUpForCounting`, `chatStore.ts:2569`), resolves the
coverage bottom, incorporates the transient overlay, compares order positions, and only then calls
`messageCache.countUnreadInArchive`. A detector running against the resident or bounded-cache slice
would **recreate the exact under-count class it exists to catch** — the worst possible failure for a
detector, because it would be silent precisely when the bug is present.

This detector therefore requires a **read-only SDK diagnostic seam** exposing an archive-derived
count with the same coverage gating, and lands in stage 5 (§5.5). The two stage-3 detectors need no
such seam: both are observable from store transitions alone.

**Evaluation trigger for stage 5.** When it does land, `badge-vs-pointer` must not free-run — during
a normal recompute the displayed count and the pointer legitimately disagree for a window. It must
be debounced 500ms on `conversationMeta` / `roomMeta` change and suppressed while a recount is in
flight. A detector that fires during normal settling is indistinguishable from one that found a bug,
and by §6.1 it would be deleted.

### 5.2 `xmpp-traffic/`

`onStanza` is **inbound only**. The missing outbound visibility affects more than one detector:

| id | check | sev | needs `onStanzaOut` |
|---|---|---|---|
| `mam-page-yield` | rows returned vs rows retained per query | drift | yes — query lifecycle correlation |
| `redundant-query` | same disco/vCard/MAM target re-queried within a window | suspect | yes — outbound queries are the thing being counted |
| `iq-unanswered` | outbound IQ with no result within 30s | bug | yes |

All three land in **stage 5**, behind the SDK seam. Stage 4 previously claimed partial coverage via
module events; that was optimistic — disco and vCard traffic is not visible in the typed event
stream at the granularity these checks need.

### 5.3 `scroll/` — fan-out, not re-pointing

`reassertLoopMonitor`, `slowCorrectionMonitor`, `resizeLoopMonitor` and `stallSentinel` already
detect correctly. They gain a **second, additive output**: the existing `console.warn` prose stays
exactly as it is, including in production where it remains the troubleshooting path, and a
structured record is emitted **in addition** when `__FLUUX_ANOMALY__` is set.

Nothing is removed from `fluux.log`. §1 promises the prose log is preserved; fan-out is what keeps
that promise. Verified by test (§7.1): with the gate off, the prose output must be byte-identical to
today's.

New in stage 3: `fab-at-live-edge` (FAB visible while the list is at the bottom) and
`jump-target-miss` (target row not in viewport after a go-to-message settles).

### 5.4 `resource/`

No pass/fail. Digest counters only — renders per route and component, IDB writes, memory delta
across room switches, stall count — compared against baseline. `sev: drift` by construction.

### 5.5 SDK seams (stage 5)

Two read-only additions to the SDK public API, each useful beyond this system:

1. **`onStanzaOut(handler)`** — mirrors the existing `onStanza`. Unblocks all of §5.2.
2. **A read-only unread diagnostic** returning the archive-derived count with the same coverage
   gating as the real recount, without mutating store state. Unblocks `badge-vs-pointer`.

Both are ordinary SDK API improvements rather than instrumentation hooks, and neither carries
anomaly-system code into `dist`.

---

## 6. The review loop

- **`docs/ANOMALY_INVARIANTS.md`** — registry keyed by `id`: what the invariant means, likely
  causes, where to look.
- **`docs/anomaly-baseline.json`** — committed digest baseline for drift comparison.
- **`/fluux-anomaly-review` skill** — reads the last 7 days of JSONL by default, refuses unknown
  schema majors, groups by `id`, folds in `suppressed` counts, diffs digest against baseline,
  reports. It **reports findings; it does not fix them.** Findings become issues.
- **Cadence** — invoked manually, optionally driven by `/loop`.

### 6.1 The maintenance hazard, named

**Baseline rot.** When a drift is accepted, the baseline must be updated in the same commit.
Otherwise the review cries wolf on every run and stops being read — which kills this system more
reliably than any bug it might catch.

Same rule for detectors: **a detector that produces false positives is deleted, not tuned
indefinitely.** Trust in the log is the actual asset being protected.

---

## 7. Verification

### 7.1 Unit tests

Each detector is a pure function with timestamps and state passed in, matching the existing sentinel
style (`stallSentinel.ts`, `reassertLoopMonitor.ts`). Every detector lands with **both**:

- a firing case, and
- a **control case proving it stays silent on healthy input**.

A break-check alone is necessary but not sufficient — a detector that fires on everything passes a
firing test. Hollow tests are this repository's recurring defect class.

Additionally required:

- **StrictMode cycle test** — install → cleanup → install must yield exactly one subscription set,
  one session id, and unreset counters (§3.4).
- **Prose-preservation test** — with the gate off, sentinel `console.warn` output is byte-identical
  to today's (§5.3).
- **Boundedness tests** — cooldown coalescing, ceiling stop with its final record, 8 KB truncation
  order, newline rejection (§4.3).

### 7.2 Paired CI assertions

One sentinel string is insufficient: that export could be tree-shaken while other anomaly modules
remain. CI asserts in **both directions**:

| Artifact | Assertion |
|---|---|
| Production bundle + manifest | No chunk filename matches `anomaly*`; no module in the graph resolves under `src/anomaly/`; the `gate.ts` sentinel string is absent from every emitted asset |
| Dev bundle (`FLUUX_ANOMALY=1`) | The anomaly chunk **is** emitted, the sentinel **is** present, and a Playwright smoke run produces at least one record in `window.__fluuxAnomalies` |

The Dev half is what stops a silent regression to "eliminated everywhere, including where it was
supposed to run" — the failure mode that already happened with `import.meta.env.DEV` (§2.1).

No native assertion is needed, because §3.5 adds no native code.

### 7.3 Privacy tests

Adversarial and property-based, per §4.4 — the mechanism is tested, not a sample list.

### 7.4 Playwright

Memory sink asserted in the demo and scroll suites.

### 7.5 Standard gates

`npm test`, `npm run typecheck`, `npm run lint`. `npm run test:scroll` for the §5.3 stage. No Cargo
work is required by this design.

---

## 8. Sequencing

Each stage is independently useful and independently revertable.

| Stage | Content | Proves | SDK change |
|---|---|---|---|
| 1 | Gate, schema + constrained constructors, recorder with cooldown/ceiling, single-flight sink, paired CI assertions, registry skeleton | Production cost is zero, Dev actually runs, privacy holds by construction | none |
| 2 | Scroll/stall sentinel **fan-out** | The pipe works end to end with no new detection logic, and the prose log is untouched | none |
| 3 | `read-state/` (pointer-regression, unread-survives-focus) + `scroll/` (fab-at-live-edge, jump-target-miss) | Real detectors on store- and DOM-observable state | none |
| 4 | `resource/` counters, baseline, `/fluux-anomaly-review` skill | The review loop closes and drift detection starts | none |
| 5 | `onStanzaOut` + read-only unread diagnostic, then `xmpp-traffic/` and `badge-vs-pointer` | Everything requiring new SDK visibility | two read-only additions |

Stage 1 ships no detectors deliberately: the elimination and privacy guarantees are what everything
else rests on. Stage 4 now precedes the SDK work so the loop is closed and proven useful before the
public API is extended.

---

## 9. Out of scope

- Remote telemetry, any network transport, any consent flow.
- Production-build instrumentation. The gate makes enabling it a one-line change if that decision
  ever changes.
- A native append command, and therefore any Cargo feature matrix (§3.5).
- Automatic fixing of anomalies. The review reports; a human triages.
- E2EE-specific detectors. The 614 lines of repeating E2EE output that motivated §1 are a strong
  candidate for a later family, but classifying them needs protocol judgement this slice does not
  attempt.
