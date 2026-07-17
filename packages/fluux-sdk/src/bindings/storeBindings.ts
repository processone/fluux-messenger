/**
 * Store bindings - wire SDK events to Zustand store updates.
 *
 * This module provides the event-based store binding layer between
 * the SDK's typed event system and the Zustand stores. Instead of
 * modules directly calling store methods, they emit events which
 * these bindings translate into store updates.
 *
 * Benefits:
 * - Clean SDK/React-SDK separation
 * - Bot usage without React (skip bindings, handle events directly)
 * - No render loops (events are decoupled from React lifecycle)
 * - Testable in isolation
 *
 * @packageDocumentation
 * @module Bindings
 */

import type { XMPPClient } from '../core/XMPPClient'
import type {
  connectionStore,
  chatStore,
  rosterStore,
  roomStore,
  eventsStore,
  adminStore,
  blockingStore,
  consoleStore,
  ignoreStore,
} from '../stores'
import { isMessageFromIgnoredUser, isReplyToIgnoredUser, ignoreStore as ignoreStoreInstance } from '../stores'
import { findLastNonIgnoredMessage } from '../stores/shared/lastMessageUtils'
import { isMarkerDebugEnabled, markerDebugLog } from '../utils/markerDebug'
import { getBareJid, getLocalPart } from '../core/jid'

/**
 * Store references for binding SDK events.
 * Uses the vanilla Zustand store getState() pattern.
 */
export interface StoreRefs {
  connection: ReturnType<typeof connectionStore.getState>
  chat: ReturnType<typeof chatStore.getState>
  roster: ReturnType<typeof rosterStore.getState>
  room: ReturnType<typeof roomStore.getState>
  events: ReturnType<typeof eventsStore.getState>
  admin: ReturnType<typeof adminStore.getState>
  blocking: ReturnType<typeof blockingStore.getState>
  console: ReturnType<typeof consoleStore.getState>
  ignore: ReturnType<typeof ignoreStore.getState>
}

/**
 * Unsubscribe function returned by createStoreBindings.
 */
export type UnsubscribeBindings = () => void

/**
 * Create store bindings that wire SDK events to Zustand stores.
 *
 * Call this once when initializing the XMPP client (e.g., in XMPPProvider).
 * Returns an unsubscribe function to clean up all event subscriptions.
 *
 * @param client - The XMPPClient instance to bind
 * @param getStores - Function that returns current store state (called lazily)
 * @returns Unsubscribe function to remove all bindings
 *
 * @example
 * ```typescript
 * const unsubscribe = createStoreBindings(client, () => ({
 *   connection: useConnectionStore.getState(),
 *   chat: useChatStore.getState(),
 *   // ... other stores
 * }))
 *
 * // Clean up on unmount
 * unsubscribe()
 * ```
 */
