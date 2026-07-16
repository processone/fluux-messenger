// @vitest-environment node
/**
 * Generate golden test vectors from openpgp.js for Sequoia consumption.
 *
 * This test writes fixture files that the Rust test
 * `consume_web_golden_vectors` reads and decrypts with Sequoia-PGP.
 *
 * Excluded from `npm test` (`.manual.test.ts`) because it regenerates
 * fixture files with fresh keys on every run. Run explicitly when you
 * need to update the vectors:
 *
 *   npx vitest run src/e2ee/generateWebVectors.manual.test.ts
 *
 * Then run the Rust consumer:
 *   cd apps/fluux/src-tauri && cargo test consume_web_golden_vectors -- --ignored --nocapture
 */
import { writeFileSync } from 'node:fs'
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
import { createMockHostStores } from './testing/mockHostStores'

const FIXTURES_DIR = resolve(__dirname, 'fixtures')
const BACKUP_PASSPHRASE = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'

class TestablePlugin extends WebOpenPGPPlugin {
  callEnsureKeyMaterial(jid: string) {
    return this.ensureKeyMaterial(jid)
  }
  callEncryptToRecipient(jid: string, recipientPub: string, plaintext: string) {
    return this.encryptToRecipient(jid, recipientPub, plaintext)
  }
  callBackupEncrypt(jid: string, pp: string) {
    return this.backupEncrypt(jid, pp)
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
  }
}

beforeEach(async () => {
  localStorage.clear()
  clearSessionPassphrase()
})

afterEach(() => {
  clearSessionPassphrase()
})

describe('generate web golden vectors for Sequoia consumption', () => {
  it('writes fixture files', async () => {
    // Alice
    const alice = new TestablePlugin({ hostStores: createMockHostStores() })
    const { ctx: aliceCtx } = makeCtx('alice@example.com')
    setSessionPassphrase('alice-pp')
    await alice.init(aliceCtx)
    const aliceBundle = await alice.callEnsureKeyMaterial('alice@example.com')

    // Bob
    clearSessionPassphrase()
    const bob = new TestablePlugin({ hostStores: createMockHostStores() })
    const { ctx: bobCtx } = makeCtx('bob@example.com')
    setSessionPassphrase('bob-pp')
    await bob.init(bobCtx)
    const bobBundle = await bob.callEnsureKeyMaterial('bob@example.com')

    // 1. Public keys
    writeFileSync(resolve(FIXTURES_DIR, 'web_alice_public.asc'), aliceBundle.publicArmored)
    writeFileSync(resolve(FIXTURES_DIR, 'web_bob_public.asc'), bobBundle.publicArmored)

    // 2. Alice → Bob ciphertext (signed by Alice, encrypted to Bob + Alice-self)
    setSessionPassphrase('alice-pp')
    const plaintext = 'Hello from openpgp.js — cross-library interop test'
    const ciphertext = await alice.callEncryptToRecipient(
      'alice@example.com',
      bobBundle.publicArmored,
      plaintext,
    )
    writeFileSync(resolve(FIXTURES_DIR, 'web_alice_to_bob.asc'), ciphertext)

    // 3. Backups for both Alice and Bob (Rust needs both secret keys to decrypt the message)
    const aliceBackup = await alice.callBackupEncrypt('alice@example.com', BACKUP_PASSPHRASE)
    writeFileSync(resolve(FIXTURES_DIR, 'web_alice_backup.asc'), aliceBackup)

    setSessionPassphrase('bob-pp')
    const bobBackup = await bob.callBackupEncrypt('bob@example.com', BACKUP_PASSPHRASE)
    writeFileSync(resolve(FIXTURES_DIR, 'web_bob_backup.asc'), bobBackup)

    // 4. Metadata JSON
    const meta = {
      aliceFingerprint: aliceBundle.fingerprint,
      bobFingerprint: bobBundle.fingerprint,
      plaintext,
      backupPassphrase: BACKUP_PASSPHRASE,
    }
    writeFileSync(resolve(FIXTURES_DIR, 'web_meta.json'), JSON.stringify(meta, null, 2))

    // Sanity assertions
    expect(aliceBundle.fingerprint).toMatch(/^[a-f0-9]{40}$/)
    expect(bobBundle.fingerprint).toMatch(/^[a-f0-9]{40}$/)
    expect(ciphertext).toContain('BEGIN PGP MESSAGE')
    expect(aliceBackup).toContain('BEGIN PGP MESSAGE')
    expect(bobBackup).toContain('BEGIN PGP MESSAGE')
  })
})
