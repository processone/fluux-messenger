# Durable MAM Sync Engine Implementation Plan

> **For agentic workers:** execute this plan task by task. Keep each task reviewable and independently green. Do not let the legacy path and the new engine both own synchronization state for the same entity.

**Goal:** Replace the distributed MAM cursor/gap logic currently spread across protocol code, Zustand stores, IndexedDB helpers, bindings, and hooks with one headless synchronization engine whose durable state can be tested like a replicated log.

**Architecture:** The MAM module becomes a stateless, one-page transport. A serialized per-entity `MamSyncEngine` plans queries and submits every page to a transactional `MamSyncRepository`. The repository atomically materializes messages, applies or journals mutations, and advances coverage in the same account/cache generation. Zustand and React consume committed deltas; they no longer own cursors, gaps, or proofs of coverage.

**Tech stack:** TypeScript, XEP-0313/XEP-0059, IndexedDB through `idb`, Zustand projections, Vitest, `fake-indexeddb`, property-based tests with a direct `fast-check` development dependency.

**Protocol basis:** [XEP-0313](https://xmpp.org/extensions/xep-0313.html) requires archive order to be preserved, warns not to use timestamps as order, defines ordinary and last-page results in chronological order, and defines omitted `stable` as stable. [XEP-0059](https://xmpp.org/extensions/xep-0059.html) defines opaque UIDs and exact `before`/`after` page adjacency. The proof model below relies only on those guarantees, never on numeric or lexicographic ID ordering.

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
        +-- canonical messages and identity aliases
        +-- page receipts, canonical order edges and MAM operation log
        +-- segments, gaps, terminal facts and resumable jobs
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
2. **Liveness:** if the server retains a requested range, local policy permits storage, and failures eventually stop, repeated work converges. Otherwise the command terminates in an explicit blocked or unavailable state rather than a hot retry loop.
3. **Honesty:** if a cursor or range has been purged and can no longer be recovered, the engine exposes an explicit unresolved or unavailable gap instead of reporting completion.

The engine cannot guarantee recovery of data already removed by the server. It can guarantee that local metadata never hides that uncertainty.

## Mandatory invariants

1. **Atomic checkpoint:** messages, operations, dispositions, and the resulting checkpoint commit together.
2. **Lag is safe:** after any failure, coverage may be behind materialized data; it must never be ahead.
3. **At-least-once input:** any page or operation may be replayed after any restart; applying it twice yields the same durable state.
4. **Exact seams only:** opaque MAM IDs are identities and cursors, never sortable values. Segments merge only through a query-proven exact boundary.
5. **No cache-shape inference:** timestamps, sidebar previews, global-oldest rows, and overlap with an arbitrary context island are not coverage proofs.
6. **Single logical writer per entity revision:** one local entity queue plans work serially, and IndexedDB revision checks allow only one concurrent tab/repository to advance a given revision. Different entities may run concurrently.
7. **Generation isolation:** durable account, ownership mode/revision, engine-proof epoch, cache, entity, materializer, and entity revision tokens are checked before every commit. The run epoch gates continued scheduling and UI publication.
8. **Signals are ordered entries:** corrections, retractions, reactions, fastenings, and encrypted signals require durable outcomes and archive-order provenance.
9. **Missing targets are not drops:** a mutation whose target is absent remains in the durable pending-operation journal.
10. **Context is not live coverage:** a bounded context/search fetch creates an island until an exact query seam connects it.
11. **Unstable pages are provisional:** `stable=false` pages may materialize data but cannot definitively close a gap or establish terminal coverage.
12. **Stores are projections:** Zustand state can be reconstructed after restart from IndexedDB; it is not an input to coverage decisions.
13. **Deletion invalidates proof:** clearing an account or entity removes or invalidates its messages, operations, segments, and checkpoints atomically, while preserving and incrementing the durable generation tombstone.
14. **No late resurrection:** a callback from an old account, cache generation, or entity generation cannot mutate durable state. An obsolete run response is dropped before commit when possible, must still pass current durable-token validation if a transaction already started, and can never publish after the run closes.
15. **One authoritative ownership mode:** legacy and engine-v1 paths may coexist in a compatible rollout build, but only the owner matching the current per-kind revision may authoritatively commit for an entity.

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
  flipPage?: boolean
  after?: string
  before?: string // '' means a present empty <before/> (last page); undefined means absent
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
  archiveId?: string
  rawIndex: number
  timestamp?: number
  envelope: SerializableMamPayload
}

export type NormalizedMamEntry =
  | { kind: 'message'; archiveId: string; value: Message | RoomMessage }
  | { kind: 'mutation'; archiveId: string; value: MamMutation }
  | { kind: 'ignored'; archiveId: string; reason: IgnoredEntryReason }
  | { kind: 'quarantined'; archiveId: string; payload: SerializableMamPayload; reason: string }
  | { kind: 'uncertifiable'; rawIndex: number; envelopeDigest: string; payload: SerializableMamPayload; reason: 'missing-archive-id' | 'malformed-without-archive-id' }

export interface PreparedMamPage {
  source: MamArchivePage
  entries: NormalizedMamEntry[]
}

export interface SyncToken {
  accountId: string
  cacheGeneration: number
  entityGeneration: number
  expectedOwnershipMode: 'engine-v1'
  ownershipRevision: number
  engineProofEpoch: number
  expectedMaterializerVersion: number
  runEpoch: number
  expectedRevision: number
}

export interface PageCommit {
  token: SyncToken
  page: PreparedMamPage
}

export interface CommitResult {
  committed: boolean
  conflict?:
    | 'account'
    | 'cache-generation'
    | 'entity-generation'
    | 'ownership-mode'
    | 'ownership-revision'
    | 'engine-proof-epoch'
    | 'materializer-version'
    | 'revision'
  state?: EntitySyncState
  delta?: CommittedSyncDelta
}
~~~

`accountId` is immutable constructor input. `domainKey` is a canonical fingerprint of result-set membership only: account, archive owner, entity, domain kind (`archive` or `bounded-context`), normalized selection criteria (`start`, `end`, protocol filters), and server namespace. It explicitly excludes command purpose, `max`, direction, `flip-page`, and pagination cursors. Thus `ensureLive`, `ensureReadPointer`, `ensureOlder`, and `repairGap` can extend the same unbounded archive domain, while a differently filtered context domain cannot. Only identical fingerprints can share proof. Full-text result domains never contribute coverage.

`requestFingerprint` adds direction, `max`, `flip-page`, and the exact before/after cursor to `domainKey`, while excluding command purpose and ephemeral IQ/query IDs. It identifies a transport request/receipt; it is not a coverage domain.

Transport preserves every serializable envelope even when the server omits its MAM archive ID. Such an entry may be rendered or quarantined, but its page is not certifiable and cannot advance history coverage. Raw XMPP `Element` instances never cross the transport boundary or enter IndexedDB. `stable === undefined` means stable, as permitted by XEP-0313; only explicit `stable === false` is provisional.

## Durable identity and generations

Keep these concepts separate:

| Value | Lifetime | Purpose |
|---|---|---|
| `accountId` | Persistent namespace | Bare-JID owner of the scoped database |
| `cacheGeneration` | Until account cache clear | Invalidates all positive state after global deletion |
| `entityGeneration` | Until entity delete/recreate | Prevents late work from resurrecting one conversation or room |
| `ownershipRevision` | Until owner switch for an entity kind | Fences work planned by the legacy/engine owner being replaced |
| `engineProofEpoch` | Until rollback to legacy for an entity kind | Prevents a later engine activation from reusing pre-rollback proofs |
| `runEpoch` | One engine/connection run | Cancels late network results and UI publication |
| `revision` | One committed entity-state version | Optimistic concurrency and multi-tab conflict detection |
| `materializerVersion` | Code-defined durable policy version | Invalidates proofs if entry disposition semantics change |

The account ID is passed explicitly to database opening and every transaction. `runEpoch` is checked after network return, immediately before repository submission, and before publication. If a run closes after an IndexedDB transaction has already begun, the transaction remains safe because durable generations, exact proof, and revision are validated; its UI delta is suppressed. All durable values are reread from IndexedDB inside the transaction.

`close()` cancels a run without clearing cache. `clearEntity()` atomically bumps `entityGeneration`, clears the entity's canonical data plus any legacy mirror rows, and retains an empty sync-state tombstone. `clearAccount()` atomically bumps `cacheGeneration`, clears all subordinate canonical and legacy stores, and retains `mam-sync-meta`; neither generation may reset to an initial value after deletion. `resetProjection()` only clears UI state.

