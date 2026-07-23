# Fluux Messenger code-review checklist

This guide turns the bug-fix history from 2026-05-23 through 2026-07-23 into
review questions for humans and LLM reviewers. It is deliberately specific to
Fluux: its stores, MAM and XEP-0490 flows, deferred decryption, React lifecycle,
virtualized message list, and Tauri platform boundary.

The main lesson from the period is:

> Most serious regressions came from treating two related states as if they had
> the same meaning.

Examples include display preview versus message arrival, window focus versus
message read, archive-bottom completion versus resident-window completion,
probe failure versus confirmed absence, and a DOM position versus a durable
message identity.

## Audit basis

The complete reachable history in the review window contained:

- 788 commits
- 366 commits explicitly named `fix` or `fix(scope)`
- 398 fix-like subjects when corrective commits without the conventional prefix
  are included
- 266 of the 366 explicit fixes touching a test, test fixture, or scroll
  invariant harness
- 66 explicit fixes spanning more than one of app TypeScript, SDK TypeScript,
  and Tauri Rust

Explicit fixes by broad area:

| Area | Fix commits |
| --- | ---: |
| UI, focus, and visual behavior | 70 |
| Messaging and protocol semantics | 56 |
| E2EE and trust | 52 |
| Scroll and virtualization | 51 |
| Archive, read state, notifications, and sidebar | 34 |
| Platform, lifecycle, packaging, connection, and proxy | 29 |
| Other scopes | 74 |

The counts classify commit subjects, so they are directional rather than a
defect-rate metric. Every commit subject and touched-path set in the window was
included; representative fixes and repeated fix chains were then reviewed at
diff level.

## Review protocol

Use this order. It catches the expensive mistakes before style or local
implementation details distract the review.

1. State the user-visible invariant the change must preserve.
2. Name the source of truth for every state the diff reads or writes.
3. Walk the transition through live delivery, replay/hydration, retry, and
   inactive-view paths.
4. Check identity, ordering, and coverage boundaries.
5. Check destructive, security, and persistence behavior.
6. Check React/browser/platform lifecycle variants.
7. Demand a regression test that fails for the exact bad transition.

Do not approve a patch merely because the happy path is locally plausible or
the test suite passes. First show that the state model distinguishes the cases
below.

## 1. State semantics: do not infer one fact from a nearby fact

- [ ] Does the code use an explicit semantic signal instead of a convenient
  display field?
- [ ] Is an event represented as an event/transition rather than inferred from a
  snapshot diff?
- [ ] Are `unknown`, `absent`, `present`, and `failed` distinct where the next
  action can destroy or replace data?
- [ ] Does "active" mean the correct thing: selected, visible, focused, at the
  live edge, or actually read?
- [ ] Is "complete" scoped precisely: archive bottom, live edge, current query,
  resident window, or durable coverage?
- [ ] Are ephemeral fields excluded from persistence and durable fields included
  in persistence, hydration, reset, and migration?
- [ ] If a field is derived, can it legitimately move backwards or change
  without a new event?

Fluux warning signs:

- `lastMessage` or a sidebar preview used to infer message arrival
- `document.hasFocus()` or window visibility used to mark content read
- a boolean probe result where transport failure is possible
- `complete` propagated between MAM queries with different boundaries
- preview or placeholder changes incrementing unread state
- a local cache merge treated as a new server delivery

History examples:

- `134ea4ef` introduced `lastArrivedMessage` because a preview can move during
  cache rehydration without a new arrival.
- `c895e59d` required real viewport-at-bottom evidence before focus-regain read
  effects could advance read state.
- `69bd5bab` stopped a disjoint read-pointer probe from marking the visible
  timeline's history complete.
- `84b2a2ec` made an inconclusive OpenPGP backup probe `unknown`, not `absent`.

## 2. Ordering, replay, duplicate, and delayed-message behavior

- [ ] What happens for live delivery, MAM replay, SM replay, cache hydration,
  deferred decrypt, and a duplicate/carbon echo?
- [ ] Can an older or delayed message replace a newer preview, pointer, or sort
  key?
- [ ] Is ordering based on a stable archive/protocol key rather than mutable
  cache identity or current array position?
