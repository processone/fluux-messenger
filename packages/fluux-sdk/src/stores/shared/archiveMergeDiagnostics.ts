/**
 * What an archive merge did with every row it was given.
 *
 * A MAM delivery hands a message set to `chatStore.mergeMAMMessages` or its room twin,
 * which dedupes it against the resident window, back-fills stanza ids onto resident
 * copies, and writes what is persistable in ONE IndexedDB transaction. From outside
 * the store none of that is observable: the caller sees the message count the server
 * returned and nothing about what became of it.
 *
 * This module turns a merge's own counters into the `archive-merge` record the
 * diagnostic channel publishes. The arithmetic lives here rather than in each store
 * so the two cannot drift apart, and so the balance the record promises can be
 * tested without driving a store. `diagnostics/channel.ts` declares the record
 * itself.
 *
 * @module Stores/Shared/ArchiveMergeDiagnostics
 */

import {
  publishDeferredDiagnostic,
  publishDiagnostic,
  type ArchiveMergeCounts,
  type ArchiveMergeOutcome,
  type ArchiveMergeReport,
  type DiagnosticEvent,
} from '../../diagnostics/channel'

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
  entityKind: ArchiveMergeReport['entityKind'],
  entityId: string,
  direction: ArchiveMergeReport['direction'],
  complete: boolean,
  inputs: ArchiveMergeInputs,
  ownWrite?: Promise<boolean>,
  chainGate?: Promise<boolean>
): void {
  publishDeferredDiagnostic(archiveMergeEvent, async () => {
    const attempted = inputs.persistableNew + inputs.persistablePatched > 0
    const [own, chained] = await Promise.all([ownWrite ?? true, chainGate ?? true])
    return {
      entityKind,
      entityId,
      direction,
      complete,
      ...describeArchiveMerge(inputs, own, chained, attempted),
    }
  })
}

/**
 * Publish a merge report on the SDK's diagnostic channel.
 *
 * The channel isolates the flat report for each subscriber.
 */
export function reportArchiveMerge(report: ArchiveMergeReport): void {
  publishDiagnostic(archiveMergeEvent, report)
}

const archiveMergeEvent = (report: ArchiveMergeReport): DiagnosticEvent => ({
  kind: 'archive-merge',
  report,
})
