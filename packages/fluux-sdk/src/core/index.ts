// Core XMPP client for advanced usage
export { XMPPClient } from './XMPPClient'

// Default store bindings for headless usage
export { createDefaultStoreBindings } from './defaultStoreBindings'

// This is the bot/CLI bundle, so it is the one that most has to read as
// "XMPP without the XMPP". The stanza builder and the ltx `Element` type are
// therefore not here either; they live on `@fluux/sdk/xmpp`.

// Client construction options (carries the store bundle, so it lives outside
// the leaf type layer).
export type { XMPPClientConfig } from './clientConfig'

// Types
export type {
  ConnectOptions,
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
  FileEncryption,
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

// Media encryption for XEP-0454-style encrypted file attachments.
// Apps use these to encrypt file bytes locally before HTTP Upload and to
// decrypt inbound ciphertext. See docs/ENCRYPTION.md §Media sharing.
export { encryptFile, decryptFile } from './modules/MediaEncryption'
export type { EncryptedFile } from './modules/MediaEncryption'
export {
  build as buildAesgcmUri,
  parse as parseAesgcmUri,
  isAesgcmUri,
} from './modules/AesgcmUri'
export type { AesgcmUriParts } from './modules/AesgcmUri'

// Store-based side effects (auto-load, MAM fetch, etc.)
export {
  setupStoreSideEffects,
  setupChatSideEffects,
  setupRoomSideEffects,
} from './sideEffects'
export type { SideEffectsOptions } from './sideEffects'
