import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { useXMPPContext } from '@fluux/sdk'
import { useTrustStateVerdict } from '@/e2ee/openpgpTrustView'
import { useToastStore } from '@/stores/toastStore'

type RecoverablePlugin = {
  resealTrustState?: () => Promise<void>
}

export function TrustStateCompromisedBanner() {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const { status, details } = useTrustStateVerdict()
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  // The plugin can refuse, for instance while trust data of an earlier
  // version waits to be moved: the person is told why.
  const handleReseal = useCallback(async () => {
    const plugin = client.e2ee?.getPlugin('openpgp') as RecoverablePlugin | null
    if (!plugin?.resealTrustState) return
    setBusy(true)
    try {
      await plugin.resealTrustState()
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [client, addToast])

  if (status !== 'compromised') return null

  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-fluux-error" />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium text-fluux-error">
            {t('settings.encryption.trustStateCompromised.title', 'Trust state integrity check failed')}
          </p>
          <p className="text-xs text-fluux-error">
            {t(
              'settings.encryption.trustStateCompromised.description',
              "Local trust data may have been tampered with. Check your contacts' keys before you continue.",
            )}
          </p>

          {details && details.length > 0 && (
            <div>
              <button
                type="button"
                className="text-xs text-fluux-error underline"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? t('common.hideDetails', 'Hide details') : t('common.showDetails', 'Show details')}
              </button>
              {expanded && (
                <ul className="mt-1 list-disc pl-4 text-xs text-fluux-error">
                  {details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              onClick={handleReseal}
              disabled={busy}
            >
              {busy
                ? t('common.loading', 'Loading…')
                : t('settings.encryption.trustStateCompromised.reestablishButton', 'Re-verify and continue')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
