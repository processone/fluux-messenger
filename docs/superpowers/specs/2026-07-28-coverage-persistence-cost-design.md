# Coverage persistence cost — measurement and decision (#1138)

Follow-up to [#1133](2026-07-24-throttled-persist-design.md), which added a per-key
leading+trailing persistence throttle and force-flushed every structural gap and coverage
transition. Its §4.2 flagged the coverage half as *deliberately conservative* and deferred the
measurement here.

**Result: the conservatism cost the entire benefit of the throttle on a first session.** On the
reference 400-conversation profile, the shipped implementation wrote exactly as many times, and
serialized exactly as many bytes, as the pre-#1133 write-on-every-mutation code it replaced.

---

## 1. Method

Two harnesses, both driving the **real** stores through their real persistence funnels.

### 1.1 `packages/fluux-sdk/bench/persistCost.bench.ts` — write counts

```bash
npm run bench:persist -w @fluux/sdk
```

Counts `JSON.stringify` calls, `localStorage.setItem` calls, bytes and CPU per storage key, under a
counting object mock. Results land in `bench/results/persistCost.json`.

Five variants, all exercising the same store code so the comparison isolates the persistence rule:

| Variant | What it is |
|---|---|
| `legacy` | pre-#1133 — `schedule` made to write through, which is byte-for-byte what the replaced call sites did |
| `merged` | #1133 as shipped — every coverage `bottomId` change force-flushes, re-created over the shipped primitives |
| `coverageThrottled` | the **ceiling** for candidate 2: coverage dropped from structural detection entirely. Not shippable — it loses replacement durability — but it bounds the achievable win |
| `allThrottled` | pure throttle, no structural detection at all. Bounds **candidate 1**, which can only ever recover the window-closing part of a structural write, never the write itself |
| `optimized` | what this change ships |

Wall clock is simulated with fake timers (the throttle window is a `setTimeout`), `performance` is
left real. Real catch-up is paced by MAM round-trips at `concurrency = 2`
(`MAM.catchUpAllConversations`), so **inter-merge spacing** is the axis that matters and every
scenario runs at 0 / 25 / 100 ms — 25 ms ≈ a 50 ms RTT, 100 ms ≈ a 200 ms mobile RTT.

Checking out the parent commit was rejected as the baseline: it would vary the store as well as the
persistence rule, which is not the comparison the issue asks for.

### 1.2 `packages/fluux-sdk/bench/browser/` — main-thread blocking

```bash
npm run bench:persist:browser -w @fluux/sdk
```

Vite + Playwright, driving the same store in **Chromium and WebKit** against each engine's real
`localStorage`, where `setItem` is a synchronous disk write. WebKit is the engine behind the
iOS/macOS WebView and the Linux WebKitGTK build.

Both rules run in-page over identical mutations: `rule1133` is re-created by reporting an
invalidation for every changed `bottomId` (exactly what that version force-flushed on), `rule1138`
is the code as it now stands.

`blockedMs` sums per-mutation deltas, which **WebKit quantizes to 1 ms** — at 400 samples that is
enough rounding noise to swamp the quantity. The comparable figure is `probedMs`: a 50-write batch
timed as one block gives a per-write cost above the quantum, multiplied by the writes each rule
actually performed.

---

## 2. Results

Reference profile: 400 conversations, each with a full `lastMessage` in `conversationMeta` —
a **238 KB** chat blob. Rooms carry coverage in their own small key (~12 KB), which is the storage
shape difference the issue asks about.

### 2.1 Writes and bytes (25 ms spacing)

| Scenario | legacy | merged (#1133) | ceiling | **optimized** |
|---|---|---|---|---|
| S1 cold coverage bootstrap, chat | 400 / 88.9 MB | **400 / 88.9 MB** | 11 / 2.4 MB | **11 / 2.4 MB** |
| S2 warm session, chat | 400 / 92.3 MB | 11 / 2.5 MB | 11 / 2.5 MB | 11 / 2.5 MB |
| S3 Phase B stitch (50 × 10 pages), chat | 500 / 115.5 MB | **500 / 115.5 MB** | 14 / 3.2 MB | **14 / 3.2 MB** |
| S4 forward catch-up churn (180 mutations) | 180 / 41.6 MB | 21 / 4.9 MB | 21 / 4.9 MB | 21 / 4.9 MB |
| S5a cold coverage bootstrap, rooms | 400 / 4.90 MB | 400 / 4.90 MB | 11 / 0.13 MB | 12 / 0.14 MB |
| S5b Phase B stitch, rooms | 500 / 11.2 MB | 500 / 11.2 MB | 14 / 0.31 MB | 15 / 0.34 MB |
| S6 gapped forward catch-up (10 × 3 pages) | 30 / 6.4 MB | 30 / 6.4 MB | 30 / 6.4 MB | **30 / 6.4 MB** |

The three findings:

1. **On the cold path #1133 was worth nothing.** S1 and S3 are identical for `legacy` and `merged`.
   Every merge created or advanced a record, every one force-flushed, and `flushKey` closes the
   window — so every mutation took a fresh leading edge, which is precisely the pre-throttle
   behaviour.
2. **The throttle was already working everywhere else.** S2 (warm) and S4 (the original
   180-mutation workload) show `merged` at the ceiling. Nothing in this change touches them.
3. **S6 is unchanged by design.** Gap formation and boundary advance stay force-flushed;
   `optimized` matches `merged` exactly.

The room numbers make the shape difference concrete: the same 400 forced writes cost 4.9 MB against
a dedicated key versus 88.9 MB against the chat blob. Frequency was always the problem, not record
size — as #1133's own §4.2 said. `optimized` is one write above the ceiling for rooms: the first
coverage write of a session has no baseline, cannot rule out a removal, and force-flushes. One small
write, deliberately kept.

### 2.2 Main-thread blocking, real engines

Per-write cost measured on this machine (Apple silicon, 238 KB blob): **Chromium 1.09 ms,
WebKit 0.86 ms**. That figure moves with machine load across runs (observed 0.8–1.3 ms); the
**write counts and bytes are exact and run-invariant**, so the ratio is the stable quantity and the
absolute milliseconds are the order of magnitude.

| Engine | Scenario | writes | MB | probedMs | blockedMs |
|---|---|---|---|---|---|
| Chromium | bootstrap / #1133 | 400 | 88.9 | 437.6 | 1033.5 |
| Chromium | bootstrap / **#1138** | **12** | **2.7** | **13.1** | **53.9** |
| Chromium | stitch / #1133 | 500 | 115.5 | 547.0 | 1349.3 |
| Chromium | stitch / **#1138** | **14** | **3.2** | **15.3** | **68.2** |
| WebKit | bootstrap / #1133 | 400 | 88.9 | 344.0 | 860.0 |
| WebKit | bootstrap / **#1138** | **13** | **2.9** | **11.2** | **40.0** |
| WebKit | stitch / #1133 | 500 | 115.5 | 430.0 | 1119.0 |
| WebKit | stitch / **#1138** | **15** | **3.5** | **12.9** | **65.0** |

**~0.8 s of main-thread time removed from the launch window** on desktop-class hardware
(bootstrap + stitch, either engine), along with ~200 MB of serialization.

No single mutation exceeded 50 ms in any run — the worst was ~6 ms. This was never one long task;
it is 900 chunks of 1–6 ms spread across the launch window, competing with first paint, stanza
parsing and IndexedDB commits. On phone-class hardware the per-write cost is several times higher.

---

## 3. Decision

**GO on candidate 2** (thread explicit transition semantics out of the merge functions).
**NO-GO on candidate 1** (a `flushKey` variant that leaves the timer armed), for now.

### 3.1 Why candidate 2

The measured win is the whole first-session cost, and it is available without weakening any
durability guarantee — because the transition that must survive a hard kill is a strict subset of
what #1133 force-flushed, and the subset is decidable at the merge.

### 3.2 Why not candidate 1

Candidate 1 can only recover the *window-closing* half of a structural write, never the forced write
itself. Measured with `allThrottled` as its lower bound:

| Scenario (25 ms) | merged | candidate-1 lower bound (`allThrottled`) |
|---|---|---|
| S6 gapped forward catch-up — every write structural | 30 | 2 |
| S7 gap transitions interleaved with 5× ordinary churn | 61 | 6 |

S6 is the honest reading: when every mutation is structural — which is the shape of a multi-page
gapped catch-up — candidate 1 saves **nothing**, because each forced write must still happen. Its
entire value is S7's mixed shape, where it would coalesce the ordinary writes that currently take a
fresh leading edge behind each flush: roughly 61 → ~31, a 2× improvement on a gap-heavy workload.

Real, but an order of magnitude smaller than candidate 2's 36×, on a workload that is not the
cold-start profile this issue is about — and it is a semantic change to a primitive that
`recordPendingRetraction` also uses and that *wants* the window closed. #1133 said it "needs its own
change with its own tests, not a rider on this one"; that still holds. The scenario, the bound and
the harness are committed, so it can be picked up on its own evidence.

After this change the remaining force-flush paths are gap formation/boundary advance (≤ 3 per
gapped entity per catch-up), coverage replacement and removal (both rare), and one write per key per
session for the unknown baseline. There is not much left for candidate 1 to multiply.

---

## 4. Design

### 4.1 The classification has to come from the merge

The unsafe transition is *an existing record being overwritten by a walk that did not prove
contiguity with it* — `syncCoverageAfterArchiveMerge`'s fetch-latest branch with `sawCoverageTop`
false and a record present. Every other `bottomId` change errs **shallow** when lost:

| Transition | Loss on a hard kill | Treatment |
|---|---|---|
| `created` | disk holds NO record. The next session re-seeds from the local downloaded edge, which is shallower. **Asserts nothing** | throttle |
| `deepened` | disk holds the shallower previous bottom, which is still true. Phase B re-walks covered ground | throttle |
| `topRefreshed` | stale re-entry marker; one extra walked page | throttle |
| `replaced` | **disk keeps the record whose contiguity this walk disproved, and Phase B seeds its backward walk from it — skipping the disconnected interval** | **force-flush** |
| removal | same class as `replaced` | **force-flush** |

`durableMapPersist` cannot derive this: archive ids are non-sequential (`mamGap`), so no comparison
of two `bottomId`s can tell a deepening from a replacement. That is exactly why #1133 was
conservative, and the fix is not a cleverer comparison — it is to ask the one function that knows.

### 4.2 Shape

- `syncCoverageAfterArchiveMerge` returns `{ coverage, transition }` instead of the bare map.
  One funnel, so the classification cannot drift from the transition it describes.
- `durableMapPersist` gains `noteCoverageTransition(key, id, transition)`. Callers report
  **unconditionally**; the policy of which transitions are unsafe lives in the durability layer, not
  as an `=== 'replaced'` literal repeated at three call sites where a fourth unsafe transition would
  mean remembering all of them.
- Coverage **removal stays derived** from the baseline, so `clearConversationCoverage`,
  `clearRoomCoverage`, `deleteConversation` and `removeRoom` need no changes at all.
- The baseline now stores the coverage **id set** rather than id → `bottomId`. Keeping the values
  would invite a future reader to resurrect the comparison this change measured out.

### 4.3 Where the report is made

Both stores report where the value actually **enters the state**, not where it is computed. On the
deferred path — a transition gated behind the IndexedDB commit (`mustGateOnChain`) — reporting at
merge time would arm the flush for a write that still carries the *old* record and leave the real one
throttled. `chatStore` reports in the non-deferred branch and again inside `scheduleDeferredCommit`;
`roomStore` passes it through `saveCoverageToStorage` at both sites.

A signal that somehow found no write to attach to forces one extra flush on the following write,
never skips one.

---

## 5. Tests

Every row of the table is pinned in both directions, because a mutant that force-flushes everything
is perfectly durable and silently undoes the optimization, while a mutant that force-flushes nothing
passes every write-count assertion. Neither is sufficient alone.

- `mamCoverage.test.ts` — every branch's reported transition, `none` included.
- `durableMapPersist.test.ts` — the decision table (`created` / `deepened` / `topRefreshed`
  throttled; signalled `replaced` and derived removal flushed), plus the signal's lifecycle:
  consumed by exactly one write, effective even when the write omits the coverage map, dropped by
  `cancelDurableMaps` and `forgetAllDurableMapBaselines`.
- `chatStore.persist.test.ts` / `roomStore.throttledPersist.test.ts` — the same properties driven
  through real store actions, since module tests cannot see whether the funnels are wired.

**Control runs, both directions** (§5.5 of #1133's spec — hollow tests are this repo's recurring
defect):

| Mutation | Tests that went red |
|---|---|
| `noteCoverageTransition` made a no-op | 5 — the module's replacement + signal-lifecycle rows, **and both stores' end-to-end `persists a coverage REPLACEMENT that was coalesced into an open window`** |
| force-flush restored on every coverage write (#1133's rule) | 6 — `coverage key ADDED stays throttled`, `bottomId DEEPENED stays throttled`, `topId-only stays throttled`, `is consumed by exactly one write`, and both stores' new `coalesces …` tests |

The clear-path signal tests write an **empty** coverage map on purpose. Dropping the baseline makes
the next non-empty write structural on its own, which would mask a leaked signal entirely — §5.5's
"a test cannot cover a guard a preceding guard renders unreachable". With an empty map the unknown
baseline is quiet, so the only thing that can force a flush is a signal that outlived the clear.

---

## 6. What did not change

- Hard-kill durability of gap formation and `start` / `startId` boundary advances (S6 identical).
- Hard-kill durability of coverage replacement and removal.
- Synchronous durability of pending retractions — `flushKey` and its window-closing semantics are
  untouched, which is also why candidate 1 stays out of this change.
- Account-switch flushing, cancel-before-remove, Tauri's synchronous shutdown flush, lazy
  serialization, per-key throttle isolation.
