import { getDomain, hasFastToken } from '@fluux/sdk'
import { platform } from '@/platform'
import { hasSavedCredentials } from '@/utils/keychain'

/**
 * What a cold start that has no tab session (the tab or the app was reopened)
 * can still reconnect with, without asking the user anything.
 *
 * `useSessionPersistence` performs that reconnect and reports it as pending
 * from the first render, so the login form is never painted ahead of it.
 */
export type StandaloneStartupReconnect =
  | { kind: 'fast-token'; jid: string; server: string }
  | { kind: 'keychain' }

export function standaloneStartupReconnect(): StandaloneStartupReconnect | null {
  // FAST token (XEP-0484) remembered with "Remember Me": valid up to 14 days.
  const rememberMe = localStorage.getItem('xmpp-remember-me') === 'true'
  const savedJid = localStorage.getItem('xmpp-last-jid')
  const savedServer = localStorage.getItem('xmpp-last-server')
  // Fallback: derive server from JID domain when savedServer is empty
  // (backward compat with older sessions that stored '' for the server field)
  const effectiveServer = savedServer || (savedJid ? getDomain(savedJid) : null)
  if (rememberMe && savedJid && effectiveServer && hasFastToken(savedJid)) {
    return { kind: 'fast-token', jid: savedJid, server: effectiveServer }
  }
  // Password saved in the OS keychain (desktop, iOS), no FAST token.
  if (platform().nativeKeychain && hasSavedCredentials()) return { kind: 'keychain' }
  return null
}
