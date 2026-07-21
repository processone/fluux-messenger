import { describe, it, expect } from 'vitest'
import { DemoOpenPGPPlugin, DEMO_AVA_FINGERPRINT } from './DemoOpenPGPPlugin'

/**
 * Regression coverage for Finding 2 of the Phase B1 final review:
 * `DemoOpenPGPPlugin` implements `E2EEPlugin` standalone (it does NOT
 * extend `OpenPGPPluginBase`), so before that fix it had no
 * `setIdentityTrust` at all. `ChatView`'s verify/revoke handlers hit the
 * "plugin unavailable" branch on every demo verify and fired a red error
 * toast where the user used to get a success toast and a flipped chip —
 * user-visibly broken on `demo.fluux.io` (tracks `main`) and in the
 * screenshot/promo-reel scripts.
 *
 * Phase B2 Task 6: `useVerifiedPeerKeysStore` is being deleted (Task 8), so
 * `setIdentityTrust` now writes the plugin's OWN in-memory holder instead —
 * exposed read-only via `getVerifiedKeysView()`, satisfying the same
 * `VerifiedKeysView` contract the real OpenPGP plugins expose via
 * `OpenPGPPluginBase.getVerifiedKeysView()`.
 */
describe('DemoOpenPGPPlugin verified-key holder', () => {
  it("'verified' writes the peer's current fingerprint and the view reports it verified", async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'verified')
    const view = plugin.getVerifiedKeysView()
    expect(view.isVerified('ava@fluux.chat', DEMO_AVA_FINGERPRINT)).toBe(true)
    expect(view.getVerifiedFingerprint('ava@fluux.chat')).toBe(DEMO_AVA_FINGERPRINT)
  })

  it("isVerified compares case/whitespace-insensitively, like the real plugin's fingerprintsEqual", async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'verified')
    const view = plugin.getVerifiedKeysView()
    const scrambled = DEMO_AVA_FINGERPRINT.toLowerCase().replace(/(.{4})/g, '$1 ').trim()
    expect(view.isVerified('ava@fluux.chat', scrambled)).toBe(true)
  })

  it("'untrusted' clears a previously verified entry", async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'verified')
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'untrusted')
    const view = plugin.getVerifiedKeysView()
    expect(view.isVerified('ava@fluux.chat', DEMO_AVA_FINGERPRINT)).toBe(false)
    expect(view.getVerifiedFingerprint('ava@fluux.chat')).toBeNull()
  })

  it('no-ops when the peer has no known fingerprint', async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('nobody@fluux.chat', '', 'verified')
    expect(plugin.getVerifiedKeysView().getVerifiedFingerprint('nobody@fluux.chat')).toBeNull()
  })

  it('no-ops when a non-empty id no longer matches the current fingerprint (stale identity reference)', async () => {
    const plugin = new DemoOpenPGPPlugin()
    // Start from an explicit untrusted baseline (rather than relying on the
    // construction-time Ava seed) so this asserts the no-op leaves state
    // unchanged, not merely "still whatever the seed left it at".
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'untrusted')
    await plugin.setIdentityTrust('ava@fluux.chat', 'STALE-FINGERPRINT', 'verified')
    expect(plugin.getVerifiedKeysView().getVerifiedFingerprint('ava@fluux.chat')).toBeNull()
  })

  it('accepts an empty id and acts on the current fingerprint (id optional)', async () => {
    const plugin = new DemoOpenPGPPlugin()
    await plugin.setIdentityTrust('ava@fluux.chat', '', 'verified')
    expect(plugin.getVerifiedKeysView().getVerifiedFingerprint('ava@fluux.chat')).toBe(DEMO_AVA_FINGERPRINT)
  })

  it('subscribers are notified on verify and on revoke', async () => {
    const plugin = new DemoOpenPGPPlugin()
    const view = plugin.getVerifiedKeysView()
    let notifications = 0
    const unsubscribe = view.subscribe(() => {
      notifications++
    })
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'verified')
    expect(notifications).toBe(1)
    await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'untrusted')
    expect(notifications).toBe(2)
    unsubscribe()
  })

  it('seeds ava@fluux.chat as verified at construction (boot seed, matching the old demo.tsx-side seed)', () => {
    const plugin = new DemoOpenPGPPlugin()
    const view = plugin.getVerifiedKeysView()
    expect(view.isVerified('ava@fluux.chat', DEMO_AVA_FINGERPRINT)).toBe(true)
  })

  describe('getSnapshot()', () => {
    it('is referentially stable across calls with no mutation in between', () => {
      const plugin = new DemoOpenPGPPlugin()
      const view = plugin.getVerifiedKeysView()
      expect(view.getSnapshot()).toBe(view.getSnapshot())
    })

    it('changes identity after a mutation', async () => {
      const plugin = new DemoOpenPGPPlugin()
      const view = plugin.getVerifiedKeysView()
      const before = view.getSnapshot()
      await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'untrusted')
      const after = view.getSnapshot()
      expect(after).not.toBe(before)
    })

    it('reflects the current verified map contents', async () => {
      const plugin = new DemoOpenPGPPlugin()
      const view = plugin.getVerifiedKeysView()
      expect(view.getSnapshot()).toEqual({ 'ava@fluux.chat': DEMO_AVA_FINGERPRINT })
      await plugin.setIdentityTrust('ava@fluux.chat', DEMO_AVA_FINGERPRINT, 'untrusted')
      expect(view.getSnapshot()).toEqual({})
    })
  })
})
