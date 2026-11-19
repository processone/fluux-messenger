import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildSavedMessage, connectionStore, findLatestCopy, messageRowRef, sameSavedMessage, useXMPPContext, type RoomMessage, type SavedMessage,
} from '@fluux/sdk'
import { useNavigateToTarget } from './useNavigateToTarget'
import { useRoomMessageLink } from './useRoomMessageLink'
import { useToastStore } from '@/stores/toastStore'

/** What a failed open says about an entry: the message is gone, or the lookup failed. */
export type SavedOpenProblem = 'absent' | 'failed'

/**
 * Opens a saved message in its conversation. It lives above the Saved list, not
 * in it: opening a room can leave the list (and a room join it waits for) behind,
 * and the failure shown on the entry must still be there when the list returns.
 */
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

  const open = useCallback(async (entry: SavedMessage) => {
    const { client, navigateToConversation, navigateToRoom, openRoomLink, addToast, t } = latest.current
    setProblem(entry.id, undefined)
    const fail = (kind: 'absent' | 'unknown') => setProblem(entry.id, kind === 'absent' ? 'absent' : 'failed')
    const failWithToast = (kind: 'absent' | 'unknown') => {
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
          if (cached?.stanzaId) stanzaId = cached.stanzaId
          else if (cached) { navigateToRoom(entry.conversationJid, messageRowRef(cached)); return }
          else if (entry.sentAt === undefined) { failWithToast('unknown'); return }
          else {
            const { messages, complete } = await client.messages.fetchContextAround(entry.conversationJid, new Date(entry.sentAt).toISOString(), 50)
            const hit = (messages as RoomMessage[]).find((m) => sameSavedMessage(buildSavedMessage(m, own, 0), entry))
            if (!hit) { failWithToast(complete ? 'absent' : 'unknown'); return }
            stanzaId = hit.stanzaId
            if (!stanzaId) { navigateToRoom(entry.conversationJid, messageRowRef(hit)); return }
          }
        }
        openRoomLink({ roomJid: entry.conversationJid, stanzaId }, fail)
        return
      }
      const result = await client.messages.locateChatMessage(entry.conversationJid, {
        id: entry.messageId, stanzaId: entry.stanzaId, originId: entry.originId, sentAt: entry.sentAt,
      })
      if (result.kind === 'found') { navigateToConversation(entry.conversationJid, result.message.id); return }
      failWithToast(result.kind)
    } catch (error) {
      console.warn('Could not open saved message', error)
      failWithToast('unknown')
    }
  }, [setProblem])

  return { problems, open }
}
