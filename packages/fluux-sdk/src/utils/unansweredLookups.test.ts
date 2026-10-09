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

  it('suppresses an overlapping timeout but persists later same-hash recovery backoff', async () => {
    const registry = await reload()
    const { avatarCacheState } = await import('./avatarState')
    const peer = avatarCacheState.capture(JID, 'a')
    const overlapping = await registry.beginUnansweredLookup(JID, 'a')
    expect(peer.positive()).toBe(true)
    await timeout(overlapping)
    expect(overlapping.allowed()).toBe(true)
    const recovery = await registry.beginUnansweredLookup(JID, 'a', avatarCacheState.snapshot()(JID, 'a'))
    await timeout(recovery)
    expect(recovery.allowed()).toBe(false)
    vi.setSystemTime(Date.now() + 5 * MINUTE)
    const retry = await registry.beginUnansweredLookup(JID, 'a')
    expect(retry.allowed()).toBe(true)
    await timeout(retry)
    const restarted = await reload()
    const persisted = await restarted.beginUnansweredLookup(JID, 'a')
    expect(persisted.allowed()).toBe(false)
    vi.setSystemTime(Date.now() + HOUR - 1)
    expect(persisted.allowed()).toBe(false)
    vi.setSystemTime(Date.now() + 1)
    expect(persisted.allowed()).toBe(true)
  })

  it('drops a late timeout for a superseded hash', async () => {
    const registry = await reload()
    const old = await registry.beginUnansweredLookup(JID, 'a')
    const current = await registry.beginUnansweredLookup(JID, 'b')
    await timeout(old)
    expect(current.allowed()).toBe(true)
  })

  it('resets persisted backoff when A returns after a B announcement before storage preparation', async () => {
    let registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID, 'a'))
    registry = await reload()
    await timeout(await registry.beginUnansweredLookup(JID, 'a'))
    registry = await reload()
    await registry.beginUnansweredLookup(JID)
    const { avatarCacheState } = await import('./avatarState')
    avatarCacheState.capture(JID, 'b')
    expect((await registry.beginUnansweredLookup(JID, 'a')).allowed()).toBe(true)
  })

  it('does not let an old success erase the current version timeout history', async () => {
    const registry = await reload()
    const old = await registry.beginUnansweredLookup(JID, 'a')
    const current = await registry.beginUnansweredLookup(JID, 'b')
    await timeout(current)
    await old.answered()
    expect(current.allowed()).toBe(false)
    const restarted = await reload()
    await timeout(await restarted.beginUnansweredLookup(JID, 'b'))
    expect((await (await reload()).beginUnansweredLookup(JID, 'b')).allowed()).toBe(false)
  })

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
