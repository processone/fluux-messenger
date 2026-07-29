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
