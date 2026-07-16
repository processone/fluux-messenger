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
  /**
   * Fingerprint of the key that signed this message, when the protocol exposes
   * one (OpenPGP). The host stashes it onto the message's
   * {@link MessageSecurityContext} so the UI can confirm the verified lock
   * against the ACTUAL signing key — a rotated/substituted key must not inherit
   * a stale out-of-band verification.
   */
  fingerprint?: string
}

/**
 * Outcome discriminant for a decrypt attempt. Stateless protocols (OpenPGP)
 * only ever produce `ok` (or throw); stateful ratcheting protocols (OMEMO,
 * MLS) need the richer set:
 *
 * - `ok`              — plaintext recovered; surface it to the user.
 * - `control-message` — decrypt succeeded and advanced the session, but there
 *                       is no user-visible content (a key-transport / empty
 *                       ratchet-advance message). {@link DecryptResult.plaintext}
 *                       is absent. The host consumes it silently — it must NOT
 *                       synthesize a placeholder body.
 * - `broken-session`  — the session is desynchronized (e.g. a ratchet step was
 *                       missed); decrypt cannot succeed until the session is
 *                       repaired. The host triggers {@link E2EEPlugin.repairSession}
 *                       and surfaces a could-not-decrypt placeholder rather than
 *                       stashing for a plain retry (a retry alone won't fix it).
 * - `unverifiable`    — plaintext was recovered but the sender's identity could
 *                       not be authenticated. {@link DecryptResult.securityContext}
 *                       carries the (untrusted/rejected) trust; the host shows
 *                       the content with the reduced trust state.
 */
export type DecryptStatus = 'ok' | 'control-message' | 'broken-session' | 'unverifiable'

export interface DecryptResult {
  /**
   * Recovered plaintext bytes. Optional because ratcheting protocols emit
   * control / key-transport messages that advance session state but carry no
   * user-visible body — see {@link DecryptStatus} `control-message`. When
   * `status` is `ok` (or omitted) this MUST be present; for `control-message`
   * and `broken-session` it is absent.
   */
  plaintext?: Uint8Array
  /**
   * What kind of result this is. Omitted is equivalent to `'ok'` so existing
   * stateless plugins (OpenPGP, the dummy plugin) need no change — they return
   * `plaintext` and the host treats it as a normal decrypt.
   */
  status?: DecryptStatus
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
   * `true` when this stanza was replayed from the XEP-0313 MAM archive.
   * Plugins should relax time-based anti-replay checks (e.g. signcrypt
   * timestamp skew) for archived messages — they are authentically old.
   * When set, {@link archiveTimestamp} carries the `<delay/>` stamp so
   * plugins can still validate relative freshness.
   */
  fromArchive?: boolean
  /**
   * XEP-0203 `<delay/>` timestamp from the MAM `<forwarded/>` wrapper.
   * Only meaningful when {@link fromArchive} is `true`. Plugins should
   * validate the signcrypt `<time/>` against this value (± tolerance)
   * rather than against `now()` — this preserves temporal integrity
   * without rejecting legitimately old archived messages.
   */
  archiveTimestamp?: Date
  /**
   * `true` when this stanza is being re-decrypted by
   * {@link XMPPClient.retryPendingDecrypts}. Unlike {@link fromArchive},
   * retried messages were originally live-delivered and SHOULD be subject
   * to the normal timestamp skew check against their original reception
   * time. The skew check is simply skipped for retries because the
   * envelope `<time/>` was already validated on first delivery — only the
   * signature is pending.
   */
  fromRetry?: boolean
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
 * One archived message to decrypt as part of a batch — see
 * {@link E2EEPlugin.decryptArchiveBatch}. Bundles the extracted payload with
 * its optional per-message context (stanza id, archive timestamp) so a
 * ratcheting plugin can decrypt a whole MAM page against frozen session state
 * in a single call instead of re-deriving state once per message.
 */
export interface ArchiveDecryptItem {
  payload: EncryptedPayload
  context?: InboundDecryptContext
}

/**
 * Admin-tunable, plugin-internal settings forwarded verbatim through
 * {@link E2EEPlugin.configure}. The host does not interpret the contents —
 * each plugin documents and validates its own keys (e.g. signed-prekey
 * rotation cadence, stale-device policy, device-list refresh interval). Opaque
 * by design so the host needs no knowledge of any protocol's options.
 */
export type PluginConfiguration = Record<string, unknown>

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
  /** When set, replaces the stored message body (e.g. to expunge a
   *  plaintext that was delivered before the signature was rejected). */
  body?: string
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

/**
 * One trustable identity of a peer, protocol-agnostic. OMEMO maps each of a
 * peer's DEVICES to a `PeerIdentity` (`id` = device id string); a future
 * OpenPGP plugin maps its single key to a length-1 list. The host renders a
 * uniform per-identity list from `listPeerIdentities`, feature-detecting the
 * optional trait methods below.
 */
export interface PeerIdentity {
  /** Stable identity id within the protocol (OMEMO: the device id, as a string). */
  id: string
  /** Hex fingerprint/safety-number for out-of-band comparison; `''` if no key is known yet. */
  fingerprint: string
  /** Resolved trust for this identity. */
  trust: TrustState
}

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

