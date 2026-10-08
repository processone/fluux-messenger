import { useEffect } from 'react'
import type { XMPPClient } from '@fluux/sdk/core'
import { platform } from '@/platform'
import { finishSendsInBackground } from '@/utils/pendingSends'

/** Asks the OS for time to finish pending sends when the app leaves the foreground. */
export function useFinishSendsInBackground(client: Pick<XMPPClient, 'whenSentAcknowledged'>): void {
  useEffect(() => {
    if (!platform().finishesWorkInBackground) return
    const onVisibilityChange = () => {
      if (!document.hidden) return
      finishSendsInBackground(() => client.whenSentAcknowledged()).catch(error => {
        console.error('[PendingSends] Could not finish sending in the background:', error)
      })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [client])
}
