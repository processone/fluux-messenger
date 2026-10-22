import type { ArchivingDefault, ArchivingPreferences } from '@fluux/sdk'

/** The SDK owns protocol details and confirmation, including empty-success readback. */
export interface ArchivingClient {
  getArchivingPreferences(): Promise<ArchivingPreferences>
  setArchivingPreferences(prefs: ArchivingPreferences): Promise<ArchivingPreferences>
}

const pending = new WeakSet<ArchivingClient>()

/**
 * Change the account default, preserving freshly read exceptions, not a UI snapshot.
 * Local legacy overrides intentionally have no authority and are left untouched.
 * XEP-0313 has no revision/compare-and-set; this reduces, but cannot eliminate,
 * the race with another client changing exceptions between the GET and SET.
 */
export async function chooseArchiving(
  client: ArchivingClient,
  value: ArchivingDefault,
  isCurrent: () => boolean,
): Promise<ArchivingPreferences> {
  if (pending.has(client)) throw new Error('Archiving update already pending')
  pending.add(client)
  const assertCurrent = () => {
    if (!isCurrent()) throw new DOMException('Archiving update cancelled', 'AbortError')
  }
  try {
    assertCurrent()
    const fresh = await client.getArchivingPreferences()
    assertCurrent()
    const confirmed = fresh.default === value ? fresh
      : await client.setArchivingPreferences({ ...fresh, default: value })
    assertCurrent()
    return confirmed
  } finally {
    pending.delete(client)
  }
}
