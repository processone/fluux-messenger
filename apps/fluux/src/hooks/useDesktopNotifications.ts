import { useEffect, useRef, useCallback } from 'react'
import { rosterStore } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { useNotificationEvents } from './useNotificationEvents'
import { useNavigateToTarget } from './useNavigateToTarget'
import { getNotificationAvatarUrl } from '@/utils/notificationAvatar'
import { formatMessagePreview } from '@fluux/sdk'
import { notificationDebug } from '@/utils/notificationDebug'

// Check if we're running in Tauri (v2 uses __TAURI_INTERNALS__)
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Pending navigation target for notification click handling on macOS
// Since onAction() is mobile-only, we use app activation as a proxy for notification clicks
interface PendingNavigation {
  type: 'conversation' | 'room'
  target: string
  timestamp: number
}
let pendingNavigation: PendingNavigation | null = null

// Time window (ms) to consider a pending navigation valid after app activation
const NOTIFICATION_CLICK_WINDOW = 3000

// Module-level flag to check permission only once per session
let permissionChecked = false

/**
 * Hook to show desktop notifications for new messages and room mentions.
 * - Requests permission on mount (after login)
 * - Shows notification for messages in non-active conversations
 * - Shows notification for mentions in MUC rooms
 * - Clicking notification focuses the conversation/room and switches view
 * - Uses Tauri notification API when available, falls back to web API
 */
export function useDesktopNotifications(): void {
  // Use focused selector to only subscribe to status
  const status = useConnectionStore((s) => s.status)
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const permissionGranted = useRef(false)

  // Refs for stable access in async callbacks (useNavigateToTarget uses refs internally)
  const navigateToConversationRef = useRef(navigateToConversation)
  const navigateToRoomRef = useRef(navigateToRoom)

  useEffect(() => {
    navigateToConversationRef.current = navigateToConversation
    navigateToRoomRef.current = navigateToRoom
  }, [navigateToConversation, navigateToRoom])

  // Handle notification clicks via app activation (macOS workaround)
  // The onAction() API is mobile-only, so on desktop we detect when the app
  // becomes visible shortly after sending a notification
  useEffect(() => {
    if (!isTauri) return

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (!pendingNavigation) return

      const elapsed = Date.now() - pendingNavigation.timestamp
      if (elapsed > NOTIFICATION_CLICK_WINDOW) {
        // Too old, user probably just switched to the app normally
        pendingNavigation = null
        return
      }

      // Navigate to the pending target
      if (pendingNavigation.type === 'conversation') {
        navigateToConversationRef.current(pendingNavigation.target)
      } else {
        navigateToRoomRef.current(pendingNavigation.target)
      }
      pendingNavigation = null
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  // Request notification permission when connected
  useEffect(() => {
    if (status !== 'online') return

    if (permissionChecked) {
      return
    }

    const requestNotificationPermission = async () => {
      try {
        if (isTauri) {
          // Tauri notification API
          let granted = await isPermissionGranted()
          console.log('[Notifications] Initial permission status:', granted ? 'granted' : 'not granted')
          if (!granted) {
            console.log('[Notifications] Requesting permission...')
            const permission = await requestPermission()
            granted = permission === 'granted'
            console.log('[Notifications] Permission request result:', permission)
          }
          permissionGranted.current = granted
          if (!granted) {
            console.log('[Notifications] Permission not granted. On macOS, go to System Settings → Notifications → Fluux Messenger to enable.')
          }
        } else {
          // Web Notification API
          if (typeof Notification === 'undefined') return
          console.log('[Notifications] Web API permission:', Notification.permission)
          if (Notification.permission === 'granted') {
            permissionGranted.current = true
          } else if (Notification.permission !== 'denied') {
            console.log('[Notifications] Requesting permission...')
            const permission = await Notification.requestPermission()
            permissionGranted.current = permission === 'granted'
            console.log('[Notifications] Permission request result:', permission)
          }
        }
        permissionChecked = true
      } catch (error) {
        console.error('[Notifications] Error requesting permission:', error)
      }
    }

    requestNotificationPermission()
  }, [status])

  // Show conversation notification
  const showConversationNotification = useCallback(async (conv: Conversation, message: Message) => {
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
      // Set pending navigation for app activation handler (macOS workaround)
      pendingNavigation = {
        type: 'conversation',
        target: conv.id,
        timestamp: Date.now(),
      }
      sendNotification({
        title,
        body,
        attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
      })
    } else {
      if (typeof Notification === 'undefined') return

      const notification = new Notification(title, {
        body,
        icon: avatarUrl || '/icon-512.png',
        tag: conv.id, // Prevents duplicate notifications for same conversation
      })

      notification.onclick = () => {
        window.focus()
        navigateToConversation(conv.id)
        notification.close()
      }

      setTimeout(() => notification.close(), 5000)
    }
  }, [navigateToConversation])

  // Show room notification
  const showRoomNotification = useCallback(async (room: Room, message: RoomMessage) => {
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
      // Set pending navigation for app activation handler (macOS workaround)
      pendingNavigation = {
        type: 'room',
        target: room.jid,
        timestamp: Date.now(),
      }
      sendNotification({
        title,
        body,
        attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
      })
    } else {
      if (typeof Notification === 'undefined') return

      const notification = new Notification(title, {
        body,
        icon: avatarUrl || '/icon-512.png',
        tag: `room-${room.jid}`,
      })

      notification.onclick = () => {
        window.focus()
        navigateToRoom(room.jid)
        notification.close()
      }

      setTimeout(() => notification.close(), 5000)
    }
  }, [navigateToRoom])

  // Subscribe to notification events
  useNotificationEvents({
    onConversationMessage: showConversationNotification,
    onRoomMessage: showRoomNotification,
  })
}