“Atomically” here covers IndexedDB authoritative stores only. Matching localStorage keys are removed after commit on a best-effort basis. Migration tracks plus the durable generation tombstone prevent stale or newly rewritten localStorage from being reimported after a clear, so cleanup success is not part of correctness.

## Durable data model

Extend the existing account-scoped `fluux-message-cache:<bare-jid>` database. Do not create a second database: IndexedDB cannot provide an atomic transaction across databases.

Bump `DB_VERSION` from 3 to 4, or to the next unused version at implementation time.

`messageCacheDb.ts` must handle `blocking`, `blocked`, `versionchange`, and abnormal termination explicitly. Cooperative v3/v4 tabs close their connection on `versionchange`. If a pre-v4 tab keeps the upgrade blocked, remain legacy-owned, persist no partial migration claim, and surface a “close/reload other tabs” recovery state; never enable engine-v1 against an uncompleted schema upgrade.

### Legacy object stores

- `messages`
- `room-messages`

Keep these stores readable during rollout and rollback, but do not make them the engine's authoritative identity model. Chat currently uses the globally collision-prone `id` key, while rooms may change from a temporary composite key to `stanzaId`. Engine-v1 therefore adds a canonical message store rather than certifying coverage over those legacy keys.

### New `mam-sync-messages` and `mam-sync-aliases` stores

`mam-sync-messages` is keyed by an immutable, entity-scoped `messageKey`. The protocol-facing `message.id` remains payload, never the IndexedDB primary key. A row stores the original/base message, the materialized projection, entity key, sender scope, encryption quality, materializer revision, and every proven page/ordinal or provisional-live position.

`mam-sync-aliases` maps a typed, entity-scoped identity to `messageKey`:

~~~ts
type MessageAlias =
  | { kind: 'mam-archive'; archiveOwner: string; id: string }
  | { kind: 'stanza-id'; by: string; id: string }
  | { kind: 'origin-id'; senderScope: string; id: string }
  | { kind: 'legacy-id'; senderScope: string; id: string }
~~~

The first insert allocates a stable `messageKey`; later live, carbon, and MAM reflections add aliases without rekeying the row. Validated MAM and `stanza-id` aliases are strong. `origin-id` and legacy IDs are fallbacks scoped to the same entity and sender and may never merge two rows that have conflicting strong identities. Target resolution uses the identity kind carried by the mutation, then the same trust ordering. Add indexes for entity/time, every alias kind, pending decryption, and operation target lookup; no steady-state target resolution may scan a message store.

Message display order uses the connected canonical order-edge graph and intra-page provenance, not timestamps. A resident window traverses archive-entry edges and resolves archive aliases to canonical rows. Disconnected islands are separated by an explicit gap; timestamp indexes may select a candidate island for UX but cannot merge or order proof components. Live rows have provisional edge order until their MAM reflection adds a proven archive position.

`SerializableTargetIdentity` preserves which protocol field supplied the reference (`id`, `stanzaId`, `originId`, or an existing `correctionStanzaIds` alias), its authority/sender scope, and any fallback candidates. A weak alias can resolve only when it is unambiguous and cannot override a conflicting strong alias.

### New `mam-sync-meta` store

One record for the account:

~~~ts
interface StoredSyncMeta {
  key: 'account'
  accountId: string
  cacheGeneration: number
  migrationVersion: number
  migration: Record<MigrationTrack, {
    phase: 'pending' | 'running' | 'complete' | 'failed' | 'quarantined'
    cursor?: string
    sourceFingerprint?: string
    failureReason?: string
  }>
  ownership: Record<'chat' | 'room', {
    mode: 'legacy' | 'switching-to-engine' | 'engine-v1' | 'switching-to-legacy'
    revision: number
    engineProofEpoch: number
    legacyProofEpoch: number
    legacyBootstrapRequired: boolean
  }>
  materializerVersion: number
  lastWriterVersion: string
}
~~~

`MigrationTrack` includes at least schema initialization, legacy chat messages, legacy room messages, localStorage chat messages, legacy chat hints, and legacy room hints. A single boolean cannot represent a phased chat-then-room rollout. This account record survives `clearAccount()`; the transaction increments `cacheGeneration` and clears subordinate stores instead of deleting or recreating this record.

Every engine proof/journal record (`mam-sync-state`, page, edge, operation, quarantine, and job) is stamped/keyed with the current per-kind `engineProofEpoch`. Canonical messages and aliases are content, not proof, and may survive an epoch change as unproven islands.

### Temporary `mam-legacy-state` store

During the compatible rollback window, move authoritative legacy gap/coverage state out of localStorage into an IndexedDB row keyed by entity. Each row carries `ownershipRevision`, `legacyProofEpoch`, `bootstrapRequired`, and the legacy payload. `LegacyMamStateAdapter` updates this row and the relevant legacy message store in a transaction that also reads `mam-sync-meta`. localStorage is only a best-effort mirror; unstamped or old-epoch records are ignored. Remove this store after the rollback window, not before the first cut-over.

### New `mam-sync-state` store

Key: `chat:<bare-jid>` or `room:<room-jid>`.

~~~ts
interface StoredEntitySyncState {
  entityKey: string
  entityGeneration: number
  engineProofEpoch: number
  revision: number
  segments: CoverageSegment[]
  terminalProofs: DomainTerminalProof[]
  unresolvedGaps: SyncGap[]
  bootstrapRequired: boolean
  lastCommittedAt?: number
}

interface CoverageSegment {
  id: string
  domainKey: string
  domainKind: 'archive' | 'bounded-context'
  kind: 'live-connected' | 'context-island'
  stability: 'stable' | 'provisional'
  availability: 'complete' | 'policy-incomplete'
  oldest: { archiveId: string; timestamp?: number }
  newest: { archiveId: string; timestamp?: number }
  reachesArchiveStart: boolean
  reachesLive: boolean
  proofReceiptIds: string[]
  proofVersion: number
  materializerVersion: number
}

interface DomainTerminalProof {
  domainKey: string
  kind: 'empty-archive' | 'archive-start' | 'live-edge'
  pageReceiptId: string
  stability: 'stable' | 'provisional'
  materializerVersion: number
}

interface SyncGap {
  id: string
  domainKey: string
  olderBoundary?: { archiveId: string; timestamp?: number }
  newerBoundary?: { archiveId: string; timestamp?: number }
  status: 'recoverable' | 'provisional' | 'blocked-policy' | 'unavailable-protocol' | 'unavailable'
  reason: string
}
~~~

Segments are not ordered by archive ID. They are an unordered set of query-proven ranges within one `domainKey`. Timestamps are presentation hints only. Archive-start and live-edge status are derived from segments and terminal proofs rather than persisted as a second entity-level truth. `unresolvedGaps` is a transactionally validated annotation derived from the same topology, not a second cursor ledger. A stable empty terminal proof distinguishes “archive checked and empty” from “never bootstrapped”. The entity-state tombstone remains after `clearEntity()` with incremented generation, empty proof arrays, and `bootstrapRequired: true`.

Only stable segments with `availability: 'complete'` count as positive local-history coverage. A policy-incomplete or provisional segment may guide traversal and prevent wasteful refetch, but always projects an explicit gap and cannot satisfy `ensureLive` as fully covered.

Full-text searches do not create `CoverageSegment` or `DomainTerminalProof` rows. A bounded context domain can create an island but can connect to archive coverage only after a later archive-domain query proves the exact seam.

### New `mam-sync-pages` store

One compact durable receipt is retained for every committed page:

~~~ts
interface StoredMamPageReceipt {
  receiptId: string // hash(domainKey, canonical request, orderedEntries)
  entityKey: string
  engineProofEpoch: number
  domainKey: string
  requestFingerprint: string
  direction: 'forward' | 'backward'
  cursor?: { before?: string; after?: string }
  orderedEntries: Array<{
    rawIndex: number
    archiveId?: string
    envelopeDigest: string
  }> // canonical oldest-to-newest transmission normalized without filtering holes
  first?: string
  last?: string
  complete: boolean
  certifiable: boolean
  stability: 'stable' | 'provisional'
  orderEdgeKeys: string[]
  outcomesDigest: string
  receiptRevision: number
  materializerVersion: number
}
~~~

