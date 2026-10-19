import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { chatStore, isMessageFromIgnoredUser, isReplyToIgnoredUser, connectionStore, roomStore, rosterStore, checkForMention, isNotificationMessageUnread, shouldNotifyConversation, shouldNotifyRoom, resolveNotificationMessage, usePresence, useConnectionStatus, getBareJid, subscribeSettledReads, messageRowRef } from '@fluux/sdk'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'
import { ignoreStore } from '@fluux/sdk/stores'
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { onAction } from '@tauri-apps/plugin-notification'
import type { Options as NotificationOptions } from '@tauri-apps/plugin-notification'
import { isMobileTauri } from '@/utils/tauriPlatform'
import { useNotificationEvents } from './useNotificationEvents'
import { useNavigateToTarget } from './useNavigateToTarget'
import {
  useNotificationPermission,
  getNotificationPermissionGranted,
} from './useNotificationPermission'
import { getNotificationAvatarUrl } from '@/utils/notificationAvatar'
import { buildLocalMessageNotification, type LocalMessageNotification } from '@/utils/localMessageNotification'
import { notificationDebug } from '@/utils/notificationDebug'
import { showWebNotification } from '@/utils/webNotification'
import { webTag } from '@/utils/notificationNavigation'
import { routeNotificationTarget } from '@/utils/notificationRouting'
import { pushTapTarget } from '@/utils/pushTapTarget'
import { useArrivalJumpStore } from '@/stores/arrivalJumpStore'
import { announcedByPush } from './useNativePush'
import { dismissNotification } from '@/utils/dismissNotification'
import { postPluginNotification } from '@/utils/postPluginNotification'
import { currentAccountId, postNativeDesktopNotification } from '@/utils/nativeNotification'
import { createNotificationCoalescer } from './notificationCoalescer'
import { requestAttention } from '@/utils/attention'
import { platform } from '@/platform'

/** Duration of the post-reconnect window during which offline-delivery
 *  notifications are coalesced to one per conversation. */
const CATCHUP_WINDOW_MS = 3000

/**
 * Hook to show system notifications for new messages and room mentions.
 * - Requests permission on mount (after login)
 * - Shows notification for messages in non-active conversations
 * - Shows notification for mentions in MUC rooms
 * - Clicking notification focuses the conversation/room and switches view
 * - Desktop: native platform backends route clicks through 'notification-activated'
 * - Mobile: the Tauri notification plugin routes actions through onAction()
 * - Falls back to web Notification API for non-Tauri environments
 */
