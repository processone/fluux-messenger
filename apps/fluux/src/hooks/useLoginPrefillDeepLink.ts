import { useEffect } from 'react'
import { loginPrefillFromXmppUri } from '@/utils/loginPrefillSources'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Desktop-only: while the user is on the login screen, route incoming xmpp:
 * deep links to a login prefill instead of in-app navigation. Covers both the
 * cold-start launch URL (double-clicking a link with the app closed) and a
 * link clicked while the login screen is already open.
 *
 * Mounted by LoginScreen. Mutually exclusive with ChatLayout's useDeepLink,
 * which owns navigation once the user is connected.
 */
export function useLoginPrefillDeepLink(): void {
  useEffect(() => {
    if (!isTauri) return

    let cleanup: (() => void) | undefined
    let cleanedUp = false

    const apply = (urls: string[]) => {
      for (const url of urls) {
        const prefill = loginPrefillFromXmppUri(url)
        if (prefill) {
          useLoginPrefillStore.getState().setPrefill(prefill)
          break
        }
      }
    }

    const setup = async () => {
      try {
        const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link')
        const unlisten = await onOpenUrl((urls) => apply(urls))
        if (cleanedUp) {
          unlisten()
          return
        }
        const initial = await getCurrent()
        if (initial && initial.length > 0) apply(initial)
        cleanup = unlisten
      } catch (error) {
        console.error('[LoginPrefill] Failed to set up deep link handler:', error)
      }
    }

    void setup()

    return () => {
      cleanedUp = true
      cleanup?.()
    }
  }, [])
}
