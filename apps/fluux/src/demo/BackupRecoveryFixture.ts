/** FLM-343: opt-in demo fixture for browser and the unsigned native test host.
 * Only non-sensitive, committed crypto fixtures are used. No account or network.
 * The native host supplies actual OpenPGP commands over an injected secret store. */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { invoke as nativeInvoke } from '@tauri-apps/api/core'
import { decrypt, encrypt, createMessage, readMessage, readKey, unarmor } from 'openpgp'
import { xml, type Element } from '@fluux/sdk/xmpp'
import type { XMPPPrimitives } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { chatStore } from '@fluux/sdk/stores'
import { SequoiaPgpPlugin, type InvokeFn } from '@/e2ee/SequoiaPgpPlugin'
import type { KeyBundle } from '@/e2ee/OpenPGPPluginBase'
import { parseSecretKeysFromBackupPayload } from '@/e2ee/backupKeyMaterial'
import { platform, setPlatformForTesting } from '@/platform'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import backup from '@/e2ee/fixtures/sequoia_alice_backup.asc?raw'
import meta from '@/e2ee/fixtures/sequoia_meta.json'

export function createBackupRecoveryFixture() {
  const params = new URLSearchParams(location.search)
  const failure = params.get('recoveryFailure')
  const desync = failure === 'desync' || failure === 'desync-refused'
  // FLM-304: a refusal is held for the launch, of the protected storage or,
  // with desync-refused, of the old item that may hold this key's passphrase.
  let refusalHeld = failure !== 'desync'
  const backupAbsent = params.get('recoveryBackup') === 'absent'
  // FLM-304: the user refuses the first macOS prompt the explicit retry opens.
  let retryReads = 0
  // FLM-408 R2: with unlock-fails, the user allows the second prompt but the
  // secret it reads still cannot unlock the key, which consumes the refusal.
  const unlockFails = params.get('recoveryRetry') === 'unlock-fails'
  // FLM-408 R1: a journey may hold the next retried read open, as a macOS
  // prompt the user has not answered yet.
  let promptAnswered: Promise<void> | null = null
  let answerPrompt = () => {}
  ;(window as any).__recoveryPrompt = {
    hold: () => { promptAnswered = new Promise<void>(done => { answerPrompt = done }) },
    answer: () => { promptAnswered = null; answerPrompt() },
  }
  const native = platform().nativeOpenpgp
  if (!native) {
    mockWindows('main')
    mockIPC((cmd, args) => cmd.startsWith('openpgp_') ? invoke(cmd, args as Record<string, unknown>) : cmd === 'plugin:share-inbox|list' ? [] : null, { shouldMockEvents: true })
  }
  // FLM-304: a journey may run as desktop Windows to show the macOS-only retry stays hidden.
  setPlatformForTesting({ shell: 'desktop', os: params.get('recoveryOs') === 'windows' ? 'windows' : 'macos' })
  setPlatformForTesting({ ...platform(), hasInAppUpdates: false })
  const audit = { native, build: __GIT_COMMIT__, commands: [] as string[], publications: [] as string[] }
  ;(window as any).__recoveryFixture = audit
  let installed: KeyBundle | null = JSON.parse(localStorage.getItem('__test_recovery_bundle') ?? 'null')
  const privateKey = async () => {
    const decrypted = await decrypt({ message: await readMessage({ armoredMessage: backup }), passwords: [meta.backupPassphrase], format: 'binary' })
    return (await parseSecretKeysFromBackupPayload(decrypted.data))[0]
  }
  const browserInvoke: InvokeFn = async <T>(cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'openpgp_has_persisted_key') return true as T
    if (cmd === 'openpgp_ensure_key') {
      if (installed) return installed as T
      if (desync) throw new Error('decrypt persisted TSK: decrypt primary secret key: unexpected EOF')
      throw new Error('openpgp-storage-unavailable: macOS keychain (-25293): authorization refused')
    }
    // The refusal is held for the launch until the user's explicit retry.
    if (cmd === 'openpgp_keychain_retry_available') return (!installed && refusalHeld) as T
    if (cmd === 'openpgp_retry_keychain_access') {
      if (installed) return installed as T
      if (!refusalHeld) throw new Error(`openpgp-keychain-retry-unavailable: no refused keychain access to retry for ${args!.accountJid}`)
      if (promptAnswered) await promptAnswered
      retryReads++
      if (retryReads === 1) throw new Error('openpgp-keychain-refused: access to the protected items was refused again')
      if (unlockFails) {
        refusalHeld = false
        throw new Error('decrypt persisted TSK: decrypt primary secret key: unexpected EOF')
      }
      const key = await privateKey()
      installed = { fingerprint: key.getFingerprint().toUpperCase(), publicArmored: key.toPublic().armor(), keychainBacked: true, createdAt: key.getCreationTime().toISOString() }
      localStorage.setItem('__test_recovery_bundle', JSON.stringify(installed))
      return installed as T
    }
    if (cmd === 'openpgp_backup_import_all' || cmd === 'openpgp_backup_import_selected') {
      const result = await decrypt({ message: await readMessage({ armoredMessage: args!.backupMessage as string }), passwords: [args!.passphrase as string], format: 'binary' })
      const keys = await parseSecretKeysFromBackupPayload(result.data)
      const bundles = keys.map(key => ({ fingerprint: key.getFingerprint().toUpperCase(), publicArmored: key.toPublic().armor(), keychainBacked: true, createdAt: key.getCreationTime().toISOString() }))
      if (cmd.endsWith('_all')) return bundles as T
      installed = bundles.find(b => b.fingerprint === args!.selectedFingerprint) ?? null
      if (!installed) throw new Error('Selected key missing')
      if (args!.withoutMigration !== true) throw new Error('Fixture old storage is refused')
      localStorage.setItem('__test_recovery_bundle', JSON.stringify(installed))
      return installed as T
    }
    if (cmd === 'openpgp_decrypt') {
      if (!installed) throw new Error('no key for account')
      const verificationKeys = await Promise.all((args!.senderPublicArmored as string[]).map(armoredKey => readKey({ armoredKey })))
      const result = await decrypt({ message: await readMessage({ armoredMessage: args!.ciphertext as string }), decryptionKeys: [await privateKey()], verificationKeys })
      const signature = result.signatures[0]
      const verified = signature ? await signature.verified.then(() => true, () => false) : false
      return { plaintext: result.data, signaturePresent: !!signature, signatureVerified: verified,
        signatureStatus: verified ? 'verified' : signature ? 'missing-key' : 'none', signerFingerprint: verified ? meta.aliceFingerprint : null } as T
    }
    if (cmd === 'openpgp_validate_cert') {
      const key = await readKey({ armoredKey: args!.publicArmored as string })
      return { fingerprint: key.getFingerprint().toUpperCase(), userIds: key.getUserIDs(), createdAt: key.getCreationTime().toISOString(), subkeyFingerprints: key.getSubkeys().map(k => k.getFingerprint().toUpperCase()), hasEncryptionSubkey: true } as T
    }
    throw new Error(`Fixture refuses unexpected native command: ${cmd}`)
  }
  const invoke: InvokeFn = (cmd, args) => {
    audit.commands.push(cmd)
    return (native ? nativeInvoke : browserInvoke)(cmd, args)
  }
  class FixturePlugin extends SequoiaPgpPlugin {
    override async pickKeyFile() { return backup }
  }
  const xmpp: XMPPPrimitives = {
    sendStanza: async () => {},
    queryDisco: async () => ({ features: [{ var: 'http://jabber.org/protocol/pubsub' }, { var: 'http://jabber.org/protocol/pubsub#publish-options' }], identities: [{ category: 'pubsub', type: 'pep' }] }),
    queryPEP: async (_jid, node) => !backupAbsent && node === 'urn:xmpp:openpgp:0:secret-key' ? [{ id: 'current', payload: { name: 'secretkey', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [btoa(String.fromCharCode(...(await unarmor(backup)).data))] } }] : [],
    publishPEP: async node => { audit.publications.push(node) },
    retractPEP: async () => {}, deletePEP: async () => {}, subscribePEP: () => ({ unsubscribe: () => {} }),
  }
  // The App's raw-PEP facade and the plugin must observe the same protocol fixture.
  // Substitute only the demo IQ service's OpenPGP reads with real wire elements;
  // do not pass text-bearing replies through DemoClient's transport MockElement format.
  const attachPepReader = (client: object) => {
    const service = client as { sendIQ: (stanza: Element, timeoutMs?: number) => Promise<Element> }
    const original = service.sendIQ.bind(client)
    service.sendIQ = async (stanza, timeoutMs) => {
      const items = stanza.getChild('pubsub', 'http://jabber.org/protocol/pubsub')?.getChild('items')
      const node = items?.attrs.node
      if (!node?.startsWith('urn:xmpp:openpgp:0:')) return original(stanza, timeoutMs)
      const response = await xmpp.queryPEP(stanza.attrs.to, node)
      return xml('iq', { type: 'result', id: stanza.attrs.id },
        xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
          xml('items', { node }, ...response.map(item => xml('item', { id: item.id },
            xml(item.payload.name, item.payload.attrs, ...item.payload.children))))))
    }
  }
  const seedPending = async () => {
    const envelope = `<signcrypt xmlns='urn:xmpp:openpgp:0'><to jid='ava@fluux.chat'/><time stamp='2026-01-01T00:00:00Z'/><rpad>fixture</rpad><payload xmlns='jabber:client'><body>${meta.plaintext}</body></payload></signcrypt>`
    const key = native ? null : await privateKey()
    const ciphertext = native ? await nativeInvoke<string>('recovery_ciphertext')
      : await encrypt({ message: await createMessage({ text: envelope }), encryptionKeys: [key!.toPublic()], signingKeys: [key!], format: 'armored' })
    const encoded = btoa(String.fromCharCode(...(await unarmor(ciphertext)).data))
    chatStore.getState().addMessage({ id: 'recovery-waiting', stanzaId: 'recovery-waiting', originId: undefined,
      type: 'chat', from: 'you@fluux.chat', conversationId: 'ava@fluux.chat', timestamp: new Date(),
      isOutgoing: true, body: '[could not decrypt]', encryptedPayload: `<openpgp xmlns='urn:xmpp:openpgp:0'>${encoded}</openpgp>` }, { isLiveArrival: false })
  }
  // FLM-408 R3: transitions a journey runs around the retry without pressing it.
  const attachTransitions = (client: XMPPClient) => {
    ;(window as any).__recoveryTransitions = {
      // A session that starts without the plugin: the App's registration hook
      // registers a new one over the same native store (registerPlugins.ts)
      // and runs its follow-up. Resolves once the new plugin is registered.
      reregister: async () => {
        const manager = client.e2ee!
        const previous = manager.getPlugin('openpgp')
        await manager.unregister('openpgp')
        const registered = new Promise<void>((done, fail) => {
          const stop = useEncryptionSettingsStore.subscribe(state => {
            const next = manager.getPlugin('openpgp')
            if (state.registrationError) { stop(); fail(new Error(`re-registration failed: ${state.registrationError.code}`)) }
            else if (next && next !== previous) { stop(); done() }
          })
        })
        client.emitSDK('connection:authenticated', { jid: 'you@fluux.chat/fluux' })
        await registered
      },
      // What XMPPClient does when a new session starts with the plugin kept;
      // resolves once the plugin's re-sync after the reconnect has run.
      reconnect: async () => {
        const manager = client.e2ee!
        const plugin = manager.getPlugin('openpgp') as unknown as { reconnectResync: Promise<void> }
        const idle = plugin.reconnectResync
        manager.notifyReconnected({ resumed: false })
        client.emitSDK('connection:authenticated', { jid: 'you@fluux.chat/fluux' })
        // The plugin chains its re-sync when told; it must have been told.
        if (plugin.reconnectResync === idle) throw new Error('the plugin did not receive the reconnect')
        await plugin.reconnectResync
      },
    }
  }
  return { attachPepReader, attachTransitions, seedPending, plugin: new FixturePlugin({ invoke }) as SequoiaPgpPlugin, xmpp, meta, audit }
}
