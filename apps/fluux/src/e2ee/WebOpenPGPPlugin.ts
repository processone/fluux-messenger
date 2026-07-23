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
import { E2EEPluginError, isE2EEPluginError } from '@fluux/sdk'
import {
  OpenPGPPluginBase,
  type CertValidation,
  type DecryptOutput,
  type KeyBundle,
  type RestoreResult,
} from './OpenPGPPluginBase'
import { accountUserId } from './openpgpUserId'
import { keyExportFilename } from './keyExportNaming'
import { KeyPickerRequiredError, NoRecoveryAvailableError } from './recoveryErrors'
import { clearSessionPassphrase, getSessionPassphrase, setSessionPassphrase } from './webPassphraseStore'
import { USE_V6_KEYS } from './passphraseGenerator'
import { prepareBackupPassphrase } from './backupPassphrase'
import { detectArmorKind } from './armorDetect'
import { parseSecretKeysFromBackupPayload } from './backupKeyMaterial'

const PRIVATE_KEY_STORAGE_KEY = 'private-key'

/**
 * Clock-skew tolerance applied when verifying a signature's *creation time*.
 *
 * openpgp.js rejects any signature whose creation time is after the
 * verification date ("Signature creation time is in the future") with zero
 * tolerance. When a sender's machine clock runs even slightly ahead of the
 * verifier's, a freshly-signed message is rejected as "invalid signature" —
 * intermittently, depending on the instantaneous skew. We verify against
 * `now + this window` so modest clock skew doesn't cause spurious rejections.
 *
 * This only widens the *future* bound of the signature timestamp; message
 * freshness/replay is enforced separately by the signcrypt `<time>` envelope
 * check ({@link SIGNCRYPT_CLOCK_SKEW_MS}). Accepting a slightly-future
 * signature carries no authenticity risk — forging one still requires the
 * signing key.
 */
const SIGNATURE_CLOCK_SKEW_TOLERANCE_MS = 60 * 60 * 1000 // 1 hour

/**
 * A local-key failure that the server backup might fix: the stored blob
 * won't decrypt with this passphrase, or there's no local blob but the
 * server advertises an identity. Both are worth a backup-recovery attempt.
 */
function isRecoverableLocalFailure(err: unknown): boolean {
  return (
    isE2EEPluginError(err) &&
    (err.code === 'wrong-passphrase' || err.code === 'needs-identity-decision')
  )
}

/** Decide the final error after BOTH the local key and the backup failed. */
function classifyRecoveryFailure(localErr: unknown, recoverErr: unknown): Error {
  const localCode = isE2EEPluginError(localErr) ? localErr.code : undefined
  const recoverCode = isE2EEPluginError(recoverErr) ? recoverErr.code : undefined
  if (recoverCode === 'no-backup') {
    // No secret backup to recover from. When the local failure was a
    // published-identity-without-backup, preserve that error so the host's
    // existing IdentityChoiceDialog routing (import file / retire) applies.
    if (localCode === 'needs-identity-decision') {
      return localErr instanceof Error ? localErr : new Error(String(localErr))
    }
    return new NoRecoveryAvailableError(localCode === 'wrong-passphrase', recoverErr)
  }
  if (recoverCode === 'wrong-passphrase') {
    return new E2EEPluginError(
      'permanent',
      'wrong-passphrase',
      'WebOpenPGPPlugin: wrong passphrase — neither the local key nor the server backup could be decrypted',
      recoverErr,
    )
  }
  // Transient (server unreachable, etc.) — surface as-is so the user retries.
  return recoverErr instanceof Error ? recoverErr : new Error(String(recoverErr))
}

