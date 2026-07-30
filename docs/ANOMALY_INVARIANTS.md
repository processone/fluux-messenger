# Anomaly invariant registry

Every `id` emitted into `anomalies.YYYY-MM-DD.jsonl` has an entry here. A review loads
**this file plus the log** — not the codebase. That is what makes a recurring review
affordable rather than a re-derivation of "normal" every time.

Design: `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md`.

This file and the `ID` registry in `apps/fluux/src/anomaly/values.ts` are independent,
so their parity is asserted by a test in `values.test.ts` rather than assumed.

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

| id | Meaning | What to do |
|---|---|---|
| `recorder/session-start` | One per session, written once the tokenizer holds its key | Its absence means the runtime never installed. Its `tokenKeyId` opens the session's token space |
| `recorder/ceiling-reached` | 500 records or 2 MB in one session; recording stopped | Something fired in a loop. Find the last repeated `id` before it |

Counter names (digest only, not invariant ids):

| counter | Meaning | What to do |
|---|---|---|
| `recorder/rejected-value` | A detector passed a value with the wrong provenance or category; the record was dropped | A detector bug. Nothing reached disk, but the evidence is lost |
| `recorder/localref-overflow` | The 2 000-ref map was full and all refs pinned; a crumb was omitted | Usually a leak: something retains refs without releasing |
| `recorder/token-unresolved` | A token was requested before it was warmed | Rare is fine. Sustained means the pre-warm is missing a lifecycle event |
| `recorder/dropped-not-ready` | Records refused because the tokenizer had no key yet | A few at startup are normal. Sustained means the tokenizer never initialised — check `fluux.log` for the warning |
| `recorder/sink-write-failed` | A sidecar append failed | Check `fluux.log` — failures mirror there, because a broken sink cannot report itself |

## Detector families

Each entry below is added by the stage that introduces it.

### `read-state/`

_(stage 3: `unread-survives-focus`; stage 5: `badge-vs-pointer`, `pointer-regression`)_

### `xmpp-traffic/`

_(stage 5: `mam-page-yield`, `redundant-query`, `iq-unanswered`)_

### `scroll/`

These are **fan-out, not new detection.** The monitors in
`apps/fluux/src/components/conversation/` decide, log their prose to `fluux.log`
exactly as they always have, and additionally signal a record. So every id here has
a matching `console.warn` line: when one is puzzling, the prose has the detail that
could not be recorded (overlapping loop labels, the conversation, the scrollHeight).

| id | sev | Meaning | What to do |
|---|---|---|---|
| `scroll/reassert-overlap` | bug | Two or more message-list re-assert loops were alive at once, fighting over `scrollTop`. `observed` is how many; `expected` is 1 | A loop started without superseding the previous one. Historically a second MAM prepend beginning before the first re-assert finished |
| `scroll/reassert-nonconverging` | bug | One loop issued `observed` scroll writes without settling on a stable anchor (`expected` is the threshold) | Two anchors disagree by more than the tolerance and the loop ping-pongs. `ctx.loop` names the loop kind |
| `scroll/resize-loop` | suspect | The message-list `ResizeObserver` fired `observed` times in `ctx.elapsedMs` (`expected` is the threshold per window) | Oscillating content — classically a `<video controls>` on WebKitGTK — driving a correction feedback loop. Not itself a failure; a sustained one is |
| `scroll/slow-correction` | suspect | A scroll correction took `observed` ms (`expected` is the threshold), with `ctx.rows` rows rendered | Reflow cost scaling with the rendered backlog. Correlate with `ctx.rows`: a high count means virtualization is not engaged |

_(stage 3 adds `fab-at-live-edge` and `jump-target-miss` in this family — those are
genuinely new detectors, not fan-out.)_

### `perf/`

`stallSentinel` is route-wide and fires for freezes that have nothing to do with
the message list.

| id | sev | Meaning | What to do |
|---|---|---|---|
| `perf/main-thread-stall` | suspect | The main thread was blocked ~`observed` ms (`expected` is the threshold) | Any freeze class, including ones with no React render. The prose line carries the route; the record deliberately does not, because a route contains a JID |

### `resource/`

_(stage 4: rates with denominators; no pass/fail)_
