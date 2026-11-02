import { E2EEPluginError } from '@fluux/sdk'
import type { TFunction } from 'i18next'

/** Protocol/native errors carry stable codes; only the view chooses translated copy. */
export function backupRecoveryError(error: unknown, t: TFunction, recovery = false) {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof E2EEPluginError) {
    switch (error.code) {
      case 'recovery-account-changed':
        return { message: t('settings.encryption.recoveryAccountChanged'), uncertain: false }
      case 'identity-change-pending':
        return { message: t('settings.encryption.recoveryIdentityChangePending'), uncertain: false }
      case 'restore-outcome-uncertain':
        return { message: t('settings.encryption.recoveryRestartRequired'), detail, uncertain: true }
    }
  }
  return { message: recovery ? t('settings.encryption.recoveryFailed') : detail, detail: recovery ? detail : undefined, uncertain: false }
}
