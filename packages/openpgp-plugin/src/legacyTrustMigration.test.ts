import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { E2EEPluginError } from '@fluux/sdk'
import { TrustRecordStore } from './trustRecords'
import {
  LEGACY_UNSCOPED_CLAIM_LOCK,
  claimUnscopedLegacyTrust,
  legacyRecordsMismatch,
  legacySealCheckFor,
  parseLegacySealCheck,
  readLegacyTrustState,
  serializeLegacySealCheck,
  trustRecordsFromLegacy,
  verifyLegacyTrustStateSeal,
  type LegacyTrustState,
} from './legacyTrustMigration'

const ME = 'me@example.com'
const BOB = 'bob@example.com'
const CAROL = 'carol@example.com'
const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const BOB_FP = 'B0B0000000000000000000000000000000000012'
const CAROL_OLD_FP = 'CA40100000000000000000000000000000000013'
const CAROL_NEW_FP = 'CA40100000000000000000000000000000000023'
const NOW = '2026-11-18T10:00:00.000Z'

/** What earlier versions saved for `ME`, under the keys they used. */
function saveLegacy(values: Record<string, unknown>, scope: string | null = ME) {
  for (const [base, value] of Object.entries(values)) {
    const key = scope ? `${base}:${scope}` : base
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
}

const ALERT = { previousFingerprint: CAROL_OLD_FP, currentFingerprint: CAROL_NEW_FP, observedAt: '2026-10-01T08:00:00.000Z' }

/** The seal earlier versions wrote: their snapshot, "encrypted" by a passthrough. */
function legacySeal(state: { pins: Record<string, string>; verified: Record<string, string>; alerts: Record<string, unknown>; syncVersion: number }) {
  return JSON.stringify({ v: 1, sealedAt: '2026-10-01T08:00:00.000Z', ...state })
}

const decryptOwn = async (ciphertext: string) => ({
  plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
})
const isKeyUnavailable = (err: unknown) => err instanceof E2EEPluginError && err.code === 'key-locked'

beforeEach(() => {
  localStorage.clear()
})

describe('readLegacyTrustState', () => {
  it('reads every value earlier versions kept for the account', () => {
    saveLegacy({
      'fluux-e2ee-verified-peers': { [BOB]: BOB_FP },
      'fluux-e2ee-pinned-primary-fingerprints': { [BOB]: BOB_FP, [CAROL]: CAROL_NEW_FP },
      'fluux-e2ee-key-change-alerts': { [CAROL]: ALERT },
      'fluux-e2ee-cert-rejections': { [BOB]: [{ fingerprint: 'DEAD', code: 'uid_mismatch', detail: 'x', observedAt: 'y' }] },
      'fluux-e2ee-verifications-version': '7',
      'fluux-e2ee-trust-state-seal': 'SEAL',
      'fluux-e2ee-trust-integrity-init': '1',
    })
    expect(readLegacyTrustState(ME)).toEqual({
      verified: { [BOB]: BOB_FP },
      pins: { [BOB]: BOB_FP, [CAROL]: CAROL_NEW_FP },
      alerts: { [CAROL]: ALERT },
      rejections: { [BOB]: [{ fingerprint: 'DEAD', code: 'uid_mismatch', detail: 'x', observedAt: 'y' }] },
      syncVersion: 7,
      seal: 'SEAL',
      sealInitialized: true,
      usesUnscoped: false,
    })
  })

  it('reads the unscoped values earlier versions kept before scoping by account', () => {
    saveLegacy({ 'fluux-e2ee-verified-peers': { [BOB]: BOB_FP }, 'fluux-e2ee-verifications-version': '2' }, null)
    expect(readLegacyTrustState(ME)).toMatchObject({ verified: { [BOB]: BOB_FP }, syncVersion: 2, usesUnscoped: true })
  })

  it('gives the unscoped values to the first account that claims them, and keeps them in place', async () => {
    const OTHER = 'other@example.com'
    saveLegacy({ 'fluux-e2ee-verified-peers': { [BOB]: BOB_FP }, 'fluux-e2ee-verifications-version': '2' }, null)
    await claimUnscopedLegacyTrust(ME)
    await claimUnscopedLegacyTrust(OTHER)

    expect(readLegacyTrustState(OTHER)).toMatchObject({ verified: {}, syncVersion: -1, usesUnscoped: false })
    // A migration of ME that stopped half way still finds them.
    expect(readLegacyTrustState(ME)).toMatchObject({ verified: { [BOB]: BOB_FP }, syncVersion: 2, usesUnscoped: true })
    expect(localStorage.getItem('fluux-e2ee-verified-peers')).toBe(JSON.stringify({ [BOB]: BOB_FP }))
  })

  // The claim stands only once it is saved for this account. A failed save
  // leaves no owner, so the migration can try again; another account that
  // claimed them since they were read keeps them.
  it.each([
    ['cannot be saved', 'unavailable', null, (_key: string, _value: string, _save: (k: string, v: string) => void) => { throw new Error('quota exceeded') }],
    ['is taken by another account since they were read', 'other-owner', 'other@example.com', (key: string, _value: string, save: (k: string, v: string) => void) => save(key, 'other@example.com')],
  ] as const)('confirms no claim that %s: %s', async (_case, expected, owner, ownerWrite) => {
    saveLegacy({ 'fluux-e2ee-verified-peers': { [BOB]: BOB_FP }, 'fluux-e2ee-verifications-version': '2' }, null)
    expect(readLegacyTrustState(ME).usesUnscoped).toBe(true)
    const setItem = localStorage.setItem
    const save = (key: string, value: string) => setItem.call(localStorage, key, value)
    localStorage.setItem = (key: string, value: string) =>
      key === 'fluux-e2ee-legacy-unscoped-owner' ? ownerWrite(key, value, save) : save(key, value)
    try {
      expect(await claimUnscopedLegacyTrust(ME)).toBe(expected)
    } finally {
      localStorage.setItem = setItem
    }
    expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBe(owner)
  })

  it('confirms the claim of the first account', async () => {
    saveLegacy({ 'fluux-e2ee-verified-peers': { [BOB]: BOB_FP } }, null)
    expect(await claimUnscopedLegacyTrust(ME)).toBe('owned')
    expect(await claimUnscopedLegacyTrust(ME)).toBe('owned')
    expect(await claimUnscopedLegacyTrust('other@example.com')).toBe('other-owner')
  })

  describe('claiming across windows', () => {
    const lockManager = navigator.locks
    const useLocks = (locks: unknown) => Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
    afterEach(() => {
      useLocks(lockManager)
    })

    it('waits while another window claims the unscoped values, then leaves them to that account', async () => {
      saveLegacy({ 'fluux-e2ee-verified-peers': { [BOB]: BOB_FP } }, null)
      // Another window, signed in to another account, found no owner and is saving its claim.
      let otherWindowSaves!: () => void
      const otherWindow = navigator.locks.request(LEGACY_UNSCOPED_CLAIM_LOCK, () => new Promise<void>((resolve) => {
        otherWindowSaves = () => {
          localStorage.setItem('fluux-e2ee-legacy-unscoped-owner', 'other@example.com')
          resolve()
        }
      }))

      const claim = claimUnscopedLegacyTrust(ME)
      await new Promise((r) => setTimeout(r, 0))
      expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBeNull()
      otherWindowSaves()
      await otherWindow

      expect(await claim).toBe('other-owner')
      expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBe('other@example.com')
    })

    // Intent: FLM-311 - without Web Locks (an older system web view, a page
    // served without HTTPS) the move no longer waits for ever, and still
    // gives the values to one account: the claim is made in one transaction
    // of a database the windows share.
    describe('without a lock shared between windows', () => {
      const noLock: [string, unknown][] = [
        ['the browser has none', null],
        ['the lock is refused', { request: () => Promise.reject(new DOMException('The operation is insecure.', 'SecurityError')) }],
      ]
      const indexedDBBefore = globalThis.indexedDB
      beforeEach(() => {
        globalThis.indexedDB = new IDBFactory()
        saveLegacy({ 'fluux-e2ee-verified-peers': { [BOB]: BOB_FP } }, null)
      })
      afterEach(() => {
        globalThis.indexedDB = indexedDBBefore
      })

      it.each(noLock)('confirms the claim it saves when %s', async (_case, locks) => {
        useLocks(locks)
        expect(await claimUnscopedLegacyTrust(ME)).toBe('owned')
        expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBe(ME)
        expect(await claimUnscopedLegacyTrust('other@example.com')).toBe('other-owner')
      })

      // Another window's claim reaches this window's localStorage late, or
      // not at all; it is the claim the database saved first that counts.
      it.each(noLock)('leaves the values to the claim another window saved first, even one this window cannot see, when %s', async (_case, locks) => {
        useLocks(locks)
        const setItem = localStorage.setItem
        localStorage.setItem = (key: string, value: string) => {
          if (key !== 'fluux-e2ee-legacy-unscoped-owner') setItem.call(localStorage, key, value)
        }
        try {
          expect(await claimUnscopedLegacyTrust('other@example.com')).toBe('owned')
          expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBeNull()
          expect(await claimUnscopedLegacyTrust(ME)).toBe('other-owner')
        } finally {
          localStorage.setItem = setItem
        }
      })

      it.each(noLock)('gives the values to one of two windows claiming at the same moment when %s', async (_case, locks) => {
        useLocks(locks)
        const setItem = localStorage.setItem
        localStorage.setItem = (key: string, value: string) => {
          if (key !== 'fluux-e2ee-legacy-unscoped-owner') setItem.call(localStorage, key, value)
        }
        try {
          const claims = await Promise.all([claimUnscopedLegacyTrust(ME), claimUnscopedLegacyTrust('other@example.com')])
          expect([...claims].sort()).toEqual(['other-owner', 'owned'])
        } finally {
          localStorage.setItem = setItem
        }
      })

      it.each([
        ['the browser has no database', () => {
          globalThis.indexedDB = undefined as unknown as IDBFactory
        }],
        ['the database cannot be opened', () => {
          globalThis.indexedDB = { open: () => { throw new DOMException('denied', 'SecurityError') } } as unknown as IDBFactory
        }],
        ['the database never answers', () => {
          globalThis.indexedDB = { open: () => ({}) } as unknown as IDBFactory
        }],
      ])('confirms no claim when %s', async (_case, breakDatabase) => {
        useLocks(null)
        breakDatabase()
        expect(await claimUnscopedLegacyTrust(ME, 20)).toBe('unavailable')
        expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBeNull()
      })
    })
  })

  it('does not read another account\'s values', () => {
    saveLegacy({ 'fluux-e2ee-verified-peers': { [BOB]: BOB_FP } }, 'other@example.com')
    expect(readLegacyTrustState(ME)).toMatchObject({ verified: {}, syncVersion: -1, seal: null, sealInitialized: false })
  })

  it('leaves the old values in place', () => {
    saveLegacy({ 'fluux-e2ee-verified-peers': { [BOB]: BOB_FP } })
    readLegacyTrustState(ME)
    expect(localStorage.getItem(`fluux-e2ee-verified-peers:${ME}`)).toBe(JSON.stringify({ [BOB]: BOB_FP }))
  })
})

describe('trustRecordsFromLegacy', () => {
  const legacy = (over: Partial<LegacyTrustState>): LegacyTrustState => ({
    verified: {}, pins: {}, alerts: {}, rejections: {}, syncVersion: -1, seal: null, sealInitialized: false, usesUnscoped: false, ...over,
  })

  it('keeps each verified key verified', () => {
    expect(trustRecordsFromLegacy(legacy({ verified: { [BOB]: BOB_FP.toLowerCase() } }), NOW).peers).toEqual({
      [BOB]: { [BOB_FP]: { decision: 'verified', decidedAt: NOW } },
    })
  })

  it('keeps the key a key-change alert replaced verified, so the newer key waits for a decision', () => {
    expect(trustRecordsFromLegacy(legacy({ alerts: { [CAROL]: ALERT } }), NOW).peers).toEqual({
      [CAROL]: { [CAROL_OLD_FP]: { decision: 'verified', decidedAt: NOW } },
    })
  })

  it('drops pins, and carries rejections and the sync version', () => {
    const rejection = { fingerprint: BOB_FP, code: 'no_encryption_subkey' as const, detail: 'gone', observedAt: NOW }
    const records = trustRecordsFromLegacy(legacy({
      pins: { [BOB]: BOB_FP },
      rejections: { [BOB]: [rejection, { ...rejection, code: 'made_up' as never }] },
      syncVersion: 5,
    }), NOW)
    expect(records).toEqual({ v: 1, peers: {}, rejections: { [BOB]: [rejection] }, syncVersion: 5, setsAdopted: false })
  })
})

describe('legacyRecordsMismatch', () => {
  const state = { verified: { [BOB]: BOB_FP }, alerts: { [CAROL]: ALERT }, syncVersion: 4 }
  const migrated = () => {
    saveLegacy({
      'fluux-e2ee-verified-peers': state.verified,
      'fluux-e2ee-key-change-alerts': state.alerts,
      'fluux-e2ee-verifications-version': String(state.syncVersion),
    })
    const legacy = readLegacyTrustState(ME)
    const records = new TrustRecordStore()
    records.replace(trustRecordsFromLegacy(legacy, NOW))
    return { check: legacySealCheckFor(legacy)!, records }
  }

  it('finds nothing when the records are what the migration made of the old data', () => {
    const { check, records } = migrated()
    expect(legacyRecordsMismatch(check, records)).toEqual([])
  })

  it('finds a decision changed behind the plugin', () => {
    const { check, records } = migrated()
    records.setDecision(CAROL, CAROL_NEW_FP, 'verified')
    expect(legacyRecordsMismatch(check, records)).toEqual(['trust decisions differ from the upgraded trust state'])
  })

  it('finds a changed sync version or an adopted set node', () => {
    const changed = migrated()
    changed.records.setSyncVersion(9)
    expect(legacyRecordsMismatch(changed.check, changed.records)).toEqual(['verification sync state differs from the upgraded trust state'])
    const adopted = migrated()
    adopted.records.adoptSets()
    expect(legacyRecordsMismatch(adopted.check, adopted.records)).toEqual(['verification sync state differs from the upgraded trust state'])
  })
})

describe('the earlier seal check', () => {
  const state = {
    pins: { [BOB]: BOB_FP, [CAROL]: CAROL_NEW_FP },
    verified: { [BOB]: BOB_FP },
    alerts: { [CAROL]: ALERT },
    syncVersion: 4,
  }
  const saveState = (seal: string | null, values = state) => saveLegacy({
    'fluux-e2ee-verified-peers': values.verified,
    'fluux-e2ee-pinned-primary-fingerprints': values.pins,
    'fluux-e2ee-key-change-alerts': values.alerts,
    'fluux-e2ee-verifications-version': String(values.syncVersion),
    ...(seal ? { 'fluux-e2ee-trust-state-seal': seal, 'fluux-e2ee-trust-integrity-init': '1' } : {}),
  })
  const verdictFor = async (decrypt = decryptOwn) => {
    const check = legacySealCheckFor(readLegacyTrustState(ME))
    expect(check).not.toBeNull()
    // The check waits in plugin storage until the key is usable.
    const saved = parseLegacySealCheck(serializeLegacySealCheck(check!))
    return verifyLegacyTrustStateSeal(saved!, decrypt, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
  }

  it('is sealed when the old data matches its seal', async () => {
    saveState(legacySeal(state))
    expect(await verdictFor()).toEqual({ status: 'sealed' })
  })

  it('names what was changed behind the earlier version', async () => {
    saveState(legacySeal(state), { ...state, verified: { [BOB]: CAROL_NEW_FP } })
    expect(await verdictFor()).toEqual({ status: 'compromised', details: ['verified peers differ'] })
  })

  it('compares key-change alerts by contact only, as earlier versions did', async () => {
    saveState(legacySeal(state), { ...state, alerts: { [CAROL]: { ...ALERT, observedAt: '2026-10-02T08:00:00.000Z' } } })
    expect(await verdictFor()).toEqual({ status: 'sealed' })
  })

  it('is compromised when a key-change alert names another replaced key than the sealed one', async () => {
    const changed = { [CAROL]: { ...ALERT, previousFingerprint: 'BAD0000000000000000000000000000000000041' } }
    saveState(legacySeal(state), { ...state, alerts: changed })
    expect(await verdictFor()).toEqual({ status: 'compromised', details: ['key-change alerts differ'] })
  })

  it('is compromised when the seal was removed after one was written', async () => {
    saveState(null)
    localStorage.setItem(`fluux-e2ee-trust-integrity-init:${ME}`, '1')
    expect(await verdictFor()).toEqual({ status: 'compromised', details: ['Trust state seal was removed but stores contain data'] })
  })

  it('is pending-seal when data exists and no seal was ever written', async () => {
    saveState(null)
    expect(await verdictFor()).toEqual({ status: 'pending-seal' })
  })

  it('waits for the key when it is locked', async () => {
    saveState(legacySeal(state))
    const locked = async () => { throw new E2EEPluginError('transient', 'key-locked', 'locked') }
    expect(await verdictFor(locked)).toEqual({ status: 'awaiting-key' })
  })

  it('is compromised when a key other than ours signed the seal', async () => {
    saveState(legacySeal(state))
    const foreign = async (ciphertext: string) => ({ ...(await decryptOwn(ciphertext)), signerFingerprint: 'FFFF' })
    expect((await verdictFor(foreign)).status).toBe('compromised')
  })

  it('has nothing to check for an account without old data', () => {
    expect(legacySealCheckFor(readLegacyTrustState(ME))).toBeNull()
  })
})
