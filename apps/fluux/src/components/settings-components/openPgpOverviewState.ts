import { useEffect, useMemo, useState } from 'react'
import { useConnection, useXMPPContext } from '@fluux/sdk'
import type { BackupProbeResult } from '@fluux/openpgp-plugin'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { platform } from '@/platform'
import { useWebKeyLocked } from '@/hooks/useWebKeyLocked'
import { useOwnKeyConflict, useTrustStateVerdict } from '@/e2ee/openpgpTrustView'

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
  const webKeyLocked = useWebKeyLocked()
  // The same reactive sources as the OpenPGP screen's banners.
  const ownKeyConflict = useOwnKeyConflict()
  const trustCompromised = useTrustStateVerdict().status === 'compromised'
  const online = status === 'online'

  // The key unlocking or being restored outside this screen (startup unlock, guided recovery, key picker,
  // keychain retry) does not touch the stores above; the plugin announces it.
  const [unlockCount, setUnlockCount] = useState(0)
  useEffect(() => client.subscribe('e2ee:key-unlocked', () => setUnlockCount((n) => n + 1)), [client])

  // What the plugin knows locally is read at once, before any server request.
  const local = useMemo(() => {
    // These say the plugin's state may have changed since the last read.
    void [pluginRegisteredAt, unlockCount, webKeyLocked]
    if (!enabled || !online || registrationError) return null
    const plugin = client.e2ee?.getPlugin('openpgp') as OpenPgpPluginReads | null | undefined
    const fingerprint = plugin?.getOwnFingerprint?.() ?? null
    return {
      fingerprint,
      keyWarning:
        plugin?.isKeyRecoveryNeeded?.() === true ||
        (platform().nativeOpenpgp && !!fingerprint && plugin?.isKeychainBacked?.() === false),
      backedUpFingerprint: plugin?.getBackedUpFingerprint?.() ?? null,
    }
  }, [enabled, online, registrationError, client, pluginRegisteredAt, unlockCount, webKeyLocked])

  // The server answers arrive later and only add to the reading.
  const [remote, setRemote] = useState<{ pepUnsupported: boolean; backupProbe: BackupProbeResult | null }>({
    pepUnsupported: false,
    backupProbe: null,
  })
  const hasKey = !!local?.fingerprint
  useEffect(() => {
    setRemote({ pepUnsupported: false, backupProbe: null })
    if (!local) return
    let cancelled = false
    const plugin = client.e2ee?.getPlugin('openpgp') as OpenPgpPluginReads | null | undefined
    void client.server
      .checkPepSupport()
      .catch(() => null)
      .then((supported) => {
        if (!cancelled && supported === false) setRemote((r) => ({ ...r, pepUnsupported: true }))
      })
    if (hasKey) {
      void (plugin?.probeSecretKeyBackup?.() ?? Promise.resolve('absent' as const))
        .catch(() => 'unknown' as const)
        .then((backupProbe) => {
          if (!cancelled) setRemote((r) => ({ ...r, backupProbe }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [local, hasKey, client])

  return openPgpOverviewState({
    enabled,
    online,
    registrationError: !!registrationError,
    locked: webKeyLocked && enabled && !registrationError,
    fingerprint: local?.fingerprint ?? null,
    warning: !!local?.keyWarning || remote.pepUnsupported || !!ownKeyConflict || trustCompromised,
    backupProbe: remote.backupProbe,
    backedUpFingerprint: local?.backedUpFingerprint ?? null,
  })
}
