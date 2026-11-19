/**
 * Shared utilities for message content parsing.
 *
 * These utilities are used by both Chat and MUC modules to parse
 * common message elements from both real-time and MAM-retrieved messages.
 *
 * @module messagingUtils
 * @category Modules
 * @internal
 */

import type { MessageImplState } from '../types/message-internal'
import { Element, xml } from '@xmpp/client'
import { getBareJid } from '../jid'
import { readStashedEncryptedPayload, readStashedContentAvailability } from '../e2ee/stanzaDecrypt'
import {
  NS_DELAY,
  NS_REFERENCE,
  NS_FALLBACK,
  NS_FORWARD,
  NS_FORWARD_QUOTE,
  NS_REPLY,
  NS_OOB,
  NS_THUMBS,
  NS_FILE_METADATA,
  NS_STANZA_ID,
  NS_XHTML,
  NS_FASTEN,
  NS_REACTIONS,
  NS_RETRACT,
  NS_CORRECTION,
} from '../namespaces'
import type { Message, ForwardedCopy, MessageReference, DataReference, FileAttachment, FileEncryption, ThumbnailInfo, LinkPreview, ReplyInfo } from '../types'
import { processFallback, rebaseFallbackOffset } from '../../utils/fallbackUtils'
import { CHAT_FALLBACK_TARGETS, ROOM_FALLBACK_TARGETS } from '../../utils/fallbackRegistry'
import { isAesgcmUri, parse as parseAesgcmUri } from './AesgcmUri'
import { fromCodePointOffset } from '../../utils/xep0426'
import { parseRoomMessageLink } from '../../utils/roomMessageLink'
import { logWarn } from '../logger'

/**
 * Parse XEP-0422 apply-to fastening with OGP metadata for link previews.
 * Returns LinkPreview if valid OGP metadata is found, null otherwise.
 */
export function parseOgpFastening(applyToEl: Element): LinkPreview | null {
  // OGP <meta> elements are direct children of <apply-to> (Prosody mod_ogp
  // convention). Older Fluux builds wrapped them in <external name='ogp'>, which
  // is invalid per XEP-0422 — still accept that shape so previews sent by those
  // builds keep rendering.
  const externalEl = applyToEl.getChild('external', NS_FASTEN)
  const metaEls = (externalEl ?? applyToEl).getChildren('meta', NS_XHTML)
  if (metaEls.length === 0) return null

  let url: string | undefined
  let title: string | undefined
  let description: string | undefined
  let image: string | undefined
  let siteName: string | undefined

  for (const meta of metaEls) {
    const property = meta.attrs.property
    const content = meta.attrs.content
    if (!property || !content) continue

    switch (property) {
      case 'og:url':
        url = content
        break
      case 'og:title':
        title = content
        break
      case 'og:description':
        description = content
        break
      case 'og:image':
        image = content
        break
      case 'og:site_name':
        siteName = content
        break
    }
  }

  // URL is required
  if (!url) return null

  return {
    url,
    ...(title && { title }),
    ...(description && { description }),
    ...(image && { image }),
    ...(siteName && { siteName }),
  }
}

/**
 * Parse XEP-0066 Out of Band Data with optional XEP-0264 thumbnail and XEP-0446 file metadata.
 * Returns FileAttachment if OOB data is present.
 */
