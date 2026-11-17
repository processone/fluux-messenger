import { describe, it, expect } from 'vitest'
import {
  currentPassphraseFormat,
  withPassphraseFormatHeader,
  parseArmorPassphraseFormat,
} from './passphraseFormatHeader'

const MSG = (headers = '') =>
  `-----BEGIN PGP MESSAGE-----\n${headers}\nwcDMAxk...base64body...\n-----END PGP MESSAGE-----\n`

describe('currentPassphraseFormat', () => {
  it('is xep0373 while USE_V6_KEYS is false (v4 default)', () => {
    expect(currentPassphraseFormat()).toBe('xep0373')
  })
})

describe('withPassphraseFormatHeader', () => {
  it('inserts the header line right after the BEGIN line', () => {
    const out = withPassphraseFormatHeader(MSG('Version: OpenPGP.js'), 'xep0373')
    expect(out).toContain('-----BEGIN PGP MESSAGE-----\nPassphrase-Format: xep0373\n')
    // The original body and Version header survive.
    expect(out).toContain('Version: OpenPGP.js')
    expect(out).toContain('wcDMAxk')
  })

  it('handles a message with no existing armor headers', () => {
    const out = withPassphraseFormatHeader(MSG(''), 'bip39')
    expect(out).toContain('-----BEGIN PGP MESSAGE-----\nPassphrase-Format: bip39\n')
  })

  it('is idempotent — never adds a second header', () => {
    const once = withPassphraseFormatHeader(MSG(), 'xep0373')
    const twice = withPassphraseFormatHeader(once, 'xep0373')
    expect(twice).toBe(once)
  })

  it('defaults the format to currentPassphraseFormat()', () => {
    const out = withPassphraseFormatHeader(MSG())
    expect(out).toContain('Passphrase-Format: xep0373')
  })

  it('leaves a non-MESSAGE blob untouched', () => {
    const key = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nbody\n-----END PGP PRIVATE KEY BLOCK-----\n'
    expect(withPassphraseFormatHeader(key, 'xep0373')).toBe(key)
  })
})

describe('parseArmorPassphraseFormat', () => {
  it('reads the Fluux xep0373 header', () => {
    expect(parseArmorPassphraseFormat(withPassphraseFormatHeader(MSG(), 'xep0373'))).toBe('xep0373')
  })

  it("reads OpenKeychain's numeric9x4 header verbatim", () => {
    expect(parseArmorPassphraseFormat(MSG('Passphrase-Format: numeric9x4'))).toBe('numeric9x4')
  })

  it('returns null when the header is absent', () => {
    expect(parseArmorPassphraseFormat(MSG('Version: GnuPG v2'))).toBeNull()
  })

  it('returns null for a raw private key block', () => {
    expect(
      parseArmorPassphraseFormat('-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nx\n-----END PGP PRIVATE KEY BLOCK-----'),
    ).toBeNull()
  })

  it('tolerates a leading BOM/whitespace', () => {
    expect(parseArmorPassphraseFormat('﻿  ' + withPassphraseFormatHeader(MSG(), 'xep0373'))).toBe('xep0373')
  })
})
