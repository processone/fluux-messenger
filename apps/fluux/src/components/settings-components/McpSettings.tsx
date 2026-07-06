import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { useMcpBridgeStore } from '@/stores/mcpBridgeStore'

export function McpSettings() {
  const { t } = useTranslation()
  const enabled = useMcpBridgeStore((s) => s.enabled)
  const setEnabled = useMcpBridgeStore((s) => s.setEnabled)
  const serverInfo = useMcpBridgeStore((s) => s.serverInfo)
  const activityLog = useMcpBridgeStore((s) => s.activityLog)
  const clearActivityLog = useMcpBridgeStore((s) => s.clearActivityLog)
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!serverInfo) return
    const url = `http://127.0.0.1:${serverInfo.port}/mcp`
    void navigator.clipboard.writeText(`${url}\n${serverInfo.token}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className="w-full max-w-md">
      <SettingsSection title={t('settings.mcp.title')} description={t('settings.mcp.description')}>
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          className="px-4 py-2 rounded-lg bg-fluux-brand text-fluux-text-on-accent"
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
                <button type="button" onClick={handleCopy} className="text-xs underline mt-1">
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
              <button type="button" onClick={clearActivityLog} className="text-xs text-fluux-muted underline">
                {t('settings.mcp.activityClear')}
              </button>
            )}
          </div>
          {activityLog.length === 0 ? (
            <p className="text-sm text-fluux-muted mt-2">{t('settings.mcp.activityEmpty')}</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {activityLog.map((entry, index) => (
                <li key={index} className="text-xs text-fluux-muted">
                  {t(`settings.mcp.tool.${entry.tool}`)}
                  {entry.conversationId ? ` (${entry.conversationId})` : ''}
                  {' · '}
                  {entry.timestamp.toLocaleTimeString()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>
    </section>
  )
}