export function parseOobData(stanza: Element): FileAttachment | undefined {
  const oobEl = stanza.getChild('x', NS_OOB)
  if (!oobEl) return undefined

  const urlEl = oobEl.getChild('url')
  if (!urlEl) return undefined

  const rawUrl = urlEl.text()
  if (!rawUrl) return undefined

  // XEP-0454: if the URL is an aesgcm:// URI, parse out the IV+key from the
  // fragment and rebuild the plain HTTPS URL. The UI layer uses the HTTPS
  // URL to fetch the ciphertext and the `encryption` params to decrypt it.
  //
  // An aesgcm:// URI inbound here must have ridden inside an E2EE
  // `<payload/>` — if it ever appears at a plaintext stanza root that's
  // either a misconfigured sender leaking their key to the server or a
  // downgrade attempt. We don't reject (harmless to render as encrypted
  // anyway — the fragment is already in the clear at that point), but we
  // log so operators can spot it.
  let url = rawUrl
  let encryption: FileEncryption | undefined
  if (isAesgcmUri(rawUrl)) {
    try {
      const parts = parseAesgcmUri(rawUrl)
      url = parts.httpsUrl
      encryption = { cipher: 'aes-256-gcm', key: parts.key, iv: parts.iv }
    } catch (err) {
      logWarn(`parseOobData: malformed aesgcm:// URI — falling back to raw URL: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Get optional description
  const descEl = oobEl.getChild('desc')
  const desc = descEl?.text()

  // XEP-0264: Parse thumbnail info if present
  let thumbnail: ThumbnailInfo | undefined
  const thumbEl = oobEl.getChild('thumbnail', NS_THUMBS)
  if (thumbEl) {
    const { uri: rawThumbUri, width, height } = thumbEl.attrs
    const mediaType = thumbEl.attrs['media-type']
    if (rawThumbUri && mediaType && width && height) {
      let thumbUri = rawThumbUri
      let thumbEncryption: FileEncryption | undefined
      if (isAesgcmUri(rawThumbUri)) {
        try {
          const parts = parseAesgcmUri(rawThumbUri)
          thumbUri = parts.httpsUrl
          thumbEncryption = { cipher: 'aes-256-gcm', key: parts.key, iv: parts.iv }
        } catch (err) {
          logWarn(`parseOobData: malformed aesgcm:// thumbnail URI — keeping raw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      thumbnail = {
        uri: thumbUri,
        mediaType,
        width: parseInt(width, 10),
        height: parseInt(height, 10),
        ...(thumbEncryption && { encryption: thumbEncryption }),
      }
    }
  }

  // XEP-0446: Parse file metadata element for original dimensions
  let fileWidth: number | undefined
  let fileHeight: number | undefined
  let fileSize: number | undefined
  let fileName: string | undefined
  let fileMediaType: string | undefined
  const fileEl = stanza.getChild('file', NS_FILE_METADATA)
  if (fileEl) {
    const widthEl = fileEl.getChild('width')
    const heightEl = fileEl.getChild('height')
    const sizeEl = fileEl.getChild('size')
    const nameEl = fileEl.getChild('name')
    const mediaTypeEl = fileEl.getChild('media-type')
    if (widthEl?.text()) fileWidth = parseInt(widthEl.text(), 10)
    if (heightEl?.text()) fileHeight = parseInt(heightEl.text(), 10)
    if (sizeEl?.text()) fileSize = parseInt(sizeEl.text(), 10)
    if (nameEl?.text()) fileName = nameEl.text()
    if (mediaTypeEl?.text()) fileMediaType = mediaTypeEl.text()
  }

  // Extract filename from URL (fallback if not in XEP-0446)
  let name: string | undefined = fileName
  if (!name) {
    try {
      const urlObj = new URL(url)
      const pathname = urlObj.pathname
      const lastSegment = pathname.split('/').pop()
      if (lastSegment && !lastSegment.includes('.')) {
        name = undefined // No extension, likely not a filename
      } else {
        name = lastSegment ? decodeURIComponent(lastSegment) : undefined
      }
    } catch {
      // Invalid URL, skip name extraction
    }
  }

  // Use description as name if provided (override URL-extracted name)
  if (desc) name = desc

  // Determine media type - prefer XEP-0446, fallback to URL extension
  let mediaType: string | undefined = fileMediaType
  if (!mediaType && name) {
    const ext = name.split('.').pop()?.toLowerCase()
    const mimeMap: Record<string, string> = {
      // Images
      'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
      'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
      'svg': 'image/svg+xml',
      // Audio
      'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
      'oga': 'audio/ogg', 'flac': 'audio/flac', 'm4a': 'audio/mp4',
      'aac': 'audio/aac', 'wma': 'audio/x-ms-wma', 'opus': 'audio/opus',
      'weba': 'audio/webm', 'aif': 'audio/aiff', 'aiff': 'audio/aiff',
      'mid': 'audio/midi', 'midi': 'audio/midi', 'caf': 'audio/x-caf',
      // Video
      'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
      'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska', 'm4v': 'video/mp4',
      'wmv': 'video/x-ms-wmv', '3gp': 'video/3gpp', 'ogv': 'video/ogg',
      // Documents
      'pdf': 'application/pdf',
      // DjVu: registered under image/* by IANA but browsers cannot render it,
      // so map straight to the application/ type used for the file card.
      'djvu': 'application/x-djvu', 'djv': 'application/x-djvu',
    }
    mediaType = ext ? mimeMap[ext] : undefined
  }
  // Note: We intentionally do NOT use thumbnail.mediaType as a fallback
  // because thumbnails are always images, even for video files

  return {
    url,
    ...(name && { name }),
    ...(fileSize !== undefined && { size: fileSize }),
    ...(mediaType && { mediaType }),
    ...(fileWidth !== undefined && { width: fileWidth }),
    ...(fileHeight !== undefined && { height: fileHeight }),
    ...(thumbnail && { thumbnail }),
    ...(encryption && { encryption }),
  }
}

