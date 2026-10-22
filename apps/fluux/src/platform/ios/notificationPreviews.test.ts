import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPreviewController, ensureExtensionCredential, setIOSNotificationPreviews,
  type CredentialDependencies, type PreviewState,
} from './notificationPreviews'
import { useIOSPreviewSettingsStore } from './previewSettings'
function setup() {
  let state: PreviewState = { account: 'bob@nse.invalid', enabled: false, ready: true, peers: {} }
  let shared: Record<string, unknown> | null = { account: 'old@nse.invalid' }
  let purges = 0
  let prepared = 0
  let resolve: (() => void) | undefined
  let delay = false
  const controller = createPreviewController({
    state: () => state,
    prepare: async (account) => {
      prepared++
      if (delay) await new Promise<void>(done => { resolve = done })
      return { account, secret_b64: 'synthetic-only', password: 'synthetic-only' }
    },
    write: async (snapshot, purge) => { shared = snapshot; if (purge) purges++ },
  })
  return {
    controller, update: (next: Partial<PreviewState>) => { state = { ...state, ...next } },
    shared: () => shared, purges: () => purges, prepared: () => prepared,
    delay: () => { delay = true }, resolve: () => resolve?.(),
  }
}
describe('iOS notification capability lifetime', () => {
  it('cold startup revokes without purging history before the account is known', async () => {
    let state: PreviewState = { account: null, enabled: false, ready: false, peers: {} }
    const writes: boolean[] = []
    const controller = createPreviewController({ state: () => state, prepare: async () => ({}),
      write: async (_snapshot, purge) => { writes.push(purge ?? false) } })
    await controller.refresh()
    state = { ...state, account: 'bob@nse.invalid', enabled: true, ready: true }
    await controller.refresh()
    expect(writes).toEqual([false, false, false])
    state = { ...state, account: null, enabled: false }
    await controller.refresh()
    expect(writes).toEqual([false, false, false, false])
    await controller.stop(true)
    expect(writes.at(-1)).toBe(true)
  })
  it('routine refresh and session remount revocation preserve the ID ledger', async () => {
    const lab = setup()
    lab.update({ enabled: true })
    await lab.controller.refresh()
    await lab.controller.refresh()
    await lab.controller.stop()
    expect(lab.purges()).toBe(0)
  })
  it('opt-out, explicit logout and an account change purge the ID ledger', async () => {
    const lab = setup()
    lab.update({ enabled: true })
    await lab.controller.refresh()
    lab.update({ account: 'other@nse.invalid' })
    await lab.controller.refresh()
    expect(lab.purges()).toBe(1)
    lab.update({ enabled: false })
    await lab.controller.refresh()
    expect(lab.purges()).toBe(2)
    await lab.controller.stop(true)
    expect(lab.purges()).toBe(3)
  })
  it('off by default purges an existing capability without reading secrets', async () => {
    const lab = setup()
    await lab.controller.refresh()
    expect(lab.shared()).toBeNull()
    expect(lab.prepared()).toBe(0)
  })
  it('opt-in provisions the current account and public verifier snapshot', async () => {
    const lab = setup()
    const peers = { 'alice@nse.invalid': [{ fingerprint: 'synthetic-fp', publicArmored: 'synthetic-public' }] }
    lab.update({ enabled: true, peers })
    await lab.controller.refresh()
    expect(lab.shared()).toMatchObject({ account: 'bob@nse.invalid', opt_in: true, peers })
    lab.update({ enabled: false })
    await lab.controller.refresh()
    expect(lab.shared()).toBeNull()
  })
  it('a logout or account switch invalidates an in-flight provision', async () => {
    const lab = setup()
    lab.update({ enabled: true }); lab.delay()
    const on = lab.controller.refresh()
    await new Promise(done => setTimeout(done, 0))
    lab.update({ account: null })
    const off = lab.controller.refresh()
    lab.resolve()
    await Promise.all([on, off])
    expect(lab.shared()).toBeNull()
  })
  it('shutdown purges even if a pending secret read later resolves', async () => {
    const lab = setup()
    lab.update({ enabled: true }); lab.delay()
    const pending = lab.controller.refresh()
    await new Promise(done => setTimeout(done, 0))
    const stopped = lab.controller.stop()
    lab.resolve()
    await Promise.all([pending, stopped])
    expect(lab.shared()).toBeNull()
  })
  it('identity unavailable clears the provision without fetching credentials', async () => {
    const lab = setup()
    lab.update({ enabled: true, ready: false })
    await lab.controller.refresh()
    expect(lab.shared()).toBeNull()
    expect(lab.prepared()).toBe(0)
  })
})
describe('notification extension FAST token', () => {
  const UA = '8a1f5c1e-2f7b-4d8e-9b0a-3c4d5e6f7a8b'
  function credentialLab(saved: string | null, present = false) {
    const stored: unknown[] = []
    const deps: CredentialDependencies = {
      saved: async () => saved == null ? null : { password: saved, server: 'xmpp.nse.invalid' },
      tokenStatus: async () => ({ userAgentId: UA, present }),
      provision: vi.fn(async () => ({ token: 'issued', expiry: '2026-11-20T00:00:00Z' })),
      storeToken: async (token) => { stored.push(token) },
    }
    return { deps, stored }
  }
  beforeEach(() => { localStorage.clear(); useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid') })
  it('an extension that holds a token needs no password', async () => {
    const lab = credentialLab(null, true)
    await expect(ensureExtensionCredential('bob@nse.invalid', lab.deps)).resolves.toEqual({ password: '', server: 'nse.invalid' })
    expect(lab.deps.provision).not.toHaveBeenCalled()
    expect(useIOSPreviewSettingsStore.getState().missingCredential).toBe(false)
  })
  it('the saved password issues a token for the extension user agent', async () => {
    const lab = credentialLab('synthetic-only')
    await expect(ensureExtensionCredential('bob@nse.invalid', lab.deps)).resolves.toEqual({ password: 'synthetic-only', server: 'xmpp.nse.invalid' })
    expect(lab.deps.provision).toHaveBeenCalledWith({ account: 'bob@nse.invalid', server: 'xmpp.nse.invalid', password: 'synthetic-only', userAgentId: UA })
    expect(lab.stored).toEqual([{ account: 'bob@nse.invalid', userAgentId: UA, token: 'issued', expiry: '2026-11-20T00:00:00Z' }])
  })
  it('without a token or a password it asks for the password', async () => {
    const lab = credentialLab(null)
    await expect(ensureExtensionCredential('bob@nse.invalid', lab.deps)).rejects.toMatchObject({ problem: 'credential' })
    expect(lab.deps.provision).not.toHaveBeenCalled()
    expect(useIOSPreviewSettingsStore.getState().missingCredential).toBe(true)
  })
  it('a refused saved password is not retried until one is typed', async () => {
    const lab = credentialLab('stale')
    vi.mocked(lab.deps.provision).mockRejectedValueOnce('credential-refused')
    await expect(ensureExtensionCredential('bob@nse.invalid', lab.deps)).rejects.toBe('credential-refused')
    await expect(ensureExtensionCredential('bob@nse.invalid', lab.deps)).rejects.toMatchObject({ problem: 'credential' })
    expect(lab.deps.provision).toHaveBeenCalledTimes(1)
    await setIOSNotificationPreviews(true, 'typed')
    await expect(ensureExtensionCredential('bob@nse.invalid', lab.deps)).resolves.toMatchObject({ password: 'typed' })
    expect(lab.deps.provision).toHaveBeenLastCalledWith(expect.objectContaining({ password: 'typed' }))
    expect(useIOSPreviewSettingsStore.getState().missingCredential).toBe(false)
  })
})
