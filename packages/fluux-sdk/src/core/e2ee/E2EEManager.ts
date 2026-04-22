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
  Logger,
  PluginContext,
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

/**
 * User or admin pin that forces a specific plugin on a conversation.
 * `null` means "no pin — use automatic selection".
 */
export type PinnedStrategy = string | null

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
  private account: AccountInfo
  private readonly logger: Logger

  constructor(options: E2EEManagerOptions) {
    this.storage = options.storage
    this.xmpp = options.xmpp
    this.account = options.account
    this.logger = options.logger ?? silentLogger
    this.capabilityCache = new CapabilityCache(options.capabilityCache)
  }

  /**
   * Update the account info handed to plugins during {@link register}.
   * The host calls this when the logged-in JID becomes known (or changes)
   * so plugins registered after construction see the current account.
   *
   * Already-registered plugins keep the context they were initialized with;
   * their `ctx.account` is a snapshot. If we later need runtime-updatable
   * account info on live plugins we'd refactor `PluginContext.account` to a
   * getter — for now all identity-sensitive work happens inside
   * `plugin.init`, so updating here before `register()` is sufficient.
   */
  setAccount(account: AccountInfo): void {
    this.account = account
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
   */
  async decryptInbound(
    stanzaChild: XMLElementData,
    senderTarget: ConversationTarget,
  ): Promise<DecryptResult | null> {
    const claim = this.claimInbound(stanzaChild)
    if (!claim) return null
    const handle = await claim.plugin.openConversation(senderTarget)
    try {
      return await claim.plugin.decrypt(handle, claim.payload)
    } finally {
      await claim.plugin.closeConversation(handle).catch(() => {})
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
  }
}

function targetPeers(target: ConversationTarget): BareJID[] {
  return target.kind === 'direct' ? [target.peer] : target.participants
}

function targetKey(target: ConversationTarget): string {
  return target.kind === 'direct' ? `direct\u0000${target.peer}` : `muc\u0000${target.room}`
}
