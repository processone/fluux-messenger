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
  private readonly storage: StorageBackend
  private readonly xmpp: XMPPPrimitives
  private readonly account: AccountInfo
  private readonly logger: Logger
  private sendPolicy: E2EESendPolicy = 'opportunistic'
  private readonly securityContextListeners = new Set<SecurityContextUpdateListener>()

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
      this.plugins.get(protocolId)?.onPeerKeysChanged?.(peer)
      return
    }
    for (const plugin of this.plugins.values()) {
      plugin.onPeerKeysChanged?.(peer)
    }
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
  }
}

function targetPeers(target: ConversationTarget): BareJID[] {
  return target.kind === 'direct' ? [target.peer] : target.participants
}

function targetKey(target: ConversationTarget): string {
  return target.kind === 'direct' ? `direct\u0000${target.peer}` : `muc\u0000${target.room}`
}
