/**
 * Sequoia-PGP plugin for XEP-0373 (OpenPGP for XMPP, "OX") — Tauri desktop.
 *
 * Thin subclass of {@link OpenPGPPluginBase} that delegates all crypto
 * operations to the Rust backend via Tauri IPC commands. Key generation,
 * encryption, decryption, and signature verification all execute in Rust;
 * PEP publication, conversation state, and peer key management live in the
 * base class and are shared with the web plugin.
 *
 * Key persistence is owned by the Rust side: the secret key is written to
 * an ASCII-armored file under the app data dir, encrypted under a per-account
 * passphrase stored in the OS keychain (with a 0600 file fallback).
 * `openpgp_ensure_key` is idempotent — the first call per account per process
 * generates or loads; subsequent calls are served from an in-memory cache.
 */

import { E2EEPluginError } from '@fluux/sdk'
import {
  OpenPGPPluginBase,
  type CertValidation,
  type DecryptOutput,
  type KeyBundle,
  classifyBoundaryError,
} from './OpenPGPPluginBase'
import { accountUserId } from './openpgpUserId'
import { keyExportFilename } from './keyExportNaming'
import type { OpenPGPHostStores, OpenPGPFileIO } from './hostStores'

/**
 * Typed wrapper over Tauri's `invoke`. Abstracted so tests can inject a
 * fake implementation without dynamically importing `@tauri-apps/api/core`.
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export interface SequoiaPgpPluginOptions {
  /** Tauri command dispatcher. Tests pass a mock; app code passes the real one. */
  invoke: InvokeFn
  /** App-injected adapter over the six trust stores. */
  hostStores: OpenPGPHostStores
  /** App-injected Tauri file dialogs (keeps @tauri-apps/* out of the package). */
  fileIO: OpenPGPFileIO
}

export class SequoiaPgpPlugin extends OpenPGPPluginBase {
  private readonly invoke: InvokeFn
  private readonly fileIO: OpenPGPFileIO

  constructor(options: SequoiaPgpPluginOptions) {
    super({ hostStores: options.hostStores })
    this.invoke = options.invoke
    this.fileIO = options.fileIO
  }

  protected pluginName(): string {
    return 'SequoiaPgpPlugin'
  }

  // ---------------------------------------------------------------------------
  // Abstract crypto method implementations (Rust via Tauri IPC)
  // ---------------------------------------------------------------------------

  protected async ensureKeyMaterial(accountJid: string): Promise<KeyBundle> {
    // Defence in depth (mirrors WebOpenPGPPlugin): refuse silent
    // generation when the server already holds an OpenPGP identity for
    // this account AND we have no local key on disk. Without this
    // guard, `openpgp_ensure_key` would generate a fresh key and the
    // base class would then publish it, overwriting whatever metadata
    // is on the server — silently forking the identity for any
    // sibling device (other desktop, web browser) that still holds
    // the matching private key.
    //
    // The probe runs only when no local key is persisted, so the
    // common case (returning user, key on disk) pays no extra IPC.
    // `_allowSilentRegenerate` (set by retireAndGenerateIdentity)
    // skips both the local-key check and the probe.
    if (!this._allowSilentRegenerate && (await this.hasNoLocalKey())) {
      await this.assertSilentGenerationAllowed(accountJid)
    }
    try {
      return await this.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid,
        userId: accountUserId(accountJid),
      })
    } catch (err) {
      throw this.toPluginError('ensureKeyMaterial', err)
    }
  }

  /**
   * Inverse of {@link hasPersistedKey}, exposed for parity with the web
   * subclass so consumers (App.tsx auto-init, EncryptionSettings
   * toggle handler, the identity-choice dialog router) can probe with
   * a uniform method name regardless of platform. Returns `true` when
   * the OS keychain / on-disk store has no key for this account.
   */
  async hasNoLocalKey(): Promise<boolean> {
    return !(await this.hasPersistedKey())
  }

  protected async encryptToRecipient(
    senderAccountJid: string,
    recipientPublicArmored: string,
    plaintext: string,
  ): Promise<string> {
    return this.invoke<string>('openpgp_encrypt', {
      senderAccountJid,
      recipientPublicArmored,
      plaintext,
    })
  }

  protected async decryptWithOwnKey(
    accountJid: string,
    ciphertext: string,
    senderPublicArmored: string | null,
  ): Promise<DecryptOutput> {
    const rust = await this.invoke<{
      plaintext: string
      signatureVerified: boolean
      signerFingerprint: string | null
      signaturePresent: boolean
    }>('openpgp_decrypt', {
      accountJid,
      ciphertext,
      senderPublicArmored,
    })
    return rust
  }

  protected async validateCert(
    publicArmored: string,
  ): Promise<CertValidation> {
    return this.invoke<CertValidation>(
      'openpgp_validate_cert',
      { publicArmored },
    )
  }

  protected async rotateKeyMaterial(accountJid: string): Promise<KeyBundle> {
    return this.invoke<KeyBundle>('openpgp_rotate_encryption_subkey', { accountJid })
  }

  protected async backupEncrypt(accountJid: string, passphrase: string): Promise<string> {
    return this.invoke<string>('openpgp_backup_encrypt', { accountJid, passphrase })
  }

  protected async backupImport(
    accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle> {
    return this.invoke<KeyBundle>('openpgp_backup_import', {
      accountJid,
      backupMessage,
      passphrase,
    })
  }

  protected async backupImportAll(
    _accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle[]> {
    return this.invoke<KeyBundle[]>('openpgp_backup_import_all', {
      backupMessage,
      passphrase,
    })
  }

  protected async backupImportSelected(
    accountJid: string,
    backupMessage: string,
    passphrase: string,
    selectedFingerprint: string,
  ): Promise<KeyBundle> {
    return this.invoke<KeyBundle>('openpgp_backup_import_selected', {
      accountJid,
      backupMessage,
      passphrase,
      selectedFingerprint,
    })
  }

  protected async forgetAccount(accountJid: string): Promise<void> {
    await this.invoke<void>('openpgp_forget_account', { accountJid })
  }

  // ---------------------------------------------------------------------------
  // Platform-specific file I/O (Tauri native dialogs)
  // ---------------------------------------------------------------------------

  async exportKeyToFile(passphrase: string): Promise<boolean> {
    const ctx = this.requireCtx()
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        'SequoiaPgpPlugin: no identity to export — call ensureIdentity first',
      )
    }
    let armoredMessage: string
    try {
      armoredMessage = await this.buildExportArmor(passphrase)
    } catch (err) {
      throw this.toPluginError('exportKeyToFile', err)
    }
    return this.fileIO.saveFile(keyExportFilename(ctx.account.jid), armoredMessage)
  }

  async pickKeyFile(): Promise<string | null> {
    return this.fileIO.pickFile()
  }

  // ---------------------------------------------------------------------------
  // Tauri-specific extras (not part of E2EEPlugin interface)
  // ---------------------------------------------------------------------------

  /** @internal Used by the settings UI to check if a key already exists on disk. */
  async hasPersistedKey(): Promise<boolean> {
    const ctx = this.requireCtx()
    try {
      return await this.invoke<boolean>('openpgp_has_persisted_key', {
        accountJid: ctx.account.jid,
      })
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Classify errors at the Tauri boundary (kept for backward compat with tests)
  // ---------------------------------------------------------------------------

  /** @internal */
  static classifyBoundaryError(err: unknown) {
    return classifyBoundaryError(err)
  }
}
