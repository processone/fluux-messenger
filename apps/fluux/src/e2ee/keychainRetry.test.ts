// @vitest-environment node
/** Intent FLM-304, the captain's words on FLM-298: "Never, but maybe an
 * explicit retry try could be proposed in a advanced panel, in case there is
 * no other way to recover the key". The plugin offers the retry only when no
 * other recovery is possible, reads the keychain only on the user's request,
 * and unlocks the same key without generating or restoring one. Native IPC is
 * injected; the key is the real Sequoia-generated fixture. The owning Rust
 * suites prove the native reads (macos_secrets.rs, openpgp.rs). */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginStorage, InMemoryStorageBackend, type PluginContext } from '@fluux/sdk'
import { decrypt, readMessage, readKey, unarmor } from 'openpgp'
import { resetUncertainImportsForTesting, SequoiaPgpPlugin, type InvokeFn } from './SequoiaPgpPlugin'
import type { KeyBundle } from './OpenPGPPluginBase'
import { parseSecretKeysFromBackupPayload } from './backupKeyMaterial'
import { setPlatformForTesting } from '@/platform'

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const meta = JSON.parse(fixture('sequoia_meta.json'))
const accountJid = 'alice@example.com'
const sourceBackup = fixture('sequoia_alice_backup.asc')
const REFUSAL = 'openpgp-storage-unavailable: macOS keychain (-128): user canceled the operation'
const DESYNC = 'decrypt persisted TSK: decrypt primary secret key: unexpected EOF'
const RETRY = 'openpgp_retry_keychain_access'
const SECRET_NODE = 'urn:xmpp:openpgp:0:secret-key'
let restorePlatform: () => void
const plugins: SequoiaPgpPlugin[] = []
vi.setConfig({ testTimeout: 30_000 })
beforeEach(() => { resetUncertainImportsForTesting(); restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' }) })
afterEach(async () => { for (const p of plugins.splice(0)) await p.shutdown(); resetUncertainImportsForTesting(); restorePlatform() })

/** What the user answers on each macOS prompt the retry opens. */
type Answer = 'refuse' | 'grant' | 'desync'

async function aliceBundle(): Promise<KeyBundle> {
  const result = await decrypt({ message: await readMessage({ armoredMessage: sourceBackup }), passwords: [meta.backupPassphrase], format: 'binary' })
  const key = (await parseSecretKeysFromBackupPayload(result.data))[0]
  return { fingerprint: key.getFingerprint().toUpperCase(), publicArmored: key.toPublic().armor(), keychainBacked: true, createdAt: key.getCreationTime().toISOString() }
}

async function setup({ initError = REFUSAL, refused = true, backup = 'absent' as 'absent' | 'present' | 'error' } = {}) {
  const calls: string[] = []
  const publications: string[] = []
  const answers: Answer[] = []
  const alice = await aliceBundle()
  let unlocked: KeyBundle | null = null
  let pause: (() => Promise<void>) | undefined
  const invoke: InvokeFn = async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd)
    if (cmd === 'openpgp_has_persisted_key') return true as T
    if (cmd === 'openpgp_ensure_key') { if (unlocked) return unlocked as T; throw new Error(initError) }
    // The native probe inspects cached answers only; it never opens a prompt.
    if (cmd === 'openpgp_keychain_retry_available') return (refused && !unlocked) as T
    if (cmd === RETRY) {
      expect(args).toEqual({ accountJid })
      await pause?.()
      if (unlocked) return unlocked as T
      const answer = answers.shift()
      if (answer === 'refuse') throw new Error('openpgp-keychain-refused: access to the protected items was refused again')
      if (answer === 'desync') { refused = false; throw new Error(DESYNC) }
      if (answer === 'grant') { unlocked = alice; return alice as T }
      throw new Error('openpgp-keychain-retry-unavailable: no refused keychain access to retry')
    }
    if (cmd === 'openpgp_backup_import_selected') throw new Error('openpgp-restore-outcome-uncertain: the restored key is in use but its record is not confirmed durable')
    if (cmd === 'openpgp_validate_cert') {
      const key = await readKey({ armoredKey: args!.publicArmored as string })
      return { fingerprint: key.getFingerprint().toUpperCase(), userIds: key.getUserIDs(), createdAt: key.getCreationTime().toISOString(),
        subkeyFingerprints: key.getSubkeys().map(k => k.getFingerprint().toUpperCase()), hasEncryptionSubkey: true } as T
    }
    throw new Error(`Unexpected native effect: ${cmd}`)
  }
  const ctx: PluginContext = {
    account: { jid: accountJid }, storage: createPluginStorage(new InMemoryStorageBackend(), 'keychain-retry'),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    reportSecurityContextUpdate: () => {}, notifyKeyUnlocked: vi.fn(),
    xmpp: {
      sendStanza: async () => {},
      queryDisco: async () => ({ features: [{ var: 'http://jabber.org/protocol/pubsub' }, { var: 'http://jabber.org/protocol/pubsub#publish-options' }], identities: [{ category: 'pubsub', type: 'pep' }] }),
      queryPEP: async (_jid, node) => {
        if (node !== SECRET_NODE) return []
        if (backup === 'error') throw new Error('remote-server-timeout')
        return backup === 'present'
          ? [{ id: 'current', payload: { name: 'secretkey', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [Buffer.from((await unarmor(sourceBackup)).data).toString('base64')] } }]
          : []
      },
      publishPEP: async node => { publications.push(node) }, retractPEP: async () => {}, deletePEP: async () => {},
      subscribePEP: () => ({ unsubscribe: () => {} }),
    },
  }
  const plugin = new SequoiaPgpPlugin({ invoke }); plugins.push(plugin)
  await plugin.init(ctx)
  return { plugin, ctx, calls, publications, alice, answer: (...next: Answer[]) => answers.push(...next), setPause: (value?: () => Promise<void>) => { pause = value } }
}

