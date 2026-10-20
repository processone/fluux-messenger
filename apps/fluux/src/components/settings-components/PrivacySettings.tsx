import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getBareJid, useConnection, useXMPPContext, type ArchivingDefault, type ArchivingPreferences } from '@fluux/sdk'
import { chooseArchiving, clearArchivingOverride, effectiveArchiving } from '@/utils/archivingOverride'
import { useSettingsStore, type MediaAutoDownload } from '@/stores/settingsStore'
import { SettingsSection } from '@/components/ui/SettingsSection'

const mediaOptions: { value: MediaAutoDownload; labelKey: string; descriptionKey: string }[] = [
  { value: 'always', labelKey: 'settings.mediaAutoDownloadAlways', descriptionKey: 'settings.mediaAutoDownloadAlwaysDescription' },
  { value: 'private-only', labelKey: 'settings.mediaAutoDownloadPrivateOnly', descriptionKey: 'settings.mediaAutoDownloadPrivateOnlyDescription' },
  { value: 'never', labelKey: 'settings.mediaAutoDownloadNever', descriptionKey: 'settings.mediaAutoDownloadNeverDescription' },
]

const archiveOptions: { value: ArchivingDefault; labelKey: string; descriptionKey: string }[] = [
  { value: 'always', labelKey: 'settings.archiveAlways', descriptionKey: 'settings.archiveAlwaysDescription' },
  { value: 'roster', labelKey: 'settings.archiveRoster', descriptionKey: 'settings.archiveRosterDescription' },
  { value: 'never', labelKey: 'settings.archiveNever', descriptionKey: 'settings.archiveNeverDescription' },
]

type ArchiveState = 'offline' | 'unsupported' | 'loading' | 'ready' | 'error'

/**
 * Shows the archiving default in effect for the account: the server's own
 * setting until the user picks another value, which is then written to the
 * server and remembered so it can be put back to the server's default.
 */
function ServerArchiveSetting() {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const { isConnected, jid } = useConnection()
  const account = jid ? getBareJid(jid) : ''
  const override = useSettingsStore((s) => s.archiveOverrides[account])
  const [prefs, setPrefs] = useState<ArchivingPreferences | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const supported = isConnected && client.supportsMAM()

  useEffect(() => {
    if (!supported) {
      setPrefs(null)
      return
    }
    let cancelled = false
    setFailed(false)
    client.getArchivingPreferences()
      .then((current) => { if (!cancelled) setPrefs(current) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [client, supported])

  const state: ArchiveState = !isConnected ? 'offline'
    : !supported ? 'unsupported'
    : prefs ? 'ready'
    : failed ? 'error'
    : 'loading'

  const save = async (change: () => Promise<ArchivingPreferences>) => {
    if (saving) return
    setSaving(true)
    setFailed(false)
    try {
      setPrefs(await change())
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const selected = prefs ? effectiveArchiving(account, prefs.default) : undefined
  const originalLabel = override ? t(archiveOptions.find((o) => o.value === override.original)?.labelKey ?? '') : ''
  return (
    <div className="space-y-3 mb-6">
      <label id="server-archive-label" className="text-sm font-medium text-fluux-text">{t('settings.archiveConversations')}</label>
      <p className="text-xs text-fluux-muted">{t('settings.archiveConversationsDescription')}</p>
      {state === 'ready' && prefs ? (
        <>
          <div role="group" aria-labelledby="server-archive-label"
            className="grid grid-cols-3 gap-1 rounded-lg border border-fluux-border bg-fluux-bg p-1">
            {archiveOptions.map((option) => {
              const isSelected = selected === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={isSelected}
                  disabled={saving}
                  onClick={() => { if (!isSelected) void save(() => chooseArchiving(client, account, prefs, option.value)) }}
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
          <p className="text-xs text-fluux-muted">
            {t(archiveOptions.find((o) => o.value === selected)?.descriptionKey || '')}
          </p>
          {override ? (
            <p className="text-xs text-fluux-muted">
              {t('settings.archiveOverridden', { value: originalLabel })}{' '}
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(() => clearArchivingOverride(client, account, prefs))}
                className="text-fluux-brand hover:underline disabled:opacity-50"
              >
                {t('settings.archiveUseServerDefault')}
              </button>
            </p>
          ) : (
            <p className="text-xs text-fluux-muted">{t('settings.archiveServerDefault')}</p>
          )}
        </>
      ) : (
        <p className="text-xs text-fluux-muted">{t(`settings.archiveStatus.${state}`)}</p>
      )}
      {state === 'ready' && failed && (
        <p role="alert" className="text-xs text-fluux-error">{t('settings.archiveStatus.error')}</p>
      )}
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
