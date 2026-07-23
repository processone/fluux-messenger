import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP } from '@fluux/sdk'
import { chatStore, roomStore, connectionStore, getBareJid, getLocalPart } from '@fluux/sdk'
import { findMessageById } from '@fluux/sdk'
import { getMessage as getCachedMessage, getMessageByStanzaId as getCachedMessageByStanzaId } from '@fluux/sdk/cache'
import { getRoomMessage as getCachedRoomMessage, getRoomMessageByStanzaId as getCachedRoomMessageByStanzaId } from '@fluux/sdk/cache'
import { useToastStore } from '@/stores/toastStore'
import { useReactionMentionStore } from '@/stores/reactionMentionStore'
import { useNavigateToTarget } from './useNavigateToTarget'
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
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()

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
          // Navigate by message reference: navigateToConversation/navigateToRoom set the
          // target's `targetMessageId` before activating, so the message list loads the
          // history slice around it (getMessagesAround) and scrolls — even when the reacted
          // message is far outside the loaded window. A DOM-query jump would silently no-op
          // there (#923).
          if (m.isRoom) {
            navigateToRoom(m.conversationId, m.messageId)
          } else {
            navigateToConversation(m.conversationId, m.messageId)
          }
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

    const unsubChat = client.subscribe('chat:reactions', async ({ conversationId, messageId, reactorJid, emojis, isLive }) => {
      // Only live reactions notify. Bail before any store/cache work so a MAM or
      // replayed reaction never triggers a durable-cache read we'd discard.
      if (!isLive) return

      // Skip own reactions
      const myJid = getBareJid(connectionStore.getState().jid ?? '')
      if (getBareJid(reactorJid) === myJid) return

      // Only notify for our own outgoing messages. The resident array holds only
      // the active conversation's messages (deactivation evicts the rest), and even
      // the active conversation keeps only its latest window. When the reacted
      // message isn't resident — the toast case (conversation not active) or a
      // reaction on an off-screen older message — fall back to the durable cache.
      const residentMessages = chatStore.getState().messages.get(conversationId)
      let message = residentMessages ? findMessageById([...residentMessages], messageId) : undefined
      if (!message) {
        message = (await getCachedMessage(messageId)) ?? (await getCachedMessageByStanzaId(messageId)) ?? undefined
      }
      if (!message?.isOutgoing) return

      // The reactor references the message by whatever id tier its client used —
      // for archived messages that's the server stanza-id, not our client id. The
      // navigation/scroll machinery (targetMessageId → getIndexForMessageId /
      // data-message-id) resolves only the client id, so normalize to it here.
      const canonicalMessageId = message.id

      // "Last message" only applies while the conversation is active and the message
      // is resident; a cache-recovered message is either non-active (→ toast) or
      // off-screen in the active conversation (→ mention), never the last message.
      const isLastMessage =
        residentMessages && residentMessages.length > 0 ? residentMessages[residentMessages.length - 1].id === canonicalMessageId : false

      const reactorName = getLocalPart(reactorJid)
      const decision = decideReactionNotification(
        { conversationId, messageId: canonicalMessageId, reactorName, emojis, isLive },
        {
          activeConversationId: chatStore.getState().activeConversationId,
          isLastMessage,
          isOwnOutgoing: true,
        },
      )

      dispatchDecision(decision, {
        conversationId,
        messageId: canonicalMessageId,
        reactorName,
        emoji: emojis[0] ?? '',
        preview: message.body?.slice(0, 80) ?? '',
        isRoom: false,
      })
    })

    const unsubRoom = client.subscribe('room:reactions', async ({ roomJid, messageId, reactorNick, emojis, isLive }) => {
      // Only live reactions notify — bail before any store/cache work.
      if (!isLive) return

      // Only act if we know the room
      const state = roomStore.getState()
      const room = state.rooms.get(roomJid)
      if (!room) return

      // Skip own reactions (by nick)
      if (reactorNick === room.nickname) return

      // Only notify for our own messages (identified by nick). Rooms keep just the
      // resident window in RAM, so a reaction to an own message that has scrolled
      // out of the window isn't found there — fall back to the durable cache, same
      // as the 1:1 path.
      const roomMessages = room.messages
      let message = state.getMessage(roomJid, messageId)
      if (!message) {
        message = (await getCachedRoomMessage(messageId)) ?? (await getCachedRoomMessageByStanzaId(roomJid, messageId)) ?? undefined
      }
      if (!message || message.nick !== room.nickname) return

      // MUC reactions reference the server stanza-id; navigation needs the client id
      // (same normalization as the 1:1 path above).
      const canonicalMessageId = message.id

      const isActive = state.activeRoomJid === roomJid
      const isLastMessage = roomMessages.length > 0 ? roomMessages[roomMessages.length - 1].id === canonicalMessageId : false

      const decision = decideReactionNotification(
        { conversationId: roomJid, messageId: canonicalMessageId, reactorName: reactorNick, emojis, isLive },
        {
          activeConversationId: isActive ? roomJid : null,
          isLastMessage,
          isOwnOutgoing: true,
        },
      )

      dispatchDecision(decision, {
        conversationId: roomJid,
        messageId: canonicalMessageId,
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
  }, [client, t, navigateToConversation, navigateToRoom])
}
