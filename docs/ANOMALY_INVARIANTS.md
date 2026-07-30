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

| id | sev | Meaning | What to do |
|---|---|---|---|
| `read-state/unread-survives-focus` | suspect | A conversation was active, the window focused, and the newest message actually on screen, yet the unread count stayed above zero for `ctx.heldMs`. `observed` is the count | The mark-read path on focus regain did not run or did not stick. Check the read pointer for that conversation and whether a recount overwrote it |

`suspect` rather than `bug` on purpose: the app marks read on focus regain, so a count
lingering briefly is more likely propagation delay than a broken invariant, and `bug`
has to keep meaning "an invariant broke". Promote it if the log shows it is not noisy.

This uses the **viewport**, not the SDK's `windowAtLiveEdge` — the latter is true for
any backgrounded conversation parked at the tail, so it is not evidence anyone saw
anything.

_(stage 5 adds `badge-vs-pointer` and `pointer-regression`, both of which need SDK
seams that do not exist yet.)_

### `xmpp-traffic/`

_(stage 5: `mam-page-yield`, `redundant-query`, `iq-unanswered`)_

### `scroll/`

The first four entries are **fan-out, not new detection.** The monitors in
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

These two are genuine detectors rather than fan-out, so they have **no** matching
`console.warn`:

| id | sev | Meaning | What to do |
|---|---|---|---|
| `scroll/fab-at-live-edge` | bug | The scroll-to-bottom button was shown for `ctx.heldMs` while an independent measurement put the viewport `observed` px from the content bottom — already at the newest message | Stale `showScrollToBottom` React state: the scroll handler stopped firing after the list returned to the bottom. Not a fault in `shouldShowScrollToBottomFab`, which cannot produce this state |
| `scroll/jump-target-miss` | bug | A go-to-message reported that it applied a position, but the target row landed `ctx.offBy` px outside the viewport — negative above, positive below | The anchor resolved to the wrong offset, or content grew after the jump settled. `ctx.msg` is the session-local ref for the target |

**Named non-cases**, so a later reader does not think they were forgotten:

- `fab-at-live-edge` does **not** fire while the loaded window has slid up. `fabVisible`
  is `showScrollToBottom || windowSlidUp`, so there the button means "jump to the
  latest" — a real affordance, even with the viewport at the bottom of what is loaded.
- `fab-at-live-edge` reads the FAB's `inert` state, not its presence. The button is
  always in the DOM; only its wrapper's `inert` attribute says whether it is offered.
- `jump-target-miss` does **not** fire when the target row is absent from the DOM. That
  is a load or windowing failure with a different cause, and one id with two meanings
  would stop telling a reader where to look.
- `fab-at-live-edge` measures through `utils/viewportScroller.ts`, deliberately not the
  scroll hook's own at-bottom state — a detector reading the suspect value cannot
  disagree with it, and would go silent exactly when the bug is present.

### `perf/`

`stallSentinel` is route-wide and fires for freezes that have nothing to do with
the message list.

| id | sev | Meaning | What to do |
|---|---|---|---|
| `perf/main-thread-stall` | suspect | The main thread was blocked ~`observed` ms (`expected` is the threshold) | Any freeze class, including ones with no React render. The prose line carries the route; the record deliberately does not, because a route contains a JID |

### `resource/`

_(stage 4: rates with denominators; no pass/fail)_
