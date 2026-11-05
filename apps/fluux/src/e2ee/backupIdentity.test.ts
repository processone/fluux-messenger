// @vitest-environment node
/** Intent FLM-357: installing a file must not claim that an unrelated server
 * backup protects its identity. Use the committed Alice/Bob interop keys and
 * the real web crypto/install path; only PEP transport and storage are local. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginStorage, InMemoryStorageBackend, type PEPItem, type PluginContext } from '@fluux/sdk'
import { createMessage, decrypt, encrypt, readMessage, unarmor } from 'openpgp'
import { WebOpenPGPPlugin } from './WebOpenPGPPlugin'
import { clearSessionPassphrase } from './webPassphraseStore'
import { parseSecretKeysFromBackupPayload } from './backupKeyMaterial'
import { legacyNormalizeBackupPassphrase } from './backupPassphrase'
import { clearBackedUpFingerprint, readBackedUpFingerprint, writeBackedUpFingerprint } from './backupMarker'

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const meta = JSON.parse(fixture('sequoia_meta.json'))
const webMeta = JSON.parse(fixture('web_meta.json'))
const aliceFingerprint = meta.aliceFingerprint.toLowerCase()
const aliceBackup = fixture('sequoia_alice_backup.asc')
const bobBackup = fixture('web_bob_backup.asc')
const jid = 'alice@example.com'
const secretNode = 'urn:xmpp:openpgp:0:secret-key'
const publicNode = 'urn:xmpp:openpgp:0:public-keys'
class InspectableWebPlugin extends WebOpenPGPPlugin {
  exportBackup(passphrase: string) { return this.buildExportArmor(passphrase) }
  inspectBackup(message: string, passphrase: string) { return this.backupImportAll(jid, message, passphrase, false) }
}
const plugins: WebOpenPGPPlugin[] = []
vi.setConfig({ testTimeout: 30_000 })
beforeEach(() => { localStorage.clear(); clearSessionPassphrase() })
afterEach(async () => { for (const plugin of plugins.splice(0)) await plugin.shutdown(); clearSessionPassphrase() })

async function decode(backup: string, passphrase = meta.backupPassphrase) {
  const result = await decrypt({ message: await readMessage({ armoredMessage: backup }), passwords: [passphrase], format: 'binary' })
  return parseSecretKeysFromBackupPayload(result.data)
}
async function multiKeyBackup() {
  const alice = (await decode(aliceBackup))[0]
  const bob = (await decode(bobBackup, legacyNormalizeBackupPassphrase(meta.backupPassphrase)))[0]
  return encrypt({ message: await createMessage({ binary: new Uint8Array([...alice.write(), ...bob.write()]) }), passwords: [meta.backupPassphrase], format: 'armored' })
}
async function setup() {
  const nodes = new Map<string, PEPItem[]>()
  nodes.set(secretNode, [{ id: 'current', payload: { name: 'secretkey', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [Buffer.from((await unarmor(aliceBackup)).data).toString('base64')] } }])
  const publications: string[] = []
  const ctx: PluginContext = {
    account: { jid }, storage: createPluginStorage(new InMemoryStorageBackend(), 'backup-identity'),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    reportSecurityContextUpdate: () => {},
    xmpp: {
      sendStanza: async () => {},
      queryDisco: async () => ({ features: [{ var: 'http://jabber.org/protocol/pubsub' }, { var: 'http://jabber.org/protocol/pubsub#publish-options' }], identities: [{ category: 'pubsub', type: 'pep' }] }),
      queryPEP: async (_jid, node) => nodes.get(node) ?? [],
      publishPEP: async (node, item) => { publications.push(node); nodes.set(node, [{ id: item.id, payload: item.payload }]) },
      retractPEP: async node => { nodes.delete(node) }, deletePEP: async node => { nodes.delete(node) },
      subscribePEP: () => ({ unsubscribe: () => {} }),
    },
  }
  const plugin = new InspectableWebPlugin(); plugins.push(plugin)
  await plugin.init(ctx)
  return { plugin, ctx, nodes, publications }
}

describe('server backup identity after file installation', () => {
  it.each(['automatic', 'picker', 'guided'] as const)('keeps Alice backed up, not Bob, after %s file installation', async mode => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    expect(f.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
    writeBackedUpFingerprint('other@example.com', aliceFingerprint)
    const serverBefore = await f.plugin.fetchSecretKeyBackup()
    f.publications.length = 0
    if (mode === 'automatic') {
      await f.plugin.importKeyFromFile(bobBackup, meta.backupPassphrase)
    } else {
      f.nodes.delete(publicNode) // no advertised choice: the user picks from real keys
      const recovery = mode === 'guided' ? { accountJid: jid } : undefined
      const preview = await f.plugin.importKeyFromFile(await multiKeyBackup(), meta.backupPassphrase, recovery)
      if (!('needsPicker' in preview)) throw new Error('Expected a key choice')
      expect(preview.candidates.map(key => key.fingerprint)).toEqual(expect.arrayContaining([aliceFingerprint, webMeta.bobFingerprint.toLowerCase()]))
      expect(f.plugin.getOwnFingerprint()).toBe(aliceFingerprint)
      expect(f.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
      await f.plugin.installSelectedKey(preview.backupContext.message, preview.backupContext.passphrase, webMeta.bobFingerprint, recovery)
    }
    expect(f.plugin.getOwnFingerprint()).toBe(webMeta.bobFingerprint.toLowerCase())
    expect(f.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
    expect(await f.plugin.fetchSecretKeyBackup()).toBe(serverBefore)
    expect((await decode(serverBefore!)).map(key => key.getFingerprint().toLowerCase())).toEqual([aliceFingerprint])
    expect(f.publications).not.toContain(secretNode)
    expect(readBackedUpFingerprint('other@example.com')).toBe(aliceFingerprint)
  })

  it.each(['absent', 'unavailable'] as const)('imports Bob without creating a marker when its server backup is %s', async state => {
    const f = await setup()
    if (state === 'absent') f.nodes.delete(secretNode)
    else {
      const query = f.ctx.xmpp.queryPEP
      f.ctx.xmpp.queryPEP = (account, node, ...rest) => node === secretNode ? Promise.reject(new Error('remote-server-timeout')) : query(account, node, ...rest)
    }
    await f.plugin.importKeyFromFile(bobBackup, meta.backupPassphrase)
    expect(f.plugin.getOwnFingerprint()).toBe(webMeta.bobFingerprint.toLowerCase())
    expect(f.plugin.getBackedUpFingerprint()).toBeNull()
    expect(f.publications).not.toContain(secretNode)
  })

  it('does not equate an advertised Bob public key with a Bob secret backup', async () => {
    const f = await setup()
    f.nodes.set(publicNode, [{ id: 'current', payload: { name: 'public-keys-list', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [{ name: 'pubkey-metadata', attrs: { 'v4-fingerprint': webMeta.bobFingerprint }, children: [] }] } }])
    await f.plugin.importKeyFromFile(bobBackup, meta.backupPassphrase)
    expect(f.plugin.getBackedUpFingerprint()).toBeNull()
    expect(f.publications).not.toContain(secretNode)
  })

  it('retains the known marker when a file fails to open or the post-install server read fails', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    await expect(f.plugin.importKeyFromFile(bobBackup, 'wrong-code')).rejects.toThrow()
    expect(f.plugin.getOwnFingerprint()).toBe(aliceFingerprint)
    expect(f.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
    const query = f.ctx.xmpp.queryPEP
    f.ctx.xmpp.queryPEP = (account, node, ...rest) => node === secretNode ? Promise.reject(new Error('remote-server-timeout')) : query(account, node, ...rest)
    await f.plugin.importKeyFromFile(bobBackup, meta.backupPassphrase)
    expect(f.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
  })

  it.each(['automatic', 'confirmed'] as const)('records a genuine %s server restore and keeps a known same-key file in sync', async mode => {
    const f = await setup()
    if (mode === 'automatic') await f.plugin.restoreSecretKey(meta.backupPassphrase)
    else {
      const preview = await f.plugin.restoreSecretKey(meta.backupPassphrase, { accountJid: jid })
      if (!('needsPicker' in preview)) throw new Error('Expected confirmation')
      await f.plugin.installSelectedKey(preview.backupContext.message, preview.backupContext.passphrase, aliceFingerprint, { accountJid: jid })
    }
    expect(f.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
    await f.plugin.importKeyFromFile(aliceBackup.replaceAll('\n', '\r\n'), meta.backupPassphrase)
    expect(f.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
    expect(f.publications).not.toContain(secretNode)
  })

  it('F1 confirms a real re-encrypted same-key export on a device without a marker', async () => {
    const source = await setup()
    await source.plugin.restoreSecretKey(meta.backupPassphrase)
    const exported = await source.plugin.exportBackup(meta.backupPassphrase)
    expect((await unarmor(exported)).data).not.toEqual((await unarmor(aliceBackup)).data)
    clearBackedUpFingerprint(jid); clearSessionPassphrase()
    const device = await setup()
    await device.plugin.importKeyFromFile(exported, meta.backupPassphrase)
    expect(device.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
    expect(device.publications).not.toContain(secretNode)
    expect((await decode((await device.plugin.fetchSecretKeyBackup())!))[0].getFingerprint()).toBe(aliceFingerprint)
  })

  it('F1 retains no claim when the file code cannot open the same-key server backup', async () => {
    const source = await setup()
    await source.plugin.restoreSecretKey(meta.backupPassphrase)
    const fileCode = JSON.parse(fixture('migration_meta.json')).openkeychain.passphrase
    const exported = await source.plugin.exportBackup(fileCode)
    clearBackedUpFingerprint(jid); clearSessionPassphrase()
    const device = await setup()
    await device.plugin.importKeyFromFile(exported, fileCode)
    expect(device.plugin.getOwnFingerprint()).toBe(aliceFingerprint)
    expect(device.plugin.getBackedUpFingerprint()).toBeNull()
    expect(device.publications).not.toContain(secretNode)
  })

  it('F1 read-only server inspection does not replace a staged file selection', async () => {
    const f = await setup()
    const preview = await f.plugin.importKeyFromFile(bobBackup, meta.backupPassphrase, { accountJid: jid })
    if (!('needsPicker' in preview)) throw new Error('Expected confirmation')
    expect((await f.plugin.inspectBackup(aliceBackup, meta.backupPassphrase)).map(key => key.fingerprint)).toEqual([aliceFingerprint])
    await f.plugin.installSelectedKey(preview.backupContext.message, preview.backupContext.passphrase, webMeta.bobFingerprint)
    expect(f.plugin.getOwnFingerprint()).toBe(webMeta.bobFingerprint)
    expect(f.plugin.getBackedUpFingerprint()).toBeNull()
  })

  it.each(['automatic', 'conflict-selection'] as const)('F2 reuses the fetched backup for %s server restore when another read would fail', async mode => {
    const f = await setup()
    if (mode === 'conflict-selection') {
      const backup = await multiKeyBackup()
      f.nodes.set(secretNode, [{ id: 'current', payload: { name: 'secretkey', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [Buffer.from((await unarmor(backup)).data).toString('base64')] } }])
    }
    let secretReads = 0
    const query = f.ctx.xmpp.queryPEP
    f.ctx.xmpp.queryPEP = (account, node, ...rest) => {
      if (node === secretNode && ++secretReads > 1) return Promise.reject(new Error('remote-server-timeout'))
      return query(account, node, ...rest)
    }
    const restored = mode === 'automatic' ? await f.plugin.restoreSecretKey(meta.backupPassphrase)
      : await f.plugin.resolveOwnKeyConflict_importFromServer(meta.backupPassphrase)
    if ('needsPicker' in restored) throw new Error('Expected direct server install')
    expect(secretReads).toBe(1)
    expect(f.plugin.getBackedUpFingerprint()).toBe(restored.fingerprint)
    expect(f.publications).not.toContain(secretNode)
  })

  it('records the selected identity when a real multi-key server backup contains it', async () => {
    const f = await setup()
    const backup = await multiKeyBackup()
    f.nodes.set(secretNode, [{ id: 'current', payload: { name: 'secretkey', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [Buffer.from((await unarmor(backup)).data).toString('base64')] } }])
    const preview = await f.plugin.restoreSecretKey(meta.backupPassphrase)
    if (!('needsPicker' in preview)) throw new Error('Expected a key choice')
    await f.plugin.installSelectedKey(preview.backupContext.message, preview.backupContext.passphrase, webMeta.bobFingerprint)
    expect(f.plugin.getBackedUpFingerprint()).toBe(webMeta.bobFingerprint)
    expect(f.publications).not.toContain(secretNode)
  })

  it('cannot write a marker after shutdown while confirming the server blob', async () => {
    const f = await setup()
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { resume = resolve })
    const query = f.ctx.xmpp.queryPEP
    f.ctx.xmpp.queryPEP = async (account, node, ...rest) => {
      if (node === secretNode) { entered(); await held }
      return query(account, node, ...rest)
    }
    const install = f.plugin.importKeyFromFile(aliceBackup, meta.backupPassphrase)
    const rejected = expect(install).rejects.toThrow(/account changed/)
    await started
    await f.plugin.shutdown()
    resume()
    await rejected
    expect(readBackedUpFingerprint(jid)).toBeNull()
  })

  it('records Bob only after explicit successful publication, never on failed publication', async () => {
    const f = await setup()
    await f.plugin.restoreSecretKey(meta.backupPassphrase)
    await f.plugin.importKeyFromFile(bobBackup, meta.backupPassphrase)
    const publish = f.ctx.xmpp.publishPEP
    f.ctx.xmpp.publishPEP = (node, ...rest) => node === secretNode ? Promise.reject(new Error('forbidden')) : publish(node, ...rest)
    await expect(f.plugin.backupSecretKey(meta.backupPassphrase)).rejects.toThrow('forbidden')
    expect(f.plugin.getBackedUpFingerprint()).toBe(aliceFingerprint)
    f.ctx.xmpp.publishPEP = publish
    await f.plugin.backupSecretKey(meta.backupPassphrase)
    expect(f.plugin.getBackedUpFingerprint()).toBe(webMeta.bobFingerprint.toLowerCase())
    const server = await f.plugin.fetchSecretKeyBackup()
    expect((await decode(server!)).map(key => key.getFingerprint().toLowerCase())).toEqual([webMeta.bobFingerprint.toLowerCase()])
  })
})
