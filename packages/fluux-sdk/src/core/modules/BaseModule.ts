import type { RoomReadMarkers } from './RoomReadMarkers'
import { AvatarStateOwner } from '../../utils/avatarState'
import { getBareJid, getDomain } from '../jid'
import { resolveDefaultMucNick } from '../nick'
import type { DeferredDecryptEngine } from '../e2ee/deferredDecrypt'
import { captureStorageScope } from '../../utils/storageScope'
import type { Client, Element } from '@xmpp/client'
import type { StoreBindings, ClientEvents, SDKEvents, StorageAdapter, ProxyAdapter, PrivacyOptions } from '../types'
import type { E2EEManager } from '../e2ee'
import type { PresenceReader } from '../presenceReader'
import type { FastTokenStorageAdapter } from '../fastTokenStorage'

/**
 * Dependencies injected into each module by XMPPClient.
 *
 * Provides access to stores, stanza sending, and event emission
 * without modules needing direct access to the XMPPClient instance.
 *
 * @internal
 */
export interface ModuleDependencies {
  avatarState?: AvatarStateOwner
  stores: StoreBindings | null
  /** Room-only peer markers; no dependency on private read-sync events. */
  getRoomReadMarkers?: () => RoomReadMarkers
  /** Reuse the archive's existing positive purged-anchor classification. */
  lookUpRoomArchiveAnchor?: (roomJid: string, archiveId: string) => Promise<{ kind: 'found' | 'absent' | 'unknown' }>
  flushRoomOccupants?: (roomJid?: string) => void
  waitForRoomOccupants?: (roomJid: string) => Promise<void>
  /**
   * Read surface for presence-machine state. Presence is machine state, not
   * connection-store state, so modules consult it here rather than through the
   * connection store binding. Always provided (defaults to a headless reader).
   */
  presence: PresenceReader
  sendStanza: (stanza: Element) => Promise<void>
  sendIQ: (iq: Element, timeoutMs?: number) => Promise<Element>
  getCurrentJid: () => string | null
  emit: <K extends keyof ClientEvents>(
    event: K,
    ...args: Parameters<ClientEvents[K]>
  ) => void
  /**
   * Emit SDK events for store bindings.
   * See createStoreBindings for the event-to-store mapping and update timing.
   */
  emitSDK: <K extends keyof SDKEvents>(event: K, payload: SDKEvents[K]) => void
  /** A Retry is sending this chat message. Call the result once it is in the stream, or could not be sent. */
  beginMessageRetry?: (to: string, messageId: string) => (sent: boolean) => void
  /** The underlying xmpp.js client, or null when no session is live. */
  getXmpp: () => Client | null
  /**
   * Storage adapter for session persistence.
   * Used by Connection module for SM state persistence.
   */
  storageAdapter?: StorageAdapter
  /** Stream Management resumption duration to request, in seconds (default 600). */
  streamManagementMaxSeconds?: number
  /** Platform-specific persistence for XEP-0484 FAST authentication tokens. */
  fastTokenStorage?: FastTokenStorageAdapter
  /** Stable XEP-0388 identity used when authenticating and binding FAST tokens. */
  userAgentId?: string
  /**
   * Proxy adapter for WebSocket-to-TCP bridging.
   * Used by Connection module for native TCP/TLS connections.
   */
  proxyAdapter?: ProxyAdapter
  /**
   * Register a MAM query collector.
   * The collector will be called for each incoming stanza while active.
   * Returns a function to unregister the collector.
   * Used by MAM module to avoid adding temporary event listeners.
   */
  registerMAMCollector?: (queryId: string, collector: (stanza: Element) => void) => () => void
  /**
   * Privacy options for controlling data exposure.
   * Used by Profile module to control avatar fetching behavior.
   */
  privacyOptions?: PrivacyOptions
  /**
   * Accessor for the end-to-end encryption plugin host. Chat consults it
   * on the send and receive paths to decide whether to encrypt/decrypt.
   * The account's `e2ee:manager-ready` signal marks when the host and its
   * callbacks are ready for plugin registration.
   */
  getE2EEManager?: () => E2EEManager | null
  recoverCorrection?: DeferredDecryptEngine['recoverCorrection']
  /**
   * Pull-based predicate: "is automatic reconnection currently allowed?"
   * Evaluated live at the single reconnect funnel (Connection.attemptReconnect).
   * Keeps the SDK headless — the app wires this to its reconnect-intent flag.
   * Defaults to always-allowed when omitted.
   */
  shouldAutoReconnect?: () => boolean
  /**
   * The server accepted a new password for this account: later authentications
   * of the session (every reconnect) use it instead of the one given at connect.
   * Wired by XMPPClient to the Connection module; used by Profile.changePassword.
   */
  adoptChangedPassword?: (accountJid: string, password: string) => void
}

