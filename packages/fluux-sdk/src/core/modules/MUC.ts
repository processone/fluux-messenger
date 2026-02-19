import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getBareJid, getLocalPart, getResource, getDomain } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { generateQuickChatSlug } from '../wordlist'
import {
  NS_MUC,
  NS_MUC_USER,
  NS_MUC_OWNER,
  NS_BOOKMARKS,
  NS_PUBSUB,
  NS_HATS,
  NS_DISCO_ITEMS,
  NS_DISCO_INFO,
  NS_RSM,
  NS_DATA_FORMS,
  NS_FLUUX,
  NS_MAM,
  NS_NICK,
  NS_VCARD_UPDATE,
} from '../namespaces'
import type {
  Room,
  RoomOccupant,
  RoomAffiliation,
  RoomRole,
  Hat,
  PresenceShow,
  RSMRequest,
  RSMResponse,
  AdminRoom,
} from '../types'
import { parseXMPPError, formatXMPPError } from '../../utils/xmppError'
import { logInfo, logWarn, logError as logErr } from '../logger'

/**
 * Multi-User Chat (MUC) module for group chat functionality.
 *
 * Implements XEP-0045 Multi-User Chat for joining, managing, and interacting
 * with group chat rooms. Also handles XEP-0402 PEP Native Bookmarks for
 * persistent room bookmarks.
 *
 * @remarks
 * This module is accessed via `client.muc` on the XMPPClient instance.
 *
 * @example Joining a room
 * ```typescript
 * await client.muc.joinRoom('room@conference.example.com', 'MyNickname')
 * ```
 *
 * @example Creating a quick chat (temporary room)
 * ```typescript
 * const roomJid = await client.muc.createQuickChat('MyNick', 'Discussion topic', [
 *   'alice@example.com',
 *   'bob@example.com'
 * ])
 * ```
 *
 * @example Managing bookmarks
 * ```typescript
 * // Fetch all bookmarks
 * const { roomsToAutojoin } = await client.muc.fetchBookmarks()
 *
 * // Add a bookmark with autojoin
 * await client.muc.setBookmark('room@conference.example.com', {
 *   name: 'Team Chat',
 *   nick: 'Me',
 *   autojoin: true
 * })
 *
 * // Remove a bookmark
 * await client.muc.removeBookmark('room@conference.example.com')
 * ```
 *
 * @example Inviting users
 * ```typescript
 * await client.muc.inviteToRoom('room@conference.example.com', 'user@example.com', 'Join us!')
 * ```
 *
 * @category Core
 */
/** Default timeout for room join (in milliseconds) */
const JOIN_TIMEOUT_MS = 30000

/** Maximum number of join retry attempts */
const MAX_JOIN_RETRIES = 1

/** Timeout for disco#info queries to rooms (in milliseconds) */
const DISCO_QUERY_TIMEOUT_MS = 10000

/**
 * Pending join info for timeout tracking
 */
interface PendingJoin {
  timeoutId: ReturnType<typeof setTimeout>
  retryCount: number
  nickname: string
  options?: { maxHistory?: number; password?: string; isQuickChat?: boolean }
}

export class MUC extends BaseModule {
  /** Track pending room joins for timeout handling */
  private pendingJoins = new Map<string, PendingJoin>()

  /**
   * Buffer for occupant presences during room join.
   * Occupants are accumulated here while isJoining is true,
   * then flushed in a single batch when join completes.
   * This reduces store updates from ~50 to ~1 for large rooms.
   */
  private pendingOccupants = new Map<string, RoomOccupant[]>()

  handle(stanza: Element): boolean | void {
    if (stanza.is('presence')) {
      const mucUser = stanza.getChild('x', NS_MUC_USER)
      if (mucUser) {
        this.handleMUCPresence(stanza, mucUser)
        return true
      }
    }
    return false
  }

