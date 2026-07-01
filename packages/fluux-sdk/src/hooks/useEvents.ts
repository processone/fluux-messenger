import { useCallback, useMemo } from 'react'
import { connectionStore, chatStore } from '../stores'
import { useEventsStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import { getLocalPart } from '../core/jid'
import type { Conversation } from '../core'

/**
 * Hook for managing pending events and notifications.
 *
 * Handles subscription requests, messages from strangers (non-contacts),
 * MUC invitations, and system notifications. These events require user
 * action before they become part of normal conversations.
 *
 * @returns An object containing pending events and actions to handle them
 *
 * @example Displaying pending events count
 * ```tsx
 * function EventsBadge() {
 *   const { pendingCount } = useEvents()
 *
 *   if (pendingCount === 0) return null
 *
 *   return <span className="badge">{pendingCount}</span>
 * }
 * ```
 *
 * @example Handling subscription requests
 * ```tsx
 * function SubscriptionRequests() {
 *   const { subscriptionRequests, acceptSubscription, rejectSubscription } = useEvents()
 *
 *   return (
 *     <ul>
 *       {subscriptionRequests.map(req => (
 *         <li key={req.from}>
 *           {req.from} wants to add you
 *           <button onClick={() => acceptSubscription(req.from)}>Accept</button>
 *           <button onClick={() => rejectSubscription(req.from)}>Decline</button>
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * @example Handling MUC invitations
 * ```tsx
 * function RoomInvitations() {
 *   const { mucInvitations, acceptInvitation, declineInvitation } = useEvents()
 *
 *   return (
 *     <ul>
 *       {mucInvitations.map(inv => (
 *         <li key={inv.roomJid}>
 *           {inv.from} invited you to {inv.roomName || inv.roomJid}
 *           {inv.reason && <p>{inv.reason}</p>}
 *           <button onClick={() => acceptInvitation(inv.roomJid)}>Join</button>
 *           <button onClick={() => declineInvitation(inv.roomJid)}>Decline</button>
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * @example Handling messages from strangers
 * ```tsx
 * function StrangerMessages() {
 *   const { strangerConversations, acceptStranger, ignoreStranger } = useEvents()
 *
 *   return (
 *     <ul>
 *       {Object.entries(strangerConversations).map(([jid, messages]) => (
 *         <li key={jid}>
 *           {jid} sent {messages.length} message(s)
 *           <button onClick={() => acceptStranger(jid)}>Add Contact</button>
 *           <button onClick={() => ignoreStranger(jid)}>Ignore</button>
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * @category Hooks
 */
export function useEvents() {
  const { client } = useXMPPContext()
  const subscriptionRequests = useEventsStore((s) => s.subscriptionRequests)
  const strangerMessages = useEventsStore((s) => s.strangerMessages)
  const mucInvitations = useEventsStore((s) => s.mucInvitations)
  const systemNotifications = useEventsStore((s) => s.systemNotifications)
  const removeStrangerMessages = useEventsStore((s) => s.removeStrangerMessages)
  const removeMucInvitation = useEventsStore((s) => s.removeMucInvitation)
  const removeSystemNotification = useEventsStore((s) => s.removeSystemNotification)

  const acceptSubscription = useCallback(
    async (jid: string) => {
      await client.roster.acceptSubscription(jid)
    },
    [client]
  )

  const rejectSubscription = useCallback(
    async (jid: string) => {
      await client.roster.rejectSubscription(jid)
    },
    [client]
  )

  // Accept stranger: add to roster and create conversation
  const acceptStranger = useCallback(
    async (jid: string) => {
      // Add to roster (sends subscription request)
      await client.roster.addContact(jid, getLocalPart(jid))

      // Create conversation
      const conversation: Conversation = {
        id: jid,
        name: getLocalPart(jid),
        type: 'chat',
        unreadCount: 0,
      }
      chatStore.getState().addConversation(conversation)

      // Move stranger messages to the conversation
      const messages = strangerMessages.filter((m) => m.from === jid)
      for (const msg of messages) {
        chatStore.getState().addMessage({
          type: 'chat',
          id: msg.id,
          conversationId: jid,
          from: jid,
          body: msg.body,
          timestamp: msg.timestamp,
          isOutgoing: false,
        })
      }

      // Remove from stranger messages
      removeStrangerMessages(jid)
    },
    [client, strangerMessages, removeStrangerMessages]
  )

  // Ignore stranger: just remove their messages from events
  const ignoreStranger = useCallback(
    (jid: string) => {
      removeStrangerMessages(jid)
    },
    [removeStrangerMessages]
  )

  // Group stranger messages by sender for display (memoized to prevent re-computation)
  const strangerConversations = useMemo(() => {
    return strangerMessages.reduce((acc, msg) => {
      if (!acc[msg.from]) {
        acc[msg.from] = []
      }
      acc[msg.from].push(msg)
      return acc
    }, {} as Record<string, typeof strangerMessages>)
  }, [strangerMessages])

  // Dismiss a system notification
  const dismissNotification = useCallback(
    (id: string) => {
      removeSystemNotification(id)
    },
    [removeSystemNotification]
  )

  // Accept MUC invitation: join the room with optional password
  const acceptInvitation = useCallback(
    async (roomJid: string, password?: string) => {
      // Find the invitation to get the password and isQuickChat flag
      const invitation = mucInvitations.find((i) => i.roomJid === roomJid)
      const currentJid = connectionStore.getState().jid
      const defaultNick = getLocalPart(currentJid ?? 'user')
      const roomPassword = invitation?.password || password

      // Join the room with isQuickChat flag from invitation
      await client.muc.joinRoom(roomJid, defaultNick, {
        password: roomPassword,
        isQuickChat: invitation?.isQuickChat,
      })

      // Remove from invitations
      removeMucInvitation(roomJid)
    },
    [client, mucInvitations, removeMucInvitation]
  )

  // Decline MUC invitation: just remove it
  const declineInvitation = useCallback(
    (roomJid: string) => {
      removeMucInvitation(roomJid)
    },
    [removeMucInvitation]
  )

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      acceptSubscription,
      rejectSubscription,
      acceptStranger,
      ignoreStranger,
      acceptInvitation,
      declineInvitation,
      dismissNotification,
    }),
    [acceptSubscription, rejectSubscription, acceptStranger, ignoreStranger, acceptInvitation, declineInvitation, dismissNotification]
  )

  // Memoize pending count to prevent re-computation
  const pendingCount = useMemo(
    () => subscriptionRequests.length + Object.keys(strangerConversations).length + mucInvitations.length + systemNotifications.length,
    [subscriptionRequests.length, strangerConversations, mucInvitations.length, systemNotifications.length]
  )

  // Memoize the entire return value to prevent render loops
  return useMemo(
    () => ({
      // State
      subscriptionRequests,
      strangerMessages,
      strangerConversations,
      mucInvitations,
      systemNotifications,
      pendingCount,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [subscriptionRequests, strangerMessages, strangerConversations, mucInvitations, systemNotifications, pendingCount, actions]
  )
}
