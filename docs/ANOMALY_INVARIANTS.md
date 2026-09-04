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

| id | sev | Meaning | What to do |
|---|---|---|---|
| `read-state/pointer-regression` | bug | The read pointer for `ctx.conv` or `ctx.room` was replaced by one `ctx.behindMs` ms behind it, inside a single read-state generation | The forward-only invariant broke, in its unrecoverable direction: read messages are marked unread again and nothing downstream can tell that from new mail (#1076). Find the writer — the viewport observer, XEP-0490, or mark-read |

**Named non-cases:**

- A generation change is never a regression. `chatReadStateGeneration` /
  `roomReadStateGeneration` report a `store` scope (logout, account switch) and an
  `entity` scope (that conversation or room deleted); a move in **either** resets the
  comparison, and the first pointer of a new generation has no predecessor.
- Writing the same pointer twice is idempotence. Only a pointer strictly behind its
  predecessor counts, decided by the SDK's own `isAhead` rather than by a comparison
  this detector invents.
- A pointer being CLEARED is a different event with a different cause, and is not
  reported here.
- The detector observes at most 300 entities. Past that the oldest is dropped, so a
  very large account can miss a regression — it never leaks to keep one.

### `xmpp-traffic/`

Both read the outbound application stanza seam (`subscribeDiagnostics`, kind
`application-stanza-out`) and pair it with the inbound stanzas `onStanza` already
carries.

| id | sev | Meaning | What to do |
|---|---|---|---|
| `xmpp-traffic/redundant-query` | suspect | The same disco, vCard or avatar query went to `ctx.target` again `ctx.elapsedMs` after the previous one had already been answered. `observed` is how many were sent inside the window, `expected` is 1 | A cache that is not being consulted, or a caller re-querying on every presence. `ctx.query` names the kind |
| `xmpp-traffic/iq-unanswered` | bug | An outbound application IQ went `observed` ms with no reply (`expected` is the threshold). `ctx.query` names the kind, `ctx.target` the entity | The peer or server never answered. Read it with the connection crumbs: a reply lost across a reconnect is cleared, not reported |
| `xmpp-traffic/mam-write-failed` | bug | An archive merge for `ctx.target` failed to write `observed` of the `ctx.returned` rows it was given | The IndexedDB transaction did not commit. That entity's durable catch-up cursor is now frozen for the session (`archiveSaveChain.ts`), so the next session refetches from the stale cursor rather than skipping the page. Look for storage pressure or a closed database |

**Named non-cases**, so a later reader does not think they were forgotten:

- Neither id sees connection-level traffic. The keepalive ping and the Stream
  Management `<r/>` bypass the application layer, so a stalled ping or an
  unacknowledged SM request is invisible here by construction.
- `redundant-query` never judges MAM or roster traffic. MAM pages the same archive
  with a different window on purpose, and a roster fetch after a reconnect is
  expected. Only disco, vCard and avatar queries carry a dedupe identity.
- `redundant-query` requires the previous query to have been **answered**. A
  re-query after an error or a timeout is a retry, not a redundancy.
- An avatar `data` and `metadata` fetch to one JID are two different queries: the
  PubSub node is part of the identity, as is a disco `node`.
- `iq-unanswered` clears everything in flight on disconnect and on reconnect. A
  request outstanding when the connection drops is unanswerable through no fault of
  the app.
- An IQ whose transport write failed is still reported as outbound. The seam reports
  the hand-off to the transport, not the socket write; the connection reset that
  follows clears the pending entry.

More named non-cases, for the archive merge:

- A `partial` merge is **not** recorded. It means an earlier page for the same entity
  failed — and that page recorded it. One fault, one record.
- Only a merge is observed, never a protocol query. Chat walks reach the store as one
  accumulated set, while forward room walks can arrive per page; neither store event
  retains the collector's per-query id.

The merge yield itself is a RATE, not an id: severity `drift` is judged only on rates
(design §5.4). See `mam.rowsRetained/rowsReturned` under `resource/`.

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
| `scroll/live-edge-pin-short` | suspect | A live-edge pin run reported itself `settled` while the viewport was still `observed` px beyond the executor's own at-bottom threshold, and it was **still** there `ctx.heldMs` later | A correction that was asked for and did not arrive. Classically a resident row that grew in place — a reaction, a link preview, a decrypted attachment, a correction, a retraction — whose growth nothing absorbed. `rowGrowthDecision.ts` skips the re-pin when a pin loop already claims the bottom, on the bet that the running loop absorbs it, and that skip is final. The `PIN completed` and `[PinLoopProbe]` lines in `fluux.log` carry the trigger |
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
- `live-edge-pin-short` is the family's only detector of a correction that did **not**
  happen. The other five all need pathological activity, or an action that completed and
  landed wrong; a growth nothing absorbs produces no loop, no write, no resize and no
  slow frame, so it was invisible to all of them.
- `live-edge-pin-short` takes its threshold FROM the executor rather than declaring one.
  A detector judging the pin against a number the pin does not use would report a
  disagreement about the rule instead of a failure to follow it.
- `live-edge-pin-short` sees a growth only when a live-edge run actually settles. A
  growth that `rowGrowthDecision.ts` skips with no loop in flight — the reader judged
  away from the bottom, or an ambient growth refused during a navigation — produces no
  run and so no record. The claim-held bet IS covered, because the loop holding the
  claim reports its own settle.
- `live-edge-pin-short` cannot tell a reader who scrolled away during the hold window
  from a shortfall that persisted, so its `observed` is the distance measured AT THE
  SETTLE and never the later one. The confirmation is a noise filter, not the claim.
  Reported as `suspect` for that reason.

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
| `mam.rowsRetained/rowsReturned` | Rows an archive merge wrote durably / rows that merge received | The quantity is sound — both halves come from one report — but seeding a baseline needs the build-stamp question settled first (see `docs/anomaly-baseline.json`) |

**`retained` means written, not new.** Only the conversation or room on screen keeps a
resident array; a backgrounded entity dedupes against nothing, so its pages are
rewritten in full and its yield sits near 1. That is a fact about where the merge
dedupes, not about how much the catch-up learned. Compare yields within one entity
state, never across them.

`apps/fluux/src/anomaly/values.ts` owns these pairings and their judgeability. Before
making any informational rate judgeable, also resolve the build-stamp limitation documented
in `docs/anomaly-baseline.json`: dirty rebuilds from one short HEAD currently share a
series.
