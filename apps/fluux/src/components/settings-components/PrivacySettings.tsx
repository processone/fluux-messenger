import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnection, useXMPPContext, RequestTimeoutError, type ArchivingDefault, type ArchivingPreferences } from '@fluux/sdk'
import { chooseArchiving } from '@/utils/archivingOverride'
import { useSettingsStore, type MediaAutoDownload } from '@/stores/settingsStore'
import { SettingsSection } from '@/components/ui/SettingsSection'

const mediaOptions: { value: MediaAutoDownload; labelKey: string; descriptionKey: string }[] = [
  { value: 'always', labelKey: 'settings.mediaAutoDownloadAlways', descriptionKey: 'settings.mediaAutoDownloadAlwaysDescription' },
  { value: 'private-only', labelKey: 'settings.mediaAutoDownloadPrivateOnly', descriptionKey: 'settings.mediaAutoDownloadPrivateOnlyDescription' },
  { value: 'never', labelKey: 'settings.mediaAutoDownloadNever', descriptionKey: 'settings.mediaAutoDownloadNeverDescription' },
]

const archiveOptions: { value: ArchivingDefault; labelKey: string }[] = [
  { value: 'always', labelKey: 'settings.archiveAlways' },
  { value: 'roster', labelKey: 'settings.archiveRoster' },
  { value: 'never', labelKey: 'settings.archiveNever' },
]

type ArchiveError = 'unsupported' | 'denied' | 'timeout' | 'invalid' | 'error'

function archiveError(error: unknown): ArchiveError {
  const detail = error as { condition?: string; code?: string; name?: string } | null
  if (['feature-not-implemented', 'service-unavailable'].includes(detail?.condition ?? '')) return 'unsupported'
  if (['forbidden', 'not-allowed', 'not-authorized'].includes(detail?.condition ?? '')) return 'denied'
  if (error instanceof RequestTimeoutError || detail?.name === 'RequestTimeoutError' || detail?.name === 'TimeoutError') return 'timeout'
  return detail?.code === 'invalid' ? 'invalid' : 'error'
}

/** A different full JID mounts a different owner, so old account results cannot paint here. */
function ServerArchiveSetting() {
  const { jid } = useConnection()
  return <ServerArchiveControl key={jid ?? ''} />
}

function ServerArchiveControl() {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const { isConnected, status } = useConnection()
  const supported = client.supportsMAM()
  const [confirmed, setConfirmed] = useState<{ client: typeof client; prefs: ArchivingPreferences } | null>(null)
  const prefs = confirmed?.client === client ? confirmed.prefs : null
  const [error, setError] = useState<ArchiveError | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  const operation = useRef({ active: false, busy: false })

  useEffect(() => {
    const scope = { active: true, busy: false }
    operation.current = scope
    setSaving(false)
    setError(null)
    setLoading(isConnected && supported)
    if (isConnected && supported) {
      scope.busy = true
      client.getArchivingPreferences()
        .then(current => { if (scope.active) setConfirmed({ client, prefs: current }) })
        .catch(cause => { if (scope.active) setError(archiveError(cause)) })
        .finally(() => {
          scope.busy = false
          if (scope.active) setLoading(false)
        })
    }
    return () => { scope.active = false }
  }, [client, isConnected, status, supported, revision])

  const save = async (value: ArchivingDefault) => {
    const scope = operation.current
    if (!scope.active || scope.busy || !isConnected || !supported || error) return
    scope.busy = true
    setSaving(true)
    setError(null)
    try {
      const current = await chooseArchiving(client, value, () => scope.active)
      if (scope.active) setConfirmed({ client, prefs: current })
    } catch (cause) {
      if (scope.active) setError(archiveError(cause))
    } finally {
      scope.busy = false
      if (scope.active) setSaving(false)
    }
  }

  const state = !isConnected ? 'offline' : !supported ? 'unsupported'
    : saving ? 'saving' : loading ? 'loading' : null
  const disabled = !!state || !!error
  return (
    <div className="space-y-3 mb-6" aria-busy={loading || saving}>
      <h3 id="server-archive-label" className="text-sm font-medium text-fluux-text">{t('settings.archiveConversations')}</h3>
      <p className="text-xs text-fluux-muted">{t('settings.archiveConversationsDescription')}</p>
      {prefs && (
        <>
          <div role="group" aria-labelledby="server-archive-label"
            className="grid grid-cols-3 gap-1 rounded-lg border border-fluux-border bg-fluux-bg p-1">
            {archiveOptions.map(option => (
              <button key={option.value} type="button" aria-pressed={prefs.default === option.value}
                disabled={disabled}
                onClick={() => { if (prefs.default !== option.value) void save(option.value) }}
                className={`min-w-0 break-words rounded-md px-2 py-2 text-center text-sm font-medium leading-tight transition-colors
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-fluux-brand disabled:opacity-60
                  ${prefs.default === option.value
                    ? 'bg-fluux-active text-fluux-text ring-1 ring-fluux-brand'
                    : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'}`}>
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          <p className="text-xs text-fluux-muted">{t('settings.archiveConfirmed')}</p>
          {(prefs.always.length > 0 || prefs.never.length > 0) && (
            <p className="text-xs text-fluux-muted">{t('settings.archiveExceptions', { always: prefs.always.length, never: prefs.never.length })}</p>
          )}
        </>
      )}
      <div role="status" aria-live="polite" className="text-xs text-fluux-muted">
        {state ? t(`settings.archiveStatus.${state}`) : null}
      </div>
      {error && isConnected && supported && (
        <p role="alert" className="text-xs text-fluux-error">{t(`settings.archiveStatus.${error}`)}</p>
      )}
      {isConnected && supported && (
        <button type="button" disabled={loading || saving}
          onClick={() => { if (!operation.current.busy) setRevision(r => r + 1) }}
          className="text-sm text-fluux-brand hover:underline disabled:opacity-50">
          {t('settings.archiveRefresh')}
        </button>
      )}
      <p className="text-xs text-fluux-muted">{t('settings.archiveConcurrency')}</p>
    </div>
  )
}

export function PrivacySettings() {
  const { t } = useTranslation()
  const mediaAutoDownload = useSettingsStore((s) => s.mediaAutoDownload)
  const setMediaAutoDownload = useSettingsStore((s) => s.setMediaAutoDownload)

  return (
    <section className="w-full max-w-md">
      <SettingsSection>
        <ServerArchiveSetting />
        <div className="space-y-3">
        <label id="media-auto-download-label" className="text-sm font-medium text-fluux-text">{t('settings.mediaAutoDownload')}</label>
        <div role="group" aria-labelledby="media-auto-download-label"
          className="grid grid-cols-3 gap-1 rounded-lg border border-fluux-border bg-fluux-bg p-1">
          {mediaOptions.map((option) => {
            const isSelected = mediaAutoDownload === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setMediaAutoDownload(option.value)}
                className={`min-w-0 rounded-md px-2 py-2 text-center text-sm font-medium leading-tight transition-colors
                  ${isSelected
                    ? 'bg-fluux-active text-fluux-text ring-1 ring-fluux-brand'
                    : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'
                  }`}
              >
                {t(option.labelKey)}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-fluux-muted mt-2">
          {t(mediaOptions.find((o) => o.value === mediaAutoDownload)?.descriptionKey || '')}
        </p>
        <p className="text-xs text-fluux-muted border-t border-fluux-border pt-3 mt-3">
          {t('settings.mediaAutoDownloadStrangerNote')}
        </p>
        </div>
      </SettingsSection>
    </section>
  )
}
