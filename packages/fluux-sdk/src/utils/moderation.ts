import { archiveIdentityConflict, retractionPrecedesDelivery, roomMessageAuthor, type MessageActor, type RoomIdentityFields } from './messageIdentity'
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

/** Whether a retraction reference names the message by one of its archive or origin ids. */
function namesArchiveIdentity(message: RoomIdentityFields, targetId: string | undefined): boolean {
  return !!targetId && (message.stanzaId === targetId || message.originId === targetId ||
    message.correctionStanzaIds?.includes(targetId) === true)
}

/**
 * XEP-0425 addresses the room's archive id; client ids are never moderator targets.
 *
 * A XEP-0424 record that names its target by client id alone cannot be about a
 * first delivery received after the retraction was; see
 * `retractionPrecedesDelivery`.
 */
export function roomRetractionAuthorized(
  message: RoomIdentityFields,
  record: MessageActor & { targetId?: string; moderation?: ModerationMetadata; retractedAt?: number },
  accountJid?: string | null,
): boolean {
  if (record.moderation) {
    return record.actorJid === message.roomJid && !!record.targetId && getRoomModerationId(message, accountJid) === record.targetId
  }
  if (record.retractedAt !== undefined && !namesArchiveIdentity(message, record.targetId) &&
    retractionPrecedesDelivery(message, record.retractedAt)) return false
  return roomMessageAuthor(message, record)
}

/**
 * Whether a verified-ledger record (`retractedIdentities.ts`) reached through a
 * room message's aliases is about that message. A record reached through the
 * `from+id` alias alone cannot be about a first delivery received after the
 * retraction was (`retractionPrecedesDelivery`): the race the ledger guards has
 * the target received BEFORE it.
 */
export function roomRetractionRecordApplies(
  message: RoomIdentityFields,
  record: MessageActor & { stanzaId?: string; originId?: string; retractedAt: number; moderation?: ModerationMetadata },
  accountJid?: string | null,
): boolean {
  const archiveCorroborated = !!record.stanzaId && message.stanzaId === record.stanzaId ||
    !!record.originId && message.originId === record.originId
  return roomMessageAuthor(message, record) && !archiveIdentityConflict(message, record)
    && (archiveCorroborated || !retractionPrecedesDelivery(message, record.retractedAt))
    && (!record.moderation || !!record.stanzaId && getRoomModerationId(message, accountJid) === record.stanzaId)
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
