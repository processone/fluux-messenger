/**
 * The Encryption overview's OpenPGP row (FLM-294 spec): Off, On with its backup state, Locked,
 * or Needs attention when the OpenPGP screen shows a warning.
 */
import { describe, it, expect } from 'vitest'
import { openPgpOverviewState, type OpenPgpOverviewInputs } from './openPgpOverviewState'

const FP = 'ab'.repeat(20)
const ready: OpenPgpOverviewInputs = {
  enabled: true,
  online: true,
  registrationError: false,
  locked: false,
  fingerprint: FP,
  warning: false,
  backupStatus: 'confirmed',
}
const state = (over: Partial<OpenPgpOverviewInputs>) => openPgpOverviewState({ ...ready, ...over })

describe('openPgpOverviewState', () => {
  it('is off when the switch is off, whatever else is true', () => {
    expect(state({ enabled: false, locked: true, warning: true })).toBe('off')
  })

  it('waits for a connection before anything else', () => {
    expect(state({ online: false, locked: true })).toBe('waiting')
  })

  it('needs attention after a registration failure, even when the key is locked', () => {
    expect(state({ registrationError: true, fingerprint: null, locked: true })).toBe('needs-attention')
  })

  it('is locked when the key waits for the session passphrase', () => {
    expect(state({ fingerprint: null, locked: true, backupStatus: null })).toBe('locked')
  })

  it('needs attention for a warning, with or without a ready key', () => {
    expect(state({ warning: true })).toBe('needs-attention')
    expect(state({ fingerprint: null, warning: true, backupStatus: null })).toBe('needs-attention')
  })

  it('is plainly on while the key is being made or the backup is still being checked', () => {
    expect(state({ fingerprint: null, backupStatus: null })).toBe('on')
    expect(state({ backupStatus: null })).toBe('on')
  })

  it('says the backup is in sync only when it is the file this device confirmed', () => {
    expect(state({})).toBe('on-backed-up')
  })

  it('says there is no backup when the server holds none', () => {
    expect(state({ backupStatus: 'absent' })).toBe('on-no-backup')
  })

  it('says the backup is unconfirmed when no file was confirmed, or it could not be checked', () => {
    expect(state({ backupStatus: 'unconfirmed' })).toBe('on-backup-unconfirmed')
    expect(state({ backupStatus: 'unknown' })).toBe('on-backup-unconfirmed')
  })

  it('says when the backup changed or is out of date (FLM-411)', () => {
    expect(state({ backupStatus: 'changed' })).toBe('on-backup-changed')
    expect(state({ backupStatus: 'out-of-date' })).toBe('on-backup-out-of-date')
  })
})
