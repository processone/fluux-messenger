import { useEffect, useState } from 'react'
import { useConnection, useXMPPContext, getBareJid } from '@fluux/sdk'
import { pepAccessFor, readOwnDeviceLists } from '@fluux/omemo-plugin/devices'

/**
 * How many OMEMO devices other apps registered on the account (OMEMO 2 and legacy lists together, one per device id).
 * null while unknown: offline, still reading, or the lists couldn't be read.
 */
export function useOwnOmemoDeviceCount(): number | null {
  const { status, jid } = useConnection()
  const { client } = useXMPPContext()
  const online = status === 'online' && !!jid
  const accountJid = jid ? getBareJid(jid) : ''
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!online) {
      setCount(null)
      return
    }
    let cancelled = false
    readOwnDeviceLists(pepAccessFor(client), accountJid)
      .then((lists) => {
        if (cancelled) return
        const ids = new Set<number>()
        for (const read of [lists.omemo2, lists.legacy]) {
          if (!read.ok) {
            setCount(null)
            return
          }
          for (const device of read.devices) ids.add(device.id)
        }
        setCount(ids.size)
      })
      .catch(() => {
        if (!cancelled) setCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [online, client, accountJid])

  return count
}
