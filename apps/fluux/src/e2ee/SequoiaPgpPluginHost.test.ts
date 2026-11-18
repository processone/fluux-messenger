/**
 * The desktop plugin from @fluux/openpgp-plugin on the app's own host: the real
 * zustand stores (through createAppHostStores) and the real file adapter
 * (createAppFileIO) over in-memory Tauri dialog and filesystem plugins. The
 * package's suite runs the same journeys on an in-memory host; these two cases
 * keep the app's side of that seam covered: a key file saved and read through
 * the app adapter, and trust-state recovery against state that lives in the
 * stores, not in the plugin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginContext } from '@fluux/sdk'
import { SequoiaPgpPlugin } from '@fluux/openpgp-plugin'
import {
  encodeOpenPgpArmorForXep0373,
  makeContext,
  makeFakeRust,
} from '@fluux/openpgp-plugin/testing/sequoiaTestKit'
import { createAppFileIO } from './appDesktopHost'
import { createAppHostStores } from './appHostStores'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useTrustStateStatusStore } from '@/stores/trustStateStatusStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'

vi.setConfig({ testTimeout: 30_000 })

// In-memory stand-in for the Tauri dialog and filesystem plugins.
const tauriDisk = vi.hoisted(() => ({ files: new Map<string, string>(), picked: null as string | null }))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: async () => '/disk/backup.asc',
  open: async () => tauriDisk.picked,
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: async (path: string, text: string) => { tauriDisk.files.set(path, text) },
  readTextFile: async (path: string) => tauriDisk.files.get(path) ?? '',
}))

const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'

function appPlugin(invoke: ReturnType<typeof makeFakeRust>['invoke']) {
  return new SequoiaPgpPlugin({ stores: createAppHostStores(), macosDesktop: false, fileIO: createAppFileIO(), invoke })
}

beforeEach(() => {
  localStorage.clear()
  tauriDisk.files.clear()
  tauriDisk.picked = null
  useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  useKeyChangeAlertsStore.setState({ alertsByJid: {} })
  usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {}, pinnedAtByJid: {} })
  useTrustStateStatusStore.getState().clear()
})

describe('SequoiaPgpPlugin on the app host', () => {
  it('imports a key exported through the app file adapter and keeps its fingerprint', async () => {
    const fake = makeFakeRust()
    const source = appPlugin(fake.invoke)
    await source.init(makeContext('me@example.com').ctx)
    const originalFingerprint = source.getOwnFingerprint()
    expect(originalFingerprint).not.toBeNull()
    expect(await source.exportKeyToFile('correct horse battery')).toBe(true)
    expect(tauriDisk.files.get('/disk/backup.asc')).toContain('-----BEGIN PGP MESSAGE-----')

    // A second device with no key reads the file back and installs it.
    const device = appPlugin(makeFakeRust().invoke)
    const deviceCtx = makeContext('me@example.com')
    deviceCtx.ctx.xmpp.queryPEP = async () => []
    ;(device as unknown as { ctx: PluginContext }).ctx = deviceCtx.ctx
    tauriDisk.picked = '/disk/backup.asc'
    const armored = await device.pickKeyFile()
    expect(armored).not.toBeNull()
    const result = await device.importKeyFromFile(armored!, 'correct horse battery')
    expect('needsPicker' in result).toBe(false)
    expect((result as { fingerprint: string }).fingerprint).toBe(originalFingerprint)
    expect(device.getOwnFingerprint()).toBe(originalFingerprint)
  })

  it('re-verifies the trust state after recovery (awaiting-key -> sealed) on the real stores', async () => {
    // The second plugin finds the first one's seal and pins in the stores, so
    // this case needs state that outlives a plugin instance.
    const fake = makeFakeRust()
    const plugin = appPlugin(fake.invoke)
    await plugin.init(makeContext('me@example.com').ctx)
    usePinnedPrimaryFingerprintsStore.getState().setPinned('peer@example.com', 'PEERFP000000')
    await (plugin as unknown as { verifyTrustStateOnInit(): Promise<void> }).verifyTrustStateOnInit()
    await plugin.backupSecretKey('shared-pp')
    const backup = await plugin.fetchSecretKeyBackup()
    expect(backup).toBeTruthy()
    expect(useTrustStateStatusStore.getState().status).toBe('sealed')

    const pluginB = appPlugin(fake.invoke)
    const { ctx: ctxB } = makeContext('me@example.com')
    ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
      id: 'current',
      payload: {
        name: 'secretkey',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [encodeOpenPgpArmorForXep0373(backup!)],
      },
    })
    await pluginB.init(ctxB)
    fake.failNextOwnDecryptWith('key-unrecoverable')
    await (pluginB as unknown as { verifyTrustStateOnInit(): Promise<void> }).verifyTrustStateOnInit()
    expect(useTrustStateStatusStore.getState().status).toBe('awaiting-key')

    await pluginB.restoreSecretKey('shared-pp')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useTrustStateStatusStore.getState().status).toBe('sealed')
  })
})
