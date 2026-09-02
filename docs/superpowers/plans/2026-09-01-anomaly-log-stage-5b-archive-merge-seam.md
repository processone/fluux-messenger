# Anomaly log stage 5b — archive merge outcome seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every archive merge a single reported outcome — how many rows it
returned and what durably happened to each of them — and turn that into the MAM page-yield rate and
a detector for a failed durable write.

**Architecture:** A shared store-side diagnostic module owns the subscription and the arithmetic.
`chatStore.mergeMAMMessages` and `roomStore.mergeMAMMessages` already compute every input the
dispositions need and already hold the two promises that say whether the write landed; they report
once both settle. The app subscribes, counts rows, and records one invariant.

**Tech Stack:** TypeScript, Zustand vanilla stores, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md` §5.2, §5.4, §5.5
seam 2. Predecessor: `docs/superpowers/plans/2026-08-31-anomaly-log-stage-5a-outbound-stanza-seam.md`.

## Two facts that change the spec's plan

Both were verified against the current code on 2026-09-01. The spec is a month old and its §5.5 is
wrong on each.

**1. Archive patches are not fire-and-forget.** §5.5 says the seam "requires tracking them rather
than discarding the promise — a small change to product code". That was true of the `void
messageCache.updateMessage(...)` calls on the live paths (reactions, retractions, live stanza-id
backfill), but **not** of the archive merge. `chatStore.ts:3005-3007` builds
`archiveWriteMessages = [...persistableMessages, ...persistablePatches]` and writes both in **one**
`messageCache.saveMessages` transaction (`:3105`), gated through `conversationArchiveSaves.chain`.
`roomStore.ts:4029-4031` and `:4120-4122` are identical. **No product-code change is needed** — the
promise this seam must await already exists and is already awaited for the gap/coverage commit.

**2. There is no query id at merge time.** §5.5 types the payload with `queryId: string`.
`MAM.ts` emits `chat:history-messages` once per walk, with `allMessages` accumulated across every
page, while forward room history is emitted per page. Neither store event retains the collector's
protocol-query id, so such a field could only carry an invented value. The payload instead carries
what actually exists and is useful: the entity (raw JID, tokenized by the app at the recorder
boundary, per the §5.5 boundary rule), its kind, the direction, and whether the walk reported
complete.

A third, smaller consequence: the two booleans the stores hold give `partial` a truer meaning than
the spec guessed. `saveMessages` is one IndexedDB transaction and so is all-or-nothing per merge;
`chain()` ANDs it with every earlier in-flight page for the same entity
(`stores/shared/archiveSaveChain.ts`). So `partial` is observable, and it means: **this** merge's
write landed while an **earlier** one for the same entity did not — the rows are on disk but the
durable cursor is frozen. That is exactly §5.5's "at least one attempted write succeeded and at
least one failed", distributed across the pages of a catch-up rather than within one page.

## Global Constraints

- **No payload is built when nobody is subscribed.** The stores guard every computation behind
  `hasArchiveMergeSubscribers()`; with the seam unused the cost is one predicate call per merge.
- **The SDK never emits anomaly types.** The payload is plain data with a raw JID; `Token` and the
  HMAC key stay in `apps/fluux/src/anomaly/`.
- **Every returned row gets exactly one disposition**, and they balance:
  `returned === retained + deduplicated + patched + intentionallyUnstored + persistenceFailed`.
- **The store is not made to do more work than it already does.** No new write, no new await on a
  path that did not already have one, no change to when gap or coverage transitions commit.
- **Registry parity.** Any new `ID` needs a row in `docs/ANOMALY_INVARIANTS.md`; `values.test.ts`
  checks both directions, and its regex treats any `` `a-b/c-d` `` in the doc as a declared id.
- **The yield is a rate, not an invariant id.** §5.2 gives `mam-page-yield` severity `drift`, and
  §5.4 says drift verdicts are computed **only** on rates. Minting an id for it would be a category
  error; it ships as `mam.rowsRetained/rowsReturned`.
- **The rate ships informational.** `docs/anomaly-baseline.json` requires the build-stamp question
  (dirty rebuilds from one short HEAD share a series) to be settled before *any* rate becomes
  judgeable. That is a maintainer decision, not a side effect of this plan.

## What each disposition means here

Read against `timeline.mergeArchive` (`stores/shared/messageTimeline.ts:139`), whose `newMessages`
are rows new to the **resident window** and whose `patched` are **resident** messages that gained a
server stanza-id from an archived copy — the archived copy itself then dedupes away.

| disposition | source |
|---|---|
| `retained` | new to the window, persistable, and the write committed |
| `patched` | a duplicate row that carried a durable stanza-id backfill, and the write committed |
| `deduplicated` | `returned - newMessages - patched`: a duplicate that wrote nothing |
| `intentionallyUnstored` | `noLocalStore` rows, whether new or patching (`isNoLocalStore` filters them out of `persistableMessages` / `persistablePatches` on purpose) |
| `persistenceFailed` | every row whose attempted write did not commit — on failure, `retained` and `patched` are 0 and their rows move here |

---

### Task 1: The diagnostics module

**Files:**
- Create: `packages/fluux-sdk/src/stores/shared/archiveMergeDiagnostics.ts`
- Test: `packages/fluux-sdk/src/stores/shared/archiveMergeDiagnostics.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type ArchiveMergeOutcome = 'durable' | 'partial' | 'failed'
  export interface ArchiveMergeInputs {
    returned: number; newMessages: number; persistableNew: number
    patched: number; persistablePatched: number
  }
  export interface ArchiveMergeReport {
    entityKind: 'chat' | 'room'
    /** Raw JID. The consumer tokenizes it; the SDK never sees a token. */
    entityId: string
    direction: 'backward' | 'forward'
    complete: boolean
    outcome: ArchiveMergeOutcome
    returned: number; retained: number; deduplicated: number
    patched: number; intentionallyUnstored: number; persistenceFailed: number
  }
  export function onArchiveMerge(handler: (report: ArchiveMergeReport) => void): () => void
  export function hasArchiveMergeSubscribers(): boolean
  export function describeArchiveMerge(inputs: ArchiveMergeInputs, ownWriteCommitted: boolean,
    chainCommitted: boolean, attempted: boolean): Pick<ArchiveMergeReport, 'outcome' | 'returned' |
    'retained' | 'deduplicated' | 'patched' | 'intentionallyUnstored' | 'persistenceFailed'>
  export function reportArchiveMerge(report: ArchiveMergeReport): void
  export function resetArchiveMergeDiagnosticsForTesting(): void
  ```

- [ ] **Step 1: Write the failing test**

Cover the balance on every path, the outcome table, and the subscriber guard.

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  describeArchiveMerge, hasArchiveMergeSubscribers, onArchiveMerge, reportArchiveMerge,
  resetArchiveMergeDiagnosticsForTesting, type ArchiveMergeReport,
} from './archiveMergeDiagnostics'

afterEach(() => resetArchiveMergeDiagnosticsForTesting())

const page = { returned: 10, newMessages: 6, persistableNew: 5, patched: 2, persistablePatched: 1 }

function balances(r: Pick<ArchiveMergeReport, 'returned' | 'retained' | 'deduplicated' | 'patched' |
  'intentionallyUnstored' | 'persistenceFailed'>): boolean {
  return r.returned === r.retained + r.deduplicated + r.patched + r.intentionallyUnstored +
    r.persistenceFailed
}

describe('describeArchiveMerge', () => {
  it('accounts for every returned row when the write commits', () => {
    const r = describeArchiveMerge(page, true, true, true)
    expect(r).toMatchObject({
      outcome: 'durable', returned: 10, retained: 5, patched: 1,
      // 1 new + 1 patching row were noLocalStore; 10 - 6 new - 2 patched = 2 plain duplicates.
      intentionallyUnstored: 2, deduplicated: 2, persistenceFailed: 0,
    })
    expect(balances(r)).toBe(true)
  })

  it('moves both written kinds to persistenceFailed when the write fails', () => {
    const r = describeArchiveMerge(page, false, false, true)
    expect(r).toMatchObject({ outcome: 'failed', retained: 0, patched: 0, persistenceFailed: 6 })
    expect(balances(r)).toBe(true)
  })

  it('calls a merge partial when its own write landed behind a failed earlier page', () => {
    const r = describeArchiveMerge(page, true, false, true)
    expect(r.outcome).toBe('partial')
    // The rows ARE on disk. Only the durable cursor is frozen, so they are retained.
    expect(r.retained).toBe(5)
    expect(balances(r)).toBe(true)
  })

  it('is durable when nothing was attempted', () => {
    const nothing = { returned: 4, newMessages: 0, persistableNew: 0, patched: 0, persistablePatched: 0 }
    const r = describeArchiveMerge(nothing, true, true, false)
    expect(r).toMatchObject({ outcome: 'durable', deduplicated: 4, retained: 0 })
    expect(balances(r)).toBe(true)
  })

  it('never reports a negative duplicate count', () => {
    // Defensive: patched rows are duplicates by construction, so this cannot
    // happen — but a clamp here beats a nonsense record if the timeline changes.
    const odd = { returned: 1, newMessages: 1, persistableNew: 1, patched: 1, persistablePatched: 1 }
    expect(describeArchiveMerge(odd, true, true, true).deduplicated).toBe(0)
  })
})

describe('subscription', () => {
  it('reports nothing and claims no subscribers when nobody listens', () => {
    expect(hasArchiveMergeSubscribers()).toBe(false)
  })

  it('delivers a report to every subscriber and stops on unsubscribe', () => {
    const seen: ArchiveMergeReport[] = []
    const off = onArchiveMerge((r) => seen.push(r))
    expect(hasArchiveMergeSubscribers()).toBe(true)

    const report: ArchiveMergeReport = {
      entityKind: 'chat', entityId: 'a@example.com', direction: 'forward', complete: true,
      outcome: 'durable', returned: 1, retained: 1, deduplicated: 0, patched: 0,
      intentionallyUnstored: 0, persistenceFailed: 0,
    }
    reportArchiveMerge(report)
    off()
    reportArchiveMerge(report)

    expect(seen).toEqual([report])
    expect(hasArchiveMergeSubscribers()).toBe(false)
  })

  it('contains a throwing subscriber', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    onArchiveMerge(() => { throw new Error('detector bug') })
    onArchiveMerge((r) => seen.push(r.entityId))

    reportArchiveMerge({
      entityKind: 'room', entityId: 'room@conf.example.com', direction: 'backward', complete: false,
      outcome: 'failed', returned: 0, retained: 0, deduplicated: 0, patched: 0,
      intentionallyUnstored: 0, persistenceFailed: 0,
    })

    // A diagnostic subscriber must not take the merge down with it.
    expect(seen).toEqual(['room@conf.example.com'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
```

