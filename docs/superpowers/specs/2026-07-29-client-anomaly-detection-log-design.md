# Client anomaly detection log — design

A dev-build-only instrumentation layer that records **invariant violations** and **bounded usage
digests** to a machine-readable sidecar log, so a coding agent can sweep real daily usage on a
recurring cadence and surface bugs and inefficiency without a human first noticing something is
wrong.

Production builds are unaffected: every line of this system is eliminated at build time, and CI
asserts the elimination rather than assuming it.

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

This design adds those three properties without touching the existing prose log, which remains the
right tool for human troubleshooting of a specific reported bug.

---

## 2. Constraints

| Constraint | Source | Consequence |
|---|---|---|
| Local only, no transport | Decided | No consent flow, no collector, no retention policy |
| Dev builds only | Decided | Corpus comes from `Fluux Messenger Dev`, demo mode, and Playwright |
| Zero production cost, provable | Decided | Build-time constant + guarded call sites + CI assertion |
| SDK ships one prebuilt `dist/` | `packages/fluux-sdk/tsup.config.ts` | **Detectors cannot live in SDK source** — see §3.1 |
| Privacy contract of `logger.ts` | Existing | No bodies, no JID local parts, even though local-only |

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

### 3.1 Placement: app-side, not SDK

`packages/fluux-sdk` builds via tsup with `minify: false` and no defines, and **one `dist/` serves
both the Dev and the release app**. A Vite `define` in the app cannot eliminate code already
compiled into `dist/index.js`. Any detector in SDK source would therefore ship to production and
cost real cycles.

So the entire system lives in `apps/fluux/src/anomaly/` and consumes SDK surfaces that already
exist:

- `client.onStanza()` — public, `packages/fluux-sdk/src/core/XMPPClient.ts:948`
- typed SDK events via the existing subscription API
- direct Zustand `store.subscribe`

**Zero SDK changes in the first slice.**

Accepted limitation: detectors can only assert on what public surfaces expose. The known gap is
**outgoing stanzas** — `onStanza` is inbound only. A future `onStanzaOut` is a clean public-API
addition, deferred out of this slice (see §5.2, `iq-unanswered`).

### 3.2 Layout

```
apps/fluux/src/anomaly/
  gate.ts          __FLUUX_ANOMALY__ re-export + sentinel string for the CI check
  recorder.ts      breadcrumb ring, counters, record(), flushDigest()
  schema.ts        record types, shared with the review skill
  sinks/tauri.ts   append JSONL via a narrow Rust command
  sinks/memory.ts  window.__fluuxAnomalies for demo / web / Playwright
  detectors/
    readState.ts
    xmppTraffic.ts
    scroll.ts
    resource.ts
  install.ts       wires detectors to client + stores; single entry point
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
3. **Assert it in CI.** §7.2.

Single ignition point in `main.tsx`:

```ts
if (__FLUUX_ANOMALY__) void import('./anomaly/install').then((m) => m.install(client))
```

A **dynamic** import inside a statically-false branch means Rollup does not merely skip the code —
it never emits the chunk.

### 3.4 Data flow

```
detector subscribes (client event / store / rAF)
        │
        ├─ every observation ──▶ breadcrumb ring (fixed 100 entries)
        │
        └─ invariant fails ───▶ record()
                                  │ attaches last 50 crumbs, session id, build stamp
                                  ▼
                                sink ──▶ JSONL
