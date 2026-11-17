import { connectionStore, getBareJid } from '@fluux/sdk'
import type { SDKEvents } from '@fluux/sdk'

type SignInAccepted = SDKEvents['connection:authenticated']

/** The part of the SDK client that announces an accepted sign-in. */
interface SignInEvents {
  subscribe(event: 'connection:authenticated', handler: (event: SignInAccepted) => void): () => void
}

/**
 * Calls `persist` once, as soon as the server accepts the sign-in to `jid`, and
 * returns what stops waiting for it: call that when `connect()` rejects. Call
 * this right before `connect()`, with nothing awaited in between.
 *
 * `connect()` resolves only after the setup that follows the sign-in (roster,
 * bookmarks), and the app is usable from the moment the server accepts it.
 * Saving the sign-in's password once `connect()` resolves would overwrite a
 * password changed during that setup; saving it here lets the change replace it.
 *
 * `connect()` also resolves, before any sign-in, when it hands a failed attempt
 * to the automatic reconnection: the wait goes on until that is accepted. It
 * ends by itself when the connection ends without it, on a final failure
 * (status `error`) or a cancellation or logout (`disconnected`).
 *
 * `connect()` ignores a request while another connection is in progress or up.
 * The sign-in that follows is that connection's, made with its own password,
 * so nothing is saved for the ignored request: its password was never tried.
 */
export function onSignInAccepted(
  client: SignInEvents,
  jid: string,
  persist: (event: SignInAccepted) => void,
): () => void {
  const { status } = connectionStore.getState()
  if (status === 'connecting' || status === 'reconnecting' || status === 'online' || status === 'verifying') {
    return () => {}
  }
  const account = getBareJid(jid)
  const stopAccepted = client.subscribe('connection:authenticated', (event) => {
    if (getBareJid(event.jid) !== account) return
    stop()
    persist(event)
  })
  const stopEnded = connectionStore.subscribe((state) => state.status, (status) => {
    if (status === 'error' || status === 'disconnected') stop()
  })
  function stop(): void {
    stopAccepted()
    stopEnded()
  }
  return stop
}
