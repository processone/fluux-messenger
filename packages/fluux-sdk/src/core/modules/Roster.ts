import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getBareJid, getLocalPart, getResource } from '../jid'
import { isMucJid } from '../../utils/xmppUri'
import { generateUUID } from '../../utils/uuid'
import { calculateCapsHash, getCapsNode } from '../caps'
import { getClientName } from '../clients'
import {
  NS_CAPS,
  NS_VCARD_UPDATE,
  NS_IDLE,
} from '../namespaces'
import type { PresenceShow, Contact } from '../types'
import { parseXMPPError, formatXMPPError } from '../../utils/xmppError'
import { logInfo } from '../logger'

/**
 * Roster and presence management module.
 *
 * Handles contact list (buddy list) operations and presence:
 * - Roster management: fetch, add, remove, rename contacts
 * - Presence handling: online/away/dnd status, caps, idle time
 * - Subscription management: accept/reject subscription requests
 * - XEP-0115: Entity Capabilities (client identification)
 * - XEP-0153: vCard-Based Avatars (legacy avatar updates via presence)
 * - XEP-0319: Last User Interaction in Presence
 *
 * @remarks
 * Presence is aggregated across multiple resources per contact.
 * The module handles both incoming presence stanzas and outgoing
 * presence broadcasts to contacts and joined MUC rooms.
 *
 * @example
 * ```typescript
 * // Access via XMPPClient
 * client.roster.addContact('user@example.com', 'Display Name')
 * client.roster.removeContact('user@example.com')
 * client.roster.setPresence('away', 'Be right back')
 * client.roster.acceptSubscription('user@example.com')
 * ```
 *
 * @category Modules
 */
export class Roster extends BaseModule {
  private capsHash: string | null = null
  /** Track JIDs for which we received 'unsubscribed' but haven't seen the roster push yet */
  private _pendingSubscriptionDenials = new Set<string>()

  handle(stanza: Element): boolean | void {
    if (stanza.is('iq')) {
      const query = stanza.getChild('query', 'jabber:iq:roster')
      if (query) {
        this.handleRosterIQ(stanza, query)
        return true
      }
    }

    if (stanza.is('presence')) {
      const type = stanza.attrs.type
      const from = stanza.attrs.from
      if (!from) return false

      const bareFrom = getBareJid(from)

      if (type === 'error') {
        this.handlePresenceError(stanza, bareFrom)
        return true
      }

      if (type === 'subscribe') {
        this.handleSubscribe(bareFrom)
        return true
      }

      if (type === 'unsubscribed') {
        this.handleUnsubscribed(bareFrom)
        return true
      }

      if (type === 'subscribed' || type === 'unsubscribe') {
        return true
      }

      // Only handle regular presence (MUC presence is handled by RoomModule)
      if (!stanza.getChild('x', 'http://jabber.org/protocol/muc#user')) {
        this.handleRegularPresence(stanza, from, bareFrom, type)
        return true
      }
    }

    return false
  }

  private handleRosterIQ(stanza: Element, query: Element): void {
    const type = stanza.attrs.type
    const items = query.getChildren('item')

    if (type === 'result' || type === 'set') {
      if (type === 'result') {
        const contacts: Contact[] = items.map((item: Element) => ({
          jid: item.attrs.jid,
          name: item.attrs.name || getLocalPart(item.attrs.jid),
          subscription: item.attrs.subscription as any,
          groups: item.getChildren('group').map((g: Element) => g.getText()),
          presence: 'offline',
        }))
        // SDK event only - binding should call store.setContacts
        this.deps.emitSDK('roster:loaded', { contacts })

        // Log roster distribution
        const subs: Record<string, number> = {}
        for (const c of contacts) {
          subs[c.subscription || 'none'] = (subs[c.subscription || 'none'] || 0) + 1
        }
        const subSummary = Object.entries(subs).map(([k, v]) => `${k}=${v}`).join(', ')
        logInfo(`Roster loaded: ${contacts.length} contact(s) (${subSummary})`)

        // Emit rosterLoaded event to trigger avatar hash restoration
        this.deps.emit('rosterLoaded')
      } else {
        // Roster push - handle both updates and removals
        items.forEach((item: Element) => {
          if (item.attrs.subscription === 'remove') {
            // SDK event only - binding calls store.removeContact
            this.deps.emitSDK('roster:contact-removed', { jid: item.attrs.jid })
          } else {
            const contact: Contact = {
              jid: item.attrs.jid,
              name: item.attrs.name || getLocalPart(item.attrs.jid),
              subscription: item.attrs.subscription as any,
              groups: item.getChildren('group').map((g: Element) => g.getText()),
              presence: 'offline',
            }

            // Deferred cleanup: if we received 'unsubscribed' before this roster push,
            // and the contact now has subscription="none", remove the ghost entry.
            if (contact.subscription === 'none' && this._pendingSubscriptionDenials.has(contact.jid)) {
              this._pendingSubscriptionDenials.delete(contact.jid)
              this.deps.emitSDK('roster:contact-removed', { jid: contact.jid })
              this.removeContact(contact.jid)
              return
            }

            // SDK events only - bindings call store methods
            this.deps.emitSDK('roster:contact', { contact })
            this.deps.emitSDK('chat:conversation-name', { conversationId: contact.jid, name: contact.name })
          }
        })
      }
    }
  }

