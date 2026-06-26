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

import { Element, xml } from '@xmpp/client'
import { getBareJid } from '../jid'
import { readStashedEncryptedPayload } from '../e2ee/stanzaDecrypt'
import {
  NS_DELAY,
  NS_REPLY,
  NS_OOB,
  NS_THUMBS,
  NS_FILE_METADATA,
  NS_STANZA_ID,
  NS_XHTML,
  NS_FASTEN,
} from '../namespaces'
import type { FileAttachment, FileEncryption, ThumbnailInfo, LinkPreview, ReplyInfo } from '../types'
import { processFallback } from '../../utils/fallbackUtils'
import { CHAT_FALLBACK_TARGETS, ROOM_FALLBACK_TARGETS } from '../../utils/fallbackRegistry'
import { isAesgcmUri, parse as parseAesgcmUri } from './AesgcmUri'
import { logWarn } from '../logger'

/**
 * Parse XEP-0422 apply-to fastening with OGP metadata for link previews.
 * Returns LinkPreview if valid OGP metadata is found, null otherwise.
 */
export function parseOgpFastening(applyToEl: Element): LinkPreview | null {
  // Look for external element containing OGP meta-tags
  const externalEl = applyToEl.getChild('external', NS_FASTEN)
  if (!externalEl) return null

  // Get all meta-elements with OGP properties
  const metaEls = externalEl.getChildren('meta', NS_XHTML)
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

  if (expectedBy) {
    const expectedBare = getBareJid(expectedBy)
    for (const el of stanzaIdEls) {
      if (el.attrs.id && el.attrs.by && getBareJid(el.attrs.by) === expectedBare) {
        return el.attrs.id
      }
    }
  }

  // Fallback: first stanza-id carrying an id (legacy single-archive behaviour).
  for (const el of stanzaIdEls) {
    if (el.attrs.id) {
      return el.attrs.id
    }
  }
  return undefined
}

/**
 * Parse XEP-0359 origin-id from a message element.
 * Returns the sender-assigned stable ID (if the sender supports XEP-0359).
 */
export function parseOriginId(messageEl: Element): string | undefined {
  const originIdEl = messageEl.getChild('origin-id', NS_STANZA_ID)
  return originIdEl?.attrs.id
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
}

/**
 * Result from parseMessageContent
 */
export interface ParsedMessageContent {
  timestamp: Date
  isDelayed: boolean
  stanzaId?: string
  originId?: string
  noStyling: boolean
  replyTo?: ReplyInfo
  attachment?: FileAttachment
  processedBody: string
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
  } = options

  const fallbackTargets = messageContext === 'room' ? ROOM_FALLBACK_TARGETS : CHAT_FALLBACK_TARGETS

  // XEP-0203: Parse timestamp from delay element
  let timestamp = new Date()
  let isDelayed = forceDelayed
  const delay = delayEl || messageEl.getChild('delay', NS_DELAY)
  if (delay) {
    const stamp = delay.attrs.stamp
    if (stamp) {
      timestamp = new Date(stamp)
      isDelayed = true
    }
  }
  // E2EE in-envelope timestamp (e.g. XEP-0373 §4.1 `<time/>`) is sender-
  // attested and signed inside the ciphertext — more trustworthy than
  // `<delay/>`, which an intermediate server can rewrite. When present,
  // it wins. `isDelayed` is preserved as-is: whether this message is
  // historical from the receiver's POV is independent of the authored-at
  // source (a live MAM catch-up arrival is still "delayed").
  if (authoredAt) {
    timestamp = authoredAt
  }

  // XEP-0359: Unique stanza ID (server-assigned) and origin ID (sender-assigned).
  // Prefer the stanza-id stamped by the queried archive (expectedStanzaIdBy) so
  // it is valid as a MAM pagination cursor and cross-client reference.
  const stanzaId = parseStanzaId(messageEl, expectedStanzaIdBy)
  const originId = parseOriginId(messageEl)

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

  // XEP-0428: Process fallback text removal
  const { processedBody, fallbackBody } = processFallback(messageEl, body, { validTargets: fallbackTargets }, replyTo)

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

  return {
    timestamp,
    isDelayed,
    stanzaId,
    originId,
    noStyling,
    replyTo,
    attachment,
    processedBody: finalBody,
  }
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
}): boolean {
  return (
    content.processedBody.trim().length > 0 ||
    content.attachment != null ||
    content.hasPoll === true ||
    content.hasPollClosed === true ||
    content.hasEncryptedContent === true
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

/**
 * Result of applying a correction to a message.
 */
export interface CorrectionResult {
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
}

/**
 * Apply correction to a message.
 * Used by both live message handling and MAM processing.
 *
 * @param messageEl - The correction message element
 * @param body - The new body text
 * @param originalBody - The original body text (before any corrections)
 * @returns Correction data to apply
 */
export function applyCorrection(
  messageEl: Element,
  body: string,
  originalBody: string
): CorrectionResult {
  const parsed = parseMessageContent({ messageEl, body })
  return {
    body: parsed.processedBody,
    isEdited: true,
    originalBody,
    ...(parsed.attachment && { attachment: parsed.attachment }),
    // Always present (string when the correction is still encrypted, undefined
    // otherwise) so callers can unconditionally stamp/clear the target's
    // encryptedPayload — see CorrectionResult.encryptedPayload.
    encryptedPayload: readStashedEncryptedPayload(messageEl),
  }
}
