/**
 * What an archive merge cost and what it kept.
 *
 * The SDK reports one outcome per archive merge (`onArchiveMerge`). Two things are
 * derived here: the merge-yield rate's two counters, and one invariant — a durable
 * write that did not commit, which freezes that entity's catch-up cursor for the
 * rest of the session and is invisible everywhere else.
 *
 * @module Anomaly/Detectors/ArchiveMerge
 */
import type { ArchiveMergeReport } from '@fluux/sdk'
import type { RecordInput } from '../recorder'
import { CTX, ID, METRIC, type Opaque } from '../values'

export interface ArchiveMergeDetector {
  observe(report: ArchiveMergeReport): void
}

export interface ArchiveMergeOptions {
  record: (input: RecordInput) => void
  count: (key: Opaque, by: number) => void
  /** Tokenizes an entity id at the recorder boundary. Never the raw value. */
  token: (report: ArchiveMergeReport) => Opaque
}

export function createArchiveMergeDetector(opts: ArchiveMergeOptions): ArchiveMergeDetector {
  return {
    observe(report) {
      // Zero is not a measurement: an empty page would add a denominator sample
      // that says nothing about yield.
      if (report.returned > 0) opts.count(METRIC.mamRowsReturned, report.returned)
      const durablyWritten = report.retained + report.patched
      if (durablyWritten > 0) opts.count(METRIC.mamRowsRetained, durablyWritten)

      // `partial` means an EARLIER merge for this entity failed, and that merge
      // recorded it already. Reporting here would count one fault twice and make
      // a single lost page look like a run of them.
      if (report.outcome !== 'failed') return

      opts.record({
        id: ID.mamWriteFailed,
        sev: 'bug',
        expected: 0,
        observed: report.persistenceFailed,
        ctx: [
          [CTX.target, opts.token(report)],
          [CTX.returned, report.returned],
        ],
      })
    },
  }
}
