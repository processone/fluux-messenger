import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getBareJid, getLocalPart, getDomain } from '../jid'
import type { VCardInfo } from '../types/roster'
import { generateUUID } from '../../utils/uuid'
import { getCachedAvatar, getAvatarHash, cacheAvatar, saveAvatarHash, getAllAvatarHashes, hasNoAvatar, markNoAvatar, clearNoAvatar, refreshAllBlobUrls, isPepForbiddenDomain, markPepForbiddenDomain, loadPepForbiddenDomains } from '../../utils/avatarCache'
import {
  NS_PUBSUB,
  NS_NICK,
  NS_APPEARANCE,
  NS_VCARD_TEMP,
  NS_REGISTER,
  NS_AVATAR_METADATA,
  NS_AVATAR_DATA,
} from '../namespaces'

/**
 * Profile management module for user and room profiles.
 *
 * Handles profile-related operations including:
 * - XEP-0084: User Avatar (PEP-based avatars)
 * - XEP-0054: vCard-temp (legacy avatars for contacts and rooms)
 * - XEP-0172: User Nickname (PEP-based nicknames)
 * - XEP-0223: Private PEP storage (appearance settings)
 * - XEP-0077: In-Band Registration (password change)
 *
 * @remarks
 * Avatars are fetched via XEP-0084 PEP first, falling back to XEP-0054 vCard-temp.
 * Room avatars always use vCard-temp as MUC rooms don't support PEP.
 *
 * @example
 * ```typescript
 * // Access via XMPPClient
 * client.profile.publishOwnAvatar(base64Data, 'image/png', 256, 256)
 * client.profile.publishOwnNickname('My Nickname')
 * client.profile.fetchOwnProfile()
 * client.profile.changePassword('newPassword')
 * ```
 *
 * @category Modules
 */
export class Profile extends BaseModule {
  // Note: PubSub events are now handled by the PubSub module.
  // Profile module focuses on outgoing operations (publish avatar, set nickname)
  // and data fetching (fetchAvatarData, fetchVCardAvatar, fetchRoomAvatar).

  /**
   * Handle incoming stanzas.
   * Profile doesn't handle stanzas directly - PubSub module handles PubSub events.
   */
  handle(_stanza: Element): boolean {
    return false
  }

  /**
   * Fetch avatar data from PEP (XEP-0084) or VCard (XEP-0054).
   */
  async fetchAvatarData(jid: string, hash: string): Promise<void> {
    const bareJid = getBareJid(jid)

    // Check IndexedDB cache first - skip network if we already have this avatar
    const cachedUrl = await getCachedAvatar(hash)
    if (cachedUrl) {
      this.updateAvatar(bareJid, cachedUrl, hash)
      return
    }

    // Skip PEP for domains known to block PubSub avatar access
    const domain = getDomain(bareJid)
    if (isPepForbiddenDomain(domain)) {
      await this.fetchVCardAvatar(bareJid)
      return
    }

    try {
      // Try XEP-0084 (PEP) first
      const iq = xml('iq', { type: 'get', to: bareJid, id: `avatar_${generateUUID()}` },
        xml('pubsub', { xmlns: NS_PUBSUB },
          xml('items', { node: `urn:xmpp:avatar:data` },
            xml('item', { id: hash })
          )
        )
      )
      const result = await this.deps.sendIQ(iq)
      const data = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChild('item')?.getChild('data', 'urn:xmpp:avatar:data')?.text()

      if (data) {
        // Cache to IndexedDB and get a blob URL
        const blobUrl = await cacheAvatar(hash, data, 'image/png')
        await saveAvatarHash(bareJid, hash, 'contact')
        this.updateAvatar(bareJid, blobUrl, hash)
        // Clear negative cache since we found an avatar
        await clearNoAvatar(bareJid)
      } else {
        // Fallback to VCard
        await this.fetchVCardAvatar(bareJid)
      }
    } catch (err: any) {
      // Learn from forbidden/service-unavailable: cache the domain to skip PEP next time
      const condition = err?.condition as string | undefined
      if (condition === 'forbidden' || condition === 'service-unavailable') {
        markPepForbiddenDomain(domain).catch(() => {})
      }
      await this.fetchVCardAvatar(bareJid)
    }
  }

