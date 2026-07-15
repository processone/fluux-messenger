import { describe, it, expect, beforeEach } from 'vitest'
import { useProtocolSwitchStore } from './protocolSwitchStore'

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
})
