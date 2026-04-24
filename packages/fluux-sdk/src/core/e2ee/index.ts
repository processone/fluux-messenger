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
  InboundDecryptContext,
  Logger,
  PEPItem,
  PeerSupport,
  PluginContext,
  PluginStorage,
  ProtocolFeatures,
  SecurityContext,
  SecurityContextUpdate,
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
export {
  E2EEManager,
  E2EEEncryptionRequiredError,
  type E2EEManagerOptions,
  type E2EESendPolicy,
  type PinnedStrategy,
  type SecurityContextUpdateListener,
} from './E2EEManager'
// DummyPlaintextPlugin is intentionally not re-exported here — see its file
// for the rationale. Tests import it via relative path.