counters (in recorder) ── every 5 min + visibilitychange/exit ──▶ flushDigest() ──▶ sink
```

### 3.5 Transport

**Tauri:** append to `~/Library/Logs/com.processone.fluux/anomalies.YYYY-MM-DD.jsonl` — the
directory already reachable from the app menu and tray, daily-rotated to match `fluux.log`. Via a
narrow Rust `append_anomaly_line` command rather than the `fs` plugin, which avoids read-modify-write
races and keeps the plugin scope unchanged.

**Web / demo / Playwright:** memory sink on `window.__fluuxAnomalies`. This is what later allows the
same detectors to run as CI oracles.

Retention: a sweep on startup deleting sidecar files older than 30 days.

---

## 4. Record schema

One envelope, two kinds. Short flat keys, so a day's file stays small enough to read whole.

```jsonc
{ "t":"2026-07-29T11:47:02Z", "sid":"a3f2", "build":"0.17.2+5abd37a",
  "kind":"anomaly", "id":"read-state/badge-vs-pointer", "sev":"bug",
  "expected":0, "observed":3,
  "ctx":{ "conv":"process-one.net", "route":"#/chat" },
  "crumbs":[ ["msg:in","process-one.net"], ["ptr:advance",42], ["focus",1] ] }
```

```jsonc
{ "t":"2026-07-29T11:50:00Z", "sid":"a3f2", "build":"0.17.2+5abd37a",
  "kind":"digest", "windowMs":300000,
  "counters":{ "mam.queries":108, "mam.rowsRetained":340, "mam.pagesEmpty":4,
               "room.joins":10, "render.MessageList":1840, "scroll.writes":96 } }
