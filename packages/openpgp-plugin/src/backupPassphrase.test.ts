import { describe, expect, it } from 'vitest'
import { legacyNormalizeBackupPassphrase, prepareBackupPassphrase } from './backupPassphrase'

describe('prepareBackupPassphrase', () => {
  it('preserves the passphrase verbatim — case, accents, and internal spacing', () => {
    // #1021: the passphrase is opaque key material. What the user sees is
    // what every client must feed the S2K, byte for byte.
    expect(prepareBackupPassphrase('TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW')).toBe(
      'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW',
    )
    expect(prepareBackupPassphrase('Café Été')).toBe('Café Été')
    expect(prepareBackupPassphrase('two  spaces')).toBe('two  spaces')
  })

  it('trims only surrounding whitespace (paste artifacts)', () => {
    expect(prepareBackupPassphrase('  ABCD-1234\n')).toBe('ABCD-1234')
    expect(prepareBackupPassphrase('\tWord One \n')).toBe('Word One')
  })
})

describe('legacyNormalizeBackupPassphrase', () => {
  it('reproduces the pre-0.17.2 normalization: NFKD, lowercase, collapsed whitespace', () => {
    expect(legacyNormalizeBackupPassphrase('TWNK-KD5Y')).toBe('twnk-kd5y')
    expect(legacyNormalizeBackupPassphrase('Hello World')).toBe('hello world')
    expect(legacyNormalizeBackupPassphrase('  a    b  ')).toBe('a b')
    expect(legacyNormalizeBackupPassphrase('a\tb\nc')).toBe('a b c')
    expect(legacyNormalizeBackupPassphrase('a b')).toBe('a b')
    // NFC and NFD spellings of "café" normalize to the same NFKD form.
    expect(legacyNormalizeBackupPassphrase('café')).toBe(
      legacyNormalizeBackupPassphrase('café'),
    )
  })

  it('differs from the canonical form for a XEP-0373 §5.4 backup code — the migration trigger', () => {
    const code = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'
    expect(legacyNormalizeBackupPassphrase(code)).not.toBe(prepareBackupPassphrase(code))
  })
})
