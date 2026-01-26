import { memo } from 'react'
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
  /** Message body text */
  body: string
  /** Whether message was edited */
  isEdited?: boolean
  /** Original body before editing (for tooltip) */
  originalBody?: string
  /** Whether message has been retracted/deleted */
  isRetracted?: boolean
  /** Whether to disable text styling (code blocks, links, etc.) */
  noStyling?: boolean
  /** Sender display name (for /me actions) */
  senderName: string
  /** Sender color (for /me actions) */
  senderColor: string
  /** Mention references for highlighting (room messages) */
  mentions?: MentionReference[]
  /** Whether message has an attachment with thumbnail (hide text body) */
  hasAttachmentThumbnail?: boolean
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
  noStyling,
  senderName,
  senderColor,
  mentions,
  hasAttachmentThumbnail,
}: MessageBodyProps) {
  const { t } = useTranslation()

  // Retracted message
  if (isRetracted) {
    return (
      <div className="text-fluux-muted italic">
        {t('chat.messageDeleted')}
      </div>
    )
  }

  // Hide body if attachment has thumbnail (body is just fallback URL)
  if (hasAttachmentThumbnail) {
    return null
  }

  // /me action message
  if (isActionMessage(body)) {
    return (
      <div className="text-fluux-text/85 italic break-words whitespace-pre-wrap leading-[1.375]">
        <span className="text-fluux-muted mr-1">*</span>
        <span className="font-medium" style={{ color: senderColor }}>
          {senderName}
        </span>
        {' '}
        {noStyling ? getActionText(body) : renderStyledMessage(getActionText(body), mentions)}
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
    <div className="text-fluux-text break-words whitespace-pre-wrap leading-[1.375]">
      {noStyling ? body : renderStyledMessage(body, mentions)}
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
      className={`ml-1 text-xs text-fluux-muted cursor-help ${className}`}
      title={originalBody ? t('chat.originalMessage', { body: originalBody }) : t('chat.messageWasEdited')}
    >
      {t('chat.edited')}
    </span>
  )
}
