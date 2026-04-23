/**
 * E2EE plugin architecture — public trait and supporting types.
 *
 * The SDK hosts an {@link E2EEManager} that dispatches to registered plugins.
 * Each plugin implements one encryption protocol (OpenPGP, OMEMO, MLS, …).
 * Plugins never know about each other; strategy selection lives in the host.
 *
 * Types here are designed to be JSON-serializable where practical so the same
 * trait can be implemented in TypeScript or fronted by a native runtime
 * (Rust via Tauri commands, WASM).
 */

/** Bare JID (`local@domain`, no resource). */
export type BareJID = string

/** Identifier of a specific device belonging to a JID. Opaque to the host. */
export interface DeviceIdentifier {
  jid: BareJID
  deviceId: string
}

/**
 * Minimal structural form of an XMPP element that is JSON-serializable.
 *
 * Plugins emit this shape; the host converts it into an `@xmpp/client`
 * Element before sending. Using a structural form keeps the trait uniform
 * across TS plugins and native plugins bridged over Tauri.
 */
export interface XMLElementData {
  name: string
  attrs: Record<string, string>
  children: Array<XMLElementData | string>
}

/** Features a plugin can advertise. Used for strategy selection and UI. */
export interface ProtocolFeatures {
  /** Compromise of long-term key does not decrypt old messages (with whatever granularity the plugin provides). */
  forwardSecrecy: boolean
  /** Key compromise can be healed by continued use. */
  postCompromiseSecurity: boolean
  /** Protocol can target multiple recipient devices independently. */
  multiDevice: boolean
  /** Protocol works inside a MUC. */
  groupChat: boolean
  /** Protocol can encrypt for recipients that are currently offline. */
  asynchronous: boolean
  /** Messages are deniable (no non-repudiation signature on plaintext). */
  deniability: boolean
}

/**
 * Static description of a protocol. Used by {@link E2EEManager} to rank
 * mutually-supported plugins and to render UI.
 */
export interface E2EEProtocolDescriptor {
  /** Stable identifier, e.g. `openpgp`, `omemo:2`, `mls`. */
  id: string
  /** Human-readable name. */
  displayName: string
  /**
   * Ranking used to pick among mutually-supported plugins. Higher wins.
   * Indicative values: MLS 90, OMEMO 2 80, OMEMO 1 70, OpenPGP 30.
   */
  securityLevel: number
  features: ProtocolFeatures
}

/** Result of a peer capability probe. Cached by the host with `ttl`. */
export interface PeerSupport {
  supported: boolean
  /** Seconds for which this result may be cached. */
  ttl: number
  /** Optional protocol variant (e.g. `omemo:2` vs `omemo:1`). */
  variant?: string
}

/** Identity material the plugin has ensured exists locally + published. */
export interface IdentityInfo {
  /**
   * Fingerprint of the primary identity, suitable for display.
   * Format is protocol-specific; plugin must document it.
   */
  fingerprint: string
  /** Optional list of this account's device identifiers under this protocol. */
  devices?: DeviceIdentifier[]
}

/** What kind of conversation a plugin is asked to operate on. */
export type ConversationTarget =
  | { kind: 'direct'; peer: BareJID }
  | { kind: 'muc'; room: BareJID; participants: BareJID[] }

/**
 * Opaque handle returned by a plugin from {@link E2EEPlugin.openConversation}.
 * The host passes it back to encrypt/decrypt calls. Contents are plugin-private.
 */
export interface ConversationHandle {
  /** Plugin id that owns this handle. */
  protocolId: string
  /** Plugin-private state; host must not interpret. */
  state: unknown
}

/**
 * Encrypted payload produced by a plugin. The host wraps `stanzaElement`
 * as a child of the outgoing `<message>` stanza.
 */
export interface EncryptedPayload {
  protocolId: string
  /** Full XMPP element the plugin wants inserted into the outgoing stanza. */
  stanzaElement: XMLElementData
  /** Optional user-visible body for clients that cannot decrypt. */
  fallbackBody?: string
}

/** Per-message security context surfaced in the UI. */
export interface SecurityContext {
  protocolId: string
  /**
   * Whether this message is considered trusted based on the plugin's trust model.
   * `verified` — fingerprint explicitly verified.
   * `trusted` — accepted (e.g. BTBV) but not verified.
   * `untrusted` — sender identity not trusted.
   */
  trust: 'verified' | 'trusted' | 'untrusted'
  /** Optional free-form notes (e.g. "subkey 3 days old"). */
  notes?: string[]
}

export interface DecryptResult {
  plaintext: Uint8Array
  senderDevice: DeviceIdentifier
  securityContext: SecurityContext
}

/** Trust state for a peer or one of their devices. */
export type TrustState = 'verified' | 'trusted' | 'untrusted' | 'unknown'

/** A verification flow a plugin supports. */
export interface VerificationMethod {
  id: string
  displayName: string
  /** Short description of what this method does, for UI. */
  description?: string
}

/**
 * In-progress verification. Plugins drive the protocol; the host renders
 * prompts via a `VerificationUIAdapter` (out of scope for this slice).
 */
export interface VerificationFlow {
  method: VerificationMethod
  cancel(): Promise<void>
  /** Resolves when verification completes (accept or reject). */
  result: Promise<TrustState>
}

