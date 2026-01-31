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

import { Element } from '@xmpp/client'
import { getBareJid } from '../jid'
import {
  NS_DELAY,
  NS_REPLY,
  NS_OOB,
  NS_THUMBS,
  NS_FILE_METADATA,
  NS_STANZA_ID,
  NS_CORRECTION,
  NS_XHTML,
  NS_FASTEN,
} from '../namespaces'
import type { FileAttachment, ThumbnailInfo, LinkPreview, ReplyInfo } from '../types'
import { processFallback } from '../../utils/fallbackUtils'

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

  const url = urlEl.text()
  if (!url) return undefined

  // Get optional description
  const descEl = oobEl.getChild('desc')
  const desc = descEl?.text()

  // XEP-0264: Parse thumbnail info if present
  let thumbnail: ThumbnailInfo | undefined
  const thumbEl = oobEl.getChild('thumbnail', NS_THUMBS)
  if (thumbEl) {
    const { uri, width, height } = thumbEl.attrs
    const mediaType = thumbEl.attrs['media-type']
    if (uri && mediaType && width && height) {
      thumbnail = {
        uri,
        mediaType,
        width: parseInt(width, 10),
        height: parseInt(height, 10),
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
  }
}

/**
 * Parse XEP-0359 stanza-id from a message element.
 * Returns the first stanza-id found (typically assigned by server or MUC service).
 */
export function parseStanzaId(messageEl: Element): string | undefined {
  const stanzaIdEls = messageEl.getChildren('stanza-id', NS_STANZA_ID)
  for (const el of stanzaIdEls) {
    if (el.attrs.id) {
      return el.attrs.id
    }
  }
  return undefined
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
  /** Valid fallback 'for' targets to strip (default: [NS_REPLY, NS_OOB, NS_CORRECTION]) */
  fallbackTargets?: string[]
  /** Keep full JID in replyTo.to (for room messages) instead of converting to bare JID */
  preserveFullReplyToJid?: boolean
}

/**
 * Result from parseMessageContent
 */
export interface ParsedMessageContent {
  timestamp: Date
  isDelayed: boolean
  stanzaId?: string
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
    fallbackTargets = [NS_REPLY, NS_OOB, NS_CORRECTION],
    preserveFullReplyToJid = false,
  } = options

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

  // XEP-0359: Unique stanza ID
  const stanzaId = parseStanzaId(messageEl)

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
    noStyling,
    replyTo,
    attachment,
    processedBody: finalBody,
  }
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
  }
}
