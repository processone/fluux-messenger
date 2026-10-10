import { useTranslation } from 'react-i18next'
import { iosNotificationTones, useIOSSoundSettingsStore, type IOSNotificationTone } from './notificationSounds'
export function NotificationSoundSetting() {
  const { t } = useTranslation()
  const tone = useIOSSoundSettingsStore(s => s.tone)
  const account = useIOSSoundSettingsStore(s => s.account)
  const setTone = useIOSSoundSettingsStore(s => s.setTone)
  return <div className="space-y-2 p-4 rounded-lg border-2 border-fluux-border bg-fluux-bg">
    <label htmlFor="ios-notification-tone" className="block text-sm font-medium text-fluux-text">{t('settings.nativeNotificationTone')}</label>
    <p className="text-xs text-fluux-muted">{t('settings.nativeNotificationToneDescription')}</p>
    <select id="ios-notification-tone" value={tone} disabled={!account} onChange={e => setTone(e.target.value as IOSNotificationTone)}
      className="w-full p-2 rounded bg-fluux-bg text-fluux-text border border-fluux-border">
      {iosNotificationTones.map(value => <option key={value} value={value}>{t(`settings.notificationTone_${value}`)}</option>)}
    </select>
  </div>
}
