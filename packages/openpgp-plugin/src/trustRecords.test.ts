import { describe, expect, it } from 'vitest'
import { InMemoryStorageBackend, createPluginStorage, type PluginStorage } from '@fluux/sdk'
import {
  TRUST_RECORDS_STORAGE_KEY,
  TrustRecordStore,
  canonicalFingerprint,
  emptyTrustRecords,
  keyStanding,
  parseTrustRecords,
  planVerifiedSetsUpdate,
  serializeTrustRecords,
  type TrustRecordsChange,
} from './trustRecords'

const BOB = 'bob@example.com'
const CAROL = 'carol@example.com'
// v4 fingerprints as XEP-0373 publishes them, and one v6 fingerprint.
const FP_A = 'B0B0000000000000000000000000000000000012'
const FP_B = 'B0B0000000000000000000000000000000000022'
const FP_V6 = 'CA40100000000000000000000000000000000000000000000000000000000013'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function newStorage(): PluginStorage {
  return createPluginStorage(new InMemoryStorageBackend(), 'openpgp-test')
}

describe('canonicalFingerprint', () => {
  it('upper-cases and removes spaces from v4 and v6 fingerprints', () => {
    expect(canonicalFingerprint('b0b0 0000 0000 0000 0000  0000 0000 0000 0000 0012')).toBe(FP_A)
    expect(canonicalFingerprint(FP_V6.toLowerCase())).toBe(FP_V6)
  })

  it('refuses anything that is not a fingerprint', () => {
    expect(canonicalFingerprint('B0B0')).toBeNull()
    expect(canonicalFingerprint('xmpp:bob@example.com')).toBeNull()
  })
})

describe('parseTrustRecords', () => {
  it('reads what serializeTrustRecords wrote', () => {
    const data = emptyTrustRecords()
    data.peers[BOB] = { [FP_A]: { decision: 'verified', decidedAt: '2024-01-01T00:00:00.000Z' } }
    data.rejections[BOB] = [{ fingerprint: FP_B, code: 'uid_mismatch', detail: 'wrong UID', observedAt: '2024-01-02T00:00:00.000Z' }]
    data.syncVersion = 3
    expect(parseTrustRecords(serializeTrustRecords(data))).toEqual(data)
  })

  it('drops entries of the wrong shape and keeps the rest', () => {
    const parsed = parseTrustRecords(encode({
      v: 1,
      peers: {
        [BOB]: {
          [FP_A.toLowerCase()]: { decision: 'verified', decidedAt: '2024-01-01T00:00:00.000Z' },
          [FP_B]: { decision: 'trusted', decidedAt: '2024-01-01T00:00:00.000Z' },
          NOTAFINGERPRINT: { decision: 'tofu', decidedAt: '2024-01-01T00:00:00.000Z' },
        },
        [CAROL]: 'verified',
      },
      rejections: { [BOB]: [{ fingerprint: FP_B, code: 'made_up', detail: '', observedAt: '' }] },
      syncVersion: 1.5,
    }))
    expect(parsed).toEqual({
      v: 1,
      peers: { [BOB]: { [FP_A]: { decision: 'verified', decidedAt: '2024-01-01T00:00:00.000Z' } } },
      rejections: {},
      syncVersion: -1,
    })
  })

  it('is null for a blob that is not records', () => {
    expect(parseTrustRecords(new TextEncoder().encode('not json'))).toBeNull()
    expect(parseTrustRecords(encode({ v: 2, peers: {} }))).toBeNull()
  })
})

describe('keyStanding', () => {
  it.each([
    ['verified', false, { trust: 'verified', used: true, allowedDecisions: ['tofu', 'untrusted'] }],
    ['tofu', true, { trust: 'tofu', used: true, allowedDecisions: ['verified', 'untrusted'] }],
    ['untrusted', false, { trust: 'untrusted', used: false, notUsedReason: 'distrusted', allowedDecisions: ['verified', 'tofu'] }],
    [undefined, false, { trust: 'tofu', used: true, allowedDecisions: ['verified', 'untrusted'] }],
    [undefined, true, { trust: 'unknown', used: false, notUsedReason: 'awaiting-decision', allowedDecisions: ['verified', 'tofu', 'untrusted'] }],
  ] as const)('a %s key of a contact that holds new keys: %s', (decision, holds, expected) => {
    expect(keyStanding(decision, holds)).toEqual(expected)
  })
})

describe('planVerifiedSetsUpdate', () => {
  it('verifies keys a newer list verifies and approves keys it no longer verifies', () => {
    const changes = planVerifiedSetsUpdate(
      { [BOB]: [FP_A.toLowerCase(), FP_B], [CAROL]: [FP_V6] },
      { [BOB]: [FP_A], 'dave@example.com': ['DA7E000000000000000000000000000000000014'] },
    )
    expect(changes).toEqual(expect.arrayContaining([
      { peer: BOB, fingerprint: FP_B, decision: 'verified' },
      { peer: CAROL, fingerprint: FP_V6, decision: 'verified' },
      { peer: 'dave@example.com', fingerprint: 'DA7E000000000000000000000000000000000014', decision: 'tofu' },
    ]))
    expect(changes).toHaveLength(3)
  })

  it('ignores entries that are not fingerprints', () => {
    expect(planVerifiedSetsUpdate({ [BOB]: ['BOB_FP'] }, {})).toEqual([])
  })
})

