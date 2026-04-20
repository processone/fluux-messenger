/**
 * E2EE plugin architecture — public SDK surface.
 *
 * Consumers register {@link E2EEPlugin} implementations with an
 * {@link E2EEManager}; the manager handles strategy selection and dispatch.
 * See `private/E2EE_PLUGIN_ARCHITECTURE.md` (internal) for the full design.
 */

export type {
  AccountInfo,
  BareJID,
  ConversationHandle,
  ConversationTarget,
  DecryptResult,
  DeviceIdentifier,
  DiscoFeature,
  DiscoResult,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  IdentityInfo,
  Logger,
  PEPItem,
  PeerSupport,
  PluginContext,
  PluginStorage,
  ProtocolFeatures,
  SecurityContext,
  Subscription,
  TrustState,
  VerificationFlow,
  VerificationMethod,
  XMLElementData,
  XMPPPrimitives,
} from './types'

export { CapabilityCache, type CapabilityCacheOptions } from './CapabilityCache'
export {
  InMemoryStorageBackend,
  createPluginStorage,
  type StorageBackend,
} from './PluginStorage'
export { E2EEManager, type E2EEManagerOptions, type PinnedStrategy } from './E2EEManager'
export { DummyPlaintextPlugin } from './DummyPlaintextPlugin'
