// Core XMPP client for advanced usage
export { XMPPClient } from './XMPPClient'

// Default store bindings for headless usage
export { createDefaultStoreBindings } from './defaultStoreBindings'
export type { DefaultStoreBindingsOptions } from './defaultStoreBindings'

// Re-export xml builder from @xmpp/client for raw stanza construction
export { xml } from '@xmpp/client'
export type { Element } from '@xmpp/client'

// Types
export type {
  ConnectOptions,
  XMPPClientConfig,
  XMPPClientEvents,
  StoreBindings,
  PresenceOptions,
  ConnectionStatus,
  ConnectionMethod,
  Message,
  ConversationEntity,
  ConversationMetadata,
  Conversation,
  Contact,
  PresenceStatus,
  XmppPacket,
  ChatStateNotification,
  FileAttachment,
  ThumbnailInfo,
  MAMQueryState,
  RSMResponse,
  // Room types (separated for fine-grained subscriptions)
  Room,
  RoomEntity,
  RoomMetadata,
  RoomRuntime,
  // Storage types
  StorageAdapter,
  SessionState,
  StoredCredentials,
} from './types'

// Store-based side effects (auto-load, MAM fetch, etc.)
export {
  setupStoreSideEffects,
  setupChatSideEffects,
  setupRoomSideEffects,
} from './sideEffects'
export type { SideEffectsOptions } from './sideEffects'
