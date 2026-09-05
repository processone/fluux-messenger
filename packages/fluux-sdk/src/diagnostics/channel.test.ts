/**
 * The two rules the channel exists to hold, tested at the boundary that holds
 * them rather than once per seam.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  publishDiagnostic,
  publishDeferredDiagnostic,
  resetDiagnosticsForTesting,
  subscribeDiagnostics,
  type ArchiveMergeDiagnostic,
  type DiagnosticEvent,
  type UnreadRecountDiagnostic,
} from './channel'

afterEach(() => resetDiagnosticsForTesting())

const merge = (entityId: string): ArchiveMergeDiagnostic => ({
  kind: 'archive-merge',
  report: {
    entityKind: 'chat',
    entityId,
    direction: 'forward',
    complete: true,
    outcome: 'durable',
    returned: 1,
    retained: 1,
    deduplicated: 0,
    patched: 0,
    intentionallyUnstored: 0,
    persistenceFailed: 0,
  },
})

const recount = (entityId: string): UnreadRecountDiagnostic => ({
  kind: 'unread-recount',
  entityKind: 'chat',
  entityId,
  verdict: { status: 'deferred', reason: 'coverage-missing' },
})

describe('diagnostic channel', () => {
  it('builds nothing when nobody subscribes', () => {
    const build = vi.fn(merge)

    publishDiagnostic('archive-merge', build, 'a@example.com')

    expect(build).not.toHaveBeenCalled()
  })

  it('builds nothing when subscribers want another kind', () => {
    const build = vi.fn(merge)
    subscribeDiagnostics(() => {}, { kinds: ['unread-recount'] })

    publishDiagnostic('archive-merge', build, 'a@example.com')

    expect(build).not.toHaveBeenCalled()
  })

  it('delivers only the kinds each subscriber requested', () => {
    const recountOnly = vi.fn()
    const catchAll = vi.fn()
    subscribeDiagnostics(recountOnly, { kinds: ['unread-recount'] })
    subscribeDiagnostics(catchAll)

    publishDiagnostic('archive-merge', merge, 'a@example.com')
    publishDiagnostic('unread-recount', recount, 'a@example.com')

    expect(recountOnly).toHaveBeenCalledTimes(1)
    expect(recountOnly.mock.calls[0]?.[0]).toMatchObject({ kind: 'unread-recount' })
    expect(catchAll).toHaveBeenCalledTimes(2)
  })

  it('delivers to every subscriber and stops on unsubscribe', () => {
    const seen: string[] = []
    const off = subscribeDiagnostics((event) => {
      if (event.kind === 'archive-merge') seen.push(event.report.entityId)
    })
    subscribeDiagnostics((event) => {
      if (event.kind === 'archive-merge') seen.push(`second:${event.report.entityId}`)
    })

    publishDiagnostic('archive-merge', merge, 'a@example.com')
    off()
    publishDiagnostic('archive-merge', merge, 'b@example.com')

    expect(seen).toEqual(['a@example.com', 'second:a@example.com', 'second:b@example.com'])
  })

  it('restores per-kind unreachability on unsubscribe', () => {
    const build = vi.fn(merge)
    const off = subscribeDiagnostics(() => {}, { kinds: ['archive-merge'] })
    off()

    publishDiagnostic('archive-merge', build, 'a@example.com')

    expect(build).not.toHaveBeenCalled()
  })

  it('builds once and isolates every subscriber from earlier mutations', () => {
    const build = vi.fn(merge)
    let second: DiagnosticEvent | undefined
    subscribeDiagnostics((event) => {
      if (event.kind === 'archive-merge') event.report.entityId = 'tampered@example.com'
    })
    subscribeDiagnostics((event) => {
      second = event
    })

    publishDiagnostic('archive-merge', build, 'a@example.com')

    expect(build).toHaveBeenCalledTimes(1)
    expect(second?.kind === 'archive-merge' && second.report.entityId).toBe('a@example.com')
  })

  it('does not run a deferred producer when nobody subscribes', () => {
    const produce = vi.fn(async () => 'a@example.com')

    publishDeferredDiagnostic('archive-merge', merge, produce)

    expect(produce).not.toHaveBeenCalled()
  })

  it('does not run a deferred producer for another kind', () => {
    const produce = vi.fn(async () => 'a@example.com')
    subscribeDiagnostics(() => {}, { kinds: ['unread-recount'] })

    publishDeferredDiagnostic('archive-merge', merge, produce)

    expect(produce).not.toHaveBeenCalled()
  })

  it('builds a deferred event once after its source is ready', async () => {
    const build = vi.fn(merge)
    const produce = vi.fn(async () => 'a@example.com')
    const seen: string[] = []
    subscribeDiagnostics((event) => {
      if (event.kind === 'archive-merge') seen.push(event.report.entityId)
    })
    subscribeDiagnostics((event) => {
      if (event.kind === 'archive-merge') seen.push(`second:${event.report.entityId}`)
    })

    publishDeferredDiagnostic('archive-merge', build, produce)
    await vi.waitFor(() => expect(seen).toHaveLength(2))

    expect(produce).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['a@example.com', 'second:a@example.com'])
  })

  it('contains a throwing subscriber', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    subscribeDiagnostics(() => {
      throw new Error('detector bug')
    })
    subscribeDiagnostics((event) => {
      if (event.kind === 'archive-merge') seen.push(event.report.entityId)
    })

    expect(() => publishDiagnostic('archive-merge', merge, 'a@example.com')).not.toThrow()

    // A diagnostic subscriber must not take down the operation it observes.
    expect(seen).toEqual(['a@example.com'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('contains a throwing builder', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    subscribeDiagnostics((event) => {
      if (event.kind === 'archive-merge') seen.push(event.report.entityId)
    })
    subscribeDiagnostics((event) => {
      if (event.kind === 'archive-merge') seen.push(`second:${event.report.entityId}`)
    })
    const build = vi.fn((_entityId: string) => {
      throw new Error('builder bug')
    })

    expect(() =>
      publishDiagnostic('archive-merge', build, 'a@example.com')
    ).not.toThrow()

    expect(build).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('shares subscriptions across distinct module instances', async () => {
    vi.resetModules()
    const first = await import('./channel')
    vi.resetModules()
    const second = await import('./channel')
    const handler = vi.fn()
    const unsubscribe = first.subscribeDiagnostics(handler, { kinds: ['archive-merge'] })

    try {
      second.publishDiagnostic('archive-merge', merge, 'a@example.com')
      expect(handler).toHaveBeenCalledOnce()
    } finally {
      unsubscribe()
    }
  })

  it('clears kind reachability when diagnostics reset', () => {
    const build = vi.fn(merge)
    subscribeDiagnostics(() => {}, { kinds: ['archive-merge'] })
    resetDiagnosticsForTesting()

    publishDiagnostic('archive-merge', build, 'a@example.com')

    expect(build).not.toHaveBeenCalled()
  })
})
