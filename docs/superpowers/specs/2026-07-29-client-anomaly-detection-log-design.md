# Client anomaly detection log — design

A dev-build-only instrumentation layer that records **invariant violations** and **bounded usage
digests** to a machine-readable sidecar log, so a coding agent can sweep real daily usage on a
recurring cadence and surface bugs and inefficiency without a human first noticing something is
wrong.

Production builds ship **no anomaly JavaScript, no new native command, and no new capability
permission**, and CI asserts both the absence in production and the presence in Dev, rather than
assuming either.

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
| Local only, no transport | Decided | No consent flow, no collector, no remote retention obligation. The review command can explicitly prune local files after 30 days (§3.5) |
| Dev builds only | Decided | Corpus comes from `Fluux Messenger Dev`, demo mode, and Playwright |
| Zero production JS, no new native command, no new permission | Decided | Build-time constant + guarded call sites + build-audit plugin + paired CI assertions (§7.2). One named exception: the stage-5 SDK seams (§5.5) |
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

**Zero SDK changes in stages 1–4.** Stage 5 adds four read-only SDK seams (§5.5).

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

The sidecar is written from JavaScript via `@tauri-apps/plugin-fs` 2.5.1:

```ts
await writeFile(path, new TextEncoder().encode(line + '\n'), { append: true })
```

**`writeFile`, not `writeTextFile`.** They are different Tauri commands with different permissions —
`tauri-plugin-fs-2.5.1` ships separate `write_file.toml` and `write_text_file.toml` autogenerated
permissions. `writeTextFile` invokes `plugin:fs|write_text_file`
(`node_modules/@tauri-apps/plugin-fs/dist-js/index.js:703`), which the capability does **not** grant;
`writeFile` invokes `plugin:fs|write_file` (`:679`), which `fs:allow-write-file` does. The plugin is
already registered (`apps/fluux/src-tauri/src/main.rs:1576`) and the permission is already scoped to
`$HOME/**` (`apps/fluux/src-tauri/capabilities/default.json:51`), which covers the log directory.

**No new permission is added.** That is a hard constraint, not a convenience: every permission in
`capabilities/default.json` applies to the production app, so widening the capability surface for a
Dev-only feature would contradict §2 directly.

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

**Retention happens in `npm run anomaly:review -- --prune`, not in the app.** A startup sweep would need
`fs:allow-read-dir` and `fs:allow-remove`, neither of which is currently granted, and both of which
would widen the **production** native capability surface for a Dev-only feature. The review command
already reads the directory and runs outside the app, so an explicit `--prune` removes files older
than 30 days without widening the app. Inspection alone never deletes them. The app only ever
appends.

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

The envelope — `v`, `t`, `sid`, `build`, `tokenKeyId` — is identical on both kinds.

```jsonc
{ "v":1, "t":"2026-07-29T11:47:02Z", "sid":"9f2c1a04-...", "build":"0.17.2+5abd37a",
  "tokenKeyId":"3b91cc07",
  "kind":"anomaly", "id":"read-state/pointer-regression", "sev":"bug",
  "expected":"ahead", "observed":"behind",
  "ctx":{ "conv":"c:7f3a2b1d40e9c815", "route":"#/chat" },
  "crumbs":[ ["msg:in","c:7f3a2b1d40e9c815","s:m41"], ["ptr:advance",42], ["focus",1] ] }
```

```jsonc
{ "v":1, "t":"2026-07-29T11:50:00Z", "sid":"9f2c1a04-...", "build":"0.17.2+5abd37a",
  "tokenKeyId":"3b91cc07",
  "kind":"digest", "windowMs":300000,
  "counters":{ "render.MessageList":1840, "room.switches":10,
               "scroll.writes":96, "scroll.positioningOps":12 },
  "suppressed":{ "scroll/reassert-nonconverging":47 },
  "rates":{ "render.MessageList/roomSwitch":{ "n":1840, "d":10, "informational":true },
            "scroll.writes/positioning":{ "n":96, "d":12, "informational":true } },
  "env":{ "platform":"macos", "engine":"webkit", "engineVersion":620,
           "sizeClass":"lg", "accounts":1, "foreground":0.94 } }
```

