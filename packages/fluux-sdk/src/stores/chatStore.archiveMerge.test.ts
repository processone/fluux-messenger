/**
 * What `mergeMAMMessages` reports about the page it just merged.
 *
 * The dispositions themselves are tested in `shared/archiveMergeDiagnostics.test.ts`.
 * What THIS suite proves is that the store feeds that arithmetic the right inputs —
 * the counts the merge actually produced — and reports only once the durable write
 * has settled, which is the whole reason the seam exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatStore } from './chatStore'
import {
  resetDiagnosticsForTesting,
  subscribeDiagnostics,
  type ArchiveMergeReport,
} from '../diagnostics/channel'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import { _resetForTesting as _resetThrottledStorageForTesting } from './shared/throttledStorage'
import type { Message } from '../core/types/chat'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    saveMessages: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
  }
})
import * as messageCache from '../utils/messageCache'

/**
 * A fresh conversation per test.
 *
 * `archiveSaveChain` poisons an entity's chain for the whole session after one
 * failed write — deliberately, so a frozen cursor cannot leap a lost page. Sharing
 * one id across tests would therefore leak the failure case into every test after
 * it, reported as `partial`.
 */
let CONV = 'alice@example.com'
let convCounter = 0

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: CONV,
    from: CONV,
    to: 'me@example.com',
    body: `body ${id}`,
    timestamp: new Date(Date.parse('2026-09-01T10:00:00Z') + Number(id.replace(/\D/g, '')) * 1000),
    isOutgoing: false,
    stanzaId: `stanza-${id}`,
    ...overrides,
  } as Message
}

/**
 * Collect reports and hand them out ONE at a time.
 *
 * A queue, not a latest-value: two merges in a row must yield two different
 * reports, and a helper that re-serves the first would make the second merge look
 * identical to the first no matter what the store did.
 */
function collector(): { pending: ArchiveMergeReport[]; next: () => Promise<ArchiveMergeReport> } {
  const pending: ArchiveMergeReport[] = []
  const waiters: Array<(r: ArchiveMergeReport) => void> = []
  subscribeDiagnostics((event) => {
    if (event.kind !== 'archive-merge') return
    const r = event.report
    const waiter = waiters.shift()
    if (waiter) waiter(r)
    else pending.push(r)
  })
  return {
    pending,
    next: () =>
      new Promise<ArchiveMergeReport>((resolve) => {
        const queued = pending.shift()
        if (queued) return resolve(queued)
        waiters.push(resolve)
      }),
  }
}

beforeEach(() => {
  convCounter++
  CONV = `alice-${convCounter}@example.com`
  localStorageMock.clear()
  _resetStorageScopeForTesting()
  _resetThrottledStorageForTesting()
  chatStore.setState({ messages: new Map(), activeConversationId: null })
  vi.mocked(messageCache.saveMessages).mockResolvedValue(true)
})

afterEach(() => {
  resetDiagnosticsForTesting()
})

describe('mergeMAMMessages reporting', () => {
  it('reports a durable page with every row accounted for', async () => {
    const { next } = collector()

    chatStore.getState().mergeMAMMessages(
      CONV,
      [msg('a1'), msg('a2')],
      { first: 'a1', last: 'a2', count: 2 },
      true,
      'backward'
    )

    const report = await next()
    expect(report).toMatchObject({
      entityKind: 'chat',
      entityId: CONV,
      direction: 'backward',
      complete: true,
      outcome: 'durable',
      returned: 2,
      retained: 2,
      deduplicated: 0,
      persistenceFailed: 0,
    })
  })

  it('counts a re-merged page as deduplicated for the conversation on screen', async () => {
    chatStore.setState({ activeConversationId: CONV })
    const { next } = collector()
    const page = [msg('a1'), msg('a2')]

    chatStore
      .getState()
      .mergeMAMMessages(CONV, page, { first: 'a1', last: 'a2', count: 2 }, true, 'backward')
    await next()

    chatStore
      .getState()
      .mergeMAMMessages(CONV, page, { first: 'a1', last: 'a2', count: 2 }, true, 'backward')
    const second = await next()

    expect(second).toMatchObject({
      outcome: 'durable',
      returned: 2,
      retained: 0,
      deduplicated: 2,
      persistenceFailed: 0,
    })
  })

  it('re-reports a backgrounded conversation page as retained, not deduplicated', async () => {
    // A conversation that is not on screen keeps NO resident array, so the merge
    // dedupes against nothing and writes the page again. `retained` therefore means
    // "written durably", never "new to the archive" — the registry says so, because
    // reading it as novelty would make every background catch-up look productive.
    const { next } = collector()
    const page = [msg('a1'), msg('a2')]

    chatStore
      .getState()
      .mergeMAMMessages(CONV, page, { first: 'a1', last: 'a2', count: 2 }, true, 'backward')
    await next()

    chatStore
      .getState()
      .mergeMAMMessages(CONV, page, { first: 'a1', last: 'a2', count: 2 }, true, 'backward')
    const second = await next()

    expect(second).toMatchObject({ returned: 2, retained: 2, deduplicated: 0 })
  })

  it('reports a failed write with its rows under persistenceFailed', async () => {
    vi.mocked(messageCache.saveMessages).mockResolvedValue(false)
    const { next } = collector()

    chatStore
      .getState()
      .mergeMAMMessages(CONV, [msg('a1')], { first: 'a1', last: 'a1', count: 1 }, true, 'forward')

    const report = await next()
    expect(report).toMatchObject({
      outcome: 'failed',
      returned: 1,
      retained: 0,
      persistenceFailed: 1,
    })
  })

  it('reports nothing at all when no one is subscribed', async () => {
    const seen: ArchiveMergeReport[] = []

    chatStore
      .getState()
      .mergeMAMMessages(CONV, [msg('a1')], { first: 'a1', last: 'a1', count: 1 }, true, 'backward')
    // Let the write settle: a report, if the store made one, would arrive by now.
    await Promise.resolve()
    await Promise.resolve()

    expect(seen).toEqual([])
  })

  it('waits for the write before reporting', async () => {
    let settle: (ok: boolean) => void = () => {}
    vi.mocked(messageCache.saveMessages).mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve
      })
    )
    const { pending, next } = collector()

    chatStore
      .getState()
      .mergeMAMMessages(CONV, [msg('a1')], { first: 'a1', last: 'a1', count: 1 }, true, 'backward')
    await Promise.resolve()

    // The merge is done in RAM, but its durable outcome is not known yet. Reporting
    // here would claim a retention that may still fail.
    expect(pending).toEqual([])

    settle(true)
    expect((await next()).outcome).toBe('durable')
  })
})
