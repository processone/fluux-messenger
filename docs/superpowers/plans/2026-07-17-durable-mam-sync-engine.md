# Durable MAM Sync Engine Implementation Plan

> **For agentic workers:** execute this plan task by task. Keep each task reviewable and independently green. Do not let the legacy path and the new engine both own synchronization state for the same entity.

**Goal:** Replace the distributed MAM cursor/gap logic currently spread across protocol code, Zustand stores, IndexedDB helpers, bindings, and hooks with one headless synchronization engine whose durable state can be tested like a replicated log.

**Architecture:** The MAM module becomes a stateless, one-page transport. A serialized per-entity `MamSyncEngine` plans queries and submits every page to a transactional `MamSyncRepository`. The repository atomically materializes messages, applies or journals mutations, and advances coverage in the same account/cache generation. Zustand and React consume committed deltas; they no longer own cursors, gaps, or proofs of coverage.

**Tech stack:** TypeScript, XEP-0313/XEP-0059, IndexedDB through `idb`, Zustand projections, Vitest, `fake-indexeddb`, property-based tests with a direct `fast-check` development dependency.

## Status and relationship to current work

- PR #1029 introduced the latest-first, two-pointer catch-up design.
- PR #1040 is short-term hardening of the existing implementation. It should remain a bounded safety release and must not absorb this architectural rewrite.
- `docs/MAM_CATCHUP.md` continues to describe the shipped behavior until the cut-over is complete.
- The existing plans under `docs/superpowers/plans/` remain historical implementation records. This document supersedes them only for ownership and durability of future synchronization state.
- The new engine must preserve the user-facing behavior of chat and room history, XEP-0490 read-pointer stitching, the history-gap marker, bounded background work, and on-demand context loading.

## Why a dedicated engine is necessary

The current correctness decision is repeated across multiple layers:

| Current owner | Synchronization responsibility |
|---|---|
| `core/modules/MAM.ts` | Query construction, pagination loops, signal collection, cursor fallback, purge handling |
| `stores/chatStore.ts` and `stores/roomStore.ts` | Deduplication, durable writes, gap transitions, coverage transitions, UI projection |
| `stores/shared/mamGap.ts` and `mamCoverage.ts` | Partial range state and transition rules |
| `utils/messageCache.ts` | Message durability and account-scoped IndexedDB |
| `bindings/storeBindings.ts` | Ordering between MAM pages and signal updates |
| Hooks and background side effects | Trigger selection, cursor selection, repair and scroll-up behavior |
| `localStorage` | Positive and negative coverage metadata outside the message transaction |

This distribution makes a local change to one invariant require coordinated patches in chat, room, forward, backward, signal-only, reset, and account-switch paths. It also prevents a test from observing one authoritative durable state after a simulated crash.

The new boundary is:

~~~text
XMPP / MAM server
        |
        v
MamTransport.fetchPage()       one raw ordered page, no store events
        |
        v
MamSyncEngine                  planning, budgets, retries, per-entity serialization
        |
        v
MamSyncRepository.commitPage() one IndexedDB transaction
        |
        +-- messages / room-messages
        +-- pending MAM operations
        +-- segments, gaps and checkpoints
        +-- cache and entity generations
        |
        v
CommittedSyncDelta
        |
        +-- Zustand resident-window projection
        +-- unread/preview projection
        +-- search-index follow-up
        +-- hooks / UI status
~~~

## Primary contract

> A range may be declared covered only when every relevant archive entry in that range has, in the same IndexedDB transaction and cache generation, been materialized, durably journaled for later application, or explicitly classified by a versioned no-op policy.

This contract has three parts:

1. **Safety:** durable coverage is never ahead of durable effects.
2. **Liveness:** if the server retains a requested range and failures eventually stop, repeated work converges.
3. **Honesty:** if a cursor or range has been purged and can no longer be recovered, the engine exposes an explicit unresolved or unavailable gap instead of reporting completion.

The engine cannot guarantee recovery of data already removed by the server. It can guarantee that local metadata never hides that uncertainty.

## Mandatory invariants

1. **Atomic checkpoint:** messages, operations, dispositions, and the resulting checkpoint commit together.
2. **Lag is safe:** after any failure, coverage may be behind materialized data; it must never be ahead.
3. **At-least-once input:** any page may be replayed; applying it twice yields the same durable state.
4. **Exact seams only:** opaque MAM IDs are identities and cursors, never sortable values. Segments merge only through a query-proven exact boundary.
5. **No cache-shape inference:** timestamps, sidebar previews, global-oldest rows, and overlap with an arbitrary context island are not coverage proofs.
6. **Single logical writer per entity revision:** one local entity queue plans work serially, and IndexedDB revision checks allow only one concurrent tab/repository to advance a given revision. Different entities may run concurrently.
7. **Generation isolation:** durable account, cache, entity, materializer, and revision tokens are checked before every commit. The run epoch gates continued scheduling and UI publication.
8. **Signals are entries:** corrections, retractions, reactions, fastenings, and encrypted signals require durable outcomes.
9. **Missing targets are not drops:** a mutation whose target is absent remains in the durable pending-operation journal.
10. **Context is not live coverage:** a bounded context/search fetch creates an island until an exact query seam connects it.
11. **Unstable pages are provisional:** `stable=false` pages may materialize data but cannot definitively close a gap or establish terminal coverage.
12. **Stores are projections:** Zustand state can be reconstructed after restart from IndexedDB; it is not an input to coverage decisions.
13. **Deletion invalidates proof:** clearing an account or entity removes or invalidates its messages, operations, segments, and checkpoints atomically.
14. **No late resurrection:** a callback from an old account, cache generation, or entity generation cannot mutate durable state. An obsolete run response is dropped before commit when possible, must still pass current durable-token validation if a transaction already started, and can never publish after the run closes.
15. **One ownership mode:** legacy and engine-v1 paths may coexist for rollout, but never process the same entity concurrently.

