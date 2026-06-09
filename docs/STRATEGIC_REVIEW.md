# Fluux Messenger — Strategic Review

A strategic assessment of Fluux Messenger as of 2026-06-09 (`main`, post-0.16.0-beta.4),
covering product positioning, architecture (SDK and app), and a prioritised plan. It is the
strategic companion to the tactical [UX_REVIEW.md](UX_REVIEW.md) (2026-04-25) and an input to
[ROADMAP_2026.md](ROADMAP_2026.md).

**Goal under review:** position Fluux as a reference messaging client for businesses and
communities, and `@fluux/sdk` as the reference XMPP SDK.

---

## 1. Verdict

Fluux is much closer to "reference client" quality than the average XMPP client. The core
messaging experience — reactions, corrections, replies, retraction, XEP-0393 styling,
encrypted file sharing, polls, whispers, MUC moderation, full-text search, the ⌘K palette,
33 locales, hardened OpenPGP E2EE — is production-grade. The engineering discipline (281 test
files, ~5 TODOs in the whole app, render-loop detection, a scriptable perf harness, demo mode)
is tooling most competitors did not have at this stage.

The gaps are **strategic, not cosmetic**:

1. **No front door.** A user without an existing XMPP account is stopped dead at the login
   screen. There is no registration, no invitation flow, no "find a server" path.
2. **No delivery trust.** Outgoing messages render identically whether pending, sent, or
   delivered; only failures are surfaced. Users coming from Slack/Signal/Teams read this as
   "broken".
3. **No SDK extension point.** A third-party developer who needs an uncovered XEP must fork.
   The E2EE plugin system proves the right pattern exists; it is not generalised.

There is also a visible allocation imbalance: since the 2026-04-25 UX review, ~80 commits went
to E2EE, render performance, and connection reliability — while essentially none of the 36 UX
tickets were addressed. The measurable problems got fixed; the felt problems did not.

---

## 2. What is already at reference level (protect it)

- **The room view** is the strongest surface in the product: polls with anti-bias voting
  ("Vote before peeking"), pinned poll banner, visible moderation ("Message removed by …"),
  moderator crown, Moderators/Participants/Ignored grouping, syntax-highlighted code blocks.
- **Engineering discipline**: test density, render-loop detector, perf stress harness,
  deterministic demo mode usable for sales, screenshots, and regression testing.
- **OpenPGP E2EE hardening**: signed trust state, per-account scoping, encrypted metadata
  envelopes (reactions, retractions, link previews). Differentiating and serious.
- **The product thesis** — ejabberd + Fluux + admin console as "the complete package" — is
  correct, and the admin console (XEP-0133 + ad-hoc commands) already exists as a foundation.

---

## 3. Interface & ergonomics

Re-verified visually in demo mode on 2026-06-09. The high-impact findings of
[UX_REVIEW.md](UX_REVIEW.md) are **still present**:

- Login screen: no "create account" / "find a server" path (§1.1, severity H). This is the
  single biggest gap for both target segments.
- Sidebar: names truncated because the unread badge outcompetes the name column (§3.1); a rail
  of seven unlabeled icons (§3.2); empty states with no call to action (§3.5).
- No sent/delivered/read state on outgoing messages (§2.1/2.2). XEP-0184 is listed as
  supported, but only *failures* are rendered; there is no positive delivery signal.
- Settings: "Web Push · Not supported" with no explanation; raw "Priority: 50" XMPP jargon.

