import { describe, expect, it } from 'vitest'
import { detectArmorKind } from './armorDetect'

describe('detectArmorKind', () => {
  it('detects a Fluux backup (PGP MESSAGE)', () => {
    const armored = `-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js\n\nwcDM...\n-----END PGP MESSAGE-----\n`
    expect(detectArmorKind(armored)).toBe('message')
  })

  it('detects a raw private key block (gpg --export-secret-keys)', () => {
    const armored = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOY...\n-----END PGP PRIVATE KEY BLOCK-----\n`
    expect(detectArmorKind(armored)).toBe('private-key')
  })

  it('tolerates leading whitespace and BOM', () => {
    const armored = `\\uFEFF\n   \n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOY...\n-----END PGP PRIVATE KEY BLOCK-----\n`
    expect(detectArmorKind(armored)).toBe('private-key')
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
