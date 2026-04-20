import { describe, it, expect } from 'vitest'
import { InMemoryStorageBackend, createPluginStorage } from './PluginStorage'

describe('InMemoryStorageBackend', () => {
  it('round-trips bytes and copies on read', async () => {
    const backend = new InMemoryStorageBackend()
    const value = new Uint8Array([1, 2, 3])
    await backend.put('foo', value)
    const read = await backend.get('foo')
    expect(read).toEqual(value)
    // Stored value must be a copy — mutating the caller's buffer afterwards
    // must not change what we read back.
    value[0] = 99
    const readAgain = await backend.get('foo')
    expect(readAgain?.[0]).toBe(1)
  })

  it('returns null for missing keys', async () => {
    const backend = new InMemoryStorageBackend()
    expect(await backend.get('missing')).toBeNull()
  })

  it('lists keys by prefix', async () => {
    const backend = new InMemoryStorageBackend()
    await backend.put('a/1', new Uint8Array([1]))
    await backend.put('a/2', new Uint8Array([2]))
    await backend.put('b/1', new Uint8Array([3]))
    const keys = (await backend.list('a/')).sort()
    expect(keys).toEqual(['a/1', 'a/2'])
  })

  it('deletes keys', async () => {
    const backend = new InMemoryStorageBackend()
    await backend.put('k', new Uint8Array([1]))
    await backend.delete('k')
    expect(await backend.get('k')).toBeNull()
  })
})

describe('createPluginStorage', () => {
  it('isolates plugins by namespace', async () => {
    const backend = new InMemoryStorageBackend()
    const a = createPluginStorage(backend, 'plugin-a')
    const b = createPluginStorage(backend, 'plugin-b')

    await a.put('same-key', new Uint8Array([1]))
    await b.put('same-key', new Uint8Array([2]))

    expect((await a.get('same-key'))?.[0]).toBe(1)
    expect((await b.get('same-key'))?.[0]).toBe(2)
  })

  it('list() returns keys without the namespace prefix', async () => {
    const backend = new InMemoryStorageBackend()
    const storage = createPluginStorage(backend, 'p')
    await storage.put('keys/1', new Uint8Array([1]))
    await storage.put('keys/2', new Uint8Array([2]))
    await storage.put('other', new Uint8Array([3]))

    const keys = (await storage.list('keys/')).sort()
    expect(keys).toEqual(['keys/1', 'keys/2'])
  })

  it('does not leak other namespaces via list()', async () => {
    const backend = new InMemoryStorageBackend()
    const a = createPluginStorage(backend, 'a')
    const b = createPluginStorage(backend, 'b')
    await a.put('shared', new Uint8Array([1]))
    await b.put('shared', new Uint8Array([2]))

    expect(await a.list('')).toEqual(['shared'])
    expect(await b.list('')).toEqual(['shared'])
  })

  it('rejects invalid namespaces', () => {
    const backend = new InMemoryStorageBackend()
    expect(() => createPluginStorage(backend, '')).toThrow()
    expect(() => createPluginStorage(backend, 'bad\u0000ns')).toThrow()
  })
})
