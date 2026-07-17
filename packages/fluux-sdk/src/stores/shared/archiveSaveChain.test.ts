import { describe, it, expect } from 'vitest'
import { createArchiveSaveChain } from './archiveSaveChain'

describe('createArchiveSaveChain', () => {
  it('gates a later save on an earlier failed one (cumulative AND)', async () => {
    const c = createArchiveSaveChain()
    let resolveN!: (ok: boolean) => void
    const gateN = c.chain('a', new Promise<boolean>((r) => { resolveN = r }))
    const gateN1 = c.chain('a', Promise.resolve(true))
    resolveN(false)
    await expect(gateN).resolves.toBe(false)
    await expect(gateN1).resolves.toBe(false) // poisoned by N
  })

  it('resolves true in order when every save succeeds, then self-clears', async () => {
    const c = createArchiveSaveChain()
    const g1 = c.chain('a', Promise.resolve(true))
    const g2 = c.chain('a', Promise.resolve(true))
    await expect(g1).resolves.toBe(true)
    await expect(g2).resolves.toBe(true)
    // Drained successfully → no entry left (no permanent memory growth).
    await new Promise((r) => setTimeout(r, 0))
    expect(c.has('a')).toBe(false)
  })

  it('keeps a poisoned entry until cleared', async () => {
    const c = createArchiveSaveChain()
    await expect(c.chain('a', Promise.resolve(false))).resolves.toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(c.has('a')).toBe(true) // session-long freeze after a failure
    // A later successful save still cannot resurrect the skipped page.
    await expect(c.chain('a', Promise.resolve(true))).resolves.toBe(false)
    c.clear()
    expect(c.has('a')).toBe(false)
  })

  it('entities are independent', async () => {
    const c = createArchiveSaveChain()
    await expect(c.chain('a', Promise.resolve(false))).resolves.toBe(false)
    await expect(c.chain('b', Promise.resolve(true))).resolves.toBe(true)
  })
})
