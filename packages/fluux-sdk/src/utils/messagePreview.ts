/**
 * Message Preview Utilities
 *
 * Utilities for formatting message previews in conversation/room lists.
 */

import type { BaseMessage, FileAttachment, ReplyInfo } from '../core/types'

/**
 * Attachment emoji and label result
 */
export interface AttachmentDisplay {
  /** Emoji representing the file type */
  emoji: string
  /** Human-readable label for the file type */
  label: string
}

/**
 * Get emoji and label for a file attachment based on its media type.
 *
 * @param attachment - File attachment to analyze
 * @returns Object with emoji and label for the attachment type
 *
 * @example
 * ```typescript
 * getAttachmentEmoji({ mediaType: 'image/png', name: 'photo.png' })
 * // { emoji: '📷', label: 'Photo' }
 * ```
 */
export function getAttachmentEmoji(attachment: FileAttachment): AttachmentDisplay {
  const mediaType = attachment.mediaType?.toLowerCase() || ''
  const name = attachment.name?.toLowerCase() || ''

  // Images
  if (mediaType.startsWith('image/')) {
    return { emoji: '📷', label: 'Photo' }
  }

  // Videos
  if (mediaType.startsWith('video/')) {
    return { emoji: '🎬', label: 'Video' }
  }

  // Audio
  if (mediaType.startsWith('audio/')) {
    return { emoji: '🎵', label: 'Audio' }
  }

  // Code files
  const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.swift', '.kt', '.sql', '.sh', '.bash', '.zsh', '.css', '.html', '.htm']
  if (codeExtensions.some(ext => name.endsWith(ext)) ||
      mediaType.includes('javascript') || mediaType.includes('typescript') ||
      mediaType.includes('x-python') || mediaType.includes('x-ruby') ||
      mediaType.includes('x-rust') || mediaType.includes('x-go') ||
      mediaType.includes('x-java') || mediaType.includes('x-c') ||
      mediaType.includes('x-swift') || mediaType.includes('x-kotlin') ||
      mediaType.includes('x-sql') || mediaType.includes('x-shellscript')) {
    return { emoji: '💻', label: 'Code' }
  }

  // Text/Markdown files
  const textExtensions = ['.txt', '.md', '.markdown', '.json', '.xml', '.csv', '.log', '.yml', '.yaml', '.ini', '.cfg', '.conf', '.toml']
  if (textExtensions.some(ext => name.endsWith(ext)) ||
      mediaType.startsWith('text/') ||
      mediaType === 'application/json' ||
      mediaType === 'application/xml') {
    return { emoji: '📝', label: 'Text' }
  }

  // PDF
  if (mediaType === 'application/pdf' || name.endsWith('.pdf')) {
    return { emoji: '📕', label: 'PDF' }
  }

  // Ebooks (EPUB)
  if (mediaType === 'application/epub+zip' || name.endsWith('.epub')) {
    return { emoji: '📚', label: 'Book' }
  }

  // Spreadsheets (check before generic document)
  if (mediaType.includes('spreadsheet') || mediaType.includes('excel') ||
      name.endsWith('.xls') || name.endsWith('.xlsx')) {
    return { emoji: '📊', label: 'Spreadsheet' }
  }

  // Presentations (check before generic document)
  if (mediaType.includes('presentation') || mediaType.includes('powerpoint') ||
      name.endsWith('.ppt') || name.endsWith('.pptx')) {
    return { emoji: '📽️', label: 'Presentation' }
  }

  // Office documents (Word, RTF, etc.)
  if (mediaType.includes('word') || mediaType.includes('msword') ||
      name.endsWith('.doc') || name.endsWith('.docx') || name.endsWith('.rtf')) {
    return { emoji: '📄', label: 'Document' }
  }

  // Archives
  if (mediaType.includes('zip') || mediaType.includes('rar') || mediaType.includes('7z') ||
      mediaType.includes('tar') || mediaType.includes('gzip') ||
      name.endsWith('.zip') || name.endsWith('.rar') || name.endsWith('.7z') ||
      name.endsWith('.tar') || name.endsWith('.gz')) {
    return { emoji: '📦', label: 'Archive' }
  }

  // Default for unknown files
  return { emoji: '📎', label: 'File' }
}

/**
 * Strip message styling markup from text.
 *
 * Supports both XEP-0393 Message Styling and Markdown patterns:
 * - `**bold**` (Markdown) or `*bold*` (XEP-0393) → `bold`
 * - `_italic_` → `italic`
 * - `~~strikethrough~~` (Markdown) or `~strikethrough~` (XEP-0393) → `strikethrough`
 * - `` `code` `` → `code`
 *
 * @param text - Text that may contain styling markup
 * @returns Text with markup stripped
 */
