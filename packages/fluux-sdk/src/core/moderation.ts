import type { Element } from '@xmpp/client'
import { getResource } from './jid'
import { NS_FASTEN, NS_MESSAGE_MODERATE, NS_RETRACT } from './namespaces'
import type { ModerationMetadata } from '../utils/moderation'

const MODERATE_V0 = 'urn:xmpp:message-moderate:0'
const RETRACT_V0 = 'urn:xmpp:message-retract:0'

export function readModeration(moderated: Element, wrapper: Element = moderated): ModerationMetadata {
  // XEP-0425 v1 places reason beside moderated. ejabberd may qualify it with
  // message-moderate:1, whereas the XEP example inherits message-retract:1.
  const reason = wrapper.getChildText('reason') || moderated.getChildText('reason') || undefined
  const moderatedBy = moderated.attrs.by ? getResource(moderated.attrs.by) : undefined
  return { isModerated: true, moderatedBy, moderationReason: reason }
}

/** Parse broadcast structure; the caller must verify the bare room sender. */
export function parseModerationSignal(message: Element): { targetId: string; moderation: ModerationMetadata } | undefined {
  const retract = message.getChild('retract', NS_RETRACT)
  const v1 = retract?.getChild('moderated', NS_MESSAGE_MODERATE)
  if (v1 && retract?.attrs.id) return { targetId: retract.attrs.id, moderation: readModeration(v1, retract) }
  const applyTo = message.getChild('apply-to', NS_FASTEN)
  const v0 = applyTo?.getChild('moderated', MODERATE_V0)
  if (v0 && applyTo?.attrs.id) return { targetId: applyTo.attrs.id, moderation: readModeration(v0) }
  const legacy = message.getChild('moderated', NS_MESSAGE_MODERATE)
  if (legacy?.attrs.id) return { targetId: legacy.attrs.id, moderation: readModeration(legacy) }
}

/** Archive-only tombstones replace the original payload, retaining its identity. */
export function parseModerationTombstone(message: Element): (ModerationMetadata & { isRetracted: true; retractedAt?: Date }) | undefined {
  const v1 = message.getChild('retracted', NS_RETRACT)
  const v1Moderator = v1?.getChild('moderated', NS_MESSAGE_MODERATE)
  const v0Moderator = message.getChild('moderated', MODERATE_V0)
  const v0 = v0Moderator?.getChild('retracted', RETRACT_V0)
  const retracted = v1Moderator ? v1 : v0
  const moderated = v1Moderator ?? (v0 ? v0Moderator : undefined)
  if (!retracted || !moderated) return
  const stamp = retracted.attrs.stamp ? new Date(retracted.attrs.stamp) : undefined
  return {
    ...readModeration(moderated, v1Moderator ? retracted : moderated),
    isRetracted: true,
    ...(stamp && !Number.isNaN(stamp.getTime()) && { retractedAt: stamp }),
  }
}
