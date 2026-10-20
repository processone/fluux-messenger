import type { ArchivingDefault, ArchivingPreferences } from '@fluux/sdk'
import { useSettingsStore } from '@/stores/settingsStore'

/** The part of the SDK client that reads and writes XEP-0313 archiving preferences. */
export interface ArchivingClient {
  getArchivingPreferences(): Promise<ArchivingPreferences>
  setArchivingPreferences(prefs: ArchivingPreferences): Promise<ArchivingPreferences>
}

/**
 * The value to show for `account`: the user's own choice when they made one,
 * otherwise whatever the server currently has.
 */
export function effectiveArchiving(account: string, server: ArchivingDefault): ArchivingDefault {
  return useSettingsStore.getState().archiveOverrides[account]?.value ?? server
}

/**
 * Apply the user's choice for `account`. The first choice remembers the
 * server's own default; choosing that default again is the same as having no
 * override. Returns the preferences the server reports afterwards.
 */
export async function chooseArchiving(
  client: ArchivingClient,
  account: string,
  server: ArchivingPreferences,
  value: ArchivingDefault,
): Promise<ArchivingPreferences> {
  const { archiveOverrides, setArchiveOverride, clearArchiveOverride } = useSettingsStore.getState()
  const original = archiveOverrides[account]?.original ?? server.default
  const applied = value === server.default ? server : await client.setArchivingPreferences({ ...server, default: value })
  if (value === original) clearArchiveOverride(account)
  else setArchiveOverride(account, { value, original })
  return applied
}

/** Drop the user's choice for `account` and put the server's own default back. */
export async function clearArchivingOverride(
  client: ArchivingClient,
  account: string,
  server: ArchivingPreferences,
): Promise<ArchivingPreferences> {
  const { archiveOverrides, clearArchiveOverride } = useSettingsStore.getState()
  const override = archiveOverrides[account]
  if (!override) return server
  const applied = override.original === server.default
    ? server
    : await client.setArchivingPreferences({ ...server, default: override.original })
  clearArchiveOverride(account)
  return applied
}

/**
 * On sign-in, make the server match the user's choice when it has drifted
 * (another client changed it, or the account was reset). Does nothing for an
 * account without an override, so a server default is never touched.
 */
export async function reapplyArchivingOverride(client: ArchivingClient, account: string): Promise<boolean> {
  const override = useSettingsStore.getState().archiveOverrides[account]
  if (!override) return false
  const server = await client.getArchivingPreferences()
  if (server.default === override.value) return false
  await client.setArchivingPreferences({ ...server, default: override.value })
  return true
}
