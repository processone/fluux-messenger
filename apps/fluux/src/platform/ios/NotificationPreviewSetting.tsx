import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Toggle } from '@/components/ui/Toggle'
import { useIOSPreviewSettingsStore } from './previewSettings'
import { setIOSNotificationPreviews } from './notificationPreviews'
export function NotificationPreviewSetting() {
  const { t } = useTranslation()
  const enabled = useIOSPreviewSettingsStore(s => s.enabled)
  const account = useIOSPreviewSettingsStore(s => s.account)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const change = async (next: boolean) => {
    setBusy(true); setFailed(false)
    try { await setIOSNotificationPreviews(next) } catch { setFailed(true) } finally { setBusy(false) }
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
    {failed && <p role="status" className="text-xs text-fluux-red">{t('settings.oxNotificationPreviewFailed')}</p>}
  </div>
}