  private handlePresenceError(stanza: Element, bareFrom: string): void {
    const error = parseXMPPError(stanza)
    const errorReason = error ? formatXMPPError(error) : 'Unknown error'

    // SDK event only - binding calls store.setPresenceError
    this.deps.emitSDK('roster:presence-error', { jid: bareFrom, error: errorReason })
  }

  private handleSubscribe(bareFrom: string): void {
    // Ignore subscription requests from MUC JIDs - rooms should never be contacts
    if (isMucJid(bareFrom)) {
      return
    }

    // Auto-accept only if they're already in our roster with an active subscription.
    // A subscription="none" ghost entry (e.g., from a previous rejected request)
    // should NOT trigger auto-accept — the user must explicitly approve.
    const contact = this.deps.stores?.roster.getContact(bareFrom)
    if (contact && contact.subscription !== 'none') {
      this.deps.sendStanza(xml('presence', { to: bareFrom, type: 'subscribed' }))
    } else {
      // SDK event only - binding calls store.addSubscriptionRequest
      this.deps.emitSDK('events:subscription-request', { from: bareFrom })
    }
  }

  private handleUnsubscribed(bareFrom: string): void {
    // The remote contact denied our subscription request or revoked an existing subscription.
    // Track this JID so we can also handle the deferred case (roster push arriving later).
    this._pendingSubscriptionDenials.add(bareFrom)

    // If the contact is in our roster with subscription="none", it's a ghost entry — remove it.
    const contact = this.deps.stores?.roster.getContact(bareFrom)
    if (contact && contact.subscription === 'none') {
      this.removeContact(bareFrom)
      this._pendingSubscriptionDenials.delete(bareFrom)
    }

    // Notify the user that their subscription request was denied
    this.deps.emitSDK('events:system-notification', {
      type: 'subscription-denied',
      title: 'Subscription denied',
      message: `${getLocalPart(bareFrom)} declined your contact request`,
    })
  }

