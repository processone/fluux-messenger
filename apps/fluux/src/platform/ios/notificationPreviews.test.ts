import { describe, expect, it } from 'vitest'
import { createPreviewController, type PreviewState } from './notificationPreviews'
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
