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

/**
 * Typed wrapper over Tauri's `invoke`. Abstracted so tests can inject a
 * fake implementation without dynamically importing `@tauri-apps/api/core`.
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export interface SequoiaPgpPluginOptions {
  /** Tauri command dispatcher. Tests pass a mock; app code passes the real one. */
  invoke: InvokeFn
  /** Bounds on native calls, in milliseconds. Defaults to {@link NATIVE_CALL_TIMEOUTS_MS}. */
  timeouts?: Partial<NativeCallTimeouts>
}

interface NativeCallTimeouts {
  /** Encrypt, decrypt, cert validation and key-file probe. */
  routineMs: number
  /** Commands listed in {@link KEY_MATERIAL_COMMANDS}. */
  keyMaterialMs: number
}

/**
 * Every native call is bounded because iOS suspends the WKWebView web process
 * about a second after the app is backgrounded, and an `invoke` in flight at
 * that moment may never settle. An unbounded call would hold its caller
 * forever: plugin registration never completes, or a decrypt never returns.
 *
 * Routine commands finish in milliseconds; 30 s only fires for a lost call.
 * Key-material commands run the Argon2id at-rest KDF (once or twice per call),
 * key generation, and an OS keychain read that can wait on an unlock prompt
 * answered by the user (macOS keychain, Linux Secret Service), so they get two
 * minutes. Expiry rejects with a "timeout" message, which
 * `classifyBoundaryError` reads as transient: the caller keeps the work
 * retryable. The Rust side finishes the abandoned command and caches the
 * unlocked key, so the retry is fast.
 */
const NATIVE_CALL_TIMEOUTS_MS: NativeCallTimeouts = {
  routineMs: 30_000,
  keyMaterialMs: 120_000,
}

const KEY_MATERIAL_COMMANDS = new Set([
  'openpgp_ensure_key',
  // Explicit forget can wait on one authorization per retained old item.
  'openpgp_forget_account',
  'openpgp_rotate_encryption_subkey',
  'openpgp_backup_encrypt',
  'openpgp_backup_import',
  'openpgp_backup_import_all',
  'openpgp_backup_import_selected',
])

class NativeCallTimeoutError extends Error {
  constructor(cmd: string, ms: number) {
    super(`SequoiaPgpPlugin: native call ${cmd} timeout after ${ms} ms`)
    this.name = 'NativeCallTimeoutError'
  }
}

/** Rejects with {@link NativeCallTimeoutError} when `invoke` has not settled within the bound; a late outcome is dropped. */
function boundedInvoke(invoke: InvokeFn, timeouts: NativeCallTimeouts): InvokeFn {
  return <T>(cmd: string, args?: Record<string, unknown>) => {
    const ms = KEY_MATERIAL_COMMANDS.has(cmd) ? timeouts.keyMaterialMs : timeouts.routineMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NativeCallTimeoutError(cmd, ms)), ms)
    })
    return Promise.race([invoke<T>(cmd, args), expiry]).finally(() => clearTimeout(timer))
  }
}

export class SequoiaPgpPlugin extends OpenPGPPluginBase {
  private readonly invoke: InvokeFn

  constructor(options: SequoiaPgpPluginOptions) {
    super()
    this.invoke = boundedInvoke(options.invoke, { ...NATIVE_CALL_TIMEOUTS_MS, ...options.timeouts })
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

  protected async encryptToRecipients(
    accountJid: string,
    recipientPublics: string[],
    plaintext: string,
  ): Promise<string> {
    return this.invoke<string>('openpgp_encrypt', {
      senderAccountJid: accountJid,
      recipientPublicArmored: recipientPublics,
      plaintext,
    })
  }

  protected async decryptWithOwnKey(
    accountJid: string,
    ciphertext: string,
    senderPublics: string[],
  ): Promise<DecryptOutput> {
    return this.invoke<DecryptOutput>('openpgp_decrypt', {
      accountJid,
      ciphertext,
      senderPublicArmored: senderPublics,
    })
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
    const { save } = await import('@tauri-apps/plugin-dialog')
    const filePath = await save({
      defaultPath: keyExportFilename(ctx.account.jid),
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
    } catch (err) {
      // A lost call says nothing about the key file. Reporting "absent" would
      // route a device that holds its key to the identity-choice flow.
      if (err instanceof NativeCallTimeoutError) throw err
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