  private handleRegularPresence(stanza: Element, from: string, bareFrom: string, type?: string): void {
    const resource = getResource(from)
    const show = stanza.getChildText('show') as PresenceShow | null
    const status = stanza.getChildText('status') || undefined
    const priority = parseInt(stanza.getChildText('priority') || '0', 10)

    // XEP-0115: Entity Capabilities
    const caps = stanza.getChild('c', NS_CAPS)
    const client = caps ? getClientName(caps.attrs.node) : undefined

    // Check if this is presence from our own account (another connected resource)
    const ownJid = this.deps.stores?.connection.getJid()
    const ownBareJid = ownJid ? getBareJid(ownJid) : null
    const ownResource = ownJid ? getResource(ownJid) : null
    const isSelfPresence = ownBareJid && bareFrom === ownBareJid && resource && resource !== ownResource

    // Check if this is a room bare JID presence (room avatar update)
    // Room presence comes from bare JID without resource and is a known room
    const isRoomPresence = !resource && this.deps.stores?.room.getRoom(bareFrom) !== undefined

    // XEP-0153: VCard-based Avatars (Legacy)
    const xUpdate = stanza.getChild('x', NS_VCARD_UPDATE)
    const photo = xUpdate?.getChildText('photo')

    if (xUpdate) {
      if (isRoomPresence) {
        // Room avatar update from room bare JID
        if (photo) {
          // Only trigger fetch if hash changed
          const room = this.deps.stores?.room.getRoom(bareFrom)
          if (room?.avatarHash === photo && room?.avatar) {
            // Same hash and already have avatar - skip
          } else {
            this.deps.emitSDK('room:updated', {
              roomJid: bareFrom,
              updates: { avatarFromPresence: true, avatarHash: photo },
            })
            this.deps.emit('roomAvatarUpdate', bareFrom, photo)
          }
        } else {
          // Empty photo - avatar was removed
          this.deps.emitSDK('room:updated', {
            roomJid: bareFrom,
            updates: { avatarFromPresence: true, avatar: undefined, avatarHash: undefined },
          })
        }
      } else if (!isSelfPresence) {
        if (photo) {
          // Contact has XEP-0153 avatar hash - emit if hash changed OR avatar blob is missing
          // (blob can be missing when hash was restored from cache but blob was evicted)
          const contact = this.deps.stores?.roster.getContact(bareFrom)
          if (contact?.avatarHash !== photo || !contact?.avatar) {
            this.deps.emit('avatarMetadataUpdate', bareFrom, photo)
          }
        } else {
          // Contact has empty <photo/> in XEP-0153 - they may use XEP-0084 instead
          // Clients like Conversations publish avatars via XEP-0084 (PEP) only.
          // Emit event to trigger XEP-0084 metadata fetch as fallback.
          this.deps.emit('contactMissingXep0153Avatar', bareFrom)
        }
      }
    } else if (isRoomPresence) {
      // Room presence WITHOUT vcard-temp:x:update means room doesn't advertise avatar
      // Clear any cached avatar to avoid stale/corrupted cache entries
      this.deps.emitSDK('room:updated', {
        roomJid: bareFrom,
        updates: { avatarFromPresence: true, avatar: undefined, avatarHash: undefined },
      })
    }

    // XEP-0319: Last Interaction Time
    let lastInteraction: Date | undefined
    const idle = stanza.getChild('idle', NS_IDLE)
    if (idle?.attrs.since) {
      lastInteraction = new Date(idle.attrs.since)
    }

    // Handle self-presence (other connected resources of our own account)
    if (isSelfPresence) {
      if (type === 'unavailable') {
        // SDK event only - binding calls store.removeOwnResource
        this.deps.emitSDK('connection:own-resource-offline', { resource })
      } else {
        // SDK event only - binding calls store.updateOwnResource
        this.deps.emitSDK('connection:own-resource', {
          resource,
          show,
          priority,
          status,
          lastInteraction,
          client,
        })
      }
      return // Don't process as contact presence
    }

    if (type === 'unavailable') {
      // SDK event only - binding calls store.removePresence
      this.deps.emitSDK('roster:presence-offline', { fullJid: from })
      const contact = this.deps.stores?.roster.getContact(bareFrom)
      this.deps.emit('presence', bareFrom, contact?.presence || 'offline', contact?.statusMessage)
    } else {
      // SDK event only - binding calls store.updatePresence
      this.deps.emitSDK('roster:presence', {
        fullJid: from,
        show,
        priority,
        statusMessage: status,
        lastInteraction,
        client,
      })

      // Emit with aggregated presence
      const contact = this.deps.stores?.roster.getContact(bareFrom)
      this.deps.emit('presence', bareFrom, contact?.presence || 'online', contact?.statusMessage)
    }
  }

  // --- Outgoing Presence Methods ---