- [ ] Are duplicate checks performed before arrival signals, unread increments,
  notifications, indexing, and persistence side effects?
- [ ] If a retry request arrives while a retry is running, is it coalesced and
  replayed rather than run concurrently or dropped?
- [ ] Does a message outside the resident window remain durable without being
  inserted into the wrong in-memory window?
- [ ] Are forward and backward pagination boundaries tested independently?
- [ ] Can a retraction, correction, reaction, or key-transport signal arrive
  before its target or without a body?

Required scenario table for message-flow changes:

| Scenario | Must establish |
| --- | --- |
| Live inbound | one arrival, one unread transition, at most one notification |
| Duplicate/carbon echo | no second arrival side effect |
| Delayed/MAM replay | correct ordering; no false live notification |
| Cache rehydration | display may change; arrival state must not |
| Inactive conversation | durable mutation without requiring a mounted view |
| Deferred decrypt | placeholder is replaced or removed atomically |
| Target not resident | durable lookup/windowing path, not DOM-only lookup |

History examples:

- `49106a6e` coalesced deferred-decrypt retries without dropping a trigger that
  arrived during an in-flight pass.
- `5dfc515e` and `8f685c2f` stopped delayed messages from dragging room/chat
  previews backwards.
- `3832efaa` classified bodiless OMEMO key transports as control messages rather
  than phantom chat messages.
- `0653006a` persisted reactions even while a conversation was inactive.

## 3. MAM, XEP-0490 read state, gaps, and coverage

- [ ] Is every coverage claim backed by a proven contiguous boundary?
- [ ] Does a query's `complete` bit prove the boundary being updated?
- [ ] Are resident-window bounds kept distinct from archive bounds and cache
  bounds?
- [ ] Is an unresolved remote marker preserved until its message identity can be
  resolved?
- [ ] Does pointer movement only move forward in the relevant archive order?
- [ ] Is an outgoing message handled as a read boundary only where the product
  semantics require it?
- [ ] Are room message identities scoped by room and sender where protocol IDs
  are not globally unique?
- [ ] If coverage is not exact, does the code preserve the persisted count
  instead of manufacturing a precise-looking answer?
- [ ] Can a gap be formed and closed from both forward and backward progress?
- [ ] Are empty pages, missing cursors, stale cursors, fetch-latest, and
  server-reported completion covered?

Reject these shortcuts:

- deriving unread count from only the currently resident slice
- snapping a pointer to newest while a remote marker is pending
- using timestamps alone as a total order
- equating "query reached archive start" with "visible window has all history"
- clearing durable state because the local cache cannot currently resolve it

Representative fixes: `ca92894c`, `170e0eb0`, `ec850d36`, `10aa9a0d`,
`bb1dad17`, `57ec3612`, `69bd5bab`, and `48db6151`.

## 4. Identity and canonicalization

- [ ] Which identity is being compared: client ID, stanza ID, origin ID,
  archive ID, cache key, bare JID, full JID, room occupant identity, key
  fingerprint, or certificate component?
- [ ] Is the identifier stable across cache reload, MAM replay, device sync,
  correction, and protocol normalization?
- [ ] Is the identity scoped to the entity where uniqueness is guaranteed?
- [ ] Are JIDs normalized only at the correct boundary, preserving display form
  while using the canonical form for comparison/network operations?
- [ ] Are DNS and TLS SNI values IDNA-encoded consistently?
- [ ] Are fingerprints normalized for whitespace/case and matched against all
  relevant primary/subkey components?
- [ ] Does the code accidentally compare serialized key bytes when component
  identity is the intended invariant?
- [ ] Do navigation and reaction/reply targets use canonical message identity
  rather than a currently mounted DOM node?

History examples:

- `a44bc389` applied IDNA at DNS and TLS boundaries.
- `a0075f03` and `29a4033c` moved reaction navigation toward stable/canonical
  message references.
- `61dac88a` reconciled an own key by component/subkey fingerprints rather than
  raw certificate bytes.
- `fb20e241` made MUC nickname defaults consistent across entry points.

## 5. E2EE and destructive actions: fail closed

