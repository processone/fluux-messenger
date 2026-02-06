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
} from '../stores'

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

  on('connection:status', ({ status, error }) => {
    const stores = getStores()
    switch (status) {
      case 'connecting':
        stores.connection.setStatus('connecting')
        break
      case 'online':
        stores.connection.setStatus('online')
        break
      case 'offline':
        stores.connection.setStatus('disconnected')
        break
      case 'error':
        stores.connection.setStatus('error')
        if (error) stores.connection.setError(error)
        break
      case 'reconnecting':
        stores.connection.setStatus('reconnecting')
        break
    }
  })

  on('connection:authenticated', ({ jid }) => {
    const stores = getStores()
    stores.connection.setJid(jid)
  })

  on('connection:server-info', ({ info }) => {
    const stores = getStores()
    stores.connection.setServerInfo(info)
  })

  on('connection:http-upload-service', ({ service }) => {
    const stores = getStores()
    stores.connection.setHttpUploadService(service)
  })

  on('connection:own-avatar', ({ avatar, hash }) => {
    const stores = getStores()
    stores.connection.setOwnAvatar(avatar, hash ?? undefined)
  })

  on('connection:own-nickname', ({ nickname }) => {
    const stores = getStores()
    stores.connection.setOwnNickname(nickname)
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

  on('chat:reactions', ({ conversationId, messageId, reactorJid, emojis }) => {
    const stores = getStores()
    stores.chat.updateReactions(conversationId, messageId, reactorJid, emojis)
  })

  on('chat:message-updated', ({ conversationId, messageId, updates }) => {
    const stores = getStores()
    stores.chat.updateMessage(conversationId, messageId, updates)
  })

  on('chat:animation', ({ conversationId, animation }) => {
    const stores = getStores()
    stores.chat.triggerAnimation(conversationId, animation)
  })

  on('chat:mam-loading', ({ conversationId, isLoading }) => {
    const stores = getStores()
    stores.chat.setMAMLoading(conversationId, isLoading)
  })

  on('chat:mam-error', ({ conversationId, error }) => {
    const stores = getStores()
    stores.chat.setMAMError(conversationId, error)
  })

  on('chat:mam-messages', ({ conversationId, messages, rsm, complete, direction }) => {
    const stores = getStores()
    stores.chat.mergeMAMMessages(conversationId, messages, rsm, complete, direction)
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

  on('room:occupant-avatar', ({ roomJid, nick, avatar, avatarHash }) => {
    const stores = getStores()
    stores.room.updateOccupantAvatar(roomJid, nick, avatar, avatarHash)
  })

  on('room:self-occupant', ({ roomJid, occupant }) => {
    const stores = getStores()
    stores.room.setSelfOccupant(roomJid, occupant)
  })

  on('room:message', ({ roomJid, message, incrementUnread, incrementMentions }) => {
    const stores = getStores()
    stores.room.addMessage(roomJid, message, { incrementUnread, incrementMentions })
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

  on('room:animation', ({ roomJid, animation }) => {
    const stores = getStores()
    stores.room.triggerAnimation(roomJid, animation)
  })

  on('room:mam-loading', ({ roomJid, isLoading }) => {
    const stores = getStores()
    stores.room.setRoomMAMLoading(roomJid, isLoading)
  })

  on('room:mam-error', ({ roomJid, error }) => {
    const stores = getStores()
    stores.room.setRoomMAMError(roomJid, error)
  })

  on('room:mam-messages', ({ roomJid, messages, rsm, complete, direction }) => {
    const stores = getStores()
    stores.room.mergeRoomMAMMessages(roomJid, messages, rsm, complete, direction)
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

  on('admin:entity-counts', ({ counts }) => {
    const stores = getStores()
    stores.admin.setEntityCounts(counts)
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

  on('admin:muc-service-mam', ({ supportsMAM }) => {
    const stores = getStores()
    stores.admin.setMucServiceSupportsMAM(supportsMAM)
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

  // Return cleanup function
  return () => {
    for (const unsub of unsubscribers) {
      unsub()
    }
    unsubscribers.length = 0
  }
}
