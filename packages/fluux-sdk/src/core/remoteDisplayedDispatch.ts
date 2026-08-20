import { wasLocallyPublishedDisplayed } from './localMdsPublishes'

/**
 * Where an inbound XEP-0490 read marker came from.
 *
 * `remote` — another of the account's devices read there. Evidence about the user's reading, so the
 * new-message divider follows it.
 *
 * `local-echo` — this client published that marker itself and the account's node pushed it back.
 * It says nothing the local read pointer does not already say, and treating it as evidence would
 * let scrolling move the divider through a loop.
 */
export type RemoteDisplayedOrigin = 'remote' | 'local-echo'

/**
 * The one place an inbound read marker is classified.
 *
 * Markers reach the stores by two routes — a live PEP notification, and the reconnect seed that
 * re-reads the node — and both can carry this client's own publish back to it. Classifying at each
 * call site is how the seed route came to be missed, and how a stream-management replay slipped
 * past a time-bounded check. Every route calls this instead.
 *
 * Classification never suppresses the marker: the read pointer, the pending-marker bookkeeping and
 * the unread recount run for an echo exactly as they do for a peer's marker, because a forward-only
 * pointer cannot be harmed by a position it already holds, and dropping the marker would strand the
 * pending state a stash is waiting to clear. Only the divider reads the origin.
 */
export function classifyRemoteDisplayed(
  accountJid: string | undefined,
  conversationJid: string,
  stanzaId: string,
): RemoteDisplayedOrigin {
  if (!accountJid) return 'remote'
  return wasLocallyPublishedDisplayed(accountJid, conversationJid, stanzaId)
    ? 'local-echo'
    : 'remote'
}