  /**
   * Fetch a contact's avatar metadata from XEP-0084 PEP.
   *
   * This is used when a contact's presence has an empty <photo/> element
   * in XEP-0153 (vcard-temp:x:update), indicating they may use XEP-0084
   * PEP-based avatars instead. Clients like Conversations use XEP-0084.
   *
   * @param jid - The contact's JID
   * @returns The avatar hash if found, null otherwise
   */
  async fetchContactAvatarMetadata(jid: string): Promise<string | null> {
    const bareJid = getBareJid(jid)

    // Check negative cache first - skip if we recently confirmed no avatar
    if (await hasNoAvatar(bareJid)) {
      return null
    }

    // Skip PEP for domains known to block PubSub avatar access
    const domain = getDomain(bareJid)
    if (isPepForbiddenDomain(domain)) {
      await this.fetchVCardAvatar(bareJid)
      return null
    }

    try {
      // Query contact's PEP node for avatar metadata
      const metadataIq = xml(
        'iq',
        { type: 'get', to: bareJid, id: `avatar_meta_${generateUUID()}` },
        xml('pubsub', { xmlns: NS_PUBSUB },
          xml('items', { node: NS_AVATAR_METADATA, max_items: '1' })
        )
      )

      const metadataResult = await this.deps.sendIQ(metadataIq)

      // Parse metadata response
      const pubsub = metadataResult.getChild('pubsub', NS_PUBSUB)
      const items = pubsub?.getChild('items')
      const item = items?.getChild('item')
      const metadata = item?.getChild('metadata', NS_AVATAR_METADATA)
      const info = metadata?.getChild('info')

      if (!info) {
        // No avatar set via XEP-0084, try vCard-temp (XEP-0054) as fallback
        await this.fetchVCardAvatar(bareJid)
        return null
      }

      const hash = info.attrs.id

      if (hash) {
        // Found an avatar - clear any negative cache entry
        await clearNoAvatar(bareJid)
        // Emit the same event that XEP-0153 would emit, so existing
        // avatar fetching logic handles it consistently
        this.deps.emit('avatarMetadataUpdate', bareJid, hash)
        return hash
      }
    } catch (err: any) {
      // Learn from forbidden/service-unavailable: cache the domain to skip PEP next time
      const condition = err?.condition as string | undefined
      if (condition === 'forbidden' || condition === 'service-unavailable') {
        markPepForbiddenDomain(domain).catch(() => {})
      }
      // Contact may not support XEP-0084 or PEP, try vCard-temp (XEP-0054) as fallback
      await this.fetchVCardAvatar(bareJid)
    }

    return null
  }

  /**
   * Fetch vCard profile information for a JID (XEP-0054).
   *
   * Returns selected fields (full name, organisation, email, country)
   * for display in user info popovers. For room occupants in anonymous
   * rooms, pass the full occupant JID (room@conf/nick).
   *
   * @param jid - The bare JID or full occupant JID to query
   * @returns VCardInfo with available fields, or null on error
   */
  async fetchVCard(jid: string): Promise<VCardInfo | null> {
    const iq = xml('iq', { type: 'get', to: jid, id: `vcard_${generateUUID()}` },
      xml('vCard', { xmlns: NS_VCARD_TEMP })
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const vcard = result.getChild('vCard', NS_VCARD_TEMP)
      if (!vcard) return null

      const fullName = vcard.getChildText('FN') || undefined
      const org = vcard.getChild('ORG')?.getChildText('ORGNAME') || undefined
      const email = vcard.getChild('EMAIL')?.getChildText('USERID') || undefined
      const adr = vcard.getChild('ADR')
      const country = adr?.getChildText('CTRY') || undefined

      // Return null if no fields were found
      if (!fullName && !org && !email && !country) return null

      return { fullName, org, email, country }
    } catch {
      return null
    }
  }

  async fetchVCardAvatar(jid: string): Promise<void> {
    const bareJid = getBareJid(jid)

    // Check negative cache first - skip if we recently confirmed no avatar
    if (await hasNoAvatar(bareJid)) {
      return
    }

    const iq = xml('iq', { type: 'get', to: bareJid, id: `vcard_${generateUUID()}` },
      xml('vCard', { xmlns: NS_VCARD_TEMP })
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const vcard = result.getChild('vCard', NS_VCARD_TEMP)
      const photo = vcard?.getChild('PHOTO')
      const binval = photo?.getChildText('BINVAL')
      const type = photo?.getChildText('TYPE') || 'image/png'

      if (binval) {
        const avatarUrl = `data:${type};base64,${binval.replace(/\s/g, '')}`
        this.updateAvatar(bareJid, avatarUrl, null)
        // Clear negative cache since we found an avatar
        await clearNoAvatar(bareJid)
      } else {
        // vCard exists but has no photo - mark as no avatar
        await markNoAvatar(bareJid, 'contact')
      }
    } catch {
      // vCard query failed - mark as no avatar for now
      await markNoAvatar(bareJid, 'contact')
    }
  }