### 4.1 Field rules

1. **`v` is a schema version.** The review tool rejects and reports an unknown major version rather
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
| **Write discipline** | Single-flight queue; max 8 KB per line; over-limit records **drop whole crumbs, then whole optional fields**, and set `"trunc":true`. Strings are never shortened — §4.4 rejects a disallowed string outright rather than emitting a prefix of it. Newlines are rejected in every string value (a newline would forge a second JSONL record) |

#### Write-queue failure semantics

A naive single-flight chain (`q = q.then(write)`) **poisons itself**: one rejected write propagates
rejection to every subsequent link, so a single transient I/O error silently ends logging for the
rest of the session — and the log would look like a healthy quiet day. Required behaviour:

- Every link absorbs its own failure (`q = q.then(write).catch(absorb)`). A failed write is dropped;
  the queue continues.
- Failures increment an in-memory `recorder/sink-write-failed` counter surfaced in the next digest.
- **Failures are also mirrored to `console.warn`.** If the sink is broken, the digest reporting the
  breakage cannot be written either — the prose log is the only channel that still works, and this
  is the one place the two logs must overlap.
- After 10 consecutive failures the sink disables itself for the session, emitting one final
  `console.warn`. A permanently failing path (disk full, revoked permission) must not burn a write
  attempt per record.

**Flush on `visibilitychange` / exit is best effort.** The WebView gives no guarantee that
asynchronous I/O completes during teardown, so the final digest may be lost. The review tool must
therefore treat a missing trailing digest as normal, not as a signal, and never infer session length
from its absence.

### 4.4 Privacy by construction

A sample-based redaction test cannot stop a future detector from logging a body — it only tests the
samples someone thought to write. Neither can TypeScript alone: **branded types vanish at runtime**,
so a cast, an `any`, or a JS-side caller defeats them entirely. Enforcement therefore lives in the
serializer, at runtime.

**The serializer checks provenance, not shape.** A pattern-matching allowlist validates what a
string *looks like*, which is not the same question. A message body equal to `focus`, or to
`c:0123456789abcdef`, or to `s:m41`, would satisfy any shape check — so a detector that accidentally
passed a body through would emit it, and the guarantee would be decorative.

Constrained values are therefore **opaque objects, never primitive strings**, registered in a
module-private `WeakSet` at construction. But `WeakSet` membership only proves *which constructor
ran*, not *where the content came from* — so the two value families need different treatment:

- **`Tag` has no public constructor.** Tags are a closed set of **pre-constructed frozen constants**
  exported by name from `schema.ts` (`TAG.focus`, `TAG.ptrAdvance`, …). There is no `Tag(value)`
  taking a runtime string, because such a function would let `Tag(message.body as any)` emit a body
  that happens to equal `focus` — passing the `WeakSet` check honestly, having been constructed
  honestly. Removing the entry point removes the class of mistake.
- **`Token` and `LocalRef` keep dynamic constructors**, and are safe despite taking runtime input
  precisely because **neither ever re-emits its input**: one emits an HMAC digest, the other a
  sequence number. Passing a body to either is harmless — it yields an opaque value derived from it,
  never the thing itself.

The serializer:

1. **rejects any primitive string** appearing in `expected`, `observed`, a crumb value, or **any
   value in `ctx`** — unconditionally, whatever it contains;
2. accepts an object only if the private `WeakSet` recognizes it, then emits its carried string.

Provenance is what is checked: the value is emitted because *this module made it*, not because it
resembles something this module makes. A body cannot forge membership of a `WeakSet` it was never
inserted into.

Anything else **rejects the whole record** and increments a `recorder/rejected-value` counter in the
digest. It is not truncated. Truncation was the flaw in an earlier revision: a 64-character cap on
an accidentally-supplied body still emits the first 64 characters of that body, which is precisely
the leak the rule exists to prevent. A rejected record is a visible bug in a detector; a truncated
one is a silent disclosure.

The wire format is unchanged — records still serialize to `"c:7f3a…"` and `"focus"` — so the
patterns below remain the *reader's* contract for the review tool. They are simply no longer the
writer's authorization check.