/**
 * Parse XEP-0359 stanza-id from a message element.
 *
 * Per XEP-0359/XEP-0313 a message can carry multiple `<stanza-id by="..."/>`
 * elements stamped by different archiving entities (e.g. the user's own server
 * AND a MUC service). Only the id stamped by the *queried* archive is valid as
 * a MAM RSM pagination cursor (`<before>`) or a stable cross-client reference —
 * using a foreign one makes mod_mam reject backward queries with
 * `item-not-found`.
 *
 * When `expectedBy` is provided, prefers the `<stanza-id>` whose `by` matches it
 * (compared on a bare-JID basis): the user's own bare JID for 1:1 chats, the
 * room bare JID for MUC. Falls back to the first stanza-id when no `by` matches
 * or when `expectedBy` is omitted (preserving legacy single-archive behaviour).
 *
 * @param messageEl - The message element to read the stanza-id from.
 * @param expectedBy - Bare (or full) JID of the archive whose stanza-id is wanted.
 */
export function parseStanzaId(messageEl: Element, expectedBy?: string): string | undefined {
  const stanzaIdEls = messageEl.getChildren('stanza-id', NS_STANZA_ID)

  const archiveId = parseArchiveStanzaId(messageEl, expectedBy)
  if (archiveId) return archiveId

  // Fallback: first stanza-id carrying an id (legacy single-archive behaviour).
  for (const el of stanzaIdEls) {
    if (el.attrs.id) {
      return el.attrs.id
    }
  }
  return undefined
}

export function parseArchiveStanzaId(messageEl: Element, expectedBy?: string): string | undefined {
  if (!expectedBy) return undefined
  const expectedBare = getBareJid(expectedBy)
  return messageEl.getChildren('stanza-id', NS_STANZA_ID).find(el =>
    el.attrs.id && el.attrs.by && getBareJid(el.attrs.by) === expectedBare
  )?.attrs.id
}

/**
 * Parse XEP-0359 origin-id from a message element.
 * Returns the sender-assigned stable ID (if the sender supports XEP-0359).
 */
export function parseOriginId(messageEl: Element): string | undefined {
  const originIdEl = messageEl.getChild('origin-id', NS_STANZA_ID)
  return originIdEl?.attrs.id
}

export function parseCorrectionIds(messageEl: Element, expectedBy?: string, archiveId?: string): string[] {
  const originId = parseOriginId(messageEl)
  const stanzaId = parseArchiveStanzaId(messageEl, expectedBy) ?? archiveId
  return [...(messageEl.attrs.id ? [`id:${messageEl.attrs.id}`] : []), ...(originId ? [`origin:${originId}`] : []), ...(stanzaId ? [`stanza:${stanzaId}`] : [])]
}

/**
 * Create an XEP-0359 origin-id element for outgoing stanzas.
 * The origin-id is a sender-assigned stable ID that survives archiving,
 * enabling echo deduplication before the server assigns a stanza-id.
 */
export function createOriginIdElement(id: string): Element {
  return xml('origin-id', { xmlns: NS_STANZA_ID, id })
}

/**
 * Options for parseMessageContent
 */
export interface ParseMessageContentOptions {
  /** The message element to parse */
  messageEl: Element
  /** The raw message body text */
  body: string
  /** Optional delay element (XEP-0203) - extracted from forwarded wrapper for MAM */
  delayEl?: Element
  /** Force isDelayed=true (for MAM messages which are always historical) */
  forceDelayed?: boolean
  /** Message context — determines which fallback targets are stripped (default: 'chat') */
  messageContext?: 'chat' | 'room'
  /** Keep full JID in replyTo.to (for room messages) instead of converting to bare JID */
  preserveFullReplyToJid?: boolean
  /**
   * Sender-attested composition time recovered from inside an E2EE envelope
   * (e.g. XEP-0373 §4.1 `<time>`). When present, it overrides both the
   * stanza-level `<delay/>` and the default-to-now fallback: it's the only
   * timestamp on the message that wasn't set by an intermediary. Callers
   * that have no authenticated timestamp omit this field.
   */
  authoredAt?: Date
  /**
   * Bare (or full) JID of the archive whose XEP-0359 `<stanza-id>` should be
   * selected when the message carries several from different archiving entities
   * (see {@link parseStanzaId}). Pass the user's own bare JID for 1:1 chats and
   * the room bare JID for MUC. Omit to keep first-match behaviour.
   */
  expectedStanzaIdBy?: string
  archiveId?: string
}

