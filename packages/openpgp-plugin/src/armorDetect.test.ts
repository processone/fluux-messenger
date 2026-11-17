import { describe, expect, it } from 'vitest'
import { detectArmorKind } from './armorDetect'

describe('detectArmorKind', () => {
  // A genuine U+FEFF byte-order mark (BOM), the kind text-mode file readers
  // sometimes prepend. Constructed from its code point so the source stays
  // all-ASCII and unambiguous. The original bug matched the literal 6-char
  // text "backslash u F E F F" instead of this single code point.
  const BOM = String.fromCharCode(0xfeff)

  it('detects a Fluux backup (PGP MESSAGE)', () => {
    const armored = `-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js\n\nwcDM...\n-----END PGP MESSAGE-----\n`
    expect(detectArmorKind(armored)).toBe('message')
  })

  it('detects a raw private key block (gpg --export-secret-keys)', () => {
    const armored = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOY...\n-----END PGP PRIVATE KEY BLOCK-----\n`
    expect(detectArmorKind(armored)).toBe('private-key')
  })

  it('tolerates leading whitespace and BOM', () => {
    const armored = `${BOM}\n   \n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOY...\n-----END PGP PRIVATE KEY BLOCK-----\n`
    expect(detectArmorKind(armored)).toBe('private-key')
  })

  it('detects a PGP MESSAGE with a real BOM prefix', () => {
    // Guard the fixture: a mangled or empty BOM would still pass via
    // trimStart() without ever exercising BOM handling.
    expect(BOM.charCodeAt(0)).toBe(0xfeff)
    const armored = `${BOM}-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js\n\nwcDM...\n-----END PGP MESSAGE-----\n`
    expect(detectArmorKind(armored)).toBe('message')
  })

  it('returns "unknown" for a public-key block', () => {
    const armored = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQGN...\n-----END PGP PUBLIC KEY BLOCK-----\n`
    expect(detectArmorKind(armored)).toBe('unknown')
  })

  it('returns "unknown" for empty input', () => {
    expect(detectArmorKind('')).toBe('unknown')
  })

  it('returns "unknown" for garbage', () => {
    expect(detectArmorKind('this is not an armored block')).toBe('unknown')
  })
})