**Two identifier classes, because one mechanism cannot serve both.** JIDs are not the only
identifiers these records carry — MAM breadcrumbs also hold query ids, message ids and stanza ids.
Those two populations behave differently, and a single async-tokenized space fails the second one:

| Class | Examples | Lifetime | Mechanism |
|---|---|---|---|
| **Entity** | bare JID, room, device | Long-lived, seen repeatedly, known before use | `Token` — HMAC, cross-session stable |
| **Ephemeral** | message id, stanza id, MAM query id | Often seen exactly once, unknown until the moment it is recorded | `LocalRef` — synchronous, session-local |

`Token(ns, value)` is HMAC-SHA-256 over `ns + '\0' + value` under a per-install key, rendered as
`c:` + **16 hex chars (64 bits)**, with `ns ∈ {jid, room, device}`. The namespace is part of the
preimage, so the same string in two roles yields two tokens and cannot produce a spurious
correlation. Six hex characters would have been 24 bits, which collides at roughly 4 000 distinct
entities by the birthday bound — plausible over a long-lived install, and a collision silently
merges two conversations' evidence.

`LocalRef(ns, value)` is a **synchronously assigned session-local sequence number**, rendered as
`s:` + a one-letter namespace + an integer (`s:m41`, `s:q7`). It carries no information about the
value, needs no key, and is available in the same tick the crumb is recorded.

Its backing map is keyed by **`ns + '\0' + value`** (or equivalently one map per namespace) — never
by the raw value alone. The namespaces overlap in practice: a stanza id and a MAM query id can be
the same string, and a shared key would hand them one ref, silently asserting an identity that does
not exist. This mirrors the namespacing already in `Token`'s HMAC preimage.

**Eviction is pinned, not LRU.** "Bounded" alone is unimplementable in either direction: an
un-evicted `Map` grows with session length, while a naive LRU can evict a MAM query or IQ that is
*still in flight* and then assign it a **second, different ref** on its next appearance — splitting
one query's evidence across two identities inside a single anomaly record, which is worse than not
recording it. The rule:

- **Pins are ref-counted.** The same ref can appear in several crumbs *and* in an open request at
  once, so a boolean pin would be released by whichever holder finished first while others still
  referred to it. Each reference increments; the crumb leaving the fixed 100-entry ring, or the
  request or timer completing, decrements. An entry is evictable at zero.
- Eviction removes **zero-count entries only**, oldest first, above a cap of 2 000 entries.
- **Under pressure the map stops issuing, it does not grow.** If the cap is reached and every entry
  is still referenced, existing refs are all **kept** — identity is never broken — but **no new ref
  is allocated**: the crumb that wanted one is omitted and `recorder/localref-overflow` is counted.

That last rule is what makes the bound real. An earlier revision chose to keep growing under full
pressure, which is simply an unbounded map with a counter attached. Losing a crumb is a bounded,
counted, visible degradation; growing without limit is not, and reassigning a live ref would corrupt
evidence rather than merely thin it.

**Why ephemeral ids cannot use the async path.** A pre-warmed cache only works when the identifier
is known *before* the breadcrumb. A message or stanza id seen for the first time has no prior event
to warm from, so it would serialize as `c:unresolved` and only acquire a real token after the event
had passed — meaning essentially every ephemeral breadcrumb would collapse into the same sentinel
and become mutually indistinguishable. `LocalRef` resolves this by never being async.

Cost accepted: a `LocalRef` does not correlate across sessions. For message and query identity that
is the correct scope anyway — cross-session correlation of a single stanza is not a question the
review asks. Entity identity keeps cross-session stability via `Token`.

**`c:unresolved` remains possible only for the entity class.** Its current causes and recorder-health
signals are owned by `docs/ANOMALY_INVARIANTS.md`. The review process **must never correlate two
`c:unresolved` values with each other**; they are explicitly not an identity.

- **Key persistence:** 32 random bytes from `crypto.getRandomValues`, generated once and stored in
  `localStorage` under `fluux:anomaly-token-key`. Never derived from account identity, so the token
  space cannot be reversed by guessing JIDs against a known salt.
