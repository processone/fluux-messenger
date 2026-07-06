import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { useMcpBridgeStore } from '@/stores/mcpBridgeStore'
import { copyToClipboard } from '@/utils/clipboard'
import { useTimeFormat } from '@/hooks/useTimeFormat'

export function McpSettings() {
  const { t } = useTranslation()
  const { formatTime } = useTimeFormat()
  const enabled = useMcpBridgeStore((s) => s.enabled)
  const setEnabled = useMcpBridgeStore((s) => s.setEnabled)
  const serverInfo = useMcpBridgeStore((s) => s.serverInfo)
  const activityLog = useMcpBridgeStore((s) => s.activityLog)
  const clearActivityLog = useMcpBridgeStore((s) => s.clearActivityLog)
  const [copied, setCopied] = useState(false)
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(copiedTimeoutRef.current), [])

  const handleCopy = async () => {
    if (!serverInfo) return
    const url = `http://127.0.0.1:${serverInfo.port}/mcp`
    // copyToClipboard falls back to execCommand where the async Clipboard API
    // is unavailable; only show "Copied" once it has actually run.
    await copyToClipboard(`${url}\n${serverInfo.token}`)
    setCopied(true)
    clearTimeout(copiedTimeoutRef.current)
    copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className="w-full max-w-md">
      <SettingsSection title={t('settings.mcp.title')} description={t('settings.mcp.description')}>
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          className="px-4 py-2 rounded-lg bg-fluux-brand text-fluux-text-on-accent text-sm font-medium
                     hover:bg-fluux-brand-hover transition-colors tap-target"
        >
          {enabled ? t('settings.mcp.disable') : t('settings.mcp.enable')}
        </button>

        {enabled && (
          <div className="mt-2 text-sm text-fluux-muted">
            {serverInfo ? (
              <>
                <p>{t('settings.mcp.statusRunning', { port: serverInfo.port })}</p>
                <p className="font-mono text-xs mt-1 break-all">{`http://127.0.0.1:${serverInfo.port}/mcp`}</p>
                <p className="font-mono text-xs break-all">{serverInfo.token}</p>
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="text-xs underline mt-1 tap-target transition-colors"
                >
                  {copied ? t('settings.mcp.copied') : t('settings.mcp.copy')}
                </button>
              </>
            ) : (
              <p>{t('settings.mcp.statusStarting')}</p>
            )}
          </div>
        )}

        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-fluux-text">{t('settings.mcp.activityTitle')}</h3>
            {activityLog.length > 0 && (
              <button type="button" onClick={clearActivityLog} className="text-xs text-fluux-muted underline tap-target transition-colors">
                {t('settings.mcp.activityClear')}
              </button>
            )}
          </div>
          {activityLog.length === 0 ? (
            <p className="text-sm text-fluux-muted mt-2">{t('settings.mcp.activityEmpty')}</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {activityLog.map((entry) => (
                <li key={entry.id} className="text-xs text-fluux-muted">
                  {t(`settings.mcp.tool.${entry.tool}`)}
                  {entry.conversationId ? ` (${entry.conversationId})` : ''}
                  {' · '}
                  {formatTime(entry.timestamp)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>
    </section>
  )
}
