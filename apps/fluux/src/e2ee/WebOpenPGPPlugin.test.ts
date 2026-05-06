// @vitest-environment node
/**
 * WebOpenPGPPlugin unit tests. Exercises the openpgp.js-backed crypto
 * layer end-to-end against a minimal in-memory plugin context. No
 * Tauri, no IndexedDB — `InMemoryStorageBackend` stands in for IDB so
 * the tests stay fast and deterministic.
 *
 * Runs under the `node` environment because openpgp.js performs
 * realm-sensitive `instanceof Uint8Array` checks that fail under
 * jsdom (which uses a different realm than Node's globals).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  InMemoryStorageBackend,
  createPluginStorage,
  type PEPItem,
  type PluginContext,
  type XMPPPrimitives,
} from '@fluux/sdk'
import { WebOpenPGPPlugin } from './WebOpenPGPPlugin'
import { clearSessionPassphrase, setSessionPassphrase } from './webPassphraseStore'

// Expose the crypto-layer protected methods so we can round-trip
// without going through the full XEP-0373 envelope handling.
class TestableWebOpenPGPPlugin extends WebOpenPGPPlugin {
  callEnsureKeyMaterial(jid: string) {
    return this.ensureKeyMaterial(jid)
  }
  callEncryptToRecipient(jid: string, recipientPub: string, plaintext: string) {
    return this.encryptToRecipient(jid, recipientPub, plaintext)
  }
  callDecryptWithOwnKey(jid: string, ciphertext: string, senderPub: string | null) {
    return this.decryptWithOwnKey(jid, ciphertext, senderPub)
  }
  callValidateCert(armored: string) {
    return this.validateCert(armored)
  }
  callBackupEncrypt(jid: string, passphrase: string) {
    return this.backupEncrypt(jid, passphrase)
  }
  callBackupImport(jid: string, msg: string, passphrase: string) {
    return this.backupImport(jid, msg, passphrase)
  }
  callForgetAccount(jid: string) {
    return this.forgetAccount(jid)
  }
}

function makeCtx(accountJid: string, sharedBackend?: InMemoryStorageBackend): {
  ctx: PluginContext
  backend: InMemoryStorageBackend
} {
  const backend = sharedBackend ?? new InMemoryStorageBackend()
  const xmpp: XMPPPrimitives = {
    sendStanza: async () => {},
    queryDisco: async () => ({
      features: [
        { var: 'http://jabber.org/protocol/pubsub' },
        { var: 'http://jabber.org/protocol/pubsub#publish-options' },
      ],
      identities: [{ category: 'pubsub', type: 'pep' }],
    }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    deletePEP: async () => {},
    queryPEP: async (): Promise<PEPItem[]> => [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
  const ctx: PluginContext = {
    storage: createPluginStorage(backend, 'openpgp-test'),
    xmpp,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    account: { jid: accountJid },
    reportSecurityContextUpdate: () => {},
  }
  return { ctx, backend }
}

beforeEach(async () => {
  // Per-test reset of every singleton store the plugin (via the base) touches.
  localStorage.clear()
  const verifiedStore = await import('@/stores/verifiedPeerKeysStore')
  const alertsStore = await import('@/stores/keyChangeAlertsStore')
  const pinStore = await import('@/stores/pinnedPrimaryFingerprintsStore')
  const ownConflictStore = await import('@/stores/ownKeyConflictStore')
  verifiedStore.useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  alertsStore.useKeyChangeAlertsStore.setState({ alertsByJid: {} })
  pinStore.usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {} })
  ownConflictStore.useOwnKeyConflictStore.setState({ conflict: null })
  clearSessionPassphrase()
})

afterEach(() => {
  clearSessionPassphrase()
})

describe('WebOpenPGPPlugin', () => {
  describe('ensureKeyMaterial', () => {
    it('throws key-locked when no session passphrase is set', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      await plugin.init(ctx)

      await expect(plugin.callEnsureKeyMaterial('alice@example.com')).rejects.toMatchObject({
        code: 'key-locked',
      })
    })

    it('generates a new key when none is stored and a passphrase is set', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)

      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')
      // v4 ECC fingerprint is 40 hex chars (SHA-1). openpgp.js emits lowercase.
      expect(bundle.fingerprint).toMatch(/^[a-f0-9]{40}$/)
      expect(bundle.publicArmored).toContain('BEGIN PGP PUBLIC KEY BLOCK')
      expect(bundle.keychainBacked).toBe(false)
    })

    it('loads the same key on re-init with the same passphrase', async () => {
      const backend = new InMemoryStorageBackend()
      const passphrase = 'hunter2-strong-passphrase'

      // First instance: generate.
      const first = new TestableWebOpenPGPPlugin()
      const ctx1 = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase(passphrase)
      await first.init(ctx1)
      const firstBundle = await first.callEnsureKeyMaterial('alice@example.com')

      // Simulate a page reload: new plugin, same backend, same passphrase.
      clearSessionPassphrase()
      const second = new TestableWebOpenPGPPlugin()
      const ctx2 = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase(passphrase)
      await second.init(ctx2)
      const secondBundle = await second.callEnsureKeyMaterial('alice@example.com')

      expect(secondBundle.fingerprint).toBe(firstBundle.fingerprint)
      expect(secondBundle.publicArmored).toBe(firstBundle.publicArmored)
    })

    it('rejects a wrong passphrase with wrong-passphrase code', async () => {
      const backend = new InMemoryStorageBackend()
      const first = new TestableWebOpenPGPPlugin()
      const ctx1 = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase('correct-passphrase-123')
      await first.init(ctx1)
      await first.callEnsureKeyMaterial('alice@example.com')

      // Same backend, different passphrase → init() reaches ensureIdentity
      // which propagates wrong-passphrase (only key-locked is swallowed).
      clearSessionPassphrase()
      const second = new TestableWebOpenPGPPlugin()
      const ctx2 = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase('totally-different-pp')

      await expect(second.init(ctx2)).rejects.toMatchObject({
        code: 'wrong-passphrase',
      })
    })
  })

  describe('crypto round-trip', () => {
    it('encryptToRecipient → decryptWithOwnKey returns the original plaintext', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)

      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')

      const plaintext = 'the quick brown fox jumps over the lazy dog'
      const ciphertext = await plugin.callEncryptToRecipient(
        'alice@example.com',
        bundle.publicArmored,
        plaintext,
      )
      expect(ciphertext).toContain('BEGIN PGP MESSAGE')

      const decrypted = await plugin.callDecryptWithOwnKey(
        'alice@example.com',
        ciphertext,
        bundle.publicArmored, // sender = self
      )

      expect(decrypted.plaintext).toBe(plaintext)
      // We signed with our own key and verified with our own pub → must verify.
      expect(decrypted.signaturePresent).toBe(true)
      expect(decrypted.signatureVerified).toBe(true)
      expect(decrypted.signerFingerprint).not.toBeNull()
    })

    it('decrypts without a sender public key (no verification possible)', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)

      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')

      const ciphertext = await plugin.callEncryptToRecipient(
        'alice@example.com',
        bundle.publicArmored,
        'plain message',
      )

      const decrypted = await plugin.callDecryptWithOwnKey(
        'alice@example.com',
        ciphertext,
        null, // no sender key → cannot verify
      )

      expect(decrypted.plaintext).toBe('plain message')
      expect(decrypted.signatureVerified).toBe(false)
    })
  })

  describe('validateCert', () => {
    it('returns the fingerprint and a positive subkey count for a generated key', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)

      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')
      const info = await plugin.callValidateCert(bundle.publicArmored)

      expect(info.fingerprint.toUpperCase()).toBe(bundle.fingerprint.toUpperCase())
      // ECC keys generate with one encryption subkey by default.
      expect(info.encryptionSubkeyCount).toBeGreaterThanOrEqual(1)
    })
  })

  describe('backup round-trip', () => {
    it('backupEncrypt → backupImport recovers the same key on a fresh plugin', async () => {
      const backupPassphrase = 'correct horse battery staple eight words ok'

      // Source plugin: generate + back up.
      const source = new TestableWebOpenPGPPlugin()
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('source-session-pp')
      await source.init(sourceCtx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt(
        'alice@example.com',
        backupPassphrase,
      )
      expect(backupMessage).toContain('BEGIN PGP MESSAGE')

      // Destination plugin: empty backend + no session passphrase initially.
      // backupImport must accept the backup passphrase as the new session pp.
      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx) // locked — that's fine for import
      const restored = await dest.callBackupImport(
        'alice@example.com',
        backupMessage,
        backupPassphrase,
      )

      expect(restored.fingerprint).toBe(original.fingerprint)
      expect(restored.publicArmored).toBe(original.publicArmored)

      // After import, the destination plugin should be able to decrypt
      // a message encrypted to the original public key. This is the
      // load-bearing assertion — fingerprint match alone could be
      // satisfied by a public-key-only restore.
      const ciphertext = await source.callEncryptToRecipient(
        'alice@example.com',
        original.publicArmored,
        'survives the backup',
      )
      const decrypted = await dest.callDecryptWithOwnKey(
        'alice@example.com',
        ciphertext,
        original.publicArmored,
      )
      expect(decrypted.plaintext).toBe('survives the backup')
    })

    it('rejects backup decryption with the wrong passphrase', async () => {
      const source = new TestableWebOpenPGPPlugin()
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')
      const backupMessage = await source.callBackupEncrypt(
        'alice@example.com',
        'right-backup-passphrase',
      )

      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      await expect(
        dest.callBackupImport('alice@example.com', backupMessage, 'wrong-passphrase'),
      ).rejects.toMatchObject({ code: 'wrong-passphrase' })
    })
  })

  describe('key lifecycle helpers', () => {
    it('hasNoLocalKey returns true before generation, false after', async () => {
      const plugin = new WebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      // After init, ensureIdentity ran and generated a key.
      expect(await plugin.hasNoLocalKey()).toBe(false)
    })

    it('hasNoLocalKey returns true on a freshly-installed locked plugin', async () => {
      const plugin = new WebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      // No passphrase → init catches key-locked, no key generated.
      await plugin.init(ctx)

      expect(await plugin.hasNoLocalKey()).toBe(true)
    })

    it('forgetAccount removes the stored key', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)
      await plugin.callEnsureKeyMaterial('alice@example.com')

      expect(await plugin.hasNoLocalKey()).toBe(false)
      await plugin.callForgetAccount('alice@example.com')
      expect(await plugin.hasNoLocalKey()).toBe(true)
    })
  })

  describe('unlock', () => {
    it('sets the session passphrase and decrypts the stored key', async () => {
      const backend = new InMemoryStorageBackend()
      const passphrase = 'shared-passphrase'

      // Generate a key first (this populates the storage backend).
      const setup = new WebOpenPGPPlugin()
      const setupCtx = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase(passphrase)
      await setup.init(setupCtx)
      const originalFp = setup.getOwnFingerprint()
      expect(originalFp).not.toBeNull()

      // Simulate a fresh session: clear passphrase + new plugin instance.
      clearSessionPassphrase()
      const fresh = new WebOpenPGPPlugin()
      const freshCtx = makeCtx('alice@example.com', backend).ctx
      await fresh.init(freshCtx)
      // Locked: no fingerprint yet.
      expect(fresh.getOwnFingerprint()).toBeNull()

      await fresh.unlock(passphrase)
      expect(fresh.getOwnFingerprint()).toBe(originalFp)
    })

    it('clears the session passphrase on a wrong-passphrase unlock', async () => {
      const backend = new InMemoryStorageBackend()

      const setup = new WebOpenPGPPlugin()
      const setupCtx = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase('the-real-passphrase')
      await setup.init(setupCtx)

      clearSessionPassphrase()
      const fresh = new WebOpenPGPPlugin()
      const freshCtx = makeCtx('alice@example.com', backend).ctx
      await fresh.init(freshCtx)

      await expect(fresh.unlock('wrong-pp')).rejects.toMatchObject({
        code: 'wrong-passphrase',
      })

      // After failure, the session passphrase must have been rolled back
      // so the locked state is preserved (no half-unlocked plugin).
      const { isKeyLocked } = await import('./webPassphraseStore')
      expect(isKeyLocked()).toBe(true)
    })
  })
})