export function createStoreBindings(
  client: XMPPClient,
  getStores: () => StoreRefs
): UnsubscribeBindings {
  const unsubscribers: Array<() => void> = []

  // Helper to subscribe and track for cleanup
  const on = <K extends Parameters<typeof client.subscribe>[0]>(
    event: K,
    handler: Parameters<typeof client.subscribe<K>>[1]
  ) => {
    const unsub = client.subscribe(event, handler)
    unsubscribers.push(unsub)
  }

  // ============================================================================
  // Connection Events
  // ============================================================================

  // Note: connection:status store updates are handled directly by Connection.ts
  // (setStatus/setError/setJid calls). The SDK event is emitted for external consumers
  // but the store binding here is intentionally removed to avoid duplicate updates
  // that cause unnecessary React re-renders during reconnection cycles.

  // connection:authenticated is also handled directly by Connection.ts

  on('connection:server-info', ({ info }) => {
    const stores = getStores()
    stores.connection.setServerInfo(info)
  })

  on('connection:http-upload-service', ({ service }) => {
    const stores = getStores()
    stores.connection.setHttpUploadService(service)
  })

  on('connection:mam-fulltext-search', ({ supported }) => {
    const stores = getStores()
    stores.connection.setMAMFulltextSearch(supported)
  })

  on('connection:own-avatar', ({ avatar, hash }) => {
    const stores = getStores()
    stores.connection.setOwnAvatar(avatar, hash ?? undefined)
  })

  on('connection:own-nickname', ({ nickname }) => {
    const stores = getStores()
    stores.connection.setOwnNickname(nickname)
  })

  on('connection:own-vcard', ({ vcard }) => {
    const stores = getStores()
    stores.connection.setOwnVCard(vcard)
  })

  on('connection:own-resource', (payload) => {
    const stores = getStores()
    stores.connection.updateOwnResource(
      payload.resource,
      payload.show,
      payload.priority,
      payload.status,
      payload.lastInteraction,
      payload.client
    )
  })

  on('connection:own-resource-offline', ({ resource }) => {
    const stores = getStores()
    stores.connection.removeOwnResource(resource)
  })

  on('connection:webpush-services', ({ services }) => {
    const stores = getStores()
    // Set both fields atomically so subscribeWithSelector fires once with
    // consistent {services, status} — two separate set() calls can cause
    // the subscription to see services updated but status still stale,
    // skipping the registration trigger.
    stores.connection.setWebPushServicesAndStatus(
      services,
      services.length > 0 ? 'available' : 'unavailable'
    )
  })

  on('connection:webpush-status', ({ status }) => {
    const stores = getStores()
    stores.connection.setWebPushStatus(status)
  })

  // ============================================================================
  // Chat Events (1:1 Messaging)
  // ============================================================================

  on('chat:message', ({ message }) => {
    const stores = getStores()
    stores.chat.addMessage(message)
  })

  on('chat:conversation', ({ conversation }) => {
    const stores = getStores()
    stores.chat.addConversation(conversation)
  })

  on('chat:conversation-name', ({ conversationId, name }) => {
    const stores = getStores()
    stores.chat.updateConversationName(conversationId, name)
  })

  on('chat:typing', ({ conversationId, jid, isTyping }) => {
    const stores = getStores()
    stores.chat.setTyping(conversationId, jid, isTyping)
  })

  on('room:typing', ({ roomJid, nick, isTyping }) => {
    const stores = getStores()
    stores.room.setTyping(roomJid, nick, isTyping)
  })

  on('chat:reactions', ({ conversationId, messageId, reactorJid, emojis }) => {
    const stores = getStores()
    stores.chat.updateReactions(conversationId, messageId, reactorJid, emojis)
  })

  on('chat:message-updated', ({ conversationId, messageId, updates }) => {
    const stores = getStores()
    stores.chat.updateMessage(conversationId, messageId, updates)
  })

  on('message:security-updated', ({ conversationId, messageId, securityContext, body }) => {
    const stores = getStores()
    stores.chat.updateMessage(conversationId, messageId, {
      securityContext,
      ...(body !== undefined && { body }),
    })
  })

  on('chat:message-error', ({ conversationId, messageId, error }) => {
    const stores = getStores()
    stores.chat.updateMessage(conversationId, messageId, { deliveryError: error })
  })

  on('chat:animation', ({ conversationId, animation, senderJid }) => {
    const stores = getStores()
    // Only auto-play in the active conversation; inactive eggs are surfaced by
    // useEasterEggNotifications (toast + pending-egg store) and played on open.
    if (stores.chat.activeConversationId === conversationId) {
      // Name the sender on the overlay, but not for our own outgoing egg.
      const isOwn = getBareJid(senderJid) === getBareJid(stores.connection.jid ?? '')
      stores.chat.triggerAnimation(conversationId, animation, isOwn ? undefined : getLocalPart(senderJid))
    }
  })

  on('read:displayed-synced', ({ conversationId, stanzaId }) => {
    const stores = getStores()
    const isRoom = stores.room.rooms.has(conversationId)
    // XEP-0490 read-position from another of our own devices. This advances lastSeenMessageId,
    // from which the unread divider (firstNewMessageId) is derived — so a sync landing on/just
    // before a conversation the user is entering can shrink or erase the divider and flip the
    // message-list scroll branch (scroll-to-marker → scroll-to-bottom). Log before→after so the
    // [MDS] line sits inline with the [Scroll]/[Nav] trace at the moment it mutates the marker.
    if (isMarkerDebugEnabled()) {
      const beforeSeen = isRoom
        ? stores.room.roomMeta.get(conversationId)?.lastSeenMessageId
        : stores.chat.conversationMeta.get(conversationId)?.lastSeenMessageId
      const isActive = isRoom
        ? stores.room.activeRoomJid === conversationId
        : stores.chat.activeConversationId === conversationId
      if (isRoom) stores.room.applyRemoteDisplayed(conversationId, stanzaId)
      else stores.chat.applyRemoteDisplayed(conversationId, stanzaId)
      const after = getStores()
      const afterSeen = isRoom
        ? after.room.roomMeta.get(conversationId)?.lastSeenMessageId
        : after.chat.conversationMeta.get(conversationId)?.lastSeenMessageId
      markerDebugLog('read:displayed-synced (remote device)', {
        conversationId, stanzaId, kind: isRoom ? 'room' : 'chat', isActive,
        lastSeenBefore: beforeSeen, lastSeenAfter: afterSeen, advanced: beforeSeen !== afterSeen,
      })
      return
    }
    if (isRoom) {
      stores.room.applyRemoteDisplayed(conversationId, stanzaId)
    } else {
      stores.chat.applyRemoteDisplayed(conversationId, stanzaId)
    }
  })

  on('chat:mam-loading', ({ conversationId, isLoading }) => {
    const stores = getStores()
    stores.chat.setMAMLoading(conversationId, isLoading)
  })

  on('chat:mam-error', ({ conversationId, error }) => {
    const stores = getStores()
    stores.chat.setMAMError(conversationId, error)
  })

  on('chat:mam-messages', ({ conversationId, messages, rsm, complete, direction, isFetchLatest, preserveGapMarker, initialBefore, fetchLatestTopId, sawCoverageTop, walkCarriedModifications }) => {
    const stores = getStores()
    stores.chat.mergeMAMMessages(conversationId, messages, rsm, complete, direction, isFetchLatest, preserveGapMarker, { initialBefore, fetchLatestTopId, sawCoverageTop, walkCarriedModifications })
  })

  // A purged id-exact anchor (item-not-found degrade): strip the matching
  // startId from the persisted gap so the timestamp fallback can progress.
  on('chat:mam-anchor-purged', ({ conversationId, after }) => {
    const stores = getStores()
    stores.chat.clearConversationGapAnchor(conversationId, after)
  })

  // A purged coverage-record anchor (item-not-found degrade): drop the record
  // so later resumes don't re-anchor on the dead id forever. Guarded on the
  // exact bottomId — a record that already advanced is left untouched.
  on('chat:mam-coverage-purged', ({ conversationId, before }) => {
    const stores = getStores()
    stores.chat.clearConversationCoverage(conversationId, before)
  })

  // ============================================================================
  // Room Events (MUC)
  // ============================================================================

  on('room:added', ({ room }) => {
    const stores = getStores()
    stores.room.addRoom(room)
  })

  on('room:updated', ({ roomJid, updates }) => {
    const stores = getStores()
    stores.room.updateRoom(roomJid, updates)
  })

  on('room:removed', ({ roomJid }) => {
    const stores = getStores()
    stores.room.removeRoom(roomJid)
  })

  on('room:joined', ({ roomJid, joined }) => {
    const stores = getStores()
    stores.room.setRoomJoined(roomJid, joined)
  })

  on('room:occupant-joined', ({ roomJid, occupant }) => {
    const stores = getStores()
    stores.room.addOccupant(roomJid, occupant)
  })

  on('room:occupants-batch', ({ roomJid, occupants }) => {
    const stores = getStores()
    stores.room.batchAddOccupants(roomJid, occupants)
  })

  on('room:occupant-left', ({ roomJid, nick }) => {
    const stores = getStores()
    stores.room.removeOccupant(roomJid, nick)
  })

  // Coalesce per-occupant avatar resolutions into one store write per room.
  // Joining a large room fires one async avatar fetch per occupant; writing each
  // resolution individually replaces the occupants Map N times in a burst and
  // re-renders every room subscriber once per avatar (render storm on join).
  const AVATAR_FLUSH_DELAY_MS = 200
  const pendingOccupantAvatars = new Map<string, Map<string, { nick: string; avatar: string | null; avatarHash: string | null }>>()
  let avatarFlushTimer: ReturnType<typeof setTimeout> | null = null

  const flushOccupantAvatars = () => {
    avatarFlushTimer = null
    const stores = getStores()
    for (const [roomJid, byNick] of pendingOccupantAvatars) {
      stores.room.updateOccupantAvatars(roomJid, [...byNick.values()])
    }
    pendingOccupantAvatars.clear()
  }

  on('room:occupant-avatar', ({ roomJid, nick, avatar, avatarHash }) => {
    let byNick = pendingOccupantAvatars.get(roomJid)
    if (!byNick) {
      byNick = new Map()
      pendingOccupantAvatars.set(roomJid, byNick)
    }
    byNick.set(nick, { nick, avatar, avatarHash })
    if (avatarFlushTimer === null) {
      avatarFlushTimer = setTimeout(flushOccupantAvatars, AVATAR_FLUSH_DELAY_MS)
    }
  })

  unsubscribers.push(() => {
    if (avatarFlushTimer !== null) {
      clearTimeout(avatarFlushTimer)
      avatarFlushTimer = null
    }
    pendingOccupantAvatars.clear()
  })

  on('room:self-occupant', ({ roomJid, occupant }) => {
    const stores = getStores()
    stores.room.setSelfOccupant(roomJid, occupant)
  })

  on('room:message', ({ roomJid, message, incrementUnread, incrementMentions }) => {
    const stores = getStores()
    const ignoredUsers = stores.ignore.getIgnoredForRoom(roomJid)
    const nickToJidCache = stores.room.getRoom(roomJid)?.nickToJidCache
    // Suppress notifications for ignored users and replies quoting them
    const doNotNotify =
      isMessageFromIgnoredUser(ignoredUsers, message, nickToJidCache) ||
      isReplyToIgnoredUser(ignoredUsers, message.replyTo, nickToJidCache)
    stores.room.addMessage(roomJid, message, {
      incrementUnread: incrementUnread && !doNotNotify,
      incrementMentions: incrementMentions && !doNotNotify,
    })
  })

  on('room:whisper', ({ roomJid, message, incrementUnread, incrementMentions }) => {
    const stores = getStores()
    const ignoredUsers = stores.ignore.getIgnoredForRoom(roomJid)
    const nickToJidCache = stores.room.getRoom(roomJid)?.nickToJidCache
    // Suppress notifications for ignored occupants and replies quoting them
    const doNotNotify =
      isMessageFromIgnoredUser(ignoredUsers, message, nickToJidCache) ||
      isReplyToIgnoredUser(ignoredUsers, message.replyTo, nickToJidCache)
    // Whispers are locally durable: addMessage persists + indexes them like any message.
    stores.room.addMessage(roomJid, message, {
      incrementUnread: !!incrementUnread && !doNotNotify,
      incrementMentions: !!incrementMentions && !doNotNotify,
    })
  })

  on('room:message-updated', ({ roomJid, messageId, updates }) => {
    const stores = getStores()
    stores.room.updateMessage(roomJid, messageId, updates)
  })

  on('room:reactions', ({ roomJid, messageId, reactorNick, emojis }) => {
    const stores = getStores()
    stores.room.updateReactions(roomJid, messageId, reactorNick, emojis)
  })

  on('room:subject', ({ roomJid, subject }) => {
    const stores = getStores()
    stores.room.updateRoom(roomJid, { subject })
  })

  on('room:bookmark', ({ roomJid, bookmark }) => {
    const stores = getStores()
    stores.room.setBookmark(roomJid, bookmark)
  })

  on('room:bookmark-removed', ({ roomJid }) => {
    const stores = getStores()
    stores.room.removeBookmark(roomJid)
  })

  on('room:animation', ({ roomJid, animation, senderNick }) => {
    const stores = getStores()
    if (stores.room.activeRoomJid === roomJid) {
      // Name the sender on the overlay, but not for our own outgoing egg
      // (own sends carry an empty nick; a reflection carries our own nick).
      const ownNick = stores.room.rooms.get(roomJid)?.nickname
      const isOwn = !senderNick || senderNick === ownNick
      stores.room.triggerAnimation(roomJid, animation, isOwn ? undefined : senderNick)
    }
  })

  on('room:mam-loading', ({ roomJid, isLoading }) => {
    const stores = getStores()
    stores.room.setRoomMAMLoading(roomJid, isLoading)
  })

  on('room:mam-error', ({ roomJid, error }) => {
    const stores = getStores()
    stores.room.setRoomMAMError(roomJid, error)
  })

  on('room:mam-messages', ({ roomJid, messages, rsm, complete, direction, preserveGapMarker, isFetchLatest, initialBefore, fetchLatestTopId, sawCoverageTop, walkCarriedModifications }) => {
    const stores = getStores()
    stores.room.mergeRoomMAMMessages(roomJid, messages, rsm, complete, direction, preserveGapMarker, isFetchLatest, { initialBefore, fetchLatestTopId, sawCoverageTop, walkCarriedModifications })
  })

  // Room twin of chat:mam-anchor-purged (see above).
  on('room:mam-anchor-purged', ({ roomJid, after }) => {
    const stores = getStores()
    stores.room.clearRoomGapAnchor(roomJid, after)
  })

  // Room twin of chat:mam-coverage-purged (see above).
  on('room:mam-coverage-purged', ({ roomJid, before }) => {
    const stores = getStores()
    stores.room.clearRoomCoverage(roomJid, before)
  })

  on('room:members', ({ roomJid, members }) => {
    const stores = getStores()
    stores.room.mergeRoomMembers(roomJid, members, (jid) => {
      return stores.roster.getContact(jid)?.avatar ?? null
    })
  })

  on('room:affiliation-changed', ({ roomJid, userJid, affiliation }) => {
    const stores = getStores()
    stores.room.updateMemberAffiliation(roomJid, userJid, affiliation)
  })

  // ============================================================================
  // Roster Events
  // ============================================================================

  on('roster:loaded', ({ contacts }) => {
    const stores = getStores()
    stores.roster.setContacts(contacts)
  })

  on('roster:contact', ({ contact }) => {
    const stores = getStores()
    stores.roster.addOrUpdateContact(contact)
  })

  on('roster:contact-updated', ({ jid, updates }) => {
    const stores = getStores()
    stores.roster.updateContact(jid, updates)
  })

  on('roster:contact-removed', ({ jid }) => {
    const stores = getStores()
    stores.roster.removeContact(jid)
  })

  on('roster:presence', (payload) => {
    const stores = getStores()
    stores.roster.updatePresence(
      payload.fullJid,
      payload.show,
      payload.priority,
      payload.statusMessage,
      payload.lastInteraction,
      payload.client
    )
  })

  on('roster:presence-offline', ({ fullJid }) => {
    const stores = getStores()
    stores.roster.removePresence(fullJid)
  })

  on('roster:presence-error', ({ jid, error }) => {
    const stores = getStores()
    stores.roster.setPresenceError(jid, error)
  })

  on('roster:avatar', ({ jid, avatar, avatarHash }) => {
    const stores = getStores()
    stores.roster.updateAvatar(jid, avatar, avatarHash)
  })

  // ============================================================================
  // Events Store (Notifications)
  // ============================================================================

  on('events:subscription-request', ({ from }) => {
    const stores = getStores()
    stores.events.addSubscriptionRequest(from)
  })

  on('events:subscription-request-removed', ({ from }) => {
    const stores = getStores()
    stores.events.removeSubscriptionRequest(from)
  })

  on('events:stranger-message', ({ from, body }) => {
    const stores = getStores()
    stores.events.addStrangerMessage(from, body)
  })

  on('events:stranger-messages-removed', ({ from }) => {
    const stores = getStores()
    stores.events.removeStrangerMessages(from)
  })

  on('events:muc-invitation', (payload) => {
    const stores = getStores()
    stores.events.addMucInvitation(
      payload.roomJid,
      payload.from,
      payload.reason,
      payload.password,
      payload.isDirect,
      payload.isQuickChat
    )
  })

  on('events:muc-invitation-removed', ({ roomJid }) => {
    const stores = getStores()
    stores.events.removeMucInvitation(roomJid)
  })

  on('events:system-notification', ({ type, title, message }) => {
    const stores = getStores()
    stores.events.addSystemNotification(type, title, message)
  })

  // ============================================================================
  // Blocking Events
  // ============================================================================

  on('blocking:list', ({ jids }) => {
    const stores = getStores()
    stores.blocking.setBlocklist(jids)
  })

  on('blocking:added', ({ jids }) => {
    const stores = getStores()
    stores.blocking.addBlockedJids(jids)
  })

  on('blocking:removed', ({ jids }) => {
    const stores = getStores()
    stores.blocking.removeBlockedJids(jids)
  })

  on('blocking:cleared', () => {
    const stores = getStores()
    stores.blocking.clearBlocklist()
  })

  // ============================================================================
  // Admin Events
  // ============================================================================

  on('admin:is-admin', ({ isAdmin }) => {
    const stores = getStores()
    stores.admin.setIsAdmin(isAdmin)
  })

  on('admin:commands', ({ commands }) => {
    const stores = getStores()
    stores.admin.setCommands(commands)
  })

  on('admin:session', ({ session }) => {
    const stores = getStores()
    stores.admin.setCurrentSession(session)
  })

  on('admin:discovering', ({ isDiscovering }) => {
    const stores = getStores()
    stores.admin.setIsDiscovering(isDiscovering)
  })

  on('admin:executing', ({ isExecuting }) => {
    const stores = getStores()
    stores.admin.setIsExecuting(isExecuting)
  })

  on('admin:vhosts', ({ vhosts }) => {
    const stores = getStores()
    stores.admin.setVhosts(vhosts)
  })

  on('admin:selected-vhost', ({ vhost }) => {
    const stores = getStores()
    stores.admin.setSelectedVhost(vhost)
  })

  on('admin:muc-service', ({ mucServiceJid }) => {
    const stores = getStores()
    stores.admin.setMucServiceJid(mucServiceJid)
  })

  on('admin:server-stats', ({ stats }) => {
    const stores = getStores()
    stores.admin.setServerStats(stats)
  })

  // ============================================================================
  // Console Events (optional, for debugging)
  // ============================================================================

  on('console:event', ({ message, category }) => {
    const stores = getStores()
    stores.console.addEvent(message, category)
  })

  on('console:packet', ({ direction, xml }) => {
    const stores = getStores()
    stores.console.addPacket(direction, xml)
  })

  // Recalculate room lastMessage previews when users are un-ignored.
  // NOTE: this subscribes to the module-global ignore singleton, not the injected
  // bundle. Harmless in single-account (the singleton IS client.stores.ignore), but a
  // known direct-global consumer to thread through the bundle for multi-account — see
  // docs/MULTI_ACCOUNT.md §3.1 for why getStores().ignore is NOT the fix.
  let prevIgnoredUsers = ignoreStoreInstance.getState().ignoredUsers
  const unsubIgnore = ignoreStoreInstance.subscribe((state) => {
    const curr = state.ignoredUsers
    if (curr === prevIgnoredUsers) return
    const prev = prevIgnoredUsers
    prevIgnoredUsers = curr

    const stores = getStores()
    // Find rooms where the ignore list changed (user ignored or un-ignored)
    const allRoomJids = new Set([...Object.keys(prev), ...Object.keys(curr)])
    for (const roomJid of allRoomJids) {
      const prevList = prev[roomJid]
      const currList = curr[roomJid]
      if (prevList === currList) continue

      // Recalculate lastMessage from in-memory messages
      const room = stores.room.getRoom(roomJid)
      if (room && room.messages.length > 0) {
        const newLast = findLastNonIgnoredMessage(room.messages, roomJid, room.nickToJidCache)
        if (newLast) {
          stores.room.updateLastMessagePreview(roomJid, newLast)
        }
      }
    }
  })
  unsubscribers.push(unsubIgnore)

  // Return cleanup function
  return () => {
    for (const unsub of unsubscribers) {
      unsub()
    }
    unsubscribers.length = 0
  }
}
