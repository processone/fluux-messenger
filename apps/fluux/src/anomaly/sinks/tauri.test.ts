import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTauriSink } from './tauri'

/** Let the single-flight chain drain. */
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => vi.restoreAllMocks())

describe('createTauriSink', () => {
  it('writes lines in order', async () => {
    const seen: string[] = []
    const sink = createTauriSink(async (line) => {
      seen.push(line)
    })
    sink.write('a')
    sink.write('b')
    sink.write('c')
    await drain()
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('serializes writes — a slow write cannot be overtaken', async () => {
    const seen: string[] = []
    let releaseFirst: () => void = () => {}
    const sink = createTauriSink(async (line) => {
      if (line === 'slow') await new Promise<void>((r) => (releaseFirst = r))
      seen.push(line)
    })

    sink.write('slow')
    sink.write('fast')
    await drain()
    expect(seen).toEqual([]) // the queue is blocked on 'slow', as it should be

    releaseFirst()
    await drain()
    expect(seen).toEqual(['slow', 'fast'])
  })

  it('does not let one failed write poison the chain', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    let calls = 0
    const sink = createTauriSink(async (line) => {
      calls++
      if (calls === 1) throw new Error('EIO')
      seen.push(line)
    })

    sink.write('first')
    sink.write('second')
    sink.write('third')
    await drain()

    // `q = q.then(write)` would propagate the first rejection to every later link
    // and silently end logging for the rest of the session.
    expect(seen).toEqual(['second', 'third'])
    expect(sink.failureCount()).toBe(1)
  })

  it('mirrors failures to console.warn, since a broken sink cannot report itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sink = createTauriSink(async () => {
      throw new Error('EIO')
    })
    sink.write('x')
    await drain()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('EIO')
  })

  it('disables itself after ten consecutive failures and stops attempting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let attempts = 0
    const sink = createTauriSink(async () => {
      attempts++
      throw new Error('ENOSPC')
    })

    for (let i = 0; i < 20; i++) {
      sink.write(`line-${i}`)
      await drain()
    }

    expect(sink.disabled()).toBe(true)
    // A permanently failing path must not burn a write attempt per record.
    expect(attempts).toBe(10)
  })

  it('resets the consecutive run on a success, so intermittent errors never disable it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const sink = createTauriSink(async () => {
      calls++
      if (calls === 10) return // one success breaks the run
      throw new Error('EIO')
    })

    for (let i = 0; i < 19; i++) {
      sink.write(`line-${i}`)
      await drain()
    }

    expect(sink.disabled()).toBe(false)
    expect(sink.failureCount()).toBe(18)
  })

  it('announces the shutdown exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sink = createTauriSink(async () => {
      throw new Error('EIO')
    })
    for (let i = 0; i < 15; i++) {
      sink.write(`line-${i}`)
      await drain()
    }
    const shutdownLines = warn.mock.calls.filter((c) => String(c[0]).includes('disabled'))
    expect(shutdownLines).toHaveLength(1)
  })
})
