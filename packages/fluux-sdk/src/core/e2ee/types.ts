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
  /** Optional peer identity fingerprint discovered during the probe. */
  fingerprint?: string
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
   * Trust level assigned to this message by the plugin.
   * `verified`    — fingerprint confirmed out-of-band by the local user.
   * `introduced`  — a verified contact has signed this peer's key (web-of-trust hint; not first-person verified).
   * `tofu`        — key seen before and accepted via Trust-On-First-Use; no explicit verification.
   * `untrusted`   — key is new, has changed, or decryption failed.
   * `rejected`    — signature verification failed or absent; message integrity not confirmed.
   */
  trust: 'verified' | 'introduced' | 'tofu' | 'untrusted' | 'rejected'
  /** Optional free-form notes (e.g. "subkey 3 days old"). */
  notes?: string[]
}

export interface DecryptResult {
  plaintext: Uint8Array
  senderDevice: DeviceIdentifier
  securityContext: SecurityContext
  /**
   * Sender-attested composition time recovered from inside the encrypted
   * envelope. When set, it supersedes the stanza-level `<delay/>` and local
   * arrival time for display and ordering: those are set by intermediaries
   * (server, relay, MAM) and can be tampered with, while this value was
   * signed by the sender as part of the ciphertext.
   *
   * Optional because not every E2EE protocol carries an in-envelope
   * timestamp (XEP-0373 §4.1 does via `<time stamp='…'/>`; OMEMO 1 does
   * not). Plugins without one omit the field; the SDK falls back to
   * `<delay/>` or arrival time as before.
   */
  authoredAt?: Date
}

/**
 * Optional context handed to {@link E2EEPlugin.decrypt} alongside the
 * payload. Populated by the SDK when the inbound message has identity
 * fields that the plugin may need for protocol-level features (e.g.
 * stashing a not-yet-verifiable signature for later re-checking).
 *
 * Plugins that don't need any of these fields can ignore the parameter.
 */
export interface InboundDecryptContext {
  /**
   * Stanza-level message id (`<message id="...">`). Plugins that buffer
   * decrypts for later re-verification key their entries on this so the
   * upgrade event can patch the right rendered message.
   */
  messageId?: string
  /**
   * `true` when this stanza is one of our own outgoing messages being
   * delivered back to us — XEP-0280 sent carbons on a sibling device, or
   * a XEP-0313 MAM self-outgoing replay. Encrypt-to-self makes the
   * ciphertext openable, but the conventional inbound checks (peer-key
   * signature verification, addressees-contain-self reflection defence)
   * are inverted: the signer is us, and the envelope `<to/>` names the
   * conversation peer rather than us. Plugins that ship those defences
   * (OpenPGP, OMEMO) must branch on this flag.
   */
  isSelfOutgoing?: boolean
  /**
   * `true` when this stanza was replayed from the XEP-0313 MAM archive
   * or is being re-decrypted by {@link XMPPClient.retryPendingDecrypts}.
   * Plugins should relax time-based anti-replay checks (e.g. signcrypt
   * timestamp skew) for archived messages, since they may be arbitrarily
   * old yet still authentic.
   */
  fromArchive?: boolean
}

/**
 * Where an inbound encrypted stanza came from. The distinction matters for
 * stateful-ratchet protocols (OMEMO, MLS) that must NOT consume
 * forward-only key material when replaying MAM history: archived messages
 * should be decrypted against a frozen side-channel, not the live session
 * state. Stateless protocols (OpenPGP) can treat both sources identically.
 *
 * - `live`    — the stanza just arrived from the server (or from a carbon).
 * - `archive` — the stanza was retrieved via XEP-0313 MAM replay.
 */
export type InboundSource = 'live' | 'archive'

/**
 * Notification a plugin emits after re-evaluating a previously-delivered
 * message — typically when a sender's key arrived after the message had
 * already been surfaced as `untrusted`. The host re-publishes this to
 * downstream consumers so the UI re-renders the affected message with
 * the upgraded trust state.
 */