/**
 * Where {@link ParsedMessageContent.timestamp} came from. `received` means no
 * date rode with the stanza and the local clock was used — a value that must
 * not be compared against server-dated timestamps from other devices.
 */
export type MessageTimestampSource = 'authored' | 'delay' | 'received'

/** Retain mention and data references without treating resource links as mentions. */
export function parseMessageReferences(stanza: Element): MessageReference[] | undefined {
  const body = stanza.getChildText('body') ?? ''
  const references: MessageReference[] = []
  for (const ref of stanza.getChildren('reference', NS_REFERENCE)) {
    const { type, uri, begin, end } = ref.attrs
    if ((type !== 'mention' && type !== 'data') || !uri) continue
    if (begin === undefined && end === undefined && type === 'data') {
      references.push({ type, uri })
      continue
    }
    if (!/^\d+$/.test(begin ?? '') || !/^\d+$/.test(end ?? '')) continue
    const start = Number(begin), stop = Number(end)
    if (start >= stop || stop > Array.from(body).length) continue
    references.push({ type, uri, begin: fromCodePointOffset(body, start), end: fromCodePointOffset(body, stop) })
  }
  attachForwardFallback(stanza, body, references)
  return references.length ? references : undefined
}

/**
 * XEP-0428: a `<fallback for="urn:fluux:forward-quote:0">` range marks a forward's generated
 * quote and link. It is kept on the data reference whose link it contains, never stripped
 * here: only a reader that can show the source hides it.
 */
function attachForwardFallback(stanza: Element, body: string, references: MessageReference[]): void {
  const codePoints = Array.from(body).length
  for (const fallback of stanza.getChildren('fallback')) {
    const el = fallback as Element
    if (el.attrs?.xmlns !== NS_FALLBACK || el.attrs?.for !== NS_FORWARD_QUOTE) continue
    const range = el.getChild('body', NS_FALLBACK)
    if (!range || !/^\d+$/.test(range.attrs.start ?? '') || !/^\d+$/.test(range.attrs.end ?? '')) continue
    const start = Number(range.attrs.start), stop = Number(range.attrs.end)
    if (start >= stop || stop > codePoints) continue
    const begin = fromCodePointOffset(body, start), end = fromCodePointOffset(body, stop)
    // The generated block ends with the source link, so the marker binds to the last link
    // inside the range: a room link quoted in the text above it is not the source.
    let target: DataReference | undefined
    for (const ref of references) {
      if (ref.type !== 'data' || ref.begin === undefined || ref.end === undefined || ref.begin < begin || ref.end > end
        || !parseRoomMessageLink(ref.uri)) continue
      if (!target || ref.end > target.end!) target = ref
    }
    if (target) target.forwardFallback = { begin, end }
  }
}

const MAX_FORWARDED_CODE_POINTS = 4000
const MAX_FORWARDED_AUTHOR_CODE_POINTS = 120
const MAX_FORWARDED_ADDRESS_CODE_POINTS = 1023

/** Drop control characters other than newline and tab, then bound the length in code points. */
function boundedPlainText(value: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '')
  const characters = Array.from(cleaned)
  return characters.length > limit ? `${characters.slice(0, limit).join('').trimEnd()}…` : cleaned
}

/**
 * XEP-0297: the one structured copy a message carries beside its own body. Bounded and
 * non-recursive: only the forwarded message's plain body, sender, original time and the
 * original's ids (the inner `id` and an XEP-0359 `<stanza-id/>` with its `by`) are read. The ids
 * are a claim used only to find the original in local history. A nested forward, receipts,
 * routing addresses and every other extension are ignored, and the
 * inner message is never routed as a message of its own. Attribution to the sender of the
 * outer message stays separate: the author here is only the forwarder's claim.
 */