## Scope

### Included

- 1:1 and MUC MAM parity.
- Forward catch-up, fetch-latest, backward scroll-up, gap repair, and read-pointer stitching.
- Context/search windows as non-authoritative islands.
- Raw message entries and all currently supported MAM mutations.
- Encrypted entries and deferred decryption.
- Account scoping, logout, reset, delete/recreate, reconnect, and late callbacks.
- Cursor purge, page caps, empty pages, signal-only pages, and `stable=false`.
- Durable migration from existing scoped IndexedDB caches and legacy localStorage metadata.
- Existing SDK hooks and app UX through compatibility adapters.

### Non-goals

- Changing the XMPP server or requiring ejabberd-specific archive IDs.
- Reconstructing entries that the server has already purged.
- Replacing Zustand as the UI state container.
- Making the search index strongly transactional with history. Search remains a rebuildable projection.
- Turning MAM into a CRDT. The server archive is the ordered source log; the local engine is an idempotent materializer.
- Exposing the new engine as public SDK API in the first cut-over.
- Refactoring unrelated message rendering, unread policy, or notification behavior.

## Target component boundaries

Create an internal package:

~~~text
packages/fluux-sdk/src/sync/mam/
  types.ts
  coverageModel.ts
  normalizeArchiveEntry.ts
  MamTransport.ts
  MamSyncRepository.ts
  IndexedDbMamSyncRepository.ts
  MamSyncPlanner.ts
  MamSyncEngine.ts
  EntitySyncQueue.ts
  SyncProjector.ts
  testing/
    ModelArchive.ts
    MemorySyncRepository.ts
    failureSchedule.ts
~~~

Supporting cache refactor:

~~~text
packages/fluux-sdk/src/utils/
  messageCacheDb.ts             shared DB schema/opening/serialization
  messageCache.ts               compatibility message-cache API
~~~

The package stays off the curated main SDK export until the internal cut-over is complete. Public hooks continue to call the existing client APIs through adapters during migration.

### `MamTransport`

- Knows XEP-0313, RSM, XMPP elements, serializable envelope extraction, and server errors.
- Fetches exactly one page per call.
- Returns every ordered archive entry as a serializable raw envelope, including signal-only entries. Policy classification and materialization happen after transport.
- Does not auto-paginate, emit store events, mutate gaps, or choose a recovery strategy.
- Reports the exact request that produced the page.

### `MamSyncEngine`

- Owns synchronization commands, retry budgets, pagination, and recovery policy.
- Serializes work by immutable account scope and entity key.
- Plans only from durable repository state.
- Normalizes every raw transport envelope into a message, mutation, deterministic no-op, or durable quarantine; no raw entry disappears between transport and commit.
- Treats page replay as normal.
- Publishes UI deltas only after repository commit.

### `MamSyncRepository`

- Is the sole authority for messages plus synchronization metadata.
- Validates generations and optimistic entity revision.
- Applies a page and advances its proof in one transaction.
- Resolves pending mutations when targets arrive.
- Exposes read models needed by the engine and projections, not raw object stores.

### `SyncProjector`

- Converts a committed delta into resident chat/room windows, previews, unread reconciliation, and gap status.
- Never computes or persists a cursor.
- Can reload an entity projection from the repository if a post-commit notification was lost.

## Core domain types

The exact syntax may evolve during Task 1, but the semantics are fixed.

~~~ts
export interface MamEntity {
  kind: 'chat' | 'room'
  id: string
}

export type SyncPurpose =
  | 'to-live'
  | 'toward-read-pointer'
  | 'older'
  | 'repair-gap'
  | 'context'

export interface MamPageRequest {
  accountId: string
  entity: MamEntity
  purpose: SyncPurpose
  domainKey: string
  direction: 'forward' | 'backward'
  after?: string
  before?: string
  start?: string
  end?: string
  max: number
}

export interface MamArchivePage {
  request: MamPageRequest
  entries: MamRawArchiveEntry[]
  rsm: { first?: string; last?: string; count?: number }
  complete: boolean
  stable: boolean | undefined
}

export interface MamRawArchiveEntry {
  archiveId: string
  timestamp?: number
  envelope: SerializableMamPayload
}

export type NormalizedMamEntry =
  | { kind: 'message'; archiveId: string; value: Message | RoomMessage }
  | { kind: 'mutation'; archiveId: string; value: MamMutation }
  | { kind: 'ignored'; archiveId: string; reason: IgnoredEntryReason }
  | { kind: 'quarantined'; archiveId: string; payload: SerializableMamPayload; reason: string }

export interface PreparedMamPage {
  source: MamArchivePage
  entries: NormalizedMamEntry[]
}

export interface SyncToken {
  accountId: string
  cacheGeneration: number
  entityGeneration: number
  runEpoch: number
  expectedRevision: number
}

export interface PageCommit {
  token: SyncToken
  page: PreparedMamPage
}

export interface CommitResult {
  committed: boolean
  conflict?: 'account' | 'cache-generation' | 'entity-generation' | 'revision'
  state?: EntitySyncState
  delta?: CommittedSyncDelta
}
~~~

