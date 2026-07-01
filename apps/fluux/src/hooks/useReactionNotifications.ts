import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP } from '@fluux/sdk'
import { chatStore, roomStore, connectionStore, getBareJid } from '@fluux/sdk'
import { findMessageById } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'
import { useReactionMentionStore } from '@/stores/reactionMentionStore'
import { useRouteSync } from '@/hooks'
import { scrollToMessage } from '@/components/conversation/messageGrouping'
import { decideReactionNotification, type ReactionDecision } from './reactionNotificationDecision'

/**
 * Subscribes to reaction events and surfaces them as:
 * - A clickable toast (conversation not active) that navigates + scrolls to the message
 * - An in-flow mention chip (conversation active, message not last)
 * - Nothing (MAM replay, own reaction, not our message, or active + last message)
 *
 * Should be called once in GlobalEffects alongside other top-level effect hooks.
 */
export function useReactionNotifications(): void {
  const { client } = useXMPP()
  const { t } = useTranslation()
  const { navigateToMessages, navigateToRooms } = useRouteSync()

  useEffect(() => {
    if (!client?.subscribe) return

    const dispatchDecision = (
      decision: ReactionDecision,
      m: {
        conversationId: string
        messageId: string
        reactorName: string
        emoji: string
        preview: string
        isRoom: boolean
      },
    ) => {
      if (decision.kind === 'none') return

      const label = t('reactions.mention', { name: m.reactorName, emoji: m.emoji, preview: m.preview })

      if (decision.kind === 'toast') {
        useToastStore.getState().addToast('info', label, 6000, () => {
          if (m.isRoom) {
            navigateToRooms(m.conversationId)
          } else {
            navigateToMessages(m.conversationId)
          }
          setTimeout(() => scrollToMessage(m.messageId), 100)
        })
      } else {
        // decision.kind === 'mention'
        useReactionMentionStore.getState().addMention({
          id: `${m.conversationId}:${m.messageId}`,
          conversationId: m.conversationId,
          messageId: m.messageId,
          reactorName: m.reactorName,
          emoji: m.emoji,
          preview: m.preview,
        })
      }
    }

    const unsubChat = client.subscribe('chat:reactions', ({ conversationId, messageId, reactorJid, emojis, isLive }) => {
      // Skip own reactions
      const myJid = getBareJid(connectionStore.getState().jid ?? '')
      if (getBareJid(reactorJid) === myJid) return

      // Only notify for our own outgoing messages
      const messages = chatStore.getState().messages.get(conversationId)
      const message = messages ? findMessageById([...messages], messageId) : undefined
      if (!message?.isOutgoing) return

      const isLastMessage = messages && messages.length > 0 ? messages[messages.length - 1].id === messageId : false

      const decision = decideReactionNotification(
        { conversationId, messageId, reactorName: getBareJid(reactorJid).split('@')[0], emojis, isLive },
        {
          activeConversationId: chatStore.getState().activeConversationId,
          isLastMessage,
          isOwnOutgoing: true,
        },
      )

      dispatchDecision(decision, {
        conversationId,
        messageId,
        reactorName: getBareJid(reactorJid).split('@')[0],
        emoji: emojis[0] ?? '',
        preview: message.body?.slice(0, 80) ?? '',
        isRoom: false,
      })
    })

    const unsubRoom = client.subscribe('room:reactions', ({ roomJid, messageId, reactorNick, emojis, isLive }) => {
      // Only act if we know the room
      const state = roomStore.getState()
      const room = state.rooms.get(roomJid)
      if (!room) return

      // Skip own reactions (by nick)
      if (reactorNick === room.nickname) return

      // Only notify for our own messages (identified by nick)
      const message = state.getMessage(roomJid, messageId)
      if (!message || message.nick !== room.nickname) return

      const isActive = state.activeRoomJid === roomJid
      const roomMessages = room.messages
      const isLastMessage = roomMessages.length > 0 ? roomMessages[roomMessages.length - 1].id === messageId : false

      const decision = decideReactionNotification(
        { conversationId: roomJid, messageId, reactorName: reactorNick, emojis, isLive },
        {
          activeConversationId: isActive ? roomJid : null,
          isLastMessage,
          isOwnOutgoing: true,
        },
      )

      dispatchDecision(decision, {
        conversationId: roomJid,
        messageId,
        reactorName: reactorNick,
        emoji: emojis[0] ?? '',
        preview: message.body?.slice(0, 80) ?? '',
        isRoom: true,
      })
    })

    return () => {
      unsubChat()
      unsubRoom()
    }
  }, [client, t, navigateToMessages, navigateToRooms])
}
