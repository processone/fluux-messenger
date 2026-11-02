// @vitest-environment node
/** Intent FLM-343: confirmed, account-bound recovery must restore an existing
 * identity without migrating refused storage or replacing its source backup.
 * Native IPC is injected; real Sequoia-generated backup/key fixtures are parsed
 * and decrypted here. The owning Rust suite proves durable native storage. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginStorage, InMemoryStorageBackend, type PluginContext } from '@fluux/sdk'
import { decrypt, encrypt, readMessage, createMessage, readKey, unarmor } from 'openpgp'
import { SequoiaPgpPlugin, type InvokeFn } from './SequoiaPgpPlugin'
import { classifyBoundaryError, type KeyBundle } from './OpenPGPPluginBase'
import { parseSecretKeysFromBackupPayload } from './backupKeyMaterial'
import { legacyNormalizeBackupPassphrase } from './backupPassphrase'
import { setPlatformForTesting } from '@/platform'

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const meta = JSON.parse(fixture('sequoia_meta.json'))
const accountJid = 'alice@example.com'
const sourceBackup = fixture('sequoia_alice_backup.asc')
let restorePlatform: () => void
const plugins: SequoiaPgpPlugin[] = []
vi.setConfig({ testTimeout: 30_000 })
beforeEach(() => { localStorage.clear(); restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' }) })
afterEach(async () => { for (const p of plugins.splice(0)) await p.shutdown(); restorePlatform() })

async function setup(error = 'openpgp-storage-unavailable: macOS keychain (-25293): authorization refused', jid = accountJid) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = []
  const publications: string[] = []
  let backup = sourceBackup
  let installed: KeyBundle | null = null
  let pause: (() => Promise<void>) | undefined
  const decode = async (message: string, passphrase: string) => {
    const result = await decrypt({ message: await readMessage({ armoredMessage: message }), passwords: [passphrase], format: 'binary' })
    return parseSecretKeysFromBackupPayload(result.data)
  }
  const bundle = (key: Awaited<ReturnType<typeof decode>>[number]): KeyBundle => ({
    fingerprint: key.getFingerprint().toUpperCase(), publicArmored: key.toPublic().armor(),
    keychainBacked: true, createdAt: key.getCreationTime().toISOString(),
  })
  const invoke: InvokeFn = async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args })
    if (cmd === 'openpgp_has_persisted_key') return true as T
    if (cmd === 'openpgp_ensure_key') { if (installed) return installed as T; throw new Error(error) }
    if (cmd === 'openpgp_backup_import_all') {
      await pause?.()
      return (await decode(args!.backupMessage as string, args!.passphrase as string)).map(bundle) as T
    }
    if (cmd === 'openpgp_backup_import_selected') {
      await pause?.()
      const keys = await decode(args!.backupMessage as string, args!.passphrase as string)
      const key = keys.find(k => k.getFingerprint().toUpperCase() === args!.selectedFingerprint)
      if (!key) throw new Error('No selected key in backup')
      installed = bundle(key)
      return installed as T
    }
    if (cmd === 'openpgp_validate_cert') {
      const key = await readKey({ armoredKey: args!.publicArmored as string })
      return { fingerprint: key.getFingerprint().toUpperCase(), userIds: key.getUserIDs(),
        createdAt: key.getCreationTime().toISOString(), subkeyFingerprints: key.getSubkeys().map(k => k.getFingerprint().toUpperCase()), hasEncryptionSubkey: true } as T
    }
    throw new Error(`Unexpected native effect: ${cmd}`)
  }
  const ctx: PluginContext = {
    account: { jid }, storage: createPluginStorage(new InMemoryStorageBackend(), 'recovery'),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    reportSecurityContextUpdate: () => {}, notifyKeyUnlocked: vi.fn(),
    xmpp: {
      sendStanza: async () => {}, queryDisco: async () => ({ features: [{ var: 'http://jabber.org/protocol/pubsub' }, { var: 'http://jabber.org/protocol/pubsub#publish-options' }], identities: [{ category: 'pubsub', type: 'pep' }] }),
      queryPEP: async (_jid, node) => node === 'urn:xmpp:openpgp:0:secret-key' ? [{ id: 'current', payload: { name: 'secretkey', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [Buffer.from((await unarmor(backup)).data).toString('base64')] } }] : [],
      publishPEP: async node => { publications.push(node) }, retractPEP: async () => {}, deletePEP: async () => {},
      subscribePEP: () => ({ unsubscribe: () => {} }),
    },
  }
  const plugin = new SequoiaPgpPlugin({ invoke }); plugins.push(plugin)
  return { plugin, ctx, calls, publications, invoke, decode, setBackup: (value: string) => { backup = value }, setPause: (value?: () => Promise<void>) => { pause = value } }
}

describe('guided backup recovery', () => {
  it.each([-25293, -128, -25308, -25291])('retains a recovery-capable plugin for scoped native storage error %s, not a missing key', async code => {
    const f = await setup(`openpgp-storage-unavailable: macOS keychain (${code})`)
    await f.plugin.init(f.ctx)
    expect(f.plugin.isKeyRecoveryNeeded()).toBe(true)
    expect(f.plugin.getOwnFingerprint()).toBeNull()
    expect(f.publications).toEqual([])
    expect(f.calls.map(c => c.cmd)).toEqual(['openpgp_has_persisted_key', 'openpgp_ensure_key'])
  })
  it.each(['network disconnected', 'native call timeout after 120000 ms'])('does not classify unrelated failure %s as recoverable storage', async error => {
    const f = await setup(error)
    await expect(f.plugin.init(f.ctx)).rejects.toThrow()
    expect(f.plugin.isKeyRecoveryNeeded()).toBe(false)
    expect(classifyBoundaryError(error).code).not.toBe('key-storage-unavailable')
  })
  it('does not treat a failed persisted-key probe as an absent identity', async () => {
    const f = await setup()
    const invoke: InvokeFn = (cmd, args) => cmd === 'openpgp_has_persisted_key'
      ? Promise.reject(new Error('native dispatcher disconnected')) : f.invoke(cmd, args)
    const device = new SequoiaPgpPlugin({ invoke }); plugins.push(device)
    await expect(device.init(f.ctx)).rejects.toThrow(/disconnected/)
    expect(f.calls).toEqual([])
    expect(device.isKeyRecoveryNeeded()).toBe(false)
  })
  it.each(['server', 'file'])('%s preview is read-only, then confirmed recovery installs the original identity and notifies deferred decrypt', async source => {
    const f = await setup(); await f.plugin.init(f.ctx)
    const mode = { accountJid }
    const preview = source === 'server' ? await f.plugin.restoreSecretKey(meta.backupPassphrase, mode)
      : await f.plugin.importKeyFromFile(sourceBackup, meta.backupPassphrase, mode)
    expect('needsPicker' in preview).toBe(true)
    if (!('needsPicker' in preview)) throw new Error('Missing preview')
    expect(preview.candidates.map(b => b.fingerprint)).toEqual([meta.aliceFingerprint])
    expect(f.calls.some(c => c.cmd.includes('import_selected'))).toBe(false)
    expect(f.plugin.getOwnFingerprint()).toBeNull()
    const result = await f.plugin.installSelectedKey(preview.backupContext.message, preview.backupContext.passphrase, preview.candidates[0].fingerprint, mode)
    expect(result.fingerprint).toBe(meta.aliceFingerprint)
    expect(f.calls.find(c => c.cmd === 'openpgp_backup_import_selected')?.args).toMatchObject({ accountJid, withoutMigration: true, selectedFingerprint: meta.aliceFingerprint })
    expect(f.plugin.isKeyRecoveryNeeded()).toBe(false)
    expect(f.ctx.notifyKeyUnlocked).toHaveBeenCalledOnce()
    expect(f.publications).toContain('urn:xmpp:openpgp:0:public-keys')
    expect(f.publications).not.toContain('urn:xmpp:openpgp:0:secret-key')
  })
  it('keeps wrong-code and mismatched-account previews from writing', async () => {
    const f = await setup(); await f.plugin.init(f.ctx)
    await expect(f.plugin.importKeyFromFile(sourceBackup, 'wrong-code', { accountJid })).rejects.toThrow()
    await expect(f.plugin.importKeyFromFile(sourceBackup, meta.backupPassphrase, { accountJid: 'bob@example.com' })).rejects.toThrow(/account changed/)
    expect(f.calls.some(c => c.cmd.includes('import_selected'))).toBe(false)
    expect(f.plugin.isKeyRecoveryNeeded()).toBe(true)
  })
  it('accepts legacy backup-code encoding without healing the source backup in recovery', async () => {
    const f = await setup(); await f.plugin.init(f.ctx)
    const keys = await f.decode(sourceBackup, meta.backupPassphrase)
    const code = '  Saved Backup Code  '
    f.setBackup(await encrypt({ message: await createMessage({ binary: keys[0].write() }), passwords: [legacyNormalizeBackupPassphrase(code)], format: 'armored' }))
    const result = await f.plugin.restoreSecretKey(code, { accountJid })
    if (!('needsPicker' in result)) throw new Error('Missing preview')
    await f.plugin.installSelectedKey(result.backupContext.message, result.backupContext.passphrase, result.candidates[0].fingerprint, { accountJid })
    expect(f.publications).not.toContain('urn:xmpp:openpgp:0:secret-key')
  })
  it('rejects a preview completed after shutdown without any install', async () => {
    const f = await setup(); await f.plugin.init(f.ctx)
    let resume!: () => void
    f.setPause(() => new Promise<void>(resolve => { resume = resolve }))
    const preview = f.plugin.importKeyFromFile(sourceBackup, meta.backupPassphrase, { accountJid })
    const rejected = expect(preview).rejects.toThrow(/account changed/)
    await f.plugin.shutdown(); resume(); await rejected
    expect(f.calls.some(c => c.cmd.includes('import_selected'))).toBe(false)
  })
  it.each(['windows', 'linux', 'ios'] as const)('does not opt other platform %s out of migration', async os => {
    restorePlatform(); restorePlatform = setPlatformForTesting({ shell: os === 'ios' ? 'mobile' : 'desktop', os })
    const f = await setup(); await f.plugin.init(f.ctx)
    await f.plugin.installSelectedKey(sourceBackup, meta.backupPassphrase, meta.aliceFingerprint, { accountJid })
    expect(f.calls.find(c => c.cmd === 'openpgp_backup_import_selected')?.args).not.toHaveProperty('withoutMigration')
  })
  it('keeps ordinary imports on their normal native storage path', async () => {
    const f = await setup(); await f.plugin.init(f.ctx)
    await f.plugin.importKeyFromFile(sourceBackup, meta.backupPassphrase)
    expect(f.calls.find(c => c.cmd === 'openpgp_backup_import_selected')?.args).not.toHaveProperty('withoutMigration')
  })
  it('presents every real key in a multi-key backup and installs only the selected fingerprint', async () => {
    const f = await setup(); await f.plugin.init(f.ctx)
    const alice = (await f.decode(sourceBackup, meta.backupPassphrase))[0]
    const bob = (await f.decode(fixture('web_bob_backup.asc'), legacyNormalizeBackupPassphrase(meta.backupPassphrase)))[0]
    const bytes = new Uint8Array([...alice.write(), ...bob.write()])
    const backup = await encrypt({ message: await createMessage({ binary: bytes }), passwords: [meta.backupPassphrase], format: 'armored' })
    const query = f.ctx.xmpp.queryPEP
    f.ctx.xmpp.queryPEP = async (...args) => args[1] === 'urn:xmpp:openpgp:0:public-keys'
      ? [{ id: 'current', payload: { name: 'public-keys-list', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [{ name: 'pubkey-metadata', attrs: { 'v4-fingerprint': bob.getFingerprint().toUpperCase() }, children: [] }] } }] : query(...args)
    const result = await f.plugin.importKeyFromFile(backup, meta.backupPassphrase, { accountJid })
    if (!('needsPicker' in result)) throw new Error('Missing picker')
    expect(result.candidates.map(k => k.fingerprint)).toEqual([alice, bob].map(k => k.getFingerprint().toUpperCase()))
    expect(result.recommendedFingerprint).toBe(bob.getFingerprint().toUpperCase())
    expect(f.calls.some(c => c.cmd.includes('import_selected'))).toBe(false)
    await f.plugin.installSelectedKey(result.backupContext.message, result.backupContext.passphrase, result.candidates[1].fingerprint, { accountJid })
    expect(f.plugin.getOwnFingerprint()).toBe(bob.getFingerprint().toUpperCase())
  })
  it('does not revive a logged-out plugin when an already-dispatched native save finishes', async () => {
    const f = await setup(); await f.plugin.init(f.ctx)
    let resume!: () => void
    f.setPause(() => new Promise<void>(resolve => { resume = resolve }))
    const install = f.plugin.installSelectedKey(sourceBackup, meta.backupPassphrase, meta.aliceFingerprint, { accountJid })
    const rejected = expect(install).rejects.toThrow(/account changed/)
    await f.plugin.shutdown(); resume(); await rejected
    expect(f.plugin.getOwnFingerprint()).toBeNull()
    expect(f.ctx.notifyKeyUnlocked).not.toHaveBeenCalled()
    expect(f.publications).toEqual([])
  })
  it.each([
    ['uncertain-durability@example.com', 'openpgp-restore-outcome-uncertain: the restored key is in use but its record is not confirmed durable'],
    ['uncertain-readback@example.com', "openpgp-restore-outcome-uncertain: whether the restored key's record was published could not be read back; Nothing was rolled back"],
    ['uncertain-rollback@example.com', 'openpgp-restore-outcome-uncertain: could not put the previous key back'],
  ])('preserves partial outcome information and blocks a second native install for %s', async (jid, reading) => {
    const f = await setup(undefined, jid)
    let installs = 0
    const invoke: InvokeFn = async <T>(cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'openpgp_backup_import_selected') { installs++; throw new Error(reading) }
      return f.invoke<T>(cmd, args)
    }
    const device = new SequoiaPgpPlugin({ invoke }); plugins.push(device)
    await device.init(f.ctx)
    await expect(device.installSelectedKey(sourceBackup, meta.backupPassphrase, meta.aliceFingerprint, { accountJid: jid })).rejects.toThrow(reading)
    await expect(device.installSelectedKey(sourceBackup, meta.backupPassphrase, meta.aliceFingerprint, { accountJid: jid })).rejects.toThrow(/outcome is unknown/)
    expect(installs).toBe(1)
    expect(f.ctx.notifyKeyUnlocked).not.toHaveBeenCalled()
  })
  it('never resends an import with a timed-out native outcome, even after plugin replacement', async () => {
    const f = await setup()
    const invoke: InvokeFn = (cmd, args) => cmd === 'openpgp_backup_import_selected'
      ? new Promise(() => {}) : f.invoke(cmd, args)
    const device = new SequoiaPgpPlugin({ invoke, timeouts: { keyMaterialMs: 1000 } }); plugins.push(device)
    await device.init(f.ctx)
    vi.useFakeTimers()
    try {
      const install = device.installSelectedKey(sourceBackup, meta.backupPassphrase, meta.aliceFingerprint, { accountJid })
      const timedOut = expect(install).rejects.toThrow(/timeout/)
      await vi.advanceTimersByTimeAsync(1000); await timedOut
      const replacement = new SequoiaPgpPlugin({ invoke }); plugins.push(replacement)
      await replacement.init(f.ctx)
      await expect(replacement.installSelectedKey(sourceBackup, meta.backupPassphrase, meta.aliceFingerprint, { accountJid })).rejects.toThrow(/outcome is unknown/)
      expect(f.ctx.notifyKeyUnlocked).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

})
