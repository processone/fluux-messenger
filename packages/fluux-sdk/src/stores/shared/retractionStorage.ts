/**
 * The durable half of a retraction (XEP-0424) — shared by the chat and room stores.
 *
 * A tombstone in the resident window is a rendering decision. This module is the
 * one that makes the retraction TRUE of the data: the cached row loses its
 * content and the search document goes away. Both stores route every retraction
 * through here — the resident path, the pending-record replay, and the case this
 * module exists for, a retraction whose target is not resident at all.
 *
 * An evicted or never-loaded target leaves no resident object to patch, so the
 * durable cache resolves its tiered identity ladder of stanzaId → originId →
 * from+id. Search documents carry optional identity fields to prove ownership,
 * but the cache remains the canonical boundary for resolving and expanding
 * logical copies before their content is scrubbed and their index entries are
 * removed.
 *
 * @module Stores/Shared/RetractionStorage
 */

import type { Message } from '../../core/types/chat'
import type { RoomMessage } from '../../core/types/room'
import * as messageCache from '../../utils/messageCache'
import * as searchIndex from '../../utils/searchIndex'
import {
  chatRetractionAliases,
  clearPendingRetractionIdentity,
  consumePendingRetractionIdentity,
  noteRetractedIdentity,
  notePendingRetractionIdentity,
  roomRetractionAliases,
  type RetractionScope,
} from '../../utils/retractedIdentities'
import { getStorageScopeJid } from '../../utils/storageScope'
import { canonicalReference, chatMessageAuthor, roomMessageAuthor } from '../../utils/messageIdentity'
import { type PendingRetraction } from './pendingRetractions'

export type PendingRetractionOutcome = 'pending' | 'consumed' | 'resolved'

/**
 * Apply a retraction to the durable copies of a KNOWN chat message.
 *
 * The ledger note comes first and is not conditional on the cache write finding
 * a row: when the message's own save is still in flight there is nothing to
 * update yet, and the note is what stops that save from landing the body (see
 * `retractedIdentities.ts`).
 */
export async function retractChatMessageInStorage(
  conversationId: string,
  message: Message,
  updates: Partial<Message> = {},
  storageScope: string | null = getStorageScopeJid(),
  targetReference: string = canonicalReference(message)
): Promise<void> {
  // `updates` carries whatever else the same event set — XEP-0425 moderation
  // arrives as a retraction plus its moderator fields, and dropping them here
  // would leave the cached row saying only "deleted".
  const retractedAt = message.retractedAt ?? updates.retractedAt ?? new Date()
  const scope: RetractionScope = { kind: 'chat', entityId: conversationId, accountScope: storageScope }
  noteRetractedIdentity(scope, chatRetractionAliases(message), message, retractedAt.getTime())
  const resolution = await messageCache.findChatRetractionTargets(
    conversationId,
    targetReference,
    storageScope
  )
  const actor = { actorJid: message.from }
  const targets = new Map<string, Message>([[message.id, message]])
  for (const candidate of resolution?.candidates ?? []) {
    if (chatMessageAuthor(candidate, actor)) targets.set(candidate.id, candidate)
  }
  const queue = [...targets.values()]
  for (let index = 0; index < queue.length; index++) {
    const target = queue[index]
    const copies = await messageCache.findChatMessageCopies(
      conversationId,
      target,
      storageScope
    )
    for (const candidate of copies) {
      if (targets.has(candidate.id) || !chatMessageAuthor(candidate, actor)) continue
      targets.set(candidate.id, candidate)
      queue.push(candidate)
    }
  }
  for (const target of targets.values()) {
    const targetRetractedAt = target.retractedAt ?? retractedAt
    noteRetractedIdentity(
      scope,
      chatRetractionAliases(target),
      target,
      targetRetractedAt.getTime()
    )
    await messageCache.updateMessage(
      target.id,
      { ...updates, isRetracted: true, retractedAt: targetRetractedAt },
      storageScope,
      { conversationId: target.conversationId, from: target.from }
    )
    await searchIndex.removeMessage(target, storageScope)
  }
}

