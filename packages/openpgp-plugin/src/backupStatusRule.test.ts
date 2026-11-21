/** Intent FLM-411: the status rule. A record of the confirmed file decides; a failed hash or key read is never confirmed. */
import { describe, expect, it, beforeEach } from 'vitest'
import { backupIdentityStatus, readBackupIdentity, writeBackupIdentity, clearBackupIdentity, type BackupIdentityRecord } from './backupIdentity'

const hash = 'a'.repeat(64)
const record: BackupIdentityRecord = { version: 1, packetsSha256: hash, fingerprints: ['AAAA', 'BBBB'], confirmedBy: 'publish', confirmedAt: '2026-11-21T10:00:00.000Z' }
beforeEach(() => localStorage.clear())

describe('backupIdentityStatus', () => {
  it.each([
    ['same file and every part held', record, hash, ['bbbb', 'aaaa'], 'confirmed'],
    ['same file and fewer parts than recorded', record, hash, ['AAAA'], 'confirmed'],
    ['same file but this key has a part the record lacks', record, hash, ['AAAA', 'BBBB', 'CCCC'], 'out-of-date'],
    ['another file', record, 'b'.repeat(64), ['AAAA', 'BBBB'], 'changed'],
    ['no record', null, hash, ['AAAA'], 'unconfirmed'],
    ['hash failed', record, null, ['AAAA'], 'unknown'],
    ['own key unreadable', record, hash, null, 'unknown'],
    ['no own parts', record, hash, [], 'unknown'],
  ] as const)('%s → %s', (_name, rec, serverHash, own, expected) => {
    expect(backupIdentityStatus({ record: rec, serverHash, ownFingerprints: own })).toBe(expected)
  })
})

describe('the stored record', () => {
  it('round-trips, ignores a damaged value and clears', () => {
    writeBackupIdentity('a@b', record)
    expect(readBackupIdentity('a@b')).toEqual(record)
    localStorage.setItem('fluux:openpgp:backupIdentity:v1:a@b', '{"version":2}')
    expect(readBackupIdentity('a@b')).toBeNull()
    writeBackupIdentity('a@b', record)
    clearBackupIdentity('a@b')
    expect(readBackupIdentity('a@b')).toBeNull()
  })
})