`accountId` is immutable constructor input. `domainKey` fingerprints the archive owner and every filter that affects membership. Full-text result domains never contribute coverage. The engine and repository must not consult the mutable global `currentStorageScopeJid` when completing asynchronous work.

## Durable identity and generations

Keep these concepts separate:

| Value | Lifetime | Purpose |
|---|---|---|
| `accountId` | Persistent namespace | Bare-JID owner of the scoped database |
| `cacheGeneration` | Until account cache clear | Invalidates all positive state after global deletion |
| `entityGeneration` | Until entity delete/recreate | Prevents late work from resurrecting one conversation or room |
| `runEpoch` | One engine/connection run | Cancels late network results and UI publication |
| `revision` | One committed entity-state version | Optimistic concurrency and multi-tab conflict detection |
| `materializerVersion` | Code-defined durable policy version | Invalidates proofs if entry disposition semantics change |

The account ID is passed explicitly to database opening and every transaction. `runEpoch` is checked after network return, immediately before repository submission, and before publication. If a run closes after an IndexedDB transaction has already begun, the transaction remains safe because durable generations, exact proof, and revision are validated; its UI delta is suppressed. All durable values are reread from IndexedDB inside the transaction.

`close()` cancels a run without clearing cache. `clearEntity()` and `clearAccount()` atomically bump generations and delete authoritative data. `resetProjection()` only clears UI state.

## Durable data model

Extend the existing account-scoped `fluux-message-cache:<bare-jid>` database. Do not create a second database: IndexedDB cannot provide an atomic transaction across databases.

Bump `DB_VERSION` from 3 to 4, or to the next unused version at implementation time.

### Existing object stores

- `messages`
- `room-messages`

### New `mam-sync-meta` store

One record for the account:

~~~ts
interface StoredSyncMeta {
  key: 'account'
  accountId: string
  cacheGeneration: number
  migrationVersion: number
  migrationCompleted: boolean
  materializerVersion: number
  lastWriterVersion: string
}
~~~

### New `mam-sync-state` store

Key: `chat:<bare-jid>` or `room:<room-jid>`.

~~~ts
interface StoredEntitySyncState {
  entityKey: string
  entityGeneration: number
  revision: number
  nextOperationSequence: number
  segments: CoverageSegment[]
  unresolvedGaps: SyncGap[]
  bootstrapRequired: boolean
  lastCommittedAt?: number
}

interface CoverageSegment {
  id: string
  domainKey: string
  oldest: { archiveId: string; timestamp?: number }
  newest: { archiveId: string; timestamp?: number }
  reachesArchiveStart: boolean
  reachesLive: boolean
  proofVersion: number
}

interface SyncGap {
  id: string
  domainKey: string
  olderBoundary?: { archiveId: string; timestamp?: number }
  newerBoundary?: { archiveId: string; timestamp?: number }
  status: 'recoverable' | 'provisional' | 'unavailable'
  reason: string
}
~~~

Segments are not ordered by archive ID. They are an unordered set of query-proven ranges within one `domainKey`. Timestamps are presentation hints only. Archive-start and live-edge status are derived from segment flags rather than persisted as a second entity-level truth.

### New `mam-sync-operations` store

Key includes archive owner, entity key, and mutation archive ID. Index by entity and target ID.

~~~ts
interface StoredMamOperation {
  key: string
  entityKey: string
  archiveId: string
  targetId: string
  operation: SerializableMamMutation
  observedSequence: number
  status: 'pending-target' | 'pending-decrypt' | 'quarantined'
}
~~~

`nextOperationSequence` assigns order only when an operation is first observed. A duplicate archive-operation key retains its original sequence. Resolved operations may be removed after their effect and checkpoint commit atomically. Unresolved operations remain until the target arrives or a terminal, explicit policy decision is recorded.

### Optional disposition receipts

Do not add an unbounded receipt store by default. The page checkpoint is the aggregate receipt for materialized messages, resolved mutations, pending operations, and deterministic ignored entries.

Quick Chat entities remain outside durable MAM coverage because their history is intentionally transient. For `noLocalStore` in an otherwise durable entity, or any policy that intentionally omits a renderable archive entry, the conservative v1 behavior is **not to advance coverage**. A later design may add compact, versioned disposition receipts, but an ephemeral in-memory decision is insufficient.

## Coverage and seam rules

### Establishing a segment

- A fetch-latest page whose relevant entries all receive durable outcomes establishes a new segment for exactly that page and query domain.
- A context/search page establishes an island segment, never live-connected merely because it contains cached duplicates.
- An empty raw page establishes no range unless the server response itself proves a terminal boundary.
- A page with zero displayable messages is still non-empty when it contains mutations.

### Extending a segment

- Backward extension is valid when the request domain matches and was exactly `before: segment.oldest.archiveId`.
- Forward extension is valid when the request domain matches and was exactly `after: segment.newest.archiveId`.
- A fetch-latest walk may connect to an existing segment only when it observes an exact known endpoint, normally the previous live segment's `newest.archiveId`.
- A query chain may merge two segments when one committed page proves both exact seams.

### Things that never prove adjacency

- Similar or adjacent timestamps.
- The oldest or newest row in the global cache.
- A sidebar preview.
- Deduplication with an arbitrary resident message.
- Overlap with a context/search island when the covered endpoint was not observed.
- A session-only flag.
- An exact ID observed under a different MAM query domain or filter.

### Gap projection

Gaps are derived from the durable segment topology and terminal query facts. The engine may persist explicit unresolved-gap records for repair status and UI placement, but there must not be a second independently advanced cursor ledger.