  /**
   * Plugin-driven channel for telling the host that the local private key
   * has just become usable through a user action — passphrase entered,
   * server backup restored, key file imported, or identity replaced. The
   * host re-runs every pending deferred decrypt (see
   * {@link XMPPClient.retryPendingDecrypts}) so messages that arrived while
   * the key was locked or absent are decrypted immediately, without each UI
   * restore site having to remember to call
   * {@link XMPPClient.notifyE2EEKeyUnlocked} (one such site being missed is
   * exactly how restored messages stayed "could not be decrypted").
   *
   * Wired by {@link E2EEManager} at {@link E2EEManager.register} time;
   * optional so hand-rolled hosts and tests may omit it — plugins invoke it
   * defensively as `ctx.notifyKeyUnlocked?.()`. Plugins MUST NOT call it from
   * `init`'s passive key load: registration already triggers a retry via the
   * plugin-registered event, so firing here too would be redundant.
   */
  notifyKeyUnlocked?(): void
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

  /**
   * Optional: decrypt a whole page of archived messages in one call.
   *
   * MAM catch-up replays many messages at once. Calling
   * {@link E2EEPlugin.decryptArchive} once per message forces a ratcheting
   * plugin to load and re-freeze its session state on every message; a batch
   * lets it freeze once and walk the page. The returned array MUST be aligned
   * to `items` by index — element `i` is the result for `items[i]`. A plugin
   * that cannot decrypt a particular item should still occupy its slot (e.g.
   * with a `broken-session` / `unverifiable` {@link DecryptResult}) rather than
   * shifting later results.
   *
   * Plugins without batch needs omit this — the host falls back to looping
   * {@link E2EEPlugin.decryptArchive} (then {@link E2EEPlugin.decrypt}), which
   * is semantically identical for stateless protocols.
   */
  decryptArchiveBatch?(handle: ConversationHandle, items: ArchiveDecryptItem[]): Promise<DecryptResult[]>

  /**
   * Optional: rebuild a desynchronized session with `peer`.
   *
   * Ratcheting protocols can lose session sync (a dropped message, a device
   * reset, key material that no longer lines up). When {@link E2EEPlugin.decrypt}
   * reports {@link DecryptStatus} `broken-session`, the host calls this to let
   * the plugin re-handshake — typically by discarding the broken session and
   * sending an empty/key-transport message to re-establish the ratchet. The
   * call should be idempotent and safe to invoke repeatedly. Stateless
   * protocols (OpenPGP) have no session to repair and omit this.
   */
  repairSession?(handle: ConversationHandle, peer: BareJID): Promise<void>

  /**
   * Optional: apply admin-tunable, plugin-internal settings.
   *
   * The host forwards {@link PluginConfiguration} verbatim without interpreting
   * it (e.g. signed-prekey rotation cadence, stale-device ignoring,
   * device-list refresh policy). Plugins validate their own keys and ignore
   * unknown ones. Safe to call more than once; later calls supersede earlier
   * ones. Plugins with no tunables omit this.
   */
  configure?(options: PluginConfiguration): Promise<void>

  /** List verification methods this protocol supports (may be empty). */
  getVerificationMethods(): VerificationMethod[]
  startVerification(peer: BareJID, method: VerificationMethod): Promise<VerificationFlow>
  getPeerTrust(peer: BareJID): Promise<TrustState>
  getDeviceTrust(peer: BareJID, deviceId: string): Promise<TrustState>

  /**
   * Optional: enumerate a peer's trustable identities (OMEMO: one per device)
   * for the per-identity verification UI. Returns `[]` if the peer has none.
   * The host feature-detects (`if (plugin.listPeerIdentities) …`); a plugin
   * that omits it keeps the aggregate-only trust surface.
   */
  listPeerIdentities?(peer: BareJID): Promise<PeerIdentity[]>

  /**
   * Optional: record an explicit trust decision for one identity. `id` is the
   * `PeerIdentity.id` (OMEMO: the device id string). `'verified'` pins the
   * current fingerprint out-of-band; `'untrusted'` revokes/marks it. Both
   * operations are idempotent.
   */
  setIdentityTrust?(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void>

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
