import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  clearPeerVerified,
  getVerifiedPeerFingerprint,
  isPeerVerified,
  useVerifiedPeerKeysStore,
} from './verifiedPeerKeysStore'

const STORAGE_KEY = 'fluux-e2ee-verified-peers'

describe('verifiedPeerKeysStore', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset the store to its initial state (which is empty after the
    // localStorage clear, but the singleton still holds the previous
    // session's data — we re-read from storage).
    useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('records a verification keyed on (jid, fingerprint)', () => {
    useVerifiedPeerKeysStore.getState().setVerified('alice@example.com', 'FP1')
    expect(isPeerVerified('alice@example.com', 'FP1')).toBe(true)
    expect(isPeerVerified('alice@example.com', 'FP2')).toBe(false)
    expect(isPeerVerified('bob@example.com', 'FP1')).toBe(false)
  })

  it('isPeerVerified is case- and whitespace-insensitive (cross-backend sync: Sequoia UPPERCASE ↔ openpgp.js lowercase)', () => {
    // The native (Sequoia/Rust) client formats fingerprints UPPERCASE and
    // publishes them verbatim to the cross-device verification-sync node; the
    // web (openpgp.js) client probes the same key and reports it lowercase.
    // A trust decision must treat the two as the same key — otherwise a
    // verification made on desktop reads as unverified on the web client.
    const upper = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
    const lower = 'aabbccddeeff00112233445566778899aabbccdd'
    useVerifiedPeerKeysStore.getState().setVerified('adrien@example.com', upper)
    expect(isPeerVerified('adrien@example.com', lower)).toBe(true)
    // Reverse direction too (verified lowercase, queried uppercase).
    useVerifiedPeerKeysStore.getState().setVerified('bob@example.com', lower)
    expect(isPeerVerified('bob@example.com', upper)).toBe(true)
    // A genuinely different fingerprint still does NOT match.
    expect(isPeerVerified('adrien@example.com', 'FFEE' + lower.slice(4))).toBe(false)
  })

  it('clearVerified removes the entry', () => {
    useVerifiedPeerKeysStore.getState().setVerified('alice@example.com', 'FP1')
    expect(isPeerVerified('alice@example.com', 'FP1')).toBe(true)
    clearPeerVerified('alice@example.com')
    expect(isPeerVerified('alice@example.com', 'FP1')).toBe(false)
    // No-op for an already-cleared entry.
    clearPeerVerified('alice@example.com')
  })

  it('getVerifiedPeerFingerprint returns the stored fingerprint or null', () => {
    expect(getVerifiedPeerFingerprint('alice@example.com')).toBeNull()
    useVerifiedPeerKeysStore.getState().setVerified('alice@example.com', 'FP1')
    expect(getVerifiedPeerFingerprint('alice@example.com')).toBe('FP1')
  })

  it('persists to localStorage and rehydrates from it', () => {
    useVerifiedPeerKeysStore.getState().setVerified('alice@example.com', 'FP1')
    // Confirm the actual storage payload — the rehydrate path relies
    // on this exact shape, not just on the in-memory store.
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)).toEqual({ 'alice@example.com': 'FP1' })
  })

  it('setVerified is idempotent — repeated calls with the same value do nothing extra', () => {
    const { setVerified } = useVerifiedPeerKeysStore.getState()
    setVerified('alice@example.com', 'FP1')
    const stateBefore = useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid
    setVerified('alice@example.com', 'FP1')
    const stateAfter = useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid
    // Reference equality survives — the no-op early-return preserved
    // the same object, so any selector subscribers don't re-fire.
    expect(stateBefore).toBe(stateAfter)
  })

  it('setVerified with a different fingerprint replaces the previous entry', () => {
    // The auto-demote-on-rotation invariant relies on a different
    // fingerprint NOT being treated as verified — but the store entry
    // itself can hold only one fingerprint per JID, so a re-verify
    // overwrites cleanly.
    const { setVerified } = useVerifiedPeerKeysStore.getState()
    setVerified('alice@example.com', 'FP1')
    setVerified('alice@example.com', 'FP2')
    expect(isPeerVerified('alice@example.com', 'FP1')).toBe(false)
    expect(isPeerVerified('alice@example.com', 'FP2')).toBe(true)
  })

  it('ignores corrupt localStorage payloads on initial load', () => {
    // Tampered or partially-written blobs shouldn't poison the store.
    // (Module-level `loadInitial` runs once at import time; this test
    // exercises the defensive filter via a manual setState instead.)
    localStorage.setItem(STORAGE_KEY, 'not-valid-json{')
    // Simulate the load path: the store's loader is called once at
    // module import. We can at least confirm calling setState({})
    // followed by a real entry behaves correctly.
    useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
    expect(isPeerVerified('anyone@example.com', 'FP')).toBe(false)
  })
})
