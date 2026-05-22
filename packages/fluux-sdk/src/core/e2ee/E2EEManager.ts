import { CapabilityCache, type CapabilityCacheOptions } from './CapabilityCache'
import { createPluginStorage, type StorageBackend } from './PluginStorage'
import type {
  AccountInfo,
  BareJID,
  ConversationTarget,
  DecryptResult,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  InboundDecryptContext,
  Logger,
  PluginContext,
  SecurityContextUpdate,
  XMLElementData,
  XMPPPrimitives,
} from './types'

/** Default no-op logger. Replaced via options in production. */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface E2EEManagerOptions {
  storage: StorageBackend
  xmpp: XMPPPrimitives
  account: AccountInfo
  logger?: Logger
  capabilityCache?: CapabilityCacheOptions
}

/** Listener for plugin-driven security-context upgrades. See {@link E2EEManager.onSecurityContextUpdated}. */
export type SecurityContextUpdateListener = (update: SecurityContextUpdate) => void

/**
 * User or admin pin that forces a specific plugin on a conversation.
 * `null` means "no pin — use automatic selection".
 */
export type PinnedStrategy = string | null

/**
 * What the host does when the user tries to send to a conversation for
 * which no plugin is mutually available.
 *
 * - `opportunistic` — silently ship plaintext. Preserves delivery when
 *    the peer has not published keys yet. Appropriate when E2EE is off
 *    globally and a single conversation happens to be encryptable.
 * - `strict` — fail the send with {@link E2EEEncryptionRequiredError}.
 *    The UI is expected to surface the failure and let the user retry
 *    (e.g. after their peer publishes keys) or explicitly send in
 *    plaintext as a one-off. Right default whenever the user has
 *    enabled E2EE in settings.
 */
export type E2EESendPolicy = 'opportunistic' | 'strict'

/**
 * Thrown by {@link E2EEManager.requireEncryption} (and, by extension, by
 * the Chat send path in strict mode) when no plugin can encrypt to the
 * recipient. Callers catch this specifically to decide whether to block
 * the send or fall back to plaintext with explicit user consent.
 */
export class E2EEEncryptionRequiredError extends Error {
  constructor(public readonly target: ConversationTarget) {
    super('E2EE required but no plugin available for this conversation')
    this.name = 'E2EEEncryptionRequiredError'
  }
}

/**
 * Host that owns registered plugins and dispatches encrypt/decrypt to the
 * right one. Plugins do not negotiate among themselves; all selection
 * happens here.
 */
export class E2EEManager {
  private readonly plugins = new Map<string, E2EEPlugin>()
  private readonly pins = new Map<string, PinnedStrategy>()
  private readonly capabilityCache: CapabilityCache
  private storage: StorageBackend
  private readonly xmpp: XMPPPrimitives
  private readonly account: AccountInfo
  private readonly logger: Logger
  private sendPolicy: E2EESendPolicy = 'opportunistic'
  private readonly securityContextListeners = new Set<SecurityContextUpdateListener>()
  private readonly forcedPlaintextConversations = new Set<string>()
  private pluginRegisteredCallback: ((pluginId: string) => void) | null = null
  private peerKeysChangedCallback: ((peer: BareJID) => void) | null = null
  // PEP key-change notifications can race plugin registration: the server
  // bursts headline pushes immediately on stream open, but plugins finish
  // their async init (IndexedDB hydration, key unwrap) seconds later. We
  // queue notifications addressed to a known-but-unregistered plugin id
  // and drain them in register() so the plugin sees them as soon as it
  // comes online — otherwise its in-memory peer-key cache stays empty
  // until something else (encrypt path, conversation open) probes the peer.
  private readonly pendingPeerKeyChanges = new Map<string, Set<BareJID>>()

  constructor(options: E2EEManagerOptions) {
    this.storage = options.storage
    this.xmpp = options.xmpp
    this.account = options.account
    this.logger = options.logger ?? silentLogger
    this.capabilityCache = new CapabilityCache(options.capabilityCache)
  }

  /**
   * Bare JID this manager is bound to. The host uses this to decide
   * whether to rebuild the manager on reconnect (same JID → reuse;
   * different JID → fresh manager for the new identity).
   */
  getAccountJid(): BareJID {
    return this.account.jid
  }