Progress since April: an **Encryption** section now exists in Settings, and an accessibility
pass landed (#430).

**Recommendation:** treat the top-10 of UX_REVIEW.md as a release blocker for 0.17. Most H
items are S-effort (reconnect banner, empty-state CTAs, badge-on-avatar, rail labels). It is
the best impact/cost ratio in this entire review, and the spec already exists.

---

## 4. Architecture

### 4.1 SDK (`packages/fluux-sdk`) — good core, leaky shell

The 15-module organisation by XEP namespace, the entity/meta store split, and the event-based
store binding are solid. Five structural weaknesses, ordered by impact on the "reference SDK"
goal:

1. **No protocol extension point.** Adding an uncovered XEP requires forking. The E2EE plugin
   system (`client.e2ee.register(...)`) is the right pattern — generalise it into
   `client.registerModule(name, module)` with a lifecycle (connect/disconnect/stanza
   dispatch). This is the feature that turns an SDK into a platform.
2. **`Element` from `@xmpp/client` leaks into the public API** (`src/index.ts` re-export).
   Every consumer is coupled to ltx internals. Wrap it in a minimal DTO before any public
   release.
3. **~600–800 duplicated lines between `chatStore` (~1,360 LOC) and `roomStore` (~2,000 LOC)**:
   message arrays, typing, drafts, notification state, MAM query state. A shared
   `createMessageStoreState(deduplicator)` factory would end the "fixed on one side only"
   class of bug (already paid for once with the MUC reference-id rules).
4. **35+ silent `.catch()` blocks** (MAM timeouts, IndexedDB quota, proxy failures). A bot
   cannot know why history did not load. Expose typed `error:*` events.
5. **The bot use case is claimed but not served.** Headless operation works (no DOM
   dependencies in core), but `createDefaultStoreBindings` is undiscoverable and there is no
   runnable example. An 80-line `examples/bot/` would do more for adoption than any docs page.

**Timing:** the SDK is not yet published; breaking changes are still free. Items 1, 2, and 4
should land **before** the first public release — afterwards each costs a major version.

Design spec: [2026-06-09-sdk-extensibility-design.md](2026-06-09-sdk-extensibility-design.md).

### 4.2 App (`apps/fluux`)

- **`ChatView` (~1,150 LOC) and `RoomView` (~2,170 LOC) are parallel god components** with an
  estimated ~70% of messaging logic re-implemented (reply, edit, upload, scroll, selection,
  find-on-page). Every messaging feature costs 2×. Extract a shared `MessageThread` component
  with 1:1/MUC slots — and do it **before** calls land, or the call UI gets duplicated too.
- **Routing is decorative**: routes are declared but views are driven by Zustand; URLs do not
  carry state (bookmark/back/refresh are fragile). This converges with the already-specified,
  deferred `selectAppView` refactor — extend it to "the URL is the source of truth".
- **No shared UI primitives** (`<Button>`, `<Modal>`) — UX_REVIEW §14.1, still true; the cost
  grows with every new modal.

---

## 5. Positioning — the connecting thread

The strategic move that ties everything together: **the invitation link as a product**.

> Admin generates a link → newcomer clicks → account provisioned → team rooms auto-joined →
> first conversation in 60 seconds.

This flow is what makes "ejabberd + Fluux + admin console" sellable against Slack
(enterprise) and what solves the cold-start problem (communities). Without it, the admin
console manages a user base that has no way to arrive. ROADMAP_2026 priority 1 already
mentions invitation link generation — this review argues it is the *centre* of that chantier,
not a bullet point.

A key constraint resolved: ejabberd exposes its full command set over XMPP itself (ad-hoc
commands), not only REST. Fluux can therefore be **ejabberd-first in capability and
pure-XMPP in transport**, with graceful degradation on other servers falling out of disco for
free. Server-side gaps (invitation tokens) can be filled with an ejabberd module.

Design spec: [2026-06-09-invitation-flow-design.md](2026-06-09-invitation-flow-design.md).

**Enterprise, in order:**
1. The invitation flow (above).
2. Delivery receipts: XEP-0184 + XEP-0333 markers — a trust feature, one sprint.
3. An IT deployment story, currently absent: managed configuration (pre-filled server,
   registration policy, enforced theme), later SSO / SASL EXTERNAL.
4. Multi-account — currently actively prevented by tab coordination.

**Communities, in order:**
1. The same invitation flow.
2. Pinned messages (communities use pins as their knowledge base: rules, FAQ — absent today).
3. Voice/video (roadmap #3; the 1:1 Jingle → LiveKit SFU sequencing is right).
4. Mobile (roadmap #2; Tauri 2 + FCM-first is coherent).

---

## 6. Adjustments to ROADMAP_2026

The roadmap is right on architecture (autonomous Rust connection layer, MLS on watch). It is
written in server/protocol features and omits three adoption-critical items:

1. **Onboarding is not on it** — yet it is the prerequisite of priority 1's "complete
   package". Fold it into the admin-panel chantier.
2. **Delivery receipts are not on it** — one sprint, major trust impact, should precede calls.
3. **SDK API hardening is not on it** — while the breaking-change window is still open.

---

## 7. Suggested ~90-day plan

| # | Chantier | Effort | Why now |
|---|----------|--------|---------|
| 1 | Top-10 of UX_REVIEW.md (reconnect banner, CTAs, rail labels, badges) | ~2 weeks | Almost all S-effort, already specified |
| 2 | XEP-0184/0333: sent/delivered/read | 1 sprint | Trust; expected by every Slack/Signal convert |
| 3 | Invitation flow + XEP-0077, coupled to the admin chantier | 2 sprints | Unlocks both segments; gives priority 1 its meaning |
| 4 | SDK: `registerModule`, Element DTO, `error:*` events, `examples/bot/` | 2 sprints | Before SDK publication, breaking changes are still free |
| 5 | `MessageThread` refactor (+ URL-driven routing already planned) | 2–3 sprints | Finish before calls to avoid duplicating the call UI |

Calls, mobile, and MLS keep their downstream slots — their current sequencing is right; they
simply arrive on foundations that no longer double every cost.

---

## 8. Method & limits

- UI findings were verified visually in demo mode (desktop 1440×860) on 2026-06-09; demo mode
  cannot exhibit real network behaviour (reconnect, MAM latency).
- Duplication figures (~70% ChatView/RoomView, ~600–800 store LOC) are reading-based orders of
  magnitude, not tooled measurements.
- Architecture findings come from a full-source review of `packages/fluux-sdk` and
  `apps/fluux` at the commit above; line counts are approximate and will drift.
