import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { BaseModule, type ModuleDependencies } from './BaseModule'
import { PepNode, type PepCodec, type PepGetOptions, type PublishOptions } from './PepNode'
import { getBareJid, getLocalPart, getDomain } from '../jid'
import type { ProfileDetails } from '../types/roster'
import { generateUUID } from '../../utils/uuid'
import {
  getCachedAvatar,
  getAvatarHash,
  cacheAvatar,
  saveAvatarHash,
  getAllAvatarHashes,
  tryGetAllAvatarHashes,
  saveRoomOccupantAvatarHash,
  getRoomOccupantAvatarHashes,
  seedRoomOccupantAvatarHashes,
  hasNoAvatar,
  markNoAvatar,
  clearNoAvatar,
  refreshAllBlobUrls,
  isPepForbiddenDomain,
  markPepForbiddenDomain,
  loadPepForbiddenDomains,
} from '../../utils/avatarCache'
import { sniffImageMimeType } from '../../utils/imageType'
import {
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
 * declare const base64Data: string
 *
 * // Access via XMPPClient
 * client.profile.publishOwnAvatar(base64Data, 'image/png', 256, 256)
 * client.profile.publishOwnNickname('My Nickname')
 * client.profile.fetchOwnProfile()
 * client.profile.changePassword('newPassword')
 * ```
 *
 * @category Modules
 */
/** XEP-0172 and the appearance node each keep a single current value. */
const CURRENT_ITEM_ID = 'current'

/** What the appearance node stores. `mode` is required; the rest are optional. */
export interface AppearanceSettings {
  mode: string
  themeId?: string
  fontSize?: number
  accentPreset?: string
}

/** XEP-0223 private storage: owner-only, retained across sessions. */
const APPEARANCE_NODE_OPTIONS: PublishOptions = {
  persistItems: true,
  accessModel: 'whitelist',
}

const appearanceCodec: PepCodec<AppearanceSettings> = {
  encode: (settings) => {
    const children = [xml('mode', {}, settings.mode)]
    if (settings.themeId) children.push(xml('themeId', {}, settings.themeId))
    if (settings.fontSize != null) children.push(xml('fontSize', {}, String(settings.fontSize)))
    if (settings.accentPreset) children.push(xml('accentPreset', {}, settings.accentPreset))
    return xml('appearance', { xmlns: NS_APPEARANCE }, ...children)
  },
  decode: (item) => {
    const appearance = item.getChild('appearance', NS_APPEARANCE)
    if (!appearance) return undefined
    // `theme` is the pre-0.18 name for `mode`, still read so an upgrade keeps
    // the user's choice. Publishing only ever writes `mode`.
    const mode = appearance.getChildText('mode') || appearance.getChildText('theme')
    if (!mode) return undefined
    const settings: AppearanceSettings = { mode }
    const themeId = appearance.getChildText('themeId')
    if (themeId) settings.themeId = themeId
    const fontSize = appearance.getChildText('fontSize')
    if (fontSize) settings.fontSize = Number(fontSize)
    const accentPreset = appearance.getChildText('accentPreset')
    if (accentPreset) settings.accentPreset = accentPreset
    return settings
  },
}

/** XEP-0084 data node: base64 payload keyed by the avatar's SHA-1. */
const avatarDataCodec: PepCodec<string> = {
  encode: (data) => xml('data', { xmlns: NS_AVATAR_DATA }, data),
  decode: (item) => item.getChild('data', NS_AVATAR_DATA)?.text() || undefined,
}

/** What XEP-0084's `<info/>` carries about the current avatar. */
export interface AvatarMetadata {
  /** SHA-1 of the image, and the item id on the data node. */
  hash: string
  mimeType?: string
  bytes?: number
}

/**
 * XEP-0084 metadata node.
 *
 * `null` is the published state "no avatar", which the XEP spells as a
 * `<metadata/>` with no `<info/>` (§4.2) rather than as an absent item. It is a
 * VALUE here because it is one on the wire: peers read it to drop the avatar
 * they hold. `undefined` stays reserved for an item that does not parse.
 */
const avatarMetadataCodec: PepCodec<AvatarMetadata | null> = {
  encode: (meta) => xml('metadata', { xmlns: NS_AVATAR_METADATA },
    ...(meta === null ? [] : [xml('info', {
      id: meta.hash,
      ...(meta.mimeType ? { type: meta.mimeType } : {}),
      ...(meta.bytes === undefined ? {} : { bytes: String(meta.bytes) }),
    })]),
  ),
  decode: (item) => {
    const metadata = item.getChild('metadata', NS_AVATAR_METADATA)
    if (!metadata) return undefined
    const info = metadata.getChild('info')
    if (!info) return null
    const hash = info.attrs.id
    if (!hash) return undefined
    const bytes = Number(info.attrs.bytes)
    return {
      hash,
      ...(info.attrs.type ? { mimeType: info.attrs.type } : {}),
      ...(Number.isFinite(bytes) && info.attrs.bytes ? { bytes } : {}),
    }
  },
}

/** Payload is the bare `<nick/>` text; the node carries no publish-options. */
const nickCodec: PepCodec<string> = {
  encode: (nickname) => xml('nick', { xmlns: NS_NICK }, nickname),
  decode: (item) => item.getChild('nick', NS_NICK)?.text() || undefined,
}

export class Profile extends BaseModule {
  private readonly nickNode: PepNode<string>
  private readonly appearanceNode: PepNode<AppearanceSettings>
  private readonly avatarDataNode: PepNode<string>
  private readonly avatarMetadataNode: PepNode<AvatarMetadata | null>

  constructor(deps: ModuleDependencies) {
    super(deps)
    this.nickNode = new PepNode(deps, NS_NICK, nickCodec)
    this.appearanceNode = new PepNode(deps, NS_APPEARANCE, appearanceCodec, APPEARANCE_NODE_OPTIONS)
    this.avatarDataNode = new PepNode(deps, NS_AVATAR_DATA, avatarDataCodec)
    this.avatarMetadataNode = new PepNode(deps, NS_AVATAR_METADATA, avatarMetadataCodec)
  }

  /**
   * Read a contact's XEP-0084 node, honouring what their server has already
   * told us.
   *
   * A deployment that refuses PEP avatar reads refuses them for every contact it
   * hosts, so the refusal is remembered per DOMAIN and skipped from then on.
   * Only a REFUSAL is remembered: a timeout says nothing about policy, and
   * treating one as a refusal would strand every contact on that domain at the
   * vCard fallback for the rest of the session.
   *
   * Returns an empty array for every non-answer, because the caller's response
   * is the same either way — fall back to vCard.
   */
  private async readContactAvatarNode<T>(
    node: PepNode<T, unknown>,
    contactBareJid: string,
    options: PepGetOptions = {},
  ): Promise<T[]> {
    const contactDomain = getDomain(contactBareJid)
    if (isPepForbiddenDomain(contactDomain)) return []

    const result = await node.get({ ...options, jid: contactBareJid })
    if (result.status === 'refused') {
      markPepForbiddenDomain(contactDomain).catch(() => {})
      return []
    }
    return result.status === 'ok' ? result.items : []
  }

  // Note: PubSub events are now handled by the PubSub module.
  // Profile module focuses on outgoing operations (publish avatar, set nickname)
  // and data fetching (fetchAvatarData, fetchVCardAvatar, fetchRoomAvatar).


  /**
   * Fetch avatar data from PEP (XEP-0084) or VCard (XEP-0054).
   */
  async fetchAvatarData(jid: string, hash: string): Promise<void> {
    const bareJid = getBareJid(jid)

    // Check if we already have this avatar cached
    const cachedUrl = await getCachedAvatar(hash)
    if (cachedUrl) {
      this.updateAvatar(bareJid, cachedUrl, hash)
      return
    }

    const data = (await this.readContactAvatarNode(
      this.avatarDataNode, bareJid, { itemId: hash },
    ))[0]

    if (!data) {
      await this.fetchVCardAvatar(bareJid)
      return
    }

    // XEP-0084 data responses carry no MIME type, so sniff the bytes rather
    // than assume PNG — otherwise animated GIF/WebP/APNG avatars get a Blob
    // typed image/png and any consumer trusting blob.type is misled.
    const mimeType = sniffImageMimeType(data) ?? 'image/png'
    const blobUrl = await cacheAvatar(hash, data, mimeType)
    await saveAvatarHash(bareJid, hash, 'contact')
    this.updateAvatar(bareJid, blobUrl, hash)
    // Clear negative cache since we found an avatar
    await clearNoAvatar(bareJid)
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

    // `null` is the contact stating they have no avatar; both it and an
    // unreadable node fall through to vCard.
    const hash = (await this.readContactAvatarNode(
      this.avatarMetadataNode, bareJid, { maxItems: 1 },
    ))[0]?.hash

    if (!hash) {
      // No avatar via XEP-0084, or the server would not say — either way, fall
      // back to vCard-temp (XEP-0054).
      await this.fetchVCardAvatar(bareJid)
      return null
    }

    // Found an avatar - clear any negative cache entry
    await clearNoAvatar(bareJid)
    // Emit the same event that XEP-0153 would emit, so existing
    // avatar fetching logic handles it consistently
    this.deps.emit('avatarMetadataUpdate', bareJid, hash)
    return hash
  }

  /**
   * Fetch the descriptive fields a JID publishes about itself.
   *
   * Carried over XEP-0054 vcard-temp. For a room occupant in an anonymous
   * room, pass the full occupant JID (room@conf/nick).
   *
   * @param jid - The bare JID or full occupant JID to query
   * @returns The fields the server returned, or null if the query failed
   */
  async fetchProfileDetails(jid: string): Promise<ProfileDetails | null> {
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
   * @param occupantId - XEP-0421 identity, stable within roomJid
   */
  async fetchOccupantAvatar(
    roomJid: string,
    nick: string,
    avatarHash: string,
    realJid?: string,
    occupantId?: string,
  ): Promise<void> {
    // This gate intentionally uses per-presence evidence while restore uses the
    // room's disco result: with the privacy option enabled, fetching/persistence
    // is allowed only when this occupant exposes a real JID; restore is
    // suppressed once disco confirms the room anonymous
    // (`isNonAnonymous === false`).
    if (this.deps.privacyOptions?.disableOccupantAvatarsInAnonymousRooms && !realJid) {
      return
    }

    // Check cache first using the hash
    const cachedUrl = await getCachedAvatar(avatarHash)
    if (cachedUrl) {
      if (occupantId) {
        await saveRoomOccupantAvatarHash(roomJid, occupantId, avatarHash)
      }
      this.deps.emitSDK('room:occupant-avatar', {
        roomJid,
        nick,
        ...(occupantId && { occupantId }),
        avatar: cachedUrl,
        avatarHash,
      })
      return
    }

    // If we have a real JID, try to fetch from their PEP or vCard
    if (realJid) {
      const bareJid = getBareJid(realJid)
      // The presence advertises an avatar hash, which is a positive signal
      // that the user now has an avatar. Clear any stale negative cache entry
      // (they may have been marked as "no avatar" from a previous session).
      await clearNoAvatar(bareJid)

      const data = (await this.readContactAvatarNode(
        this.avatarDataNode, bareJid, { itemId: avatarHash },
      ))[0]

      if (data) {
        // The data node has no MIME type; sniff the bytes so animated
        // avatars aren't cached as image/png (see fetchAvatarData).
        const mimeType = sniffImageMimeType(data) ?? 'image/png'
        const blobUrl = await cacheAvatar(avatarHash, data, mimeType)
        await clearNoAvatar(bareJid)
        // Persist JID→hash mapping so we can restore from cache on next session
        await saveAvatarHash(bareJid, avatarHash, 'contact')
        if (occupantId) {
          await saveRoomOccupantAvatarHash(roomJid, occupantId, avatarHash)
        }
        this.deps.emitSDK('room:occupant-avatar', {
          roomJid,
          nick,
          ...(occupantId && { occupantId }),
          avatar: blobUrl,
          avatarHash,
        })
        return
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
          if (occupantId) {
            await saveRoomOccupantAvatarHash(roomJid, occupantId, avatarHash)
          }
          this.deps.emitSDK('room:occupant-avatar', {
            roomJid,
            nick,
            ...(occupantId && { occupantId }),
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
        if (occupantId) {
          await saveRoomOccupantAvatarHash(roomJid, occupantId, avatarHash)
        }
        this.deps.emitSDK('room:occupant-avatar', {
          roomJid,
          nick,
          ...(occupantId && { occupantId }),
          avatar: blobUrl,
          avatarHash,
        })
      }
    } catch {
      // Silently fail - avatar fetch failed or occupant has no avatar
    }
  }

  /**
   * Fetch a room's avatar from its vCard (XEP-0054).
   * MUC rooms don't support PEP, so avatars are always via vCard-temp.
   *
   * @param roomJid - The room's bare JID
   * @param knownHash - Optional hash from XEP-0153 presence (used for cache key)
   */
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
      this.deps.emitSDK('contacts:avatar', { jid: bareJid, avatar, avatarHash: hash ?? undefined })
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
    const nicks = await this.nickNode.getOr([], { jid: getBareJid(jid), maxItems: 1 })
    return nicks[0] ?? null
  }

  /**
   * Fetch own nickname from PEP (XEP-0172 User Nickname).
   */
  async fetchOwnNickname(): Promise<string | null> {
    if (!this.deps.getCurrentJid()) return null
    const nicks = await this.nickNode.getOr([], { maxItems: 1 })
    const nick = nicks[0]
    if (!nick) return null
    this.deps.emitSDK('connection:own-nickname', { nickname: nick })
    return nick
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

    await this.nickNode.publish(CURRENT_ITEM_ID, trimmedNickname)
    this.deps.emitSDK('connection:own-nickname', { nickname: trimmedNickname })
  }

  /**
   * Clear/remove own nickname from PEP (XEP-0172).
   */
  async clearOwnNickname(): Promise<void> {
    await this.nickNode.retract(CURRENT_ITEM_ID)
    this.deps.emitSDK('connection:own-nickname', { nickname: null })
  }

  /**
   * Fetch our own profile details.
   *
   * Emits `connection:own-profile` so the store picks them up.
   */
  async fetchOwnProfileDetails(): Promise<ProfileDetails | null> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return null

    const bareJid = getBareJid(currentJid)
    const details = await this.fetchProfileDetails(bareJid)
    this.deps.emitSDK('connection:own-profile', { details })
    return details
  }

  /**
   * Publish our own profile details.
   *
   * XEP-0054 replaces the whole vcard-temp rather than patching it, so the
   * current one is fetched first and merged into: publishing only the edited
   * fields would drop everything else the user has set, the avatar included.
   */
  async publishOwnProfileDetails(info: ProfileDetails): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    // Fetch current vCard to preserve PHOTO and other unmanaged fields
    const bareJid = getBareJid(this.deps.getCurrentJid()!)
    let existingVCardEl: Element | null = null
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
    this.deps.emitSDK('connection:own-profile', { details: info })
  }

  /**
   * Fetch appearance settings from private PEP storage (XEP-0223).
   * Returns mode (required) plus optional themeId, fontSize, and accentPreset.
   */
  async fetchAppearance(): Promise<AppearanceSettings | null> {
    const settings = await this.appearanceNode.getOr([], { itemId: CURRENT_ITEM_ID, maxItems: 1 })
    return settings[0] ?? null
  }

  /**
   * Save appearance settings to private PEP storage (XEP-0223).
   */
  async setAppearance(settings: AppearanceSettings): Promise<void> {
    await this.appearanceNode.publish(CURRENT_ITEM_ID, settings)
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
      this.fetchOwnProfileDetails(),
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

    const meta = (await this.avatarMetadataNode.getOr([], { maxItems: 1 }))[0]
    // `null` is a published "no avatar"; either way there is nothing to fetch.
    if (!meta) return

    const cachedUrl = await getCachedAvatar(meta.hash)
    if (cachedUrl) {
      this.deps.emitSDK('connection:own-avatar', { avatar: cachedUrl, hash: meta.hash })
      return
    }

    const base64 = (await this.avatarDataNode.getOr([], { itemId: meta.hash }))[0]
    if (!base64) return

    // Prefer the sniffed type over the advertised <info type>, which the
    // publishing client may have mislabeled; fall back to it when unknown.
    const sniffedType = sniffImageMimeType(base64) ?? meta.mimeType ?? 'image/png'
    const blobUrl = await cacheAvatar(meta.hash, base64, sniffedType)
    await saveAvatarHash(bareJid, meta.hash, 'contact')
    this.deps.emitSDK('connection:own-avatar', { avatar: blobUrl, hash: meta.hash })
  }

  async publishOwnAvatar(imageData: string, mimeType: string, _width: number, _height: number): Promise<void> {
    const base64Data = imageData.split(',')[1] || imageData
    const hash = generateUUID() // Should ideally be SHA-1 of data

    // Data first: a peer reading the metadata immediately must find the image
    // the hash names.
    await this.avatarDataNode.publish(hash, base64Data)
    await this.avatarMetadataNode.publish(hash, {
      hash,
      mimeType,
      bytes: Math.round(base64Data.length * 0.75),
    })

    this.updateAvatar(this.deps.getCurrentJid()!, imageData, hash)
  }

  async clearOwnAvatar(): Promise<void> {
    // XEP-0084 §4.2 disables an avatar by publishing a `<metadata/>` with no
    // `<info/>`, not by publishing a bare `<item/>`: peers drop the avatar they
    // hold on reading the empty element, and an item with no payload carries
    // nothing for them to read.
    await this.avatarMetadataNode.publish(CURRENT_ITEM_ID, null)
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
        this.deps.emitSDK('contacts:avatar', { jid, avatar: cachedUrl, avatarHash })
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
            this.deps.emitSDK('contacts:avatar', { jid: mapping.jid, avatar: cachedUrl, avatarHash: mapping.hash })
          } else {
            // At least set the hash so we can try fetching later
            this.deps.emitSDK('contacts:avatar', { jid: mapping.jid, avatar: null, avatarHash: mapping.hash })
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

      const currentJid = this.deps.getCurrentJid()
      const ownBareJid = currentJid ? getBareJid(currentJid) : null

      const hashMappings = await tryGetAllAvatarHashes()
      const occupantMappingsByRoom =
        await seedRoomOccupantAvatarHashes(hashMappings)
      for (const mapping of hashMappings ?? []) {
        const url = freshUrls.get(mapping.hash)
        if (!url) continue

        if (mapping.type === 'contact') {
          // The current user's own avatar is stored as a 'contact' under their
          // own bare JID, but the user isn't in their own roster (so getContact
          // misses) and it needs the connection:own-avatar event, not
          // roster:avatar. Without this the own avatar's blob URL — revoked by
          // refreshAllBlobUrls — is never re-pointed and renders as a fallback.
          if (ownBareJid && mapping.jid === ownBareJid) {
            this.deps.emitSDK('connection:own-avatar', { avatar: url, hash: mapping.hash })
            continue
          }
          const contact = this.deps.stores?.roster.getContact(mapping.jid)
          if (contact) {
            this.deps.emitSDK('contacts:avatar', { jid: mapping.jid, avatar: url, avatarHash: mapping.hash })
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

      // Safety net for roster contacts the mapping loop above missed. The loop
      // only re-points JIDs present in the IndexedDB hash-mapping store, but a
      // contact can hold a (now-dead) avatar blob without such a mapping — e.g.
      // its avatar arrived via MUC vcard-temp presence rather than a PEP/vCard
      // fetch, or the mapping/data was evicted. Without this, that contact keeps
      // a dead blob: URL after a WebKit reclaim and renders as a broken image.
      // Drive off the roster store (source of truth for live contacts + hashes):
      //   - hash bytes still cached → re-point to the fresh URL (idempotent),
      //   - hash bytes gone        → re-fetch so it heals instead of staying broken.
      const contacts = this.deps.stores?.roster?.sortedContacts?.() ?? []
      for (const contact of contacts) {
        if (!contact.avatarHash) continue
        const url = freshUrls.get(contact.avatarHash)
        if (url) {
          if (contact.avatar !== url) {
            this.updateAvatar(contact.jid, url, contact.avatarHash)
          }
        } else if (!contact.avatar || contact.avatar.startsWith('blob:')) {
          // Only refetch contacts whose current pointer is empty or a revoked
          // blob: URL — leave data: URIs and other live pointers untouched.
          this.fetchAvatarData(contact.jid, contact.avatarHash).catch(() => {})
        }
      }

      // MUC occupant avatars live in each room's occupant map (keyed by nick),
      // not in the contact/room hash store, so the loop above never touches
      // them. After blob invalidation (WebKit reclaiming memory on sleep, or
      // revokeAllBlobUrls on disconnect) their URLs are dead and were never
      // re-pointed — the cause of broken occupant avatars ("img blob:" load
      // failures) when reading public groups. Re-point each occupant whose
      // cached avatar hash has a fresh URL.
      const joinedRooms = this.deps.stores?.room?.joinedRooms?.() ?? []
      for (const room of joinedRooms) {
        for (const occupant of room.occupants.values()) {
          if (!occupant.avatarHash) continue
          const url = freshUrls.get(occupant.avatarHash)
          if (!url) continue
          this.deps.emitSDK('room:occupant-avatar', {
            roomJid: room.jid,
            nick: occupant.nick,
            ...(occupant.occupantId && { occupantId: occupant.occupantId }),
            avatar: url,
            avatarHash: occupant.avatarHash,
          })
        }

        // Re-point offline XEP-0421 identities too. They are absent from the
        // live occupant map, but their room-scoped hash bindings are durable.
        if (
          this.deps.privacyOptions?.disableOccupantAvatarsInAnonymousRooms
          && room.isNonAnonymous === false
        ) {
          continue
        }
        const stableMappings = occupantMappingsByRoom.get(getBareJid(room.jid))
        if (!stableMappings) continue
        for (const [occupantId, hash] of stableMappings) {
          const url = freshUrls.get(hash)
          if (!url) continue
          const nick = room.occupantIdToNick?.get(occupantId)
          this.deps.emitSDK('room:occupant-avatar', {
            roomJid: room.jid,
            ...(nick && { nick }),
            occupantId,
            avatar: url,
            avatarHash: hash,
          })
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
            ...(occupant.occupantId && { occupantId: occupant.occupantId }),
            avatar: cachedUrl,
            avatarHash: hash,
          })
        }
      }

      // XEP-0421 is the durable path for anonymous rooms: hydrate every known
      // room-scoped identity, including occupants who are already offline.
      const anonymousRestoreDisabled =
        this.deps.privacyOptions?.disableOccupantAvatarsInAnonymousRooms
        && room.isNonAnonymous === false
      if (!anonymousRestoreDisabled) {
        const stableMappings = await getRoomOccupantAvatarHashes(roomJid)
        for (const { occupantId, hash } of stableMappings) {
          const cachedUrl = await getCachedAvatar(hash)
          if (!cachedUrl) continue
          const nick = room.occupantIdToNick?.get(occupantId)
          this.deps.emitSDK('room:occupant-avatar', {
            roomJid,
            ...(nick && { nick }),
            occupantId,
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
