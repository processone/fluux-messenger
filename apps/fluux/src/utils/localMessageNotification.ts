import { getLocalPart, isNotificationMessageReady } from '@fluux/sdk'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'
import { formatLocalizedPreview } from './messagePreviewText'
import { formatUnreadCount } from './formatUnreadCount'
import { newMessagesText } from './swMessages'

export type LocalMessageNotification =
  | { kind: 'chat'; entity: Conversation; message: Message }
  | { kind: 'room'; entity: Room; message: RoomMessage }

type Translate = Parameters<typeof formatLocalizedPreview>[1]

/** Build local message notification text after resolving content and eligibility. */
export function buildLocalMessageNotification(target: LocalMessageNotification, t: Translate, language: string, web: boolean) {
  if (!isNotificationMessageReady(target.message)) return undefined
  const preview = formatLocalizedPreview(target.message, t)
  if (!preview.trim()) return undefined
  const count = target.entity.unreadCount
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
