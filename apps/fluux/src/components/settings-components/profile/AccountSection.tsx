import { useTranslation } from 'react-i18next'
import { Bell, Key, Network } from 'lucide-react'
import { useConnection } from '@fluux/sdk'
import { isTauri } from '@/utils/tauri'
import { Tooltip } from '../../Tooltip'

interface AccountSectionProps {
  onChangePassword: () => void
}

export function AccountSection({ onChangePassword }: AccountSectionProps) {
  const { t } = useTranslation()
  const { isConnected, connectionMethod, authMechanism, webPushStatus, supportsPasswordChange } =
    useConnection()

  const showWebPush = !isTauri() && isConnected
  const passwordEnabled = supportsPasswordChange && isConnected
  const passwordTooltip = !isConnected
    ? t('profile.offlineNotice')
    : t('profile.passwordChangeNotSupported')

  if (!connectionMethod && !showWebPush && !supportsPasswordChange) return null

  return (
    <section className="px-4 md:px-6">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2 px-1">
        {t('profile.account')}
      </h3>
      <div className="rounded-lg bg-fluux-bg/40 divide-y divide-fluux-bg">
        {connectionMethod && (
          <div className="flex items-center gap-3 px-3 py-2.5">
            <Network className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
            <span className="text-sm text-fluux-text break-words">
              {t(`profile.connectionMethod_${connectionMethod}`)}
              {authMechanism && ` · ${authMechanism}`}
            </span>
          </div>
        )}

        {showWebPush && (
          <div className="flex items-center gap-3 px-3 py-2.5">
            <Bell className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
            <span className="flex-1 text-sm text-fluux-text break-words">
              {t('profile.webPush')} · {t(`profile.webPush_${webPushStatus}`)}
            </span>
            <span
              className={`size-2 rounded-full flex-shrink-0 ${
                webPushStatus === 'registered'
                  ? 'bg-fluux-green'
                  : webPushStatus === 'available'
                    ? 'bg-fluux-yellow'
                    : 'bg-fluux-muted'
              }`}
              aria-hidden
            />
          </div>
        )}

        {passwordEnabled ? (
          <button
            type="button"
            onClick={onChangePassword}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-start hover:bg-fluux-hover transition-colors"
          >
            <Key className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
            <span className="text-sm text-fluux-text">{t('profile.changePassword')}</span>
          </button>
        ) : (
          <Tooltip content={passwordTooltip} position="top">
            <div
              className="w-full flex items-center gap-3 px-3 py-2.5 text-fluux-muted opacity-50"
              aria-label={passwordTooltip}
            >
              <Key className="size-4 flex-shrink-0" aria-hidden />
              <span className="text-sm">{t('profile.changePassword')}</span>
            </div>
          </Tooltip>
        )}
      </div>
    </section>
  )
}