  private handleMUCPresence(stanza: Element, mucUser: Element): void {
    const from = stanza.attrs.from
    if (!from) return

    const roomJid = getBareJid(from)
    const nick = getResource(from)
    const type = stanza.attrs.type

    if (!nick) {
      // Room-level presence (e.g. error)
      if (type === 'error') {
        const error = parseXMPPError(stanza)
        console.error(`[MUC] Room error for ${roomJid}: ${error ? formatXMPPError(error) : 'unknown'}`)
        this.clearPendingJoin(roomJid)
        this.pendingOccupants.delete(roomJid) // Clear buffered occupants on error
        // SDK event only - binding calls store.updateRoom
        this.deps.emitSDK('room:updated', { roomJid, updates: { joined: false, isJoining: false } })
      }
      return
    }

    if (type === 'error') {
      console.error(`[MUC] Presence error for ${from}`)
      return
    }

    // Parse MUC user info
    const item = mucUser.getChild('item')
    const affiliation = item?.attrs.affiliation as RoomAffiliation
    const role = item?.attrs.role as RoomRole
    const realJid = item?.attrs.jid

    // Check for status codes
    const statuses = mucUser.getChildren('status').map(s => s.attrs.code)
    const isSelf = statuses.includes('110')

    if (type === 'unavailable') {
      if (isSelf) {
        // SDK event only - binding calls store.setRoomJoined
        this.deps.emitSDK('room:joined', { roomJid, joined: false })
      } else {
        // SDK event only - binding calls store.removeOccupant
        this.deps.emitSDK('room:occupant-left', { roomJid, nick })
      }
      return
    }

    // Parse presence details (show)
    const show = stanza.getChildText('show') as PresenceShow | undefined

    // XEP-0317: Hats
    const hats: Hat[] = []
    const hatsEl = stanza.getChild('hats', NS_HATS)
    if (hatsEl) {
      for (const hatEl of hatsEl.getChildren('hat')) {
        if (hatEl.attrs.uri && hatEl.attrs.title) {
          hats.push({
            uri: hatEl.attrs.uri,
            title: hatEl.attrs.title,
            hue: hatEl.attrs.hue ? parseFloat(hatEl.attrs.hue) : undefined,
          })
        }
      }
    }

    // XEP-0398: User Avatar to vCard-Based Avatars Conversion
    // Parse avatar hash from XEP-0153 vcard-temp:x:update in presence
    const xUpdate = stanza.getChild('x', NS_VCARD_UPDATE)
    const avatarHash = xUpdate?.getChildText('photo') || undefined

    const occupant: RoomOccupant = {
      nick,
      jid: realJid,
      affiliation: affiliation || 'none',
      role: role || 'none',
      show: show || undefined,
      hats: hats.length > 0 ? hats : undefined,
      avatarHash,
    }

    if (isSelf) {
      // Clear the join timeout - we successfully joined
      this.clearPendingJoin(roomJid)

      // Capture occupant count before flushing (flush deletes the buffer)
      const pendingCount = this.pendingOccupants.get(roomJid)?.length ?? 0

      // Flush any buffered occupants before processing self
      // This reduces store updates from ~N to 1 for large rooms
      this.flushPendingOccupants(roomJid)

      // SDK events only - bindings call store methods
      this.deps.emitSDK('room:joined', { roomJid, joined: true })
      this.deps.emitSDK('room:self-occupant', { roomJid, occupant })

      logInfo(`Room joined: ${roomJid} (${affiliation}/${role}, ${pendingCount + 1} occupants)`)

      this.deps.emit('mucJoined', roomJid, nick)

      // Auto-bookmark the room if not already bookmarked (skip quick chats - they're transient)
      const room = this.deps.stores?.room.getRoom(roomJid)
      if (room && !room.isBookmarked && !room.isQuickChat) {
        this.setBookmark(roomJid, {
          name: room.name,
          nick: nick,
          autojoin: false,
        }).catch(() => {
          // Ignore bookmark errors - room join was still successful
        })
      }

      // SDK event only - binding calls store.addOccupant
      this.deps.emitSDK('room:occupant-joined', { roomJid, occupant })

      // XEP-0398: Trigger avatar fetch if occupant has avatar hash (skip self - we use own avatar)
      if (avatarHash) {
        this.deps.emit('occupantAvatarUpdate', roomJid, nick, avatarHash, realJid)
      }
    } else {
      // Check if room is in joining state - buffer occupants to reduce re-renders
      const room = this.deps.stores?.room.getRoom(roomJid)
      if (room?.isJoining) {
        // Buffer the occupant for batch processing
        const buffer = this.pendingOccupants.get(roomJid) || []
        buffer.push(occupant)
        this.pendingOccupants.set(roomJid, buffer)
      } else {
        // Room already joined - add occupant immediately (e.g., late joiner or presence update)
        // SDK event only - binding calls store.addOccupant
        this.deps.emitSDK('room:occupant-joined', { roomJid, occupant })

        // XEP-0398: Trigger avatar fetch if occupant has avatar hash
        // Only emit if hash changed from what we already have
        if (avatarHash) {
          const existing = room?.occupants.get(nick)
          if (existing?.avatarHash !== avatarHash || !existing?.avatar) {
            this.deps.emit('occupantAvatarUpdate', roomJid, nick, avatarHash, realJid)
          }
        }
      }
    }
  }

  /**
   * Clear a pending join timeout for a room.
   * Called when join succeeds, fails with error, or is manually cancelled.
   */
  private clearPendingJoin(roomJid: string): void {
    const pending = this.pendingJoins.get(roomJid)
    if (pending) {
      clearTimeout(pending.timeoutId)
      this.pendingJoins.delete(roomJid)
    }
  }

  /**
   * Clean up all pending operations.
   * Called when the client is destroyed or connection is lost to prevent
   * memory leaks from orphaned timeouts.
   */
  cleanup(): void {
    // Clear all pending join timeouts
    for (const pending of Array.from(this.pendingJoins.values())) {
      clearTimeout(pending.timeoutId)
    }
    this.pendingJoins.clear()
    this.pendingOccupants.clear()
  }

  /**
   * Flush buffered occupants for a room in a single batch update.
   * This reduces store updates from ~N to 1 for large rooms during join.
   */
  private flushPendingOccupants(roomJid: string): void {
    const occupants = this.pendingOccupants.get(roomJid)
    if (occupants && occupants.length > 0) {
      // SDK event only - binding calls store.batchAddOccupants
      this.deps.emitSDK('room:occupants-batch', { roomJid, occupants })

      // XEP-0398: Trigger avatar fetch for all occupants with avatar hashes
      for (const occupant of occupants) {
        if (occupant.avatarHash) {
          this.deps.emit('occupantAvatarUpdate', roomJid, occupant.nick, occupant.avatarHash, occupant.jid)
        }
      }
    }
    this.pendingOccupants.delete(roomJid)
  }

  /**
   * Handle join timeout - called when no self-presence is received within timeout period.
   * Will retry once before giving up.
   */
  private handleJoinTimeout(roomJid: string): void {
    const pending = this.pendingJoins.get(roomJid)
    if (!pending) return

    const room = this.deps.stores?.room.getRoom(roomJid)
    if (!room || room.joined) {
      // Room already joined or removed, clean up
      this.pendingJoins.delete(roomJid)
      return
    }

    if (pending.retryCount < MAX_JOIN_RETRIES) {
      // Retry joining - DON'T delete the pending entry yet,
      // so startJoinTimeout can read the retry count
      logWarn(`Room join timeout: ${roomJid}, retrying (attempt ${pending.retryCount + 1}/${MAX_JOIN_RETRIES})`)
      // Re-call joinRoom which will set up a new timeout with incremented retry count
      this.joinRoom(roomJid, pending.nickname, pending.options).catch(err => {
        console.error(`[MUC] Retry join failed for ${roomJid}:`, err)
      })
    } else {
      // Max retries reached, give up
      logErr(`Room join timeout: ${roomJid} after ${MAX_JOIN_RETRIES} retries, giving up`)
      this.pendingJoins.delete(roomJid)
      this.pendingOccupants.delete(roomJid) // Clear buffered occupants on timeout
      // SDK event only - binding calls store.updateRoom
      this.deps.emitSDK('room:updated', { roomJid, updates: { isJoining: false, joined: false } })
    }
  }

