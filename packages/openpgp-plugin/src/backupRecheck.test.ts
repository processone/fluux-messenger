// @vitest-environment node
/** Intent FLM-411: the status of the server backup follows the identity of the exact backup file this
 * device confirmed, not only the key fingerprint. Committed Alice/Bob keys and the real web crypto path;
 * only PEP transport and storage are local. The web engine cannot rotate keys, so one stand-in grows the
 * own certificate by a subkey, which is all a rotation changes for this status. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginStorage, InMemoryStorageBackend, type PEPItem, type PluginContext } from '@fluux/sdk'
import { unarmor } from 'openpgp'
import { WebOpenPGPPlugin } from './WebOpenPGPPlugin'
import type { CertValidation, KeyBundle } from './types'
import { clearSessionPassphrase, readBackupIdentity, sha256Hex, clearBackedUpFingerprint, writeBackedUpFingerprint } from './index'

const fixture = (name: string) => readFileSync(resolve(__dirname, './fixtures', name), 'utf8')
const meta = JSON.parse(fixture('sequoia_meta.json'))
const aliceBackup = fixture('sequoia_alice_backup.asc')
const bobBackup = fixture('web_bob_backup.asc')
const jid = 'alice@example.com'
const secretNode = 'urn:xmpp:openpgp:0:secret-key'
const otherCode = JSON.parse(fixture('migration_meta.json')).openkeychain.passphrase

class RecheckPlugin extends WebOpenPGPPlugin {
  /** Stand-in for a rotation: the own certificate gains a subkey. */
  rotated = false
  protected override async validateCert(publicArmored: string): Promise<CertValidation> {
    const cert = await super.validateCert(publicArmored)
    const own = this.ownBundle?.fingerprint.toLowerCase() === cert.fingerprint.toLowerCase()
    return this.rotated && own ? { ...cert, subkeyFingerprints: [...cert.subkeyFingerprints, 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'] } : cert
  }
  exportBackup(passphrase: string) { return this.buildExportArmor(passphrase) }
}
/** Stand-in for the native engine: bundles report every component, retired subkeys included,
 * while their public armor (and so validateCert) omits them. `extraOnInstall` adds parts a newer file's key has. */
class NativeLikePlugin extends RecheckPlugin {
  extraOnInstall: string[] = []
  readonly retired = 'AAAA00000000000000000000000000000000AAAA'
  private withComponents(b: KeyBundle, extra: string[] = []): KeyBundle {
    return { ...b, componentFingerprints: [b.fingerprint.toUpperCase(), this.retired, ...extra] }
  }
  protected override async backupImportAll(account: string, message: string, passphrase: string, stage = true) {
    return (await super.backupImportAll(account, message, passphrase, stage)).map(b => this.withComponents(b))
  }
  protected override async backupImportSelected(...args: Parameters<WebOpenPGPPlugin['backupImportSelected']>) {
    return this.withComponents(await super.backupImportSelected(...args), this.extraOnInstall)
  }
}
const plugins: WebOpenPGPPlugin[] = []
vi.setConfig({ testTimeout: 30_000 })
beforeEach(() => { localStorage.clear(); clearSessionPassphrase() })
afterEach(async () => { vi.restoreAllMocks(); for (const plugin of plugins.splice(0)) await plugin.shutdown(); clearSessionPassphrase() })

const item = async (armored: string): Promise<PEPItem> => ({ id: 'current', payload: { name: 'secretkey', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [Buffer.from((await unarmor(armored)).data).toString('base64')] } })
const hashOf = async (armored: string) => sha256Hex((await unarmor(armored)).data)

async function setup(Plugin: typeof RecheckPlugin = RecheckPlugin) {
  const nodes = new Map<string, PEPItem[]>([[secretNode, [await item(aliceBackup)]]])
  const publications: string[] = []
  let secretReads = 0
  const ctx: PluginContext = {
    account: { jid }, storage: createPluginStorage(new InMemoryStorageBackend(), 'backup-recheck'),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    reportSecurityContextUpdate: () => {},
    xmpp: {
      sendStanza: async () => {},
      queryDisco: async () => ({ features: [{ var: 'http://jabber.org/protocol/pubsub' }, { var: 'http://jabber.org/protocol/pubsub#publish-options' }], identities: [{ category: 'pubsub', type: 'pep' }] }),
      queryPEP: async (_jid, node) => { if (node === secretNode) secretReads++; return nodes.get(node) ?? [] },
      publishPEP: async (node, i) => { publications.push(node); nodes.set(node, [{ id: i.id, payload: i.payload }]) },
      retractPEP: async node => { nodes.delete(node) }, deletePEP: async node => { nodes.delete(node) },
      subscribePEP: () => ({ unsubscribe: () => {} }),
    },
  }
  const plugin = new Plugin(); plugins.push(plugin) as unknown
  await plugin.init(ctx)
  return { plugin: plugin as RecheckPlugin, nodes, publications, reads: () => secretReads }
}

describe('server backup status follows the confirmed file', () => {
  it('a server restore records the file and later reads are confirmed with one server read each', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    const record = readBackupIdentity(jid)!
    expect(record.confirmedBy).toBe('restore')
    expect(record.packetsSha256).toBe(await hashOf(aliceBackup))
    expect(record.fingerprints).toContain(meta.aliceFingerprint.toUpperCase())
    const before = f.reads()
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('confirmed')
    expect(f.reads() - before).toBe(1)
  })

  it('reports a same-key backup replaced under a new code as changed, and the saved code no longer opens it', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    f.nodes.set(secretNode, [await item(await f.plugin.exportBackup(otherCode))])
    expect(f.plugin.getBackedUpFingerprint()).toBe(meta.aliceFingerprint.toLowerCase()) // the old claim alone would still say backed up
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('changed')
    await expect(f.plugin.checkBackupWithCode(meta.backupPassphrase)).rejects.toThrow()
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('changed')
  })

  it('Check with code confirms the new file in memory: no publish, no install, wrong code changes nothing', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    f.nodes.set(secretNode, [await item(await f.plugin.exportBackup(otherCode))])
    const recordBefore = readBackupIdentity(jid)
    f.publications.length = 0
    await expect(f.plugin.checkBackupWithCode('not-the-code')).rejects.toThrow()
    expect(readBackupIdentity(jid)).toEqual(recordBefore)
    expect(await f.plugin.checkBackupWithCode(otherCode)).toEqual({ outcome: 'confirmed', status: 'confirmed' })
    expect(readBackupIdentity(jid)!.confirmedBy).toBe('check')
    expect(f.publications).toEqual([])
    expect(f.plugin.getOwnFingerprint()).toBe(meta.aliceFingerprint.toLowerCase())
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('confirmed')
  })

  it('a backup holding another key is not recorded', async () => {
    const f = await setup()
    await f.plugin.importKeyFromFile(bobBackup, meta.backupPassphrase)
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('unconfirmed')
    expect(await f.plugin.checkBackupWithCode(meta.backupPassphrase)).toEqual({ outcome: 'other-key', status: 'unconfirmed' })
    expect(readBackupIdentity(jid)).toBeNull()
  })

  it('a rotation whose backup publish failed reads out of date, and publishing again confirms', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('confirmed')
    f.plugin.rotated = true // the key gained a subkey; the server still holds the earlier file
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('out-of-date')
    await f.plugin.backupSecretKey(meta.backupPassphrase)
    expect(readBackupIdentity(jid)!.confirmedBy).toBe('publish')
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('confirmed')
  })

  it('a device holding only the older marker records the current backup at its first read', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    localStorage.clear()
    writeBackedUpFingerprint(jid, meta.aliceFingerprint.toLowerCase())
    expect(readBackupIdentity(jid)).toBeNull()
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('confirmed')
    expect(readBackupIdentity(jid)!.confirmedBy).toBe('adopted')
    f.nodes.set(secretNode, [await item(await f.plugin.exportBackup(otherCode))])
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('changed')
  })

  it('a device without proof of this backup reads unconfirmed and records nothing', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    localStorage.clear()
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('unconfirmed')
    writeBackedUpFingerprint(jid, 'ffff')
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('unconfirmed')
    expect(readBackupIdentity(jid)).toBeNull()
  })

  it('records the server file, not the imported file, when an install is proven against the server backup', async () => {
    const source = await setup()
    await source.plugin.restoreSecretKey(meta.backupPassphrase)
    const exported = await source.plugin.exportBackup(meta.backupPassphrase)
    localStorage.clear(); clearSessionPassphrase()
    const device = await setup()
    await device.plugin.importKeyFromFile(exported, meta.backupPassphrase)
    const record = readBackupIdentity(jid)!
    expect(record.confirmedBy).toBe('install')
    expect(record.packetsSha256).toBe(await hashOf(aliceBackup))
    expect(record.packetsSha256).not.toBe(await hashOf(exported))
    expect(await device.plugin.inspectSecretKeyBackup()).toBe('confirmed')
  })

  it('a failed hash or read is never confirmed or absent', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('no digest'))
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('unknown')
    digest.mockRestore()
    const query = vi.spyOn(f.plugin['ctx']!.xmpp, 'queryPEP').mockRejectedValue(new Error('remote-server-timeout'))
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('unknown')
    query.mockRestore()
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('confirmed')
  })

  it('reports absent when the server has no backup, and deleting the backup or identity clears the record', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    await f.plugin.retractSecretKeyBackup()
    expect(readBackupIdentity(jid)).toBeNull()
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('absent')
    await f.plugin.backupSecretKey(meta.backupPassphrase)
    expect(readBackupIdentity(jid)).not.toBeNull()
    await f.plugin.deleteIdentity()
    expect(readBackupIdentity(jid)).toBeNull()
    clearBackedUpFingerprint(jid)
  })

  it('records the server file\'s own components when a newer key shares its primary but has other subkeys', async () => {
    const source = await setup()
    await source.plugin.restoreSecretKey(meta.backupPassphrase)
    const exported = await source.plugin.exportBackup(meta.backupPassphrase)
    localStorage.clear(); clearSessionPassphrase()
    const device = await setup(NativeLikePlugin)
    ;(device.plugin as NativeLikePlugin).extraOnInstall = ['BBBB00000000000000000000000000000000BBBB']
    const preview = await device.plugin.importKeyFromFile(exported, meta.backupPassphrase, { accountJid: jid })
    if (!('needsPicker' in preview)) throw new Error('Expected confirmation')
    await device.plugin.installSelectedKey(preview.backupContext.message, preview.backupContext.passphrase, meta.aliceFingerprint.toLowerCase(), { accountJid: jid })
    const record = readBackupIdentity(jid)!
    expect(record.fingerprints).toContain('AAAA00000000000000000000000000000000AAAA')
    expect(record.fingerprints).not.toContain('BBBB00000000000000000000000000000000BBBB')
    expect(await device.plugin.inspectSecretKeyBackup()).toBe('out-of-date')
  })

  it('uses the native full component list, retired subkeys included, for the record and the comparison', async () => {
    const f = await setup(NativeLikePlugin)
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    expect(readBackupIdentity(jid)!.fingerprints).toContain('AAAA00000000000000000000000000000000AAAA')
    f.nodes.set(secretNode, [await item(await f.plugin.exportBackup(otherCode))])
    expect(await f.plugin.checkBackupWithCode(otherCode)).toEqual({ outcome: 'confirmed', status: 'confirmed' })
    expect(readBackupIdentity(jid)!.fingerprints).toContain('AAAA00000000000000000000000000000000AAAA')
  })

  it('a record that cannot be stored is never used: no adoption, and the old claim is dropped', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    localStorage.clear()
    writeBackedUpFingerprint(jid, meta.aliceFingerprint.toLowerCase())
    const real = localStorage.setItem.bind(localStorage)
    const failing = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.includes('backupIdentity')) throw new Error('QuotaExceededError')
      return real(key, value)
    })
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('unconfirmed')
    f.nodes.set(secretNode, [await item(await f.plugin.exportBackup(otherCode))])
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('unconfirmed')
    await f.plugin.backupSecretKey(meta.backupPassphrase) // publish whose record cannot be stored
    expect(f.plugin.getBackedUpFingerprint()).toBeNull()
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('unconfirmed')
    failing.mockRestore()
    localStorage.setItem = real
  })

  it('names another key when the confirmed backup holds a different primary', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    expect(f.plugin.backupRecordHoldsOtherKey()).toBe(false)
    await f.plugin.importKeyFromFile(bobBackup, meta.backupPassphrase)
    expect(await f.plugin.inspectSecretKeyBackup()).toBe('out-of-date')
    expect(f.plugin.backupRecordHoldsOtherKey()).toBe(true)
  })
})
