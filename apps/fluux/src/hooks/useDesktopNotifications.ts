import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { rosterStore, usePresence } from '@fluux/sdk'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { sendNotification, onAction } from '@tauri-apps/plugin-notification'
import type { Options as NotificationOptions } from '@tauri-apps/plugin-notification'
import { isMacOSDesktop } from '@/utils/tauriPlatform'
import { useNotificationEvents } from './useNotificationEvents'
import { useNavigateToTarget } from './useNavigateToTarget'
import {
  useNotificationPermission,
  getNotificationPermissionGranted,
  isTauri,
} from './useNotificationPermission'
import { getNotificationAvatarUrl } from '@/utils/notificationAvatar'
import { formatLocalizedPreview } from '@/utils/messagePreviewText'
import { notificationDebug } from '@/utils/notificationDebug'
import { showWebNotification } from '@/utils/webNotification'
import { routeNotificationTarget } from '@/utils/notificationRouting'

/**
 * Hook to show desktop notifications for new messages and room mentions.
 * - Requests permission on mount (after login)
 * - Shows notification for messages in non-active conversations
 * - Shows notification for mentions in MUC rooms
 * - Clicking notification focuses the conversation/room and switches view
 * - macOS: posts natively (UNUserNotificationCenter), routes clicks via the 'notification-activated' event; mobile uses onAction()
 * - Falls back to web Notification API for non-Tauri environments
 */
export function useDesktopNotifications(): void {
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  useNotificationPermission()
  const { presenceStatus } = usePresence()
  const { t } = useTranslation()

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

  // Handle notification clicks.
  //
  // Desktop (macOS native): the Rust delegate emits "notification-activated"
  // and stashes a target for cold starts (drained on mount). Mobile: the
  // plugin's onAction() is the click source — but registerListener only exists
  // on iOS/Android, so guard it there (on desktop it rejects with
  // "not allowed by ACL"). Web routes clicks in sw.ts and is untouched here.
  useEffect(() => {
    if (!isTauri) return

    const route = (payload: unknown) => {
      const p = (payload ?? {}) as { navType?: string; navTarget?: string }
      routeNotificationTarget(p.navType, p.navTarget, {
        navigateToConversation: navigateToConversationRef.current,
        navigateToRoom: navigateToRoomRef.current,
      })
    }

    let cancelled = false
    let unlistenEvent: (() => void) | undefined
    let unlistenMobile: (() => void) | undefined

    // Desktop: Tauri event + cold-start drain. Register the listener, tell the
    // native side it's ready, THEN drain any target stashed before readiness
    // (cold start: the delegate fires before this effect mounts).
    void listen('notification-activated', (e) => route(e.payload)).then((un) => {
      if (cancelled) {
        un()
        return
      }
      unlistenEvent = un
      void invoke('set_notification_listener_ready', { ready: true })
        .then(() => invoke('take_pending_notification_target'))
        .then((target) => {
          if (!cancelled && target) route(target)
        })
        .catch(() => {
          // Commands are macOS-only; absent elsewhere — ignore.
        })
    })

    // Mobile: onAction (iOS/Android only).
    void (async () => {
      const { platform } = await import('@tauri-apps/plugin-os')
      const os = await platform()
      if (cancelled || (os !== 'ios' && os !== 'android')) return
      const listener = await onAction((notification: NotificationOptions) => {
        route({
          navType: notification.extra?.navType,
          navTarget: notification.extra?.navTarget,
        })
      })
      if (cancelled) void listener.unregister()
      else unlistenMobile = listener.unregister
    })()

    return () => {
      cancelled = true
      void invoke('set_notification_listener_ready', { ready: false }).catch(() => {})
      unlistenEvent?.()
      unlistenMobile?.()
    }
  }, [])

  // Show conversation notification
  const showConversationNotification = async (conv: Conversation, message: Message) => {
    if (presenceStatusRef.current === 'dnd') return
    if (!getNotificationPermissionGranted()) {
      notificationDebug.desktopNotification({
        title: conv.name || message.from.split('@')[0],
        body: '(permission not granted)',
        conversationId: conv.id,
      })
      return
    }

    const senderName = message.from.split('@')[0]
    const title = conv.name || senderName
    const body = formatLocalizedPreview(message, t)

    notificationDebug.desktopNotification({
      title,
      body,
      conversationId: conv.id,
    })

    // Get contact avatar
    const contact = rosterStore.getState().getContact(conv.id)
    const avatarUrl = await getNotificationAvatarUrl(contact?.avatar, contact?.avatarHash)

    if (isTauri) {
      if (await isMacOSDesktop()) {
        await invoke('post_notification', {
          title,
          body,
          navType: 'conversation',
          navTarget: conv.id,
          avatarPath: avatarUrl?.startsWith('file://') ? avatarUrl.replace(/^file:\/\//, '') : null,
        })
      } else {
        sendNotification({
          title,
          body,
          attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
          extra: { navType: 'conversation', navTarget: conv.id },
        })
      }
    } else {
      await showWebNotification(
        title,
        {
          body,
          icon: avatarUrl || './icon-512.png',
          tag: conv.id,
          onClick: () => navigateToConversation(conv.id),
        },
        { from: conv.id, type: 'conversation' },
      )
    }
  }

  // Show room notification
  const showRoomNotification = async (room: Room, message: RoomMessage) => {
    if (presenceStatusRef.current === 'dnd') return
    if (!getNotificationPermissionGranted()) {
      notificationDebug.desktopNotification({
        title: `${message.nick} @ ${room.name}`,
        body: '(permission not granted)',
        roomJid: room.jid,
      })
      return
    }

    // Format: "nick @ Room Name" as title, message body as body
    const title = `${message.nick} @ ${room.name}`
    const body = formatLocalizedPreview(message, t)

    notificationDebug.desktopNotification({
      title,
      body,
      roomJid: room.jid,
    })

    // Get room avatar
    const avatarUrl = await getNotificationAvatarUrl(room.avatar, room.avatarHash)

    if (isTauri) {
      if (await isMacOSDesktop()) {
        await invoke('post_notification', {
          title,
          body,
          navType: 'room',
          navTarget: room.jid,
          avatarPath: avatarUrl?.startsWith('file://') ? avatarUrl.replace(/^file:\/\//, '') : null,
        })
      } else {
        sendNotification({
          title,
          body,
          attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
          extra: { navType: 'room', navTarget: room.jid },
        })
      }
    } else {
      await showWebNotification(
        title,
        {
          body,
          icon: avatarUrl || './icon-512.png',
          tag: `room-${room.jid}`,
          onClick: () => navigateToRoom(room.jid),
        },
        { from: room.jid, type: 'room' },
      )
    }
  }

  // Subscribe to notification events
  useNotificationEvents({
    onConversationMessage: showConversationNotification,
    onRoomMessage: showRoomNotification,
  })
}
