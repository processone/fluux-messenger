/**
 * The store methods that are passed through to XMPPClient verbatim.
 *
 * Each list names the members of one {@link StoreBindings} namespace that a
 * store implements by simple delegation, so two artifacts can be generated
 * from it instead of hand-written three times:
 *
 * - `createDefaultStoreBindings()` (late-bound delegation to the global store)
 * - `createMockStores()` (a `vi.fn()` per key in test-utils)
 *
 * The `satisfies` clauses check the names against the PORT, not against the
 * store: the contract is `types/storeBindings.ts`, and a store proves it
 * conforms in `stores/storeBindingsConformance.ts`. Adding a method to the
 * client surface therefore means declaring it in the port, implementing it in
 * the store, and adding its name here — the compiler rejects any two of the
 * three without the last.
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

import type { StoreBindings } from './types/storeBindings'

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
  'setOwnProfileDetails',
  'updateOwnResource',
  'removeOwnResource',
  'clearOwnResources',
  // HTTP Upload (XEP-0363)
  'setHttpUploadService',
  // Web Push (p1:push)
  'setWebPushStatus',
  'setWebPushServices',
] as const satisfies readonly (keyof StoreBindings['connection'])[]

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
  'recordPendingRetraction',
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
] as const satisfies readonly (keyof StoreBindings['chat'])[]

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
] as const satisfies readonly (keyof StoreBindings['roster'])[]

export const consoleBindingMethodKeys = [
  'addPacket',
  'addEvent',
] as const satisfies readonly (keyof StoreBindings['console'])[]

export const eventsBindingMethodKeys = [
  'addSubscriptionRequest',
  'removeSubscriptionRequest',
  'addStrangerMessage',
  'removeStrangerMessages',
  'addMucInvitation',
  'removeMucInvitation',
  'addSystemNotification',
  'clearSystemNotifications',
] as const satisfies readonly (keyof StoreBindings['events'])[]

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
  'recordPendingRetraction',
  'getMessage',
  'recomputeUnreadForRoom',
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
] as const satisfies readonly (keyof StoreBindings['room'])[]

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
] as const satisfies readonly (keyof StoreBindings['admin'])[]

export const blockingBindingMethodKeys = [
  'setBlocklist',
  'addBlockedJids',
  'removeBlockedJids',
  'clearBlocklist',
  'isBlocked',
  'getBlockedJids',
] as const satisfies readonly (keyof StoreBindings['blocking'])[]
