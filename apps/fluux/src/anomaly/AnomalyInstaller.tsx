/**
 * Mounts the anomaly runtime inside `XMPPProvider`, so the detectors that read
 * protocol traffic can reach the client. Children mount only after attachment.
 *
 * It lives inside the provider rather than in `main.tsx` because at that level
 * there is no client — `XMPPProvider` constructs it internally.
 *
 * @module Anomaly/Installer
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useXMPPContext } from '@fluux/sdk'
import { install } from './install'

export interface AnomalyInstallerProps {
  children: ReactNode
}

export default function AnomalyInstaller({ children }: AnomalyInstallerProps): ReactNode {
  const { client } = useXMPPContext()
  const [attachedClient, setAttachedClient] = useState<typeof client | null>(null)

  useEffect(() => {
    const cleanup = install(client)
    setAttachedClient(client)
    return cleanup
  }, [client])

  return attachedClient === client ? children : null
}
