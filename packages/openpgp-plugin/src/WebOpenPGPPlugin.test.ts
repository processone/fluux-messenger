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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryStorageBackend,
  createPluginStorage,
  parsePayloadEnvelope,
  serializePayloadEnvelope,
  xml,
  type PEPItem,
  type PluginContext,
  type XMLElementData,
  type XMPPPrimitives,
} from '@fluux/sdk'
import { WebOpenPGPPlugin } from './WebOpenPGPPlugin'
import { clearSessionPassphrase, setSessionPassphrase } from './webPassphraseStore'
import type { KeyBundle } from './OpenPGPPluginBase'
import { createMockHostStores, type MockHostStores } from './testing/mockHostStores'

const FIXTURES_DIR = resolve(__dirname, 'fixtures')

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
  callBuildExportArmor(passphrase: string) {
    return this.buildExportArmor(passphrase)
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

function makeCtxWithWritablePep(
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
    publishPEP: async (node, item) => {
      shared.set(pepKey(accountJid, node), [{ id: item.id, payload: item.payload }])
    },
    retractPEP: async (node) => { shared.delete(pepKey(accountJid, node)) },
    deletePEP: async (node) => { shared.delete(pepKey(accountJid, node)) },
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

// Fresh mock host adapter per test — the migration's equivalent of resetting
// every singleton store the plugin touches (pinned primary fingerprints,
// verified peers, key-change alerts, own-key conflict, trust-state status).
// Shared by every construction site in a given test so multiple plugin
// instances (e.g. alice's two devices) observe the same trust state, exactly
// as they did against the real (singleton) app stores pre-migration.
let hostStores: MockHostStores

beforeEach(async () => {
  localStorage.clear()
  hostStores = createMockHostStores()
  clearSessionPassphrase()
})

afterEach(() => {
  clearSessionPassphrase()
})

describe('WebOpenPGPPlugin', () => {
  describe('ensureKeyMaterial', () => {
    it('throws key-locked when no session passphrase is set', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      await plugin.init(ctx)

      await expect(plugin.callEnsureKeyMaterial('alice@example.com')).rejects.toMatchObject({
        code: 'key-locked',
      })
    })

    it('generates a new key when none is stored and a passphrase is set', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)

      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')
      // v4 ECC fingerprint is 40 hex chars (SHA-1). openpgp.js emits lowercase.
      expect(bundle.fingerprint).toMatch(/^[a-f0-9]{40}$/)
      expect(bundle.publicArmored).toContain('BEGIN PGP PUBLIC KEY BLOCK')
      expect(bundle.keychainBacked).toBe(false)
    })

    it('publishes the own public-key node id and v4/v6-fingerprint in upper-case (XEP-0373 §4.1, issue #528)', async () => {
      const shared: SharedPep = new Map()
      setSessionPassphrase('hunter2-strong-passphrase')
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      // init() → ensureIdentity() generates the key and publishes both PEP nodes.
      await plugin.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)
      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')

      // The internal bundle representation stays lower-case (openpgp.js form);
      // only the wire form is upper-cased.
      expect(bundle.fingerprint).toMatch(/^[a-f0-9]{40}$/)
      const upper = bundle.fingerprint.toUpperCase()

      // Metadata node: a v4 (40-hex) key advertises v4-fingerprint in
      // upper-case hex and must NOT advertise a (malformed 40-hex)
      // v6-fingerprint.
      const metaItems = shared.get(pepKey('alice@example.com', 'urn:xmpp:openpgp:0:public-keys'))
      expect(metaItems).toBeDefined()
      const pubkeyMeta = (metaItems![0].payload as XMLElementData).children.find(
        (c): c is XMLElementData => typeof c !== 'string' && c.name === 'pubkey-metadata',
      )
      expect(pubkeyMeta?.attrs['v4-fingerprint']).toBe(upper)
      expect(pubkeyMeta?.attrs['v6-fingerprint']).toBeUndefined()
      expect(pubkeyMeta?.attrs['v4-fingerprint']).toMatch(/^[A-F0-9]{40}$/)

      // Data node id must use the same upper-case fingerprint, never the lower-case one.
      expect(
        shared.has(pepKey('alice@example.com', `urn:xmpp:openpgp:0:public-keys:${upper}`)),
      ).toBe(true)
      expect(
        shared.has(
          pepKey('alice@example.com', `urn:xmpp:openpgp:0:public-keys:${bundle.fingerprint}`),
        ),
      ).toBe(false)
    })

    it('does not generate or store a key when the server lacks PEP support', async () => {
      // Ordering guard for the no-PEP path (issue #414): the probe in
      // ensureIdentity must run BEFORE ensureKeyMaterial, so a server
      // that can never host the published key doesn't end up with an
      // orphan private key parked in IndexedDB.
      const plugin = new WebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      ctx.xmpp.queryDisco = async () => ({ features: [], identities: [] })

      await expect(plugin.init(ctx)).rejects.toThrow(/does not advertise PEP/)

      expect(await plugin.hasNoLocalKey()).toBe(true)
      expect(plugin.getOwnFingerprint()).toBeNull()
    })

    it('loads the same key on re-init with the same passphrase', async () => {
      const backend = new InMemoryStorageBackend()
      const passphrase = 'hunter2-strong-passphrase'

      // First instance: generate.
      const first = new TestableWebOpenPGPPlugin({ hostStores })
      const ctx1 = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase(passphrase)
      await first.init(ctx1)
      const firstBundle = await first.callEnsureKeyMaterial('alice@example.com')

      // Simulate a page reload: new plugin, same backend, same passphrase.
      clearSessionPassphrase()
      const second = new TestableWebOpenPGPPlugin({ hostStores })
      const ctx2 = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase(passphrase)
      await second.init(ctx2)
      const secondBundle = await second.callEnsureKeyMaterial('alice@example.com')

      expect(secondBundle.fingerprint).toBe(firstBundle.fingerprint)
      expect(secondBundle.publicArmored).toBe(firstBundle.publicArmored)
    })

    it('rejects a wrong passphrase with wrong-passphrase code', async () => {
      const backend = new InMemoryStorageBackend()
      const first = new TestableWebOpenPGPPlugin({ hostStores })
      const ctx1 = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase('correct-passphrase-123')
      await first.init(ctx1)
      await first.callEnsureKeyMaterial('alice@example.com')

      // Same backend, different passphrase → init() reaches ensureIdentity
      // which propagates wrong-passphrase (only key-locked is swallowed).
      clearSessionPassphrase()
      const second = new TestableWebOpenPGPPlugin({ hostStores })
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx)
      const bundle = await plugin.callEnsureKeyMaterial('alice@example.com')
      expect(bundle.fingerprint).toMatch(/^[a-f0-9]{40,}$/)
    })
  })

  describe('crypto round-trip', () => {
    it('encryptToRecipient → decryptWithOwnKey returns the original plaintext', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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

    it('decrypt rejects a structurally malformed ciphertext as permanent malformed-data (never retried)', async () => {
      // A payload whose bytes are not valid OpenPGP (e.g. legacy/corrupt
      // test-era ciphertext) makes openpgp.js readMessage throw "Error during
      // parsing … does not conform to a valid OpenPGP format". That is
      // terminal, so the plugin must surface a permanent 'malformed-data'
      // E2EEPluginError — the SDK uses that to stop re-stashing it for retry.
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)
      await plugin.callEnsureKeyMaterial('alice@example.com')

      const garbageB64 = Buffer.from('this is not an OpenPGP message at all').toString('base64')
      const claim = plugin.tryClaimInbound({
        name: 'openpgp',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [garbageB64],
      })!
      const handle = await plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })

      await expect(plugin.decrypt(handle, claim)).rejects.toMatchObject({
        kind: 'permanent',
        code: 'malformed-data',
      })
    })

    it('decrypts without a sender public key (no verification possible)', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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

  describe('clock skew tolerance', () => {
    it('verifies a signature created slightly in the future (signer clock ahead)', async () => {
      // Regression for the "[Message rejected: invalid signature]" reports:
      // openpgp.js rejects a signature whose creation time is after the
      // verifier's clock ("Signature creation time is in the future") with
      // zero tolerance. When the sender's machine clock is a little ahead,
      // a freshly-signed message fails to verify. The verifier must allow a
      // small clock-skew window.
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)
      const ownBundle = await plugin.callEnsureKeyMaterial('alice@example.com')

      // A peer signs a message addressed to us, but their clock is 2 minutes
      // ahead of ours.
      const { generateKey, createMessage, encrypt, readKey } = await import('openpgp')
      const { privateKey: senderPriv } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'xmpp:bob@example.com' }],
        format: 'object',
      })
      const twoMinutesAhead = new Date(Date.now() + 2 * 60 * 1000)
      const ciphertext = await encrypt({
        message: await createMessage({ text: 'hello from a fast clock' }),
        encryptionKeys: await readKey({ armoredKey: ownBundle.publicArmored }),
        signingKeys: senderPriv,
        date: twoMinutesAhead,
        format: 'armored',
      })

      const decrypted = await plugin.callDecryptWithOwnKey(
        'bob@example.com',
        ciphertext,
        senderPriv.toPublic().armor(),
      )

      expect(decrypted.plaintext).toBe('hello from a fast clock')
      expect(decrypted.signaturePresent).toBe(true)
      expect(decrypted.signatureVerified).toBe(true)
    })

    it('still rejects a signature dated far beyond the skew tolerance', async () => {
      // Guard: the skew tolerance must stay bounded — a signature created
      // grossly in the future (well past the tolerance window) is still not
      // trusted. This distinguishes "allow modest skew" from "disable the
      // creation-time check entirely".
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)
      const ownBundle = await plugin.callEnsureKeyMaterial('alice@example.com')

      const { generateKey, createMessage, encrypt, readKey } = await import('openpgp')
      const { privateKey: senderPriv } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'xmpp:bob@example.com' }],
        format: 'object',
      })
      const thirtyDaysAhead = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      const ciphertext = await encrypt({
        message: await createMessage({ text: 'far-future forgery attempt' }),
        encryptionKeys: await readKey({ armoredKey: ownBundle.publicArmored }),
        signingKeys: senderPriv,
        date: thirtyDaysAhead,
        format: 'armored',
      })

      const decrypted = await plugin.callDecryptWithOwnKey(
        'bob@example.com',
        ciphertext,
        senderPriv.toPublic().armor(),
      )

      expect(decrypted.signaturePresent).toBe(true)
      expect(decrypted.signatureVerified).toBe(false)
    })

    it('flags a beyond-tolerance future signature as not-yet-valid (transient, retryable)', async () => {
      // A signature dated past the skew window fails to verify, but the cause
      // is a clock difference, not a bad key — so it must be marked transient
      // so the upper layer can retry it rather than reject it permanently.
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)
      const ownBundle = await plugin.callEnsureKeyMaterial('alice@example.com')

      const { generateKey, createMessage, encrypt, readKey } = await import('openpgp')
      const { privateKey: senderPriv } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'xmpp:bob@example.com' }],
        format: 'object',
      })
      const twoHoursAhead = new Date(Date.now() + 2 * 60 * 60 * 1000)
      const ciphertext = await encrypt({
        message: await createMessage({ text: 'too far in the future' }),
        encryptionKeys: await readKey({ armoredKey: ownBundle.publicArmored }),
        signingKeys: senderPriv,
        date: twoHoursAhead,
        format: 'armored',
      })

      const decrypted = await plugin.callDecryptWithOwnKey(
        'bob@example.com',
        ciphertext,
        senderPriv.toPublic().armor(),
      )

      expect(decrypted.signatureVerified).toBe(false)
      expect(decrypted.signatureNotYetValid).toBe(true)
    })

    it('does NOT flag a genuine key mismatch as not-yet-valid (permanent)', async () => {
      // Signature made by one key, verified against a different key → a real
      // failure that must stay permanent (not retried, not self-healing).
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('hunter2-strong-passphrase')
      await plugin.init(ctx)
      const ownBundle = await plugin.callEnsureKeyMaterial('alice@example.com')

      const { generateKey, createMessage, encrypt, readKey } = await import('openpgp')
      const { privateKey: actualSigner } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'xmpp:bob@example.com' }],
        format: 'object',
      })
      const { privateKey: wrongKey } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'xmpp:mallory@example.com' }],
        format: 'object',
      })
      const ciphertext = await encrypt({
        message: await createMessage({ text: 'signed by the wrong key' }),
        encryptionKeys: await readKey({ armoredKey: ownBundle.publicArmored }),
        signingKeys: actualSigner,
        format: 'armored',
      })

      const decrypted = await plugin.callDecryptWithOwnKey(
        'bob@example.com',
        ciphertext,
        wrongKey.toPublic().armor(), // verify against a different key
      )

      expect(decrypted.signatureVerified).toBe(false)
      expect(decrypted.signatureNotYetValid).toBeFalsy()
    })
  })

  describe('validateCert', () => {
    it('returns the fingerprint and a positive subkey count for a generated key', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const source = new TestableWebOpenPGPPlugin({ hostStores })
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
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
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
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')
      const backupMessage = await source.callBackupEncrypt(
        'alice@example.com',
        'right-backup-passphrase',
      )

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      await expect(
        dest.callBackupImport('alice@example.com', backupMessage, 'wrong-passphrase'),
      ).rejects.toMatchObject({ code: 'wrong-passphrase' })
    })
  })

  describe('file export header', () => {
    it('exported armor carries Passphrase-Format: xep0373 and round-trips', async () => {
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('source-session-pp')
      await source.init(sourceCtx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')

      const exported = await source.callBuildExportArmor('correct horse battery staple eight words ok')
      expect(exported).toContain('-----BEGIN PGP MESSAGE-----')
      expect(exported).toMatch(/Passphrase-Format: xep0373/)

      // The header must not break import: a fresh plugin recovers the key.
      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)
      const restored = await dest.callBackupImport(
        'alice@example.com',
        exported,
        'correct horse battery staple eight words ok',
      )
      expect(restored.fingerprint).toBe(original.fingerprint)
    })

    it('backupEncrypt output (PEP/server backup) carries NO Passphrase-Format header', async () => {
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('source-session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      const raw = await source.callBackupEncrypt('alice@example.com', 'some passphrase here ok eight')
      expect(raw).toContain('-----BEGIN PGP MESSAGE-----')
      expect(raw).not.toContain('Passphrase-Format')
    })
  })

  describe('key version handling', () => {
    // XEP-0373 §6.1 mandates accepting "v4 (or higher)" packets, and the whole
    // stack (Sequoia generate/rotate/storage, fingerprint-length handling) is
    // built for v6, so v6 keys MUST import, not be rejected. We generate v4
    // today (USE_V6_KEYS=false) only for peer interop; that governs generation,
    // not what we accept. Guard against regressing to a v6 rejection.
    it('imports an OpenPGP v6 key (the stack is v6-capable)', async () => {
      const openpgp = await import('openpgp')
      const { privateKey: v6 } = await openpgp.generateKey({
        type: 'curve25519',
        userIDs: [{ name: 'xmpp:v6@example.com' }],
        format: 'object',
        config: { v6Keys: true },
      })
      expect(v6.keyPacket.version).toBe(6) // guard: we really generated a v6 key

      const backup = (await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: v6.write() as Uint8Array }),
        passwords: ['pw'],
      })) as string

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('v6@example.com')
      await dest.init(ctx)

      const bundles = await dest.callBackupImportAll('v6@example.com', backup, 'pw')
      expect(bundles.map((b) => b.fingerprint)).toContain(v6.getFingerprint())
    })

    it('accepts a v4 imported key', async () => {
      const openpgp = await import('openpgp')
      const { privateKey: v4 } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'xmpp:v4@example.com' }],
        format: 'object',
      })
      expect(v4.keyPacket.version).toBe(4)

      const backup = (await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: v4.write() as Uint8Array }),
        passwords: ['pw'],
      })) as string

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('v4@example.com')
      await dest.init(ctx)

      const bundles = await dest.callBackupImportAll('v4@example.com', backup, 'pw')
      expect(bundles.map((b) => b.fingerprint)).toContain(v4.getFingerprint())
    })
  })

  describe('import adds the XEP-0373 xmpp: User ID', () => {
    // XEP-0373 §8.5 requires the key to carry an `xmpp:<jid>` User ID (the trust
    // anchor peers verify). A foreign key (GnuPG/OpenKeychain) has only a
    // `Name <email>` UID, so import must self-sign the `xmpp:` UID onto it,
    // keeping the primary-key fingerprint so trust pinning still works.
    it('self-signs an xmpp:<jid> UID onto an imported key that lacks one', async () => {
      const openpgp = await import('openpgp')
      const { privateKey: foreign } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'Imported User', email: 'imported@example.org' }],
        format: 'object',
      })
      const fp = foreign.getFingerprint()
      expect(foreign.getUserIDs().some((u) => u.startsWith('xmpp:'))).toBe(false)

      const backup = (await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: foreign.write() as Uint8Array }),
        passwords: ['pw'],
      })) as string

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('imported@example.com')
      await dest.init(ctx)

      const bundles = await dest.callBackupImportAll('imported@example.com', backup, 'pw')
      const installed = await dest.callBackupImportSelected(
        'imported@example.com',
        backup,
        'pw',
        bundles[0].fingerprint,
      )

      // Fingerprint preserved (trust pinning); canonicalized to xmpp:-only,
      // so the foreign name/email UID is dropped.
      expect(installed.fingerprint).toBe(fp)
      const info = await dest.callValidateCert(installed.publicArmored)
      expect(info.userIds).toEqual(['xmpp:imported@example.com'])
    })

    it('leaves a key that already has the xmpp: UID unchanged', async () => {
      const openpgp = await import('openpgp')
      const { privateKey: own } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'xmpp:already@example.com' }],
        format: 'object',
      })
      const fp = own.getFingerprint()

      const backup = (await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: own.write() as Uint8Array }),
        passwords: ['pw'],
      })) as string

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('already@example.com')
      await dest.init(ctx)

      const bundles = await dest.callBackupImportAll('already@example.com', backup, 'pw')
      const installed = await dest.callBackupImportSelected(
        'already@example.com',
        backup,
        'pw',
        bundles[0].fingerprint,
      )

      expect(installed.fingerprint).toBe(fp)
      const info = await dest.callValidateCert(installed.publicArmored)
      expect(info.userIds).toEqual(['xmpp:already@example.com'])
    })
  })

  describe('key lifecycle helpers', () => {
    it('hasNoLocalKey returns true before generation, false after', async () => {
      const plugin = new WebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      // After init, ensureIdentity ran and generated a key.
      expect(await plugin.hasNoLocalKey()).toBe(false)
    })

    it('hasNoLocalKey returns true on a freshly-installed locked plugin', async () => {
      const plugin = new WebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      // No passphrase → init catches key-locked, no key generated.
      await plugin.init(ctx)

      expect(await plugin.hasNoLocalKey()).toBe(true)
    })

    it('forgetAccount removes the stored key', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const aliceDeviceA = new WebOpenPGPPlugin({ hostStores })
      const aliceACtx = makeCtxWithSharedPep('alice@example.com', shared, aliceBackend).ctx
      await aliceDeviceA.init(aliceACtx)
      // Force key generation via probePeer's underlying ensureKey.
      // Easier path: use the Testable wrapper directly.
      const aliceFromInit = new TestableWebOpenPGPPlugin({ hostStores })
      const aliceInitCtx = makeCtxWithSharedPep('alice@example.com', shared, aliceBackend).ctx
      await aliceFromInit.init(aliceInitCtx)
      const aliceBundle = await aliceFromInit.callEnsureKeyMaterial('alice@example.com')

      // Alice device-B — separate plugin instance, SAME backend so it
      // loads the same private key.
      clearSessionPassphrase()
      setSessionPassphrase(passphrase)
      const aliceDeviceB = new WebOpenPGPPlugin({ hostStores })
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
      const bob = new TestableWebOpenPGPPlugin({ hostStores })
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
      const alice = new TestableWebOpenPGPPlugin({ hostStores })
      const aliceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('alice-pp')
      await alice.init(aliceCtx)
      const aliceBundle = await alice.callEnsureKeyMaterial('alice@example.com')

      clearSessionPassphrase()
      const bob = new TestableWebOpenPGPPlugin({ hostStores })
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

  describe('encrypt — missing peer key', () => {
    it('throws E2EEPluginError with code peer-key-missing when peerKeys has no entry for the peer', async () => {
      const alice = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('alice-pp')
      await alice.init(ctx)
      // Generate alice's own key so requireCtx() and requireUnlocked() pass.
      await alice.callEnsureKeyMaterial('alice@example.com')

      // Open a conversation with bob WITHOUT probing him first, so peerKeys
      // has no entry for bob@example.com.
      const handle = await alice.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const plaintext = new TextEncoder().encode('<payload/>')

      await expect(alice.encrypt(handle, plaintext)).rejects.toMatchObject({
        code: 'peer-key-missing',
        kind: 'transient',
      })
    })
  })

  describe('signer fingerprint format', () => {
    it('returns the full primary cert fingerprint, not a short key ID', async () => {
      const alice = new TestableWebOpenPGPPlugin({ hostStores })
      const aliceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('alice-pp')
      await alice.init(aliceCtx)
      const aliceBundle = await alice.callEnsureKeyMaterial('alice@example.com')

      clearSessionPassphrase()
      const bob = new TestableWebOpenPGPPlugin({ hostStores })
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

  describe('backup passphrase is used verbatim (#1021)', () => {
    it('imports with the exact code, rejects a case-folded one', async () => {
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      const code = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'
      const backupMessage = await source.callBackupEncrypt('alice@example.com', code)

      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      await dest.init(makeCtx('alice@example.com').ctx)
      // Case-folding is NOT forgiven — the passphrase is opaque key
      // material used byte-for-byte, like every other XEP-0373 client.
      await expect(
        dest.callBackupImport('alice@example.com', backupMessage, code.toLowerCase()),
      ).rejects.toMatchObject({ code: 'wrong-passphrase' })

      const restored = await dest.callBackupImport('alice@example.com', backupMessage, code)
      expect(restored.fingerprint).toBeTruthy()
    })

    it('forgives surrounding whitespace only (paste artifacts)', async () => {
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt(
        'alice@example.com',
        'correct horse battery staple',
      )

      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      await dest.init(makeCtx('alice@example.com').ctx)
      const restored = await dest.callBackupImport(
        'alice@example.com',
        backupMessage,
        '  correct horse battery staple\n',
      )
      expect(restored.fingerprint).toBeTruthy()
    })
  })

  describe('validateCert filtering', () => {
    it('counts only encryption-capable subkeys', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const setup = new WebOpenPGPPlugin({ hostStores })
      const setupCtx = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase(passphrase)
      await setup.init(setupCtx)
      const originalFp = setup.getOwnFingerprint()
      expect(originalFp).not.toBeNull()

      // Simulate a fresh session: clear passphrase + new plugin instance.
      clearSessionPassphrase()
      const fresh = new WebOpenPGPPlugin({ hostStores })
      const freshCtx = makeCtx('alice@example.com', backend).ctx
      await fresh.init(freshCtx)
      // Locked: no fingerprint yet.
      expect(fresh.getOwnFingerprint()).toBeNull()

      await fresh.unlock(passphrase)
      expect(fresh.getOwnFingerprint()).toBe(originalFp)
    })

    it('clears the session passphrase on a wrong-passphrase unlock (no backup available)', async () => {
      const backend = new InMemoryStorageBackend()

      const setup = new WebOpenPGPPlugin({ hostStores })
      const setupCtx = makeCtx('alice@example.com', backend).ctx
      setSessionPassphrase('the-real-passphrase')
      await setup.init(setupCtx)

      clearSessionPassphrase()
      const fresh = new WebOpenPGPPlugin({ hostStores })
      const freshCtx = makeCtx('alice@example.com', backend).ctx
      await fresh.init(freshCtx)

      // With no server backup, a wrong passphrase surfaces as
      // NoRecoveryAvailableError (local decrypt failed + no backup to fall
      // back to). The session passphrase must still be rolled back.
      const { NoRecoveryAvailableError } = await import('./recoveryErrors')
      await expect(fresh.unlock('wrong-pp')).rejects.toBeInstanceOf(NoRecoveryAvailableError)

      // After failure, the session passphrase must have been rolled back
      // so the locked state is preserved (no half-unlocked plugin).
      const { isKeyLocked } = await import('./webPassphraseStore')
      expect(isKeyLocked()).toBe(true)
    })
  })

  describe('multi-TSK backup (backupImportAll / backupImportSelected)', () => {
    it('backupImportAll returns a single-element array for a single-key backup', async () => {
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt('alice@example.com', 'backup-pp')

      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      const bundles = await dest.callBackupImportAll('alice@example.com', backupMessage, 'backup-pp')

      expect(bundles).toHaveLength(1)
      expect(bundles[0].fingerprint).toBe(original.fingerprint)
      expect(bundles[0].publicArmored).toContain('BEGIN PGP PUBLIC KEY BLOCK')
      expect(bundles[0].createdAt).toBeTruthy()
    })

    it('backupImportSelected installs the chosen key and enables decryption', async () => {
      const source = new TestableWebOpenPGPPlugin({ hostStores })
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
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
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
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt('alice@example.com', 'right-pp')

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const destCtx = makeCtx('alice@example.com').ctx
      await dest.init(destCtx)

      await expect(
        dest.callBackupImportAll('alice@example.com', backupMessage, 'wrong-pp'),
      ).rejects.toMatchObject({ code: 'wrong-passphrase' })
    })

    it('backupImportSelected rejects an unknown fingerprint', async () => {
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      const sourceCtx = makeCtx('alice@example.com').ctx
      setSessionPassphrase('session-pp')
      await source.init(sourceCtx)
      await source.callEnsureKeyMaterial('alice@example.com')

      const backupMessage = await source.callBackupEncrypt('alice@example.com', 'backup-pp')

      clearSessionPassphrase()
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
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

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
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

  describe('raw private key import (gpg --export-secret-keys)', () => {
    it('rejects a raw armored TSK with wrong passphrase', async () => {
      const { generateKey } = await import('openpgp')
      const { privateKey } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy' as const,
        userIDs: [{ name: 'Bob', email: 'bob@example.com' }],
        passphrase: 'correct-horse-battery-staple',
        format: 'object',
      })
      const armoredPrivateKey = privateKey.armor()

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('bob@example.com')
      await dest.init(ctx)

      await expect(
        dest.callBackupImportAll('bob@example.com', armoredPrivateKey, 'wrong-passphrase'),
      ).rejects.toMatchObject({ code: 'wrong-passphrase', kind: 'permanent' })
    })

    it('rejects a public-key block (neither MESSAGE nor PRIVATE KEY BLOCK)', async () => {
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('carol@example.com')
      await dest.init(ctx)
      const garbage = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQGN...\n-----END PGP PUBLIC KEY BLOCK-----\n`

      await expect(
        dest.callBackupImportAll('carol@example.com', garbage, 'any'),
      ).rejects.toMatchObject({ code: 'malformed-data', kind: 'permanent' })
    })

    it('rejects an unparseable private-key block', async () => {
      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('dave@example.com')
      await dest.init(ctx)
      const broken = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nnot-real-base64-data\n-----END PGP PRIVATE KEY BLOCK-----\n`

      await expect(
        dest.callBackupImportAll('dave@example.com', broken, 'any'),
      ).rejects.toMatchObject({ code: 'malformed-data', kind: 'permanent' })
    })

    it('rejects a key with no encryption-capable subkey (e.g. DSA sign-only)', async () => {
      // Synthesize a sign-only key by generating a normal key then stripping
      // its subkeys. openpgp.js will then reject getEncryptionKey().
      const { generateKey } = await import('openpgp')
      const { privateKey } = await generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy' as const,
        userIDs: [{ name: 'Eve', email: 'eve@example.com' }],
        passphrase: 'pw',
        format: 'object',
      })
      privateKey.subkeys = []
      const armoredPrivateKey = privateKey.armor()

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('eve@example.com')
      await dest.init(ctx)

      await expect(
        dest.callBackupImportAll('eve@example.com', armoredPrivateKey, 'pw'),
      ).rejects.toMatchObject({ code: 'unsupported-key-algorithm', kind: 'permanent' })
    })

    it('imports a real GnuPG-produced armored TSK (interop fixture)', async () => {
      // Fixture: `gnupg_modern_key.asc` was generated with real GnuPG
      // (gpg 2.5.18) via:
      //   gpg --quick-gen-key '…' ed25519 default 0
      //   gpg --quick-add-key <FP> cv25519 encr 0
      //   gpg --export-secret-keys --armor <FP>
      // Primary key: ed25519 (sign+certify), subkey: cv25519 (encrypt).
      // Passphrase set at generation: 'fluux-fixture-passphrase'. Proves
      // openpgp.js can parse and unlock secret keys produced by a real
      // GnuPG export, not just keys we round-trip through ourselves.
      const armoredPrivateKey = readFileSync(
        resolve(FIXTURES_DIR, 'gnupg_modern_key.asc'),
        'utf-8',
      )
      expect(armoredPrivateKey.startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toBe(true)

      const dest = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('fixture@fluux.test')
      await dest.init(ctx)

      const bundles = await dest.callBackupImportAll(
        'fixture@fluux.test',
        armoredPrivateKey,
        'fluux-fixture-passphrase',
      )

      expect(bundles).toHaveLength(1)
      expect(bundles[0].fingerprint.toUpperCase()).toBe(
        'E7DFB4979F5F2745B2B113B65DD61AB5E88A475B',
      )
      expect(bundles[0].publicArmored).toContain('BEGIN PGP PUBLIC KEY BLOCK')
    })
  })

  describe('selectKeyFromBackup heuristic', () => {
    it('returns null for an empty bundle array', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      const { ctx } = makeCtx('alice@example.com')
      setSessionPassphrase('session-pp')
      await plugin.init(ctx)

      const result = await plugin.callSelectKeyFromBackup([])
      expect(result).toBeNull()
    })

    it('auto-selects (needsPicker=false) when there is exactly one key', async () => {
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
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
      // The data node id uses the XEP-0373 §4.1 upper-case fingerprint (issue #528).
      const publishedNodes = publishCalls.map((c) => c.node)
      expect(publishedNodes).toContain(
        `urn:xmpp:openpgp:0:public-keys:${result.fingerprint.toUpperCase()}`,
      )
      expect(publishedNodes).toContain('urn:xmpp:openpgp:0:public-keys')
    })

    it('clears the own-key-conflict alert after a successful retire', async () => {
      // Before retire, init recorded a conflict (server fp != local key
      // would conflict if we had one). After retire, server == local and
      // the conflict banner must come down on its own.
      const { ctx } = makeCtxWithPublishedFingerprint('alice@example.com', 'cc'.repeat(20))
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx)

      // Simulate the conflict that the post-replace flow should clear.
      hostStores.ownKeyConflict.record({
        kind: 'primary-mismatch',
        localFingerprint: 'dd'.repeat(20),
        publishedFingerprint: 'cc'.repeat(20),
        publishedDate: '2026-05-11T00:00:00Z',
      })
      expect(hostStores.ownKeyConflict.get()).not.toBeNull()

      await plugin.retireAndGenerateIdentity()
      expect(hostStores.ownKeyConflict.get()).toBeNull()
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
      const plugin = new TestableWebOpenPGPPlugin({ hostStores })
      setSessionPassphrase('strong-test-passphrase-123')
      await plugin.init(ctx)

      const result = await plugin.retireAndGenerateIdentity()
      expect(result.fingerprint).toMatch(/^[a-f0-9]{40}$/)
      expect(publishedNew).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Signature enforcement & trust (mirrors SequoiaPgpPlugin coverage)
  // -------------------------------------------------------------------------

  describe('signature enforcement and trust', () => {
    interface ActorCtx {
      plugin: WebOpenPGPPlugin
      testable: TestableWebOpenPGPPlugin
      ctx: PluginContext
      bundle: KeyBundle
      securityUpdates: Array<{
        peer: string
        messageId: string
        securityContext: { protocolId: string; trust: string; notes?: string[] }
        body?: string
      }>
    }

    async function buildCrossPublishedPair(): Promise<{
      shared: SharedPep
      alice: ActorCtx
      bob: ActorCtx
    }> {
      const shared: SharedPep = new Map()

      setSessionPassphrase('alice-strong-pp')
      const alicePlugin = new TestableWebOpenPGPPlugin({ hostStores })
      const aliceSecUpdates: ActorCtx['securityUpdates'] = []
      const aliceRaw = makeCtxWithSharedPep('alice@example.com', shared)
      const aliceCtx: PluginContext = {
        ...aliceRaw.ctx,
        reportSecurityContextUpdate: (u) => aliceSecUpdates.push(u as ActorCtx['securityUpdates'][0]),
      }
      await alicePlugin.init(aliceCtx)
      const aliceBundle = await alicePlugin.callEnsureKeyMaterial('alice@example.com')
      publishKeyToSharedPep(shared, 'alice@example.com', aliceBundle)

      clearSessionPassphrase()
      setSessionPassphrase('bob-strong-pp')
      const bobPlugin = new TestableWebOpenPGPPlugin({ hostStores })
      const bobSecUpdates: ActorCtx['securityUpdates'] = []
      const bobRaw = makeCtxWithSharedPep('bob@example.com', shared)
      const bobCtx: PluginContext = {
        ...bobRaw.ctx,
        reportSecurityContextUpdate: (u) => bobSecUpdates.push(u as ActorCtx['securityUpdates'][0]),
      }
      await bobPlugin.init(bobCtx)
      const bobBundle = await bobPlugin.callEnsureKeyMaterial('bob@example.com')
      publishKeyToSharedPep(shared, 'bob@example.com', bobBundle)

      // Restore alice as active passphrase
      clearSessionPassphrase()
      setSessionPassphrase('alice-strong-pp')

      return {
        shared,
        alice: { plugin: alicePlugin, testable: alicePlugin, ctx: aliceCtx, bundle: aliceBundle, securityUpdates: aliceSecUpdates },
        bob: { plugin: bobPlugin, testable: bobPlugin, ctx: bobCtx, bundle: bobBundle, securityUpdates: bobSecUpdates },
      }
    }

    function encodeBody(text: string): Uint8Array {
      return new TextEncoder().encode(
        serializePayloadEnvelope([xml('body', {}, text)]),
      )
    }

    function decodeBody(plaintext: Uint8Array): string {
      const xmlStr = new TextDecoder().decode(plaintext)
      const children = parsePayloadEnvelope(xmlStr)
      return children?.find((c) => c.name === 'body')?.text() ?? ''
    }

    const flushAsync = async () => {
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }

    it('encrypts for a probed peer, decrypts back to plaintext with signature verified', async () => {
      const { alice, bob } = await buildCrossPublishedPair()

      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBody('hello bob'))

      clearSessionPassphrase()
      setSessionPassphrase('bob-strong-pp')
      await bob.plugin.probePeer('alice@example.com')
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
      const decrypted = await bob.plugin.decrypt(bobHandle, claim)

      expect(decodeBody(decrypted.plaintext!)).toBe('hello bob')
      expect(decrypted.securityContext.trust).toBe('tofu')
      expect(decrypted.securityContext.notes).toBeUndefined()
    })

    it('resolves a peer that advertises upper-case but published its data node lower-case (#528 tolerance)', async () => {
      // Postel's law: even though XEP-0373 §4.1 mandates upper-case, a peer may
      // advertise one case while having published its data node under the
      // other. We must still find and cache the key.
      const { shared, alice, bob } = await buildCrossPublishedPair()

      // Re-advertise Bob's fingerprint in UPPER-case while his data node stays
      // at the lower-case id seeded by publishKeyToSharedPep (the mismatch).
      const upperFp = bob.bundle.fingerprint.toUpperCase()
      expect(upperFp).not.toBe(bob.bundle.fingerprint) // sanity: there IS a case difference
      shared.set(pepKey('bob@example.com', 'urn:xmpp:openpgp:0:public-keys'), [
        {
          id: 'current',
          payload: {
            name: 'public-keys-list',
            attrs: { xmlns: 'urn:xmpp:openpgp:0' },
            children: [
              {
                name: 'pubkey-metadata',
                attrs: { 'v4-fingerprint': upperFp, date: '2024-01-01T00:00:00Z' },
                children: [],
              },
            ],
          },
        },
      ])
      // Confirm the data node really only exists under the lower-case id.
      expect(
        shared.has(pepKey('bob@example.com', `urn:xmpp:openpgp:0:public-keys:${upperFp}`)),
      ).toBe(false)
      expect(
        shared.has(pepKey('bob@example.com', `urn:xmpp:openpgp:0:public-keys:${bob.bundle.fingerprint}`)),
      ).toBe(true)

      const support = await alice.plugin.probePeer('bob@example.com')

      expect(support.supported).toBe(true)
      expect(support.fingerprint?.toLowerCase()).toBe(bob.bundle.fingerprint.toLowerCase())
    })

    it('resolves the lower-case data node even when the upper-case node returns item-not-found IQ error (#528 interop)', async () => {
      // Same case-mismatch as the test above, but here the transport reflects
      // how real servers (ejabberd, Prosody) answer a query for a node that
      // does not exist: an item-not-found IQ error rather than an empty result.
      // The tolerant query must SWALLOW that error and fall through to the next
      // casing variant — otherwise the first variant aborts the whole lookup.
      const { shared, alice, bob } = await buildCrossPublishedPair()

      const upperFp = bob.bundle.fingerprint.toUpperCase()
      expect(upperFp).not.toBe(bob.bundle.fingerprint)
      shared.set(pepKey('bob@example.com', 'urn:xmpp:openpgp:0:public-keys'), [
        {
          id: 'current',
          payload: {
            name: 'public-keys-list',
            attrs: { xmlns: 'urn:xmpp:openpgp:0' },
            children: [
              {
                name: 'pubkey-metadata',
                attrs: { 'v4-fingerprint': upperFp, date: '2024-01-01T00:00:00Z' },
                children: [],
              },
            ],
          },
        },
      ])

      // A missing *data* node throws item-not-found (real-server behavior);
      // every other absent node keeps the empty-result contract so unrelated
      // lookups are undisturbed.
      alice.ctx.xmpp.queryPEP = async (jid, node): Promise<PEPItem[]> => {
        const items = shared.get(pepKey(jid, node))
        if (items !== undefined) return items
        if (node.startsWith('urn:xmpp:openpgp:0:public-keys:')) {
          throw new Error('stanza error: item-not-found (node does not exist)')
        }
        return []
      }

      // The upper-case data node (variant tried first) genuinely does not exist.
      expect(
        shared.has(pepKey('bob@example.com', `urn:xmpp:openpgp:0:public-keys:${upperFp}`)),
      ).toBe(false)
      expect(
        shared.has(pepKey('bob@example.com', `urn:xmpp:openpgp:0:public-keys:${bob.bundle.fingerprint}`)),
      ).toBe(true)

      const support = await alice.plugin.probePeer('bob@example.com')

      expect(support.supported).toBe(true)
      expect(support.fingerprint?.toLowerCase()).toBe(bob.bundle.fingerprint.toLowerCase())
    })

    it('marks trust untrusted when the sender key is not cached at decrypt time', async () => {
      const { alice, bob } = await buildCrossPublishedPair()

      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBody('from alice'))

      // Bob decrypts WITHOUT probing alice first → sender key not cached
      clearSessionPassphrase()
      setSessionPassphrase('bob-strong-pp')
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
      const decrypted = await bob.plugin.decrypt(bobHandle, claim, { messageId: 'm-no-key' })

      expect(decodeBody(decrypted.plaintext!)).toBe('from alice')
      expect(decrypted.securityContext.trust).toBe('untrusted')
      expect(decrypted.securityContext.notes?.join(' ')).toMatch(/not cached/)
    })

    it('rejects when the signature does not match the cached sender cert (Case A)', async () => {
      const { shared, alice, bob } = await buildCrossPublishedPair()

      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBody('hi'))

      // Bob caches eve's key as alice's (server substitution).
      // Eve's key must carry UID xmpp:alice@example.com so probePeer
      // accepts it — a real attacker can trivially forge the UID.
      clearSessionPassphrase()
      setSessionPassphrase('eve-strong-pp')
      const eve = new TestableWebOpenPGPPlugin({ hostStores })
      const eveCtx = makeCtx('alice@example.com').ctx
      await eve.init(eveCtx)
      const eveBundle = await eve.callEnsureKeyMaterial('alice@example.com')

      // Overwrite alice's key in shared PEP with eve's key
      publishKeyToSharedPep(shared, 'alice@example.com', eveBundle)

      clearSessionPassphrase()
      setSessionPassphrase('bob-strong-pp')
      await bob.plugin.probePeer('alice@example.com')
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!

      await expect(bob.plugin.decrypt(bobHandle, claim)).rejects.toThrow(/signature did not verify/)
    })

    it('rejects an envelope whose <time/> is more than 7 days skewed', async () => {
      const { alice, bob } = await buildCrossPublishedPair()

      // Monkey-patch the clock so the envelope timestamp is >7 days old
      const realNow = Date.now()
      const eightDaysMs = 8 * 24 * 60 * 60 * 1000
      ;(alice.plugin as unknown as { now: () => number }).now = () => realNow - eightDaysMs

      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBody('old message'))

      // Restore alice's clock, bob uses real time
      ;(alice.plugin as unknown as { now: () => number }).now = () => Date.now()

      clearSessionPassphrase()
      setSessionPassphrase('bob-strong-pp')
      await bob.plugin.probePeer('alice@example.com')
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!

      await expect(bob.plugin.decrypt(bobHandle, claim)).rejects.toMatchObject({
        code: 'envelope-stale',
      })
    })

    it('throws a transient (retryable) error for a clock-skew signature failure, not a permanent rejection', async () => {
      // When the sender key is present but the signature fails *because its
      // creation time is ahead of our clock* (beyond tolerance), the failure
      // is transient — decrypt() must throw `signature-not-yet-valid`
      // (transient) so the pipeline stashes it for retry, NOT
      // `signature-failed` (permanent) which renders a sticky red rejection.
      const { alice, bob } = await buildCrossPublishedPair()
      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBody('clock skew message'))

      clearSessionPassphrase()
      setSessionPassphrase('bob-strong-pp')
      await bob.plugin.probePeer('alice@example.com') // alice's key cached → Case A path
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!

      // Keep the real decryption (valid envelope) but report a not-yet-valid
      // signature, exactly as the crypto layer would under clock skew.
      const target = bob.testable as unknown as {
        decryptWithOwnKey: (...a: unknown[]) => Promise<Record<string, unknown>>
      }
      const real = target.decryptWithOwnKey.bind(target)
      const spy = vi
        .spyOn(target, 'decryptWithOwnKey')
        .mockImplementation(async (...args) => ({
          ...(await real(...args)),
          signatureVerified: false,
          signatureNotYetValid: true,
          signerFingerprint: null,
        }))

      await expect(
        bob.plugin.decrypt(bobHandle, claim, { messageId: 'm-skew' }),
      ).rejects.toMatchObject({ kind: 'transient', code: 'signature-not-yet-valid' })
      spy.mockRestore()
    })

    describe('pending signature verification buffer', () => {
      it('drains the buffer on onPeerKeysChanged and reports an upgrade for verified entries', async () => {
        const { shared, alice, bob } = await buildCrossPublishedPair()

        await alice.plugin.probePeer('bob@example.com')
        const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
        const payload = await alice.plugin.encrypt(handle, encodeBody('stashed message'))

        // Bob decrypts without alice's key → stashed for deferred verification
        clearSessionPassphrase()
        setSessionPassphrase('bob-strong-pp')
        const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
        const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
        await bob.plugin.decrypt(bobHandle, claim, { messageId: 'm-drain' })

        // Now bob learns alice's real key → drain should upgrade
        publishKeyToSharedPep(shared, 'alice@example.com', alice.bundle)
        bob.plugin.onPeerKeysChanged('alice@example.com')

        // The drain runs real openpgp.js verify off a fire-and-forget call, so
        // poll for the resulting update rather than guessing a fixed number of
        // event-loop turns — `flushAsync`'s fixed tick budget flakes under the
        // CPU contention of a full parallel test run.
        await vi.waitFor(() => expect(bob.securityUpdates).toHaveLength(1), { timeout: 5000 })
        expect(bob.securityUpdates[0].securityContext.trust).toBe('tofu')
        expect(bob.securityUpdates[0].messageId).toBe('m-drain')
      })

      it('does not stash when the signature verified on first decrypt', async () => {
        const { alice, bob } = await buildCrossPublishedPair()

        await alice.plugin.probePeer('bob@example.com')
        const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
        const payload = await alice.plugin.encrypt(handle, encodeBody('immediate verify'))

        clearSessionPassphrase()
        setSessionPassphrase('bob-strong-pp')
        await bob.plugin.probePeer('alice@example.com')
        const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
        const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
        const decrypted = await bob.plugin.decrypt(bobHandle, claim, { messageId: 'm-imm' })

        expect(decrypted.securityContext.trust).toBe('tofu')

        // Trigger drain — nothing should fire since entry was never stashed
        bob.plugin.onPeerKeysChanged('alice@example.com')
        await flushAsync()
        expect(bob.securityUpdates).toHaveLength(0)
      })

      it('stash-then-verify-fails rejects the entry when key arrives (Case D)', async () => {
        const { shared, alice, bob } = await buildCrossPublishedPair()

        await alice.plugin.probePeer('bob@example.com')
        const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
        const payload = await alice.plugin.encrypt(handle, encodeBody('from real alice'))

        // Bob decrypts without alice's key → stashed
        clearSessionPassphrase()
        setSessionPassphrase('bob-strong-pp')
        const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
        const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
        await bob.plugin.decrypt(bobHandle, claim, { messageId: 'm-mismatch' })

        // Bob later sees eve's key advertised as alice (server misbehavior).
        // Eve's key carries UID xmpp:alice@example.com so probePeer accepts it.
        clearSessionPassphrase()
        setSessionPassphrase('eve-strong-pp')
        const eve = new TestableWebOpenPGPPlugin({ hostStores })
        const eveCtx = makeCtx('alice@example.com').ctx
        await eve.init(eveCtx)
        const eveBundle = await eve.callEnsureKeyMaterial('alice@example.com')
        publishKeyToSharedPep(shared, 'alice@example.com', eveBundle)

        clearSessionPassphrase()
        setSessionPassphrase('bob-strong-pp')
        bob.plugin.onPeerKeysChanged('alice@example.com')

        await vi.waitFor(() => expect(bob.securityUpdates).toHaveLength(1), { timeout: 5000 })
        expect(bob.securityUpdates[0].securityContext.trust).toBe('rejected')
        expect(bob.securityUpdates[0].body).toBe('[Message rejected: invalid signature]')
      })

      it('preserves the entry on a transient re-verify error instead of falsely rejecting', async () => {
        const { shared, alice, bob } = await buildCrossPublishedPair()

        await alice.plugin.probePeer('bob@example.com')
        const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
        const payload = await alice.plugin.encrypt(handle, encodeBody('transient retry'))

        // Bob decrypts without alice's key → stashed for deferred verification
        clearSessionPassphrase()
        setSessionPassphrase('bob-strong-pp')
        const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
        const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
        await bob.plugin.decrypt(bobHandle, claim, { messageId: 'm-transient' })

        // Bob learns alice's real key, but the re-verify decrypt fails with a
        // TRANSIENT fault (e.g. IPC timeout). The message must NOT be rejected,
        // and the entry must survive so a later drain can resolve it.
        publishKeyToSharedPep(shared, 'alice@example.com', alice.bundle)
        const spy = vi
          .spyOn(
            bob.testable as unknown as { decryptWithOwnKey: (...a: unknown[]) => Promise<unknown> },
            'decryptWithOwnKey',
          )
          .mockRejectedValueOnce(new Error('ipc request timed out'))
        bob.plugin.onPeerKeysChanged('alice@example.com')
        // Wait until the re-verify decrypt was actually attempted (and rejected)
        // before restoring the mock — that ordering is the real dependency, not a
        // fixed number of ticks. Then let the rejection's catch handler settle.
        await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 5000 })
        await flushAsync()
        spy.mockRestore()

        // Transient failure must not produce a permanent rejection.
        expect(
          bob.securityUpdates.filter((u) => u.securityContext.trust === 'rejected'),
        ).toHaveLength(0)

        // The entry survived: a subsequent drain (decrypt now works) upgrades it.
        bob.plugin.onPeerKeysChanged('alice@example.com')
        await vi.waitFor(
          () => expect(bob.securityUpdates.filter((u) => u.securityContext.trust === 'tofu')).toHaveLength(1),
          { timeout: 5000 },
        )
        const upgrades = bob.securityUpdates.filter((u) => u.securityContext.trust === 'tofu')
        expect(upgrades[0].messageId).toBe('m-transient')
      })

      it('does not stash when no messageId is available', async () => {
        const { alice, bob } = await buildCrossPublishedPair()

        await alice.plugin.probePeer('bob@example.com')
        const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
        const payload = await alice.plugin.encrypt(handle, encodeBody('no id'))

        // Bob decrypts without key AND without messageId → no stash
        clearSessionPassphrase()
        setSessionPassphrase('bob-strong-pp')
        const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
        const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
        await bob.plugin.decrypt(bobHandle, claim) // no context → no messageId

        // Drain should have nothing
        bob.plugin.onPeerKeysChanged('alice@example.com')
        await flushAsync()
        expect(bob.securityUpdates).toHaveLength(0)
      })
    })
  })

  describe('unlock — auto-recovery from server backup', () => {
    const PP = 'current-backup-passphrase-123'

    it('returns recovered:false on a normal local unlock', async () => {
      const backend = new InMemoryStorageBackend()
      const setup = new WebOpenPGPPlugin({ hostStores })
      setSessionPassphrase(PP)
      await setup.init(makeCtx('alice@example.com', backend).ctx)
      const fp = setup.getOwnFingerprint()

      clearSessionPassphrase()
      const fresh = new WebOpenPGPPlugin({ hostStores })
      await fresh.init(makeCtx('alice@example.com', backend).ctx)
      const result = await fresh.unlock(PP)

      expect(result).toEqual({ recovered: false })
      expect(fresh.getOwnFingerprint()).toBe(fp)
    })

    it('fires ctx.notifyKeyUnlocked() on a normal local unlock, but NOT on init', async () => {
      // Web parity with the Sequoia restore path: a successful unlock must tell
      // the host so deferred decrypts re-run. init()'s locked load must NOT.
      const backend = new InMemoryStorageBackend()
      const setup = new WebOpenPGPPlugin({ hostStores })
      setSessionPassphrase(PP)
      await setup.init(makeCtx('alice@example.com', backend).ctx)

      clearSessionPassphrase()
      const fresh = new WebOpenPGPPlugin({ hostStores })
      const ctx = makeCtx('alice@example.com', backend).ctx
      const notifyKeyUnlocked = vi.fn()
      ctx.notifyKeyUnlocked = notifyKeyUnlocked
      await fresh.init(ctx) // key is locked → init returns early, no unlock signal
      expect(notifyKeyUnlocked).not.toHaveBeenCalled()

      await fresh.unlock(PP)
      expect(notifyKeyUnlocked).toHaveBeenCalledTimes(1)
    })

    it('recovers a stale local key from the server backup (rotated passphrase)', async () => {
      const shared: SharedPep = new Map()
      const sourceBackend = new InMemoryStorageBackend()
      setSessionPassphrase('old-local-passphrase')
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      await source.init(makeCtxWithWritablePep('alice@example.com', shared, sourceBackend).ctx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')
      await source.backupSecretKey(PP) // publishes the backup under the NEW passphrase

      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin({ hostStores })
      await device.init(makeCtxWithWritablePep('alice@example.com', shared, sourceBackend).ctx)
      expect(device.getOwnFingerprint()).toBeNull() // locked

      const result = await device.unlock(PP) // NEW passphrase fails locally, opens the backup

      expect(result).toEqual({ recovered: true })
      expect(device.getOwnFingerprint()).toBe(original.fingerprint)
    })

    it('recovers when there is no local key but a server backup exists', async () => {
      const shared: SharedPep = new Map()
      setSessionPassphrase('source-session-pp')
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      await source.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')
      await source.backupSecretKey(PP)

      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin({ hostStores }) // empty backend
      await device.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)

      const result = await device.unlock(PP)

      expect(result).toEqual({ recovered: true })
      expect(device.getOwnFingerprint()).toBe(original.fingerprint)
    })

    it('throws NoRecoveryAvailableError when local is stale and there is no backup', async () => {
      const backend = new InMemoryStorageBackend()
      const setup = new WebOpenPGPPlugin({ hostStores })
      setSessionPassphrase('real-passphrase')
      await setup.init(makeCtx('alice@example.com', backend).ctx)

      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin({ hostStores })
      await device.init(makeCtx('alice@example.com', backend).ctx)

      const { NoRecoveryAvailableError } = await import('./recoveryErrors')
      await expect(device.unlock('wrong-and-no-backup')).rejects.toBeInstanceOf(
        NoRecoveryAvailableError,
      )
      const { isKeyLocked } = await import('./webPassphraseStore')
      expect(isKeyLocked()).toBe(true) // rolled back
    })

    it('throws wrong-passphrase when neither local nor backup decrypt', async () => {
      const shared: SharedPep = new Map()
      const backend = new InMemoryStorageBackend()
      setSessionPassphrase('local-pp')
      const source = new TestableWebOpenPGPPlugin({ hostStores })
      await source.init(makeCtxWithWritablePep('alice@example.com', shared, backend).ctx)
      await source.callEnsureKeyMaterial('alice@example.com')
      await source.backupSecretKey('backup-pp')

      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin({ hostStores })
      await device.init(makeCtxWithWritablePep('alice@example.com', shared, backend).ctx)

      await expect(device.unlock('neither-of-them')).rejects.toMatchObject({
        code: 'wrong-passphrase',
      })
    })

    it('re-raises needs-identity-decision when the server has a published key but no secret backup', async () => {
      // No local key + server advertises a public key but holds no secret
      // backup → recovery has nothing to restore, so the original
      // needs-identity-decision is preserved for the IdentityChoiceDialog.
      const { ctx } = makeCtxWithPublishedFingerprint('alice@example.com', 'c3'.repeat(20))
      const device = new WebOpenPGPPlugin({ hostStores })
      await device.init(ctx) // locked (no passphrase yet) → init swallows key-locked

      await expect(device.unlock('some-passphrase-123')).rejects.toMatchObject({
        code: 'needs-identity-decision',
      })
      const { isKeyLocked } = await import('./webPassphraseStore')
      expect(isKeyLocked()).toBe(true) // rolled back
    })

    it('throws KeyPickerRequiredError when recovery finds a multi-key backup', async () => {
      // The PEP-level multi-key parsing is covered by the backupImportAll
      // tests; here we verify unlock's needsPicker → KeyPickerRequiredError
      // wiring (and passphrase rollback). Stub restoreSecretKey to report a
      // multi-key backup so the test stays focused on the orchestration.
      const backend = new InMemoryStorageBackend()
      setSessionPassphrase('old-local-pp')
      const setup = new WebOpenPGPPlugin({ hostStores })
      await setup.init(makeCtx('alice@example.com', backend).ctx) // stores a key under old-local-pp

      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin({ hostStores })
      await device.init(makeCtx('alice@example.com', backend).ctx)
      const candidates: KeyBundle[] = [
        { fingerprint: 'a'.repeat(40), publicArmored: 'PUB-A', keychainBacked: false },
        { fingerprint: 'b'.repeat(40), publicArmored: 'PUB-B', keychainBacked: false },
      ]
      ;(device as unknown as { restoreSecretKey: (pp: string) => Promise<unknown> }).restoreSecretKey =
        async () => ({ needsPicker: true, candidates, backupContext: { message: 'MSG', passphrase: 'new-pp' } })

      const { KeyPickerRequiredError } = await import('./recoveryErrors')
      await expect(device.unlock('wrong-for-local-pp')).rejects.toBeInstanceOf(KeyPickerRequiredError)
      const { isKeyLocked } = await import('./webPassphraseStore')
      expect(isKeyLocked()).toBe(true) // rolled back
    })
  })
})

