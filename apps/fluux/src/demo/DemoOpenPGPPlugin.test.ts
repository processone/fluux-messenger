import { describe, it, expect, beforeEach } from 'vitest'
import { DemoOpenPGPPlugin, DEMO_AVA_FINGERPRINT } from './DemoOpenPGPPlugin'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'

/**
 * Regression coverage for Finding 2 of the Phase B1 final review:
 * `DemoOpenPGPPlugin` implements `E2EEPlugin` standalone (it does NOT
 * extend `OpenPGPPluginBase`), so before this fix it had no
 * `setIdentityTrust` at all. `ChatView`'s verify/revoke handlers hit the
 * "plugin unavailable" branch on every demo verify and fired a red error
 * toast where the user used to get a success toast and a flipped chip —
 * user-visibly broken on `demo.fluux.io` (tracks `main`) and in the
 * screenshot/promo-reel scripts.
 */
describe('DemoOpenPGPPlugin.setIdentityTrust', () => {
  beforeEach(() => {
    useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  })

  it("'verified' writes the peer's current fingerprint into the same store demo.tsx seeds and the chip reads from", async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'verified')
    expect(useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid['ava@fluux.chat']).toBe(
      DEMO_AVA_FINGERPRINT,
    )
  })

  it("'untrusted' clears a previously verified entry", async () => {
    const plugin = new DemoOpenPGPPlugin()
    useVerifiedPeerKeysStore.getState().setVerified('ava@fluux.chat', DEMO_AVA_FINGERPRINT)
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'untrusted')
    expect(
      useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid['ava@fluux.chat'],
    ).toBeUndefined()
  })

  it('no-ops when the peer has no known fingerprint', async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('nobody@fluux.chat', '', 'verified')
    expect(
      useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid['nobody@fluux.chat'],
    ).toBeUndefined()
  })

  it('no-ops when a non-empty id no longer matches the current fingerprint (stale identity reference)', async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('ava@fluux.chat', 'STALE-FINGERPRINT', 'verified')
    expect(
      useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid['ava@fluux.chat'],
    ).toBeUndefined()
  })

  it('accepts an empty id and acts on the current fingerprint (id optional)', async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('ava@fluux.chat', '', 'verified')
    expect(useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid['ava@fluux.chat']).toBe(
      DEMO_AVA_FINGERPRINT,
    )
  })
})