  /**
   * Start a join timeout for a room.
   * If no self-presence is received within the timeout, will retry or give up.
   */
  private startJoinTimeout(roomJid: string, nickname: string, options?: { maxHistory?: number; password?: string; isQuickChat?: boolean }): void {
    // Get current retry count BEFORE clearing (to preserve count across retries)
    const existingPending = this.pendingJoins.get(roomJid)
    const retryCount = existingPending ? existingPending.retryCount + 1 : 0

    // Clear any existing timeout for this room
    this.clearPendingJoin(roomJid)

    const timeoutId = setTimeout(() => {
      this.handleJoinTimeout(roomJid)
    }, JOIN_TIMEOUT_MS)

    this.pendingJoins.set(roomJid, {
      timeoutId,
      retryCount,
      nickname,
      options,
    })
  }

  /**
   * Join a MUC room.
   *
   * Sends presence to the room to join as an occupant. Creates the room
   * in the local store if it doesn't exist, and requests message history.
   *
   * @param roomJid - The room JID to join (e.g., 'room@conference.example.com')
   * @param nickname - Your nickname in the room
   * @param options - Optional join settings
   * @param options.maxHistory - Number of history messages to request (default: 50, use 0 for none)
   * @param options.password - Room password if required
   * @param options.isQuickChat - Mark this as a temporary quick chat room
   *
   * @example
   * ```typescript
   * // Basic join
   * await client.muc.joinRoom('room@conference.example.com', 'MyNick')
   *
   * // Join with password and limited history
   * await client.muc.joinRoom('private@conference.example.com', 'MyNick', {
   *   password: 'secret',
   *   maxHistory: 10
   * })
   * ```
   *
   * @remarks
   * - Emits 'mucJoined' event when successfully joined
   * - Automatically bookmarks the room (unless it's a quick chat)
   * - Includes current presence status in the join presence
   */
  async joinRoom(
    roomJid: string,
    nickname: string,
    options?: { maxHistory?: number; password?: string; isQuickChat?: boolean }
  ): Promise<void> {
    const existingRoom = this.deps.stores?.room.getRoom(roomJid)

    // If already joined, don't send another presence (avoids leave/rejoin issues)
    if (existingRoom?.joined) {
      console.log('[MUC] Already in room, skipping join:', roomJid)
      return
    }

    const isQuickChat = options?.isQuickChat ?? existingRoom?.isQuickChat

    // Query room features to get room name and detect MAM support
    // For quickchats, we still query to get the room name (set by creator)
    // but skip MAM since quickchats are transient
    const roomFeatures = await this.queryRoomFeatures(roomJid)
    const supportsMAM = isQuickChat ? false : (roomFeatures?.supportsMAM ?? false)
    const roomName = roomFeatures?.name || existingRoom?.name || getLocalPart(roomJid)

    if (!existingRoom) {
      const room: Room = {
        jid: roomJid,
        name: roomName,
        nickname,
        joined: false,
        isJoining: true,
        isBookmarked: false,
        isQuickChat: options?.isQuickChat,
        supportsMAM,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      }
      // SDK event only - binding calls store.addRoom
      this.deps.emitSDK('room:added', { room })
    } else {
      const updates: Partial<Room> = {
        nickname,
        isJoining: true,
        supportsMAM,
        occupants: new Map() as Map<string, RoomOccupant>,
        selfOccupant: undefined,
        typingUsers: new Set() as Set<string>,
        ...(options?.isQuickChat !== undefined && { isQuickChat: options.isQuickChat }),
      }
      // Update room name if we fetched a proper name and it's different from local part
      if (roomFeatures?.name && existingRoom.name === getLocalPart(roomJid)) {
        updates.name = roomFeatures.name
      }
      // SDK event only - binding calls store.updateRoom
      this.deps.emitSDK('room:updated', { roomJid, updates })
    }

    const xChildren: (Element | undefined)[] = []

    // Request history based on MAM support:
    // - Room supports MAM: request 0 (MAM provides full history via archive queries)
    // - No MAM: request 50 (default, or custom maxHistory) - get history from MUC
    const maxHistory = supportsMAM ? 0 : (options?.maxHistory ?? 50)
    xChildren.push(xml('history', { maxstanzas: maxHistory.toString() }))

    if (options?.password) {
      xChildren.push(xml('password', {}, options.password))
    }

    const presenceChildren: Element[] = [
      xml('x', { xmlns: NS_MUC }, ...xChildren.filter(Boolean) as Element[])
    ]

    // Include current presence show (away, dnd, xa) if not online
    const currentPresence = this.deps.stores?.connection.getPresenceShow()
    const currentStatus = this.deps.stores?.connection.getStatusMessage()
    if (currentPresence && currentPresence !== 'online' && currentPresence !== 'offline') {
      const showValue = currentPresence === 'away' ? 'away' : currentPresence === 'dnd' ? 'dnd' : undefined
      if (showValue) {
        presenceChildren.push(xml('show', {}, showValue))
      }
    }
    if (currentStatus) {
      presenceChildren.push(xml('status', {}, currentStatus))
    }

    const presence = xml(
      'presence',
      { to: `${roomJid}/${nickname}` },
      ...presenceChildren
    )

    logInfo(`Joining room: ${roomJid}`)
    await this.deps.sendStanza(presence)

    // Start timeout - if no self-presence received within timeout, will retry or give up
    this.startJoinTimeout(roomJid, nickname, options)
  }