describe('FLM-304 explicit keychain retry', () => {
  it.each([
    ['a refused keychain read and no server backup', {}, true],
    ['a desynced key whose old item read was refused', { initError: DESYNC }, true],
    ['a server backup that can restore the key', { backup: 'present' as const }, false],
    ['a backup probe that could not reach the server', { backup: 'error' as const }, false],
    ['a locked key with no refusal held this launch', { refused: false }, false],
  ])('offers the retry for %s: %s, without reading the keychain', async (_name, options, offered) => {
    const f = await setup(options)
    expect(f.plugin.isKeyRecoveryNeeded()).toBe(true)
    expect(await f.plugin.isKeychainRetryOffered()).toBe(offered)
    expect(f.calls).not.toContain(RETRY)
    expect(f.publications).toEqual([])
  })

  it('reads the keychain once per request and unlocks the same key after a second refusal', async () => {
    const f = await setup()
    expect(await f.plugin.isKeychainRetryOffered()).toBe(true)

    f.answer('refuse')
    await expect(f.plugin.retryKeychainAccess()).rejects.toMatchObject({ code: 'keychain-refused' })
    expect(f.plugin.isKeyRecoveryNeeded()).toBe(true)
    expect(f.plugin.isKeyStorageUnavailable()).toBe(true)
    expect(f.plugin.getOwnFingerprint()).toBeNull()
    expect(f.ctx.notifyKeyUnlocked).not.toHaveBeenCalled()
    expect(f.publications).toEqual([])
    expect(await f.plugin.isKeychainRetryOffered()).toBe(true)

    f.answer('grant')
    await expect(f.plugin.retryKeychainAccess()).resolves.toEqual({ fingerprint: meta.aliceFingerprint })
    expect(f.plugin.getOwnFingerprint()).toBe(meta.aliceFingerprint)
    expect(f.plugin.isKeyRecoveryNeeded()).toBe(false)
    expect(f.ctx.notifyKeyUnlocked).toHaveBeenCalledOnce()
    expect(f.publications).toContain('urn:xmpp:openpgp:0:public-keys')
    expect(f.publications).not.toContain(SECRET_NODE)
    // One native read per click; nothing generated, restored or read again on its own.
    expect(f.calls.filter(c => c === RETRY)).toHaveLength(2)
    expect(f.calls.filter(c => c === 'openpgp_ensure_key')).toHaveLength(1)
    expect(f.calls).not.toContain('openpgp_backup_import_selected')
    expect(await f.plugin.isKeychainRetryOffered()).toBe(false)
  })

  it('keeps a second click from starting another read while the prompt is open', async () => {
    const f = await setup()
    let resume!: () => void
    f.setPause(() => new Promise<void>(done => { resume = done }))
    f.answer('grant')
    const first = f.plugin.retryKeychainAccess()
    await vi.waitFor(() => expect(f.calls).toContain(RETRY))
    await expect(f.plugin.retryKeychainAccess()).rejects.toMatchObject({ code: 'identity-change-pending' })
    resume()
    await expect(first).resolves.toEqual({ fingerprint: meta.aliceFingerprint })
    expect(f.calls.filter(c => c === RETRY)).toHaveLength(1)
  })

  it('reports a key that still cannot be unlocked after the items were read', async () => {
    const f = await setup()
    f.answer('desync')
    await expect(f.plugin.retryKeychainAccess()).rejects.toMatchObject({ code: 'key-unrecoverable' })
    expect(f.plugin.isKeyRecoveryNeeded()).toBe(true)
    expect(f.plugin.isKeyStorageUnavailable()).toBe(false)
    expect(f.ctx.notifyKeyUnlocked).not.toHaveBeenCalled()
    expect(await f.plugin.isKeychainRetryOffered()).toBe(false)
  })

  it('does not unlock a plugin that logged out while the prompt was open', async () => {
    const f = await setup()
    let resume!: () => void
    f.setPause(() => new Promise<void>(done => { resume = done }))
    f.answer('grant')
    const retry = f.plugin.retryKeychainAccess()
    const rejected = expect(retry).rejects.toMatchObject({ code: 'recovery-account-changed' })
    await vi.waitFor(() => expect(f.calls).toContain(RETRY))
    await f.plugin.shutdown(); resume(); await rejected
    expect(f.plugin.getOwnFingerprint()).toBeNull()
    expect(f.ctx.notifyKeyUnlocked).not.toHaveBeenCalled()
    expect(f.publications).toEqual([])
  })

  it('neither offers nor runs the retry while a restore awaits reconciliation', async () => {
    const f = await setup()
    await expect(f.plugin.installSelectedKey(sourceBackup, meta.backupPassphrase, meta.aliceFingerprint, { accountJid }))
      .rejects.toThrow(/restore-outcome-uncertain/)
    expect(f.plugin.isBackupRestoreUncertain()).toBe(true)
    expect(await f.plugin.isKeychainRetryOffered()).toBe(false)
    f.answer('grant')
    await expect(f.plugin.retryKeychainAccess()).rejects.toMatchObject({ code: 'restore-outcome-uncertain' })
    expect(f.calls).not.toContain(RETRY)
  })

  it('refuses the retry once the key is unlocked, without a native read', async () => {
    const f = await setup()
    f.answer('grant')
    await f.plugin.retryKeychainAccess()
    await expect(f.plugin.retryKeychainAccess()).rejects.toMatchObject({ code: 'keychain-retry-unavailable' })
    expect(f.calls.filter(c => c === RETRY)).toHaveLength(1)
  })
})
