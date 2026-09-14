import { getRoomModerationId } from '../utils/roomStanzaId'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getRoomMessageByReference } from '../utils/messageCache'
import { captureStorageScope } from '../utils/storageScope'
import { roomStore } from '../stores/roomStore'
import { applyPendingRetractions, type PendingRetraction } from '../stores/shared/pendingRetractions'
import { roomRetractionAuthorized } from '../utils/moderation'
import { useChatStore, useRoomStore, useConnectionStore } from '../react/storeHooks'
import { findMessageById, resolveMessageReference, selectRoomReference } from '../utils/messageIdentity'
import type { Message, RoomMessage } from '../core/types'

/**
 * Parameters for {@link useReferencedMessage}: the conversation the row lives in
 * plus the id another message references (XEP-0461 reply, XEP-0308 correction…).
 */
export type ReferencedMessageParams =
  | { type: 'chat'; conversationId: string | undefined; id: string | undefined }
  | RoomReferenceParams

type RoomReferenceParams = {
  type: 'groupchat'
  roomJid: string | undefined
  id: string | undefined
  from?: string
  /** Opt into local-cache resolution; see the hook's return contract. */
  cache?: boolean
  /** Additional snapshots to reconcile with resident/cache candidates when `cache` is true. */
  messages?: readonly RoomMessage[]
}

const EMPTY_CHAT_MESSAGES: Message[] = []
const EMPTY_ROOM_MESSAGES: RoomMessage[] = []
const EMPTY_RETRACTIONS: PendingRetraction[] = []

/**
 * Reactively resolve the message referenced by `id` (a reply or correction
 * target) from the store, matching across client-id / stanza-id / origin-id
 * (see {@link findMessageById}).
 *
 * Why a hook instead of a render-time lookup getter: message rows are
 * `React.memo`-ised and their lookup props are referentially stable, so a value
 * derived at render time from such a getter FREEZES — a reply whose target only
 * paginates in later never updates (it stays on the XEP-0428 fallback). By
 * subscribing to the store and selecting *only the resolved target*, the row
 * re-renders precisely when that target appears or changes, and never on
 * unrelated appends/churn (the selector returns a stable reference otherwise).
 *
 * Room callers may opt into `cache: true` to combine resident messages, supplied
 * snapshots and account/room-scoped IndexedDB candidates with pending moderation.
 * This mode returns `null` while local resolution is pending and `undefined` when
 * no unambiguous match is available; a cache failure falls back to the local
 * match. It never requests MAM or other network history. Omitted/false `cache`
 * preserves the resident-only lookup and its `RoomMessage | undefined` return.
 *
 * @example
 * const replyTarget = useReferencedMessage({ type: 'groupchat', roomJid: room.jid, id: message.replyTo?.id })
 */