- [ ] Can cleartext derived from an encrypted message escape through a fallback,
  reply quote, attachment URL, metadata extension, log, notification, or
  preview?
- [ ] If encryption was expected and encryption fails, is sending blocked rather
  than silently downgraded?
- [ ] Are malformed, unsupported, temporarily unavailable, signature-rejected,
  and control-message cases classified separately?
- [ ] Are permanent failures excluded from infinite retry loops?
- [ ] Are bodiless encrypted signals consumed without manufacturing a visible
  placeholder?
- [ ] Is a destructive action disabled on `unknown`, not only on explicit
  failure?
- [ ] Does a recovery/rotation flow preserve the old identity until backup,
  publish, and persistence outcomes are known?
- [ ] Is a passphrase handled verbatim at every boundary?
- [ ] Does a UI control invoke only the named action? Copy, reveal, export,
  publish, replace, and rotate must not share surprising side effects.
- [ ] Are trust and archive-verification policies explicit for inactive or
  retired keys?

Security regressions must include negative controls: a test proving the sensitive
material is absent from the cleartext stanza/state/log, not just a test proving
the intended encrypted field exists.

History examples:

- `0ee42b62` stripped plaintext reply fallbacks derived from encrypted messages.
- `eda0751c` fixed encrypted attachment decryption on web.
- `c7dc5b76` recovered OpenPGP keychain/TSK passphrase desynchronization.
- `1a5660c9` preserved backup passphrases verbatim.
- `a3a90ca2` stopped a Copy button from publishing the key.
- `49e557d0` surfaced backup re-publish failure after key rotation.

## 6. Persistence, hydration, and migration

- [ ] Is the store field initialized in empty state, hydration, account switch,
  logout/reset, mocks, and test factories?
- [ ] Is it intentionally present or absent in serialization/partialization?
- [ ] Does an account-scoped value remain isolated across account switches?
- [ ] Can a cache schema change read old data and safely handle partial or
  malformed records?
- [ ] Are aliases/canonical keys migrated without duplicating or losing records?
- [ ] Are cache writes awaited or explicitly fire-and-forget with a handled
  failure path?
- [ ] Does published/synced state imply the corresponding local durable write
  actually settled?
- [ ] Does inactive-view behavior work without relying on component effects?
- [ ] Does StrictMode teardown/re-setup recreate every subscription that
  `destroy()` stops?

History examples:

- `3eb2c38f` recreated the SDK state snapshot subscriber after a StrictMode
  remount.
- `a4925c10` restored room ordering on SM-resumed reload.
- `f3a22251` preserved decrypted cache behavior across a locked-key web reload.
- `0653006a` moved inactive reaction durability out of view-dependent behavior.

## 7. React, stores, and asynchronous side effects

- [ ] Is any event, store write, or diagnostic dispatch happening during render?
- [ ] Can an effect run twice, clean up, and re-run without losing authority or
  duplicating work?
- [ ] Does a callback capture stale store state, props, or a previous session
  generation?
- [ ] Are subscriptions torn down and re-established as a pair?
- [ ] Is there one authority for reconnect, snapshotting, notification arrival,
  read movement, or another cross-cutting effect?
- [ ] Are updates atomic when consumers must not observe the intermediate state?
- [ ] Does an async chain abort when its session/account/generation is stale?
- [ ] Are high-frequency progress, typing, search, resize, and scroll updates
  deduplicated or throttled before store writes?
- [ ] Can error handling itself create a render or reconnect loop?

Warning signs:

- module-level or ref-based "run once" guards that reset on remount
- two independently scheduled reads used as if they were one atomic snapshot
- an async result committed without checking current account/session
- an effect that derives durable state from whether a component happens to be
  mounted
- a store selector that returns new containers on every keystroke or render

Representative fixes: `cac173fa`, `d7f9264f`, `95fdcbfe`, `3eb2c38f`,
`859f7f77`, and `1b1b9fe8`.

## 8. Scroll and virtualization

- [ ] Is there exactly one writer/authority for the current scroll intent?
- [ ] Are policy ("follow live", "restore anchor", "jump to message") and
  mechanism (`scrollToIndex`, offset refinement, DOM write) separated?
