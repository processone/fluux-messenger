import { describe, it, expect } from 'vitest'
import { validateBareJid } from './jidValidation'

// Local shape validation for the login JID field (UX_REVIEW §1.4): catch a
// typo'd JID before a network round-trip. Permissive on domain (XMPP allows a
// single-label host like `localhost`), strict on the local@domain skeleton and
// on characters RFC 7622 forbids in the localpart.

describe('validateBareJid', () => {
  it('treats empty / whitespace-only input as empty (not an error to surface)', () => {
    expect(validateBareJid('')).toEqual({ valid: false, reason: 'empty' })
    expect(validateBareJid('   ')).toEqual({ valid: false, reason: 'empty' })
  })

  it('accepts a well-formed bare JID', () => {
    expect(validateBareJid('alice@example.com')).toEqual({ valid: true })
  })

  it('accepts a single-label domain (e.g. localhost)', () => {
    expect(validateBareJid('alice@localhost')).toEqual({ valid: true })
  })

  it('accepts a full JID with a resource', () => {
    expect(validateBareJid('alice@example.com/phone')).toEqual({ valid: true })
  })

  it('trims surrounding whitespace before validating', () => {
    expect(validateBareJid('  alice@example.com  ')).toEqual({ valid: true })
  })

  it('rejects a missing @', () => {
    expect(validateBareJid('alice.example.com')).toEqual({ valid: false, reason: 'malformed' })
  })

  it('rejects an empty localpart', () => {
    expect(validateBareJid('@example.com')).toEqual({ valid: false, reason: 'malformed' })
  })

  it('rejects an empty domain', () => {
    expect(validateBareJid('alice@')).toEqual({ valid: false, reason: 'malformed' })
    expect(validateBareJid('alice@/phone')).toEqual({ valid: false, reason: 'malformed' })
  })

  it('rejects more than one @', () => {
    expect(validateBareJid('a@b@example.com')).toEqual({ valid: false, reason: 'malformed' })
  })

  it('rejects internal whitespace', () => {
    expect(validateBareJid('al ice@example.com')).toEqual({ valid: false, reason: 'malformed' })
  })

  it.each(['"', '&', "'", ':', '<', '>'])(
    'rejects the RFC 7622 forbidden localpart character %s',
    (ch) => {
      expect(validateBareJid(`al${ch}ice@example.com`)).toEqual({ valid: false, reason: 'malformed' })
    }
  )
})
