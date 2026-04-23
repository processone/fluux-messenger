import { describe, it, expect } from 'vitest'
import {
  CLIENT_FEATURES,
  calculateVerificationString,
  calculateCapsHash,
  getClientIdentity,
  getCapsNode,
} from './caps'

describe('caps (XEP-0115)', () => {
  describe('CLIENT_FEATURES', () => {
    it('should include XEP-0444 Message Reactions', () => {
      expect(CLIENT_FEATURES).toContain('urn:xmpp:reactions:0')
    })

    it('should include XEP-0085 Chat States', () => {
      expect(CLIENT_FEATURES).toContain('http://jabber.org/protocol/chatstates')
    })

    it('should include XEP-0030 Service Discovery', () => {
      expect(CLIENT_FEATURES).toContain('http://jabber.org/protocol/disco#info')
    })

    it('should include XEP-0084 PEP Avatar notifications', () => {
      expect(CLIENT_FEATURES).toContain('urn:xmpp:avatar:metadata+notify')
    })

    it('should include XEP-0280 Message Carbons', () => {
      expect(CLIENT_FEATURES).toContain('urn:xmpp:carbons:2')
    })

    it('should include XEP-0393 Message Styling', () => {
      expect(CLIENT_FEATURES).toContain('urn:xmpp:styling:0')
    })

    it('should include XEP-0461 Message Replies', () => {
      expect(CLIENT_FEATURES).toContain('urn:xmpp:reply:0')
    })

    it('should include XEP-0153 vCard avatar updates', () => {
      expect(CLIENT_FEATURES).toContain('vcard-temp:x:update')
    })

    it('should include XEP-0373 OpenPGP public-keys +notify', () => {
      // Without this, ejabberd will not push PEP headlines when a peer
      // publishes or rotates their OX key — the client would keep a
      // stale negative cache and silently fall back to plaintext.
      expect(CLIENT_FEATURES).toContain('urn:xmpp:openpgp:0:public-keys+notify')
    })
  })

  describe('getClientIdentity', () => {
    it('should return web identity in test environment', () => {
      const identity = getClientIdentity()
      // No Tauri in tests, so defaults to web
      expect(identity.category).toBe('client')
      expect(identity.type).toBe('web')
      expect(identity.name).toBe('Fluux Web')
    })
  })

  describe('getCapsNode', () => {
    it('should return web caps node in test environment', () => {
      // No Tauri in tests, so defaults to web
      expect(getCapsNode()).toBe('https://fluux.io/web')
    })
  })

  describe('calculateVerificationString', () => {
    it('should start with identity string', () => {
      const verString = calculateVerificationString()
      // In test environment (no Tauri), platform is 'web' -> 'Fluux Web'
      expect(verString).toMatch(/^client\/web\/\/Fluux Web</)
    })

    it('should include all features with < separator', () => {
      const verString = calculateVerificationString()
      // Each feature should end with <
      expect(verString).toContain('urn:xmpp:reactions:0<')
      expect(verString).toContain('urn:xmpp:carbons:2<')
    })

    it('should have features sorted alphabetically', () => {
      const verString = calculateVerificationString()
      // Extract features from the string (after identity)
      // In test environment, identity is 'Fluux Web'
      const afterIdentity = verString.split('Fluux Web<')[1]
      const features = afterIdentity.split('<').filter(Boolean)

      const sortedFeatures = [...features].sort()
      expect(features).toEqual(sortedFeatures)
    })
  })

  describe('calculateCapsHash', () => {
    it('should return a base64-encoded SHA-1 hash', async () => {
      const hash = await calculateCapsHash()

      // Base64 string validation
      expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/)

      // SHA-1 produces 20 bytes = 28 base64 chars (with padding)
      expect(hash.length).toBe(28)
    })

    it('should be deterministic (same input = same output)', async () => {
      const hash1 = await calculateCapsHash()
      const hash2 = await calculateCapsHash()

      expect(hash1).toBe(hash2)
    })
  })
})