export function useDesktopNotifications(): void {
  const {
    navigateToConversation,
    navigateToRoom,
    navigateToContactRequests,
    navigateToRoomInvitations,
  } = useNavigateToTarget()
  useNotificationPermission()
  const { presenceStatus } = usePresence()
  const { t, i18n } = useTranslation()

  // Refs for stable access in async callbacks (useNavigateToTarget uses refs internally)
  const navigateToConversationRef = useRef(navigateToConversation)
  const navigateToRoomRef = useRef(navigateToRoom)
  const navigateToContactRequestsRef = useRef(navigateToContactRequests)
  const navigateToRoomInvitationsRef = useRef(navigateToRoomInvitations)
  const presenceStatusRef = useRef(presenceStatus)

  const accountGenerationRef = useRef(0)
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
    let account = currentAccountId()
    return connectionStore.subscribe?.(state => {
      const next = state.jid ? getBareJid(state.jid) : null
      if (next === account) return
      accountGenerationRef.current++
      account = next
      if (windowTimerRef.current) clearTimeout(windowTimerRef.current)
      windowTimerRef.current = null
      coalescerRef.current.drop()
    })
  }, [])

  useEffect(() => {
    navigateToConversationRef.current = navigateToConversation
    navigateToRoomRef.current = navigateToRoom
    navigateToContactRequestsRef.current = navigateToContactRequests
    navigateToRoomInvitationsRef.current = navigateToRoomInvitations
  }, [navigateToConversation, navigateToRoom, navigateToContactRequests, navigateToRoomInvitations])

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
    if (!platform().notificationsManagedByOS) return

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
        navigateToContactRequests: navigateToContactRequestsRef.current,
        navigateToRoomInvitations: navigateToRoomInvitationsRef.current,
      }, p.messageId)
    }

    const desktop = platform().shell === 'desktop'
    let cancelled = false
    let unlisten: (() => void) | undefined

    // Desktop: Tauri event + cold-start drain. Register the listener, tell the
    // native side it's ready, THEN drain any target stashed before readiness
    // (cold start: the delegate fires before this effect mounts).
    if (desktop) {
      void listen('notification-activated', (e) => route(e.payload)).then((un) => {
        if (cancelled) {
          un()
          return
        }
        unlisten = un
        void invoke('set_notification_listener_ready', { ready: true })
          .then(() => invoke('take_pending_notification_target'))
          .then((target) => {
            if (!cancelled && target) route(target)
          })
          .catch((error) => {
            console.warn('[Notifications] Failed to initialize native click routing:', error)
          })
      })
    } else {
      // Mobile: onAction (iOS/Android only).
      void onAction((notification: NotificationOptions) => {
        route({
          navType: notification.extra?.navType,
          navTarget: notification.extra?.navTarget,
          messageId: notification.extra?.messageId,
          accountId: notification.extra?.accountId,
        })
      }).then((listener) => {
        if (cancelled) void listener.unregister()
        else unlisten = () => { void listener.unregister() }
      })
    }

    // Native push: the plugin keeps the last tapped remote notification until
    // taken, so a tap that launched the app is read here once the hook mounts.
    let unlistenPushTap: (() => void) | undefined
    if (platform().usesNativePush) {
      const takePushTap = () => {
        void invoke<{ payload?: Record<string, unknown> | null }>('plugin:push|take_pending_tap')
          .then(({ payload }) => {
            if (cancelled) return
            const target = pushTapTarget(payload, (jid) => roomStore.getState().getRoom(jid) !== undefined)
            if (!target) return
            // The pushed message is fetched after the conversation opens.
            useArrivalJumpStore.getState().request(target.navTarget)
            route(target)
          })
          .catch((error) => console.warn('[Notifications] Failed to read the tapped push notification:', error))
      }
      void addPluginListener('push', 'tap', takePushTap)
        .then((listener) => {
          if (cancelled) void listener.unregister()
          else unlistenPushTap = () => { void listener.unregister() }
        })
        .catch((error) => console.warn('[Notifications] Push tap listener unavailable:', error))
      takePushTap()
    }

    return () => {
      cancelled = true
      if (desktop) void invoke('set_notification_listener_ready', { ready: false }).catch(() => {})
      unlisten?.()
      unlistenPushTap?.()
    }
  }, [])

  const resolveTarget = async (target: LocalMessageNotification): Promise<LocalMessageNotification | undefined> => {
    const message = await resolveNotificationMessage(target.message)
    if (!message || (!target.message.isRetracted && message.isRetracted)) return undefined
    const windowVisible = connectionStore.getState().windowVisible
    if (target.kind === 'chat' && message.type === 'chat') {
      const state = chatStore.getState()
      const entity = state.conversations.get(target.entity.id)
      if (!entity || announcedByPush(message) || !isNotificationMessageUnread(message, entity.readPointer) ||
        !shouldNotifyConversation(message, { isActive: entity.id === state.activeConversationId, windowVisible, unreadCount: entity.unreadCount, readPointer: entity.readPointer })) return undefined
      return { kind: 'chat', entity, message }
    }
    if (target.kind === 'room' && message.type === 'groupchat') {
      const state = roomStore.getState()
      const entity = state.rooms.get(target.entity.jid)
      if (!entity?.joined || !isNotificationMessageUnread(message, entity.readPointer)) return undefined
      const ignored = ignoreStore.getState().getIgnoredForRoom(entity.jid)
      if (isMessageFromIgnoredUser(ignored, message, entity.nickToJidCache) ||
        isReplyToIgnoredUser(ignored, message.replyTo, entity.nickToJidCache)) return undefined
      const isMention = message.isMentionAll || checkForMention(message.body, entity.nickname) || /@all\b/i.test(message.body)
      const current = { ...message, isMention }
      if (!shouldNotifyRoom(current, { isActive: entity.jid === state.activeRoomJid, windowVisible }, entity.notifyAll ?? entity.notifyAllPersistent ?? false).shouldNotify) return undefined
      return { kind: 'room', entity, message: current }
    }
    return undefined
  }

  const isDnd = () => presenceStatusRef.current === 'dnd'

  const showMessageNotification = async (original: LocalMessageNotification) => {
    const accountId = currentAccountId()
    const generation = accountGenerationRef.current
    const desktop = platform().notificationsManagedByOS
    let target = await resolveTarget(original)
    if (!target || isDnd() || currentAccountId() !== accountId || accountGenerationRef.current !== generation) return
    let notification = buildLocalMessageNotification(target, t, i18n?.language ?? 'en', !desktop)
    if (!notification) return
    requestAttention()
    if (!getNotificationPermissionGranted()) {
      notificationDebug.desktopNotification({ title: notification.title, body: '(permission not granted)',
        ...(target.kind === 'chat' ? { conversationId: target.entity.id } : { roomJid: target.entity.jid }) })
      return
    }
    const avatar = target.kind === 'chat'
      ? rosterStore.getState().getContact(target.entity.id)
      : target.entity
    const avatarUrl = await getNotificationAvatarUrl(avatar?.avatar, avatar?.avatarHash)
    const mobile = desktop && await isMobileTauri()
    // Avatar/platform work may outlive a decrypt repair, edit, read or account change.
    target = await resolveTarget(original)
    if (!target || isDnd() || currentAccountId() !== accountId || accountGenerationRef.current !== generation || !getNotificationPermissionGranted()) return
    notification = buildLocalMessageNotification(target, t, i18n?.language ?? 'en', !desktop)
    if (!notification) return
    const { title, body, navType, navTarget, messageId, count } = notification
    notificationDebug.desktopNotification({ title, body: '(message preview)',
      ...(target.kind === 'chat' ? { conversationId: navTarget } : { roomJid: navTarget }) })
    if (desktop) {
      if (!mobile) {
        await postNativeDesktopNotification({ title, body, navType, navTarget, messageId, accountId,
          avatarPath: avatarUrl?.startsWith('file://') ? avatarUrl.replace(/^file:\/\//, '') : null })
      } else {
        await postPluginNotification({ title, body,
          attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
          extra: { navType, navTarget, messageId, accountId } }, messageRowRef(target.message))
      }
    } else {
      await showWebNotification(title, { body, icon: avatarUrl || './icon-512.png', tag: webTag(navType, navTarget),
        onClick: () => navType === 'conversation' ? navigateToConversation(navTarget) : navigateToRoom(navTarget),
      }, { from: navTarget, type: navType, count })
    }
  }

  const showConversationNotification = (conv: Conversation, message: Message) =>
    showMessageNotification({ kind: 'chat', entity: conv, message })
  const showRoomNotification = (room: Room, message: RoomMessage) =>
    showMessageNotification({ kind: 'room', entity: room, message })

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
    if (announcedByPush(message)) return
    const coalescer = coalescerRef.current
    if (coalescer.isOpen()) {
      coalescer.add(conv.id, { conv, message })
      return
    }
    await showConversationNotification(conv, message)
  }

  // Dismiss the native notification when an entity is read — including a
  // synced cross-device read marker (MDS), which the navigation/focus paths
  // never see. Also drop any still-buffered catch-up notification so the
  // post-reconnect flush does not re-post a banner for a conversation the user
  // has since read/opened.
  const handleConversationRead = (conversationId: string) => {
    coalescerRef.current.delete(conversationId)
    void dismissNotification('conversation', conversationId)
  }

  const handleRoomRead = (roomJid: string) => {
    void dismissNotification('room', roomJid)
  }

  // A read that settled during catch-up never crosses unread > 0 → 0: the message and a
  // XEP-0490 marker from another client arrive together after a fresh session.
  useEffect(
    () => subscribeSettledReads(({ kind, conversationId }) => {
      if (kind === 'chat') handleConversationRead(conversationId)
      else handleRoomRead(conversationId)
    }),
    [],
  )

  // Subscribe to notification events
  useNotificationEvents({
    onConversationMessage: handleConversationMessage,
    onRoomMessage: showRoomNotification,
    onConversationRead: handleConversationRead,
    onRoomRead: handleRoomRead,
  })
}
