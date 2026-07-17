# MAM Catch-Up — Next Improvements Roadmap

**Status as of 2026-07-17.** The latest-first catch-up redesign shipped in **PR #1029** (merged, `57ec3612`). The two-pointer model (XEP-0490 read pointer drives unread; per-device coverage id drives downloading) is in place, along with the Codex audit fixes for findings 1, 2, 4, 5, and 8.

**Currently in flight (separate branch `mr/mam-coverage-contiguous-bottom`):** Codex #9 (disjoint cache island mis-seeding Phase B) and #10 (preview-timestamp seams) — see `docs/superpowers/plans/2026-07-17-mam-contiguous-coverage-tracking.md` on that branch.

This document is the backlog *beyond* those — what to improve next, prioritized, each with problem / impact / approach / effort / dependencies. Nothing here is a known silent-hole defect in shipped code; these improve convergence speed, precision, observability, and cost.

---

## Tier 1 — Convergence completeness (do next, after #9/#10)

### R1. Resume Phase B when an entity goes inactive (Codex #7)

**Problem.** Phase B (the background backward walk toward the read pointer) refuses to run on the *active* conversation/room — correctly, since paging older history into the on-screen resident window would evict the live edge under the user. But when the user switches *away* and the entity goes inactive, nothing wakes a repair pass. An entity opened before its history finished filling can sit with an incomplete gap until the next reconnect.

**Impact.** Latency, not correctness — the gap stays recorded and user-visible as "Load missing messages," and a reconnect re-triggers catch-up. But a user who opens then closes a deep conversation may see a stale gap far longer than necessary.

**Approach.** Keep a *paused Phase B job* per entity when the walk bails on activation (record `{id, windowBottom, remaining budget}` in a session-scoped map). On the active-entity-change side effect (`chatSideEffects` / `roomSideEffects`), when an entity transitions active → inactive and has a paused job, resume `runCatchUpHistory` from the saved cursor. Reuse the existing per-iteration active-guard as the pause trigger. Chat/room twins via the shared side-effect pattern.

**Effort.** Small–medium (~1 focused task + tests). No new persisted state — the pause map is session-scoped; the durable resume cursor remains the cache bottom.

**Dependencies.** Composes cleanly with #9's contiguous-bottom seeding (the resumed walk seeds the same way). Best done after #9 lands so the seed logic is final.

### R2. In-session Phase B re-pass when the cap is hit (partial-state visibility)

**Problem.** A very deep pointer (> `MAM_POINTER_STITCH_MAX_PAGES × MAM_CATCHUP_FORWARD_MAX` ≈ 1000 messages) makes Phase B hit its per-pass cap and return. Convergence then waits for the *next fresh `online`* (reconnect/restart) — SM `resumed` skips it because the fetch-latest marked the entity caught-up-to-live. Across a long quiet session, a >1000-deep backlog never finishes filling.

**Impact.** Rare (needs a >1000-message unread backlog AND a long session with no reconnect). Unread badge stays approximate; the seam marker keeps the hole visible meanwhile. Codex flagged this as acceptable *if* state is explicitly partial — which it is.

**Approach.** Two options, pick per appetite:
- **(a) Lightweight:** after a cap-hit pass, schedule one more pass via a short idle timer / `requestIdleCallback`-style hook, bounded by a total per-session budget. The cache is still the durable cursor, so each pass just descends further.
- **(b) Explicit partial state:** surface a per-entity `catchUpProgress: { pending: true, coveredThrough: ts }` the UI can show ("loading older messages…"), decoupling the "keep going" trigger from reconnect.

**Effort.** (a) small; (b) medium (touches store state + a UI affordance).

**Dependencies.** Independent of #9/#10. (a) is a good quick win; (b) is a product decision.

### R3. Exact unread badge while the pointer is still pending

**Problem.** #1029's fix wave made the badge recount from the full cache when the pointer resolves during Phase B (finding fixed). But *while the pointer is still pending* (deep backlog mid-walk), the badge shows a lower bound (loaded-so-far), converging to exact only once the pointer's message loads. The async recount also has a documented benign race (a live message landing between the cache read and the apply is missed by that one recount, corrected on the next merge/activation).