```

Four rules make this reviewable rather than merely structured:

1. **`id` is a registry key** (`family/name`), not prose. Meaning resolves from
   `docs/ANOMALY_INVARIANTS.md`, so a review loads the log plus one registry file rather than the
   codebase. This is the property that makes a *recurring* review affordable.
2. **`sev` is `bug` | `suspect` | `drift`**, so triage is mechanical instead of a judgement call on
   every pass.
3. **Crumbs are tuples, not objects** — roughly 4× smaller, and a day stays readable.
   `expected` and `observed` are arbitrary JSON values, not necessarily numbers.
4. **Privacy identical to `logger.ts`**: domains and ids only, never bodies or JID local parts.
   Enforced by a test (§7.3). It is dev-only and local, but the crumb helpers are shared and a log
   pasted into an issue must not leak.

### 4.1 Breadcrumbs

The single highest-value element. Without them a record reads `expected 0, observed 3` and is not
actionable. With a bounded ring of preceding domain events, each record is a self-contained
mini-repro. Ring size is fixed, so cost is constant in session length.

---

## 5. Detector catalogue (first slice)

Where a pure recompute function already exists, the detector **runs it as an oracle and diffs**,
rather than encoding a second copy of the rule that can drift from the product.

### 5.1 `read-state/`

| id | check | sev | catches / does not catch |
|---|---|---|---|
| `badge-vs-pointer` | run `recomputeCountsFromPointer` (`stores/shared/notificationState.ts:637`) against the archive, diff vs displayed `unreadCount` | bug | Catches a **stale** count — a missed recompute. Does **not** catch a wrong pointer: same function, same answer |
| `pointer-regression` | every pointer write must satisfy `isAhead` (`stores/shared/readPointer.ts:89`) | bug | The forward-only violation from #1076, which is unrecoverable once it lands |
| `unread-survives-focus` | active + focused + at live edge for >2s, yet `unreadCount > 0` | bug | The "badge will not clear" class |

**Evaluation trigger and the settling problem.** `badge-vs-pointer` is not free-running: a naive
implementation would fire constantly, because during a normal recompute the displayed count and the
pointer legitimately disagree for a short window. It must therefore be:

- evaluated on `conversationMeta` / `roomMeta` store change, debounced 500ms; and
- suppressed while a recompute is in flight for that conversation, resuming only once the store has
  quiesced.

A detector that fires during normal settling is indistinguishable from one that found a bug, and by
§6.1 it would be deleted. Getting this trigger right is the difference between the detector being
worth building and being noise.

### 5.2 `xmpp-traffic/`

| id | check | sev | note |
|---|---|---|---|
| `mam-page-yield` | rows returned vs rows retained per query | drift | ~4 zero-yield pages observed on 2026-07-29 |
| `redundant-query` | same disco/vcard/MAM target re-queried within a window | suspect | 10 room-joins per room observed; quantify before calling it normal |
| `iq-unanswered` | outbound IQ with no result within 30s | bug | **Blocked on `onStanzaOut`.** First slice approximates via module events; full version deferred |

### 5.3 `scroll/`

`reassertLoopMonitor`, `slowCorrectionMonitor`, `resizeLoopMonitor` and `stallSentinel`
**already detect correctly** — they only emit prose. Re-pointing them at the recorder is a sink
change, not new detection logic: the lowest-risk way to prove the pipe end to end.

New: `fab-at-live-edge` (FAB visible while the list is at the bottom) and `jump-target-miss` (target
row not in viewport after a go-to-message settles).

### 5.4 `resource/`

No pass/fail. Digest counters only — renders per route and component, IDB writes, memory delta
across room switches, stall count — compared against baseline. `sev: drift` by construction.

---

## 6. The review loop

- **`docs/ANOMALY_INVARIANTS.md`** — registry keyed by `id`: what the invariant means, likely
  causes, where to look.
- **`docs/anomaly-baseline.json`** — committed digest baseline for drift comparison.
- **`/fluux-anomaly-review` skill** — reads the last 7 days of JSONL by default, groups by `id`,
  diffs digest against baseline, reports. It **reports findings; it does not fix them.** Findings
  become issues.
- **Cadence** — invoked manually, optionally driven by `/loop`.

### 6.1 The maintenance hazard, named

**Baseline rot.** When a drift is accepted, the baseline must be updated in the same commit.
Otherwise the review cries wolf on every run and stops being read — which kills this system more
reliably than any bug it might catch.

Same rule for detectors: **a detector that produces false positives is deleted, not tuned
indefinitely.** Trust in the log is the actual asset being protected.

---

## 7. Verification

### 7.1 Detector unit tests

Each detector is a pure function with timestamps and state passed in, matching the existing sentinel
style (`stallSentinel.ts`, `reassertLoopMonitor.ts`). Every detector lands with **both**:

- a firing case, and
- a **control case proving it stays silent on healthy input**.

A break-check alone is necessary but not sufficient — a detector that fires on everything passes a
firing test. Hollow tests are this repository's recurring defect class.

### 7.2 CI dead-code assertion

Build production, grep the bundle for the sentinel string exported from `gate.ts`. Present ⇒ **fail
the build**. This converts "zero production cost" from a claim into a build invariant, and catches
the regression where a refactor moves a guard or adds an unguarded import.

### 7.3 Redaction test

Sample records — including breadcrumbs — through an assertion that no body text and no JID local
part survives serialization.

### 7.4 Playwright

Memory sink asserted in the demo and scroll suites.

### 7.5 Standard gates

`npm test`, `npm run typecheck`, `npm run lint`. `npm run test:scroll` for the §5.3 stage.
`cargo test --locked` and `cargo clippy --locked -- -D warnings` for the append command.

---

## 8. Sequencing

Four families is a large first landing. Each stage below is independently useful and independently
revertable.

| Stage | Content | Proves |
|---|---|---|
| 1 | Gate, schema, recorder, sinks, CI assertion, registry skeleton | Production cost is zero and stays zero |
| 2 | Fold in existing scroll sentinels | The pipe works end to end, with **no new detection logic** |
| 3 | `read-state/` detectors | Oracle pattern on the most bug-dense area |
| 4 | `xmpp-traffic/` detectors | Traffic health, minus the `onStanzaOut` gap |
| 5 | `resource/` counters + baseline + review skill | Drift detection closes the loop |

Stage 1 ships no detectors deliberately: the elimination guarantee is the part that must be correct
before anything else is built on it.

---

## 9. Out of scope

- Remote telemetry, any network transport, any consent flow.
- Production-build instrumentation. The gate makes enabling it a one-line change if that decision
  ever changes.
- `onStanzaOut` in the SDK, and therefore the complete `iq-unanswered` detector.
- Automatic fixing of anomalies. The review reports; a human triages.
- E2EE-specific detectors. The 614 lines of repeating E2EE output that motivated §1 are a strong
  candidate for a later family, but classifying them needs protocol judgement this slice does not
  attempt.