  async sendInitialPresence(): Promise<void> {
    if (!this.deps.getXmpp()) {
      this.deps.emitSDK('console:event', { message: 'sendInitialPresence: skipped (no xmpp client)', category: 'presence' })
      return
    }

    if (!this.capsHash) {
      this.capsHash = await calculateCapsHash()
    }

    const currentPresence = this.deps.stores?.connection.getPresenceShow()
    const isAutoAway = this.deps.stores?.connection.getIsAutoAway()
    const currentStatusMessage = this.deps.stores?.connection.getStatusMessage()

    const preAutoAwayState = this.deps.stores?.connection.getPreAutoAwayState()
    const preAutoAwayStatusMessage = this.deps.stores?.connection.getPreAutoAwayStatusMessage()

    let showToSend: 'away' | 'dnd' | 'xa' | undefined
    let statusToSend: string | null | undefined

    if (currentPresence === 'dnd') {
      // Preserve DND - user explicitly set it
      showToSend = 'dnd'
      statusToSend = currentStatusMessage
    } else if (isAutoAway || preAutoAwayState) {
      // Recovering from auto-away/sleep - restore pre-auto-away presence
      // The presence machine handles the state (isAutoAway) - we just need to send
      // the correct presence stanza. When the user becomes active again, the
      // activity/wake detection will transition the machine and sync the store.
      //
      // Check preAutoAwayState in addition to isAutoAway because during the
      // transition window, the store might have preAutoAwayState but isAutoAway
      // could already be false.
      showToSend = preAutoAwayState === 'online' ? undefined : (preAutoAwayState as 'away' | 'dnd' | 'xa' | undefined)
      statusToSend = preAutoAwayStatusMessage
      this.deps.emitSDK('console:event', {
        message: `sendInitialPresence: restoring from auto-away (isAutoAway=${isAutoAway}, preAutoAwayState=${preAutoAwayState})`,
        category: 'presence',
      })
      // Note: We don't clear auto-away flags here. The presence machine is the
      // authoritative source and will sync the correct state to the store when
      // the user's activity/wake detection triggers a machine transition.
    }
    // NOTE: Removed the 'currentPresence === away' branch.
    // Previously, if currentPresence was 'away' and isAutoAway was false, we
    // assumed it was "manual away". But this caused issues on reconnect:
    // - isAutoAway and savedPresenceShow are transient (not persisted)
    // - currentPresence IS persisted
    // So after app restart/reconnect, a previous auto-away state would appear
    // as "manual away" and presence would stay 'away' even though user is active.
    //
    // Now we default to online unless:
    // - DND is set (user explicitly set it, likely important)
    // - Auto-away is active (isAutoAway or savedPresenceShow is set)
    // If user wants to be away manually, they can set it again after reconnect.

    const presence = xml('presence', {},
      showToSend ? xml('show', {}, showToSend) : undefined,
      statusToSend ? xml('status', {}, statusToSend) : undefined,
      xml('priority', {}, '50'),
      xml('c', {
        xmlns: NS_CAPS,
        hash: 'sha-1',
        node: getCapsNode(),
        ver: this.capsHash
      })
    )

    this.deps.emitSDK('console:event', {
      message: `sendInitialPresence: sending ${showToSend || 'online'}`,
      category: 'presence',
    })
    await this.deps.sendStanza(presence)
  }

  async sendPresenceProbes(): Promise<void> {
    const contacts = this.deps.stores?.roster.sortedContacts() || []
    const offlineContacts = contacts.filter(c => c.presence === 'offline')
    if (offlineContacts.length > 0) {
      logInfo(`Sending presence probes to ${offlineContacts.length} offline contact(s)`)
    }
    for (const contact of offlineContacts) {
      const probe = xml('presence', { to: contact.jid, type: 'probe' })
      await this.deps.sendStanza(probe)
    }
  }

