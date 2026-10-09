import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

const JID = 'silent@example.com'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
async function reload() {
  vi.resetModules()
  return import('./unansweredLookups')
}
async function timeout(lookup: Awaited<ReturnType<typeof import('./unansweredLookups')['beginUnansweredLookup']>>) {
  const { RequestTimeoutError } = await import('../core/errors')
  await expect(lookup.read(() => Promise.reject(new RequestTimeoutError(10_000)))).rejects.toBeInstanceOf(RequestTimeoutError)
}

describe('unanswered avatar lookup registry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('persists the count across sessions and caps escalating backoff at 24 hours', async () => {
    for (const hours of [0, 1, 2, 4, 8, 16, 24, 24]) {
      const { beginUnansweredLookup } = await reload()
      const lookup = await beginUnansweredLookup(JID, 'unchanged')
      expect(lookup.allowed()).toBe(true)
      await timeout(lookup)
      const restarted = await reload()
      const next = await restarted.beginUnansweredLookup(JID, 'unchanged')
      expect(next.allowed()).toBe(hours === 0)
      if (hours > 0) {
        vi.setSystemTime(Date.now() + hours * HOUR - 1)
        expect(next.allowed()).toBe(false)
        vi.setSystemTime(Date.now() + 1)
        expect(next.allowed()).toBe(true)
      }
    }
  })

  it('counts a silent PEP read and its silent vCard fallback as one avatar attempt', async () => {
    const { beginUnansweredLookup } = await reload()
    const lookup = await beginUnansweredLookup(JID)
    await timeout(lookup)
    await timeout(lookup)
    expect(lookup.allowed()).toBe(false)
    vi.setSystemTime(Date.now() + 5 * MINUTE)
    expect(lookup.allowed()).toBe(true)
    expect((await (await reload()).beginUnansweredLookup(JID)).allowed()).toBe(true)
  })

  it('retains announced history beneath an unrelated no-hash transient failure', async () => {
    let registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID, 'same'))
    registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID))
    vi.setSystemTime(Date.now() + HOUR)
    const transient = await registry.beginUnansweredLookup(JID)
    await expect(transient.read(() => Promise.reject(new Error('Disconnected')))).rejects.toThrow('Disconnected')
    expect((await registry.beginUnansweredLookup(JID, 'same')).allowed()).toBe(true)
    await timeout(await registry.beginUnansweredLookup(JID, 'same'))
    registry = await reload()
    const doubled = await registry.beginUnansweredLookup(JID, 'same')
    vi.setSystemTime(Date.now() + HOUR)
    expect(doubled.allowed()).toBe(false)
    expect((await registry.beginUnansweredLookup(JID, 'changed')).allowed()).toBe(true)
  })

  it('keeps timeout history through an intermediate PEP reply until resolution completes', async () => {
    let registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID))
    registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID))
    const lookup = await registry.beginUnansweredLookup(JID)
    await lookup.read(() => Promise.resolve([]))
    registry = await reload()
    expect((await registry.beginUnansweredLookup(JID)).allowed()).toBe(false)
    await lookup.answered()
    registry = await reload()
    expect((await registry.beginUnansweredLookup(JID)).allowed()).toBe(true)
  })

  it('a successful answer clears persistent history', async () => {
    let registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID))
    registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID))
    const lookup = await registry.beginUnansweredLookup(JID)
    expect(lookup.allowed()).toBe(false)
    await lookup.answered()
    registry = await reload()
    expect((await registry.beginUnansweredLookup(JID)).allowed()).toBe(true)
    await timeout(await registry.beginUnansweredLookup(JID))
    registry = await reload()
    expect((await registry.beginUnansweredLookup(JID)).allowed()).toBe(true)
  })

  it('clearing avatar data removes persistent suppression', async () => {
    let registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID))
    registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID))
    expect((await registry.beginUnansweredLookup(JID)).allowed()).toBe(false)
    await (await import('./avatarCache')).clearAllAvatarData()
    registry = await reload()
    expect((await registry.beginUnansweredLookup(JID)).allowed()).toBe(true)
  })
})
