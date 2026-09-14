import type { RoomMessage } from '../core/types/room'
import type { MessageRowRef } from '../core/types/messageRow'
import { getBareJid } from '../core/jid'
import { getStorageScopeJid } from './storageScope'

type RoomIdentity = Pick<RoomMessage, 'roomJid' | 'id' | 'from' | 'occupantId' | 'stanzaId' | 'stanzaIdAuthority' | 'localRowRef'>
  & { timestamp?: Date | number; body?: string; originalBody?: string }

export type RowIdentityFields = MessageRowRef & Partial<Pick<RoomMessage, 'roomJid' | 'from' | 'stanzaIdAuthority' | 'localRowRef'>>

export function roomStanzaIdAuthority(message: RoomIdentity, accountJid: string | null) {
  if (!message.stanzaId || getBareJid(message.from) !== message.roomJid) return undefined
  return {
    stanzaId: message.stanzaId, roomJid: message.roomJid,
    accountJid: accountJid ? getBareJid(accountJid) : null,
    id: message.id, from: message.from, occupantId: message.occupantId,
  }
}

export function matchingRoomStanzaIdAuthority(message: RoomIdentity) {
  const proof = message.stanzaIdAuthority
  return proof && !!proof.stanzaId && proof.stanzaId === message.stanzaId
    && proof.roomJid === message.roomJid && getBareJid(message.from) === message.roomJid
    && getBareJid(proof.from) === proof.roomJid
    && proof.id === message.id
    && (proof.occupantId ? proof.occupantId === message.occupantId : proof.from === message.from && !message.occupantId)
    ? proof : undefined
}

export function getRoomModerationId(message: RoomIdentity, accountJid: string | null = getStorageScopeJid()): string | undefined {
  const proof = matchingRoomStanzaIdAuthority(message)
  return proof && proof.accountJid === (accountJid ? getBareJid(accountJid) : null) ? proof.stanzaId : undefined
}

/**
 * The row ref naming `message`.
 *
 * `unconfirmed` is TRI-STATE, and each state is load-bearing: `true` for an
 * archive id the room is not proven to have assigned, `false` for one it is, and
 * ABSENT for a ref that predates the distinction or names no archive id at all.
 * A legacy cached row and a genuinely confirmed row can carry the SAME raw id,
 * and then this flag is the only thing separating them.
 *
 * Lives here rather than in `messageIdentity` because the only non-trivial thing
 * it computes is {@link matchingRoomStanzaIdAuthority}; `messageIdentity`
 * re-exports it, and that direction is what keeps the two modules acyclic.
 */
export function messageRowRef(message: RowIdentityFields): MessageRowRef {
  const unconfirmed = message.stanzaId && message.roomJid && message.from
    ? !matchingRoomStanzaIdAuthority({ ...message, roomJid: message.roomJid, from: message.from })
    : message.unconfirmed
  return {
    id: message.id,
    ...(message.occupantId ? { occupantId: message.occupantId } : {}),
    ...(message.stanzaId ? { stanzaId: message.stanzaId } : {}),
    ...(unconfirmed !== undefined ? { unconfirmed } : {}),
  }
}

export function roomStanzaIdsMergeable(a: RoomIdentity, b: RoomIdentity): boolean {
  const ap = matchingRoomStanzaIdAuthority(a)
  const bp = matchingRoomStanzaIdAuthority(b)
  if (!ap && !bp) return true
  if (a.roomJid !== b.roomJid || (a.occupantId && b.occupantId ? a.occupantId !== b.occupantId : a.from !== b.from)) return false
  if (ap && bp) return ap.accountJid === bp.accountJid && ap.stanzaId === bp.stanzaId
  const confirmed = ap ? a : b
  const legacy = ap ? b : a
  return a.id === b.id && !!a.occupantId && a.occupantId === b.occupantId
    && a.timestamp !== undefined && b.timestamp !== undefined
    && Number.isFinite(+a.timestamp) && +a.timestamp === +b.timestamp
    && ((a.originalBody ?? a.body) !== undefined && (a.originalBody ?? a.body) === (b.originalBody ?? b.body) ||
      confirmed.localRowRef?.id === legacy.id && confirmed.localRowRef.occupantId === legacy.occupantId &&
      confirmed.localRowRef.stanzaId === legacy.stanzaId &&
      (confirmed.localRowRef.unconfirmed === undefined || confirmed.localRowRef.unconfirmed === messageRowRef(legacy).unconfirmed))
}

export function mergeRoomStanzaId(a: RoomIdentity, b: RoomIdentity, merged: RoomIdentity) {
  const ap = matchingRoomStanzaIdAuthority(a)
  const bp = matchingRoomStanzaIdAuthority(b)
  const compatible = roomStanzaIdsMergeable(a, b) && (a.id === b.id || !!ap && !!bp)
  const stanzaId = compatible ? (ap ?? bp)?.stanzaId ?? merged.stanzaId : merged.stanzaId
  const proof = compatible ? [ap, bp].find(stanzaIdAuthority => matchingRoomStanzaIdAuthority({ ...merged, stanzaId, stanzaIdAuthority })) : undefined
  const legacy = compatible && !!ap !== !!bp ? (ap ? b : a) : undefined
  const localRowRef = a.localRowRef ?? b.localRowRef ?? (proof && legacy
    ? messageRowRef(legacy)
    : undefined)
  return { stanzaId, stanzaIdAuthority: proof, localRowRef }
}

export function backfillRoomStanzaId<T extends RoomIdentity & { originId?: string }>(current: T, donor: T): T {
  const merged = {
    ...current, stanzaId: current.stanzaId ?? donor.stanzaId, originId: current.originId ?? donor.originId,
  }
  const identity = mergeRoomStanzaId(current, donor, merged)
  return identity.stanzaId === current.stanzaId && identity.stanzaIdAuthority === current.stanzaIdAuthority
    && merged.originId === current.originId && identity.localRowRef === current.localRowRef
    ? current : { ...merged, ...identity }
}
