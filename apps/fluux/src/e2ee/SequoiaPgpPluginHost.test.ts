/**
 * The desktop plugin from @fluux/openpgp-plugin on the app's own host: the
 * storage the app gives it on desktop (LocalStorageStorageBackend) and the real
 * file adapter (createAppFileIO) over in-memory Tauri dialog and filesystem
 * plugins. The package's suite runs the same journeys on an in-memory host;
 * these two cases keep the app's side of that seam covered: a key file saved
 * and read through the app adapter, and trust-state recovery against trust
 * records that outlive the plugin, in the app's storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginStorage, type PluginContext } from '@fluux/sdk'
import { SequoiaPgpPlugin, type TrustRecordStore } from '@fluux/openpgp-plugin'
import {
  encodeOpenPgpArmorForXep0373,
  makeContext,
  makeFakeRust,
} from '@fluux/openpgp-plugin/testing/sequoiaTestKit'
import { createAppFileIO } from './appDesktopHost'
import { LocalStorageStorageBackend } from './LocalStorageStorageBackend'

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
  return new SequoiaPgpPlugin({ macosDesktop: false, fileIO: createAppFileIO(), invoke })
}

beforeEach(() => {
  localStorage.clear()
  tauriDisk.files.clear()
  tauriDisk.picked = null
})

/** The plugin's storage as the app builds it on desktop. */
const appStorage = () => createPluginStorage(new LocalStorageStorageBackend('me@example.com'), 'e2ee/openpgp')

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

  it('re-verifies the trust state after recovery (awaiting-key -> sealed) on the app storage', async () => {
    // The second plugin finds the first one's seal and trust records in the
    // app's storage, so this case needs state that outlives a plugin instance.
    const fake = makeFakeRust()
    const plugin = appPlugin(fake.invoke)
    await plugin.init(makeContext('me@example.com', { storage: appStorage() }).ctx)
    ;(plugin as unknown as { trustRecords: TrustRecordStore }).trustRecords
      .setDecision('peer@example.com', 'BEE4000000000000000000000000000000000030', 'tofu')
    await (plugin as unknown as { verifyTrustStateOnInit(): Promise<void> }).verifyTrustStateOnInit()
    await plugin.backupSecretKey('shared-pp')
    const backup = await plugin.fetchSecretKeyBackup()
    expect(backup).toBeTruthy()
    expect(plugin.getTrustState().status).toBe('sealed')

    const pluginB = appPlugin(fake.invoke)
    const { ctx: ctxB } = makeContext('me@example.com', { storage: appStorage() })
    ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
      id: 'current',
      payload: {
        name: 'secretkey',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [encodeOpenPgpArmorForXep0373(backup!)],
      },
    })
    await pluginB.init(ctxB)
    await vi.waitFor(() => expect(pluginB.getTrustState().status).toBe('sealed'))
    fake.failNextOwnDecryptWith('key-unrecoverable')
    await (pluginB as unknown as { verifyTrustStateOnInit(): Promise<void> }).verifyTrustStateOnInit()
    expect(pluginB.getTrustState().status).toBe('awaiting-key')

    await pluginB.restoreSecretKey('shared-pp')
    await vi.waitFor(() => expect(pluginB.getTrustState().status).toBe('sealed'))
    expect(pluginB.getKeyDecisions('peer@example.com')).toEqual({ BEE4000000000000000000000000000000000030: 'tofu' })
  })
})
