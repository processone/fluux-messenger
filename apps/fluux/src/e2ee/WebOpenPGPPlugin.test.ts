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
import type { KeyBundle } from './OpenPGPPluginBase'

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
  callBackupImportAll(jid: string, msg: string, passphrase: string) {
    return this.backupImportAll(jid, msg, passphrase)
  }
  callBackupImportSelected(jid: string, msg: string, passphrase: string, fp: string) {
    return this.backupImportSelected(jid, msg, passphrase, fp)
  }
  callSelectKeyFromBackup(bundles: KeyBundle[]) {
    return this.selectKeyFromBackup(bundles)
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
      expect(info.userIds).toContain('xmpp:alice@example.com')
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

  describe('encrypt-to-self', () => {
    it('sender can decrypt their own outgoing ciphertext', async () => {
      // Alice and Bob each get their own plugin/key.
      const alice = new TestableWebOpenPGPPlugin()
      const aliceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('alice-pp')
      await alice.init(aliceCtx)
      const aliceBundle = await alice.callEnsureKeyMaterial('alice@example.com')

      clearSessionPassphrase()
      const bob = new TestableWebOpenPGPPlugin()
      const bobCtx = makeCtx('bob@example.com').ctx
      setSessionPassphrase('bob-pp')
      await bob.init(bobCtx)
      const bobBundle = await bob.callEnsureKeyMaterial('bob@example.com')

      // Alice encrypts to Bob → should also be decryptable by Alice (encrypt-to-self).
      setSessionPassphrase('alice-pp')
      const ciphertext = await alice.callEncryptToRecipient(
        'alice@example.com',
        bobBundle.publicArmored,
        'hello bob',
      )

      // Alice decrypts her own outgoing message (MAM replay scenario).
      const selfDecrypted = await alice.callDecryptWithOwnKey(
        'alice@example.com',
        ciphertext,
        aliceBundle.publicArmored,
      )
      expect(selfDecrypted.plaintext).toBe('hello bob')

      // Bob also decrypts normally.
      setSessionPassphrase('bob-pp')
      const bobDecrypted = await bob.callDecryptWithOwnKey(
        'bob@example.com',
        ciphertext,
        aliceBundle.publicArmored,
      )
      expect(bobDecrypted.plaintext).toBe('hello bob')
    })
  })

  describe('signer fingerprint format', () => {
    it('returns the full primary cert fingerprint, not a short key ID', async () => {
      const alice = new TestableWebOpenPGPPlugin()
      const aliceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('alice-pp')
      await alice.init(aliceCtx)
      const aliceBundle = await alice.callEnsureKeyMaterial('alice@example.com')

      clearSessionPassphrase()
      const bob = new TestableWebOpenPGPPlugin()
      const bobCtx = makeCtx('bob@example.com').ctx
      setSessionPassphrase('bob-pp')
      await bob.init(bobCtx)
      const bobBundle = await bob.callEnsureKeyMaterial('bob@example.com')

      setSessionPassphrase('alice-pp')
      const ciphertext = await alice.callEncryptToRecipient(
        'alice@example.com',
        bobBundle.publicArmored,
        'signed message',
      )

      setSessionPassphrase('bob-pp')
      const decrypted = await bob.callDecryptWithOwnKey(
        'bob@example.com',
        ciphertext,
        aliceBundle.publicArmored,
      )

      expect(decrypted.signatureVerified).toBe(true)
      // Must be the full 40-char v4 fingerprint, matching Alice's primary FP.
      expect(decrypted.signerFingerprint).toMatch(/^[a-f0-9]{40}$/)
      expect(decrypted.signerFingerprint!.toLowerCase()).toBe(
        aliceBundle.fingerprint.toLowerCase(),
      )
    })
  })

  describe('backup passphrase normalization', () => {
    it('normalizes case so uppercase and lowercase codes are equivalent', async () => {
      const source = new TestableWebOpenPGPPlugin()
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      // Encrypt with uppercase backup code.
      const backupMessage = await source.callBackupEncrypt(
        'alice@example.com',
        'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW',
      )

      // Import with lowercase version — must succeed due to normalization.
      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)
      const restored = await dest.callBackupImport(
        'alice@example.com',
        backupMessage,
        'twnk-kd5y-mt3t-e1gs-drdb-kvtw',
      )
      expect(restored.fingerprint).toBeTruthy()
    })

    it('normalizes whitespace variants', async () => {
      const source = new TestableWebOpenPGPPlugin()
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt(
        'alice@example.com',
        'correct horse battery staple',
      )

      // Import with extra spaces and trailing newline — must work.
      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)
      const restored = await dest.callBackupImport(
        'alice@example.com',
        backupMessage,
        '  correct   horse  battery   staple  \n',
      )
      expect(restored.fingerprint).toBeTruthy()
    })
  })

  describe('validateCert filtering', () => {
    it('counts only encryption-capable subkeys', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')
      const info = await plugin.callValidateCert(bundle.publicArmored)

      // A freshly generated ECC key has exactly one encryption subkey.
      expect(info.encryptionSubkeyCount).toBe(1)
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

  describe('multi-TSK backup (backupImportAll / backupImportSelected)', () => {
    it('backupImportAll returns a single-element array for a single-key backup', async () => {
      const source = new TestableWebOpenPGPPlugin()
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt('alice@example.com', 'backup-pp')

      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      const bundles = await dest.callBackupImportAll('alice@example.com', backupMessage, 'backup-pp')

      expect(bundles).toHaveLength(1)
      expect(bundles[0].fingerprint).toBe(original.fingerprint)
      expect(bundles[0].publicArmored).toContain('BEGIN PGP PUBLIC KEY BLOCK')
      expect(bundles[0].createdAt).toBeTruthy()
    })

    it('backupImportSelected installs the chosen key and enables decryption', async () => {
      const source = new TestableWebOpenPGPPlugin()
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt('alice@example.com', 'backup-pp')

      // Encrypt a message that the restored key must be able to decrypt.
      const ciphertext = await source.callEncryptToRecipient(
        'alice@example.com',
        original.publicArmored,
        'round-trip via importSelected',
      )

      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      const bundles = await dest.callBackupImportAll('alice@example.com', backupMessage, 'backup-pp')
      const installed = await dest.callBackupImportSelected(
        'alice@example.com',
        backupMessage,
        'backup-pp',
        bundles[0].fingerprint,
      )

      expect(installed.fingerprint).toBe(original.fingerprint)

      const decrypted = await dest.callDecryptWithOwnKey(
        'alice@example.com',
        ciphertext,
        original.publicArmored,
      )
      expect(decrypted.plaintext).toBe('round-trip via importSelected')
    })

    it('backupImportAll rejects a wrong passphrase', async () => {
      const source = new TestableWebOpenPGPPlugin()
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt('alice@example.com', 'right-pp')

      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      await expect(
        dest.callBackupImportAll('alice@example.com', backupMessage, 'wrong-pp'),
      ).rejects.toMatchObject({ code: 'wrong-passphrase' })
    })

    it('backupImportSelected rejects an unknown fingerprint', async () => {
      const source = new TestableWebOpenPGPPlugin()
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt('alice@example.com', 'backup-pp')

      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      await dest.callBackupImportAll('alice@example.com', backupMessage, 'backup-pp')

      await expect(
        dest.callBackupImportSelected(
          'alice@example.com',
          backupMessage,
          'backup-pp',
          'nonexistent0000000000000000000000000000',
        ),
      ).rejects.toMatchObject({ code: 'not-found' })
    })

    it('multi-key backup: importAll returns both keys with distinct fingerprints', async () => {
      // Generate two independent keys and concatenate their binary TSKs
      // into a single backup blob, simulating Gajim-style multi-TSK backups.
      const { generateKey, createMessage, encrypt } = await import('openpgp')

      const { privateKey: keyA } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy' as const,
        userIDs: [{ name: 'xmpp:alice@example.com' }],
        format: 'object',
      })
      const { privateKey: keyB } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy' as const,
        userIDs: [{ name: 'xmpp:alice@example.com' }],
        format: 'object',
      })

      // Concatenate binary TSK packets (same format as Sequoia multi-TSK backup).
      const binaryA = keyA.write() as Uint8Array
      const binaryB = keyB.write() as Uint8Array
      const combined = new Uint8Array(binaryA.length + binaryB.length)
      combined.set(binaryA, 0)
      combined.set(binaryB, binaryA.length)

      const message = await createMessage({ binary: combined })
      const backupMessage = await encrypt({ message, passwords: ['multi-pp'] }) as string

      const dest = new TestableWebOpenPGPPlugin()
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      const bundles = await dest.callBackupImportAll('alice@example.com', backupMessage, 'multi-pp')

      expect(bundles).toHaveLength(2)
      expect(bundles[0].fingerprint).not.toBe(bundles[1].fingerprint)
      expect(bundles[0].createdAt).toBeTruthy()
      expect(bundles[1].createdAt).toBeTruthy()

      // Select the second key and verify it's usable for decryption.
      const installed = await dest.callBackupImportSelected(
        'alice@example.com',
        backupMessage,
        'multi-pp',
        bundles[1].fingerprint,
      )
      expect(installed.fingerprint).toBe(bundles[1].fingerprint)

      // The installed key should be able to decrypt a message encrypted to it.
      const { encrypt: enc2, readKey, createMessage: cm2 } = await import('openpgp')
      const pubKey = await readKey({ armoredKey: installed.publicArmored })
      const ct = await enc2({
        message: await cm2({ text: 'hello from multi-tsk' }),
        encryptionKeys: pubKey,
      }) as string

      const decrypted = await dest.callDecryptWithOwnKey('alice@example.com', ct, null)
      expect(decrypted.plaintext).toBe('hello from multi-tsk')
    })
  })

  describe('selectKeyFromBackup heuristic', () => {
    it('returns null for an empty bundle array', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      const result = await plugin.callSelectKeyFromBackup([])
      expect(result).toBeNull()
    })

    it('auto-selects (needsPicker=false) when there is exactly one key', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      const bundle: KeyBundle = {
        fingerprint: 'aabbccdd',
        publicArmored: 'armored-key',
        keychainBacked: false,
      }
      const result = await plugin.callSelectKeyFromBackup([bundle])

      expect(result).not.toBeNull()
      expect(result!.needsPicker).toBe(false)
      expect(result!.selected.fingerprint).toBe('aabbccdd')
    })

    it('auto-selects via metadata match when published FP matches a candidate', async () => {
      const metadataFp = 'AABBCCDD11223344'
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      ctx.xmpp.queryPEP = async (_jid: string, node: string): Promise<PEPItem[]> => {
        if (node === 'urn:xmpp:openpgp:0:public-keys') {
          return [{
            id: 'current',
            payload: {
              name: 'public-keys-list',
              attrs: { xmlns: 'urn:xmpp:openpgp:0' },
              children: [{
                name: 'pubkey-metadata',
                attrs: { 'v4-fingerprint': metadataFp, date: '2025-01-01T00:00:00Z' },
                children: [],
              }],
            },
          }]
        }
        return []
      }
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      const bundles: KeyBundle[] = [
        { fingerprint: 'OTHER000', publicArmored: 'a', keychainBacked: false, createdAt: '2025-06-01T00:00:00Z' },
        { fingerprint: metadataFp, publicArmored: 'b', keychainBacked: false, createdAt: '2024-01-01T00:00:00Z' },
      ]
      const result = await plugin.callSelectKeyFromBackup(bundles)

      expect(result).not.toBeNull()
      expect(result!.needsPicker).toBe(false)
      expect(result!.selected.fingerprint).toBe(metadataFp)
    })

    it('falls back to newest key with needsPicker=true when no metadata matches', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      const bundles: KeyBundle[] = [
        { fingerprint: 'OLDER000', publicArmored: 'a', keychainBacked: false, createdAt: '2024-01-01T00:00:00Z' },
        { fingerprint: 'NEWER000', publicArmored: 'b', keychainBacked: false, createdAt: '2025-06-01T00:00:00Z' },
      ]
      const result = await plugin.callSelectKeyFromBackup(bundles)

      expect(result).not.toBeNull()
      expect(result!.needsPicker).toBe(true)
      expect(result!.selected.fingerprint).toBe('NEWER000')
    })

    it('falls back to newest key when metadata query fails', async () => {
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      ctx.xmpp.queryPEP = async () => { throw new Error('item-not-found') }
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      const bundles: KeyBundle[] = [
        { fingerprint: 'KEY_A', publicArmored: 'a', keychainBacked: false, createdAt: '2025-03-01T00:00:00Z' },
        { fingerprint: 'KEY_B', publicArmored: 'b', keychainBacked: false, createdAt: '2025-06-01T00:00:00Z' },
      ]
      const result = await plugin.callSelectKeyFromBackup(bundles)

      expect(result).not.toBeNull()
      expect(result!.needsPicker).toBe(true)
      expect(result!.selected.fingerprint).toBe('KEY_B')
    })
  })
})
