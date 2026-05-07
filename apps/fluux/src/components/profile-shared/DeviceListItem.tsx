import { useTranslation } from 'react-i18next'
import { Globe, Monitor, Smartphone } from 'lucide-react'
import { type ResourcePresence, getClientType } from '@fluux/sdk'
import { getShowColor, getTranslatedShowText } from '@/utils/presence'

interface DeviceListItemProps {
  resource: string
  presence: ResourcePresence
  forceOffline?: boolean
}

export function DeviceListItem({ resource, presence, forceOffline = false }: DeviceListItemProps) {
  const { t } = useTranslation()
  const clientType = getClientType(presence.client)
  const DeviceIcon = clientType === 'mobile' ? Smartphone : clientType === 'web' ? Globe : Monitor

  return (
    <li className="flex items-center gap-2 px-3 py-2 bg-fluux-bg rounded-lg">
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${getShowColor(presence.show, forceOffline)}`}
        aria-hidden
      />
      <DeviceIcon className="w-4 h-4 text-fluux-muted flex-shrink-0" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fluux-text truncate">
          {presence.client || resource || t('contacts.unknown')}
        </div>
        <div className="text-xs text-fluux-muted truncate">
          {getTranslatedShowText(presence.show, t, forceOffline)}
          <span className="text-fluux-muted/60"> · {t('profile.priority')}: {presence.priority}</span>
          {presence.client && resource && (
            <span className="text-fluux-muted/60"> · {resource}</span>
          )}
        </div>
      </div>
    </li>
  )
}