export interface SecurityContextUpdate {
  /** Bare JID of the conversation peer. */
  peer: BareJID
  /** Stanza-level message id of the message whose context changed. */
  messageId: string
  securityContext: SecurityContext
}

/**
 * Trust state for a peer or one of their devices.
 * `verified`   — fingerprint confirmed out-of-band by the local user.
 * `introduced` — a verified contact signed this peer's key (web-of-trust hint).
 * `tofu`       — key accepted via Trust-On-First-Use; not explicitly verified.
 * `untrusted`  — key is new, has changed, or failed verification.
 * `unknown`    — no trust record stored yet.
 */
export type TrustState = 'verified' | 'introduced' | 'tofu' | 'untrusted' | 'unknown'

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
  /**
   * Delete one of our own PEP nodes (XEP-0060 §8.2).
   *
   * Needed to recover from `precondition-not-met` on publish: if the node
   * persists with an accessModel we can no longer match, re-publishing is
   * impossible without tearing the node down and recreating it. Plugins
   * use this as a last-resort self-heal — they should catch the publish
   * error, delete, then retry the publish.
   */
  deletePEP(node: string): Promise<void>
  /**
   * Fetch items from a remote PEP node. `maxItems` maps to PubSub's
   * `max_items` attribute and lets callers request only the latest item.
   */
  queryPEP(jid: BareJID, node: string, maxItems?: number): Promise<PEPItem[]>
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
  /**
   * Plugin-driven channel for telling the host that a previously-delivered
   * message's security context has changed (e.g. signature verified after a
   * peer's key arrived). The host re-publishes this through its SDK event
   * surface so any UI bound to the message re-renders. Wired by
   * {@link E2EEManager} when it constructs the context; plugins must NOT
   * call it during a `decrypt` call (that path returns a fresh
   * {@link SecurityContext} via {@link DecryptResult} instead).
   */
  reportSecurityContextUpdate(update: SecurityContextUpdate): void
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
  /**
   * Decrypt a live encrypted payload. `context` carries optional
   * message-level metadata the plugin may need (e.g. the stanza
   * message-id, used to key deferred re-verification entries).
   *
   * A plugin with forward-secure session state (OMEMO, MLS) must advance
   * that state here — this is the "live" path. Archived messages
   * retrieved via MAM take the {@link E2EEPlugin.decryptArchive} path
   * instead so replay can't consume forward-only key material.
   */
  decrypt(
    handle: ConversationHandle,
    payload: EncryptedPayload,
    context?: InboundDecryptContext,
  ): Promise<DecryptResult>

  /**
   * Optional: decrypt a message pulled from XEP-0313 MAM history without
   * advancing the live session state.
   *
   * Ratcheting protocols (OMEMO, MLS) must not consume forward-only key
   * material on replay — a single ratchet step consumed during archive
   * catch-up would break decryption of the in-flight live message with
   * the same counter. Plugins that have such state should implement this
   * hook to decrypt against archived/session keys only.
   *
   * Stateless protocols (e.g. OpenPGP / XEP-0373) have no forward
   * secrecy to protect and may omit this method entirely; the host falls
   * back to {@link E2EEPlugin.decrypt} for archive decryption in that
   * case, which is semantically equivalent.
   */
  decryptArchive?(
    handle: ConversationHandle,
    payload: EncryptedPayload,
    context?: InboundDecryptContext,
  ): Promise<DecryptResult>

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

  /**
   * Optional: rotate the encryption material while preserving identity.
   *
   * The primary key / verified fingerprint stays the same — peers who
   * already trust this identity do not need to re-verify. Only the key
   * used to encrypt to the account changes. Superseded material is
   * retained locally so history remains decryptable.
   *
   * Not every protocol supports this shape: some cycle the whole
   * identity on rotation, others have no stable identity at all. Plugins
   * that implement this MUST preserve {@link IdentityInfo.fingerprint}
   * across rotations.
   */
  rotateEncryptionKey?(): Promise<IdentityInfo>
}
