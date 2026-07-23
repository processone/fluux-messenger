// @vitest-environment node
/**
 * Migration interop: import secret-key backups produced by other tools.
 *
 * Two backup-payload shapes a user may bring to Fluux, both verified end-to-end
 * through the real import path (importKeyFromFile → backupImportAll):
 *
 *  - tsk:         a binary Transferable Secret Key wrapped in a passphrase
 *                 MESSAGE — the shape Fluux's own web backups and the Sequoia
 *                 desktop side produce. Minted in memory per run by
 *                 {@link makeTskBackupVector} (below), with its fingerprint
 *                 derived from the generated key. The test therefore neither
 *                 reads nor rewrites a committed blob: a stale generator used
 *                 to rotate a checked-in fixture on every run, drifting its
 *                 fingerprint out of sync with this metadata and dirtying the
 *                 working tree.
 *  - openkeychain: an OpenKeychain (Android) `numeric9x4` backup, which
 *                 decrypts to an armored PUBLIC KEY BLOCK *followed by* a
 *                 PRIVATE KEY BLOCK. A genuine external artifact, so it stays a
 *                 frozen, read-only fixture. Users could not import it because
 *                 (a) the passphrase field masked the 9x4 code and (b)
 *                 readPrivateKeys() choked on the leading public block.
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

/** A ready-to-import backup plus the passphrase and fingerprint to verify it. */
interface MigrationVector {
  backup: string
  passphrase: string
  fingerprint: string
}

const TSK_PASSPHRASE = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'

/**
 * Build a Fluux/Sequoia-style TSK backup entirely in memory: a fresh ECC key
 * whose binary Transferable Secret Key is wrapped in a passphrase-encrypted
 * OpenPGP MESSAGE — the exact container Fluux's web and desktop backups emit.
 * The passphrase is used verbatim (#1021), matching the real backup path.
 * The fingerprint is read back off the generated key, so there is no hardcoded
 * value to drift and nothing is ever written to disk.
 */
async function makeTskBackupVector(): Promise<MigrationVector> {
  const openpgp = await import('openpgp')
  const { privateKey: tsk } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name: 'xmpp:migration-tsk@example.com' }],
    format: 'object',
  })
  const backup = (await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: tsk.write() as Uint8Array }),
    passwords: [TSK_PASSPHRASE],
  })) as string
  return { backup, passphrase: TSK_PASSPHRASE, fingerprint: tsk.getFingerprint() }
}

/** OpenKeychain vector metadata still lives in the committed fixture manifest. */
interface OpenKeychainMeta {
  fixture: string
  passphrase: string
  fingerprint: string
}
const OPENKEYCHAIN = (
  JSON.parse(readFixture('migration_meta.json')) as { openkeychain: OpenKeychainMeta }
).openkeychain

/**
 * Table of backup producers. `tsk` is minted per run in memory; `openkeychain`
 * is read from its frozen, real-world fixture. Each yields the same
 * {@link MigrationVector} shape so the assertions below stay vector-agnostic.
 */
const VECTOR_SPECS: Record<string, () => Promise<MigrationVector>> = {
  tsk: makeTskBackupVector,
  openkeychain: async () => ({
    backup: readFixture(OPENKEYCHAIN.fixture),
    passphrase: OPENKEYCHAIN.passphrase,
    fingerprint: OPENKEYCHAIN.fingerprint,
  }),
}

class TestablePlugin extends WebOpenPGPPlugin {
  callBackupImportAll(jid: string, msg: string, pp: string) {
    return this.backupImportAll(jid, msg, pp)
  }
  callBackupImportSelected(jid: string, msg: string, pp: string, fp: string) {
    return this.backupImportSelected(jid, msg, pp, fp)
  }
  callEncryptToRecipient(jid: string, recipientPub: string, plaintext: string) {
    return this.encryptToRecipients(jid, [recipientPub], plaintext)
  }
  callDecryptWithOwnKey(jid: string, ciphertext: string, senderPub: string | null) {
    return this.decryptWithOwnKey(jid, ciphertext, senderPub ? [senderPub] : [])
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
  for (const [name, makeVector] of Object.entries(VECTOR_SPECS)) {
    it(`imports a ${name} backup and recovers a usable secret key`, async () => {
      const { backup, passphrase, fingerprint } = await makeVector()
      const plugin = new TestablePlugin()
      const ctx = makeCtx('migrant@example.com')
      await plugin.init(ctx) // locked — fine for import

      const bundles = await plugin.callBackupImportAll('migrant@example.com', backup, passphrase)
      const bundle = bundles.find(
        (b) => b.fingerprint.toUpperCase() === fingerprint.toUpperCase(),
      )
      expect(bundle, `${name} backup should yield fingerprint ${fingerprint}`).toBeDefined()

      // Load-bearing: install the SECRET key and prove it actually decrypts —
      // a fingerprint match alone could be satisfied by a public-only restore.
      await plugin.callBackupImportSelected(
        'migrant@example.com',
        backup,
        passphrase,
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
      const { backup } = await makeVector()
      const plugin = new TestablePlugin()
      const ctx = makeCtx('migrant@example.com')
      await plugin.init(ctx)

      await expect(
        plugin.callBackupImportAll('migrant@example.com', backup, 'totally-wrong-passphrase'),
      ).rejects.toMatchObject({ code: 'wrong-passphrase' })
    })
  }
})
