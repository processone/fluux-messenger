import type { RoomMessage } from '../core/types/room'
import type { MessageRowRef } from '../core/types/messageRow'
import { getBareJid } from '../core/jid'
import { getStorageScopeJid } from './storageScope'

type RoomIdentity = Pick<RoomMessage, 'roomJid' | 'id' | 'from' | 'occupantId' | 'stanzaId' | 'localRowRef'>
  & { timestamp?: Date | number; body?: string; originalBody?: string; isOutgoing?: boolean; isRetracted?: boolean }

export type RowIdentityFields = MessageRowRef & Partial<Pick<RoomMessage, 'roomJid' | 'from' | 'localRowRef'>>

/** XEP-0359: room ingestion stores only the ID assigned by this room. */
export function getRoomModerationId(message: RoomIdentity, accountJid: string | null = getStorageScopeJid()): string | undefined {
  if ((accountJid ? getBareJid(accountJid) : null) !== getStorageScopeJid()) return undefined
  return message.stanzaId && getBareJid(message.from) === message.roomJid ? message.stanzaId : undefined
}

/** Ignore the redundant metadata carried by older cache records. */
export function withoutLegacyRoomAuthority<T extends object>(value: T): T {
  if (!('stanzaIdAuthority' in value)) return value
  const { stanzaIdAuthority: _obsolete, ...rest } = value
  return rest as T
}

/** A local row reference, including its room's archive discriminator when present. */
export function messageRowRef(message: RowIdentityFields): MessageRowRef {
  return {
    id: message.id,
    ...(message.occupantId ? { occupantId: message.occupantId } : {}),
    ...(message.stanzaId ? { stanzaId: message.stanzaId } : {}),
    // Preserve the serialized spelling used by existing room pointers and anchors.
    ...(message.unconfirmed !== undefined ? { unconfirmed: message.unconfirmed }
      : message.stanzaId && message.roomJid && message.from ? { unconfirmed: false } : {}),
  }
}

export function roomStanzaIdsMergeable(a: RoomIdentity, b: RoomIdentity): boolean {
  if (a.roomJid !== b.roomJid) return false
  if (a.occupantId && b.occupantId ? a.occupantId !== b.occupantId : a.from !== b.from) return false
  // A reused client ID cannot attach a different received occurrence to a legacy row.
  if (!!a.stanzaId !== !!b.stanzaId && a.id === b.id && a.occupantId && a.occupantId === b.occupantId &&
    !a.isOutgoing && !b.isOutgoing && a.timestamp !== undefined && b.timestamp !== undefined &&
    Number.isFinite(+a.timestamp) && Number.isFinite(+b.timestamp)) {
    if (+a.timestamp !== +b.timestamp) return false
    const archived = a.stanzaId ? a : b
    const legacy = a.stanzaId ? b : a
    // A persisted alias survives edits, decryption and removal of the body.
    if (archived.localRowRef?.id === legacy.id && archived.localRowRef.occupantId === legacy.occupantId &&
      archived.localRowRef.stanzaId === legacy.stanzaId) return true
    if (!a.isRetracted && !b.isRetracted && (a.originalBody ?? a.body) !== undefined &&
      (b.originalBody ?? b.body) !== undefined && (a.originalBody ?? a.body) !== (b.originalBody ?? b.body)) return false
  }
  return !a.stanzaId || !b.stanzaId || a.stanzaId === b.stanzaId
}

export function mergeRoomStanzaId(a: RoomIdentity, b: RoomIdentity, merged: RoomIdentity) {
  const compatible = roomStanzaIdsMergeable(a, b)
  const legacy = !a.stanzaId ? a : !b.stanzaId ? b : undefined
  // A local pointer may acquire an archive name only for the exact same occurrence.
  const localRowRef = a.localRowRef ?? b.localRowRef ?? (compatible && legacy &&
    a.id === b.id && !!a.occupantId && a.occupantId === b.occupantId &&
    a.timestamp !== undefined && b.timestamp !== undefined && Number.isFinite(+a.timestamp) &&
    +a.timestamp === +b.timestamp && (a.originalBody ?? a.body) !== undefined &&
    (a.originalBody ?? a.body) === (b.originalBody ?? b.body) ? messageRowRef(legacy) : undefined)
  return { stanzaId: compatible ? a.stanzaId ?? b.stanzaId : merged.stanzaId, localRowRef }
}

export function backfillRoomStanzaId<T extends RoomIdentity & { originId?: string }>(current: T, donor: T): T {
  if (!roomStanzaIdsMergeable(current, donor)) return current
  const identity = mergeRoomStanzaId(current, donor, current)
  const originId = current.originId ?? donor.originId
  return identity.stanzaId === current.stanzaId && identity.localRowRef === current.localRowRef && originId === current.originId
    ? current : { ...current, ...identity, originId }
}
