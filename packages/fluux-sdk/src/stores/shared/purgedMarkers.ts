/**
 * XEP-0490 markers the archive has PROVEN it no longer holds.
 *
 * A remote read marker the loaded slice cannot order is stashed as
 * `pendingRemoteDisplayedStanzaId`, and every later merge retries it. That is
 * correct while the marker is merely deep. It is a permanent lock once the
 * server has purged the message it names: the retry can never succeed, the
 * unread recount defers on the stash forever, and `publishDecision` answers
 * `retry` forever — so the entity stops publishing its read position at all.
 *
 * The catch-up walk already derives the proof (a backward page reporting
 * `complete` with the marker still pending means the archive start was reached
 * without finding it). This module is where that proof is kept, so the discard
 * it authorises cannot be undone by the next thing that re-applies the same
 * dead marker.
 *
 * SESSION-SCOPED, deliberately. The purged marker is still on the MDS node until
 * our replacement publish lands, so the `online` seed re-applies it on every
 * reconnect; without this record the entity would re-stash and re-lock before
 * the publish went out. It is not persisted: "the server no longer has this id"
 * is cheap to re-derive and must not outlive a wipe of local state.
 *
 * This is a NEGATIVE cache and nothing more. It records that one id is
 * unorderable; it never asserts a read POSITION, and nothing here can move a
 * read pointer.
 *
 * Scoped by `{accountScope, kind, entityId}` — same shape and rationale as
 * `viewportEvidence.ts` and `transientUnread.ts`: a bare entity id can collide
 * across accounts sharing the same room/chat id.
 *
 * @module Stores/Shared/PurgedMarkers
 */

export interface PurgedMarkerKey {
  kind: 'chat' | 'room'
  entityId: string
  accountScope: string
}

// U+0000 separator: account scopes/kinds/entity ids cannot contain it, so joins never collide.
const SEP = String.fromCharCode(0)

/** entity key → the one stanza-id proven purged for it. */
const purged = new Map<string, string>()

function keyString(key: PurgedMarkerKey): string {
  return `${key.accountScope}${SEP}${key.kind}${SEP}${key.entityId}`
}

/**
 * Record that `stanzaId` is not in this entity's archive.
 *
 * One id per entity: a newer marker supersedes an older one, and only the
 * marker currently stashed can ever be proven absent, so there is never a
 * second live candidate to remember.
 */
export function notePurgedMarker(key: PurgedMarkerKey, stanzaId: string): void {
  purged.set(keyString(key), stanzaId)
}

/** Has `stanzaId` been proven absent from this entity's archive this session? */
export function isMarkerPurged(key: PurgedMarkerKey, stanzaId: string): boolean {
  return purged.get(keyString(key)) === stanzaId
}

/** Forget one account's records — account switch, mirroring `clearViewportEvidence`. */
export function clearPurgedMarkers(accountScope: string): void {
  const prefix = `${accountScope}${SEP}`
  for (const key of purged.keys()) {
    if (key.startsWith(prefix)) purged.delete(key)
  }
}

/** Test-only. */
export function _resetPurgedMarkersForTesting(): void {
  purged.clear()
}