/**
 * Base class for domain-specific modules in XMPPClient.
 *
 * Each module handles a specific set of XEPs or features and is responsible
 * for processing incoming stanzas related to its domain. Modules are created
 * by XMPPClient during store binding and share common dependencies.
 *
 * @remarks
 * Handling incoming stanzas is opt-in: a module that routes declares `claims`
 * and implements `handle()` (see `StanzaClaimant` in `core/stanzaRouting`), or
 * declares `observes` and implements `observe()` when it only watches. Modules
 * that are purely request/response — Discovery, Profile — declare neither.
 *
 * @example Creating a custom module
 * ```typescript
 * import type { Element } from '@fluux/sdk/xmpp'
 * import { BaseModule } from './BaseModule'
 *
 * class CustomModule extends BaseModule {
 *   handle(stanza: Element): boolean {
 *     if (stanza.is('message') && stanza.getChild('custom', 'urn:example:custom')) {
 *       // Process custom stanza
 *       return true // Stanza handled
 *     }
 *     return false // Pass to next module
 *   }
 * }
 * ```
 *
 * @category Modules
 * @internal
 */
export abstract class BaseModule {
  protected deps: ModuleDependencies
  protected readonly avatarState: AvatarStateOwner

  protected getRoomWithOccupants(roomJid: string) {
    this.deps.flushRoomOccupants?.(roomJid)
    return this.deps.stores?.room.getRoom(roomJid)
  }

  /**
   * Whether an incoming address is a room, from what this session knows: a
   * room Fluux holds, or an address on the account's own room service. Asks
   * no one, so a stranger's stanza cannot make the client reveal it is online,
   * and never goes by the server's name: people have accounts on chat.* too.
   */
  protected isKnownRoomAddress(bareJid: string): boolean {
    const stores = this.deps.stores
    if (!stores) return false
    if (stores.room.getRoom(bareJid)) return true
    const roomService = stores.admin.getMucServiceJid()
    return !!roomService && getDomain(bareJid).toLowerCase() === roomService.toLowerCase()
  }

  /**
   * The nickname to join a room with when its bookmark stores none: the
   * profile username, then the account's local part (see
   * resolveDefaultMucNick). Every source of a room's bookmark uses it, so a
   * room Fluux is not in joins with the same nickname whichever arrives last.
   */
  protected defaultMucNick(): string {
    const connection = this.deps.stores?.connection
    return resolveDefaultMucNick(connection?.getOwnNickname?.(), connection?.getJid?.()) || 'user'
  }

  protected captureQuery() {
    const scope = captureStorageScope()
    const jid = this.deps.getCurrentJid()
    const xmpp = this.deps.getXmpp()
    const manager = this.deps.getE2EEManager?.()
    const isAccountCurrent = () => scope.isCurrent() && jid === this.deps.getCurrentJid()
    const isCurrent = () => isAccountCurrent() && xmpp === this.deps.getXmpp() && manager === this.deps.getE2EEManager?.()
    return {
      isCurrent,
      isAccountCurrent,
      assertCurrent() {
        if (!isCurrent()) throw new DOMException('History query cancelled', 'AbortError')
      },
    }
  }

  constructor(deps: ModuleDependencies) {
    this.deps = deps
    this.avatarState = deps.avatarState ??= new AvatarStateOwner(() => {
      const jid = deps.getCurrentJid?.()
      return jid ? getBareJid(jid) : null
    })
  }
}