  /**
   * Leave a MUC room.
   *
   * Sends an unavailable presence to gracefully leave the room.
   *
   * @param roomJid - The room JID to leave
   *
   * @example
   * ```typescript
   * await client.muc.leaveRoom('room@conference.example.com')
   * ```
   *
   * @remarks
   * - Updates the local room state to `joined: false`
   * - Does not remove the room from the store or bookmarks
   */
  async leaveRoom(roomJid: string): Promise<void> {
    const room = this.deps.stores?.room.getRoom(roomJid)
    if (!room) return

    // Clear any pending join timeout
    this.clearPendingJoin(roomJid)

    const presence = xml('presence', {
      to: `${roomJid}/${room.nickname}`,
      type: 'unavailable',
    })

    await this.deps.sendStanza(presence)
    logInfo(`Room left: ${roomJid}`)
    // SDK event only - binding calls store.updateRoom
    this.deps.emitSDK('room:updated', { roomJid, updates: { joined: false, isJoining: false } })
  }

  /**
   * Send a mediated invitation to a MUC room (XEP-0045).
   *
   * The invitation is sent through the room server, which forwards it
   * to the invitee. This is the standard way to invite users to a room.
   *
   * @param roomJid - The room JID
   * @param jid - The JID of the user to invite
   * @param reason - Optional invitation message
   * @param password - Room password to include in the invitation
   *
   * @example
   * ```typescript
   * // Simple invitation
   * await client.muc.inviteToRoom('room@conference.example.com', 'user@example.com')
   *
   * // Invitation with reason and password
   * await client.muc.inviteToRoom('private@conference.example.com', 'user@example.com',
   *   'Join our meeting!', 'room-password')
   * ```
   */
  async inviteToRoom(roomJid: string, jid: string, reason?: string, password?: string): Promise<void> {
    const invite = xml('message', { to: roomJid },
      xml('x', { xmlns: NS_MUC_USER },
        xml('invite', { to: jid },
          reason ? xml('reason', {}, reason) : undefined
        ),
        password ? xml('password', {}, password) : undefined
      )
    )
    await this.deps.sendStanza(invite)
  }

  /**
   * Send a mediated invitation with quick chat support.
   *
   * Similar to {@link inviteToRoom} but with support for marking the
   * invitation as a quick chat, which tells the recipient's client
   * to treat the room as temporary.
   *
   * @param roomJid - The room JID
   * @param inviteeJid - The JID of the user to invite
   * @param reason - Optional invitation message
   * @param isQuickChat - If true, includes a marker so recipient treats this as a quick chat
   *
   * @example
   * ```typescript
   * await client.muc.sendMediatedInvitation(
   *   'quickchat-xyz@conference.example.com',
   *   'user@example.com',
   *   'Quick discussion',
   *   true
   * )
   * ```
   */
  async sendMediatedInvitation(roomJid: string, inviteeJid: string, reason?: string, isQuickChat?: boolean): Promise<void> {
    // Build invite element children
    const inviteChildren: Element[] = []
    if (reason) {
      inviteChildren.push(xml('reason', {}, reason))
    }
    // Add quickchat marker INSIDE the invite element so it gets forwarded by the MUC server
    if (isQuickChat) {
      inviteChildren.push(xml('quickchat', { xmlns: NS_FLUUX }))
    }

    const inviteElement = xml('invite', { to: inviteeJid }, ...inviteChildren)

    const message = xml(
      'message',
      { to: roomJid },
      xml('x', { xmlns: NS_MUC_USER }, inviteElement)
    )

    await this.deps.sendStanza(message)
  }

  /**
   * Send mediated invitations to multiple users.
   *
   * Convenience method to invite multiple users at once. Invitations
   * are sent in parallel for efficiency.
   *
   * @param roomJid - The room JID
   * @param inviteeJids - Array of JIDs to invite
   * @param reason - Optional invitation message for all invitees
   * @param isQuickChat - If true, marks invitations as quick chat
   *
   * @example
   * ```typescript
   * await client.muc.sendMediatedInvitations(
   *   'room@conference.example.com',
   *   ['alice@example.com', 'bob@example.com', 'carol@example.com'],
   *   'Team meeting'
   * )
   * ```
   */
  async sendMediatedInvitations(roomJid: string, inviteeJids: string[], reason?: string, isQuickChat?: boolean): Promise<void> {
    await Promise.all(
      inviteeJids.map(jid => this.sendMediatedInvitation(roomJid, jid, reason, isQuickChat))
    )
  }

