/**
 * MessageAttachments - Shared component for rendering file attachments in messages
 *
 * Used by both ChatView and RoomView to render image, video, audio,
 * text file previews, and document cards in a consistent way.
 */

import type { FileAttachment } from '@fluux/sdk'
import { canPreviewAsText } from '@/utils/thumbnail'
import { TextFilePreview } from './TextFilePreview'
import {
  ImageAttachment,
  VideoAttachment,
  AudioAttachment,
  FileAttachmentCard,
  shouldShowFileCard,
} from './FileAttachments'

interface MessageAttachmentsProps {
  attachment: FileAttachment | undefined
  /** Called when media (images) finish loading - useful for scroll adjustment */
  onMediaLoad?: () => void
  /** Whether the parent message is selected (for gradient adaptation) */
  isSelected?: boolean
  /** Whether the parent message is hovered (for gradient adaptation) */
  isHovered?: boolean
}

/**
 * Renders all applicable attachment types for a message.
 * Each attachment component internally checks if it should render
 * based on the attachment's media type.
 */
export function MessageAttachments({ attachment, onMediaLoad, isSelected, isHovered }: MessageAttachmentsProps) {
  if (!attachment) return null

  const canPreview = canPreviewAsText(attachment.mediaType, attachment.name)

  return (
    <>
      {/* Image attachment preview */}
      <ImageAttachment attachment={attachment} onLoad={onMediaLoad} />

      {/* Video attachment with inline player */}
      <VideoAttachment attachment={attachment} onLoad={onMediaLoad} />

      {/* Audio attachment with inline player */}
      <AudioAttachment attachment={attachment} />

      {/* Text file preview (code, markdown, json, etc.) */}
      {canPreview && <TextFilePreview attachment={attachment} isSelected={isSelected} isHovered={isHovered} />}

      {/* Document/file attachment card (PDF, Word, etc.) */}
      {shouldShowFileCard(attachment, canPreview) && (
        <FileAttachmentCard attachment={attachment} />
      )}
    </>
  )
}
