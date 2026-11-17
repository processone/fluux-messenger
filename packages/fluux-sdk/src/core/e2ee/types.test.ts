import { describe, it, expect, expectTypeOf } from 'vitest'
import type { PeerIdentity, TrustState, E2EEPlugin } from './types'
import { DummyPlaintextPlugin } from './DummyPlaintextPlugin'

describe('PeerIdentity', () => {
  it('is importable from ./types and shaped as { id, fingerprint, trust }', () => {
    const identity: PeerIdentity = {
      id: '12345',
      fingerprint: 'ABCD1234',
      trust: 'tofu',
    }

    expect(identity.id).toBe('12345')
    expect(identity.fingerprint).toBe('ABCD1234')
    expect(identity.trust).toBe('tofu')

    expectTypeOf(identity.id).toBeString()
    expectTypeOf(identity.fingerprint).toBeString()
    expectTypeOf(identity.trust).toEqualTypeOf<TrustState>()
  })

  it('accepts every TrustState value', () => {
    const states: TrustState[] = ['verified', 'introduced', 'tofu', 'untrusted', 'unknown']
    for (const trust of states) {
      const identity: PeerIdentity = { id: 'x', fingerprint: '', trust }
      expect(identity.trust).toBe(trust)
    }
  })
})

describe('E2EEPlugin — listPeerIdentities / setIdentityTrust are optional', () => {
  it('a plugin that omits both methods still satisfies E2EEPlugin', () => {
    // Compile-time assertion: DummyPlaintextPlugin implements E2EEPlugin without
    // defining the two new optional trait methods. If they were required,
    // this file would fail to typecheck.
    const plugin: E2EEPlugin = new DummyPlaintextPlugin()

    expect(plugin.listPeerIdentities).toBeUndefined()
    expect(plugin.setIdentityTrust).toBeUndefined()
  })
})
