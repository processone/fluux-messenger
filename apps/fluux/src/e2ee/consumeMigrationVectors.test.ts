// @vitest-environment node
/**
 * Migration interop: import secret-key backups produced by other tools.
 *
 * Two backup-payload shapes a user may bring to Fluux, both verified end-to-end
 * through the real import path (importKeyFromFile → backupImportAll):
 *
 *  - tsk:         a binary Transferable Secret Key wrapped in a passphrase
 *                 MESSAGE — the shape Fluux's own web backups and the Sequoia
 *                 desktop side produce.
 *  - openkeychain: an OpenKeychain (Android) `numeric9x4` backup, which
 *                 decrypts to an armored PUBLIC KEY BLOCK *followed by* a
 *                 PRIVATE KEY BLOCK. The fixture is a real throwaway key
 *                 exported from OpenKeychain — users could not import it
 *                 because (a) the passphrase field masked the 9x4 code and
 *                 (b) readPrivateKeys() choked on the leading public block.
 *
 * Regenerate the tsk fixture with (drop the `.manual` to run it once):
 *   npx vitest run src/e2ee/migrationTskVectorGen.manual.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  InMemoryStorageBackend,
  createPluginStorage,
  type PEPItem,
  type PluginContext,
  type XMPPPrimitives,
} from '@fluux/sdk'
import { WebOpenPGPPlugin } from './WebOpenPGPPlugin'
import { clearSessionPassphrase } from './webPassphraseStore'

const FIXTURES_DIR = resolve(__dirname, 'fixtures')
const readFixture = (name: string) => readFileSync(resolve(FIXTURES_DIR, name), 'utf-8')

interface MigrationVector {
  fixture: string
  format: string
  passphrase: string
  fingerprint: string
}
const VECTORS = JSON.parse(readFixture('migration_meta.json')) as Record<string, MigrationVector>

class TestablePlugin extends WebOpenPGPPlugin {
  callBackupImportAll(jid: string, msg: string, pp: string) {
    return this.backupImportAll(jid, msg, pp)
  }
  callBackupImportSelected(jid: string, msg: string, pp: string, fp: string) {
    return this.backupImportSelected(jid, msg, pp, fp)
  }
  callEncryptToRecipient(jid: string, recipientPub: string, plaintext: string) {
    return this.encryptToRecipient(jid, recipientPub, plaintext)
  }
  callDecryptWithOwnKey(jid: string, ciphertext: string, senderPub: string | null) {
    return this.decryptWithOwnKey(jid, ciphertext, senderPub)
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
    storage: createPluginStorage(backend, 'openpgp-test'),
    xmpp,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    account: { jid: accountJid },
    reportSecurityContextUpdate: () => {},
  } satisfies PluginContext
}

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

describe('migration backup import (other tools → Fluux)', () => {
  for (const [name, vector] of Object.entries(VECTORS)) {
    it(`imports a ${name} backup and recovers a usable secret key`, async () => {
      const backup = readFixture(vector.fixture)
      const plugin = new TestablePlugin()
      const ctx = makeCtx('migrant@example.com')
      await plugin.init(ctx) // locked — fine for import

      const bundles = await plugin.callBackupImportAll('migrant@example.com', backup, vector.passphrase)
      const bundle = bundles.find(
        (b) => b.fingerprint.toUpperCase() === vector.fingerprint.toUpperCase(),
      )
      expect(bundle, `${name} fixture should yield fingerprint ${vector.fingerprint}`).toBeDefined()

      // Load-bearing: install the SECRET key and prove it actually decrypts —
      // a fingerprint match alone could be satisfied by a public-only restore.
      await plugin.callBackupImportSelected(
        'migrant@example.com',
        backup,
        vector.passphrase,
        bundle!.fingerprint,
      )
      const ciphertext = await plugin.callEncryptToRecipient(
        'migrant@example.com',
        bundle!.publicArmored,
        `migration roundtrip: ${name}`,
      )
      const decrypted = await plugin.callDecryptWithOwnKey(
        'migrant@example.com',
        ciphertext,
        bundle!.publicArmored,
      )
      expect(decrypted.plaintext).toBe(`migration roundtrip: ${name}`)
    })

    it(`rejects a ${name} backup with the wrong passphrase`, async () => {
      const backup = readFixture(vector.fixture)
      const plugin = new TestablePlugin()
      const ctx = makeCtx('migrant@example.com')
      await plugin.init(ctx)

      await expect(
        plugin.callBackupImportAll('migrant@example.com', backup, 'totally-wrong-passphrase'),
      ).rejects.toMatchObject({ code: 'wrong-passphrase' })
    })
  }
})
