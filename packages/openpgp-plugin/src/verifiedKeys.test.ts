import { describe, it, expect } from 'vitest'
import { loadVerifiedMap, persistVerifiedMap, VERIFIED_STORAGE_KEY } from './verifiedKeys'
import type { PluginStorage } from '@fluux/sdk'

function memStorage(seed?: Record<string, Uint8Array>): PluginStorage {
  const m = new Map<string, Uint8Array>(Object.entries(seed ?? {}))
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
  }
}
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

describe('verifiedKeys persistence', () => {
  it('returns {} when nothing is stored', async () => {
    expect(await loadVerifiedMap(memStorage())).toEqual({})
  })

  it('round-trips a map', async () => {
    const s = memStorage()
    await persistVerifiedMap(s, { 'bob@x': 'ABCD', 'carol@x': 'EF01' })
    expect(await loadVerifiedMap(s)).toEqual({ 'bob@x': 'ABCD', 'carol@x': 'EF01' })
  })

  it('returns {} on a corrupt blob rather than throwing', async () => {
    const s = memStorage({ [VERIFIED_STORAGE_KEY]: new TextEncoder().encode('not json{') })
    expect(await loadVerifiedMap(s)).toEqual({})
  })

  it('drops non-string entries defensively', async () => {
    const s = memStorage({ [VERIFIED_STORAGE_KEY]: enc({ 'bob@x': 'ABCD', 'bad@x': 42, 'null@x': null }) })
    expect(await loadVerifiedMap(s)).toEqual({ 'bob@x': 'ABCD' })
  })

  it('returns {} for a JSON array (wrong shape)', async () => {
    const s = memStorage({ [VERIFIED_STORAGE_KEY]: enc(['bob@x']) })
    expect(await loadVerifiedMap(s)).toEqual({})
  })
})
