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

import { defaultStores, type SDKStores } from '../stores'
import type { StoreBindings } from './types/client'
import {
  connectionBindingMethodKeys,
  chatBindingMethodKeys,
  rosterBindingMethodKeys,
  consoleBindingMethodKeys,
  eventsBindingMethodKeys,
  roomBindingMethodKeys,
  adminBindingMethodKeys,
  blockingBindingMethodKeys,
} from './storeBindingKeys'

/**
 * Bind the listed store methods as late-bound delegates: each call reads the
 * CURRENT store state, so bindings stay valid across store resets. The key
 * lists live in storeBindingKeys.ts (single source of truth shared with the
 * StoreBindings interface and the test mock).
 */
function bindStoreMethods<S, K extends keyof S>(
  store: { getState(): S },
  keys: readonly K[]
): Pick<S, K> {
  const bound = {} as Record<K, unknown>
  for (const key of keys) {
    bound[key] = (...args: unknown[]) =>
      (store.getState()[key] as (...a: unknown[]) => unknown)(...args)
  }
  return bound as Pick<S, K>
}

/**
 * Create default StoreBindings using the global Zustand stores.
 *
 * This is the standard way to create store bindings for XMPPClient. Presence
 * is no longer part of the store bindings — it is a separate PresenceReader
 * dependency (see `presenceReader.ts`), since presence is machine state, not
 * connection-store state.
 *
 * @param stores - The store bundle to bind. Defaults to the process-wide
 *   {@link defaultStores} singletons; an injected bundle is the store-injection
 *   seam (see `sdkStores.ts`).
 * @returns StoreBindings object for XMPPClient
 *
 * @example
 * ```typescript
 * const client = new XMPPClient()
 * // Uses createDefaultStoreBindings() internally
 * ```
 */
export function createDefaultStoreBindings(stores: SDKStores = defaultStores): StoreBindings {
  const {
    connection: connectionStore,
    chat: chatStore,
    roster: rosterStore,
    console: consoleStore,
    events: eventsStore,
    room: roomStore,
    admin: adminStore,
    blocking: blockingStore,
  } = stores
  return {
    connection: {
      ...bindStoreMethods(connectionStore, connectionBindingMethodKeys),
      // State getters
      getStatus: () => connectionStore.getState().status,
      getOwnNickname: () => connectionStore.getState().ownNickname,
      getJid: () => connectionStore.getState().jid,
      getHttpUploadService: () => connectionStore.getState().httpUploadService,
      getWebPushServices: () => connectionStore.getState().webPushServices,
      getWebPushEnabled: () => connectionStore.getState().webPushEnabled,
      getServerInfo: () => connectionStore.getState().serverInfo,
    },
    chat: {
      ...bindStoreMethods(chatStore, chatBindingMethodKeys),
      // Composite getters
      getAllConversations: () => {
        const state = chatStore.getState()
        // Use activeConversations() which efficiently returns only non-archived
        return state.activeConversations().map(conv => ({
          id: conv.id,
          messages: state.messages.get(conv.id) || [],
        }))
      },
      getConversationGapStart: (conversationId: string) => chatStore.getState().conversationGaps.get(conversationId)?.start,
      getConversationPendingStanzaId: (conversationId: string) => chatStore.getState().conversationMeta.get(conversationId)?.pendingRemoteDisplayedStanzaId,
      getArchivedConversations: () => {
        const state = chatStore.getState()
        const result = []
        for (const id of state.archivedConversations) {
          const conv = state.conversations.get(id)
          if (conv) {
            result.push({ id: conv.id, messages: state.messages.get(conv.id) || [] })
          }
        }
        return result
      },
      getLastMessage: (conversationId: string) => {
        const meta = chatStore.getState().conversationMeta.get(conversationId)
        return meta?.lastMessage
      },
      getAllStoredMessages: () =>
        Array.from(chatStore.getState().messages, ([id, messages]) => ({ id, messages })),
      getConversationMessages: (conversationId: string) =>
        chatStore.getState().messages.get(conversationId) ?? [],
    },
    roster: bindStoreMethods(rosterStore, rosterBindingMethodKeys),
    console: bindStoreMethods(consoleStore, consoleBindingMethodKeys),
    events: bindStoreMethods(eventsStore, eventsBindingMethodKeys),
    room: {
      ...bindStoreMethods(roomStore, roomBindingMethodKeys),
      // Composite getter
      getRoomGapStart: (roomJid: string) => roomStore.getState().roomGaps.get(roomJid)?.start,
      getRoomPendingStanzaId: (roomJid: string) => roomStore.getState().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId,
      getAllRoomMessages: () =>
        Array.from(roomStore.getState().roomRuntime, ([jid, runtime]) => ({ jid, messages: runtime.messages })),
    },
    admin: {
      ...bindStoreMethods(adminStore, adminBindingMethodKeys),
      // State getters
      getCommands: () => adminStore.getState().commands,
      getCurrentSession: () => adminStore.getState().currentSession,
      getMucServiceJid: () => adminStore.getState().mucServiceJid,
      get selectedVhost() { return adminStore.getState().selectedVhost },
    },
    blocking: bindStoreMethods(blockingStore, blockingBindingMethodKeys),
  }
}
