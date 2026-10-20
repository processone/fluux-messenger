import { useEffect } from 'react'
import { getBareJid, useConnection, useXMPPContext } from '@fluux/sdk'
import { reapplyArchivingOverride } from '@/utils/archivingOverride'

/**
 * Re-applies the user's own archiving choice after sign-in when the server no
 * longer matches it. Accounts that never overrode their server default are left alone.
 */
export function useArchivingOverride(): void {
  const { client } = useXMPPContext()
  const { isConnected, jid } = useConnection()
  const account = jid ? getBareJid(jid) : null

  useEffect(() => {
    if (!isConnected || !account || !client.supportsMAM()) return
    void reapplyArchivingOverride(client, account).catch(() => {})
  }, [client, isConnected, account])
}