**Impact.** Cosmetic during the (usually brief) walk window; self-corrects. Only visible for genuinely deep backlogs.

**Approach.** Either (i) accept and document as the intended "converging lower bound" (cheapest), or (ii) if the server's MDS response or a lightweight count query can give the true post-pointer count up front, seed the badge from it and reconcile. Prefer (i) unless users report confusion — this is a YAGNI candidate.

**Effort.** (i) doc-only; (ii) medium.

**Dependencies.** None.

---

## Tier 2 — Durability & correctness hardening (opportunistic)

### R4. `noLocalStore` messages × gap durability

**Problem.** PR #1029's Fix 5 defers a backward gap *deletion* until the bridging page is saved to IndexedDB. But if the bridging messages are all `noLocalStore` (never persisted by policy — ephemeral/tombstone content), the gap clears immediately while nothing was saved → after reload the hole is silent again. This is a *pre-existing* interaction between `noLocalStore` semantics and gap durability, not introduced by #1029.

**Impact.** Narrow: requires a backward crossing merge whose new messages are *entirely* non-persistable, spanning a recorded gap. Real but rare.

**Approach.** When a backward merge would clear a gap but *all* its new messages are `noLocalStore`, do NOT clear the gap — the region was reached but not durably recorded, so the coverage claim can't survive a reload. Keep the seam; it heals on the next real (persistable) crossing. Add the `isNoLocalStore` filter check alongside the existing `persistableMessages` computation in both stores' merge paths.

**Effort.** Small (both stores + a targeted test).

**Dependencies.** Builds on Fix 5's deferral machinery.

### R5. Tighten the "durably cached" invariant (best-effort → explicit)

**Problem.** `messageCache.saveMessages` swallows IndexedDB write errors and resolves anyway, so Fix 5's deferred gap deletion proceeds even on a *failed* write. Consistent with the cache's fire-and-forget design and no worse than pre-#1029 (which deleted immediately), but the "page is durably cached, deletion is safe" comment overstates the guarantee.

**Impact.** Only under IndexedDB write failure (quota, private-mode eviction) — degrades to the pre-#1029 behavior, not worse. Observability gap more than a bug.

**Approach.** Have `saveMessages` signal success/failure (resolve `false` on caught error instead of swallowing), and gate the deferred deletion on it: on failure, retain the gap. Alternatively, downgrade the comment to state the best-effort reality and file success-signalling as its own change. Prefer the comment fix now, the signal later.

**Effort.** Comment-only (now) or small (signal path).

**Dependencies.** Fix 5.

### R6. Bound room scroll-up IQ cost on signal-dense pages

**Problem.** #1029's Fix 2 gave room *backward* queries the same "retry past signal-only pages" loop as 1:1 (up to 5 IQs). Correct for parity and for not rendering empty rooms — but it means plain scroll-up in a signal-dense MUC can now cost up to 5 round-trips (it breaks on the first displayable page, so the common case is still one).

**Impact.** Latency/bandwidth on scroll-up in reaction-heavy public rooms; not a correctness issue.

**Approach.** Confirm the loop breaks on first displayable page (it does). If measured cost is a problem, cap plain scroll-up retries lower than fetch-latest retries, or coalesce signal-only pages server-side is out of scope. Likely just *monitor* — no change unless real MUCs show the cost. Add a debug counter if investigating.

**Effort.** Monitor-only, or small if a lower cap is wanted.

**Dependencies.** None.

---

## Tier 3 — Protocol robustness & observability (as-needed)

### R7. Honor XEP-0313 `stable='false'` (Codex #3)

**Problem.** `parseMAMResponse` ignores the `<fin stable='false'>` attribute, which warns that a paged result set may mutate between pages (RSM skip/duplicate). A gap could be closed on an unstable result.

**Impact.** **None on ejabberd** — verified in the local checkout that `mod_mam.erl` never emits `stable`, so our primary server always omits it. Only matters against a server that does emit it.

