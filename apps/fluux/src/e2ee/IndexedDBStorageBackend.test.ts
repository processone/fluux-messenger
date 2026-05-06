import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDBStorageBackend } from './IndexedDBStorageBackend'

// Each test gets a fresh in-memory IndexedDB so writes from one test
// don't leak into the next via the shared global.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('IndexedDBStorageBackend', () => {
  it('round-trips a value through put / get', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()

    const value = new TextEncoder().encode('hello world')
    await backend.put('greeting', value)

    const got = await backend.get('greeting')
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got!)).toBe('hello world')
  })

  it('returns null for missing keys', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()

    const got = await backend.get('missing-key')
    expect(got).toBeNull()
  })

  it('overwrites existing values on put', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()

    await backend.put('k', new TextEncoder().encode('first'))
    await backend.put('k', new TextEncoder().encode('second'))

    const got = await backend.get('k')
    expect(new TextDecoder().decode(got!)).toBe('second')
  })

  it('removes a value via delete', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()

    await backend.put('k', new TextEncoder().encode('value'))
    expect(await backend.get('k')).not.toBeNull()

    await backend.delete('k')
    expect(await backend.get('k')).toBeNull()
  })

  it('delete is a no-op for missing keys', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()

    await expect(backend.delete('not-there')).resolves.toBeUndefined()
  })

  it('list returns only keys matching the prefix', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()

    const v = new TextEncoder().encode('x')
    await backend.put('peer/bob@example.com/key', v)
    await backend.put('peer/carol@example.com/key', v)
    await backend.put('own/private-key', v)
    await backend.put('verifications', v)

    const peerKeys = (await backend.list('peer/')).sort()
    expect(peerKeys).toEqual([
      'peer/bob@example.com/key',
      'peer/carol@example.com/key',
    ])

    const own = await backend.list('own/')
    expect(own).toEqual(['own/private-key'])

    const all = await backend.list('')
    expect(all.sort()).toEqual(
      [
        'own/private-key',
        'peer/bob@example.com/key',
        'peer/carol@example.com/key',
        'verifications',
      ].sort(),
    )
  })

  it('list returns empty when nothing matches', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()

    expect(await backend.list('peer/')).toEqual([])
  })

  it('isolates data between different account JIDs (separate databases)', async () => {
    const alice = new IndexedDBStorageBackend('alice@example.com')
    const bob = new IndexedDBStorageBackend('bob@example.com')
    await alice.open()
    await bob.open()

    await alice.put('private-key', new TextEncoder().encode('alice-secret'))
    await bob.put('private-key', new TextEncoder().encode('bob-secret'))

    expect(new TextDecoder().decode((await alice.get('private-key'))!)).toBe('alice-secret')
    expect(new TextDecoder().decode((await bob.get('private-key'))!)).toBe('bob-secret')

    // Deleting from one account must not affect the other.
    await alice.delete('private-key')
    expect(await alice.get('private-key')).toBeNull()
    expect(new TextDecoder().decode((await bob.get('private-key'))!)).toBe('bob-secret')
  })

  it('open() is idempotent — calling twice does not error', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()
    await expect(backend.open()).resolves.toBeUndefined()

    await backend.put('k', new TextEncoder().encode('v'))
    expect(await backend.get('k')).not.toBeNull()
  })

  it('auto-opens on first operation when open() was not called', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    // No explicit open() — get/put should still work via requireDb.
    await backend.put('k', new TextEncoder().encode('v'))
    const got = await backend.get('k')
    expect(new TextDecoder().decode(got!)).toBe('v')
  })

  it('persists data across backend instances on the same JID', async () => {
    const first = new IndexedDBStorageBackend('alice@example.com')
    await first.open()
    await first.put('persistent', new TextEncoder().encode('survives-reopen'))

    // New instance, same JID → same database.
    const second = new IndexedDBStorageBackend('alice@example.com')
    await second.open()
    const got = await second.get('persistent')
    expect(new TextDecoder().decode(got!)).toBe('survives-reopen')
  })

  it('sanitizes JIDs that contain unsafe characters in the database name', async () => {
    // Anything outside [a-zA-Z0-9@._-] is replaced with `_`. Two different raw
    // JIDs that sanitize to the same name would share a DB; check that two
    // distinct sanitized names map to distinct DBs.
    const a = new IndexedDBStorageBackend('alice@example.com')
    const b = new IndexedDBStorageBackend('alice/resource@example.com')
    await a.open()
    await b.open()

    await a.put('k', new TextEncoder().encode('alice'))
    await b.put('k', new TextEncoder().encode('alice-resource'))

    expect(new TextDecoder().decode((await a.get('k'))!)).toBe('alice')
    expect(new TextDecoder().decode((await b.get('k'))!)).toBe('alice-resource')
  })

  it('preserves the exact bytes of binary values (no encoding side-effects)', async () => {
    const backend = new IndexedDBStorageBackend('alice@example.com')
    await backend.open()

    const original = new Uint8Array([0, 1, 2, 254, 255, 128, 0xff, 0xab, 0xcd])
    await backend.put('binary', original)

    const got = await backend.get('binary')
    expect(got).not.toBeNull()
    expect(Array.from(got!)).toEqual(Array.from(original))
  })
})
