import { beforeEach, describe, expect, it } from 'vitest'
import { createPluginStorage } from '@fluux/sdk'
import { TrustRecordStore } from '@fluux/openpgp-plugin'
import { LocalStorageStorageBackend } from './LocalStorageStorageBackend'

const ME = 'me@example.com'
const BOB = 'bob@example.com'
const BOB_FP = 'B0B0000000000000000000000000000000000012'
const BOB_NEW_FP = 'B0B0000000000000000000000000000000000022'

/** The plugin's storage as the SDK builds it over this backend. */
const pluginStorage = (account: string) =>
  createPluginStorage(new LocalStorageStorageBackend(account), 'e2ee/openpgp')

beforeEach(() => {
  localStorage.clear()
})

describe('LocalStorageStorageBackend', () => {
  it('keeps trust decisions across a restart of the app', async () => {
    const before = new TrustRecordStore()
    await before.attach(pluginStorage(ME))
    before.setDecision(BOB, BOB_FP, 'verified')
    before.setDecision(BOB, BOB_NEW_FP, 'untrusted')
    await before.flush()

    const after = new TrustRecordStore()
    expect(await after.attach(pluginStorage(ME))).toEqual({ found: true, readable: true })
    expect(after.decisions()).toEqual({ [BOB]: { [BOB_FP]: 'verified', [BOB_NEW_FP]: 'untrusted' } })
  })

  it('does not show one account the decisions of another', async () => {
    const mine = new TrustRecordStore()
    await mine.attach(pluginStorage(ME))
    mine.setDecision(BOB, BOB_FP, 'verified')
    await mine.flush()

    const other = new TrustRecordStore()
    expect(await other.attach(pluginStorage('other@example.com'))).toEqual({ found: false, readable: true })
  })

  it('lists, reads and deletes keys under a prefix', async () => {
    const storage = pluginStorage(ME)
    await storage.put('trust-seal', new Uint8Array([0, 1, 255]))
    await storage.put('trust-seal-written', new TextEncoder().encode('1'))
    await storage.put('trust-records', new TextEncoder().encode('{}'))

    expect((await storage.list('trust-seal')).sort()).toEqual(['trust-seal', 'trust-seal-written'])
    expect(await storage.get('trust-seal')).toEqual(new Uint8Array([0, 1, 255]))
    await storage.delete('trust-seal')
    expect(await storage.get('trust-seal')).toBeNull()
  })
})
