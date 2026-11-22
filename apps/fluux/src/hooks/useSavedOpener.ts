import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildSavedMessage, connectionStore, findLatestCopy, getBareJid, getLocalPart, messageRowRef, roomStore, sameSavedMessage, useXMPPContext,
  type RoomMessage, type SavedMessage,
} from '@fluux/sdk'
import { useNavigateToTarget } from './useNavigateToTarget'
import { useRoomMessageLink } from './useRoomMessageLink'
import { useToastStore } from '@/stores/toastStore'

/** What a failed open says about an entry: the message is gone, or the lookup failed. */
export type SavedOpenProblem = 'absent' | 'failed'

/**
 * Opens a saved message in its conversation. It lives above the Saved list and the
 * Saved pane (in ChatLayout), not in either: opening a room can leave the list (and a room join it waits for) behind,
 * and the failure shown on the entry must still be there when the list returns.
 */
const JOIN_WAIT_MS = 30_000

/** A room the list no longer holds (its history may still be cached) is added again, as a room link does, so it can be shown and joined. */
function registerRoom(roomJid: string, account: string): void {
  const rooms = roomStore.getState()
  if (rooms.rooms.get(roomJid)) return
  rooms.addRoom({ jid: roomJid, name: getLocalPart(roomJid), nickname: getLocalPart(account),
    joined: false, isBookmarked: false, occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() })
}

/** Resolves true once the room is joined, false if `abandoned()` turns true or the wait times out. */
function waitForJoin(roomJid: string, abandoned: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean) => { clearTimeout(timer); unsubscribe(); unsubscribeConnection(); resolve(value) }
    const check = () => {
      if (abandoned()) finish(false)
      else if (roomStore.getState().rooms.get(roomJid)?.joined) finish(true)
    }
    const unsubscribe = roomStore.subscribe(check)
    const unsubscribeConnection = connectionStore.subscribe(check)
    const timer = setTimeout(() => finish(false), JOIN_WAIT_MS)
    check()
  })
}

export type SavedOpener = ReturnType<typeof useSavedOpener>

export function useSavedOpener() {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const openRoomLink = useRoomMessageLink()
  const addToast = useToastStore((s) => s.addToast)
  const [problems, setProblems] = useState<Record<string, SavedOpenProblem>>({})
  const latest = useRef({ client, navigateToConversation, navigateToRoom, openRoomLink, addToast, t })
  latest.current = { client, navigateToConversation, navigateToRoom, openRoomLink, addToast, t }

  const setProblem = useCallback((id: string, problem: SavedOpenProblem | undefined) => {
    setProblems((current) => {
      if (current[id] === problem) return current
      const next = { ...current }
      if (problem) next[id] = problem
      else delete next[id]
      return next
    })
  }, [])

  // The newest open owns the result: an older one, or one from another account, never navigates.
  const request = useRef(0)
  useEffect(() => {
    const cancel = () => { request.current += 1 }
    const unsubscribe = connectionStore.subscribe((state, previous) => {
      if (getBareJid(state.jid ?? '') !== getBareJid(previous.jid ?? '')) cancel()
    })
    return () => { unsubscribe(); cancel() }
  }, [])

  const open = useCallback(async (entry: SavedMessage) => {
    const { client, navigateToConversation, navigateToRoom, openRoomLink, addToast, t } = latest.current
    const mine = ++request.current
    const account = getBareJid(connectionStore.getState().jid ?? '')
    const stale = () => request.current !== mine || getBareJid(connectionStore.getState().jid ?? '') !== account
    setProblem(entry.id, undefined)
    const fail = (kind: 'absent' | 'unknown') => setProblem(entry.id, kind === 'absent' ? 'absent' : 'failed')
    const failWithToast = (kind: 'absent' | 'unknown') => {
      if (stale()) return
      fail(kind)
      addToast('error', kind === 'absent' ? t('chat.linkedMessageUnavailable') : t('chat.linkedMessageLoadFailed'))
    }
    const own = connectionStore.getState().jid ?? ''
    try {
      if (entry.type === 'groupchat') {
        let stanzaId = entry.stanzaId
        if (!stanzaId) {
          // No archive id: the copy this device holds, else the archive around the time it was sent.
          const cached = await findLatestCopy(entry, own) as RoomMessage | undefined
          if (stale()) return
          if (cached?.stanzaId) stanzaId = cached.stanzaId
          else if (cached) { registerRoom(entry.conversationJid, account); navigateToRoom(entry.conversationJid, messageRowRef(cached)); return }
          else if (entry.sentAt === undefined) { failWithToast('unknown'); return }
          else {
            // The room's archive can be asked only once the room is joined: bring it in the way a room link does.
            registerRoom(entry.conversationJid, account)
            if (!roomStore.getState().rooms.get(entry.conversationJid)?.joined) {
              navigateToRoom(entry.conversationJid)
              if (!await waitForJoin(entry.conversationJid, stale)) { failWithToast('unknown'); return }
            }
            const { messages, complete } = await client.messages.fetchContextAround(entry.conversationJid, new Date(entry.sentAt).toISOString(), 50)
            if (stale()) return
            const hit = (messages as RoomMessage[]).find((m) => sameSavedMessage(buildSavedMessage(m, own, 0), entry))
            if (!hit) { failWithToast(complete ? 'absent' : 'unknown'); return }
            stanzaId = hit.stanzaId
            if (!stanzaId) { navigateToRoom(entry.conversationJid, messageRowRef(hit)); return }
          }
        }
        if (stale()) return
        openRoomLink({ roomJid: entry.conversationJid, stanzaId }, (kind) => { if (!stale()) fail(kind) }, () => !stale())
        return
      }
      const result = await client.messages.locateChatMessage(entry.conversationJid, {
        id: entry.messageId, stanzaId: entry.stanzaId, originId: entry.originId, sentAt: entry.sentAt, from: entry.from,
      })
      if (stale()) return
      if (result.kind === 'found') { navigateToConversation(entry.conversationJid, result.message.id); return }
      failWithToast(result.kind)
    } catch (error) {
      console.warn('Could not open saved message', error)
      failWithToast('unknown')
    }
  }, [setProblem])

  return { problems, open }
}