export function useReferencedMessage(params: { type: 'chat'; conversationId: string | undefined; id: string | undefined }): Message | undefined
export function useReferencedMessage(params: RoomReferenceParams & { cache?: false }): RoomMessage | undefined
export function useReferencedMessage(params: RoomReferenceParams): RoomMessage | null | undefined
export function useReferencedMessage(params: ReferencedMessageParams): Message | RoomMessage | null | undefined {
  const id = params.id
  const conversationId = params.type === 'chat' ? params.conversationId : undefined
  const roomJid = params.type === 'groupchat' ? params.roomJid : undefined
  const from = params.type === 'groupchat' ? params.from : undefined
  const cache = params.type === 'groupchat' && params.cache
  const account = useConnectionStore(s => s.jid)
  const snapshots = params.type === 'groupchat' && cache ? params.messages ?? EMPTY_ROOM_MESSAGES : EMPTY_ROOM_MESSAGES

  // Both stores are subscribed unconditionally (rules of hooks); the inactive
  // one short-circuits to `undefined` without scanning, so it never re-renders.
  const chatMatch = useChatStore((s) =>
    conversationId && id
      ? findMessageById(s.messages.get(conversationId) ?? EMPTY_CHAT_MESSAGES, id)
      : undefined
  )
  const legacyRoomMatch = useRoomStore(s => !cache && roomJid && id
    ? from
      ? selectRoomReference(resolveMessageReference(s.messages.get(roomJid) ?? EMPTY_ROOM_MESSAGES, id, 'archive-first'), from)
      : findMessageById(s.messages.get(roomJid) ?? EMPTY_ROOM_MESSAGES, id)
    : undefined)
  const residentCandidates = useRoomStore(useShallow(s => cache && roomJid && id
    ? resolveMessageReference(s.messages.get(roomJid) ?? EMPTY_ROOM_MESSAGES, id, 'archive-first')?.candidates
      .map(candidate => candidate.message) ?? EMPTY_ROOM_MESSAGES
    : EMPTY_ROOM_MESSAGES))
  const selectSnapshotCandidates = useShallow((messages: readonly RoomMessage[]) => cache && roomJid && id
    ? resolveMessageReference(messages.filter(message => message.roomJid === roomJid), id, 'archive-first')?.candidates
      .map(candidate => candidate.message) ?? EMPTY_ROOM_MESSAGES
    : EMPTY_ROOM_MESSAGES)
  const snapshotCandidates = selectSnapshotCandidates(snapshots)
  const localCandidates = useMemo(() => [...residentCandidates, ...snapshotCandidates], [residentCandidates, snapshotCandidates])
  const roomMatch = useMemo(() => id
    ? selectRoomReference(resolveMessageReference(localCandidates, id, 'archive-first'), from, true)
    : undefined, [localCandidates, id, from])
  const lookup = useMemo(() => ({ roomJid, id, from, account, localCandidates }),
    [roomJid, id, from, account, localCandidates])

  const [cached, setCached] = useState<{
    lookup: typeof lookup
    scope: ReturnType<typeof captureStorageScope>; message: RoomMessage | undefined
  }>()
  useEffect(() => {
    if (!cache || !roomJid || !id || (roomMatch && getRoomModerationId(roomMatch) === id)) return
    const scope = captureStorageScope()
    let cancelled = false
    void getRoomMessageByReference(roomJid, id, from, localCandidates).then(message => {
      if (!cancelled && scope.isCurrent()) {
        const resolved = message
          ? applyPendingRetractions([message], roomStore.getState().pendingRetractions.get(roomJid) ?? EMPTY_RETRACTIONS, roomRetractionAuthorized).messages[0]
          : undefined
        setCached({ lookup, scope, message: resolved })
      }
    }).catch(() => {
      if (!cancelled && scope.isCurrent()) setCached({ lookup, scope, message: roomMatch })
    })
    return () => { cancelled = true }
  }, [cache, roomJid, id, from, roomMatch, lookup, localCandidates])

  const currentCache = cached?.lookup === lookup && cached.scope.isCurrent() ? cached : undefined
  const baseMatch = !roomJid || !id || (roomMatch && getRoomModerationId(roomMatch) === id) ? roomMatch
    : currentCache ? currentCache.message : null
  const pending = useRoomStore(useShallow(s => cache && roomJid && baseMatch
    ? (s.pendingRetractions.get(roomJid) ?? EMPTY_RETRACTIONS).filter(record =>
      roomRetractionAuthorized(baseMatch, record) && resolveMessageReference([baseMatch], record.targetId, 'archive-first'))
    : EMPTY_RETRACTIONS))
  const knownMatch = useMemo(() => baseMatch
    ? applyPendingRetractions([baseMatch], pending, roomRetractionAuthorized).messages[0]
    : baseMatch, [baseMatch, pending])
  useEffect(() => {
    if (currentCache && knownMatch?.isRetracted && knownMatch !== currentCache.message) {
      setCached(previous => previous === currentCache ? { ...previous, message: knownMatch } : previous)
    }
  }, [currentCache, knownMatch])

  if (params.type === 'chat') return chatMatch
  if (!cache) return legacyRoomMatch
  return knownMatch
}
