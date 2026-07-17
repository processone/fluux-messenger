/**
 * Single source of truth for the store methods exposed through {@link StoreBindings}.
 *
 * Each list enumerates the methods of one Zustand store that are passed
 * through to XMPPClient verbatim. Three artifacts are derived from it:
 *
 * - the `StoreBindings` interface (`Pick<State, key>` in types/client.ts)
 * - `createDefaultStoreBindings()` (late-bound delegation to the global store)
 * - `createMockStores()` (a `vi.fn()` per key in test-utils)
 *
 * Adding a store method to the client surface = add it to the store, then add
 * its name here. The `satisfies` clauses reject typos at compile time, and
 * storeBindingKeys.test.ts keeps the three artifacts in lockstep.
 *
 * NOT listed here: presence-machine bridge members (they come from
 * PresenceOptions, not a store), plain state getters (`getStatus`,
 * `getJid`, …), and composite getters with real logic
 * (`getAllConversations`, `getRoomGapStart`, …) — those stay handwritten
 * in defaultStoreBindings.ts.
 *
 * @packageDocumentation
 * @module Core
 */

import type {
  ConnectionState,
  ChatState,
  RosterState,
  ConsoleState,
  EventsState,
  RoomState,
  AdminState,
  BlockingState,
} from '../stores'

export const connectionBindingMethodKeys = [
  'setStatus',
  'setIsVerifying',
  'setJid',
  'setError',
  'setReconnectState',
  'setServerInfo',
  'setConnectionMethod',
  'setAuthMechanism',
  'setAuthMethod',
  // Own profile state
  'setOwnAvatar',
  'setOwnNickname',
  'setOwnVCard',
  'updateOwnResource',
  'removeOwnResource',
  'clearOwnResources',
  // HTTP Upload (XEP-0363)
  'setHttpUploadService',
  // Web Push (p1:push)
  'setWebPushStatus',
  'setWebPushServices',
] as const satisfies readonly (keyof ConnectionState)[]

export const chatBindingMethodKeys = [
  'addMessage',
  'addConversation',
  'updateConversationName',
  'hasConversation',
  'setTyping',
  'updateReactions',
  'updateMessage',
  'removeMessage',
  'recomputeUnreadForConversation',
  'getMessage',
  'triggerAnimation',
  // XEP-0313: MAM support
  'setMAMLoading',
  'setMAMError',
  'mergeMAMMessages',
  'getMAMQueryState',
  'resetMAMStates',
  'getConversationCoverage',
  'clearConversationCoverage',
  'updateLastMessagePreview',
  'refreshLastMessageContent',
  'loadMessagesFromCache',
  'getConversationLastTimestamp',
  'archiveConversation',
  'unarchiveConversation',
  'mergeServerConversations',
] as const satisfies readonly (keyof ChatState)[]

export const rosterBindingMethodKeys = [
  'setContacts',
  'addOrUpdateContact',
  'updateContact',
  'updatePresence',
  'removePresence',
  'setPresenceError',
  'updateAvatar',
  'removeContact',
  'hasContact',
  'getContact',
  'getOfflineContacts',
  'sortedContacts',
  'resetAllPresence',
] as const satisfies readonly (keyof RosterState)[]

export const consoleBindingMethodKeys = [
  'addPacket',
  'addEvent',
] as const satisfies readonly (keyof ConsoleState)[]

export const eventsBindingMethodKeys = [
  'addSubscriptionRequest',
  'removeSubscriptionRequest',
  'addStrangerMessage',
  'removeStrangerMessages',
  'addMucInvitation',
  'removeMucInvitation',
  'addSystemNotification',
  'clearSystemNotifications',
] as const satisfies readonly (keyof EventsState)[]

export const roomBindingMethodKeys = [
  'addRoom',
  'updateRoom',
  'removeRoom',
  'setRoomJoined',
  'addOccupant',
  'batchAddOccupants',
  'removeOccupant',
  'setSelfOccupant',
  'updateOccupantAvatars',
  'getRoom',
  'addMessage',
  'updateReactions',
  'updateMessage',
  'getMessage',
  'markAsRead',
  'getActiveRoomJid',
  'setTyping',
  'setBookmark',
  'removeBookmark',
  'isNonAnonymousRoomAcknowledged',
  'setNotifyAll',
  'joinedRooms',
  'getRoomLastTimestamp',
  'triggerAnimation',
  // XEP-0313: MAM support for MUC rooms
  'setRoomMAMLoading',
  'setRoomMAMError',
  'mergeRoomMAMMessages',
  'getRoomMAMQueryState',
  'resetRoomMAMStates',
  'getRoomCoverage',
  'clearRoomCoverage',
  'markAllRoomsNotJoined',
  'updateLastMessagePreview',
  'loadMessagesFromCache',
  'loadPreviewFromCache',
  'hydratePreviewsFromCache',
  'mergeRoomMembers',
  'updateMemberAffiliation',
] as const satisfies readonly (keyof RoomState)[]

export const adminBindingMethodKeys = [
  'setIsAdmin',
  'setCommands',
  'setCurrentSession',
  'setIsDiscovering',
  'setIsExecuting',
  'setMucServiceJid',
  'setServerStats',
  'setVhosts',
  'setSelectedVhost',
  'reset',
] as const satisfies readonly (keyof AdminState)[]

export const blockingBindingMethodKeys = [
  'setBlocklist',
  'addBlockedJids',
  'removeBlockedJids',
  'clearBlocklist',
  'isBlocked',
  'getBlockedJids',
] as const satisfies readonly (keyof BlockingState)[]
