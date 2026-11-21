import type { BackupProbeResult, BackupStatus } from '@fluux/openpgp-plugin'

/** What the Encryption screens read from the OpenPGP plugin about the server backup. */
export interface BackupStatusReads {
  inspectSecretKeyBackup?: () => Promise<BackupStatus>
  probeSecretKeyBackup?: () => Promise<BackupProbeResult>
  getOwnFingerprint?: () => string | null
  getBackedUpFingerprint?: () => string | null
  backupRecordHoldsOtherKey?: () => boolean
}

/**
 * One reading of the server backup: absent, unknown (could not check), confirmed, changed,
 * out of date or unconfirmed. The plugin compares the downloaded file with the one this device
 * confirmed (FLM-411). A plugin without that method keeps the older rule: the backup is
 * confirmed only when the device's fingerprint marker names its current key.
 * Never rejects: a failed read is `unknown`, never `absent`, which would skip the replace warning.
 */
export async function readBackupStatus(plugin: BackupStatusReads | null | undefined): Promise<BackupStatus> {
  if (plugin?.inspectSecretKeyBackup) return plugin.inspectSecretKeyBackup().catch(() => 'unknown' as const)
  // No plugin method at all is different from a failed probe: nothing can be published to, so `absent` is truthful.
  if (!plugin?.probeSecretKeyBackup) return 'absent'
  const probe = await plugin.probeSecretKeyBackup().catch(() => 'unknown' as const)
  if (probe !== 'present') return probe
  const own = plugin.getOwnFingerprint?.() ?? null
  const marker = plugin.getBackedUpFingerprint?.() ?? null
  if (marker === null) return 'unconfirmed'
  return own && marker === own ? 'confirmed' : 'out-of-date'
}

/**
 * Whether the backup this device last confirmed belongs to another key. Settings keeps the older
 * policy for it: the foreign-backup warning, and rotation that leaves that backup alone.
 */
export function readBackupHoldsOtherKey(plugin: BackupStatusReads | null | undefined): boolean {
  if (!plugin) return false
  if (plugin.backupRecordHoldsOtherKey) return plugin.backupRecordHoldsOtherKey()
  const marker = plugin.getBackedUpFingerprint?.() ?? null
  return marker !== null && marker !== (plugin.getOwnFingerprint?.() ?? null)
}
