import { useEffect } from 'react'
import { setupExternalLinkHandler } from '@/utils/externalLinkHandler'

/**
 * Intercepts external link clicks in Tauri desktop mode and opens them
 * in webview popup windows instead of the system browser. No-op in web mode.
 */
export function useExternalLinkHandler(): void {
  useEffect(() => {
    const cleanup = setupExternalLinkHandler()
    return () => { cleanup?.() }
  }, [])
}
