import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Lock, AlertTriangle } from 'lucide-react'
import { useConnection, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { registerE2EEPlugins, unregisterE2EEPlugins } from '@/e2ee/registerPlugins'
import { useToastStore } from '@/stores/toastStore'

type PluginStatus = 'disabled' | 'generating' | 'ready' | 'waiting-online'

/**
 * Settings → Encryption panel.
 *
 * Surfaces the OpenPGP toggle and — when enabled — the account's
 * fingerprint. Purposely minimal: import, export, verification, and
 * rotation are later slices. Labelled "experimental" throughout so
 * users understand what they are opting into.
 */
export function EncryptionSettings() {
  const { t } = useTranslation()
  const { status } = useConnection()
  const { client } = useXMPPContext()
  const openpgpEnabled = useEncryptionSettingsStore((s) => s.openpgpEnabled)
  const setOpenpgpEnabled = useEncryptionSettingsStore((s) => s.setOpenpgpEnabled)
  const addToast = useToastStore((s) => s.addToast)

  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [isCopied, setIsCopied] = useState(false)
  const [isToggling, setIsToggling] = useState(false)

  const online = status === 'online'
  const pluginStatus: PluginStatus = !openpgpEnabled
    ? 'disabled'
    : !online
      ? 'waiting-online'
      : fingerprint
        ? 'ready'
        : 'generating'

  // Track fingerprint — poll briefly after enable so the "Generating…"
  // state resolves without needing a manual reload. The plugin exposes
  // its fingerprint synchronously via a direct method on the instance.
  useEffect(() => {
    if (!openpgpEnabled || !online) {
      setFingerprint(null)
      return
    }

    let cancelled = false
    const poll = () => {
      if (cancelled) return
      const plugin = client.e2ee.getPlugin('openpgp') as
        | { getOwnFingerprint?: () => string | null }
        | null
      const fp = plugin?.getOwnFingerprint?.() ?? null
      if (fp) {
        setFingerprint(fp)
        return
      }
      setTimeout(poll, 250)
    }
    poll()

    return () => {
      cancelled = true
    }
  }, [openpgpEnabled, online, client])

  const handleToggle = useCallback(async () => {
    const next = !openpgpEnabled
    setIsToggling(true)
    try {
      setOpenpgpEnabled(next)
      if (!online) {
        // Nothing to register yet — registration will run on the next
        // `online` event via App.tsx.
        return
      }
      if (next) {
        await registerE2EEPlugins(client)
      } else {
        await unregisterE2EEPlugins(client)
        setFingerprint(null)
      }
    } catch (err) {
      addToast('error', t('settings.encryption.toggleFailed'))
      console.error('[Fluux] E2EE toggle failed:', err)
      // Roll the preference back if the hot-toggle step failed.
      setOpenpgpEnabled(!next)
    } finally {
      setIsToggling(false)
    }
  }, [openpgpEnabled, online, client, setOpenpgpEnabled, addToast, t])

  const handleCopyFingerprint = useCallback(async () => {
    if (!fingerprint) return
    try {
      await navigator.clipboard.writeText(fingerprint)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch {
      addToast('error', t('settings.encryption.copyFailed'))
    }
  }, [fingerprint, addToast, t])

  return (
    <section className="max-w-md w-full">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.categories.encryption')}
      </h3>

      <div className="space-y-6">
        {/* Toggle block */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                <label className="text-sm font-medium text-fluux-text">
                  {t('settings.encryption.openpgpLabel')}
                </label>
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-yellow-500/15 text-yellow-600 dark:text-yellow-400">
                  {t('settings.encryption.experimental')}
                </span>
              </div>
              <p className="mt-1 text-xs text-fluux-muted leading-snug">
                {t('settings.encryption.openpgpDescription')}
              </p>
            </div>
            <button
              onClick={handleToggle}
              disabled={isToggling}
              aria-pressed={openpgpEnabled}
              aria-label={t('settings.encryption.openpgpLabel')}
              className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                openpgpEnabled ? 'bg-fluux-brand' : 'bg-fluux-hover'
              } ${isToggling ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
            >
              <span
                className={`absolute top-0.5 start-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  openpgpEnabled ? 'translate-x-4' : ''
                }`}
              />
            </button>
          </div>
        </div>

        {/* Status + fingerprint block — only when enabled */}
        {openpgpEnabled && (
          <div className="space-y-3">
            <label className="text-sm font-medium text-fluux-text">
              {t('settings.encryption.statusLabel')}
            </label>
            <div className="rounded-lg border-2 border-fluux-hover bg-fluux-bg p-3 space-y-2">
              <div className="text-xs text-fluux-muted">
                {pluginStatus === 'waiting-online' &&
                  t('settings.encryption.statusWaitingOnline')}
                {pluginStatus === 'generating' &&
                  t('settings.encryption.statusGenerating')}
                {pluginStatus === 'ready' && t('settings.encryption.statusReady')}
              </div>
              {fingerprint && (
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono text-fluux-text break-all">
                    {formatFingerprint(fingerprint)}
                  </code>
                  <button
                    onClick={handleCopyFingerprint}
                    className="p-1.5 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover transition-colors"
                    title={t('settings.encryption.copyFingerprint')}
                    aria-label={t('settings.encryption.copyFingerprint')}
                  >
                    {isCopied ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Limitations callout */}
        <div className="flex gap-2 p-3 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
          <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-fluux-text">
              {t('settings.encryption.limitationsTitle')}
            </p>
            <ul className="mt-1 space-y-1 list-disc list-inside">
              <li>{t('settings.encryption.limitationVerification')}</li>
              <li>{t('settings.encryption.limitationPersistence')}</li>
              <li>{t('settings.encryption.limitationBackend')}</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

/** Split a 40-char hex fingerprint into space-separated blocks of 4. */
function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}
