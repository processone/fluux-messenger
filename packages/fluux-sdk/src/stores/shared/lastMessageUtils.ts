/**
 * Shared utilities for lastMessage timestamp comparison and filtering.
 *
 * These functions help determine when to update the lastMessage preview
 * for conversations and rooms, used by both chatStore and roomStore.
 */

import type { BaseMessage, RoomMessage } from '../../core/types'
import { ignoreStore, isMessageFromIgnoredUser } from '../ignoreStore'
import { findMessageIndexById } from '../../utils/messageLookup'

/**
 * Generic interface for messages with an optional timestamp.
 * Both Message and RoomMessage satisfy this interface.
 */
export interface MessageWithTimestamp {
  timestamp?: Date
}

/**
 * Fields that determine whether a message has anything to show in a
 * conversation/room preview. A structural subset of {@link BaseMessage} so
 * both Message and RoomMessage (and lightweight test fixtures) satisfy it.
 */
export type PreviewableMessage = Pick<
  BaseMessage,
  'body' | 'attachment' | 'poll' | 'pollClosed' | 'isRetracted' | 'unsupportedEncryption'
>

/**
 * Whether a message can be rendered as a conversation/room preview.
 *
 * Returns false for "bodiless signal" placeholders that carry no displayable
 * content — most importantly an **encrypted reaction** replayed from MAM before
 * its key was available. Such a stanza is stored as an empty-body message (its
 * `<reactions>` element is sealed inside the ciphertext, so the reaction
 * skip-guards in the live/MAM parsers can't see it) and would otherwise surface
 * as a blank "Me:" preview. It is not a real message and must never become the
 * `lastMessage`.
 *
 * A message is previewable when it would produce visible preview text:
 * - retracted (renders a localized "message deleted")
 * - unsupported encryption (renders a localized notice)
 * - a poll or a closed poll
 * - a file attachment
 * - non-whitespace body text
 *
 * @param msg - Any message-like object
 * @returns true if the message has displayable preview content
 */
export function isPreviewableMessage(msg: PreviewableMessage): boolean {
  if (msg.isRetracted) return true
  if (msg.unsupportedEncryption) return true
  if (msg.poll || msg.pollClosed) return true
  if (msg.attachment) return true
  return !!(msg.body && msg.body.trim().length > 0)
}

/**
 * Decide whether a previewable `candidate` should replace the current
 * `existing` lastMessage.
 *
 * Replaces when:
 * - there is no existing preview, OR
 * - the existing preview is a non-previewable placeholder (e.g. a stuck
 *   bodiless encrypted reaction) — a real message always supersedes it, even
 *   if the placeholder's timestamp is newer, OR
 * - the candidate is strictly newer than the existing preview.
 *
 * The caller is expected to pass a previewable candidate (e.g. the result of
 * {@link findLastPreviewableMessage}).
 *
 * @param existing - The current lastMessage (may be undefined)
 * @param candidate - The previewable candidate message
 * @returns true if candidate should become the new lastMessage
 */
export function shouldReplaceLastMessage<T extends PreviewableMessage & MessageWithTimestamp>(
  existing: T | undefined,
  candidate: T
): boolean {
  if (!existing) return true
  if (!isPreviewableMessage(existing)) return true
  return shouldUpdateLastMessage(existing, candidate)
}

/** Identity + encryption-state fields needed to recognise a resolved preview. */
interface ResolvablePreview {
  id: string
  stanzaId?: string
  originId?: string
  correctionStanzaIds?: string[]
  encryptedPayload?: string
}

/**
 * Whether `candidate` is the SAME underlying message as the current `existing`
 * preview but now *resolved* — its encrypted stash cleared (a deferred decrypt,
 * rejection, or unsupported-encryption resolution) while `existing` still holds
 * the encrypted fallback.
 *
 * A bulk reload (durable cache or MAM merge) uses this to heal a preview stuck on
 * "[OpenPGP-encrypted message]": {@link shouldReplaceLastMessage} gates on a
 * strictly-newer timestamp and refuses a same-id, same-timestamp content change,
 * so without this the sidebar would never update after decryption. It only ever
 * promotes encrypted → resolved (never the reverse), so it cannot clobber a
 * fresher cleartext preview with a stale ciphertext copy.
 *
 * @param existing - The current preview message (may be undefined)
 * @param candidate - The freshly (re)loaded copy of a previewable message
 */
export function isResolvedSamePreview(
  existing: ResolvablePreview | undefined,
  candidate: ResolvablePreview,
): boolean {
  if (!existing?.encryptedPayload) return false
  if (candidate.encryptedPayload) return false
  return findMessageIndexById([existing], candidate.id) !== -1
}

/**
 * Find the newest {@link isPreviewableMessage | previewable} message in a
 * timestamp-sorted array, scanning from the end.
 *
 * Use this instead of `messages[messages.length - 1]` when deriving a
 * `lastMessage` preview: the raw last element may be a bodiless signal
 * placeholder (e.g. an undecrypted encrypted reaction) that must be skipped.
 *
 * @param messages - Array of messages assumed sorted ascending by timestamp
 * @returns The newest previewable message, or undefined if none qualify
 */
export function findLastPreviewableMessage<T extends PreviewableMessage>(
  messages: T[]
): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPreviewableMessage(messages[i])) return messages[i]
  }
  return undefined
}

/**
 * Determines if a new message should replace an existing lastMessage.
 *
 * The new message should only replace the existing one if it has a newer timestamp.
 * This prevents older messages (e.g., from MAM pagination) from overwriting
 * more recent previews.
 *
 * @param existing - The current lastMessage (may be undefined)
 * @param newMessage - The candidate message to potentially use as lastMessage
 * @returns true if newMessage is newer and should replace existing
 *
 * @example
 * ```typescript
 * // In chatStore.updateLastMessagePreview
 * if (!shouldUpdateLastMessage(meta.lastMessage, newMessage)) {
 *   return state // Keep existing, new message is older
 * }
 *
 * // In roomStore.updateLastMessagePreview
 * if (!shouldUpdateLastMessage(room.lastMessage, newMessage)) {
 *   return state
 * }
 * ```
 */
export function shouldUpdateLastMessage<T extends MessageWithTimestamp>(
  existing: T | undefined,
  newMessage: T
): boolean {
  const existingTime = existing?.timestamp?.getTime() ?? 0
  const newTime = newMessage.timestamp?.getTime() ?? 0
  return newTime > existingTime
}

/**
 * Find the last message in an array that is both
 * {@link isPreviewableMessage | previewable} and not from an ignored user.
 *
 * Scans backward from the newest message and returns the first that qualifies,
 * so bodiless signal placeholders (e.g. undecrypted encrypted reactions) and
 * messages from ignored users are skipped when deriving a room preview.
 *
 * @param messages - Array of room messages (assumed sorted by timestamp)
 * @param roomJid - The room JID to look up ignored users for
 * @param nickToJidCache - Optional nick-to-JID cache for JID-based matching
 * @returns The last previewable, non-ignored message, or undefined if none qualify
 */
export function findLastNonIgnoredMessage(
  messages: RoomMessage[],
  roomJid: string,
  nickToJidCache?: Map<string, string>,
): RoomMessage | undefined {
  if (messages.length === 0) return undefined

  const ignoredUsers = ignoreStore.getState().getIgnoredForRoom(roomJid)
  const hasIgnored = ignoredUsers.length > 0

  // Iterate backward to find the last previewable, non-ignored message
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isPreviewableMessage(message)) continue
    if (hasIgnored && isMessageFromIgnoredUser(ignoredUsers, message, nickToJidCache)) continue
    return message
  }
  return undefined
}
