import { useEffect } from 'react'
import { setupExternalLinkHandler } from '@/utils/externalLinkHandler'

/**
 * Routes XMPP links inside Fluux on every platform; native HTTP links use
 * the system browser. Ordinary web HTTP links keep browser navigation.
 */
export function useExternalLinkHandler(): void {
  useEffect(() => {
    const cleanup = setupExternalLinkHandler()
    return () => { cleanup?.() }
  }, [])
}
