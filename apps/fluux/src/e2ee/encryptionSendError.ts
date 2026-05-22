import { E2EEEncryptionRequiredError, isE2EEPluginError } from '@fluux/sdk'

/**
 * Map a thrown send error to an i18n key for a user-facing toast, or `null`
 * when the error is unrelated to encryption (the caller should log it).
 *
 * After the SDK stopped silently downgrading to plaintext, an outbound send
 * can reject with either `E2EEEncryptionRequiredError` (no usable encryption
 * for a peer that requires it) or a plugin `E2EEPluginError` (encryption was
 * attempted and failed). The user's typed message is preserved by the
 * composer, so the toast tells them why it did not send and what to do.
 */
export function encryptionSendErrorKey(err: unknown): string | null {
  if (err instanceof E2EEEncryptionRequiredError) {
    return 'chat.encryption.sendBlockedEncryptionRequired'
  }
  if (isE2EEPluginError(err)) {
    switch (err.code) {
      case 'pin-mismatch':
        return 'chat.encryption.sendBlockedKeyChanged'
      case 'key-locked':
        return 'chat.encryption.sendBlockedKeyLocked'
      case 'own-key-conflict':
        return 'chat.encryption.sendBlockedKeyConflict'
      default:
        return 'chat.encryption.sendBlockedGeneric'
    }
  }
  return null
}
