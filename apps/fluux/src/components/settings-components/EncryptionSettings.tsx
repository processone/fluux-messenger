import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight, X } from 'lucide-react'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { useRouteSync } from '@/hooks/useRouteSync'
import { OpenPgpSettings } from './OpenPgpSettings'
import { OmemoSettings } from './OmemoSettings'
import { useOwnOmemoDeviceCount } from './useOwnOmemoDeviceCount'
import { type EncryptionSubPage } from './encryptionPages'
import { useOpenPgpOverviewState, type OpenPgpOverviewState } from './openPgpOverviewState'

const OPENPGP_STATE_KEYS: Record<OpenPgpOverviewState, string> = {
  off: 'stateOff',
  waiting: 'stateWaiting',
  locked: 'stateLocked',
  'needs-attention': 'stateNeedsAttention',
  on: 'stateOn',
  'on-backed-up': 'stateOnBackedUp',
  'on-no-backup': 'stateOnNoBackup',
  'on-backup-unconfirmed': 'stateOnBackupUnconfirmed',
}

interface EncryptionSettingsProps {
  /** The screen to show; null is the overview. */
  subPage?: EncryptionSubPage | null
}

/** Settings > Encryption: the overview, or one method's screen. */
export function EncryptionSettings({ subPage = null }: EncryptionSettingsProps) {
  if (subPage === 'openpgp') return <OpenPgpSettings />
  if (subPage === 'omemo') return <OmemoSettings />
  return <EncryptionOverview />
}

function EncryptionOverview() {
  const { t } = useTranslation()
  const { navigateToSettings } = useRouteSync()
  const openpgpStateKey = OPENPGP_STATE_KEYS[useOpenPgpOverviewState()]
  const deviceCount = useOwnOmemoDeviceCount()
  const [limitationsDismissed, setLimitationsDismissed] = useState(
    () => localStorage.getItem('enc-limitations-dismissed') === '1'
  )

  const dismissLimitations = () => {
    localStorage.setItem('enc-limitations-dismissed', '1')
    setLimitationsDismissed(true)
  }

  const openpgpState = t(`settings.encryption.overview.${openpgpStateKey}`)
  const omemoState = deviceCount
    ? t('settings.encryption.overview.omemoNotUsedDevices', { devices: deviceCount })
    : t('settings.encryption.overview.omemoNotUsed')

  const open = (page: EncryptionSubPage) => navigateToSettings('encryption', { subPage: page })
  const rows: { page: EncryptionSubPage; name: string; state: string; description: string }[] = [
    {
      page: 'openpgp',
      name: t('settings.encryption.openpgpName'),
      state: openpgpState,
      description: t('settings.encryption.openpgpDescription'),
    },
    {
      page: 'omemo',
      name: t('settings.encryption.omemoName'),
      state: omemoState,
      description: t('settings.encryption.overview.omemoDescription'),
    },
  ]

  return (
    <section className="w-full max-w-md">
      <SettingsSection description={t('settings.encryption.overview.intro')}>
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.page}>
              <button
                type="button"
                onClick={() => open(row.page)}
                className="w-full flex items-center gap-3 p-3 rounded-lg bg-fluux-bg border border-fluux-border hover:bg-fluux-hover text-start transition-colors"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fluux-text">{row.name}</span>
                  <span className="block text-xs text-fluux-brand">{row.state}</span>
                  <span className="block mt-0.5 text-xs text-fluux-muted">{row.description}</span>
                </span>
                <ChevronRight className="size-4 flex-shrink-0 text-fluux-muted rtl-mirror" />
              </button>
            </li>
          ))}
        </ul>
        {!limitationsDismissed && (
          <div className="mt-4 flex gap-2 p-3 rounded-lg bg-fluux-yellow/10 text-xs text-fluux-muted leading-snug">
            <AlertTriangle className="size-4 text-fluux-yellow flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-fluux-text">{t('settings.encryption.limitationsTitle')}</p>
              <p className="mt-1">{t('settings.encryption.limitationBackend')}</p>
            </div>
            <button
              type="button"
              onClick={dismissLimitations}
              aria-label={t('common.close')}
              className="flex-shrink-0 p-0.5 text-fluux-muted hover:text-fluux-text rounded transition-colors tap-target"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </SettingsSection>
    </section>
  )
}
