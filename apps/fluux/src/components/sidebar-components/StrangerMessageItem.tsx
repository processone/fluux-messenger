import { useTranslation } from 'react-i18next'
import { getLocalPart } from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { RequestActions } from './RequestActions'

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

      <RequestActions
        acceptLabel={t('common.accept')}
        onAccept={onAccept}
        dismissLabel={t('common.ignore')}
        onDismiss={onIgnore}
        blockLabel={t('common.block')}
        onBlock={onBlock}
      />
    </div>
  )
}
