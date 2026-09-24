import { useEffect } from 'react'
import { setupExternalLinkHandler } from '@/utils/externalLinkHandler'

/**
 * Opens external links in the system browser in native Tauri shells.
 * No-op in web mode.
 */
export function useExternalLinkHandler(): void {
  useEffect(() => {
    const cleanup = setupExternalLinkHandler()
    return () => { cleanup?.() }
  }, [])
}
