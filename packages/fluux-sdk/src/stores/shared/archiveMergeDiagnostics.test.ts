import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  describeArchiveMerge,
  hasArchiveMergeSubscribers,
  onArchiveMerge,
  reportArchiveMerge,
  resetArchiveMergeDiagnosticsForTesting,
  type ArchiveMergeReport,
} from './archiveMergeDiagnostics'

afterEach(() => resetArchiveMergeDiagnosticsForTesting())

const page = { returned: 10, newMessages: 6, persistableNew: 5, patched: 2, persistablePatched: 1 }

type Counts = Pick<
  ArchiveMergeReport,
  'returned' | 'retained' | 'deduplicated' | 'patched' | 'intentionallyUnstored' | 'persistenceFailed'
>

function balances(r: Counts): boolean {
  return (
    r.returned ===
    r.retained + r.deduplicated + r.patched + r.intentionallyUnstored + r.persistenceFailed
  )
}

describe('describeArchiveMerge', () => {
  it('accounts for every returned row when the write commits', () => {
    const r = describeArchiveMerge(page, true, true, true)
    expect(r).toMatchObject({
      outcome: 'durable',
      returned: 10,
      retained: 5,
      patched: 1,
      // 1 new + 1 patching row were noLocalStore; 10 - 6 new - 2 patched = 2 plain duplicates.
      intentionallyUnstored: 2,
      deduplicated: 2,
      persistenceFailed: 0,
    })
    expect(balances(r)).toBe(true)
  })

  it('moves both written kinds to persistenceFailed when the write fails', () => {
    const r = describeArchiveMerge(page, false, false, true)
    expect(r).toMatchObject({
      outcome: 'failed',
      retained: 0,
      patched: 0,
      persistenceFailed: 6,
      intentionallyUnstored: 2,
      deduplicated: 2,
    })
    expect(balances(r)).toBe(true)
  })

  it('calls a merge partial when its own write landed behind a failed earlier page', () => {
    const r = describeArchiveMerge(page, true, false, true)
    expect(r.outcome).toBe('partial')
    // The rows ARE on disk. Only the durable cursor is frozen, so they are retained.
    expect(r.retained).toBe(5)
    expect(r.persistenceFailed).toBe(0)
    expect(balances(r)).toBe(true)
  })

  it('is durable when nothing was attempted', () => {
    const nothing = {
      returned: 4,
      newMessages: 0,
      persistableNew: 0,
      patched: 0,
      persistablePatched: 0,
    }
    const r = describeArchiveMerge(nothing, true, true, false)
    expect(r).toMatchObject({ outcome: 'durable', deduplicated: 4, retained: 0 })
    expect(balances(r)).toBe(true)
  })

  it('reports an empty page without inventing a disposition', () => {
    const empty = {
      returned: 0,
      newMessages: 0,
      persistableNew: 0,
      patched: 0,
      persistablePatched: 0,
    }
    const r = describeArchiveMerge(empty, true, true, false)
    expect(r).toMatchObject({ outcome: 'durable', returned: 0, deduplicated: 0 })
    expect(balances(r)).toBe(true)
  })

  it('never reports a negative duplicate count', () => {
    // Defensive: patched rows are duplicates by construction, so this cannot
    // happen — but a clamp beats a nonsense record if the timeline ever changes.
    const odd = {
      returned: 1,
      newMessages: 1,
      persistableNew: 1,
      patched: 1,
      persistablePatched: 1,
    }
    expect(describeArchiveMerge(odd, true, true, true).deduplicated).toBe(0)
  })
})

describe('subscription', () => {
  const report: ArchiveMergeReport = {
    entityKind: 'chat',
    entityId: 'a@example.com',
    direction: 'forward',
    complete: true,
    outcome: 'durable',
    returned: 1,
    retained: 1,
    deduplicated: 0,
    patched: 0,
    intentionallyUnstored: 0,
    persistenceFailed: 0,
  }

  it('claims no subscribers when nobody listens', () => {
    expect(hasArchiveMergeSubscribers()).toBe(false)
    expect(() => reportArchiveMerge(report)).not.toThrow()
  })

  it('delivers to every subscriber and stops on unsubscribe', () => {
    const seen: ArchiveMergeReport[] = []
    const off = onArchiveMerge((r) => seen.push(r))
    expect(hasArchiveMergeSubscribers()).toBe(true)

    reportArchiveMerge(report)
    off()
    reportArchiveMerge(report)

    expect(seen).toEqual([report])
    expect(hasArchiveMergeSubscribers()).toBe(false)
  })

  it('contains a throwing subscriber', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    onArchiveMerge(() => {
      throw new Error('detector bug')
    })
    onArchiveMerge((r) => seen.push(r.entityId))

    reportArchiveMerge({ ...report, entityKind: 'room', entityId: 'room@conf.example.com' })

    // A diagnostic subscriber must not take the merge down with it.
    expect(seen).toEqual(['room@conf.example.com'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('isolates each subscriber from earlier report mutations', () => {
    let second: ArchiveMergeReport | undefined
    onArchiveMerge((received) => {
      received.outcome = 'durable'
      received.entityId = 'tampered@example.com'
    })
    onArchiveMerge((received) => {
      second = received
    })
    const failed = { ...report, outcome: 'failed' as const, persistenceFailed: 1, retained: 0 }

    reportArchiveMerge(failed)

    expect(second?.outcome).toBe('failed')
    expect(second?.entityId).toBe('a@example.com')
    expect(failed.outcome).toBe('failed')
  })
})
