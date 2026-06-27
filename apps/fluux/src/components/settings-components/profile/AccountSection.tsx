import { useTranslation } from 'react-i18next'
import { Key, Network } from 'lucide-react'
import { useConnection } from '@fluux/sdk'
import { isTauri } from '@/utils/tauri'
import { Tooltip } from '../../Tooltip'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { SettingsGroup } from '@/components/ui/SettingsGroup'
import { SettingsRow } from '@/components/ui/SettingsRow'

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
      <SettingsSection title={t('profile.account')}>
        <SettingsGroup>
          {connectionMethod && (
            <SettingsRow
              label={t(`profile.connectionMethod_${connectionMethod}`)}
              description={authMechanism ?? undefined}
            >
              <Network className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
            </SettingsRow>
          )}

          {showWebPush && (
            <SettingsRow
              label={t('profile.webPush')}
              description={t(`profile.webPush_${webPushStatus}`)}
            >
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
            </SettingsRow>
          )}

          {passwordEnabled ? (
            <SettingsRow label={t('profile.changePassword')} onClick={onChangePassword}>
              <Key className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
            </SettingsRow>
          ) : (
            <Tooltip content={passwordTooltip} position="top">
              <SettingsRow label={t('profile.changePassword')} className="opacity-50">
                <Key className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
              </SettingsRow>
            </Tooltip>
          )}
        </SettingsGroup>
      </SettingsSection>
    </section>
  )
}
