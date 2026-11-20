import { Check, X, Ban } from 'lucide-react'
import { Tooltip } from '../Tooltip'

interface RequestActionsProps {
  acceptLabel: string
  onAccept: () => void
  dismissLabel: string
  onDismiss: () => void
  /** Omit to hide the block action (room invitations have no sender to block). */
  blockLabel?: string
  onBlock?: () => void
}

/**
 * Action row shared by the sidebar's pending items: message requests, contact
 * requests and room invitations. Accept keeps its label as the primary action;
 * dismiss and block are compact icon buttons so the row never overflows the
 * narrow sidebar. The buttons stay quiet so a pending request does not outweigh
 * the conversations listed under it.
 */
export function RequestActions({ acceptLabel, onAccept, dismissLabel, onDismiss, blockLabel, onBlock }: RequestActionsProps) {
  const iconButton =
    'flex-shrink-0 px-2.5 py-1.5 rounded-md text-fluux-muted hover:bg-fluux-active transition-colors flex items-center justify-center'

  return (
    <div className="flex items-stretch gap-1.5 mt-2">
      <button
        type="button"
        onClick={onAccept}
        className="request-accept flex-1 min-w-0 px-2 py-1.5 text-sm font-medium text-fluux-text rounded-md transition-colors flex items-center justify-center gap-1"
      >
        <Check className="size-4 flex-shrink-0" />
        <span className="truncate">{acceptLabel}</span>
      </button>
      <Tooltip content={dismissLabel} position="top">
        <button
          type="button"
          onClick={onDismiss}
          className={`${iconButton} hover:text-fluux-text`}
          aria-label={dismissLabel}
        >
          <X className="size-4" />
        </button>
      </Tooltip>
      {blockLabel && onBlock && (
        <Tooltip content={blockLabel} position="top">
          <button
            type="button"
            onClick={onBlock}
            className={`${iconButton} hover:text-fluux-red`}
            aria-label={blockLabel}
          >
            <Ban className="size-4" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
