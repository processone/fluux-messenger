import { roomMessageAuthor, type MessageActor } from './messageIdentity'
import type { RoomMessage } from '../core/types/room'
import { getRoomModerationId } from './roomStanzaId'

/** Metadata retained on a tombstone after a room service authorizes moderation. */
export interface ModerationMetadata {
  isModerated: true
  moderatedBy?: string
  moderationReason?: string
}

export function moderationMetadata(message: {
  isModerated?: boolean
  moderatedBy?: string
  moderationReason?: string
}): ModerationMetadata | undefined {
  return message.isModerated ? {
    isModerated: true,
    ...(message.moderatedBy !== undefined && { moderatedBy: message.moderatedBy }),
    ...(message.moderationReason !== undefined && { moderationReason: message.moderationReason }),
  } : undefined
}

/** XEP-0425 addresses the room's archive id; client ids are never moderator targets. */
export function roomRetractionAuthorized(
  message: Pick<RoomMessage, 'id' | 'roomJid' | 'from' | 'occupantId' | 'stanzaId'>,
  record: MessageActor & { targetId?: string; moderation?: ModerationMetadata },
  accountJid?: string | null,
): boolean {
  return record.moderation
    ? record.actorJid === message.roomJid && !!record.targetId && getRoomModerationId(message, accountJid) === record.targetId
    : roomMessageAuthor(message, record)
}

/** A duplicate notification may omit metadata already supplied by the service. */
export function mergeModerationMetadata(
  previous?: ModerationMetadata,
  incoming?: ModerationMetadata
): ModerationMetadata | undefined {
  return previous || incoming ? { ...previous, ...incoming, isModerated: true } : undefined
}

/** Match the whole free-text reason after trimming and case folding. */
export function isSpamModerated(message: {
  isRetracted?: boolean
  isModerated?: boolean
  moderationReason?: string
}): boolean {
  return message.isRetracted === true && message.isModerated === true &&
    message.moderationReason?.trim().toLowerCase() === 'spam'
}