- **`tokenKeyId` in the common envelope — every record, not only digests.** The first 8 hex chars
  of SHA-256 of the key: a one-way digest, so it discloses nothing. Without it, a key rotation or a
  cleared `localStorage` produces a second, disjoint token space that looks identical to the first,
  and a review spanning the boundary would read two different conversations as one. It cannot live
  in the digest alone, because a short session — or a close before the first flush, which §4.3
  declares normal since the exit flush is best effort — yields anomaly records with no digest at
  all, leaving their tokens unattributable. Eight characters per record is the right price for that.
  The review process treats a `tokenKeyId` change as a hard correlation boundary and refuses to join
  records across it.
- **Raw identifiers never enter a record object.** Not in the breadcrumb ring, not in a generic
  record field, and **not transiently inside the write queue**. Tokenization happens at the
  *call site*, before any value is handed to `record()`.
- **Sync lookup, async pre-warm — entity class only.** WebCrypto is async but detector paths are
  synchronous, so a background tokenizer subscribes to conversation, roster and room lifecycle
  events and populates a bounded LRU (`Map`, 500 entries, keyed by `ns + '\0' + value`) *ahead of
  use*. Crumb recording does a synchronous `Map.get`. A miss emits `c:unresolved` — never the raw
  value — and schedules tokenization so later crumbs can resolve. The ephemeral class bypasses this
  entirely via `LocalRef`, keeping the sentinel scoped to entity-resolution misses.

**Recursive serialization limits.** Max depth 2, max 50 array entries, applied in the serializer —
belt-and-braces against a malformed record shape, not the privacy mechanism itself.

**Adversarial tests.** Three layers, each targeting a mechanism rather than a sample:

1. **High-entropy bodies.** Property-based: bodies of random high-entropy strings; assert no
   substring of length ≥ 8 appears anywhere in sink output, and that the record was *rejected*
   rather than emitted-and-truncated.
2. **Shape-collision bodies.** Bodies set to values a shape check would have accepted — every `Tag`
   constant's string in turn, a string matching `/^c:[0-9a-f]{16}$/`, one matching
   `/^s:[a-z][0-9]+$/`, and `c:unresolved`. All must be **rejected**: they arrive as primitive
   strings and are absent from the `WeakSet`. Under the earlier pattern-based check every one of
   these would have passed.
3. **Forgery attempt.** A hand-built object carrying the same fields as a `Token` but constructed
   outside `schema.ts` must be rejected, confirming the check is `WeakSet` membership and not
   structural duck-typing.
4. **No dynamic `Tag`.** A static test asserts `schema.ts` exports no function producing a `Tag`
   from a runtime string — the API-shape guard for §4.4's first rule. `Token` and `LocalRef` are
   separately asserted never to echo their input: given a body as input, the output must share no
   substring of length ≥ 8 with it.

---

## 5. Detector catalogue

This is the design-time catalogue. Once an id ships, `docs/ANOMALY_INVARIANTS.md` owns its current
record contract, severity, context fields, and named non-cases.

### 5.1 `read-state/`

| id | check | sev | stage |
|---|---|---|---|
| `pointer-regression` | every pointer write must satisfy `isAhead` (`stores/shared/readPointer.ts:89`) | bug | **5 — blocked** |
| `unread-survives-focus` | See the runtime invariant registry | registry | 3 |
| `badge-vs-pointer` | archive-derived recount vs displayed count | bug | **5 — blocked** |

**`pointer-regression` moves to stage 5, because generations are not observable.** "Forward-only"
holds *within* one store generation. Several normal transitions legitimately replace a pointer
wholesale, so the detector needs a **generation identity** to reset on — and the previous revision
claimed that identity was reachable from the signals `recountContextIsCurrent` guards on. It is not:
`chatRecountVersion` and `chatUnreadInputVersion` (`chatStore.ts:548–549`) and `chatCacheEpoch`
(`:566`) are module-private and exported from neither `stores/index.ts` nor `index.ts`.

Only account/storage scope is publicly observable. A rehydration or cache-epoch bump would therefore
be invisible, and every one of them would surface as a false `pointer-regression` — the exact
outcome §6.1 deletes a detector for. Shipping it in stage 3 on partial signals would spend the
system's credibility on its first detector.

