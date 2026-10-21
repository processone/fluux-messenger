import { useEffect } from 'react'
import { ensureDeepLinkRouter } from '@/utils/deepLinkRouter'

/**
 * Desktop and iOS: while the login form is up, incoming xmpp: login links
 * prefill it instead of navigating. The deep link router owns the listener
 * and the launch URL for the whole app; while no chat view is mounted it
 * stores login links in the prefill store, which LoginScreen consumes.
 *
 * Mounted by LoginScreen so the router is up even when no startup reconnect
 * started it (fresh install, logged out).
 */
export function useLoginPrefillDeepLink(): void {
  useEffect(() => {
    void ensureDeepLinkRouter()
  }, [])
}