### Purged boundaries

An `item-not-found` for any request page invalidates that boundary, not only page zero. The engine:

1. marks the seam unusable;
2. retains already materialized data;
3. bootstraps a new live segment with fetch-latest;
4. reconnects only through exact observed endpoints;
5. exposes an unavailable gap if server retention makes reconnection impossible.

## Mutation materialization

Each archive entry receives one durable outcome before coverage advances:

~~~text
message            -> materialized(messageKey)
resolved mutation  -> applied(operationKey, targetKey)
missing target     -> pending(operationKey, targetId)
locked encryption  -> pendingDecrypt(operationKey, ciphertext)
known no-op         -> ignored(operationKey, policyVersion, reason)
unknown parse       -> quarantined(operationKey, serializedPayload)
~~~

The materializer must preserve enough query order to handle:

- multiple corrections of one message;
- reaction replacement by the same actor;
- correction followed by retraction;
- signal before target;
- encrypted signal before key unlock;
- duplicate signal delivery after retry.

Mutation keys use the archive owner, entity key, and mutation archive ID. The code must not compare archive IDs lexicographically or numerically.

When a message target is inserted, the same transaction reads matching pending operations, applies them in observed order, updates the message, and removes resolved operations before advancing the page checkpoint.

Normalization happens before the transaction but produces only serializable `NormalizedMamEntry` values. A locked-key or parse failure becomes a durable pending/quarantined entry rather than an exception that silently removes the archive position. The repository revalidates the prepared page's domain, token, and materializer version before using it.

## Atomic page-commit protocol

`commitPage()` is the only operation allowed to advance coverage.

1. Capture the immutable account ID and engine run epoch before the request.
2. Open one read-write transaction over:
   - the relevant message store;
   - `mam-sync-meta`;
   - `mam-sync-state`;
   - `mam-sync-operations`.
3. Reread account, cache generation, entity generation, materializer version, and entity revision.
4. Abort with a typed conflict if any expected value differs.
5. Validate that the prepared entries correspond one-for-one with the raw page archive IDs.
6. Upsert every persistable display message from the archive page, including messages deduplicated in RAM, while preserving the existing non-degrading encryption-quality guard.
7. Apply or journal every mutation and quarantined relevant entry.
8. Resolve pending operations for newly inserted targets.
9. Run the pure coverage transition using the exact request, domain, and durable outcomes.
10. Persist the new entity state with `revision + 1`.
11. Await `tx.done`.
12. Only after commit, publish `CommittedSyncDelta` and schedule rebuildable projections such as search indexing.

If a relevant entry cannot receive a durable outcome, either commit the materialized subset without advancing that seam, or abort the entire page. Never publish a checkpoint for a partially applied page.

A crash before step 11 leaves the previous checkpoint. A crash after step 11 may lose the UI notification, but the next projection reload observes the committed state.

## Engine commands and state machine

Initial internal API:

~~~ts
export interface MamSyncEngine {
  ingestLive(entity: MamEntity, entry: LiveEntry): Promise<void>
  ensureLive(entity: MamEntity, options?: SyncBudget): Promise<SyncResult>
  ensureReadPointer(entity: MamEntity, pointerId: string, options?: SyncBudget): Promise<SyncResult>
  ensureOlder(entity: MamEntity, anchor?: string, options?: SyncBudget): Promise<SyncResult>
  ensureAround(entity: MamEntity, archiveId: string, options?: ContextBudget): Promise<SyncResult>
  repairGap(entity: MamEntity, gapId: string, options?: SyncBudget): Promise<SyncResult>
  getState(entity: MamEntity): Promise<EntitySyncState>
  clearEntity(entity: MamEntity): Promise<void>
  close(): void
}
~~~

Each command follows:

~~~text
enqueue entity command
  -> load durable state/token
  -> plan one exact request
  -> fetch one raw page
  -> normalize every raw entry
  -> commit page transactionally
  -> reload state on revision conflict
  -> stop, retry, or plan the next page within budget
  -> publish status/delta after commit
~~~

Commands for one entity coalesce where possible:

- two `ensureLive` calls share one job;
- `repairGap` may raise the budget of an existing repair;
- `ensureAround` remains a separate context purpose and cannot silently upgrade coverage;
- opening an entity may reprioritize work but does not create a second writer.

Network concurrency across entities continues to use bounded scheduling. The entity queue is the correctness mechanism; the global scheduler is a performance mechanism.

## UI and SDK integration

### Committed deltas

The engine emits a typed internal delta after commit:

~~~ts
interface CommittedSyncDelta {
  entity: MamEntity
  insertedMessageKeys: string[]
  updatedMessageKeys: string[]
  removedMessageKeys: string[]
  syncState: PublicEntitySyncStatus
}
~~~

The projector may load the actual rows by key or use committed serialized values returned by the repository. The delta itself is not authoritative and need not be replayed after restart.

### Store responsibilities after cut-over

`chatStore` and `roomStore` retain:

- resident-window state;
- active entity;
- previews and unread projections;
- typing, drafts, occupants, and UI-only state;
- projection actions applied after durable commit.

They lose:

- `conversationGaps` / `roomGaps` as independent truth;
- `conversationCoverage` / `roomCoverage`;
- `coverageBottomUnproven`;
- MAM cursor advancement;
- fire-and-forget message writes from MAM merge functions.

### Existing entry points

Compatibility adapters map:

| Existing path | New command |
|---|---|
| Background catch-up | `ensureLive`, then `ensureReadPointer` when needed |
| Open conversation/room | `ensureLive` with foreground priority |
| Scroll older | `ensureOlder` |
| Load missing messages | `repairGap` |
| Search context | `ensureAround` |
| XEP-0490 pending pointer | `ensureReadPointer` |
| Live/carbons/reflections | `ingestLive` plus later archive seam proof |
| Force catch-up | bounded repeated `repairGap` / `ensureLive` |

Public hooks should retain their current signatures during the migration.

## Legacy-data migration

The migration follows one rule:

> Reuse historical content, but trust no inherited positive continuity without a new MAM proof.

| Existing data | Migration treatment |
|---|---|
| Scoped IndexedDB v3 messages | Keep as materialized island content |
| Unscoped legacy database with ambiguous owner | Do not assign automatically without ownership proof |
| Timestamp-only `GapInterval` | Import as a suspected repair hint, never an exact cursor |
| `GapInterval` with IDs | Treat IDs as revalidation hints, not proof |
| Legacy `CoverageRecord` | Never import as positive coverage |
| Old localStorage message arrays | Import transactionally and idempotently as island content |
| Search index and Zustand previews/counters | Rebuild as derived data |

Migration requirements:

- versioned and idempotent;
- restartable after every step;
- recorded by `migrationVersion` and `migrationCompleted` in IndexedDB;
- old data deleted only after the new migration marker commits;
- correctness independent of successful localStorage cleanup;
- same database upgrade so future page commits are atomic with existing message rows;
- localStorage-to-IndexedDB import commits rows plus the migration marker first, then removes localStorage best-effort; a crash before cleanup safely replays the idempotent import;
- first engine run establishes a new live segment from the server;
- legacy metadata retained for one rollout window as rollback hints, but never used by engine-v1 as proof.

A coverage record above an empty cache becomes `bootstrapRequired`, never covered.

## Rollout and rollback

Use an account-scoped ownership flag:

~~~ts
type MamSyncOwner = 'legacy' | 'engine-v1'
~~~

Selection occurs before scheduling any entity work. Do not dual-write positive coverage. A test/debug shadow may consume recorded pages and compute diagnostics in an isolated in-memory repository, but it must not own durable state or UI.

Recommended rollout:

1. Land contracts, repository, and engine with production ownership fixed to `legacy`.
2. Exercise engine-v1 in tests and optional developer shadow diagnostics.
3. Enable engine-v1 for chat in development/demo builds.
4. Enable engine-v1 for chat in production behind the account flag.
5. Enable rooms only after chat telemetry and restart tests are clean.
6. Keep legacy localStorage metadata for one compatible release.
7. Remove legacy writers and metadata only after rollback is no longer required.

Rollback before legacy removal switches ownership at next restart and forces conservative bootstrap. Rollback must never copy engine-v1 segments into legacy `CoverageRecord`.

`lastWriterVersion` is diagnostic information, not a proof that an older binary did not touch the existing message stores. Supported rollback means switching the ownership flag within a compatible build. Arbitrary binary downgrade cannot preserve positive engine-v1 coverage safely; returning from such a downgrade requires discarding engine coverage and bootstrapping again, or clearing local history if the downgrade cannot be detected reliably.

## Observability and performance constraints

Emit structured, content-free diagnostics:

- entity kind and hashed/scoped identifier;
- command purpose;
- query direction and page count;
- commit revision and duration;
- generation/revision conflicts;
- segment count and pending-operation count;
- bootstrap, purge, cap, unstable-page, and unavailable-gap outcomes;
- retries caused by failpoints or real storage errors.

Do not log message bodies, encrypted payloads, or raw JIDs in production diagnostics.

Performance constraints:

- one IndexedDB transaction per committed page;
- no full-message-store scan during steady-state sync;
- indexes for pending operations by entity and target;
- compact adjacent proven segments inside the committing transaction;
- retain current global query concurrency limits initially;
- preserve resident-window caps;
- search indexing remains post-commit and retryable;
- measure transaction duration and segment growth before enabling rooms.

## Test architecture

The existing suite remains a functional regression shell, not the correctness oracle. Tests that assert unsafe behavior must be inverted or retired as the corresponding safety patch lands.

### Layer 1: pure model tests

Test `coverageModel.ts` and planner transitions without stores or IndexedDB:

- exact endpoint extension;
- unrelated island overlap;
- fetch-latest bootstrap;
- gap repair from both directions;
- purged boundary;
- `stable=false`;
- opaque, non-sequential IDs;
- page caps and continuation plans.

### Layer 2: repository integration

Use `fake-indexeddb` with the real schema and repository:

- commit then reconstruct a new repository instance;
- duplicate page replay;
- message plus mutation plus checkpoint atomicity;
- missing-target pending operation;
- pending-operation resolution when the target arrives;
- account/cache/entity generation mismatch;
- reset/delete/recreate;
- v3-to-v4 migration;
- localStorage legacy migration;
- room cache-key behavior.

### Layer 3: engine contract tests

Run one reusable `MamSyncEngineContract` against:

- a deterministic memory repository;
- the IndexedDB repository;
- chat and room transport adapters.

Assertions target durable observable state after restart, not internal event order or mock call counts.

### Layer 4: model-based and property tests

`ModelArchive` is an independent ordered server log supporting:

- before/after pagination;
- signals and messages;
- page caps and empty pages;
- retention and cursor purge;
- `complete` and `stable=false`;
- duplicate responses and connection failures.