It therefore moves to stage 5 behind a `readStateGeneration` seam (§5.5). Its contract, once the
seam exists:

- **resets** whenever the generation changes (account switch, rehydration, store reset);
- **ignores the first observation** in each generation, having no predecessor to compare against;
- **accepts an identical rewrite** — the same pointer written twice is idempotence, not regression.
  Only a strictly-behind pointer within one generation is an anomaly.

`unread-survives-focus` stays in stage 3 because it needs no private generation seam. The runtime
invariant registry owns its current continuity and reset contract, including how the publicly
observable account/storage scope bounds an episode.

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
count with the same coverage gating, and lands in stage 5 (§5.5). Only `unread-survives-focus`
remains in stage 3 — it is the one read-state invariant fully observable from public surfaces.

**Evaluation trigger for stage 5.** When it does land, `badge-vs-pointer` must not free-run — during
a normal recompute the displayed count and the pointer legitimately disagree for a window. It must
be debounced 500ms on `conversationMeta` / `roomMeta` change and suppressed while a recount is in
flight. A detector that fires during normal settling is indistinguishable from one that found a bug,
and by §6.1 it would be deleted.

### 5.2 `xmpp-traffic/`

`onStanza` is **inbound only**. All three detectors land in **stage 5**, but they do not all need
the same seam — and an outbound hook alone is not sufficient for any of them:

| id | check | sev | seam required |
|---|---|---|---|
| `redundant-query` | same disco/vCard/MAM target re-queried within a window | suspect | `onApplicationStanzaOut` |
| `iq-unanswered` | outbound application IQ with no result within 30s | bug | `onApplicationStanzaOut` |
| `mam-page-yield` | rows returned vs rows **retained** per query | drift | MAM outcome seam (§5.5) |

**`mam-page-yield` cannot be built from an outbound hook.** The outbound seam sees the query and the
typed MAM event sees the messages *returned*, but retention is decided later — durable
deduplication and cache writes happen downstream of that event. "Rows retained" is not observable
from either end, so it needs its own outcome seam giving each returned row exactly one disposition
(§5.5). Without that breakdown the detector would report page yield as returned-count, which is not
the quantity in question.

Stage 4 previously claimed partial coverage via module events; that was optimistic — disco and vCard
traffic is not visible in the typed event stream at the granularity these checks need.

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

### 5.4 `resource/` — rates, not raw counts

No pass/fail; drift only. But **raw counters are not a usable baseline**: comparing
`render.MessageList: 1840` against a committed number mostly measures how much the app was used that
day. A quiet day and a fixed regression are indistinguishable, and so are a busy day and a new one.

Every drift metric is therefore a **normalized rate with an explicit denominator**. Stage 4 can
observe two pairings, both informational until their remaining measurement ambiguity is removed:

| Rate | Denominator | Stage 4 status |
|---|---|---|
| `render.MessageList/roomSwitch` | conversation or room switch | Informational: renders also scale with traffic, and room arrivals are not observable separately from MAM merges |
| `scroll.writes/positioning` | positioning operation (live-edge stick, anchor restore, jump) | Informational: the frame-loop signal does not distinguish an issued write from actual movement |

The message-arrival, MAM, and IndexedDB pairings wait for the stage 5 seams that can measure their
denominators without substituting a nearby but different quantity.

Raw counters are still emitted — they are the rate inputs and remain useful for spotting an
absolute explosion — but **drift verdicts are computed only on rates**.

Two further requirements, without which a rate is still misleading:

- **Sample counts travel with every rate**, and the review tool **suppresses a drift verdict below
  a minimum sample size** (default 30 denominator events). Three room switches producing a high
  render rate is noise, not a regression.
- **Environment travels with the digest** — platform, WebView engine and version, window size class,
  account count, and the window's foreground share. A WebKitGTK session and a macOS
  session are not comparable, and a baseline that silently mixes them will drift forever.

### 5.5 SDK seams (stage 5)

Four read-only additions to the SDK public API, each useful beyond this system.