  /**
   * Fetch a room's avatar from its vCard (XEP-0054).
   * MUC rooms don't support PEP, so avatars are always via vCard-temp.
   *
   * @param roomJid - The room's bare JID
   * @param knownHash - Optional hash from XEP-0153 presence (used for cache key)
   */
  /**
   * Fetch an occupant's avatar from their vCard (XEP-0398).
   *
   * XEP-0398 defines how MUC occupant avatars work:
   * - For non-anonymous rooms: we can use the real JID to fetch via XEP-0084/XEP-0054
   * - For anonymous rooms: we query the vCard via the occupant's room JID (room@conf/nick)
   *
   * @param roomJid - The room's bare JID
   * @param nick - The occupant's nickname
   * @param avatarHash - The avatar hash from XEP-0153 presence
   * @param realJid - The occupant's real JID (if available in non-anonymous rooms)
   */
  async fetchOccupantAvatar(
    roomJid: string,
    nick: string,
    avatarHash: string,
    realJid?: string
  ): Promise<void> {
    // Check privacy options: if avatar fetching is disabled for anonymous rooms
    // and we don't have a real JID (meaning we'd query via room@conf/nick),
    // skip fetching to protect user privacy
    if (this.deps.privacyOptions?.disableOccupantAvatarsInAnonymousRooms && !realJid) {
      return
    }

    // Check cache first using the hash
    const cachedUrl = await getCachedAvatar(avatarHash)
    if (cachedUrl) {
      this.deps.emitSDK('room:occupant-avatar', {
        roomJid,
        nick,
        avatar: cachedUrl,
        avatarHash,
      })
      return
    }

    // If we have a real JID, try to fetch from their PEP or vCard
    if (realJid) {
      const bareJid = getBareJid(realJid)
      const domain = getDomain(bareJid)

      // The presence advertises an avatar hash, which is a positive signal
      // that the user now has an avatar. Clear any stale negative cache entry
      // (they may have been marked as "no avatar" from a previous session).
      await clearNoAvatar(bareJid)

      // Skip PEP for domains known to block PubSub avatar access
      if (!isPepForbiddenDomain(domain)) {
        try {
          // Try XEP-0084 (PEP) first
          const iq = xml('iq', { type: 'get', to: bareJid, id: `avatar_${generateUUID()}` },
            xml('pubsub', { xmlns: NS_PUBSUB },
              xml('items', { node: NS_AVATAR_DATA },
                xml('item', { id: avatarHash })
              )
            )
          )
          const result = await this.deps.sendIQ(iq)
          const data = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChild('item')?.getChild('data', NS_AVATAR_DATA)?.text()

          if (data) {
            const mimeType = 'image/png'
            const blobUrl = await cacheAvatar(avatarHash, data, mimeType)
            await clearNoAvatar(bareJid)
            // Persist JID→hash mapping so we can restore from cache on next session
            await saveAvatarHash(bareJid, avatarHash, 'contact')
            this.deps.emitSDK('room:occupant-avatar', {
              roomJid,
              nick,
              avatar: blobUrl,
              avatarHash,
            })
            return
          }
        } catch (err: any) {
          // Learn from forbidden/service-unavailable: cache the domain to skip PEP next time
          const condition = err?.condition as string | undefined
          if (condition === 'forbidden' || condition === 'service-unavailable') {
            markPepForbiddenDomain(domain).catch(() => {})
          }
          // Fall through to vCard fetch
        }
      }

      // Try vCard-temp (XEP-0054)
      try {
        const vcardIq = xml('iq', { type: 'get', to: bareJid, id: `vcard_${generateUUID()}` },
          xml('vCard', { xmlns: NS_VCARD_TEMP })
        )
        const result = await this.deps.sendIQ(vcardIq)
        const photo = result.getChild('vCard', NS_VCARD_TEMP)?.getChild('PHOTO')
        const binval = photo?.getChildText('BINVAL')

        if (binval) {
          const mimeType = photo?.getChildText('TYPE') || 'image/png'
          const base64 = binval.replace(/\s/g, '')
          const blobUrl = await cacheAvatar(avatarHash, base64, mimeType)
          await clearNoAvatar(bareJid)
          // Persist JID→hash mapping so we can restore from cache on next session
          await saveAvatarHash(bareJid, avatarHash, 'contact')
          this.deps.emitSDK('room:occupant-avatar', {
            roomJid,
            nick,
            avatar: blobUrl,
            avatarHash,
          })
          return
        } else {
          // vCard exists but no photo - mark as no avatar
          await markNoAvatar(bareJid, 'contact')
        }
      } catch {
        // vCard fetch failed - mark as no avatar
        await markNoAvatar(bareJid, 'contact')
      }
      return
    }

    // No real JID - fetch via occupant's room JID (anonymous room)
    // Per XEP-0398, query vCard via room@conference.example.com/nickname
    const occupantJid = `${roomJid}/${nick}`
    try {
      const iq = xml('iq', { type: 'get', to: occupantJid, id: `vcard_${generateUUID()}` },
        xml('vCard', { xmlns: NS_VCARD_TEMP })
      )
      const result = await this.deps.sendIQ(iq)
      const photo = result.getChild('vCard', NS_VCARD_TEMP)?.getChild('PHOTO')
      const binval = photo?.getChildText('BINVAL')

      if (binval) {
        const mimeType = photo?.getChildText('TYPE') || 'image/png'
        const base64 = binval.replace(/\s/g, '')
        const blobUrl = await cacheAvatar(avatarHash, base64, mimeType)
        this.deps.emitSDK('room:occupant-avatar', {
          roomJid,
          nick,
          avatar: blobUrl,
          avatarHash,
        })
      }
    } catch {
      // Silently fail - avatar fetch failed or occupant has no avatar
    }
  }