- [ ] **Step 2: Run it and watch it fail** — `cd packages/fluux-sdk && npx vitest run
  src/stores/shared/archiveMergeDiagnostics.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement the module** with the disposition arithmetic in one place, the subscriber
  Set, and a `try/catch` per handler.

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Export it** from `packages/fluux-sdk/src/stores/index.ts` and
  `packages/fluux-sdk/src/index.ts` (public compatibility surface — the export is
  `onArchiveMerge` plus the two types; `reportArchiveMerge`, `describeArchiveMerge` and the reset
  stay internal to the SDK, exported from the module for the stores and its own test only).

- [ ] **Step 6: Commit** — `feat(sdk): report what an archive merge did with every row`

---

### Task 2: Report from the chat store

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`mergeMAMMessages`, `:2881-3245`)
- Test: `packages/fluux-sdk/src/stores/chatStore.archiveMerge.test.ts` (new)

**Interfaces:**
- Consumes: Task 1.

The counts are computed inside `set()`, where `newMessages`, `patched`, `persistableMessages` and
`persistablePatches` live; the report is emitted after both promises settle, next to the existing
`archiveCommitGate.then(...)` at `:3200`. Two new outer `let`s carry the state across, in the style
of the existing `durableMessages` and `archiveCommitGate`.

- [ ] **Step 1: Write the failing test** — drive `mergeMAMMessages` with a mocked `messageCache`,
  and assert: a durable page reports the right dispositions; a failed `saveMessages` reports
  `failed` with `persistenceFailed` carrying both kinds; a page where every row dedupes reports
  `durable` with `returned === deduplicated`; nothing is reported when no one subscribed.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** Inside `set()`, right after `archiveWriteMessages` is built:

```typescript
          // Diagnostics only: nothing is computed unless something is listening
          // (design §3.3 rule 2 applied inside the SDK).
          if (hasArchiveMergeSubscribers()) {
            mergeInputs = {
              returned: mamMessages.length,
              newMessages: newMessages.length,
              persistableNew: persistableMessages.length,
              patched: patched.length,
              persistablePatched: persistablePatches.length,
            }
          }
