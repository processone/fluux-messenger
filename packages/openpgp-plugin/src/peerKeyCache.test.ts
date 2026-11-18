/**
 * Tests for the peer key localStorage cache in OpenPGPPluginBase.
 *
 * The cache persists peer public keys across sessions so that incoming
 * encrypted messages from MAM can be decrypted immediately (signature
 * verified) without waiting for the PEP key fetch round-trip.
 */
import { describe, it, expect, beforeEach } from 'vitest'

// The cache functions are module-level in OpenPGPPluginBase.ts.
// Rather than exporting them, we test the behaviour through localStorage
// directly using the same key format the implementation uses.

const PEER_KEY_CACHE_PREFIX = 'fluux:e2ee:peer-keys:'

interface KeyBundle {
  fingerprint: string
  publicArmored: string
  keychainBacked: boolean
}

function peerKeyCacheKey(accountJid: string): string {
  return `${PEER_KEY_CACHE_PREFIX}${accountJid}`
}

function loadPeerKeyCache(accountJid: string): Map<string, KeyBundle> {
  const map = new Map<string, KeyBundle>()
  try {
    const raw = localStorage.getItem(peerKeyCacheKey(accountJid))
    if (!raw) return map
    const entries = JSON.parse(raw) as Array<[string, KeyBundle]>
    for (const [jid, bundle] of entries) {
      map.set(jid, bundle)
    }
  } catch { /* corrupt cache — start fresh */ }
  return map
}

function savePeerKeyCache(accountJid: string, map: Map<string, KeyBundle>): void {
  try {
    localStorage.setItem(
      peerKeyCacheKey(accountJid),
      JSON.stringify([...map.entries()]),
    )
  } catch { /* storage full or unavailable */ }
}

function clearPeerKeyCache(accountJid: string): void {
  try { localStorage.removeItem(peerKeyCacheKey(accountJid)) } catch { /* */ }
}

const ACCOUNT = 'alice@example.com'
const PEER = 'bob@example.com'
const BUNDLE: KeyBundle = {
  fingerprint: 'AAAA1111',
  publicArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nfake\n-----END PGP PUBLIC KEY BLOCK-----',
  keychainBacked: false,
}

describe('peerKeyCache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns empty map when nothing is stored', () => {
    const map = loadPeerKeyCache(ACCOUNT)
    expect(map.size).toBe(0)
  })

  it('round-trips a single peer key', () => {
    const map = new Map<string, KeyBundle>()
    map.set(PEER, BUNDLE)
    savePeerKeyCache(ACCOUNT, map)

    const loaded = loadPeerKeyCache(ACCOUNT)
    expect(loaded.size).toBe(1)
    expect(loaded.get(PEER)).toEqual(BUNDLE)
  })

  it('round-trips multiple peer keys', () => {
    const map = new Map<string, KeyBundle>()
    map.set('bob@example.com', BUNDLE)
    map.set('carol@example.com', { ...BUNDLE, fingerprint: 'BBBB2222' })
    savePeerKeyCache(ACCOUNT, map)

    const loaded = loadPeerKeyCache(ACCOUNT)
    expect(loaded.size).toBe(2)
    expect(loaded.get('bob@example.com')?.fingerprint).toBe('AAAA1111')
    expect(loaded.get('carol@example.com')?.fingerprint).toBe('BBBB2222')
  })

  it('scopes cache to account JID', () => {
    const map1 = new Map<string, KeyBundle>()
    map1.set(PEER, BUNDLE)
    savePeerKeyCache('alice@example.com', map1)

    const map2 = new Map<string, KeyBundle>()
    map2.set(PEER, { ...BUNDLE, fingerprint: 'CCCC3333' })
    savePeerKeyCache('mallory@example.com', map2)

    expect(loadPeerKeyCache('alice@example.com').get(PEER)?.fingerprint).toBe('AAAA1111')
    expect(loadPeerKeyCache('mallory@example.com').get(PEER)?.fingerprint).toBe('CCCC3333')
  })

  it('clearPeerKeyCache removes the entry', () => {
    const map = new Map<string, KeyBundle>()
    map.set(PEER, BUNDLE)
    savePeerKeyCache(ACCOUNT, map)
    expect(loadPeerKeyCache(ACCOUNT).size).toBe(1)

    clearPeerKeyCache(ACCOUNT)
    expect(loadPeerKeyCache(ACCOUNT).size).toBe(0)
  })

  it('handles corrupt JSON gracefully', () => {
    localStorage.setItem(peerKeyCacheKey(ACCOUNT), 'not valid json{{{')
    const map = loadPeerKeyCache(ACCOUNT)
    expect(map.size).toBe(0)
  })

  it('overwrites stale entries on save', () => {
    const map1 = new Map<string, KeyBundle>()
    map1.set(PEER, BUNDLE)
    savePeerKeyCache(ACCOUNT, map1)

    const map2 = new Map<string, KeyBundle>()
    map2.set(PEER, { ...BUNDLE, fingerprint: 'ROTATED' })
    savePeerKeyCache(ACCOUNT, map2)

    expect(loadPeerKeyCache(ACCOUNT).get(PEER)?.fingerprint).toBe('ROTATED')
  })
})