  async fetchRoomAvatar(roomJid: string, knownHash?: string): Promise<void> {
    const bareJid = getBareJid(roomJid)

    // If we have a known hash, check cache first
    if (knownHash) {
      const cachedUrl = await getCachedAvatar(knownHash)
      if (cachedUrl) {
        this.deps.emitSDK('room:updated', {
          roomJid: bareJid,
          updates: { avatar: cachedUrl, avatarHash: knownHash },
        })
        return
      }
    }

    // Check negative cache - skip if we recently confirmed no avatar
    // Only skip if we don't have a known hash (hash means presence advertised an avatar)
    if (!knownHash && await hasNoAvatar(bareJid)) {
      return
    }

    const iq = xml('iq', { type: 'get', to: bareJid, id: `vcard_${generateUUID()}` },
      xml('vCard', { xmlns: NS_VCARD_TEMP })
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const vcard = result.getChild('vCard', NS_VCARD_TEMP)
      const photo = vcard?.getChild('PHOTO')
      const binval = photo?.getChildText('BINVAL')

      if (binval) {
        const base64 = binval.replace(/\s/g, '')
        const mimeType = photo?.getChildText('TYPE') || 'image/png'

        // Use known hash from presence, or generate one from data
        const hash = knownHash || generateUUID()

        // Cache the avatar and save hash mapping
        const blobUrl = await cacheAvatar(hash, base64, mimeType)
        await saveAvatarHash(bareJid, hash, 'room')
        // Clear negative cache since we found an avatar
        await clearNoAvatar(bareJid)

        this.deps.emitSDK('room:updated', {
          roomJid: bareJid,
          updates: { avatar: blobUrl, avatarHash: hash },
        })
      } else {
        // vCard exists but has no photo - mark as no avatar
        await markNoAvatar(bareJid, 'room')
      }
    } catch (err) {
      // item-not-found is expected when a room has no avatar set
      const isNotFound = err instanceof Error && err.message.includes('item-not-found')
      if (isNotFound) {
        // Room definitively has no avatar - cache this
        await markNoAvatar(bareJid, 'room')
      } else {
        // Network or other error - don't cache, might succeed next time
        console.error('Failed to fetch room avatar:', err)
      }
    }
  }

  private updateAvatar(jid: string, avatar: string | null, hash: string | null): void {
    const bareJid = getBareJid(jid)
    const currentJid = this.deps.getCurrentJid()

    if (bareJid === getBareJid(currentJid ?? '')) {
      this.deps.emitSDK('connection:own-avatar', { avatar, hash })
    } else {
      this.deps.emitSDK('roster:avatar', { jid: bareJid, avatar, avatarHash: hash ?? undefined })
    }
  }