/** Room twin of {@link retractChatMessageInStorage}. */
export async function retractRoomMessageInStorage(
  roomJid: string,
  message: RoomMessage,
  updates: Partial<RoomMessage> = {},
  storageScope: string | null = getStorageScopeJid()
): Promise<void> {
  // See the chat twin: `updates` may carry XEP-0425 moderator fields.
  const retractedAt = message.retractedAt ?? updates.retractedAt ?? new Date()
  const scope: RetractionScope = { kind: 'room', entityId: roomJid, accountScope: storageScope }
  noteRetractedIdentity(scope, roomRetractionAliases(message), message, retractedAt.getTime())
  const actor = { actorJid: message.from, actorOccupantId: message.occupantId }
  const copies = (await messageCache.findRoomMessageCopies(
    roomJid,
    message,
    storageScope
  )).filter((copy) => roomMessageAuthor(copy.message, actor))
  const targets: messageCache.RoomMessageCopy[] = copies.length > 0
    ? copies
    : [{
        cacheKey: '',
        identityKeys: roomRetractionAliases(message),
        ids: [message.id],
        message,
      }]
  for (const target of targets) {
    const targetRetractedAt = target.message.retractedAt ?? retractedAt
    noteRetractedIdentity(
      scope,
      roomRetractionAliases(target.message),
      target.message,
      targetRetractedAt.getTime()
    )
    await messageCache.updateRoomMessage(
      roomJid,
      target.message.id,
      { ...updates, isRetracted: true, retractedAt: targetRetractedAt },
      target.message.from,
      storageScope,
      target.message,
      target.cacheKey || undefined
    )
    await searchIndex.removeMessage(
      target.message,
      storageScope,
      { identityKeys: target.identityKeys, ids: target.ids }
    )
  }
}

/**
 * Apply a retraction whose target is NOT in the resident window, by resolving it
 * against the durable cache.
 *
 * An unresolved reference retains its actor until a cache row arrives, so the
 * write boundary can verify authorship before adopting the retraction.
 */
export async function retractUnresidentChatTarget(
  conversationId: string,
  record: PendingRetraction,
  storageScope: string | null = getStorageScopeJid()
): Promise<PendingRetractionOutcome> {
  const scope: RetractionScope = { kind: 'chat', entityId: conversationId, accountScope: storageScope }
  notePendingRetractionIdentity(scope, record.targetId, record)

  const resolution = await messageCache.findChatRetractionTargets(
    conversationId,
    record.targetId,
    storageScope
  )
  const targets = resolution?.candidates.filter((message) =>
    chatMessageAuthor(message, record)
  ) ?? []
  if (targets.length === 0 && resolution?.authoritative) {
    clearPendingRetractionIdentity(scope, record.targetId)
    return 'consumed'
  }
  if (targets.length === 0) return 'pending'

  await retractChatMessageInStorage(
    conversationId,
    targets[0],
    { retractedAt: new Date(record.retractedAt) },
    storageScope,
    record.targetId
  )
  consumePendingRetractionIdentity(
    scope,
    record.targetId,
    record,
    resolution?.authoritative ?? false
  )
  return 'resolved'
}

/**
 * Room twin of {@link retractUnresidentChatTarget}.
 *
 * The candidate list can hold more than one row — after a nick reassignment an
 * old archive copy and a recent message share room, nick and client id. The
 * XEP-0424 authorship gate picks between them on the occupant-id, exactly as it
 * does for a resident window. Cache resolution returns only the highest matching
 * identity tier.
 */
export async function retractUnresidentRoomTarget(
  roomJid: string,
  record: PendingRetraction,
  storageScope: string | null = getStorageScopeJid()
): Promise<PendingRetractionOutcome> {
  const scope: RetractionScope = { kind: 'room', entityId: roomJid, accountScope: storageScope }
  notePendingRetractionIdentity(scope, record.targetId, record)

  const resolution = await messageCache.findRoomRetractionTargets(
    roomJid,
    record.targetId,
    storageScope
  )
  const target = resolution?.candidates.find((message) =>
    roomMessageAuthor(message, record)
  )
  if (!target && resolution?.authoritative) {
    clearPendingRetractionIdentity(scope, record.targetId)
    return 'consumed'
  }
  if (!target) return 'pending'

  await retractRoomMessageInStorage(
    roomJid,
    target,
    { retractedAt: new Date(record.retractedAt) },
    storageScope
  )
  consumePendingRetractionIdentity(
    scope,
    record.targetId,
    record,
    resolution?.authoritative ?? false
  )
  return 'resolved'
}
