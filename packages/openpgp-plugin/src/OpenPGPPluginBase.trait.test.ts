import { describe, it, expect } from 'vitest'
import { makeTestBase, seedPeerKey } from './testSupport/baseHarness'

describe('OpenPGPPluginBase — per-identity trait', () => {
  it('listPeerIdentities returns [] when no key is cached', async () => {
    const { base } = makeTestBase()
    expect(await base.listPeerIdentities('bob@x')).toEqual([])
  })

  it('listPeerIdentities returns a length-1 identity (id === fingerprint) with tofu trust for a cached-but-unverified key', async () => {
    const { base, verified } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    verified.isVerified = () => false
    const list = await base.listPeerIdentities('bob@x')
    expect(list).toEqual([{ id: 'ABCD1234', fingerprint: 'ABCD1234', trust: 'tofu' }])
  })

  it('listPeerIdentities reports verified trust when the marker matches the cached fingerprint', async () => {
    const { base, verified } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    verified.isVerified = (jid, fp) => jid === 'bob@x' && fp === 'ABCD1234'
    const list = await base.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('verified')
  })

  it("setIdentityTrust('verified') pins the marker to the current fingerprint", async () => {
    const { base, calls } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')
    expect(calls.setVerified).toEqual([['bob@x', 'ABCD1234']])
  })

  it("setIdentityTrust('untrusted') clears the marker (revoke → TOFU)", async () => {
    const { base, calls } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await base.setIdentityTrust('bob@x', 'ABCD1234', 'untrusted')
    expect(calls.clearVerified).toEqual([['bob@x']])
    expect(calls.setVerified).toEqual([])
  })

  it('setIdentityTrust no-ops when the peer has no cached key', async () => {
    const { base, calls } = makeTestBase()
    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')
    expect(calls.setVerified).toEqual([])
    expect(calls.clearVerified).toEqual([])
  })

  it('setIdentityTrust no-ops when a non-empty id no longer matches the current fingerprint (TOCTOU guard)', async () => {
    const { base, calls } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'NEWFP9999')
    await base.setIdentityTrust('bob@x', 'STALEFP0000', 'verified')
    expect(calls.setVerified).toEqual([])
  })

  it('setIdentityTrust with an empty id acts on the current fingerprint (id optional)', async () => {
    const { base, calls } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await base.setIdentityTrust('bob@x', '', 'verified')
    expect(calls.setVerified).toEqual([['bob@x', 'ABCD1234']])
  })
})