Fold the server log into a reference projection and compare the engine after every generated step. Add `fast-check` directly to `packages/fluux-sdk` devDependencies rather than relying on a transitive dependency.

### Layer 5: adapter and UI regression

Keep current hook, background-sync, chat, room, unread, scroll, and gap-marker tests. Adapt their seams so they assert:

- public behavior and projected state;
- no protocol knowledge in app components;
- parity between chat and rooms;
- no resident-window regression.

They must not require the old `chat:mam-messages` / `room:mam-messages` event ordering after cut-over.

## Failure-injection harness

Every core scenario must run with a crash at:

1. before transaction open;
2. after each message write;
3. after each mutation write;
4. after pending-operation resolution;
5. before sync-state write;
6. after sync-state write but before transaction completion;
7. after commit but before UI publication;
8. between page N and page N+1;
9. during account reset;
10. during entity delete/recreate;
11. during account switch;
12. after network response from an obsolete run epoch.

A crash destroys the engine and repository instances, preserves only committed IndexedDB state, and reconstructs them before continuing.

Control mutations that the suite must catch:

- write checkpoint before messages;
- remove entity serialization;
- accept arbitrary dedupe as an exact seam;
- drop an unresolved mutation;
- ignore a generation mismatch;
- publish before `tx.done`;
- trust legacy positive coverage;
- handle purged floor only on page zero.

Each mutation should fail multiple tests.

## Acceptance scenarios

| Scenario | Required outcome |
|---|---|
| New gap, page write fails | Previous durable boundary remains; retry refetches the page |
| Page N fails, N+1 response arrives | N+1 cannot advance the same entity revision |
| Five signal-only pages | Mutations are applied or journaled before coverage advances |
| Signal arrives before target | Restart preserves it; target insertion later applies it |
| Context island overlaps fetch-latest but not known endpoint | Segments remain separate |
| Fetch-latest observes exact old endpoint | Segments may merge after atomic commit |
| Floor purged on page two | Boundary invalidated; conservative bootstrap starts |
| Cursor purged beyond server retention | Explicit unavailable gap remains |
| Reset during pending commit | Old commit conflicts and cannot repopulate state |
| Account A finishes after switch to B | No A data or metadata reaches B |
| Delete then recreate same entity | New entity generation ignores old callbacks |
| Duplicate page replay | No duplicate message, mutation, or coverage |
| `stable=false` page | Data may appear; definitive gap closure waits for validation |
| Existing v3 cache with no coverage | Messages retained as islands; live coverage bootstrapped |
| Legacy coverage over empty cache | Coverage discarded; bootstrap required |
| Crash after commit before UI event | Restart reconstructs correct projection from IndexedDB |

## Implementation tasks

### Task 0: Freeze the safety contract and independent oracle

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/testing/ModelArchive.ts`
- Create: `packages/fluux-sdk/src/sync/mam/testing/failureSchedule.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncEngine.contract.test.ts`
- Modify: `packages/fluux-sdk/package.json`
- Modify selectively: existing MAM/store tests that encode unsafe immediate transitions

**Steps:**

- [ ] Add `fast-check` as a direct dev dependency.
- [ ] Implement deterministic `ModelArchive` with opaque IDs, pagination, purge, signals, and stable/unstable results.
- [ ] Define the invariant assertions independently of production code.
- [ ] Encode the acceptance scenarios as reusable contract fixtures. Mark engine-specific cases as `todo` until the interface exists so the branch remains green.
- [ ] Catalogue legacy tests that claim unsafe immediate progress. Invert them only when the matching safety patch or engine-v1 path lands; never adopt them as the new oracle.
- [ ] Keep protocol parsing and public UX tests unchanged.

**Gate:** the oracle and failure scheduler test themselves; the repository remains green and unimplemented engine cases are explicit `todo` entries.

**Suggested commit:** `test(mam): add durable sync oracle and crash contract`

### Task 1: Add domain contracts and pure coverage model

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/types.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamTransport.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncRepository.ts`
- Create: `packages/fluux-sdk/src/sync/mam/coverageModel.ts`
- Create: `packages/fluux-sdk/src/sync/mam/coverageModel.test.ts`

**Steps:**

- [ ] Define entities, query-domain fingerprints, raw/prepared entries, generations, segments, gaps, and committed deltas.
- [ ] Implement pure exact-seam segment creation, extension, merge, purge, and provisional-state transitions.
- [ ] Make illegal transitions return typed failures, never best-effort guesses.
- [ ] Add chat/room-neutral tests with random opaque IDs.
- [ ] Add a boundary test keeping the internal package off the main public export.

**Gate:** pure model suite passes; no production path changed.

**Suggested commit:** `feat(mam-sync): define durable engine contracts and range proofs`

### Task 2: Extract the shared IndexedDB foundation and schema migration

**Files:**

- Create: `packages/fluux-sdk/src/utils/messageCacheDb.ts`
- Modify: `packages/fluux-sdk/src/utils/messageCache.ts`
- Create: `packages/fluux-sdk/src/sync/mam/IndexedDbMamSyncRepository.ts`
- Create: `packages/fluux-sdk/src/sync/mam/IndexedDbMamSyncRepository.test.ts`
- Modify: `packages/fluux-sdk/src/utils/messageCache.test.ts`

**Steps:**

- [ ] Move scoped DB naming, schema, upgrade, and serialization internals behind a shared internal DB module.
- [ ] Add `mam-sync-meta`, `mam-sync-state`, and `mam-sync-operations` in the next DB version.
- [ ] Preserve existing chat and room message rows during upgrade.
- [ ] Initialize immutable account ownership and cache generation.
- [ ] Implement idempotent migration markers without trusting legacy coverage.
- [ ] Keep the existing `@fluux/sdk/cache` API behavior unchanged.
- [ ] Test interrupted and repeated upgrades.

