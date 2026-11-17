import { describe, it, expect } from 'vitest'
import { PluginStorageOmemoStore } from './store'
import type { PluginStorage } from '@fluux/sdk'

function memStorage(): PluginStorage {
  const m = new Map<string, Uint8Array>()
  return {
    async get(k) {
      return m.get(k) ?? null
    },
    async put(k, v) {
      m.set(k, v)
    },
    async delete(k) {
      m.delete(k)
    },
    async list(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

describe('PluginStorageOmemoStore', () => {
  it('round-trips identity, prekeys (with consumption), sessions, trust', async () => {
    const s = new PluginStorageOmemoStore(memStorage())
    await s.saveIdentity({ edSeed: new Uint8Array(32).fill(1), edPub: new Uint8Array(32).fill(2), deviceId: 7 })
    expect((await s.loadIdentity())!.deviceId).toBe(7)
    await s.savePreKey(3, { id: 3, priv: new Uint8Array(32), pub: new Uint8Array(32) })
    expect(await s.loadPreKey(3)).not.toBeNull()
    await s.removePreKey(3)
    expect(await s.loadPreKey(3)).toBeNull()
    await s.saveSession('bob@x', 5, new Uint8Array([9, 9]))
    expect(await s.loadSession('bob@x', 5)).toEqual(new Uint8Array([9, 9]))
    await s.saveTrust('bob@x', 5, { state: 'undecided', identityKey: new Uint8Array(32).fill(3) })
    expect((await s.loadTrust('bob@x', 5))!.state).toBe('undecided')
  })

  it('round-trips a signed prekey', async () => {
    const s = new PluginStorageOmemoStore(memStorage())
    await s.saveSignedPreKey(1, {
      id: 1,
      priv: new Uint8Array(32).fill(4),
      pub: new Uint8Array(32).fill(5),
      signature: new Uint8Array(64).fill(6),
    })
    const loaded = await s.loadSignedPreKey(1)
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(1)
    expect(loaded!.priv).toEqual(new Uint8Array(32).fill(4))
    expect(loaded!.pub).toEqual(new Uint8Array(32).fill(5))
    expect(loaded!.signature).toEqual(new Uint8Array(64).fill(6))
  })

  it('returns null for identity/prekey/session/trust that were never saved', async () => {
    const s = new PluginStorageOmemoStore(memStorage())
    expect(await s.loadIdentity()).toBeNull()
    expect(await s.loadSignedPreKey(1)).toBeNull()
    expect(await s.loadPreKey(1)).toBeNull()
    expect(await s.loadSession('bob@x', 1)).toBeNull()
    expect(await s.loadTrust('bob@x', 1)).toBeNull()
  })

  it('removePreKey of a non-existent id is a no-op', async () => {
    const s = new PluginStorageOmemoStore(memStorage())
    await expect(s.removePreKey(999)).resolves.toBeUndefined()
    expect(await s.loadPreKey(999)).toBeNull()
  })

  it('round-trips a session with high-bit bytes byte-exactly', async () => {
    const s = new PluginStorageOmemoStore(memStorage())
    const bytes = new Uint8Array([0x80, 0x81, 0xfe, 0xff, 0x00, 0x7f])
    await s.saveSession('alice@x', 2, bytes)
    const loaded = await s.loadSession('alice@x', 2)
    expect(loaded).toEqual(bytes)
    expect(Array.from(loaded!)).toEqual(Array.from(bytes))
  })

  it('keeps records under different keys independent', async () => {
    const s = new PluginStorageOmemoStore(memStorage())
    await s.savePreKey(1, { id: 1, priv: new Uint8Array(32).fill(1), pub: new Uint8Array(32).fill(2) })
    await s.savePreKey(2, { id: 2, priv: new Uint8Array(32).fill(3), pub: new Uint8Array(32).fill(4) })
    await s.saveSession('bob@x', 1, new Uint8Array([1, 2, 3]))
    await s.saveSession('bob@x', 2, new Uint8Array([4, 5, 6]))

    await s.removePreKey(1)

    expect(await s.loadPreKey(1)).toBeNull()
    const pk2 = await s.loadPreKey(2)
    expect(pk2).not.toBeNull()
    expect(pk2!.priv).toEqual(new Uint8Array(32).fill(3))

    expect(await s.loadSession('bob@x', 1)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await s.loadSession('bob@x', 2)).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('survives 0x00 and 0xff bytes inside a JSON+base64 codec record', async () => {
    const s = new PluginStorageOmemoStore(memStorage())
    const identityKey = new Uint8Array(32)
    for (let i = 0; i < identityKey.length; i++) {
      identityKey[i] = i % 2 === 0 ? 0x00 : 0xff
    }
    await s.saveTrust('carol@x', 9, { state: 'trusted', identityKey })
    const loaded = await s.loadTrust('carol@x', 9)
    expect(loaded).not.toBeNull()
    expect(loaded!.state).toBe('trusted')
    expect(loaded!.identityKey).toEqual(identityKey)
    expect(Array.from(loaded!.identityKey)).toEqual(Array.from(identityKey))
  })
})