**Boundary rule: the SDK never emits anomaly types.** `Token` and `LocalRef`, and the HMAC key
behind them, belong to `apps/fluux/src/anomaly/`. A seam typed as `queryId: Token` would drag them
into `dist` and contradict "no anomaly-system code enters `dist`". Every seam therefore emits its
own **raw or SDK-opaque** identifier, and the app tokenizes at the recorder boundary — the same
boundary §4.4 already requires for JIDs.

1. **`onApplicationStanzaOut(handler)`** — outbound application stanzas only.

2. **A MAM outcome seam** emitting, once a page has been merged into the cache:

   ```ts
   { queryId: string, outcome: 'durable' | 'partial' | 'failed', returned: number,
     retained: number, deduplicated: number, patched: number,
     intentionallyUnstored: number, persistenceFailed: number }
   ```

   **Every returned row gets exactly one disposition**, and they balance:

   ```
   returned === retained + deduplicated + patched + intentionallyUnstored + persistenceFailed
   ```

   Three dispositions were not enough, because the merge has more real outcomes than that:

   - **`intentionallyUnstored`** — `noLocalStore` messages are filtered out of `persistableMessages`
     deliberately (`chatStore.ts:2844`). Counting them as `persistenceFailed` would invent a storage
     bug; counting them as `retained` would claim a write that never happened.
   - **`patched`** — a duplicate row can still trigger a durable stanza-id backfill
     (`chatStore.ts:2758–2760`). It is neither a plain duplicate nor a plain insert, and folding it
     into `deduplicated` would make a page look inert while it was in fact writing.

   **Emission waits for inserts *and* patches to resolve.** Today those patches are fire-and-forget
   (`void messageCache.updateMessage(...)`), so this seam requires tracking them rather than
   discarding the promise — a small change to product code, not only a new event, and one to plan
   for in stage 5.

   `outcome` is then derived mechanically from `persistenceFailed` and the number of writes
   attempted, so it can never disagree with the counts:

   | `outcome` | Condition |
   |---|---|
   | `durable` | no write failed — **including** a page where nothing was attempted, every row being deduplicated or `intentionallyUnstored` |
   | `partial` | at least one attempted write succeeded and at least one failed |
   | `failed` | writes were attempted and **all** of them failed |

   Unblocks §5.2.

3. **A read-only unread diagnostic** returning **both counts from one validated snapshot**:

   ```ts
   { status: 'exact' | 'deferred' | 'stale', archiveCount?: number, badgeCount?: number }
   ```

   Only `exact` may be compared. `deferred` means the coverage gate declined (the real recount would
   also have declined) and `stale` means the inputs moved during computation — neither is evidence
   of a bug, and treating either as a mismatch would make the detector fire during ordinary
   catch-up.

   Returning both numbers **from the same guarded snapshot** is what removes the need for a public
   revalidation operation: the SDK performs the `recountContextIsCurrent()`-style re-check
   (`chatStore.ts:2478`) internally, where the private versions actually live, and hands out two
   numbers already known to be mutually consistent. The detector compares two integers and needs no
   view of `InputVersions` at all. Exposing versions to the app would have meant publishing internal
   race-guard state as API. Unblocks `badge-vs-pointer` (§5.1).

4. **A scoped `readStateGeneration` signal:**

   ```ts
   { scope: 'store', gen: number } | { scope: 'entity', id: string, gen: number }
   ```

   **The scope is the whole point.** A single global counter would be wrong, because the underlying
   `chatCacheEpoch` is bumped by conversation *deletion* as well as by logout and account switch —
   its own comment says so (`chatStore.ts:560`), and the deletion bump is at `:1525`. A global
   signal would therefore reset every conversation's detector state whenever one unrelated
   conversation was deleted, and a genuine regression elsewhere would be silently forgiven as a
   generation change.

   So: `store` scope for hydration, reset and account switch; `entity` scope for the deletion or
   recreation of one conversation. A detector resets only the state matching the scope it received.

   Unblocks `pointer-regression` (§5.1), and is independently useful to any SDK consumer caching
   derived read state that needs to know precisely what to discard.