/** Save `content` as `filename` via a transient `<a download>` anchor. */
function triggerBrowserDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    URL.revokeObjectURL(url)
  }
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
      let decrypted: PrivateKey
      try {
        decrypted = await decryptKey({ privateKey: encryptedKey, passphrase })
      } catch (err) {
        // Do NOT swallow the real reason: the message is almost always a
        // genuine wrong passphrase, but it can also be a corrupt/foreign
        // blob. Log the underlying cause and keep it on the error chain so
        // unlock()'s recovery path and any future diagnosis can see it.
        this.requireCtx().logger.warn(
          `WebOpenPGPPlugin: stored private key did not decrypt: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        throw new E2EEPluginError(
          'permanent',
          'wrong-passphrase',
          'WebOpenPGPPlugin: could not decrypt stored private key — wrong passphrase',
          err,
        )
      }
      // Outside the catch on purpose: a heal failure must never be reported
      // as a wrong passphrase.
      const privateKey = await this.clearKeyExpiration(decrypted, accountJid, passphrase)
      this.ownPrivateKey = privateKey
      return this.bundleFromKey(privateKey)
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
      // Verify against now + skew tolerance so a sender whose clock runs
      // slightly ahead doesn't trip openpgp.js's zero-tolerance "creation
      // time is in the future" rejection. See SIGNATURE_CLOCK_SKEW_TOLERANCE_MS.
      date: new Date(Date.now() + SIGNATURE_CLOCK_SKEW_TOLERANCE_MS),
      ...(verificationKeys.length > 0 && { verificationKeys }),
    })

    let signatureVerified = false
    let signerFingerprint: string | null = null
    let signatureNotYetValid = false
    const signaturePresent = signatures.length > 0

    if (signaturePresent && senderPublicArmored) {
      try {
        await signatures[0].verified
        signatureVerified = true
        // Return the primary cert fingerprint (40 hex chars for v4) to
        // match Sequoia's behavior. keyID.toHex() only gives the 8-byte
        // key ID (16 chars), which would never match the cached peer FP.
        signerFingerprint = verificationKeys[0].getFingerprint()
      } catch (err) {
        signatureVerified = false
        const reason = err instanceof Error ? err.message : String(err)
        // A failure caused purely by the signature being dated ahead of our
        // clock (beyond the skew tolerance) is transient — clocks may
        // converge. Flag it so the decrypt path retries instead of issuing a
        // permanent rejection. Any other reason (bad key, tamper) is genuine.
        signatureNotYetValid = /creation time is in the future|not yet valid/i.test(reason)
        // DIAGNOSTIC: surface why openpgp.js rejected the signature — the
        // message names the cause (time-window vs EdDSA/MPI vs key lookup).
        // The signature creation time is pulled separately so this log can
        // never throw out of the catch even if `.signature` rejected too.
        let sigCreated = '?'
        try {
          const sig = await signatures[0].signature
          sigCreated = sig?.packets?.[0]?.created?.toISOString() ?? '?'
        } catch {
          /* signature packet unavailable — leave as '?' */
        }
        this.requireCtx().logger.warn(
          `WebOpenPGPPlugin: signature verify failed (signer ${
            verificationKeys[0]?.getFingerprint?.() ?? '?'
          }, sigCreated ${sigCreated}, now ${new Date().toISOString()}): ${reason}`,
        )
      }
    }

    return {
      plaintext: plaintext as string,
      signatureVerified,
      signerFingerprint,
      signaturePresent,
      ...(signatureNotYetValid && { signatureNotYetValid }),
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
    // Every subkey fingerprint, independent of usage/expiry — these identify
    // the key material so the own-key consistency check can tell "same key,
    // re-signed" from "a different key was published" (OpenPGPPluginBase).
    const subkeyFingerprints = key.getSubkeys().map((sk) => sk.getFingerprint())
    return { fingerprint, encryptionSubkeyCount, userIds, subkeyFingerprints }
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
    // #1021: the passphrase is used verbatim (trim only) so the code shown
    // to the user unlocks this backup in Gajim and other XEP-0373 clients.
    const encrypted = await encrypt({ message, passwords: [prepareBackupPassphrase(passphrase)] })
    return encrypted as string
  }

  protected async backupImport(
    accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle> {
    const { readMessage, decrypt, encryptKey } = await import('openpgp')

    // Decrypt the backup message. Use format:'binary' to handle both
    // Sequoia-generated backups (binary TSK) and legacy web backups
    // (armored TSK text) uniformly.
    const message = await readMessage({ armoredMessage: backupMessage })
    let tskBytes: Uint8Array
    try {
      const { data } = await decrypt({ message, passwords: [prepareBackupPassphrase(passphrase)], format: 'binary' })
      tskBytes = data as Uint8Array
    } catch (err) {
      throw new E2EEPluginError(
        'permanent',
        'wrong-passphrase',
        'WebOpenPGPPlugin: backup decryption failed — wrong passphrase',
        err,
      )
    }

    // Recover the secret key, accepting a binary TSK, a single armored private
    // key, or OpenKeychain's public-then-private armored payload. A single-key
    // backup yields exactly one; take the first.
    const [parsed] = await parseSecretKeysFromBackupPayload(tskBytes)
    const privateKey = await this.ensureAccountUserId(parsed, accountJid)

    // Store encrypted with the backup passphrase (which becomes the session passphrase)
    const encrypted = await encryptKey({ privateKey, passphrase })
    const ctx = this.requireCtx()
    await ctx.storage.put(PRIVATE_KEY_STORAGE_KEY, new TextEncoder().encode(encrypted.armor()))

    // Accept the backup passphrase as the session passphrase for this session
    setSessionPassphrase(passphrase)
    this.ownPrivateKey = privateKey

    return this.bundleFromKey(privateKey)
  }

  /**
   * Decrypt a Fluux/Sequoia backup container (an OpenPGP MESSAGE wrapping
   * a binary TSK under a passphrase-derived SKESK) and return the
   * decrypted PrivateKey objects found inside.
   *
   * Wrong-passphrase failures are translated to E2EEPluginError; parse
   * failures propagate so the caller can decide whether to retry with a
   * different format.
   */
  private async decryptBackupMessage(
    backupMessage: string,
    passphrase: string,
  ): Promise<PrivateKey[]> {
    const { readMessage, decrypt } = await import('openpgp')

    const message = await readMessage({ armoredMessage: backupMessage })
    let tskBytes: Uint8Array
    try {
      const { data } = await decrypt({
        message,
        passwords: [prepareBackupPassphrase(passphrase)],
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

    // The payload is either a binary TSK (Fluux/Sequoia) or armored key blocks
    // (OpenKeychain: a public block then a private block); branch accordingly.
    return parseSecretKeysFromBackupPayload(tskBytes)
  }

  /**
   * Decrypt a raw armored OpenPGP transferable secret key (the output of
   * `gpg --export-secret-keys --armor`). Each key's secret material is
   * S2K-protected with the user's GnuPG passphrase; we unlock them all
   * up front so the rest of the import pipeline sees decrypted keys, the
   * same shape `decryptBackupMessage` returns.
   */
  private async decryptRawPrivateKeys(
    armoredKey: string,
    passphrase: string,
  ): Promise<PrivateKey[]> {
    const { readPrivateKeys, decryptKey } = await import('openpgp')

    let keys: PrivateKey[]
    try {
      keys = await readPrivateKeys({ armoredKeys: armoredKey })
    } catch (err) {
      throw new E2EEPluginError(
        'permanent',
        'malformed-data',
        'WebOpenPGPPlugin: could not parse private key block',
        err,
      )
    }

    const decrypted: PrivateKey[] = []
    for (const key of keys) {
      if (key.isDecrypted()) {
        decrypted.push(key)
        continue
      }
      try {
        decrypted.push(await decryptKey({ privateKey: key, passphrase }))
      } catch (err) {
        throw new E2EEPluginError(
          'permanent',
          'wrong-passphrase',
          'WebOpenPGPPlugin: private key decryption failed — wrong passphrase',
          err,
        )
      }
    }
    return decrypted
  }

  protected async backupImportAll(
    _accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle[]> {
    const kind = detectArmorKind(backupMessage)
    let keys: PrivateKey[]
    if (kind === 'private-key') {
      keys = await this.decryptRawPrivateKeys(backupMessage, passphrase)
    } else if (kind === 'message') {
      keys = await this.decryptBackupMessage(backupMessage, passphrase)
    } else {
      throw new E2EEPluginError(
        'permanent',
        'malformed-data',
        'WebOpenPGPPlugin: file is neither an OpenPGP message nor a private key block',
      )
    }

    this.pendingImportKeys.clear()
    const bundles: KeyBundle[] = []
    for (const key of keys) {
      try {
        // openpgp.js applies `rejectPublicKeyAlgorithms` here, so a key
        // whose only encryption-capable subkey is ElGamal (or whose
        // primary key alone has no encryption subkey) throws.
        await key.getEncryptionKey()
      } catch (err) {
        throw new E2EEPluginError(
          'permanent',
          'unsupported-key-algorithm',
          `WebOpenPGPPlugin: imported key ${key.getFingerprint()} has no usable encryption subkey`,
          err,
        )
      }
      this.pendingImportKeys.set(key.getFingerprint(), key)
      bundles.push({
        fingerprint: key.getFingerprint(),
        publicArmored: key.toPublic().armor(),
        keychainBacked: false,
        createdAt: key.getCreationTime().toISOString(),
      })
    }
    return bundles
  }

  /**
   * Canonicalize an imported key to the XEP-0373 §8.5 trust anchor: a single
   * `xmpp:<jid>` User ID. A foreign key (GnuPG / OpenKeychain) carries a
   * `Name <email>` UID, so we re-sign it with just the `xmpp:` UID: adding the
   * anchor peers verify and dropping the name/email (Fluux publishes no
   * real-name component). The primary key is preserved, so the fingerprint (and
   * trust pinning) is unchanged. A key that is already exactly `xmpp:`-only
   * (e.g. a restored Fluux backup) is returned untouched, so it isn't re-signed.
   *
   * NOTE: if key generation ever starts adding a name/email UID, relax this to
   * keep them rather than stripping to xmpp:-only.
   */
  private async ensureAccountUserId(
    privateKey: PrivateKey,
    accountJid: string,
  ): Promise<PrivateKey> {
    const expected = accountUserId(accountJid)
    const uids = privateKey.getUserIDs()
    if (uids.length === 1 && uids[0].toLowerCase() === expected.toLowerCase()) {
      return privateKey
    }
    const { reformatKey } = await import('openpgp')
    const { privateKey: reformatted } = await reformatKey({
      privateKey,
      userIDs: [{ name: expected }],
      format: 'object',
    })
    return reformatted
  }

  protected async backupImportSelected(
    accountJid: string,
    _backupMessage: string,
    passphrase: string,
    selectedFingerprint: string,
  ): Promise<KeyBundle> {
    const { encryptKey } = await import('openpgp')

    const pending = this.pendingImportKeys.get(selectedFingerprint)
    if (!pending) {
      this.pendingImportKeys.clear()
      throw new E2EEPluginError(
        'permanent',
        'not-found',
        `WebOpenPGPPlugin: no pending import key for fingerprint ${selectedFingerprint}`,
      )
    }
    const privateKey = await this.ensureAccountUserId(pending, accountJid)

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
    const armoredMessage = await this.buildExportArmor(passphrase)
    triggerBrowserDownload(armoredMessage, keyExportFilename(ctx.account.jid))
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
   *
   * On a normal unlock, returns `{ recovered: false }`. If the local key
   * could not be decrypted but a server backup was successfully restored,
   * returns `{ recovered: true }`. Throws on unrecoverable failures.
   */
  async unlock(passphrase: string): Promise<{ recovered: boolean }> {
    setSessionPassphrase(passphrase)
    try {
      // Happy path: decrypt the local key and publish/subscribe.
      await this.ensureIdentity()
      this.activateSubscriptions()
      // The local key is now decrypted into memory — re-run deferred decrypts
      // so messages stashed while locked are recovered. (The recovery branch
      // below routes through restoreSecretKey → doInstallKey, which already
      // notifies, so only this happy path needs an explicit call.)
      this.requireCtx().notifyKeyUnlocked?.()
      // The key is usable now — re-run the trust-state seal check so a deferred
      // `awaiting-key` verdict resolves to `sealed`. `init()` returns early
      // (no subscriptions) when the key was locked, so `activateSubscriptions()`
      // above runs it for that case; this explicit call covers re-unlock where
      // subscriptions were already active.
      void this.verifyTrustStateOnInit()
      return { recovered: false }
    } catch (err) {
      if (!isRecoverableLocalFailure(err)) {
        clearSessionPassphrase()
        throw err
      }
      // The local copy is missing or won't open with this passphrase. The
      // key is recoverable from the server backup if the passphrase is the
      // current one — try that before giving up.
      let result: RestoreResult
      try {
        result = await this.restoreSecretKey(passphrase)
      } catch (recoverErr) {
        clearSessionPassphrase()
        throw classifyRecoveryFailure(err, recoverErr)
      }
      if ('needsPicker' in result) {
        clearSessionPassphrase()
        throw new KeyPickerRequiredError(result.candidates, result.backupContext)
      }
      // restoreSecretKey installed + published the recovered key and set the
      // session passphrase. Report recovery.
      // restoreSecretKey() -> doInstallKey() already re-verifies the trust state.
      return { recovered: true }
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
      userIDs: [{ name: accountUserId(accountJid) }],
      // Stated rather than inherited from the library default: Gajim refuses
      // to restore an expiring secret key from the XEP-0373 §5 node, so a
      // silent upstream change here would break cross-client recovery.
      keyExpirationTime: 0,
      format: 'object',
    })
    const encrypted = await encryptKey({ privateKey, passphrase })
    await storage.put(PRIVATE_KEY_STORAGE_KEY, new TextEncoder().encode(encrypted.armor()))
    this.ownPrivateKey = privateKey
    return this.bundleFromKey(privateKey)
  }

  /**
   * Clear the key expiration that blocks a cross-client restore, returning
   * the key unchanged when it already has none.
   *
   * Gajim's XEP-0373 §5 restore refuses outright any secret key whose
   * primary carries an expiration ("Imported key has expiration date"). The
   * expiry lives in the key's self-signatures rather than in the backup
   * blob, so re-publishing the backup cannot fix it — the key itself has to
   * be re-signed. `reformatKey` rebuilds the self-signatures over the same
   * key packets, so the fingerprint (and every published identity and pinned
   * peer trust that hangs off it) survives.
   *
   * Mirrors `strip_key_expiration` in `src-tauri/src/openpgp.rs`; openpgp.js
   * defaults to no expiry, so this is reached only by keys imported from
   * another implementation.
   *
   * A failure is logged and tolerated: an unhealed key still works locally,
   * and failing the unlock would lock the user out of their own messages
   * over an interop nicety.
   */
  private async clearKeyExpiration(
    privateKey: PrivateKey,
    accountJid: string,
    passphrase: string,
  ): Promise<PrivateKey> {
    if ((await privateKey.getExpirationTime()) === Infinity) return privateKey

    const { reformatKey, encryptKey } = await import('openpgp')
    try {
      const { privateKey: reformatted } = await reformatKey({
        privateKey,
        // The canonical XEP-0373 §8.5 trust anchor, matching what
        // generateAndStoreKey emits and what ensureAccountUserId enforces.
        userIDs: [{ name: accountUserId(accountJid) }],
        keyExpirationTime: 0,
        format: 'object',
      })
      const encrypted = await encryptKey({ privateKey: reformatted, passphrase })
      await this.requireCtx().storage.put(
        PRIVATE_KEY_STORAGE_KEY,
        new TextEncoder().encode(encrypted.armor()),
      )
      this.requireCtx().logger.info(
        'WebOpenPGPPlugin: cleared key expiration so the backup can be restored elsewhere',
      )
      return reformatted
    } catch (err) {
      this.requireCtx().logger.warn(
        `WebOpenPGPPlugin: could not clear key expiration: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return privateKey
    }
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