/**
 * Namespaced key/value storage the host hands to each plugin. Values are
 * opaque bytes; the host does not interpret plugin state.
 */
export interface PluginStorage {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

/**
 * XMPP primitives the host exposes to plugins so they can publish and
 * discover their own material without taking a dependency on internal
 * XMPPClient shape.
 */
export interface PEPItem {
  id: string
  payload: XMLElementData
}

export interface DiscoFeature {
  var: string
}

export interface DiscoResult {
  features: DiscoFeature[]
  identities: Array<{ category: string; type: string; name?: string }>
}

export interface Subscription {
  unsubscribe(): void
}

/**
 * PEP publish options passed through to XEP-0060 `<publish-options/>`.
 * The SDK's `PubSub.publish` supports more fields; we expose only the
 * subset plugins actually need so the interface stays small.
 */
export interface PEPPublishOptions {
  /** `pubsub#access_model` — who may read the node. */
  accessModel?: 'open' | 'whitelist' | 'presence' | 'roster' | 'authorize'
  /** `pubsub#max_items` — cap retained items. `1` produces a current-value node. */
  maxItems?: number
  /** `pubsub#persist_items` — retain across sessions (defaults to server policy). */
  persistItems?: boolean
}

export interface XMPPPrimitives {
  /** Send an already-built outgoing stanza. */
  sendStanza(stanza: XMLElementData): Promise<void>
  /** Disco#info on a JID. */
  queryDisco(jid: BareJID): Promise<DiscoResult>
  /**
   * Publish to our own PEP node.
   *
   * `options` forwards XEP-0060 `<publish-options/>` configuration so a
   * plugin can pin, for example, the secret-key backup node to
   * `accessModel: 'whitelist'` (owner-only). Omitting it keeps the
   * server's defaults.
   */
  publishPEP(node: string, item: PEPItem, options?: PEPPublishOptions): Promise<void>
  /**
   * Retract a previously published item from one of our own PEP nodes.
   * Servers typically tolerate retracting an already-absent item silently;
   * callers should still catch errors to distinguish "already gone" from
   * a genuine failure they want to surface.
   */
  retractPEP(node: string, itemId: string): Promise<void>
  /** Fetch items from a remote PEP node. */
  queryPEP(jid: BareJID, node: string): Promise<PEPItem[]>
  /** Subscribe to PEP notifications from a remote JID for a given node. */
  subscribePEP(jid: BareJID, node: string, cb: (item: PEPItem) => void): Subscription
}

export interface AccountInfo {
  /** Our own bare JID, normalized. */
  jid: BareJID
  /** Stable identifier for this device (if the host has one). */
  deviceLabel?: string
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface PluginContext {
  storage: PluginStorage
  xmpp: XMPPPrimitives
  logger: Logger
  account: AccountInfo
}

/**
 * The E2EE plugin trait. All methods are async to accommodate both pure-TS
 * plugins and ones bridged over Tauri/WASM boundaries.
 */
export interface E2EEPlugin {
  readonly descriptor: E2EEProtocolDescriptor

  /** Called once after registration with the host-provided context. */
  init(ctx: PluginContext): Promise<void>
  /** Called when the plugin is being torn down. Must free resources. */
  shutdown(): Promise<void>

  /**
   * Make sure the account's identity material exists locally and is
   * published on the network. Idempotent — safe to call on every startup.
   */
  ensureIdentity(): Promise<IdentityInfo>

  /**
   * Does `peer` support this protocol? Plugin owns the mechanism (PEP node
   * lookup, disco, etc.). Result is cached by the host using `ttl`.
   */
  probePeer(peer: BareJID): Promise<PeerSupport>

  /** Open a conversation, returning an opaque handle for subsequent calls. */
  openConversation(target: ConversationTarget): Promise<ConversationHandle>
  closeConversation(handle: ConversationHandle): Promise<void>

  /** Encrypt plaintext bytes for the conversation. */
  encrypt(handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload>
  /** Decrypt an encrypted payload. */
  decrypt(handle: ConversationHandle, payload: EncryptedPayload): Promise<DecryptResult>

  /** List verification methods this protocol supports (may be empty). */
  getVerificationMethods(): VerificationMethod[]
  startVerification(peer: BareJID, method: VerificationMethod): Promise<VerificationFlow>
  getPeerTrust(peer: BareJID): Promise<TrustState>
  getDeviceTrust(peer: BareJID, deviceId: string): Promise<TrustState>

  /**
   * If an incoming stanza's encrypted element belongs to this plugin, return
   * the extracted {@link EncryptedPayload}. Otherwise return `null`.
   *
   * The host calls this on every registered plugin, in descending
   * `securityLevel` order, until one claims the stanza.
   */
  tryClaimInbound(stanzaChild: XMLElementData): EncryptedPayload | null

  /**
   * Optional hook: the host noticed (via a PEP headline or an explicit
   * caller) that `peer`'s public key material has changed. The plugin
   * should drop any positive cache it holds so the next probe re-fetches
   * the current key. The capability cache the host owns is invalidated
   * separately — plugins only need to evict their own state here.
   */
  onPeerKeysChanged?(peer: BareJID): void
}
