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
  parsePayloadEnvelope,
  serializePayloadEnvelope,
  xml,
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

/**
 * Build a PluginContext whose PEP layer mimics a server holding a single
 * published OpenPGP public key fingerprint for the account. Used by the
 * silent-generation guard tests where we need ensureKeyMaterial to see a
 * non-empty server identity without committing to a real cert payload.
 */
function makeCtxWithPublishedFingerprint(
  accountJid: string,
  fingerprint: string,
): { ctx: PluginContext; backend: InMemoryStorageBackend } {
  const backend = new InMemoryStorageBackend()
  const xmpp: XMPPPrimitives = {
    sendStanza: async () => {},
    queryDisco: async () => ({
      features: [{ var: 'http://jabber.org/protocol/pubsub' }],
      identities: [{ category: 'pubsub', type: 'pep' }],
    }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    deletePEP: async () => {},
    queryPEP: async (jid, node): Promise<PEPItem[]> => {
      if (jid !== accountJid) return []
      if (node === 'urn:xmpp:openpgp:0:public-keys') {
        return [
          {
            id: 'current',
            payload: {
              name: 'public-keys-list',
              attrs: { xmlns: 'urn:xmpp:openpgp:0' },
              children: [
                {
                  name: 'pubkey-metadata',
                  attrs: { 'v4-fingerprint': fingerprint },
                  children: [],
                },
              ],
            },
          },
        ]
      }
      return []
    },
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

// ---------------------------------------------------------------------------
// Multi-device PEP fixture
// ---------------------------------------------------------------------------
// A shared in-memory PEP "server" lets multiple plugin instances probe each
// other's published OpenPGP keys without standing up a real XMPP transport.
// Both alice's devices and bob's plugin point at the same map; when one
// publishes (or the test seeds the map directly), the others see it on the
// next queryPEP.
type SharedPep = Map<string, PEPItem[]> // key: `${jid}\0${node}`

function pepKey(jid: string, node: string): string {
  return `${jid}\0${node}`
}

function makeCtxWithSharedPep(
  accountJid: string,
  shared: SharedPep,
  sharedBackend?: InMemoryStorageBackend,
): { ctx: PluginContext; backend: InMemoryStorageBackend } {
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
    queryPEP: async (jid, node): Promise<PEPItem[]> => shared.get(pepKey(jid, node)) ?? [],
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

// XEP-0373 publishes the raw (dearmored) public-key bytes inside <data>
// base64-encoded. The plugin's own `base64EncodeOpenPgpBlock` helper isn't
// exported, so we replicate the equivalent shape here for test fixtures.
function dearmorBase64ForXep0373(armored: string): string {
  const lines = armored.replace(/\r\n/g, '\n').split('\n')
  const begin = lines.findIndex((line) => /^-----BEGIN PGP [^-]+-----$/.test(line.trim()))
  const end = lines.findIndex(
    (line, index) => index > begin && /^-----END PGP [^-]+-----$/.test(line.trim()),
  )
  if (begin < 0 || end < 0) throw new Error('test: expected ASCII-armored OpenPGP block')
  let afterHeaders = false
  const body: string[] = []
  for (let i = begin + 1; i < end; i++) {
    const line = lines[i].trim()
    if (!afterHeaders) {
      if (line === '') afterHeaders = true
      continue
    }
    if (line === '' || line.startsWith('=')) continue
    body.push(line)
  }
  // The base64 body of the armor block IS the wire format the plugin
  // expects (its own helper just dearmors then re-base64s the bytes,
  // which equals the armor body modulo line breaks).
  return body.join('')
}

function publishKeyToSharedPep(shared: SharedPep, jid: string, bundle: KeyBundle): void {
  shared.set(pepKey(jid, 'urn:xmpp:openpgp:0:public-keys'), [
    {
      id: 'current',
      payload: {
        name: 'public-keys-list',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [
          {
            name: 'pubkey-metadata',
            attrs: {
              'v4-fingerprint': bundle.fingerprint,
              date: '2024-01-01T00:00:00Z',
            },
            children: [],
          },
        ],
      },
    },
  ])
  shared.set(pepKey(jid, `urn:xmpp:openpgp:0:public-keys:${bundle.fingerprint}`), [
    {
      id: 'current',
      payload: {
        name: 'pubkey',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [
          {
            name: 'data',
            attrs: {},
            children: [dearmorBase64ForXep0373(bundle.publicArmored)],
          },
        ],
      },
    },
  ])
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

    it('refuses to silent-generate when the server already advertises a public key', async () => {
      // EXACTLY Adrien's scenario. A fresh browser (empty IndexedDB) connects
      // to an account whose PEP already lists a public key (published from
      // another device). Silent generation would publish a competing key
      // fingerprint and leave any peer who encrypts to the existing one
      // unable to deliver — and the device that holds the matching private
      // key still talking to a now-stale published metadata.
      //
      // ensureKeyMaterial MUST throw `needs-identity-decision`. The caller
      // (init / unlock / dialog handlers) decides how to surface it; init
      // itself swallows the error so the plugin stays registered for the
      // user-driven resolution path (see dedicated test below).
      const { ctx } = makeCtxWithPublishedFingerprint('alice@example.com', 'a1'.repeat(20))
      const plugin = new TestableWebOpenPGPPlugin()
      // Do NOT call init() — we want to reach ensureKeyMaterial directly
      // to assert the guard's behaviour without depending on the init
      // wrapper's error-swallowing policy.
      // Instead, populate ctx manually via init() and capture the swallow.
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx)
      // After init, calling ensureKeyMaterial directly must still fail —
      // the guard is what protects the user from later code paths that
      // might bypass init (e.g. a manual retry).
      await expect(
        plugin.callEnsureKeyMaterial('alice@example.com'),
      ).rejects.toMatchObject({
        code: 'needs-identity-decision',
      })
    })

    it('init swallows needs-identity-decision so the plugin stays registered for recovery', async () => {
      // The host expects the plugin to remain available even when it
      // refuses to silent-generate: the user needs to call
      // `restoreSecretKey` / `importKeyFromFile` (or future
      // `retireAndGenerateIdentity`) through the registered plugin. If
      // init propagated, every subsequent call would have to re-register.
      const { ctx } = makeCtxWithPublishedFingerprint('alice@example.com', 'b2'.repeat(20))
      const plugin = new TestableWebOpenPGPPlugin()
      setSessionPassphrase('strong-test-passphrase-123')
      // No throw expected — the guard fires inside ensureIdentity, init
      // recognises the error code and swallows it (same shape as the
      // key-locked path).
      await expect(plugin.init(ctx)).resolves.toBeUndefined()
    })

    it('refuses to silent-generate when the server holds a backup (no public key)', async () => {
      // Symmetric edge case: the public-keys node was retracted but the
      // secret-key backup persists. Generating a fresh key here would
      // overwrite the backup the user could otherwise recover from.
      const dearmored = atob('ZmFrZS1iYWNrdXAtcGF5bG9hZA==')
      const reencoded = btoa(dearmored)
      const xmpp: XMPPPrimitives = {
        sendStanza: async () => {},
        queryDisco: async () => ({
          features: [{ var: 'http://jabber.org/protocol/pubsub' }],
          identities: [{ category: 'pubsub', type: 'pep' }],
        }),
        publishPEP: async () => {},
        retractPEP: async () => {},
        deletePEP: async () => {},
        queryPEP: async (_jid, node) => {
          if (node === 'urn:xmpp:openpgp:0:secret-key') {
            return [
              {
                id: 'current',
                payload: {
                  name: 'secretkey',
                  attrs: { xmlns: 'urn:xmpp:openpgp:0' },
                  children: [reencoded],
                },
              },
            ]
          }
          return []
        },
        subscribePEP: () => ({ unsubscribe: () => {} }),
      }
      const ctx: PluginContext = {
        storage: createPluginStorage(new InMemoryStorageBackend(), 'openpgp-test'),
        xmpp,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        account: { jid: 'alice@example.com' },
        reportSecurityContextUpdate: () => {},
      }
      const plugin = new TestableWebOpenPGPPlugin()
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx)
      await expect(
        plugin.callEnsureKeyMaterial('alice@example.com'),
      ).rejects.toMatchObject({
        code: 'needs-identity-decision',
      })
    })

    it('still generates silently when neither a backup nor a public key exists', async () => {
      // Truly fresh account — first-ever setup. The user has nothing to
      // lose by generating; the existing flow is the right path.
      const plugin = new TestableWebOpenPGPPlugin()
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx)
      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')
      expect(bundle.fingerprint).toMatch(/^[a-f0-9]{40,}$/)
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

  describe('self-outgoing carbon decrypt (multi-device, XEP-0280)', () => {
    // Multi-device scenario: alice has two devices sharing the same
    // OpenPGP private key (one `InMemoryStorageBackend` between them,
    // matching Adrien's "j'ai la même clé sur tous les devices firefox"
    // setup). Bob is a separate account. Device-A sends to Bob; the
    // server fans the message out to device-B as a XEP-0280 sent carbon.
    // device-B must decrypt the carbon, which requires (1) encrypt-to-
    // self at send time and (2) the inverted reflection check on
    // receive — without isSelfOutgoing the plugin rejects every carbon
    // because the signcrypt `<to/>` names Bob, not alice.

    async function buildMultiDeviceTriple(): Promise<{
      shared: SharedPep
      aliceDeviceA: WebOpenPGPPlugin
      aliceDeviceB: WebOpenPGPPlugin
      aliceBundle: KeyBundle
      bobBundle: KeyBundle
    }> {
      const shared: SharedPep = new Map()
      const aliceBackend = new InMemoryStorageBackend()
      const passphrase = 'alice-passphrase-strong'

      // Alice device-A — generates the account key.
      setSessionPassphrase(passphrase)
      const aliceDeviceA = new WebOpenPGPPlugin()
      const aliceACtx = makeCtxWithSharedPep('alice@example.com', shared, aliceBackend).ctx
      await aliceDeviceA.init(aliceACtx)
      // Force key generation via probePeer's underlying ensureKey.
      // Easier path: use the Testable wrapper directly.
      const aliceFromInit = new TestableWebOpenPGPPlugin()
      const aliceInitCtx = makeCtxWithSharedPep('alice@example.com', shared, aliceBackend).ctx
      await aliceFromInit.init(aliceInitCtx)
      const aliceBundle = await aliceFromInit.callEnsureKeyMaterial('alice@example.com')

      // Alice device-B — separate plugin instance, SAME backend so it
      // loads the same private key.
      clearSessionPassphrase()
      setSessionPassphrase(passphrase)
      const aliceDeviceB = new WebOpenPGPPlugin()
      const aliceBCtx = makeCtxWithSharedPep('alice@example.com', shared, aliceBackend).ctx
      await aliceDeviceB.init(aliceBCtx)
      // Force device-B to load (rather than regenerate) the existing key.
      const aliceDeviceBTestable = aliceDeviceB as unknown as {
        ensureKeyMaterial: (jid: string) => Promise<KeyBundle>
      }
      await aliceDeviceBTestable.ensureKeyMaterial('alice@example.com')

      // Bob — different identity, his own backend.
      clearSessionPassphrase()
      setSessionPassphrase('bob-passphrase-strong')
      const bob = new TestableWebOpenPGPPlugin()
      const bobCtx = makeCtxWithSharedPep('bob@example.com', shared).ctx
      await bob.init(bobCtx)
      const bobBundle = await bob.callEnsureKeyMaterial('bob@example.com')

      // Cross-publish both keys via the shared PEP so probePeer works
      // for both directions.
      publishKeyToSharedPep(shared, 'alice@example.com', aliceBundle)
      publishKeyToSharedPep(shared, 'bob@example.com', bobBundle)

      // Restore alice's passphrase as the active session for the test
      // body (otherwise encrypt/decrypt requireUnlocked will throw).
      clearSessionPassphrase()
      setSessionPassphrase(passphrase)

      return { shared, aliceDeviceA, aliceDeviceB, aliceBundle, bobBundle }
    }

    it('alice device-B decrypts a sent carbon produced by device-A (encrypt-to-self path)', async () => {
      const { aliceDeviceA, aliceDeviceB, aliceBundle, bobBundle } =
        await buildMultiDeviceTriple()
      // Suppress unused-var lint on bobBundle (it's published via the
      // helper but the test doesn't need it directly).
      void bobBundle

      // device-A probes bob (populates peerKeys for the encrypt step),
      // then encrypts via the full high-level API — produces a wire-
      // shaped <openpgp> element with a signcrypt envelope inside.
      await aliceDeviceA.probePeer('bob@example.com')
      const sendHandle = await aliceDeviceA.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      // plugin.encrypt expects the plaintext to be a serialized
      // <payload xmlns='jabber:client'> envelope (same shape Chat.ts
      // ships on the real send path).
      const plaintext = new TextEncoder().encode(
        serializePayloadEnvelope([xml('body', {}, 'hello from device-A')]),
      )
      const payload = await aliceDeviceA.encrypt(sendHandle, plaintext)
      expect(payload.protocolId).toBe('openpgp')

      // device-B receives the sent carbon. It opens the conversation
      // against bob (the RECIPIENT, mirroring what Chat.ts does for
      // sent carbons) and decrypts with isSelfOutgoing: true.
      const carbonHandle = await aliceDeviceB.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const claim = aliceDeviceB.tryClaimInbound(payload.stanzaElement)
      expect(claim).not.toBeNull()

      const decrypted = await aliceDeviceB.decrypt(carbonHandle, claim!, {
        isSelfOutgoing: true,
      })

      // The decrypted plaintext is the inner payload envelope; the
      // SDK pipeline normally lifts its children onto the stanza root.
      // Just confirm the body roundtrips.
      const envelopeXml = new TextDecoder().decode(decrypted.plaintext)
      const children = parsePayloadEnvelope(envelopeXml)!
      expect(children.find((c) => c.name === 'body')?.text()).toBe(
        'hello from device-A',
      )
      // Trust is evaluated against our own key (we signed); since we
      // hold the signing key locally the signature verifies.
      expect(decrypted.securityContext.protocolId).toBe('openpgp')
      expect(decrypted.securityContext.trust).toBe('verified')
      expect(decrypted.securityContext.notes).toBeUndefined()
      // Attribution: the carbon doesn't reveal which sibling device
      // originated the send, so the message is attributed to our bare
      // JID with our own signing fingerprint.
      expect(decrypted.senderDevice.jid).toBe('alice@example.com')
      expect(decrypted.senderDevice.deviceId).toBe(aliceBundle.fingerprint)
    })

    it('rejects a self-outgoing decrypt when the envelope <to/> does not name the conversation peer', async () => {
      // The inverted reflection check must still have teeth: with
      // isSelfOutgoing, addressees MUST include the conversation peer.
      // Opening device-B's handle against the wrong peer (charlie
      // instead of bob) must surface as envelope-reflection so a
      // tampered carbon can't be silently mis-attributed.
      const { aliceDeviceA, aliceDeviceB } = await buildMultiDeviceTriple()

      await aliceDeviceA.probePeer('bob@example.com')
      const sendHandle = await aliceDeviceA.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const payload = await aliceDeviceA.encrypt(
        sendHandle,
        new TextEncoder().encode(
          serializePayloadEnvelope([xml('body', {}, 'to bob')]),
        ),
      )

      // Open the carbon handle against the WRONG peer — the inverted
      // check should compare "is bob in addressees?" against the
      // conversation peer (charlie) and reject.
      const wrongHandle = await aliceDeviceB.openConversation({
        kind: 'direct',
        peer: 'charlie@example.com',
      })
      const claim = aliceDeviceB.tryClaimInbound(payload.stanzaElement)!
      await expect(
        aliceDeviceB.decrypt(wrongHandle, claim, { isSelfOutgoing: true }),
      ).rejects.toMatchObject({ code: 'envelope-reflection' })
    })

    it('without isSelfOutgoing, the same carbon is rejected by the default reflection check (regression baseline)', async () => {
      // This is the bug Adrien reported: pre-fix, the live carbon path
      // passed bareFrom (our own JID) as the peer and did NOT set the
      // flag. With the modern fix-pair, Chat.ts now opens against the
      // recipient AND sets isSelfOutgoing; if either step regresses
      // (e.g. Chat.ts is reverted), this test guards the plugin layer
      // by confirming the default check rejects the legitimate carbon.
      const { aliceDeviceA, aliceDeviceB } = await buildMultiDeviceTriple()

      await aliceDeviceA.probePeer('bob@example.com')
      const sendHandle = await aliceDeviceA.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const payload = await aliceDeviceA.encrypt(
        sendHandle,
        new TextEncoder().encode(
          serializePayloadEnvelope([xml('body', {}, 'hello')]),
        ),
      )

      const carbonHandle = await aliceDeviceB.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const claim = aliceDeviceB.tryClaimInbound(payload.stanzaElement)!
      // No isSelfOutgoing → default check fires.
      await expect(aliceDeviceB.decrypt(carbonHandle, claim)).rejects.toMatchObject({
        code: 'envelope-reflection',
      })
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

  describe('retireAndGenerateIdentity', () => {
    it('retracts every published fingerprint and generates a fresh key', async () => {
      // The user-driven "I can't recover the published key — replace it"
      // path of the identity choice dialog. Must:
      //   1. enumerate published fingerprints and retract each data node,
      //   2. retract the metadata node,
      //   3. clear the local key material,
      //   4. generate a fresh keypair (bypassing the silent-fork guard
      //      because the user explicitly authorised the replacement),
      //   5. publish the new data + metadata nodes.
      const oldFp1 = 'aa'.repeat(20)
      const oldFp2 = 'bb'.repeat(20)
      const retractCalls: Array<{ node: string; itemId: string }> = []
      const publishCalls: Array<{ node: string; itemId: string }> = []
      const xmpp: XMPPPrimitives = {
        sendStanza: async () => {},
        queryDisco: async () => ({
          features: [{ var: 'http://jabber.org/protocol/pubsub' }],
          identities: [{ category: 'pubsub', type: 'pep' }],
        }),
        publishPEP: async (node, item) => {
          publishCalls.push({ node, itemId: item.id })
        },
        retractPEP: async (node, itemId) => {
          retractCalls.push({ node, itemId })
        },
        deletePEP: async () => {},
        queryPEP: async (jid, node): Promise<PEPItem[]> => {
          if (jid !== 'alice@example.com') return []
          if (node === 'urn:xmpp:openpgp:0:public-keys') {
            return [
              {
                id: 'current',
                payload: {
                  name: 'public-keys-list',
                  attrs: { xmlns: 'urn:xmpp:openpgp:0' },
                  children: [
                    {
                      name: 'pubkey-metadata',
                      attrs: { 'v4-fingerprint': oldFp1 },
                      children: [],
                    },
                    {
                      name: 'pubkey-metadata',
                      attrs: { 'v4-fingerprint': oldFp2 },
                      children: [],
                    },
                  ],
                },
              },
            ]
          }
          return []
        },
        subscribePEP: () => ({ unsubscribe: () => {} }),
      }
      const ctx: PluginContext = {
        storage: createPluginStorage(new InMemoryStorageBackend(), 'openpgp-test'),
        xmpp,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        account: { jid: 'alice@example.com' },
        reportSecurityContextUpdate: () => {},
      }
      const plugin = new TestableWebOpenPGPPlugin()
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx) // init swallows needs-identity-decision

      const result = await plugin.retireAndGenerateIdentity()

      // Step 1+2: each published fingerprint and the metadata node were retracted.
      const retractedNodes = retractCalls.map((c) => c.node)
      expect(retractedNodes).toContain('urn:xmpp:openpgp:0:public-keys')
      expect(retractedNodes).toContain(`urn:xmpp:openpgp:0:public-keys:${oldFp1}`)
      expect(retractedNodes).toContain(`urn:xmpp:openpgp:0:public-keys:${oldFp2}`)

      // Step 4: a fresh fingerprint was generated.
      expect(result.fingerprint).toMatch(/^[a-f0-9]{40}$/)
      expect(result.fingerprint).not.toBe(oldFp1)
      expect(result.fingerprint).not.toBe(oldFp2)

      // Step 5: the new public key was published — both data and metadata nodes.
      const publishedNodes = publishCalls.map((c) => c.node)
      expect(publishedNodes).toContain(`urn:xmpp:openpgp:0:public-keys:${result.fingerprint}`)
      expect(publishedNodes).toContain('urn:xmpp:openpgp:0:public-keys')
    })

    it('clears the own-key-conflict alert after a successful retire', async () => {
      // Before retire, init recorded a conflict (server fp != local key
      // would conflict if we had one). After retire, server == local and
      // the conflict banner must come down on its own.
      const { ctx } = makeCtxWithPublishedFingerprint('alice@example.com', 'cc'.repeat(20))
      const plugin = new TestableWebOpenPGPPlugin()
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx)

      const { useOwnKeyConflictStore, recordOwnKeyConflict } = await import(
        '@/stores/ownKeyConflictStore'
      )
      // Simulate the conflict that the post-replace flow should clear.
      recordOwnKeyConflict({
        kind: 'primary-mismatch',
        localFingerprint: 'dd'.repeat(20),
        publishedFingerprint: 'cc'.repeat(20),
        publishedDate: '2026-05-11T00:00:00Z',
      })
      expect(useOwnKeyConflictStore.getState().conflict).not.toBeNull()

      await plugin.retireAndGenerateIdentity()
      expect(useOwnKeyConflictStore.getState().conflict).toBeNull()
    })

    it('continues to publish even when retract fails (best-effort)', async () => {
      // PEP retract can fail for many transient reasons; the new
      // publication will overwrite the metadata regardless, so a retract
      // failure must NOT block regeneration.
      let publishedNew = false
      const xmpp: XMPPPrimitives = {
        sendStanza: async () => {},
        queryDisco: async () => ({
          features: [{ var: 'http://jabber.org/protocol/pubsub' }],
          identities: [{ category: 'pubsub', type: 'pep' }],
        }),
        publishPEP: async (node) => {
          if (node === 'urn:xmpp:openpgp:0:public-keys') publishedNew = true
        },
        retractPEP: async () => {
          throw new Error('item-not-found')
        },
        deletePEP: async () => {},
        queryPEP: async (_jid, node): Promise<PEPItem[]> => {
          if (node === 'urn:xmpp:openpgp:0:public-keys') {
            return [
              {
                id: 'current',
                payload: {
                  name: 'public-keys-list',
                  attrs: { xmlns: 'urn:xmpp:openpgp:0' },
                  children: [
                    {
                      name: 'pubkey-metadata',
                      attrs: { 'v4-fingerprint': 'ee'.repeat(20) },
                      children: [],
                    },
                  ],
                },
              },
            ]
          }
          return []
        },
        subscribePEP: () => ({ unsubscribe: () => {} }),
      }
      const ctx: PluginContext = {
        storage: createPluginStorage(new InMemoryStorageBackend(), 'openpgp-test'),
        xmpp,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        account: { jid: 'alice@example.com' },
        reportSecurityContextUpdate: () => {},
      }
      const plugin = new TestableWebOpenPGPPlugin()
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx)

      const result = await plugin.retireAndGenerateIdentity()
      expect(result.fingerprint).toMatch(/^[a-f0-9]{40}$/)
      expect(publishedNew).toBe(true)
    })
  })
})
