# Anomaly invariant registry

Every `id` emitted into `anomalies.YYYY-MM-DD.jsonl` has an entry here. A review loads
**this file plus the log**: not the codebase. That is what makes a recurring review
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

- `sev`: `bug` (an invariant broke), `suspect` (probably wrong, needs a look),
  `drift` (a rate moved; not a failure).
- `tokenKeyId`. **a hard correlation boundary.** Never join records across two
  different values: they are disjoint token spaces, so the same `c:` token in each
  refers to different entities.
- `c:unresolved`. **not an identity.** Never correlate two of them with each other.
- `s:` refs are session-local. Never correlate them across `sid` values.

Digest records summarize one recorder window. `counters` are raw quantities,
`suppressed` restores anomalies hidden by the per-id cooldown, and each `rates` entry
keeps its numerator `n` and denominator/sample count `d` together. `env` supplies the
platform context needed to compare those rates.

An anomaly record carries up to the last 50 breadcrumbs, oldest first. Every crumb
starts with its age in milliseconds relative to the record: `[ageMs, tag, ...]`. The
age is per event rather than relative to session start, so it says how shortly before
this record the event was observed without adding another absolute timestamp.

| crumb shape | Meaning |
|---|---|
| `[ageMs, "focus"\|"blur"]` | The window entered or left the foreground |
| `[ageMs, "activate", entity]` | A conversation or room became active; `entity` is a privacy-safe token |
| `[ageMs, "deactivate"]` | The last active conversation or room closed |
| `[ageMs, "msg:in"\|"msg:out", entity]` | The newest arrival transition for that conversation or room |
| `[ageMs, "perf:persist"\|"perf:merge-archive", durationMs]` | A store persistence or archive-merge operation took at least 50 ms; duration is rounded milliseconds |

## Running the review

From the repository root:

```bash
npm run anomaly:review
```

The command reads the last seven UTC days from the platform's Fluux log directory.
Pass options after npm's `--`: `--dir <path>` for another directory, `--days <n>` for
another window, and `--json` for machine-readable output. It reports malformed or
unsupported records instead of silently omitting them; legacy v1 digests without
`rates` or `env` still contribute their counters and suppressed anomalies.

Rate evidence is grouped by build and by platform and engine together. Windows with less than
20% foreground time are excluded from rate aggregation, but their anomalies and raw
counters remain in the report. A rate gets a verdict only when it is not marked
informational, has at least the baseline's `minSamples`, and has an accepted entry in
`docs/anomaly-baseline.json`. The default tolerance is 30% of that accepted rate.

Pruning is explicit, never a side effect of inspection:

```bash
npm run anomaly:review -- --prune
```

That removes complete UTC-day files older than 30 days by default; override the
boundary with `--retention <days>`.

## Recorder health

These describe the recorder itself, not the app.

| id | Meaning | What to do |
|---|---|---|
| `recorder/session-start` | One per session, written once the tokenizer holds its key | Its absence means the runtime never installed. Its `tokenKeyId` opens the session's token space |
| `recorder/ceiling-reached` | 500 records or 2 MB in one session; recording stopped | Something fired in a loop. Find the last repeated `id` before it |
| `recorder/entity-warm-failing` | Entity tokenisation has failed `observed` times in a row. Records for that conversation are still written but name `c:unresolved`, so they cannot be correlated | The tokenizer holds its key (startup is excluded), so this is a real `crypto.subtle` failure. Reported once per episode and again only after a recovery, its absence is meaningful  |

Counter names (digest only, not invariant ids):

| counter | Meaning | What to do |
|---|---|---|
| `recorder/rejected-value` | A detector passed a value with the wrong provenance or category; the record was dropped | A detector bug. Nothing reached disk, but the evidence is lost |
| `recorder/localref-overflow` | The 2 000-ref map was full and all refs pinned; a crumb was omitted | Usually a leak: something retains refs without releasing |
| `recorder/token-unresolved` | A token was requested before it was warmed | Rare is fine. Sustained means the pre-warm is missing a lifecycle event |
| `recorder/token-warm-failed` | A background token warm started by a synchronous lookup rejected | Check `recorder/entity-warm-failing` in the same session. Sustained failures mean `crypto.subtle.sign` is unavailable or failing |
| `recorder/dropped-not-ready` | Records refused because the tokenizer had no key yet | A few at startup are normal. Sustained means the tokenizer never initialised, check `fluux.log` for the warning  |
| `recorder/sink-write-failed` | A sidecar append failed | Check `fluux.log`: failures mirror there, because a broken sink cannot report itself  |

