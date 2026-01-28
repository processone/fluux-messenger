/**
 * Default store bindings using global Zustand stores.
 *
 * This module provides the default StoreBindings implementation using
 * the SDK's global Zustand stores. This is used by XMPPClient when
 * no custom stores are provided.
 *
 * @packageDocumentation
 * @module Core
 */

import {
  connectionStore,
  chatStore,
  rosterStore,
  consoleStore,
  eventsStore,
  roomStore,
  adminStore,
  blockingStore,
} from '../stores'
import type { StoreBindings, PresenceOptions } from './types/client'

/**
 * Options for creating default store bindings.
 */
export type DefaultStoreBindingsOptions = PresenceOptions

/**
 * Create default StoreBindings using the global Zustand stores.
 *
 * This is the standard way to create store bindings for XMPPClient.
 * The presence getters/setters are optional - if not provided, they
 * return defaults (useful for headless bots that don't need presence state machine).
 *
 * @param options - Optional presence getters/setters from PresenceOptions
 * @returns StoreBindings object for XMPPClient
 *
 * @example Bot usage (no presence machine)
 * ```typescript
 * const client = new XMPPClient()
 * // Uses createDefaultStoreBindings() internally with default presence
 * ```
 *
 * @example React app with XState presence machine
 * ```typescript
 * const presenceActor = createActor(presenceMachine).start()
 * const client = new XMPPClient({
 *   presenceOptions: {
 *     getPresenceShow: () => getPresenceStatusFromState(presenceActor.getSnapshot().value),
 *     setPresenceState: (show, msg) => presenceActor.send({ type: 'SET_PRESENCE', show, status: msg }),
 *     // ...
 *   },
 * })
 * ```
 */