  /**
   * Replace the storage backend. Must be called before any plugins are
   * registered — plugins receive a namespaced view of the backend at
   * {@link register} time and are not affected by later changes.
   *
   * The primary use case is injecting a persistent backend (e.g.
   * IndexedDB on web) after the manager has been constructed but before
   * plugins are wired in.
   */
  setStorage(backend: StorageBackend): void {
    this.storage = backend
  }

  /**
   * Register and initialize a plugin. Calls {@link E2EEPlugin.init} with a
   * context scoped to this manager. Throws if the plugin id is already taken.
   */
  async register(plugin: E2EEPlugin): Promise<void> {
    const id = plugin.descriptor.id
    if (this.plugins.has(id)) {
      throw new Error(`E2EE plugin already registered: ${id}`)
    }
    const ctx: PluginContext = {
      storage: createPluginStorage(this.storage, `e2ee/${id}`),
      xmpp: this.xmpp,
      logger: this.logger,
      account: this.account,
      reportSecurityContextUpdate: (update) => this.dispatchSecurityContextUpdate(update),
    }
    await plugin.init(ctx)
    this.plugins.set(id, plugin)
    this.logger.info(`E2EE plugin registered: ${id}`)
    this.drainPendingPeerKeyChanges(id, plugin)
    this.pluginRegisteredCallback?.(id)
  }

  /**
   * Replay any PEP key-change notifications that arrived before this plugin
   * was registered. Each queued peer triggers a single `onPeerKeysChanged`
   * call; the plugin re-fetches its keys lazily from there.
   */
  private drainPendingPeerKeyChanges(id: string, plugin: E2EEPlugin): void {
    const pending = this.pendingPeerKeyChanges.get(id)
    if (!pending || pending.size === 0) return
    this.pendingPeerKeyChanges.delete(id)
    this.logger.info(
      `E2EE plugin ${id}: draining ${pending.size} queued peer key-change(s)`,
    )
    for (const peer of pending) {
      try {
        plugin.onPeerKeysChanged?.(peer)
      } catch (err) {
        this.logger.warn(`E2EE plugin ${id} onPeerKeysChanged(${peer}) threw`, err)
      }
    }
  }

  /** Shut down and remove a plugin. Safe to call with an unknown id. */
  async unregister(id: string): Promise<void> {
    const plugin = this.plugins.get(id)
    if (!plugin) return
    this.plugins.delete(id)
    await plugin.shutdown()
    this.logger.info(`E2EE plugin unregistered: ${id}`)
  }

  /** Descriptors for every registered plugin, sorted by securityLevel desc. */
  listPlugins(): E2EEProtocolDescriptor[] {
    return [...this.plugins.values()]
      .map((p) => p.descriptor)
      .sort((a, b) => b.securityLevel - a.securityLevel)
  }

  /** Get a specific plugin by id, or `null`. */
  getPlugin(id: string): E2EEPlugin | null {
    return this.plugins.get(id) ?? null
  }

  /** True when at least one plugin is registered. */
  hasPlugins(): boolean {
    return this.plugins.size > 0
  }

  /** Set a callback invoked whenever a plugin is registered. */
  onPluginRegistered(cb: (pluginId: string) => void): void {
    this.pluginRegisteredCallback = cb
  }

  /** Set a callback invoked whenever a peer's key material changes via PEP. */
  onPeerKeysChanged(cb: (peer: BareJID) => void): void {
    this.peerKeysChangedCallback = cb
  }

  /** Force all outbound sends to this target to skip encryption entirely. Inbound decryption is unaffected. */
  setForcedPlaintext(target: ConversationTarget, forced: boolean): void {
    const key = targetKey(target)
    if (forced) this.forcedPlaintextConversations.add(key)
    else this.forcedPlaintextConversations.delete(key)
  }

  /** Returns true if encryption has been explicitly disabled for this target. */
  isForcedPlaintext(target: ConversationTarget): boolean {
    return this.forcedPlaintextConversations.has(targetKey(target))
  }

  /** Pin a conversation to a specific plugin (or clear with `null`). */
  setPinnedStrategy(target: ConversationTarget, pin: PinnedStrategy): void {
    const key = targetKey(target)
    if (pin === null) this.pins.delete(key)
    else this.pins.set(key, pin)
  }

  getPinnedStrategy(target: ConversationTarget): PinnedStrategy {
    return this.pins.get(targetKey(target)) ?? null
  }