**Approach.** When/if a target deployment uses such a server: thread `stable` through `MAMResult` and forbid *definitive* gap closure when `stable=false` (keep the seam, schedule a re-validation pass). Defer until a concrete server needs it — threading a dead signal through every layer now is negative value.

**Effort.** Medium (query fns + merges + gap transition). **Deferred** — no action until a server emits it.

**Dependencies.** None; gated on a real server requirement.

### R8. First-class persisted `contiguousBottomId` (generalize #9)

**Problem.** #9's fix uses the recorded gap's `endId` as a proxy for "contiguous coverage bottom." That's correct when a gap exists, but the *general* engine-owned notion of "how far down are we provably contiguous from live" is currently reconstructed from gap state + cache each pass rather than being a single durable fact.

**Impact.** #9 already closes the concrete bug. This is a *cleanliness/robustness* generalization — a single persisted `contiguousBottomId` per entity would make coverage reasoning explicit and immune to future cache-shape surprises (multiple islands, tombstone rows, etc.).

**Approach.** Introduce `contiguousBottomId` (+ its timestamp) as persisted per-entity coverage state, advanced only by *proven contiguous* MAM merges from the live edge, never by context/search/island writes. Phase B seeds from it directly; seam formation reads it. Retire the gap-`endId`-as-proxy and the `coverageBottomUnproven` flag once this is the source of truth. This is the auditor's original #9 framing in full.

**Effort.** Medium–large (new persisted state + migration-tolerant load + rework of the seeder and seam formation to read it).

**Dependencies.** Do *after* #9/#10 ship and prove the proxy approach in the field — this is the "if the proxy shows cracks, generalize" follow-up, not urgent.

### R9. Catch-up observability / coverage telemetry

**Problem.** Coverage state (gaps, caught-up-to-live, pending pointers, Phase B progress) is only visible via the in-app console events and manual XML-log reading. Diagnosing a "why is history incomplete" report in the field is hard.

**Impact.** Support/diagnosis friction; no user-facing defect.

**Approach.** A lightweight coverage-state snapshot (per-entity: coverage bottom, gap intervals, caught-up flag, last catch-up outcome) surfaced in the debug/console panel, and structured `console:event` categories for each catch-up phase transition. Optionally a "coverage health" dev overlay.

**Effort.** Small–medium; pure additive instrumentation.

**Dependencies.** None; more valuable once R8's explicit state exists.

---

## Recommended sequencing

1. **Finish #9 + #10** (in flight) — closes the two known coverage-precision gaps.
2. **R1** (resume-on-deactivation) + **R2a** (idle re-pass) — the two convergence-completeness wins; small, high user value for deep backlogs.
3. **R4** (`noLocalStore` × gap durability) + **R5 comment** — cheap durability hardening, fold into one PR.
4. **R8** (persisted `contiguousBottomId`) — only if the #9 proxy shows limitations in the field; otherwise skip.
5. **R7 / R9 / R3(ii) / R6-cap** — as-needed, driven by a concrete server, support report, or measurement.

**Deliberately not planned:** anything requiring a server change we don't control; speculative abstractions ahead of a proven need (R8 before the proxy shows cracks; R3 before a server emits `stable`).

---

## Reference

- Shipped design: PR #1029; plan `docs/superpowers/plans/2026-07-16-unified-mam-catchup-latest-first.md`.
- In-flight: branch `mr/mam-coverage-contiguous-bottom`; plan `docs/superpowers/plans/2026-07-17-mam-contiguous-coverage-tracking.md`.
- Codex audit findings map: #1,#2,#4,#5,#8 → shipped in #1029; #9,#10 → in flight; #3 → R7 (deferred); #6 → refuted (cache is the durable cursor), residual niceties → R2; #7 → R1.
- Key modules: `packages/fluux-sdk/src/core/modules/MAM.ts` (`runCatchUpHistory`), `packages/fluux-sdk/src/stores/shared/mamGap.ts` (seams), `mamState.ts` (query state), `chatStore.ts`/`roomStore.ts` (merges), `chatSideEffects.ts`/`roomSideEffects.ts` (triggers).
