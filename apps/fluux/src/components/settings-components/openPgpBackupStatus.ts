import type { BackupProbeResult, BackupStatus } from '@fluux/openpgp-plugin'

/** What the Encryption screens read from the OpenPGP plugin about the server backup. */
export interface BackupStatusReads {
  inspectSecretKeyBackup?: () => Promise<BackupStatus>
  probeSecretKeyBackup?: () => Promise<BackupProbeResult>
  getOwnFingerprint?: () => string | null
  getBackedUpFingerprint?: () => string | null
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
