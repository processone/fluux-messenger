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