  /**
   * Policy for outgoing messages when no plugin is mutually available.
   * See {@link E2EESendPolicy}. Default is `opportunistic` so an
   * E2EE-disabled account behaves the same as before; the host flips
   * this to `strict` when the user opts into E2EE.
   */
  getSendPolicy(): E2EESendPolicy {
    return this.sendPolicy
  }

  setSendPolicy(policy: E2EESendPolicy): void {
    this.sendPolicy = policy
  }

  /**
   * Returns true if any registered plugin reports this peer as `'verified'`.
   * Used by the send path to enforce per-peer strict policy: a peer the user
   * has verified out-of-band must never silently receive plaintext, even when
   * the global send policy is `'opportunistic'`.
   *
   * Plugin trust-check errors are treated as non-verified (fail-open) so a
   * transient plugin fault never permanently blocks the send path.
   */
  async isPeerVerified(peer: BareJID): Promise<boolean> {
    for (const plugin of this.plugins.values()) {
      try {
        const trust = await plugin.getPeerTrust(peer)
        if (trust === 'verified') return true
      } catch {
        // Plugin trust check failed — cannot confirm verified, continue
      }
    }
    return false
  }

  /**
   * True if any registered plugin reports an *established* trust state for
   * this peer — `verified`, `introduced`, or `tofu`. These all mean "we hold
   * a pinned key for this peer", so plaintext is an implicit per-peer downgrade
   * and must be blocked even under the opportunistic global policy. `untrusted`
   * and `unknown` are excluded: the former is a deliberate not-trusted marker,
   * the latter means we have never seen a key (legitimate first contact).
   *
   * Plugin trust-check errors are treated as not-established (fail-open) so a
   * transient plugin fault never permanently blocks the send path.
   */
  async hasEstablishedTrust(peer: BareJID): Promise<boolean> {
    for (const plugin of this.plugins.values()) {
      try {
        const trust = await plugin.getPeerTrust(peer)
        if (trust === 'verified' || trust === 'introduced' || trust === 'tofu') {
          return true
        }
      } catch {
        // Plugin trust check failed — cannot confirm, continue.
      }
    }
    return false
  }

  /**
   * Assert that sending a plaintext message to `target` is permitted
   * under the current policy.
   *
   * Called when encryption was not applied — either no plugin matched or
   * the user forced plaintext. Returns without throwing when plaintext is
   * allowed; throws {@link E2EEEncryptionRequiredError} otherwise.
   *
   * Priority order:
   * 1. Forced-plaintext override always passes — explicit user consent.
   * 2. Strict global send policy blocks all plaintext.
   * 3. A direct peer with established trust (verified / introduced / tofu) blocks plaintext (implicit per-peer strict).
   * 4. Opportunistic policy with an unverified peer → allowed.
   */
  async assertPlaintextPermitted(target: ConversationTarget): Promise<void> {
    if (this.isForcedPlaintext(target)) return
    if (this.sendPolicy === 'strict') {
      throw new E2EEEncryptionRequiredError(target)
    }
    if (target.kind === 'direct') {
      const established = await this.hasEstablishedTrust(target.peer).catch(() => false)
      if (established) throw new E2EEEncryptionRequiredError(target)
    }
  }

  /**
   * Cheap "is encryption available for `target` right now?" probe. Used by
   * call sites that need to decide between two stanza shapes BEFORE
   * building children — e.g. reactions, where the legacy reply-quote
   * fallback embeds the original body in cleartext and must be skipped
   * whenever the recipient can be reached over E2EE.
   *
   * Implemented on top of {@link selectStrategy} so the answer is exactly
   * "would `encryptOutbound` succeed for this target". Hits the capability
   * cache when warm, so repeated calls in a single send path are free.
   */
  async canEncryptTo(target: ConversationTarget): Promise<boolean> {
    return (await this.selectStrategy(target)) !== null
  }

  /**
   * Pick the plugin to use for `target`. Selection rules:
   * 1. User/admin pin wins.
   * 2. Otherwise, highest securityLevel among mutually-supported plugins.
   * 3. Returns `null` if no plugin is mutually available (never plaintext
   *    fallback; the host must surface that in the UI).
   */
  async selectStrategy(target: ConversationTarget): Promise<E2EEPlugin | null> {
    if (this.isForcedPlaintext(target)) return null
    const pin = this.getPinnedStrategy(target)
    if (pin) {
      const pinned = this.plugins.get(pin)
      if (pinned) return pinned
      this.logger.warn(`Pinned strategy unavailable, falling back: ${pin}`)
    }

    const mutual = await this.mutuallySupported(target)
    if (mutual.length === 0) return null
    mutual.sort((a, b) => b.descriptor.securityLevel - a.descriptor.securityLevel)
    return mutual[0]
  }

