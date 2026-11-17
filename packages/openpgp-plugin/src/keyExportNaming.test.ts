import { describe, it, expect } from 'vitest'
import { keyExportFilename } from './keyExportNaming'

describe('keyExportFilename', () => {
  it('embeds the account JID so exports are self-describing', () => {
    expect(keyExportFilename('alice@example.org')).toBe('openpgp-backup-alice@example.org.asc')
  })

  it('replaces filesystem-unsafe characters (resource separators, slashes)', () => {
    expect(keyExportFilename('alice@example.org/phone')).toBe('openpgp-backup-alice@example.org_phone.asc')
    expect(keyExportFilename('a/b\\c:d')).toBe('openpgp-backup-a_b_c_d.asc')
  })

  it('collapses runs and trims leading/trailing separators (no hidden file, no `..`)', () => {
    expect(keyExportFilename('..weird//jid..')).toBe('openpgp-backup-weird_jid.asc')
  })

  it('falls back to a bare name when the JID sanitizes to nothing', () => {
    expect(keyExportFilename('')).toBe('openpgp-backup.asc')
    expect(keyExportFilename('   ')).toBe('openpgp-backup.asc')
    expect(keyExportFilename('///')).toBe('openpgp-backup.asc')
  })
})