  async setPresence(show: PresenceShow | 'online', status?: string, idleSince?: Date): Promise<void> {
    const children = [
      show !== 'online' ? xml('show', {}, show) : undefined,
      status ? xml('status', {}, status) : undefined,
      xml('priority', {}, '50'),
      this.capsHash ? xml('c', {
        xmlns: NS_CAPS,
        hash: 'sha-1',
        node: getCapsNode(),
        ver: this.capsHash
      }) : undefined,
      idleSince ? xml('idle', { xmlns: NS_IDLE, since: idleSince.toISOString() }) : undefined
    ].filter(Boolean)

    const presence = xml('presence', {}, ...children)

    // Send regular presence broadcast (for contacts)
    await this.deps.sendStanza(presence)

    // Also send directed presence to all joined MUC rooms
    // XEP-0045: Room presence must be sent separately as directed presence
    const joinedRooms = this.deps.stores?.room.joinedRooms() || []
    for (const room of joinedRooms) {
      if (room.joined && room.nickname) {
        // Build room presence children (show + status only, no caps/priority needed for MUC)
        const roomPresenceChildren: Element[] = []
        if (show !== 'online') roomPresenceChildren.push(xml('show', {}, show))
        if (status) roomPresenceChildren.push(xml('status', {}, status))

        const roomPresence = xml('presence', {
          to: `${room.jid}/${room.nickname}`,
        }, ...roomPresenceChildren)

        await this.deps.sendStanza(roomPresence)
      }
    }

    // NOTE: Do NOT call setPresenceState() here!
    // The presence machine is the authoritative source of presence state.
    // This method is called FROM setupPresenceSync when the machine state changes.
    // Calling setPresenceState() here would create a circular dependency:
    //   machine transition -> setupPresenceSync -> setPresence() -> setPresenceState() -> machine event
    // This would convert autoAway to userAway, breaking the restore mechanism.
  }

  // --- Roster Management Methods ---

  async fetchRoster(): Promise<void> {
    const iq = xml('iq', { type: 'get', id: `roster_${generateUUID()}` },
      xml('query', { xmlns: 'jabber:iq:roster' })
    )
    // Use sendIQ to wait for the response, ensuring the roster is loaded
    // before initial presence is sent (prevents presence race condition)
    const result = await this.deps.sendIQ(iq)
    const query = result.getChild('query', 'jabber:iq:roster')
    if (query) {
      this.handleRosterIQ(result, query)
    }
  }

  async addContact(jid: string, name?: string): Promise<void> {
    const bareJid = getBareJid(jid)

    // Only send roster set IQ if a name is provided (and not empty)
    if (name && name.trim()) {
      const rosterSet = xml('iq', { type: 'set', id: `roster_add_${generateUUID()}` },
        xml('query', { xmlns: 'jabber:iq:roster' },
          xml('item', { jid: bareJid, name })
        )
      )
      await this.deps.sendStanza(rosterSet)
    }

    // Always send subscribe presence
    const subscribe = xml('presence', { to: bareJid, type: 'subscribe' })
    await this.deps.sendStanza(subscribe)
  }

  async removeContact(jid: string): Promise<void> {
    const bareJid = getBareJid(jid)
    const rosterRemove = xml('iq', { type: 'set', id: `roster_remove_${generateUUID()}` },
      xml('query', { xmlns: 'jabber:iq:roster' },
        xml('item', { jid: bareJid, subscription: 'remove' })
      )
    )
    await this.deps.sendStanza(rosterRemove)
  }

  async renameContact(jid: string, name: string): Promise<void> {
    const bareJid = getBareJid(jid)
    const rosterSet = xml('iq', { type: 'set', id: `roster_rename_${generateUUID()}` },
      xml('query', { xmlns: 'jabber:iq:roster' },
        xml('item', { jid: bareJid, name })
      )
    )
    await this.deps.sendStanza(rosterSet)
  }

  async acceptSubscription(jid: string): Promise<void> {
    const bareJid = getBareJid(jid)
    const subscribed = xml('presence', { to: bareJid, type: 'subscribed' })
    await this.deps.sendStanza(subscribed)

    const subscribe = xml('presence', { to: bareJid, type: 'subscribe' })
    await this.deps.sendStanza(subscribe)

    // SDK event only - binding calls store.removeSubscriptionRequest
    this.deps.emitSDK('events:subscription-request-removed', { from: bareJid })
  }

  async rejectSubscription(jid: string): Promise<void> {
    const bareJid = getBareJid(jid)
    const unsubscribed = xml('presence', { to: bareJid, type: 'unsubscribed' })
    await this.deps.sendStanza(unsubscribed)
    // SDK event only - binding calls store.removeSubscriptionRequest
    this.deps.emitSDK('events:subscription-request-removed', { from: bareJid })

    // Defensively clean up any ghost roster entry with subscription="none".
    // This prevents a rejected contact from being auto-accepted on future requests.
    const contact = this.deps.stores?.roster.getContact(bareJid)
    if (contact && contact.subscription === 'none') {
      await this.removeContact(bareJid)
    }
  }
}
