import { describe, it, expect } from 'vitest'
import { loadVerifiedMap, persistVerifiedMap, VERIFIED_STORAGE_KEY } from './verifiedKeys'
import { memStorage } from './testSupport/memStorage'

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

  // Finding 5: persistVerifiedMap must only write what loadVerifiedMap will
  // read back, or a value the writer accepts but the loader rejects
  // survives one session, gets swept into a trust-state seal, then
  // vanishes on reload — a seal/reload mismatch that manufactures a false
  // "compromised" verdict.
  it('drops non-string / empty-string values at the write boundary so persisted data always round-trips', async () => {
    const s = memStorage()
    // Deliberately smuggle shapes the `Record<string, string>` type forbids
    // (via `unknown`) to prove the RUNTIME filter, not just the type,
    // protects the boundary — the same defensive stance `loadVerifiedMap`
    // already takes on read.
    const dirty = { 'bob@x': 'ABCD', 'bad@x': 42, 'empty@x': '' } as unknown as Record<string, string>
    await persistVerifiedMap(s, dirty)
    expect(await loadVerifiedMap(s)).toEqual({ 'bob@x': 'ABCD' })
  })

  // Re-review Finding 1 (Phase B1): the round-trip assertion above is
  // tautological — `loadVerifiedMap` already applies the exact same filter
  // on READ, so it would pass even against a `persistVerifiedMap` with the
  // write-side filter deleted (the loader would clean up the writer's mess
  // on the way back out). Assert on the STORED BYTES instead: read the raw
  // value straight out of the storage stub, decode it, and check the
  // rejected keys never made it into the serialized JSON at all. This is
  // the one that can actually catch a regression that removes the write
  // boundary filter.
  it('never writes the rejected keys to storage at all (byte-level, not round-trip)', async () => {
    const s = memStorage()
    const dirty = { 'bob@x': 'ABCD', 'bad@x': 42, 'empty@x': '' } as unknown as Record<string, string>
    await persistVerifiedMap(s, dirty)
    const raw = await s.get(VERIFIED_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(new TextDecoder().decode(raw as Uint8Array)) as Record<string, unknown>
    expect(stored).toEqual({ 'bob@x': 'ABCD' })
    expect(Object.hasOwn(stored, 'bad@x')).toBe(false)
    expect(Object.hasOwn(stored, 'empty@x')).toBe(false)
  })
})
