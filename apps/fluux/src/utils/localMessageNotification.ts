import { getLocalPart, isNotificationMessageReady } from '@fluux/sdk'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'
import { formatLocalizedPreview } from './messagePreviewText'
import { formatUnreadCount } from './formatUnreadCount'
import { newMessagesText } from './swMessages'
import type { CommunicationMetadata } from './nativeNotification'
import { communicationPrototypeAvailable } from '@/platform'

export type LocalMessageNotification =
  | { kind: 'chat'; entity: Conversation; message: Message }
  | { kind: 'room'; entity: Room; message: RoomMessage }

type Translate = Parameters<typeof formatLocalizedPreview>[1]

/** Local message text policy: docs/NOTIFICATION_CONTENT.md and its shared native/TS fixtures. */
export function buildLocalMessageNotification(target: LocalMessageNotification, t: Translate, language: string, web: boolean, count = target.entity.unreadCount) {
  if (!isNotificationMessageReady(target.message)) return undefined
  const preview = formatLocalizedPreview(target.message, t)
  if (!preview.trim()) return undefined
  const coalesced = count > 1
  const baseTitle = target.kind === 'chat'
    ? target.entity.name || getLocalPart(target.message.from)
    : target.entity.name
  const title = target.kind === 'chat'
    ? !web && coalesced ? `${baseTitle} (${formatUnreadCount(count)})` : baseTitle
    : web && coalesced ? baseTitle : `${target.message.nick} @ ${baseTitle}`
  return {
    title,
    body: web && coalesced ? newMessagesText(language, count) : preview,
    navType: target.kind === 'chat' ? 'conversation' as const : 'room' as const,
    navTarget: target.kind === 'chat' ? target.entity.id : target.entity.jid,
    messageId: target.message.id,
    count,
  }
}

/** Issue #1386: structured native metadata, never parsed from the composed title. */
export function communicationMetadata(target: LocalMessageNotification): CommunicationMetadata | undefined {
  if (!communicationPrototypeAvailable()) return undefined
  if (target.kind === 'chat') return {
    senderId: target.entity.id,
    senderName: target.entity.name || getLocalPart(target.message.from),
  }
  // Occupancy is the same last-known set used by iOS. Unknown sender/self means native fallback.
  return {
    senderId: target.message.occupantId || target.entity.occupants.get(target.message.nick)?.occupantId || target.message.nick,
    senderName: target.message.nick,
    senderNick: target.message.nick,
    participantIds: Object.fromEntries([...target.entity.occupants.values()].map(occupant => [occupant.nick, occupant.occupantId || occupant.nick])),
    roomName: target.entity.name,
    ownNick: target.entity.nickname,
    participants: [...target.entity.occupants.values()].map(occupant => occupant.nick),
  }
}
