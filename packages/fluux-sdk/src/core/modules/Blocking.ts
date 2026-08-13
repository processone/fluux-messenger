import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { NS_BLOCKING } from '../namespaces'
import { generateUUID } from '../../utils/uuid'
import type { StanzaClaim } from '../stanzaRouting'

/**
 * Blocking module (XEP-0191).
 *
 * Manages the user's blocklist - JIDs that are blocked from sending
 * messages, presence, or other communications.
 *
 * Features:
 * - Fetch current blocklist from server
 * - Block/unblock individual JIDs
 * - Unblock all blocked JIDs
 * - Receive push notifications when blocklist changes
 *
 * @remarks
 * Blocked contacts appear offline and cannot send messages or see
 * your presence. The server handles the actual blocking - this module
 * just manages the list.
 *
 * @example
 * ```typescript
 * // Access via XMPPClient
 * await client.blocking.fetchBlocklist()
 * await client.blocking.blockJid('spammer@example.com')
 * await client.blocking.unblockJid('friend@example.com')
 * await client.blocking.unblockAll()
 * ```
 *
 * @category Modules
 */
/** Stanza shapes this module may handle. Exported so the routing test
 * checks the real claims rather than a copy of them. */
export const BLOCKING_CLAIMS: readonly StanzaClaim[] = [
    { kind: 'iq', type: 'set', child: { name: 'block', ns: NS_BLOCKING } },
    { kind: 'iq', type: 'set', child: { name: 'unblock', ns: NS_BLOCKING } },
  ]

export class Blocking extends BaseModule {
  /**
   * Handle incoming IQ stanzas related to blocking.
   * Processes blocklist push notifications from the server.
   */
  /** XEP-0191 blocklist pushes. Disjoint from Roster's iq claim. */
  readonly claims = BLOCKING_CLAIMS

  handle(stanza: Element): boolean | void {
    if (!stanza.is('iq')) return false

    const type = stanza.attrs.type

    // Handle blocklist push notifications (type="set")
    if (type === 'set') {
      const block = stanza.getChild('block', NS_BLOCKING)
      const unblock = stanza.getChild('unblock', NS_BLOCKING)

      if (block) {
        this.handleBlockPush(stanza, block)
        return true
      }

      if (unblock) {
        this.handleUnblockPush(stanza, unblock)
        return true
      }
    }

    return false
  }

  /**
   * Handle a block push notification from the server.
   * Server sends this when JIDs are added to the blocklist.
   */
  private handleBlockPush(iq: Element, block: Element): void {
    const items = block.getChildren('item')
    const blockedJids = items
      .map((item: Element) => item.attrs.jid)
      .filter((jid): jid is string => !!jid)

    if (blockedJids.length > 0) {
      this.deps.emitSDK('blocking:added', { jids: blockedJids })
    }

    // Acknowledge the push
    this.sendAck(iq)
  }

  /**
   * Handle an unblock push notification from the server.
   * Server sends this when JIDs are removed from the blocklist.
   */
  private handleUnblockPush(iq: Element, unblock: Element): void {
    const items = unblock.getChildren('item')

    if (items.length === 0) {
      // Empty unblock = unblock all
      this.deps.emitSDK('blocking:cleared', {})
    } else {
      const unblockedJids = items
        .map((item: Element) => item.attrs.jid)
        .filter((jid): jid is string => !!jid)

      if (unblockedJids.length > 0) {
        this.deps.emitSDK('blocking:removed', { jids: unblockedJids })
      }
    }

    // Acknowledge the push
    this.sendAck(iq)
  }

  /**
   * Send IQ result to acknowledge a push notification.
   */
  private sendAck(iq: Element): void {
    const ack = xml('iq', {
      type: 'result',
      id: iq.attrs.id,
    })
    this.deps.sendStanza(ack)
  }

  /**
   * Fetch the current blocklist from the server.
   * Should be called after authentication to sync the blocklist.
   *
   * @returns Array of blocked JIDs
   * @throws Error if the server returns an error
   */
  async fetchBlocklist(): Promise<string[]> {
    const iq = xml('iq', { type: 'get', id: generateUUID() },
      xml('blocklist', { xmlns: NS_BLOCKING })
    )

    const result = await this.deps.sendIQ(iq)
    const blocklist = result.getChild('blocklist', NS_BLOCKING)

    if (!blocklist) {
      return []
    }

    const items = blocklist.getChildren('item')
    const blockedJids = items
      .map((item: Element) => item.attrs.jid)
      .filter((jid): jid is string => !!jid)

    this.deps.emitSDK('blocking:list', { jids: blockedJids })

    return blockedJids
  }

  /**
   * Block one or more JIDs.
   * Blocked contacts will appear offline and cannot send you messages.
   *
   * @param jids - JID(s) to block (string or array)
   * @throws Error if no JIDs provided or server returns an error
   */
  async blockJid(jids: string | string[]): Promise<void> {
    const jidArray = Array.isArray(jids) ? jids : [jids]

    if (jidArray.length === 0) {
      throw new Error('At least one JID is required')
    }

    const iq = xml('iq', { type: 'set', id: generateUUID() },
      xml('block', { xmlns: NS_BLOCKING },
        ...jidArray.map(jid => xml('item', { jid }))
      )
    )

    await this.deps.sendIQ(iq)

    // Server will also send push notification, but we emit immediately
    // for responsive UI updates
    this.deps.emitSDK('blocking:added', { jids: jidArray })
  }

  /**
   * Unblock one or more JIDs.
   *
   * @param jids - JID(s) to unblock (string or array)
   * @throws Error if server returns an error
   */
  async unblockJid(jids: string | string[]): Promise<void> {
    const jidArray = Array.isArray(jids) ? jids : [jids]

    if (jidArray.length === 0) {
      throw new Error('At least one JID is required')
    }

    const iq = xml('iq', { type: 'set', id: generateUUID() },
      xml('unblock', { xmlns: NS_BLOCKING },
        ...jidArray.map(jid => xml('item', { jid }))
      )
    )

    await this.deps.sendIQ(iq)

    // Server will also send push notification, but we emit immediately
    // for responsive UI updates
    this.deps.emitSDK('blocking:removed', { jids: jidArray })
  }

  /**
   * Unblock all blocked JIDs.
   *
   * @throws Error if server returns an error
   */
  async unblockAll(): Promise<void> {
    const iq = xml('iq', { type: 'set', id: generateUUID() },
      xml('unblock', { xmlns: NS_BLOCKING })
    )

    await this.deps.sendIQ(iq)

    // Server will also send push notification, but we emit immediately
    // for responsive UI updates
    this.deps.emitSDK('blocking:cleared', {})
  }

  /**
   * Check if a JID is blocked.
   *
   * @param jid - JID to check
   * @returns true if the JID is blocked
   */
  isBlocked(jid: string): boolean {
    return this.deps.stores?.blocking.isBlocked(jid) ?? false
  }
}