export function parseForwardedCopy(messageEl: Element): ForwardedCopy | undefined {
  const forwarded = messageEl.getChildren('forwarded').find((el: Element) => el.attrs?.xmlns === NS_FORWARD)
  const inner = forwarded?.getChildren('message').find((el: Element) => !el.attrs?.xmlns || el.attrs.xmlns === 'jabber:client')
  const body = inner?.getChildren('body').find((el: Element) => !el.attrs?.xmlns || el.attrs.xmlns === 'jabber:client')
  const text = body ? boundedPlainText(body.text(), MAX_FORWARDED_CODE_POINTS) : ''
  if (!inner || !text.trim()) return undefined
  const from = typeof inner.attrs.from === 'string' ? inner.attrs.from : ''
  const slash = from.indexOf('/')
  const innerType = inner.attrs.type === 'chat' || inner.attrs.type === 'groupchat' ? inner.attrs.type : undefined
  // A room occupant is named by its nickname; a direct sender (type chat) by its bare address.
  const isOccupant = innerType !== 'chat' && slash >= 0 && slash < from.length - 1
  const bare = slash >= 0 ? from.slice(0, slash) : from
  const author = boundedPlainText(isOccupant ? from.slice(slash + 1) : bare, MAX_FORWARDED_AUTHOR_CODE_POINTS).trim()
  const stamp = forwarded?.getChild('delay', NS_DELAY)?.attrs.stamp
  const time = typeof stamp === 'string' ? new Date(stamp).getTime() : NaN
  const address = boundedPlainText(from, MAX_FORWARDED_ADDRESS_CODE_POINTS)
  // The original's ids are a claim for matching local history only, never an identity of this message.
  const bounded = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= MAX_FORWARDED_ADDRESS_CODE_POINTS && value === boundedPlainText(value, MAX_FORWARDED_ADDRESS_CODE_POINTS) ? value : undefined
  const sid = inner.getChildren('stanza-id').find((el: Element) => el.attrs?.xmlns === NS_STANZA_ID)
  const id = bounded(inner.attrs.id)
  const stanzaId = bounded(sid?.attrs.id)
  const stanzaIdBy = stanzaId ? bounded(sid?.attrs.by) : undefined
  return { author, ...(address && address === from && { from: address }), text,
    ...(id && { id }), ...(stanzaId && stanzaIdBy && { stanzaId, stanzaIdBy }), ...(innerType && { type: innerType }), ...(Number.isFinite(time) && { timestamp: time }) }
}

/**
 * XEP-0428: the part of the body that only stands in for the forwarded copy, as a
 * `<fallback for="urn:xmpp:forward:0">` range (code points in the raw body). Returned as
 * UTF-16 offsets, or undefined when it is missing or does not lie inside the body.
 */
function parseForwardedCopyFallback(messageEl: Element, body: string): { begin: number; end: number } | undefined {
  const codePoints = Array.from(body).length
  for (const fallback of messageEl.getChildren('fallback')) {
    const el = fallback as Element
    if (el.attrs?.xmlns !== NS_FALLBACK || el.attrs?.for !== NS_FORWARD) continue
    const range = el.getChild('body', NS_FALLBACK)
    if (!range || !/^\d+$/.test(range.attrs.start ?? '') || !/^\d+$/.test(range.attrs.end ?? '')) continue
    const start = Number(range.attrs.start), stop = Number(range.attrs.end)
    if (start >= stop || stop > codePoints) continue
    return { begin: fromCodePointOffset(body, start), end: fromCodePointOffset(body, stop) }
  }
  return undefined
}

/** Result from parseMessageContent. */
export interface ParsedMessageContent {
  timestamp: Date
  timestampSource: MessageTimestampSource
  archiveTimestamp?: number
  correctionIds: string[]
  correctionLegacyStanzaIds?: string[]
  isDelayed: boolean
  stanzaId?: string
  ownArchiveId?: string
  ownArchiveBy?: string
  originId?: string
  noStyling: boolean
  replyTo?: ReplyInfo
  attachment?: FileAttachment
  processedBody: string
  references?: MessageReference[]
  forwarded?: ForwardedCopy
}

/**
 * Shared message content parsing for real-time messages and MAM.
 * Handles common XEP parsing: delay, stanza-id, no-styling, reply, fallback, OOB.
 */
