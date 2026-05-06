// @vitest-environment node
/**
 * Cross-platform backup format interop tests.
 *
 * The web (`WebOpenPGPPlugin`) and desktop (`SequoiaPgpPlugin`) sides
 * must produce backups in the exact same wire format so a backup
 * created on one platform can be restored on the other. The Rust side
 * uses Sequoia's `Encryptor::with_passwords` (AES-256, OCB AEAD) and
 * wraps a binary TSK in a literal data packet inside an armored
 * OpenPGP MESSAGE; the web side uses openpgp.js's `encrypt({ passwords })`.
 *
 * These tests pin the format contract by parsing what `WebOpenPGPPlugin.
 * backupEncrypt` produces and asserting on packet structure — anything
 * that drifts from "armored MESSAGE → SKESK → SEIP/AEAD → literal → TSK"
 * would break Rust↔Web interop, even if the web→web round-trip still
 * passes.
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

class TestableWebOpenPGPPlugin extends WebOpenPGPPlugin {
  callBackupEncrypt(jid: string, pp: string) {
    return this.backupEncrypt(jid, pp)
  }
  callBackupImport(jid: string, msg: string, pp: string) {
    return this.backupImport(jid, msg, pp)
  }
}

function makeCtx(accountJid: string, sharedBackend?: InMemoryStorageBackend) {
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

describe('backup interop: WebOpenPGPPlugin produces a Sequoia-compatible wire format', () => {
  it('emits an ASCII-armored OpenPGP MESSAGE (not a key block)', async () => {
    const plugin = new TestableWebOpenPGPPlugin()
    const { ctx } = makeCtx('alice@example.com')
    setSessionPassphrase('session-pp')
    await plugin.init(ctx)

    const backup = await plugin.callBackupEncrypt('alice@example.com', 'backup-passphrase-xyz')

    // The Rust side wraps the TSK in `armor::Kind::Message`; openpgp.js's
    // `encrypt({ passwords })` does the same. A "PUBLIC KEY BLOCK" or
    // "PRIVATE KEY BLOCK" header would mean we shipped the raw TSK
    // unprotected — exactly the bug we're guarding against.
    expect(backup).toContain('-----BEGIN PGP MESSAGE-----')
    expect(backup).toContain('-----END PGP MESSAGE-----')
    expect(backup).not.toContain('PRIVATE KEY BLOCK')
    expect(backup).not.toContain('PUBLIC KEY BLOCK')
  })

  it('uses a SKESK (passphrase-protected) container, not PKESK', async () => {
    const plugin = new TestableWebOpenPGPPlugin()
    const { ctx } = makeCtx('alice@example.com')
    setSessionPassphrase('session-pp')
    await plugin.init(ctx)

    const backup = await plugin.callBackupEncrypt('alice@example.com', 'pp-1234')

    // Parse the outer message and inspect the packet stream. The Rust side
    // produces ONLY SKESK packets (no PKESK), since the backup is wrapped
    // for a passphrase, not a public key.
    const openpgp = await import('openpgp')
    const message = await openpgp.readMessage({ armoredMessage: backup })

    const packets = message.packets
    const types = packets.map((p) => p.constructor.name)

    // At least one SKESK must be present.
    expect(types).toContain('SymEncryptedSessionKeyPacket')

    // PKESKs (public-key session keys) would indicate the backup was
    // encrypted to a recipient key, not a passphrase — incompatible with
    // Sequoia's `Encryptor::with_passwords`.
    expect(types).not.toContain('PublicKeyEncryptedSessionKeyPacket')
  })

  it('produces a payload that decrypts to a binary TSK with secret-key packets', async () => {
    const plugin = new TestableWebOpenPGPPlugin()
    const { ctx } = makeCtx('alice@example.com')
    setSessionPassphrase('session-pp')
    await plugin.init(ctx)

    const backupPp = 'long-and-strong-passphrase'
    const backup = await plugin.callBackupEncrypt('alice@example.com', backupPp)

    // Decrypt the outer container and pull out the literal payload as a
    // string. This mirrors what Sequoia does on the Rust side
    // (`std::io::copy` from the decryptor into `tsk_bytes`, then
    // `Cert::from_bytes`). The recovered armor must contain SECRET KEY
    // BLOCK markers — Rust explicitly rejects any payload whose Cert is
    // not a TSK.
    const openpgp = await import('openpgp')
    const message = await openpgp.readMessage({ armoredMessage: backup })
    const { data } = await openpgp.decrypt({ message, passwords: [backupPp] })

    const tskArmored = typeof data === 'string' ? data : await streamToString(data)

    expect(tskArmored).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----')
    expect(tskArmored).toContain('-----END PGP PRIVATE KEY BLOCK-----')

    // Parse the recovered TSK and assert it really carries a secret key —
    // not a stripped public key (which Rust's `cert.is_tsk()` would reject).
    const recoveredKey = await openpgp.readPrivateKey({ armoredKey: tskArmored })
    expect(recoveredKey.isPrivate()).toBe(true)
  })

  it('decrypts a fixture produced via the Sequoia-equivalent openpgp.js path', async () => {
    // This mirrors what Sequoia's `Encryptor::with_passwords` produces:
    // the outer is a passphrase-only OpenPGP MESSAGE wrapping a TSK as
    // literal data. We construct the fixture inside the test (not from a
    // hardcoded string) so it stays valid across openpgp.js patch bumps.
    const openpgp = await import('openpgp')
    const fixturePassphrase = 'rust-side-equivalent-pp'

    // 1. Generate a TSK exactly the way the Rust side stores it:
    //    armored, with the secret material unencrypted-at-rest (the
    //    backup's only protection is the outer SKESK).
    const { privateKey: tsk } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name: 'xmpp:alice@example.com' }],
      format: 'object',
    })
    const tskArmored = tsk.armor()

    // 2. Wrap it in a passphrase-encrypted OpenPGP MESSAGE — the format
    //    the Rust `encrypt_tsk_with_passphrase` produces.
    const fixture = (await openpgp.encrypt({
      message: await openpgp.createMessage({ text: tskArmored }),
      passwords: [fixturePassphrase],
    })) as string

    // 3. Hand the fixture to a fresh WebOpenPGPPlugin (no prior key) and
    //    confirm the import recovers the same fingerprint, the same
    //    public material, and a usable secret key.
    clearSessionPassphrase()
    const dest = new TestableWebOpenPGPPlugin()
    const { ctx } = makeCtx('alice@example.com')
    await dest.init(ctx) // locked — fine for import

    const recovered = await dest.callBackupImport(
      'alice@example.com',
      fixture,
      fixturePassphrase,
    )

    expect(recovered.fingerprint.toUpperCase()).toBe(tsk.getFingerprint().toUpperCase())
    expect(recovered.publicArmored).toBe(tsk.toPublic().armor())
  })

  it('rejects a fixture decrypted with the wrong passphrase (matches Rust error code)', async () => {
    const openpgp = await import('openpgp')
    const { privateKey: tsk } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name: 'xmpp:alice@example.com' }],
      format: 'object',
    })
    const fixture = (await openpgp.encrypt({
      message: await openpgp.createMessage({ text: tsk.armor() }),
      passwords: ['the-real-passphrase'],
    })) as string

    const dest = new TestableWebOpenPGPPlugin()
    const { ctx } = makeCtx('alice@example.com')
    await dest.init(ctx)

    // Rust surfaces "no SKESK matched the supplied passphrase" → classified
    // as { kind: 'permanent', code: 'wrong-passphrase' } in the shared
    // base. The web path should produce the SAME code so UIs can branch
    // identically on `err.code === 'wrong-passphrase'`.
    await expect(
      dest.callBackupImport('alice@example.com', fixture, 'wrong-pp'),
    ).rejects.toMatchObject({ code: 'wrong-passphrase' })
  })

  it('round-trip survives a re-wrap with a new passphrase (rotation parity)', async () => {
    // Sequoia re-wraps the backup with a fresh passphrase on every
    // rotate-with-backup-in-sync call. The web side must emit a fixture
    // that survives a second pass through encrypt/decrypt — proving the
    // recovered TSK isn't degraded (e.g. losing a subkey or its binding
    // signature) on import.
    const plugin = new TestableWebOpenPGPPlugin()
    const { ctx } = makeCtx('alice@example.com')
    setSessionPassphrase('session-pp')
    await plugin.init(ctx)

    const first = await plugin.callBackupEncrypt('alice@example.com', 'pp-one')

    // Decrypt with pp-one, re-encrypt with pp-two — the Rust rotation
    // path does exactly this dance.
    const openpgp = await import('openpgp')
    const decrypted = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: first }),
      passwords: ['pp-one'],
    })
    const tskArmored = typeof decrypted.data === 'string'
      ? decrypted.data
      : await streamToString(decrypted.data)

    const second = (await openpgp.encrypt({
      message: await openpgp.createMessage({ text: tskArmored }),
      passwords: ['pp-two'],
    })) as string

    // Import the re-wrapped backup on a fresh plugin and verify the
    // recovered key matches the original.
    clearSessionPassphrase()
    const dest = new TestableWebOpenPGPPlugin()
    const { ctx: destCtx } = makeCtx('alice@example.com')
    await dest.init(destCtx)
    const restored = await dest.callBackupImport('alice@example.com', second, 'pp-two')

    const originalFp = plugin.getOwnFingerprint()
    expect(originalFp).not.toBeNull()
    expect(restored.fingerprint).toBe(originalFp)
  })
})

async function streamToString(stream: unknown): Promise<string> {
  // openpgp.js's decrypt returns either a string (when text format) or
  // a stream. We always pass `text` so the string branch is the common
  // path; this fallback is defensive for cases where the lib hands us
  // a stream-like object instead.
  const reader = (stream as { getReader?: () => ReadableStreamDefaultReader }).getReader?.()
  if (!reader) return String(stream)
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += typeof value === 'string' ? value : decoder.decode(value)
  }
  return out
}
