import type { RoomMessage } from '../core/types'
import { roomStore, type RoomState } from '../stores/roomStore'
import { applyPendingRetractions, type PendingRetraction } from '../stores/shared/pendingRetractions'
import { getRoomMessage, getRoomMessageByReference, getRoomMessageByRowRef } from './messageCache'
import { archiveIdentityConflict, identityKeys, mergeableOccupantCandidates, roomMessageAuthor, roomScope, sameLogicalMessage, resolveMessageReference, messageRowRef, matchesMessageRowAlias } from './messageIdentity'
import { moderationMetadata, roomRetractionAuthorized } from './moderation'
import { captureStorageScope } from './storageScope'
import { backfillRoomStanzaId, roomStanzaIdsMergeable } from './roomStanzaId'

const residentIndexes = new WeakMap<RoomMessage[], Map<string, RoomMessage[]>>()
const EMPTY_MESSAGES: RoomMessage[] = []
const EMPTY_RETRACTIONS: PendingRetraction[] = []

function matchingSnapshot(message: RoomMessage, candidate: RoomMessage): boolean {
  if (candidate.roomJid === message.roomJid && +candidate.timestamp === +message.timestamp &&
    roomMessageAuthor(candidate, { actorJid: message.from, actorOccupantId: message.occupantId }) &&
    matchesMessageRowAlias(candidate.localRowRef, messageRowRef(message))) return true
  return candidate.roomJid === message.roomJid &&
    roomStanzaIdsMergeable(message, candidate) &&
    !archiveIdentityConflict(backfillRoomStanzaId(message, candidate), candidate) &&
    (!!message.stanzaId && message.stanzaId === candidate.stanzaId ||
      roomMessageAuthor(candidate, { actorJid: message.from, actorOccupantId: message.occupantId })) &&
    sameLogicalMessage(roomScope(message.roomJid), message, candidate)
}

function residentSnapshot(message: RoomMessage, residents: RoomMessage[]): RoomMessage | undefined {
  let index = residentIndexes.get(residents)
  if (!index) {
    index = new Map()
    for (const resident of residents) {
      for (const key of identityKeys(roomScope(resident.roomJid), resident)) {
        const bucket = index.get(key)
        if (bucket) bucket.push(resident)
        else index.set(key, [resident])
      }
    }
    residentIndexes.set(residents, index)
  }
  const candidates = [...new Set(identityKeys(roomScope(message.roomJid), message)
    .flatMap(key => index.get(key) ?? []))].filter(candidate => matchingSnapshot(message, candidate))
  return mergeableOccupantCandidates(message, candidates)[0]
}

function retainRetraction(message: RoomMessage, current: RoomMessage): RoomMessage {
  if (!message.isRetracted || current === message) return current
  if (current.isRetracted && (!message.isModerated || current.isModerated &&
    (message.moderationReason === undefined || current.moderationReason === message.moderationReason) &&
    (message.moderatedBy === undefined || current.moderatedBy === message.moderatedBy))) return current
  return { ...current, isRetracted: true, retractedAt: message.retractedAt ?? current.retractedAt,
    ...moderationMetadata(message), ...moderationMetadata(current) }
}

export function reconcileRoomMessageSnapshots(
  messages: RoomMessage[],
  residents: RoomMessage[] = EMPTY_MESSAGES,
  pending: PendingRetraction[] = EMPTY_RETRACTIONS,
): RoomMessage[] {
  const current = messages.map(message => {
    const resident = residentSnapshot(message, residents)
    return resident ? retainRetraction(message, resident) : message
  })
  const source = current.every((message, i) => message === messages[i]) ? messages : current
  return applyPendingRetractions(source, pending, roomRetractionAuthorized).messages
}

export function createRoomMessageSnapshotSelector(messages: RoomMessage[], roomJid?: string) {
  const groups = new Map<string, {
    messages: RoomMessage[]
    residents: RoomMessage[]
    pending: PendingRetraction[]
    resolved: RoomMessage[]
  }>()
  for (const message of messages) {
    if (roomJid && message.roomJid !== roomJid) continue
    let group = groups.get(message.roomJid)
    if (!group) {
      group = { messages: [], residents: EMPTY_MESSAGES, pending: EMPTY_RETRACTIONS, resolved: EMPTY_MESSAGES }
      groups.set(message.roomJid, group)
    }
    group.messages.push(message)
  }
  return (state: RoomState): RoomMessage[] => {
    const current = new Map<RoomMessage, RoomMessage>()
    for (const [jid, group] of groups) {
      const residents = group.messages.map(message => residentSnapshot(message, state.messages.get(jid) ?? EMPTY_MESSAGES) ?? message)
      const pending = (state.pendingRetractions.get(jid) ?? EMPTY_RETRACTIONS).filter(record =>
        resolveMessageReference(residents, record.targetId, 'archive-first')?.candidates
          .some(({ message }) => roomRetractionAuthorized(message, record)))
      if (residents.some((message, i) => message !== group.residents[i]) ||
        pending.length !== group.pending.length || pending.some((record, i) => record !== group.pending[i])) {
        group.residents = residents
        group.pending = pending
        group.resolved = reconcileRoomMessageSnapshots(group.messages, residents, pending)
      }
      group.messages.forEach((message, i) => current.set(message, group.resolved[i]))
    }
    return messages.map(message => current.get(message) ?? message)
  }
}

export async function resolveRoomMessageSnapshot(message: RoomMessage): Promise<RoomMessage> {
  const scope = captureStorageScope()
  const state = roomStore.getState()
  const [known] = reconcileRoomMessageSnapshots([message], state.messages.get(message.roomJid), state.pendingRetractions.get(message.roomJid))
  let cached = residentSnapshot(message, state.messages.get(message.roomJid) ?? EMPTY_MESSAGES)
  if (!cached) {
    // A saved snapshot carries a local row name, including any persisted alias.
    const row = await getRoomMessageByRowRef(message.roomJid, messageRowRef(message))
    scope.assertCurrent()
    if (row && matchingSnapshot(message, row)) cached = row
    else {
      const candidate = await (message.stanzaId
        ? getRoomMessageByReference(message.roomJid, message.stanzaId, message.from).catch(() => null)
        : getRoomMessage(message.roomJid, message.id, message.from, message.occupantId))
      scope.assertCurrent()
      cached = candidate && matchingSnapshot(message, candidate) ? candidate : undefined
    }
  }
  scope.assertCurrent()
  const current = cached && matchingSnapshot(message, cached) ? retainRetraction(known, cached) : known
  const latest = roomStore.getState()
  return reconcileRoomMessageSnapshots([current], latest.messages.get(message.roomJid), latest.pendingRetractions.get(message.roomJid))[0]
}
