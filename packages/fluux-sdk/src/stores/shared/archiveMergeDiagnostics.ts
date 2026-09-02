/**
 * What an archive merge did with every row it was given.
 *
 * A MAM delivery hands a message set to `chatStore.mergeMAMMessages` or its room twin,
 * which dedupes it against the resident window, back-fills stanza ids onto resident
 * copies, and writes what is persistable in ONE IndexedDB transaction. From outside
 * the store none of that is observable: the caller sees the message count the server
 * returned and nothing about what became of it.
 *
 * This module is the read-only view of that outcome. Every returned row gets exactly
 * one disposition, and they balance:
 *
 * ```
 * returned === retained + deduplicated + patched + intentionallyUnstored + persistenceFailed
 * ```
 *
 * The arithmetic lives here rather than in each store so the two cannot drift apart,
 * and so the balance can be tested without driving a store.
 *
 * @module Stores/Shared/ArchiveMergeDiagnostics
 */

export type ArchiveMergeOutcome = 'durable' | 'partial' | 'failed'

/** What the merge itself counted, before the write outcome is known. */
export interface ArchiveMergeInputs {
  /** Rows delivered to this store merge. */
  returned: number
  /** Rows new to the resident window. */
  newMessages: number
  /** Of those, the ones the write was allowed to store. */
  persistableNew: number
  /** Resident messages that gained a server stanza id from an archived copy. */
  patched: number
  /** Of those, the ones the write was allowed to store. */
  persistablePatched: number
}

export interface ArchiveMergeCounts {
  outcome: ArchiveMergeOutcome
  returned: number
  retained: number
  deduplicated: number
  patched: number
  intentionallyUnstored: number
  persistenceFailed: number
}

export interface ArchiveMergeReport extends ArchiveMergeCounts {
  entityKind: 'chat' | 'room'
  /**
   * The conversation id or room JID, raw.
   *
   * A diagnostic consumer that needs a privacy-safe identity derives it at its own
   * boundary; the SDK has no business minting one.
   */
  entityId: string
  direction: 'backward' | 'forward'
  /** Whether the walk reported the archive exhausted in that direction. */
  complete: boolean
}

type Handler = (report: ArchiveMergeReport) => void

const handlers = new Set<Handler>()

/**
 * Observe archive merges.
 *
 * Each handler receives its own report snapshot.
 *
 * @returns an unsubscribe function.
 */
export function onArchiveMerge(handler: Handler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/**
 * Whether anything is listening.
 *
 * The stores check this BEFORE counting: with no subscriber a merge must not pay for
 * a diagnostic nobody reads.
 */
export function hasArchiveMergeSubscribers(): boolean {
  return handlers.size > 0
}

/**
 * Split the returned rows into dispositions and name the outcome.
 *
 * `ownWriteCommitted` is this merge's own transaction; `chainCommitted` additionally
 * covers every earlier in-flight page for the same entity (see `archiveSaveChain.ts`).
 * The two differ exactly when an earlier page failed — the rows of THIS merge are on
 * disk while the durable cursor stays frozen, which is what `partial` names.
 */
export function describeArchiveMerge(
  inputs: ArchiveMergeInputs,
  ownWriteCommitted: boolean,
  chainCommitted: boolean,
  attempted: boolean
): ArchiveMergeCounts {
  const { returned, newMessages, persistableNew, patched, persistablePatched } = inputs

  // A patched row is a duplicate that also carried a stanza-id backfill, so the two
  // never overlap and plain duplicates are what is left. Clamped: a negative count
  // would be a nonsense record rather than a useful one.
  const deduplicated = Math.max(0, returned - newMessages - patched)
  const intentionallyUnstored = newMessages - persistableNew + (patched - persistablePatched)

  const outcome: ArchiveMergeOutcome = !attempted
    ? 'durable'
    : !ownWriteCommitted
      ? 'failed'
      : chainCommitted
        ? 'durable'
        : 'partial'

  const wrote = outcome !== 'failed'
  return {
    outcome,
    returned,
    retained: wrote ? persistableNew : 0,
    deduplicated,
    patched: wrote ? persistablePatched : 0,
    intentionallyUnstored,
    persistenceFailed: wrote ? 0 : persistableNew + persistablePatched,
  }
}

/**
 * Report a merge once its durable outcome is KNOWN, not when it is applied.
 *
 * A report written at merge time would claim a retention that can still fail, which
 * is the one distinction this seam exists to make. So the two write outcomes are
 * awaited first: `ownWrite` is this merge's own transaction, `chainGate` additionally
 * covers every earlier in-flight page for the same entity. An absent promise means
 * that gate had nothing to wait for, which counts as committed.
 *
 * Shared by both stores so the ordering rule cannot drift into one of them.
 */
export function reportArchiveMergeWhenDurable(
  identity: Omit<ArchiveMergeReport, keyof ArchiveMergeCounts>,
  inputs: ArchiveMergeInputs,
  writes: { ownWrite?: Promise<boolean>; chainGate?: Promise<boolean> }
): void {
  const attempted = inputs.persistableNew + inputs.persistablePatched > 0
  void Promise.all([
    writes.ownWrite ?? Promise.resolve(true),
    writes.chainGate ?? Promise.resolve(true),
  ]).then(([own, chained]) => {
    reportArchiveMerge({ ...identity, ...describeArchiveMerge(inputs, own, chained, attempted) })
  })
}

/**
 * Hand a report to every subscriber.
 *
 * A handler that throws is contained: this runs on the merge's completion path, and
 * a diagnostic must never break the store operation it observes.
 */
export function reportArchiveMerge(report: ArchiveMergeReport): void {
  if (handlers.size === 0) return
  for (const handler of handlers) {
    try {
      handler({ ...report })
    } catch (err) {
      console.warn('[archiveMerge] subscriber threw:', err)
    }
  }
}

/** Test-only: drop every subscriber. */
export function resetArchiveMergeDiagnosticsForTesting(): void {
  handlers.clear()
}
