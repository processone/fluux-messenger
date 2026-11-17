import type { BaseMessage } from '../types/message-base'
import { captureStorageScope } from '../../utils/storageScope'

// Activity belongs to one bounded attempt, not to persisted message content.
const attempts = new Set<{
  peer: string
  from: string
  id: string
  payload: string
  scope: ReturnType<typeof captureStorageScope>
}>()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }

export function subscribeDecryptionActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function isMessageDecrypting(peer: string, message?: Pick<BaseMessage, 'id' | 'from' | 'encryptedPayload'>): boolean {
  if (!message?.encryptedPayload) return false
  return [...attempts].some(attempt => attempt.scope.isCurrent() && attempt.peer === peer &&
    attempt.from === message.from && attempt.id === message.id && attempt.payload === message.encryptedPayload)
}

/** Called only after a plugin claims the message, and ended even on timeout. */
export function beginDecryptionActivity(peer: string, message: Pick<BaseMessage, 'id' | 'from' | 'encryptedPayload'>): () => void {
  if (!message.encryptedPayload) return () => {}
  const attempt = { peer, id: message.id, from: message.from, payload: message.encryptedPayload, scope: captureStorageScope() }
  attempts.add(attempt)
  notify()
  return () => { if (attempts.delete(attempt)) notify() }
}
