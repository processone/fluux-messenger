import { describe, it, expect } from 'vitest'
import type { PluginStorage } from '@fluux/sdk'
import { loadVerified, isVerified, setVerified, clearVerified, hasAnyVerified } from './verifiedDevices'

function memStorage(): PluginStorage {
  const m = new Map<string, Uint8Array>()
  return {
    async get(k) { return m.get(k) ?? null },
    async put(k, v) { m.set(k, v) },
    async delete(k) { m.delete(k) },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)) },
  }
}

describe('verifiedDevices', () => {
  it('loadVerified returns {} when nothing stored', async () => {
    const s = memStorage()
    expect(await loadVerified(s, 'bob@x')).toEqual({})
  })

  it('setVerified round-trips through loadVerified', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    expect(await loadVerified(s, 'bob@x')).toEqual({ '5': 'aabb' })
  })

  it('isVerified is fingerprint-bound: matches only the exact stored fp', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    expect(await isVerified(s, 'bob@x', 5, 'aabb')).toBe(true)
    // Same device, DIFFERENT fingerprint (key changed) → not verified.
    expect(await isVerified(s, 'bob@x', 5, 'ccdd')).toBe(false)
    // Different device → not verified.
    expect(await isVerified(s, 'bob@x', 6, 'aabb')).toBe(false)
  })

  it('setVerified for a second device keeps the first', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    await setVerified(s, 'bob@x', 6, ' eeff'.trim())
    expect(await loadVerified(s, 'bob@x')).toEqual({ '5': 'aabb', '6': 'eeff' })
  })

  it('clearVerified removes only that device', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    await setVerified(s, 'bob@x', 6, 'eeff')
    await clearVerified(s, 'bob@x', 5)
    expect(await loadVerified(s, 'bob@x')).toEqual({ '6': 'eeff' })
  })

  it('clearVerified on an absent device is a no-op', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 6, 'eeff')
    await clearVerified(s, 'bob@x', 99)
    expect(await loadVerified(s, 'bob@x')).toEqual({ '6': 'eeff' })
  })

  it('hasAnyVerified reflects presence of ≥1 marker', async () => {
    const s = memStorage()
    expect(await hasAnyVerified(s, 'bob@x')).toBe(false)
    await setVerified(s, 'bob@x', 5, 'aabb')
    expect(await hasAnyVerified(s, 'bob@x')).toBe(true)
    await clearVerified(s, 'bob@x', 5)
    expect(await hasAnyVerified(s, 'bob@x')).toBe(false)
  })

  it('peers are isolated by key', async () => {
    const s = memStorage()
    await setVerified(s, 'bob@x', 5, 'aabb')
    expect(await loadVerified(s, 'alice@x')).toEqual({})
    expect(await hasAnyVerified(s, 'alice@x')).toBe(false)
  })
})
