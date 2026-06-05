/**
 * App-layer signals raised by WebOpenPGPPlugin.unlock()'s auto-recovery
 * path so the unlock dialog can react without parsing error messages.
 * Kept in the app (not the SDK): they carry UI-routing payloads and are
 * only consumed by the dialog.
 */
import type { KeyBundle } from './OpenPGPPluginBase'

/** Server backup holds more than one key — the UI must let the user pick. */
export class KeyPickerRequiredError extends Error {
  readonly code = 'needs-picker' as const
  constructor(
    readonly candidates: KeyBundle[],
    readonly backupContext: { message: string; passphrase: string },
  ) {
    super('Multiple keys found in backup; selection required')
    this.name = 'KeyPickerRequiredError'
  }
}

/** No server backup exists to recover from (with or without a local key). */
export class NoRecoveryAvailableError extends Error {
  readonly code = 'no-recovery-available' as const
  override readonly cause?: unknown
  constructor(readonly hadLocalKey: boolean, cause?: unknown) {
    super(
      hadLocalKey
        ? 'The local key could not be decrypted and no server backup is available.'
        : 'No local key and no server backup is available.',
    )
    this.name = 'NoRecoveryAvailableError'
    if (cause !== undefined) this.cause = cause
  }
}
