// @vitest-environment node
/**
 * Cross-library interop: consume Sequoia-generated golden vectors.
 *
 * These tests read fixture files produced by the Rust test
 * `generate_sequoia_golden_vectors` and verify that openpgp.js can:
 *
 * 1. Parse Sequoia-generated public keys and extract matching fingerprints
 * 2. Decrypt a message encrypted+signed by Sequoia
 * 3. Verify the Sequoia signature and match the signer fingerprint
 * 4. Import a Sequoia-generated backup via passphrase
 *
 * Regenerate fixtures with:
 *   cd apps/fluux/src-tauri && cargo test generate_sequoia_golden_vectors -- --ignored --nocapture
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
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

const FIXTURES_DIR = resolve(__dirname, 'fixtures')
const META_PATH = resolve(FIXTURES_DIR, 'sequoia_meta.json')

class TestablePlugin extends WebOpenPGPPlugin {
  callDecryptWithOwnKey(jid: string, ct: string, senderPub: string | null) {
    return this.decryptWithOwnKey(jid, ct, senderPub)
  }
  callValidateCert(armored: string) {
    return this.validateCert(armored)
  }
  callBackupImport(jid: string, msg: string, pp: string) {
    return this.backupImport(jid, msg, pp)
  }
  callEncryptToRecipient(jid: string, recipientPub: string, plaintext: string) {
    return this.encryptToRecipient(jid, recipientPub, plaintext)
  }
}

function makeCtx(accountJid: string) {
  const backend = new InMemoryStorageBackend()
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
  return {
    ctx: {
      storage: createPluginStorage(backend, 'openpgp-test'),
      xmpp,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      account: { jid: accountJid },
      reportSecurityContextUpdate: () => {},
    } satisfies PluginContext,
    backend,
  }
}

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8')
}

const fixturesExist = existsSync(META_PATH)

beforeEach(async () => {
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

describe.skipIf(!fixturesExist)('Sequoia → openpgp.js interop', () => {
  let meta: {
    aliceFingerprint: string
    bobFingerprint: string
    plaintext: string
    backupPassphrase: string
  }

  beforeEach(() => {
    meta = JSON.parse(readFixture('sequoia_meta.json'))
  })

  it('parses Sequoia-generated public keys and extracts matching fingerprints', async () => {
    const plugin = new TestablePlugin()
    const { ctx } = makeCtx('test@example.com')
    setSessionPassphrase('pp')
    await plugin.init(ctx)

    const alicePub = readFixture('sequoia_alice_public.asc')
    const bobPub = readFixture('sequoia_bob_public.asc')

    const aliceInfo = await plugin.callValidateCert(alicePub)
    const bobInfo = await plugin.callValidateCert(bobPub)

    expect(aliceInfo.fingerprint.toUpperCase()).toBe(meta.aliceFingerprint.toUpperCase())
    expect(bobInfo.fingerprint.toUpperCase()).toBe(meta.bobFingerprint.toUpperCase())
    expect(aliceInfo.encryptionSubkeyCount).toBeGreaterThanOrEqual(1)
    expect(bobInfo.encryptionSubkeyCount).toBeGreaterThanOrEqual(1)
    expect(aliceInfo.userIds).toContain('xmpp:alice@example.com')
    expect(bobInfo.userIds).toContain('xmpp:bob@example.com')
  })

  it('imports a Sequoia-generated backup and recovers the same fingerprint', async () => {
    const backup = readFixture('sequoia_alice_backup.asc')
    const plugin = new TestablePlugin()
    const { ctx } = makeCtx('alice@example.com')
    await plugin.init(ctx)

    const restored = await plugin.callBackupImport(
      'alice@example.com',
      backup,
      meta.backupPassphrase,
    )

    expect(restored.fingerprint.toUpperCase()).toBe(meta.aliceFingerprint.toUpperCase())
  })

  it('decrypts a Sequoia-encrypted message and verifies the signature', async () => {
    // Import Bob's key from Alice's backup won't work — we need Bob's
    // secret key to decrypt. Instead, import Alice's backup (so we have
    // her signing cert for verification), then check that the message
    // structure is correct by importing Bob via a separate path.
    //
    // Since we only have Alice's backup in the fixtures, we verify the
    // encrypt/decrypt interop by importing Alice, then having Alice
    // decrypt her own copy (encrypt-to-self from Sequoia).
    const backup = readFixture('sequoia_alice_backup.asc')
    const plugin = new TestablePlugin()
    const { ctx } = makeCtx('alice@example.com')
    await plugin.init(ctx)
    await plugin.callBackupImport('alice@example.com', backup, meta.backupPassphrase)

    const ciphertext = readFixture('sequoia_alice_to_bob.asc')
    const alicePub = readFixture('sequoia_alice_public.asc')

    // Alice decrypts her own message (Sequoia encrypts to self).
    const output = await plugin.callDecryptWithOwnKey(
      'alice@example.com',
      ciphertext,
      alicePub,
    )

    expect(output.plaintext).toBe(meta.plaintext)
    expect(output.signaturePresent).toBe(true)
    expect(output.signatureVerified).toBe(true)
    expect(output.signerFingerprint!.toUpperCase()).toBe(meta.aliceFingerprint.toUpperCase())
  })

  it('rejects a Sequoia backup with the wrong passphrase', async () => {
    const backup = readFixture('sequoia_alice_backup.asc')
    const plugin = new TestablePlugin()
    const { ctx } = makeCtx('alice@example.com')
    await plugin.init(ctx)

    await expect(
      plugin.callBackupImport('alice@example.com', backup, 'wrong-passphrase'),
    ).rejects.toMatchObject({ code: 'wrong-passphrase' })
  })
})
