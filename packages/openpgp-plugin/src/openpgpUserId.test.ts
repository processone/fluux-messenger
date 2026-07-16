import { describe, it, expect } from 'vitest'
import { accountUserId } from './openpgpUserId'

describe('accountUserId', () => {
  it('builds the bare XEP-0373 §8.5 trust-anchor UID', () => {
    expect(accountUserId('alice@example.org')).toBe('xmpp:alice@example.org')
  })

  it('adds no real-name component (the XMPP address is the only trust anchor)', () => {
    // Must stay free of `<…>` / `(…)` so both Sequoia and openpgp.js emit the
    // exact same User ID packet and verification matches across platforms.
    expect(accountUserId('bob@example.com')).not.toMatch(/[<>()]/)
  })

  it('matches the format peer-key verification expects', () => {
    const peer = 'carol@example.net'
    expect(accountUserId(peer)).toBe(`xmpp:${peer}`)
  })
})
