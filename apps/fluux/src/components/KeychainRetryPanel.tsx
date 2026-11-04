import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { isE2EEPluginError } from '@fluux/sdk'
import { SettingsDisclosure } from '@/components/ui/SettingsDisclosure'
import { backupRecoveryError } from '@/components/backupRecoveryError'
import { BackupRecoveryFailure } from '@/components/BackupRecoveryFailure'
import { platform } from '@/platform'
import type { KeychainRetryState } from '@/e2ee/OpenPGPPluginBase'

type RetryFailure = ReturnType<typeof backupRecoveryError>

/** Shared recovery copy for a changed account or a running identity change; native details otherwise. */
function retryFailure(error: unknown, t: TFunction): RetryFailure {
  if (isE2EEPluginError(error) && (error.code === 'recovery-account-changed' || error.code === 'identity-change-pending')) {
    return backupRecoveryError(error, t)
  }
  const detail = error instanceof Error ? error.message : String(error)
  return { message: t('settings.encryption.keychainRetry.failed'), detail, uncertain: false }
}

/** What the panel needs from the OpenPGP plugin. */
export interface KeychainRetryPlugin {
  keychainRetryState(): Promise<KeychainRetryState>
  retryKeychainAccess(): Promise<{ fingerprint: string }>
}

/** A failed probe decides nothing, like a request still on macOS's prompt. */
function readRetryState(plugin: KeychainRetryPlugin): Promise<KeychainRetryState> {
  return plugin.keychainRetryState().catch((): KeychainRetryState => 'unconfirmed')
}

function supportsKeychainRetry(plugin: unknown): plugin is KeychainRetryPlugin {
  const candidate = plugin as Partial<KeychainRetryPlugin> | null | undefined
  return typeof candidate?.keychainRetryState === 'function' && typeof candidate.retryKeychainAccess === 'function'
}

interface KeychainRetryPanelProps {
  plugin: KeychainRetryPlugin
  onUnlocked: (fingerprint: string) => void
  /** The recovery action the backup hint names; Settings' restore entry by default. */
  hintAction?: string
  /**
   * Told when a retry starts and ends, so the caller holds its other recovery
   * actions until the retry reports which key is in use.
   */
  onBusyChange?: (busy: boolean) => void
}

// One panel per plugin instance: a newly registered plugin starts folded, with
// no outcome of the previous plugin's retry.
const panelKeys = new WeakMap<KeychainRetryPlugin, number>()
let lastPanelKey = 0
function panelKey(plugin: KeychainRetryPlugin): number {
  let key = panelKeys.get(plugin)
  if (key === undefined) panelKeys.set(plugin, key = ++lastPanelKey)
  return key
}

/**
 * The retry asks the macOS keychain again, so only desktop macOS offers it.
 * Callers place it where a locked key's recovery is shown: under Settings'
 * restore entry, or inside the identity choice a desynced key opens.
 */
export function KeychainRetryOffer({ plugin, ...props }: Omit<KeychainRetryPanelProps, 'plugin'> & { plugin: unknown }) {
  if (platform().shell !== 'desktop' || platform().os !== 'macos' || !supportsKeychainRetry(plugin)) return null
  return <KeychainRetryPanel key={panelKey(plugin)} plugin={plugin} {...props} />
}

/**
 * FLM-304, the captain's words on FLM-298: "Never, but maybe an explicit
 * retry try could be proposed in a advanced panel, in case there is no other
 * way to recover the key". The panel shows only when the plugin offers the
 * retry (a keychain refusal this launch, no server backup), stays folded
 * until opened, and reads the keychain only when the user presses its button.
 */
function KeychainRetryPanel({ plugin, onUnlocked, hintAction, onBusyChange }: KeychainRetryPanelProps) {
  const { t } = useTranslation()
  const [offered, setOffered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusedAgain, setRefusedAgain] = useState(false)
  const [failure, setFailure] = useState<RetryFailure | null>(null)
  // A failed retry with nothing left to ask again keeps its details but no action.
  const [spent, setSpent] = useState(false)

  useEffect(() => {
    let cancelled = false
    setOffered(false)
    void readRetryState(plugin).then((next) => { if (!cancelled) setOffered(next === 'offered') })
    return () => { cancelled = true }
  }, [plugin])

  if (!offered) return null

  const retry = async () => {
    setBusy(true)
    onBusyChange?.(true)
    setRefusedAgain(false)
    setFailure(null)
    try {
      const { fingerprint } = await plugin.retryKeychainAccess()
      onUnlocked(fingerprint)
    } catch (error) {
      if (isE2EEPluginError(error) && error.code === 'keychain-refused') {
        setRefusedAgain(true)
      } else if (isE2EEPluginError(error) && error.code === 'keychain-retry-unavailable') {
        // Nothing is refused any more, for example after a restore elsewhere.
        setOffered((await readRetryState(plugin)) === 'offered')
      } else {
        setFailure(retryFailure(error, t))
        // A granted read that still cannot unlock the key consumes the
        // refusal, and only that confirmed answer retires the action. A
        // request that outlived its time limit may still be on macOS's
        // prompt; its answer comes later, so the action stays (FLM-408 R4).
        setSpent((await readRetryState(plugin)) === 'none')
      }
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  return (
    <SettingsDisclosure title={t('settings.encryption.keychainRetry.title')} stayOpen={busy}>
      <div className="space-y-2 text-xs text-fluux-muted leading-snug">
        <p>{t('settings.encryption.keychainRetry.body')}</p>
        <p>{t('settings.encryption.keychainRetry.backupHint', { action: hintAction ?? t('settings.encryption.recoveryTitle') })}</p>
      </div>
      {refusedAgain && (
        <p role="alert" className="text-xs text-fluux-error break-words">
          {t('settings.encryption.keychainRetry.refusedAgain')}
        </p>
      )}
      <BackupRecoveryFailure failure={failure} />
      <button
        type="button"
        className="px-3 py-2 text-sm rounded-lg bg-fluux-hover text-fluux-text hover:bg-fluux-active disabled:opacity-60"
        disabled={busy || spent}
        onClick={() => { void retry() }}
      >
        {busy ? t('settings.encryption.keychainRetry.busy') : t('settings.encryption.keychainRetry.action')}
      </button>
    </SettingsDisclosure>
  )
}
