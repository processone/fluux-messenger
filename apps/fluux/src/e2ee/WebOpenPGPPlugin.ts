/**
 * Web (browser) OpenPGP plugin for XEP-0373 (OpenPGP for XMPP, "OX").
 *
 * Concrete subclass of {@link OpenPGPPluginBase} that implements all crypto
 * operations using the openpgp.js library (dynamic import — excluded from
 * Tauri/desktop builds). Key material is stored in IndexedDB encrypted under
 * a session passphrase the user enters at login.
 *
 * # Key model
 *
 * - One ECC Curve25519 key per account. The key version (v4 or v6) is
 *   controlled by {@link USE_V6_KEYS} — see the matching flag in openpgp.rs.
 * - The private key is stored encrypted-under-passphrase in IndexedDB
 *   (via the plugin's namespaced {@link StorageBackend}).
 * - The decrypted private key is held in module memory for the session;
 *   a page reload requires re-entry of the passphrase.
 *
 * # Backup compatibility with Sequoia/desktop
 *
 * Both backup and restore use the same internal format as desktop: an
 * armored OpenPGP MESSAGE (SKESK) that wraps the raw TSK armor. The shared
 * base class converts that armor to the XEP-0373 §5 PEP payload.
 */

import type { PrivateKey } from 'openpgp'
import { E2EEPluginError } from '@fluux/sdk'
import {
  OpenPGPPluginBase,
  type CertValidation,
  type DecryptOutput,
  type KeyBundle,
} from './OpenPGPPluginBase'
import { clearSessionPassphrase, getSessionPassphrase, setSessionPassphrase } from './webPassphraseStore'
import { USE_V6_KEYS } from './passphraseGenerator'

const PRIVATE_KEY_STORAGE_KEY = 'private-key'

/**
 * Normalize a backup passphrase to match Rust's `normalize_passphrase`:
 * NFKD → lowercase → collapse whitespace to single ASCII space.
 */
