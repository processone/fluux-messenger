import { occupantAvatarKey, captureOccupantAvatar, snapshotOccupantAvatar, type AvatarVersion } from '../../utils/avatarState'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { BaseModule, type ModuleDependencies } from './BaseModule'
import { PepNode, type PepCodec, type PepGetOptions, type PublishOptions } from './PepNode'
import { getBareJid, getLocalPart, getDomain, getResource } from '../jid'
import type { ProfileDetails } from '../types/roster'
import type { SDKEvents } from '../types'
import type { RoomOccupant } from '../types/room'
import { generateUUID } from '../../utils/uuid'
import {
  getCachedAvatar,
  getAvatarHash,
  cacheAvatar,
  saveAvatarHash,
  deleteAvatarHash,
  getAllAvatarHashes,
  tryGetAllAvatarHashes,
  saveRoomOccupantAvatarHash,
  getRoomOccupantAvatarHashes,
  seedRoomOccupantAvatarHashes,
  hasNoAvatar,
  hasNoAvatarForHash,
  markNoAvatar,
  clearNoAvatar,
  refreshAllBlobUrls,
  isPepForbiddenDomain,
  markPepForbiddenDomain,
  loadPepForbiddenDomains,
  type AvatarEntityType,
} from '../../utils/avatarCache'
import { RequestTimeoutError } from '../errors'
import { AVATAR_LOOKUP_TIMEOUT_MS, beginUnansweredLookup, clearUnansweredLookup, type UnansweredLookup } from '../../utils/unansweredLookups'
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

type ProfileCompletion =
  | { event: 'connection:own-avatar'; payload: SDKEvents['connection:own-avatar']; accountJid: string | null }
  | { event: 'connection:own-profile'; payload: SDKEvents['connection:own-profile']; accountJid: string | null; replaceProfile?: boolean; hasPhoto?: boolean }
  | { event: 'contacts:avatar'; payload: SDKEvents['contacts:avatar']; restore?: boolean }
  | { event: 'room:occupant-avatar'; payload: SDKEvents['room:occupant-avatar']; realJid?: string }
  | { event: 'avatar:evidence'; payload: { jid: string; realJid?: string; hash?: string; stateJid?: string }; accountJid?: string }
  | { event: 'profile:photo'; payload: { jid: string } }

const PROFILE_REFRESH_MS = 5 * 60 * 1000
const VCARD_ABSENCE_TTL_MS = 24 * 60 * 60 * 1000

function isDefinitiveVCardError(error: unknown): boolean {
  // iqCaller exposes the error stanza's condition. Free-form error text is
  // not a server response and cannot justify a durable negative cache entry.
  const condition = (error as { condition?: unknown } | null)?.condition
  return condition === 'service-unavailable' || condition === 'feature-not-implemented'
    || condition === 'item-not-found'
}

