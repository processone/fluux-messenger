import type { Message } from '@fluux/sdk'

/**
 * A message arrived end-to-end encrypted if it was successfully decrypted
 * (`securityContext` set) or is still awaiting a deferred decrypt
 * (`encryptedPayload` set). Used to decide whether quoting it in a cleartext
 * reply would leak the original — see Chat.sendMessage's strip guard.
 */
export function isEncryptedSource(
  message: Pick<Message, 'securityContext' | 'encryptedPayload'>,
): boolean {
  return !!(message.securityContext || message.encryptedPayload)
}
