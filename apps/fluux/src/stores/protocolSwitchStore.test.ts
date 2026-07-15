import { describe, it, expect, beforeEach } from 'vitest'
import { useProtocolSwitchStore, load } from './protocolSwitchStore'
import { buildScopedStorageKey } from '@fluux/sdk'

const KEY = buildScopedStorageKey('fluux-e2ee-protocol-switch')

describe('protocolSwitchStore', () => {
  beforeEach(() => { localStorage.clear(); useProtocolSwitchStore.getState().reset() })
  it('flags a one-time openpgp->omemo:2 switch and clears on dismiss', () => {
    const s = () => useProtocolSwitchStore.getState()
    expect(s().recordSelected('bob@x', 'openpgp').switchedFromOpenpgp).toBe(false) // first sight, no prior
    expect(s().recordSelected('bob@x', 'omemo:2').switchedFromOpenpgp).toBe(true)  // openpgp -> omemo:2
    expect(s().pendingNotice('bob@x')).toBe(true)
    // re-recording the same protocol does not re-raise
    expect(s().recordSelected('bob@x', 'omemo:2').switchedFromOpenpgp).toBe(false)
    s().dismiss('bob@x')
    expect(s().pendingNotice('bob@x')).toBe(false)
  })
  it('a peer that starts on omemo:2 never raises a switch notice', () => {
    const s = () => useProtocolSwitchStore.getState()
    expect(s().recordSelected('carol@x', 'omemo:2').switchedFromOpenpgp).toBe(false)
    expect(s().pendingNotice('carol@x')).toBe(false)
  })

  describe('load() shape guard', () => {
    it.each([
      ['empty object', '{}'],
      ['invalid json', 'not json'],
      ['missing pending key', '{"last":{}}'],
    ])('tolerates a malformed persisted value (%s) and falls back to empty state', (_label, raw) => {
      localStorage.setItem(KEY, raw)
      expect(() => load()).not.toThrow()
      expect(load()).toEqual({ last: {}, pending: {} })
    })

    it('does not crash the store getters when localStorage holds a malformed value', () => {
      localStorage.setItem(KEY, '{}')
      // Re-run the same shape-guard the store applies at construction time.
      const state = load()
      expect(state.last).toEqual({})
      expect(state.pending).toEqual({})
      // Public API stays usable even though the persisted shape was wrong.
      const s = () => useProtocolSwitchStore.getState()
      expect(() => s().pendingNotice('anyone@x')).not.toThrow()
      expect(s().pendingNotice('anyone@x')).toBe(false)
      expect(() => s().recordSelected('anyone@x', 'omemo:2')).not.toThrow()
    })
  })
})
