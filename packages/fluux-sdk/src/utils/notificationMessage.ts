import type { Message, RoomMessage } from '../core/types'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { isPreviewableMessage } from '../stores/shared/lastMessageUtils'
import { exactPosition, isAfterBoundary } from '../stores/shared/readState'
import type { ReadPointer } from '../core/types/readState'
import { isSpamModerated } from './moderation'
import { archiveIdentityConflict, findChatMessageIndex, roomScope, sameLogicalMessage, selectRoomMergeTargets } from './messageIdentity'
import { getMessage, getRoomMessage, getRoomMessageByReference, isMessageCacheAvailable } from './messageCache'
import { captureStorageScope } from './storageScope'

export function isNotificationMessageReady(message: Parameters<typeof isPreviewableMessage>[0] & Pick<Message, 'encryptedPayload' | 'securityContext'>): boolean {
  return !message.encryptedPayload && !message.securityContext?.failureReason &&
    message.securityContext?.trust !== 'rejected' && !isSpamModerated(message) && isPreviewableMessage(message)
}

/** Whether an observed arrival remains after the read boundary, including imprecise legacy floors. */
export function isNotificationMessageUnread(message: Message | RoomMessage, pointer: ReadPointer | undefined): boolean {
  return !pointer || isAfterBoundary(exactPosition(message, message.type === 'groupchat' ? 'room' : 'chat'), pointer.order)
}

export function findNotificationMessage<T extends Message | RoomMessage>(reference: T, candidates: readonly T[]): T | undefined {
  if (reference.type === 'groupchat') {
    const scope = roomScope(reference.roomJid)
    // A preview can duplicate a resident row; duplicate candidates are not distinct deliveries.
    const copies = new Map<string, T>()
    for (const candidate of candidates) {
      if (!sameLogicalMessage(scope, reference, candidate) || archiveIdentityConflict(reference, candidate)) continue
      const room = candidate as RoomMessage
      const key = JSON.stringify([room.id, room.from, room.stanzaId, room.originId, room.occupantId, room.receivedAt?.getTime(), room.timestamp.getTime()])
      if (!copies.has(key)) copies.set(key, candidate)
    }
    return selectRoomMergeTargets(scope, reference, [...copies.values()])[0]
  }
  return candidates[findChatMessageIndex(candidates, reference)]
}

/** Current in-memory copy, including previews for conversations outside the resident window. */
export function residentNotificationMessage<T extends Message | RoomMessage>(reference: T): T | undefined {
  if (reference.type === 'groupchat') {
    const state = roomStore.getState()
    const preview = state.rooms.get(reference.roomJid)?.lastMessage
    return findNotificationMessage(reference, [
      ...(state.messages.get(reference.roomJid) ?? []), ...(preview ? [preview] : []),
    ] as T[])
  }
  const state = chatStore.getState()
  const preview = state.conversations.get(reference.conversationId)?.lastMessage
  return findNotificationMessage(reference, [
    ...(state.messages.get(reference.conversationId) ?? []), ...(preview ? [preview] : []),
  ] as T[])
}

/** Resolve the latest copy of an observed arrival without loading or replaying its history window. */
export function resolveNotificationMessage(reference: Message): Promise<Message | undefined>
export function resolveNotificationMessage(reference: RoomMessage): Promise<RoomMessage | undefined>
export function resolveNotificationMessage(reference: Message | RoomMessage): Promise<Message | RoomMessage | undefined>
export async function resolveNotificationMessage(reference: Message | RoomMessage): Promise<Message | RoomMessage | undefined> {
  const scope = captureStorageScope()
  const resident = residentNotificationMessage(reference)
  if (resident) return resident
  let cached: Message | RoomMessage | null = null
  if (isMessageCacheAvailable()) {
    cached = reference.type === 'groupchat'
      ? reference.stanzaId
        ? await getRoomMessageByReference(reference.roomJid, reference.stanzaId, reference.from)
        : await getRoomMessage(reference.roomJid, reference.id, reference.from, reference.occupantId)
      : await getMessage(reference.conversationId, reference.id, reference)
  }
  if (!scope.isCurrent()) return undefined
  const current = residentNotificationMessage(reference)
  if (current) return current
  if (cached) return findNotificationMessage(reference, [cached])
  const arrived = reference.type === 'groupchat'
    ? roomStore.getState().lastArrivedMessage.get(reference.roomJid)
    : chatStore.getState().lastArrivedMessage.get(reference.conversationId)
  return arrived ? findNotificationMessage(reference, [arrived]) : undefined
}
