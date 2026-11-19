import { useTranslation } from 'react-i18next'
import { getLocalPart, type SubscriptionRequest } from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { RequestActions } from './RequestActions'

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
      <RequestActions
        acceptLabel={t('common.accept')}
        onAccept={onAccept}
        dismissLabel={t('common.reject')}
        onDismiss={onReject}
        blockLabel={t('common.block')}
        onBlock={onBlock}
      />
    </div>
  )
}