export function parseMessageContent(options: ParseMessageContentOptions): ParsedMessageContent {
  const {
    messageEl,
    body,
    delayEl,
    forceDelayed = false,
    messageContext = 'chat',
    preserveFullReplyToJid = false,
    authoredAt,
    expectedStanzaIdBy,
    archiveId,
  } = options

  const fallbackTargets = messageContext === 'room' ? ROOM_FALLBACK_TARGETS : CHAT_FALLBACK_TARGETS

  // XEP-0203: Parse timestamp from delay element
  let timestamp = new Date()
  let timestampSource: MessageTimestampSource = 'received'
  let isDelayed = forceDelayed
  const delay = delayEl || messageEl.getChild('delay', NS_DELAY)
  if (delay) {
    const stamp = delay.attrs.stamp
    if (stamp) {
      timestamp = new Date(stamp)
      timestampSource = 'delay'
      isDelayed = true
    }
  }
  const archiveTimestamp = timestampSource === 'delay' && Number.isFinite(timestamp.getTime()) ? timestamp.getTime() : undefined
  // E2EE in-envelope timestamp (e.g. XEP-0373 §4.1 `<time/>`) is sender-
  // attested and signed inside the ciphertext — more trustworthy than
  // `<delay/>`, which an intermediate server can rewrite. When present,
  // it wins. `isDelayed` is preserved as-is: whether this message is
  // historical from the receiver's POV is independent of the authored-at
  // source (a live MAM catch-up arrival is still "delayed").
  if (authoredAt) {
    timestamp = authoredAt
    timestampSource = 'authored'
  }

  // XEP-0359: Unique stanza ID (server-assigned) and origin ID (sender-assigned).
  // Prefer the stanza-id stamped by the queried archive (expectedStanzaIdBy) so
  // it is valid as a MAM pagination cursor and cross-client reference.
  const stanzaId = messageContext === 'room'
    ? parseArchiveStanzaId(messageEl, expectedStanzaIdBy) ?? archiveId
    : parseStanzaId(messageEl, expectedStanzaIdBy)
  const originId = parseOriginId(messageEl)
  const correctionStanzaId = parseArchiveStanzaId(messageEl, expectedStanzaIdBy) ?? archiveId

  // XEP-0393: Message styling hints
  const noStyling = !!messageEl.getChild('no-styling', 'urn:xmpp:styling:0')

  // XEP-0461: Message replies
  let replyTo: ReplyInfo | undefined
  const replyEl = messageEl.getChild('reply', NS_REPLY)
  if (replyEl) {
    const replyId = replyEl.attrs.id
    let replyToJid = replyEl.attrs.to
    if (replyId) {
      if (replyToJid && !preserveFullReplyToJid) {
        replyToJid = getBareJid(replyToJid)
      }
      replyTo = {
        id: replyId,
        ...(replyToJid && { to: replyToJid }),
      }
    }
  }

  // XEP-0066: Out of Band Data
  const attachment = parseOobData(messageEl)
  const parsedCopy = parseForwardedCopy(messageEl)

  // XEP-0428: Process fallback text removal
  const fallback = processFallback(messageEl, body, { validTargets: fallbackTargets }, replyTo)

  const { processedBody, fallbackBody } = fallback

  // Add fallbackBody to replyTo if extracted
  if (replyTo && fallbackBody) {
    replyTo.fallbackBody = fallbackBody
  }

  // For clients that don't send XEP-0428 fallback indication but include OOB URL in body:
  // Strip the attachment URL from the body if it matches the OOB URL
  let finalBody = processedBody
  if (attachment?.url && processedBody.includes(attachment.url)) {
    finalBody = processedBody.replace(attachment.url, '').trim()
  }

  // The marked quote is kept with the copy, never stripped here: only a reader that shows the
  // copy hides it. Reply and attachment fallback removal moves it; if it no longer fits, the
  // quote simply stays visible.
  let forwardedCopy = parsedCopy
  if (parsedCopy) {
    const marked = parseForwardedCopyFallback(messageEl, body)
    if (marked) {
      const rebased = finalBody === body ? marked
        : processedBody.length === finalBody.length
          ? { begin: rebaseFallbackOffset(marked.begin, fallback), end: rebaseFallbackOffset(marked.end, fallback) }
          : undefined
      if (rebased && rebased.begin < rebased.end && rebased.end <= finalBody.length) forwardedCopy = { ...parsedCopy, fallback: { ...rebased, text: finalBody.slice(rebased.begin, rebased.end) } }
    }
  }

  return {
    timestamp,
    timestampSource,
    archiveTimestamp,
    correctionIds: parseCorrectionIds(messageEl, expectedStanzaIdBy, archiveId),
    ...(stanzaId && stanzaId !== correctionStanzaId && { correctionLegacyStanzaIds: [stanzaId] }),
    isDelayed,
    stanzaId,
    ownArchiveId: parseArchiveStanzaId(messageEl, expectedStanzaIdBy),
    ownArchiveBy: expectedStanzaIdBy ? getBareJid(expectedStanzaIdBy) : undefined,
    originId,
    noStyling,
    replyTo,
    attachment,
    processedBody: finalBody,
    ...(messageContext !== 'room' && forwardedCopy && { forwarded: forwardedCopy }),
    references: rebaseForwardReferences(parseMessageReferences(messageEl), body, finalBody, fallback),
  }
}

/**
 * A forward's link and marker were parsed against the raw body; reply and OOB fallback
 * removal moves them. Rebase both together, and drop the marker (keeping the quote
 * visible) if the link no longer sits where the marker says.
 */
