import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP } from '@fluux/sdk'
import { chatStore, roomStore, connectionStore, getBareJid, getLocalPart } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'
import { useEasterEggMentionStore } from '@/stores/easterEggMentionStore'
import { useNavigateToTarget } from './useNavigateToTarget'
import { decideEasterEggNotification } from './easterEggNotificationDecision'

/**
 * Surfaces easter eggs received while their conversation is inactive:
 * a clickable toast (navigate + play on open) plus a transient pending-egg
 * marker that drives the Replay chip. Active-conversation and own-send eggs
 * are handled by the store binding (immediate play), so this hook ignores them.
 *
 * Call once in ChatLayout alongside useReactionNotifications.
 */
export function useEasterEggNotifications(): void {
  const { client } = useXMPP()
  const { t } = useTranslation()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()

  useEffect(() => {
    if (!client?.subscribe) return

    const unsubChat = client.subscribe('chat:animation', ({ conversationId, animation, senderJid }) => {
      const myJid = getBareJid(connectionStore.getState().jid ?? '')
      const isOwn = getBareJid(senderJid) === myJid
      const isActive = chatStore.getState().activeConversationId === conversationId
      if (decideEasterEggNotification({ isOwn, isActive }).kind !== 'notify') return

      const senderName = getLocalPart(senderJid)
      useToastStore.getState().addToast('info', t('easterEgg.mention', { name: senderName }), 6000, () => {
        navigateToConversation(conversationId)
      })
      useEasterEggMentionStore.getState().add({ id: conversationId, conversationId, animation, senderName })
    })

    const unsubRoom = client.subscribe('room:animation', ({ roomJid, animation, senderNick }) => {
      const room = roomStore.getState().rooms.get(roomJid)
      if (!room) return
      const isOwn = senderNick === room.nickname
      const isActive = roomStore.getState().activeRoomJid === roomJid
      if (decideEasterEggNotification({ isOwn, isActive }).kind !== 'notify') return

      useToastStore.getState().addToast('info', t('easterEgg.mention', { name: senderNick }), 6000, () => {
        navigateToRoom(roomJid)
      })
      useEasterEggMentionStore.getState().add({ id: roomJid, conversationId: roomJid, animation, senderName: senderNick })
    })

    return () => {
      unsubChat()
      unsubRoom()
    }
  }, [client, t, navigateToConversation, navigateToRoom])
}