function normalizeBackupPassphrase(raw: string): string {
  return raw.normalize('NFKD').toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

export class WebOpenPGPPlugin extends OpenPGPPluginBase {
  /** In-memory decrypted private key. Cleared on shutdown / page reload. */
  private ownPrivateKey: PrivateKey | null = null

  /** Transient cache of parsed keys from backupImportAll, keyed by fingerprint. */
  private pendingImportKeys: Map<string, PrivateKey> = new Map()

  protected pluginName(): string {
    return 'WebOpenPGPPlugin'
  }

  // ---------------------------------------------------------------------------
  // Abstract crypto method implementations (openpgp.js)
  // ---------------------------------------------------------------------------

  protected async ensureKeyMaterial(accountJid: string): Promise<KeyBundle> {
    const passphrase = getSessionPassphrase()
    if (!passphrase) {
      throw new E2EEPluginError(
        'transient',
        'key-locked',
        'WebOpenPGPPlugin: key is locked — enter passphrase to unlock',
      )
    }

    // Return already-decrypted key from session cache.
    if (this.ownPrivateKey && this.ownBundle) {
      return this.ownBundle
    }

    const ctx = this.requireCtx()
    const { readPrivateKey, decryptKey } = await import('openpgp')

    const storedBytes = await ctx.storage.get(PRIVATE_KEY_STORAGE_KEY)
    if (storedBytes) {
      const armoredKey = new TextDecoder().decode(storedBytes)
      const encryptedKey = await readPrivateKey({ armoredKey })
      try {
        const privateKey = await decryptKey({ privateKey: encryptedKey, passphrase })
        this.ownPrivateKey = privateKey
        return this.bundleFromKey(privateKey)
      } catch (err) {
        throw new E2EEPluginError(
          'permanent',
          'wrong-passphrase',
          'WebOpenPGPPlugin: could not decrypt stored private key — wrong passphrase',
          err,
        )
      }
    }

    // Defence in depth: refuse to silent-generate when the server
    // already holds OpenPGP identity material for this account. See
    // {@link OpenPGPPluginBase.assertSilentGenerationAllowed} for the
    // full rationale. Bypassable via `_allowSilentRegenerate` set by
    // `retireAndGenerateIdentity`.
    await this.assertSilentGenerationAllowed(accountJid)

    // Truly fresh account, OR explicit retire+regenerate. Safe to generate.
    return this.generateAndStoreKey(accountJid, passphrase, ctx.storage)
  }

  protected async encryptToRecipient(
    _senderAccountJid: string,
    recipientPublicArmored: string,
    plaintext: string,
  ): Promise<string> {
    await this.requireUnlocked()
    const { createMessage, readKey, encrypt } = await import('openpgp')
    const recipientKey = await readKey({ armoredKey: recipientPublicArmored })
    const senderPublicKey = this.ownPrivateKey!.toPublic()
    const message = await createMessage({ text: plaintext })
    const encrypted = await encrypt({
      message,
      encryptionKeys: [recipientKey, senderPublicKey],
      signingKeys: this.ownPrivateKey!,
    })
    return encrypted as string
  }

  protected async decryptWithOwnKey(
    _accountJid: string,
    ciphertext: string,
    senderPublicArmored: string | null,
  ): Promise<DecryptOutput> {
    await this.requireUnlocked()
    const { readMessage, decrypt, readKey } = await import('openpgp')

    const message = await readMessage({ armoredMessage: ciphertext })
    const verificationKeys = senderPublicArmored
      ? [await readKey({ armoredKey: senderPublicArmored })]
      : []

    const { data: plaintext, signatures } = await decrypt({
      message,
      decryptionKeys: this.ownPrivateKey!,
      ...(verificationKeys.length > 0 && { verificationKeys }),
    })

    let signatureVerified = false
    let signerFingerprint: string | null = null
    const signaturePresent = signatures.length > 0

    if (signaturePresent && senderPublicArmored) {
      try {
        await signatures[0].verified
        signatureVerified = true
        // Return the primary cert fingerprint (40 hex chars for v4) to
        // match Sequoia's behavior. keyID.toHex() only gives the 8-byte
        // key ID (16 chars), which would never match the cached peer FP.
        signerFingerprint = verificationKeys[0].getFingerprint()
      } catch {
        signatureVerified = false
      }
    }

    return {
      plaintext: plaintext as string,
      signatureVerified,
      signerFingerprint,
      signaturePresent,
    }
  }

  protected async validateCert(
    publicArmored: string,
  ): Promise<CertValidation> {
    const { readKey } = await import('openpgp')
    const key = await readKey({ armoredKey: publicArmored })
    const fingerprint = key.getFingerprint()
    let encryptionSubkeyCount = 0
    try {
      await key.getEncryptionKey()
      encryptionSubkeyCount = 1
    } catch {
      // No usable encryption-capable subkey (expired, revoked, or absent).
    }
    const userIds = key.getUserIDs()
    return { fingerprint, encryptionSubkeyCount, userIds }
  }

  protected async rotateKeyMaterial(_accountJid: string): Promise<KeyBundle> {
    // Key rotation on web requires adding a new subkey. openpgp.js v6 supports
    // this via `addSubkey`. For MVP we throw a clear error so the UI can hide
    // the rotation button on web.
    throw new E2EEPluginError(
      'permanent',
      'not-supported',
      'WebOpenPGPPlugin: key rotation is not yet supported on web — use the desktop app',
    )
  }

  protected async backupEncrypt(_accountJid: string, passphrase: string): Promise<string> {
    await this.requireUnlocked()
    const { createMessage, encrypt } = await import('openpgp')
    // Wrap binary TSK packets (not armored text) to match Sequoia's format.
    const tskBinary = this.ownPrivateKey!.write() as Uint8Array
    const message = await createMessage({ binary: tskBinary })
    const encrypted = await encrypt({ message, passwords: [normalizeBackupPassphrase(passphrase)] })
    return encrypted as string
  }

  protected async backupImport(
    _accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle> {
    const { readMessage, decrypt, readPrivateKey, encryptKey } = await import('openpgp')

    // Decrypt the backup message. Use format:'binary' to handle both
    // Sequoia-generated backups (binary TSK) and legacy web backups
    // (armored TSK text) uniformly.
    const message = await readMessage({ armoredMessage: backupMessage })
    let tskBytes: Uint8Array
    try {
      const { data } = await decrypt({ message, passwords: [normalizeBackupPassphrase(passphrase)], format: 'binary' })
      tskBytes = data as Uint8Array
    } catch (err) {
      throw new E2EEPluginError(
        'permanent',
        'wrong-passphrase',
        'WebOpenPGPPlugin: backup decryption failed — wrong passphrase',
        err,
      )
    }

    // Parse the recovered private key — try binary first (Sequoia format),
    // fall back to armored (legacy web format).
    let privateKey
    try {
      privateKey = await readPrivateKey({ binaryKey: tskBytes })
    } catch {
      privateKey = await readPrivateKey({ armoredKey: new TextDecoder().decode(tskBytes) })
    }

    // Store encrypted with the backup passphrase (which becomes the session passphrase)
    const encrypted = await encryptKey({ privateKey, passphrase })
    const ctx = this.requireCtx()
    await ctx.storage.put(PRIVATE_KEY_STORAGE_KEY, new TextEncoder().encode(encrypted.armor()))

    // Accept the backup passphrase as the session passphrase for this session
    setSessionPassphrase(passphrase)
    this.ownPrivateKey = privateKey

    return this.bundleFromKey(privateKey)
  }

  protected async backupImportAll(
    _accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle[]> {
    const { readMessage, decrypt, readPrivateKeys } = await import('openpgp')

    const message = await readMessage({ armoredMessage: backupMessage })
    let tskBytes: Uint8Array
    try {
      const { data } = await decrypt({
        message,
        passwords: [normalizeBackupPassphrase(passphrase)],
        format: 'binary',
      })
      tskBytes = data as Uint8Array
    } catch (err) {
      throw new E2EEPluginError(
        'permanent',
        'wrong-passphrase',
        'WebOpenPGPPlugin: backup decryption failed — wrong passphrase',
        err,
      )
    }

    let keys: PrivateKey[]
    try {
      keys = await readPrivateKeys({ binaryKeys: tskBytes })
    } catch {
      keys = await readPrivateKeys({
        armoredKeys: new TextDecoder().decode(tskBytes),
      })
    }

    this.pendingImportKeys.clear()
    for (const key of keys) {
      this.pendingImportKeys.set(key.getFingerprint(), key)
    }

    return keys.map((k) => ({
      fingerprint: k.getFingerprint(),
      publicArmored: k.toPublic().armor(),
      keychainBacked: false,
      createdAt: k.getCreationTime().toISOString(),
    }))
  }

  protected async backupImportSelected(
    _accountJid: string,
    _backupMessage: string,
    passphrase: string,
    selectedFingerprint: string,
  ): Promise<KeyBundle> {
    const { encryptKey } = await import('openpgp')

    const privateKey = this.pendingImportKeys.get(selectedFingerprint)
    if (!privateKey) {
      this.pendingImportKeys.clear()
      throw new E2EEPluginError(
        'permanent',
        'not-found',
        `WebOpenPGPPlugin: no pending import key for fingerprint ${selectedFingerprint}`,
      )
    }

    const encrypted = await encryptKey({ privateKey, passphrase })
    const ctx = this.requireCtx()
    await ctx.storage.put(PRIVATE_KEY_STORAGE_KEY, new TextEncoder().encode(encrypted.armor()))

    setSessionPassphrase(passphrase)
    this.ownPrivateKey = privateKey
    this.pendingImportKeys.clear()

    return {
      ...this.bundleFromKey(privateKey),
      createdAt: privateKey.getCreationTime().toISOString(),
    }
  }

  protected async forgetAccount(_accountJid: string): Promise<void> {
    const ctx = this.requireCtx()
    await ctx.storage.delete(PRIVATE_KEY_STORAGE_KEY).catch(() => {})
    this.ownPrivateKey = null
    this.pendingImportKeys.clear()
  }

  // ---------------------------------------------------------------------------
  // Platform-specific file I/O (browser download / file input)
  // ---------------------------------------------------------------------------

  async exportKeyToFile(passphrase: string): Promise<boolean> {
    const ctx = this.requireCtx()
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        'WebOpenPGPPlugin: no identity to export',
      )
    }
    const armoredMessage = await this.backupEncrypt(ctx.account.jid, passphrase)
    const blob = new Blob([armoredMessage], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = 'openpgp-backup.asc'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } finally {
      URL.revokeObjectURL(url)
    }
    return true
  }

  async pickKeyFile(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.asc,.pgp,.gpg'
      input.style.display = 'none'
      document.body.appendChild(input)

      input.onchange = () => {
        const file = input.files?.[0]
        document.body.removeChild(input)
        if (!file) {
          resolve(null)
          return
        }
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => resolve(null)
        reader.readAsText(file)
      }

      input.oncancel = () => {
        document.body.removeChild(input)
        resolve(null)
      }

      input.click()
    })
  }

  // ---------------------------------------------------------------------------
  // Lifecycle overrides
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.ownPrivateKey = null
    await super.shutdown()
  }

  // ---------------------------------------------------------------------------
  // Web-specific public API
  // ---------------------------------------------------------------------------

  /**
   * Unlock the plugin with a passphrase (decrypts the stored private key
   * into memory). Called by the unlock dialog after the user confirms.
   * Throws if the passphrase is wrong.
   */
  async unlock(passphrase: string): Promise<void> {
    setSessionPassphrase(passphrase)
    try {
      // Re-run ensureIdentity to decrypt the key and re-publish if needed.
      await this.ensureIdentity()
      // Activate PEP and store subscriptions now that the key is loaded.
      this.activateSubscriptions()
    } catch (err) {
      // Roll back passphrase on failure so the locked state is preserved.
      clearSessionPassphrase()
      throw err
    }
  }

  /** True when no private key is stored in IndexedDB for this account yet. */
  async hasNoLocalKey(): Promise<boolean> {
    if (!this.ctx) return true
    const stored = await this.ctx.storage.get(PRIVATE_KEY_STORAGE_KEY)
    return stored === null
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async generateAndStoreKey(
    accountJid: string,
    passphrase: string,
    storage: { put(key: string, value: Uint8Array): Promise<void> },
  ): Promise<KeyBundle> {
    const { generateKey, encryptKey } = await import('openpgp')
    const { privateKey } = await generateKey({
      type: 'ecc',
      curve: (USE_V6_KEYS ? 'curve25519' : 'curve25519Legacy') as 'curve25519Legacy',
      userIDs: [{ name: `xmpp:${accountJid}` }],
      format: 'object',
    })
    const encrypted = await encryptKey({ privateKey, passphrase })
    await storage.put(PRIVATE_KEY_STORAGE_KEY, new TextEncoder().encode(encrypted.armor()))
    this.ownPrivateKey = privateKey
    return this.bundleFromKey(privateKey)
  }

  private bundleFromKey(privateKey: PrivateKey): KeyBundle {
    return {
      fingerprint: privateKey.getFingerprint(),
      publicArmored: privateKey.toPublic().armor(),
      keychainBacked: false,
    }
  }

  private async requireUnlocked(): Promise<void> {
    if (!this.ownPrivateKey) {
      throw new E2EEPluginError(
        'transient',
        'key-locked',
        'WebOpenPGPPlugin: no private key in memory — unlock with passphrase first',
      )
    }
  }
}
