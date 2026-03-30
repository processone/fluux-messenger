import { useEffect, useRef } from 'react'
import { rosterStore, usePresence } from '@fluux/sdk'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'
import { sendNotification, onAction } from '@tauri-apps/plugin-notification'
import type { Options as NotificationOptions } from '@tauri-apps/plugin-notification'
import { useNotificationEvents } from './useNotificationEvents'
import { useNavigateToTarget } from './useNavigateToTarget'
import { useNotificationPermission, isTauri } from './useNotificationPermission'
import { getNotificationAvatarUrl } from '@/utils/notificationAvatar'
import { formatMessagePreview } from '@fluux/sdk'
import { notificationDebug } from '@/utils/notificationDebug'

/**
 * Hook to show desktop notifications for new messages and room mentions.
 * - Requests permission on mount (after login)
 * - Shows notification for messages in non-active conversations
 * - Shows notification for mentions in MUC rooms
 * - Clicking notification focuses the conversation/room and switches view
 * - Uses Tauri notification API with onAction() for click handling
 * - Falls back to web Notification API for non-Tauri environments
 */
export function useDesktopNotifications(): void {
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const permissionGranted = useNotificationPermission()
  const { presenceStatus } = usePresence()

  // Refs for stable access in async callbacks (useNavigateToTarget uses refs internally)
  const navigateToConversationRef = useRef(navigateToConversation)
  const navigateToRoomRef = useRef(navigateToRoom)
  const presenceStatusRef = useRef(presenceStatus)

  useEffect(() => {
    navigateToConversationRef.current = navigateToConversation
    navigateToRoomRef.current = navigateToRoom
  }, [navigateToConversation, navigateToRoom])

  useEffect(() => {
    presenceStatusRef.current = presenceStatus
  }, [presenceStatus])

  // Handle notification clicks via Tauri onAction listener
  useEffect(() => {
    if (!isTauri) return

    let unlisten: (() => void) | undefined

    void onAction((notification: NotificationOptions) => {
      const navType = notification.extra?.navType as string | undefined
      const navTarget = notification.extra?.navTarget as string | undefined
      if (!navTarget) return

      if (navType === 'room') {
        navigateToRoomRef.current(navTarget)
      } else {
        navigateToConversationRef.current(navTarget)
      }
    }).then((listener) => {
      unlisten = listener.unregister
    })

    return () => {
      unlisten?.()
    }
  }, [])

  // Show conversation notification
  const showConversationNotification = async (conv: Conversation, message: Message) => {
    if (presenceStatusRef.current === 'dnd') return
    if (!permissionGranted.current) {
      notificationDebug.desktopNotification({
        title: conv.name || message.from.split('@')[0],
        body: '(permission not granted)',
        conversationId: conv.id,
      })
      return
    }

    const senderName = message.from.split('@')[0]
    const title = conv.name || senderName
    const body = formatMessagePreview(message)

    notificationDebug.desktopNotification({
      title,
      body,
      conversationId: conv.id,
    })

    // Get contact avatar
    const contact = rosterStore.getState().getContact(conv.id)
    const avatarUrl = await getNotificationAvatarUrl(contact?.avatar, contact?.avatarHash)

    if (isTauri) {
      sendNotification({
        title,
        body,
        attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
        extra: { navType: 'conversation', navTarget: conv.id },
      })
    } else {
      if (typeof Notification === 'undefined') return

      const notification = new Notification(title, {
        body,
        icon: avatarUrl || './icon-512.png',
        tag: conv.id, // Prevents duplicate notifications for same conversation
      })

      notification.onclick = () => {
        window.focus()
        navigateToConversation(conv.id)
        notification.close()
      }

      setTimeout(() => notification.close(), 5000)
    }
  }

  // Show room notification
  const showRoomNotification = async (room: Room, message: RoomMessage) => {
    if (presenceStatusRef.current === 'dnd') return
    if (!permissionGranted.current) {
      notificationDebug.desktopNotification({
        title: `${message.nick} @ ${room.name}`,
        body: '(permission not granted)',
        roomJid: room.jid,
      })
      return
    }

    // Format: "nick @ Room Name" as title, message body as body
    const title = `${message.nick} @ ${room.name}`
    const body = formatMessagePreview(message)

    notificationDebug.desktopNotification({
      title,
      body,
      roomJid: room.jid,
    })

    // Get room avatar
    const avatarUrl = await getNotificationAvatarUrl(room.avatar, room.avatarHash)

    if (isTauri) {
      sendNotification({
        title,
        body,
        attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
        extra: { navType: 'room', navTarget: room.jid },
      })
    } else {
      if (typeof Notification === 'undefined') return

      const notification = new Notification(title, {
        body,
        icon: avatarUrl || './icon-512.png',
        tag: `room-${room.jid}`,
      })

      notification.onclick = () => {
        window.focus()
        navigateToRoom(room.jid)
        notification.close()
      }

      setTimeout(() => notification.close(), 5000)
    }
  }

  // Subscribe to notification events
  useNotificationEvents({
    onConversationMessage: showConversationNotification,
    onRoomMessage: showRoomNotification,
  })
}
