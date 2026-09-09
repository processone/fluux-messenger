import { resolveCorrectionUpdates, type StoredMessage, type StoredRoomMessage } from '../../core/types/message-internal'
import { archiveIdentityConflict, CHAT_SCOPE, chatMessageAuthor, roomMessageAuthor, roomScope, sameLogicalMessage } from '../../utils/messageIdentity'
import { reconcileChatHistoryMessages, reconcileRoomHistoryMessages } from '../../utils/messageCache'
import { getStorageScopeJid } from '../../utils/storageScope'

type Row = StoredMessage | StoredRoomMessage

export function matchesCorrectionTarget(held: Row, incoming: Row): boolean {
  if (held.type !== incoming.type || archiveIdentityConflict(held, incoming)) return false
  const actor = { actorJid: incoming.from, actorOccupantId: incoming.type === 'groupchat' ? incoming.occupantId : undefined }
  if (held.type === 'chat' && incoming.type === 'chat') {
    return held.conversationId === incoming.conversationId && chatMessageAuthor(held, actor) && sameLogicalMessage(CHAT_SCOPE, held, incoming)
  }
  return held.type === 'groupchat' && incoming.type === 'groupchat' && held.roomJid === incoming.roomJid &&
    roomMessageAuthor(held, actor) && sameLogicalMessage(roomScope(held.roomJid), held, incoming)
}

export function reconcileCorrectionHandoff<T extends Row>(held: T | undefined, incoming: T, scope: string | null): T | undefined {
  if (!held || !matchesCorrectionTarget(held, incoming)) return undefined
  const updates = resolveCorrectionUpdates(held, {
    body: incoming.body,
    isEdited: incoming.isEdited,
    originalBody: incoming.originalBody,
    attachment: incoming.attachment,
    encryptedPayload: incoming.encryptedPayload,
    unsupportedEncryption: incoming.unsupportedEncryption,
    securityContext: incoming.securityContext,
    correctionTimestamp: incoming.correctionTimestamp,
    correctionTimestampSource: incoming.correctionTimestampSource,
    correctionRevision: incoming.correctionRevision,
    correctionAlternatives: incoming.correctionAlternatives,
    correctionStanzaIds: incoming.correctionStanzaIds,
    correctionHandoff: incoming.correctionHandoff,
    contentRecovery: incoming.contentRecovery,
  }, scope)
  const result = {
    ...held,
    ...updates,
    ...(incoming.isRetracted && { isRetracted: true, retractedAt: held.retractedAt ?? incoming.retractedAt }),
  }
  return result.isRetracted ? {
    ...result, body: '', originalBody: undefined, attachment: undefined,
    linkPreview: undefined, poll: undefined, pollClosed: undefined,
    encryptedPayload: undefined, unsupportedEncryption: undefined, correctionAlternatives: undefined,
  } : result
}

/** Reconcile duplicate cache rows without replacing resident reactions or message identity. */
export function reconcileCachedCorrections<T extends Row>(resident: T[], cached: readonly T[], scope: string | null): T[] {
  let messages = resident
  for (const incoming of cached) {
    if (!incoming.isEdited && !incoming.isRetracted && !incoming.correctionStanzaIds?.length) continue
    for (let index = 0; index < messages.length; index++) {
      const held = messages[index]
      const updated = reconcileCorrectionHandoff(held, incoming, scope)
      if (!updated) continue
      const next = updated
      // Metadata unions can allocate equivalent arrays; unchanged hydration keeps row references.
      const unchanged = (Object.keys(next) as (keyof T)[]).every(key =>
        key === 'correctionRevision' || key === 'correctionStanzaIds' || key === 'correctionAlternatives'
          ? JSON.stringify(next[key]) === JSON.stringify(held[key])
          : next[key] === held[key]
      )
      if (unchanged) continue
      if (messages === resident) messages = [...resident]
      messages[index] = next
    }
  }
  return messages
}

export async function refreshCachedCorrections<T extends Row>(cached: T[], isCurrent: () => boolean): Promise<T[]> {
  if (!cached.length || !isCurrent()) return []
  const scope = getStorageScopeJid()
  const refreshed = cached[0].type === 'chat'
    ? await reconcileChatHistoryMessages(cached as StoredMessage[], () => [], scope)
    : await reconcileRoomHistoryMessages(cached as StoredRoomMessage[], () => [], scope)
  return isCurrent() ? reconcileCachedCorrections(cached, refreshed as T[], scope) : []
}