- [ ] Does a reassert loop converge on one target per frame rather than alternate
  between competing targets?
- [ ] Can user input cancel a programmatic loop without accidentally changing
  follow-live policy?
- [ ] Is a target identified by message identity plus generation, not stale
  index or DOM node?
- [ ] Are real measurements distinguished from estimates and tagged with the
  width/layout conditions that make them valid?
- [ ] Can ResizeObserver/media/composer/sidebar changes occur after a nominal
  timeout?
- [ ] Does a programmatic measurement settle stay excluded from saved user
  position until it actually settles?
- [ ] Are bottom pin, anchor hold, deep restore, prepend, jump, and conversation
  switch tested separately?
- [ ] Is WebKit/WebKitGTK behavior verified when the code depends on layout,
  momentum, ResizeObserver, or repaint timing?

Do not accept fixed delays as proof of settling. Prefer a state transition tied
to the last relevant measurement/change, a generation-aware loop, and an
invariant checked over multiple frames.

Representative fix chain: `dff35b47`, `e5d9ec9a`, `fc9062ee`, `53915c8d`,
`a7c60333`, `b1f4899d`, `b5cb3b2e`, `77288aa0`, `0e3b5394`, `74133d5a`, and
`dbf295ea`.

## 9. Keyboard, focus, overlays, and accessibility

- [ ] Does a handled keyboard event stop before a broader shortcut interprets
  the same event?
- [ ] After closing the topmost overlay, does focus return to the opener without
  triggering conversation actions?
- [ ] Is Escape behavior tested both with an overlay open and after it closes?
- [ ] Are nested interactive elements avoided?
- [ ] Do click, keyboard selection, focus restore, and screen-reader naming lead
  to the same action?
- [ ] Are modal, sheet, dropdown, context menu, lightbox, and default overlay
  implementations consistent rather than each partially reimplementing policy?
- [ ] Does a focus or hover fix work in WebKit, not only Chromium?
- [ ] Are RTL layout and narrow/mobile variants covered when positioning or
  directional text changes?

History examples:

- `0d8091d9`, `5dbbab5d`, and `0536d49c` consumed overlay Escape so it did not
  fall through to conversation scroll-to-bottom.
- `92664e2c` restored modal focus after window focus returned.
- `e888b1ec` used an outline for a focus zone so WebKit cleared it correctly.

## 10. Desktop, web, PWA, and packaging boundaries

- [ ] Is the behavior intentionally gated for web, PWA, macOS, Windows, and
  Linux rather than defaulting all non-macOS platforms to one behavior?
- [ ] Does the Tauri invoke/listener path handle rejection and teardown?
- [ ] Are frontend and Rust assumptions about command payloads and lifecycle
  synchronized?
- [ ] Does shutdown set its one-way intent before disconnect/status effects can
  remount login or reconnect code?
- [ ] Do local dev identity, installed bundle behavior, and release artifacts
  remain distinct?
- [ ] Are platform detection and settings launchers tested against the relevant
  desktop environment variables?
- [ ] Does a packaging change preserve stable identifiers, keychain service
  names, upgrade codes, artifact naming, and updater inputs?
- [ ] Is a native behavior claim verified on the native runtime rather than only
  in jsdom/Chromium?

History examples:

- `859f7f77` marked shutdown before disconnect could mount auto-connect logic.
- `8e5dc8e2` selected the notification settings pane by Linux desktop.
- `ff965146`, `f1ff1ed4`, and `fa7741c2` fixed platform packaging/runtime
  assumptions.
- `9eda7eca` and `961611cd` restored stable bundle/keychain identities.

## 11. Regression-test standard

Every correctness fix should normally include a test that:

- [ ] fails on the parent commit for the reported reason
- [ ] exercises the exact transition, not only the final happy-path snapshot
- [ ] includes the closest negative control
- [ ] asserts forbidden side effects did not occur
- [ ] covers chat and room parity when shared semantics are intended
- [ ] covers inactive/hydrated/replayed state when the bug involved stores or
  archive data
- [ ] uses multiple frames/measurements for scroll convergence rather than one
  final pixel sample