## Recount deferrals

The same privacy-safe tallies have two read-only diagnostic views:

- `recount.deferred.<chat|room>.<reason>` in anomaly digest counters, reported as
  deltas for each digest window.
- `Unread recount deferrals (cumulative)` in an exported XMPP console log,
  reported as process-lifetime totals with separate Chat and Room sections.

An unread recount is a chain of about twenty guards, most of which decline to count
rather than risk a wrong number. Each is correct alone, but from outside the store they
are indistinguishable: the badge simply keeps its old value. These tallies say which
guard stood down, so a stale badge can be attributed instead of guessed at (issue
#1211).

In an anomaly digest, read the counters **alongside**
`read-state/unread-survives-focus`. That record flags the stale badge episode; the
counter deltas show which guards deferred during the same window.

Both views are split by chat or room but carry no entity id. Recounts for other
entities can contribute to the same digest window; the console export is broader
still because its cumulative totals cover the entire process lifetime.

| reason | Meaning |
|---|---|
| `active-skipped` | The entity was active and the caller did not opt in |
| `no-meta` | No metadata for the entity |
| `pointerless-defer` | No read position ever established; a bare zero cannot be trusted |
| `pending-remote-displayed` | A remote XEP-0490 position is still resolving |
| `no-floor` | Neither a read pointer nor a history floor to count from |
| `history-not-caught-up` | History is partial, so any count would under-report |
| `context-changed` | Cache epoch or storage scope moved underneath |
| `coverage-missing` | No coverage record, so the archive bottom is unknown |
| `coverage-unresolvable` | The coverage bottom no longer resolves in the archive |
| `coverage-short-of-floor` | Coverage does not reach back to the floor |
| `cache-unavailable` | The archive count failed: an IndexedDB error  |
| `recount-superseded` | Another recount for the same entity overtook this one |
| `input-version-changed` | Message inputs changed mid-recount, for example through a live arrival or MAM merge |
| `pointer-changed` | The read pointer moved while the recount was in flight |

`input-version-changed` is the one to watch for #1211: `addMessage` bumps that version
on **every** arrival, so live traffic can invalidate an in-flight recount. The store
keeps the stale-snapshot guard and schedules at most one coalesced trailing recount,
waiting until pending cache writes and archive catch-up are durably ready. A high tally
during the affected window supports that attribution; a high `coverage-missing` points
elsewhere entirely.

## Detector families

Each entry below is added by the stage that introduces it.

### `read-state/`

| id | sev | Meaning | What to do |
|---|---|---|---|
| `read-state/unread-survives-focus` | suspect | A conversation was active, the window focused, and the newest message actually on screen at the archive tail, yet the unread count stayed above zero for `ctx.heldMs`. `observed` is the count | The mark-read path on focus regain did not run or did not stick. Check the read pointer for that conversation and whether a recount overwrote it |
| `read-state/unread-persists` | bug | The same condition was continuously observed 30s later. `observed` is how long it had held; `ctx.peak` is the worst count reached | The mark-read did not merely lag, it did not happen. This is the record that makes the finding actionable |
| `read-state/unread-focus-cleared` | drift | The count genuinely reached zero while the conversation was still active, focused and at the live edge. `observed` is the real end-to-end duration | Not a complaint: the measurement that says how bad an episode was  |

**How to read the three.** Within one `sid`, match records by their conversation or room
token. The `suspect` record fires the instant the threshold is crossed, so its `heldMs`
is always ~2000 and says nothing about severity. A following `unread-persists` proves
that the same badge stayed wrong for at least 30s; a following `unread-focus-cleared`
gives the observed recovery time. If neither follows, the episode's outcome is unknown.

`unread-focus-cleared` is deliberately narrow: it is emitted **only** on a genuine
recovery under observation. Losing sight of an episode any other way, focus lost,
viewport moved, conversation switched, store rebuilt, ends it **silently**. An earlier
revision reported those as clears, which measured how long the detector could watch
rather than how long the badge was wrong.

So the absence of a close record means **the end was not observed**. It does NOT mean
the badge never recovered, the app marks read on focus change and tab switch, so a
badge may routinely clear just after the user looks away, and the per-id cooldown can
also suppress a close when two episodes fall inside one minute. Judge severity from
`unread-persists`, never from a missing `unread-focus-cleared`.

`suspect` rather than `bug` on purpose: the app marks read on focus regain, so a count
lingering briefly is more likely propagation delay than a broken invariant, and `bug`
has to keep meaning "an invariant broke". Promote it if the log shows it is not noisy.

This requires both the **viewport** and the SDK's `windowAtLiveEdge`. The latter alone
is true for any backgrounded conversation parked at the tail, while the viewport alone
can be at the bottom of a resident slice with newer unread messages beyond it. A missed
sampling window ends the episode silently, so suspended timers cannot turn an
unobserved interval into persistence evidence.

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
| `scroll/resize-loop` | suspect | The message-list `ResizeObserver` fired `observed` times in `ctx.elapsedMs` (`expected` is the threshold per window) | Oscillating content (classically a `<video controls>` on WebKitGTK) driving a correction feedback loop. Not itself a failure; a sustained one is   |
| `scroll/slow-correction` | suspect | A scroll correction took `observed` ms (`expected` is the threshold), with `ctx.rows` rows rendered | Reflow cost scaling with the rendered backlog. Correlate with `ctx.rows`: a high count means virtualization is not engaged |

These two are genuine detectors rather than fan-out, so they have **no** matching
`console.warn`:

| id | sev | Meaning | What to do |
|---|---|---|---|
| `scroll/fab-at-live-edge` | bug | The scroll-to-bottom button was shown for `ctx.heldMs` while an independent measurement put the viewport `observed` px from the content bottom, already at the newest message  | Stale `showScrollToBottom` React state: the scroll handler stopped firing after the list returned to the bottom. Not a fault in `shouldShowScrollToBottomFab`, which cannot produce this state |
| `scroll/jump-target-miss` | bug | A go-to-message reported that it applied a position, but the target row landed `ctx.offBy` px outside the viewport, negative above, positive below  | The anchor resolved to the wrong offset, or content grew after the jump settled. `ctx.msg` is the session-local ref for the target |

**Named non-cases**, so a later reader does not think they were forgotten:

- `fab-at-live-edge` does **not** fire while the loaded window has slid up. `fabVisible`
  is `showScrollToBottom || windowSlidUp`, so there the button means "jump to the
  latest", a real affordance, even with the viewport at the bottom of what is loaded.
- `fab-at-live-edge` reads the FAB's `inert` state, not its presence. The button is
  always in the DOM; only its wrapper's `inert` attribute says whether it is offered.
- `jump-target-miss` does **not** fire when the target row is absent from the DOM. That
  is a load or windowing failure with a different cause, and one id with two meanings
  would stop telling a reader where to look.
- `fab-at-live-edge` measures through `utils/viewportScroller.ts`, deliberately not the
  scroll hook's own at-bottom state, a detector reading the suspect value cannot
  disagree with it, and would go silent exactly when the bug is present.

### `perf/`

`stallSentinel` is route-wide and fires for freezes that have nothing to do with
the message list.

| id | sev | Meaning | What to do |
|---|---|---|---|
| `perf/main-thread-stall` | suspect | The main thread was blocked ~`observed` ms (`expected` is the threshold) | Read the age-prefixed crumbs first. A nearby `perf:persist` or `perf:merge-archive` names slow synchronous store work and its duration; without one, investigate layout or other script. The prose line carries the route; the record deliberately does not, because a route contains a JID |

### `resource/`

Stage 4 records these rates as **informational** measurements. They appear in the
weekly sweep with their numerator, denominator, size-class mix, and foreground share,
but they never produce `ok` or `drift` and must not be added to the baseline yet.

| rate | Numerator / denominator | Why it is informational |
|---|---|---|
| `render.MessageList/roomSwitch` | Message-list renders / conversation or room switches | Conversation and room arrivals are now counted separately, but this rate still divides by switches while renders also scale with arrivals, typing, presence, read-state, scroll, and resize |
| `scroll.writes/positioning` | Re-assert-loop scroll writes / positioning operations | The frame-loop signal does not yet distinguish a scroll call being issued from geometry actually moving |

`apps/fluux/src/anomaly/values.ts` owns these pairings and their judgeability. Before
stage 5 makes either rate judgeable, also resolve the build-stamp limitation documented
in `docs/anomaly-baseline.json`: dirty rebuilds from one short HEAD currently share a
series.
