import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Toggle } from '@/components/ui/Toggle'
import { useIOSPreviewSettingsStore } from './previewSettings'
import { setIOSNotificationPreviews, type PreviewProblem } from './notificationPreviews'
const PROBLEM_TEXT: Record<PreviewProblem, string> = {
  credential: 'settings.oxNotificationPreviewNeedsPassword',
  refused: 'settings.oxNotificationPreviewPasswordRefused',
  key: 'settings.oxNotificationPreviewKeyUnavailable',
  server: 'settings.oxNotificationPreviewServerUnreachable',
  unavailable: 'settings.oxNotificationPreviewFailed',
}
export function NotificationPreviewSetting() {
  const { t } = useTranslation()
  const enabled = useIOSPreviewSettingsStore(s => s.enabled)
  const account = useIOSPreviewSettingsStore(s => s.account)
  const missingCredential = useIOSPreviewSettingsStore(s => s.missingCredential)
  const failure = useIOSPreviewSettingsStore(s => s.failure)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const change = async (next: boolean, typed?: string) => {
    setBusy(true)
    // The store records the failure the setting explains.
    try { await setIOSNotificationPreviews(next, typed); setPassword('') }
    catch { /* shown from the store */ }
    finally { setBusy(false) }
  }
  const shown: PreviewProblem | null = enabled ? failure?.problem ?? (missingCredential ? 'credential' : null) : null
  const asksPassword = shown === 'credential' || shown === 'refused'
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-4 p-4 rounded-lg border-2 border-fluux-border bg-fluux-bg">
      <div>
        <label htmlFor="ox-notification-preview" className="text-sm font-medium text-fluux-text">{t('settings.oxNotificationPreview')}</label>
        <p className="text-xs text-fluux-muted">{t('settings.oxNotificationPreviewDescription')}</p>
      </div>
      <Toggle id="ox-notification-preview" checked={enabled} disabled={!account} loading={busy}
        aria-label={t('settings.oxNotificationPreview')} onChange={next => void change(next)} />
    </div>
    {shown && <p role="status" className="text-xs text-fluux-red">{t(PROBLEM_TEXT[shown])}</p>}
    {shown === 'unavailable' && failure?.detail && <p className="text-xs text-fluux-muted font-mono break-words select-text">{failure.detail}</p>}
    {asksPassword && <form className="flex items-end gap-2"
      onSubmit={event => { event.preventDefault(); if (password) void change(true, password) }}>
      <div className="flex-1 min-w-0">
        <label htmlFor="ox-notification-preview-password" className="block text-xs font-semibold text-fluux-muted mb-1">
          {t('login.passwordLabel')}
        </label>
        <input id="ox-notification-preview-password" type="password" autoComplete="current-password"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} value={password} disabled={busy}
          onChange={event => setPassword(event.target.value)}
          className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded border border-fluux-border
                     focus:border-fluux-brand focus-visible:ring-2 focus-visible:ring-fluux-brand
                     disabled:opacity-50" />
      </div>
      <button type="submit" disabled={busy || !password}
        className="px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors
                   disabled:opacity-50 disabled:cursor-not-allowed">
        {t('settings.oxNotificationPreviewPasswordSubmit')}
      </button>
    </form>}
  </div>
}
