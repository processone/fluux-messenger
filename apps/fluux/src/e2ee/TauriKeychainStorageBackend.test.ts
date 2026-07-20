import { describe, it, expect, vi } from 'vitest'
import { TauriKeychainStorageBackend } from './TauriKeychainStorageBackend'

function fakeInvoke() {
  const store = new Map<string, string>() // "account key" -> base64
  return vi.fn(async (cmd: string, args: any) => {
    const k = `${args.account} ${args.key}`
    if (cmd === 'e2ee_store_put') {
      store.set(k, args.valueB64)
      return
    }
    if (cmd === 'e2ee_store_get') {
      return store.get(k) ?? null
    }
    if (cmd === 'e2ee_store_delete') {
      store.delete(k)
      return
    }
    if (cmd === 'e2ee_store_list') {
      const accountPrefix = `${args.account} ${args.prefix}`
      return [...store.keys()]
        .filter((kk) => kk.startsWith(accountPrefix))
        .map((kk) => kk.slice(`${args.account} `.length))
    }
    throw new Error('unknown cmd ' + cmd)
  })
}

describe('TauriKeychainStorageBackend', () => {
  it('round-trips bytes (incl. high-bit) via base64 IPC', async () => {
    const invoke = fakeInvoke()
    const b = new TauriKeychainStorageBackend('alice@x', invoke as any)
    const v = new Uint8Array([0, 0x80, 0xff, 1])
    await b.put('session/bob/5', v)
    expect(await b.get('session/bob/5')).toEqual(v)
    expect(invoke).toHaveBeenCalledWith(
      'e2ee_store_put',
      expect.objectContaining({ account: 'alice@x', key: 'session/bob/5', valueB64: expect.any(String) })
    )
  })

  it('get of a missing key returns null; delete is a no-op; list filters', async () => {
    const b = new TauriKeychainStorageBackend('a@x', fakeInvoke() as any)
    expect(await b.get('nope')).toBeNull()
    await b.delete('nope')
    await b.put('session/1', new Uint8Array([1]))
    await b.put('trust/1', new Uint8Array([2]))
    expect((await b.list('session/')).sort()).toEqual(['session/1'])
  })

  describe('store name routing', () => {
    it('omits the store arg when no storeName is given (legacy file)', async () => {
      const invoke = vi.fn().mockResolvedValue(null)
      const b = new TauriKeychainStorageBackend('a@x', invoke)
      await b.get('k')
      expect(invoke).toHaveBeenCalledWith('e2ee_store_get', { account: 'a@x', key: 'k' })
      // toHaveBeenCalledWith uses toEqual semantics, which treats an absent key
      // as equal to a present-but-undefined one. Assert genuine absence so a
      // future `{ ...args, store: this.storeName }` refactor (which would send
      // `store: undefined` and break the legacy `<jid>.json` path) fails here.
      expect(invoke.mock.calls[0][1]).not.toHaveProperty('store')
    })

    it('passes the store arg when a storeName is given', async () => {
      const invoke = vi.fn().mockResolvedValue(null)
      const b = new TauriKeychainStorageBackend('a@x', invoke, 'openpgp')
      await b.get('k')
      expect(invoke).toHaveBeenCalledWith('e2ee_store_get', { account: 'a@x', key: 'k', store: 'openpgp' })
    })

    it('put omits the store arg when no storeName is given', async () => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const b = new TauriKeychainStorageBackend('a@x', invoke)
      await b.put('k', new Uint8Array([1]))
      expect(invoke).toHaveBeenCalledWith('e2ee_store_put', { account: 'a@x', key: 'k', valueB64: expect.any(String) })
      expect(invoke.mock.calls[0][1]).not.toHaveProperty('store')
    })

    it('put passes the store arg when a storeName is given', async () => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const b = new TauriKeychainStorageBackend('a@x', invoke, 'openpgp')
      await b.put('k', new Uint8Array([1]))
      expect(invoke).toHaveBeenCalledWith('e2ee_store_put', {
        account: 'a@x',
        key: 'k',
        valueB64: expect.any(String),
        store: 'openpgp',
      })
    })

    it('delete omits the store arg when no storeName is given', async () => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const b = new TauriKeychainStorageBackend('a@x', invoke)
      await b.delete('k')
      expect(invoke).toHaveBeenCalledWith('e2ee_store_delete', { account: 'a@x', key: 'k' })
      expect(invoke.mock.calls[0][1]).not.toHaveProperty('store')
    })

    it('delete passes the store arg when a storeName is given', async () => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const b = new TauriKeychainStorageBackend('a@x', invoke, 'openpgp')
      await b.delete('k')
      expect(invoke).toHaveBeenCalledWith('e2ee_store_delete', { account: 'a@x', key: 'k', store: 'openpgp' })
    })

    it('list omits the store arg when no storeName is given', async () => {
      const invoke = vi.fn().mockResolvedValue([])
      const b = new TauriKeychainStorageBackend('a@x', invoke)
      await b.list('prefix/')
      expect(invoke).toHaveBeenCalledWith('e2ee_store_list', { account: 'a@x', prefix: 'prefix/' })
      expect(invoke.mock.calls[0][1]).not.toHaveProperty('store')
    })

    it('list passes the store arg when a storeName is given', async () => {
      const invoke = vi.fn().mockResolvedValue([])
      const b = new TauriKeychainStorageBackend('a@x', invoke, 'openpgp')
      await b.list('prefix/')
      expect(invoke).toHaveBeenCalledWith('e2ee_store_list', { account: 'a@x', prefix: 'prefix/', store: 'openpgp' })
    })
  })
})