interface CachedProfileDetails {
  promise: Promise<ProfileDetails | null>
  expiresAt: number
  negative?: boolean
  negativeInvalidated?: boolean
  occupant?: RoomOccupant
}

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
    // Appearance items published before the first public release name this
    // element `theme`. Both spellings are read so an upgrade keeps the user's
    // choice; publishing only ever writes `mode`.
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
  private readonly profileDetailsCache = new Map<string, CachedProfileDetails>()
  private profileCacheAccount: string | null = null

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

  private avatarReadNode<T>(namespace: string, codec: PepCodec<T>, lookup: UnansweredLookup): PepNode<T> {
    return new PepNode({ ...this.deps, sendIQ: iq => lookup.read(() => this.deps.sendIQ(iq, AVATAR_LOOKUP_TIMEOUT_MS), iq.attrs.to) }, namespace, codec)
  }

  // Note: PubSub events are now handled by the PubSub module.
  // Profile module focuses on outgoing operations (publish avatar, set nickname)
  // and data fetching (fetchAvatarData, fetchVCardAvatar, fetchRoomAvatar).


  /**
   * Fetch avatar data from PEP (XEP-0084) or VCard (XEP-0054).
   *
   * @param acceptedVersion - Recovery must carry the owner's accepted snapshot;
   *   omitting it admits the supplied hash as an announcement.
   */
  async fetchAvatarData(jid: string, hash: string, acceptedVersion?: AvatarVersion): Promise<void> {
    const bareJid = getBareJid(jid)
    const version = acceptedVersion ?? this.avatarState.capture(bareJid, hash)
    if (!version.current()) return
    await this.clearVCardNegativeCache(bareJid, undefined, hash)
    if (!version.current()) return
    let avatarUrl = await getCachedAvatar(hash)
    if (!version.current()) return
    if (!avatarUrl) avatarUrl = await this.lookUpAnnouncedAvatar(bareJid, hash, 'contact', version)
    if (avatarUrl) await this.updateAvatar(bareJid, avatarUrl, hash, version)
  }

  private async lookUpAnnouncedAvatar(
    jid: string,
    hash: string,
    kind: AvatarEntityType,
    version: AvatarVersion,
  ): Promise<string | null> {
    const lookup = await beginUnansweredLookup(version.jid, hash, version)
    if (!version.current() || !lookup.allowed()) return null
    if (await hasNoAvatarForHash(version.jid, hash) || !version.current()) return null

    if (kind === 'contact') {
      const data = (await this.readContactAvatarNode(this.avatarReadNode(NS_AVATAR_DATA, avatarDataCodec, lookup), jid, { itemId: hash }))[0]
      if (!version.current()) return null
      if (data) {
        const avatarUrl = await cacheAvatar(hash, data, sniffImageMimeType(data) ?? 'image/png')
        if (!version.positive()) return null
        await lookup.answered()
        return version.current() ? avatarUrl : null
      }
    }
    try {
      const iq = xml('iq', { type: 'get', to: jid, id: `vcard_${generateUUID()}` },
        xml('vCard', { xmlns: NS_VCARD_TEMP }))
      const vcard = (await lookup.read(() => this.deps.sendIQ(iq, AVATAR_LOOKUP_TIMEOUT_MS), iq.attrs.to)).getChild('vCard', NS_VCARD_TEMP)
      await lookup.answered()
      if (!version.current()) return null
      const photo = vcard?.getChild('PHOTO')
      const binval = photo?.getChildText('BINVAL')
      if (binval) {
        const avatar = await cacheAvatar(hash, binval.replace(/\s/g, ''), photo?.getChildText('TYPE') || 'image/png')
        if (!version.positive()) return null
        return version.current() ? avatar : null
      }
      await markNoAvatar(version.jid, kind, 'definitive', version, hash)
      if (vcard && kind === 'contact' && version.jid === jid && version.current()) {
        await this.updateAvatar(jid, null, null, version.absence())
      }
    } catch (error) {
      if (error instanceof RequestTimeoutError) return null
      if (isDefinitiveVCardError(error)) await lookup.answered()
      await markNoAvatar(version.jid, kind, isDefinitiveVCardError(error) ? 'definitive' : 'transient', version, hash)
    }
    return null
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
    const version = this.avatarState.capture(bareJid)
    const lookup = await beginUnansweredLookup(bareJid, undefined, version)
    if (!lookup.allowed()) return null

    // Both confirmed absence and transient backoff suppress this query.
    if (await hasNoAvatar(bareJid) || !version.current()) {
      return null
    }

    // `null` is the contact stating they have no avatar; both it and an
    // unreadable node fall through to vCard.
    const hash = (await this.readContactAvatarNode(
      this.avatarReadNode(NS_AVATAR_METADATA, avatarMetadataCodec, lookup), bareJid, { maxItems: 1 },
    ))[0]?.hash

    if (!version.current()) return null
    if (!hash) {
      // No avatar via XEP-0084, or the server would not say — either way, fall
      // back to vCard-temp (XEP-0054).
      await this.fetchVCardAvatarForVersion(bareJid, version, lookup)
      return null
    }

    await this.fetchAvatarData(bareJid, hash)
    return hash
  }

  /**
   * Fetch the descriptive fields a JID publishes about itself.
   *
   * Carried over XEP-0054 vcard-temp. For a room occupant in an anonymous
   * room, pass the full occupant JID (room@conf/nick).
   * Concurrent reads share one query. Results and failures are cached in memory:
   * five minutes for populated profiles or ambiguous failures, 24 hours for
   * empty profiles or explicit absence. An avatar announcement invalidates negative
   * profile results.
   * All outcomes are memory-only, including definitive absence: the first read
   * after an application restart queries the server again.
   *
   * @param jid - The bare JID or full occupant JID to query
   * @returns The fields the server returned, or null if the query failed
   */
  async fetchProfileDetails(jid: string): Promise<ProfileDetails | null> {
    const account = this.deps.getCurrentJid()
    const bareAccount = account ? getBareJid(account) : null
    if (this.profileCacheAccount !== bareAccount) {
      this.profileDetailsCache.clear()
      this.profileCacheAccount = bareAccount
    }
    for (const [key, entry] of this.profileDetailsCache) {
      if (entry.expiresAt <= Date.now()) this.profileDetailsCache.delete(key)
    }
    // The full occupant JID is the query target; different nicks are not the room.
    let entry = this.profileDetailsCache.get(jid)
    if (entry && !this.isProfileOccupantCurrent(jid, entry)) {
      this.profileDetailsCache.delete(jid)
      entry = undefined
    }
    if (!entry) {
      const pending: CachedProfileDetails = {
        expiresAt: Infinity,
        occupant: this.getProfileOccupant(jid),
        promise: this.queryProfileDetails(jid).then(({ details, ttlMs }) => {
          pending.expiresAt = Date.now() + ttlMs
          pending.negative = details === null
          if (pending.negative && pending.negativeInvalidated && this.profileDetailsCache.get(jid) === pending) {
            this.profileDetailsCache.delete(jid)
          }
          return details
        }),
      }
      this.profileDetailsCache.set(jid, pending)
      entry = pending
    }
    const details = await entry.promise
    if (this.profileDetailsCache.get(jid) !== entry || !this.isProfileOccupantCurrent(jid, entry)) return null
    return details ? { ...details } : null
  }

  private async queryProfileDetails(jid: string): Promise<{ details: ProfileDetails | null; ttlMs: number }> {
    const version = this.avatarState.capture(jid)
    const iq = xml('iq', { type: 'get', to: jid, id: `vcard_${generateUUID()}` },
      xml('vCard', { xmlns: NS_VCARD_TEMP })
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const vcard = result.getChild('vCard', NS_VCARD_TEMP)
      if (!vcard) return { details: null, ttlMs: VCARD_ABSENCE_TTL_MS }

      if (vcard.getChild('PHOTO')?.getChildText('BINVAL')) {
        await this.completeProfileUpdate({ event: 'profile:photo', payload: { jid } }, version)
      }

      const fullName = vcard.getChildText('FN') || undefined
      const org = vcard.getChild('ORG')?.getChildText('ORGNAME') || undefined
      const email = vcard.getChild('EMAIL')?.getChildText('USERID') || undefined
      const adr = vcard.getChild('ADR')
      const country = adr?.getChildText('CTRY') || undefined

      // Return null if no fields were found
      if (!fullName && !org && !email && !country) return { details: null, ttlMs: VCARD_ABSENCE_TTL_MS }

      return { details: { fullName, org, email, country }, ttlMs: PROFILE_REFRESH_MS }
    } catch (error) {
      return { details: null, ttlMs: isDefinitiveVCardError(error) ? VCARD_ABSENCE_TTL_MS : PROFILE_REFRESH_MS }
    }
  }

  /**
   * Record positive avatar evidence for a JID, lifting the negatives it overrides.
   *
   * @param hash - The announced avatar hash. A negative recorded for this same
   *   hash already answers the announcement and is kept.
   */
  async clearVCardNegativeCache(jid: string, realJid?: string, hash?: string, stateJid?: string): Promise<void> {
    const identities = [...new Set([jid, ...(realJid ? [getBareJid(realJid)] : []), ...(stateJid ? [stateJid] : [])])]
    const versions = identities.map(identity => hash === undefined ? this.avatarState.invalidate(identity) : this.avatarState.capture(identity, hash))
    for (const identity of identities) this.invalidateNegativeProfile(identity)
    await Promise.all(versions.map(version => this.clearAvatarNegatives(version, hash)))
  }

  private invalidateNegativeProfile(jid: string): void {
    const entry = this.profileDetailsCache.get(jid)
    if (entry?.negative) this.profileDetailsCache.delete(jid)
    else if (entry && entry.negative === undefined) entry.negativeInvalidated = true
  }

  private async clearAvatarNegatives(version: AvatarVersion, announcedHash?: string): Promise<void> {
    await clearUnansweredLookup(version.jid, announcedHash, version)
    if (!version.current()) return
    const keep = announcedHash && await hasNoAvatarForHash(version.jid, announcedHash)
    if (!keep) await clearNoAvatar(version.jid, version)
  }

  private async completeProfileUpdate(update: ProfileCompletion, version?: AvatarVersion): Promise<boolean> {
    const currentJid = this.deps.getCurrentJid()
    if ('accountJid' in update && update.accountJid !== (currentJid ? getBareJid(currentJid) : null)) return false
    if (update.event === 'connection:own-profile') {
      const jid = update.accountJid
      if (!jid) return false
      if (update.replaceProfile) this.profileDetailsCache.delete(jid)
      const photoVersion = version ?? this.avatarState.capture(jid)
      if (update.hasPhoto && photoVersion.positive()) {
        this.invalidateNegativeProfile(jid)
        await this.clearAvatarNegatives(photoVersion)
      }
      const account = this.deps.getCurrentJid()
      if (jid !== (account ? getBareJid(account) : null)) return false
      this.deps.emitSDK(update.event, update.payload)
      return true
    }
    if (version && !version.current()) return false
    if (update.event === 'avatar:evidence') {
      await this.clearVCardNegativeCache(update.payload.jid, update.payload.realJid, update.payload.hash, update.payload.stateJid)
      return true
    }
    const jid = update.event === 'contacts:avatar' ? getBareJid(update.payload.jid)
      : update.event === 'room:occupant-avatar' ? this.getOccupantAvatarStateKey(update.payload.roomJid, update.payload.nick ?? '', update.realJid, update.payload.occupantId)
      : update.event === 'profile:photo' ? update.payload.jid : update.accountJid
    if (!jid) return false
    version ??= this.avatarState.capture(jid)
    if (update.event === 'contacts:avatar' && update.restore && await getAvatarHash(jid) !== update.payload.avatarHash) return false
    if (!version.current()) return false
    if (update.event === 'contacts:avatar' && update.payload.avatar === null && !update.payload.avatarHash
      || update.event === 'connection:own-avatar' && update.payload.avatar === null && !update.payload.hash) {
      version.apply(() => this.deps.emitSDK(update.event, update.payload))
      await deleteAvatarHash(jid, version)
      return true
    }
    const identities = [jid]
    if (update.event === 'room:occupant-avatar') {
      const { roomJid, nick, occupantId } = update.payload
      await this.deps.waitForRoomOccupants?.(roomJid)
      if (!version.current()) return false
      const occupant = nick ? this.deps.stores?.room.getRoom(roomJid)?.occupants.get(nick) : undefined
      const sameOccupant = !occupantId || !occupant?.occupantId || occupantId === occupant.occupantId
      if (nick && sameOccupant) {
        identities.push(`${roomJid}/${nick}`)
        const realJid = update.realJid ?? occupant?.jid
        if (realJid) identities.push(getBareJid(realJid))
      } else if (update.realJid) identities.push(getBareJid(update.realJid))
    }
    const positive = update.event === 'profile:photo' || (update.event === 'connection:own-avatar'
      ? Boolean(update.payload.avatar || update.payload.hash) : Boolean(update.payload.avatar || update.payload.avatarHash))
    if (positive && !version.positive()) return false
    if (positive) {
      for (const identity of new Set(identities)) {
        if (update.event !== 'profile:photo') this.invalidateNegativeProfile(identity)
        const identityVersion = identity === jid ? version : this.avatarState.capture(identity)
        if (!identityVersion.positive()) return false
        await this.clearAvatarNegatives(identityVersion)
        if (!version.current()) return false
      }
    }
    if (!version.current()) return false
    if (update.event === 'contacts:avatar' && update.payload.avatar && update.payload.avatarHash) {
      await saveAvatarHash(jid, update.payload.avatarHash!, 'contact', version)
    }
    if (update.event === 'connection:own-avatar' && update.payload.avatar && update.payload.hash) {
      await saveAvatarHash(jid, update.payload.hash!, 'contact', version)
    }
    if (update.event === 'room:occupant-avatar' && update.payload.avatarHash && update.payload.occupantId) {
      await saveRoomOccupantAvatarHash(update.payload.roomJid, update.payload.occupantId!, update.payload.avatarHash!, version)
    }
    return update.event === 'profile:photo' ? version.current() : version.apply(() => this.deps.emitSDK(update.event, update.payload))
  }

  invalidateOccupantProfiles(roomJid: string, nick?: string): void {
    if (nick !== undefined) {
      const occupantJid = `${roomJid}/${nick}`
      this.profileDetailsCache.delete(occupantJid)
      const version = this.avatarState.invalidate(occupantJid)
      this.clearAvatarNegatives(version).catch(() => {})
    } else {
      for (const jid of this.profileDetailsCache.keys()) {
        if (jid.startsWith(`${roomJid}/`)) this.profileDetailsCache.delete(jid)
      }
    }
  }

  private getProfileOccupant(jid: string): RoomOccupant | undefined {
    const nick = getResource(jid)
    return nick ? this.getRoomWithOccupants(getBareJid(jid))?.occupants.get(nick) : undefined
  }

  private isProfileOccupantCurrent(jid: string, entry: CachedProfileDetails): boolean {
    const occupant = this.getProfileOccupant(jid)
    return Boolean(occupant) === Boolean(entry.occupant)
      && occupant?.occupantId === entry.occupant?.occupantId
      && occupant?.jid === entry.occupant?.jid
  }

  async fetchVCardAvatar(jid: string): Promise<void> {
    const bareJid = getBareJid(jid)
    const version = this.avatarState.capture(bareJid)
    await this.fetchVCardAvatarForVersion(bareJid, version)
  }

  private async fetchVCardAvatarForVersion(bareJid: string, version: AvatarVersion, fallback?: UnansweredLookup): Promise<void> {
    const lookup = fallback ?? await beginUnansweredLookup(bareJid, undefined, version)
    if (!version.current() || (!fallback && !lookup.allowed()) || await hasNoAvatar(bareJid) || !version.current()) return
    const iq = xml('iq', { type: 'get', to: bareJid, id: `vcard_${generateUUID()}` }, xml('vCard', { xmlns: NS_VCARD_TEMP }))
    try {
      const result = await lookup.read(() => this.deps.sendIQ(iq, AVATAR_LOOKUP_TIMEOUT_MS), iq.attrs.to)
      await lookup.answered()
      if (!version.current()) return
      const vcard = result.getChild('vCard', NS_VCARD_TEMP)
      const photo = vcard?.getChild('PHOTO')
      const binval = photo?.getChildText('BINVAL')
      const type = photo?.getChildText('TYPE') || 'image/png'
      if (binval) {
        await this.updateAvatar(bareJid, `data:${type};base64,${binval.replace(/\s/g, '')}`, null, version)
      } else {
        await markNoAvatar(bareJid, 'contact', 'definitive', version)
        if (vcard && version.current()) await this.updateAvatar(bareJid, null, null, version.absence())
      }
    } catch (error) {
      if (error instanceof RequestTimeoutError) return
      if (isDefinitiveVCardError(error)) await lookup.answered()
      await markNoAvatar(bareJid, 'contact', isDefinitiveVCardError(error) ? 'definitive' : 'transient', version)
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

    const occupantJid = `${roomJid}/${nick}`
    // A disclosed real JID is queried through its own PEP and vCard. An anonymous
    // occupant is queried through the room (XEP-0398), which relays vCard only.
    const target = realJid ? getBareJid(realJid) : occupantJid
    const stateJid = this.getOccupantAvatarStateKey(roomJid, nick, realJid, occupantId)
    const version = captureOccupantAvatar(this.avatarState, roomJid, nick, avatarHash, realJid, occupantId)
    await this.clearVCardNegativeCache(occupantJid, realJid, avatarHash, stateJid)
    if (!version.current()) return

    // Check cache first using the hash
    const cachedUrl = await getCachedAvatar(avatarHash)
    if (!version.current()) return
    if (cachedUrl) {
      if (!version.positive()) return
      await this.updateOccupantAvatar(roomJid, nick, cachedUrl, avatarHash, realJid, occupantId, version)
      return
    }

    const blobUrl = await this.lookUpAnnouncedAvatar(target, avatarHash, realJid ? 'contact' : 'occupant', version)
    if (!blobUrl || !version.positive()) return
    // Persist JID→hash mapping so we can restore from cache on next session
    if (realJid) {
      await saveAvatarHash(target, avatarHash, 'contact', version)
    }
    await this.updateOccupantAvatar(roomJid, nick, blobUrl, avatarHash, realJid, occupantId, version)
  }

  private async updateOccupantAvatar(
    roomJid: string,
    nick: string,
    avatar: string,
    avatarHash: string,
    realJid: string | undefined,
    occupantId: string | undefined,
    version: AvatarVersion,
  ): Promise<void> {
    await this.completeProfileUpdate({ event: 'room:occupant-avatar', payload: {
      roomJid,
      nick,
      ...(occupantId && { occupantId }),
      avatar,
      avatarHash,
    }, realJid }, version)
  }

  getOccupantAvatarStateKey(roomJid: string, nick: string, realJid?: string, occupantId?: string): string {
    return occupantAvatarKey(roomJid, nick, realJid, occupantId)
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
    const version = this.avatarState.capture(bareJid, knownHash)
    if (knownHash) {
      await this.clearVCardNegativeCache(bareJid, undefined, knownHash)
      if (!version.current()) return
      const cachedUrl = await getCachedAvatar(knownHash)
      if (!version.current()) return
      if (cachedUrl) {
        if (!version.positive()) return
        version.apply(() => this.deps.emitSDK('room:updated', {
          roomJid: bareJid, updates: { avatar: cachedUrl, avatarHash: knownHash },
        }))
        return
      }
      const blobUrl = await this.lookUpAnnouncedAvatar(bareJid, knownHash, 'room', version)
      if (!blobUrl || !version.positive()) return
      await saveAvatarHash(bareJid, knownHash, 'room', version)
      version.apply(() => this.deps.emitSDK('room:updated', {
        roomJid: bareJid, updates: { avatar: blobUrl, avatarHash: knownHash },
      }))
      return
    }
    const lookup = await beginUnansweredLookup(bareJid, undefined, version)
    if (!version.current() || !lookup.allowed() || await hasNoAvatar(bareJid) || !version.current()) return
    const iq = xml('iq', { type: 'get', to: bareJid, id: `vcard_${generateUUID()}` }, xml('vCard', { xmlns: NS_VCARD_TEMP }))
    try {
      const result = await lookup.read(() => this.deps.sendIQ(iq, AVATAR_LOOKUP_TIMEOUT_MS), iq.attrs.to)
      await lookup.answered()
      if (!version.current()) return
      const photo = result.getChild('vCard', NS_VCARD_TEMP)?.getChild('PHOTO')
      const binval = photo?.getChildText('BINVAL')
      if (binval) {
        const hash = generateUUID()
        const blobUrl = await cacheAvatar(hash, binval.replace(/\s/g, ''), photo?.getChildText('TYPE') || 'image/png')
        if (!version.positive()) return
        await saveAvatarHash(bareJid, hash, 'room', version)
        await this.clearAvatarNegatives(version)
        version.apply(() => this.deps.emitSDK('room:updated', {
          roomJid: bareJid, updates: { avatar: blobUrl, avatarHash: hash },
        }))
      } else {
        await markNoAvatar(bareJid, 'room', 'definitive', version)
      }
    } catch (err) {
      if (err instanceof RequestTimeoutError || !version.current()) return
      if (err instanceof Error && err.message.includes('item-not-found')) {
        await lookup.answered()
        await markNoAvatar(bareJid, 'room', 'definitive', version)
      } else console.error('Failed to fetch room avatar:', err)
    }
  }

  getContactAvatarRemovalVersion(jid: string): number {
    return this.avatarState.capture(getBareJid(jid)).generation
  }

  async removeContactAvatar(jid: string): Promise<void> {
    const version = this.avatarState.capture(getBareJid(jid), null)
    await this.completeProfileUpdate({ event: 'contacts:avatar', payload: { jid: getBareJid(jid), avatar: null } }, version)
  }

  private async updateAvatar(jid: string, avatar: string | null, hash: string | null, version: AvatarVersion): Promise<void> {
    const bareJid = getBareJid(jid)
    const currentJid = this.deps.getCurrentJid()

    if (bareJid === getBareJid(currentJid ?? '')) {
      await this.completeProfileUpdate({ event: 'connection:own-avatar', accountJid: bareJid, payload: { avatar, hash } }, version)
    } else {
      await this.completeProfileUpdate({ event: 'contacts:avatar', payload: { jid: bareJid, avatar, avatarHash: hash ?? undefined } }, version)
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
    await this.completeProfileUpdate({ event: 'connection:own-profile', accountJid: bareJid, payload: { details } })
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
    const version = this.avatarState.capture(bareJid)
    let existingVCardEl: Element | null = null
    try {
      const getIq = xml('iq', { type: 'get', to: bareJid, id: `vcard_get_${generateUUID()}` },
        xml('vCard', { xmlns: NS_VCARD_TEMP })
      )
      const result = await this.deps.sendIQ(getIq)
      existingVCardEl = result.getChild('vCard', NS_VCARD_TEMP) ?? null
      if (existingVCardEl?.getChild('PHOTO')?.getChildText('BINVAL')) {
        if (version.positive()) {
          this.invalidateNegativeProfile(bareJid)
          await this.clearAvatarNegatives(version)
        }
      }
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
    await this.completeProfileUpdate({ event: 'connection:own-profile', accountJid: bareJid, payload: { details: info }, replaceProfile: true,
      hasPhoto: Boolean(existingVCardEl?.getChild('PHOTO')?.getChildText('BINVAL')),
    }, version)
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

    let version = this.avatarState.capture(bareJid)
    const meta = (await this.avatarMetadataNode.getOr([], { maxItems: 1 }))[0]
    // `null` is a published "no avatar"; either way there is nothing to fetch.
    if (!meta || !version.current()) return
    version = this.avatarState.capture(bareJid, meta.hash)
    await this.completeProfileUpdate({ event: 'avatar:evidence', payload: { jid: bareJid, hash: meta.hash } }, version)

    const cachedUrl = await getCachedAvatar(meta.hash)
    if (!version.current()) return
    if (cachedUrl) {
      await this.completeProfileUpdate({ event: 'connection:own-avatar', accountJid: bareJid, payload: { avatar: cachedUrl, hash: meta.hash } }, version)
      return
    }

    const base64 = (await this.avatarDataNode.getOr([], { itemId: meta.hash }))[0]
    if (!base64 || !version.current()) return

    // Prefer the sniffed type over the advertised <info type>, which the
    // publishing client may have mislabeled; fall back to it when unknown.
    const sniffedType = sniffImageMimeType(base64) ?? meta.mimeType ?? 'image/png'
    const blobUrl = await cacheAvatar(meta.hash, base64, sniffedType)
    await this.completeProfileUpdate({ event: 'connection:own-avatar', accountJid: bareJid, payload: { avatar: blobUrl, hash: meta.hash } }, version)
  }

  async publishOwnAvatar(imageData: string, mimeType: string, _width: number, _height: number): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    const accountJid = currentJid ? getBareJid(currentJid) : null
    const base64Data = imageData.split(',')[1] || imageData
    const hash = generateUUID() // Should ideally be SHA-1 of data
    const version = this.avatarState.capture(accountJid ?? '', hash)

    // Data first: a peer reading the metadata immediately must find the image
    // the hash names.
    await this.avatarDataNode.publish(hash, base64Data)
    await this.avatarMetadataNode.publish(hash, {
      hash,
      mimeType,
      bytes: Math.round(base64Data.length * 0.75),
    })

    await this.completeProfileUpdate({ event: 'connection:own-avatar', accountJid, payload: { avatar: imageData, hash } }, version)
  }

  async clearOwnAvatar(): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    const accountJid = currentJid ? getBareJid(currentJid) : null
    const version = this.avatarState.capture(accountJid ?? '', null)
    // XEP-0084 §4.2 disables an avatar by publishing a `<metadata/>` with no
    // `<info/>`, not by publishing a bare `<item/>`: peers drop the avatar they
    // hold on reading the empty element, and an item with no payload carries
    // nothing for them to read.
    await this.avatarMetadataNode.publish(CURRENT_ITEM_ID, null)
    await this.completeProfileUpdate({ event: 'connection:own-avatar', accountJid, payload: { avatar: null, hash: null } }, version)
  }

  async setRoomAvatar(roomJid: string, imageData: string, _mimeType: string): Promise<void> {
    const version = this.avatarState.capture(getBareJid(roomJid), generateUUID())
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
    if (!version.positive()) return
    version.apply(() => this.deps.emitSDK('room:updated', { roomJid, updates: { avatar: imageData } }))
    await deleteAvatarHash(getBareJid(roomJid), version)
  }

  async clearRoomAvatar(roomJid: string): Promise<void> {
    const version = this.avatarState.capture(getBareJid(roomJid), null)
    const iq = xml('iq', { type: 'set', to: roomJid, id: `room_avatar_clear_${generateUUID()}` },
      xml('vCard', { xmlns: NS_VCARD_TEMP },
        xml('PHOTO', {})
      )
    )
    await this.deps.sendIQ(iq)
    version.apply(() => this.deps.emitSDK('room:updated', { roomJid, updates: { avatar: undefined } }))
    await deleteAvatarHash(getBareJid(roomJid), version)
  }

  // --- Avatar Cache Restore Methods ---

  async restoreContactAvatarFromCache(jid: string, avatarHash: string): Promise<boolean> {
    const version = this.avatarState.snapshot()(getBareJid(jid), avatarHash)
    try {
      const cachedUrl = await getCachedAvatar(avatarHash)
      if (cachedUrl) {
        return this.completeProfileUpdate({ event: 'contacts:avatar', payload: { jid, avatar: cachedUrl, avatarHash } }, version)
      }
    } catch (error) {
      console.error('Failed to restore contact avatar from cache:', jid, error)
    }
    return false
  }

  async restoreOwnAvatarFromCache(avatarHash: string): Promise<boolean> {
    const currentJid = this.deps.getCurrentJid()
    const accountJid = currentJid ? getBareJid(currentJid) : null
    const version = this.avatarState.snapshot()(accountJid ?? '', avatarHash)
    try {
      const cachedUrl = await getCachedAvatar(avatarHash)
      if (cachedUrl) {
        return this.completeProfileUpdate({ event: 'connection:own-avatar', accountJid, payload: { avatar: cachedUrl, hash: avatarHash } }, version)
      }
    } catch (error) {
      console.error('Failed to restore own avatar from cache:', error)
    }
    return false
  }

  async restoreRoomAvatarFromCache(roomJid: string, avatarHash: string): Promise<boolean> {
    const version = this.avatarState.snapshot()(getBareJid(roomJid), avatarHash)
    try {
      const cachedUrl = await getCachedAvatar(avatarHash)
      if (cachedUrl) {
        return version.positive() && version.apply(() => this.deps.emitSDK('room:updated', { roomJid, updates: { avatar: cachedUrl, avatarHash } }))
      }
    } catch (error) {
      console.error('Failed to restore room avatar from cache:', roomJid, error)
    }
    return false
  }

  async tryRestoreRoomAvatar(roomJid: string): Promise<boolean> {
    const snapshot = this.avatarState.snapshot()
    try {
      const hash = await getAvatarHash(roomJid)
      if (hash && snapshot(getBareJid(roomJid), hash).current()) {
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
    const snapshot = this.avatarState.snapshot()
    // Load PEP-forbidden domains before avatar fetches begin
    await loadPepForbiddenDomains().catch(() => {})

    try {
      const mappings = await getAllAvatarHashes('contact')
      for (const mapping of mappings) {
        const contact = this.deps.stores?.roster.getContact(mapping.jid)
        if (contact && !contact.avatarHash) {
          const cachedUrl = await getCachedAvatar(mapping.hash)
          if (cachedUrl) {
            await this.completeProfileUpdate({ event: 'contacts:avatar', restore: true, payload: { jid: mapping.jid, avatar: cachedUrl, avatarHash: mapping.hash } }, snapshot(mapping.jid, mapping.hash))
          } else {
            // At least set the hash so we can try fetching later
            await this.completeProfileUpdate({ event: 'contacts:avatar', restore: true, payload: { jid: mapping.jid, avatar: null, avatarHash: mapping.hash } }, snapshot(mapping.jid, mapping.hash))
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
    const snapshot = this.avatarState.snapshot()
    try {
      const mappings = await getAllAvatarHashes('room')
      for (const mapping of mappings) {
        // Only restore if the room exists in store
        const room = this.deps.stores?.room.getRoom(mapping.jid)
        if (room && !room.avatarHash) {
          // Try to restore the full avatar from cache
          const cachedUrl = await getCachedAvatar(mapping.hash)
          if (cachedUrl) {
            const version = snapshot(mapping.jid, mapping.hash)
            if (!version.positive()) continue
            version.apply(() => this.deps.emitSDK('room:updated', {
              roomJid: mapping.jid,
              updates: { avatar: cachedUrl, avatarHash: mapping.hash },
            }))
          } else {
            // At least set the hash so we can try fetching later
            snapshot(mapping.jid, mapping.hash).apply(() => this.deps.emitSDK('room:updated', {
              roomJid: mapping.jid,
              updates: { avatarHash: mapping.hash },
            }))
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
    const snapshot = this.avatarState.snapshot()
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
            await this.completeProfileUpdate({ event: 'connection:own-avatar', accountJid: ownBareJid, payload: { avatar: url, hash: mapping.hash } }, snapshot(mapping.jid, mapping.hash))
            continue
          }
          const contact = this.deps.stores?.roster.getContact(mapping.jid)
          if (contact) {
            await this.completeProfileUpdate({ event: 'contacts:avatar', restore: true, payload: { jid: mapping.jid, avatar: url, avatarHash: mapping.hash } }, snapshot(mapping.jid, mapping.hash))
          }
        } else if (mapping.type === 'room') {
          const room = this.deps.stores?.room.getRoom(mapping.jid)
          if (room) {
            const version = snapshot(mapping.jid, mapping.hash)
            if (!version.positive()) continue
            version.apply(() => this.deps.emitSDK('room:updated', {
              roomJid: mapping.jid,
              updates: { avatar: url, avatarHash: mapping.hash },
            }))
          }
        }
      }

      // Hash mappings or image bytes can be evicted while the roster retains a
      // blob URL. Recover those contacts only through the owner's snapshot:
      // a displayed hash must not supersede a newer pending announcement.
      const contacts = this.deps.stores?.roster?.sortedContacts?.() ?? []
      for (const contact of contacts) {
        if (!contact.avatarHash || this.deps.stores?.roster.getContact(contact.jid)?.avatarHash !== contact.avatarHash) continue
        const url = freshUrls.get(contact.avatarHash)
        if (url) {
          if (contact.avatar !== url) {
            await this.updateAvatar(contact.jid, url, contact.avatarHash, snapshot(contact.jid, contact.avatarHash))
          }
        } else if (!contact.avatar || contact.avatar.startsWith('blob:')) {
          // Only refetch contacts whose current pointer is empty or a revoked
          // blob: URL — leave data: URIs and other live pointers untouched.
          this.fetchAvatarData(contact.jid, contact.avatarHash, snapshot(contact.jid, contact.avatarHash)).catch(() => {})
        }
      }

      // MUC occupant avatars live in each room's occupant map (keyed by nick),
      // not in the contact/room hash store, so the loop above never touches
      // them. After blob invalidation (WebKit reclaiming memory on sleep, or
      // revokeAllBlobUrls on disconnect) their URLs are dead and were never
      // re-pointed — the cause of broken occupant avatars ("img blob:" load
      // failures) when reading public groups. Re-point each occupant whose
      // cached avatar hash has a fresh URL.
      this.deps.flushRoomOccupants?.()
      const joinedRooms = this.deps.stores?.room?.joinedRooms?.() ?? []
      for (const room of joinedRooms) {
        for (const occupant of room.occupants.values()) {
          if (!occupant.avatarHash) continue
          const url = freshUrls.get(occupant.avatarHash)
          if (!url) continue
          await this.completeProfileUpdate({ event: 'room:occupant-avatar', payload: {
            roomJid: room.jid,
            nick: occupant.nick,
            ...(occupant.occupantId && { occupantId: occupant.occupantId }),
            avatar: url,
            avatarHash: occupant.avatarHash,
          } }, snapshotOccupantAvatar(snapshot, room.jid, occupant.nick, occupant.avatarHash, occupant.jid, occupant.occupantId))
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
          await this.completeProfileUpdate({ event: 'room:occupant-avatar', payload: {
            roomJid: room.jid,
            ...(nick && { nick }),
            occupantId,
            avatar: url,
            avatarHash: hash,
          } }, snapshotOccupantAvatar(snapshot, room.jid, nick ?? '', hash, undefined, occupantId))
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
    const snapshot = this.avatarState.snapshot()
    try {
      const room = this.getRoomWithOccupants(roomJid)
      if (!room) return

      for (const [nick, occupant] of room.occupants) {
        // Skip occupants that already have an avatar or don't have a real JID
        if (occupant.avatar || !occupant.jid) continue

        const bareJid = getBareJid(occupant.jid)
        const hash = await getAvatarHash(bareJid)
        if (!hash) continue

        const cachedUrl = await getCachedAvatar(hash)
        if (cachedUrl) {
          await this.completeProfileUpdate({ event: 'room:occupant-avatar', payload: {
            roomJid,
            nick,
            ...(occupant.occupantId && { occupantId: occupant.occupantId }),
            avatar: cachedUrl,
            avatarHash: hash,
          } }, snapshotOccupantAvatar(snapshot, roomJid, nick, hash, bareJid, occupant.occupantId))
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
          await this.completeProfileUpdate({ event: 'room:occupant-avatar', payload: {
            roomJid,
            ...(nick && { nick }),
            occupantId,
            avatar: cachedUrl,
            avatarHash: hash,
          } }, snapshotOccupantAvatar(snapshot, roomJid, nick ?? '', hash, undefined, occupantId))
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
