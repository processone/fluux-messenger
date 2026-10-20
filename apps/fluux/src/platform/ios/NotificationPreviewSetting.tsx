import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Toggle } from '@/components/ui/Toggle'
import { useIOSPreviewSettingsStore } from './previewSettings'
import { setIOSNotificationPreviews, PreviewProvisioningError, type PreviewProblem } from './notificationPreviews'
const PROBLEM_TEXT: Record<PreviewProblem, string> = {
  credential: 'settings.oxNotificationPreviewNeedsPassword',
  key: 'settings.oxNotificationPreviewKeyUnavailable',
  server: 'settings.oxNotificationPreviewServerUnreachable',
  unavailable: 'settings.oxNotificationPreviewFailed',
}
export function NotificationPreviewSetting() {
  const { t } = useTranslation()
  const enabled = useIOSPreviewSettingsStore(s => s.enabled)
  const account = useIOSPreviewSettingsStore(s => s.account)
  const missingCredential = useIOSPreviewSettingsStore(s => s.missingCredential)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<PreviewProblem | null>(null)
  const change = async (next: boolean) => {
    setBusy(true); setProblem(null)
    try { await setIOSNotificationPreviews(next) }
    catch (error) { setProblem(error instanceof PreviewProvisioningError ? error.problem : 'unavailable') }
    finally { setBusy(false) }
  }
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-4 p-4 rounded-lg border-2 border-fluux-border bg-fluux-bg">
      <div>
        <label htmlFor="ox-notification-preview" className="text-sm font-medium text-fluux-text">{t('settings.oxNotificationPreview')}</label>
        <p className="text-xs text-fluux-muted">{t('settings.oxNotificationPreviewDescription')}</p>
      </div>
      <Toggle id="ox-notification-preview" checked={enabled} disabled={!account} loading={busy}
        aria-label={t('settings.oxNotificationPreview')} onChange={next => void change(next)} />
    </div>
    {problem && <p role="status" className="text-xs text-fluux-red">{t(PROBLEM_TEXT[problem])}</p>}
    {!problem && enabled && missingCredential && <p role="status" className="text-xs text-fluux-red">{t('settings.oxNotificationPreviewNeedsPassword')}</p>}
  </div>
}
