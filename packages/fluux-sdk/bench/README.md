# Persistence cost benchmark (#1138)

Measures what the store persistence layer actually costs on a cold start, so a change to the
throttle/force-flush rules can be argued from numbers rather than from reasoning about the rules.

```bash
npm run bench:persist -w @fluux/sdk          # write counts, bytes, CPU (vitest, in-memory)
npm run bench:persist:browser -w @fluux/sdk  # main-thread blocking (Chromium + WebKit, real localStorage)
```

Results land in `bench/results/`. The full method, the variant definitions and the decision they
supported are in
[docs/superpowers/specs/2026-07-28-coverage-persistence-cost-design.md](../../../docs/superpowers/specs/2026-07-28-coverage-persistence-cost-design.md).

Both harnesses drive the **real** stores. Historical implementations are re-created over the shipped
primitives rather than checked out, so every variant exercises the same store code and the only
thing varying is the persistence rule.

Not part of `npm test` — it is a measurement, not an assertion, and it takes far longer than a unit
test. It IS typechecked by `npm run typecheck -w @fluux/sdk`, so it cannot rot silently.

## Outbound seam dispatch (stage 5a)

```bash
npm run bench:seam -w @fluux/sdk
```

The per-stanza cost of the `application-stanza-out` diagnostic published through
`subscribeDiagnostics`, which ships in `dist` to every SDK consumer. The unsubscribed path has to
stay at one handler-registry check. Variants are interleaved and each reports its fastest round:
measured one after another, whichever runs last wins, and a seam can appear to make sending cheaper.

The 2026-09-01 pre-channel baseline (macOS, Node 22) measured 5.5 ns/stanza unsubscribed against a
1.6 ns control call and 261.3 ns with one subscriber. A full `sendStanza` was 52.4 ns unsubscribed
against 318.9 ns with a subscriber. The subscribed path still includes an independent deep stanza
snapshot per subscriber, isolating the transport, Stream Management replay state, and other
observers from mutation.


## Search index cost

```bash
npm run build:sdk
npm run bench:search:browser -w @fluux/sdk
npm run bench:search:browser -w @fluux/sdk -- --check
```

The search benchmark follows the browser benchmark's loopback Vite page, disposable Chromium
and WebKit contexts, typed harness and ignored `bench/results/` output conventions. `--check`
only loads the engines, historical module and shipped conversation corpus; it performs no
index seeding or cost measurement.

Both variants use exactly 50,000 messages generated from the same shipped demo conversations,
with distinct archive identities and fixed minute spacing. `src/utils/fixtures/searchHistory.ts`
is shared with migration tests and archive-service qualification; the measurement itself lives
only in `bench/searchIndex.harness.ts`.

The historical variant loads the actual version-5 `searchIndex.ts` source from Git through a
benchmark-only module, resolving its imports against the same shipped primitives as the candidate.
The default baseline is the version-5 mainline before the filter migration. Set `BENCH_SEARCH_BASE`
to another available version-5 reference if needed; missing history fails rather than substituting
the candidate. No additional checkout, copied helper or app development server is required.
The output records the baseline commit and source digest, candidate commit, working-copy state
and shared-primitives commit. The candidate's pre-facet reading remains distinct from the actual
historical implementation's result.

Each variant gets a fresh browser context. Word-only timings check results against independently
selected corpus IDs. Candidate readings also include migration time, facet row count, document reads
and posting rows for narrow and broad windows. Read instrumentation is limited to the disposable
benchmark context and restored after each window, like the persistence benchmark's storage counters.
This measures local index cost, not server archive behavior. Archive full-text support, continuation,
cancellation and coverage still require separate service qualification.

Results default to `bench/results/searchIndex.browser.json`; set `BENCH_SEARCH_OUTPUT` to retain
an output elsewhere. A comparison reports median/p95 per engine and variant; a candidate's word-only
slowdown must be investigated rather than hidden by the speed of its new filters.