export function createDefaultStoreBindings(options: DefaultStoreBindingsOptions = {}): StoreBindings {
  // Extract presence options with defaults for headless usage
  const getPresenceShow = options.getPresenceShow ?? (() => 'online' as const)
  const getStatusMessage = options.getStatusMessage ?? (() => null)
  const getIsAutoAway = options.getIsAutoAway ?? (() => false)
  const getPreAutoAwayState = options.getPreAutoAwayState ?? (() => null)
  const getPreAutoAwayStatusMessage = options.getPreAutoAwayStatusMessage ?? (() => null)
  const setPresenceState = options.setPresenceState ?? (() => {})
  const setAutoAway = options.setAutoAway ?? (() => {})
  const clearPreAutoAwayState = options.clearPreAutoAwayState ?? (() => {})

  return {
    connection: {
      setStatus: connectionStore.getState().setStatus,
      getStatus: () => connectionStore.getState().status,
      setJid: connectionStore.getState().setJid,
      setError: connectionStore.getState().setError,
      setReconnectState: connectionStore.getState().setReconnectState,
      setServerInfo: connectionStore.getState().setServerInfo,
      // Presence from external machine (or defaults for headless)
      getPresenceShow,
      getStatusMessage,
      getIsAutoAway,
      getPreAutoAwayState,
      getPreAutoAwayStatusMessage,
      setPresenceState,
      setAutoAway,
      clearPreAutoAwayState,
      // Own profile state
      setOwnAvatar: connectionStore.getState().setOwnAvatar,
      setOwnNickname: connectionStore.getState().setOwnNickname,
      getOwnNickname: () => connectionStore.getState().ownNickname,
      updateOwnResource: connectionStore.getState().updateOwnResource,
      removeOwnResource: connectionStore.getState().removeOwnResource,
      clearOwnResources: connectionStore.getState().clearOwnResources,
      getJid: () => connectionStore.getState().jid,
      // HTTP Upload (XEP-0363)
      setHttpUploadService: connectionStore.getState().setHttpUploadService,
      getHttpUploadService: () => connectionStore.getState().httpUploadService,
      // Server info getter
      getServerInfo: () => connectionStore.getState().serverInfo,
    },
    chat: {
      addMessage: chatStore.getState().addMessage,
      addConversation: chatStore.getState().addConversation,
      updateConversationName: chatStore.getState().updateConversationName,
      hasConversation: chatStore.getState().hasConversation,
      setTyping: chatStore.getState().setTyping,
      updateReactions: chatStore.getState().updateReactions,
      updateMessage: chatStore.getState().updateMessage,
      getMessage: chatStore.getState().getMessage,
      triggerAnimation: chatStore.getState().triggerAnimation,
      // XEP-0313: MAM support
      setMAMLoading: chatStore.getState().setMAMLoading,
      setMAMError: chatStore.getState().setMAMError,
      mergeMAMMessages: chatStore.getState().mergeMAMMessages,
      getMAMQueryState: chatStore.getState().getMAMQueryState,
      resetMAMStates: chatStore.getState().resetMAMStates,
      markAllNeedsCatchUp: chatStore.getState().markAllNeedsCatchUp,
      clearNeedsCatchUp: chatStore.getState().clearNeedsCatchUp,
      updateLastMessagePreview: chatStore.getState().updateLastMessagePreview,
      getAllConversations: () => {
        const state = chatStore.getState()
        // Use activeConversations() which efficiently returns only non-archived
        return state.activeConversations().map(conv => ({
          id: conv.id,
          messages: state.messages.get(conv.id) || [],
        }))
      },
    },
    roster: {
      setContacts: rosterStore.getState().setContacts,
      addOrUpdateContact: rosterStore.getState().addOrUpdateContact,
      updateContact: rosterStore.getState().updateContact,
      updatePresence: rosterStore.getState().updatePresence,
      removePresence: rosterStore.getState().removePresence,
      setPresenceError: rosterStore.getState().setPresenceError,
      updateAvatar: rosterStore.getState().updateAvatar,
      removeContact: rosterStore.getState().removeContact,
      hasContact: rosterStore.getState().hasContact,
      getContact: rosterStore.getState().getContact,
      getOfflineContacts: rosterStore.getState().getOfflineContacts,
      sortedContacts: rosterStore.getState().sortedContacts,
      resetAllPresence: rosterStore.getState().resetAllPresence,
    },
    console: {
      addPacket: consoleStore.getState().addPacket,
      addEvent: consoleStore.getState().addEvent,
    },
    events: {
      addSubscriptionRequest: eventsStore.getState().addSubscriptionRequest,
      removeSubscriptionRequest: eventsStore.getState().removeSubscriptionRequest,
      addStrangerMessage: eventsStore.getState().addStrangerMessage,
      removeStrangerMessages: eventsStore.getState().removeStrangerMessages,
      addMucInvitation: eventsStore.getState().addMucInvitation,
      removeMucInvitation: eventsStore.getState().removeMucInvitation,
      addSystemNotification: eventsStore.getState().addSystemNotification,
      clearSystemNotifications: eventsStore.getState().clearSystemNotifications,
    },
    room: {
      addRoom: roomStore.getState().addRoom,
      updateRoom: roomStore.getState().updateRoom,
      removeRoom: roomStore.getState().removeRoom,
      setRoomJoined: roomStore.getState().setRoomJoined,
      addOccupant: roomStore.getState().addOccupant,
      batchAddOccupants: roomStore.getState().batchAddOccupants,
      removeOccupant: roomStore.getState().removeOccupant,
      setSelfOccupant: roomStore.getState().setSelfOccupant,
      getRoom: roomStore.getState().getRoom,
      addMessage: roomStore.getState().addMessage,
      updateReactions: roomStore.getState().updateReactions,
      updateMessage: roomStore.getState().updateMessage,
      getMessage: roomStore.getState().getMessage,
      markAsRead: roomStore.getState().markAsRead,
      getActiveRoomJid: roomStore.getState().getActiveRoomJid,
      setTyping: roomStore.getState().setTyping,
      setBookmark: roomStore.getState().setBookmark,
      removeBookmark: roomStore.getState().removeBookmark,
      setNotifyAll: roomStore.getState().setNotifyAll,
      joinedRooms: roomStore.getState().joinedRooms,
      triggerAnimation: roomStore.getState().triggerAnimation,
      // XEP-0313: MAM support for MUC rooms
      setRoomMAMLoading: roomStore.getState().setRoomMAMLoading,
      setRoomMAMError: roomStore.getState().setRoomMAMError,
      mergeRoomMAMMessages: roomStore.getState().mergeRoomMAMMessages,
      getRoomMAMQueryState: roomStore.getState().getRoomMAMQueryState,
      resetRoomMAMStates: roomStore.getState().resetRoomMAMStates,
      markAllRoomsNeedsCatchUp: roomStore.getState().markAllRoomsNeedsCatchUp,
      clearRoomNeedsCatchUp: roomStore.getState().clearRoomNeedsCatchUp,
      updateLastMessagePreview: roomStore.getState().updateLastMessagePreview,
    },
    admin: {
      setIsAdmin: adminStore.getState().setIsAdmin,
      setCommands: adminStore.getState().setCommands,
      getCommands: () => adminStore.getState().commands,
      setCurrentSession: adminStore.getState().setCurrentSession,
      setIsDiscovering: adminStore.getState().setIsDiscovering,
      setIsExecuting: adminStore.getState().setIsExecuting,
      getCurrentSession: () => adminStore.getState().currentSession,
      setEntityCounts: adminStore.getState().setEntityCounts,
      setMucServiceJid: adminStore.getState().setMucServiceJid,
      getMucServiceJid: () => adminStore.getState().mucServiceJid,
      // Vhost management
      setVhosts: adminStore.getState().setVhosts,
      setSelectedVhost: adminStore.getState().setSelectedVhost,
      get selectedVhost() { return adminStore.getState().selectedVhost },
      reset: adminStore.getState().reset,
    },
    blocking: {
      setBlocklist: blockingStore.getState().setBlocklist,
      addBlockedJids: blockingStore.getState().addBlockedJids,
      removeBlockedJids: blockingStore.getState().removeBlockedJids,
      clearBlocklist: blockingStore.getState().clearBlocklist,
      isBlocked: blockingStore.getState().isBlocked,
      getBlockedJids: blockingStore.getState().getBlockedJids,
    },
  }
}