describe('TrustRecordStore', () => {
  it('saves decisions and reads them back in a new store', async () => {
    const storage = newStorage()
    const first = new TrustRecordStore()
    expect(await first.attach(storage)).toEqual({ found: false, readable: true })
    first.setDecisions([
      { peer: BOB, fingerprint: FP_A, decision: 'verified' },
      { peer: BOB, fingerprint: FP_B, decision: 'untrusted' },
    ], '2024-01-01T00:00:00.000Z')
    first.setSyncVersion(2)
    await first.flush()

    const second = new TrustRecordStore()
    expect(await second.attach(storage)).toEqual({ found: true, readable: true })
    expect(second.decisions()).toEqual({ [BOB]: { [FP_A]: 'verified', [FP_B]: 'untrusted' } })
    expect(second.syncVersion()).toBe(2)
    expect(second.verifiedSets()).toEqual({ [BOB]: [FP_A] })
  })

  it('starts empty from an unreadable blob and says so', async () => {
    const storage = newStorage()
    await storage.put(TRUST_RECORDS_STORAGE_KEY, new TextEncoder().encode('{'))
    const store = new TrustRecordStore()
    expect(await store.attach(storage)).toEqual({ found: true, readable: false })
    expect(store.hasDecisions()).toBe(false)
  })

  it('saves the last change when writes overlap', async () => {
    const storage = newStorage()
    const store = new TrustRecordStore()
    await store.attach(storage)
    store.setDecision(BOB, FP_A, 'verified')
    store.setDecision(BOB, FP_A, 'tofu')
    store.setDecision(BOB, FP_A, null)
    store.setDecision(CAROL, FP_V6, 'untrusted')
    await store.flush()
    expect(parseTrustRecords((await storage.get(TRUST_RECORDS_STORAGE_KEY))!)?.peers).toEqual({
      [CAROL]: { [FP_V6]: expect.objectContaining({ decision: 'untrusted' }) },
    })
  })

  it('reports what each change touched, and skips a decision already recorded', async () => {
    const store = new TrustRecordStore()
    await store.attach(newStorage())
    const changes: TrustRecordsChange[] = []
    store.subscribe((change) => changes.push(change))

    store.setDecision(BOB, FP_A, 'tofu')
    store.setDecision(BOB, FP_A, 'tofu')
    store.setDecision(BOB, FP_A, 'verified')
    store.setRejections(BOB, [{ fingerprint: FP_B, code: 'uid_mismatch', detail: 'x', observedAt: 'y' }])
    store.setSyncVersion(4)

    expect(changes).toEqual([
      { peers: [BOB], decisions: true, verified: false, syncVersion: false, loaded: false },
      { peers: [BOB], decisions: true, verified: true, syncVersion: false, loaded: false },
      { peers: [BOB], decisions: false, verified: false, syncVersion: false, loaded: false },
      { peers: [], decisions: false, verified: false, syncVersion: true, loaded: false },
    ])
  })

  it('keeps a contact\'s decisions view until one of them changes', async () => {
    const store = new TrustRecordStore()
    await store.attach(newStorage())
    store.setDecision(BOB, FP_A, 'verified')
    const view = store.decisionsView(BOB)
    expect(store.decisionsView(BOB)).toBe(view)
    store.setDecision(CAROL, FP_V6, 'tofu')
    expect(store.decisionsView(BOB)).toBe(view)
    store.setDecision(BOB, FP_B, 'untrusted')
    expect(store.decisionsView(BOB)).not.toBe(view)
    expect(store.decisionsView(BOB)).toEqual({ [FP_A]: 'verified', [FP_B]: 'untrusted' })
  })

  it('counts a contact as verified through a key it no longer announces', async () => {
    const store = new TrustRecordStore()
    await store.attach(newStorage())
    store.setDecision(BOB, FP_A, 'tofu')
    expect(store.hasVerified(BOB)).toBe(false)
    store.setDecision(BOB, FP_B, 'verified')
    expect(store.hasVerified(BOB)).toBe(true)
  })

  it('forgets the records and stops saving after detach', async () => {
    const storage = newStorage()
    const store = new TrustRecordStore()
    await store.attach(storage)
    store.setDecision(BOB, FP_A, 'verified')
    await store.flush()
    store.detach()
    expect(store.hasDecisions()).toBe(false)
    store.setDecision(CAROL, FP_V6, 'verified')
    await store.flush()
    expect(parseTrustRecords((await storage.get(TRUST_RECORDS_STORAGE_KEY))!)?.peers).toEqual({
      [BOB]: { [FP_A]: expect.objectContaining({ decision: 'verified' }) },
    })
  })
})