**Gate:** all current message-cache tests plus migration/restart tests pass.

**Suggested commit:** `feat(mam-sync): add transactional sync stores to message cache`

### Task 3: Implement transactional materialization and pending operations

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/normalizeArchiveEntry.ts`
- Create: `packages/fluux-sdk/src/sync/mam/materializePage.ts`
- Create: `packages/fluux-sdk/src/sync/mam/materializePage.test.ts`
- Modify: `packages/fluux-sdk/src/sync/mam/IndexedDbMamSyncRepository.ts`
- Modify: `packages/fluux-sdk/src/sync/mam/IndexedDbMamSyncRepository.test.ts`

**Steps:**

- [ ] Preserve archive IDs on every message and mutation.
- [ ] Assign stable first-observed operation sequence numbers and retain them on duplicate replay.
- [ ] Upsert the full persistable MAM page, including RAM duplicates.
- [ ] Apply corrections, retractions, reactions, and fastenings transactionally.
- [ ] Journal missing-target and pending-decrypt operations.
- [ ] Resolve pending operations when a target is inserted.
- [ ] Define deterministic ignored-entry policy with `materializerVersion`.
- [ ] Refuse coverage advancement for renderable `noLocalStore` entries in v1.
- [ ] Add failpoints around every write stage.

**Gate:** crash/restart at every materializer failpoint satisfies the primary contract.

**Suggested commit:** `feat(mam-sync): atomically materialize pages and pending mutations`

### Task 4: Implement atomic page commit, generations, and reset semantics

**Files:**

- Modify: `packages/fluux-sdk/src/sync/mam/IndexedDbMamSyncRepository.ts`
- Modify: `packages/fluux-sdk/src/sync/mam/IndexedDbMamSyncRepository.test.ts`
- Create: `packages/fluux-sdk/src/sync/mam/generationIsolation.test.ts`

**Steps:**

- [ ] Validate account, cache generation, entity generation, materializer version, and expected revision inside the transaction.
- [ ] Run the pure coverage transition only after all page outcomes are prepared.
- [ ] Commit materialization, pending operations, segments, and revision together.
- [ ] Implement atomic `clearEntity` and `clearAccount`.
- [ ] Reject late A-to-B, reset, and delete/recreate commits; drop obsolete-run responses before repository submission and suppress publication if closure races an already-started safe transaction.
- [ ] Add two-repository and two-tab revision-conflict tests.

**Gate:** no failure schedule publishes a checkpoint or delta from an obsolete token.

**Suggested commit:** `feat(mam-sync): enforce generation-safe atomic checkpoints`

### Task 5: Extract a stateless one-page MAM transport

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/XmppMamTransport.ts`
- Create: `packages/fluux-sdk/src/sync/mam/XmppMamTransport.test.ts`
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts`
- Modify: `packages/fluux-sdk/src/core/types/pagination.ts`
- Modify: existing `Chat.mam.test.ts` protocol tests

**Steps:**

- [ ] Extract one-page query construction and collector lifecycle.
- [ ] Return ordered serializable raw envelopes, including mutation archive IDs, without applying materializer policy.
- [ ] Thread `stable`, complete, exact request, and typed cursor errors.
- [ ] Move auto-pagination and purge recovery decisions out of the transport.
- [ ] Keep `queryArchive` and `queryRoomArchive` as legacy wrappers initially.
- [ ] Prove that legacy wrappers produce unchanged public results in nominal scenarios.

**Gate:** protocol tests pass; transport performs no store event or coverage mutation.

**Suggested commit:** `refactor(mam): extract stateless one-page archive transport`

### Task 6: Implement the serialized planner and engine

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/EntitySyncQueue.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncPlanner.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncEngine.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncEngine.test.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncEngine.property.test.ts`

**Steps:**

- [ ] Implement immutable account scope and run epoch.
- [ ] Serialize per entity and retain bounded cross-entity concurrency.
- [ ] Implement `ensureLive`, `ensureReadPointer`, `ensureOlder`, `ensureAround`, and `repairGap`.
- [ ] Plan every request from durable segments and exact endpoints.
- [ ] Handle page caps by returning durable partial status and a resumable job.
- [ ] Handle purge on any page.
- [ ] Treat `stable=false` as provisional.
- [ ] Coalesce compatible commands and cancel obsolete runs.
- [ ] Run the full contract against memory and IndexedDB repositories.

**Gate:** deterministic, failure-injection, and property suites converge to `ModelArchive` or expose an explicit unavailable gap.

**Suggested commit:** `feat(mam-sync): add serialized durable synchronization engine`

### Task 7: Add post-commit projection and chat cut-over

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/SyncProjector.ts`
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts`
- Modify: `packages/fluux-sdk/src/core/storeBindingKeys.ts`
- Modify: chat hooks and background side effects
- Modify: chat store, hook, background, unread, and MAM tests

**Steps:**

- [ ] Add committed-delta projection for resident chat windows.
- [ ] Route one ownership flag to engine-v1 for chat.
- [ ] Replace background, open, scroll-older, pointer-stitch, context, and repair chat paths.
- [ ] Ensure live chat ingestion uses generation-safe repository writes and cannot be used as a durability proof before commit.
- [ ] Derive gap UI state from the repository projection.
- [ ] Stop chatStore from writing MAM messages or advancing coverage in engine-v1 mode.
- [ ] Test restart after a committed page with a lost UI delta.

