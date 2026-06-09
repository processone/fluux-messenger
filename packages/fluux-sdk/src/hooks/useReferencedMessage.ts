import { useChatStore, useRoomStore } from '../react/storeHooks'
import { findMessageById } from '../utils/messageLookup'
import type { Message, RoomMessage } from '../core/types'

/**
 * Parameters for {@link useReferencedMessage}: the conversation the row lives in
 * plus the id another message references (XEP-0461 reply, XEP-0308 correction…).
 */
export type ReferencedMessageParams =
  | { type: 'chat'; conversationId: string | undefined; id: string | undefined }
  | { type: 'groupchat'; roomJid: string | undefined; id: string | undefined }

const EMPTY_CHAT_MESSAGES: Message[] = []
const EMPTY_ROOM_MESSAGES: RoomMessage[] = []

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
 * @example
 * const replyTarget = useReferencedMessage({ type: 'groupchat', roomJid: room.jid, id: message.replyTo?.id })
 */
export function useReferencedMessage(params: { type: 'chat'; conversationId: string | undefined; id: string | undefined }): Message | undefined
export function useReferencedMessage(params: { type: 'groupchat'; roomJid: string | undefined; id: string | undefined }): RoomMessage | undefined
export function useReferencedMessage(params: ReferencedMessageParams): Message | RoomMessage | undefined {
  const id = params.id
  const conversationId = params.type === 'chat' ? params.conversationId : undefined
  const roomJid = params.type === 'groupchat' ? params.roomJid : undefined

  // Both stores are subscribed unconditionally (rules of hooks); the inactive
  // one short-circuits to `undefined` without scanning, so it never re-renders.
  const chatMatch = useChatStore((s) =>
    conversationId && id
      ? findMessageById(s.messages.get(conversationId) ?? EMPTY_CHAT_MESSAGES, id)
      : undefined
  )
  const roomMatch = useRoomStore((s) =>
    roomJid && id
      ? findMessageById(s.roomRuntime.get(roomJid)?.messages ?? EMPTY_ROOM_MESSAGES, id)
      : undefined
  )

  return params.type === 'chat' ? chatMatch : roomMatch
}
