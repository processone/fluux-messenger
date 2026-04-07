import { memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { renderStyledMessage } from '@/utils/messageStyles'
import type { MentionReference } from '@fluux/sdk'

// Check if message is a /me action message
function isActionMessage(body: string | undefined): boolean {
  return body?.startsWith('/me ') ?? false
}

// Extract the action part from a /me message (everything after "/me ")
function getActionText(body: string): string {
  return body.slice(4) // Remove "/me "
}

export interface MessageBodyProps {
  /** Message body text (already processed by SDK - OOB URLs stripped) */
  body: string
  /** Whether message was edited */
  isEdited?: boolean
  /** Original body before editing (for tooltip) */
  originalBody?: string
  /** Whether message has been retracted/deleted */
  isRetracted?: boolean
  /** Whether message was moderated (retracted by a moderator) */
  isModerated?: boolean
  /** Nick of the moderator who retracted the message */
  moderatedBy?: string
  /** Reason provided for the moderation */
  moderationReason?: string
  /** Whether to disable text styling (code blocks, links, etc.) */
  noStyling?: boolean
  /** Sender display name (for /me actions) */
  senderName: string
  /** Sender color (for /me actions) */
  senderColor: string
  /** Mention references for highlighting (room messages) */
  mentions?: MentionReference[]
  /** User's nickname in the room (for IRC-style mention detection fallback) */
  nickname?: string
  /** Known occupant nicknames in the room (for IRC-style prefix mention highlighting) */
  knownNicks?: ReadonlySet<string>
  /** Whether the app is in dark mode (for mention color generation) */
  isDarkMode?: boolean
  /** Search terms to highlight in the message body (from search query) */
  highlightTerms?: string[]
  /** Whether this message is the current find-on-page match */
  isCurrentMatch?: boolean
}

/**
 * Renders the message body text with support for:
 * - Regular messages with styling (code, links, mentions)
 * - /me action messages (italic with inline sender name)
 * - Edited indicator with original body tooltip
 * - Retracted message placeholder
 */
export const MessageBody = memo(function MessageBody({
  body,
  isEdited,
  originalBody,
  isRetracted,
  isModerated,
  moderatedBy,
  moderationReason,
  noStyling,
  senderName,
  senderColor,
  mentions,
  nickname,
  knownNicks,
  isDarkMode,
  highlightTerms,
  isCurrentMatch,
}: MessageBodyProps) {
  const { t } = useTranslation()

  // Retracted message
  if (isRetracted) {
    const label = isModerated && moderatedBy
      ? t('chat.messageModerated', { moderator: moderatedBy })
      : t('chat.messageDeleted')
    return (
      <div className="text-fluux-muted italic" title={moderationReason || undefined}>
        {label}
      </div>
    )
  }

  // If body is empty (e.g., was just attachment URL, now stripped by SDK), hide it
  if (!body) {
    return null
  }

  const wrap = (node: ReactNode) =>
    highlightTerms && highlightTerms.length > 0
      ? <SearchHighlight terms={highlightTerms} isCurrent={isCurrentMatch}>{node}</SearchHighlight>
      : node

  // /me action message
  if (isActionMessage(body)) {
    return (
      <div dir="auto" className="text-fluux-text/85 italic break-words whitespace-pre-wrap leading-[1.375]">
        <span className="text-fluux-muted me-1">*</span>
        <span className="font-medium" style={{ color: senderColor }}>
          {senderName}
        </span>
        {' '}
        {wrap(noStyling ? getActionText(body) : renderStyledMessage(getActionText(body), mentions, nickname, knownNicks, isDarkMode))}
        {isEdited && (
          <EditedIndicator
            originalBody={originalBody}
            className="not-italic"
          />
        )}
      </div>
    )
  }

  // Regular message
  return (
    <div dir="auto" className="text-fluux-text break-words whitespace-pre-wrap leading-[1.375]">
      {wrap(noStyling ? body : renderStyledMessage(body, mentions, nickname, knownNicks, isDarkMode))}
      {isEdited && <EditedIndicator originalBody={originalBody} />}
    </div>
  )
})

interface EditedIndicatorProps {
  originalBody?: string
  className?: string
}

function EditedIndicator({ originalBody, className = '' }: EditedIndicatorProps) {
  const { t } = useTranslation()

  return (
    <span
      className={`ms-1 text-xs text-fluux-muted cursor-help ${className}`}
      title={originalBody ? t('chat.originalMessage', { body: originalBody }) : t('chat.messageWasEdited')}
    >
      {t('chat.edited')}
    </span>
  )
}

// ============================================================================
// Search term highlighting
// ============================================================================

/**
 * Recursively walks React children and wraps text substrings matching any of
 * the given terms with a <mark> tag.  Leaves non-text nodes (elements)
 * untouched so styled segments, links, code blocks etc. are preserved.
 */
function SearchHighlight({ terms, children, isCurrent }: { terms: string[]; children: ReactNode; isCurrent?: boolean }) {
  // Build a single regex that matches any term (case-insensitive, Unicode-aware)
  // Each term is escaped and we use word-like boundaries via \b where possible
  const escaped = terms
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return <>{children}</>

  const markClass = isCurrent ? 'search-match search-match-current' : 'search-match'
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  return <>{highlightChildren(children, pattern, markClass)}</>
}

function highlightChildren(node: ReactNode, pattern: RegExp, markClass: string): ReactNode {
  if (typeof node === 'string') {
    return highlightText(node, pattern, markClass)
  }
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <HighlightFragment key={i} node={child} pattern={pattern} markClass={markClass} />
    ))
  }
  if (node && typeof node === 'object' && 'props' in node) {
    // React element — clone and recurse into children
    const element = node as React.ReactElement<{ children?: ReactNode }>
    if (element.props.children != null) {
      return { ...element, props: { ...element.props, children: highlightChildren(element.props.children, pattern, markClass) } }
    }
  }
  return node
}

function HighlightFragment({ node, pattern, markClass }: { node: ReactNode; pattern: RegExp; markClass: string }) {
  return <>{highlightChildren(node, pattern, markClass)}</>
}

function highlightText(text: string, pattern: RegExp, markClass: string): ReactNode {
  const parts: ReactNode[] = []
  let lastIndex = 0
  // Reset regex state
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    parts.push(
      <mark key={match.index} className={markClass}>
        {match[0]}
      </mark>
    )
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts.length > 0 ? parts : text
}
