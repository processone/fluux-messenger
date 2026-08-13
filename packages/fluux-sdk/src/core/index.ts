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
  RoomMessage,
  SendMessageOptions,
  ReplyTarget,
  AnyMessage,
  MentionReference,
  ReplyInfo,
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

// Redirect the SDK's diagnostics. A bot owns its stdout; without this its own
// output is interleaved with SDK logging and cannot be separated.
export { setLogSink } from './logger'
export type { LogLevel, LogSink } from './logger'

// Narrow an incoming message to the room or the one-to-one shape.
export { isChatMessage, isRoomMessage } from './types'

// JIDs are the address vocabulary of any bot: it answers `message.from`, joins
// a room by JID, and derives its own nickname from its account. Splitting the
// address helpers out of this bundle would leave a bot writing `split('@')`.
export { parseJid, getBareJid, getResource, getLocalPart, getDomain } from './jid'
export type { ParsedJid } from './jid'

// Whether a room message addresses a given nickname. A bot in a MUC answers
// when spoken to, so this is on the path of the first room bot anyone writes.
export { checkForMention } from './mentionDetection'

// XEP-0156: resolve a domain to its WebSocket endpoint. `ConnectOptions.server`
// wants a `wss://` URL rather than a domain, so without this a bot author has
// to know their server's endpoint by heart.
export { discoverWebSocket, discoverXmppEndpoints } from '../utils/websocketDiscovery'
export type { DiscoveryResult } from '../utils/websocketDiscovery'

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
