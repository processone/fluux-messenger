# Read-state PR C: restrict the pointer writers

**Date:** 2026-07-28
**Status:** Implemented on `mr/read-state-consolidation-pr-c-b3e094`. This document was
reconciled against the delivered code before the status was changed — D1's `mentionsCount`
claim was narrowed, D5 gained the divider/count-disagreement-on-defer section, and D6b records
a decision taken mid-execution that the approved design did not contain. PR link to be added
when the PR is opened.
**Issue:** [#1081](https://github.com/processone/fluux-messenger/issues/1081) (tracking; closes with this PR)
**Follows:** PR A [#1089](https://github.com/processone/fluux-messenger/pull/1089), PR B0 [#1102](https://github.com/processone/fluux-messenger/pull/1102), PR B [#1155](https://github.com/processone/fluux-messenger/pull/1155)
**Supersedes:** the "PR C — the writers" bullet in
`2026-07-22-read-state-model-consolidation-design.md`

PR B changed *where the count comes from*. PR C removes the pointer writes. It is the last
PR in the `A → B0 → B → C` stack.

## Premise

The read pointer is forward-only, and an erroneous advance is unrecoverable. That is the
entire reason #1081 exists.

PR C removes three *heuristic* writer classes — the outgoing-message inference, the
activation snap, and the MAM outgoing-boundary advance. Fewer heuristics is a real
simplification, and it moves uncertainty toward extra unread rather than an irreversible
forward jump.

**That is not the same as "safer by construction."** Three changes in this PR — D2, D3 and
D4 — *widen* when the pointer moves, each by letting a comparison succeed where it previously
refused. Their safety rests entirely on one precondition: **the comparison is only allowed
when both positions carry an `archiveOrderKey`**, which is what certifies that a pointer's
timestamp is the named message's own. Every widening is therefore gated on key-presence and
must be tested in **both polarities** — keyed advances, keyless refuses. See
[Safety direction](#safety-direction).

## Re-grounding against `main` @ `41cdd8d2`

`main` moved 33 commits during PR B, several inside the functions PR C targets. Every
reference in the parent design was re-verified against the merged code. Five statements no
longer hold, and three of them change the design.

**1. `isAhead` has exactly one production consumer: `advance()`.** The parent design says it
"drives `advance()` for the MDS regressive-publish guard". It does not. The publisher's
regressive guard (`mdsSideEffects.ts`, `consider()`) compares by **message index in the
loaded slice** (`indexOfStanza`) and never calls `isAhead`. `advance()` has four production
call sites: `onMessageReceived`'s outgoing branch, its `userSeesMessage` branch,
`chatStore.applyMigratedReadPointer`, and the room restore merge in `roomStore`. Both
`isAhead` and `advance` are on the SDK public surface (`index.ts`).

The parent design's *effect* claim is still right, by a different mechanism: the publisher
publishes whatever the pointer names, so a pointer that cannot cross a same-millisecond run
yields a published marker that cannot either.

**2. The XEP-0490 comparison is not a timestamp comparison at all.**
`resolveRemoteDisplayed` routes through `onMessageSeen`, which orders **by array index**, and
returns `stash-pending` whenever the local pointer's message is absent from the slice. Its
comment refuses timestamps outright, on the grounds that a migrated pointer's timestamp can
sit on either side of the message it names.

That objection is now discriminable. Only `migrateReadPointer`'s `lastSeenMessageId +
lastReadAt` branch produces such a pointer, and it produces it **without** an
`archiveOrderKey`; every `makeReadPointer`-built pointer has one, and its timestamp *is* the
named message's own. **Key-presence is the predicate that comment lacked.**

**3. The two data-loss guards do not need a new home.** Both stores already re-check both
conditions *independently, after* the guard pass (`chatStore.recomputeUnreadForConversation`,
`roomStore.recomputeUnreadForRoom`), and `pointerlessDefers` now runs *inside*
`recomputeCountsFromPointer` as well (added by the no-mistakes gate's round-2 fix). The
guards have two distinct jobs and only one survives — see
[Guard disposition](#guard-disposition).

**4. The carried "recompute vs unread-only branch" race is already fixed.** It was flagged in
PR B's FIX WAVE 2 re-review, *before* the gate's round-2 fix introduced
`chatUnreadInputVersion` / `roomUnreadInputVersion` — bumped by `addMessage` and re-checked
after every await and inside each `set()`. A count-changing write that leaves the pointer put
now invalidates the in-flight recount. PR C adds a regression test rather than a fix.

**5. `historyFloor` coverage is complete.** It is stamped `?? new Date()` at every creation
path in both stores, and an entity somehow without one hits `if (!floor) return` → defer →
persisted count preserved. The fresh-entity snap therefore has a real replacement.

**6. `treatDelayedAsNew` is NOT `true` at every caller.** The parent design's Deletions table
says "both stores already pass `true`". They do not. The **room live-arrival path** relies on
the `false` default: `roomStore.addMessage` calls `onMessageReceived` with
`{ incrementUnread, incrementMentions }` and no `treatDelayedAsNew`, and its
`isUnseenIncomingMessage` call passes no options at all. For a MUC, `isDelayed` means *history
replay on join*, and suppressing it is deliberate — pinned by "should not increment unread
count for delayed (historical) messages" in `roomStore.test.ts`.

A grep for the literal flag finds only the sites that *mention* it, never the ones that depend
on its default. The option therefore survives in `onMessageReceived` and
`isUnseenIncomingMessage`; only `onActivate` can shed it. See [D8](#d8--folded-in-cleanups-from-the-parent-designs-deletions-table).

## Design decisions

### D1 — Writer #4 collapses into writer #1

The parent design's fourth writer is "a message composed *on this device*". No such
discriminator exists: `isOutgoing = isSentCarbon || bareFrom === myBareJid` for chat and
`isSentCarbon || nick match` for MUC, so a carbon from another device and a nick-misattributed
MUC reflection are both `isOutgoing: true`. Chat has an optimistic local emit carrying our own
`originId`; **groupchat has none** — a room's pointer only ever advances on the server
reflection, matched by nickname. That is precisely the misattribution vector the issue names,
and it is currently the room's only writer-#4 path.

Rather than invent the discriminator, **delete the outgoing branch's pointer write and let an
outgoing message fall through to the `userSeesMessage` branch.** Sending while active, focused
and demonstrably at the live edge then advances the pointer for the same reason any *visible*
message does — not because it is outgoing. A carbon or misattributed reflection arriving at a
**backgrounded** entity advances nothing, which is where the vector bites.

This needs no new field, no registry, and no new writer. It also means the count and the
pointer stay coherent: the `userSeesMessage` branch already commits `unreadCount: 0` together
with the advance, so there is no repeat of the `room-pointer-count-divergence` defect PR B's
gate caught.

Two hazards the current early-return masks, which must be closed in the same change:

- `chatStore.addMessage` passes `incrementUnread: !noteAsTransient` — **not** `!isOutgoing`.
  (Rooms get `incrementUnread: !message.isOutgoing` from the SDK event in `Chat.ts`.) Without
  a guard, chat would `+1` on your own sent message. This asymmetry is pre-existing and
  currently unreachable.
- `newFirstNewMessageId` would place the divider on your own message when the entity is
  active and the window hidden.

Both are closed by gating the `+1` and the divider-set on `!msg.isOutgoing` inside
`onMessageReceived`, at the source, rather than by fixing one caller.

**Concretely**, the shape is: delete the `if (msg.isOutgoing)` early return; add
`!msg.isOutgoing` to the increment gate; and force `firstNewMessageId: undefined` for an
outgoing message in *both* remaining branches. "Falls through to `userSeesMessage`" describes
the pointer and count, not the divider.

**The divider clear survives for a LIVE outgoing message**, whatever the viewport state — the
divider is not the read pointer, and losing "replying dismisses the new-messages line" would be
an unrelated UX regression.

It is **not** unconditional, and the earlier draft of this paragraph was wrong to say so.
Deleting the outgoing early return puts the delayed guard first, so the order becomes
`isDelayed → userSeesMessage → final`. A **delayed outgoing** message therefore follows the
entity's delayed-arrival policy (D8) instead of the outgoing one:

| | Today | After |
|---|---|---|
| live outgoing | clears the divider | clears the divider |
| delayed outgoing, **chat** (`treatDelayedAsNew: true`) | clears | clears — falls past the guard |
| delayed outgoing, **room** (default `false`) | clears | **does not clear** — returns at the guard |

The room row is a deliberate behaviour change, and an improvement: joining a MUC replays your
own past messages carrying `<delay/>`, and a history replay is not evidence that you have read
anything. Dismissing the divider on it is the same "you must have read it" inference this PR
removes everywhere else. The direction is safe — the divider survives, drawing *more* attention
to unread, not less. It needs a test in both polarities and a demo-mode check, since it is
user-visible on every room join.

**`mentionsCount` is the one deliberate loss, and it is narrower than the first draft of this
paragraph claimed.** Before the collapse, the outgoing branch zeroed `mentionsCount`
unconditionally; after it, the zeroing happens only when the send also satisfies
`userSeesMessage`.

That is *not* the same as "replying to a room while scrolled up leaves the @-mention badge
standing", stated generally. `onActivate` returns `mentionsCount: 0` **unconditionally** on
every open (`stores/shared/notificationState.ts`) — pre-existing behaviour, unrelated to this
PR — so a mention that was already standing when the room was opened is cleared by the open
itself, long before any reply. **The loss is observable only for a mention that arrives AFTER
activation while the reader is scrolled up**: an active room with
`ctx.viewportAtLiveEdge !== true`, so `onMessageReceived` takes its final branch and
increments `mentionsCount`; replying then no longer clears that badge.

The direction is more badge, not less, and it is the same "you replied, so you must have read
it" inference this PR removes elsewhere. Confirm it in demo mode with that exact sequence —
open the room *first*, then let the mention arrive, then reply. A mention seeded before
activation proves nothing, because activation already zeroed it.

### D2 — `isAhead` aligns to `(timestamp, archiveOrderKey)`, with a keyless fallback

`compareOrder` cannot be reused verbatim. Its keyless tie-break — *"a missing key sorts BEFORE
a present one at an equal timestamp"* — is justified in `readState.ts` as "under-advance →
over-count (safe)". That holds when the keyless value is the **floor**. In `isAhead` the
keyless value is the **current pointer**, so the identical rule makes it *easier* for a
candidate to beat it: same comparator, inverted safety. A migrated keyless pointer would be
overtaken by any same-millisecond keyed candidate — the unsafe direction.

**Rule: when either side lacks an `archiveOrderKey`, `isAhead` falls back to strict
millisecond comparison** — today's behaviour, preserved exactly where the position is not
provable. Only when both sides carry a key does the tie-break apply.

### D3 — XEP-0490 resolves by position for a keyed pointer

`resolveRemoteDisplayed` has **three** branches, not two. The no-pointer case is separate and
must not be folded into "keyless", because today it already advances and losing that would be
a silent regression: `pointerInSlice` is vacuously `true` when `meta.readPointer` is
`undefined`, so `onMessageSeen` takes its "no read position yet: any resolvable message is an
advancement" path.

| Local pointer | Behaviour |
|---|---|
| **absent** | Advance to the matched remote marker. Unchanged from today — preserved explicitly. |
| **keyed** (`archiveOrderKey` present) | Compare `(timestamp, archiveOrderKey)` against the matched message's **real** position (taken from `match`, which is in the slice by construction) and advance or clear directly. **No residency requirement on the local pointer.** |
| **keyless** (migrated) | Unchanged: the resident-index path when the pointer is in the slice, `stash-pending` when it is absent. |

Only the middle row is new. Justification in [Safety direction](#safety-direction).

### D4 — `onMessageSeen` compares by position, not array index

With the shared order available, `onMessageSeen` stops requiring both ends in the slice **when
the current pointer carries an `archiveOrderKey`**: it compares the reported message's position
against the pointer's directly, so there is no unresolvable pointer left to guard against. This
is what the parent design's Deletions table anticipated with "there is no unresolvable pointer
any more" — true now only for keyed pointers.

A **keyless** pointer keeps today's index path, including the `currentIdx === -1` guard and its
`atLiveEdge` escape hatch. Those are therefore *narrowed to the keyless branch*, not deleted
outright; the parent design's Deletions table overstates this, because it predates the
migration branch that legitimately produces keyless pointers.

**Accepted consequence — the far-forward advance.** The dropped guard did not only block
*unresolvable* pointers; it also blocked an advance across an arbitrary **gap**. The viewport
observer reports the bottom-most *visible* row (`useViewportObserver`) and `MessageList` enables
it on `!isLoading && messages.length > 0`, never on the live edge. After a search "go to message"
jump — `loadMessagesAroundFromCache` hydrates the resident array with a slice around an arbitrary
anchor and does **not** write `windowAtLiveEdge` — a keyed pointer sitting far behind and off the
slice now advances straight to a row in the jumped-to window, putting the whole intervening range
permanently behind a forward-only boundary. Raised by the whole-branch review, **considered and
accepted** by the plan owner: the observer only ever reports a row the user is actually looking
at, and the equivalent skip already occurs within a resident slice (land at the top of a loaded
window, scroll to its bottom — everything between is marked read, by index, in the old code too).
A difference of degree, not of kind. Pinned by *"accepts a far-forward advance: a KEYED off-slice
pointer jumps to the reported row and the skipped range goes read"* in `notificationState.test.ts`.

*Provenance of the delta, verified by reading the code at the merge-base (`41cdd8d2`):* for a
reported row that is **not** the resident array's last element the old code did refuse — the
escape hatch required `newIdx === messages.length - 1`, which the middle of a jumped-to window is
not. But for the **last** element it would have advanced just as far, because `chatStore`
computes `atLiveEdge` as `windowAtLiveEdge.get(id) !== false` and the jump path never sets that
entry, so an unset entry reads as `true`. The widening is therefore real but narrower than "the
guard blocked this": it removes the *not-the-last-element* condition, not the hazard's existence.

### D5 — `onActivate`'s ladder is replaced by a floor-position scan

Deleted: the `lastReadAt`-timestamp branch, the Nth-from-end branch, the brand-new-conversation
branch, and the resume-preserving snap (the ladder's only pointer write).

Replaced by: **the divider is the first message the canonical count would count.** Same order,
*and the same eligibility predicate* — agreement is only "by construction" if both halves are
literally the same rule:

```
divider = first m in slice where
    !m.isOutgoing
 && isRenderableStoredMessage(m)
 && compareOrder(positionOf(m), floorPos) > 0
```

matching `countUnreadInArchive`'s `!isOutgoing && isRenderableStoredMessage`, strictly after
the same position. Two consequences the previous draft got wrong:

- **`isDelayed` disappears from the divider rule entirely.** With a timestamp floor, a delayed
  message after the floor simply *is* new — which is the parent design's own argument. This is
  the same edit as `onActivate` shedding `treatDelayedAsNew` (D8); they are one change.
- **`isRenderableStoredMessage` must be added.** `onActivate`'s current `isNewCandidate` does
  not check renderability, so today a non-renderable row (a stray XEP-0333 marker, a
  fallback-only body) can carry the divider while contributing nothing to the count. That is a
  pre-existing divider/count disagreement this PR closes rather than inherits.

**`floorPos` must be the same `OrderPosition` the count uses**, which means
`computeFloor(readPointer, historyFloor)` — pointer-wins-else-floor — with the pointer's own
`archiveOrderKey` when the pointer supplied it, and no key when it came from `historyFloor`
(keyless sorts first, so a same-millisecond message counts as strictly after: the over-count
direction, matching the count exactly).

**This requires plumbing `historyFloor` to the divider call sites that can reach the scan
without a pointer**, which none of them do today. Those callers construct object literals
holding `unreadCount: 0` and a pointer, so a *pointerless* entity currently reaches the scan
with no boundary at all and would take the whole slice. In scope — **four sites**:

- `chatStore.activateConversation` / `roomStore.activateRoom`.
- `resyncDividerToReadPointer`, both stores.

**Two candidate sites are deliberately excluded, because a pointerless entity cannot reach
either.** Plumbing them would add a field no code path can read and a control no test can make
fail — the hollow-test shape this PR is otherwise careful to avoid:

- **`ReadMarkerMeta` / `resolveRemoteDisplayed`.** It reaches `onActivate` only on the advance
  path, and passes the `readPointer` it has just built. `computeFloor` is pointer-wins, so a
  floor could never influence the result.
- **The divider rederivation inside `recomputeUnreadForConversation` / `recomputeUnreadForRoom`.**
  It runs only when `firstNewMessageMarkers.has(id)`, and deactivation deletes the marker (and
  evicts the resident array) for every non-active entity. The only recounts that run against an
  entity still holding a marker are the `allowActive` ones, and both of their triggers — a local
  pointer advance and an inbound marker that advanced the pointer — mean the pointer is already
  defined.

With neither a pointer nor a `historyFloor` there is no boundary and therefore **no divider** —
the same stand-down the count makes at `if (!floor) return`.

Past the slice, divider and count can still disagree in *magnitude*: with the floor below the
whole window the divider sits at the top and the label shows the canonical count. **Accepted
and documented.** The divider marks a *boundary*; when the boundary is below the loaded window,
top-of-slice is the only honest placement, and the label is already single-sourced on the
canonical count (PR B, Task 12). Making divider placement archive-resolved would make it async
for no gain in correctness. This closes the second item carried from PR B's reviews.

**"By construction" holds where the count DERIVES, not where it DEFERS.** The shared predicate
and the shared floor make the divider and the count answer the same question, but the count
only *answers* it on an `exact` outcome. `recomputeUnreadForConversation` /
`recomputeUnreadForRoom` stand down — leaving the persisted count in place — in each of these
states, in this order:

1. the entity is active and the caller did not pass `allowActive`;
2. `pointerlessDefers` — no pointer *and* a non-zero persisted count. Checked **twice**: at
   entry against the pre-await meta, and again against the freshly re-read meta;
3. a pending inbound XEP-0490 marker (`pendingRemoteDisplayedStanzaId !== undefined`);
4. `computeFloor` yields nothing — neither a pointer nor a `historyFloor`;
5. MAM catch-up is not complete for the entity (`isCaughtUpForCounting`);
6. the coverage record is missing, its `bottomId` no longer resolves (the record is invalidated
   so a later merge can rebuild it), or the resolved bottom sorts **above** the floor;
7. `countUnreadInArchive` returns `null` — the `unavailable` outcome;
8. the latest-wins guards at the commit: recount version, unread-input version, cache epoch,
   storage scope, and the pointer-identity re-check.

`onActivate` has no equivalent stand-down. It derives the divider synchronously from whatever
`computeFloor` yields, whether or not the count deferred. So in every state above, the badge
shows a preserved value the archive did not produce while the divider shows the boundary, and
the two can legitimately disagree — in magnitude, and in presence.

**Accepted, deliberately.** Suppressing the divider whenever the count deferred would hide the
read boundary precisely when the count is least trustworthy, and every defer above exists to
*preserve* a count, not to declare the boundary unknown. The sharpest case is state 2: a
pointerless entity with a non-zero persisted count keeps that count, while the divider derives
from `historyFloor`. For the shape that dominates this defer — a pre-#1081 conversation stamped
`historyFloor = new Date()` when it flowed through `setConversations` at upgrade — no loaded
message sorts after that floor, so the entity shows **the badge and no divider at all**. That
is the accepted outcome: the persisted count is the value that was accumulated live and is the
one worth keeping, and no read *position* is invented to justify a divider next to it. It
resolves itself as soon as any surviving writer establishes a pointer.

`onActivate` keeps its five divider-only call sites (`readMarkerSync`, both stores' remote and
recount paths), which pass `unreadCount: 0` and read back only `firstNewMessageId`.

### D6 — `recomputeCountsFromPointer` and `MAM_POINTER_RECOUNT_CACHE_LIMIT` are deleted together

Four production call sites, all four already discarding the count:

| Call site | What it still does | On deletion |
|---|---|---|
| `chatStore.recomputeUnreadForConversation` guard pass | pointer advance only | inert — the derivation re-checks both defer conditions immediately after |
| `roomStore.recomputeUnreadForRoom` guard pass | pointer advance only | inert — same |
| `chatStore.mergeMAMMessages` forward hydration | fresh-entity snap + outgoing-boundary advance | both deliberately removed, below |
| `roomStore` MAM twin | same | same |

The constant's only remaining job is fetching the slice those guard passes consume, so it
retires with them, along with its assertion in `mamCatchUpUtils.test.ts`. This is what PR B's
Task 10 correctly refused to do alone.

**The fresh-entity snap is replaced by `historyFloor`** (the parent design's decision 5). A
pointerless entity's floor is its creation watermark, so a deep MAM backfill of older history
counts zero without anyone touching the pointer. Messages that arrived *after* creation and
are merged during catch-up now count as unread — because they are. This is a behaviour change
toward more unread, in the safe direction, and it is the design's intent.

**The outgoing-boundary advance is deleted, not relocated.** "The user replied somewhere, so
they must have read up to here" is the heuristic #1081 exists to kill, and in a MUC
`isOutgoing` misattribution makes it destroy the position permanently. XEP-0490 is the
cross-device read-position mechanism; inference from `isOutgoing` is not. Consequence: a user
who replies from another client that does **not** publish XEP-0490 will accumulate unread here
until they read locally. Accepted — it is the recoverable direction, and it is consistent with
D1, which removes the same inference from the live path.

### Guard disposition

`hasPendingRemoteMarker` and `hasUnmigratedLegacyReadState` are not relocated. They split:

- **"Stop the fresh-entity snap from firing"** — dies with the snap. This is #1080 gate 3,
  which the parent design already marks **delete**. Only the `RecomputeCountsOptions` fields
  and their two call-site arguments go.
- **"Don't derive a count you cannot trust"** — already lives at each derivation's own defer
  checks, outside the deleted function. Unchanged for `pendingRemoteDisplayedStanzaId` and
  `pointerlessDefers`, and covered by their own tests. The legacy-migration half of it does
  **not** survive — see [D6b](#d6b--the-hasunmigratedlegacyreadstate-defer-is-retired-too).

### D6b — the `hasUnmigratedLegacyReadState` defer is retired too

**Not in the design as approved.** It was raised and approved by the plan owner mid-execution
and shipped in `9fee3127`; it is recorded here so the document matches what was built.

`recomputeUnreadForConversation` opened with
`if (hasUnmigratedLegacyReadState(conversationId)) return` — a stand-down for any conversation
whose #1081 legacy read pair had not yet resolved into a `readPointer`. It was written against
a recount that could **write** the pointer. D6 deletes that pass, so from then on the check
suppressed an archive-derived *count* and nothing else. Both the defer and the now-unused
function are deleted; `roomStore` never had an equivalent (rooms have no #1081 legacy pair).

**It could no longer be shown to protect anything.** With `pointerlessDefers` sitting beside
it, exactly two residual states could still reach it, and neither is protective:

- **(a) Pointerless with a *zero* persisted count.** The derivation counts from `historyFloor`
  and can only *raise* the badge. There is no trusted count to erase.
- **(b) A conversation holding a *real* pointer** written by a direct path (activation,
  `markAsRead`, XEP-0490) whose migration probe never resolved. Here the guard was not a
  protection but an active defect — below.

Every state in which a bare derived zero could not be trusted is still caught by
`pointerlessDefers`, which is unconditional (`!pointer && persistedUnread > 0`) and runs both
at entry and against the freshly re-read meta.

**The live bug it fixed.** `scheduleReadPointerBackfill` leaves an entry in its `pending` set
whenever `migrateReadPointer` resolves nothing — a `lastSeenMessageId` the cache never held, or
a `lastReadAt` predating every cached message — and nothing removes that entry when a *direct*
path later writes a genuine pointer. So a conversation the user was actively reading could hold
a correct, current `readPointer`, still be reported un-migrated, and have its badge stop
reconciling for the rest of the session.

**Deliberately kept:** `withUnmigratedReadState`, the `unmigratedLegacyReadState` map,
`scheduleReadPointerBackfill`, and `serializeState`'s re-emit of the legacy pair. That is the
*persistence* path — it is what lets a later launch, whose cache may hold more, still resolve
the position. Retiring the defer does not weaken it: the recount commits `unreadCount` only, so
it can never retire a legacy pair or move a read position.

**Two invariants the analysis rests on**, both re-verified against the code:

1. **`pointerlessDefers` covers every pointerless entity carrying a non-zero persisted count**,
   unconditionally (no scope, coverage, or account qualifier) and at both check points. So
   removing the legacy defer cannot expose a trusted count to a bare derived zero.
2. **A pre-#1081 conversation's `historyFloor` never sits *behind* its legacy read position.**
   `historyFloor` and `readPointer` shipped in the same commit (`baa1601b`), so no pre-#1081
   blob carries a floor at all; restore never invents one (`deserializeState` reads only what
   was persisted, and an absent value defers at `if (!floor) return`); and the sole fresh stamp
   is `new Date()` at a post-upgrade re-add, necessarily later than a position recorded in an
   earlier session. Residual state (a) can therefore only ever count *fewer* messages than the
   true boundary — the over-count direction is not even reachable.

Invariant 2 is load-bearing but not test-enforced: a future change that stamped `historyFloor`
from a message timestamp rather than from "now" would break state (a)'s reasoning. There is no
legacy-blob fixture that could express a backdated floor, so this is a note rather than a test.

### D7 — The #1080 gates, re-decided against the merged code

| Gate | Where | Decision |
|---|---|---|
| 1. Presence gate | `advanceReadPointer`: `if (!windowVisible) return`, both stores | **Keep.** Model-independent: painted is not seen. |
| 2. Focus-regain gate | `useWindowVisibility` + `isViewportAtBottom` before `markAsRead` | **Keep.** Same reasoning. |
| 3. `hasPendingRemoteMarker` option | `recomputeCountsFromPointer` | **Delete** with its host. The *defer check* on `pendingRemoteDisplayedStanzaId` in both derivations stays. |
| 4. `archiveIsTrustworthy` publish gate | `mdsSideEffects` | **Keep, rewrite the rationale.** Its stated reason — a position derived mid-catch-up — evaporates once catch-up is not a pointer writer. It earns its place as a publish-side backstop; leaving the old comment would make it exactly the dead guard the issue warns about. |

### D8 — Folded-in cleanups from the parent design's Deletions table

- **`treatDelayedAsNew` deleted from `onActivate` only.** *Not* "everywhere" — see
  [re-grounding finding 6](#re-grounding-against-main--41cdd8d2). Every `onActivate` caller
  passes `true` and wants unified divider semantics (both stores' activation, both
  `resyncDividerToReadPointer`, both recount rederivations, and `readMarkerSync`'s
  pass-through, whose own `options.treatDelayedAsNew` plumbing then becomes dead and goes with
  it) — and D5 removes `isDelayed` from the divider rule anyway, so this is the same edit.

  The option **survives, explicitly, in `onMessageReceived` and `isUnseenIncomingMessage`**,
  where chat and rooms genuinely differ: for a 1:1 chat `isDelayed` means offline delivery
  (new to me), for a MUC it means history replay on join (not new). Both must keep an explicit
  delayed-arrival policy. Because the room path depends on the *default* rather than an
  explicit argument, this task must not be verified by grep: the guard is
  `roomStore.test.ts`'s "should not increment unread count for delayed (historical) messages",
  which has to keep passing untouched.
- **`apps/fluux/src/utils/newMessagesMarker.ts` + its test deleted.** Still referenced only by
  its own test file.
- **`onMarkAsRead`'s `advanceSeenTo` parameter dropped.** Both stores duplicate
  `atLiveEdge ? lastMessage : undefined`; the decision moves into the pure function as
  `onMarkAsRead(state, messages, kind, { windowAtLiveEdge, viewportAtLiveEdge })`. It picks
  the newest only when the loaded slice reaches the archive tail **and** the current activation
  generation reports that the viewport is at the live edge. Either fact missing still clears
  the counts but preserves the pointer. Only `markAsRead` is affected — `markReadToNewest`
  builds its pointer directly and keeps its own
  `messages ?? meta.lastMessage ?? existing.lastMessage` fallback chain.
- **`resolveSeenStanzaId` cache-resolution is NOT in PR C** — moved to
  [Out of scope](#out-of-scope). It does not restrict a pointer writer, so it does not belong
  in this PR's thesis, and it is the only item that changes the publisher's control flow.
  Rationale and the design constraints it must satisfy are recorded there so the follow-up does
  not have to re-derive them.

## Safety direction

Every change is checked against "does this widen when the pointer moves?". **Three do.** The
net effect is still a simplification — three heuristic writer *classes* disappear — but that
is an argument about which *kinds* of evidence move the pointer, not a proof that every
individual edit is conservative. The widenings are safe only because of the key-presence
precondition, and only if both polarities are tested.

| Change | Direction | Note |
|---|---|---|
| D1 outgoing collapse | **narrows** | advances only with current-generation live-edge evidence |
| D2 `isAhead` keyed tie-break | **widens, bounded** | crosses a same-millisecond run only when both sides carry a key, i.e. both positions are provable. Keyless falls back to today's strict-ms. |
| D3 XEP-0490 by position | **widens** | keyed pointers only. No-pointer and keyless branches unchanged. See below |
| D4 `onMessageSeen` by position | **widens** | keyed pointers only. The guard's main failure mode was an *unresolvable* pointer, which a key resolves — but it also blocked a far-forward advance against an off-slice pointer, accepted deliberately (see D4) |
| D5 ladder deletion | **narrows** | removes the resume-snap, a pointer write. The divider half also *narrows* eligibility by adding `isRenderableStoredMessage` |
| D6 snap + outgoing-boundary | **narrows** | removes two pointer writes |
| D8 `advanceSeenTo` | **narrows** | loaded-window tail now advances only with current-generation viewport-at-edge evidence; tab exit while scrolled up clears counts without moving the pointer |
| D8 `treatDelayedAsNew` | **neutral** | divider-only; the live-arrival policy is preserved explicitly |

**D3 is the one to justify.** It lets an inbound marker advance the pointer without the local
pointer being resident. It is acceptable because: (a) it applies only to pointers whose
timestamp is provably the named message's own, which is exactly what the `archiveOrderKey`
certifies; (b) the signal is the user's own other device genuinely reading, which is what
XEP-0490 is *for*; (c) it retires the "stays pending and re-folds on every activation" churn
the current comment calls an accepted cost; and (d) #1076's failure mode was **under**-syncing
a read position, not over-advancing one. The pointer stays forward-only either way, so a
regressive marker still cannot move it backwards.

## Testing

Regression tests map to bug modes, not to functions. Every control gets a **deliberate break
that is actually run and watched fail** — hollow tests are this codebase's recurring defect
(eight caught during PR B). Never seed `0` and assert `0`. A pre-existing test that fails is a
signal to investigate, never to relax.

- Carbon of our own message arriving at a **backgrounded** conversation → pointer does not
  move. (D1; the vector.)
- MUC reflection with misattributed `isOutgoing` at a backgrounded room → pointer does not
  move. (D1.)
- Own message sent while active, focused, at the live edge → pointer advances, count 0.
  (D1; the convergence must survive the collapse.)
- Own message sent while active but **scrolled up** → no `+1`, no divider on our own message,
  pointer unmoved, badge stays truthfully non-zero. (D1's two masked hazards.)
- Tab exit with the loaded window at the live edge but the current-generation viewport
  **away** → `markAsRead` clears counts but preserves the pointer, for both chat and room.
  With both loaded-window and viewport evidence at the live edge, the pointer advances to the
  resident tail. (D8, both evidence polarities.)
- Room reply sent while scrolled up → `mentionsCount` survives; sent at the live edge → cleared.
  (D1's deliberate loss, both polarities, plus a demo-mode check.) The mention must arrive
  **after** activation: `onActivate` zeroes `mentionsCount` on open, so a fixture that seeds the
  mention before activating cannot distinguish the two polarities and is hollow.
- Divider vs outgoing, all three rows of D1's table: **live** outgoing clears it (chat and
  room); **delayed** outgoing clears it in a chat; **delayed** outgoing in a room does **not**
  — joining a MUC and replaying your own `<delay/>`-stamped history must leave the divider
  standing. Demo-mode check, since it is visible on every room join.
- Same-millisecond run, both sides keyed → pointer crosses it. Keyless current pointer → does
  **not**. (D2, both polarities.)
- Viewport report with the current pointer absent from the slice: keyed → advances by position;
  keyless → refused unless `atLiveEdge` and newest. (D4, both branches.)
- Inbound marker, all three D3 branches: **no local pointer** → advances to the marker (a
  regression test — this works today and must keep working); **keyed** pointer absent from the
  slice → resolves by position; **keyless** pointer absent from the slice → `stash-pending`.
- Divider eligibility matches the count's, both directions: a **non-renderable** row after the
  floor carries neither the divider nor a `+1`; a **delayed** room message after the floor
  carries the divider (unified semantics) while still not incrementing unread on live arrival
  (the room `isDelayed` policy D8 preserves).
- **Pointerless** entity: divider derives from `historyFloor`, and a message sharing that exact
  millisecond counts as strictly after it — divider and count agree. With neither pointer nor
  `historyFloor`, no divider at all.
- `historyFloor` reaches the **four** plumbed divider call sites — activation and resync, both
  stores. **Every control must use a pointerless entity**: with a pointer present,
  `computeFloor` is pointer-wins, so dropping `historyFloor` changes nothing and the break
  cannot bite. Seed a pointerless entity holding messages both before and after its
  `historyFloor`, assert the divider sits at the first eligible message *after* the floor, then
  drop the floor at that one call site. For activation the mutant must yield **no divider at
  all**, per D5's "neither pointer nor floor → no boundary → no divider" — *not* "the top of the
  slice", which was an earlier draft's rule and contradicts D5. For resync the marker must
  instead stay at the deliberately-wrong value it was seeded with, because
  `resyncDividerToReadPointer` keeps an existing marker when it derives none; a resync control
  that starts from the *correct* marker passes either way and is hollow.
- No control exists for the remote-marker or recount-rederivation sites, because neither is
  plumbed — see D5 for why a pointerless entity cannot reach them. If a future change makes one
  reachable, it needs the plumbing and a control together.
- Deep-backfill catch-up on a fresh entity → zero unread, pointer untouched, floor =
  `historyFloor`. (D6's replacement.)
- Messages arriving after creation and merged during catch-up → counted unread. (D6's
  intended behaviour change; must not be mistaken for a regression.)
- Reply from another device merged by MAM → pointer does **not** advance. (D6's deletion.)
- Divider and count agree within the slice; with the floor below the window the divider sits
  at the top and the label shows the canonical count. (D5.)
- Recompute racing an unread-only `addMessage` write → the input-version guard invalidates the
  stale recount. (Re-grounding finding 4; a pin, not a fix.)
- Archive recounts still never write `mentionsCount` — exact / deferred / unavailable, both
  stores.
- `roomStore.test.ts`'s "should not increment unread count for delayed (historical) messages"
  keeps passing **untouched**. If it fails, the `treatDelayedAsNew` scope was overreached.

**Gates:** `npm run build:sdk`, repo-root `npm run typecheck`, `npm run lint`, the full SDK
and app suites run **from the repo root**, and `npm run test:scroll` for D5 and anything else
touching the divider or the loaded window.

## Task order

Safest-first; each task leaves the branch green and is independently reviewable.

1. `isAhead` + the keyless fallback rule (`readPointer.ts` only). Lands the shared order.
2. Outgoing collapse (D1) + the `incrementUnread` / divider hazards.
3. XEP-0490 position comparison (D3) — depends on 1.
4. `onMessageSeen` position comparison (D4) — depends on 1.
5. Thread `historyFloor` to the **four** divider call sites that can reach the scan without a
   pointer — activation and resync, both stores (D5, part 1). Not `ReadMarkerMeta` and not the
   recount rederivation; both always hold a pointer, so a floor there is unreadable. Merge this
   with step 6 when planning: plumbing with no consumer yet can only be "tested" by spying on a
   call argument, which pins implementation rather than behaviour.
6. `onActivate` ladder → floor-position scan with the count's own eligibility predicate, and
   shed `treatDelayedAsNew` from `onActivate` (D5 part 2 + D8's divider half — one change).
   `test:scroll` gate.
7. Delete `recomputeCountsFromPointer` + `MAM_POINTER_RECOUNT_CACHE_LIMIT` (D6). Depends on
   2 and 6.
8. #1080 gate 3 removal + gate 4 rationale rewrite (D7); falls out of 7.
9. `newMessagesMarker.ts` deletion + `onMarkAsRead`'s `advanceSeenTo` (D8).
10. Docs: update the parent design's PR C bullet, close #1081.

A whole-branch review follows the per-task reviews. On PR B that review caught three defects
living *between* tasks that twelve clean per-task reviews each correctly missed.

## Out of scope

Carried forward, to be raised when PR C lands — not to evaporate:

0. **`resolveSeenStanzaId` cache-resolution** (moved out of PR C). It resolves the publisher's
   stanza-id from the resident slice with a `lastMessage` fallback, and returns `undefined`
   otherwise. #1142 already made the publisher retry rather than drop, so this is a churn fix,
   not a correctness one — and it restricts no pointer writer, so it does not belong to PR C's
   thesis. It is also the only change that touches the publisher's control flow, which the
   parent design's Risks section already flags as a hazard for MDS seed/echo suppression.

   Constraints the follow-up must satisfy, recorded so they are not re-derived badly:

   - **A per-JID in-flight guard alone is wrong.** Suppressing a `consider(jid)` while an
     earlier one is resolving loses the newer position: A is in flight, B arrives and is
     dropped, A completes, and nothing ever retries B. The pointer B named is then never
     published — the exact #1142 failure, reintroduced.
   - Required instead: a **latest-wins serial drain** per JID — at most one resolution in
     flight, with the newest pending position kept and re-run on completion.
   - **Revalidate after every await**: account/storage scope, session (`syncEnabled` and
     connection status), pointer identity, and `archiveIsTrustworthy`. Any of them changing
     invalidates the in-flight result rather than publishing it. The account check is not
     hypothetical — the no-mistakes gate found a cross-account pointer write of exactly this
     shape during PR B.
   - **Two tests, not one**: no duplicate publication under interleaving, **and** eventual
     publication of the newest pointer. A guard that only satisfies the first is the bug above.

1. **Validation against Gajim on a real ejabberd.** Nothing in A/B0/B/C has been exercised
   against a real server or a second, differently-implemented client. "It works between Fluux
   instances" is evidence of consistent wrongness, not correctness. Cover XEP-0490 both
   directions, the offline-then-reconnect catch-up that started #1076, and a MUC with deep
   history.
2. **B0's outstanding manual gate** — a real-browser smoke test of the v4 IndexedDB migration
   against a *populated* pre-upgrade profile. `fake-indexeddb` cannot prove the auto-commit
   timing of that version-change transaction.
3. **Mention derivation.** `isMention` is set only on the live stanza path; persisting a
   mention classification at ingest is a prerequisite before any scan may raise *or* lower
   `mentionsCount`.
4. **Smaller PR B deferrals:** `useDesktopNotifications` renders the count unformatted;
   replace the fixed-tick `for (i<5) await setTimeout(0)` convergence idiom with `vi.waitFor`.
