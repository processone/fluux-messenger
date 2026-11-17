import { describe, it, expect } from 'vitest'
import { MemoryStore } from './MemoryStore'

describe('MemoryStore', () => {
  it('round-trips a session and consumes a prekey', async () => {
    const s = new MemoryStore()
    await s.saveSession('bob@x', 5, new Uint8Array([1, 2, 3]))
    expect(await s.loadSession('bob@x', 5)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await s.loadSession('bob@x', 6)).toBeNull()

    await s.savePreKey(1, { id: 1, priv: new Uint8Array(32), pub: new Uint8Array(32) })
    expect(await s.loadPreKey(1)).not.toBeNull()
    await s.removePreKey(1)
    expect(await s.loadPreKey(1)).toBeNull()
  })

  it('returns null for an identity that was never saved', async () => {
    const s = new MemoryStore()
    expect(await s.loadIdentity()).toBeNull()
  })

  it('removing a non-existent prekey is a no-op and does not throw', async () => {
    const s = new MemoryStore()
    await expect(s.removePreKey(42)).resolves.toBeUndefined()
    expect(await s.loadPreKey(42)).toBeNull()
  })

  it('keeps sessions for the same peer but different deviceId independent', async () => {
    const s = new MemoryStore()
    await s.saveSession('bob@x', 5, new Uint8Array([5]))
    await s.saveSession('bob@x', 6, new Uint8Array([6]))

    expect(await s.loadSession('bob@x', 5)).toEqual(new Uint8Array([5]))
    expect(await s.loadSession('bob@x', 6)).toEqual(new Uint8Array([6]))
  })

  it('overwriting a saved session replaces it', async () => {
    const s = new MemoryStore()
    await s.saveSession('bob@x', 5, new Uint8Array([1, 2, 3]))
    await s.saveSession('bob@x', 5, new Uint8Array([9, 9]))

    expect(await s.loadSession('bob@x', 5)).toEqual(new Uint8Array([9, 9]))
  })
})
