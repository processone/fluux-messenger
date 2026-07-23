import { useTranslation } from 'react-i18next'
import { getLocalPart, type SubscriptionRequest } from '@fluux/sdk'
import { Check, X, Ban } from 'lucide-react'
import { Avatar } from '../Avatar'
import { Tooltip } from '../Tooltip'

interface SubscriptionRequestItemProps {
  request: SubscriptionRequest
  onAccept: () => void
  onReject: () => void
  onBlock: () => void
}

export function SubscriptionRequestItem({ request, onAccept, onReject, onBlock }: SubscriptionRequestItemProps) {
  const { t } = useTranslation()
  const displayName = getLocalPart(request.from)

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      <div className="flex items-center gap-3">
        <Avatar identifier={request.from} name={displayName} size="md" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-fluux-text truncate">{displayName}</p>
          <p className="text-xs text-fluux-muted truncate">{request.from}</p>
        </div>
      </div>
      {/* Accept keeps its label (primary action); reject/block are compact icon
          buttons so the row never overflows the narrow sidebar. */}
      <div className="flex items-stretch gap-1.5 mt-2">
        <button
          type="button"
          onClick={onAccept}
          className="flex-1 min-w-0 px-2 py-1.5 bg-fluux-green text-white text-sm font-medium rounded hover:bg-fluux-green/80 transition-colors flex items-center justify-center gap-1"
        >
          <Check className="size-4 flex-shrink-0" />
          <span className="truncate">{t('common.accept')}</span>
        </button>
        <Tooltip content={t('common.reject')} position="top">
          <button
            type="button"
            onClick={onReject}
            className="flex-shrink-0 px-2.5 py-1.5 bg-fluux-muted/20 text-fluux-text rounded hover:bg-fluux-muted/30 transition-colors flex items-center justify-center"
            aria-label={t('common.reject')}
          >
            <X className="size-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('common.block')} position="top">
          <button
            type="button"
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