**Why `onApplicationStanzaOut` and not `onStanzaOut`.** Several connection-level sends bypass
`XMPPClient.sendIQ` (`core/XMPPClient.ts:1784`) and go straight to the transport — the keepalive
ping at `core/modules/Connection.ts:1088` and the SM `<r/>` nonza at `:1169` among them. A hook at
the application layer would therefore silently miss them, and a name promising *all* outbound
stanzas would be a lie that a future detector would eventually trust.

The alternative — instrumenting the actual transport — is rejected for this slice: it means wrapping
the xmpp.js client's `send` across multiple call sites, on the connection hot path, for signal the
detectors do not need. Connection liveness already has its own health path through the connection
machine. **Consequence to accept explicitly:** `iq-unanswered` cannot see a stalled ping or an
unacknowledged SM request. That is a real coverage gap, named here so the registry entry can say so
rather than implying the detector covers all IQ traffic.

**This is the one exception to "zero production JS."** Unlike everything else in this design, these
seams live in SDK source and therefore ship in `dist` to every SDK consumer, including production
Fluux. They are ordinary API surface, not gated instrumentation — but they are not free, and the
spec should not pretend otherwise:

- Each seam is a **null-check plus, at most, one dispatch** on its path. No payload object may be
  constructed when no handler is registered — the same call-site discipline as §3.3 rule 2, applied
  inside the SDK.
- Stage 5 must **measure the hot-path cost** before merge, following the existing bench pattern in
  `packages/fluux-sdk/bench/`, and report the per-stanza delta with no subscriber attached. The
  budget is "within noise of the unsubscribed baseline"; a measurable regression means the seam gets
  redesigned, not accepted with a note.
- No anomaly-system code enters `dist` — only the seams themselves.

---

## 6. The review loop

- **`docs/ANOMALY_INVARIANTS.md`** — registry keyed by `id`: what the invariant means, likely
  causes, where to look.
- **`docs/anomaly-baseline.json`** — committed digest baseline for drift comparison.
- **`npm run anomaly:review`** — reads the last 7 UTC days of JSONL by default, rejects and reports
  unknown schema majors, groups by `id`, folds in `suppressed` counts, compares rates with the
  baseline, and reports. `--prune` explicitly applies the 30-day retention boundary. It **reports
  findings; it does not fix them.** Findings become issues.
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
- **Queue-poisoning test** — a rejected write must not prevent the next N writes from succeeding,
  and must surface on `console.warn` plus the failure counter (§4.3).
- **Generation-reset test** (stage 5) — account switch, rehydration, and an identical pointer
  rewrite each produce **no** anomaly from `pointer-regression`; only a strictly-behind pointer
  within one generation does (§5.1). A control test in the §7.1 sense: the transitions it covers are
  exactly the ones a naive implementation would report.
- **Ephemeral-ref test** — a message id seen exactly once serializes as a distinct `s:` ref, never
  as `c:unresolved`. This is the regression guard for §4.4's two-class split; without it, a future
  refactor routing ephemeral ids through the async path would silently collapse every such crumb
  into one indistinguishable sentinel.
- **Ref-stability test** — a `LocalRef` for an in-flight query keeps the same value across pressure
  that evicts zero-count entries around it; an entry held by two crumbs plus an open request only
  becomes evictable after **all three** release it (the ref-count case a boolean pin would get
  wrong); and at full pressure existing refs are preserved while a new allocation is refused and
  counted as `recorder/localref-overflow` (§4.4).
- **Generation-scope test** (stage 5) — deleting conversation A must **not** reset
  `pointer-regression` state for conversation B, and a store-scope generation change must reset
  both. This is the control test for the `chatCacheEpoch` conflation described in §5.5.
- **MAM balance test** (stage 5) — every emitted outcome satisfies the five-way identity, with
  explicit cases for a `noLocalStore` page (`intentionallyUnstored`, not `persistenceFailed`) and a
  duplicate page carrying stanza-id backfills (`patched`, not `deduplicated`), plus an assertion
  that emission happens only after the patch promises resolve.

### 7.2 Paired CI assertions

One sentinel string is insufficient: that export could be tree-shaken while other anomaly modules
remain.