function rebaseForwardReferences(
  references: MessageReference[] | undefined,
  rawBody: string,
  finalBody: string,
  fallback: ReturnType<typeof processFallback>,
): MessageReference[] | undefined {
  if (finalBody === rawBody) return references
  return references?.map(ref => {
    if (ref.type !== 'data' || !ref.forwardFallback) return ref
    const { forwardFallback } = ref
    const begin = ref.begin === undefined ? undefined : rebaseFallbackOffset(ref.begin, fallback)
    const end = ref.end === undefined ? undefined : rebaseFallbackOffset(ref.end, fallback)
    const markerBegin = rebaseFallbackOffset(forwardFallback.begin, fallback)
    const markerEnd = rebaseFallbackOffset(forwardFallback.end, fallback)
    const valid = begin !== undefined && end !== undefined && finalBody.slice(begin, end) === ref.uri
      && markerBegin <= begin && end <= markerEnd && markerEnd <= finalBody.length
    return valid ? { ...ref, begin, end, forwardFallback: { begin: markerBegin, end: markerEnd } } : { type: 'data' as const, uri: ref.uri }
  })
}

/**
 * Whether a parsed message carries anything renderable.
 *
 * The upstream body-presence gates accept a message when its raw `<body>` is
 * non-empty. But XEP-0428 fallback processing can strip that body to nothing —
 * e.g. a XEP-0461 reply whose body is entirely the quoted fallback with no new
 * text. Such a message has empty `processedBody` and, unless it also carries an
 * attachment, poll, or encrypted payload, would render as a blank bubble. This
 * is the post-parse complement to the raw-body gate: callers drop a message
 * with no renderable content instead of storing an empty row.
 *
 * `processedBody` is checked after trimming so a whitespace-only remainder
 * counts as empty. Encrypted-but-bodiless entries are kept on purpose — the UI
 * renders a placeholder from `encryptedPayload`/`unsupportedEncryption`
 * (see issue #135).
 */
export function hasRenderableContent(content: {
  processedBody: string
  attachment?: unknown
  hasPoll?: boolean
  hasPollClosed?: boolean
  hasEncryptedContent?: boolean
  hasForwarded?: boolean
}): boolean {
  return (
    content.processedBody.trim().length > 0 ||
    content.attachment != null ||
    content.hasPoll === true ||
    content.hasPollClosed === true ||
    content.hasEncryptedContent === true ||
    content.hasForwarded === true
  )
}

/**
 * Result of applying a retraction to a message.
 */
export interface RetractionResult {
  isRetracted: true
  retractedAt: Date
}

/**
 * Apply retraction to a message.
 * Used by both live message handling and MAM processing.
 *
 * @param senderMatches - Whether the retraction sender matches the original message sender
 * @returns Retraction data to apply, or null if sender doesn't match
 */
export function applyRetraction(senderMatches: boolean): RetractionResult | null {
  if (!senderMatches) return null
  return {
    isRetracted: true,
    retractedAt: new Date(),
  }
}

export function correctionMarks(parsed: ParsedMessageContent): MessageImplState & { isEdited: true } {
  const dated = parsed.timestampSource !== 'received' && Number.isFinite(parsed.timestamp.getTime())
  return {
    isEdited: true,
    correctionTimestamp: dated ? parsed.timestamp.getTime() : undefined,
    correctionTimestampSource: dated ? parsed.timestampSource as 'authored' | 'delay' : undefined,
    correctionRevision: { ids: parsed.correctionIds, supersedes: [], archiveTimestamp: parsed.archiveTimestamp,
      ...(parsed.correctionLegacyStanzaIds && { legacyStanzaIds: parsed.correctionLegacyStanzaIds }),
    },
  }
}

/**
 * Result of applying a correction to a message.
 */
export interface CorrectionResult extends MessageImplState {
  references?: MessageReference[]
  body: string
  isEdited: true
  originalBody: string
  attachment?: FileAttachment
  /** Accumulated stanza-IDs from correction stanzas (for reply lookup) */
  correctionStanzaIds?: string[]
  /**
   * Serialized encrypted payload of the CORRECTION stanza when its new body
   * could not be decrypted at apply time (plugin not yet registered / key
   * locked). Callers must stamp this onto the target message — overwriting any
   * payload left by the original — so {@link XMPPClient.retryPendingDecrypts}
   * recovers the corrected text, not the stale original. `undefined` when the
   * correction was decrypted inline (or is cleartext): callers should then
   * clear the target's `encryptedPayload`, so a previously-stashed original
   * isn't re-decrypted on top of the applied correction.
   */
  encryptedPayload?: string
  contentAvailability?: Message['contentAvailability']
}