  /**
   * Fetch a contact's nickname from their PEP (XEP-0172 User Nickname).
   * Returns null if not set or on error.
   *
   * Note: This method only returns the contact's self-published nickname.
   * It does NOT update the roster name, which is set by the local user and
   * should be preserved. The app can display the PEP nickname separately
   * if desired (e.g., in the contact profile view).
   */
  async fetchContactNickname(jid: string): Promise<string | null> {
    const bareJid = getBareJid(jid)
    const iq = xml('iq', { type: 'get', to: bareJid, id: `nick_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_NICK, max_items: '1' })
      )
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const nick = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChild('item')?.getChild('nick', NS_NICK)?.text()
      if (nick) {
        return nick
      }
    } catch {
      // Contact may not have a nickname set
    }
    return null
  }

  /**
   * Fetch own nickname from PEP (XEP-0172 User Nickname).
   */
  async fetchOwnNickname(): Promise<string | null> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return null

    const bareJid = getBareJid(currentJid)
    const iq = xml('iq', { type: 'get', to: bareJid, id: `nick_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_NICK, max_items: '1' })
      )
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const nick = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChild('item')?.getChild('nick', NS_NICK)?.text()
      if (nick) {
        this.deps.emitSDK('connection:own-nickname', { nickname: nick })
        return nick
      }
    } catch {
      // Own nickname might not be set
    }
    return null
  }

  /**
   * Publish own nickname to PEP (XEP-0172 User Nickname).
   */
  async publishOwnNickname(nickname: string): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    const trimmedNickname = nickname.trim()
    if (!trimmedNickname) {
      throw new Error('Nickname cannot be empty')
    }

    const iq = xml('iq', { type: 'set', id: `nick_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: NS_NICK },
          xml('item', { id: 'current' },
            xml('nick', { xmlns: NS_NICK }, trimmedNickname)
          )
        )
      )
    )
    await this.deps.sendIQ(iq)
    this.deps.emitSDK('connection:own-nickname', { nickname: trimmedNickname })
  }

  /**
   * Clear/remove own nickname from PEP (XEP-0172).
   */
  async clearOwnNickname(): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    const iq = xml('iq', { type: 'set', id: `nick_clear_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('retract', { node: NS_NICK },
          xml('item', { id: 'current' })
        )
      )
    )
    await this.deps.sendIQ(iq)
    this.deps.emitSDK('connection:own-nickname', { nickname: null })
  }

  /**
   * Fetch own vCard (XEP-0054 vcard-temp).
   * Emits `connection:own-vcard` event so the store picks it up.
   */
  async fetchOwnVCard(): Promise<VCardInfo | null> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return null

    const bareJid = getBareJid(currentJid)
    const vcard = await this.fetchVCard(bareJid)
    this.deps.emitSDK('connection:own-vcard', { vcard })
    return vcard
  }

  /**
   * Publish own vCard fields (XEP-0054 vcard-temp).
   *
   * Fetches the current vCard first to preserve fields we don't edit (e.g. PHOTO),
   * then merges the provided fields and sends `<iq type="set">`.
   */
  async publishOwnVCard(info: VCardInfo): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    // Fetch current vCard to preserve PHOTO and other unmanaged fields
    const bareJid = getBareJid(this.deps.getCurrentJid()!)
    let existingVCardEl: import('@xmpp/client').Element | null = null
    try {
      const getIq = xml('iq', { type: 'get', to: bareJid, id: `vcard_get_${generateUUID()}` },
        xml('vCard', { xmlns: NS_VCARD_TEMP })
      )
      const result = await this.deps.sendIQ(getIq)
      existingVCardEl = result.getChild('vCard', NS_VCARD_TEMP) ?? null
    } catch {
      // No existing vCard, we'll create a fresh one
    }

    // Build new vCard, preserving children we don't manage
    const managedTags = new Set(['FN', 'ORG', 'EMAIL', 'ADR'])
    const children: ReturnType<typeof xml>[] = []

    // Preserve unmanaged children (e.g. PHOTO)
    if (existingVCardEl) {
      for (const child of existingVCardEl.children) {
        if (typeof child === 'object' && 'name' in child && !managedTags.has(child.name)) {
          children.push(child as ReturnType<typeof xml>)
        }
      }
    }

    // Add managed fields
    if (info.fullName) {
      children.push(xml('FN', {}, info.fullName))
    }
    if (info.org) {
      children.push(xml('ORG', {}, xml('ORGNAME', {}, info.org)))
    }
    if (info.email) {
      children.push(xml('EMAIL', {}, xml('USERID', {}, info.email)))
    }
    if (info.country) {
      children.push(xml('ADR', {}, xml('CTRY', {}, info.country)))
    }

    const setIq = xml('iq', { type: 'set', id: `vcard_set_${generateUUID()}` },
      xml('vCard', { xmlns: NS_VCARD_TEMP }, ...children)
    )
    await this.deps.sendIQ(setIq)
    this.deps.emitSDK('connection:own-vcard', { vcard: info })
  }

  /**
   * Fetch appearance settings from private PEP storage (XEP-0223).
   * Returns mode (required) plus optional themeId, fontSize, and accentPreset.
   */
  async fetchAppearance(): Promise<{ mode: string; themeId?: string; fontSize?: number; accentPreset?: string } | null> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return null

    const bareJid = getBareJid(currentJid)
    const iq = xml('iq', { type: 'get', to: bareJid, id: `appearance_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_APPEARANCE, max_items: '1' })
      )
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const item = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChild('item')
      const appearance = item?.getChild('appearance', NS_APPEARANCE)
      if (appearance) {
        // Read 'mode' (new format) or 'theme' (legacy format) for backwards compatibility
        // TODO: Remove 'theme' fallback before 1.0 release
        const mode = appearance.getChildText('mode') || appearance.getChildText('theme')
        if (mode) {
          const result: { mode: string; themeId?: string; fontSize?: number; accentPreset?: string } = { mode }
          const themeId = appearance.getChildText('themeId')
          if (themeId) result.themeId = themeId
          const fontSize = appearance.getChildText('fontSize')
          if (fontSize) result.fontSize = Number(fontSize)
          const accentPreset = appearance.getChildText('accentPreset')
          if (accentPreset) result.accentPreset = accentPreset
          return result
        }
      }
    } catch {
      // Appearance not set
    }
    return null
  }

  /**
   * Save appearance settings to private PEP storage (XEP-0223).
   */
  async setAppearance(settings: { mode: string; themeId?: string; fontSize?: number; accentPreset?: string }): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    const children = [xml('mode', {}, settings.mode)]
    if (settings.themeId) children.push(xml('themeId', {}, settings.themeId))
    if (settings.fontSize != null) children.push(xml('fontSize', {}, String(settings.fontSize)))
    if (settings.accentPreset) children.push(xml('accentPreset', {}, settings.accentPreset))

    const iq = xml('iq', { type: 'set', id: `appearance_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: NS_APPEARANCE },
          xml('item', { id: 'current' },
            xml('appearance', { xmlns: NS_APPEARANCE }, ...children)
          )
        ),
        // XEP-0223: Publish options for private storage
        xml('publish-options', {},
          xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
            xml('field', { var: 'FORM_TYPE', type: 'hidden' },
              xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')
            ),
            xml('field', { var: 'pubsub#persist_items' },
              xml('value', {}, 'true')
            ),
            xml('field', { var: 'pubsub#access_model' },
              xml('value', {}, 'whitelist')
            )
          )
        )
      )
    )
    await this.deps.sendIQ(iq)
  }

  /**
   * Fetch own profile data (avatar and nickname) from PEP.
   */
  async fetchOwnProfile(): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return

    await Promise.allSettled([
      this.fetchOwnAvatar(),
      this.fetchOwnNickname(),
      this.fetchOwnVCard(),
    ])
  }

  /**
   * Fetch own avatar from PEP (XEP-0084).
   * First queries metadata to get the hash, then fetches data.
   */
  async fetchOwnAvatar(): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return

    const bareJid = getBareJid(currentJid)

    try {
      // Query our own PEP node for avatar metadata
      const metadataIq = xml(
        'iq',
        { type: 'get', to: bareJid, id: `avatar_meta_${generateUUID()}` },
        xml('pubsub', { xmlns: NS_PUBSUB },
          xml('items', { node: NS_AVATAR_METADATA, max_items: '1' })
        )
      )

      const metadataResult = await this.deps.sendIQ(metadataIq)

      // Parse metadata response
      const pubsub = metadataResult.getChild('pubsub', NS_PUBSUB)
      const items = pubsub?.getChild('items')
      const item = items?.getChild('item')
      const metadata = item?.getChild('metadata', NS_AVATAR_METADATA)
      const info = metadata?.getChild('info')

      if (!info) {
        // No avatar set
        return
      }

      const hash = info.attrs.id
      const mimeType = info.attrs.type || 'image/png'

      if (!hash) return

      // Check cache first
      const cachedUrl = await getCachedAvatar(hash)
      if (cachedUrl) {
        this.deps.emitSDK('connection:own-avatar', { avatar: cachedUrl, hash })
        return
      }

      // Fetch avatar data
      const dataIq = xml(
        'iq',
        { type: 'get', to: bareJid, id: `avatar_data_${generateUUID()}` },
        xml('pubsub', { xmlns: NS_PUBSUB },
          xml('items', { node: NS_AVATAR_DATA },
            xml('item', { id: hash })
          )
        )
      )

      const dataResult = await this.deps.sendIQ(dataIq)

      const dataPubsub = dataResult.getChild('pubsub', NS_PUBSUB)
      const dataItems = dataPubsub?.getChild('items')
      const dataItem = dataItems?.getChild('item')
      const data = dataItem?.getChild('data', NS_AVATAR_DATA)

      if (data) {
        const base64 = data.text()
        if (base64) {
          const blobUrl = await cacheAvatar(hash, base64, mimeType)
          await saveAvatarHash(bareJid, hash, 'contact')
          this.deps.emitSDK('connection:own-avatar', { avatar: blobUrl, hash })
        }
      }
    } catch {
      // Own avatar might not be set, this is normal
    }
  }

  async publishOwnAvatar(imageData: string, mimeType: string, _width: number, _height: number): Promise<void> {
    const base64Data = imageData.split(',')[1] || imageData
    const hash = generateUUID() // Should ideally be SHA-1 of data

    // XEP-0084: Publish data
    const dataIq = xml('iq', { type: 'set', id: `avatar_pub_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: 'urn:xmpp:avatar:data' },
          xml('item', { id: hash },
            xml('data', { xmlns: 'urn:xmpp:avatar:data' }, base64Data)
          )
        )
      )
    )
    await this.deps.sendIQ(dataIq)

    // XEP-0084: Publish metadata
    const metadataIq = xml('iq', { type: 'set', id: `avatar_meta_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: 'urn:xmpp:avatar:metadata' },
          xml('item', { id: hash },
            xml('metadata', { xmlns: 'urn:xmpp:avatar:metadata' },
              xml('info', {
                id: hash,
                type: mimeType,
                bytes: String(Math.round(base64Data.length * 0.75)),
              })
            )
          )
        )
      )
    )
    await this.deps.sendIQ(metadataIq)
    
    this.updateAvatar(this.deps.getCurrentJid()!, imageData, hash)
  }

  async clearOwnAvatar(): Promise<void> {
    const iq = xml('iq', { type: 'set', id: `avatar_clear_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: 'urn:xmpp:avatar:metadata' },
          xml('item', {})
        )
      )
    )
    await this.deps.sendIQ(iq)
    this.updateAvatar(this.deps.getCurrentJid()!, null, null)
  }

  async setRoomAvatar(roomJid: string, imageData: string, _mimeType: string): Promise<void> {
    // Legacy VCard-based room avatar update
    const base64Data = imageData.split(',')[1] || imageData
    const iq = xml('iq', { type: 'set', to: roomJid, id: `room_avatar_${generateUUID()}` },
      xml('vCard', { xmlns: NS_VCARD_TEMP },
        xml('PHOTO', {},
          xml('BINVAL', {}, base64Data)
        )
      )
    )
    await this.deps.sendIQ(iq)
    this.deps.emitSDK('room:updated', { roomJid, updates: { avatar: imageData } })
  }

  async clearRoomAvatar(roomJid: string): Promise<void> {
    const iq = xml('iq', { type: 'set', to: roomJid, id: `room_avatar_clear_${generateUUID()}` },
      xml('vCard', { xmlns: NS_VCARD_TEMP },
        xml('PHOTO', {})
      )
    )
    await this.deps.sendIQ(iq)
    this.deps.emitSDK('room:updated', { roomJid, updates: { avatar: undefined } })
  }

  // --- Avatar Cache Restore Methods ---

  async restoreContactAvatarFromCache(jid: string, avatarHash: string): Promise<boolean> {
    try {
      const cachedUrl = await getCachedAvatar(avatarHash)
      if (cachedUrl) {
        this.deps.emitSDK('roster:avatar', { jid, avatar: cachedUrl, avatarHash })
        return true
      }
    } catch (error) {
      console.error('Failed to restore contact avatar from cache:', jid, error)
    }
    return false
  }

  async restoreOwnAvatarFromCache(avatarHash: string): Promise<boolean> {
    try {
      const cachedUrl = await getCachedAvatar(avatarHash)
      if (cachedUrl) {
        this.deps.emitSDK('connection:own-avatar', { avatar: cachedUrl, hash: avatarHash })
        return true
      }
    } catch (error) {
      console.error('Failed to restore own avatar from cache:', error)
    }
    return false
  }

  async restoreRoomAvatarFromCache(roomJid: string, avatarHash: string): Promise<boolean> {
    try {
      const cachedUrl = await getCachedAvatar(avatarHash)
      if (cachedUrl) {
        this.deps.emitSDK('room:updated', { roomJid, updates: { avatar: cachedUrl, avatarHash } })
        return true
      }
    } catch (error) {
      console.error('Failed to restore room avatar from cache:', roomJid, error)
    }
    return false
  }

  async tryRestoreRoomAvatar(roomJid: string): Promise<boolean> {
    try {
      const hash = await getAvatarHash(roomJid)
      if (hash) {
        return this.restoreRoomAvatarFromCache(roomJid, hash)
      }
    } catch (error) {
      console.error('Failed to lookup room avatar hash:', roomJid, error)
    }
    return false
  }

  /**
   * Restore avatar hashes and blob URLs for all contacts from IndexedDB cache.
   * This is called after roster load to populate avatars for offline contacts.
   */
  async restoreAllContactAvatarHashes(): Promise<void> {
    // Load PEP-forbidden domains before avatar fetches begin
    await loadPepForbiddenDomains().catch(() => {})

    try {
      const mappings = await getAllAvatarHashes('contact')
      for (const mapping of mappings) {
        const contact = this.deps.stores?.roster.getContact(mapping.jid)
        if (contact && !contact.avatarHash) {
          const cachedUrl = await getCachedAvatar(mapping.hash)
          if (cachedUrl) {
            this.deps.emitSDK('roster:avatar', { jid: mapping.jid, avatar: cachedUrl, avatarHash: mapping.hash })
          } else {
            // At least set the hash so we can try fetching later
            this.deps.emitSDK('roster:avatar', { jid: mapping.jid, avatar: null, avatarHash: mapping.hash })
          }
        }
      }
    } catch (error) {
      // Silently fail - avatar cache is optional
      console.warn('Failed to restore contact avatar hashes:', error)
    }
  }

  /**
   * Restore avatar hashes for all rooms from IndexedDB cache.
   * This is called after bookmarks load to populate avatarHash for bookmarked
   * rooms that aren't currently joined, enabling their cached avatars to display.
   */
  async restoreAllRoomAvatarHashes(): Promise<void> {
    try {
      const mappings = await getAllAvatarHashes('room')
      for (const mapping of mappings) {
        // Only restore if the room exists in store
        const room = this.deps.stores?.room.getRoom(mapping.jid)
        if (room && !room.avatarHash) {
          // Try to restore the full avatar from cache
          const cachedUrl = await getCachedAvatar(mapping.hash)
          if (cachedUrl) {
            this.deps.emitSDK('room:updated', {
              roomJid: mapping.jid,
              updates: { avatar: cachedUrl, avatarHash: mapping.hash },
            })
          } else {
            // At least set the hash so we can try fetching later
            this.deps.emitSDK('room:updated', {
              roomJid: mapping.jid,
              updates: { avatarHash: mapping.hash },
            })
          }
        }
      }
    } catch (error) {
      // Silently fail - avatar cache is optional
      console.warn('Failed to restore room avatar hashes:', error)
    }
  }

  /**
   * Refresh all avatar blob URLs after events that invalidate them
   * (e.g., WebKit reclaiming memory during sleep/SM resumption).
   * Re-creates fresh blob URLs from IndexedDB and updates stores.
   */
  async refreshAllAvatarBlobUrls(): Promise<void> {
    try {
      const freshUrls = await refreshAllBlobUrls()
      if (freshUrls.size === 0) return

      const hashMappings = await getAllAvatarHashes()
      for (const mapping of hashMappings) {
        const url = freshUrls.get(mapping.hash)
        if (!url) continue

        if (mapping.type === 'contact') {
          const contact = this.deps.stores?.roster.getContact(mapping.jid)
          if (contact) {
            this.deps.emitSDK('roster:avatar', { jid: mapping.jid, avatar: url, avatarHash: mapping.hash })
          }
        } else if (mapping.type === 'room') {
          const room = this.deps.stores?.room.getRoom(mapping.jid)
          if (room) {
            this.deps.emitSDK('room:updated', {
              roomJid: mapping.jid,
              updates: { avatar: url, avatarHash: mapping.hash },
            })
          }
        }
      }
    } catch (error) {
      console.warn('Failed to refresh avatar blob URLs:', error)
    }
  }

  /**
   * Restore cached avatars for MUC occupants whose presence didn't include
   * a vcard-temp:x:update hash. Looks up each occupant's real JID in the
   * IndexedDB avatar-hashes store and restores the blob URL if available.
   * Called after room join to fill in avatars from previous sessions.
   */
  async restoreOccupantAvatarsFromCache(roomJid: string): Promise<void> {
    try {
      const room = this.deps.stores?.room.getRoom(roomJid)
      if (!room) return

      for (const [nick, occupant] of room.occupants) {
        // Skip occupants that already have an avatar or don't have a real JID
        if (occupant.avatar || !occupant.jid) continue

        const bareJid = getBareJid(occupant.jid)
        const hash = await getAvatarHash(bareJid)
        if (!hash) continue

        const cachedUrl = await getCachedAvatar(hash)
        if (cachedUrl) {
          this.deps.emitSDK('room:occupant-avatar', {
            roomJid,
            nick,
            avatar: cachedUrl,
            avatarHash: hash,
          })
        }
      }
    } catch {
      // Silently fail - avatar cache is optional
    }
  }

  /**
   * Change the user's password (XEP-0077 In-Band Registration).
   * @param newPassword - The new password to set
   */
  async changePassword(newPassword: string): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) throw new Error('Not connected')

    const username = getLocalPart(currentJid)
    const domain = getDomain(currentJid)

    const iq = xml(
      'iq',
      { type: 'set', to: domain, id: `passwd_${generateUUID()}` },
      xml('query', { xmlns: NS_REGISTER },
        xml('username', {}, username),
        xml('password', {}, newPassword)
      )
    )

    await this.deps.sendIQ(iq)
  }
}
