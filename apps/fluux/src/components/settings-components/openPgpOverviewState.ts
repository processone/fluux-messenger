import { useEffect, useState } from 'react'
import { useConnection, useXMPPContext } from '@fluux/sdk'
import { isKeyLocked, type BackupProbeResult } from '@fluux/openpgp-plugin'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { platform } from '@/platform'

/** What the overview's OpenPGP row says. Each value has its own line of text. */
export type OpenPgpOverviewState =
  | 'off'
  | 'waiting'
  | 'locked'
  | 'needs-attention'
  | 'on'
  | 'on-backed-up'
  | 'on-no-backup'
  | 'on-backup-unconfirmed'

export interface OpenPgpOverviewInputs {
  enabled: boolean
  online: boolean
  registrationError: boolean
  /** Web: the key needs this session's passphrase. */
  locked: boolean
  /** This device's key fingerprint once the key is ready, else null. */
  fingerprint: string | null
  /** A warning the OpenPGP screen shows: key needs recovery, generation failed, no PEP, key unprotected at rest. */
  warning: boolean
  /** Server backup probe; null until it settles. */
  backupProbe: BackupProbeResult | null
  /** Fingerprint recorded at the last confirmed backup or restore. */
  backedUpFingerprint: string | null
}

/** Same precedence as the OpenPGP screen's own status line, then the backup state of a ready key. */
export function openPgpOverviewState(i: OpenPgpOverviewInputs): OpenPgpOverviewState {
  if (!i.enabled) return 'off'
  if (!i.online) return 'waiting'
  if (i.registrationError) return 'needs-attention'
  if (!i.fingerprint) {
    if (i.locked) return 'locked'
    return i.warning ? 'needs-attention' : 'on'
  }
  if (i.warning) return 'needs-attention'
  if (i.backupProbe === null) return 'on'
  if (i.backupProbe === 'absent') return 'on-no-backup'
  if (i.backupProbe === 'present' && i.backedUpFingerprint === i.fingerprint) return 'on-backed-up'
  return 'on-backup-unconfirmed'
}

interface OpenPgpPluginReads {
  getOwnFingerprint?: () => string | null
  isKeyRecoveryNeeded?: () => boolean
  isKeychainBacked?: () => boolean | null
  getBackedUpFingerprint?: () => string | null
  probeSecretKeyBackup?: () => Promise<BackupProbeResult>
}

/** The OpenPGP row's state, read from the registered plugin the way the OpenPGP screen reads it. */
export function useOpenPgpOverviewState(): OpenPgpOverviewState {
  const { status } = useConnection()
  const { client } = useXMPPContext()
  const enabled = useEncryptionSettingsStore((s) => s.openpgpEnabled)
  const registrationError = useEncryptionSettingsStore((s) => s.registrationError)
  const pluginRegisteredAt = useEncryptionSettingsStore((s) => s.pluginRegisteredAt)
  const online = status === 'online'
  const [read, setRead] = useState<Pick<OpenPgpOverviewInputs, 'fingerprint' | 'warning' | 'backupProbe' | 'backedUpFingerprint'>>({
    fingerprint: null,
    warning: false,
    backupProbe: null,
    backedUpFingerprint: null,
  })

  useEffect(() => {
    if (!enabled || !online || registrationError) {
      setRead({ fingerprint: null, warning: false, backupProbe: null, backedUpFingerprint: null })
      return
    }
    let cancelled = false
    void (async () => {
      const plugin = client.e2ee?.getPlugin('openpgp') as OpenPgpPluginReads | null | undefined
      const fingerprint = plugin?.getOwnFingerprint?.() ?? null
      const pepSupported = await client.server.checkPepSupport().catch(() => null)
      const warning =
        pepSupported === false ||
        plugin?.isKeyRecoveryNeeded?.() === true ||
        (platform().nativeOpenpgp && !!fingerprint && plugin?.isKeychainBacked?.() === false)
      const backedUpFingerprint = plugin?.getBackedUpFingerprint?.() ?? null
      const backupProbe = fingerprint
        ? await (plugin?.probeSecretKeyBackup?.() ?? Promise.resolve('absent' as const)).catch(() => 'unknown' as const)
        : null
      if (!cancelled) setRead({ fingerprint, warning, backupProbe, backedUpFingerprint })
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, online, registrationError, client, pluginRegisteredAt])

  return openPgpOverviewState({
    enabled,
    online,
    registrationError: !!registrationError,
    locked: platform().keyNeedsSessionPassphrase && enabled && isKeyLocked() && !registrationError,
    ...read,
  })
}
