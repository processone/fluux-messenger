import { describe, it, expect } from 'vitest'
import {
  CLIENT_FEATURES,
  calculateVerificationString,
  calculateCapsHash,
  getClientFeatures,
  getClientIdentity,
  getCapsNode,
} from './caps'
import { NS_MDS_NOTIFY, NS_CONVERSATIONS_NOTIFY, NS_OPENPGP_IM } from './namespaces'

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

    it('should include Fluux verifications cross-device sync +notify', () => {
      // Without this, the server will not push PEP headlines when another
      // device of the same account publishes an updated verification list.
      expect(CLIENT_FEATURES).toContain('urn:xmpp:fluux:verifications:0+notify')
    })

    it('includes the MDS +notify feature so the server pushes read-position updates', () => {
      expect(CLIENT_FEATURES).toContain(NS_MDS_NOTIFY)
      // feature appears in the (sorted) XEP-0115 verification string
      expect(calculateVerificationString()).toContain(`${NS_MDS_NOTIFY}<`)
    })

    it('includes the Fluux conversation-list +notify so the server pushes archive/unarchive changes', () => {
      // Without this, ejabberd will not push PEP headlines when another
      // device of the same account archives/unarchives a conversation —
      // the change would only surface on the next fresh-session fetch.
      expect(CLIENT_FEATURES).toContain(NS_CONVERSATIONS_NOTIFY)
      expect(calculateVerificationString()).toContain(`${NS_CONVERSATIONS_NOTIFY}<`)
    })

    it('does not include the XEP-0374 OX-IM feature unconditionally', () => {
      // XEP-0374 §2.1: the feature announces that OpenPGP messaging works.
      // It comes from a registered E2EE plugin, not from the static list.
      expect(CLIENT_FEATURES).not.toContain(NS_OPENPGP_IM)
    })
  })

  describe('getClientFeatures', () => {
    it('returns the static features, sorted, when nothing extra is advertised', () => {
      expect(getClientFeatures()).toEqual([...CLIENT_FEATURES].sort())
    })

    it('adds extra features once each, keeping the list sorted', () => {
      const features = getClientFeatures([NS_OPENPGP_IM, NS_OPENPGP_IM, NS_MDS_NOTIFY])
      expect(features.filter((f) => f === NS_OPENPGP_IM)).toHaveLength(1)
      expect(features.filter((f) => f === NS_MDS_NOTIFY)).toHaveLength(1)
      expect(features).toEqual([...features].sort())
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

    it('changes when an extra feature is advertised', async () => {
      const base = await calculateCapsHash()
      const withOx = await calculateCapsHash([NS_OPENPGP_IM])
      expect(withOx).not.toBe(base)
      expect(calculateVerificationString([NS_OPENPGP_IM])).toContain(`${NS_OPENPGP_IM}<`)
    })

    it('should be deterministic (same input = same output)', async () => {
      const hash1 = await calculateCapsHash()
      const hash2 = await calculateCapsHash()

      expect(hash1).toBe(hash2)
    })
  })
})