**Mechanism: a build-audit Rollup plugin, not a manifest read.** Vite emits no bundler manifest here
— the `manifest` at `apps/fluux/vite.config.ts:79` is the **PWA web-app manifest** inside
`VitePWA({...})`, unrelated to the module graph. The audit is a small local plugin whose
`generateBundle` hook walks every emitted chunk's `modules` collection and fails the build if any
module id resolves under `src/anomaly/`. That inspects the actual graph, which is strictly stronger
than matching chunk filenames — a module inlined into an existing chunk has no distinguishing
filename at all.

CI asserts in **both directions**:

| Artifact | Assertion |
|---|---|
| Production build | Build-audit plugin finds **no** module under `src/anomaly/` in any chunk; the `gate.ts` sentinel string is absent from every emitted asset |
| Dev build (`FLUUX_ANOMALY=1`) | The audit finds the anomaly modules **present**, the sentinel **is** present, and a Playwright smoke run produces at least one record in `window.__fluuxAnomalies` |

The Dev half is what stops a silent regression to "eliminated everywhere, including where it was
supposed to run" — the failure mode that already happened with `import.meta.env.DEV` (§2.1).

No native assertion is needed, because §3.5 adds no native code and no new permission.

### 7.2.1 Gate matrix

`__FLUUX_ANOMALY__` is not simply "dev". Every build path gets an explicit, tested value:

| Build path | Gate | Rationale |
|---|---|---|
| Release desktop + PWA web (`tauri.conf.json`, CI) | **off** | The guarantee in §1 |
| `Fluux Messenger Dev` (`tauri-build.sh` dev identity) | **on** | The daily-driver corpus — the whole point |
| Demo build and Playwright | **on** | Detectors double as CI oracles (§7.4) |
| `npm run dev` / `npm run tauri:dev` | **on** | Where iteration happens; cost is irrelevant there, and an always-off dev server would mean detectors are only ever exercised in CI |

The matrix is asserted directly: a test resolves the define for each configuration rather than
trusting the shell scripts to agree with this table.

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
| 0 | **Fix the `MessageList` probe gate** (§2.1): move `:497` and `:652` off `import.meta.env.DEV` onto `__FLUUX_ANOMALY__`, plus the gate matrix and its test (§7.2.1) | The gate is correct before anything is built on it | none |
| 1 | Schema + constrained serializer, recorder with cooldown/ceiling, single-flight `writeFile` sink, build-audit plugin, paired CI assertions, registry skeleton | Production cost is zero, Dev actually runs, privacy holds at runtime | none |
| 2 | Scroll/stall sentinel **fan-out** | The pipe works end to end with no new detection logic, and the prose log is untouched | none |
| 3 | `read-state/` (unread-survives-focus) + `scroll/` (fab-at-live-edge, jump-target-miss) | Real detectors on state observable from public surfaces alone | none |
| 4 | `resource/` **rates with denominators**, baseline, `npm run anomaly:review` incl. explicit retention pruning | The review loop closes and drift detection starts | none |
| 5 | Four SDK seams (§5.5), then `xmpp-traffic/`, `badge-vs-pointer` and `pointer-regression` | Everything requiring new SDK visibility | four read-only additions, measured (§5.5) |

Stage 0 is separated out because the gate correction is a live pre-existing bug (§2.1) that is worth
landing on its own, and because every later stage depends on the gate being right.

Stage 1 ships no detectors deliberately: the elimination and privacy guarantees are what everything
else rests on. Stage 4 precedes the SDK work so the loop is closed and proven useful before the
public API is extended.

---

## 9. Out of scope

- Remote telemetry, any network transport, any consent flow.
- Production-build instrumentation. The gate makes enabling it a one-line change if that decision
  ever changes.
- A native append command, and therefore any Cargo feature matrix (§3.5).
- Any new entry in `capabilities/default.json`. In-app log pruning is excluded for this reason —
  retention lives in the review command (§3.5).
- Transport-level outbound instrumentation, and therefore `iq-unanswered` coverage of connection
  pings and SM nonzas (§5.5).
- Automatic fixing of anomalies. The review reports; a human triages.
- E2EE-specific detectors. The 614 lines of repeating E2EE output that motivated §1 are a strong
  candidate for a later family, but classifying them needs protocol judgement this slice does not
  attempt.
