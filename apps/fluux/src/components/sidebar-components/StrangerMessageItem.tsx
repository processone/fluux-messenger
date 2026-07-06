import { useTranslation } from 'react-i18next'
import { getLocalPart } from '@fluux/sdk'
import { Check, X, Ban } from 'lucide-react'
import { Avatar } from '../Avatar'
import { Tooltip } from '../Tooltip'

interface StrangerMessageItemProps {
  jid: string
  messages: { id: string; from: string; body: string; timestamp: Date }[]
  /** Open the read-only preview of this stranger's full thread. */
  onSelect?: (jid: string) => void
  onAccept: () => void
  onIgnore: () => void
  onBlock: () => void
}

export function StrangerMessageItem({ jid, messages, onSelect, onAccept, onIgnore, onBlock }: StrangerMessageItemProps) {
  const { t } = useTranslation()
  const displayName = getLocalPart(jid)
  const latestMessage = messages[messages.length - 1]
  const messageCount = messages.length

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      {/* Clicking the info row opens the read-only preview; the action buttons
          below are a separate sibling, so they don't trigger it. */}
      <div
        className="flex items-center gap-3 cursor-pointer"
        role="button"
        tabIndex={0}
        onClick={() => onSelect?.(jid)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect?.(jid)
          }
        }}
      >
        {/* Avatar */}
        <Avatar
          identifier={jid}
          name={displayName}
          size="md"
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-fluux-text truncate">{displayName}</p>
            {messageCount > 1 && (
              <span className="text-xs bg-fluux-brand/20 text-fluux-brand px-1.5 py-0.5 rounded">
                {messageCount}
              </span>
            )}
          </div>
          <p className="text-xs text-fluux-muted truncate">{latestMessage?.body}</p>
        </div>
      </div>

      {/* Actions — same compact layout as SubscriptionRequestItem so the row
          never overflows the narrow sidebar: Accept keeps its label (primary),
          Ignore/Block are icon buttons with tooltips. */}
      <div className="flex items-stretch gap-1.5 mt-2">
        <button
          onClick={onAccept}
          className="flex-1 min-w-0 px-2 py-1.5 bg-fluux-brand text-fluux-text-on-accent text-sm font-medium rounded hover:bg-fluux-brand-hover transition-colors flex items-center justify-center gap-1"
        >
          <Check className="size-4 flex-shrink-0" />
          <span className="truncate">{t('common.accept')}</span>
        </button>
        <Tooltip content={t('common.ignore')} position="top">
          <button
            onClick={onIgnore}
            className="flex-shrink-0 px-2.5 py-1.5 bg-fluux-muted/20 text-fluux-text rounded hover:bg-fluux-muted/30 transition-colors flex items-center justify-center"
            aria-label={t('common.ignore')}
          >
            <X className="size-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('common.block')} position="top">
          <button
            onClick={onBlock}
            className="flex-shrink-0 px-2.5 py-1.5 bg-fluux-red text-white rounded hover:bg-fluux-red/80 transition-colors flex items-center justify-center"
            aria-label={t('common.block')}
          >
            <Ban className="size-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