- [ ] avoids arbitrary timing when a semantic event can be awaited
- [ ] keeps platform-only claims separate from generic unit-test claims

Useful verification commands, selected according to the touched area:

```bash
npm test
npm run typecheck
npm run lint
npm run test:scroll
cargo test --manifest-path apps/fluux/src-tauri/Cargo.toml
cargo check --manifest-path apps/fluux/src-tauri/Cargo.toml
```

For scroll bugs, reproduce with the scroll diagnostics and verify the relevant
invariant in Chromium and WebKit. For native notification, tray, proxy,
keychain, and shutdown behavior, add unit coverage but also test an installed
desktop build on the affected platform.

## Hotspot map

Use touched paths to decide which specialized questions to apply.

| Touched area | Mandatory checklist sections |
| --- | --- |
| `packages/fluux-sdk/src/stores` | 1, 2, 3, 4, 6, 7, 11 |
| `packages/fluux-sdk/src/core/modules/MAM*` | 1, 2, 3, 4, 6, 11 |
| `packages/fluux-sdk/src/core/e2ee` or app E2EE plugins | 1, 2, 4, 5, 6, 7, 11 |
| notification/read hooks and state | 1, 2, 3, 6, 7, 10, 11 |
| `useMessageListScroll` or message virtualizer | 1, 2, 7, 8, 9, 11 |
| overlays, focus, shortcuts, navigation | 1, 4, 7, 9, 11 |
| `src-tauri`, packaging, or workflows | 4, 5, 6, 10, 11 |

## LLM reviewer instructions

The following block is ready to use as the core of a Fluux-specific code-review
prompt:

```text
Review this Fluux Messenger change for concrete correctness regressions.

Start from the diff and inspect the relevant current implementations and
callers. State the invariant before judging the code. Prioritize:

1. semantic state confusion: event vs display state, focused vs read,
   unknown vs absent, archive coverage vs resident-window coverage;
2. live vs MAM/SM/cache replay, duplicate, delayed, inactive, and deferred-
   decrypt behavior;
3. stable identity, ordering, JID/fingerprint canonicalization, and entity
   scoping;
4. E2EE fail-closed behavior and plaintext/fallback/metadata leakage;
5. persistence, hydration, account switching, migrations, and StrictMode
   teardown/re-setup;
6. async races, stale session generations, dropped coalesced work, and
   multiple authorities for one side effect;
7. scroll ownership, measurement validity, convergence, and WebKit timing;
8. keyboard propagation, overlay focus, platform gates, Tauri lifecycle,
   packaging identifiers, and native-runtime assumptions.

For each finding provide:
- severity (P0 data/security, P1 user-visible correctness, P2 bounded issue);
- exact file and tight line range;
- the violated invariant;
- a concrete event/state sequence that triggers it;
- why existing guards/tests do not prevent it;
- the smallest useful regression test.

Do not report style preferences, generic defensive-programming advice, or a
hypothetical issue without a reachable trigger. Do not recommend a broad
redesign when a narrow semantic guard is sufficient. If no concrete bug is
found, say so and list the high-risk paths you checked.
```

## Reviewer output template

```markdown
## Findings

### [P1] Short actionable title

- Location: `path/to/file.ts:line`
- Invariant: ...
- Trigger: state A -> event B -> replay/remount C -> wrong state D
- Evidence: ...
- Regression test: ...

## Coverage checked

- Live / duplicate / replay / inactive:
- Persistence / migration / account switch:
- E2EE / fallback:
- React lifecycle / async:
- Scroll / WebKit:
- Desktop platforms:

## Residual risk

- Untested platform or protocol boundary:
```

## Review calibration

Use P0 only for credible confidentiality, integrity, data-loss, identity-fork,
or destructive migration failures. Use P1 for reachable user-visible
correctness failures such as lost read position, duplicate notifications,
phantom messages, wrong navigation, reconnect loops, or persistent scroll
drift. Use P2 for bounded issues with a clear trigger and modest impact.

The reviewer should prefer one strong, reproducible finding over several weak
possibilities. A clean review with explicit coverage is better than invented
findings.
