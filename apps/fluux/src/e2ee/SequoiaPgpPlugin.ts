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
  type DecryptOutput,
  type KeyBundle,
  classifyBoundaryError,
} from './OpenPGPPluginBase'

/**
 * Typed wrapper over Tauri's `invoke`. Abstracted so tests can inject a
 * fake implementation without dynamically importing `@tauri-apps/api/core`.
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export interface SequoiaPgpPluginOptions {
  /** Tauri command dispatcher. Tests pass a mock; app code passes the real one. */
  invoke: InvokeFn
}

export class SequoiaPgpPlugin extends OpenPGPPluginBase {
  private readonly invoke: InvokeFn

  constructor(options: SequoiaPgpPluginOptions) {
    super()
    this.invoke = options.invoke
  }

  protected pluginName(): string {
    return 'SequoiaPgpPlugin'
  }

  // ---------------------------------------------------------------------------
  // Abstract crypto method implementations (Rust via Tauri IPC)
  // ---------------------------------------------------------------------------

  protected async ensureKeyMaterial(accountJid: string): Promise<KeyBundle> {
    try {
      return await this.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid,
        userId: accountJid,
      })
    } catch (err) {
      throw this.toPluginError('ensureKeyMaterial', err)
    }
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
  ): Promise<{ fingerprint: string; encryptionSubkeyCount: number }> {
    return this.invoke<{ fingerprint: string; encryptionSubkeyCount: number }>(
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
      armoredMessage = await this.backupEncrypt(ctx.account.jid, passphrase)
    } catch (err) {
      throw this.toPluginError('exportKeyToFile', err)
    }
    const { save } = await import('@tauri-apps/plugin-dialog')
    const filePath = await save({
      defaultPath: 'openpgp-backup.asc',
      filters: [{ name: 'OpenPGP Armor', extensions: ['asc', 'pgp', 'gpg'] }],
    })
    if (!filePath) return false
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(filePath, armoredMessage)
    return true
  }

  async pickKeyFile(): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({
      multiple: false,
      filters: [{ name: 'OpenPGP Armor', extensions: ['asc', 'pgp', 'gpg'] }],
    })
    if (!result) return null
    const filePath = typeof result === 'string' ? result : result[0]
    if (!filePath) return null
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    return readTextFile(filePath)
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
