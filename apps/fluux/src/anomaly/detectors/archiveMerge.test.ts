import { describe, it, expect } from 'vitest'
import { createArchiveMergeDetector } from './archiveMerge'
import { CTX, ID, METRIC, TAG } from '../values'
import type { RecordInput } from '../recorder'
import type { Opaque } from '../values'
import type { ArchiveMergeReport } from '@fluux/sdk'

const TOKEN = TAG.focus

function report(overrides: Partial<ArchiveMergeReport> = {}): ArchiveMergeReport {
  return {
    entityKind: 'chat',
    entityId: 'alice@example.com',
    direction: 'backward',
    complete: true,
    outcome: 'durable',
    returned: 10,
    retained: 7,
    deduplicated: 3,
    patched: 0,
    intentionallyUnstored: 0,
    persistenceFailed: 0,
    ...overrides,
  }
}

function setup() {
  const records: RecordInput[] = []
  const counts: Array<[Opaque, number]> = []
  const detector = createArchiveMergeDetector({
    record: (input) => records.push(input),
    count: (key, by) => counts.push([key, by]),
    token: () => TOKEN,
  })
  return { detector, records, counts }
}

describe('archive merge counting', () => {
  it('counts the rows a durable page returned and retained', () => {
    const { detector, records, counts } = setup()

    detector.observe(report())

    expect(counts).toEqual([
      [METRIC.mamRowsReturned, 10],
      [METRIC.mamRowsRetained, 7],
    ])
    expect(records).toEqual([])
  })

  it('counts a page that retained nothing without dropping its denominator', () => {
    const { detector, counts } = setup()

    // Every row deduped. The yield rate needs the denominator anyway: a page that
    // returned ten rows and kept none is exactly what the rate exists to show.
    detector.observe(report({ returned: 10, retained: 0, deduplicated: 10 }))

    expect(counts).toEqual([[METRIC.mamRowsReturned, 10]])
  })

  it('counts patched duplicate rows as durable yield', () => {
    const { detector, counts } = setup()

    detector.observe(report({ returned: 1, retained: 0, deduplicated: 0, patched: 1 }))

    expect(counts).toEqual([
      [METRIC.mamRowsReturned, 1],
      [METRIC.mamRowsRetained, 1],
    ])
  })

  it('says nothing at all about an empty page', () => {
    const { detector, records, counts } = setup()

    detector.observe(
      report({ returned: 0, retained: 0, deduplicated: 0 }),
    )

    expect(counts).toEqual([])
    expect(records).toEqual([])
  })
})

describe('mam-write-failed', () => {
  it('records a failed durable write', () => {
    const { detector, records } = setup()

    detector.observe(
      report({ outcome: 'failed', returned: 4, retained: 0, deduplicated: 1, persistenceFailed: 3 }),
    )

    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(ID.mamWriteFailed)
    expect(records[0].sev).toBe('bug')
    expect(records[0].expected).toBe(0)
    expect(records[0].observed).toBe(3)
    expect(records[0].ctx).toEqual(
      expect.arrayContaining([
        [CTX.target, TOKEN],
        [CTX.returned, 4],
      ]),
    )
  })

  it('stays silent on a partial page', () => {
    const { detector, records } = setup()

    // `partial` means an EARLIER merge for this entity failed — and that merge
    // already recorded it. Recording again would report one fault twice.
    detector.observe(report({ outcome: 'partial', retained: 7, persistenceFailed: 0 }))

    expect(records).toEqual([])
  })

  it('still counts the rows of a failed page', () => {
    const { detector, counts } = setup()

    detector.observe(
      report({ outcome: 'failed', returned: 4, retained: 0, persistenceFailed: 4, deduplicated: 0 }),
    )

    // Returned rows are a fact about the query, not about the write.
    expect(counts).toEqual([[METRIC.mamRowsReturned, 4]])
  })
})