/**
 * Apply correction to a message.
 * Used by both live message handling and MAM processing.
 *
 * @param messageEl - The correction message element
 * @param body - The new body text
 * @param originalBody - The original body text (before any corrections)
 * @param options - Envelope date sources: the `<delay>` of a wrapping carbon or
 *   MAM `<forwarded>`, and the sender-signed in-envelope authored-at of an
 *   encrypted correction. Resolved by {@link parseMessageContent}.
 * @returns Correction data to apply
 */
export function applyCorrection(
  messageEl: Element,
  body: string,
  originalBody: string,
  options: { delayEl?: Element; authoredAt?: Date; expectedStanzaIdBy?: string; archiveId?: string } = {},
): CorrectionResult {
  const parsed = parseMessageContent({
    messageEl,
    body,
    ...(options.delayEl && { delayEl: options.delayEl }),
    ...(options.authoredAt && { authoredAt: options.authoredAt }),
    expectedStanzaIdBy: options.expectedStanzaIdBy,
    archiveId: options.archiveId,
  })
  return {
    body: parsed.processedBody,
    references: parsed.references,
    ...correctionMarks(parsed),
    originalBody,
    ...(parsed.attachment && { attachment: parsed.attachment }),
    // Always present (string when the correction is still encrypted, undefined
    // otherwise) so callers can unconditionally stamp/clear the target's
    // encryptedPayload — see CorrectionResult.encryptedPayload.
    encryptedPayload: readStashedEncryptedPayload(messageEl),
    contentAvailability: readStashedContentAvailability(messageEl),
  }
}

// ============================================================================
// Message signals (XEP-0444 reactions, XEP-0424 retraction, XEP-0308 correction)
//
// One parser per signal, shared by the three inbound paths — the Chat live
// path, the MAM archive path, and the E2EE deferred-decrypt retry. Parsing
// drifted when each path hand-rolled its own getChild/extraction (e.g. the
// emoji extraction existed in three copies); any change to signal parsing
// lands here exactly once.
// ============================================================================

/** Parsed XEP-0444 `<reactions>` signal. */
export interface ParsedReactionsSignal {
  /** The raw element, for handlers that need attributes beyond the id. */
  el: Element
  /** Target message id. Undefined for malformed/legacy stanzas without `id`. */
  targetId: string | undefined
  /** Emoji list; empty means "clear all my reactions" (a valid signal). */
  emojis: string[]
}

/**
 * Parse a XEP-0444 `<reactions>` child of a message stanza.
 * Returns null when the stanza carries no reactions element. A present
 * element with a missing `id` is still reported (targetId undefined) so the
 * live path can claim the stanza as handled instead of showing fallback text.
 */
export function parseReactionsSignal(messageEl: Element): ParsedReactionsSignal | null {
  const el = messageEl.getChild('reactions', NS_REACTIONS)
  if (!el) return null
  const emojis = el.getChildren('reaction').map((r) => r.getText()).filter(Boolean)
  return { el, targetId: el.attrs.id, emojis }
}

/** Parsed XEP-0424 `<retract>` signal. */
export interface ParsedRetractionSignal {
  /** The raw element — XEP-0425 v1 nests `<moderated>` inside it. */
  el: Element
  /** Target message id. Undefined for malformed stanzas without `id`. */
  targetId: string | undefined
}

/**
 * Parse a XEP-0424 `<retract>` child of a message stanza.
 * Returns null when the stanza carries no retract element.
 */
export function parseRetractionSignal(messageEl: Element): ParsedRetractionSignal | null {
  const el = messageEl.getChild('retract', NS_RETRACT)
  if (!el) return null
  return { el, targetId: el.attrs.id }
}

/** Parsed XEP-0308 `<replace>` signal. */
export interface ParsedCorrectionSignal {
  el: Element
  /** Target message id. Undefined for malformed stanzas without `id`. */
  targetId: string | undefined
}

/**
 * Parse a XEP-0308 `<replace>` child of a message stanza.
 * Returns null when the stanza carries no replace element. The corrected
 * body itself stays with the caller (live path and archive path source it
 * differently).
 */
export function parseCorrectionSignal(messageEl: Element): ParsedCorrectionSignal | null {
  const el = messageEl.getChild('replace', NS_CORRECTION)
  if (!el) return null
  return { el, targetId: el.attrs.id }
}

/**
 * Whether the stanza is a reaction/retraction/correction signal rather than
 * new message content. Used to skip signal stanzas where only genuine
 * messages are wanted (e.g. MAM preview/backfill scans).
 */
export function isMessageSignal(messageEl: Element): boolean {
  return !!(
    messageEl.getChild('reactions', NS_REACTIONS) ||
    messageEl.getChild('retract', NS_RETRACT) ||
    messageEl.getChild('replace', NS_CORRECTION)
  )
}
