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
})
