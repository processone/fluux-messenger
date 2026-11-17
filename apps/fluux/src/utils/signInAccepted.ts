import { getBareJid } from '@fluux/sdk'
import type { SDKEvents } from '@fluux/sdk'

type SignInAccepted = SDKEvents['connection:authenticated']

/** The part of the SDK client that announces an accepted sign-in. */
interface SignInEvents {
  subscribe(event: 'connection:authenticated', handler: (event: SignInAccepted) => void): () => void
}

/**
 * Calls `persist` once, as soon as the server accepts the sign-in to `jid`, and
 * returns what stops waiting for it: call that once the sign-in is over.
 *
 * `connect()` resolves only after the setup that follows the sign-in (roster,
 * bookmarks), and the app is usable from the moment the server accepts it.
 * Saving the sign-in's password once `connect()` resolves would overwrite a
 * password changed during that setup; saving it here lets the change replace it.
 */
export function onSignInAccepted(
  client: SignInEvents,
  jid: string,
  persist: (event: SignInAccepted) => void,
): () => void {
  const account = getBareJid(jid)
  const stop = client.subscribe('connection:authenticated', (event) => {
    if (getBareJid(event.jid) !== account) return
    stop()
    persist(event)
  })
  return stop
}