**Gate:** all chat public APIs and UI tests pass with engine-v1 as the sole chat owner.

**Suggested commit:** `feat(mam-sync): cut chat history over to durable engine`

### Task 8: Room parity and multi-page ordering

**Files:**

- Modify: `packages/fluux-sdk/src/stores/roomStore.ts`
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts`
- Modify: room hooks and background side effects
- Modify: room store, hook, MUC MAM, unread, and scroll tests
- Add: room-specific engine contract cases

**Steps:**

- [ ] Route rooms through the same engine and repository interfaces.
- [ ] Preserve room cache-key and sender-ID semantics.
- [ ] Remove per-page fire-and-forget room transactions.
- [ ] Cover page N failure followed by page N+1 success.
- [ ] Cover signal-before-target, occupant identity, and reaction replacement.
- [ ] Preserve resident-window and live-edge behavior.

**Gate:** the same engine contract passes for chats and rooms; only transport/materializer policy differs.

**Suggested commit:** `feat(mam-sync): cut room history over with chat parity`

### Task 9: Complete legacy migration, rollout controls, and cleanup

**Files:**

- Modify: account/session lifecycle and clear-local-data paths
- Modify: `packages/fluux-sdk/src/stores/shared/mamGap.ts`
- Modify: `packages/fluux-sdk/src/stores/shared/mamCoverage.ts`
- Modify: `packages/fluux-sdk/src/stores/shared/mamState.ts`
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts`
- Modify: `docs/MAM_CATCHUP.md`
- Add: migration and downgrade/rollback tests

**Steps:**

- [ ] Migrate legacy content as unproven islands.
- [ ] Revalidate legacy gap hints without trusting their cursor IDs.
- [ ] Discard legacy positive coverage for engine decisions.
- [ ] Wire clear account/entity to generation-safe repository deletion.
- [ ] Retain legacy metadata for the agreed rollback window.
- [ ] Remove legacy chat/room cursor writers after both cut-overs.
- [ ] Remove obsolete MAM merge events and store-binding keys.
- [ ] Update shipped architecture documentation.

**Gate:** no production path writes synchronization truth to Zustand or localStorage.

**Suggested commit:** `refactor(mam-sync): retire legacy gap and coverage ownership`

### Task 10: Full verification, performance baseline, and release gate

**Files:**

- Add or update benchmark fixtures and debug telemetry tests
- Update this plan's checklist and self-review

**Steps:**

- [ ] Run all pure, repository, contract, property, migration, and adapter suites.
- [ ] Run each acceptance scenario under every relevant failpoint.
- [ ] Run explicit control mutations and confirm multiple failures.
- [ ] Measure transaction duration, page throughput, pending-operation lookup, and segment compaction.
- [ ] Verify logs contain no message content or raw JIDs.
- [ ] Rebase/merge current main before final verification.
- [ ] Confirm one owner per entity under every feature-flag state.

**Commands:**

~~~bash
cd packages/fluux-sdk
npx vitest run src/sync/mam

cd ../../
npm test
npm run build:sdk
npm run typecheck
npm run lint
npm run test:scroll
~~~

**Release gate:**

- no test errors or unexpected stderr;
- no new lint errors;
- all contract and crash suites green;
- performance within the current background-sync budgets;
- rollback behavior documented and tested;
- `docs/MAM_CATCHUP.md` matches the implemented ownership model.

**Suggested commit:** `test(mam-sync): verify crash safety migration and performance`

## Definition of done

The migration is complete when:

- chat and room use the same `MamSyncEngine`;
- every MAM page advances state only through `MamSyncRepository.commitPage()`;
- messages and unresolved mutations are durable before coverage;
- all positive coverage lives in the same IndexedDB transaction domain as message data;
- account and entity generations prevent late writes and cross-account contamination;
- context islands cannot bridge live coverage without an exact seam;
- cursor purge on any page produces conservative recovery;
- Zustand and localStorage no longer own MAM cursors, gaps, or coverage;
- existing public hooks and UI behavior remain compatible;
- after any tested crash trace, restart converges to the reference model or exposes an explicit irrecoverable gap.

## Self-review checklist

- [ ] Does every durable cursor have a same-transaction durable effect set?
- [ ] Are signals modeled as operations rather than empty pages?
- [ ] Is every asynchronous callback bound to immutable account and generation tokens?
- [ ] Can a context island ever be mistaken for live coverage?
- [ ] Can a page after a failed page commit?
- [ ] Can reset/delete and a late callback resurrect state?
- [ ] Can old localStorage coverage influence a positive engine-v1 proof?
- [ ] Does restart require only IndexedDB, not Zustand memory?
- [ ] Are chat and room behavior driven by one engine contract?
- [ ] Does a purged server range stay explicitly incomplete?
- [ ] Are performance and observability bounded?
- [ ] Can the rollout be stopped without two owners touching one entity?

## Decisions intentionally deferred

- Whether engine commands become a curated public SDK API after internal stabilization.
- Whether a compact durable disposition-receipt store is needed for future `noLocalStore` semantics.
- Whether production shadow diagnostics provide enough value to justify their storage/network cost.
- Whether multi-tab efficiency should use Web Locks in addition to the mandatory IndexedDB revision check.
- Whether explicit user-visible wording should distinguish recoverable, purged, and policy-unavailable gaps.

These decisions must not weaken the primary contract or delay the internal transactional boundary.