```

capture `ownWrite = savePromise` where the save is issued, and after `set()` returns:

```typescript
        if (mergeInputs) {
          const inputs = mergeInputs
          const attempted = inputs.persistableNew + inputs.persistablePatched > 0
          void Promise.all([ownWrite ?? Promise.resolve(true), archiveCommitGate ?? Promise.resolve(true)])
            .then(([own, chained]) => {
              reportArchiveMerge({
                entityKind: 'chat',
                entityId: conversationId,
                direction,
                complete,
                ...describeArchiveMerge(inputs, own, chained, attempted),
              })
            })
        }
```

- [ ] **Step 4: Run it and watch it pass**, then run the chat store suite:
  `npx vitest run src/stores/chatStore` — the merge is heavily tested and must be unchanged.

- [ ] **Step 5: Commit** — `feat(sdk): report the outcome of a chat archive merge`

---

### Task 3: Report from the room store

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (`:3939-4265`)
- Test: `packages/fluux-sdk/src/stores/roomStore.archiveMerge.test.ts` (new)

Identical shape to Task 2 — `newFromMAM` is the room's name for `newMessages`,
`messageCache.saveRoomMessages` the write, `roomArchiveSaves` the chain — with `entityKind: 'room'`
and `entityId: roomJid`.

- [ ] **Step 1: Write the failing test** (durable page, failed write, all-duplicates page).
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement**, mirroring Task 2.
- [ ] **Step 4: Run it and watch it pass**, then `npx vitest run src/stores/roomStore`.
- [ ] **Step 5: Commit** — `feat(sdk): report the outcome of a room archive merge`

---

### Task 4: Count the rows and record a failed write

**Files:**
- Modify: `apps/fluux/src/anomaly/values.ts` (`METRIC.mamRowsReturned`, `RATE.mamYield`,
  `ID.mamWriteFailed`)
- Create: `apps/fluux/src/anomaly/detectors/archiveMerge.ts`
- Test: `apps/fluux/src/anomaly/detectors/archiveMerge.test.ts`
- Modify: `apps/fluux/src/anomaly/install.ts` (subscribe)
- Modify: `apps/fluux/src/anomaly/install.test.ts`
- Modify: `docs/ANOMALY_INVARIANTS.md`

**Interfaces:**
- Produces: `createArchiveMergeDetector({ record, count, token })` with `observe(report)`.

`METRIC.mamRowsRetained` already exists and is currently never counted; this is what it was reserved
for. The new numerator/denominator pair is `mam.rowsRetained / mam.rowsReturned`, registered in
`RATE` as **informational** with the build-stamp reason stated in the comment.

`ID.mamWriteFailed` = `xmpp-traffic/mam-write-failed`, severity `bug`: a merge whose durable write
did not commit. Its `ctx` carries the entity token, `returned`, and `persistenceFailed`. `partial`
is deliberately **not** recorded: it means an *earlier* merge failed, and that merge already fired
this id — recording both would double-count one fault.

- [ ] **Step 1: Write the failing detector test** — counts on a durable page; counts plus one record
  on a failed page; no record on a `partial` page; no record and no counts on an empty page.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement the detector** and add the constants.
- [ ] **Step 4: Add the registry rows** for `xmpp-traffic/mam-write-failed`, replace the
  `_(stage 5 continues with mam-page-yield…)_` line with the rate's entry in the `resource/`
  section, and state the two named non-cases: `partial` is not recorded, and `deduplicated` counts
  rows already in the **resident window**, which is not proof they are in IndexedDB.
- [ ] **Step 5: Wire it in `install.ts`** — `onArchiveMerge` beside the traffic detector, released
  with the same hold; extend the install test with a control that a failed merge reaches the log.
- [ ] **Step 6: Run** `cd apps/fluux && npx vitest run src/anomaly` and the parity test.
- [ ] **Step 7: Commit** — `feat(anomaly): measure archive page yield and catch a failed archive write`

---

### Task 5: Close the slice

- [ ] **Step 1:** Add the two new ids to the healthy-session control in `scripts/anomaly-smoke.ts`.
- [ ] **Step 2:** Update §5.2 and §5.5 of the spec: mark `mam-page-yield` shipped as a rate, record
  that patches already ride the archive write (no product change was needed), and that the payload
  carries the entity rather than a `queryId`, with the reason.
- [ ] **Step 3:** Full verification — `npm test`, `npm run typecheck`, `npm run lint`,
  `npx playwright test --config playwright.e2e.config.ts --project=anomaly-chromium`,
  `npm run check:anomaly:prod`.
- [ ] **Step 4:** `$preflight-change`, then `$publish-change`.

## Self-review

**Spec coverage.** §5.5 seam 2 → Tasks 1–3, with the two documented deviations. §5.2
`mam-page-yield` → Task 4, as a rate because §5.4 forbids judging drift on anything else. §5.4's
"MAM pairing waits for the stage-5 seam" → Task 4's `RATE.mamYield`. The balance invariant → Task 1's
tests, asserted on every path rather than on the happy one.

**Placeholders.** Tasks 1 and 2 carry full code and test bodies; Tasks 3–5 are stated as deltas
against Task 2 with the exact symbols named, because repeating 200 lines of an identical store body
would be transcription rather than instruction.

**Type consistency.** `ArchiveMergeInputs` / `ArchiveMergeReport` / `describeArchiveMerge` /
`reportArchiveMerge` / `hasArchiveMergeSubscribers` are defined in Task 1 and used under those names
in Tasks 2–4. `entityKind` is `'chat' | 'room'` throughout, matching the stores' own vocabulary.