  /** Probe every plugin against the target and return the ones that fit. */
  private async mutuallySupported(target: ConversationTarget): Promise<E2EEPlugin[]> {
    const peers = targetPeers(target)
    const out: E2EEPlugin[] = []
    for (const plugin of this.plugins.values()) {
      if (target.kind === 'muc' && !plugin.descriptor.features.groupChat) continue
      const ok = await this.peersAllSupport(plugin, peers)
      if (ok) out.push(plugin)
    }
    return out
  }

  private async peersAllSupport(plugin: E2EEPlugin, peers: BareJID[]): Promise<boolean> {
    for (const peer of peers) {
      const cached = this.capabilityCache.get(plugin.descriptor.id, peer)
      if (cached) {
        if (!cached.supported) return false
        continue
      }
      try {
        const support = await plugin.probePeer(peer)
        this.capabilityCache.put(plugin.descriptor.id, peer, support)
        if (!support.supported) return false
      } catch (err) {
        this.logger.warn(`Capability probe failed: ${plugin.descriptor.id} ${peer}`, err)
        return false
      }
    }
    return true
  }

  /** Forget any cached probe result for a peer (use on PEP change notices). */
  invalidateCapability(peer: BareJID, protocolId?: string): void {
    if (protocolId) this.capabilityCache.invalidate(protocolId, peer)
    else this.capabilityCache.invalidatePeer(peer)
  }

  /**
   * PEP change for this peer's per-protocol key material. Drops the host
   * capability cache entry AND asks the plugin to evict its own positive
   * cache, so the next send re-probes and picks up a rotated key.
   *
   * When `protocolId` is omitted every plugin is notified (e.g. a peer
   * retracted everything at once); when it's set only that plugin is.
   */
  notifyPeerKeysChanged(peer: BareJID, protocolId?: string): void {
    this.invalidateCapability(peer, protocolId)
    if (protocolId) {
      const plugin = this.plugins.get(protocolId)
      if (plugin) {
        plugin.onPeerKeysChanged?.(peer)
      } else {
        this.enqueuePendingPeerKeyChange(protocolId, peer)
      }
    } else {
      for (const plugin of this.plugins.values()) {
        plugin.onPeerKeysChanged?.(peer)
      }
    }
    this.peerKeysChangedCallback?.(peer)
  }

  /**
   * Buffer a peer key-change notification addressed to a not-yet-registered
   * plugin id. Drained on the next successful {@link register} for that id.
   *
   * We intentionally do not queue when no `protocolId` is given (the
   * broadcast path is reserved for "peer retracted everything" — it
   * applies only to plugins already in the registry, not future ones).
   */
  private enqueuePendingPeerKeyChange(protocolId: string, peer: BareJID): void {
    let set = this.pendingPeerKeyChanges.get(protocolId)
    if (!set) {
      set = new Set()
      this.pendingPeerKeyChanges.set(protocolId, set)
    }
    if (set.has(peer)) return
    set.add(peer)
    this.logger.debug(
      `E2EE plugin ${protocolId} not yet registered; queued peer key-change for ${peer}`,
    )
  }

  /**
   * Ask every registered plugin whether it wants to claim an inbound encrypted
   * element. Plugins are queried in descending securityLevel order so stronger
   * protocols win when (as should never happen in practice) two plugins could
   * both parse the same element.
   */
  claimInbound(stanzaChild: XMLElementData): { plugin: E2EEPlugin; payload: EncryptedPayload } | null {
    const ordered = [...this.plugins.values()].sort(
      (a, b) => b.descriptor.securityLevel - a.descriptor.securityLevel,
    )
    for (const plugin of ordered) {
      const payload = plugin.tryClaimInbound(stanzaChild)
      if (payload) return { plugin, payload }
    }
    return null
  }

