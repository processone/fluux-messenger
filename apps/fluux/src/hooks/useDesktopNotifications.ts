import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { connectionStore, rosterStore, usePresence, useConnectionStatus, getBareJid, getLocalPart } from '@fluux/sdk'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { onAction } from '@tauri-apps/plugin-notification'
import type { Options as NotificationOptions } from '@tauri-apps/plugin-notification'
import { isMobileTauri } from '@/utils/tauriPlatform'
import { useNotificationEvents } from './useNotificationEvents'
import { useNavigateToTarget } from './useNavigateToTarget'
import {
  useNotificationPermission,
  getNotificationPermissionGranted,
  isTauri,
} from './useNotificationPermission'
import { getNotificationAvatarUrl } from '@/utils/notificationAvatar'
import { newMessagesText } from '@/utils/swMessages'
import { formatLocalizedPreview } from '@/utils/messagePreviewText'
import { notificationDebug } from '@/utils/notificationDebug'
import { showWebNotification } from '@/utils/webNotification'
import { webTag } from '@/utils/notificationNavigation'
import { routeNotificationTarget } from '@/utils/notificationRouting'
import { dismissNotification } from '@/utils/dismissNotification'
import { postPluginNotification } from '@/utils/postPluginNotification'
import { createNotificationCoalescer } from './notificationCoalescer'
import { requestAttention } from '@/utils/attention'

/** Duration of the post-reconnect window during which offline-delivery
 *  notifications are coalesced to one per conversation. */
const CATCHUP_WINDOW_MS = 3000

function currentAccountId(): string | null {
  const jid = connectionStore.getState().jid
  return jid ? getBareJid(jid) : null
}

async function postNativeDesktopNotification(payload: Record<string, unknown>): Promise<void> {
  try {
    await invoke('post_notification', payload)
  } catch (error) {
    console.error('[Notifications] Native notification failed:', error)
  }
}

/**
 * Hook to show desktop notifications for new messages and room mentions.
 * - Requests permission on mount (after login)
 * - Shows notification for messages in non-active conversations
 * - Shows notification for mentions in MUC rooms
 * - Clicking notification focuses the conversation/room and switches view
 * - Desktop: native platform backends route clicks through 'notification-activated'
 * - Mobile: the Tauri notification plugin routes actions through onAction()
 * - Falls back to web Notification API for non-Tauri environments
 */