The transport normalizes entries inside each page to server archive order, oldest to newest, regardless of fetch direction; it reverses transmission order only when the request explicitly used XEP-0313 `flip-page`. `orderedEntries` retains every raw position, including missing IDs, so `[A, missing, C]` can never collapse into a false `A -> C` edge. Engine-v1 does not request flipped pages initially. A backward walk therefore downloads page components newest-first but folds them oldest-first through order edges. An identical receipt key plus outcome digest is a replay. The same request/entries with a different outcome digest is a content/policy revision, not a duplicate: increment `receiptRevision`, invalidate dependent proof, and rematerialize before revalidation.

Receipts are part of the v1 correctness state and are retained for the lifetime of their coverage/operation proof. Do not compact them until a separately tested compactor can preserve replay detection, exact seams, and operation order. One bounded receipt per page is an accepted v1 storage cost.

### New `mam-sync-order` store

Represent archive order as domain-scoped edges between entry identities, not as a linked list of whole pages:

~~~ts
interface StoredMamOrderEdge {
  key: string
  entityKey: string
  engineProofEpoch: number
  domainKey: string
  olderArchiveId: string
  newerArchiveId: string
  proofReceiptIds: string[]
  stability: 'stable' | 'provisional'
  materializerVersion: number
}
~~~

Each **fully certifiable** page contributes edges between consecutive chronological archive IDs. An `after: anchor` request also proves `anchor -> firstResult`; a `before: anchor` request proves `lastResult -> anchor`. A receipt with any missing/malformed position contributes zero edges or seams; v1 deliberately does not salvage sub-runs. Overlapping pages align automatically through their shared archive-ID nodes, including fetch-latest overlap and requests with different page sizes. Same-domain overlap is accepted only when the ordered sequences agree. Conflicting stable predecessors/successors are an explicit server/proof inconsistency: keep the affected component provisional/unavailable and revalidate instead of choosing a branch. IDs from a different query domain never connect.

Coverage and mutation ordering traverse this canonical edge graph. Page receipts remain provenance/idempotency records; `orderEdgeKeys` records exactly which edges each receipt justified. This representation supports partial overlap and branching request histories without pretending that two entire pages are adjacent.

### New `mam-sync-quarantine` store

An uncertifiable raw entry is never dropped or retried forever:

~~~ts
interface StoredMamQuarantineBase {
  key: string
  entityKey: string
  engineProofEpoch: number
  domainKey: string
  requestFingerprint: string
  firstSeenAt: number
  lastSeenAt: number
  occurrences: number
}

type StoredMamQuarantine = StoredMamQuarantineBase & (
  | {
      kind: 'raw-entry'
      rawIndex: number
      envelopeDigest: string
      payload: SerializableMamPayload
      reason: 'missing-archive-id' | 'malformed-without-archive-id'
    }
  | {
      kind: 'order-conflict'
      nodeIds: string[]
      competingEdges: Array<{
        olderArchiveId: string
        newerArchiveId: string
        proofReceiptIds: string[]
        orderedEntries: string[]
      }>
      reason: 'order-conflict'
    }
)
~~~

Raw-entry keys hash `(requestFingerprint, rawIndex, envelopeDigest)`; order-conflict keys hash the domain, involved nodes, competing edges, receipt IDs, and their ordered sequences. The same transaction stores the quarantine row, a non-certifiable page receipt, and an `unavailable-protocol` gap/job status. A non-certifiable receipt contributes no order edge, seam, or terminal fact, because the unidentified entry's position is unknown. Replaying the same response increments diagnostics but creates no duplicate. The affected position never becomes covered, yet startup does not hot-refetch it; a manual repair or changed server/materializer version may revalidate later.

### New durable `mam-sync-operations` store

Key by an immutable local `operationKey`; index by entity, target aliases, and typed operation aliases (including archive owner plus mutation archive ID).

~~~ts
type OperationPosition =
  | { kind: 'archive'; pageReceiptId: string; entryOrdinal: number }
  | { kind: 'live-provisional'; liveReceiptId: string }

interface StoredOperationBase {
  key: string
  entityKey: string
  engineProofEpoch: number
  archiveId?: string
  aliases: SerializableOperationIdentity[]
  positions: OperationPosition[]
}

type StoredMamOperation =
  StoredOperationBase & (
    | {
      kind: 'mutation'
      target: SerializableTargetIdentity
      operation: SerializableMamMutation
    }
    | {
      kind: 'pending-decrypt'
      target?: SerializableTargetIdentity
      encryptedPayload: SerializableEncryptedPayload
      securityContext: SerializableSecurityContext
    }
    | {
      kind: 'ignored'
      policyVersion: number
      reason: string
    }
    | {
      kind: 'quarantined'
      payload: SerializableMamPayload
      reason: string
    }
  )
~~~

Archive replay resolves the entity-scoped archive alias and upserts the same operation. A live signal is first stored with provisional live provenance and its validated stanza/origin aliases; its later MAM reflection adds the archive alias and exact page/ordinal position without reapplying it as a second operation. The position set is necessary because the same archive entry may be observed under a bounded context domain and later under the main archive domain. Live provenance may drive an immediate provisional UI effect but never positive history coverage.

Resolved operations are not deleted: the journal is the durable receipt and archive-order source. The repository materializes a target by folding its retained archive-positioned operations from the immutable/base message through a common connected order-edge domain, using page/ordinal provenance for entries in the same receipt and preferring main-archive proof over bounded-domain positions. When an older page is discovered after a newer one, the target is recomputed; an old correction can never overwrite a newer one merely because it was observed later.

If relevant operations live in disconnected order components, their relative order is unknown. The target and gap remain `provisional`, and the engine schedules exact-seam repair; neither timestamp nor archive ID breaks the tie. Connecting two components transactionally establishes the order and recomputes affected targets in the same commit. Retractions, correction chains, and reaction-per-actor state all use this fold. `retryPendingDecrypt(entity)` reruns normalization after E2EE unlock, updates the operation variant, and rematerializes affected targets without changing its proven archive positions.

### New `mam-sync-jobs` store

Persist semantic continuation intent when a command reaches its page/time budget:

~~~ts
interface StoredSyncJob {
  key: string
  entityKey: string
  engineProofEpoch: number
  purpose: SyncPurpose
  targetId?: string
  gapId?: string
  nextBoundary?: { before?: string; after?: string }
  status: 'pending' | 'blocked-policy' | 'unavailable-protocol' | 'unavailable'
  attempts: number
  retryAfter?: number
  updatedAt: number
}
~~~

Persist the intent and next proven boundary, not a transient remaining millisecond budget. A new engine run resumes pending jobs or replans them from current segments. Quick Chat entities remain outside durable MAM coverage because their history is intentionally transient.

For a renderable `noLocalStore` entry in an otherwise durable entity, v1 writes a content-free `ignored` receipt with `policyVersion` and exposes a `blocked-policy` gap. The processing job may continue after the receipt, but the omitted position is never advertised as locally history-covered and is not fetched in a hot loop. Changing that policy increments `materializerVersion` and invalidates the affected proof.

## Coverage and seam rules

### Establishing a segment

- A fetch-latest page whose relevant entries all receive durable outcomes establishes a new segment for exactly that page and query domain.
- A context/search page establishes an island segment, never live-connected merely because it contains cached duplicates.
- An empty raw page establishes no non-empty range. A stable, complete terminal response creates a versioned `DomainTerminalProof`, including an `empty-archive` proof when appropriate.
- A page with zero displayable messages is still non-empty when it contains mutations.
- A page containing an entry without an archive ID may materialize best-effort data, but creates no positive coverage proof.

### Extending a segment

- Backward extension is valid when the request domain matches and was exactly `before: segment.oldest.archiveId`.
- Forward extension is valid when the request domain matches and was exactly `after: segment.newest.archiveId`.
- A fetch-latest walk may connect to an existing segment only when it observes an exact known endpoint, normally the previous live segment's `newest.archiveId`.
- Same-domain pages may align through one or more identical archive-ID nodes when their overlapping order agrees; page size and request purpose may differ.
- Segments merge only when committed order edges create one unambiguous path between their endpoints.
- A bounded-domain `complete` result proves only the bounded query domain. It never means archive start or live edge for the unbounded archive.
- An explicit `stable=false` receipt remains provisional. A later stable response over the same exact seams may promote it transactionally; repeated unstable responses use persisted backoff and never form a hot loop.

