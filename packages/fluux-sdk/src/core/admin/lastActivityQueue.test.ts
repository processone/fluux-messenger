import { describe, it, expect, vi } from 'vitest'
import { LastActivityQueue } from './lastActivityQueue'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('LastActivityQueue', () => {
  it('dedupes repeated jids', () => {
    const fetch = vi.fn().mockResolvedValue({ seconds: 1, unsupported: false })
    const q = new LastActivityQueue({ fetch, onResult: vi.fn(), onUnsupported: vi.fn() }, 6)
    q.enqueue('a@x.com')
    q.enqueue('a@x.com')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never exceeds the concurrency cap', () => {
    const fetch = vi.fn(() => deferred<any>().promise)
    const q = new LastActivityQueue({ fetch, onResult: vi.fn(), onUnsupported: vi.fn() }, 6)
    for (let i = 0; i < 20; i++) q.enqueue(`u${i}@x.com`)
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('drains the backlog as in-flight requests resolve', async () => {
    const defs = Array.from({ length: 8 }, () => deferred<any>())
    let i = 0
    const fetch = vi.fn(() => defs[i++].promise)
    const onResult = vi.fn()
    const q = new LastActivityQueue({ fetch, onResult, onUnsupported: vi.fn() }, 2)
    for (let n = 0; n < 8; n++) q.enqueue(`u${n}@x.com`)
    expect(fetch).toHaveBeenCalledTimes(2)
    defs[0].resolve({ seconds: 5, unsupported: false })
    defs[1].resolve({ seconds: 5, unsupported: false })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('stops everything on an unsupported result', async () => {
    const first = deferred<any>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise)
      .mockResolvedValue({ seconds: 1, unsupported: false })
    const onUnsupported = vi.fn()
    const onResult = vi.fn()
    const q = new LastActivityQueue({ fetch, onResult, onUnsupported }, 1)
    q.enqueue('a@x.com')
    q.enqueue('b@x.com') // queued behind the cap of 1
    first.resolve({ seconds: null, unsupported: true })
    await Promise.resolve(); await Promise.resolve()
    expect(onUnsupported).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1) // b was dropped, never fetched
    q.enqueue('c@x.com') // ignored after stop
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports per-user null on a rejected fetch', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('boom'))
    const onResult = vi.fn()
    const q = new LastActivityQueue({ fetch, onResult, onUnsupported: vi.fn() }, 6)
    q.enqueue('a@x.com')
    await Promise.resolve(); await Promise.resolve()
    expect(onResult).toHaveBeenCalledWith('a@x.com', null)
  })
})