export function useDesktopNotifications(): void {
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  useNotificationPermission()
  const { presenceStatus } = usePresence()
  const { t, i18n } = useTranslation()

  // Refs for stable access in async callbacks (useNavigateToTarget uses refs internally)
  const navigateToConversationRef = useRef(navigateToConversation)
  const navigateToRoomRef = useRef(navigateToRoom)
  const presenceStatusRef = useRef(presenceStatus)

  const { status } = useConnectionStatus()
  const prevStatusRef = useRef(status)
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coalescerRef = useRef(
    createNotificationCoalescer<{ conv: Conversation; message: Message }>(),
  )
  const showConvNotifRef = useRef<(conv: Conversation, message: Message) => void>(
    () => {},
  )

  useEffect(() => {
    navigateToConversationRef.current = navigateToConversation
    navigateToRoomRef.current = navigateToRoom
  }, [navigateToConversation, navigateToRoom])

  useEffect(() => {
    presenceStatusRef.current = presenceStatus
  }, [presenceStatus])

  // Handle notification clicks.
  //
  // Desktop: a native Rust backend emits "notification-activated" and stashes
  // a target until this listener is ready. Mobile: the plugin's onAction() is
  // the click source — registerListener only exists on iOS/Android, so guard
  // it there. Web routes clicks in sw.ts and is untouched here.
  useEffect(() => {
    if (!isTauri) return

    const route = (payload: unknown) => {
      const p = (payload ?? {}) as {
        navType?: string
        navTarget?: string
        messageId?: string
        accountId?: string
      }
      const currentAccount = connectionStore.getState().jid
      if (
        p.accountId
        && currentAccount
        && getBareJid(currentAccount) !== getBareJid(p.accountId)
      ) {
        console.warn('[Notifications] Ignoring activation for a different account')
        return
      }
      routeNotificationTarget(p.navType, p.navTarget, {
        navigateToConversation: navigateToConversationRef.current,
        navigateToRoom: navigateToRoomRef.current,
      }, p.messageId)
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
        .catch((error) => {
          console.warn('[Notifications] Failed to initialize native click routing:', error)
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
          messageId: notification.extra?.messageId,
          accountId: notification.extra?.accountId,
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
    requestAttention()
    if (!getNotificationPermissionGranted()) {
      notificationDebug.desktopNotification({
        title: conv.name || getLocalPart(message.from),
        body: '(permission not granted)',
        conversationId: conv.id,
      })
      return
    }

    const senderName = getLocalPart(message.from)
    const baseTitle = conv.name || senderName
    // When a reconnect backlog collapsed into one notification, surface the count.
    const title = conv.unreadCount > 1 ? `${baseTitle} (${conv.unreadCount})` : baseTitle
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
      const accountId = currentAccountId()
      if (!(await isMobileTauri())) {
        await postNativeDesktopNotification({
          title,
          body,
          navType: 'conversation',
          navTarget: conv.id,
          messageId: message.id,
          accountId,
          avatarPath: avatarUrl?.startsWith('file://') ? avatarUrl.replace(/^file:\/\//, '') : null,
        })
      } else {
        await postPluginNotification({
          title,
          body,
          attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
          extra: {
            navType: 'conversation',
            navTarget: conv.id,
            messageId: message.id,
            accountId,
          },
        })
      }
    } else {
      // Same-tag replacement swallows earlier messages, so surface the count in
      // the body (matches the SW push path; the title stays the plain name).
      const coalesced = conv.unreadCount > 1
      await showWebNotification(
        baseTitle,
        {
          body: coalesced ? newMessagesText(i18n.language, conv.unreadCount) : body,
          icon: avatarUrl || './icon-512.png',
          tag: webTag('conversation', conv.id),
          onClick: () => navigateToConversation(conv.id),
        },
        { from: conv.id, type: 'conversation', count: conv.unreadCount },
      )
    }
  }

  // Show room notification
  const showRoomNotification = async (room: Room, message: RoomMessage) => {
    if (presenceStatusRef.current === 'dnd') return
    requestAttention()
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
      const accountId = currentAccountId()
      if (!(await isMobileTauri())) {
        await postNativeDesktopNotification({
          title,
          body,
          navType: 'room',
          navTarget: room.jid,
          messageId: message.id,
          accountId,
          avatarPath: avatarUrl?.startsWith('file://') ? avatarUrl.replace(/^file:\/\//, '') : null,
        })
      } else {
        await postPluginNotification({
          title,
          body,
          attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
          extra: {
            navType: 'room',
            navTarget: room.jid,
            messageId: message.id,
            accountId,
          },
        })
      }
    } else {
      // Coalesced room notifications drop the per-message nick: the messages
      // may come from several senders, so the room name is the honest title.
      const coalesced = room.unreadCount > 1
      await showWebNotification(
        coalesced ? room.name : title,
        {
          body: coalesced ? newMessagesText(i18n.language, room.unreadCount) : body,
          icon: avatarUrl || './icon-512.png',
          tag: webTag('room', room.jid),
          onClick: () => navigateToRoom(room.jid),
        },
        { from: room.jid, type: 'room', count: room.unreadCount },
      )
    }
  }

  // Keep a ref to the latest dispatcher so the window-close timer is never stale.
  useEffect(() => {
    showConvNotifRef.current = showConversationNotification
  })

  // Open a catch-up window on each transition INTO 'online' from a non-online
  // status. This covers every path that carries a real reconnect backlog:
  // fresh connect (login), socket-died/SM-resume, and long-sleep reconnect —
  // all of which transit 'reconnecting' first. It intentionally does NOT cover
  // the verify-pass short-sleep path (connected → verifying → connected), where
  // the connection never dropped: the state machine maps 'verifying' to 'online'
  // (status never leaves 'online'), no online/resumed event fires, and there is
  // no backlog flush — messages arrive live. Coalescing that path would require
  // a wake-triggered window that delays every live notification after each
  // unlock, which is not worth it for a typically-empty trickle. See the design
  // doc's Non-goals.
  // Buffer per-conversation during the window; flush one notification per
  // conversation when it closes. Drop the buffer if the connection leaves
  // 'online' before flushing.
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    const coalescer = coalescerRef.current

    if (status === 'online' && prev !== 'online') {
      coalescer.open()
      if (windowTimerRef.current) clearTimeout(windowTimerRef.current)
      windowTimerRef.current = setTimeout(() => {
        windowTimerRef.current = null
        for (const { value } of coalescer.flush()) {
          void showConvNotifRef.current(value.conv, value.message)
        }
      }, CATCHUP_WINDOW_MS)
    }

    if (status !== 'online' && prev === 'online') {
      if (windowTimerRef.current) {
        clearTimeout(windowTimerRef.current)
        windowTimerRef.current = null
      }
      coalescer.drop()
    }
  }, [status])

  // Drop any pending buffer on unmount.
  useEffect(
    () => () => {
      if (windowTimerRef.current) clearTimeout(windowTimerRef.current)
      coalescerRef.current.drop()
    },
    [],
  )

  // Route conversation notifications through the coalescer while the window is open.
  const handleConversationMessage = async (conv: Conversation, message: Message) => {
    const coalescer = coalescerRef.current
    if (coalescer.isOpen()) {
      coalescer.add(conv.id, { conv, message })
      return
    }
    await showConversationNotification(conv, message)
  }

  // Dismiss the native notification when an entity is read — including reads
  // that the navigation/focus paths never see: a reply sent from another device
  // (sent carbon) or a synced cross-device read marker (MDS). Also drop any
  // still-buffered catch-up notification so the post-reconnect flush does not
  // re-post a banner for a conversation the user has since read/opened.
  const handleConversationRead = (conversationId: string) => {
    coalescerRef.current.delete(conversationId)
    void dismissNotification('conversation', conversationId)
  }

  const handleRoomRead = (roomJid: string) => {
    void dismissNotification('room', roomJid)
  }

  // Subscribe to notification events
  useNotificationEvents({
    onConversationMessage: handleConversationMessage,
    onRoomMessage: showRoomNotification,
    onConversationRead: handleConversationRead,
    onRoomRead: handleRoomRead,
  })
}