  /**
   * Discover the MUC service JID for the current server.
   *
   * Uses service discovery (XEP-0030) to find the conference component
   * on the connected server.
   *
   * @returns The MUC service JID (e.g., 'conference.example.com'), or null if not found
   *
   * @example
   * ```typescript
   * const mucService = await client.muc.discoverMucService()
   * if (mucService) {
   *   console.log(`MUC service available at: ${mucService}`)
   * }
   * ```
   *
   * @remarks
   * - Queries the server's disco#items and checks each for conference identity
   * - Result can be cached; typically only needs to be called once per session
   */
  async discoverMucService(): Promise<string | null> {
    const domain = getDomain(this.deps.getCurrentJid() ?? '')
    if (!domain) return null

    try {
      const iq = xml('iq', { type: 'get', to: domain, id: `disco_items_${generateUUID()}` },
        xml('query', { xmlns: NS_DISCO_ITEMS })
      )

      const response = await this.deps.sendIQ(iq)
      const query = response.getChild('query', NS_DISCO_ITEMS)
      if (!query) return null

      for (const item of query.getChildren('item')) {
        const jid = item.attrs.jid
        if (!jid) continue

        // Query each item for its features
        const infoIq = xml('iq', { type: 'get', to: jid, id: `disco_info_${generateUUID()}` },
          xml('query', { xmlns: NS_DISCO_INFO })
        )

        const infoResponse = await this.deps.sendIQ(infoIq)
        const infoQuery = infoResponse.getChild('query', NS_DISCO_INFO)
        const identity = infoQuery?.getChildren('identity').find(
          (id: Element) => id.attrs.category === 'conference'
        )

        if (identity) {
          // Check if the MUC service supports MAM globally (XEP-0313)
          // This is useful as a fallback when individual room disco fails
          const features = infoQuery?.getChildren('feature')
            .map((f: Element) => f.attrs.var as string)
            .filter(Boolean) ?? []
          const serviceSupportsMAM = features.includes(NS_MAM)

          logInfo(`MUC service: ${jid} (MAM=${serviceSupportsMAM})`)

          // Emit service-level MAM support for use as fallback
          this.deps.emitSDK('admin:muc-service-mam', { supportsMAM: serviceSupportsMAM })

          return jid
        }
      }
    } catch (err) {
      logErr(`MUC service discovery failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    return null
  }

  /**
   * Query room features via disco#info (XEP-0030).
   *
   * Discovers capabilities of a MUC room, including MAM support.
   * When MAM is supported, the room archives messages which can be
   * retrieved via XEP-0313 queries.
   *
   * @param roomJid - The room JID to query
   * @returns Object with room capabilities, or null if query failed
   *
   * @example
   * ```typescript
   * const features = await client.muc.queryRoomFeatures('room@conference.example.com')
   * if (features?.supportsMAM) {
   *   console.log('Room archives messages via MAM')
   * }
   * ```
   *
   * @remarks
   * - Called automatically by joinRoom() to determine history strategy
   * - If MAM is supported, joinRoom() requests 0 MUC history messages
   *   since MAM provides a more reliable and complete archive
   * - Has a 10-second timeout to prevent hanging if remote server doesn't respond
   */
  async queryRoomFeatures(roomJid: string): Promise<{ supportsMAM: boolean; name?: string } | null> {
    try {
      const iq = xml(
        'iq',
        { type: 'get', to: roomJid, id: `disco_room_${generateUUID()}` },
        xml('query', { xmlns: NS_DISCO_INFO })
      )

      // Wrap sendIQ with a timeout to prevent hanging if remote server doesn't respond
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Disco query timeout for ${roomJid}`)), DISCO_QUERY_TIMEOUT_MS)
      })

      const response = await Promise.race([
        this.deps.sendIQ(iq),
        timeoutPromise,
      ])

      const query = response.getChild('query', NS_DISCO_INFO)
      if (!query) return null

      // Parse features
      const features = query.getChildren('feature')
        .map((f: Element) => f.attrs.var as string)
        .filter(Boolean)

      const supportsMAM = features.includes(NS_MAM)

      // Parse room name from identity element
      // <identity category="conference" type="text" name="Room Name"/>
      const identity = query.getChildren('identity')
        .find((i: Element) => i.attrs.category === 'conference')
      const name = identity?.attrs.name as string | undefined

      logInfo(`Room features: ${roomJid} MAM=${supportsMAM}`)

      return { supportsMAM, name }
    } catch (err) {
      // Room disco#info not available - that's fine, room may not exist yet
      // or may not support disco queries, or the query timed out
      logWarn(`Room disco failed: ${roomJid}: ${err instanceof Error ? err.message : String(err)}`)

      // Don't fallback to service-level MAM - if we can't confirm room-level MAM,
      // assume it's not supported. This is safer because:
      // 1. ejabberd has per-room MAM that can be disabled individually
      // 2. Some rooms may explicitly have MAM disabled even if the service supports it
      // 3. Wrongly assuming MAM support causes UI issues (load more button when there's no MAM)
      return null
    }
  }

  /**
   * Create a new quick chat (temporary MUC room).
   *
   * Quick chats are non-persistent rooms designed for ad-hoc conversations.
   * They are automatically configured as private, non-persistent rooms
   * and are not bookmarked.
   *
   * @param nickname - Your nickname in the room
   * @param topic - Optional room topic/description
   * @param invitees - Optional array of JIDs to invite immediately
   * @returns The room JID of the created quick chat
   * @throws Error if not connected or MUC service is unavailable
   *
   * @example
   * ```typescript
   * // Create a quick chat with some contacts
   * const roomJid = await client.muc.createQuickChat('Me', 'Project discussion', [
   *   'alice@example.com',
   *   'bob@example.com'
   * ])
   *
   * // Create a solo quick chat (invite others later)
   * const roomJid = await client.muc.createQuickChat('Me', 'Notes')
   * ```
   *
   * @remarks
   * - Room is configured as non-persistent (destroyed when last occupant leaves)
   * - Room is private (not listed in public room directory)
   * - Invitations are sent automatically with quick chat marker
   * - Room name is auto-generated from invitee names and date
   */
  async createQuickChat(nickname: string, topic?: string, invitees?: string[]): Promise<string> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) throw new Error('Not connected')

    // 1. Get MUC service domain
    const mucJid = await this.discoverMucService()
    if (!mucJid) throw new Error('MUC service not available')

    // 2. Generate unique room JID
    const username = getLocalPart(currentJid)
    const slug = generateQuickChatSlug()
    const roomJid = `quickchat-${username}-${slug}@${mucJid}`

    // 3. Generate room name based on all participants (creator + invitees)
    // Try to fetch XEP-0172 nicknames, fall back to JID local parts
    const roomName = await this.generateQuickChatName(currentJid, invitees)

    // 4. Create room in store with isQuickChat flag
    const room: Room = {
      jid: roomJid,
      name: roomName,
      nickname,
      joined: false,
      isBookmarked: false,
      isQuickChat: true,
      occupants: new Map(),
      messages: [],
      unreadCount: 0,
      mentionsCount: 0,
      typingUsers: new Set(),
    }
    // SDK event only - binding calls store.addRoom
    this.deps.emitSDK('room:added', { room })

    // 5. Join room (sends presence, room auto-creates on first occupant)
    await this.joinRoom(roomJid, nickname, { maxHistory: 0 })

    // 6. Configure room as non-persistent (with optional topic as description)
    await this.configureQuickChat(roomJid, roomName, topic?.trim())

    // 7. Send invitations to specified contacts (with quick chat marker)
    if (invitees && invitees.length > 0) {
      await this.sendMediatedInvitations(roomJid, invitees, topic ? `Join quick chat: ${topic}` : undefined, true)
    }

    return roomJid
  }

  /**
   * Generate a descriptive name for a quick chat room.
   * Includes all participants (creator + invitees) using XEP-0172 nicknames
   * when available, falling back to JID local parts.
   *
   * Note: We intentionally avoid using roster names (contact.name) to prevent
   * leaking private labels the user may have assigned to contacts.
   */
  private async generateQuickChatName(creatorJid: string, invitees?: string[]): Promise<string> {
    const now = new Date()
    const dateStr = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const timeStr = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

    // Build list of all participants (creator + invitees)
    const names: string[] = []

    // Add creator's name (use stored XEP-0172 nickname or JID local part)
    const ownNickname = this.deps.stores?.connection.getOwnNickname?.()
    const creatorName = ownNickname || getLocalPart(creatorJid)
    if (creatorName) names.push(creatorName)

    // Add invitees' names
    if (invitees && invitees.length > 0) {
      for (const jid of invitees) {
        // Try XEP-0172 nickname first, fall back to JID local part
        const nickname = await this.fetchContactNickname(jid)
        const name = nickname || getLocalPart(jid)
        if (name) names.push(name)
      }
    }

    if (names.length > 0) {
      // Format: "Me, Alice, Bob - Jan 1" or "Me, Alice +2 - Jan 1"
      const nameList = names.length <= 3
        ? names.join(', ')
        : `${names.slice(0, 2).join(', ')} +${names.length - 2}`
      return `${nameList} - ${dateStr}`
    }

    // Fallback: "Quick Chat - Jan 1, 2:30 PM"
    return `Quick Chat - ${dateStr}, ${timeStr}`
  }

  /**
   * Fetch a contact's XEP-0172 User Nickname from their PEP.
   * Returns null if not available or on error.
   */
  private async fetchContactNickname(jid: string): Promise<string | null> {
    const bareJid = getBareJid(jid)
    const iq = xml('iq', { type: 'get', to: bareJid, id: `nick_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_NICK, max_items: '1' })
      )
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const nick = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChild('item')?.getChild('nick', NS_NICK)?.text()
      return nick || null
    } catch {
      // Contact may not have a nickname set or PEP may not be available
      return null
    }
  }

  /**
   * Configure a room as a temporary quick chat (non-persistent, private).
   */
  private async configureQuickChat(roomJid: string, roomName: string, description?: string): Promise<void> {
    // Build configuration fields
    const fields = [
      xml('field', { var: 'FORM_TYPE', type: 'hidden' },
        xml('value', {}, 'http://jabber.org/protocol/muc#roomconfig')
      ),
      xml('field', { var: 'muc#roomconfig_persistentroom' },
        xml('value', {}, '0')
      ),
      xml('field', { var: 'muc#roomconfig_roomname' },
        xml('value', {}, roomName)
      ),
      xml('field', { var: 'muc#roomconfig_publicroom' },
        xml('value', {}, '0')
      ),
      xml('field', { var: 'muc#roomconfig_allowinvites' },
        xml('value', {}, '1')
      ),
    ]

    // Add description if provided
    if (description) {
      fields.push(
        xml('field', { var: 'muc#roomconfig_roomdesc' },
          xml('value', {}, description)
        )
      )
    }

    const iq = xml(
      'iq',
      { type: 'set', to: roomJid, id: `config_${generateUUID()}` },
      xml('query', { xmlns: NS_MUC_OWNER },
        xml('x', { xmlns: NS_DATA_FORMS, type: 'submit' }, ...fields)
      )
    )

    try {
      await this.deps.sendIQ(iq)
      // SDK event only - binding calls store.updateRoom
      this.deps.emitSDK('room:updated', { roomJid, updates: { name: roomName } })
    } catch (err) {
      // Room configuration failed - log but don't throw
      // The room will still work, just won't be configured as temporary
      console.error('[MUC] Quick chat configuration failed:', err)
    }
  }

  /**
   * Set whether to notify for all messages in a room.
   *
   * When enabled, all messages in the room trigger notifications,
   * not just @mentions.
   *
   * @param roomJid - The room JID
   * @param notifyAll - True to notify on all messages, false for mentions only
   * @param persistent - If true, saves the setting to the server bookmark
   *
   * @example
   * ```typescript
   * // Enable notifications for all messages (session only)
   * await client.muc.setRoomNotifyAll('room@conference.example.com', true)
   *
   * // Enable and save to bookmark
   * await client.muc.setRoomNotifyAll('room@conference.example.com', true, true)
   * ```
   */
  async setRoomNotifyAll(roomJid: string, notifyAll: boolean, persistent: boolean = false): Promise<void> {
    // SDK event only - binding calls store.updateRoom
    this.deps.emitSDK('room:updated', { roomJid, updates: { notifyAll, notifyAllPersistent: persistent } })

    // If persistent, update the bookmark on the server
    if (persistent) {
      const room = this.deps.stores?.room.getRoom(roomJid)
      if (!room) return

      // Only update bookmark if room is bookmarked
      if (room.isBookmarked) {
        await this.setBookmark(roomJid, {
          name: room.name,
          nick: room.nickname,
          autojoin: room.autojoin,
          password: room.password,
          notifyAll,
        })
      }
    }
  }

  /**
   * Fetch bookmarks from the server (XEP-0402).
   *
   * Retrieves all saved room bookmarks from the user's PEP storage.
   * Bookmarked rooms are added to the room store.
   *
   * @returns Object containing rooms to autojoin and all bookmarked room JIDs
   *
   * @example
   * ```typescript
   * const { roomsToAutojoin, allRoomJids } = await client.muc.fetchBookmarks()
   *
   * // Auto-join bookmarked rooms
   * for (const room of roomsToAutojoin) {
   *   await client.muc.joinRoom(room.jid, room.nick, { password: room.password })
   * }
   *
   * console.log(`Loaded ${allRoomJids.length} bookmarked rooms`)
   * ```
   *
   * @remarks
   * - Called automatically during connection setup
   * - Rooms with autojoin=true are returned in roomsToAutojoin
   * - Supports custom notify-all extension in bookmark extensions
   */
  async fetchBookmarks(): Promise<{ roomsToAutojoin: Array<{ jid: string; nick: string; password?: string }>; allRoomJids: string[] }> {
    const roomsToAutojoin: Array<{ jid: string; nick: string; password?: string }> = []
    const allRoomJids: string[] = []

    try {
      const iq = xml('iq', { type: 'get', id: `bookmarks_${generateUUID()}` },
        xml('pubsub', { xmlns: NS_PUBSUB },
          xml('items', { node: NS_BOOKMARKS })
        )
      )

      const response = await this.deps.sendIQ(iq)
      const items = response.getChild('pubsub', NS_PUBSUB)?.getChild('items')
      if (!items) return { roomsToAutojoin, allRoomJids }

      for (const item of items.getChildren('item')) {
        // XEP-0402: conference element is directly under item with xmlns="urn:xmpp:bookmarks:1"
        const conference = item.getChild('conference', NS_BOOKMARKS)
        if (!conference) continue

        const jid = item.attrs.id // In XEP-0402, the room JID is the item id
        const name = conference.attrs.name || getLocalPart(jid)
        const autojoin = conference.attrs.autojoin === '1' || conference.attrs.autojoin === 'true'
        const nick = conference.getChildText('nick')
        const password = conference.getChildText('password') || undefined

        // Check for notify extension
        const extensions = conference.getChild('extensions')
        const notifyEl = extensions?.getChild('notify', NS_FLUUX)
        const notifyAll = notifyEl?.getText() === 'all'

        allRoomJids.push(jid)

        const room: Room = {
          jid,
          name,
          nickname: nick || 'user',
          joined: false,
          isBookmarked: true,
          autojoin,
          password,
          notifyAll,
          notifyAllPersistent: notifyAll,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        }
        // SDK event only - binding calls store.addRoom
        this.deps.emitSDK('room:added', { room })

        if (autojoin && nick) {
          roomsToAutojoin.push({ jid, nick, password })
        }
      }
    } catch (err) {
      logErr(`Bookmarks fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const autojoinCount = roomsToAutojoin.length
    logInfo(`Bookmarks: ${allRoomJids.length} total, ${autojoinCount} autojoin`)

    return { roomsToAutojoin, allRoomJids }
  }

  /**
   * Add or update a room bookmark (XEP-0402).
   *
   * Saves a room bookmark to the user's PEP storage. The bookmark
   * persists across sessions and can be used for auto-joining.
   *
   * @param roomJid - The room JID to bookmark
   * @param options - Bookmark settings
   * @param options.name - Display name for the room
   * @param options.nick - Nickname to use when joining
   * @param options.autojoin - If true, automatically join on connect
   * @param options.password - Room password (if required)
   * @param options.notifyAll - If true, notify on all messages
   *
   * @example
   * ```typescript
   * // Bookmark with autojoin
   * await client.muc.setBookmark('team@conference.example.com', {
   *   name: 'Team Chat',
   *   nick: 'Me',
   *   autojoin: true
   * })
   *
   * // Bookmark a private room
   * await client.muc.setBookmark('private@conference.example.com', {
   *   name: 'Private Room',
   *   nick: 'Me',
   *   password: 'secret',
   *   autojoin: false
   * })
   * ```
   */
  async setBookmark(
    roomJid: string,
    options: { name: string; nick: string; autojoin?: boolean; password?: string; notifyAll?: boolean }
  ): Promise<void> {
    // Build conference element children
    const confChildren: Element[] = [xml('nick', {}, options.nick)]
    if (options.password) {
      confChildren.push(xml('password', {}, options.password))
    }

    // Add extensions element with notify setting if notifyAll is enabled
    if (options.notifyAll) {
      confChildren.push(
        xml('extensions', {},
          xml('notify', { xmlns: NS_FLUUX }, 'all')
        )
      )
    }

    const iq = xml(
      'iq',
      { type: 'set', id: `bookmark_set_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: NS_BOOKMARKS },
          xml('item', { id: roomJid },
            xml('conference', {
              xmlns: NS_BOOKMARKS,
              name: options.name,
              autojoin: options.autojoin ? 'true' : 'false',
            }, ...confChildren)
          )
        )
      )
    )

    await this.deps.sendIQ(iq)

    // SDK event only - binding calls store.setBookmark
    this.deps.emitSDK('room:bookmark', {
      roomJid,
      bookmark: {
        name: options.name,
        nick: options.nick,
        autojoin: options.autojoin,
        password: options.password,
        notifyAll: options.notifyAll,
      },
    })
  }

  /**
   * Remove a room bookmark (XEP-0402).
   *
   * Deletes a room bookmark from the user's PEP storage.
   * The room will no longer appear in bookmarks or auto-join.
   *
   * @param roomJid - The room JID to remove from bookmarks
   *
   * @example
   * ```typescript
   * await client.muc.removeBookmark('room@conference.example.com')
   * ```
   *
   * @remarks
   * - Does not leave the room if currently joined
   * - Does not remove the room from the local store
   */
  async removeBookmark(roomJid: string): Promise<void> {
    const iq = xml(
      'iq',
      { type: 'set', id: `bookmark_remove_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('retract', { node: NS_BOOKMARKS },
          xml('item', { id: roomJid })
        )
      )
    )

    await this.deps.sendIQ(iq)

    // SDK event only - binding calls store.removeBookmark
    this.deps.emitSDK('room:bookmark-removed', { roomJid })
  }

  /**
   * Rejoin rooms that were previously active but don't have autojoin enabled.
   *
   * Used during session restoration to rejoin rooms that were joined
   * in the previous session but aren't set to autojoin.
   *
   * @param previouslyJoinedRooms - Array of room info from previous session
   *
   * @example
   * ```typescript
   * // Typically called during reconnection
   * await client.muc.rejoinActiveRooms([
   *   { jid: 'room1@conference.example.com', nickname: 'Me' },
   *   { jid: 'room2@conference.example.com', nickname: 'Me', password: 'pass' }
   * ])
   * ```
   *
   * @remarks
   * - Skips rooms that have autojoin enabled (they're joined automatically)
   * - Errors for individual rooms are logged but don't stop other rejoins
   */
  async rejoinActiveRooms(previouslyJoinedRooms: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>): Promise<void> {
    const roomsToRejoin = previouslyJoinedRooms.filter(room => !room.autojoin)
    if (roomsToRejoin.length === 0) return

    for (const room of roomsToRejoin) {
      try {
        await this.joinRoom(room.jid, room.nickname, { password: room.password })
      } catch (err) {
        console.error(`[MUC] Failed to rejoin ${room.jid}:`, err)
      }
    }
  }

  /**
   * Fetch public room list from a MUC service.
   *
   * Uses service discovery to get a list of public rooms available
   * on the specified MUC service. Supports pagination via RSM.
   *
   * @param mucServiceJid - The MUC service JID (e.g., 'conference.example.com')
   * @param rsm - Optional pagination parameters
   * @returns List of rooms and pagination info
   *
   * @example
   * ```typescript
   * // Fetch first page of rooms
   * const { rooms, pagination } = await client.muc.fetchRoomList('conference.example.com', { max: 20 })
   *
   * // Fetch next page
   * if (pagination?.last) {
   *   const nextPage = await client.muc.fetchRoomList('conference.example.com', {
   *     max: 20,
   *     after: pagination.last
   *   })
   * }
   * ```
   */
  async fetchRoomList(mucServiceJid: string, rsm?: RSMRequest): Promise<{ rooms: AdminRoom[]; pagination?: RSMResponse }> {
    const iq = xml('iq', { type: 'get', to: mucServiceJid, id: `disco_items_${generateUUID()}` },
      xml('query', { xmlns: NS_DISCO_ITEMS },
        rsm ? xml('set', { xmlns: NS_RSM },
          rsm.max ? xml('max', {}, String(rsm.max)) : undefined,
          rsm.after ? xml('after', {}, rsm.after) : undefined,
          rsm.before ? xml('before', {}, rsm.before) : undefined
        ) : undefined
      )
    )

    const response = await this.deps.sendIQ(iq)
    const query = response.getChild('query', NS_DISCO_ITEMS)
    const rooms: AdminRoom[] = []

    if (query) {
      for (const item of query.getChildren('item')) {
        rooms.push({
          jid: item.attrs.jid,
          name: item.attrs.name || getLocalPart(item.attrs.jid),
        })
      }
    }

    const rsmEl = query?.getChild('set', NS_RSM)
    const pagination: RSMResponse | undefined = rsmEl ? {
      first: rsmEl.getChildText('first') || undefined,
      last: rsmEl.getChildText('last') || undefined,
      count: rsmEl.getChildText('count') ? parseInt(rsmEl.getChildText('count')!, 10) : undefined,
    } : undefined

    return { rooms, pagination }
  }

  /**
   * Fetch room configuration options (XEP-0045 room configuration).
   *
   * Retrieves the current configuration form for a room. Only room
   * owners can typically access this information.
   *
   * @param roomJid - The room JID
   * @returns Configuration key-value pairs, or null if unavailable
   *
   * @example
   * ```typescript
   * const options = await client.muc.fetchRoomOptions('room@conference.example.com')
   * if (options) {
   *   console.log('Room name:', options['muc#roomconfig_roomname'])
   *   console.log('Persistent:', options['muc#roomconfig_persistentroom'])
   * }
   * ```
   *
   * @remarks
   * - Requires owner affiliation to access
   * - Returns data form fields as key-value pairs
   * - Multi-value fields are returned as arrays
   */
  async fetchRoomOptions(roomJid: string): Promise<Record<string, string | string[]> | null> {
    try {
      const iq = xml('iq', { type: 'get', to: roomJid, id: `room_config_${generateUUID()}` },
        xml('query', { xmlns: NS_MUC_OWNER })
      )

      const response = await this.deps.sendIQ(iq)
      const x = response.getChild('query', NS_MUC_OWNER)?.getChild('x', NS_DATA_FORMS)
      if (!x) return null

      const options: Record<string, string | string[]> = {}
      for (const field of x.getChildren('field')) {
        const name = field.attrs.var
        if (!name) continue
        const values = field.getChildren('value').map(v => v.getText())
        options[name] = values.length > 1 ? values : (values[0] || '')
      }

      return options
    } catch (err) {
      console.error(`[MUC] Failed to fetch room options for ${roomJid}:`, err)
      return null
    }
  }
}