describe('legacy backup passphrase migration (#1021)', () => {
  // Fluux ≤0.17.1 encrypted backups with a normalized (NFKD → lowercase)
  // passphrase; the displayed code is upper-case. A backup published by
  // an old client must (a) still restore from the displayed code and
  // (b) get re-published under the verbatim passphrase so other clients
  // can open it too.
  const CODE = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'

  /**
   * Publish a backup exactly as Fluux ≤0.17.1 did for `CODE`: encrypted
   * to the legacy-normalized form. (Post-fix `backupSecretKey` encrypts
   * verbatim, so feeding it the normalized string reproduces the legacy
   * bytes.)
   */
  async function publishLegacyBackup(shared: SharedPep) {
    const { legacyNormalizeBackupPassphrase } = await import('./backupPassphrase')
    setSessionPassphrase('source-session-pp')
    const source = new TestableWebOpenPGPPlugin({ hostStores })
    await source.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)
    const original = await source.callEnsureKeyMaterial('alice@example.com')
    await source.backupSecretKey(legacyNormalizeBackupPassphrase(CODE))
    clearSessionPassphrase()
    return original
  }

  it('restores a legacy-encoded backup from the displayed passphrase', async () => {
    const shared: SharedPep = new Map()
    const original = await publishLegacyBackup(shared)

    const device = new WebOpenPGPPlugin({ hostStores }) // fresh backend — new device
    await device.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)

    const result = await device.restoreSecretKey(CODE)

    expect(result).toEqual({ fingerprint: original.fingerprint })
    expect(device.getOwnFingerprint()).toBe(original.fingerprint)
  })

  it('heals the server copy: re-publishes the backup under the verbatim passphrase', async () => {
    const shared: SharedPep = new Map()
    await publishLegacyBackup(shared)

    const device = new WebOpenPGPPlugin({ hostStores })
    await device.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)
    await device.restoreSecretKey(CODE)

    // The published item must now open with the code exactly as the user
    // sees it — what Gajim would feed its KDF — and no longer with the
    // legacy-normalized form.
    const healed = await device.fetchSecretKeyBackup()
    expect(healed).not.toBeNull()
    const openpgp = await import('openpgp')
    const exact = await openpgp.readMessage({ armoredMessage: healed! })
    await expect(
      openpgp.decrypt({ message: exact, passwords: [CODE], format: 'binary' }),
    ).resolves.toBeDefined()

    const { legacyNormalizeBackupPassphrase } = await import('./backupPassphrase')
    const folded = await openpgp.readMessage({ armoredMessage: healed! })
    await expect(
      openpgp.decrypt({
        message: folded,
        passwords: [legacyNormalizeBackupPassphrase(CODE)],
        format: 'binary',
      }),
    ).rejects.toThrow()
  })

  it('does NOT re-publish when the backup already uses the verbatim passphrase', async () => {
    const shared: SharedPep = new Map()
    setSessionPassphrase('source-session-pp')
    const source = new TestableWebOpenPGPPlugin({ hostStores })
    await source.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)
    await source.callEnsureKeyMaterial('alice@example.com')
    await source.backupSecretKey(CODE) // canonical (post-fix) backup
    clearSessionPassphrase()

    const device = new WebOpenPGPPlugin({ hostStores })
    const { ctx } = makeCtxWithWritablePep('alice@example.com', shared)
    const secretKeyPublishes: string[] = []
    const origPublish = ctx.xmpp.publishPEP
    ctx.xmpp.publishPEP = async (node, item, opts) => {
      if (node.includes('secret-key')) secretKeyPublishes.push(node)
      return origPublish(node, item, opts)
    }
    await device.init(ctx)

    await device.restoreSecretKey(CODE)

    expect(secretKeyPublishes).toEqual([])
  })

  it('still reports wrong-passphrase when neither form opens the backup', async () => {
    const shared: SharedPep = new Map()
    await publishLegacyBackup(shared)

    const device = new WebOpenPGPPlugin({ hostStores })
    await device.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)

    // Mixed-case wrong guess: exercises the legacy retry too (the forms
    // differ), and both attempts must fail with the original error code.
    await expect(device.restoreSecretKey('WRONG-CODE-9999')).rejects.toMatchObject({
      code: 'wrong-passphrase',
    })
  })

  it('unlock() on a fresh device recovers from a legacy backup and heals it', async () => {
    // The end-to-end scenario from #1021: no local key, an old backup on
    // the server, the user types the code exactly as displayed. The
    // unlock recovery path routes through restoreSecretKey, so the
    // fallback opens the backup AND the heal re-publishes it verbatim.
    const shared: SharedPep = new Map()
    const original = await publishLegacyBackup(shared)

    const device = new WebOpenPGPPlugin({ hostStores })
    await device.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)

    const result = await device.unlock(CODE)

    expect(result).toEqual({ recovered: true })
    expect(device.getOwnFingerprint()).toBe(original.fingerprint)

    const healed = await device.fetchSecretKeyBackup()
    const openpgp = await import('openpgp')
    const message = await openpgp.readMessage({ armoredMessage: healed! })
    await expect(
      openpgp.decrypt({ message, passwords: [CODE], format: 'binary' }),
    ).resolves.toBeDefined()
  })

  it('restore still succeeds when the heal re-publish fails', async () => {
    // The heal is best-effort: losing the re-publish must never lose the
    // restore. The server copy simply keeps the legacy encoding.
    const shared: SharedPep = new Map()
    const original = await publishLegacyBackup(shared)

    const device = new WebOpenPGPPlugin({ hostStores })
    const { ctx } = makeCtxWithWritablePep('alice@example.com', shared)
    const origPublish = ctx.xmpp.publishPEP
    ctx.xmpp.publishPEP = async (node, item, opts) => {
      if (node.includes('secret-key')) throw new Error('item-not-found')
      return origPublish(node, item, opts)
    }
    await device.init(ctx)

    const result = await device.restoreSecretKey(CODE)

    expect(result).toEqual({ fingerprint: original.fingerprint })
    expect(device.getOwnFingerprint()).toBe(original.fingerprint)
  })

  it('imports a legacy-encoded export FILE without publishing anything to the server', async () => {
    // Files exported by ≤0.17.1 are encrypted with the normalized form
    // too. The same fallback opens them — but there is no server copy to
    // heal, so no secret-key publish may happen.
    const openpgp = await import('openpgp')
    const { legacyNormalizeBackupPassphrase } = await import('./backupPassphrase')
    const { privateKey: tsk } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name: 'xmpp:alice@example.com' }],
      format: 'object',
    })
    const legacyFile = (await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: tsk.write() as Uint8Array }),
      passwords: [legacyNormalizeBackupPassphrase(CODE)],
    })) as string

    const device = new WebOpenPGPPlugin({ hostStores })
    const shared: SharedPep = new Map()
    const { ctx } = makeCtxWithWritablePep('alice@example.com', shared)
    const secretKeyPublishes: string[] = []
    const origPublish = ctx.xmpp.publishPEP
    ctx.xmpp.publishPEP = async (node, item, opts) => {
      if (node.includes('secret-key')) secretKeyPublishes.push(node)
      return origPublish(node, item, opts)
    }
    await device.init(ctx)

    const result = await device.importKeyFromFile(legacyFile, CODE)

    expect(result).toEqual({ fingerprint: expect.any(String) })
    expect((result as { fingerprint: string }).fingerprint.toUpperCase()).toBe(
      tsk.getFingerprint().toUpperCase(),
    )
    expect(secretKeyPublishes).toEqual([])
  })

  it('multi-key legacy backup: the picker context carries the passphrase form that opens it', async () => {
    // Two TSKs bundled under the LEGACY encoding (a ≤0.17.1 backup made
    // from a Gajim-style multi-key import). Restore must surface the
    // picker with a backupContext whose passphrase actually decrypts the
    // blob, so installSelectedKey completes without re-prompting.
    const openpgp = await import('openpgp')
    const { legacyNormalizeBackupPassphrase } = await import('./backupPassphrase')
    const genKey = () =>
      openpgp.generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy' as const,
        userIDs: [{ name: 'xmpp:alice@example.com' }],
        format: 'object',
      })
    const [{ privateKey: keyA }, { privateKey: keyB }] = await Promise.all([genKey(), genKey()])
    const binaryA = keyA.write() as Uint8Array
    const binaryB = keyB.write() as Uint8Array
    const combined = new Uint8Array(binaryA.length + binaryB.length)
    combined.set(binaryA)
    combined.set(binaryB, binaryA.length)
    const legacyBlob = (await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: combined }),
      passwords: [legacyNormalizeBackupPassphrase(CODE)],
    })) as string

    const shared: SharedPep = new Map()
    const device = new WebOpenPGPPlugin({ hostStores })
    const { ctx } = makeCtxWithWritablePep('alice@example.com', shared)
    await device.init(ctx)
    // Serve the multi-key blob as the server backup.
    shared.set(`alice@example.com\0urn:xmpp:openpgp:0:secret-key`, [
      {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [dearmorBase64ForXep0373(legacyBlob)],
        },
      },
    ])

    const result = await device.restoreSecretKey(CODE)

    if (!('needsPicker' in result)) throw new Error('expected the multi-key picker')
    expect(result.candidates).toHaveLength(2)
    // The context must carry the form that actually decrypts the blob:
    // the NATIVE install path re-decrypts from it (web installs from a
    // cache, so only this direct assertion catches a regression here).
    expect(result.backupContext.passphrase).toBe(legacyNormalizeBackupPassphrase(CODE))

    const chosen = result.candidates[0].fingerprint
    const installed = await device.installSelectedKey(
      result.backupContext.message,
      result.backupContext.passphrase,
      chosen,
    )
    expect(installed.fingerprint).toBe(chosen)
  })
})
