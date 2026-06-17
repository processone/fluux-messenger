// @vitest-environment node
/**
 * Generator for the binary-TSK migration fixture (openpgp_tsk_backup.asc):
 * a Fluux/Sequoia-style backup = a binary Transferable Secret Key wrapped in a
 * passphrase-encrypted OpenPGP MESSAGE. Run on demand to (re)create the fixture.
 *
 * IMPORTANT: Fluux's backupEncrypt (and the Sequoia desktop side) encrypt with
 * the *normalized* passphrase, so this generator must do the same or the
 * fixture won't decrypt through the import path.
 */
import { describe, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE = resolve(__dirname, 'fixtures', 'openpgp_tsk_backup.asc')
const PASSPHRASE = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'

// Mirror of WebOpenPGPPlugin.normalizeBackupPassphrase (module-private there).
function normalizeBackupPassphrase(raw: string): string {
  return raw.normalize('NFKD').toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

describe('generate TSK migration fixture', () => {
  it('writes openpgp_tsk_backup.asc', async () => {
    const openpgp = await import('openpgp')
    const { privateKey: tsk } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name: 'xmpp:migration-tsk@example.com' }],
      format: 'object',
    })
    const message = (await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: tsk.write() as Uint8Array }),
      passwords: [normalizeBackupPassphrase(PASSPHRASE)],
    })) as string
    writeFileSync(FIXTURE, message)
    writeFileSync('/tmp/tsk-fp.txt', tsk.getFingerprint() + '\n')
  })
})