export function stripMessageStyling(text: string): string {
  if (!text) return text

  let result = text

  // Strip inline code (backticks) - do this first to avoid processing markup inside code
  // Matches `code` but not ```code blocks```
  result = result.replace(/(?<!`)`([^`\n]+)`(?!`)/g, '$1')

  // Strip Markdown-style bold (**text**) - must come before single asterisk
  // Must be preceded by start or whitespace/punctuation, followed by end or whitespace/punctuation
  result = result.replace(/(?<=^|[\s\p{P}])\*\*([^\s*](?:[^*]*[^\s*])?)\*\*(?=$|[\s\p{P}])/gu, '$1')

  // Strip XEP-0393 bold (*text*)
  result = result.replace(/(?<=^|[\s\p{P}])\*([^\s*](?:[^*]*[^\s*])?)\*(?=$|[\s\p{P}])/gu, '$1')

  // Strip italic (_text_)
  result = result.replace(/(?<=^|[\s\p{P}])_([^\s_](?:[^_]*[^\s_])?)_(?=$|[\s\p{P}])/gu, '$1')

  // Strip Markdown-style strikethrough (~~text~~) - must come before single tilde
  result = result.replace(/(?<=^|[\s\p{P}])~~([^\s~](?:[^~]*[^\s~])?)~~(?=$|[\s\p{P}])/gu, '$1')

  // Strip XEP-0393 strikethrough (~text~)
  result = result.replace(/(?<=^|[\s\p{P}])~([^\s~](?:[^~]*[^\s~])?)~(?=$|[\s\p{P}])/gu, '$1')

  return result
}

/**
 * Strip reply quote prefix from message body.
 *
 * When a message is a reply and the server/client didn't use XEP-0428 fallback
 * indication (or it wasn't processed), the body may still contain quoted text
 * in the format "> Author: quoted text\nActual reply".
 *
 * This function strips those quote lines to return just the reply content.
 *
 * @param body - The message body that may contain quote lines
 * @returns The body with quote lines stripped
 */
export function stripReplyQuote(body: string): string {
  if (!body) return body

  // Split into lines and find where the quote ends
  const lines = body.split('\n')
  let firstNonQuoteLine = 0

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('> ')) {
      firstNonQuoteLine = i
      break
    }
    // If we've gone through all lines and they're all quotes, return empty
    if (i === lines.length - 1) {
      return ''
    }
  }

  // Return everything after the quote lines, trimmed
  return lines.slice(firstNonQuoteLine).join('\n').trim()
}

/**
 * Format a message body for preview, including attachment indicator.
 * Returns the formatted preview string suitable for conversation lists.
 *
 * Works with any message type (chat or groupchat) since it only uses
 * shared fields from {@link BaseMessage}: `body`, `attachment`, and `replyTo`.
 *
 * For reply messages, this function ensures only the reply content is shown,
 * not the quoted original message (which may still be in the body if the
 * sender didn't use XEP-0428 fallback indication).
 *
 * @param message - Any message object with body, optional attachment, and optional replyTo
 * @returns Formatted preview string
 *
 * @example
 * ```typescript
 * formatMessagePreview({ body: 'Hello', attachment: undefined })
 * // 'Hello'
 *
 * formatMessagePreview({ body: '', attachment: { mediaType: 'image/png', name: 'photo.png' } })
 * // '📷 photo.png'
 *
 * // Reply with quote still in body (no XEP-0428)
 * formatMessagePreview({ body: '> Bob: hi\nMy reply', replyTo: { id: '123' } })
 * // 'My reply'
 * ```
 */
export function formatMessagePreview(message: Pick<BaseMessage, 'body' | 'attachment' | 'replyTo'>): string {
  const { body, attachment, replyTo } = message as { body: string; attachment?: FileAttachment; replyTo?: ReplyInfo }

  // For replies, strip any quote prefix that may still be in the body
  // (in case XEP-0428 fallback indication wasn't used)
  let previewBody = body || ''
  if (replyTo && previewBody.startsWith('> ')) {
    previewBody = stripReplyQuote(previewBody)
  }

  // Strip XEP-0393 message styling markup for cleaner previews
  previewBody = stripMessageStyling(previewBody)

  if (attachment) {
    const { emoji } = getAttachmentEmoji(attachment)
    // If there's body text, show emoji + body
    // If no body, show emoji + filename or label
    if (previewBody && previewBody.trim()) {
      return `${emoji} ${previewBody}`
    }
    const { label } = getAttachmentEmoji(attachment)
    return `${emoji} ${attachment.name || label}`
  }

  return previewBody
}
