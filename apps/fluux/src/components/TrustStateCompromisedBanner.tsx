import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { useXMPPContext } from '@fluux/sdk'
import { useTrustStateStatusStore } from '@/stores/trustStateStatusStore'

type RecoverablePlugin = {
  resealTrustState?: () => Promise<void>
}

export function TrustStateCompromisedBanner() {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const status = useTrustStateStatusStore((s) => s.status)
  const details = useTrustStateStatusStore((s) => s.mismatchDetails)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const handleReseal = useCallback(async () => {
    const plugin = client.e2ee?.getPlugin('openpgp') as RecoverablePlugin | null
    if (!plugin?.resealTrustState) return
    setBusy(true)
    try {
      await plugin.resealTrustState()
    } finally {
      setBusy(false)
    }
  }, [client])

  if (status !== 'compromised') return null

  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            {t('settings.encryption.trustStateCompromised.title', 'Trust state integrity check failed')}
          </p>
          <p className="text-xs text-red-700 dark:text-red-300">
            {t(
              'settings.encryption.trustStateCompromised.description',
              'Local trust data may have been tampered with. Silent key re-pinning is blocked to prevent key substitution.',
            )}
          </p>

          {details && details.length > 0 && (
            <div>
              <button
                type="button"
                className="text-xs text-red-600 underline dark:text-red-400"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? t('common.hideDetails', 'Hide details') : t('common.showDetails', 'Show details')}
              </button>
              {expanded && (
                <ul className="mt-1 list-disc pl-4 text-xs text-red-600 dark:text-red-400">
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
