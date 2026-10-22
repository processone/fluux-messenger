import { useTranslation } from 'react-i18next'
import { ChevronRight, Key } from 'lucide-react'
import { useConnection } from '@fluux/sdk'
import { platform } from '@/platform'
import { useRouteSync } from '@/hooks/useRouteSync'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { SettingsGroup } from '@/components/ui/SettingsGroup'
import { SettingsRow } from '@/components/ui/SettingsRow'

interface AccountSectionProps {
  onChangePassword: () => void
}

export function AccountSection({ onChangePassword }: AccountSectionProps) {
  const { t } = useTranslation()
  const { navigateToSettings } = useRouteSync()
  const { isConnected, connectionMethod, authMechanism, webPushStatus, supportsPasswordChange } =
    useConnection()

  const showWebPush = platform().usesWebPush && isConnected
  const passwordEnabled = supportsPasswordChange && isConnected
  const passwordExplanation = !isConnected
    ? t('profile.offlineNotice')
    : t('profile.passwordChangeNotSupported')

  if (!connectionMethod && !authMechanism && !showWebPush && !supportsPasswordChange) return null

  return (
    <section className="px-4 md:px-6">
      <SettingsSection title={t('profile.account')}>
        <SettingsGroup>
          {connectionMethod && (
            <SettingsRow label={t('profile.connection')}>
              <span className="text-sm text-fluux-muted">
                {t(`profile.connectionMethod_${connectionMethod}`)}
              </span>
            </SettingsRow>
          )}
          {authMechanism && (
            <SettingsRow
              label={t('profile.authentication')}
              description={authMechanism}
              className="[&_p]:font-mono [&_p]:break-all"
            />
          )}

          {showWebPush && (
            <SettingsRow
              label={t('settings.notifications')}
              onClick={() => navigateToSettings('notifications')}
              description={t(`profile.webPush_${webPushStatus}`)}
            >
              <div className="flex items-center gap-2">
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
                <ChevronRight className="size-4 text-fluux-muted rtl-mirror" aria-hidden />
              </div>
            </SettingsRow>
          )}

          <SettingsRow
            label={t('profile.changePassword')}
            description={passwordEnabled ? undefined : passwordExplanation}
            onClick={onChangePassword}
            disabled={!passwordEnabled}
          >
            <Key className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </section>
  )
}