### Things that never prove adjacency

- Similar or adjacent timestamps.
- The oldest or newest row in the global cache.
- A sidebar preview.
- Payload/alias deduplication with an arbitrary resident message that lacks same-domain page provenance.
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
missing archive ID  -> quarantine(request/raw-index/digest), unavailable-protocol, no coverage
~~~

The materializer must preserve enough query order to handle:

- multiple corrections of one message;
- reaction replacement by the same actor;
- correction followed by retraction;
- signal before target;
- encrypted signal before key unlock;
- duplicate signal delivery after retry.

Mutation archive aliases are scoped by archive owner and entity before resolving the stable local operation key. The code must not compare archive IDs lexicographically or numerically. `observedSequence`, wall-clock timestamps, and stanza arrival order are forbidden as archive-order substitutes.

When a message target or a new operation is inserted, the same transaction reads matching retained operations, orders them through the canonical order-edge graph plus intra-page provenance, recomputes the materialized message from its base value, and advances proof only after both the operation journal and target projection are durable. Operation records remain as replay receipts. If the order graph is disconnected, the target remains explicitly provisional until exact-seam repair connects it.

Normalization, XML parsing, decryption attempts, policy plugins, hashing, and all network work happen before the transaction and produce only serializable `NormalizedMamEntry` values. A locked-key or parse failure becomes a durable pending/quarantined entry rather than an exception that silently removes the archive position. The repository revalidates the prepared page's domain, token, ownership revision, and materializer version before using it. Once the IndexedDB transaction opens, code awaits only IndexedDB requests and performs synchronous pure transforms so the browser cannot auto-close the transaction.

## Atomic page-commit protocol

`commitPage()` is the only operation allowed to advance coverage.

1. Capture the immutable account ID and engine run epoch before the request.
2. Open one read-write transaction over:
   - `mam-sync-messages` and `mam-sync-aliases`;
   - `mam-sync-meta`;
   - `mam-sync-state`;
   - `mam-sync-pages`;
   - `mam-sync-order`;
   - `mam-sync-quarantine`;
   - `mam-sync-operations`;
   - `mam-sync-jobs` when continuation state changes.
3. Reread account, ownership mode/revision, engine proof epoch, cache generation, entity generation, materializer version, and entity revision.
4. Abort with a typed conflict if any expected value differs.
5. Validate that the prepared entries correspond one-for-one with raw entries, preserve their order, and either carry the same archive ID or an explicit uncertifiable outcome.
6. Upsert every persistable display message from the archive page, including messages deduplicated in RAM, while preserving the existing non-degrading encryption-quality guard.
7. Insert/upsert the deterministic page receipt; only if it is certifiable, add canonical same-domain order edges, align overlaps through shared nodes, and reject inconsistent branches.
8. Insert/upsert every mutation, ignored disposition, archive-identified quarantine, and deterministic missing-ID/malformed quarantine with its provenance.
9. Recompute affected targets by folding the retained operation log in proven archive order.
10. Run the pure coverage transition using the exact request fingerprint, page receipt, stability, availability, and durable outcomes.
11. Persist terminal facts, continuation job changes, and the entity state with `revision + 1`.
12. Await `tx.done`.
13. Only after commit, publish `CommittedSyncDelta` and schedule rebuildable projections such as search indexing.

If a relevant entry cannot receive a durable outcome, either commit the materialized subset without advancing that seam, or abort the entire page. Never publish a checkpoint for a partially applied page.

A crash before step 12 leaves the previous checkpoint. A crash after step 12 may lose the UI notification, but the next projection reload observes the committed state.

## Engine commands and state machine

Initial internal API:

~~~ts
export interface MamSyncEngine {
  ingestLive(entity: MamEntity, entry: LiveEntry): Promise<void>
  updateReadPointer(entity: MamEntity, pointerId: string): Promise<SyncResult>
  ensureLive(entity: MamEntity, options?: SyncBudget): Promise<SyncResult>
  ensureReadPointer(entity: MamEntity, pointerId: string, options?: SyncBudget): Promise<SyncResult>
  ensureOlder(entity: MamEntity, anchor?: string, options?: SyncBudget): Promise<SyncResult>
  ensureAround(entity: MamEntity, archiveId: string, options?: ContextBudget): Promise<SyncResult>
  repairGap(entity: MamEntity, gapId: string, options?: SyncBudget): Promise<SyncResult>
  retryPendingDecrypt(entity?: MamEntity): Promise<SyncResult>
  resumePendingJobs(): Promise<void>
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

`SyncResult` distinguishes `complete`, `partial-resumable`, `blocked-policy`, `provisional`, `unavailable-protocol`, `unavailable`, and `cancelled`. A page/time cap atomically persists a semantic job before returning `partial-resumable`; restart does not depend on the caller remembering to retry.

`updateReadPointer` persists synchronization intent and schedules/coalesces `ensureReadPointer`; the pointer itself is not a `LiveEntry`, is not inserted into the archive log, and never advances coverage.

Commands for one entity coalesce where possible:

- two `ensureLive` calls share one job;
- `repairGap` may raise the budget of an existing repair;
- `ensureAround` remains a separate context purpose and cannot silently upgrade coverage;
- opening an entity may reprioritize work but does not create a second writer.

Network concurrency across entities continues to use bounded scheduling. The entity queue is the correctness mechanism; the global scheduler is a performance mechanism. A multi-page command holds the logical intent, not the queue lock across network waits: each page is one scheduling turn, then current revision is reloaded. High-priority `ingestLive` work can run between pages, so a long backward catch-up cannot delay live messages indefinitely.

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
| XEP-0490 pointer update | `updateReadPointer`, which schedules `ensureReadPointer` |
| Live/carbons/reflections | `ingestLive` plus later archive seam proof |
| Force catch-up | bounded repeated `repairGap` / `ensureLive` |

Public hooks should retain their current signatures during the migration.

The existing `@fluux/sdk/cache` compatibility facade reads the legacy stores while a kind is legacy-owned and canonical rows after its cut-over. Engine-owned writes and every destructive operation route through `MamSyncRepository`; direct writes to legacy stores may continue only in the legacy branch. If an individual-delete API cannot invalidate the precise proof transactionally, it must be deprecated or rejected in engine-v1 mode rather than leaving positive coverage over a missing row.

## Legacy-data migration

The migration follows one rule:

> Reuse historical content, but trust no inherited positive continuity without a new MAM proof.

| Existing data | Migration treatment |
|---|---|
| Scoped IndexedDB v3 messages | Idempotently import into canonical message rows as unproven island content |
| Unscoped legacy database with ambiguous owner | Do not assign automatically without ownership proof |
| Timestamp-only `GapInterval` | Import as a suspected repair hint, never an exact cursor |
| `GapInterval` with IDs | Treat IDs as revalidation hints, not proof |
| Legacy `CoverageRecord` | Never import as positive coverage |
| Old localStorage message arrays | Import transactionally and idempotently as island content |
| Search index and Zustand previews/counters | Rebuild as derived data |

Migration requirements:

- versioned and idempotent;
- restartable after every step;
- recorded per `MigrationTrack`, including cursor and source fingerprint where needed;
- imported canonical content is retained; legacy message arrays may be deleted only after their track marker commits, while legacy sync metadata remains read-only until the rollback window ends;
- correctness independent of successful localStorage cleanup;
- same database upgrade so future page commits are atomic with existing message rows;
- localStorage-to-IndexedDB import commits rows plus the migration marker first, then removes localStorage best-effort; a crash before cleanup safely replays the idempotent import;
- first engine run establishes a new live segment from the server;
- legacy metadata retained for one rollout window as rollback hints, but never used by engine-v1 as proof.

The existing fire-and-forget localStorage message import in `chatStore.deserializeState()` must run only while legacy owns chat **and before** the new localStorage migration track starts, then be removed before chat cut-over. `LegacyMamImporter` is the only importer once that track is `running`, `failed`, `complete`, or `quarantined`. Interrupted tracks remain resumable `running`/`failed` records. Corrupt data and an unscoped database with ambiguous ownership require an explicit terminal `quarantined` decision plus conservative server bootstrap rather than a guessed import. A kind may switch owners only when its required tracks are `complete` or terminally `quarantined`.

“Unproven island content” means reusable canonical rows with no `CoverageSegment` at all; migration never fabricates a page receipt or seam. Only a new server query can turn those rows into members of proven coverage through identity aliases and exact endpoints.

A coverage record above an empty cache becomes `bootstrapRequired`, never covered.

## Rollout and rollback

Use account-scoped ownership **per entity kind**:

~~~ts
type MamSyncOwnership = Record<'chat' | 'room', {
  mode: 'legacy' | 'switching-to-engine' | 'engine-v1' | 'switching-to-legacy'
  revision: number
  engineProofEpoch: number
  legacyProofEpoch: number
  legacyBootstrapRequired: boolean
}>
~~~

Selection occurs before scheduling any entity work and is captured in every run token. Chat may use engine-v1 while rooms remain legacy, but every entity has exactly one authoritative owner. Both switching modes reject new sync writes. Before the first switch, compatible-build legacy message mutations and coverage/gap commits move behind a `LegacyMamStateAdapter` transaction that checks the same durable ownership revision and stamps positive legacy state with `legacyProofEpoch`; localStorage becomes a best-effort/read-only rollback mirror, not an unfenced writer. All engine commits check both `mode === 'engine-v1'` and `ownershipRevision`. Do not dual-write positive coverage. Canonical content may be mirrored during preparation, but it has no engine proof. A test/debug shadow may consume recorded pages and compute diagnostics in an isolated in-memory repository, but it must not own durable state or UI.

An engine cut-over is a two-transaction fenced transition:

1. atomically set `mode: 'switching-to-engine'` and increment the revision;
2. stop/await known legacy jobs; compatible tabs now reject their next transactional write;
3. finish the resumable delta import/reconciliation, including deletions, while writers are frozen;
4. atomically set `mode: 'engine-v1'`, increment the revision again, and start engine jobs.

Only the transition coordinator may write migration content while in a switching mode, using the captured switching revision; it cannot write positive coverage. Production owner switches run at startup before the XMPP connection begins, so no live stanza can fall into the frozen window. An in-session developer switch is unsupported unless a future durable ingress queue is present. `ensureLive` starts immediately after the transition.

If the app crashes in either switching mode, startup resumes the transition or offers explicit rollback; it never guesses an owner. A truly pre-v4 tab can at worst mutate ignored localStorage after the database upgrade; it cannot advance engine proof, and compatible rollback clears that legacy source before reuse. Tests cover compatible and pre-v4 races explicitly.

Recommended rollout:

1. Land contracts, repository, and engine with production ownership fixed to `legacy`.
2. Exercise engine-v1 in tests and optional developer shadow diagnostics.
3. Enable engine-v1 for chat in development/demo builds.
4. Enable engine-v1 for chat in production behind the account flag.
5. Enable rooms only after chat telemetry and restart tests are clean.
6. Keep legacy localStorage metadata for one compatible release.
7. Remove legacy writers and metadata only after rollback is no longer required.

Rollback before legacy removal mirrors the fence: enter `switching-to-legacy`, stop engine jobs, increment both `engineProofEpoch` and `legacyProofEpoch`, replace current engine state with an empty current-epoch `bootstrapRequired` state, invalidate all prior engine segments/terminal facts/jobs plus all legacy positive coverage/cursor hints for that kind, set `legacyBootstrapRequired`, then enter `legacy`. Canonical messages/aliases survive only as unproven islands; old-epoch page/order/operation records are ignored and may be garbage-collected later. The compatible legacy adapter ignores any unstamped or old-epoch localStorage record and may reuse canonical content for display but, until a new server bootstrap completes, is forbidden from choosing any cursor from cache shape, legacy `CoverageRecord`, gap IDs, or timestamps. localStorage cleanup is best-effort and rollback safety depends only on the durable epochs/revision. Rollback must never copy engine-v1 segments into legacy `CoverageRecord`.

`lastWriterVersion` is diagnostic information, not a downgrade detector or safety proof. Supported rollback means switching the ownership flag within a v4-compatible build containing both adapters. A binary that only understands schema v3 will normally fail to open a v4 database with `VersionError`; arbitrary binary downgrade is unsupported and requires clearing local cache or installing a compatible build. A later upgrade must never infer safety from `lastWriterVersion`.

## Observability and performance constraints

Emit structured, content-free diagnostics:

- entity kind and hashed/scoped identifier;
- command purpose;
- query direction and page count;
- commit revision and duration;
- generation/revision conflicts;
- segment, order-edge, retained-operation, and quarantine counts;
- bootstrap, purge, cap, unstable-page, and unavailable-gap outcomes;
- retries caused by failpoints or real storage errors.

Do not log message bodies, encrypted payloads, or raw JIDs in production diagnostics.

Performance constraints:

- one IndexedDB transaction per committed page;
- no full-message-store scan during steady-state sync;
- indexes for retained operations by entity, target alias, and operation alias;
- incoming/outgoing order-edge indexes by `(engineProofEpoch, domainKey, archiveId)`;
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
- backward order-edge construction and disconnected components;
- same-domain overlapping pages with different `max`, plus conflicting-edge quarantine;
- stable-empty terminal proof;
- page caps and continuation plans.

### Layer 2: repository integration

Use `fake-indexeddb` with the real schema and repository:

- commit then reconstruct a new repository instance;
- duplicate page replay;
- message plus mutation plus checkpoint atomicity;
- missing-target pending operation;
- pending-operation resolution when the target arrives, followed by operation replay;
- two backward pages with older and newer mutations targeting the same message;
- live, carbon, and MAM-reflection identity merge without rekey;
- same protocol ID in two entities/accounts and room temporary-key-to-stanza-ID promotion;
- account/cache/entity generation mismatch;
- ownership and materializer-version mismatch;
- engine-proof-epoch mismatch and engine→legacy→engine round trip;
- reset/delete/recreate with generation tombstones surviving restart;
- v3-to-v4 migration;
- interrupted/corrupt/ambiguous-owner localStorage and legacy migration;
- every public cache deletion API invalidating the matching proof;
- individual deletion by canonical/alias identity, including a target with retained operations and a delete racing owner switch;
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

The reference fold orders mutations by the model archive, never by discovery order. Generated traces must fetch newer islands before older pages, connect islands later, replay resolved operations, change materializer versions, interleave live entries with long catch-up, and restart between every pair of steps.

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
2. after each canonical message/alias write;
3. after the page receipt and after each order-edge write;
4. after each mutation/disposition/quarantine write;
5. after target rematerialization;
6. before sync-state write;
7. after sync-state write but before transaction completion;
8. after commit but before UI publication;
9. between page N and page N+1;
10. during account reset or entity delete/recreate;
11. during each phase of an ownership switch or migration delta;
12. after network response from an obsolete run epoch.

A crash destroys the engine and repository instances, preserves only committed IndexedDB state, and reconstructs them before continuing.

Repository failpoints throw synchronously between actual IndexedDB requests so the real transaction aborts. They must not insert arbitrary timers or non-IDB awaits that would test transaction auto-close rather than the intended crash boundary.

Control mutations that the suite must catch:

- write checkpoint before messages;
- remove entity serialization;
- accept arbitrary dedupe as an exact seam;
- model overlapping receipts as whole-page adjacency or ignore an order-edge conflict;
- drop an unresolved mutation;
- delete a resolved-operation receipt;
- order mutations by observation time;
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
| Newer correction is fetched before an older correction in a backward walk | Canonical order-edge traversal wins; the older correction never replaces the newer one |
| Resolved correction page is replayed after restart | Retained operation receipt prevents duplicate/non-idempotent application |
| Two mutation islands have no proven seam | Target remains provisional until a query links and refolds them |
| Context island overlaps fetch-latest but not known endpoint | Segments remain separate |
| Fetch-latest observes exact old endpoint | Segments may merge after atomic commit |
| Same-domain pages partially overlap with different sizes | Shared entry nodes align consistent edges; no duplicate or whole-page adjacency assumption |
| Stable pages assert conflicting neighbors | Component becomes explicit provisional/unavailable; engine never chooses an arbitrary branch |
| Floor purged on page two | Boundary invalidated; conservative bootstrap starts |
| Cursor purged beyond server retention | Explicit unavailable gap remains |
| Reset during pending commit | Old commit conflicts and cannot repopulate state |
| Account A finishes after switch to B | No A data or metadata reaches B |
| Delete then recreate same entity | New entity generation ignores old callbacks |
| Duplicate page replay | No duplicate message, mutation, or coverage |
| `stable=false` page | Data may appear; definitive gap closure waits for validation |
| Same seam later returns stable | Provisional proof is promoted once, without duplicate effects |
| Server remains unstable | Persisted backoff/status prevents a hot retry loop |
| Stable empty archive | Durable empty terminal proof prevents repeated bootstrap |
| Renderable `noLocalStore` entry | Content-free disposition persists; explicit `blocked-policy` gap, no false coverage or hot loop |
| MAM result lacks a usable archive ID | Deterministic raw quarantine and `unavailable-protocol` persist; no coverage, loss, duplicate on identical replay, or hot retry |
| Malformed result still has an archive ID | Archive-identified ordered quarantine persists and may satisfy the durable-outcome contract without losing its position |
| Raw page is `[A, missing-ID, C]` | Receipt preserves all raw indexes; no `A -> C` edge, seam, terminal fact, or coverage is fabricated |
| Existing v3 cache with no coverage | Messages retained as islands; live coverage bootstrapped |
| Legacy coverage over empty cache | Coverage discarded; bootstrap required |
| Legacy coverage extends beyond/behind retained cache rows | Content remains unproven; positive legacy boundary is discarded and re-established from MAM |
| Timestamp-only gap and ID-bearing legacy gap | Both are repair hints only; neither creates positive proof |
| Multiple legacy/context islands | They remain separate until each exact seam is proven |
| Corrupt/interrupted or ambiguously scoped migration | Restart/quarantine is deterministic; no cross-account import |
| Same stanza/origin ID in two entities or accounts | Entity/sender-scoped aliases keep distinct canonical rows |
| Several messages share a timestamp across backward pages | Receipt graph and ordinal preserve archive/UI order; timestamp ties do not reorder them |
| Live message, carbon, then MAM reflection | One canonical row gains aliases; no rekey or duplicate |
| Live mutation during long backward catch-up, then MAM reflection | Live effect is prompt but provisional; archive alias/position later refolds it once without duplicate application |
| Encrypted signal arrives before unlock | Durable ciphertext resumes on unlock at its original archive position |
| Encrypted fallback message is later decrypted/reflected | Encryption-quality guard and aliases update one canonical row without degrading cleartext |
| Materializer version changes | Old affected proof conflicts and is conservatively revalidated |
| Page cap then restart | Durable semantic job resumes from a proven boundary |
| XEP-0490 pointer changes during catch-up | Durable pointer intent coalesces `ensureReadPointer`; no synthetic live/archive entry or false coverage |
| Public entity/account cache deletion | Messages and proof clear atomically; durable generation increments and survives |
| Individual delete by stanza/origin alias targets a message with operations | Canonical row, aliases, dependent projection and affected proof are invalidated together, or the API rejects ambiguity |
| Delete races an ownership transition | Switching fence yields one transactional winner; no stale proof/alias survives |
| Chat owner engine-v1 while room owner legacy | Exactly one writer exists for every entity kind |
| Compatible old tab races owner switch | Ownership revision fences its late positive-state write |
| Crash during either switching mode | Restart resumes or explicitly rolls back the fenced transition; it never schedules both owners |
| Engine → legacy → engine, with correction/delete during legacy | Engine proof epoch changes; old segments/receipts/jobs are unusable and the second engine activation bootstraps before positive coverage |
| Pre-v4 tab keeps an IndexedDB v3 connection open | v4 upgrade remains safely blocked/legacy-owned and exposes reload guidance; no partial cut-over |
| v4 cache opened by v3-only binary | Explicit unsupported `VersionError` path; no claim of safe downgrade |
| Crash after commit before UI event | Restart reconstructs correct projection from IndexedDB |

## Implementation tasks

### Task 0: Freeze the safety contract and independent oracle

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/testing/ModelArchive.ts`
- Create: `packages/fluux-sdk/src/sync/mam/testing/failureSchedule.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncEngine.contract.test.ts`
- Modify: `packages/fluux-sdk/package.json`
- Modify: `package-lock.json`
- Modify selectively: existing MAM/store tests that encode unsafe immediate transitions

**Steps:**

- [ ] Run `npm install -w packages/fluux-sdk -D fast-check` so both the package manifest and root lockfile record the direct dependency.
- [ ] Implement deterministic `ModelArchive` with opaque IDs, pagination, purge, signals, and stable/unstable results.
- [ ] Define the invariant assertions independently of production code.
- [ ] Export an uninstantiated `runMamSyncEngineContract(factory)` fixture. Execute only the oracle/failure-scheduler self-tests until Task 6 supplies a factory; do not merge a deliberately red placeholder suite.
- [ ] Catalogue legacy tests that claim unsafe immediate progress. Invert them only when the matching safety patch or engine-v1 path lands; never adopt them as the new oracle.
- [ ] Keep protocol parsing and public UX tests unchanged.

**Gate:** the oracle and failure scheduler test themselves; the repository remains green and the uninstantiated contract factory creates no skipped/red production assertion.

**Suggested commit:** `test(mam): add durable sync oracle and crash contract`

### Task 1: Add domain contracts and pure coverage model

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/types.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamTransport.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncRepository.ts`
- Create: `packages/fluux-sdk/src/sync/mam/coverageModel.ts`
- Create: `packages/fluux-sdk/src/sync/mam/coverageModel.test.ts`

**Steps:**

- [ ] Define entities, query-domain fingerprints, raw/prepared entries, generations, message aliases, page receipts, operation positions, segments, terminal facts, gaps, jobs, and committed deltas.
- [ ] Implement pure exact-seam segment creation, extension, merge, purge, stable-empty proof, and provisional-to-stable transitions.
- [ ] Implement a pure canonical order-edge graph that composes exact cursor seams and same-domain page overlaps, never timestamps/ID sorting/discovery order.
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
- [ ] Handle cooperative `versionchange` closure plus `blocked`/`blocking`/termination states; never mark migration ready while an old connection blocks v4.
- [ ] Add `mam-sync-messages`, `mam-sync-aliases`, `mam-sync-meta`, temporary `mam-legacy-state`, `mam-sync-state`, `mam-sync-pages`, `mam-sync-order`, `mam-sync-quarantine`, `mam-sync-operations`, and `mam-sync-jobs` in the next DB version.
- [ ] Preserve existing chat and room message rows during upgrade.
- [ ] Initialize immutable account identity, per-kind ownership revisions plus engine/legacy proof epochs, cache generation, and materializer version.
- [ ] Implement resumable per-source migration tracks without trusting legacy coverage.
- [ ] Keep existing `@fluux/sdk/cache` read/write behavior unchanged while ownership is legacy; defer destructive API routing to Task 4.
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

- [ ] Build entity-scoped canonical messages and typed aliases; preserve protocol IDs without using them as global primary keys.
- [ ] Persist deterministic page receipts and operation positions in canonical archive order.
- [ ] Upsert page-interior, exact before/after, and consistent overlap edges only for wholly certifiable receipts; `[A, missing-ID, C]` creates no `A -> C` edge or seam. Quarantine conflicts.
- [ ] Upsert the full persistable MAM page, including RAM duplicates.
- [ ] Fold corrections, retractions, reactions, and fastenings from the base message through the retained operation log.
- [ ] Journal missing-target and pending-decrypt operations.
- [ ] Recompute when a target arrives, order components connect, or decryption unlocks; never delete the operation receipt.
- [ ] Persist deterministic quarantine plus `unavailable-protocol` for entries without a usable archive ID; archive-identified parse failures remain durable ordered quarantine. Reject false coverage/hot retries and keep disconnected operation order provisional.
- [ ] Define deterministic ignored-entry policy with `materializerVersion`.
- [ ] Persist a content-free `noLocalStore` disposition and a `blocked-policy` gap without a retry loop or positive history coverage.
- [ ] Add failpoints around every write stage.

**Gate:** crash/restart at every materializer failpoint satisfies the primary contract.

**Suggested commit:** `feat(mam-sync): atomically materialize pages and pending mutations`

### Task 4: Implement atomic page commit, generations, and reset semantics

**Files:**

- Modify: `packages/fluux-sdk/src/sync/mam/IndexedDbMamSyncRepository.ts`
- Modify: `packages/fluux-sdk/src/sync/mam/IndexedDbMamSyncRepository.test.ts`
- Create: `packages/fluux-sdk/src/sync/mam/generationIsolation.test.ts`
- Modify: `packages/fluux-sdk/src/utils/messageCache.ts`
- Modify: `packages/fluux-sdk/src/utils/messageCache.test.ts`
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts`

**Steps:**

- [ ] Validate account, expected per-kind ownership mode/revision, engine proof epoch, cache generation, entity generation, materializer version, and expected revision inside the transaction.
- [ ] Run the pure coverage transition only after all page outcomes are prepared.
- [ ] Commit materialization, page/operation/disposition receipts, segments, jobs, and revision together.
- [ ] On materializer-version change, retain reusable content/receipts but invalidate affected positive proofs and schedule conservative revalidation.
- [ ] Implement atomic `clearEntity` and `clearAccount`, retaining and incrementing entity/meta generation tombstones.
- [ ] Route `deleteConversationMessages`, `deleteRoomMessages`, `clearAllMessages`, and store reset/delete callers through the repository transaction before either cut-over can be enabled.
- [ ] For any public individual-message deletion that remains supported, invalidate the affected segment conservatively in the same transaction; otherwise deprecate/block it in engine-v1 mode.
- [ ] Test deletion by canonical key and every accepted alias, deletion of a mutation target, ambiguous aliases, and deletion during both ownership switching modes; assert rows, aliases, receipts/proof, gaps, and projections stay coherent.
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
- Modify: `packages/fluux-sdk/src/core/modules/Chat.mam.test.ts`

**Steps:**

- [ ] Extract one-page query construction and collector lifecycle.
- [ ] Return canonical oldest-to-newest serializable raw envelopes, including mutation archive IDs, without applying materializer policy.
- [ ] Preserve missing-ID envelopes (including malformed envelopes without a usable ID) as typed uncertifiable entries; use archive-identified quarantine when the ID is known. Never return/store raw XML elements.
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
- [ ] Implement `updateReadPointer`, `ensureLive`, `ensureReadPointer`, `ensureOlder`, `ensureAround`, `repairGap`, `retryPendingDecrypt`, and startup job resumption.
- [ ] Plan every request from durable segments and exact endpoints.
- [ ] Handle page/time caps by atomically persisting semantic continuation intent and a proven next boundary before returning partial status.
- [ ] Handle purge on any page.
- [ ] Treat explicit `stable=false` as provisional, omitted `stable` as stable, and persist bounded retry/backoff state.
- [ ] Coalesce compatible commands and cancel obsolete runs.
- [ ] Schedule one network page per entity turn so live ingestion can preempt a long catch-up between pages.
- [ ] Run the full contract against memory and IndexedDB repositories.

**Gate:** deterministic, failure-injection, and property suites converge to `ModelArchive` or expose an explicit unavailable gap.

**Suggested commit:** `feat(mam-sync): add serialized durable synchronization engine`

### Task 7: Add projection and fenced adapters with ownership still legacy

**Files:**

- Create: `packages/fluux-sdk/src/sync/mam/SyncProjector.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncOwnership.ts`
- Create: `packages/fluux-sdk/src/sync/mam/LegacyMamStateAdapter.ts`
- Create: `packages/fluux-sdk/src/sync/mam/LegacyMamImporter.ts`
- Create: `packages/fluux-sdk/src/sync/mam/MamSyncOwnership.test.ts`
- Create: `packages/fluux-sdk/src/sync/mam/LegacyMamStateAdapter.test.ts`
- Create: `packages/fluux-sdk/src/sync/mam/LegacyMamImporter.test.ts`
- Create: `packages/fluux-sdk/src/sync/mam/SyncProjector.test.ts`
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts`
- Modify: `packages/fluux-sdk/src/core/storeBindingKeys.ts`
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts`
- Modify: `packages/fluux-sdk/src/stores/chatStore.test.ts`
- Modify: `packages/fluux-sdk/src/stores/roomStore.test.ts`
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.test.ts`

**Steps:**

- [ ] Add committed-delta projection and full repository rehydrate for resident chat/room windows.
- [ ] Add the per-kind durable owner reader and ownership-revision fence to both legacy and engine adapters.
- [ ] Route compatible-build legacy saves, deletes, gap/coverage commits, and clear operations through `LegacyMamStateAdapter`; stop direct positive-state writes to localStorage before switches are enabled.
- [ ] Run resumable initial chat/room/localStorage imports while legacy owns the kind, and mirror subsequent content mutations (never positive proof) into canonical rows.
- [ ] Import timestamp/ID gap data only as repair hints and discard legacy positive coverage from every engine decision.
- [ ] Record enough source identity/deletion information for the switching-phase reconciliation; reject the ambiguous individual-delete API once preparation starts unless it resolves one entity-scoped canonical alias.
- [ ] Implement and test the reverse `switching-to-legacy` transition now: increment engine/legacy proof epochs, invalidate current engine proof/jobs while retaining content as islands, force server bootstrap, and forbid every cache-derived/legacy cursor until bootstrap completes.
- [ ] Gate the fire-and-forget `chatStore.deserializeState()` message migration behind legacy chat mode **and** a still-pending new migration track; engine migration is never started from deserialization.
- [ ] Derive projected gap/status state without removing legacy fields while the owner remains legacy.
- [ ] Register engine adapters with both production owners hard-coded to legacy.
- [ ] Test restart after a committed page whose UI delta was lost and every `{chat, room} × {legacy, switching-to-engine, engine-v1, switching-to-legacy}` mode without yet flipping production.

**Run:** `cd packages/fluux-sdk && npx vitest run src/sync/mam/SyncProjector.test.ts src/sync/mam/MamSyncOwnership.test.ts src/sync/mam/LegacyMamStateAdapter.test.ts src/sync/mam/LegacyMamImporter.test.ts src/bindings/storeBindings.test.ts`

**Gate:** all existing behavior remains legacy-owned and green; projector/ownership infrastructure has no second authoritative sync writer, and compatible rollback is implemented before any engine owner can be enabled.

**Suggested commit:** `feat(mam-sync): add fenced projection adapters behind legacy ownership`

### Task 8: Cut chat over in independently green slices

**Files:**

- Modify: `packages/fluux-sdk/src/core/chatSideEffects.ts`
- Modify: `packages/fluux-sdk/src/core/chatSideEffects.test.ts`
- Modify: `packages/fluux-sdk/src/core/backgroundSync.ts`
- Modify: `packages/fluux-sdk/src/core/backgroundSync.test.ts`
- Modify: `packages/fluux-sdk/src/hooks/useChatActions.ts`
- Modify: `packages/fluux-sdk/src/hooks/useChatActions.fetchHistory.test.tsx`
- Modify: `packages/fluux-sdk/src/hooks/useChatActive.ts`
- Modify: `packages/fluux-sdk/src/hooks/useChatActive.renderStability.test.tsx`
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts`
- Modify: `packages/fluux-sdk/src/core/chatNetworkScenarios.test.ts`
- Modify: `packages/fluux-sdk/src/core/mdsSideEffects.test.ts`
- Modify: `packages/fluux-sdk/src/stores/chatStore.mds.test.ts`
- Modify: `packages/fluux-sdk/src/stores/shared/readMarkerSync.test.ts`
- Modify: `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts`

**Slices:**

1. [ ] Project/rehydrate canonical chat rows with chat owner still legacy.
2. [ ] Route background and conversation-open work to `ensureLive`/`ensureReadPointer` behind the owner adapter; run targeted tests.
3. [ ] Route scroll-older, context, and gap repair; run hook/scroll tests.
4. [ ] Route live messages, carbons, reflections, and corrections through `ingestLive`; route XEP-0490 changes through `updateReadPointer`; verify none bypasses the repository.
5. [ ] Stop engine-mode chatStore MAM writes and legacy gap/coverage transitions; keep the legacy branch intact for rollback.
6. [ ] Enter `switching-to-engine`, finish and reconcile chat import deltas/deletions under the write fence, then enter `engine-v1`; required tracks must be complete or terminally quarantined before the final transition.

Each slice must be committed or otherwise reviewable with all tests green. Do not combine the owner flip with untested routing changes.

**Run:** `cd packages/fluux-sdk && npx vitest run src/core/chatSideEffects.test.ts src/core/backgroundSync.test.ts src/hooks/useChatActions.fetchHistory.test.tsx src/stores/chatStore.test.ts`

**Gate:** chat engine-v1 is the sole chat owner across background, foreground, live, carbon, reflection, pointer, context, and repair paths; rooms remain legacy.

**Suggested commits:** `feat(mam-sync): route chat history through durable adapters`, then `feat(mam-sync): switch chat ownership to engine v1`

### Task 9: Cut rooms over with the same engine contract

**Files:**

- Modify: `packages/fluux-sdk/src/core/roomSideEffects.ts`
- Modify: `packages/fluux-sdk/src/core/roomSideEffects.test.ts`
- Modify: `packages/fluux-sdk/src/core/backgroundSync.ts`
- Modify: `packages/fluux-sdk/src/hooks/useRoom.ts`
- Modify: `packages/fluux-sdk/src/hooks/useRoomActions.ts`
- Modify: `packages/fluux-sdk/src/hooks/useRoomActive.ts`
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts`
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts`
- Modify: `packages/fluux-sdk/src/core/networkScenarios.test.ts`
- Modify: `packages/fluux-sdk/src/stores/roomStore.mds.test.ts`
- Modify: `packages/fluux-sdk/src/stores/shared/readMarkerSync.test.ts`
- Modify: `packages/fluux-sdk/src/core/modules/Chat.mam.test.ts`
- Modify: `packages/fluux-sdk/src/hooks/useRoom.test.tsx`
- Modify: `packages/fluux-sdk/src/hooks/useRoom.fetchOlderHistory.regression.test.tsx`
- Modify: `packages/fluux-sdk/src/hooks/useRoomOccupantCount.renderStability.test.tsx`
- Add: room-specific engine contract cases

**Slices:**

1. [ ] Project/rehydrate canonical room rows while room ownership remains legacy.
2. [ ] Route background/open and then older/context/repair commands behind the room owner adapter.
3. [ ] Route live/reflection/mutation paths through `ingestLive`, XEP-0490 changes through `updateReadPointer`, and remove engine-mode fire-and-forget room transactions.
4. [ ] Verify occupant-scoped aliases and temporary-key-to-validated-stanza-ID promotion never duplicate or target the wrong sender.
5. [ ] Run multi-page backward ordering, signal-before-target, page-N failure, reaction replacement, and resident-window tests.
6. [ ] Enter `switching-to-engine`, finish and reconcile room import deltas/deletions under the write fence, then enter `engine-v1`; rerun the shared contract for both kinds.

**Run:** `cd packages/fluux-sdk && npx vitest run src/core/roomSideEffects.test.ts src/hooks/useRoom.test.tsx src/hooks/useRoom.fetchOlderHistory.regression.test.tsx src/stores/roomStore.test.ts`

**Gate:** the same engine contract passes for chat and rooms; only transport parsing and entity identity policy differ.

**Suggested commits:** `feat(mam-sync): route room history through durable adapters`, then `feat(mam-sync): switch room ownership to engine v1`

### Task 10: Verify migration/rollback and retire direct legacy writers

**Files:**

- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`
- Modify: `packages/fluux-sdk/src/stores/shared/mamGap.ts`
- Modify: `packages/fluux-sdk/src/stores/shared/mamCoverage.ts`
- Modify: `packages/fluux-sdk/src/stores/shared/mamState.ts`
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts`
- Modify: `packages/fluux-sdk/src/core/sessionLifecycle.test.ts`
- Modify: `packages/fluux-sdk/src/stores/connectionStore.ts`
- Modify: `packages/fluux-sdk/src/stores/connectionStore.test.ts`
- Modify: `docs/MAM_CATCHUP.md`
- Add: migration, owner-switch, and rollback/downgrade tests

**Steps:**

- [ ] Verify the pre-cut-over import/quarantine tracks and test that no legacy positive coverage was promoted to engine proof.
- [ ] Remove the old localStorage message import after its engine migration track and chat cut-over are complete.
- [ ] Remove old direct Zustand/localStorage legacy cursor writers after both cut-overs. Keep `LegacyMamStateAdapter` writable **only when mode is `legacy`** so compatible rollback can bootstrap and stamp current-epoch proof during the agreed window.
- [ ] Re-run rollback contracts against the shipped adapters and assert the v4 legacy adapter refuses every cache-shape, legacy coverage, gap-ID, and timestamp cursor until server bootstrap clears `legacyBootstrapRequired` in the current proof epoch.
- [ ] Test corrupt/interrupted/ambiguous migrations, compatible rollback, and the explicit unsupported v4-to-v3 `VersionError` path.
- [ ] After the rollback window in an explicitly later release/task, delete `LegacyMamStateAdapter`, `mam-legacy-state`, obsolete metadata, MAM merge events, and store-binding keys.
- [ ] Update shipped architecture documentation at each ownership milestone.

**Gate:** no production path writes synchronization truth to Zustand/localStorage, and no importer or legacy writer runs in parallel with engine ownership.

**Suggested commit:** `refactor(mam-sync): retire direct legacy gap and coverage writers`

### Task 11: Full verification, performance baseline, and release gate

**Files:**

- Add or update benchmark fixtures and debug telemetry tests
- Update this plan's checklist and self-review

**Steps:**

- [ ] Run all pure, repository, contract, property, migration, and adapter suites.
- [ ] Run each acceptance scenario under every relevant failpoint.
- [ ] Run explicit control mutations and confirm multiple failures.
- [ ] Measure transaction duration, page throughput, pending-operation lookup, and segment compaction.
- [ ] Measure retained page/operation receipt and order-edge growth plus canonical alias lookup/traversal cost.
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
- canonical messages, page receipts, and all mutation/disposition receipts are durable before coverage;
- canonical order edges make message/mutation projection recomputable after replay, backward pagination, partial overlap, and island connection;
- malformed/missing-ID entries and order conflicts have deterministic quarantine plus explicit non-coverage status;
- all positive coverage lives in the same IndexedDB transaction domain as message data;
- account, ownership, engine-proof, cache, entity, materializer, and revision fences prevent late writes, stale rollback proof, and cross-account contamination;
- generation tombstones survive account/entity deletion and restart;
- context islands cannot bridge live coverage without an exact seam;
- cursor purge on any page produces conservative recovery;
- page caps and policy blocks have durable resumable/terminal state;
- ownership switches and rollback resume from durable intermediate modes without dual authoritative writers;
- Zustand and localStorage no longer own MAM cursors, gaps, or coverage;
- existing public hooks and UI behavior remain compatible;
- after any tested crash trace, restart converges to the reference model or exposes an explicit irrecoverable gap.

## Self-review checklist

- [ ] Does every durable cursor have a same-transaction durable effect set?
- [ ] Are signals modeled as retained, ordered operations rather than empty pages?
- [ ] Can an older mutation discovered later ever override a newer archive mutation?
- [ ] Does replay remain idempotent after a mutation was already materialized?
- [ ] Is every asynchronous callback bound to immutable account and generation tokens?
- [ ] Can a context island ever be mistaken for live coverage?
- [ ] Does `domainKey` describe only result-set membership, independent of command/pagination mechanics?
- [ ] Do partial page overlaps compose through entry edges rather than whole-page adjacency?
- [ ] Can a later page advance past a failed page commit?
- [ ] Can reset/delete and a late callback resurrect state?
- [ ] Do every public cache deletion path and entity recreate invalidate proof atomically?
- [ ] Can old localStorage coverage influence a positive engine-v1 proof?
- [ ] Does restart require only IndexedDB, not Zustand memory?
- [ ] Are chat and room behavior driven by one engine contract?
- [ ] Does a purged server range stay explicitly incomplete?
- [ ] Are performance and observability bounded?
- [ ] Can the rollout be stopped without two owners touching one entity?
- [ ] Are localStorage records non-authoritative and fenced by a durable legacy proof epoch?
- [ ] Does every engine→legacy transition invalidate the prior engine proof epoch before content can change under legacy ownership?
- [ ] Can a capped job resume after restart without an in-memory caller?
- [ ] Are stable-empty, unstable, missing-ID, and `blocked-policy` outcomes explicit?

## Decisions intentionally deferred

- Whether engine commands become a curated public SDK API after internal stabilization.
- How page/operation receipts and order edges may eventually be compacted while preserving replay detection and archive-order proof.
- Whether production shadow diagnostics provide enough value to justify their storage/network cost.
- Whether multi-tab efficiency should use Web Locks in addition to the mandatory IndexedDB revision check.
- The exact user-visible wording for recoverable, purged, provisional, and policy-unavailable gaps; the internal states are not deferred.

These decisions must not weaken the primary contract or delay the internal transactional boundary.
