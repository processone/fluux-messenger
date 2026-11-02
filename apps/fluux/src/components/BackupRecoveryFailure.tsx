import { useTranslation } from 'react-i18next'
import type { backupRecoveryError } from './backupRecoveryError'

/** Localized action guidance stays separate from preserved native diagnostics. */
export function BackupRecoveryFailure({ failure, blocked = false }: {
  failure: ReturnType<typeof backupRecoveryError> | null
  blocked?: boolean
}) {
  const { t } = useTranslation()
  if (!failure && !blocked) return null
  return <>
    <p role="alert" className="text-xs text-fluux-error mb-3 break-words">
      {blocked ? t('settings.encryption.recoveryRestartRequired') : failure?.message}
    </p>
    {failure?.detail && <details className="text-xs text-fluux-muted mb-3 break-words">
      <summary>{t('settings.encryption.recoveryErrorDetails')}</summary>
      <p>{failure.detail}</p>
    </details>}
  </>
}