  /**
   * End-to-end outbound helper: pick a strategy, open a conversation, encrypt.
   * Returns `null` if no plugin is available — the caller decides whether to
   * fall back to plaintext (requires explicit user opt-in per architecture).
   *
   * The handle is opened and closed internally; plugins that need persistent
   * state should cache it themselves, keyed by `target`.
   */
  async encryptOutbound(
    target: ConversationTarget,
    plaintext: Uint8Array,
  ): Promise<{ plugin: E2EEPlugin; payload: EncryptedPayload } | null> {
    const plugin = await this.selectStrategy(target)
    if (!plugin) return null
    const handle = await plugin.openConversation(target)
    try {
      const payload = await plugin.encrypt(handle, plaintext)
      return { plugin, payload }
    } finally {
      await plugin.closeConversation(handle).catch(() => {})
    }
  }

  /**
   * End-to-end inbound helper: claim the element, open a conversation for the
   * sender, decrypt. Returns `null` if no plugin claims the element.
   *
   * `context` forwards optional message-level metadata (e.g. the stanza
   * message-id) to the plugin so features like signature re-verification
   * can reference a specific inbound message later on.
   */
  async decryptInbound(
    stanzaChild: XMLElementData,
    senderTarget: ConversationTarget,
    context?: InboundDecryptContext,
  ): Promise<DecryptResult | null> {
    const claim = this.claimInbound(stanzaChild)
    if (!claim) return null
    const handle = await claim.plugin.openConversation(senderTarget)
    try {
      return await claim.plugin.decrypt(handle, claim.payload, context)
    } finally {
      await claim.plugin.closeConversation(handle).catch(() => {})
    }
  }

  /**
   * Archive variant of {@link decryptInbound} — for stanzas retrieved via
   * XEP-0313 MAM. Plugins with forward-secure session state (OMEMO, MLS)
   * implement {@link E2EEPlugin.decryptArchive} to decrypt against
   * frozen/session state without advancing the live ratchet; plugins
   * without such state (OpenPGP) simply inherit the live path because the
   * host transparently falls back to {@link E2EEPlugin.decrypt} when
   * `decryptArchive` is not implemented.
   *
   * The host never calls the live path on archived messages for a plugin
   * that ships `decryptArchive` — that separation is the whole point of
   * this entry point.
   */
  async decryptArchive(
    stanzaChild: XMLElementData,
    senderTarget: ConversationTarget,
    context?: InboundDecryptContext,
  ): Promise<DecryptResult | null> {
    const claim = this.claimInbound(stanzaChild)
    if (!claim) return null
    const handle = await claim.plugin.openConversation(senderTarget)
    try {
      const archiveFn = claim.plugin.decryptArchive?.bind(claim.plugin)
      const decryptFn = archiveFn ?? claim.plugin.decrypt.bind(claim.plugin)
      return await decryptFn(handle, claim.payload, context)
    } finally {
      await claim.plugin.closeConversation(handle).catch(() => {})
    }
  }

  /**
   * Subscribe to plugin-driven security-context updates. Plugins call
   * {@link PluginContext.reportSecurityContextUpdate} (e.g. after a
   * previously-untrusted message's signature becomes verifiable because a
   * sender key finally arrived); every registered listener is invoked with
   * the same payload. Returns an `unsubscribe` function.
   *
   * Listeners are local to this manager instance — shutting down the
   * manager does not call them, but also does not warn if they stay
   * registered; callers are expected to unsubscribe on teardown.
   */
  onSecurityContextUpdated(listener: SecurityContextUpdateListener): () => void {
    this.securityContextListeners.add(listener)
    return () => {
      this.securityContextListeners.delete(listener)
    }
  }

  /** Dispatch a plugin-reported update to every registered listener. */
  private dispatchSecurityContextUpdate(update: SecurityContextUpdate): void {
    for (const listener of this.securityContextListeners) {
      try {
        listener(update)
      } catch (err) {
        this.logger.warn('E2EEManager: security context listener threw', err)
      }
    }
  }

  /** Tear everything down — e.g. on account switch or logout. */
  async shutdown(): Promise<void> {
    const ids = [...this.plugins.keys()]
    for (const id of ids) {
      await this.unregister(id)
    }
    this.pins.clear()
    this.capabilityCache.clear()
    this.securityContextListeners.clear()
    this.forcedPlaintextConversations.clear()
  }
}

function targetPeers(target: ConversationTarget): BareJID[] {
  return target.kind === 'direct' ? [target.peer] : target.participants
}

function targetKey(target: ConversationTarget): string {
  return target.kind === 'direct' ? `direct\u0000${target.peer}` : `muc\u0000${target.room}`
}
